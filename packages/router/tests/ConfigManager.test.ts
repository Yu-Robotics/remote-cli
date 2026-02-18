import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/types/config';
import path from 'path';

// Mock os.homedir BEFORE importing ConfigManager
vi.mock('os', () => ({
  default: {
    homedir: () => '/mock/home'
  },
  homedir: () => '/mock/home'
}));

// Mock fs/promises
vi.mock('fs/promises');

// Import after mocks are setup
import fs from 'fs/promises';
import { ConfigManager } from '../src/config/ConfigManager';

const mockHomeDir = '/mock/home';
const mockConfigDir = path.join(mockHomeDir, '.remote-cli-router');
const mockConfigFile = path.join(mockConfigDir, 'config.json');

describe('ConfigManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('should create config directory if not exists', async () => {
      (fs.mkdir as any) = vi.fn().mockResolvedValue(undefined);
      (fs.readFile as any) = vi.fn().mockRejectedValue({ code: 'ENOENT' });
      (fs.writeFile as any) = vi.fn().mockResolvedValue(undefined);

      await ConfigManager.initialize();

      expect(fs.mkdir).toHaveBeenCalledWith(mockConfigDir, { recursive: true });
    });

    it('should create default config file if not exists', async () => {
      (fs.mkdir as any) = vi.fn().mockResolvedValue(undefined);
      (fs.readFile as any) = vi.fn().mockRejectedValue({ code: 'ENOENT' });
      (fs.writeFile as any) = vi.fn().mockResolvedValue(undefined);

      await ConfigManager.initialize();

      expect(fs.writeFile).toHaveBeenCalledWith(
        mockConfigFile,
        expect.any(String),
        'utf-8'
      );
    });

    it('should initialize with default configuration', async () => {
      (fs.mkdir as any) = vi.fn().mockResolvedValue(undefined);
      (fs.readFile as any) = vi.fn().mockRejectedValue({ code: 'ENOENT' });
      (fs.writeFile as any) = vi.fn().mockResolvedValue(undefined);

      const config = await ConfigManager.initialize();
      const all = config.getAll();

      expect(all.server.port).toBe(DEFAULT_CONFIG.server.port);
      expect(all.server.host).toBe(DEFAULT_CONFIG.server.host);
      expect(all.feishu.appId).toBe('');
      expect(all.websocket.heartbeatInterval).toBe(DEFAULT_CONFIG.websocket.heartbeatInterval);
    });

    it('should load existing configuration from disk', async () => {
      const existingConfig = {
        server: {
          port: 8080,
          host: 'localhost',
          nodeEnv: 'development'
        },
        feishu: {
          appId: 'test_app_id',
          appSecret: 'test_app_secret',
          encryptKey: '',
          verificationToken: ''
        },
        websocket: {
          heartbeatInterval: 30000,
          reconnectDelay: 10000
        },
        security: {
          bindingCodeExpiry: 600000,
          maxBindingAttempts: 3
        }
      };

      (fs.mkdir as any) = vi.fn().mockResolvedValue(undefined);
      (fs.readFile as any) = vi.fn().mockResolvedValue(JSON.stringify(existingConfig));

      const config = await ConfigManager.initialize();

      expect(config.get('server', 'port')).toBe(8080);
      expect(config.get('feishu', 'appId')).toBe('test_app_id');
    });

    it('should throw error for corrupted config file', async () => {
      (fs.mkdir as any) = vi.fn().mockResolvedValue(undefined);
      (fs.readFile as any) = vi.fn().mockResolvedValue('not valid json');

      await expect(ConfigManager.initialize()).rejects.toThrow();
    });
  });

  describe('get', () => {
    let config: ConfigManager;

    beforeEach(async () => {
      (fs.mkdir as any) = vi.fn().mockResolvedValue(undefined);
      (fs.readFile as any) = vi.fn().mockRejectedValue({ code: 'ENOENT' });
      (fs.writeFile as any) = vi.fn().mockResolvedValue(undefined);

      config = await ConfigManager.initialize();
    });

    it('should get top-level configuration value', () => {
      const serverConfig = config.get('server');
      expect(serverConfig.port).toBe(DEFAULT_CONFIG.server.port);
      expect(serverConfig.host).toBe(DEFAULT_CONFIG.server.host);
    });

    it('should get nested configuration value', () => {
      expect(config.get('server', 'port')).toBe(DEFAULT_CONFIG.server.port);
      expect(config.get('websocket', 'heartbeatInterval')).toBe(DEFAULT_CONFIG.websocket.heartbeatInterval);
    });

    it('should return undefined for non-existent nested key', () => {
      const result = config.get('nonexistent' as any, 'key' as any);
      expect(result).toBeUndefined();
    });
  });

  describe('set', () => {
    let config: ConfigManager;

    beforeEach(async () => {
      (fs.mkdir as any) = vi.fn().mockResolvedValue(undefined);
      (fs.readFile as any) = vi.fn().mockRejectedValue({ code: 'ENOENT' });
      (fs.writeFile as any) = vi.fn().mockResolvedValue(undefined);

      config = await ConfigManager.initialize();
    });

    it('should set top-level configuration value', () => {
      const newServerConfig = {
        port: 9000,
        host: '127.0.0.1',
        nodeEnv: 'development' as const
      };
      config.set('server', newServerConfig);

      expect(config.get('server', 'port')).toBe(9000);
      expect(config.get('server', 'host')).toBe('127.0.0.1');
    });

    it('should set nested configuration value', () => {
      config.set('server', 'port', 8888);
      config.set('feishu', 'appId', 'new_app_id');

      expect(config.get('server', 'port')).toBe(8888);
      expect(config.get('feishu', 'appId')).toBe('new_app_id');
    });

    it('should preserve other nested values when setting one nested value', () => {
      const originalHost = config.get('server', 'host');
      config.set('server', 'port', 7777);

      expect(config.get('server', 'port')).toBe(7777);
      expect(config.get('server', 'host')).toBe(originalHost);
    });
  });

  describe('getAll', () => {
    it('should return a copy of all configuration', async () => {
      (fs.mkdir as any) = vi.fn().mockResolvedValue(undefined);
      (fs.readFile as any) = vi.fn().mockRejectedValue({ code: 'ENOENT' });
      (fs.writeFile as any) = vi.fn().mockResolvedValue(undefined);

      const config = await ConfigManager.initialize();
      const all = config.getAll();

      // Should have all sections
      expect(all.server).toBeDefined();
      expect(all.feishu).toBeDefined();
      expect(all.websocket).toBeDefined();
      expect(all.security).toBeDefined();
    });
  });

  describe('isFeishuConfigured', () => {
    let config: ConfigManager;

    beforeEach(async () => {
      (fs.mkdir as any) = vi.fn().mockResolvedValue(undefined);
      (fs.readFile as any) = vi.fn().mockRejectedValue({ code: 'ENOENT' });
      (fs.writeFile as any) = vi.fn().mockResolvedValue(undefined);

      config = await ConfigManager.initialize();
    });

    it('should return false when Feishu is not configured', () => {
      expect(config.isFeishuConfigured()).toBe(false);
    });

    it('should return false when only appId is set', () => {
      config.set('feishu', 'appId', 'some_app_id');
      expect(config.isFeishuConfigured()).toBe(false);
    });

    it('should return false when only appSecret is set', () => {
      config.set('feishu', 'appSecret', 'some_secret');
      expect(config.isFeishuConfigured()).toBe(false);
    });

    it('should return true when both appId and appSecret are set', () => {
      config.set('feishu', 'appId', 'some_app_id');
      config.set('feishu', 'appSecret', 'some_secret');
      expect(config.isFeishuConfigured()).toBe(true);
    });
  });

  describe('save', () => {
    let config: ConfigManager;

    beforeEach(async () => {
      (fs.mkdir as any) = vi.fn().mockResolvedValue(undefined);
      (fs.readFile as any) = vi.fn().mockRejectedValue({ code: 'ENOENT' });
      (fs.writeFile as any) = vi.fn().mockResolvedValue(undefined);

      config = await ConfigManager.initialize();
    });

    it('should persist configuration to disk', async () => {
      config.set('server', 'port', 5555);
      config.set('feishu', 'appId', 'saved_app_id');
      await config.save();

      expect(fs.writeFile).toHaveBeenCalledWith(
        mockConfigFile,
        expect.stringContaining('"port": 5555'),
        'utf-8'
      );
      expect(fs.writeFile).toHaveBeenCalledWith(
        mockConfigFile,
        expect.stringContaining('"appId": "saved_app_id"'),
        'utf-8'
      );
    });
  });

  describe('getConfigPath', () => {
    it('should return the correct config file path', async () => {
      (fs.mkdir as any) = vi.fn().mockResolvedValue(undefined);
      (fs.readFile as any) = vi.fn().mockRejectedValue({ code: 'ENOENT' });
      (fs.writeFile as any) = vi.fn().mockResolvedValue(undefined);

      const config = await ConfigManager.initialize();
      expect(config.getConfigPath()).toBe(mockConfigFile);
    });
  });

  describe('reset', () => {
    let config: ConfigManager;

    beforeEach(async () => {
      (fs.mkdir as any) = vi.fn().mockResolvedValue(undefined);
      (fs.readFile as any) = vi.fn().mockRejectedValue({ code: 'ENOENT' });
      (fs.writeFile as any) = vi.fn().mockResolvedValue(undefined);

      config = await ConfigManager.initialize();
    });

    it('should reset configuration to defaults', async () => {
      // Make some changes
      config.set('server', 'port', 9999);
      config.set('feishu', 'appId', 'custom_id');

      // Reset
      await config.reset();

      // Verify defaults
      expect(config.get('server', 'port')).toBe(DEFAULT_CONFIG.server.port);
      expect(config.get('feishu', 'appId')).toBe('');
    });

    it('should persist reset configuration to disk', async () => {
      config.set('server', 'port', 9999);
      await config.reset();

      // Verify save was called with default values
      const lastCall = (fs.writeFile as any).mock.calls[(fs.writeFile as any).mock.calls.length - 1];
      const savedConfig = JSON.parse(lastCall[1]);
      expect(savedConfig.server.port).toBe(DEFAULT_CONFIG.server.port);
    });
  });
});
