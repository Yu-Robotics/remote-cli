import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { DirectoryGuard } from '../security/DirectoryGuard';
import type { BackendKey, ExecutorConfig } from '../types/config';
import type { Thread } from '../thread/types';
import type { IExecutor, ExecuteResult } from '../executor/IExecutor';
import type { ApprovalRequestInfo, ApprovalStatus, ToolUseInfo, ToolResultInfo } from '../types';
import { createExecutor } from '../executor';
import { BackendRegistry } from './BackendRegistry';
import { DelegationStore, type DelegatedTaskRecord } from './DelegationStore';
import { DELEGATION_BACKENDS, type DelegationBackend, type DelegationHandler } from './contract';
import { workerConfiguration } from './WorkerPolicy';

export const DELEGATION_LIMITS = { launches: 12, concurrent: 3, timeoutMs: 30 * 60_000,
  resultBytes: 32 * 1024, streamBytes: 256 * 1024, calls: 500 } as const;

export function workspacesOverlap(first: string, second: string): boolean {
  const contains = (root: string, candidate: string) => {
    const relative = path.relative(root, candidate);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  return contains(first, second) || contains(second, first);
}

export interface DelegationParent {
  thread: Thread;
  messageId: string;
  backend: BackendKey;
  config: ExecutorConfig;
  cwd: string;
  onToolUse: (tool: ToolUseInfo) => void;
  onToolResult: (result: ToolResultInfo) => void;
  onNotice: (text: string) => void;
  onApproval: (request: ApprovalRequestInfo, executor: IExecutor) => boolean;
  onApprovalResolved: (id: string, status: ApprovalStatus) => void;
  isWorkspaceBusy?: (canonicalPath: string) => boolean;
}

interface Task {
  record: DelegatedTaskRecord;
  executor?: IExecutor;
  done: Promise<void>;
  settle: () => void;
  stop?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  interrupted: Promise<ExecuteResult>;
  interrupt: () => void;
}

export interface DelegationScope {
  invoke: DelegationHandler;
  isClosed(): boolean;
  close(): Promise<void>;
  waitingExecutor(): IExecutor | undefined;
}

function bounded(text: string, limit: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text);
  if (buffer.length <= limit) return { text, truncated: false };
  const marker = '\n[Output truncated]';
  let end = limit - Buffer.byteLength(marker);
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return { text: buffer.subarray(0, end).toString('utf8') + marker, truncated: true };
}

async function deadline<T>(operation: () => T | Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Worker cleanup timed out')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

/** Owns children independently of the user-thread queue and primary executor pool. */
export class DelegationManager {
  readonly registry: BackendRegistry;
  readonly store: DelegationStore;
  private running = 0;
  private workspaces = new Map<string, string>();
  private scopes = new Map<string, DelegationScope>();

  constructor(private readonly guard: DirectoryGuard,
    private readonly factory: typeof createExecutor = createExecutor,
    registry = new BackendRegistry(), store = new DelegationStore(),
    private readonly timeoutMs = DELEGATION_LIMITS.timeoutMs,
    private readonly cleanupMs = 10_000,
  ) { this.registry = registry; this.store = store; }

  begin(parent: DelegationParent): DelegationScope {
    if (this.scopes.has(parent.thread.id)) throw new Error('This thread already owns a delegation turn');
    const tasks = new Map<string, Task>();
    const calls = new Map<string, { signature: string; result: Promise<unknown> }>();
    let closed = false;
    let launches = 0;
    let starting = false;
    const cwd = fs.realpathSync(this.guard.resolveWorkingDirectory(parent.cwd));
    this.guard.resolveWorkingDirectory(cwd);
    const getTask = (value: unknown): Task => {
      const task = typeof value === 'string' ? tasks.get(value) : undefined;
      if (!task) throw new Error('Task does not belong to this parent request');
      return task;
    };
    const view = (task: Task) => ({ taskId: task.record.id, backend: task.record.backend,
      state: task.record.finishedAt ? task.record.state : 'running',
      output: task.record.finishedAt ? task.record.output : undefined,
      error: task.record.finishedAt ? task.record.error : undefined,
      truncated: task.record.truncated ?? false });
    const save = (task: Task) => this.store.write(task.record).catch(error => {
      console.warn('[Delegation] Could not persist task state:', error instanceof Error ? error.message : 'Storage failure');
    });
    const notify = (send: () => void) => {
      try { send(); } catch { console.warn('[Delegation] Progress could not be delivered'); }
    };
    const stop = (task: Task): Promise<void> => task.stop ??= (async () => {
      if (!task.executor) return;
      try {
        try { await deadline(() => task.executor!.abort(), Math.min(2000, this.cleanupMs)); } catch { /* Force cleanup still runs. */ }
        await deadline(async () => { await task.executor!.destroy(); await task.executor!.waitForExit?.(); }, this.cleanupMs);
      } finally { task.interrupt(); }
    })();
    const cancel = async (task: Task): Promise<unknown> => {
      if (task.record.state === 'running') {
        task.record.state = 'cancelled';
        task.record.error = 'Cancelled; edits already made were not undone.';
        await stop(task).catch(() => undefined);
      }
      await task.done;
      return view(task);
    };
    const run = async (task: Task, configuration: ExecutorConfig, objective: string): Promise<void> => {
      const backend = task.record.backend as DelegationBackend;
      let bytes = 0;
      try {
        if (task.record.state !== 'running') return;
        const childId = `delegate-${task.record.id}`;
        task.executor = this.factory(this.guard, configuration, cwd, childId,
          parent.thread.models?.[backend], parent.thread.efforts?.[backend], { lifecycleHooks: false, delegationWorker: true });
        if (fs.realpathSync(task.executor.getCurrentWorkingDirectory()) !== cwd) {
          throw new Error('Worker refused the delegated workspace; refusing a fallback directory');
        }
        // Native session IDs are distinct; policy was resolved against the real
        // parent thread before passing the synthetic child identity to the factory.
        task.timer = setTimeout(() => {
          if (task.record.state !== 'running') return;
          task.record.state = 'timed_out'; task.record.error = 'Delegated task timed out';
          void stop(task).catch(() => undefined);
        }, this.timeoutMs);
        const count = (text: string) => {
          bytes += Buffer.byteLength(text);
          if (bytes > DELEGATION_LIMITS.streamBytes && task.record.state === 'running') {
            task.record.state = 'failed'; task.record.error = 'Delegated output exceeded the capture limit';
            void stop(task).catch(() => undefined);
          }
        };
        const result = await Promise.race([task.interrupted, task.executor.execute(
          `You are executing one delegated task in an independent session. Complete only this objective and return a concise result with verification and remaining issues. Do not delegate to other agents.\n\n${objective}`,
          {
            timeout: this.timeoutMs,
            onStream: text => {
              count(text);
              queueMicrotask(() => {
                if (!closed && task.record.state === 'running' && task.executor?.isWaitingInput?.()) {
                  notify(() => parent.onNotice(`\n[${backend} delegated task]\n${bounded(text, 4000).text}`));
                }
              });
            },
            onToolResult: result => count(result.content),
            onApprovalRequest: request => !closed && task.record.state === 'running' && parent.onApproval({ ...request,
              description: `[${backend} delegated task] ${request.description}`, canRemember: false }, task.executor!),
            onApprovalResolved: parent.onApprovalResolved,
          })]);
        if (task.record.state === 'running') {
          const output = bounded(result.output ?? '', DELEGATION_LIMITS.resultBytes);
          task.record.state = result.success ? 'succeeded' : 'failed';
          task.record.output = output.text; task.record.truncated = output.truncated;
          if (result.error) task.record.error = bounded(result.error, 4000).text;
        }
      } catch (error) {
        if (task.record.state === 'running') {
          task.record.state = 'failed';
          task.record.error = bounded(error instanceof Error ? error.message : 'Worker failed', 4000).text;
        }
        this.registry.invalidate();
      } finally {
        clearTimeout(task.timer);
        let cleaned = false;
        try {
          if (task.stop) await task.stop;
          else if (task.executor) await deadline(async () => { await task.executor!.destroy(); await task.executor!.waitForExit?.(); }, this.cleanupMs);
          cleaned = true;
        } catch (error) {
          task.record.state = 'interrupted';
          task.record.error = 'Worker cleanup could not be confirmed. This workspace is blocked until the worker is stopped and the CLI restarts.';
          console.warn('[Delegation] Worker cleanup failed:', error instanceof Error ? error.message : 'Cleanup failure');
        }
        if (cleaned) {
          await task.executor?.deleteThreadData?.(`delegate-${task.record.id}`).catch(() => undefined);
          this.running--; this.workspaces.delete(cwd);
        } else this.workspaces.set(cwd, `quarantined:${parent.thread.id}`);
        task.record.finishedAt = Date.now();
        await save(task);
        await this.store.prune().catch(() => undefined);
        notify(() => parent.onToolResult({ tool_use_id: task.record.id, content: JSON.stringify(view(task)), is_error: task.record.state !== 'succeeded' }));
        notify(() => parent.onNotice(`\nDelegated ${backend} task ${task.record.state}.\n`));
        task.settle();
      }
    };
    const invoke: DelegationHandler = async (name, args, callId) => {
      if (closed) throw new Error('Delegation turn has ended');
      if (!callId || callId.length > 200) throw new Error('Invalid tool call ID');
      const signature = JSON.stringify({ name, args });
      const existing = calls.get(callId);
      if (existing) {
        if (existing.signature !== signature) throw new Error('Tool call ID was reused with different arguments');
        return existing.result;
      }
      if (calls.size >= DELEGATION_LIMITS.calls) throw new Error('Delegation tool-call limit reached');
      const result = (async (): Promise<unknown> => {
        if (name === 'remote_cli_list_backends') {
          const backends = await this.registry.list(parent.config);
          return { backends: backends.map(item => {
            try { workerConfiguration(parent.config, this.guard, parent.thread.id, parent.backend, item.backend, 'inherit'); return item; }
            catch (error) { return { ...item, worker: false, reason: (error as Error).message }; }
          }), workspace: cwd, maxConcurrentChildren: 1 };
        }
        if (name === 'remote_cli_result') {
          const task = getTask(args.taskId);
          const seconds = args.waitSeconds ?? 25;
          if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 || seconds > 25) throw new Error('waitSeconds must be between 0 and 25');
          if (!task.record.finishedAt && seconds > 0) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try { await Promise.race([task.done, new Promise<void>(resolve => { timer = setTimeout(resolve, seconds * 1000); })]); }
            finally { clearTimeout(timer); }
          }
          return view(task);
        }
        if (name === 'remote_cli_cancel') return cancel(getTask(args.taskId));
        if (name !== 'remote_cli_delegate') throw new Error('Unknown delegation tool');
        if (starting || [...tasks.values()].some(task => !task.record.finishedAt)) throw new Error('Wait for the current delegated task before starting another');
        if (launches >= DELEGATION_LIMITS.launches) throw new Error('Delegated task limit reached');
        if (!DELEGATION_BACKENDS.includes(args.backend as DelegationBackend)) throw new Error('Unsupported worker backend');
        if (typeof args.objective !== 'string' || !args.objective.trim() || args.objective.length > 24_000) throw new Error('objective must contain 1 to 24000 characters');
        const objective = args.objective;
        const mode = args.mode ?? 'inherit';
        if (mode !== 'inherit' && mode !== 'read_only') throw new Error('Unsupported execution mode');
        const backend = args.backend as DelegationBackend;
        starting = true;
        try {
          const configuration = workerConfiguration(parent.config, this.guard, parent.thread.id, parent.backend, backend, mode);
          const available = await this.registry.get(backend, parent.config);
          if (!available.installed) throw new Error(`${backend}: ${available.reason}`);
          await this.store.initialize();
          if (closed) throw new Error('Delegation turn has ended');
          if (this.running >= DELEGATION_LIMITS.concurrent
            || [...this.workspaces.keys()].some(active => workspacesOverlap(active, cwd))
            || parent.isWorkspaceBusy?.(cwd)) throw new Error('Delegation capacity or workspace is busy; wait before retrying');
          launches++; this.running++; this.workspaces.set(cwd, parent.thread.id);
          let settle!: () => void;
          let interrupt!: () => void;
          const interrupted = new Promise<ExecuteResult>(resolve => { interrupt = () => resolve({ success: false }); });
          const task: Task = { record: { id: randomUUID(), threadId: parent.thread.id,
            parentMessageId: parent.messageId, backend, objective: objective.slice(0, 1000),
            state: 'running', startedAt: Date.now() }, done: new Promise<void>(resolve => { settle = resolve; }), settle, interrupted, interrupt };
          tasks.set(task.record.id, task);
          await save(task);
          if (closed) { task.record.state = 'cancelled'; }
          notify(() => parent.onToolUse({ id: task.record.id, name: 'Task', input: {
              description: `${backend}: ${objective.slice(0, 120)}`, prompt: objective.slice(0, 1000), subagent_type: backend,
          } }));
          void run(task, configuration, objective).catch(() => undefined);
          return view(task);
        } finally { starting = false; }
      })();
      calls.set(callId, { signature, result });
      return result;
    };
    const scope: DelegationScope = {
      invoke,
      isClosed: () => closed,
      waitingExecutor: () => [...tasks.values()].find(task => task.executor?.isWaitingInput?.())?.executor,
      close: async () => {
        closed = true;
        await Promise.allSettled([...tasks.values()].map(cancel));
        // A version probe may still be pending. Its closed check prevents launch.
        if (this.scopes.get(parent.thread.id) === scope) this.scopes.delete(parent.thread.id);
      },
    };
    this.scopes.set(parent.thread.id, scope);
    return scope;
  }

  waitingExecutor(threadId: string): IExecutor | undefined { return this.scopes.get(threadId)?.waitingExecutor(); }
  blocksWorkspace(cwd: string, threadId: string): boolean {
    if (this.workspaces.size === 0) return false;
    const canonical = fs.realpathSync(cwd);
    return [...this.workspaces].some(([active, owner]) => owner !== threadId && workspacesOverlap(active, canonical));
  }
  async cancelThread(threadId: string): Promise<void> { await this.scopes.get(threadId)?.close(); }
  async destroy(): Promise<void> { await Promise.allSettled([...this.scopes.values()].map(scope => scope.close())); }
}
