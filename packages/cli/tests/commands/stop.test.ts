import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stopCommand } from '../../src/commands/stop';
import { ConfigManager } from '../../src/config/ConfigManager';
import { createServiceManager } from '../../src/service/ServiceManager';

// Mock dependencies
vi.mock('../../src/config/ConfigManager');
vi.mock('../../src/service/ServiceManager', () => ({
  createServiceManager: vi.fn(),
}));
vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    text: '',
  })),
}));

describe('stop command', () => {
  let mockConfig: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockConfig = {
      get: vi.fn(),
      has: vi.fn(() => true),
      getAll: vi.fn(() => ({
        deviceId: 'dev_test_12345',
        serverUrl: 'https://test-server.com',
        service: {
          running: true,
          pid: 12345,
          startedAt: Date.now() - 3600000,
        },
      })),
      set: vi.fn(),
    };
    vi.spyOn(ConfigManager, 'initialize').mockResolvedValue(mockConfig);
    vi.mocked(createServiceManager).mockReturnValue({
      install: vi.fn(),
      uninstall: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      status: vi.fn().mockResolvedValue({ installed: false, running: false }),
    } as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('service shutdown', () => {
    it('should stop running service', async () => {
      const result = await stopCommand();

      expect(result.success).toBe(true);
      expect(mockConfig.set).toHaveBeenCalledWith('service.running', false);
    });

    it('should stop an installed user service even when config state is stale', async () => {
      mockConfig.getAll.mockReturnValue({ service: { running: false } });
      const stop = vi.fn().mockResolvedValue({ installed: true, running: false });
      vi.mocked(createServiceManager).mockReturnValue({
        install: vi.fn(),
        uninstall: vi.fn(),
        start: vi.fn(),
        stop,
        status: vi.fn().mockResolvedValue({ installed: true, running: true }),
      } as any);

      const result = await stopCommand();

      expect(result.success).toBe(true);
      expect(stop).toHaveBeenCalledOnce();
      expect(mockConfig.set).toHaveBeenCalledWith('service.running', false);
    });

    it('should handle service not running', async () => {
      mockConfig.getAll.mockReturnValue({
        deviceId: 'dev_test_12345',
        serverUrl: 'https://test-server.com',
        service: {
          running: false,
        },
      });

      const result = await stopCommand();

      expect(result.success).toBe(false);
      expect(result.error).toContain('not running');
    });

    it('should handle missing service configuration', async () => {
      mockConfig.getAll.mockReturnValue({
        deviceId: 'dev_test_12345',
        serverUrl: 'https://test-server.com',
      });

      const result = await stopCommand();

      expect(result.success).toBe(false);
      expect(result.error).toContain('not running');
    });
  });

  describe('graceful shutdown', () => {
    it('should wait for pending tasks to complete', async () => {
      const result = await stopCommand({ graceful: true });

      expect(result.success).toBe(true);
      expect(result.graceful).toBe(true);
    });

    it('should force stop immediately when specified', async () => {
      const result = await stopCommand({ force: true });

      expect(result.success).toBe(true);
      expect(result.force).toBe(true);
    });
  });

  describe('cleanup', () => {
    it('should cleanup service state on stop', async () => {
      await stopCommand();

      expect(mockConfig.set).toHaveBeenCalledWith('service.running', false);
      expect(mockConfig.set).toHaveBeenCalledWith('service.stoppedAt', expect.any(Number));
    });

    it('should preserve configuration after stop', async () => {
      await stopCommand();

      // Should not delete deviceId or serverUrl
      expect(mockConfig.set).not.toHaveBeenCalledWith('deviceId', undefined);
      expect(mockConfig.set).not.toHaveBeenCalledWith('serverUrl', undefined);
    });
  });

  describe('error handling', () => {
    it('should handle configuration access errors', async () => {
      mockConfig.getAll.mockImplementation(() => {
        throw new Error('Config read error');
      });

      const result = await stopCommand();

      expect(result.success).toBe(false);
      expect(result.error).toContain('Config read error');
    });
  });
});
