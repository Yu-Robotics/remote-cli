import { ConfigManager } from '../config/ConfigManager';

/**
 * Config command action types
 */
export type ConfigAction = 'add-dir' | 'remove-dir' | 'list-dirs' | 'set' | 'get' | 'show';

/**
 * Config command options
 */
export interface ConfigCommandOptions {
  /** Action to perform */
  action: ConfigAction;
  /** Directory path (for add-dir/remove-dir) */
  directory?: string;
  /** Configuration key (for set/get) */
  key?: string;
  /** Configuration value (for set) */
  value?: string;
  /** Output as JSON */
  json?: boolean;
}

/**
 * Config command result
 */
export interface ConfigCommandResult {
  success: boolean;
  directories?: string[];
  config?: any;
  value?: any;
  json?: boolean;
  error?: string;
}

/**
 * Protected configuration keys that cannot be modified
 */
const PROTECTED_KEYS = ['deviceId', 'openId', 'service'];

/**
 * Manage configuration
 */
export async function configCommand(
  options: ConfigCommandOptions
): Promise<ConfigCommandResult> {
  try {
    const config = await ConfigManager.initialize();

    switch (options.action) {
      case 'add-dir':
        return await handleAddDirectory(config, options);
      case 'remove-dir':
        return await handleRemoveDirectory(config, options);
      case 'list-dirs':
        return handleListDirectories(config);
      case 'set':
        return await handleSetConfig(config, options);
      case 'get':
        return handleGetConfig(config, options);
      case 'show':
        return handleShowConfig(config, options);
      default:
        return {
          success: false,
          error: `Invalid action: ${options.action}`,
        };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Add directory to allowed list
 */
async function handleAddDirectory(
  config: ConfigManager,
  options: ConfigCommandOptions
): Promise<ConfigCommandResult> {
  const { directory } = options;

  if (!directory || directory.trim() === '') {
    return {
      success: false,
      error: 'Invalid directory path',
    };
  }

  const allConfig = config.getAll();
  const currentDirs = allConfig.security?.allowedDirectories || [];

  // Check if directory already exists
  if (currentDirs.includes(directory)) {
    return {
      success: false,
      error: `Directory already exists in allowed list: ${directory}`,
    };
  }

  // Add directory
  const newDirs = [...currentDirs, directory];
  await config.set('security.allowedDirectories', newDirs);

  return {
    success: true,
    directories: newDirs,
  };
}

/**
 * Remove directory from allowed list
 */
async function handleRemoveDirectory(
  config: ConfigManager,
  options: ConfigCommandOptions
): Promise<ConfigCommandResult> {
  const { directory } = options;

  if (!directory) {
    return {
      success: false,
      error: 'Directory path is required',
    };
  }

  const allConfig = config.getAll();
  const currentDirs = allConfig.security?.allowedDirectories || [];

  // Check if directory exists
  if (!currentDirs.includes(directory)) {
    return {
      success: false,
      error: `Directory not found in allowed list: ${directory}`,
    };
  }

  // Prevent removing last directory
  if (currentDirs.length === 1) {
    return {
      success: false,
      error: 'Cannot remove last directory. At least one directory must be allowed.',
    };
  }

  // Remove directory
  const newDirs = currentDirs.filter((dir) => dir !== directory);
  await config.set('security.allowedDirectories', newDirs);

  return {
    success: true,
    directories: newDirs,
  };
}

/**
 * List allowed directories
 */
function handleListDirectories(config: ConfigManager): ConfigCommandResult {
  const allConfig = config.getAll();
  const directories = allConfig.security?.allowedDirectories || [];

  return {
    success: true,
    directories,
  };
}

/**
 * Set configuration value
 */
async function handleSetConfig(
  config: ConfigManager,
  options: ConfigCommandOptions
): Promise<ConfigCommandResult> {
  const { key, value } = options;

  if (!key || !value) {
    return {
      success: false,
      error: 'Both key and value are required',
    };
  }

  // Check if key is protected
  if (PROTECTED_KEYS.some((protected_key) => key.startsWith(protected_key))) {
    return {
      success: false,
      error: `Cannot modify protected key: ${key}`,
    };
  }

  // Validate specific keys
  if (key === 'serverUrl') {
    if (!isValidUrl(value)) {
      return {
        success: false,
        error: 'Invalid server URL format',
      };
    }
  }

  if (key === 'maintenance.updateNotice' || key === 'maintenance.subscriptionInspection') {
    if (value !== 'true' && value !== 'false') return { success: false, error: 'Maintenance options require true or false.' };
    const enabled = value === 'true';
    await config.set(key, enabled);
    return { success: true, value: enabled };
  }

  await config.set(key, value);

  return {
    success: true,
    value,
  };
}

/**
 * Get configuration value
 */
function handleGetConfig(
  config: ConfigManager,
  options: ConfigCommandOptions
): ConfigCommandResult {
  const { key } = options;

  if (!key) {
    return {
      success: false,
      error: 'Key is required',
    };
  }

  const value = config.get(key);

  if (value === undefined) {
    return {
      success: false,
      error: `Configuration key not found: ${key}`,
    };
  }

  return {
    success: true,
    value,
  };
}

/**
 * Show all configuration
 */
function handleShowConfig(
  config: ConfigManager,
  options: ConfigCommandOptions
): ConfigCommandResult {
  const allConfig = config.getAll();

  return {
    success: true,
    config: allConfig,
    json: options.json,
  };
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
