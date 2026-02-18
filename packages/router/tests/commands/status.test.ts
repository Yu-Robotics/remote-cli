import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock dependencies before importing the command
vi.mock('axios');
vi.mock('os', () => ({
  default: { homedir: () => '/mock/home' },
  homedir: () => '/mock/home'
}));
vi.mock('fs/promises');
vi.mock('../../src/utils/PidManager');

import { statusCommand } from '../../src/commands/status';
import { PidManager } from '../../src/utils/PidManager';
import { ConfigManager } from '../../src/config/ConfigManager';
import axios from 'axios';
import fs from 'fs/promises';

describe('status command', () => {
  let mockPidManager: any;
  let consoleLogSpy: any;
  let consoleErrorSpy: any;
  let processExitSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock PidManager
    mockPidManager = {
      getRunningPid: vi.fn(),
    };
    vi.mocked(PidManager).mockImplementation(() => mockPidManager);

    // Mock fs for ConfigManager
    (fs.mkdir as any) = vi.fn().mockResolvedValue(undefined);
    (fs.readFile as any) = vi.fn().mockRejectedValue({ code: 'ENOENT' });
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

  describe('when server is not running', () => {
    it('should report not running status', async () => {
      mockPidManager.getRunningPid.mockResolvedValue(null);

      await statusCommand();

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Not Running'));
    });

    it('should suggest start command', async () => {
      mockPidManager.getRunningPid.mockResolvedValue(null);

      await statusCommand();

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('remote-cli-router start'));
    });
  });

  describe('when server is running', () => {
    beforeEach(() => {
      mockPidManager.getRunningPid.mockResolvedValue(12345);
    });

    it('should report running status with PID', async () => {
      (axios.get as any) = vi.fn().mockResolvedValue({
        data: {
          connections: 2,
          devices: ['dev_1', 'dev_2'],
          timestamp: Date.now()
        }
      });

      await statusCommand();

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Running'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('12345'));
    });

    it('should show connection count from health endpoint', async () => {
      (axios.get as any) = vi.fn().mockResolvedValue({
        data: {
          connections: 5,
          devices: ['dev_1'],
          timestamp: Date.now()
        }
      });

      await statusCommand();

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('5'));
    });

    it('should show connected devices', async () => {
      (axios.get as any) = vi.fn().mockResolvedValue({
        data: {
          connections: 2,
          devices: ['dev_device_1', 'dev_device_2'],
          timestamp: Date.now()
        }
      });

      await statusCommand();

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('dev_device_1'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('dev_device_2'));
    });

    it('should handle health endpoint failure gracefully', async () => {
      (axios.get as any) = vi.fn().mockRejectedValue(new Error('Connection refused'));

      await statusCommand();

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Could not fetch health status'));
    });

    it('should show masked app ID in configuration', async () => {
      // Setup config with appId
      (fs.readFile as any) = vi.fn().mockResolvedValue(JSON.stringify({
        server: { port: 3000, host: '0.0.0.0', nodeEnv: 'production' },
        feishu: { appId: 'cli_test12345678', appSecret: 'secret123' },
        websocket: { heartbeatInterval: 15000, reconnectDelay: 5000 },
        security: { bindingCodeExpiry: 300000, maxBindingAttempts: 5 }
      }));

      (axios.get as any) = vi.fn().mockResolvedValue({
        data: { connections: 0, devices: [], timestamp: Date.now() }
      });

      await statusCommand();

      // App ID should be masked
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('cli_...5678'));
    });
  });

  describe('error handling', () => {
    it('should handle unexpected errors', async () => {
      mockPidManager.getRunningPid.mockRejectedValue(new Error('Unexpected error'));

      await statusCommand();

      // console.error is called with two arguments: message prefix and error message
      expect(consoleErrorSpy).toHaveBeenCalled();
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });
});
