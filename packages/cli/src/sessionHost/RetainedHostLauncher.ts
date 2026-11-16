import fs from 'fs';
import path from 'path';
import { createHash, randomBytes } from 'crypto';
import { kernelGate, syncDirectory } from '../delegation/OwnershipRuntime';
import { SessionHostSupervisor, type SessionHostLaunchContext, type SessionHostServiceStatus } from '../service/SessionHostSupervisor';
import { preparePinnedHostBundle, type PinnedHostBundleInput } from '../update/PinnedHostBundle';
import { fields, identifier, secret } from './HostProtocol';
import { descriptorLauncher, privateJson, type RetainedLauncher } from './RetainedFrontend';

const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
interface LaunchRecord { version: 1; context: SessionHostLaunchContext }
interface Manifest { directory: string; installationId: string; secret: string; launcherSecret: string; descriptorFile: string }
export interface RetainedInstallationInput {
  homeDir: string;
  installationId: string;
  bundle: PinnedHostBundleInput;
  backendSearchPath?: string;
}
export interface RetainedLauncherOptions {
  supervisor?: (context: SessionHostLaunchContext) => { ensureStarted(): Promise<SessionHostServiceStatus> };
  startupTimeoutMs?: number;
}
function manifestAt(filename: string): Manifest {
  const value = privateJson(filename);
  fields(value, ['directory', 'installationId', 'secret', 'launcherSecret', 'descriptorFile']);
  identifier(value.installationId); secret(value.secret); secret(value.launcherSecret);
  for (const key of ['directory', 'descriptorFile']) {
    if (typeof value[key] !== 'string' || !path.isAbsolute(value[key] as string)) throw new Error('Invalid retained installation path.');
  }
  return value as unknown as Manifest;
}
function publish(filename: string, value: unknown): void {
  const fd = fs.openSync(filename, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(filename));
}

/** Prepare only from explicit verified distribution inventories. This does not
 * start a service, import an old session, or scan the user's configuration tree.
 * Existing launch metadata is immutable: a frontend update reuses it.
 */
export async function prepareRetainedHostInstallation(input: RetainedInstallationInput): Promise<string> {
  identifier(input.installationId);
  if (!path.isAbsolute(input.homeDir) || fs.realpathSync(input.homeDir) !== input.homeDir) throw new Error('A canonical home directory is required.');
  const directory = path.join(input.homeDir, '.remote-cli', 'retained-installations', input.installationId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory
    || process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('Unsafe retained installation directory.');
  const gate = kernelGate(path.join(directory, 'provision.lock'));
  if (!gate) throw new Error('Retained installation preparation is already running.');
  try {
    const bundle = await preparePinnedHostBundle(input.bundle);
    if (path.relative(bundle.packageRoot, bundle.entryPath).split(path.sep).join('/') !== 'dist/sessionHost/entry.js') {
      throw new Error('The pinned package must use the retained-host entry.');
    }
    const manifestFile = path.join(directory, 'manifest.json');
    const descriptorFile = path.join(directory, 'connection.json');
    if (!fs.existsSync(manifestFile)) publish(manifestFile, { directory: path.join(directory, 'state'),
      installationId: input.installationId, secret: randomBytes(32).toString('hex'), launcherSecret: randomBytes(32).toString('hex'), descriptorFile });
    const manifest = manifestAt(manifestFile);
    if (manifest.installationId !== input.installationId || manifest.directory !== path.join(directory, 'state') || manifest.descriptorFile !== descriptorFile) {
      throw new Error('Existing retained installation identity changed.');
    }
    const record: LaunchRecord = { version: 1, context: { homeDir: input.homeDir, installationId: input.installationId,
      bundle, descriptorPath: manifestFile, descriptorSha256: hash(fs.readFileSync(manifestFile)),
      ...(input.backendSearchPath !== undefined ? { backendSearchPath: input.backendSearchPath } : {}) } };
    const launchFile = path.join(directory, 'launch.json');
    if (fs.existsSync(launchFile)) {
      if (JSON.stringify(privateJson(launchFile)) !== JSON.stringify(record)) throw new Error('Existing retained installation cannot be replaced during frontend upgrade.');
    } else publish(launchFile, record);
    gate.verify();
    return launchFile;
  } finally { gate.close(); }
}

/** Manager status permits an attach attempt, never native recovery or replay.
 * Both the private descriptor and subsequent HostClient HMAC handshake are needed.
 */
export function supervisedLauncher(launchFile: string, options: RetainedLauncherOptions = {}): RetainedLauncher {
  const timeout = options.startupTimeoutMs ?? 15_000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60_000) throw new Error('Invalid retained host startup timeout.');
  return { connect: async () => {
    const value = privateJson(launchFile);
    fields(value, ['version', 'context']);
    if (value.version !== 1) throw new Error('Unsupported retained installation format.');
    fields(value.context, ['homeDir', 'installationId', 'bundle', 'descriptorPath', 'descriptorSha256'], ['backendSearchPath']);
    const context = value.context as unknown as SessionHostLaunchContext;
    if (typeof context.descriptorPath !== 'string' || !path.isAbsolute(context.descriptorPath)) throw new Error('Invalid retained manifest path.');
    const manifest = manifestAt(context.descriptorPath);
    if (manifest.installationId !== context.installationId || hash(fs.readFileSync(context.descriptorPath)) !== context.descriptorSha256) {
      throw new Error('Retained manifest integrity changed.');
    }
    const supervisor = options.supervisor?.(context) ?? new SessionHostSupervisor(context);
    const status = await supervisor.ensureStarted();
    if (status.state !== 'running') throw new Error('Retained host launch is unresolved.');
    const deadline = performance.now() + timeout;
    while (true) {
      try {
        const connection = await descriptorLauncher(manifest.descriptorFile).connect();
        if (connection.address.installationId !== context.installationId || connection.secret !== manifest.secret
          || connection.launcherSecret !== manifest.launcherSecret || connection.directory !== path.join(manifest.directory, 'control')) {
          throw new Error('Retained connection does not belong to this installation.');
        }
        return connection;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (performance.now() >= deadline) throw new Error('Retained host readiness is unresolved; the host was not restarted.');
        await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - performance.now()))));
      }
    }
  } };
}
