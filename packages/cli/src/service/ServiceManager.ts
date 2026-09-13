import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

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
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
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
  return {
    homeDir,
    nodePath: overrides.nodePath ?? process.execPath,
    cliEntryPath,
    pathValue: overrides.pathValue ?? process.env.PATH ?? '',
    logDirectory: overrides.logDirectory ?? path.join(homeDir, '.remote-cli', 'logs'),
  };
}

export interface ServiceManager {
  install(): Promise<ServiceStatus>;
  uninstall(): Promise<ServiceStatus>;
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

  async install(): Promise<ServiceStatus> {
    await this.prepareDirectories();
    await fs.mkdir(path.dirname(this.unitPath), { recursive: true, mode: 0o700 });
    const unit = [
      '[Unit]',
      'Description=Remote CLI Client',
      'After=network-online.target',
      '',
      '[Service]',
      `ExecStart=${quoteSystemdArgument(this.context.nodePath)} ${quoteSystemdArgument(this.context.cliEntryPath)} start --non-interactive`,
      `WorkingDirectory=${quoteSystemdArgument(this.context.homeDir)}`,
      `Environment=HOME=${quoteSystemdArgument(this.context.homeDir)}`,
      `Environment=PATH=${quoteSystemdArgument(this.context.pathValue)}`,
      `StandardOutput=append:${quoteSystemdArgument(path.join(this.context.logDirectory, 'service.log'))}`,
      `StandardError=append:${quoteSystemdArgument(path.join(this.context.logDirectory, 'service.error.log'))}`,
      'Restart=always',
      'RestartSec=5',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n');
    await fs.writeFile(this.unitPath, unit, { mode: 0o600 });
    await this.runner('systemctl', ['--user', 'daemon-reload']);
    await this.runner('systemctl', ['--user', 'enable', '--now', SERVICE_NAME]);
    return this.status();
  }

  async uninstall(): Promise<ServiceStatus> {
    await ignoreCommandFailure(this.runner, 'systemctl', ['--user', 'disable', '--now', SERVICE_NAME]);
    await fs.rm(this.unitPath, { force: true });
    await ignoreCommandFailure(this.runner, 'systemctl', ['--user', 'daemon-reload']);
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

  async status(): Promise<ServiceStatus> {
    const installed = await fileExists(this.plistPath);
    if (!installed) return this.createStatus(false, false, false);

    try {
      const result = await this.runner('launchctl', ['print', `${this.domain}/${MAC_SERVICE_LABEL}`]);
      const pidMatch = result.stdout.match(/\bpid\s*=\s*(\d+)/);
      return this.createStatus(true, true, true, pidMatch ? Number(pidMatch[1]) : undefined);
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
