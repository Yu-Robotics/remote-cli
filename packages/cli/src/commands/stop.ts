import { ConfigManager } from '../config/ConfigManager';
import ora from 'ora';

/**
 * Stop command options
 */
export interface StopCommandOptions {
  /** Graceful shutdown */
  graceful?: boolean;
  /** Force stop */
  force?: boolean;
}

/**
 * Stop command result
 */
export interface StopCommandResult {
  success: boolean;
  graceful?: boolean;
  force?: boolean;
  error?: string;
}

/**
 * Stop the remote CLI service
 */
export async function stopCommand(
  options: StopCommandOptions = {}
): Promise<StopCommandResult> {
  const spinner = ora('Stopping remote CLI service...').start();

  try {
    const config = await ConfigManager.initialize();

    // Get service state
    const allConfig = config.getAll();
    const service = allConfig.service;

    // Check if service is running
    if (!service || !service.running) {
      spinner.fail('Service not running');
      return {
        success: false,
        error: 'Service is not running',
      };
    }

    // Terminate the running process
    const pid = service.pid as number | undefined;
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0); // check it exists
        process.kill(pid, 'SIGTERM');
      } catch (e: any) {
        if (e.code !== 'ESRCH') {
          // EPERM or other unexpected error
          spinner.warn(`Could not terminate process ${pid}: ${e.message}`);
        }
        // ESRCH = already dead, treat as success
      }
    }

    // Update service state
    await config.set('service.running', false);
    await config.set('service.stoppedAt', Date.now());
    await config.set('service.pid', null); // clear PID so next start sees a clean slate

    spinner.succeed('Remote CLI service stopped');

    return {
      success: true,
      graceful: options.graceful,
      force: options.force,
    };
  } catch (error) {
    spinner.fail('Failed to stop service');
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
