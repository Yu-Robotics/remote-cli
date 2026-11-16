import fs from 'fs';
import path from 'path';
import { ConfigManager } from '../config/ConfigManager';
import { DirectoryGuard } from '../security/DirectoryGuard';
import { ThreadManager } from '../thread/ThreadManager';
import { ThreadExecutorPool } from '../thread/ThreadExecutorPool';
import { WebSocketClient } from '../client/WebSocketClient';
import { loadIdentity } from '../files/DeviceIdentity';
import { kernelGate, syncDirectory } from '../delegation/OwnershipRuntime';
import { initializeBackendEnvironment } from '../utils/BackendEnvironment';
import { CLI_VERSION } from '../types';
import { fields, identifier, secret } from './HostProtocol';
import { HostServer } from './HostServer';
import { RetainedRuntime } from './RetainedRuntime';
import { privateJson } from './RetainedFrontend';

/** Pinned supervisor entry: node <bundle>/dist/sessionHost/entry.js --config <private-file>.
 * Manifest: { directory, installationId, secret, launcherSecret, descriptorFile }.
 * The supervisor owns this process independently; stdin/parent IPC is not its lifetime.
 * Frontends use REMOTE_CLI_SESSION_HOST_DESCRIPTOR pointing at descriptorFile.
 */
export async function startRetainedHost(manifestFile: string): Promise<{ host: HostServer; runtime: RetainedRuntime }> {
  const manifest = privateJson(manifestFile);
  fields(manifest, ['directory', 'installationId', 'secret', 'launcherSecret', 'descriptorFile']);
  identifier(manifest.installationId); secret(manifest.secret); secret(manifest.launcherSecret);
  if (typeof manifest.directory !== 'string' || !path.isAbsolute(manifest.directory)
    || typeof manifest.descriptorFile !== 'string' || !path.isAbsolute(manifest.descriptorFile)) throw new Error('Invalid retained host manifest.');
  const config = await ConfigManager.initialize();
  const all = config.getAll();
  if (!all.deviceId || !all.serverUrl || !all.security?.allowedDirectories.length) throw new Error('Complete device configuration is required.');
  // The first opt-in must not overlap a pre-feature monolithic client, which
  // cannot export its live callback/stdio state. Never fall back to importing it.
  const marker = path.join(config.getConfigDir(), 'retained-host-mode.json');
  if (!fs.existsSync(marker) && all.service?.running) throw new Error('First adoption is unsupported while the monolithic client owns live state. No session or process was changed.');
  const routerOwner = kernelGate(path.join(config.getConfigDir(), 'router-owner.lock'));
  if (!routerOwner) throw new Error('Another client owns the Router connection.');
  let host: HostServer | undefined;
  let runtime: RetainedRuntime | undefined;
  try {
    initializeBackendEnvironment();
    const threads = await ThreadManager.initialize();
    const guard = new DirectoryGuard(all.security.allowedDirectories);
    const executorConfig = all.executor ?? { type: 'auto' as const };
    const pool = new ThreadExecutorPool(threads, guard, executorConfig);
    const url = all.serverUrl.replace(/^http/, 'ws') + '/ws';
    const router = new WebSocketClient(url, all.deviceId, {
      capabilityProfile: 'retained-runtime',
      identityLoader: () => loadIdentity(config.getConfigDir(), url, all.deviceId!),
      maintenanceCapabilities: { updateNotice: false, subscriptionInspection: false },
    });
    runtime = new RetainedRuntime({ directory: path.join(manifest.directory, 'runtime'), runtimeVersion: CLI_VERSION,
      config: executorConfig, threads, pool, guard, router });
    const directory = path.join(manifest.directory, 'control');
    const retained = runtime;
    host = new HostServer({ directory, installationId: manifest.installationId, secret: manifest.secret, launcherSecret: manifest.launcherSecret,
      runtime: { authorityId: runtime.authorityId, execute: operation => retained.execute(operation), assertCanStop: () => retained.assertCanStop(), inspect: (method, args) => retained.inspect(method, args),
        stop: async () => { await retained.stop(); routerOwner.close(); } } });
    await runtime.start();
    const address = await host.listen();
    const temporary = manifest.descriptorFile + '.tmp';
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ address, secret: manifest.secret, launcherSecret: manifest.launcherSecret, directory })); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, manifest.descriptorFile); syncDirectory(path.dirname(manifest.descriptorFile));
    fs.writeFileSync(marker, JSON.stringify({ version: 1 }), { mode: 0o600 });
    return { host, runtime };
  } catch (error) {
    if (host) await host.stop();
    else if (runtime) await runtime.stop();
    routerOwner.close(); throw error;
  }
}
export function hostConfigArgument(args: string[]): string {
  if (args.length !== 2 || args[0] !== '--config' || !path.isAbsolute(args[1])) throw new Error('Expected --config <absolute-private-file>.');
  return args[1];
}
if (require.main === module) {
  void Promise.resolve().then(() => startRetainedHost(hostConfigArgument(process.argv.slice(2)))).then(({ host }) => {
    const shutdown = () => { void host.stop().then(() => process.exit(0)).catch(() => { console.error('Native work remains owned; host shutdown was refused.'); }); };
    process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  }).catch(() => { console.error('Retained host startup refused; private state was preserved.'); process.exitCode = 1; });
}
