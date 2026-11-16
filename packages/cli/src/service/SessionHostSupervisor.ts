import { execFile } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { PinnedHostBundle, verifyPinnedHostBundle } from '../update/PinnedHostBundle';
import { ServiceCommandRunner } from './ServiceManager';

export interface SessionHostLaunchContext {
  /** Explicit canonical fixture/user home; never inferred from environment. */
  homeDir: string;
  installationId: string;
  bundle: PinnedHostBundle;
  /** Immutable private descriptor, provisioned by caller. Runtime state lives elsewhere.
   * The entry receives --config <path>; credentials are never serialized into a unit.
   */
  descriptorPath: string;
  descriptorSha256: string;
  /** Explicit native-backend search path. Pinned Node/helpers always take priority. */
  backendSearchPath?: string;
}
export interface SessionHostSupervisorOptions {
  platform?: NodeJS.Platform;
  runner?: ServiceCommandRunner;
  /** Required for a macOS GUI user domain; injectable for portable fixtures. */
  userId?: number;
}
export interface SessionHostServiceStatus {
  state: 'absent' | 'running' | 'stopped' | 'unknown';
  serviceName: string;
  servicePath: string;
  pid?: number;
  /** Manager status is never a native readiness or authenticated attach proof. */
  detail?: string;
}
const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const argument = (value: string) => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', () => '$$') + '"';
const unitPath = (value: string) => value.replaceAll('\\', '\\x5c').replaceAll(' ', '\\x20').replaceAll('"', '\\x22').replaceAll('%', '%%');
const run: ServiceCommandRunner = (command, args) => new Promise((resolve, reject) => {
  execFile(command, args, { encoding: 'utf8', timeout: 15_000, maxBuffer: 256 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(Object.assign(error, { stdout, stderr })); else resolve({ stdout, stderr });
  });
});
function safePath(value: string): void {
  if (!path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Session host paths must be absolute and contain no control characters.');
}
async function readPrivate(filename: string): Promise<Buffer> {
  if (await fs.realpath(filename) !== filename) throw new Error('Session host binding cannot use symlinks.');
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024 || (stat.mode & 0o077)
    || (process.getuid && stat.uid !== process.getuid())) throw new Error('Session host binding must be a private owned regular file.');
  return fs.readFile(filename);
}
async function exists(filename: string): Promise<boolean> {
  try { await fs.lstat(filename); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
async function privateDirectory(directory: string, home: string): Promise<void> {
  if (!directory.startsWith(home + path.sep)) throw new Error('Supervisor paths must stay under the explicit home.');
  let cursor = home;
  for (const part of path.relative(home, directory).split(path.sep)) {
    cursor = path.join(cursor, part);
    try { await fs.mkdir(cursor, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022)
      || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe supervisor directory.');
    const parent = await fs.open(path.dirname(cursor), 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  }
}
async function publish(filename: string, data: string): Promise<void> {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(data); await handle.sync(); await handle.close();
    await fs.link(temporary, filename); // Exclusive, atomic publication, never overwrite.
    const parent = await fs.open(path.dirname(filename), 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  } finally { await handle.close(); await fs.unlink(temporary); }
}

/** Independent manager ownership from initial launch. No detached/unref fallback,
 * no frontend unit dependency, no automatic host crash/reboot reconstruction.
 * A dead/failed prior attempt needs explicit reconciliation outside this component.
 */
export class SessionHostSupervisor {
  readonly serviceName: string;
  readonly servicePath: string;
  readonly bindingPath: string;
  private readonly platform: 'linux' | 'darwin';
  private readonly runner: ServiceCommandRunner;
  private readonly domain: string;
  private readonly stateRoot: string;
  private readonly context: SessionHostLaunchContext;

  constructor(context: SessionHostLaunchContext, options: SessionHostSupervisorOptions = {}) {
    const platform = options.platform ?? process.platform;
    if (platform !== 'linux' && platform !== 'darwin') throw new Error(`Independent session host supervision is unsupported on ${platform}.`);
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(context.installationId) || !/^[a-f0-9]{64}$/.test(context.descriptorSha256)) throw new Error('Invalid session host installation binding.');
    for (const value of [context.homeDir, context.descriptorPath, context.bundle.root, context.bundle.entryPath, context.bundle.nodePath]) safePath(value);
    // systemd rejects quote/backslash characters in executable names, and its
    // executable token does not use ordinary argument environment expansion.
    if (platform === 'linux' && /[\\"'`$]/.test(context.bundle.nodePath)) throw new Error('The pinned interpreter path contains unsupported systemd executable characters. Use a separate safe bundle store.');
    if (context.backendSearchPath !== undefined && context.backendSearchPath.split(':').some(part => !part.startsWith('/') || /[\x00-\x1f\x7f]/.test(part))) throw new Error('Backend search paths must be absolute POSIX directories.');
    if (context.bundle.root.includes(':')) throw new Error('Pinned bundle paths cannot contain a PATH separator.');
    this.platform = platform;
    this.context = structuredClone(context);
    this.runner = options.runner ?? run;
    const uid = options.userId ?? process.getuid?.();
    if (platform === 'darwin' && (!Number.isSafeInteger(uid) || uid! < 0)) throw new Error('A macOS GUI user ID is required.');
    this.domain = `gui/${uid}`;
    const id = digest(context.installationId).slice(0, 24);
    this.serviceName = platform === 'linux' ? `remote-cli-session-host-${id}.service` : `ai.yu-robotics.remote-cli.session-host.${id}`;
    this.servicePath = platform === 'linux' ? path.join(context.homeDir, '.config', 'systemd', 'user', this.serviceName)
      : path.join(context.homeDir, 'Library', 'LaunchAgents', `${this.serviceName}.plist`);
    this.stateRoot = path.join(context.homeDir, '.remote-cli', 'session-host-supervisor', id);
    this.bindingPath = path.join(this.stateRoot, 'binding.json');
  }

  /** Deterministic renderer; no descriptor contents, ambient environment or secrets. */
  renderService(): string {
    const c = this.context;
    const args = [c.bundle.nodePath, c.bundle.entryPath, '--config', c.descriptorPath];
    const searchPath = [path.posix.dirname(c.bundle.nodePath), path.posix.join(c.bundle.packageRoot, 'node_modules', '.bin'),
      c.backendSearchPath ?? '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'].join(':');
    const environment = (name: string, value: string) => `Environment="${name}=${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
    if (this.platform === 'linux') return [
      '[Unit]', 'Description=Remote CLI retained session host', '', '[Service]', 'Type=simple',
      `ExecStart=${args.map(argument).join(' ')}`, `WorkingDirectory=${unitPath(c.bundle.packageRoot)}`,
      environment('HOME', c.homeDir), environment('PATH', searchPath),
      'UnsetEnvironment=NODE_OPTIONS NODE_PATH NODE_CHANNEL_FD NODE_CHANNEL_SERIALIZATION_MODE',
      'UMask=0077', 'Restart=no', 'KillMode=mixed', 'TimeoutStopSec=90s', 'StandardOutput=null', 'StandardError=null', '',
    ].join('\n');
    return ['<?xml version="1.0" encoding="UTF-8"?>', '<plist version="1.0"><dict>',
      `<key>Label</key><string>${xml(this.serviceName)}</string>`,
      `<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>`,
      `<key>WorkingDirectory</key><string>${xml(c.bundle.packageRoot)}</string>`,
      `<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(c.homeDir)}</string><key>PATH</key><string>${xml(searchPath)}</string><key>NODE_OPTIONS</key><string></string><key>NODE_PATH</key><string></string></dict>`,
      '<key>Umask</key><integer>63</integer>', '<key>RunAtLoad</key><false/>', '<key>KeepAlive</key><false/>',
      '<key>StandardOutPath</key><string>/dev/null</string>', '<key>StandardErrorPath</key><string>/dev/null</string>',
      '</dict></plist>', ''].join('\n');
  }
  private binding(): string {
    return JSON.stringify({ schema: 1, installationId: this.context.installationId, bundle: Object.fromEntries(Object.entries(this.context.bundle).sort(([a], [b]) => a.localeCompare(b))),
      descriptorPath: this.context.descriptorPath, descriptorSha256: this.context.descriptorSha256,
      serviceDigest: digest(this.renderService()) });
  }
  private async validateContext(): Promise<void> {
    const c = this.context;
    if (await fs.realpath(c.homeDir) !== c.homeDir) throw new Error('Use the canonical session host home.');
    const bundle = await verifyPinnedHostBundle(c.bundle.root, c.bundle.digest);
    if (Object.keys(bundle).length !== Object.keys(c.bundle).length || Object.entries(bundle).some(([key, value]) => c.bundle[key as keyof PinnedHostBundle] !== value)) throw new Error('Pinned host paths differ from verified bundle.');
    if (digest(await readPrivate(c.descriptorPath)) !== c.descriptorSha256) throw new Error('Session host descriptor changed.');
    const parent = await fs.stat(path.dirname(c.descriptorPath));
    if (parent.mode & 0o077) throw new Error('Session host descriptor directory must be private.');
  }
  private async checkBinding(): Promise<void> {
    if ((await readPrivate(this.bindingPath)).toString() !== this.binding()
      || (await readPrivate(this.servicePath)).toString() !== this.renderService()) throw new Error('Existing session host service has a different installation binding.');
  }
  private result(state: SessionHostServiceStatus['state'], pid?: number, detail?: string): SessionHostServiceStatus {
    return { state, serviceName: this.serviceName, servicePath: this.servicePath, pid, detail };
  }
  private async managerStatus(): Promise<SessionHostServiceStatus> {
    if (this.platform === 'linux') {
      let stdout: string;
      try { ({ stdout } = await this.runner('systemctl', ['--user', 'show', this.serviceName,
        '--property=LoadState,ActiveState,SubState,MainPID,FragmentPath,DropInPaths,NeedDaemonReload'])); }
      catch (error) {
        stdout = String((error as { stdout?: string }).stdout ?? '');
        if (!/^LoadState=not-found$/m.test(stdout)) return this.result('unknown', undefined, 'User manager status unavailable.');
      }
      const fields = Object.fromEntries(stdout.trim().split('\n').map(line => line.split(/=(.*)/s).slice(0, 2)));
      if (fields.LoadState === 'not-found') return this.result('absent');
      if (fields.LoadState !== 'loaded' || fields.FragmentPath !== this.servicePath || fields.DropInPaths !== '' || fields.NeedDaemonReload !== 'no') {
        return this.result('unknown', undefined, 'Manager unit binding is unavailable or differs.');
      }
      const pid = Number(fields.MainPID);
      if (fields.ActiveState === 'active' && fields.SubState === 'running' && Number.isSafeInteger(pid) && pid > 0) return this.result('running', pid);
      if (fields.ActiveState === 'inactive' && pid === 0) return this.result('stopped');
      return this.result('unknown', undefined, 'Host is failed or transitioning.');
    }
    try {
      const { stdout } = await this.runner('launchctl', ['print', `${this.domain}/${this.serviceName}`]);
      const field = (key: string) => stdout.match(new RegExp(`^\\s*${key} = (.+)$`, 'm'))?.[1].trim();
      if (field('path') !== this.servicePath || field('program') !== this.context.bundle.nodePath) return this.result('unknown', undefined, 'LaunchAgent binding differs.');
      const pid = Number(field('pid'));
      if (field('state') === 'running' && Number.isSafeInteger(pid) && pid > 0) return this.result('running', pid);
      if (field('state') === 'not running' && !field('pid')) return this.result('stopped');
      return this.result('unknown', undefined, 'Host is failed or transitioning.');
    } catch (error) {
      const failure = error as { code?: number; stderr?: string };
      // Only a manager-confirmed missing label is absence. A missing GUI domain,
      // permission denial, tool failure or generic exit code is unknown.
      if (failure.code === 113 && failure.stderr?.includes(`Could not find service "${this.serviceName}" in domain`)) return this.result('absent');
      return this.result('unknown', undefined, 'User manager status unavailable.');
    }
  }
  async status(): Promise<SessionHostServiceStatus> {
    try {
      await this.validateContext();
      if (await exists(this.bindingPath)) await this.checkBinding();
      else if (await exists(this.servicePath)) return this.result('unknown', undefined, 'Unowned service file.');
      const status = await this.managerStatus();
      if (status.state !== 'absent' && !await exists(this.bindingPath)) return this.result('unknown', undefined, 'Unowned manager service.');
      return status;
    } catch { return this.result('unknown', undefined, 'Session host installation integrity is unresolved.'); }
  }
  private async exclusive<T>(body: () => Promise<T>): Promise<T> {
    await privateDirectory(this.stateRoot, this.context.homeDir);
    const lock = path.join(this.stateRoot, 'operation.lock');
    try { await fs.mkdir(lock, { mode: 0o700 }); }
    catch { throw new Error('Session host supervisor operation is busy or requires reconciliation.'); }
    try { return await body(); } finally { await fs.rmdir(lock); }
  }
  /** Starts only the first, unambiguously absent owner. Repeated calls on a live
   * owner do not reload/restart it. Caller must authenticate and qualify attach.
   */
  async ensureStarted(): Promise<SessionHostServiceStatus> {
    await this.validateContext();
    return this.exclusive(async () => {
      const bound = await exists(this.bindingPath);
      if (bound) {
        await this.checkBinding();
        const status = await this.managerStatus();
        if (status.state !== 'running') throw new Error('A previous session host launch exists; reconcile it before another launch.');
        return status;
      }
      if (await exists(this.servicePath) || (await this.managerStatus()).state !== 'absent') throw new Error('Cannot adopt an unknown session host service.');
      await privateDirectory(path.dirname(this.servicePath), this.context.homeDir);
      // Durable intent precedes even manager reload. A timeout is not permission
      // to issue another start. No recovery path deletes this receipt.
      await publish(this.bindingPath, this.binding());
      await publish(this.servicePath, this.renderService());
      if (this.platform === 'linux') {
        await this.runner('systemctl', ['--user', 'daemon-reload']);
        await this.runner('systemctl', ['--user', 'start', this.serviceName]);
      } else {
        await this.runner('launchctl', ['bootstrap', this.domain, this.servicePath]);
        await this.runner('launchctl', ['kickstart', `${this.domain}/${this.serviceName}`]);
      }
      const status = await this.managerStatus();
      if (status.state !== 'running') throw new Error('Session host launch outcome is unresolved; retain its binding and authenticate before retrying.');
      return status;
    });
  }
  /** Explicit destructive host stop, never called by frontend replacement. This
   * manager result does NOT prove descendant retirement or native checkpointing.
   * The caller must first authorize/drain native work through the host protocol.
   */
  async stop(): Promise<SessionHostServiceStatus> {
    await this.validateContext();
    return this.exclusive(async () => {
      await this.checkBinding();
      const before = await this.managerStatus();
      if (before.state === 'unknown') throw new Error('Cannot stop a host with unknown manager ownership.');
      if (before.state === 'absent' || before.state === 'stopped') return before;
      if (this.platform === 'linux') await this.runner('systemctl', ['--user', 'stop', this.serviceName]);
      else await this.runner('launchctl', ['bootout', `${this.domain}/${this.serviceName}`]);
      return this.managerStatus();
    });
  }
}
