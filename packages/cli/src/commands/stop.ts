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

    // Handle graceful shutdown
    if (options.graceful) {
      spinner.text = 'Waiting for pending tasks to complete...';
      // In a real implementation, we would wait for tasks to finish
      // For now, just simulate a delay
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // Update service state
    await config.set('service.running', false);
    await config.set('service.stoppedAt', Date.now());

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
