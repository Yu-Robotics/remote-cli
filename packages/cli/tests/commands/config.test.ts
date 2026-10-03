import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { configCommand } from '../../src/commands/config';
import { ConfigManager } from '../../src/config/ConfigManager';

// Mock dependencies
vi.mock('../../src/config/ConfigManager');

describe('config command', () => {
  let mockConfig: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockConfig = {
      get: vi.fn(),
      set: vi.fn().mockResolvedValue(undefined),
      has: vi.fn(() => true),
      getAll: vi.fn(() => ({
        deviceId: 'dev_test_12345',
        serverUrl: 'https://test-server.com',
        security: {
          allowedDirectories: ['~/projects', '~/work'],
        },
      })),
    };

    // Mock the static initialize method to return the mock instance
    (ConfigManager.initialize as any) = vi.fn().mockResolvedValue(mockConfig);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('add directory', () => {
    it('should add directory to allowed list', async () => {
      const result = await configCommand({
        action: 'add-dir',
        directory: '~/new-project',
      });

      expect(result.success).toBe(true);
      expect(mockConfig.set).toHaveBeenCalledWith(
        'security.allowedDirectories',
        expect.arrayContaining(['~/projects', '~/work', '~/new-project'])
      );
    });

    it('should handle duplicate directory', async () => {
      const result = await configCommand({
        action: 'add-dir',
        directory: '~/projects',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });

    it('should validate directory path', async () => {
      const result = await configCommand({
        action: 'add-dir',
        directory: '',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid directory');
    });
  });

  describe('remove directory', () => {
    it('should remove directory from allowed list', async () => {
      const result = await configCommand({
        action: 'remove-dir',
        directory: '~/work',
      });

      expect(result.success).toBe(true);
      expect(mockConfig.set).toHaveBeenCalledWith(
        'security.allowedDirectories',
        expect.arrayContaining(['~/projects'])
      );
      expect(mockConfig.set).toHaveBeenCalledWith(
        'security.allowedDirectories',
        expect.not.arrayContaining(['~/work'])
      );
    });

    it('should handle directory not in list', async () => {
      const result = await configCommand({
        action: 'remove-dir',
        directory: '~/nonexistent',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should prevent removing last directory', async () => {
      mockConfig.getAll.mockReturnValue({
        deviceId: 'dev_test_12345',
        serverUrl: 'https://test-server.com',
        security: {
          allowedDirectories: ['~/projects'],
        },
      });

      const result = await configCommand({
        action: 'remove-dir',
        directory: '~/projects',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('At least one directory');
    });
  });

  describe('list directories', () => {
    it('should list all allowed directories', async () => {
      const result = await configCommand({
        action: 'list-dirs',
      });

      expect(result.success).toBe(true);
      expect(result.directories).toEqual(['~/projects', '~/work']);
    });

    it('should handle empty directory list', async () => {
      mockConfig.getAll.mockReturnValue({
        deviceId: 'dev_test_12345',
        serverUrl: 'https://test-server.com',
        security: {
          allowedDirectories: [],
        },
      });

      const result = await configCommand({
        action: 'list-dirs',
      });

      expect(result.success).toBe(true);
      expect(result.directories).toEqual([]);
    });
  });

  describe('set configuration', () => {
    it.each(['maintenance.updateNotice', 'maintenance.subscriptionInspection'])('stores %s as a boolean so the documented opt-out works', async key => {
      expect(await configCommand({ action: 'set', key, value: 'false' })).toMatchObject({ success: true, value: false });
      expect(mockConfig.set).toHaveBeenLastCalledWith(key, false);
      expect(await configCommand({ action: 'set', key, value: 'true' })).toMatchObject({ success: true, value: true });
      expect(mockConfig.set).toHaveBeenLastCalledWith(key, true);
      mockConfig.set.mockClear();
      expect(await configCommand({ action: 'set', key, value: 'off' })).toMatchObject({ success: false });
      expect(mockConfig.set).not.toHaveBeenCalled();
    });
    it('should set server URL', async () => {
      const result = await configCommand({
        action: 'set',
        key: 'serverUrl',
        value: 'https://new-server.com',
      });

      expect(result.success).toBe(true);
      expect(mockConfig.set).toHaveBeenCalledWith('serverUrl', 'https://new-server.com');
    });

    it('should prevent setting protected keys', async () => {
      const result = await configCommand({
        action: 'set',
        key: 'deviceId',
        value: 'new-device-id',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Cannot modify');
    });

    it('should validate value format', async () => {
      const result = await configCommand({
        action: 'set',
        key: 'serverUrl',
        value: 'invalid-url',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid');
    });
  });

  describe('get configuration', () => {
    it('should get configuration value', async () => {
      mockConfig.get.mockReturnValue('https://test-server.com');

      const result = await configCommand({
        action: 'get',
        key: 'serverUrl',
      });

      expect(result.success).toBe(true);
      expect(result.value).toBe('https://test-server.com');
    });

    it('should handle missing key', async () => {
      mockConfig.get.mockReturnValue(undefined);

      const result = await configCommand({
        action: 'get',
        key: 'nonexistent',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('show all configuration', () => {
    it('should show all configuration', async () => {
      const result = await configCommand({
        action: 'show',
      });

      expect(result.success).toBe(true);
      expect(result.config).toBeDefined();
      expect(result.config.deviceId).toBe('dev_test_12345');
      expect(result.config.serverUrl).toBe('https://test-server.com');
    });

    it('should support JSON output', async () => {
      const result = await configCommand({
        action: 'show',
        json: true,
      });

      expect(result.success).toBe(true);
      expect(result.json).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should handle invalid action', async () => {
      const result = await configCommand({
        action: 'invalid-action' as any,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid action');
    });

    it('should handle configuration errors', async () => {
      mockConfig.getAll.mockImplementation(() => {
        throw new Error('Config error');
      });

      const result = await configCommand({
        action: 'show',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Config error');
    });
  });
});
