import axios from 'axios';
import { execFile } from 'child_process';
import path from 'path';
import { isNewerVersion, isValidVersion } from '../utils/version';

const CLI_PACKAGE = '@yu_robotics/remote-cli';

export interface UpdateReadiness {
  tryBeginAutomaticUpdate(): boolean;
  endAutomaticUpdate(): void;
}

export interface AutomaticUpdaterDependencies {
  installVersion: (version: string) => Promise<void>;
  beforeRestart: () => Promise<void>;
  exitProcess: (code: number) => void;
  retryDelayMs: number;
  failureRetryDelayMs: number;
}

export interface AutomaticUpdaterOptions extends Partial<AutomaticUpdaterDependencies> {
  /** Exit after installation only when a supervisor will restart this process. */
  restartAfterUpdate?: boolean;
}

function executeFile(command: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', timeout }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

export async function installGlobalCliVersion(version: string, cliEntryPath = path.resolve(process.argv[1])): Promise<void> {
  if (!isValidVersion(version)) throw new Error(`Invalid Router version: ${version}`);
  const packageSpec = `${CLI_PACKAGE}@${version}`;
  const publishedVersion = JSON.parse(await executeFile('npm', ['view', packageSpec, 'version', '--json'], 30_000));
  if (publishedVersion !== version) throw new Error(`${packageSpec} is not available from the configured npm registry`);
  await executeFile('npm', ['install', '-g', packageSpec, '--no-audit', '--no-fund'], 5 * 60_000);
  const installedVersion = await executeFile(process.execPath, [cliEntryPath, '--version'], 10_000);
  if (installedVersion !== version) {
    throw new Error(`Installed CLI version ${installedVersion || 'unknown'} does not match Router version ${version}`);
  }
}

export class AutomaticUpdater {
  private pendingVersion?: string;
  private installedVersion: string;
  private retryTimer?: NodeJS.Timeout;
  private updating = false;
  private readonly restartAfterUpdate: boolean;

  constructor(
    private readonly currentVersion: string,
    private readonly readiness: UpdateReadiness,
    dependencies: AutomaticUpdaterOptions = {}
  ) {
    this.installedVersion = currentVersion;
    this.restartAfterUpdate = dependencies.restartAfterUpdate ?? true;
    this.dependencies = {
      installVersion: dependencies.installVersion ?? ((version) => installGlobalCliVersion(version)),
      beforeRestart: dependencies.beforeRestart ?? (async () => {}),
      exitProcess: dependencies.exitProcess ?? ((code) => process.exit(code)),
      retryDelayMs: dependencies.retryDelayMs ?? 1000,
      failureRetryDelayMs: dependencies.failureRetryDelayMs ?? 60_000,
    };
  }

  private readonly dependencies: AutomaticUpdaterDependencies;

  async handleRouterVersion(routerVersion: string): Promise<void> {
    if (!isNewerVersion(routerVersion, this.installedVersion)) return;
    if (!this.pendingVersion || isNewerVersion(routerVersion, this.pendingVersion)) {
      this.pendingVersion = routerVersion;
      console.log(`[AutoUpdate] Router ${routerVersion} is newer than running CLI ${this.currentVersion}.`);
    }
    await this.attemptUpdate();
  }

  async handleProtocolMismatch(serverUrl: string): Promise<void> {
    if (!this.restartAfterUpdate) {
      console.warn(`[AutoUpdate] Router rejected running CLI ${this.currentVersion}. After the update is installed, stop this process and run "remote-cli start" again to connect.`);
    }
    try {
      const response = await axios.get<{ success: boolean; version: string }>(`${serverUrl}/api/version`, { timeout: 5000 });
      if (response.data?.success && response.data.version) {
        await this.handleRouterVersion(response.data.version);
      }
    } catch (error) {
      console.error('[AutoUpdate] Failed to resolve Router version after protocol rejection:', error instanceof Error ? error.message : error);
    }
  }

  private async attemptUpdate(): Promise<void> {
    if (this.updating || !this.pendingVersion) return;
    if (!this.readiness.tryBeginAutomaticUpdate()) {
      console.log('[AutoUpdate] Waiting for active tasks and queues to finish.');
      this.scheduleAttempt(this.dependencies.retryDelayMs);
      return;
    }

    this.updating = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    const targetVersion = this.pendingVersion;
    console.log(`[AutoUpdate] Installing ${CLI_PACKAGE}@${targetVersion}...`);
    try {
      await this.dependencies.installVersion(targetVersion);
      if (!this.restartAfterUpdate) {
        this.installedVersion = targetVersion;
        if (this.pendingVersion === targetVersion) this.pendingVersion = undefined;
        this.updating = false;
        this.readiness.endAutomaticUpdate();
        console.log(`[AutoUpdate] CLI ${targetVersion} installed. Running CLI ${this.currentVersion} will continue; the new version takes effect the next time you start remote-cli.`);
        if (this.pendingVersion) this.scheduleAttempt(this.dependencies.retryDelayMs);
        return;
      }
      console.log(`[AutoUpdate] CLI ${targetVersion} installed successfully. Exiting for the process supervisor to restart...`);
      await this.dependencies.beforeRestart();
      this.dependencies.exitProcess(0);
    } catch (error) {
      console.error('[AutoUpdate] Upgrade failed; continuing with the current process and retrying later:', error instanceof Error ? error.message : error);
      console.error(`[AutoUpdate] To update manually: npm install -g ${CLI_PACKAGE}@${targetVersion}`);
      this.updating = false;
      this.readiness.endAutomaticUpdate();
      this.scheduleAttempt(this.dependencies.failureRetryDelayMs);
    }
  }

  private scheduleAttempt(delayMs: number): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.attemptUpdate();
    }, delayMs);
  }
}
