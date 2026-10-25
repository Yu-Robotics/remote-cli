import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PidManager } from '../src/utils/PidManager';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

describe('PidManager', () => {
  let testDir: string;
  let pidManager: PidManager;

  beforeEach(async () => {
    testDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'router-pid-test-')));
    pidManager = new PidManager(testDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('writePid', () => {
    it('should write PID to file', async () => {
      const testPid = 12345;
      await pidManager.writePid(testPid);

      const pidFilePath = path.join(testDir, 'server.pid');
      const content = await fs.readFile(pidFilePath, 'utf-8');
      expect(content).toBe('12345');
    });

    it('should create directory if it does not exist', async () => {
      const deepDir = path.join(testDir, 'nested');
      const deepManager = new PidManager(deepDir);

      await deepManager.writePid(99999);

      const pidFilePath = path.join(deepDir, 'server.pid');
      const content = await fs.readFile(pidFilePath, 'utf-8');
      expect(content).toBe('99999');

    });
  });

  describe('startup ownership', () => {
    it('retains the first-line PID for legacy readers and ordinary stop/status probes', async () => {
      await pidManager.writeOwnedPid(process.pid);
      const content = await fs.readFile(path.join(testDir, 'server.pid'), 'utf8');
      expect(content.split('\n')[0]).toBe(String(process.pid));
      expect(content.split('\n')[1]).toMatch(/^[0-9a-f-]{36}$/);
      expect(parseInt(content.trim(), 10)).toBe(process.pid);
      expect(await pidManager.readPid()).toBe(process.pid);
      expect(pidManager.isProcessRunning(process.pid)).toBe(true);
      expect(await pidManager.getRunningPid()).toBe(process.pid);
      await pidManager.removeOwnedPid();
      expect(await pidManager.readPid()).toBeNull();
      await expect(pidManager.removeOwnedPid()).resolves.toBeUndefined();
    });

    it('does not clean any record before this attempt writes its own', async () => {
      await pidManager.writePid(process.pid);
      await pidManager.removeOwnedPid();
      expect(await fs.readFile(path.join(testDir, 'server.pid'), 'utf8')).toBe(String(process.pid));
    });

    it('preserves a replacement startup record even if its PID is identical', async () => {
      await pidManager.writeOwnedPid(process.pid);
      const replacement = new PidManager(testDir);
      await replacement.writeOwnedPid(process.pid);
      const content = await fs.readFile(path.join(testDir, 'server.pid'), 'utf8');
      await pidManager.removeOwnedPid();
      expect(await fs.readFile(path.join(testDir, 'server.pid'), 'utf8')).toBe(content);
      await replacement.removeOwnedPid();
      expect(await pidManager.readPid()).toBeNull();
    });

    it.each([12345, process.pid])('preserves replacement legacy PID %i', async pid => {
      await pidManager.writeOwnedPid(process.pid);
      await new PidManager(testDir).writePid(pid);
      await pidManager.removeOwnedPid();
      expect(await fs.readFile(path.join(testDir, 'server.pid'), 'utf8')).toBe(String(pid));
    });

    it('can clean an owned write that reached disk before reporting failure', async () => {
      const original = fs.writeFile.bind(fs);
      vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (...args) => {
        await original(...args);
        throw new Error('Synthetic write completion failure');
      });
      await expect(pidManager.writeOwnedPid(process.pid)).rejects.toThrow('Failed to write PID file');
      expect(await pidManager.readPid()).toBe(process.pid);
      await pidManager.removeOwnedPid();
      expect(await pidManager.readPid()).toBeNull();
    });

    it.each(['readFile', 'unlink'] as const)('reports an owned cleanup %s error without removing the record', async operation => {
      await pidManager.writeOwnedPid(process.pid);
      const failure = vi.spyOn(fs, operation).mockRejectedValueOnce(new Error('Synthetic storage failure'));
      await expect(pidManager.removeOwnedPid()).rejects.toThrow('Failed to remove owned PID file');
      failure.mockRestore();
      expect(await pidManager.readPid()).toBe(process.pid);
    });

    it('reports PID persistence errors', async () => {
      vi.spyOn(fs, 'mkdir').mockRejectedValueOnce(new Error('Synthetic storage failure'));
      await expect(pidManager.writeOwnedPid(process.pid)).rejects.toThrow('Failed to write PID file');
      await pidManager.removeOwnedPid();
    });
  });

  describe('readPid', () => {
    it('should read PID from file', async () => {
      await pidManager.writePid(54321);
      const pid = await pidManager.readPid();
      expect(pid).toBe(54321);
    });

    it('should return null if PID file does not exist', async () => {
      const pid = await pidManager.readPid();
      expect(pid).toBeNull();
    });

    it('should return null if PID file contains invalid content', async () => {
      const pidFilePath = path.join(testDir, 'server.pid');
      await fs.writeFile(pidFilePath, 'not-a-number', 'utf-8');
      const pid = await pidManager.readPid();
      expect(pid).toBeNull();
    });
  });

  describe('removePid', () => {
    it('should remove PID file', async () => {
      await pidManager.writePid(11111);

      const pidFilePath = path.join(testDir, 'server.pid');
      expect(await fileExists(pidFilePath)).toBe(true);

      await pidManager.removePid();
      expect(await fileExists(pidFilePath)).toBe(false);
    });

    it('should not throw error if PID file does not exist', async () => {
      await expect(pidManager.removePid()).resolves.not.toThrow();
    });
  });

  describe('isProcessRunning', () => {
    it('should return true for current process', () => {
      const result = pidManager.isProcessRunning(process.pid);
      expect(result).toBe(true);
    });

    it('should return false for non-existent process', () => {
      // Use a PID that is very unlikely to exist
      const result = pidManager.isProcessRunning(999999);
      expect(result).toBe(false);
    });
  });

  describe('getRunningPid', () => {
    it('should return PID if process is running', async () => {
      await pidManager.writePid(process.pid);
      const runningPid = await pidManager.getRunningPid();
      expect(runningPid).toBe(process.pid);
    });

    it('should return null if PID file does not exist', async () => {
      const runningPid = await pidManager.getRunningPid();
      expect(runningPid).toBeNull();
    });

    it('should return null and clean up stale PID file', async () => {
      // Write a PID that doesn't exist
      await pidManager.writePid(999999);

      const runningPid = await pidManager.getRunningPid();
      expect(runningPid).toBeNull();

      // Verify PID file was removed
      const pidFilePath = path.join(testDir, 'server.pid');
      expect(await fileExists(pidFilePath)).toBe(false);
    });
  });
});

/**
 * Helper function to check if file exists
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
