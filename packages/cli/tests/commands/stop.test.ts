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
      getAll: vi.fn(() => ({
        deviceId: 'dev_test_12345',
        serverUrl: 'https://router.example.com',
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
    it('should stop running service and preserve device configuration', async () => {
      const result = await stopCommand();

      expect(result.success).toBe(true);
      expect(mockConfig.set).toHaveBeenCalledWith('service.running', false);
      expect(mockConfig.set).toHaveBeenCalledWith('service.stoppedAt', expect.any(Number));
      const writtenKeys = mockConfig.set.mock.calls.map(([key]: [string]) => key);
      expect(writtenKeys).not.toContain('deviceId');
      expect(writtenKeys).not.toContain('serverUrl');
    });

    it.skipIf(process.platform === 'win32')('should stop an installed user service even when config state is stale', async () => {
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

    it.each([{}, { service: { running: false } }])('leaves config untouched when no service is running (%j)', async config => {
      mockConfig.getAll.mockReturnValue(config);

      const result = await stopCommand();

      expect(result.success).toBe(false);
      expect(result.error).toContain('not running');
      expect(mockConfig.set).not.toHaveBeenCalled();
    });
  });

  describe('shutdown options', () => {
    it.each(['graceful', 'force'] as const)('returns the requested %s option on success', async option => {
      expect(await stopCommand({ [option]: true })).toMatchObject({ success: true, [option]: true });
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
