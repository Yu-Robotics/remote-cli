import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConfigManager } from '../src/config/ConfigManager';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

import * as catalogFile from '../src/config/CatalogFile';

describe('ConfigManager', () => {
  let configManager: ConfigManager;
  let home: string, mockConfigDir: string, mockConfigFile: string;
  const readConfig = async () => JSON.parse(await fs.readFile(mockConfigFile, 'utf8'));

  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'config-test-')));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    mockConfigDir = path.join(home, '.remote-cli');
    mockConfigFile = path.join(mockConfigDir, 'config.json');
    await fs.mkdir(mockConfigDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(home, { recursive: true, force: true });
  });

  describe('initialization', () => {
    it('should create config directory if not exists', async () => {
      await fs.rmdir(mockConfigDir);

      configManager = await ConfigManager.initialize();

      expect((await fs.stat(mockConfigDir)).isDirectory()).toBe(true);
    });

    it('should create default config file if not exists', async () => {

      configManager = await ConfigManager.initialize();

      expect((await readConfig()).security.allowedDirectories).toEqual([]);
    });

    it('defaults session sharing to disabled without migrating thread metadata', async () => {
      await fs.writeFile(mockConfigFile, JSON.stringify({ security: { allowedDirectories: ['~/projects'] } }));
      const bytes = await fs.readFile(mockConfigFile);
      const config = await ConfigManager.initialize();
      expect(config.get('sessionSharing.enabled')).toBe(false);
      expect(await fs.readFile(mockConfigFile)).toEqual(bytes);
    });

    it('preserves malformed session-sharing opt-in for fail-closed validation without resetting unrelated values', async () => {
      const existing = { deviceId: 'synthetic-device', sessionSharing: { enabled: 'true' }, security: { allowedDirectories: ['~/projects'] } };
      await fs.writeFile(mockConfigFile, JSON.stringify(existing));
      const bytes = await fs.readFile(mockConfigFile);
      const config = await ConfigManager.initialize();
      expect(config.get('deviceId')).toBe(existing.deviceId);
      expect(config.get('sessionSharing')).toEqual(existing.sessionSharing);
      expect(await fs.readFile(mockConfigFile)).toEqual(bytes);
    });

    it('should load existing config file', async () => {
      const existingConfig = {
        security: {
          allowedDirectories: ['~/projects', '~/work'],
          deniedCommands: ['rm -rf /'],
          maxConcurrentTasks: 1
        },
        server: {
          url: 'wss://localhost:3000',
          reconnectInterval: 5000,
          heartbeatInterval: 30000
        }
      };

      await fs.writeFile(mockConfigFile, JSON.stringify(existingConfig));

      configManager = await ConfigManager.initialize();
      const config = configManager.getConfig();

      expect(config.security.allowedDirectories).toEqual(existingConfig.security.allowedDirectories);
      expect(config.server.url).toBe(existingConfig.server.url);
    });

    it('should persistently migrate removed executor modes', async () => {
      const existingConfig = {
        security: {
          allowedDirectories: ['~/projects'],
          deniedCommands: [],
          maxConcurrentTasks: 1
        },
        server: {
          url: 'wss://localhost:3000',
          reconnectInterval: 5000,
          heartbeatInterval: 30000
        },
        executor: {
          type: 'claude-spawn',
          codex: { model: 'gpt-5.2-codex', transport: 'exec' }
        }
      };
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await fs.writeFile(mockConfigFile, JSON.stringify(existingConfig));

      configManager = await ConfigManager.initialize();

      expect(configManager.getConfig().executor).toEqual({
        type: 'claude-persistent',
        codex: { model: 'gpt-5.2-codex' }
      });
      const persisted = await readConfig();
      expect(persisted.executor).toEqual({
        type: 'claude-persistent',
        codex: { model: 'gpt-5.2-codex' }
      });
      expect(warn).toHaveBeenCalledWith(
        '[Config] Migrated deprecated executor type "claude-spawn" to "claude-persistent".'
      );
      expect(warn).toHaveBeenCalledWith(
        '[Config] Codex exec transport was removed; migrated to app-server.'
      );
      warn.mockRestore();
    });

    it('should keep the migrated config in memory if persistence fails', async () => {
      const existingConfig = {
        security: {
          allowedDirectories: ['~/projects'],
          deniedCommands: [],
          maxConcurrentTasks: 1
        },
        server: {
          url: 'wss://localhost:3000',
          reconnectInterval: 5000,
          heartbeatInterval: 30000
        },
        executor: { type: 'claude-spawn' }
      };
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await fs.writeFile(mockConfigFile, JSON.stringify(existingConfig));
      vi.spyOn(catalogFile, 'writeCatalog').mockRejectedValueOnce(new Error('read only'));

      configManager = await ConfigManager.initialize();

      expect(configManager.getConfig().executor?.type).toBe('claude-persistent');
      expect(warn).toHaveBeenCalledWith(
        '[Config] Failed to persist executor configuration migration:',
        'read only'
      );
      warn.mockRestore();
    });

    it('should handle malformed config file gracefully', async () => {
      await fs.writeFile(mockConfigFile, 'invalid json');

      await expect(ConfigManager.initialize()).rejects.toThrow('Damaged config.json');
      expect(await fs.readFile(mockConfigFile, 'utf8')).toBe('invalid json');
    });
  });

  describe('config management', () => {
    beforeEach(async () => {
      await fs.writeFile(mockConfigFile, JSON.stringify({
        security: {
          allowedDirectories: ['~/projects'],
          deniedCommands: [],
          maxConcurrentTasks: 1
        },
        server: {
          url: 'wss://localhost:3000',
          reconnectInterval: 5000,
          heartbeatInterval: 30000
        }
      }));

      configManager = await ConfigManager.initialize();
    });

    it('should get current config', () => {
      const config = configManager.getConfig();

      expect(config).toHaveProperty('security');
      expect(config).toHaveProperty('server');
      expect(config.security).toHaveProperty('allowedDirectories');
    });

    it('retains independent updates by concurrent managers in the recovered snapshot', async () => {
      const other = await ConfigManager.initialize();
      await Promise.all([configManager.set('deviceId', 'fixture-device'), other.set('executor.type', 'codex')]);
      await fs.writeFile(mockConfigFile, '{');
      const restored = await ConfigManager.initialize();
      expect(restored.getConfig()).toMatchObject({ deviceId: 'fixture-device', executor: { type: 'codex' } });
    });

    it.each(['previous file', 'modified payload'])('refuses a %s backup after a directory grant is revoked', async kind => {
      await configManager.addAllowedDirectory('~/temporary');
      const backupFile = mockConfigFile + '.bak';
      const previous = JSON.parse(await fs.readFile(backupFile, 'utf8'));
      await configManager.removeAllowedDirectory('~/temporary');
      const current = JSON.parse(await fs.readFile(backupFile, 'utf8'));
      await fs.writeFile(backupFile, JSON.stringify(kind === 'previous file' ? previous : { ...current, data: previous.data }));
      await fs.writeFile(mockConfigFile, 'damaged');
      await expect(ConfigManager.initialize()).rejects.toThrow('Damaged config.json');
      expect(await fs.readFile(mockConfigFile, 'utf8')).toBe('damaged');
    });

    it('should add allowed directory', async () => {
      await configManager.addAllowedDirectory('~/new-project');

      const config = configManager.getConfig();
      expect(config.security.allowedDirectories).toContain('~/new-project');
      expect(await readConfig()).toEqual(config);
    });

    it('should not add duplicate directory', async () => {
      await configManager.addAllowedDirectory('~/projects');

      const config = configManager.getConfig();
      const count = config.security.allowedDirectories.filter(d => d === '~/projects').length;
      expect(count).toBe(1);
    });

    it('should remove allowed directory', async () => {
      await configManager.addAllowedDirectory('~/temp');
      await configManager.removeAllowedDirectory('~/temp');

      const config = configManager.getConfig();
      expect(config.security.allowedDirectories).not.toContain('~/temp');
      expect(await readConfig()).toEqual(config);
    });

    it('should add denied command', async () => {
      await configManager.addDeniedCommand('sudo rm');

      const config = configManager.getConfig();
      expect(config.security.deniedCommands).toContain('sudo rm');
      expect(await readConfig()).toEqual(config);
    });

    it('should remove denied command', async () => {
      await configManager.addDeniedCommand('test command');
      await configManager.removeDeniedCommand('test command');

      const config = configManager.getConfig();
      expect(config.security.deniedCommands).not.toContain('test command');
    });

    it('should update server url', async () => {
      await configManager.updateServerUrl('wss://new-server.com');

      const config = configManager.getConfig();
      expect(config.server.url).toBe('wss://new-server.com');
      expect(await readConfig()).toEqual(config);
    });

    it('should update max concurrent tasks', async () => {
      await configManager.updateMaxConcurrentTasks(3);

      const config = configManager.getConfig();
      expect(config.security.maxConcurrentTasks).toBe(3);
      expect(await readConfig()).toEqual(config);
    });
  });

  describe('validation', () => {
    beforeEach(async () => {
      await fs.writeFile(mockConfigFile, JSON.stringify({
        security: {
          allowedDirectories: ['~/projects'],
          deniedCommands: [],
          maxConcurrentTasks: 1
        },
        server: {
          url: 'wss://localhost:3000',
          reconnectInterval: 5000,
          heartbeatInterval: 30000
        }
      }));

      configManager = await ConfigManager.initialize();
    });

    it('should validate directory path format', async () => {
      await expect(
        configManager.addAllowedDirectory('')
      ).rejects.toThrow('Invalid directory path');
    });

    it('should validate server URL format', async () => {
      await expect(
        configManager.updateServerUrl('invalid-url')
      ).rejects.toThrow('Invalid server URL');
    });

    it('should validate max concurrent tasks', async () => {
      await expect(
        configManager.updateMaxConcurrentTasks(0)
      ).rejects.toThrow('Max concurrent tasks must be at least 1');

      await expect(
        configManager.updateMaxConcurrentTasks(-1)
      ).rejects.toThrow('Max concurrent tasks must be at least 1');
    });

    it('should reject absolute paths for allowed directories', async () => {
      await expect(
        configManager.addAllowedDirectory('/etc')
      ).rejects.toThrow('Only home directory and relative paths are allowed');
    });
  });

  describe('config path utilities', () => {
    beforeEach(async () => {
      await fs.writeFile(mockConfigFile, JSON.stringify({
        security: {
          allowedDirectories: ['~/projects'],
          deniedCommands: [],
          maxConcurrentTasks: 1
        },
        server: {
          url: 'wss://localhost:3000',
          reconnectInterval: 5000,
          heartbeatInterval: 30000
        }
      }));

      configManager = await ConfigManager.initialize();
    });

    it('should return config directory path', () => {
      const configDir = configManager.getConfigDir();
      expect(configDir).toBe(mockConfigDir);
    });

    it('should return config file path', () => {
      const configFile = configManager.getConfigFile();
      expect(configFile).toBe(mockConfigFile);
    });
  });

  describe('reset configuration', () => {
    beforeEach(async () => {
      await fs.writeFile(mockConfigFile, JSON.stringify({
        security: {
          allowedDirectories: ['~/projects', '~/work'],
          deniedCommands: ['rm -rf /'],
          maxConcurrentTasks: 5
        },
        server: {
          url: 'wss://custom-server.com',
          reconnectInterval: 10000,
          heartbeatInterval: 60000
        }
      }));

      configManager = await ConfigManager.initialize();
    });

    it('should reset config to defaults', async () => {
      await configManager.resetToDefaults();

      const config = configManager.getConfig();
      expect(config.security.maxConcurrentTasks).toBe(1);
      expect(config.server.reconnectInterval).toBe(5000);
      expect(await readConfig()).toEqual(config);
    });
  });

  describe('export and import', () => {
    beforeEach(async () => {
      await fs.writeFile(mockConfigFile, JSON.stringify({
        security: {
          allowedDirectories: ['~/projects'],
          deniedCommands: [],
          maxConcurrentTasks: 1
        },
        server: {
          url: 'wss://localhost:3000',
          reconnectInterval: 5000,
          heartbeatInterval: 30000
        }
      }));

      configManager = await ConfigManager.initialize();
    });

    it('should export config as JSON string', () => {
      const exported = configManager.exportConfig();

      expect(() => JSON.parse(exported)).not.toThrow();
      const parsed = JSON.parse(exported);
      expect(parsed).toHaveProperty('security');
      expect(parsed).toHaveProperty('server');
    });

    it('should import config from JSON string', async () => {
      const newConfig = {
        security: {
          allowedDirectories: ['~/imported'],
          deniedCommands: ['test'],
          maxConcurrentTasks: 2
        },
        server: {
          url: 'wss://imported-server.com',
          reconnectInterval: 3000,
          heartbeatInterval: 20000
        },
        worktree: {
          enabled: true,
          autoCleanupDays: 0,
          baseBranch: 'main'
        }
      };

      await configManager.importConfig(JSON.stringify(newConfig));

      const config = configManager.getConfig();
      expect(config.security.allowedDirectories).toEqual(newConfig.security.allowedDirectories);
      expect(config.server.url).toBe(newConfig.server.url);
      expect(await readConfig()).toEqual(config);
    });

    it('should reject invalid imported config', async () => {
      await expect(
        configManager.importConfig('invalid json')
      ).rejects.toThrow();

      await expect(
        configManager.importConfig(JSON.stringify({ invalid: 'structure' }))
      ).rejects.toThrow('Invalid config structure');
    });
  });
});
