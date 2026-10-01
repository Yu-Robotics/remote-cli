import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { DirectoryGuard } from '../security/DirectoryGuard';
import type { BackendKey, ExecutorConfig } from '../types/config';
import type { Thread } from '../thread/types';
import { resolveThreadModel } from '../thread/ThreadExecutorPool';
import type { IExecutor, ExecuteResult } from '../executor/IExecutor';
import type { ApprovalRequestInfo, ApprovalStatus, DelegationProgressInfo, ToolUseInfo, ToolResultInfo } from '../types';
import { createExecutor } from '../executor';
import { BackendRegistry } from './BackendRegistry';
import { DelegationStore, type DelegatedTaskRecord } from './DelegationStore';
import {
  DelegatedWorkerSessionStore,
  type DelegatedWorkerLane,
  type DelegatedWorkerLaneIdentity,
} from './DelegatedWorkerSessionStore';
import { cleanupDelegatedWorkerLane } from './DelegatedWorkerLaneCleanup';
import { DELEGATION_BACKENDS, type DelegationBackend, type DelegationHandler } from './contract';
import { workerConfiguration } from './WorkerPolicy';
import { formatDelegationNotice } from './DelegationNotice';
import { assertWorkingDirectoryExists } from '../utils/WorkingDirectory';

export const DELEGATION_LIMITS = { launches: 12, concurrent: 3,
  idleTimeoutMs: 15 * 60_000, toolIdleTimeoutMs: 45 * 60_000,
  resultBytes: 32 * 1024, continuationBytes: 64 * 1024,
  storageTimeoutMs: 10_000, calls: 500 } as const;

export interface DelegationTimeoutPolicy {
  idleTimeoutMs: number;
  toolIdleTimeoutMs: number;
}

type TimeoutPolicyInput = DelegationTimeoutPolicy | number;
type DelegationActivityKind = 'tool_use' | 'tool_result';

function validDuration(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function timeoutPolicy(input: TimeoutPolicyInput): DelegationTimeoutPolicy {
  if (typeof input === 'number') {
    const duration = validDuration(input, DELEGATION_LIMITS.idleTimeoutMs);
    return { idleTimeoutMs: duration, toolIdleTimeoutMs: duration };
  }
  return {
    idleTimeoutMs: validDuration(input.idleTimeoutMs, DELEGATION_LIMITS.idleTimeoutMs),
    toolIdleTimeoutMs: validDuration(input.toolIdleTimeoutMs, DELEGATION_LIMITS.toolIdleTimeoutMs),
  };
}

function formatDuration(milliseconds: number): string {
  if (milliseconds % 3_600_000 === 0) return `${milliseconds / 3_600_000} hour${milliseconds === 3_600_000 ? '' : 's'}`;
  if (milliseconds % 60_000 === 0) return `${milliseconds / 60_000} minute${milliseconds === 60_000 ? '' : 's'}`;
  const seconds = Math.ceil(milliseconds / 1000);
  return `${seconds} second${seconds === 1 ? '' : 's'}`;
}

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
  /** Returns true when the client accepted a nested worker-progress update for delivery. */
  onProgress?: (progress: DelegationProgressInfo) => boolean;
  onApproval: (request: ApprovalRequestInfo, executor: IExecutor) => boolean;
  onApprovalResolved: (id: string, status: ApprovalStatus) => void;
  isWorkspaceBusy?: (canonicalPath: string) => boolean;
}

interface Task {
  record: DelegatedTaskRecord;
  resultDelivered: boolean;
  executor?: IExecutor;
  lane?: DelegatedWorkerLane;
  /** The lane was reserved but no completed turn made its native context reusable. */
  discardLane?: boolean;
  /** A worker may have escaped lifecycle tracking; retain its workspace lease. */
  quarantineWorkspace?: boolean;
  done: Promise<void>;
  settle: () => void;
  stop?: Promise<void>;
  idleTimer?: ReturnType<typeof setTimeout>;
  activeToolIds: Set<string>;
  waitingInputText?: string;
  interrupted: Promise<ExecuteResult>;
  interrupt: () => void;
}

export interface DelegatedTaskResult {
  taskId: string;
  backend: string;
  state: DelegatedTaskRecord['state'];
  output?: string;
  error?: string;
  truncated: boolean;
}

export interface DelegationScope {
  invoke: DelegationHandler;
  isClosed(): boolean;
  hasTasks(): boolean;
  getLaunchRevision(): number;
  beginExecution(taskIds?: readonly string[]): void;
  finishExecution(success: boolean): void;
  hasPendingResults(): boolean;
  getRetainedResults(): DelegatedTaskResult[];
  collectPendingResults(): Promise<DelegatedTaskResult[]>;
  close(): Promise<void>;
  waitingExecutor(): IExecutor | undefined;
}

function bounded(text: string, limit: number, preserveEnd = false): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text);
  if (buffer.length <= limit) return { text, truncated: false };
  const marker = preserveEnd ? '\n[Output truncated]\n' : '\n[Output truncated]';
  const available = limit - Buffer.byteLength(marker);
  if (available <= 0) return { text: marker.slice(0, limit), truncated: true };
  // Worker output can contain progress before its conclusion. Keep both ends.
  let end = preserveEnd ? Math.floor(available / 2) : available;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  let start = preserveEnd ? buffer.length - (available - end) : buffer.length;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
  return { text: buffer.subarray(0, end).toString('utf8') + marker + buffer.subarray(start).toString('utf8'), truncated: true };
}

function boundedResults(terminal: DelegatedTaskResult[]): DelegatedTaskResult[] {
  let results = terminal;
  // Keep every task's identity and terminal status, reducing only text.
  for (let limit = DELEGATION_LIMITS.resultBytes / 2;
    Buffer.byteLength(JSON.stringify(results)) > DELEGATION_LIMITS.continuationBytes; limit = Math.floor(limit / 2)) {
    results = terminal.map(result => {
      const output = bounded(result.output ?? '', limit, true);
      const error = bounded(result.error ?? '', limit);
      return { ...result, output: output.text, error: error.text || undefined,
        truncated: result.truncated || output.truncated || error.truncated };
    });
  }
  return results;
}

async function deadline<T>(operation: () => T | Promise<T>, milliseconds: number, message = 'Worker cleanup timed out'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

/** Owns children independently of the user-thread queue and primary executor pool. */
export class DelegationManager {
  readonly registry: BackendRegistry;
  readonly store: DelegationStore;
  readonly laneStore: DelegatedWorkerSessionStore;
  private running = 0;
  private workspaces = new Map<string, string>();
  private scopes = new Map<string, DelegationScope>();
  private readonly timeouts: DelegationTimeoutPolicy;

  constructor(private readonly guard: DirectoryGuard,
    private readonly factory: typeof createExecutor = createExecutor,
    registry = new BackendRegistry(), store = new DelegationStore(),
    timeoutInput: TimeoutPolicyInput = DELEGATION_LIMITS,
    private readonly cleanupMs = 10_000,
    laneStore = new DelegatedWorkerSessionStore(),
  ) {
    this.registry = registry;
    this.store = store;
    this.laneStore = laneStore;
    this.timeouts = timeoutPolicy(timeoutInput);
  }

  begin(parent: DelegationParent): DelegationScope {
    if (this.scopes.has(parent.thread.id)) throw new Error('This thread already owns a delegation turn');
    // Fail with recovery guidance before realpathSync reports a raw ENOENT.
    // This must stay above scopes.set: a throw after registration would leave
    // a scope behind and reject every later delegation turn on this thread.
    assertWorkingDirectoryExists(parent.cwd);
    const tasks = new Map<string, Task>();
    const calls = new Map<string, { signature: string; result: Promise<unknown> }>();
    let closed = false;
    let launches = 0;
    let launchRevision = 0;
    let starting = false;
    let execution = 0;
    let acceptingResults = true;
    const stagedResults = new Set<string>();
    const cwd = fs.realpathSync(this.guard.resolveWorkingDirectory(parent.cwd));
    this.guard.resolveWorkingDirectory(cwd);
    const getTask = (value: unknown): Task => {
      const task = typeof value === 'string' ? tasks.get(value) : undefined;
      if (!task) throw new Error('Task does not belong to this parent request');
      return task;
    };
    const view = (task: Task): DelegatedTaskResult => ({ taskId: task.record.id, backend: task.record.backend,
      state: task.record.finishedAt ? task.record.state : 'running',
      output: task.record.finishedAt ? task.record.output : undefined,
      error: task.record.finishedAt ? task.record.error : undefined,
      truncated: task.record.truncated ?? false });
    const receive = (task: Task, requestedDuring: number): DelegatedTaskResult => {
      if (task.record.finishedAt && acceptingResults && requestedDuring === execution) stagedResults.add(task.record.id);
      return view(task);
    };
    const save = (task: Task) => this.store.write(task.record).catch(error => {
      console.warn('[Delegation] Could not persist task state:', error instanceof Error ? error.message : 'Storage failure');
    });
    const notify = (send: () => void) => {
      try { send(); } catch { console.warn('[Delegation] Progress could not be delivered'); }
    };
    const reportProgress = (
      task: Task,
      progress: Omit<DelegationProgressInfo, 'taskId' | 'backend'>,
    ): boolean => {
      try {
        return parent.onProgress?.({ taskId: task.record.id, backend: task.record.backend, ...progress }) === true;
      } catch {
        console.warn('[Delegation] Progress could not be delivered');
        return false;
      }
    };
    const reportTerminalProgress = (task: Task): boolean => {
      if (task.record.state === 'running') return false;
      return reportProgress(task, {
        phase: task.record.state,
        summary: task.record.output ? bounded(task.record.output, 1000, true).text : undefined,
        error: task.record.error ? bounded(task.record.error, 1000).text : undefined,
        startedAt: task.record.startedAt,
      });
    };
    const destroyWorker = async (worker: IExecutor): Promise<void> => {
      await worker.destroy();
      if (!worker.waitForExit) {
        throw new Error('Worker backend cannot confirm process exit');
      }
      await worker.waitForExit();
    };
    const discardLane = async (lane: DelegatedWorkerLane): Promise<boolean> => {
      try {
        await cleanupDelegatedWorkerLane(lane);
        await this.laneStore.remove(lane.id);
        return true;
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'Local worker lane cleanup failed';
        await this.laneStore.markCleanupFailure(lane.id, detail).catch(() => undefined);
        console.warn('[Delegation] Worker lane cleanup failed:', detail);
        return false;
      }
    };
    const stop = (task: Task): Promise<void> => task.stop ??= (async () => {
      if (!task.executor) {
        // A cancellation can race with durable lane acquisition. No worker
        // process owns this lane yet, so it must not become a reusable empty
        // session after the task finishes.
        task.discardLane = true;
        task.interrupt();
        return;
      }
      try {
        try { await deadline(() => task.executor!.abort(), Math.min(2000, this.cleanupMs)); } catch { /* Force cleanup still runs. */ }
        await deadline(() => destroyWorker(task.executor!), this.cleanupMs);
      } finally { task.interrupt(); }
    })();
    const clearTaskTimer = (task: Task): void => {
      clearTimeout(task.idleTimer);
      task.idleTimer = undefined;
    };
    const expire = (task: Task, duration: number): void => {
      if (task.record.state !== 'running') return;
      clearTaskTimer(task);
      task.record.state = 'timed_out';
      task.record.error = `Delegated task stopped after ${formatDuration(duration)} without tool activity`;
      void stop(task).catch(() => undefined);
    };
    const armIdleTimer = (task: Task): void => {
      clearTimeout(task.idleTimer);
      if (task.record.state !== 'running') return;
      const duration = task.activeToolIds.size > 0
        ? this.timeouts.toolIdleTimeoutMs : this.timeouts.idleTimeoutMs;
      const timer = setTimeout(() => {
        if (task.idleTimer !== timer) return;
        expire(task, duration);
      }, duration);
      task.idleTimer = timer;
    };
    const noteToolActivity = (task: Task, kind: DelegationActivityKind): void => {
      if (task.record.state !== 'running') return;
      task.record.lastActivityAt = Date.now();
      task.record.lastActivityKind = kind;
      armIdleTimer(task);
    };
    const cancel = async (task: Task): Promise<unknown> => {
      if (task.record.state === 'running') {
        clearTaskTimer(task);
        task.record.state = 'cancelled';
        task.record.error = 'Cancelled; edits already made were not undone.';
        await stop(task).catch(() => undefined);
      }
      await task.done;
      return view(task);
    };
    const run = async (task: Task, configuration: ExecutorConfig, objective: string): Promise<void> => {
      const backend = task.record.backend as DelegationBackend;
      const identity: DelegatedWorkerLaneIdentity = {
        threadId: parent.thread.id,
        backend,
        workingDirectory: cwd,
        workspaceGeneration: parent.thread.delegationWorkspaceGeneration ?? 0,
      };
      const createWorker = async (): Promise<IExecutor> => {
        if (!task.lane) {
          const acquired = await this.laneStore.acquire(identity);
          task.lane = acquired.lane;
        }
        let worker: IExecutor | undefined;
        try {
          worker = this.factory(this.guard, configuration, cwd, task.lane.executorThreadId,
            resolveThreadModel(parent.thread, configuration), parent.thread.efforts?.[backend],
            { lifecycleHooks: false, delegationWorker: true });
          task.executor = worker;
          if (fs.realpathSync(worker.getCurrentWorkingDirectory()) !== cwd) {
            throw new Error('Worker refused the delegated workspace; refusing a fallback directory');
          }
          await this.laneStore.markRunning(task.lane.id);
          return worker;
        } catch (error) {
          // The factory either supplied an executor that final cleanup can stop,
          // or failed before any worker process became manager-owned. Neither
          // case warrants a workspace quarantine by itself. Do not reuse a lane
          // whose setup did not reach a completed delegated turn.
          task.discardLane = true;
          if (!worker) task.executor = undefined;
          throw error;
        }
      };
      const discardMissingSessionLane = async (): Promise<boolean> => {
        const lane = task.lane;
        const worker = task.executor;
        if (!lane || !worker) return false;
        try {
          await deadline(() => destroyWorker(worker), this.cleanupMs);
        } catch (error) {
          task.quarantineWorkspace = true;
          const detail = error instanceof Error ? error.message : 'Worker exit could not be confirmed';
          await this.laneStore.markDirty(lane.id, detail).catch(() => undefined);
          return false;
        }
        task.executor = undefined;
        await this.laneStore.markDirty(lane.id,
          'Native worker session was unavailable before the objective was dispatched.', true);
        const discarded = await discardLane(lane);
        task.lane = undefined;
        return discarded;
      };
      try {
        if (task.record.state !== 'running') return;
        let result: ExecuteResult | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
          const worker = await createWorker();
          // Native session IDs are distinct; policy was resolved against the real
          // parent thread before passing the synthetic worker identity to the factory.
          const execution = worker.execute(
            `You are executing one delegated task in an isolated worker session. This session may contain context from earlier delegated tasks in this thread and workspace. Complete only this objective and return a concise result with verification and remaining issues. Do not delegate to other agents.

${objective}`,
            {
              // The manager owns delegated-task liveness. Zero disables optional
              // backend-local limits that would otherwise ignore tool callbacks.
              timeout: 0,
              inactivityTimeout: 0,
              onStream: text => {
                // Text streaming is intentionally not liveness activity; it can be
                // frequent without a tool making measurable progress.
                // Intermediate output is not retained here; only relay input prompts.
                queueMicrotask(() => {
                  if (!closed && task.record.state === 'running' && task.executor?.isWaitingInput?.()) {
                    const prompt = bounded(text, 4000).text;
                    if (task.waitingInputText === prompt) return;
                    task.waitingInputText = prompt;
                    if (!reportProgress(task, { phase: 'waiting_input', summary: prompt, startedAt: task.record.startedAt })) {
                      notify(() => parent.onNotice(`
[${backend} delegated task]
${prompt}`));
                    }
                  }
                });
              },
              onToolUse: tool => {
                if (task.record.state !== 'running') return;
                task.waitingInputText = undefined;
                if (tool.id) task.activeToolIds.add(tool.id);
                noteToolActivity(task, 'tool_use');
                reportProgress(task, { phase: 'tool_use', toolUse: tool, startedAt: task.record.startedAt });
              },
              onToolResult: toolResult => {
                if (task.record.state !== 'running') return;
                task.waitingInputText = undefined;
                if (toolResult.tool_use_id) task.activeToolIds.delete(toolResult.tool_use_id);
                noteToolActivity(task, 'tool_result');
                reportProgress(task, { phase: 'tool_result', toolResult, startedAt: task.record.startedAt });
              },
              onApprovalRequest: request => !closed && task.record.state === 'running' && parent.onApproval({ ...request,
                description: `[${backend} delegated task] ${request.description}`, canRemember: false }, task.executor!),
              onApprovalResolved: parent.onApprovalResolved,
            });
          // Start the inactivity window only once the worker has accepted the
          // objective and can emit its first real progress callback.
          armIdleTimer(task);
          result = await Promise.race([task.interrupted, execution]);
          if (!result.success && attempt === 0 && worker.consumeSessionResumeFailure?.()) {
            clearTaskTimer(task);
            if (await discardMissingSessionLane()) continue;
            throw new Error('The worker session was unavailable and its process could not be safely reset.');
          }
          break;
        }
        if (task.record.state === 'running' && result) {
          const output = bounded(result.output ?? '', DELEGATION_LIMITS.resultBytes, true);
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
        clearTaskTimer(task);
        let released = !task.quarantineWorkspace;
        try {
          if (task.stop) await task.stop;
          else if (task.executor) await deadline(() => destroyWorker(task.executor!), this.cleanupMs);
          else if (task.lane) {
            // A scope can close after durable acquisition but before construction.
            // No backend process was started, so discard the lane rather than
            // reserving the workspace indefinitely.
            task.discardLane = true;
          }
          if (released && task.lane && task.discardLane) {
            const lane = task.lane;
            await this.laneStore.markDirty(lane.id,
              'Delegated worker setup ended before a reusable context was established.', true).catch(() => undefined);
            await discardLane(lane);
            task.lane = undefined;
          }
          if (released && task.lane) {
            try {
              await this.laneStore.markReady(task.lane.id);
            } catch (error) {
              const detail = error instanceof Error ? error.message : 'Worker lane persistence failed';
              await this.laneStore.markDirty(task.lane.id, detail, true).catch(() => undefined);
              await discardLane(task.lane);
              console.warn('[Delegation] Worker lane could not be retained:', detail);
            }
          }
        } catch (error) {
          released = false;
          task.quarantineWorkspace = true;
          if (task.lane) {
            const detail = error instanceof Error ? error.message : 'Worker cleanup could not be confirmed';
            await this.laneStore.markDirty(task.lane.id, detail).catch(() => undefined);
          }
          task.record.state = 'interrupted';
          task.record.error = 'Worker cleanup could not be confirmed. This workspace is blocked until the worker is stopped and the CLI restarts.';
          console.warn('[Delegation] Worker cleanup failed:', error instanceof Error ? error.message : 'Cleanup failure');
        }
        if (released) {
          this.running--; this.workspaces.delete(cwd);
        } else this.workspaces.set(cwd, `quarantined:${parent.thread.id}`);
        task.record.finishedAt = Date.now();
        await deadline(async () => { await save(task); await this.store.prune(); }, this.cleanupMs)
          .catch(() => console.warn('[Delegation] Final task metadata could not be saved or pruned'));
        if (!reportTerminalProgress(task)) {
          notify(() => parent.onToolResult({ tool_use_id: task.record.id, content: JSON.stringify(view(task)), is_error: task.record.state !== 'succeeded' }));
          notify(() => parent.onNotice(formatDelegationNotice(task.record)));
        }
        task.settle();
      }
    };
    const invoke: DelegationHandler = async (name, args, callId) => {
      if (closed) throw new Error('Delegation turn has ended');
      const requestedDuring = execution;
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
            const configure = (mode: 'inherit' | 'read_only') =>
              workerConfiguration(parent.config, this.guard, parent.thread.id, parent.backend, item.backend, mode);
            try { configure('inherit'); }
            catch (error) { return { ...item, worker: false, readOnly: false, reason: (error as Error).message }; }
            let readOnly = item.readOnly;
            if (readOnly) {
              try { configure('read_only'); }
              catch { readOnly = false; }
            }
            return { ...item, readOnly };
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
          return receive(task, requestedDuring);
        }
        if (name === 'remote_cli_cancel') {
          const task = getTask(args.taskId);
          await cancel(task);
          return receive(task, requestedDuring);
        }
        if (name !== 'remote_cli_delegate') throw new Error('Unknown delegation tool');
        if (!acceptingResults) throw new Error('The coordinator execution has ended');
        if (starting || [...tasks.values()].some(task => !task.record.finishedAt)) throw new Error('Wait for the current delegated task before starting another');
        if (launches >= DELEGATION_LIMITS.launches) throw new Error('Delegated task limit reached');
        if (!DELEGATION_BACKENDS.includes(args.backend as DelegationBackend)) throw new Error('Unsupported worker backend');
        if (typeof args.objective !== 'string' || !args.objective.trim() || args.objective.length > 24_000) throw new Error('objective must contain 1 to 24000 characters');
        const objective = args.objective;
        const mode = args.mode ?? 'inherit';
        if (mode !== 'inherit' && mode !== 'read_only') throw new Error('Unsupported execution mode');
        const backend = args.backend as DelegationBackend;
        const configuration = workerConfiguration(parent.config, this.guard, parent.thread.id, parent.backend, backend, mode);
        launchRevision++;
        starting = true;
        try {
          const available = await this.registry.get(backend, parent.config);
          if (!available.installed) throw new Error(`${backend}: ${available.reason}`);
          await deadline(() => this.store.initialize(), DELEGATION_LIMITS.storageTimeoutMs, 'Task record initialization timed out');
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
            state: 'running', startedAt: Date.now() }, resultDelivered: false,
            activeToolIds: new Set(), done: new Promise<void>(resolve => { settle = resolve; }), settle, interrupted, interrupt };
          tasks.set(task.record.id, task);
          try {
            await deadline(() => this.store.write(task.record), DELEGATION_LIMITS.storageTimeoutMs, 'Initial task record write timed out');
          } catch (error) {
            tasks.delete(task.record.id);
            this.running--;
            this.workspaces.delete(cwd);
            launches--;
            task.settle();
            throw error;
          }
          try {
            const lane = await this.laneStore.acquire({
              threadId: parent.thread.id,
              backend,
              workingDirectory: cwd,
              workspaceGeneration: parent.thread.delegationWorkspaceGeneration ?? 0,
            });
            task.lane = lane.lane;
          } catch (error) {
            task.record.state = 'failed';
            task.record.error = bounded(error instanceof Error ? error.message : 'Worker lane storage failed', 4000).text;
            task.record.finishedAt = Date.now();
            await this.store.write(task.record).catch(() => undefined);
            tasks.delete(task.record.id);
            this.running--;
            this.workspaces.delete(cwd);
            launches--;
            task.settle();
            throw error;
          }
          if (closed) { task.record.state = 'cancelled'; }
          if (!reportProgress(task, { phase: 'started', objective: task.record.objective, startedAt: task.record.startedAt })) {
            notify(() => parent.onToolUse({ id: task.record.id, name: 'Task', input: {
                description: `${backend}: ${objective.slice(0, 120)}`, prompt: objective.slice(0, 1000), subagent_type: backend,
            } }));
          }
          void run(task, configuration, objective).catch(() => undefined);
          return receive(task, requestedDuring);
        } finally { starting = false; }
      })();
      calls.set(callId, { signature, result });
      return result;
    };
    const scope: DelegationScope = {
      invoke,
      isClosed: () => closed,
      hasTasks: () => starting || tasks.size > 0,
      getLaunchRevision: () => launchRevision,
      beginExecution: (taskIds = []) => {
        if (closed) throw new Error('Delegation was cancelled');
        execution++;
        acceptingResults = true;
        stagedResults.clear();
        for (const id of taskIds) {
          if (tasks.get(id)?.record.finishedAt) stagedResults.add(id);
        }
      },
      finishExecution: success => {
        acceptingResults = false;
        if (success && !closed) {
          for (const id of stagedResults) tasks.get(id)!.resultDelivered = true;
        }
        stagedResults.clear();
      },
      hasPendingResults: () => starting || [...tasks.values()].some(task => !task.resultDelivered && !stagedResults.has(task.record.id)),
      getRetainedResults: () => boundedResults([...tasks.values()]
        .filter(task => task.record.finishedAt && !task.resultDelivered).map(view)),
      collectPendingResults: async () => {
        if (closed) throw new Error('Delegation was cancelled');
        // The caller disables the bridge first, so no new calls can escape this
        // snapshot. Include launches still waiting for discovery or persistence.
        await Promise.allSettled([...calls.values()].map(call => call.result));
        if (closed) throw new Error('Delegation was cancelled');
        const pending = [...tasks.values()].filter(task => !task.resultDelivered);
        await Promise.all(pending.map(task => task.done));
        if (closed) throw new Error('Delegation was cancelled');
        return boundedResults(pending.map(view));
      },
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
  hasActiveTasks(threadId: string): boolean { return this.scopes.get(threadId)?.hasTasks() ?? false; }

  /** Remove lanes from an old workspace generation after a successful `/cd`. */
  async invalidateWorkspaceGeneration(threadId: string, generation: number): Promise<number> {
    if (this.hasActiveTasks(threadId)) {
      throw new Error('Cannot change working directory while a delegated worker is running. Wait for it to finish or send /abort first.');
    }
    return this.removeWorkerLanes(await this.laneStore.invalidateGeneration(threadId, generation));
  }

  /** Forget one backend lane or all lanes for an idle parent thread. */
  async resetWorkerLanes(threadId: string, backend?: DelegationBackend): Promise<number> {
    if (this.hasActiveTasks(threadId)) {
      throw new Error('Cannot reset delegated worker context while a delegated worker is running. Wait for it to finish or send /abort first.');
    }
    return this.removeWorkerLanes(await this.laneStore.markForReset(threadId, backend));
  }

  /** Thread deletion is executor-free so it works whether delegation is currently enabled or not. */
  async deleteWorkerLanes(threadId: string): Promise<number> {
    if (this.hasActiveTasks(threadId)) {
      throw new Error('Cannot delete delegated worker context while a delegated worker is running.');
    }
    return this.removeWorkerLanes(await this.laneStore.markForReset(threadId));
  }

  private async removeWorkerLanes(lanes: DelegatedWorkerLane[]): Promise<number> {
    let removed = 0;
    for (const lane of lanes) {
      try {
        await cleanupDelegatedWorkerLane(lane);
        await this.laneStore.remove(lane.id);
        removed++;
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'Local worker lane cleanup failed';
        await this.laneStore.markCleanupFailure(lane.id, detail).catch(() => undefined);
        console.warn('[Delegation] Worker lane cleanup failed:', detail);
      }
    }
    return removed;
  }

  blocksWorkspace(cwd: string, threadId: string): boolean {
    if (this.workspaces.size === 0) return false;
    const canonical = fs.realpathSync(cwd);
    return [...this.workspaces].some(([active, owner]) => owner !== threadId && workspacesOverlap(active, canonical));
  }
  async cancelThread(threadId: string): Promise<void> { await this.scopes.get(threadId)?.close(); }
  async destroy(): Promise<void> { await Promise.allSettled([...this.scopes.values()].map(scope => scope.close())); }
}
