import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { DirectoryGuard } from '../security/DirectoryGuard';
import type { BackendKey, ExecutorConfig } from '../types/config';
import type { Thread } from '../thread/types';
import { resolveThreadModel } from '../thread/ThreadExecutorPool';
import type { IExecutor, ExecuteResult } from '../executor/IExecutor';
import type { ApprovalRequestInfo, ApprovalStatus, DelegationProgressInfo, ExecutionMetadata, ToolUseInfo, ToolResultInfo } from '../types';
import { captureExecutionMetadata, mergeReportedExecutionMetadata } from '../executor/ExecutionMetadata';
import { createExecutor } from '../executor';
import { BackendRegistry } from './BackendRegistry';
import { DelegationStore, isTerminalTaskState, type DelegatedTaskRecord } from './DelegationStore';
import {
  DelegatedWorkerSessionStore,
  type DelegatedWorkerLane,
  type DelegatedWorkerLaneIdentity,
} from './DelegatedWorkerSessionStore';
import { cleanupDelegatedWorkerLane, clearDelegatedWorkerContext } from './DelegatedWorkerLaneCleanup';
import { DELEGATION_BACKENDS, type DelegationBackend, type DelegationHandler } from './contract';
import { workerConfiguration } from './WorkerPolicy';
import { formatDelegationNotice } from './DelegationNotice';
import { assertWorkingDirectoryExists } from '../utils/WorkingDirectory';
import { DelegatedWorkspaceManager, type DelegatedWorkspaceSource, type DelegatedWorkspace,
  type DelegatedArtifactView } from './DelegatedWorkspaceManager';
import type { GitCheckpoint } from './GitCheckpoint';

export const DELEGATION_LIMITS = { launches: 12, concurrent: 5, closeoutRounds: 2,
  idleTimeoutMs: 15 * 60_000, toolIdleTimeoutMs: 45 * 60_000,
  queueTimeoutMs: 60 * 60_000,
  resultBytes: 32 * 1024, continuationBytes: 64 * 1024,
  storageTimeoutMs: 10_000, calls: 500 } as const;

/** Bounds and cadence for optional display-only delegated-worker text. */
export const DELEGATION_TEXT_PROGRESS = {
  flushMs: 2_500,
  bufferBytes: 4 * 1024,
  latestTextBytes: 1_200,
} as const;

export interface DelegationTimeoutPolicy {
  idleTimeoutMs: number;
  toolIdleTimeoutMs: number;
  queueTimeoutMs?: number;
}

type TimeoutPolicyInput = DelegationTimeoutPolicy | number;
type DelegationActivityKind = 'tool_use' | 'tool_result';

function validDuration(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function timeoutPolicy(input: TimeoutPolicyInput): Required<DelegationTimeoutPolicy> {
  if (typeof input === 'number') {
    const duration = validDuration(input, DELEGATION_LIMITS.idleTimeoutMs);
    return { idleTimeoutMs: duration, toolIdleTimeoutMs: duration, queueTimeoutMs: DELEGATION_LIMITS.queueTimeoutMs };
  }
  return {
    idleTimeoutMs: validDuration(input.idleTimeoutMs, DELEGATION_LIMITS.idleTimeoutMs),
    toolIdleTimeoutMs: validDuration(input.toolIdleTimeoutMs, DELEGATION_LIMITS.toolIdleTimeoutMs),
    queueTimeoutMs: validDuration(input.queueTimeoutMs, DELEGATION_LIMITS.queueTimeoutMs),
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
  /** Optional negotiated channel for bounded display-only worker text. */
  onTextProgress?: (progress: DelegationProgressInfo) => boolean;
  onApproval: (request: ApprovalRequestInfo, executor: IExecutor) => boolean;
  onApprovalResolved: (id: string, status: ApprovalStatus) => void;
  isWorkspaceBusy?: (canonicalPath: string) => boolean;
}

interface Task {
  record: DelegatedTaskRecord;
  configuration: ExecutorConfig;
  objective: string;
  resultDelivered: boolean;
  settled: boolean;
  ownsSlot: boolean;
  executor?: IExecutor;
  /** Frozen per attempt and retained independently of worker process cleanup. */
  executionMetadata?: ExecutionMetadata;
  lane?: DelegatedWorkerLane;
  workspace?: DelegatedWorkspace;
  artifact?: DelegatedArtifactView;
  /** The lane was reserved but no completed turn made its native context reusable. */
  discardLane?: boolean;
  /** A pre-existing Git lane must retain native context if checkout preparation fails. */
  preserveUnstartedLane?: boolean;
  /** A worker may have escaped lifecycle tracking; retain its workspace lease. */
  quarantineWorkspace?: boolean;
  done: Promise<void>;
  settle: () => void;
  dispatched: Promise<void>;
  signalDispatch: () => void;
  finishUnstarted?: Promise<void>;
  stop?: Promise<void>;
  queueTimer?: ReturnType<typeof setTimeout>;
  idleTimer?: ReturnType<typeof setTimeout>;
  textTimer?: ReturnType<typeof setTimeout>;
  textBuffer?: string;
  lastReportedText?: string;
  textProgressEnabled?: boolean;
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
  artifact?: Pick<DelegatedArtifactView, 'taskId' | 'disposition' | 'outputCommit'>;
  executionMetadata?: ExecutionMetadata;
}

export interface DelegationCloseoutIssue {
  taskId: string;
  backend: string;
  status: 'pending' | 'recovery' | 'unavailable';
  outputCommit?: string;
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
  checkArtifactCloseout(): Promise<DelegationCloseoutIssue[]>;
  close(): Promise<void>;
  waitingExecutor(): IExecutor | undefined;
  waitingInputCount(): number;
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

/** Keep the most recent UTF-8-safe tail without retaining a worker transcript. */
function tailText(text: string, limit: number): string {
  const buffer = Buffer.from(text);
  if (buffer.length <= limit) return text;
  let start = Math.max(0, buffer.length - Math.max(0, limit - Buffer.byteLength('…')));
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
  return `…${buffer.subarray(start).toString('utf8')}`;
}

/** Include partial sentences so display snapshots keep up with assistant text deltas. */
function latestDisplayText(text: string): string | undefined {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '').trim();
  if (!normalized) return undefined;
  return tailText(normalized, DELEGATION_TEXT_PROGRESS.latestTextBytes);
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
  readonly workspaceManager: DelegatedWorkspaceManager;
  private running = 0;
  private workspaces = new Map<string, { id: string; threadId: string; quarantined: boolean }>();
  private pumps = new Set<() => void>();
  private scopes = new Map<string, DelegationScope>();
  private readonly timeouts: Required<DelegationTimeoutPolicy>;

  constructor(private readonly guard: DirectoryGuard,
    private readonly factory: typeof createExecutor = createExecutor,
    registry = new BackendRegistry(), store = new DelegationStore(),
    timeoutInput: TimeoutPolicyInput = DELEGATION_LIMITS,
    private readonly cleanupMs = 10_000,
    laneStore = new DelegatedWorkerSessionStore(),
    workspaceManager = new DelegatedWorkspaceManager(),
  ) {
    this.registry = registry;
    this.store = store;
    this.laneStore = laneStore;
    this.workspaceManager = workspaceManager;
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
    let admissions = 0;
    let admissionTail: Promise<unknown> = Promise.resolve();
    const activeTasks = new Set<Task>();
    let integrating = false;
    let integrationPending: Promise<unknown> | undefined;
    let source: DelegatedWorkspaceSource | undefined;
    let sourcePromise: Promise<void> | undefined;
    let baseline: Promise<GitCheckpoint> | undefined;
    let maxChildren = 1;
    const workspaceOwner = { id: randomUUID(), threadId: parent.thread.id, quarantined: false };
    const workspaceGeneration = parent.thread.delegationWorkspaceGeneration ?? 0;
    let execution = 0;
    let acceptingResults = true;
    const stagedResults = new Set<string>();
    const cwd = fs.realpathSync(this.guard.resolveWorkingDirectory(parent.cwd));
    let leasePath = cwd;
    this.guard.resolveWorkingDirectory(cwd);
    const discoverWorkspace = (): Promise<void> => sourcePromise ??= this.workspaceManager.discover(cwd).then(found => {
      if (found) {
        // A full repository checkpoint must not read outside the directory-selection policy.
        this.guard.resolveWorkingDirectory(found.root);
        source = found;
        leasePath = found.root;
        maxChildren = DELEGATION_LIMITS.concurrent;
      }
    });
    const getTask = (value: unknown): Task => {
      const task = typeof value === 'string' ? tasks.get(value) : undefined;
      if (!task) throw new Error('Task does not belong to this parent request');
      return task;
    };
    const view = (task: Task): DelegatedTaskResult => ({ taskId: task.record.id, backend: task.record.backend,
      state: task.record.finishedAt !== undefined ? task.record.state : task.record.startedAt === undefined ? 'queued' : 'running',
      output: task.record.finishedAt !== undefined ? task.record.output : undefined,
      error: task.record.finishedAt !== undefined ? task.record.error : undefined,
      truncated: task.record.truncated ?? false,
      ...(task.executionMetadata ? { executionMetadata: { ...task.executionMetadata } } : {}),
      ...(task.artifact ? { artifact: { taskId: task.artifact.taskId,
        disposition: task.artifact.disposition, outputCommit: task.artifact.outputCommit } } : {}) });
    const receive = (task: Task, requestedDuring: number): DelegatedTaskResult => {
      if (task.record.finishedAt !== undefined && acceptingResults && requestedDuring === execution) stagedResults.add(task.record.id);
      return view(task);
    };
    const save = (task: Task) => this.store.write(task.record).catch(error => {
      console.warn('[Delegation] Could not persist task state:', error instanceof Error ? error.message : 'Storage failure');
    });
    const notify = (send: () => void) => {
      try { send(); } catch { console.warn('[Delegation] Progress could not be delivered'); }
    };
    const releaseWorkspaceIfIdle = (): void => {
      if (integrating || admissions || activeTasks.size || [...tasks.values()].some(task => !task.settled)) return;
      // A new idle cohort must observe coordinator edits even if the last task was read-only.
      baseline = undefined;
      if (this.workspaces.get(leasePath) === workspaceOwner && !workspaceOwner.quarantined) this.workspaces.delete(leasePath);
    };
    const assertWorkspace = (): void => {
      assertWorkingDirectoryExists(parent.cwd);
      if (fs.realpathSync(this.guard.resolveWorkingDirectory(parent.cwd)) !== cwd
        || (parent.thread.delegationWorkspaceGeneration ?? 0) !== workspaceGeneration) {
        throw new Error('Delegated workspace changed before the task could start');
      }
      if (this.workspaces.get(leasePath) !== workspaceOwner || workspaceOwner.quarantined || parent.isWorkspaceBusy?.(leasePath)) {
        throw new Error('Delegation capacity or workspace is busy; task was not started');
      }
    };
    const reconcileHistory = async (reclaim: boolean, backend?: DelegationBackend,
      checkActive: () => void = assertWorkspace): Promise<void> => {
      if (!source) return;
      const lanes = await this.laneStore.lanesForThread(parent.thread.id, backend);
      const delivered = await this.workspaceManager.reconcileHistoricalDelivery({
        threadId: parent.thread.id, cwd, workspaceGeneration, checkActive,
      }, lanes, reclaim);
      for (const artifact of delivered) {
        const task = tasks.get(artifact.taskId);
        if (task) task.artifact = artifact;
      }
    };
    const captureWorkerMetadata = (task: Task): void => {
      if (!task.executor || task.record.startedAt === undefined) return;
      task.executionMetadata = mergeReportedExecutionMetadata(task.executionMetadata,
        captureExecutionMetadata(task.executor, task.record.backend));
    };
    const reportProgress = (
      task: Task,
      progress: Omit<DelegationProgressInfo, 'taskId' | 'backend'>,
    ): boolean => {
      try {
        if (task.record.state === 'running') captureWorkerMetadata(task);
        return parent.onProgress?.({ taskId: task.record.id, backend: task.record.backend, ...progress,
          ...(task.lane ? { workerContext: { laneId: task.lane.id, generation: task.lane.contextGeneration ?? 0 } } : {}),
          ...(task.executionMetadata ? { executionMetadata: { ...task.executionMetadata } } : {}) }) === true;
      } catch {
        console.warn('[Delegation] Progress could not be delivered');
        return false;
      }
    };
    const reportTextProgress = (task: Task, latestText: string): boolean => {
      try {
        captureWorkerMetadata(task);
        return parent.onTextProgress?.({
          taskId: task.record.id,
          backend: task.record.backend,
          phase: 'text',
          latestText,
          startedAt: task.record.startedAt,
          ...(task.executionMetadata ? { executionMetadata: { ...task.executionMetadata } } : {}),
        }) === true;
      } catch {
        console.warn('[Delegation] Display text could not be delivered');
        return false;
      }
    };
    const clearTextProgress = (task: Task, discardPending = false): void => {
      clearTimeout(task.textTimer);
      task.textTimer = undefined;
      if (discardPending) task.textBuffer = undefined;
    };
    const flushTextProgress = (task: Task): void => {
      if (closed || task.record.state !== 'running' || !task.textProgressEnabled) return;
      const latestText = task.textBuffer ? latestDisplayText(task.textBuffer) : undefined;
      if (!latestText || latestText === task.lastReportedText) return;
      if (!reportTextProgress(task, latestText)) {
        return;
      }
      task.lastReportedText = latestText;
    };
    const scheduleTextProgress = (task: Task): void => {
      if (closed || task.record.state !== 'running' || !task.textProgressEnabled || task.textTimer) return;
      const timer = setTimeout(() => {
        if (task.textTimer !== timer) return;
        task.textTimer = undefined;
        flushTextProgress(task);
      }, DELEGATION_TEXT_PROGRESS.flushMs);
      timer.unref?.();
      task.textTimer = timer;
    };
    const recordDisplayText = (task: Task, text: string): void => {
      if (!task.textProgressEnabled || !text) return;
      task.textBuffer = tailText(`${task.textBuffer ?? ''}${text}`, DELEGATION_TEXT_PROGRESS.bufferBytes);
      scheduleTextProgress(task);
    };
    const reportTerminalProgress = (task: Task): boolean => {
      if (!isTerminalTaskState(task.record.state) || task.record.startedAt === undefined) return false;
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
        if (source) await this.workspaceManager.preserveLane(lane.id);
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
      clearTextProgress(task, true);
      if (!task.executor) {
        // A cancellation can race with durable lane acquisition. No worker
        // process owns this lane yet, so it must not become a reusable empty
        // session after the task finishes.
        task.discardLane = true;
        task.interrupt();
        return;
      }
      try {
        captureWorkerMetadata(task);
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
      clearTextProgress(task, true);
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
    const finishTask = async (task: Task): Promise<void> => {
      clearTimeout(task.queueTimer);
      task.record.finishedAt = Date.now();
      await deadline(async () => { await save(task); await this.store.prune(); }, this.cleanupMs)
        .catch(() => console.warn('[Delegation] Final task metadata could not be saved or pruned'));
      if (!reportTerminalProgress(task)) {
        // A never-started task has no tool/progress card to close on older peers.
        if (task.record.startedAt !== undefined) {
          notify(() => parent.onToolResult({ tool_use_id: task.record.id, content: JSON.stringify(view(task)), is_error: task.record.state !== 'succeeded' }));
        }
        notify(() => parent.onNotice(formatDelegationNotice(task.record)));
      }
      task.settle();
      activeTasks.delete(task);
      releaseWorkspaceIfIdle();
      for (const start of this.pumps) start();
    };
    const completeUnstarted = (task: Task, state: 'cancelled' | 'timed_out' | 'failed' | 'interrupted', error: string): Promise<void> => {
      if (task.finishUnstarted) return task.finishUnstarted;
      task.record.state = state;
      task.record.error = error;
      return task.finishUnstarted = finishTask(task);
    };
    const armQueueTimer = (task: Task): void => {
      const remaining = Math.max(0, task.record.acceptedAt! + this.timeouts.queueTimeoutMs - Date.now());
      task.queueTimer = setTimeout(() => {
        if (task.record.state !== 'queued' || task.ownsSlot) return;
        void completeUnstarted(task, 'timed_out', `Task was not started within ${formatDuration(this.timeouts.queueTimeoutMs)} of admission.`);
      }, remaining);
    };
    const cancel = async (task: Task): Promise<unknown> => {
      if (task.record.state === 'queued' && !task.ownsSlot) {
        await completeUnstarted(task, 'cancelled', 'Cancelled before the worker started.');
      } else if (!isTerminalTaskState(task.record.state)) {
        clearTimeout(task.queueTimer);
        clearTaskTimer(task);
        clearTextProgress(task, true);
        task.record.state = 'cancelled';
        task.record.error = 'Cancelled; edits already made were not undone.';
        await stop(task).catch(() => undefined);
      }
      await task.done;
      return view(task);
    };
    const run = async (task: Task): Promise<void> => {
      const { configuration, objective } = task;
      let metadataCaptured = false;
      const backend = task.record.backend as DelegationBackend;
      const identity: DelegatedWorkerLaneIdentity = {
        threadId: parent.thread.id,
        backend,
        workingDirectory: cwd,
        workspaceGeneration,
      };
      const assertStartable = (): void => {
        if (closed || isTerminalTaskState(task.record.state) || task.quarantineWorkspace) {
          throw new Error('Delegated task ended before execution could start');
        }
        assertWorkspace();
      };
      const createWorker = async (): Promise<IExecutor> => {
        assertStartable();
        if (!task.lane) {
          const acquired = await this.laneStore.acquire(identity, source
            ? { pooled: true, excluded: await this.workspaceManager.unavailableLanes() } : undefined);
          task.lane = acquired.lane;
          task.preserveUnstartedLane = Boolean(source && acquired.reused);
          if (task.settled || task.quarantineWorkspace) {
            // Setup can finish after its deadline, but must never start a late
            // worker or leave that acquisition resumable.
            await this.laneStore.markDirty(acquired.lane.id, 'Worker setup completed after its task ended.', true).catch(() => undefined);
          }
        }
        let worker: IExecutor | undefined;
        try {
          assertStartable();
          if (source && !task.workspace) {
            baseline ??= this.workspaceManager.baseline(source);
            const input = await baseline;
            assertStartable();
            task.workspace = await this.workspaceManager.prepare(task.lane, source, input, task.record.id);
            assertStartable();
          }
          const executionCwd = task.workspace?.cwd ?? cwd;
          const workerGuard = task.workspace ? new DirectoryGuard([...this.guard.getAllowedDirectories(), executionCwd]) : this.guard;
          worker = this.factory(workerGuard, configuration, executionCwd, task.lane.executorThreadId,
            resolveThreadModel(parent.thread, configuration), parent.thread.efforts?.[backend],
            { lifecycleHooks: false, delegationWorker: true });
          task.executor = worker;
          if (fs.realpathSync(worker.getCurrentWorkingDirectory()) !== fs.realpathSync(executionCwd)) {
            throw new Error('Worker refused the delegated workspace; refusing a fallback directory');
          }
          await this.laneStore.markRunning(task.lane.id);
          assertStartable();
          task.preserveUnstartedLane = false;
          return worker;
        } catch (error) {
          // The factory either supplied an executor that final cleanup can stop,
          // or failed before any worker process became manager-owned. Neither
          // case warrants a workspace quarantine by itself. Do not reuse a lane
          // whose setup did not reach a completed delegated turn.
          task.discardLane = !task.preserveUnstartedLane;
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
        task.workspace = undefined;
        return discarded;
      };
      try {
        if (isTerminalTaskState(task.record.state)) return;
        // An optional history probe is not native startup. A slow Git query must
        // not quarantine the source as though an untracked worker had started.
        if (source) {
          await reconcileHistory(false, backend, assertStartable);
          assertStartable();
        }
        let result: ExecuteResult | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
          let setupPending = true;
          const setup = createWorker().finally(() => { setupPending = false; });
          let worker: IExecutor;
          try {
            worker = await deadline(() => setup, DELEGATION_LIMITS.storageTimeoutMs, 'Worker setup timed out');
          } catch (error) {
            if (setupPending) task.quarantineWorkspace = true;
            throw error;
          }
          assertStartable();
          task.executionMetadata = captureExecutionMetadata(worker, backend);
          metadataCaptured = false;
          if (task.record.startedAt === undefined) {
            task.record.state = 'running';
            task.record.startedAt = Date.now();
            void save(task);
            if (!reportProgress(task, { phase: 'started', objective: task.record.objective, startedAt: task.record.startedAt })) {
              notify(() => parent.onToolUse({ id: task.record.id, name: 'Task', input: {
                description: `${backend}: ${objective.slice(0, 120)}`, prompt: objective.slice(0, 1000), subagent_type: backend,
              } }));
            }
          }
          // Native session IDs are distinct; policy was resolved against the real
          // parent thread before passing the synthetic worker identity to the factory.
          const execution = worker.execute(
            `You are executing one delegated task in an isolated worker session. This session may contain context from earlier delegated tasks in this thread and workspace. Complete only this objective and return a concise result with verification and remaining issues. Do not delegate to other agents.${task.workspace
              ? `\nThis task runs in an owned Git worktree at ${task.workspace.cwd}, with a fresh detached task checkout based on checkpoint ${task.workspace.input.commit}. Previous task changes are NOT implicitly present. Re-read current files; earlier conversation context may be stale. Stay within this checkout. Do not merge into or edit the delivery directory, push, change branches, or remove the worktree. Your file changes will be captured as an artifact for explicit coordinator integration. Ignored files and dependencies are not copied from the delivery directory. A worktree is not an OS sandbox.` : ''}

${objective}`,
            {
              // The manager owns delegated-task liveness. Zero disables optional
              // backend-local limits that would otherwise ignore tool callbacks.
              timeout: 0,
              inactivityTimeout: 0,
              onStream: text => {
                // Generic streams may include reasoning or backend notices. Use
                // this channel only to detect interactive input requests.
                queueMicrotask(() => {
                  if (closed || task.record.state !== 'running') return;
                  if (task.executor?.isWaitingInput?.()) {
                    clearTextProgress(task, true);
                    const prompt = bounded(text, 4000).text;
                    if (task.waitingInputText === prompt) return;
                    task.waitingInputText = prompt;
                    if (!reportProgress(task, { phase: 'waiting_input', summary: prompt, startedAt: task.record.startedAt })) {
                      notify(() => parent.onNotice(`
[${backend} delegated task]
${prompt}`));
                    }
                    return;
                  }
                });
              },
              onDisplayText: text => {
                if (!closed && task.record.state === 'running' && !task.executor?.isWaitingInput?.()) {
                  recordDisplayText(task, text);
                }
              },
              onToolUse: tool => {
                if (task.record.state !== 'running') return;
                // Display text is delivered synchronously by executors, so flush
                // a just-emitted assistant update before showing this tool.
                flushTextProgress(task);
                clearTextProgress(task, true);
                task.waitingInputText = undefined;
                if (tool.id) task.activeToolIds.add(tool.id);
                noteToolActivity(task, 'tool_use');
                reportProgress(task, { phase: 'tool_use', toolUse: { id: tool.id, name: tool.name, input: {} }, startedAt: task.record.startedAt });
              },
              onToolResult: toolResult => {
                if (task.record.state !== 'running') return;
                // A visible assistant update may immediately precede a result.
                flushTextProgress(task);
                clearTextProgress(task, true);
                task.waitingInputText = undefined;
                if (toolResult.tool_use_id) task.activeToolIds.delete(toolResult.tool_use_id);
                noteToolActivity(task, 'tool_result');
                reportProgress(task, { phase: 'tool_result', toolResult: {
                  tool_use_id: toolResult.tool_use_id, content: '', is_error: toolResult.is_error,
                }, startedAt: task.record.startedAt });
              },
              onApprovalRequest: request => !closed && task.record.state === 'running' && parent.onApproval({ ...request,
                description: `[${backend} delegated task] ${request.description}`, canRemember: false }, task.executor!),
              onApprovalResolved: parent.onApprovalResolved,
            });
          // Start the inactivity window only once the worker has accepted the
          // objective and can emit its first real progress callback.
          task.signalDispatch();
          armIdleTimer(task);
          result = await Promise.race([task.interrupted, execution]);
          captureWorkerMetadata(task);
          metadataCaptured = true;
          if (!result.success && attempt === 0 && worker.consumeSessionResumeFailure?.()) {
            clearTaskTimer(task);
            clearTextProgress(task, true);
            task.lastReportedText = undefined;
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
        if (!isTerminalTaskState(task.record.state)) {
          task.record.state = 'failed';
          task.record.error = bounded(error instanceof Error ? error.message : 'Worker failed', 4000).text;
        }
        this.registry.invalidate();
      } finally {
        if (!metadataCaptured) captureWorkerMetadata(task);
        clearTaskTimer(task);
        clearTextProgress(task, true);
        if (task.record.startedAt === undefined) task.discardLane = !task.preserveUnstartedLane;
        let released = !task.quarantineWorkspace;
        let readyWorkspaceLane: DelegatedWorkerLane | undefined;
        try { await deadline(async () => {
          if (task.stop) await task.stop;
          else if (task.executor) await deadline(() => destroyWorker(task.executor!), this.cleanupMs);
          else if (task.lane && !task.preserveUnstartedLane) {
            // A scope can close after durable acquisition but before construction.
            // No backend process was started, so discard the lane rather than
            // reserving the workspace indefinitely.
            task.discardLane = true;
          }
          if (released && task.lane && task.preserveUnstartedLane) {
            await this.workspaceManager.preserveLane(task.lane.id);
            await this.laneStore.markDirty(task.lane.id,
              'Worker checkout preparation failed; existing context and files were retained for manual recovery.');
          }
          if (released && task.lane && task.discardLane) {
            const lane = task.lane;
            await this.laneStore.markDirty(lane.id,
              'Delegated worker setup ended before a reusable context was established.', true).catch(() => undefined);
            await discardLane(lane);
            task.lane = undefined;
          }
          if (released && task.lane && !task.preserveUnstartedLane) {
            try {
              if (task.workspace) {
                task.artifact = await this.workspaceManager.collect(task.workspace, task.record.state === 'succeeded');
                readyWorkspaceLane = task.lane;
              } else {
                await this.laneStore.markReady(task.lane.id);
              }
            } catch (error) {
              const detail = error instanceof Error ? error.message : 'Worker lane persistence failed';
              if (task.workspace) {
                // Exit was confirmed. Preserve files and context for recovery without blocking unrelated lanes.
                await this.workspaceManager.preserveLane(task.lane.id).catch(() => undefined);
                await this.laneStore.markDirty(task.lane.id, detail).catch(() => undefined);
                if (task.record.state === 'succeeded') task.record.state = 'failed';
                task.record.error = bounded(`Worker artifact could not be finalized: ${detail}. Files were retained for manual recovery.`, 4000).text;
              } else {
                await this.laneStore.markDirty(task.lane.id, detail, true).catch(() => undefined);
                await discardLane(task.lane);
              }
              console.warn('[Delegation] Worker lane could not be retained:', detail);
            }
          }
        }, this.cleanupMs);
        } catch (error) {
          released = false;
          task.quarantineWorkspace = true;
          if (task.lane) {
            const detail = error instanceof Error ? error.message : 'Worker cleanup could not be confirmed';
            await deadline(() => this.laneStore.markDirty(task.lane!.id, detail), this.cleanupMs).catch(() => undefined);
          }
          task.record.state = 'interrupted';
          task.record.error = 'Worker cleanup could not be confirmed. This workspace is blocked until the worker is stopped and the CLI restarts.';
          console.warn('[Delegation] Worker cleanup failed:', error instanceof Error ? error.message : 'Cleanup failure');
        }
        if (released && readyWorkspaceLane) {
          // Reclamation awaits subprocess exit; a timeout race must not release a live removal.
          // The lane stays non-ready until its checkout state is settled.
          if (task.record.state === 'succeeded' && task.artifact?.disposition === 'applied') {
            await this.workspaceManager.reclaim(task.record.id);
          }
          try { await this.laneStore.markReady(readyWorkspaceLane.id); }
          catch {
            await this.workspaceManager.preserveLane(readyWorkspaceLane.id).catch(() => undefined);
            await this.laneStore.markDirty(readyWorkspaceLane.id, 'Worker lane persistence failed').catch(() => undefined);
            if (task.record.state === 'succeeded') task.record.state = 'failed';
            task.record.error = 'Worker context could not be finalized. Artifacts were retained for manual recovery.';
          }
        }
        if (released && task.ownsSlot) {
          task.ownsSlot = false;
          this.running--;
        } else if (!released) {
          workspaceOwner.quarantined = true;
          task.record.state = 'interrupted';
          task.record.error = 'Worker cleanup could not be confirmed. This workspace is blocked until the worker is stopped and the CLI restarts.';
        }
        await finishTask(task);
      }
    };
    const startTask = (task: Task): void => {
      clearTimeout(task.queueTimer);
      activeTasks.add(task);
      task.ownsSlot = true;
      this.running++;
      void run(task).catch(() => undefined);
    };
    const pump = (): void => {
      if (closed || integrating || activeTasks.size >= maxChildren) return;
      const queued = [...tasks.values()].filter(task => task.record.state === 'queued' && !task.ownsSlot && !task.finishUnstarted);
      if (workspaceOwner.quarantined) {
        for (const task of queued) void completeUnstarted(task, 'interrupted', 'Task was not started because the previous worker exit could not be confirmed.');
        return;
      }
      const task = queued[0];
      if (!task) return;
      if (Date.now() >= task.record.acceptedAt! + this.timeouts.queueTimeoutMs) {
        void completeUnstarted(task, 'timed_out', `Task was not started within ${formatDuration(this.timeouts.queueTimeoutMs)} of admission.`);
        return;
      }
      try { assertWorkspace(); }
      catch (error) {
        void completeUnstarted(task, 'failed', bounded(error instanceof Error ? error.message : 'Workspace unavailable', 4000).text);
        return;
      }
      if (this.running < DELEGATION_LIMITS.concurrent) {
        startTask(task);
        pump();
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
          await discoverWorkspace();
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
          }), workspace: cwd, maxConcurrentChildren: maxChildren,
          maxTasksPerRequest: DELEGATION_LIMITS.launches, scheduling: source ? 'isolated-worktrees' : 'serial',
          queueTimeoutSeconds: this.timeouts.queueTimeoutMs / 1000 };
        }
        if (name === 'remote_cli_result') {
          const task = getTask(args.taskId);
          const seconds = args.waitSeconds ?? 25;
          if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 || seconds > 25) throw new Error('waitSeconds must be between 0 and 25');
          if (task.record.finishedAt === undefined && seconds > 0) {
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
        if (name === 'remote_cli_integrate') {
          if (!acceptingResults) throw new Error('The coordinator execution has ended');
          await discoverWorkspace();
          if (!source) throw new Error('Non-Git delegation uses the shared workspace and has no worktree artifacts');
          if (integrating || admissions || activeTasks.size || [...tasks.values()].some(task => !task.settled)) {
            throw new Error('Wait for all accepted workers to finish before integrating artifacts');
          }
          if (workspaceOwner.quarantined || [...this.workspaces].some(([active, owner]) =>
            owner !== workspaceOwner && workspacesOverlap(active, leasePath)) || parent.isWorkspaceBusy?.(leasePath)) {
            throw new Error('Delivery workspace is busy; integration was not started');
          }
          integrating = true;
          this.workspaces.set(leasePath, workspaceOwner);
          try {
            assertWorkspace();
            integrationPending = this.workspaceManager.integrate({ threadId: parent.thread.id, cwd, workspaceGeneration,
              checkActive: () => { if (closed) throw new Error('Integration was cancelled before delivery'); assertWorkspace(); } },
              String(args.taskId ?? ''), args.action ?? 'inspect', args.expectedRevision);
            const result = await integrationPending;
            baseline = undefined;
            const task = tasks.get(String(args.taskId));
            if (task) task.artifact = await this.workspaceManager.describe(task.record.id);
            return result;
          } finally { integrationPending = undefined; integrating = false; releaseWorkspaceIfIdle(); }
        }
        if (name !== 'remote_cli_delegate') throw new Error('Unknown delegation tool');
        if (!acceptingResults) throw new Error('The coordinator execution has ended');
        if (!DELEGATION_BACKENDS.includes(args.backend as DelegationBackend)) throw new Error('Unsupported worker backend');
        if (typeof args.objective !== 'string' || !args.objective.trim() || args.objective.length > 24_000) throw new Error('objective must contain 1 to 24000 characters');
        const objective = args.objective;
        const mode = args.mode ?? 'inherit';
        if (mode !== 'inherit' && mode !== 'read_only') throw new Error('Unsupported execution mode');
        const backend = args.backend as DelegationBackend;
        const configuration = workerConfiguration(parent.config, this.guard, parent.thread.id, parent.backend, backend, mode);
        if (integrating) throw new Error('Artifact integration is in progress; wait before delegating');
        launchRevision++;
        admissions++;
        const discovery = this.registry.get(backend, parent.config);
        void discovery.catch(() => undefined);
        // Serialize admission, not worker execution. Replayed calls share the
        // original promise; simultaneous new calls cannot overdraw the quota.
        const admitted = admissionTail.then(async (): Promise<Task> => {
          if (closed) throw new Error('Delegation turn has ended');
          if (launches >= DELEGATION_LIMITS.launches) throw new Error('Delegated task limit reached');
          const available = await discovery;
          if (!available.installed) throw new Error(`${backend}: ${available.reason}`);
          await discoverWorkspace();
          if (integrating) throw new Error('Artifact integration is in progress; wait before delegating');
          await deadline(() => this.store.initialize(), DELEGATION_LIMITS.storageTimeoutMs, 'Task record initialization timed out');
          if (closed) throw new Error('Delegation turn has ended');
          const idle = !activeTasks.size && ![...tasks.values()].some(task => !task.settled);
          const first = activeTasks.size < maxChildren && this.running < DELEGATION_LIMITS.concurrent
            && ![...tasks.values()].some(task => task.record.state === 'queued' && !task.ownsSlot && !task.finishUnstarted);
          if ((idle && this.running >= DELEGATION_LIMITS.concurrent)
            || workspaceOwner.quarantined
            || [...this.workspaces].some(([active, owner]) => owner !== workspaceOwner && workspacesOverlap(active, leasePath))
            || parent.isWorkspaceBusy?.(leasePath)) throw new Error('Delegation capacity or workspace is busy; wait before retrying');
          this.workspaces.set(leasePath, workspaceOwner);
          assertWorkspace();
          launches++;
          let resolveDone!: () => void;
          let resolveDispatch!: () => void;
          let interrupt!: () => void;
          const interrupted = new Promise<ExecuteResult>(resolve => { interrupt = () => resolve({ success: false }); });
          const task: Task = { record: { id: randomUUID(), threadId: parent.thread.id,
            parentMessageId: parent.messageId, backend, objective: objective.slice(0, 1000),
            state: 'queued', acceptedAt: Date.now() }, configuration, objective,
            resultDelivered: false, settled: false, ownsSlot: first,
            textProgressEnabled: parent.onTextProgress !== undefined,
            activeToolIds: new Set(), done: new Promise<void>(resolve => { resolveDone = resolve; }),
            dispatched: new Promise<void>(resolve => { resolveDispatch = resolve; }), signalDispatch: () => resolveDispatch(),
            settle: () => { if (task.settled) return; task.settled = true; resolveDone(); resolveDispatch(); }, interrupted, interrupt };
          if (first) { activeTasks.add(task); this.running++; }
          try {
            await deadline(() => this.store.write(task.record), DELEGATION_LIMITS.storageTimeoutMs, 'Initial task record write timed out');
          } catch (error) {
            if (task.ownsSlot) { this.running--; task.ownsSlot = false; activeTasks.delete(task); }
            launches--;
            task.settle();
            throw error;
          }
          // The durable queued record is the acceptance boundary. Every task
          // after it consumes quota, including setup failures and cancellation.
          tasks.set(task.record.id, task);
          if (closed) {
            if (task.ownsSlot) { this.running--; task.ownsSlot = false; activeTasks.delete(task); }
            await completeUnstarted(task, 'cancelled', 'Cancelled before the worker started.');
          } else if (task.ownsSlot) {
            void run(task).catch(() => undefined);
          } else {
            armQueueTimer(task);
            notify(() => parent.onNotice(`\n\n⏳ ${backend} delegated task ${task.record.id.slice(0, 8)} queued. It will start after earlier tasks finish; queue wait is limited to ${formatDuration(this.timeouts.queueTimeoutMs)}.\n\n`));
            pump();
          }
          return task;
        });
        admissionTail = admitted.catch(() => undefined);
        let task: Task;
        try { task = await admitted; }
        finally {
          admissions--;
          releaseWorkspaceIfIdle();
          for (const start of this.pumps) start();
        }
        if (task.ownsSlot) {
          // Preserve the existing first-task response after dispatch/setup,
          // without holding up admission of followers while setup is pending.
          await task.dispatched;
        }
        return receive(task, requestedDuring);
      })();
      calls.set(callId, { signature, result });
      return result;
    };
    const scope: DelegationScope = {
      invoke,
      isClosed: () => closed,
      hasTasks: () => admissions > 0 || tasks.size > 0,
      getLaunchRevision: () => launchRevision,
      beginExecution: (taskIds = []) => {
        if (closed) throw new Error('Delegation was cancelled');
        execution++;
        acceptingResults = true;
        stagedResults.clear();
        for (const id of taskIds) {
          if (tasks.get(id)?.record.finishedAt !== undefined) stagedResults.add(id);
        }
      },
      finishExecution: success => {
        acceptingResults = false;
        if (success && !closed) {
          for (const id of stagedResults) tasks.get(id)!.resultDelivered = true;
        }
        stagedResults.clear();
      },
      hasPendingResults: () => admissions > 0 || [...tasks.values()].some(task => !task.resultDelivered && !stagedResults.has(task.record.id)),
      getRetainedResults: () => boundedResults([...tasks.values()]
        .filter(task => task.record.finishedAt !== undefined && !task.resultDelivered).map(view)),
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
      checkArtifactCloseout: async () => {
        if (closed) throw new Error('Delegation was cancelled');
        // Unlike result acknowledgement, closeout also waits for native cleanup
        // and artifact collection of tasks whose results were already read.
        await Promise.allSettled([...calls.values()].map(call => call.result));
        await Promise.all([...tasks.values()].map(task => task.done));
        if (closed) throw new Error('Delegation was cancelled');
        const candidates = [...tasks.values()].filter(task => task.workspace && task.record.startedAt !== undefined);
        const unavailable = (): DelegationCloseoutIssue[] => candidates.map(task => ({
          taskId: task.record.id, backend: task.record.backend, status: 'unavailable',
        }));
        if (!candidates.length) return [];
        if (integrating || admissions || activeTasks.size || workspaceOwner.quarantined
          || parent.isWorkspaceBusy?.(leasePath) || [...this.workspaces].some(([active, owner]) =>
            owner !== workspaceOwner && workspacesOverlap(active, leasePath))) return unavailable();
        integrating = true;
        this.workspaces.set(leasePath, workspaceOwner);
        const checkActive = () => {
          if (closed) throw new Error('Delegation was cancelled');
          assertWorkspace();
        };
        const inspect = async (): Promise<DelegationCloseoutIssue[]> => {
          checkActive();
          // Metadata-only reconciliation cannot delete worker files at this barrier.
          await reconcileHistory(false, undefined, checkActive);
          const issues: DelegationCloseoutIssue[] = [];
          for (const task of candidates) {
            checkActive();
            try {
              const artifact = await this.workspaceManager.inspectCloseout({
                threadId: parent.thread.id, cwd, workspaceGeneration, checkActive,
              }, task.record.id);
              if (artifact.disposition !== 'retained' && (artifact.disposition !== 'applied' || artifact.recovery)) {
                issues.push({ taskId: task.record.id, backend: task.record.backend,
                  status: artifact.recovery ? 'recovery' : 'pending', outputCommit: artifact.outputCommit });
              }
            } catch {
              // Failed collection, corrupt metadata and changed refs are unknown,
              // not proof that a failed worker left no changes.
              issues.push({ taskId: task.record.id, backend: task.record.backend, status: 'unavailable' });
            }
          }
          checkActive();
          return issues;
        };
        const pending = inspect();
        integrationPending = pending;
        try { return await pending; }
        catch {
          if (closed) throw new Error('Delegation was cancelled');
          return unavailable();
        } finally { integrationPending = undefined; integrating = false; releaseWorkspaceIfIdle(); }
      },
      waitingExecutor: () => {
        const waiting = [...activeTasks].filter(task => task.record.state === 'running' && task.executor?.isWaitingInput?.());
        return !closed && waiting.length === 1 ? waiting[0].executor : undefined;
      },
      waitingInputCount: () => closed ? 0 : [...activeTasks].filter(task =>
        task.record.state === 'running' && task.executor?.isWaitingInput?.()).length,
      close: async () => {
        closed = true;
        this.pumps.delete(pump);
        await Promise.allSettled([...tasks.values()].map(cancel));
        await integrationPending?.catch(() => undefined);
        // Do not wait forever for a discovery-only admission. Its closed check
        // prevents launch; defer reconciliation unless this scope is fully idle.
        if (source && !admissions && !activeTasks.size && [...tasks.values()].every(task => task.settled)
          && !workspaceOwner.quarantined && !parent.isWorkspaceBusy?.(leasePath)
          && ![...this.workspaces].some(([active, owner]) => owner !== workspaceOwner && workspacesOverlap(active, leasePath))) {
          this.workspaces.set(leasePath, workspaceOwner);
          try { await reconcileHistory(true); }
          catch { console.warn('[Delegation] Historical delivery reconciliation deferred; worker files were preserved'); }
        }
        releaseWorkspaceIfIdle();
        // A version probe may still be pending. Its closed check prevents launch.
        if (this.scopes.get(parent.thread.id) === scope) this.scopes.delete(parent.thread.id);
      },
    };
    this.pumps.add(pump);
    this.scopes.set(parent.thread.id, scope);
    return scope;
  }

  waitingExecutor(threadId: string): IExecutor | undefined { return this.scopes.get(threadId)?.waitingExecutor(); }
  hasAmbiguousInput(threadId: string): boolean { return (this.scopes.get(threadId)?.waitingInputCount() ?? 0) > 1; }
  hasActiveTasks(threadId: string): boolean { return this.scopes.get(threadId)?.hasTasks() ?? false; }

  /** Retry previously confirmed cleanup requests without touching uncertain interrupted workers. */
  async reconcilePendingWorkerLanes(): Promise<{ removed: number; failed: number }> {
    return this.removeWorkerLanes(await this.laneStore.cleanupCandidates(), true);
  }

  /** Remove all lanes older than the new workspace generation after a successful `/cd`. */
  async invalidateWorkspaceGeneration(threadId: string, currentGeneration: number): Promise<{ removed: number; failed: number }> {
    if (this.hasActiveTasks(threadId)) {
      throw new Error('Cannot change working directory while a delegated worker is running. Wait for it to finish or send /abort first.');
    }
    return this.removeWorkerLanes(await this.laneStore.invalidateGeneration(threadId, currentGeneration), true);
  }

  /** Reset exactly one idle lane without changing its workspace or configuration. */
  async resetWorkerContext(thread: Thread, laneId: string, generation: number): Promise<void> {
    const cwd = fs.realpathSync(this.guard.resolveWorkingDirectory(thread.workingDirectory));
    await this.laneStore.clearContext(laneId, generation, { threadId: thread.id,
      workingDirectory: cwd, workspaceGeneration: thread.delegationWorkspaceGeneration ?? 0 },
    clearDelegatedWorkerContext);
  }

  /** Forget one backend lane or all lanes for an idle parent thread. */
  async resetWorkerLanes(threadId: string, backend?: DelegationBackend): Promise<number> {
    if (this.hasActiveTasks(threadId)) {
      throw new Error('Cannot reset delegated worker context while a delegated worker is running. Wait for it to finish or send /abort first.');
    }
    const result = await this.removeWorkerLanes(await this.laneStore.markForReset(threadId, backend));
    return result.removed;
  }

  /** Thread deletion is executor-free so it works whether delegation is currently enabled or not. */
  async deleteWorkerLanes(threadId: string): Promise<number> {
    if (this.hasActiveTasks(threadId)) {
      throw new Error('Cannot delete delegated worker context while a delegated worker is running.');
    }
    const result = await this.removeWorkerLanes(await this.laneStore.markForReset(threadId));
    return result.removed;
  }

  private async removeWorkerLanes(lanes: DelegatedWorkerLane[], tolerateFailures = false): Promise<{ removed: number; failed: number }> {
    let removed = 0;
    let failed = 0;
    for (const lane of lanes) {
      try {
        await this.workspaceManager.preserveLane(lane.id);
        await cleanupDelegatedWorkerLane(lane);
        await this.laneStore.remove(lane.id);
        removed++;
      } catch (error) {
        failed++;
        const detail = error instanceof Error ? error.message : 'Local worker lane cleanup failed';
        await this.laneStore.markCleanupFailure(lane.id, detail).catch(() => undefined);
        console.warn('[Delegation] Worker lane cleanup failed:', detail);
      }
    }
    if (failed && !tolerateFailures) {
      throw new Error(`Delegated worker cleanup failed for ${failed} of ${lanes.length} lane(s). ${removed} lane(s) were removed; retry after checking filesystem permissions.`);
    }
    return { removed, failed };
  }

  blocksWorkspace(cwd: string, threadId: string): boolean {
    if (this.workspaces.size === 0) return false;
    const canonical = fs.realpathSync(cwd);
    return [...this.workspaces].some(([active, owner]) => (owner.quarantined || owner.threadId !== threadId) && workspacesOverlap(active, canonical));
  }
  async cancelThread(threadId: string): Promise<void> { await this.scopes.get(threadId)?.close(); }
  async destroy(): Promise<void> { await Promise.allSettled([...this.scopes.values()].map(scope => scope.close())); }
}
