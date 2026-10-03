import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { statusCommand } from '../../src/commands/status';
import { ConfigManager } from '../../src/config/ConfigManager';
import { WebSocketClient } from '../../src/client/WebSocketClient';

// Mock dependencies
vi.mock('../../src/config/ConfigManager');
vi.mock('../../src/client/WebSocketClient');

describe('status command', () => {
  let mockConfig: any;
  let mockWsClient: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockConfig = {
      get: vi.fn(),
      has: vi.fn(() => true),
      getAll: vi.fn(() => ({
        deviceId: 'dev_test_12345',
        serverUrl: 'https://test-server.com',
        openId: 'ou_test_user_123',
        security: {
          allowedDirectories: ['~/projects', '~/work'],
        },
        service: {
          running: true,
          pid: 12345,
          startedAt: Date.now() - 3600000,
        },
      })),
    };
    vi.spyOn(ConfigManager, 'initialize').mockResolvedValue(mockConfig);

    mockWsClient = {
      isConnected: vi.fn(() => true),
    };
    (WebSocketClient as any).mockImplementation(() => mockWsClient);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('status display', () => {
    it('should show complete status information', async () => {
      const result = await statusCommand();

      expect(result.success).toBe(true);
      expect(result.status).toBeDefined();
      expect(result.status.deviceId).toBe('dev_test_12345');
      expect(result.status.serverUrl).toBe('https://test-server.com');
      expect(result.status.connected).toBe(true);
      expect(result.status.running).toBe(true);
      expect(result.status.bound).toBe(true);
      expect(result.status.allowedDirectories).toEqual(['~/projects', '~/work']);
      expect(result.status.uptime).toBeGreaterThan(0);
      expect(result.status.openId).toBe('ou_test_user_123');
    });
  });

  describe('unbound device', () => {
    it('should detect unbound device', async () => {
      mockConfig.getAll.mockReturnValue({
        deviceId: 'dev_test_12345',
        serverUrl: 'https://test-server.com',
        security: {
          allowedDirectories: ['~/projects'],
        },
        service: {
          running: true,
        },
      });

      const result = await statusCommand();

      expect(result.status.bound).toBe(false);
      expect(result.status.openId).toBeUndefined();
    });
  });

  describe('service not running', () => {
    it('should detect service stopped', async () => {
      mockConfig.getAll.mockReturnValue({
        deviceId: 'dev_test_12345',
        serverUrl: 'https://test-server.com',
        security: {
          allowedDirectories: ['~/projects'],
        },
        service: {
          running: false,
        },
      });

      const result = await statusCommand();

      expect(result.status.running).toBe(false);
    });

    it('should show connection as disconnected when service stopped', async () => {
      mockConfig.getAll.mockReturnValue({
        deviceId: 'dev_test_12345',
        serverUrl: 'https://test-server.com',
        security: {
          allowedDirectories: ['~/projects'],
        },
        service: {
          running: false,
        },
      });
      mockWsClient.isConnected.mockReturnValue(false);

      const result = await statusCommand();

      expect(result.status.connected).toBe(false);
    });
  });

  describe('not initialized', () => {
    it('should handle device not initialized', async () => {
      mockConfig.has.mockReturnValue(false);
      mockConfig.getAll.mockReturnValue({});

      const result = await statusCommand();

      expect(result.success).toBe(true);
      expect(result.status.initialized).toBe(false);
    });
  });

  describe('error handling', () => {
    it('should handle configuration errors', async () => {
      mockConfig.getAll.mockImplementation(() => {
        throw new Error('Config error');
      });

      const result = await statusCommand();

      expect(result.success).toBe(false);
      expect(result.error).toContain('Config error');
    });
  });

  describe('JSON output', () => {
    it('should support JSON output format', async () => {
      const result = await statusCommand({ json: true });

      expect(result.success).toBe(true);
      expect(result.json).toBe(true);
      expect(result.status).toBeDefined();
    });
  });
});
