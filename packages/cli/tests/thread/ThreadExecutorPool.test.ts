import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { ThreadExecutorPool } from '../../src/thread/ThreadExecutorPool';
import { ThreadManager } from '../../src/thread/ThreadManager';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import type { IExecutor } from '../../src/executor/IExecutor';
import type { ExecutorConfig } from '../../src/types/config';

const originalHomedir = os.homedir();
vi.spyOn(os, 'homedir').mockImplementation(() => process.env.HOME || originalHomedir);

/**
 * Create a mock executor that tracks state
 */
function makeMockExecutor(overrides: Partial<IExecutor> = {}): IExecutor {
  return {
    execute: vi.fn().mockResolvedValue({ success: true, output: 'ok' }),
    getCurrentWorkingDirectory: vi.fn().mockReturnValue('/tmp'),
    setWorkingDirectory: vi.fn().mockResolvedValue(undefined),
    resetContext: vi.fn(),
    abort: vi.fn().mockResolvedValue(true),
    destroy: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('ThreadExecutorPool', () => {
  let tmpDir: string;
  let manager: ThreadManager;
  let directoryGuard: DirectoryGuard;
  let executorConfig: ExecutorConfig;
  let mockExecutorFactory: ReturnType<typeof vi.fn>;
  let pool: ThreadExecutorPool;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'thread-pool-test-'));
    process.env.HOME = tmpDir;
    manager = await ThreadManager.initialize(tmpDir);
    directoryGuard = new DirectoryGuard([tmpDir]);
    executorConfig = { type: 'auto' };
    mockExecutorFactory = vi.fn().mockImplementation(() => makeMockExecutor());
    pool = new ThreadExecutorPool(manager, directoryGuard, executorConfig, mockExecutorFactory);
  });

  afterEach(async () => {
    await pool.destroyAll();
    await fs.rm(tmpDir, { recursive: true, force: true });
    delete process.env.HOME;
  });

  describe('lazy executor creation', () => {
    it('does not create executor until getExecutor() is called', () => {
      expect(mockExecutorFactory).not.toHaveBeenCalled();
    });

    it('creates executor on first getExecutor() call', () => {
      const defaultThread = manager.getDefaultThread();
      pool.getExecutor(defaultThread.id);
      expect(mockExecutorFactory).toHaveBeenCalledTimes(1);
    });

    it('reuses executor on subsequent getExecutor() calls', () => {
      const defaultThread = manager.getDefaultThread();
      const e1 = pool.getExecutor(defaultThread.id);
      const e2 = pool.getExecutor(defaultThread.id);
      expect(e1).toBe(e2);
      expect(mockExecutorFactory).toHaveBeenCalledTimes(1);
    });

    it('throws for unknown threadId', () => {
      expect(() => pool.getExecutor('no-such-thread')).toThrow(/not found/i);
    });
  });

  describe('per-thread locking', () => {
    it('isThreadBusy returns false initially', () => {
      const defaultThread = manager.getDefaultThread();
      expect(pool.isThreadBusy(defaultThread.id)).toBe(false);
    });

    it('setThreadBusy / isThreadBusy work together', () => {
      const defaultThread = manager.getDefaultThread();
      pool.setThreadBusy(defaultThread.id, true);
      expect(pool.isThreadBusy(defaultThread.id)).toBe(true);
      pool.setThreadBusy(defaultThread.id, false);
      expect(pool.isThreadBusy(defaultThread.id)).toBe(false);
    });

    it('two threads can be busy simultaneously', async () => {
      const t2 = await manager.createThread('parallel', tmpDir);
      const defaultThread = manager.getDefaultThread();

      pool.setThreadBusy(defaultThread.id, true);
      pool.setThreadBusy(t2.id, true);

      expect(pool.isThreadBusy(defaultThread.id)).toBe(true);
      expect(pool.isThreadBusy(t2.id)).toBe(true);
    });

    it('one thread busy does not affect others', async () => {
      const t2 = await manager.createThread('independent', tmpDir);
      const defaultThread = manager.getDefaultThread();

      pool.setThreadBusy(defaultThread.id, true);
      expect(pool.isThreadBusy(t2.id)).toBe(false);
    });
  });

  describe('thread status', () => {
    it('getSummaries returns all threads with idle status initially', () => {
      const summaries = pool.getSummaries();
      expect(summaries).toHaveLength(1);
      expect(summaries[0].status).toBe('idle');
    });

    it('reflects running status when thread is busy', async () => {
      const defaultThread = manager.getDefaultThread();
      pool.setThreadBusy(defaultThread.id, true);
      const summaries = pool.getSummaries();
      expect(summaries[0].status).toBe('running');
    });

    it('getStatus returns idle/running/error per thread', async () => {
      const defaultThread = manager.getDefaultThread();
      expect(pool.getStatus(defaultThread.id)).toBe('idle');
      pool.setThreadBusy(defaultThread.id, true);
      expect(pool.getStatus(defaultThread.id)).toBe('running');
    });

    it('getStatus returns error when thread is in error state', async () => {
      const defaultThread = manager.getDefaultThread();
      pool.setThreadError(defaultThread.id, true);
      expect(pool.getStatus(defaultThread.id)).toBe('error');
    });
  });

  describe('destroyThread', () => {
    it('calls destroy on the executor', async () => {
      const t = await manager.createThread('destroy-me', tmpDir);
      const executor = pool.getExecutor(t.id);

      await pool.destroyThread(t.id);

      expect(executor.destroy).toHaveBeenCalled();
    });

    it('calls deleteThreadData before destroy when executor supports it', async () => {
      const deleteThreadData = vi.fn().mockResolvedValue(undefined);
      mockExecutorFactory.mockImplementationOnce(() => makeMockExecutor({ deleteThreadData }));

      const t = await manager.createThread('with-cleanup', tmpDir);
      pool.getExecutor(t.id);

      await pool.destroyThread(t.id);

      expect(deleteThreadData).toHaveBeenCalledWith(t.id);
    });

    it('removes executor from pool after destroy', async () => {
      const t = await manager.createThread('removed', tmpDir);
      pool.getExecutor(t.id);
      await pool.destroyThread(t.id);

      // Next getExecutor creates a new one
      const newExecutor = pool.getExecutor(t.id);
      expect(mockExecutorFactory).toHaveBeenCalledTimes(2);
      expect(newExecutor).toBeDefined();
    });

    it('is no-op for thread with no executor yet', async () => {
      const t = await manager.createThread('never-used', tmpDir);
      await expect(pool.destroyThread(t.id)).resolves.not.toThrow();
    });
  });

  describe('destroyAll', () => {
    it('calls destroy on all active executors', async () => {
      const t2 = await manager.createThread('t2', tmpDir);
      const defaultThread = manager.getDefaultThread();

      const e1 = pool.getExecutor(defaultThread.id);
      const e2 = pool.getExecutor(t2.id);

      await pool.destroyAll();

      expect(e1.destroy).toHaveBeenCalled();
      expect(e2.destroy).toHaveBeenCalled();
    });

    it('is a no-op when pool is empty', async () => {
      await expect(pool.destroyAll()).resolves.not.toThrow();
    });
  });

  describe('switchBackend', () => {
    it('destroys executors WITHOUT deleting per-backend session data', async () => {
      const deleteThreadData = vi.fn().mockResolvedValue(undefined);
      mockExecutorFactory.mockImplementationOnce(() => makeMockExecutor({ deleteThreadData }));

      const defaultThread = manager.getDefaultThread();
      const executor = pool.getExecutor(defaultThread.id);

      await pool.switchBackend({ type: 'agy' });

      // The process is torn down, but the on-disk session pointer
      // (claude session / agy conversation id / codex thread id) must
      // survive so switching back can resume the conversation.
      expect(executor.destroy).toHaveBeenCalled();
      expect(deleteThreadData).not.toHaveBeenCalled();
    });

    it('lazily recreates executors with the new backend config on next use', async () => {
      const defaultThread = manager.getDefaultThread();
      pool.getExecutor(defaultThread.id);

      await pool.switchBackend({ type: 'codex' });
      pool.getExecutor(defaultThread.id);

      expect(mockExecutorFactory).toHaveBeenCalledTimes(2);
      expect(mockExecutorFactory).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ type: 'codex' }),
        expect.anything(),
        defaultThread.id,
        undefined
      );
    });

    it('destroyThread (thread delete) still deletes session data by default', async () => {
      const deleteThreadData = vi.fn().mockResolvedValue(undefined);
      mockExecutorFactory.mockImplementationOnce(() => makeMockExecutor({ deleteThreadData }));

      const t = await manager.createThread('delete-keeps-deleting', tmpDir);
      pool.getExecutor(t.id);

      await pool.destroyThread(t.id);

      expect(deleteThreadData).toHaveBeenCalledWith(t.id);
    });
  });

  describe('error state transitions', () => {
    it('setThreadBusy(true) clears the error flag', () => {
      const defaultThread = manager.getDefaultThread();
      pool.setThreadError(defaultThread.id, true);
      expect(pool.getStatus(defaultThread.id)).toBe('error');

      pool.setThreadBusy(defaultThread.id, true);
      expect(pool.getStatus(defaultThread.id)).toBe('running');
    });

    it('setThreadError(true) clears the busy flag', () => {
      const defaultThread = manager.getDefaultThread();
      pool.setThreadBusy(defaultThread.id, true);
      expect(pool.isThreadBusy(defaultThread.id)).toBe(true);

      pool.setThreadError(defaultThread.id, true);
      expect(pool.isThreadBusy(defaultThread.id)).toBe(false);
      expect(pool.getStatus(defaultThread.id)).toBe('error');
    });

    it('destroyThread clears busy and error flags when executor exists', async () => {
      const t = await manager.createThread('flagged', tmpDir);
      // Must get executor first, otherwise destroyThread is a no-op
      pool.getExecutor(t.id);
      pool.setThreadBusy(t.id, true);
      pool.setThreadError(t.id, true);

      await pool.destroyThread(t.id);

      expect(pool.isThreadBusy(t.id)).toBe(false);
      expect(pool.getStatus(t.id)).toBe('idle');
    });
  });

  describe('getSummaries', () => {
    it('includes threads that have no executor yet', async () => {
      const t2 = await manager.createThread('lazy', tmpDir);
      const defaultThread = manager.getDefaultThread();

      // Only get executor for default thread
      pool.getExecutor(defaultThread.id);

      const summaries = pool.getSummaries();
      expect(summaries).toHaveLength(2);
      const lazySummary = summaries.find(s => s.id === t2.id);
      expect(lazySummary).toBeDefined();
      expect(lazySummary!.status).toBe('idle');
    });
  });

  describe('backend switch', () => {
    it('destroys all existing executors when backend switches', async () => {
      const defaultThread = manager.getDefaultThread();
      const oldExecutor = pool.getExecutor(defaultThread.id);

      const newConfig: ExecutorConfig = { type: 'claude-spawn' };
      await pool.switchBackend(newConfig);

      expect(oldExecutor.destroy).toHaveBeenCalled();
    });

    it('uses new config for executors created after switch', async () => {
      const newConfig: ExecutorConfig = { type: 'agy' };
      await pool.switchBackend(newConfig);

      const defaultThread = manager.getDefaultThread();
      pool.getExecutor(defaultThread.id);

      expect(mockExecutorFactory).toHaveBeenCalledWith(
        expect.anything(), // directoryGuard
        newConfig,
        expect.anything(), // workingDir
        expect.anything(), // threadId
        undefined // model
      );
    });

    it('passes thread workingDirectory to executor factory', async () => {
      const subDir = path.join(tmpDir, 'workdir');
      await fs.mkdir(subDir);
      const t = await manager.createThread('wd-thread', subDir);

      pool.getExecutor(t.id);

      expect(mockExecutorFactory).toHaveBeenCalledWith(
        expect.anything(),
        executorConfig,
        subDir,
        t.id,
        undefined
      );
    });

    it('passes undefined to factory when thread workingDirectory is empty string', async () => {
      const t = await manager.createThread('empty-wd', tmpDir);
      // Force empty workingDirectory
      await manager.updateThread(t.id, { workingDirectory: '' });

      pool.getExecutor(t.id);

      expect(mockExecutorFactory).toHaveBeenCalledWith(
        expect.anything(),
        executorConfig,
        undefined,
        t.id,
        undefined
      );
    });

    it('passes thread model to executor factory when set', async () => {
      const t = await manager.createThread('model-thread', tmpDir);
      await manager.updateThread(t.id, { model: 'opus' });

      pool.getExecutor(t.id);

      expect(mockExecutorFactory).toHaveBeenCalledWith(
        expect.anything(),
        executorConfig,
        tmpDir,
        t.id,
        'opus'
      );
    });
  });
});
