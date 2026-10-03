import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startCommand, checkBackendAvailability, getServerVersion, isNewerVersion } from '../../src/commands/start';
import { ConfigManager } from '../../src/config/ConfigManager';
import { WebSocketClient } from '../../src/client/WebSocketClient';
import { CLI_VERSION } from '../../src/types';
import axios from 'axios';
import { execFile } from 'child_process';
import { AutomaticUpdater } from '../../src/update/AutomaticUpdater';
import os from 'os';

const initialPath = process.env.PATH;
afterEach(() => {
  if (initialPath === undefined) delete process.env.PATH;
  else process.env.PATH = initialPath;
});

const automaticUpdaterMocks = vi.hoisted(() => ({
  handleRouterVersion: vi.fn(),
  handleProtocolMismatch: vi.fn(),
}));
const zCodeCommandMocks = vi.hoisted(() => ({
  isZCodeAvailable: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/config/ConfigManager');
vi.mock('../../src/client/WebSocketClient');
vi.mock('child_process', () => ({ execFile: vi.fn() }));
vi.mock('../../src/update/AutomaticUpdater', () => ({
  AutomaticUpdater: vi.fn().mockImplementation(() => automaticUpdaterMocks),
}));
vi.mock('../../src/executor/zcode/ZCodeCommand', () => zCodeCommandMocks);
vi.mock('axios');
vi.mock('../../src/thread/ThreadManager', () => ({
  ThreadManager: {
    initialize: vi.fn().mockResolvedValue({
      getDefaultThread: vi.fn().mockReturnValue({ id: 'default-id', name: 'default', workingDirectory: '/tmp', sessionId: null, createdAt: 0, lastActiveAt: 0 }),
      getThread: vi.fn(),
      getThreadByName: vi.fn(),
      listThreads: vi.fn().mockReturnValue([]),
      createThread: vi.fn(),
      deleteThread: vi.fn(),
      updateThread: vi.fn().mockResolvedValue({}),
      getSessionFilePath: vi.fn().mockReturnValue('/tmp/session.jsonl'),
    }),
  },
}));
vi.mock('../../src/thread/ThreadExecutorPool', () => ({
  ThreadExecutorPool: vi.fn().mockImplementation(() => ({
    getExecutor: vi.fn().mockReturnValue({
      getCurrentWorkingDirectory: vi.fn().mockReturnValue('/tmp'),
      setWorkingDirectory: vi.fn().mockResolvedValue(undefined),
      execute: vi.fn(),
      abort: vi.fn(),
      destroy: vi.fn(),
      resetContext: vi.fn(),
    }),
    isThreadBusy: vi.fn().mockReturnValue(false),
    setThreadBusy: vi.fn(),
    setThreadError: vi.fn(),
    getSummaries: vi.fn().mockReturnValue([]),
    destroyAll: vi.fn().mockResolvedValue(undefined),
    switchBackend: vi.fn().mockResolvedValue(undefined),
  })),
}));
vi.mock('../../src/client/MessageHandler', () => ({
  MessageHandler: vi.fn().mockImplementation(() => ({
    handleMessage: vi.fn().mockResolvedValue(undefined),
    reconcilePendingDelegatedWorkers: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../src/security/HooksConfigurator', () => ({
  HooksConfigurator: vi.fn().mockImplementation(() => ({
    unconfigure: vi.fn().mockResolvedValue(undefined),
  })),
}));

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Default: axios returns "same version" so existing tests are not disturbed
function mockAxiosVersionSame() {
  vi.mocked(axios.get).mockResolvedValue({ data: { success: true, version: CLI_VERSION } });
}

// ---------------------------------------------------------------------------
// start command tests
// ---------------------------------------------------------------------------

describe('start command', () => {
  let mockConfig: any;
  let mockWsClient: any;
  let originalPath: string | undefined;

  beforeEach(async () => {
    originalPath = process.env.PATH;
    vi.clearAllMocks();
    zCodeCommandMocks.isZCodeAvailable.mockReturnValue(false);
    vi.mocked(execFile).mockImplementation(((_command: string, _args: string[], _options: object, callback: Function) => {
      callback(null, '', '');
    }) as any);

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
      set: vi.fn().mockResolvedValue(undefined),
      save: vi.fn().mockResolvedValue(undefined),
      getConfigDir: vi.fn().mockReturnValue('/tmp/.remote-cli'),
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
    mockAxiosVersionSame();
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    vi.clearAllMocks();
  });

  describe('service startup', () => {
    it.skipIf(process.platform === 'win32')('enriches the live environment before the first startup probe', async () => {
      process.env.PATH = '/opt/legacy/bin';
      const home = vi.spyOn(os, 'homedir').mockReturnValue('/tmp/backend-start-example');
      try {
        vi.mocked(axios.get).mockImplementationOnce(async () => {
          expect(process.env.PATH?.split(':')[0]).toBe('/opt/legacy/bin');
          expect(process.env.PATH?.split(':')).toContain('/tmp/backend-start-example/.kimi-code/bin');
          return { data: { success: true, version: CLI_VERSION } };
        });
        expect((await startCommand({})).success).toBe(true);
      } finally { home.mockRestore(); }
    });

    it('should start service with valid configuration', async () => {
      const result = await startCommand({
        daemon: false,
      });

      expect(result.success).toBe(true);
      expect(WebSocketClient).toHaveBeenCalledWith(
        'wss://test-server.com/ws',
        'dev_test_12345',
        { identityLoader: expect.any(Function) }
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

  describe('backend availability', () => {
    const spinner = {
      warn: vi.fn().mockReturnThis(),
      start: vi.fn().mockReturnThis(),
    } as any;

    it.each(['auto', 'claude-persistent', 'codex', 'opencode', 'kimi', 'agy', 'pi', 'dsh'])('uses the configured executable at startup: %s', async type => {
      const backend = type === 'auto' || type === 'claude-persistent' ? 'claude' : type;
      const command = `/opt/example tools/${backend}`;
      await checkBackendAvailability(type, spinner, { type, [backend]: { command } } as any);
      expect(execFile).toHaveBeenCalledWith(command, ['--version'], { timeout: 5000 }, expect.any(Function));
    });

    it.each(['', '/opt/fixture\u0000command'])('contains synchronous probe failures without blocking service startup: %j', async command => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        vi.mocked(execFile).mockImplementation(() => { throw new Error('sensitive fixture diagnostic'); });
        await expect(checkBackendAvailability('auto', spinner, { type: 'auto', claude: { command } })).resolves.toBeUndefined();
        expect(spinner.warn).toHaveBeenCalledWith('Claude Code unavailable');
        expect(spinner.start).toHaveBeenCalledWith('Continuing...');
        expect(log.mock.calls.flat().join('\n')).not.toContain('sensitive fixture');
      } finally { log.mockRestore(); }
    });

    it('checks Codex app-server support after finding the binary', async () => {
      await checkBackendAvailability('codex', spinner);

      expect(execFile).toHaveBeenNthCalledWith(1, 'codex', ['--version'], { timeout: 5000 }, expect.any(Function));
      expect(execFile).toHaveBeenNthCalledWith(2, 'codex', ['app-server', '--help'], { timeout: 5000 }, expect.any(Function));
      expect(spinner.warn).not.toHaveBeenCalled();
    });

    it('warns when the installed Codex CLI lacks app-server', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.mocked(execFile)
        .mockImplementationOnce(((_command: string, _args: string[], _options: object, callback: Function) => callback(null, '', '')) as any)
        .mockImplementationOnce(((_command: string, _args: string[], _options: object, callback: Function) => callback(new Error('unknown command'))) as any);

      await checkBackendAvailability('codex', spinner);

      expect(spinner.warn).toHaveBeenCalledWith('Codex CLI (OpenAI) does not support app-server');
      expect(console.log).toHaveBeenCalledWith('Update Codex CLI: npm install -g @openai/codex@latest');
      log.mockRestore();
    });

    it('checks the configured Pi binary', async () => {
      await checkBackendAvailability('pi', spinner, { type: 'pi', pi: { command: '/opt/pi' } });

      expect(execFile).toHaveBeenCalledWith('/opt/pi', ['--version'], { timeout: 5000 }, expect.any(Function));
      expect(spinner.warn).not.toHaveBeenCalled();
    });

    it.each([undefined, '/opt/example-tools/dsh'])('checks the DSH binary rather than Claude: %s', async command => {
      await checkBackendAvailability('dsh', spinner, { type: 'dsh', dsh: { command } });
      expect(execFile).toHaveBeenCalledTimes(1);
      expect(execFile).toHaveBeenCalledWith(command ?? 'dsh', ['--version'], { timeout: 5000 }, expect.any(Function));
      expect(spinner.warn).not.toHaveBeenCalled();
    });

    it('reports a missing DSH binary without blocking startup', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.mocked(execFile).mockImplementation(((_command: string, _args: string[], _options: object, callback: Function) => {
        callback(new Error('not found'));
      }) as any);
      await checkBackendAvailability('dsh', spinner, { type: 'dsh' });
      expect(spinner.warn).toHaveBeenCalledWith('DeepSeek Harness unavailable');
      expect(spinner.start).toHaveBeenCalledWith('Continuing...');
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('(DeepSeek Harness)'));
      log.mockRestore();
    });

    it('uses official ZCode discovery for the ZCode backend', async () => {
      zCodeCommandMocks.isZCodeAvailable.mockReturnValue(true);

      await checkBackendAvailability('zcode', spinner, { type: 'zcode', zcode: { command: '/opt/zcode' } });

      expect(zCodeCommandMocks.isZCodeAvailable).toHaveBeenCalledWith('/opt/zcode');
      expect(execFile).not.toHaveBeenCalled();
      expect(spinner.warn).not.toHaveBeenCalled();
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

    it('starts in non-interactive mode with a newer Router', async () => {
      vi.mocked(axios.get).mockResolvedValue({ data: { success: true, version: '99.0.0' } });

      const result = await startCommand({ daemon: true, nonInteractive: true });

      expect(result.success).toBe(true);
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

    it.each([true, false])('passes reconnect versions to the updater (non-interactive: %s)', async (nonInteractive) => {
      await startCommand({ nonInteractive });
      expect(AutomaticUpdater).toHaveBeenCalledWith(CLI_VERSION, expect.anything(), expect.objectContaining({ restartAfterUpdate: nonInteractive }));
      const messageHandler = mockWsClient.on.mock.calls.find(([event]: [string]) => event === 'message')?.[1];

      await messageHandler({ type: 'binding_confirm', data: { routerVersion: '1.6.26' } });

      expect(automaticUpdaterMocks.handleRouterVersion).toHaveBeenCalledWith('1.6.26');
    });

    it.each([true, false])('resolves the Router version after protocol rejection (non-interactive: %s)', async (nonInteractive) => {
      await startCommand({ nonInteractive });
      const messageHandler = mockWsClient.on.mock.calls.find(([event]: [string]) => event === 'message')?.[1];

      await messageHandler({ type: 'error', data: { code: 'PROTOCOL_VERSION_INCOMPATIBLE' } });

      expect(automaticUpdaterMocks.handleProtocolMismatch).toHaveBeenCalledWith('https://test-server.com');
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
  it.each([
    { scenario: 'remote major is greater', remote: '2.0.0', local: '1.9.9', expected: true },
    { scenario: 'remote minor is greater', remote: '1.2.0', local: '1.1.9', expected: true },
    { scenario: 'remote patch is greater', remote: '1.0.12', local: '1.0.11', expected: true },
    { scenario: 'versions are equal', remote: '1.0.11', local: '1.0.11', expected: false },
    { scenario: 'remote major is older', remote: '0.9.0', local: '1.0.0', expected: false },
    { scenario: 'remote minor is older', remote: '1.0.9', local: '1.1.0', expected: false },
    { scenario: 'remote patch is older', remote: '1.0.10', local: '1.0.11', expected: false },
  ])('compares versions when $scenario', ({ remote, local, expected }) => {
    expect(isNewerVersion(remote, local)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// getServerVersion unit tests
// ---------------------------------------------------------------------------
describe('getServerVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the Router version for automatic update scheduling', async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({ data: { success: true, version: '99.0.0' } });
    await expect(getServerVersion('http://localhost:3000')).resolves.toBe('99.0.0');
  });

  it('tolerates a missing version endpoint', async () => {
    vi.mocked(axios.get).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(getServerVersion('http://localhost:3000')).resolves.toBeUndefined();
  });

  it.each([
    { success: false },
    { success: true, version: 'latest;exit 1' },
    { success: true, version: 42 },
  ])('ignores invalid version responses: %j', async (data) => {
    vi.mocked(axios.get).mockResolvedValueOnce({ data });
    await expect(getServerVersion('http://localhost:3000')).resolves.toBeUndefined();
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

    mockConfig = {
      get: vi.fn(),
      has: vi.fn(() => true),
      getAll: vi.fn(() => ({
        deviceId: 'dev_test_12345',
        serverUrl: 'http://test-server.com',
        security: { allowedDirectories: ['~/projects'] },
      })),
      set: vi.fn().mockResolvedValue(undefined),
      save: vi.fn().mockResolvedValue(undefined),
      getConfigDir: vi.fn().mockReturnValue('/tmp/.remote-cli'),
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

  it.each([true, false])('schedules updates after startup without asking for input (non-interactive: %s)', async (nonInteractive) => {
    vi.mocked(axios.get).mockResolvedValueOnce({ data: { success: true, version: '99.0.0' } });

    const result = await startCommand({ nonInteractive });

    expect(result.success).toBe(true);
    expect(mockWsClient.connect).toHaveBeenCalled();
    expect(automaticUpdaterMocks.handleRouterVersion).toHaveBeenCalledWith('99.0.0');
    expect(mockConfig.set).toHaveBeenCalledWith('service.running', true);
  });

  it('continues startup normally when version check fails (network error)', async () => {
    vi.mocked(axios.get).mockRejectedValueOnce(new Error('timeout'));

    const result = await startCommand({ daemon: false });

    expect(result.success).toBe(true);
    expect(mockWsClient.connect).toHaveBeenCalled();
  });
});
