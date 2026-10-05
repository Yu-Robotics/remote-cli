import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { DELEGATION_BACKENDS, type DelegationBackend } from './contract';

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
  cleanupAttempts?: number;
  cleanupError?: string;
  contextGeneration?: number;
  contextResetPending?: boolean;
  lastClearedGeneration?: number;
  pooled?: boolean;
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
  return { ...lane };
}

function sameIdentity(lane: DelegatedWorkerLane, identity: DelegatedWorkerLaneIdentity): boolean {
  return lane.threadId === identity.threadId
    && lane.backend === identity.backend
    && lane.workingDirectory === identity.workingDirectory
    && lane.workspaceGeneration === identity.workspaceGeneration;
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
    && (lane.cleanupPending === undefined || typeof lane.cleanupPending === 'boolean')
    && (lane.cleanupAttempts === undefined || validGeneration(lane.cleanupAttempts))
    && (lane.contextGeneration === undefined || validGeneration(lane.contextGeneration))
    && (lane.lastClearedGeneration === undefined || validGeneration(lane.lastClearedGeneration))
    && (lane.contextResetPending === undefined || typeof lane.contextResetPending === 'boolean')
    && (lane.pooled === undefined || typeof lane.pooled === 'boolean')
    && (lane.cleanupError === undefined || typeof lane.cleanupError === 'string');
}

/**
 * Durable lane metadata. Native backend transcripts remain owned by each
 * backend; this store only decides whether a native pointer is safe to reuse.
 */
export class DelegatedWorkerSessionStore {
  private initialized?: Promise<void>;
  private readonly lanes = new Map<string, DelegatedWorkerLane>();
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly directory = path.join(os.homedir(), '.remote-cli', 'delegation-workers')) {}

  initialize(): Promise<void> {
    return this.initialized ??= this.load();
  }

  async acquire(identity: DelegatedWorkerLaneIdentity,
    options: { pooled?: boolean; excluded?: ReadonlySet<string> } = {}): Promise<DelegatedWorkerLaneAcquireResult> {
    this.assertIdentity(identity);
    await this.initialize();
    return this.mutate(async () => {
      const ready = [...this.lanes.values()]
        .filter(lane => lane.state === 'ready' && sameIdentity(lane, identity) && !options.excluded?.has(lane.id))
        .sort((a, b) => b.updatedAt - a.updatedAt);

      // Shared-directory lanes keep the legacy single-ready invariant. Isolated
      // worktree pools legitimately contain multiple ready conversations.
      if (ready.length > 1 && !options.pooled) {
        for (const duplicate of ready) await this.writeAndRemember({ ...duplicate,
          state: 'dirty', cleanupPending: false, updatedAt: Date.now(),
          cleanupError: 'Multiple delegated worker lanes matched one identity.' });
      } else if (ready.length >= 1) {
        const lane = { ...ready[0], state: 'preparing' as const, updatedAt: Date.now(),
          contextGeneration: (ready[0].contextGeneration ?? 0) + 1, pooled: options.pooled === true };
        await this.writeAndRemember(lane);
        return { lane: clone(lane), reused: true };
      }

      const now = Date.now();
      const id = randomUUID();
      const lane: DelegatedWorkerLane = {
        id,
        executorThreadId: workerLaneExecutorId(id),
        ...identity,
        pooled: options.pooled === true,
        state: 'preparing',
        createdAt: now,
        updatedAt: now,
      };
      await this.writeAndRemember(lane);
      return { lane: clone(lane), reused: false };
    });
  }

  async markRunning(id: string): Promise<DelegatedWorkerLane> {
    return this.transition(id, 'running');
  }

  async markReady(id: string): Promise<DelegatedWorkerLane> {
    return this.transition(id, 'ready', { cleanupPending: false, cleanupError: undefined });
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
        cleanupAttempts: (lane.cleanupAttempts ?? 0) + 1, cleanupError: error.slice(0, 4_000), updatedAt: Date.now() });
    });
  }

  async lanesForThread(threadId: string, backend?: DelegationBackend): Promise<DelegatedWorkerLane[]> {
    await this.initialize();
    return [...this.lanes.values()]
      .filter(lane => lane.threadId === threadId && (!backend || lane.backend === backend))
      .map(clone);
  }

  async cleanupCandidates(): Promise<DelegatedWorkerLane[]> {
    await this.initialize();
    return [...this.lanes.values()].filter(lane => lane.state === 'dirty' && lane.cleanupPending).map(clone);
  }

  async invalidateGeneration(threadId: string, currentGeneration: number): Promise<DelegatedWorkerLane[]> {
    await this.initialize();
    return this.mutate(async () => {
      const changed: DelegatedWorkerLane[] = [];
      for (const lane of this.lanes.values()) {
        if (lane.threadId !== threadId || lane.workspaceGeneration >= currentGeneration) continue;
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
      const changed: DelegatedWorkerLane[] = [];
      for (const lane of this.lanes.values()) {
        if (lane.threadId !== threadId || (backend && lane.backend !== backend)) continue;
        const next: DelegatedWorkerLane = { ...lane, state: 'dirty', cleanupPending: true,
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
      this.lanes.delete(id);
      await fs.rm(path.join(this.directory, `${id}.json`), { force: true });
    });
  }

  private async transition(id: string, state: DelegatedWorkerLaneState,
    extra: Partial<Pick<DelegatedWorkerLane, 'cleanupPending' | 'cleanupError'>> = {}): Promise<DelegatedWorkerLane> {
    if (!UUID_RE.test(id)) throw new Error('Invalid delegated worker lane ID');
    await this.initialize();
    return this.mutate(async () => {
      const lane = this.lanes.get(id);
      if (!lane) throw new Error('Delegated worker lane not found');
      const next: DelegatedWorkerLane = { ...lane, ...extra, state, updatedAt: Date.now() };
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
      if (lane.cleanupPending || (lane.state !== 'ready' && !(lane.state === 'dirty' && lane.contextResetPending))) {
        throw new Error('The Worker is active or its shutdown is unconfirmed. Wait before clearing context.');
      }
      // Persist intent before unlinking. A crash or partial failure must never resume old context.
      const pending: DelegatedWorkerLane = { ...lane, state: 'dirty', contextResetPending: true, updatedAt: Date.now() };
      await this.writeAndRemember(pending);
      await clear(clone(pending));
      // A failed reset can be superseded by a new shared-directory lane. Clearing
      // the old pointer must not revive it or authorize deleting its replacement.
      // Legacy lanes have no mode; preserve them conservatively when ambiguous.
      const superseded = lane.pooled !== true && [...this.lanes.values()].some(other =>
        other.id !== lane.id && sameIdentity(other, lane) && other.state !== 'dirty');
      await this.writeAndRemember({ ...pending, state: superseded ? 'dirty' : 'ready', contextGeneration: current + 1,
        contextResetPending: false, lastClearedGeneration: generation,
        cleanupError: superseded ? 'Worker context cleared; a replacement lane remains active.' : undefined,
        updatedAt: Date.now() });
    });
  }

  private async load(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    let names: string[] = [];
    try { names = await fs.readdir(this.directory); } catch { return; }
    for (const name of names) {
      if (!UUID_RE.test(name.replace(/\.json$/, '')) || !name.endsWith('.json')) continue;
      const file = path.join(this.directory, name);
      try {
        const stat = await fs.stat(file);
        if (stat.size > 64 * 1024) continue;
        const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
        if (!validateLane(parsed)) continue;
        const lane = parsed;
        // A process may have died between any write and terminal confirmation.
        // Only a ready lane is resumable after a CLI restart.
        if (lane.state !== 'ready') {
          const dirty: DelegatedWorkerLane = { ...lane, state: 'dirty', cleanupPending: lane.cleanupPending === true,
            cleanupError: lane.cleanupError ?? 'The CLI stopped before worker cleanup was confirmed.', updatedAt: Date.now() };
          await this.writeRecord(dirty);
          this.lanes.set(dirty.id, dirty);
        } else this.lanes.set(lane.id, lane);
      } catch {
        // A corrupt lane cannot become resumable.
      }
    }
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
    await this.writeRecord(lane);
    this.lanes.set(lane.id, lane);
  }

  private async writeRecord(lane: DelegatedWorkerLane): Promise<void> {
    if (!validateLane(lane)) throw new Error('Invalid delegated worker lane record');
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, `${lane.id}.json`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(lane), { mode: 0o600 });
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
