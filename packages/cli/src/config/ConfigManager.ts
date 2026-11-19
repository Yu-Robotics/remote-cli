import { delegationSharedSymlinks } from '../delegation/SharedSymlinks';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { Config, DEFAULT_CONFIG } from '../types/config';
import { DamagedCatalog, readCatalog, withCatalogLock, writeCatalog } from './CatalogFile';

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

    return withCatalogLock(configFile, async () => {
      const loaded = await readCatalog(configFile, ConfigManager.parse);
      const config = loaded?.config ?? structuredClone(DEFAULT_CONFIG);
      if (!loaded) await writeCatalog(configFile, JSON.stringify(config, null, 2));
      else if (loaded.changed) {
        try {
          await writeCatalog(configFile, JSON.stringify(config, null, 2));
          for (const warning of loaded.warnings) console.warn(warning);
        } catch (error) {
          console.warn('[Config] Failed to persist executor configuration migration:', error instanceof Error ? error.message : error);
        }
      }
      return new ConfigManager(config, configDir, configFile);
    });
  }

  private static parse(content: string) {
    const raw = JSON.parse(content);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DamagedCatalog('Invalid configuration.');
    const migration = ConfigManager.migrateDeprecatedExecutorConfig(raw);
    const config = ConfigManager.mergeWithDefaults(migration.config);
    if (!ConfigManager.isValidConfig(config)) throw new DamagedCatalog('Invalid configuration.');
    return { ...migration, config };
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

  /** Read current managed-only grants without replacing runtime configuration or migrating disk data. */
  async getSharedSymlinks() {
    let content: string;
    try {
      content = await fs.readFile(this.configFile, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error('Unable to load shared-symlink grants; managed admission is denied.');
    }
    try {
      const saved: unknown = JSON.parse(content);
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error();
      return delegationSharedSymlinks((saved as Record<string, unknown>).delegation);
    } catch {
      // Parser and filesystem details can contain private configuration data.
      throw new Error('Invalid shared-symlink configuration; managed admission is denied.');
    }
  }

  /** Return an independent configuration snapshot. */
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

  /** Isolate runtime catalogs while keeping device configuration and grants authoritative. */
  forThreadRecovery(directory: string): ConfigManager {
    return new ConfigManager(this.getConfig(), directory, this.configFile);
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
  private async saveConfig(update: (current: Config) => Config): Promise<void> {
    await withCatalogLock(this.configFile, async () => {
      let content: string;
      try { content = await fs.readFile(this.configFile, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Unable to preserve shared-symlink policy while saving configuration.');
        content = '{}';
      }
      let current: Config;
      try { current = ConfigManager.parse(content).config; }
      catch { throw new Error('Invalid configuration; shared-symlink policy was not overwritten.'); }
      const next = update(current);
      await writeCatalog(this.configFile, JSON.stringify(next, null, 2));
      // An unrelated write must not hot-switch an active client's identity or policy.
      this.config = update(this.getConfig());
    });
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
    await this.saveConfig(config => {
      if (!config.security.allowedDirectories.includes(directory)) config.security.allowedDirectories.push(directory);
      return config;
    });
  }

  /**
   * Remove allowed directory
   * @param directory Directory path
   */
  async removeAllowedDirectory(directory: string): Promise<void> {
    await this.saveConfig(config => {
      config.security.allowedDirectories = config.security.allowedDirectories.filter(d => d !== directory);
      return config;
    });
  }

  /**
   * Add denied command
   * @param command Command pattern
   */
  async addDeniedCommand(command: string): Promise<void> {
    await this.saveConfig(config => {
      if (!config.security.deniedCommands.includes(command)) config.security.deniedCommands.push(command);
      return config;
    });
  }

  /**
   * Remove denied command
   * @param command Command pattern
   */
  async removeDeniedCommand(command: string): Promise<void> {
    await this.saveConfig(config => {
      config.security.deniedCommands = config.security.deniedCommands.filter(c => c !== command);
      return config;
    });
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

    await this.set('server.url', url);
  }

  /**
   * Update maximum concurrent tasks
   * @param max Maximum concurrent tasks
   */
  async updateMaxConcurrentTasks(max: number): Promise<void> {
    if (max < 1) {
      throw new Error('Max concurrent tasks must be at least 1');
    }

    await this.set('security.maxConcurrentTasks', max);
  }

  /**
   * Reset configuration to defaults
   */
  async resetToDefaults(): Promise<void> {
    await this.saveConfig(() => structuredClone(DEFAULT_CONFIG));
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

      await this.saveConfig(() => config);
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
    if (this.configDir !== path.dirname(this.configFile) && keyPath === 'sessionSharing') return { enabled: false };
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
    if ([...keys, lastKey].some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) throw new Error('Invalid configuration key');
    await this.saveConfig(config => {
      let target: any = config;
      for (const key of keys) {
        if (!Object.hasOwn(target, key) || typeof target[key] !== 'object' || target[key] === null) target[key] = {};
        target = target[key];
      }
      target[lastKey] = value;
      return config;
    });
  }

  /**
   * Get all configuration (alias for getConfig)
   * @returns Configuration object (deep copy)
   */
  getAll(): Config {
    return this.getConfig();
  }
}
