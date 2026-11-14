import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { getBackendPath } from '../utils/BackendEnvironment';

export type ServicePlatform = 'linux' | 'darwin';

export interface ServiceStatus {
  platform: ServicePlatform;
  supported: boolean;
  installed: boolean;
  running: boolean;
  enabled: boolean;
  servicePath: string;
  serviceName: string;
  pid?: number;
  detail?: string;
}

export interface ServiceContext {
  homeDir: string;
  nodePath: string;
  cliEntryPath: string;
  pathValue: string;
  logDirectory: string;
}

export type ServiceCommandRunner = (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const SERVICE_NAME = 'remote-cli';
const MAC_SERVICE_LABEL = 'ai.yu-robotics.remote-cli';

function runCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        Object.assign(error, { stdout, stderr });
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function ignoreCommandFailure(runner: ServiceCommandRunner, command: string, args: string[]): Promise<void> {
  try {
    await runner(command, args);
  } catch {
    // The service may not have been loaded yet.
  }
}

function quoteSystemdArgument(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$')}"`;
}

function escapeSystemdPath(value: string): string {
  return value
    .replaceAll('\\', '\\x5c')
    .replaceAll(' ', '\\x20')
    .replaceAll('\t', '\\x09')
    .replaceAll('\n', '\\x0a')
    .replaceAll('\r', '\\x0d')
    .replaceAll('%', '%%');
}

function quoteSystemdEnvironment(name: string, value: string): string {
  const assignment = `${name}=${value}`
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t')
    .replaceAll('%', '%%');
  return `"${assignment}"`;
}

function xmlEscape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export function getServicePlatform(platform = process.platform): ServicePlatform {
  if (platform === 'linux' || platform === 'darwin') return platform;
  throw new Error(`Automatic service installation is not supported on ${platform}.`);
}

export function getServiceContext(overrides: Partial<ServiceContext> = {}): ServiceContext {
  const homeDir = overrides.homeDir ?? os.homedir();
  const cliEntryPath = overrides.cliEntryPath ?? path.resolve(process.argv[1] || path.join(__dirname, '../../bin/remote-cli.js'));
  const nodePath = overrides.nodePath ?? process.execPath;
  return {
    homeDir,
    nodePath,
    cliEntryPath,
    pathValue: overrides.pathValue ?? getBackendPath({ homeDir, nodePath, cliEntryPath }),
    logDirectory: overrides.logDirectory ?? path.join(homeDir, '.remote-cli', 'logs'),
  };
}

export interface ServiceManager {
  install(): Promise<ServiceStatus>;
  uninstall(): Promise<ServiceStatus>;
  start(): Promise<ServiceStatus>;
  stop(): Promise<ServiceStatus>;
  status(): Promise<ServiceStatus>;
}

abstract class BaseServiceManager implements ServiceManager {
  protected readonly context: ServiceContext;
  protected readonly runner: ServiceCommandRunner;

  constructor(context: ServiceContext, runner: ServiceCommandRunner = runCommand) {
    this.context = context;
    this.runner = runner;
  }

  abstract install(): Promise<ServiceStatus>;
  abstract uninstall(): Promise<ServiceStatus>;
  abstract start(): Promise<ServiceStatus>;
  abstract stop(): Promise<ServiceStatus>;
  abstract status(): Promise<ServiceStatus>;

  protected async prepareDirectories(): Promise<void> {
    await fs.mkdir(this.context.logDirectory, { recursive: true, mode: 0o700 });
  }
}

export class LinuxServiceManager extends BaseServiceManager {
  private readonly unitPath: string;

  constructor(context: ServiceContext, runner?: ServiceCommandRunner) {
    super(context, runner);
    this.unitPath = path.join(context.homeDir, '.config', 'systemd', 'user', `${SERVICE_NAME}.service`);
  }

  private createUnit(): string {
    return [
      '[Unit]',
      'Description=Remote CLI Client',
      'After=network-online.target',
      '',
      '[Service]',
      `ExecStart=${quoteSystemdArgument(this.context.nodePath)} ${quoteSystemdArgument(this.context.cliEntryPath)} start --non-interactive`,
      `WorkingDirectory=${escapeSystemdPath(this.context.homeDir)}`,
      `Environment=${quoteSystemdEnvironment('HOME', this.context.homeDir)}`,
      `Environment=${quoteSystemdEnvironment('PATH', this.context.pathValue)}`,
      `StandardOutput=append:${escapeSystemdPath(path.join(this.context.logDirectory, 'service.log'))}`,
      `StandardError=append:${escapeSystemdPath(path.join(this.context.logDirectory, 'service.error.log'))}`,
      'Restart=always',
      'RestartSec=5',
      'KillMode=mixed',
      'TimeoutStopSec=90s',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n');
  }

  async install(): Promise<ServiceStatus> {
    await this.prepareDirectories();
    await fs.mkdir(path.dirname(this.unitPath), { recursive: true, mode: 0o700 });
    const existing = await fs.lstat(this.unitPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing) await this.readManagedUnit();
    await fs.writeFile(this.unitPath, this.createUnit(), { mode: 0o600 });
    await this.prepareStopPolicy();
    await this.runner('systemctl', ['--user', 'enable', '--now', SERVICE_NAME]);
    return this.status();
  }

  /** Only the exact generated layout is eligible for automatic migration. */
  private async readManagedUnit(): Promise<string> {
    const stat = await fs.lstat(this.unitPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024) {
      throw new Error('The service unit is not a regular managed file; review it manually. No service operation was performed.');
    }
    const unit = await fs.readFile(this.unitPath, 'utf8');
    // Preserve previously captured executable, PATH, HOME and log locations.
    // Unknown directives, comments, duplicates or alternate layouts are custom.
    const normalize = (text: string) => text
      .replace(/^ExecStart="(?:[^"\\\n]|\\.)+" "(?:[^"\\\n]|\\.)+" start --non-interactive$/m, 'ExecStart=<managed>')
      .replace(/^WorkingDirectory=[^\n]+$/m, 'WorkingDirectory=<managed>')
      .replace(/^Environment="HOME=(?:[^"\\\n]|\\.)*"$/m, 'Environment=HOME')
      .replace(/^Environment="PATH=(?:[^"\\\n]|\\.)*"$/m, 'Environment=PATH')
      .replace(/^StandardOutput=append:[^\n]+$/m, 'StandardOutput=<managed>')
      .replace(/^StandardError=append:[^\n]+$/m, 'StandardError=<managed>');
    const legacy = this.createUnit().replace('KillMode=mixed\nTimeoutStopSec=90s\n', '');
    if (unit.split('\n').some(line => line.endsWith('\\') || line.includes('\r'))
      || (normalize(unit) !== normalize(legacy) && normalize(unit) !== normalize(this.createUnit()))) {
      throw new Error('The service unit has custom settings. Review its parent-first shutdown policy manually; it was not rewritten or stopped.');
    }
    return unit;
  }

  private async prepareStopPolicy(): Promise<void> {
    const unit = await this.readManagedUnit();
    if (!unit.includes('KillMode=mixed\n')) {
      const temporary = `${this.unitPath}.${randomUUID()}.tmp`;
      try {
        const stat = await fs.lstat(this.unitPath);
        await fs.writeFile(temporary, unit.replace('RestartSec=5\n', 'RestartSec=5\nKillMode=mixed\nTimeoutStopSec=90s\n'),
          { mode: stat.mode & 0o777, flag: 'wx' });
        if (await this.readManagedUnit() !== unit) throw new Error('Service unit changed during migration; retry after review.');
        await fs.rename(temporary, this.unitPath);
      } finally { await fs.rm(temporary, { force: true }); }
    }
    // Reload before stop, including a running service installed by an older CLI.
    // Effective checks catch drop-ins and a stale or failed manager reload.
    await this.runner('systemctl', ['--user', 'daemon-reload']);
    const values = await this.properties();
    const duration = values.TimeoutStopUSec ?? '';
    const finiteTimeout = /^(?:[0-9]+(?:\.[0-9]+)?(?:us|ms|s|min|h|d|w) ?)+$/.test(duration)
      && /[1-9]/.test(duration);
    if (values.KillMode !== 'mixed' || values.KillSignal !== '15' || values.SendSIGKILL !== 'yes'
      || values.FinalKillSignal !== '9' || values.SendSIGHUP !== 'no' || !finiteTimeout
      || values.ExecStop !== '' || values.ExecStopPost !== '') {
      throw new Error('Effective systemd shutdown policy is incompatible with orderly native handoff. Review unit overrides; no start or stop was requested.');
    }
  }

  private async properties(): Promise<Record<string, string>> {
    // Empty stop-command properties are omitted unless --all is requested.
    const result = await this.runner('systemctl', ['--user', 'show', SERVICE_NAME, '--no-page', '--all']);
    return parseKeyValueOutput(result.stdout);
  }

  async uninstall(): Promise<ServiceStatus> {
    if (await fileExists(this.unitPath)) {
      await this.stop();
      await this.runner('systemctl', ['--user', 'disable', SERVICE_NAME]);
      await fs.rm(this.unitPath);
      await this.runner('systemctl', ['--user', 'daemon-reload']);
    }
    return this.status();
  }

  async start(): Promise<ServiceStatus> {
    if (!await fileExists(this.unitPath)) throw new Error('The user service is not installed. Run "remote-cli service install" first.');
    await this.prepareStopPolicy();
    await this.runner('systemctl', ['--user', 'start', SERVICE_NAME]);
    return this.status();
  }

  async stop(): Promise<ServiceStatus> {
    if (!await fileExists(this.unitPath)) throw new Error('The user service is not installed.');
    await this.prepareStopPolicy();
    await this.runner('systemctl', ['--user', 'stop', SERVICE_NAME]);
    const result = await this.properties();
    if (result.ActiveState !== 'inactive' || result.Result !== 'success') {
      throw new Error('Managed service shutdown was not confirmed successful. Native recovery may remain blocked; inspect the service before restarting.');
    }
    return this.status();
  }

  async status(): Promise<ServiceStatus> {
    const installed = await fileExists(this.unitPath);
    if (!installed) return this.createStatus(false, false, false);

    try {
      const result = await this.runner('systemctl', ['--user', 'show', SERVICE_NAME, '--no-page']);
      const values = parseKeyValueOutput(result.stdout);
      const pid = Number(values.MainPID);
      return this.createStatus(
        true,
        values.ActiveState === 'active',
        values.UnitFileState === 'enabled',
        Number.isFinite(pid) && pid > 0 ? pid : undefined,
        values.ActiveState
      );
    } catch (error) {
      return this.createStatus(true, false, false, undefined, error instanceof Error ? error.message : 'Service status unavailable');
    }
  }

  private createStatus(installed: boolean, running: boolean, enabled: boolean, pid?: number, detail?: string): ServiceStatus {
    return { platform: 'linux', supported: true, installed, running, enabled, servicePath: this.unitPath, serviceName: SERVICE_NAME, pid, detail };
  }
}

export class MacServiceManager extends BaseServiceManager {
  private readonly plistPath: string;
  private readonly domain: string;

  constructor(context: ServiceContext, runner?: ServiceCommandRunner, userId = typeof process.getuid === 'function' ? process.getuid() : undefined) {
    super(context, runner);
    if (userId === undefined) throw new Error('Unable to determine the current macOS user ID.');
    this.domain = `gui/${userId}`;
    this.plistPath = path.join(context.homeDir, 'Library', 'LaunchAgents', `${MAC_SERVICE_LABEL}.plist`);
  }

  async install(): Promise<ServiceStatus> {
    await this.prepareDirectories();
    await fs.mkdir(path.dirname(this.plistPath), { recursive: true, mode: 0o700 });
    const plist = this.createPlist();
    await fs.writeFile(this.plistPath, plist, { mode: 0o600 });
    await ignoreCommandFailure(this.runner, 'launchctl', ['bootout', this.domain, this.plistPath]);
    await this.runner('launchctl', ['bootstrap', this.domain, this.plistPath]);
    return this.status();
  }

  async uninstall(): Promise<ServiceStatus> {
    await ignoreCommandFailure(this.runner, 'launchctl', ['bootout', this.domain, this.plistPath]);
    await fs.rm(this.plistPath, { force: true });
    return this.status();
  }

  async start(): Promise<ServiceStatus> {
    if (!await fileExists(this.plistPath)) throw new Error('The user service is not installed. Run "remote-cli service install" first.');
    await ignoreCommandFailure(this.runner, 'launchctl', ['bootout', this.domain, this.plistPath]);
    await this.runner('launchctl', ['bootstrap', this.domain, this.plistPath]);
    return this.status();
  }

  async stop(): Promise<ServiceStatus> {
    if (!await fileExists(this.plistPath)) throw new Error('The user service is not installed.');
    await ignoreCommandFailure(this.runner, 'launchctl', ['bootout', this.domain, this.plistPath]);
    return this.status();
  }

  async status(): Promise<ServiceStatus> {
    const installed = await fileExists(this.plistPath);
    if (!installed) return this.createStatus(false, false, false);

    try {
      const result = await this.runner('launchctl', ['print', `${this.domain}/${MAC_SERVICE_LABEL}`]);
      const pidMatch = result.stdout.match(/\bpid\s*=\s*(\d+)/);
      const stateMatch = result.stdout.match(/\bstate\s*=\s*([^\n]+)/);
      const state = stateMatch?.[1].trim();
      const pid = pidMatch ? Number(pidMatch[1]) : undefined;
      const running = state === 'running' || (state === undefined && pid !== undefined && pid > 0);
      return this.createStatus(true, running, true, running ? pid : undefined, state);
    } catch (error) {
      return this.createStatus(true, false, false, undefined, error instanceof Error ? error.message : 'Service status unavailable');
    }
  }

  private createPlist(): string {
    const outputPath = path.join(this.context.logDirectory, 'service.log');
    const errorPath = path.join(this.context.logDirectory, 'service.error.log');
    const argumentsXml = [this.context.nodePath, this.context.cliEntryPath, 'start', '--non-interactive']
      .map((argument) => `    <string>${xmlEscape(argument)}</string>`)
      .join('\n');
    const environmentXml = [
      ['HOME', this.context.homeDir],
      ['PATH', this.context.pathValue],
    ].map(([key, value]) => `    <key>${key}</key>\n    <string>${xmlEscape(value)}</string>`).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MAC_SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(this.context.homeDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${environmentXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(outputPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(errorPath)}</string>
</dict>
</plist>
`;
  }

  private createStatus(installed: boolean, running: boolean, enabled: boolean, pid?: number, detail?: string): ServiceStatus {
    return { platform: 'darwin', supported: true, installed, running, enabled, servicePath: this.plistPath, serviceName: MAC_SERVICE_LABEL, pid, detail };
  }
}

export function createServiceManager(platform = process.platform, context = getServiceContext(), runner?: ServiceCommandRunner): ServiceManager {
  const servicePlatform = getServicePlatform(platform);
  return servicePlatform === 'linux'
    ? new LinuxServiceManager(context, runner)
    : new MacServiceManager(context, runner);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseKeyValueOutput(output: string): Record<string, string> {
  return Object.fromEntries(output.split(/\r?\n/).flatMap((line) => {
    const separator = line.indexOf('=');
    return separator > 0 ? [[line.slice(0, separator), line.slice(separator + 1)]] : [];
  }));
}
