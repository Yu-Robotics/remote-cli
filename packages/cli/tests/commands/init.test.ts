import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initCommand } from '../../src/commands/init';
import { ConfigManager } from '../../src/config/ConfigManager';
import { machineId } from 'node-machine-id';
import axios from 'axios';

// Mock dependencies
vi.mock('../../src/config/ConfigManager');
vi.mock('node-machine-id');
vi.mock('axios');
vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    text: '',
  })),
}));

describe('init command', () => {
  let mockConfig: any;
  const mockMachineId = machineId as any;
  const mockAxios = axios as any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockConfig = {
      set: vi.fn(),
      get: vi.fn(),
      has: vi.fn(() => false),
      getAll: vi.fn(() => ({})),
    };
    (ConfigManager.initialize as any).mockResolvedValue(mockConfig);

    mockMachineId.mockResolvedValue('test-machine-id-12345');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('first time initialization', () => {
    it('should generate device ID and binding code', async () => {
      mockAxios.post.mockResolvedValue({
        data: {
          success: true,
          bindingCode: 'ABC-123-XYZ',
          deviceId: 'dev_test_12345',
          expiresAt: Date.now() + 300000,
        },
      });

      const result = await initCommand({
        serverUrl: 'https://test-server.com',
      });

      expect(result.success).toBe(true);
      expect(result.bindingCode).toBe('ABC-123-XYZ');
      expect(result.deviceId).toMatch(/^dev_[a-z0-9]+_[a-z0-9\-]+$/);
      expect(mockConfig.set).toHaveBeenCalledWith('deviceId', expect.stringMatching(/^dev_[a-z0-9]+_[a-z0-9\-]+$/));
      expect(mockConfig.set).toHaveBeenCalledWith('serverUrl', 'https://test-server.com');
    });

    it('should use machine ID to generate device ID', async () => {
      mockAxios.post.mockResolvedValue({
        data: {
          success: true,
          bindingCode: 'XYZ-456-ABC',
          deviceId: 'dev_test_12345',
          expiresAt: Date.now() + 300000,
        },
      });

      await initCommand({
        serverUrl: 'https://test-server.com',
      });

      expect(mockMachineId).toHaveBeenCalled();
    });

    it('should handle server connection errors', async () => {
      mockAxios.post.mockRejectedValue(new Error('Network error'));

      const result = await initCommand({
        serverUrl: 'https://test-server.com',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Network error');
    });
  });

  describe('already initialized', () => {
    it('should detect existing device ID', async () => {
      mockConfig.has.mockReturnValue(true);
      mockConfig.get.mockReturnValue('dev_existing_12345');

      const result = await initCommand({
        serverUrl: 'https://test-server.com',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('already initialized');
      expect(mockAxios.post).not.toHaveBeenCalled();
    });

    it('should allow force re-initialization', async () => {
      mockConfig.has.mockReturnValue(true);
      mockConfig.get.mockReturnValue('dev_existing_12345');

      mockAxios.post.mockResolvedValue({
        data: {
          success: true,
          bindingCode: 'NEW-123-ABC',
          deviceId: 'dev_new_67890',
          expiresAt: Date.now() + 300000,
        },
      });

      const result = await initCommand({
        serverUrl: 'https://test-server.com',
        force: true,
      });

      expect(result.success).toBe(true);
      expect(result.bindingCode).toBe('NEW-123-ABC');
      expect(mockAxios.post).toHaveBeenCalled();
    });
  });

  describe('directory configuration', () => {
    it('should accept allowed directories during init', async () => {
      mockAxios.post.mockResolvedValue({
        data: {
          success: true,
          bindingCode: 'ABC-123-XYZ',
          deviceId: 'dev_test_12345',
          expiresAt: Date.now() + 300000,
        },
      });

      await initCommand({
        serverUrl: 'https://test-server.com',
        allowedDirs: ['~/projects', '~/work'],
      });

      expect(mockConfig.set).toHaveBeenCalledWith(
        'security.allowedDirectories',
        ['~/projects', '~/work']
      );
    });

    it('should use default allowed directories if not specified', async () => {
      mockAxios.post.mockResolvedValue({
        data: {
          success: true,
          bindingCode: 'ABC-123-XYZ',
          deviceId: 'dev_test_12345',
          expiresAt: Date.now() + 300000,
        },
      });

      await initCommand({
        serverUrl: 'https://test-server.com',
      });

      expect(mockConfig.set).toHaveBeenCalledWith(
        'security.allowedDirectories',
        expect.arrayContaining([expect.stringMatching(/^~?[/\\]|^[a-zA-Z]:[/\\]/)])
      );
    });
  });

  describe('error handling', () => {
    it('should handle invalid server URL', async () => {
      const result = await initCommand({
        serverUrl: 'invalid-url',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should handle server returning error response', async () => {
      mockAxios.post.mockResolvedValue({
        data: {
          success: false,
          error: 'Server internal error',
        },
      });

      const result = await initCommand({
        serverUrl: 'https://test-server.com',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Server internal error');
    });

    it('should handle machine ID generation failure', async () => {
      mockMachineId.mockRejectedValue(new Error('Cannot read machine ID'));

      const result = await initCommand({
        serverUrl: 'https://test-server.com',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});
