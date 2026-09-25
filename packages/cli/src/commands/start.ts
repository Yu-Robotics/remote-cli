import { ConfigManager } from '../config/ConfigManager';
import { WebSocketClient } from '../client/WebSocketClient';
import { MessageHandler } from '../client/MessageHandler';
import { DirectoryGuard } from '../security/DirectoryGuard';
import { HooksConfigurator } from '../security/HooksConfigurator';
import { ThreadManager } from '../thread/ThreadManager';
import { ThreadExecutorPool } from '../thread/ThreadExecutorPool';
import { CLI_VERSION } from '../types';
import type { ExecutorConfig } from '../types/config';
import axios from 'axios';
import { execFile } from 'child_process';
import ora, { type Ora } from 'ora';
import { AutomaticUpdater } from '../update/AutomaticUpdater';
import { isValidVersion } from '../utils/version';
import { isZCodeAvailable } from '../executor/zcode/ZCodeCommand';

export { isNewerVersion } from '../utils/version';

/**
 * Start command options
 */
export interface StartCommandOptions {
  /** Run as daemon */
  daemon?: boolean;
  /** Exit after automatic updates so a process supervisor can restart the CLI. */
  nonInteractive?: boolean;
}

/**
 * Start command result
 */
export interface StartCommandResult {
  success: boolean;
  daemonMode?: boolean;
  error?: string;
}

/**
 * Check that the CLI binary for the chosen backend is reachable.
 * Prints a clear warning (non-fatal) if not found so the local operator
 * knows why commands will fail before the first Feishu message arrives.
 */
export async function checkBackendAvailability(type: string, spinner: Ora, executorConfig?: ExecutorConfig): Promise<void> {
  const isAgy = type === 'agy';
  const isCodex = type === 'codex';
  const isOpenCode = type === 'opencode';
  const isKimi = type === 'kimi';
  const isZCode = type === 'zcode';
  const isPi = type === 'pi';
  const cmd = isAgy ? (executorConfig?.agy?.command ?? 'agy')
    : isCodex ? (executorConfig?.codex?.command ?? 'codex')
      : isOpenCode ? (executorConfig?.opencode?.command ?? 'opencode')
        : isKimi ? (executorConfig?.kimi?.command ?? 'kimi')
          : isPi ? (executorConfig?.pi?.command ?? 'pi')
            : 'claude';
  const label = isAgy ? 'AGY CLI (Antigravity)'
    : isCodex ? 'Codex CLI (OpenAI)'
      : isOpenCode ? 'OpenCode CLI'
        : isKimi ? 'Kimi Code CLI'
        : isZCode ? 'ZCode'
        : isPi ? 'Pi'
        : 'Claude Code';

  const canRun = (args: string[]) => new Promise<boolean>((resolve) => {
    execFile(cmd, args, { timeout: 5000 }, (err) => resolve(!err));
  });
  const available = isZCode
    ? isZCodeAvailable(executorConfig?.zcode?.command)
    : await canRun(['--version']);

  if (!available) {
    spinner.warn(`${label} not found on PATH`);
    console.log('');
    console.log(`⚠️  The selected backend "${type}" (${label}) is not installed.`);
    console.log('Users will receive an error message via Feishu when they send commands.');
    console.log('You can switch backends with the /backend command in Feishu chat.');
    console.log('');
    spinner.start('Continuing...');
    return;
  }

  if (isCodex && !await canRun(['app-server', '--help'])) {
    spinner.warn(`${label} does not support app-server`);
    console.log('');
    console.log('⚠️  The installed Codex CLI is too old for the selected backend.');
    console.log('Update Codex CLI: npm install -g @openai/codex@latest');
    console.log('Users will receive an error message via Feishu until Codex CLI is updated.');
    console.log('');
    spinner.start('Continuing...');
  }
}

/** Read the Router package version without requiring interactive input. */
export async function getServerVersion(serverUrl: string): Promise<string | undefined> {
  try {
    const response = await axios.get<{ success: boolean; version: string }>(
      `${serverUrl}/api/version`,
      { timeout: 5000 }
    );
    const data = response.data;
    if (data?.success && typeof data.version === 'string' && isValidVersion(data.version)) {
      return data.version;
    }
  } catch {
    // Older routers and temporary network failures must not prevent startup.
  }
  return undefined;
}

/**
 * Start the remote CLI service
 */
export async function startCommand(
  options: StartCommandOptions
): Promise<StartCommandResult> {
  const spinner = ora('Starting remote CLI service...').start();

  try {
    const config = await ConfigManager.initialize();

    // Check if initialized
    if (!config.has('deviceId')) {
      spinner.fail('Device not initialized');
      return {
        success: false,
        error: 'Device not initialized. Please run "remote-cli init" first.',
      };
    }

    // Get configuration
    const allConfig = config.getAll();
    const { deviceId, serverUrl, security, service } = allConfig;

    // Validate configuration
    if (!deviceId) {
      spinner.fail('Missing deviceId');
      return {
        success: false,
        error: 'Configuration error: deviceId is missing',
      };
    }

    if (!serverUrl) {
      spinner.fail('Missing serverUrl');
      return {
        success: false,
        error: 'Configuration error: serverUrl is missing',
      };
    }

    if (!security?.allowedDirectories || security.allowedDirectories.length === 0) {
      spinner.fail('Missing allowedDirectories');
      return {
        success: false,
        error: 'Configuration error: allowedDirectories is missing',
      };
    }

    spinner.text = 'Checking server version...';
    const serverVersion = await getServerVersion(serverUrl);

    // Initialize components
    spinner.text = 'Initializing components...';

    const directoryGuard = new DirectoryGuard(security.allowedDirectories);

    // Remove the global PreToolUse hook installed by older remote-cli versions.
    spinner.text = 'Removing legacy security hooks...';
    const hooksConfigurator = new HooksConfigurator();
    try {
      await hooksConfigurator.unconfigure();
    } catch (hookError) {
      console.warn('⚠️  Failed to remove legacy security hooks:', hookError instanceof Error ? hookError.message : 'Unknown error');
    }

    // Get executor config
    const executorConfig = (config.get('executor') as ExecutorConfig | undefined) ?? { type: 'auto' as const };

    // Initialize thread manager (creates default thread if not exists, migrates from single session)
    spinner.text = 'Initializing thread manager...';
    const threadManager = await ThreadManager.initialize();

    // Initialize executor pool (lazily creates executors per thread)
    const threadPool = new ThreadExecutorPool(threadManager, directoryGuard, executorConfig);

    // Warn if the selected backend CLI is not installed
    await checkBackendAvailability(executorConfig.type ?? 'auto', spinner, executorConfig);

    // Check if any thread has a working directory configured.
    // Each thread restores its own workingDirectory lazily via ThreadExecutorPool.getExecutor(),
    // so no explicit setup is needed here. We only warn the user when no directory is set at all.
    const threads = threadManager.listThreads();
    const anyThreadHasWorkingDir = threads.some(t => t.workingDirectory);
    if (!anyThreadHasWorkingDir) {
      spinner.warn('Working directory not set');
      console.log('');
      console.log('⚠️  **Working Directory Not Set**');
      console.log('');
      console.log('You haven\'t set a working directory yet.');
      console.log('Use `/cd <directory>` command via Feishu to set your working directory.');
      console.log('');
      console.log('Example: /cd ~/workspace/my-project');
      console.log('');
      spinner.start('Continuing without working directory...');
    } else {
      // Log active working directories for each thread on startup
      for (const thread of threads) {
        if (thread.workingDirectory) {
          const label = threads.length > 1 ? ` [${thread.name}]` : '';
          console.log(`📂 Working directory${label}: ${thread.workingDirectory}`);
        }
      }
    }

    // Create WebSocket URL
    const wsUrl = serverUrl.replace(/^http/, 'ws') + '/ws';
    const wsClient = new WebSocketClient(wsUrl, deviceId);

    const messageHandler = new MessageHandler(wsClient, threadPool, threadManager, directoryGuard, config);
    const automaticUpdater = new AutomaticUpdater(CLI_VERSION, messageHandler, {
      restartAfterUpdate: options.nonInteractive === true,
      beforeRestart: async () => {
        wsClient.disconnect();
        await messageHandler.destroy();
      },
    });

    // Setup event handlers
    wsClient.on('connected', () => {
      console.log('✅ Connected to server');
    });

    wsClient.on('disconnected', () => {
      console.log('⚠️  Disconnected from server');
    });

    wsClient.on('error', (error) => {
      console.error('❌ WebSocket error:', error);
    });

    wsClient.on('message', async (message) => {
      if (message.type === 'binding_confirm' && message.data?.routerVersion) {
        void automaticUpdater.handleRouterVersion(message.data.routerVersion);
      }
      if (message.type === 'error' && message.data?.code === 'PROTOCOL_VERSION_INCOMPATIBLE') {
        void automaticUpdater.handleProtocolMismatch(serverUrl);
      }
      await messageHandler.handleMessage(message);
    });

    // Connect to server
    spinner.text = 'Connecting to server...';
    try {
      await wsClient.connect();
    } catch (error) {
      spinner.fail('Connection failed');
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Connection failed',
      };
    }

    // Save service state
    await config.set('service.running', true);
    await config.set('service.startedAt', Date.now());
    if (options.daemon) {
      await config.set('service.pid', process.pid);
    }

    spinner.succeed(
      options.daemon
        ? 'Remote CLI service started in daemon mode'
        : 'Remote CLI service started'
    );

    console.log(options.nonInteractive
      ? '[AutoUpdate] Enabled: updates wait for idle work, then restart through the process supervisor.'
      : '[AutoUpdate] Enabled: updates wait for idle work and take effect on your next start. This process will keep running.');
    if (serverVersion) void automaticUpdater.handleRouterVersion(serverVersion);

    return {
      success: true,
      daemonMode: options.daemon,
    };
  } catch (error) {
    spinner.fail('Failed to start service');
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
