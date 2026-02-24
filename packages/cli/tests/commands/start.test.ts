import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startCommand, checkServerVersion, isNewerVersion } from '../../src/commands/start';
import { ConfigManager } from '../../src/config/ConfigManager';
import { WebSocketClient } from '../../src/client/WebSocketClient';
import { CLI_VERSION } from '../../src/types';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/config/ConfigManager');
vi.mock('../../src/client/WebSocketClient');
vi.mock('axios');
vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    text: '',
  })),
}));

// Mock readline so promptYesNo never blocks on real stdin
let mockReadlineAnswer = 'y';
vi.mock('readline', () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn((_q: string, cb: (a: string) => void) => cb(mockReadlineAnswer)),
    close: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getAxios() {
  return (await import('axios')).default;
}

// Default: axios returns "same version" so existing tests are not disturbed
function mockAxiosVersionSame() {
  return vi.mocked(getAxios()).then((axios) => {
    (axios.get as any).mockResolvedValue({ data: { success: true, version: CLI_VERSION } });
  });
}

// ---------------------------------------------------------------------------
// start command tests
// ---------------------------------------------------------------------------

describe('start command', () => {
  let mockConfig: any;
  let mockWsClient: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockReadlineAnswer = 'y';

    mockConfig = {
      get: vi.fn(),
      has: vi.fn(() => true),
      getAll: vi.fn(() => ({
        deviceId: 'dev_test_12345',
        serverUrl: 'https://test-server.com',
        security: {
          allowedDirectories: ['~/projects'],
        },
      })),
      set: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(ConfigManager, 'initialize').mockResolvedValue(mockConfig);

    mockWsClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      isConnected: vi.fn(() => true),
      disconnect: vi.fn(),
      on: vi.fn(),
    };
    (WebSocketClient as any).mockImplementation(() => mockWsClient);

    // Default: no version mismatch — axios returns same version
    await mockAxiosVersionSame();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('service startup', () => {
    it('should start service with valid configuration', async () => {
      const result = await startCommand({
        daemon: false,
      });

      expect(result.success).toBe(true);
      expect(mockWsClient.connect).toHaveBeenCalled();
    });

    it('should connect to WebSocket server', async () => {
      await startCommand({
        daemon: false,
      });

      expect(WebSocketClient).toHaveBeenCalledWith(
        'wss://test-server.com/ws',
        'dev_test_12345'
      );
      expect(mockWsClient.connect).toHaveBeenCalled();
    });

    it('should fail if not initialized', async () => {
      mockConfig.has.mockReturnValue(false);

      const result = await startCommand({
        daemon: false,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not initialized');
      expect(mockWsClient.connect).not.toHaveBeenCalled();
    });
  });

  describe('daemon mode', () => {
    it('should run in daemon mode when specified', async () => {
      const result = await startCommand({
        daemon: true,
      });

      expect(result.success).toBe(true);
      expect(result.daemonMode).toBe(true);
    });

    it('should run in foreground mode by default', async () => {
      const result = await startCommand({
        daemon: false,
      });

      expect(result.success).toBe(true);
      expect(result.daemonMode).toBe(false);
    });
  });

  describe('connection handling', () => {
    it('should handle connection errors', async () => {
      mockWsClient.connect.mockRejectedValue(new Error('Connection failed'));

      const result = await startCommand({
        daemon: false,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Connection failed');
    });

    it('should setup event handlers', async () => {
      await startCommand({
        daemon: false,
      });

      expect(mockWsClient.on).toHaveBeenCalledWith('connected', expect.any(Function));
      expect(mockWsClient.on).toHaveBeenCalledWith('disconnected', expect.any(Function));
      expect(mockWsClient.on).toHaveBeenCalledWith('error', expect.any(Function));
    });
  });

  describe('configuration validation', () => {
    it('should validate device ID exists', async () => {
      mockConfig.getAll.mockReturnValue({
        serverUrl: 'https://test-server.com',
        security: { allowedDirectories: ['~/projects'] },
      });

      const result = await startCommand({
        daemon: false,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('deviceId');
    });

    it('should validate server URL exists', async () => {
      mockConfig.getAll.mockReturnValue({
        deviceId: 'dev_test_12345',
        security: { allowedDirectories: ['~/projects'] },
      });

      const result = await startCommand({
        daemon: false,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('serverUrl');
    });

    it('should validate allowed directories exist', async () => {
      mockConfig.getAll.mockReturnValue({
        deviceId: 'dev_test_12345',
        serverUrl: 'https://test-server.com',
        security: {},
      });

      const result = await startCommand({
        daemon: false,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('allowedDirectories');
    });
  });

  describe('service lifecycle', () => {
    it('should save process information when started', async () => {
      const result = await startCommand({
        daemon: true,
      });

      expect(result.success).toBe(true);
      expect(mockConfig.set).toHaveBeenCalledWith('service.running', true);
      expect(mockConfig.set).toHaveBeenCalledWith('service.startedAt', expect.any(Number));
    });
  });
});

// ---------------------------------------------------------------------------
// isNewerVersion unit tests
// ---------------------------------------------------------------------------
describe('isNewerVersion', () => {
  it('returns true when remote major is greater', () => {
    expect(isNewerVersion('2.0.0', '1.9.9')).toBe(true);
  });

  it('returns true when remote minor is greater', () => {
    expect(isNewerVersion('1.2.0', '1.1.9')).toBe(true);
  });

  it('returns true when remote patch is greater', () => {
    expect(isNewerVersion('1.0.12', '1.0.11')).toBe(true);
  });

  it('returns false when versions are equal', () => {
    expect(isNewerVersion('1.0.11', '1.0.11')).toBe(false);
  });

  it('returns false when remote is older (major)', () => {
    expect(isNewerVersion('0.9.0', '1.0.0')).toBe(false);
  });

  it('returns false when remote is older (minor)', () => {
    expect(isNewerVersion('1.0.9', '1.1.0')).toBe(false);
  });

  it('returns false when remote is older (patch)', () => {
    expect(isNewerVersion('1.0.10', '1.0.11')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkServerVersion unit tests
// ---------------------------------------------------------------------------
describe('checkServerVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true and prompts when router is newer, user answers y', async () => {
    const axios = (await import('axios')).default;
    (axios.get as any).mockResolvedValueOnce({ data: { success: true, version: '99.0.0' } });
    mockReadlineAnswer = 'y';

    const result = await checkServerVersion('http://localhost:3000');
    expect(result).toBe(true);
  });

  it('returns false when router is newer, user answers n', async () => {
    const axios = (await import('axios')).default;
    (axios.get as any).mockResolvedValueOnce({ data: { success: true, version: '99.0.0' } });
    mockReadlineAnswer = 'n';

    const result = await checkServerVersion('http://localhost:3000');
    expect(result).toBe(false);
  });

  it('returns true without prompting when versions are equal', async () => {
    const axios = (await import('axios')).default;
    (axios.get as any).mockResolvedValueOnce({ data: { success: true, version: CLI_VERSION } });

    const readline = await import('readline');
    const result = await checkServerVersion('http://localhost:3000');
    expect(result).toBe(true);
    expect(readline.createInterface).not.toHaveBeenCalled();
  });

  it('returns true without prompting when CLI is newer', async () => {
    const axios = (await import('axios')).default;
    (axios.get as any).mockResolvedValueOnce({ data: { success: true, version: '0.0.1' } });

    const readline = await import('readline');
    const result = await checkServerVersion('http://localhost:3000');
    expect(result).toBe(true);
    expect(readline.createInterface).not.toHaveBeenCalled();
  });

  it('returns true on network error (non-fatal)', async () => {
    const axios = (await import('axios')).default;
    (axios.get as any).mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await checkServerVersion('http://localhost:3000');
    expect(result).toBe(true);
  });

  it('returns true when response has no version field', async () => {
    const axios = (await import('axios')).default;
    (axios.get as any).mockResolvedValueOnce({ data: { success: false } });

    const result = await checkServerVersion('http://localhost:3000');
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// startCommand version-check integration tests
// ---------------------------------------------------------------------------
describe('startCommand version check integration', () => {
  let mockConfig: any;
  let mockWsClient: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockReadlineAnswer = 'y';

    mockConfig = {
      get: vi.fn(),
      has: vi.fn(() => true),
      getAll: vi.fn(() => ({
        deviceId: 'dev_test_12345',
        serverUrl: 'http://test-server.com',
        security: { allowedDirectories: ['~/projects'] },
      })),
      set: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(ConfigManager, 'initialize').mockResolvedValue(mockConfig);

    mockWsClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      isConnected: vi.fn(() => true),
      disconnect: vi.fn(),
      on: vi.fn(),
    };
    (WebSocketClient as any).mockImplementation(() => mockWsClient);
  });

  it('aborts startup when router is newer and user answers n', async () => {
    const axios = (await import('axios')).default;
    (axios.get as any).mockResolvedValueOnce({ data: { success: true, version: '99.0.0' } });
    mockReadlineAnswer = 'n';

    const result = await startCommand({ daemon: false });

    expect(result.success).toBe(false);
    expect(result.error).toContain('upgrade');
    expect(mockWsClient.connect).not.toHaveBeenCalled();
  });

  it('continues startup when router is newer and user answers y', async () => {
    const axios = (await import('axios')).default;
    (axios.get as any).mockResolvedValueOnce({ data: { success: true, version: '99.0.0' } });
    mockReadlineAnswer = 'y';

    const result = await startCommand({ daemon: false });

    expect(result.success).toBe(true);
    expect(mockWsClient.connect).toHaveBeenCalled();
  });

  it('continues startup normally when version check fails (network error)', async () => {
    const axios = (await import('axios')).default;
    (axios.get as any).mockRejectedValueOnce(new Error('timeout'));

    const result = await startCommand({ daemon: false });

    expect(result.success).toBe(true);
    expect(mockWsClient.connect).toHaveBeenCalled();
  });
});
