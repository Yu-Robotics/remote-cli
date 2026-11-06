import { ConfigManager } from '../config/ConfigManager';
import { machineId } from 'node-machine-id';
import axios from 'axios';
import ora from 'ora';
import os from 'os';
import { DeviceEnrollmentError, requestDeviceEnrollment } from '../files/DeviceEnrollment';

/**
 * Init command options
 */
export interface InitCommandOptions {
  /** Server URL */
  serverUrl: string;
  /** Force re-initialization */
  force?: boolean;
  /** Allowed directories */
  allowedDirs?: string[];
  /** Request device-key approval with the initial binding code. */
  withFiles?: boolean;
}

/**
 * Init command result
 */
export interface InitCommandResult {
  success: boolean;
  bindingCode?: string;
  deviceId?: string;
  error?: string;
  keyEnrollmentRequested?: boolean;
}

/**
 * Initialize the CLI and request binding code from server
 */
export async function initCommand(
  options: InitCommandOptions
): Promise<InitCommandResult> {
  const spinner = ora('Initializing remote CLI...').start();

  try {
    // Validate server URL
    if (!isValidUrl(options.serverUrl)) {
      spinner.fail('Invalid server URL');
      return {
        success: false,
        error: 'Invalid server URL format',
      };
    }

    const config = await ConfigManager.initialize();

    // Check if already initialized
    if (config.has('deviceId') && !options.force) {
      const existingDeviceId = config.get('deviceId');
      spinner.fail('Device already initialized');
      return {
        success: false,
        error: `Device already initialized with ID: ${existingDeviceId}. Use --force to re-initialize.`,
      };
    }

    // Generate device ID from machine ID
    let deviceId: string;
    try {
      const machine = await machineId();
      deviceId = `dev_${os.platform()}_${machine.substring(0, 12)}`;
    } catch (error) {
      spinner.fail('Failed to generate device ID');
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to generate device ID',
      };
    }

    // Request binding code from server
    spinner.text = 'Requesting binding code from server...';

    let bindingCode: string;
    if (options.withFiles) {
      ({ bindingCode } = await requestDeviceEnrollment({
        configDir: config.getConfigDir(), serverUrl: options.serverUrl, deviceId, deviceName: os.hostname(),
      }));
    } else {
      let response;
      try {
        response = await axios.post(
          `${options.serverUrl}/api/bind/request`,
          {
            deviceId,
            deviceName: os.hostname(),
            platform: os.platform(),
          },
          {
            timeout: 10000,
          }
        );
      } catch (error) {
        spinner.fail('Failed to connect to server');
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Network error',
        };
      }

      // Check server response
      if (!response.data.success) {
        spinner.fail('Server error');
        return {
          success: false,
          error: response.data.error || 'Server returned error',
        };
      }

      bindingCode = response.data.bindingCode;
    }

    // Save configuration
    await config.set('deviceId', deviceId);
    await config.set('serverUrl', options.serverUrl);

    // Set allowed directories
    const allowedDirs = options.allowedDirs || [
      os.homedir(),
    ];
    await config.set('security.allowedDirectories', allowedDirs);

    spinner.succeed(options.withFiles ? 'Key enrollment requested; Feishu approval is still required.' : 'Initialization successful!');

    return {
      success: true,
      bindingCode,
      deviceId,
      ...(options.withFiles ? { keyEnrollmentRequested: true } : {}),
    };
  } catch (error) {
    spinner.fail('Initialization failed');
    return {
      success: false,
      error: options.withFiles && !(error instanceof DeviceEnrollmentError)
        ? 'Initialization failed. Check local configuration storage and retry with --force; any saved device key will be reused.'
        : error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Validate URL format
 */
function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
