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
    vi.useRealTimers();
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

    it('signals the recorded PID, removes its record and reports a graceful stop', async () => {
      mockPidManager.isProcessRunning.mockReturnValue(false);

      await stopCommand();

      expect(processKillSpy.mock.calls).toEqual([[12345, 'SIGTERM']]);
      expect(mockPidManager.removePid).toHaveBeenCalledOnce();
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

      mockPidManager.isProcessRunning.mockReturnValue(true);
      vi.useFakeTimers();

      const stopPromise = stopCommand();

      await vi.advanceTimersByTimeAsync(9_999);
      expect(processKillSpy.mock.calls).toEqual([[12345, 'SIGTERM']]);
      expect(mockPidManager.removePid).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_001);
      await stopPromise;
      expect(processKillSpy.mock.calls).toEqual([[12345, 'SIGTERM'], [12345, 'SIGKILL']]);
      expect(mockPidManager.removePid).toHaveBeenCalledOnce();
    });
  });
});
