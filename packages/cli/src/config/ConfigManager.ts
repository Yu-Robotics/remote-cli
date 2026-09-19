import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { Config, DEFAULT_CONFIG } from '../types/config';

/**
 * Configuration Manager
 * Responsible for reading, writing and managing configuration files
 */
export class ConfigManager {
  private config: Config;
  private configDir: string;
  private configFile: string;

  private constructor(config: Config, configDir: string, configFile: string) {
    this.config = config;
    this.configDir = configDir;
    this.configFile = configFile;
  }

  /**
   * Initialize configuration manager
   * @returns ConfigManager instance
   */
  static async initialize(): Promise<ConfigManager> {
    const homeDir = os.homedir();
    const configDir = path.join(homeDir, '.remote-cli');
    const configFile = path.join(configDir, 'config.json');

    // Ensure config directory exists
    try {
      await fs.access(configDir);
    } catch {
      await fs.mkdir(configDir, { recursive: true });
    }

    // Read or create config file
    let config: Config;
    let migration: ReturnType<typeof ConfigManager.migrateDeprecatedExecutorConfig> | undefined;
    try {
      const content = await fs.readFile(configFile, 'utf-8');
      migration = ConfigManager.migrateDeprecatedExecutorConfig(JSON.parse(content));
      // Merge with defaults for any missing fields
      config = ConfigManager.mergeWithDefaults(migration.config);
      // Validate config structure
      if (!ConfigManager.isValidConfig(config)) {
        throw new Error('Invalid config structure');
      }
    } catch (error) {
      // Config file does not exist or is invalid, use default config
      config = { ...DEFAULT_CONFIG };
      await fs.writeFile(configFile, JSON.stringify(config, null, 2), 'utf-8');
    }

    if (migration?.changed) {
      try {
        await fs.writeFile(configFile, JSON.stringify(config, null, 2), 'utf-8');
        for (const warning of migration.warnings) console.warn(warning);
      } catch (error) {
        console.warn('[Config] Failed to persist executor configuration migration:', error instanceof Error ? error.message : error);
      }
    }

    return new ConfigManager(config, configDir, configFile);
  }

  /** Migrate executor settings whose implementations have been removed. */
  private static migrateDeprecatedExecutorConfig(config: any): {
    config: any;
    changed: boolean;
    warnings: string[];
  } {
    const warnings: string[] = [];
    let changed = false;
    const executor = config?.executor;
    if (!executor || typeof executor !== 'object') return { config, changed, warnings };

    if (executor.type === 'claude-spawn') {
      executor.type = 'claude-persistent';
      changed = true;
      warnings.push('[Config] Migrated deprecated executor type "claude-spawn" to "claude-persistent".');
    }

    if (executor.codex && typeof executor.codex === 'object' && 'transport' in executor.codex) {
      if (executor.codex.transport === 'exec') {
        warnings.push('[Config] Codex exec transport was removed; migrated to app-server.');
      }
      delete executor.codex.transport;
      changed = true;
    }

    return { config, changed, warnings };
  }

  /**
   * Merge user config with defaults (for backward compatibility)
   * @param config User configuration
   * @returns Merged configuration
   */
  private static mergeWithDefaults(config: any): Config {
    return {
      ...DEFAULT_CONFIG,
      ...config,
      security: {
        ...DEFAULT_CONFIG.security,
        ...(config.security || {}),
      },
      server: {
        ...DEFAULT_CONFIG.server,
        ...(config.server || {}),
      },
    };
  }

  /**
   * Validate configuration structure
   * @param config Configuration object
   * @returns Whether it is valid
   */
  private static isValidConfig(config: any): config is Config {
    return (
      config &&
      typeof config === 'object' &&
      config.security &&
      typeof config.security === 'object' &&
      Array.isArray(config.security.allowedDirectories) &&
      Array.isArray(config.security.deniedCommands) &&
      typeof config.security.maxConcurrentTasks === 'number' &&
      config.server &&
      typeof config.server === 'object' &&
      typeof config.server.url === 'string' &&
      typeof config.server.reconnectInterval === 'number' &&
      typeof config.server.heartbeatInterval === 'number'
    );
  }

  /**
   * Get current configuration
   * @returns Configuration object (deep copy)
   */
  getConfig(): Config {
    return JSON.parse(JSON.stringify(this.config));
  }

  /**
   * Get configuration directory path
   * @returns Configuration directory path
   */
  getConfigDir(): string {
    return this.configDir;
  }

  /**
   * Get configuration file path
   * @returns Configuration file path
   */
  getConfigFile(): string {
    return this.configFile;
  }

  /**
   * Save configuration to file
   */
  private async saveConfig(): Promise<void> {
    await fs.writeFile(this.configFile, JSON.stringify(this.config, null, 2), 'utf-8');
  }

  /**
   * Add allowed directory
   * @param directory Directory path (supports ~ and relative paths)
   */
  async addAllowedDirectory(directory: string): Promise<void> {
    // Validate directory path
    if (!directory || directory.trim() === '') {
      throw new Error('Invalid directory path');
    }

    // Only allow ~ prefix or relative paths, not absolute paths
    if (directory.startsWith('/') && !directory.startsWith('~/')) {
      throw new Error('Only home directory and relative paths are allowed');
    }

    // Check if already exists
    if (!this.config.security.allowedDirectories.includes(directory)) {
      this.config.security.allowedDirectories.push(directory);
      await this.saveConfig();
    }
  }

  /**
   * Remove allowed directory
   * @param directory Directory path
   */
  async removeAllowedDirectory(directory: string): Promise<void> {
    this.config.security.allowedDirectories = this.config.security.allowedDirectories.filter(
      d => d !== directory
    );
    await this.saveConfig();
  }

  /**
   * Add denied command
   * @param command Command pattern
   */
  async addDeniedCommand(command: string): Promise<void> {
    if (!this.config.security.deniedCommands.includes(command)) {
      this.config.security.deniedCommands.push(command);
      await this.saveConfig();
    }
  }

  /**
   * Remove denied command
   * @param command Command pattern
   */
  async removeDeniedCommand(command: string): Promise<void> {
    this.config.security.deniedCommands = this.config.security.deniedCommands.filter(
      c => c !== command
    );
    await this.saveConfig();
  }

  /**
   * Update server URL
   * @param url WebSocket server URL
   */
  async updateServerUrl(url: string): Promise<void> {
    // Validate URL format
    if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
      throw new Error('Invalid server URL: must start with ws:// or wss://');
    }

    this.config.server.url = url;
    await this.saveConfig();
  }

  /**
   * Update maximum concurrent tasks
   * @param max Maximum concurrent tasks
   */
  async updateMaxConcurrentTasks(max: number): Promise<void> {
    if (max < 1) {
      throw new Error('Max concurrent tasks must be at least 1');
    }

    this.config.security.maxConcurrentTasks = max;
    await this.saveConfig();
  }

  /**
   * Reset configuration to defaults
   */
  async resetToDefaults(): Promise<void> {
    this.config = { ...DEFAULT_CONFIG };
    await this.saveConfig();
  }

  /**
   * Export configuration as JSON string
   * @returns JSON string
   */
  exportConfig(): string {
    return JSON.stringify(this.config, null, 2);
  }

  /**
   * Import configuration from JSON string
   * @param json JSON string
   */
  async importConfig(json: string): Promise<void> {
    try {
      const config = JSON.parse(json);

      if (!ConfigManager.isValidConfig(config)) {
        throw new Error('Invalid config structure');
      }

      this.config = config;
      await this.saveConfig();
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error('Invalid JSON format');
      }
      throw error;
    }
  }

  /**
   * Check if configuration key exists
   * @param keyPath Key path (supports dot-separated nested paths)
   * @returns Whether it exists
   */
  has(keyPath: string): boolean {
    return this.get(keyPath) !== undefined;
  }

  /**
   * Get configuration value
   * @param keyPath Key path (supports dot-separated nested paths, e.g. 'security.allowedDirectories')
   * @returns Configuration value
   */
  get(keyPath: string): any {
    const keys = keyPath.split('.');
    let value: any = this.config;

    for (const key of keys) {
      if (value === null || value === undefined || typeof value !== 'object') {
        return undefined;
      }
      value = value[key];
    }

    return value;
  }

  /**
   * Set configuration value
   * @param keyPath Key path (supports dot-separated nested paths)
   * @param value Configuration value
   */
  async set(keyPath: string, value: any): Promise<void> {
    // Ensure config is initialized
    if (!this.config || typeof this.config !== 'object') {
      throw new Error('ConfigManager not properly initialized. Use ConfigManager.initialize()');
    }

    const keys = keyPath.split('.');
    const lastKey = keys.pop()!;
    let target: any = this.config;

    // Navigate to target object
    for (const key of keys) {
      if (!(key in target) || typeof target[key] !== 'object' || target[key] === null) {
        target[key] = {};
      }
      target = target[key];
    }

    // Set value
    target[lastKey] = value;

    // Save configuration
    await this.saveConfig();
  }

  /**
   * Get all configuration (alias for getConfig)
   * @returns Configuration object (deep copy)
   */
  getAll(): Config {
    return this.getConfig();
  }
}
