import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock dependencies before importing the command
vi.mock('os', () => ({
  default: { homedir: () => '/mock/home' },
  homedir: () => '/mock/home'
}));
vi.mock('fs/promises');
vi.mock('../../src/utils/PidManager');
vi.mock('../../src/storage/JsonStore');
vi.mock('../../src/server');

import { startCommand } from '../../src/commands/start';
import { PidManager } from '../../src/utils/PidManager';
import { JsonStore } from '../../src/storage/JsonStore';
import { RouterServer } from '../../src/server';
import fs from 'fs/promises';

describe('start command', () => {
  let mockPidManager: any;
  let mockStore: any;
  let mockServer: any;
  let consoleLogSpy: any;
  let consoleErrorSpy: any;
  let processExitSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock PidManager
    mockPidManager = {
      getRunningPid: vi.fn().mockResolvedValue(null),
      writePid: vi.fn().mockResolvedValue(undefined),
      removePid: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(PidManager).mockImplementation(() => mockPidManager);

    // Mock JsonStore
    mockStore = {
      initialize: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(JsonStore).mockImplementation(() => mockStore);

    // Mock RouterServer
    mockServer = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(RouterServer).mockImplementation(() => mockServer);

    // Mock fs for ConfigManager
    (fs.mkdir as any) = vi.fn().mockResolvedValue(undefined);
    (fs.writeFile as any) = vi.fn().mockResolvedValue(undefined);

    // Mock console
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Mock process.exit
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  describe('when server is already running', () => {
    it('should report that server is already running', async () => {
      mockPidManager.getRunningPid.mockResolvedValue(12345);

      await startCommand();

      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('already running'));
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it('should show the running PID', async () => {
      mockPidManager.getRunningPid.mockResolvedValue(12345);

      await startCommand();

      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('12345'));
    });
  });

  describe('when configuration is missing', () => {
    it('should report missing configuration if appId is empty', async () => {
      (fs.readFile as any) = vi.fn().mockResolvedValue(JSON.stringify({
        server: { port: 3000, host: '0.0.0.0', nodeEnv: 'production' },
        feishu: { appId: '', appSecret: '' },
        websocket: { heartbeatInterval: 15000, reconnectDelay: 5000 },
        security: { bindingCodeExpiry: 300000, maxBindingAttempts: 5 }
      }));

      await startCommand();

      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Missing required configuration'));
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it('should report missing configuration if appSecret is empty', async () => {
      (fs.readFile as any) = vi.fn().mockResolvedValue(JSON.stringify({
        server: { port: 3000, host: '0.0.0.0', nodeEnv: 'production' },
        feishu: { appId: 'test_app_id', appSecret: '' },
        websocket: { heartbeatInterval: 15000, reconnectDelay: 5000 },
        security: { bindingCodeExpiry: 300000, maxBindingAttempts: 5 }
      }));

      await startCommand();

      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Missing required configuration'));
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it('should suggest running config command', async () => {
      (fs.readFile as any) = vi.fn().mockResolvedValue(JSON.stringify({
        server: { port: 3000, host: '0.0.0.0', nodeEnv: 'production' },
        feishu: { appId: '', appSecret: '' },
        websocket: { heartbeatInterval: 15000, reconnectDelay: 5000 },
        security: { bindingCodeExpiry: 300000, maxBindingAttempts: 5 }
      }));

      await startCommand();

      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('remote-cli-router config'));
    });
  });

  describe('successful startup', () => {
    beforeEach(() => {
      (fs.readFile as any) = vi.fn().mockResolvedValue(JSON.stringify({
        server: { port: 3000, host: '0.0.0.0', nodeEnv: 'production' },
        feishu: { appId: 'test_app_id', appSecret: 'test_secret' },
        websocket: { heartbeatInterval: 15000, reconnectDelay: 5000 },
        security: { bindingCodeExpiry: 300000, maxBindingAttempts: 5 }
      }));
    });

    it('should write PID file', async () => {
      await startCommand();

      expect(mockPidManager.writePid).toHaveBeenCalledWith(process.pid);
    });

    it('should initialize storage', async () => {
      await startCommand();

      expect(mockStore.initialize).toHaveBeenCalled();
    });

    it('should create and start the router server', async () => {
      await startCommand();

      expect(RouterServer).toHaveBeenCalled();
      expect(mockServer.start).toHaveBeenCalled();
    });

    it('should show startup message', async () => {
      await startCommand();

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Starting'));
    });
  });

  describe('error handling', () => {
    beforeEach(() => {
      (fs.readFile as any) = vi.fn().mockResolvedValue(JSON.stringify({
        server: { port: 3000, host: '0.0.0.0', nodeEnv: 'production' },
        feishu: { appId: 'test_app_id', appSecret: 'test_secret' },
        websocket: { heartbeatInterval: 15000, reconnectDelay: 5000 },
        security: { bindingCodeExpiry: 300000, maxBindingAttempts: 5 }
      }));
    });

    it('should handle server start failure', async () => {
      mockServer.start.mockRejectedValue(new Error('Port already in use'));

      await startCommand();

      // console.error is called with two arguments
      expect(consoleErrorSpy).toHaveBeenCalled();
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it('should handle storage initialization failure', async () => {
      mockStore.initialize.mockRejectedValue(new Error('Storage error'));

      await startCommand();

      // console.error is called with two arguments
      expect(consoleErrorSpy).toHaveBeenCalled();
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });
});
