import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock PidManager before importing the command
vi.mock('../../src/utils/PidManager');

import { stopCommand } from '../../src/commands/stop';
import { PidManager } from '../../src/utils/PidManager';

describe('stop command', () => {
  let mockPidManager: any;
  let consoleLogSpy: any;
  let consoleErrorSpy: any;
  let processExitSpy: any;
  let processKillSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock PidManager
    mockPidManager = {
      getRunningPid: vi.fn(),
      removePid: vi.fn().mockResolvedValue(undefined),
      isProcessRunning: vi.fn(),
    };
    vi.mocked(PidManager).mockImplementation(() => mockPidManager);

    // Mock console
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Mock process.exit
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    // Mock process.kill
    processKillSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  describe('when server is not running', () => {
    it('should report that server is not running', async () => {
      mockPidManager.getRunningPid.mockResolvedValue(null);

      await stopCommand();

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('not running'));
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it('should suggest start command', async () => {
      mockPidManager.getRunningPid.mockResolvedValue(null);

      await stopCommand();

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('remote-cli-router start'));
    });
  });

  describe('when server is running', () => {
    beforeEach(() => {
      mockPidManager.getRunningPid.mockResolvedValue(12345);
    });

    it('should send SIGTERM to the running process', async () => {
      mockPidManager.isProcessRunning.mockReturnValue(false);

      await stopCommand();

      expect(processKillSpy).toHaveBeenCalledWith(12345, 'SIGTERM');
    });

    it('should clean up PID file after stopping', async () => {
      mockPidManager.isProcessRunning.mockReturnValue(false);

      await stopCommand();

      expect(mockPidManager.removePid).toHaveBeenCalled();
    });

    it('should report success when stopped', async () => {
      mockPidManager.isProcessRunning.mockReturnValue(false);

      await stopCommand();

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('stopped successfully'));
    });

    it('should handle process already stopped (ESRCH)', async () => {
      processKillSpy.mockImplementation(() => {
        const error: any = new Error('Process not found');
        error.code = 'ESRCH';
        throw error;
      });

      await stopCommand();

      expect(mockPidManager.removePid).toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('already stopped'));
    });

    it('should handle kill errors', async () => {
      processKillSpy.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      await stopCommand();

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to stop'));
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('graceful shutdown timeout', () => {
    it('should send SIGKILL if process does not stop within timeout', async () => {
      mockPidManager.getRunningPid.mockResolvedValue(12345);

      // Process keeps running until SIGKILL
      let killCount = 0;
      mockPidManager.isProcessRunning.mockImplementation(() => {
        // After SIGKILL, process stops
        return killCount < 2;
      });
      processKillSpy.mockImplementation((pid: number, signal: string) => {
        killCount++;
        return true;
      });

      // Use fake timers for timeout test
      vi.useFakeTimers();

      const stopPromise = stopCommand();

      // Fast forward time to trigger timeout
      await vi.advanceTimersByTimeAsync(11000);

      await stopPromise;

      vi.useRealTimers();

      // Should have sent both SIGTERM and SIGKILL
      expect(processKillSpy).toHaveBeenCalledWith(12345, 'SIGTERM');
      expect(processKillSpy).toHaveBeenCalledWith(12345, 'SIGKILL');
    });
  });
});
