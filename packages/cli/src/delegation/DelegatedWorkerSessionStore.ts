import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { DELEGATION_BACKENDS, type DelegationBackend } from './contract';
import { hasLegacyDiscardTombstone } from './LegacyWorkspaceCleanup';
import { ThreadContextReset } from '../thread/ThreadContextReset';
import { syncDirectory } from './OwnershipRuntime';
import { replaceAtomicFile } from './AtomicFile';
import { validNativeTarget, validDeletionPreparation, type NativeSessionDeletionTarget, type NativeDeletionResult,
  type NativeDeletionPreparation } from './NativeSessionDeletion';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATES = new Set<DelegatedWorkerLaneState>(['preparing', 'running', 'ready', 'dirty']);

/** A persisted, isolated worker conversation owned by delegation rather than a direct thread. */
export type DelegatedWorkerLaneState = 'preparing' | 'running' | 'ready' | 'dirty';

export interface DelegatedWorkerLane {
  id: string;
  executorThreadId: string;
  threadId: string;
  backend: DelegationBackend;
  workingDirectory: string;
  workspaceGeneration: number;
  state: DelegatedWorkerLaneState;
  createdAt: number;
  updatedAt: number;
  cleanupPending?: boolean;
  /** Permanent deletion is authorized only by a durable parent clear/new fence. */
  nativeDeleteRequested?: boolean;
  nativeDeletion?: NativeDeletionResult;
  nativeSession?: NativeSessionDeletionTarget;
  /** Earlier native identities remain owned after fallback or a worker-only reset. */
  nativeSessionHistory?: NativeSessionDeletionTarget[];
  /** A later executor cannot prove exit of an earlier unconfirmed native writer. */
  nativeHistoryExitUnconfirmed?: boolean;
  nativeDeletionPreparations?: Record<string, NativeDeletionPreparation>;
  nativeSessionConflict?: boolean;
  nativeMaintenanceExitUnconfirmed?: boolean;
  /** Strong process-group proof, distinct from legacy transport-only shutdown. */
  nativeGroupExitGeneration?: number;
  cleanupAttempts?: number;
  cleanupError?: string;
  contextGeneration?: number;
  /** Native exit was confirmed for this exact acquisition, independently of artifact recovery. */
  shutdownConfirmedGeneration?: number;
  contextResetPending?: boolean;
  lastClearedGeneration?: number;
  /** Cleared and retired; retained for stale cards and recovery, never reused. */
  contextRetired?: boolean;
  /** Offline discard retires scheduling without claiming native context was cleared. */
  workspaceDiscarded?: boolean;
  pooled?: boolean;
  /** Fixed worker instructions confirmed by a successful turn in this native context. */
  initializedPrompt?: { sessionId: string; workspaceKind: 'git' | 'shared' };
}

export interface DelegatedWorkerLaneIdentity {
  threadId: string;
  backend: DelegationBackend;
  workingDirectory: string;
  workspaceGeneration: number;
}

export interface DelegatedWorkerLaneAcquireResult {
  lane: DelegatedWorkerLane;
  reused: boolean;
}

/**
 * Synthetic IDs never overlap with a user-facing thread UUID. Every backend
 * stores its native pointer under this ID, keeping delegated work isolated.
 */
export function workerLaneExecutorId(laneId: string): string {
  if (!UUID_RE.test(laneId)) throw new Error('Invalid delegated worker lane ID');
  return `delegate-lane-${laneId}`;
}

export function isWorkerLaneExecutorId(value: string): boolean {
  return /^delegate-lane-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function clone(lane: DelegatedWorkerLane): DelegatedWorkerLane {
  return structuredClone(lane);
}

function sameIdentity(lane: DelegatedWorkerLane, identity: DelegatedWorkerLaneIdentity): boolean {
  return lane.threadId === identity.threadId
    && lane.backend === identity.backend
    && lane.workingDirectory === identity.workingDirectory
    && lane.workspaceGeneration === identity.workspaceGeneration;
}

function shutdownConfirmed(lane: DelegatedWorkerLane): boolean {
  return lane.shutdownConfirmedGeneration !== undefined
    && lane.shutdownConfirmedGeneration === (lane.contextGeneration ?? 0);
}

function contextResettable(lane: DelegatedWorkerLane): boolean {
  if (lane.state === 'dirty' && shutdownConfirmed(lane)) return true;
  return !lane.cleanupPending && (lane.state === 'ready'
    || lane.state === 'dirty' && Boolean(lane.contextResetPending || lane.contextRetired));
}

function validateLane(value: unknown): value is DelegatedWorkerLane {
  if (!value || typeof value !== 'object') return false;
  const lane = value as Partial<DelegatedWorkerLane>;
  return typeof lane.id === 'string'
    && UUID_RE.test(lane.id)
    && lane.executorThreadId === workerLaneExecutorId(lane.id)
    && typeof lane.threadId === 'string'
    && lane.threadId.length > 0
    && lane.threadId.length <= 200
    && typeof lane.backend === 'string'
    && DELEGATION_BACKENDS.includes(lane.backend as DelegationBackend)
    && typeof lane.workingDirectory === 'string'
    && path.isAbsolute(lane.workingDirectory)
    && validGeneration(lane.workspaceGeneration)
    && typeof lane.state === 'string'
    && STATES.has(lane.state as DelegatedWorkerLaneState)
    && validTime(lane.createdAt)
    && validTime(lane.updatedAt)
    && (lane.nativeDeleteRequested === undefined || typeof lane.nativeDeleteRequested === 'boolean')
    && (lane.nativeSessionConflict === undefined || typeof lane.nativeSessionConflict === 'boolean')
    && (lane.nativeMaintenanceExitUnconfirmed === undefined || typeof lane.nativeMaintenanceExitUnconfirmed === 'boolean')
    && (lane.nativeHistoryExitUnconfirmed === undefined || typeof lane.nativeHistoryExitUnconfirmed === 'boolean')
    && (lane.nativeSession === undefined || validNativeTarget(lane.nativeSession)
      && lane.nativeSession.executorThreadId === lane.executorThreadId && lane.backend === lane.nativeSession.backend)
    && (lane.nativeSessionHistory === undefined || Array.isArray(lane.nativeSessionHistory)
      && lane.nativeSessionHistory.length <= 64 && lane.nativeSessionHistory.every(target => validNativeTarget(target)
        && target.executorThreadId === lane.executorThreadId && lane.backend === target.backend))
    && (lane.nativeDeletionPreparations === undefined || lane.nativeDeletionPreparations
      && typeof lane.nativeDeletionPreparations === 'object' && !Array.isArray(lane.nativeDeletionPreparations)
      && Object.entries(lane.nativeDeletionPreparations).length <= 64
      && Object.entries(lane.nativeDeletionPreparations).every(([id, prepared]) =>
        prepared?.version === 1 && [lane.nativeSession, ...(lane.nativeSessionHistory ?? [])].some(target =>
          target?.sessionId === id && validDeletionPreparation(target, prepared))))
    && (lane.nativeGroupExitGeneration === undefined || validGeneration(lane.nativeGroupExitGeneration)
      && lane.nativeGroupExitGeneration === (lane.contextGeneration ?? 0))
    && (lane.nativeDeletion === undefined || lane.nativeDeletion && typeof lane.nativeDeletion.reason === 'string'
      && ['pending', 'waiting-exit', 'held', 'unsupported', 'uncertain', 'deleted'].includes(lane.nativeDeletion.state))
    && (lane.cleanupPending === undefined || typeof lane.cleanupPending === 'boolean')
    && (lane.cleanupAttempts === undefined || validGeneration(lane.cleanupAttempts))
    && (lane.contextGeneration === undefined || validGeneration(lane.contextGeneration))
    && (lane.shutdownConfirmedGeneration === undefined || (validGeneration(lane.shutdownConfirmedGeneration)
      && lane.shutdownConfirmedGeneration === (lane.contextGeneration ?? 0)))
    && (lane.lastClearedGeneration === undefined || validGeneration(lane.lastClearedGeneration))
    && (lane.contextResetPending === undefined || typeof lane.contextResetPending === 'boolean')
    && (lane.contextRetired === undefined || typeof lane.contextRetired === 'boolean')
    && (lane.contextRetired !== true || (lane.state === 'dirty' && lane.contextResetPending === false
      && validGeneration(lane.lastClearedGeneration) && lane.contextGeneration === lane.lastClearedGeneration + 1))
    && (lane.workspaceDiscarded === undefined || (lane.workspaceDiscarded === true && lane.state === 'dirty'))
    && (lane.initializedPrompt === undefined || (lane.initializedPrompt !== null
      && typeof lane.initializedPrompt.sessionId === 'string' && lane.initializedPrompt.sessionId.length > 0
      && lane.initializedPrompt.sessionId.length <= 1024
      && ['git', 'shared'].includes(lane.initializedPrompt.workspaceKind)))
    && (lane.pooled === undefined || typeof lane.pooled === 'boolean')
    && (lane.cleanupError === undefined || typeof lane.cleanupError === 'string');
}

/**
 * Durable lane metadata. Native backend transcripts remain owned by each
 * backend; this store only decides whether a native pointer is safe to reuse.
 */
export class DelegatedWorkerSessionStore {
  private initialized?: Promise<void>;
  private beforeInitialize?: () => Promise<void>;
  private readonly lanes = new Map<string, DelegatedWorkerLane>();
  // Quarantine is sticky for this store lifetime; never reload over active lanes.
  private readonly quarantinedRecords = new Set<string>();
  private readonly allocatedLanes = new Set<string>();
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly directory = path.join(os.homedir(), '.remote-cli', 'delegation-workers'),
    private readonly contextResets = new ThreadContextReset()) {}

  get storageDirectory(): string { return this.directory; }

  /** Install the lifetime owner before the first mutable inventory load. */
  setInitializationGuard(guard: () => Promise<void>): void {
    this.beforeInitialize = guard;
  }

  assertContextReady(threadId: string, generation?: number): void {
    this.contextResets.assertReady(threadId);
    if (generation !== undefined && this.contextResets.generation(threadId, generation) !== generation) {
      throw new Error('Managed conversation generation has changed; start a fresh request.');
    }
  }

  initialize(): Promise<void> {
    return this.initialized ??= Promise.resolve().then(async () => {
      await this.beforeInitialize?.();
      await this.load();
    }).catch(error => {
      // Storage failures must block admission, but a repaired inventory can be
      // retried in this process instead of caching a rejected initialization.
      this.initialized = undefined;
      throw error;
    });
  }

  /** Completeness is separate from permission to allocate an independent lane. */
  async getInventoryStatus(): Promise<{ complete: boolean; quarantinedRecords: number }> {
    await this.initialize();
    return { complete: this.quarantinedRecords.size === 0, quarantinedRecords: this.quarantinedRecords.size };
  }

  private assertCompleteInventory(): void {
    if (this.quarantinedRecords.size) {
      throw new Error('Delegated worker inventory is incomplete. Historical reuse, reset and cleanup are disabled; '
        + 'fresh independent workers remain available. Preserved records require inspection before restarting the CLI.');
    }
  }

  private quarantine(name: string): void {
    if (!this.quarantinedRecords.size) {
      console.warn('[Delegation] Worker inventory is incomplete. Unavailable historical records are preserved; '
        + 'only fresh independent lanes may be allocated. Historical reset and cleanup remain disabled.');
    }
    this.quarantinedRecords.add(name);
  }

  async acquire(identity: DelegatedWorkerLaneIdentity,
    options: { pooled?: boolean; excluded?: ReadonlySet<string> } = {}): Promise<DelegatedWorkerLaneAcquireResult> {
    this.assertIdentity(identity);
    await this.initialize();
    return this.mutate(async () => {
      this.assertContextReady(identity.threadId, identity.workspaceGeneration);
      const discarded = new Set<string>();
      for (const lane of this.quarantinedRecords.size ? [] : this.lanes.values()) {
        if (lane.state !== 'ready' || !sameIdentity(lane, identity)) continue;
        try {
          if (await hasLegacyDiscardTombstone(this.directory, lane.id)) discarded.add(lane.id);
        } catch { this.quarantine(`${lane.id}.json`); }
      }
      const ready = (this.quarantinedRecords.size ? [] : [...this.lanes.values()])
        .filter(lane => lane.state === 'ready' && !lane.nativeDeleteRequested && !lane.contextRetired && !lane.workspaceDiscarded && !discarded.has(lane.id)
          && sameIdentity(lane, identity) && !options.excluded?.has(lane.id))
        .sort((a, b) => b.updatedAt - a.updatedAt);

      // Shared-directory lanes keep the legacy single-ready invariant. Isolated
      // worktree pools legitimately contain multiple ready conversations.
      if (ready.length > 1 && !options.pooled) {
        for (const duplicate of ready) await this.writeAndRemember({ ...duplicate,
          state: 'dirty', cleanupPending: false, updatedAt: Date.now(),
          cleanupError: 'Multiple delegated worker lanes matched one identity.' });
      } else if (ready.length >= 1) {
        const lane = { ...ready[0], state: 'preparing' as const, updatedAt: Date.now(),
          shutdownConfirmedGeneration: undefined,
          // Preparation starts no native worker. Carry the last exit proof
          // until markRunning durably invalidates it before executor creation.
          nativeGroupExitGeneration: ready[0].nativeGroupExitGeneration === (ready[0].contextGeneration ?? 0)
            ? (ready[0].contextGeneration ?? 0) + 1 : undefined,
          nativeHistoryExitUnconfirmed: ready[0].nativeHistoryExitUnconfirmed ||
            (!!ready[0].nativeSession || !!ready[0].nativeSessionHistory?.length)
              && ready[0].nativeGroupExitGeneration !== (ready[0].contextGeneration ?? 0),
          contextGeneration: (ready[0].contextGeneration ?? 0) + 1, pooled: options.pooled === true };
        await this.writeAndRemember(lane);
        return { lane: clone(lane), reused: true };
      }

      const now = Date.now();
      const id = randomUUID();
      const lane: DelegatedWorkerLane = {
        id,
        executorThreadId: workerLaneExecutorId(id),
        threadId: identity.threadId, backend: identity.backend,
        workingDirectory: identity.workingDirectory, workspaceGeneration: identity.workspaceGeneration,
        pooled: options.pooled === true,
        state: 'preparing',
        createdAt: now,
        updatedAt: now,
      };
      await this.writeAndRemember(lane);
      this.allocatedLanes.add(id);
      return { lane: clone(lane), reused: false };
    });
  }

  async markRunning(id: string): Promise<DelegatedWorkerLane> {
    // The caller retains the acquired snapshot for prompt selection. Withhold
    // durable initialization until restoration/dispatch confirms that context;
    // a failed fresh session can otherwise reuse an old native ID and marker.
    return this.transition(id, 'running', { shutdownConfirmedGeneration: undefined,
      nativeGroupExitGeneration: undefined, initializedPrompt: undefined });
  }

  async markPromptInitialized(id: string, sessionId: string, workspaceKind: 'git' | 'shared'): Promise<void> {
    if (!sessionId || sessionId.length > 1024) return;
    await this.transition(id, 'running', { initializedPrompt: { sessionId, workspaceKind } });
  }

  async markReady(id: string): Promise<DelegatedWorkerLane> {
    return this.transition(id, 'ready', { cleanupPending: false, cleanupError: undefined });
  }

  async markShutdownConfirmed(id: string, generation: number, processGroupConfirmed = false): Promise<void> {
    if (!validGeneration(generation)) throw new Error('Invalid worker shutdown generation');
    await this.initialize();
    await this.mutate(async () => {
      const lane = this.lanes.get(id);
      if (!lane || (lane.contextGeneration ?? 0) !== generation) {
        throw new Error('Worker context changed before shutdown confirmation');
      }
      await this.writeAndRemember({ ...lane, shutdownConfirmedGeneration: generation,
        ...(processGroupConfirmed ? { nativeGroupExitGeneration: generation } : {}), updatedAt: Date.now() });
    });
  }

  /** Creation callbacks may arrive after reset, but never replace another acquisition's identity. */
  async captureNativeSession(id: string, generation: number, target: NativeSessionDeletionTarget): Promise<void> {
    await this.initialize();
    await this.mutate(async () => {
      const lane = this.lanes.get(id);
      if (!lane || (lane.contextGeneration ?? 0) !== generation || target.executorThreadId !== lane.executorThreadId
        || !validNativeTarget(target) || lane.backend !== target.backend) throw new Error('Native worker identity changed');
      const history = lane.nativeSessionHistory ?? [];
      const previous = [lane.nativeSession, ...history].find(value => value?.sessionId === target.sessionId);
      if (previous) {
        if (previous.backend === 'claude' && target.backend === 'claude' && !previous.confirmed && target.confirmed
          && JSON.stringify({ ...previous, confirmed: true }) === JSON.stringify(target)) {
          await this.writeAndRemember({ ...lane,
            nativeSession: lane.nativeSession === previous ? structuredClone(target) : lane.nativeSession,
            nativeSessionHistory: history.map(value => value === previous ? structuredClone(target) : value), updatedAt: Date.now() });
          return;
        }
        await this.writeAndRemember({ ...lane,
          nativeSessionConflict: lane.nativeSessionConflict || JSON.stringify(previous) !== JSON.stringify(target), updatedAt: Date.now() });
        return;
      }
      const nextHistory = lane.nativeSession ? [...history, lane.nativeSession] : history;
      const next: DelegatedWorkerLane = { ...lane, nativeSession: structuredClone(target),
        nativeSessionHistory: nextHistory, updatedAt: Date.now() };
      // Reserve room for one durable preparation per identity and later status.
      if (nextHistory.length >= 64 || Buffer.byteLength(JSON.stringify(next)) + (nextHistory.length + 1) * 200 > 60 * 1024) {
        await this.writeAndRemember({ ...lane, nativeSessionConflict: true, updatedAt: Date.now() });
        throw new Error('Native worker identity history exceeded its retained metadata limit');
      }
      await this.writeAndRemember(next);
    });
  }

  async recordNativeCaptureFailure(id: string, generation: number): Promise<void> {
    await this.initialize();
    await this.mutate(async () => {
      const lane = this.lanes.get(id);
      if (!lane || (lane.contextGeneration ?? 0) !== generation) throw new Error('Native capture generation changed');
      await this.writeAndRemember({ ...lane, nativeSessionConflict: true, updatedAt: Date.now() });
    });
  }

  async recordNativeMaintenance(id: string, generation: number, unconfirmed: boolean): Promise<void> {
    await this.initialize();
    await this.mutate(async () => {
      const lane = this.lanes.get(id);
      if (!lane?.nativeDeleteRequested || (lane.contextGeneration ?? 0) !== generation) throw new Error('Native maintenance generation changed');
      await this.writeAndRemember({ ...lane, nativeMaintenanceExitUnconfirmed: unconfirmed, updatedAt: Date.now() });
    });
  }

  /** Retire exact old generations without disposing artifacts, pointers or lane evidence. */
  async requestNativeDeletion(threadId: string, throughGeneration: number): Promise<void> {
    if (!validGeneration(throughGeneration)) throw new Error('Invalid native deletion generation');
    await this.initialize();
    await this.mutate(async () => {
      this.assertCompleteInventory();
      for (const lane of this.lanes.values()) {
        if (lane.threadId !== threadId || lane.workspaceGeneration > throughGeneration || lane.nativeDeleteRequested) continue;
        await this.writeAndRemember({ ...lane, state: 'dirty', cleanupPending: false, nativeDeleteRequested: true,
          nativeDeletion: { state: 'pending', reason: 'Parent reset requested permanent native session deletion' }, updatedAt: Date.now() });
      }
    });
  }

  async nativeDeletionCandidates(includeCompleted = false): Promise<DelegatedWorkerLane[]> {
    await this.initialize();
    this.assertCompleteInventory();
    return [...this.lanes.values()].filter(lane => lane.nativeDeleteRequested && (includeCompleted || lane.nativeDeletion?.state !== 'deleted')).map(clone);
  }

  async isNativeIdentityExclusive(id: string, target: NativeSessionDeletionTarget): Promise<boolean> {
    await this.initialize();
    this.assertCompleteInventory();
    return ![...this.lanes.values()].some(lane => lane.id !== id && lane.backend === target.backend
      && (lane.nativeSession?.sessionId === target.sessionId || lane.initializedPrompt?.sessionId === target.sessionId
        || lane.nativeSessionHistory?.some(previous => previous.sessionId === target.sessionId)));
  }

  async recordNativeDeletion(id: string, generation: number, result: NativeDeletionResult): Promise<void> {
    await this.initialize();
    await this.mutate(async () => {
      const lane = this.lanes.get(id);
      if (!lane?.nativeDeleteRequested || (lane.contextGeneration ?? 0) !== generation) throw new Error('Native deletion acquisition changed');
      await this.writeAndRemember({ ...lane, nativeDeletion: result, updatedAt: Date.now() });
    });
  }

  async prepareNativeDeletion(id: string, generation: number, target: NativeSessionDeletionTarget,
    prepared: NativeDeletionPreparation): Promise<void> {
    await this.initialize();
    await this.mutate(async () => {
      const lane = this.lanes.get(id);
      if (!lane?.nativeDeleteRequested || (lane.contextGeneration ?? 0) !== generation
        || ![lane.nativeSession, ...(lane.nativeSessionHistory ?? [])].some(value =>
          value && JSON.stringify(value) === JSON.stringify(target))
        || !validDeletionPreparation(target, prepared)) {
        throw new Error('Native deletion preparation identity changed');
      }
      const previous = lane.nativeDeletionPreparations?.[target.sessionId];
      if (previous && JSON.stringify(previous) !== JSON.stringify(prepared)) throw new Error('Native deletion preparation cannot be replaced');
      const next = { ...lane, nativeDeletionPreparations: {
        ...lane.nativeDeletionPreparations, [target.sessionId]: prepared,
      }, updatedAt: Date.now() };
      if (Buffer.byteLength(JSON.stringify(next)) > 60 * 1024) throw new Error('Native deletion preparation exceeds its retained metadata limit');
      await this.writeAndRemember(next);
    });
  }

  async markDirty(id: string, error: string, cleanupPending = false): Promise<DelegatedWorkerLane | undefined> {
    await this.initialize();
    return this.mutate(async () => {
      const lane = this.lanes.get(id);
      if (!lane) return undefined;
      const next: DelegatedWorkerLane = { ...lane, state: 'dirty', cleanupPending,
        cleanupError: error.slice(0, 4_000), updatedAt: Date.now() };
      await this.writeAndRemember(next);
      return clone(next);
    });
  }

  async markCleanupFailure(id: string, error: string): Promise<void> {
    await this.initialize();
    await this.mutate(async () => {
      const lane = this.lanes.get(id);
      if (!lane) return;
      await this.writeAndRemember({ ...lane, state: 'dirty', cleanupPending: true,
        shutdownConfirmedGeneration: lane.state === 'ready' ? lane.contextGeneration ?? 0 : lane.shutdownConfirmedGeneration,
        cleanupAttempts: (lane.cleanupAttempts ?? 0) + 1, cleanupError: error.slice(0, 4_000), updatedAt: Date.now() });
    });
  }

  /**
   * Lanes eligible for optional reconciliation; check getInventoryStatus() for completeness.
   * Incomplete history is excluded, including from reclamation by listing callers.
   * Only lanes allocated by this instance remain visible in that case.
   */
  async lanesForThread(threadId: string, backend?: DelegationBackend): Promise<DelegatedWorkerLane[]> {
    await this.initialize();
    return [...this.lanes.values()]
      .filter(lane => !this.quarantinedRecords.has(`${lane.id}.json`)
        && (!this.quarantinedRecords.size || this.allocatedLanes.has(lane.id)))
      .filter(lane => lane.threadId === threadId && (!backend || lane.backend === backend))
      .map(clone);
  }

  async cleanupCandidates(): Promise<DelegatedWorkerLane[]> {
    await this.initialize();
    this.assertCompleteInventory();
    return [...this.lanes.values()].filter(lane => lane.state === 'dirty' && lane.cleanupPending && !lane.nativeDeleteRequested).map(clone);
  }

  async invalidateGeneration(threadId: string, currentGeneration: number): Promise<DelegatedWorkerLane[]> {
    await this.initialize();
    return this.mutate(async () => {
      this.assertCompleteInventory();
      const changed: DelegatedWorkerLane[] = [];
      for (const lane of this.lanes.values()) {
        if (lane.nativeDeleteRequested || lane.threadId !== threadId || lane.workspaceGeneration >= currentGeneration) continue;
        const next: DelegatedWorkerLane = { ...lane, state: 'dirty', cleanupPending: true,
          cleanupError: 'Working directory changed; delegated worker context was invalidated.', updatedAt: Date.now() };
        await this.writeAndRemember(next);
        changed.push(clone(next));
      }
      return changed;
    });
  }

  async markForReset(threadId: string, backend?: DelegationBackend): Promise<DelegatedWorkerLane[]> {
    await this.initialize();
    return this.mutate(async () => {
      this.assertCompleteInventory();
      const changed: DelegatedWorkerLane[] = [];
      for (const lane of this.lanes.values()) {
        if (lane.nativeDeleteRequested || lane.threadId !== threadId || (backend && lane.backend !== backend)) continue;
        const next: DelegatedWorkerLane = { ...lane, state: 'dirty', cleanupPending: true,
          shutdownConfirmedGeneration: lane.state === 'ready' ? lane.contextGeneration ?? 0 : lane.shutdownConfirmedGeneration,
          cleanupError: 'Delegated worker context was reset.', updatedAt: Date.now() };
        await this.writeAndRemember(next);
        changed.push(clone(next));
      }
      return changed;
    });
  }

  async remove(id: string): Promise<void> {
    if (!UUID_RE.test(id)) throw new Error('Invalid delegated worker lane ID');
    await this.initialize();
    await this.mutate(async () => {
      if (!this.lanes.has(id) || this.quarantinedRecords.has(`${id}.json`)) {
        throw new Error('Delegated worker lane is unavailable; its historical record was preserved');
      }
      if (this.lanes.get(id)?.nativeDeleteRequested) throw new Error('Native deletion receipts and artifacts must be retained');
      if (!this.allocatedLanes.has(id)) this.assertCompleteInventory();
      const lane = this.lanes.get(id)!;
      if (lane.nativeSession || lane.nativeSessionHistory?.length) {
        // Pool reset, directory changes and failed-turn cleanup may detach the
        // continuation, but parent reset still owns these native identities.
        const generation = lane.contextGeneration ?? 0;
        await this.writeAndRemember({ ...lane, state: 'dirty', contextRetired: true,
          contextResetPending: false, cleanupPending: false, initializedPrompt: undefined,
          lastClearedGeneration: generation, contextGeneration: generation + 1,
          shutdownConfirmedGeneration: lane.shutdownConfirmedGeneration === generation ? generation + 1 : undefined,
          nativeGroupExitGeneration: lane.nativeGroupExitGeneration === generation ? generation + 1 : undefined,
          nativeHistoryExitUnconfirmed: lane.nativeHistoryExitUnconfirmed || lane.nativeGroupExitGeneration !== generation,
          updatedAt: Date.now() });
        return;
      }
      await fs.rm(path.join(this.directory, `${id}.json`), { force: true });
      this.lanes.delete(id);
    });
  }

  private async transition(id: string, state: DelegatedWorkerLaneState,
    extra: Partial<Pick<DelegatedWorkerLane, 'cleanupPending' | 'cleanupError' | 'shutdownConfirmedGeneration' | 'nativeGroupExitGeneration' | 'initializedPrompt'>> = {}): Promise<DelegatedWorkerLane> {
    if (!UUID_RE.test(id)) throw new Error('Invalid delegated worker lane ID');
    await this.initialize();
    return this.mutate(async () => {
      const lane = this.lanes.get(id);
      if (!lane) throw new Error('Delegated worker lane not found');
      if (lane.contextRetired) throw new Error('The Worker context has been retired and cannot be reused.');
      if (lane.nativeDeleteRequested && state === 'running') throw new Error('Worker native context is retired for deletion');
      const next: DelegatedWorkerLane = { ...lane, ...extra, state: lane.nativeDeleteRequested ? 'dirty' : state,
        ...(lane.nativeDeleteRequested ? { cleanupPending: false } : {}), updatedAt: Date.now() };
      await this.writeAndRemember(next);
      return clone(next);
    });
  }

  async clearContext(id: string, generation: number,
    identity: Omit<DelegatedWorkerLaneIdentity, 'backend'>,
    clear: (lane: DelegatedWorkerLane) => Promise<void>): Promise<void> {
    if (!UUID_RE.test(id) || !validGeneration(generation)) throw new Error('Invalid worker context reference');
    await this.initialize();
    await this.mutate(async () => {
      this.assertCompleteInventory();
      this.assertContextReady(identity.threadId, identity.workspaceGeneration);
      await this.clearContextLocked(id, generation, identity, clear);
    });
  }

  async assertThreadContextResettable(threadId: string): Promise<void> {
    await this.initialize();
    await this.mutate(async () => { this.resettableLanes(threadId); });
  }

  /** The thread-level barrier covers all lanes, including a later lane that fails to clear. */
  async clearThreadContexts(threadId: string, clear: (lane: DelegatedWorkerLane) => Promise<void>): Promise<void> {
    await this.initialize();
    await this.mutate(async () => {
      if (!this.contextResets.isPending(threadId)) throw new Error('Thread context reset intent is missing');
      for (const lane of this.resettableLanes(threadId)) {
        await this.clearContextLocked(lane.id, lane.contextGeneration ?? 0, lane, clear);
      }
    });
  }

  private resettableLanes(threadId: string): DelegatedWorkerLane[] {
    this.assertCompleteInventory();
    const lanes = [...this.lanes.values()].filter(lane => lane.threadId === threadId);
    if (lanes.some(lane => !contextResettable(lane))) {
      throw new Error('Cannot clear thread context: a Worker is active or its shutdown is unconfirmed. Wait for confirmed exit before retrying /clear.');
    }
    return lanes.filter(lane => !lane.contextRetired);
  }

  private async clearContextLocked(id: string, generation: number,
    identity: Omit<DelegatedWorkerLaneIdentity, 'backend'>,
    clear: (lane: DelegatedWorkerLane) => Promise<void>): Promise<void> {
    const lane = this.lanes.get(id);
    if (!lane || lane.threadId !== identity.threadId || lane.workingDirectory !== identity.workingDirectory
      || lane.workspaceGeneration !== identity.workspaceGeneration) {
      throw new Error('This Worker card has expired. Use the latest Worker card.');
    }
    const current = lane.contextGeneration ?? 0;
    if (current !== generation) {
      if (lane.lastClearedGeneration === generation) return;
      throw new Error('The Worker context has changed. Use the latest Worker card.');
    }
    if (lane.nativeDeleteRequested || lane.contextRetired || !contextResettable(lane)) {
      throw new Error('The Worker is active or its shutdown is unconfirmed. Wait before clearing context.');
    }
    const recoveryHeld = lane.state === 'dirty' && shutdownConfirmed(lane);
    // Persist intent before unlinking. A crash or partial failure must never resume old context.
    const pending: DelegatedWorkerLane = { ...lane, state: 'dirty', contextResetPending: true,
      nativeHistoryExitUnconfirmed: lane.nativeHistoryExitUnconfirmed ||
        (!!lane.nativeSession || !!lane.nativeSessionHistory?.length) && lane.nativeGroupExitGeneration !== current,
      updatedAt: Date.now() };
    await this.writeAndRemember(pending);
    await clear(clone(pending));
    // A failed reset can be superseded by a new shared-directory lane. Clearing
    // the old pointer must not revive it or authorize deleting its replacement.
    // Legacy lanes have no mode; preserve them conservatively when ambiguous.
    const superseded = lane.pooled !== true && [...this.lanes.values()].some(other =>
      other.id !== lane.id && sameIdentity(other, lane) && other.state !== 'dirty');
    const retired = superseded || recoveryHeld;
    await this.writeAndRemember({ ...pending, state: retired ? 'dirty' : 'ready', contextGeneration: current + 1,
      shutdownConfirmedGeneration: recoveryHeld ? current + 1 : undefined,
      contextResetPending: false, lastClearedGeneration: generation, initializedPrompt: undefined,
      nativeGroupExitGeneration: lane.nativeGroupExitGeneration === current ? current + 1 : undefined,
      nativeSession: undefined,
      nativeSessionHistory: lane.nativeSession
        ? [...(lane.nativeSessionHistory ?? []), lane.nativeSession] : lane.nativeSessionHistory,
      contextRetired: retired ? true : undefined,
      cleanupError: recoveryHeld ? lane.cleanupError
        : superseded ? 'Worker context cleared; a replacement lane remains active.' : undefined,
      updatedAt: Date.now() });
  }

  private async load(): Promise<void> {
    // Per-record failures quarantine history, not independent fresh allocation.
    // Directory failures still reject admission; no partial directory scan is used.
    const loaded = new Map<string, DelegatedWorkerLane>();
    try {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const names = await fs.readdir(this.directory);
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        try {
          if (!UUID_RE.test(name.slice(0, -5))) throw new Error('Invalid worker lane filename');
          const file = path.join(this.directory, name);
          const stat = await fs.lstat(file);
          if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('Invalid worker lane file');
          const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
          if (!validateLane(parsed) || name !== `${parsed.id}.json`) throw new Error('Invalid worker lane record');
          const lane = parsed;
          const id = lane.id;
          if (await hasLegacyDiscardTombstone(this.directory, id)) {
            const retired: DelegatedWorkerLane = { ...lane, state: 'dirty', workspaceDiscarded: true,
              cleanupPending: false, cleanupError: 'Historical checkout was explicitly discarded; native history is preserved.', updatedAt: Date.now() };
            await this.writeRecord(retired);
            loaded.set(id, retired);
            continue;
          }
          // A process may have died between any write and terminal confirmation.
          // Only a ready lane is resumable after a CLI restart.
          if (lane.state === 'preparing' || lane.state === 'running') {
            const dirty: DelegatedWorkerLane = { ...lane, state: 'dirty', cleanupPending: lane.cleanupPending === true,
              cleanupError: lane.cleanupError ?? 'The CLI stopped before worker cleanup was confirmed.', updatedAt: Date.now() };
            await this.writeRecord(dirty);
            loaded.set(id, dirty);
          } else {
            loaded.set(id, lane);
          }
        } catch { this.quarantine(name); }
      }
    } catch (cause) {
      // Missing records during enumeration are also uncertain. Retry a fresh
      // inventory rather than accepting a partial snapshot or rewriting it.
      throw new Error('Cannot load delegated worker inventory. Check local CLI storage and repair unreadable or invalid lane records before retrying /clear.', { cause });
    }
    for (const [id, lane] of loaded) this.lanes.set(id, lane);
  }

  private assertIdentity(identity: DelegatedWorkerLaneIdentity): void {
    if (!identity.threadId || identity.threadId.length > 200
      || !DELEGATION_BACKENDS.includes(identity.backend)
      || !path.isAbsolute(identity.workingDirectory)
      || !validGeneration(identity.workspaceGeneration)) {
      throw new Error('Invalid delegated worker lane identity');
    }
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writes.catch(() => undefined).then(operation);
    this.writes = next.then(() => undefined, () => undefined);
    return next;
  }

  private async writeAndRemember(lane: DelegatedWorkerLane): Promise<void> {
    if (this.quarantinedRecords.has(`${lane.id}.json`)) {
      throw new Error('Delegated worker lane is quarantined; its historical record was preserved');
    }
    await this.writeRecord(lane);
    this.lanes.set(lane.id, lane);
  }

  private async writeRecord(lane: DelegatedWorkerLane): Promise<void> {
    if (!validateLane(lane)) throw new Error('Invalid delegated worker lane record');
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, `${lane.id}.json`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const serialized = JSON.stringify(lane);
      if (Buffer.byteLength(serialized) > 64 * 1024) throw new Error('Delegated worker record exceeds its retained metadata limit');
      // Windows FlushFileBuffers requires a writable handle. Keep the exclusive
      // creation handle through writing and syncing, before publishing the record.
      const handle = await fs.open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(serialized);
        if (lane.nativeSession || lane.nativeSessionHistory?.length || lane.nativeDeleteRequested || lane.nativeGroupExitGeneration !== undefined) {
          await handle.sync();
        }
      } finally { await handle.close(); }
      await replaceAtomicFile(temporary, file);
      if (lane.nativeSession || lane.nativeSessionHistory?.length || lane.nativeDeleteRequested || lane.nativeGroupExitGeneration !== undefined) syncDirectory(this.directory);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
