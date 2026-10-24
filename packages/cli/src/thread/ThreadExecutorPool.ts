import { ThreadManager } from './ThreadManager';
import { ThreadSummary } from './types';
import type { Thread } from './types';
import path from 'path';
import { promises as fs } from 'fs';
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
export function resolveThreadModel(thread: Thread, config: ExecutorConfig): string | undefined {
  const key = backendKeyOf(config.type as string);
  return thread.models?.[key] ?? (key === 'claude' ? thread.model || undefined : undefined);
}

function resolveThreadEffort(thread: Thread, config: ExecutorConfig): string | undefined {
  const key = backendKeyOf(config.type as string);
  return thread.efforts?.[key];
}

function isClaudeType(type: string): boolean {
  return type === 'auto' || type === 'claude-persistent';
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
  effort?: string,
  runtime?: { speed?: string | null }
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
  private readonly contextResetShutdowns = new Map<string, Promise<void>>();

  constructor(
    threadManager: ThreadManager,
    directoryGuard: DirectoryGuard,
    executorConfig: ExecutorConfig,
    factory: ExecutorFactory = createExecutor,
    private readonly contextResetShutdownTimeoutMs = 15_000
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
    this.threadManager.contextResets.assertReady(threadId);

    let executor = this.executors.get(threadId);
    if (!executor) {
      const configuration = this.getEffectiveConfig(thread);
      const speed = thread.speeds?.[backendKeyOf(configuration.type as string)];
      const args: Parameters<ExecutorFactory> = [
        this.directoryGuard,
        configuration,
        thread.workingDirectory || undefined,
        threadId,
        resolveThreadModel(thread, configuration),
        resolveThreadEffort(thread, configuration),
      ];
      if (speed !== undefined) args.push({ speed });
      executor = this.factory(...args);
      this.executors.set(threadId, executor);
    }
    return executor;
  }

  assertContextResettable(threadId: string): void {
    if (!this.threadManager.getThread(threadId)) throw new Error(`Thread not found: ${threadId}`);
    if (this.executors.get(threadId)?.isBusy?.()) {
      throw new Error('Cannot clear conversation context while the backend is busy. Wait for it to finish.');
    }
  }

  /** Called under thread admission exclusion, after persisting whole-thread reset intent. */
  async clearThreadContext(threadId: string): Promise<void> {
    this.assertContextResettable(threadId);
    if (!this.threadManager.contextResets.isPending(threadId)) throw new Error('Thread context reset intent is missing');
    const executor = this.executors.get(threadId);
    if (executor) {
      let shutdown = this.contextResetShutdowns.get(threadId);
      if (!shutdown) {
        shutdown = Promise.resolve().then(async () => {
          // Native cleanup and reset may still mutate pointers after an outer timeout.
          await executor.destroy();
          if (executor.waitForExit) await executor.waitForExit();
          else if (executor.isProcessRunning?.()) throw new Error('Backend shutdown is unconfirmed. Retry /clear after it exits.');
          await executor.resetContext();
        });
        this.contextResetShutdowns.set(threadId, shutdown);
        void shutdown.catch(() => {
          if (this.contextResetShutdowns.get(threadId) === shutdown) this.contextResetShutdowns.delete(threadId);
        });
      }
      // A timeout releases admission, but retains the executor and the same cleanup
      // promise. Only an explicit retry that observes its settlement may detach it.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([shutdown, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(
            'Backend shutdown timed out. Context remains blocked; wait for cleanup and retry /clear or /new.'
          )), this.contextResetShutdownTimeoutMs);
        })]);
      } finally { if (timer) clearTimeout(timer); }
    }
    await this.threadManager.clearBackendSessionPointers(threadId);
    await this.threadManager.updateThread(threadId, { sessionId: null });
    this.executors.delete(threadId);
    this.contextResetShutdowns.delete(threadId);
  }

  /** Changing projects invalidates this thread's sessions on every backend. */
  async setWorkingDirectory(threadId: string, targetPath: string): Promise<{ cwd: string; changed: boolean }> {
    const executor = this.getExecutor(threadId);
    const previous = executor.getCurrentWorkingDirectory();
    const cwd = this.directoryGuard.resolveWorkingDirectory(targetPath, previous);
    if (cwd === previous) return { cwd, changed: false };
    const destination = await fs.stat(cwd).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw new Error(`Directory does not exist: ${cwd}`);
      throw error;
    });
    if (!destination.isDirectory()) throw new Error(`Not a directory: ${cwd}`);
    if (executor.isBusy?.()) throw new Error('Cannot change working directory while this thread is busy');

    await this.threadManager.clearBackendSessionPointers(threadId);
    await executor.setWorkingDirectory(cwd);
    const thread = this.threadManager.getThread(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    // Persist the directory and delegation generation together. A lane can only
    // be resumed when this authoritative thread generation still matches it.
    await this.threadManager.updateThread(threadId, {
      workingDirectory: cwd,
      sessionId: null,
      delegationWorkspaceGeneration: (thread.delegationWorkspaceGeneration ?? 0) + 1,
    });
    return { cwd, changed: true };
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
   * Get runtime summaries for all threads (id, name, status, backend, workspace).
   */
  getSummaries(): ThreadSummary[] {
    return this.threadManager.listThreads().map(t => ({
      id: t.id,
      name: t.name,
      status: this.getStatus(t.id),
      backend: this.getBackendKey(t.id),
      workspaceName: t.workingDirectory
        ? path.basename(path.normalize(t.workingDirectory)) || path.parse(path.normalize(t.workingDirectory)).root
        : undefined,
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
    // Teardown must not discard ownership of cleanup retained by a failed reset.
    this.threadManager.contextResets.assertReady(threadId);
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
   * Service shutdown also joins retained cleanup without clearing reset intent.
   */
  async destroyAll(options: { deleteData?: boolean; shutdown?: boolean } = {}): Promise<void> {
    if (options.shutdown) {
      if (options.deleteData !== false) throw new Error('Service shutdown must preserve conversation data');
      const results = await Promise.allSettled(Array.from(this.executors.keys()).map(async threadId => {
        const executor = this.executors.get(threadId)!;
        const retained = this.contextResetShutdowns.get(threadId);
        if (retained) await retained;
        else await executor.destroy();
        if (executor.waitForExit) await executor.waitForExit();
        else if (executor.isProcessRunning?.()) throw new Error('Backend shutdown is unconfirmed');
        this.executors.delete(threadId);
        this.contextResetShutdowns.delete(threadId);
        this.busy.delete(threadId);
        this.errorFlag.delete(threadId);
      }));
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failure) throw failure.reason;
      return;
    }
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
    for (const thread of this.threadManager.listThreads()) this.threadManager.contextResets.assertReady(thread.id);
    await this.destroyAll({ deleteData: false });
    this.executorConfig = newConfig;
  }

  /** Switch one thread without affecting any other executor. */
  async switchThreadBackend(threadId: string, backend: BackendKey): Promise<void> {
    this.threadManager.contextResets.assertReady(threadId);
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
