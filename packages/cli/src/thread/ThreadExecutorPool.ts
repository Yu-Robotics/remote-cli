import { ThreadManager } from './ThreadManager';
import { ThreadSummary } from './types';
import type { Thread } from './types';
import type { IExecutor } from '../executor/IExecutor';
import type { DirectoryGuard } from '../security/DirectoryGuard';
import type { BackendKey, ExecutorConfig } from '../types/config';
import { backendKeyOf } from '../types/config';
import { createExecutor } from '../executor';

/**
 * Resolve the model a thread should use on the given backend.
 * Per-backend `thread.models[key]` wins; the legacy `thread.model` field is
 * honored for the Claude backend only (model names are backend-specific —
 * a Claude name like "opus" is rejected by agy/codex).
 */
function resolveThreadModel(thread: Thread, config: ExecutorConfig): string | undefined {
  const key = backendKeyOf(config.type as string);
  return thread.models?.[key] ?? (key === 'claude' ? thread.model || undefined : undefined);
}

function resolveThreadEffort(thread: Thread, config: ExecutorConfig): string | undefined {
  const key = backendKeyOf(config.type as string);
  return key === 'codex' || key === 'agy' ? thread.efforts?.[key] : undefined;
}

function isClaudeType(type: string): boolean {
  return type === 'auto' || type === 'claude-persistent' || type === 'claude-spawn';
}

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
  initialWorkingDirectory?: string,
  threadId?: string,
  model?: string,
  effort?: string
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
        this.getEffectiveConfig(thread),
        thread.workingDirectory || undefined,
        threadId,
        resolveThreadModel(thread, this.getEffectiveConfig(thread)),
        resolveThreadEffort(thread, this.getEffectiveConfig(thread))
      );
      this.executors.set(threadId, executor);
    }
    return executor;
  }

  /** Return the backend actually used by a thread. */
  getBackendKey(threadId: string): BackendKey {
    const thread = this.threadManager.getThread(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    return thread.backend ?? backendKeyOf(this.executorConfig.type as string);
  }

  /** Return a thread's effective executor configuration. */
  getEffectiveConfig(thread: Thread): ExecutorConfig {
    if (!thread.backend) return this.executorConfig;
    if (thread.backend === 'claude') {
      return { ...this.executorConfig, type: isClaudeType(this.executorConfig.type) ? this.executorConfig.type : 'auto' };
    }
    return { ...this.executorConfig, type: thread.backend };
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
   * Get runtime summaries for all threads (id, name, status, backend).
   */
  getSummaries(): ThreadSummary[] {
    return this.threadManager.listThreads().map(t => ({
      id: t.id,
      name: t.name,
      status: this.getStatus(t.id),
      backend: this.getBackendKey(t.id),
    }));
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /**
   * Destroy a single thread's executor and remove it from the pool.
   * No-op if no executor has been created for this thread.
   *
   * By default the executor's persisted session data (claude session file /
   * agy conversation id / codex thread id) is deleted too — that is what
   * `/thread delete` wants. Pass `{ deleteData: false }` when only the
   * process should be torn down (e.g. backend switch), so switching back can
   * resume the conversation.
   */
  async destroyThread(threadId: string, options: { deleteData?: boolean } = {}): Promise<void> {
    const deleteData = options.deleteData ?? true;
    const executor = this.executors.get(threadId);
    if (executor) {
      if (deleteData && executor.deleteThreadData) {
        await executor.deleteThreadData(threadId);
      }
      // Always destroy the process: some deleteThreadData implementations
      // (e.g. Claude) only unlink the session file. destroy() is idempotent.
      await executor.destroy();
      this.executors.delete(threadId);
      this.busy.delete(threadId);
      this.errorFlag.delete(threadId);
    }
  }

  /**
   * Destroy all executors in the pool.
   * Pass `{ deleteData: false }` to keep per-backend session files on disk.
   */
  async destroyAll(options: { deleteData?: boolean } = {}): Promise<void> {
    await Promise.all(
      Array.from(this.executors.keys()).map(id => this.destroyThread(id, options))
    );
  }

  /**
   * Switch all threads to a new executor backend.
   * Destroys all existing executor processes; new ones will be lazily created
   * on next use. Session data is preserved (deleteData: false): each backend
   * keeps its own per-thread session pointer, so switching back to a backend
   * resumes the conversation that thread had on it.
   */
  async switchBackend(newConfig: ExecutorConfig): Promise<void> {
    await this.destroyAll({ deleteData: false });
    this.executorConfig = newConfig;
  }

  /** Switch one thread without affecting any other executor. */
  async switchThreadBackend(threadId: string, backend: BackendKey): Promise<void> {
    if (this.isThreadBusy(threadId)) {
      throw new Error('Cannot switch backend while this thread is running. Send /abort first.');
    }
    const thread = this.threadManager.getThread(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    if (thread.backend === backend) return;
    if (this.getBackendKey(threadId) === backend) {
      await this.threadManager.updateThread(threadId, { backend });
      return;
    }
    await this.destroyThread(threadId, { deleteData: false });
    await this.threadManager.updateThread(threadId, { backend });
  }
}
