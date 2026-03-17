import { ThreadManager } from './ThreadManager';
import { ThreadSummary } from './types';
import type { IExecutor } from '../executor/IExecutor';
import type { DirectoryGuard } from '../security/DirectoryGuard';
import type { ExecutorConfig } from '../types/config';
import { createExecutor } from '../executor';

/**
 * Thread runtime status (not persisted — computed from locking state).
 */
type ThreadStatus = 'idle' | 'running' | 'error';

/**
 * Factory function signature for creating executors (injectable for testing).
 */
export type ExecutorFactory = (
  directoryGuard: DirectoryGuard,
  config: ExecutorConfig,
  initialWorkingDirectory?: string
) => IExecutor;

/**
 * Manages a pool of executor instances — one per thread.
 * Executors are lazily created on first use.
 * Each thread has its own per-thread busy lock and error flag.
 */
export class ThreadExecutorPool {
  private executors = new Map<string, IExecutor>();
  private busy = new Map<string, boolean>();
  private errorFlag = new Map<string, boolean>();
  private executorConfig: ExecutorConfig;
  private readonly threadManager: ThreadManager;
  private readonly directoryGuard: DirectoryGuard;
  private readonly factory: ExecutorFactory;

  constructor(
    threadManager: ThreadManager,
    directoryGuard: DirectoryGuard,
    executorConfig: ExecutorConfig,
    factory: ExecutorFactory = createExecutor
  ) {
    this.threadManager = threadManager;
    this.directoryGuard = directoryGuard;
    this.executorConfig = executorConfig;
    this.factory = factory;
  }

  /**
   * Get (or lazily create) the executor for a thread.
   * Throws if the threadId is unknown.
   */
  getExecutor(threadId: string): IExecutor {
    const thread = this.threadManager.getThread(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);

    let executor = this.executors.get(threadId);
    if (!executor) {
      executor = this.factory(
        this.directoryGuard,
        this.executorConfig,
        thread.workingDirectory || undefined
      );
      this.executors.set(threadId, executor);
    }
    return executor;
  }

  // ── Per-thread locking ──────────────────────────────────────────────────

  isThreadBusy(threadId: string): boolean {
    return this.busy.get(threadId) ?? false;
  }

  setThreadBusy(threadId: string, busy: boolean): void {
    this.busy.set(threadId, busy);
    if (busy) {
      // Clear error flag when thread starts running
      this.errorFlag.set(threadId, false);
    }
  }

  setThreadError(threadId: string, hasError: boolean): void {
    this.errorFlag.set(threadId, hasError);
    if (hasError) {
      this.busy.set(threadId, false);
    }
  }

  getStatus(threadId: string): ThreadStatus {
    if (this.errorFlag.get(threadId)) return 'error';
    if (this.busy.get(threadId)) return 'running';
    return 'idle';
  }

  // ── Thread summaries ────────────────────────────────────────────────────

  /**
   * Get runtime summaries for all threads (id, name, status).
   */
  getSummaries(): ThreadSummary[] {
    return this.threadManager.listThreads().map(t => ({
      id: t.id,
      name: t.name,
      status: this.getStatus(t.id),
    }));
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /**
   * Destroy a single thread's executor and remove it from the pool.
   * No-op if no executor has been created for this thread.
   */
  async destroyThread(threadId: string): Promise<void> {
    const executor = this.executors.get(threadId);
    if (executor) {
      await executor.destroy();
      this.executors.delete(threadId);
      this.busy.delete(threadId);
      this.errorFlag.delete(threadId);
    }
  }

  /**
   * Destroy all executors in the pool.
   */
  async destroyAll(): Promise<void> {
    await Promise.all(
      Array.from(this.executors.keys()).map(id => this.destroyThread(id))
    );
  }

  /**
   * Switch all threads to a new executor backend.
   * Destroys all existing executors; new ones will be lazily created on next use.
   */
  async switchBackend(newConfig: ExecutorConfig): Promise<void> {
    await this.destroyAll();
    this.executorConfig = newConfig;
  }
}
