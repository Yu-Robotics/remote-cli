import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateScheduleId, validateSchedulePrompt, validateScheduleRule } from './ScheduleCommand';
import type { NativeScheduleEvent, NativeScheduleHandle, NativeScheduleInput, NativeScheduleProvider,
  ScheduleDelivery, ScheduleOwner, ScheduleRecord, ScheduleRule, ScheduleRecoveryCheckpoint } from './types';
import { NativeScheduleCleanupError } from './types';
import { assertNativeScheduleBackend, isNativeScheduleBackend } from './ScheduleCapabilities';

export const SCHEDULE_CATALOG_FILE = 'schedule-catalog.json';
const OUTPUT_BYTES = 16 * 1024;
const ERROR_BYTES = 4096;
const LIVE = new Set<ScheduleRecord['state']>(['creating', 'active', 'running']);
const STATES = new Set<ScheduleRecord['state']>([...LIVE, 'completed', 'cancelled', 'interrupted', 'failed']);
const RESTART_REASON = 'Native schedule interrupted by service restart; not recreated or resumed.';

export interface ScheduleServiceOptions {
  directory: string;
  provider: NativeScheduleProvider;
  /** Reject when disconnected or not delivered. Success is not an exactly-once receipt. */
  deliver: (delivery: ScheduleDelivery) => Promise<void>;
  isOwnerCurrent: (owner: ScheduleOwner) => boolean;
  now?: () => number;
  /** Current configuration/directory/session policy, checked before native recovery. */
  canRecover?: (record: ScheduleRecord) => boolean;
  recoveryTimeoutMs?: number;
  /** Hold foreground admission until reconciliation or confirmed cleanup finishes. */
  acquireRecovery?: (record: ScheduleRecord) => () => void;
  maxLiveSchedules?: number;
  maxRecords?: number;
  maxPendingDeliveries?: number;
  maxOccurrencesPerSchedule?: number;
}

interface PendingDelivery {
  id: string;
  scheduleId: string;
  occurrenceId: string;
  afterCancellation?: boolean;
  success: boolean;
  output?: string;
  error?: string;
}

interface Runtime {
  handle?: NativeScheduleHandle;
  ready: Promise<NativeScheduleHandle | undefined>;
  resolveReady: (handle: NativeScheduleHandle | undefined) => void;
  running: Set<string>;
  completed: Set<string>;
  heldDeliveries: Set<string>;
  cancelling: boolean;
  cancelPromise?: Promise<ScheduleRecord>;
  stopPromise?: Promise<void>;
  stopped: boolean;
  recoveryAbort?: AbortController;
  releasing?: boolean;
  releasePromise?: ReturnType<NonNullable<NativeScheduleHandle['releaseForRestart']>>;
  releaseAdmission?: () => void;
}

function bounded(value: string, limit: number): string {
  if (Buffer.byteLength(value, 'utf8') <= limit) return value;
  const marker = '\n[Truncated]';
  return Buffer.from(value).subarray(0, limit - Buffer.byteLength(marker)).toString('utf8').replace(/\uFFFD$/, '') + marker;
}

function errorText(error: unknown): string {
  return bounded(error instanceof Error ? error.message : 'Native schedule operation failed.', ERROR_BYTES);
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) throw new Error('Invalid schedule catalog object.');
  return value as Record<string, unknown>;
}

function text(value: unknown, max = 256): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value)
    || Buffer.byteLength(value) > max) throw new Error('Invalid schedule identifier or path.');
}

function ownerOf(record: ScheduleOwner): ScheduleOwner {
  return { threadId: record.threadId, openId: record.openId, generation: record.generation };
}

function validateOwner(owner: ScheduleOwner): void {
  if (!owner || typeof owner !== 'object') throw new Error('Invalid schedule owner.');
  text(owner.threadId); text(owner.openId); text(owner.generation);
}

function sameOwner(left: ScheduleOwner, right: ScheduleOwner): boolean {
  return left.threadId === right.threadId && left.openId === right.openId && left.generation === right.generation;
}

/** Terminal intent prevents recreation, but uncertain native cleanup still owns admission. */
function recoveryOwnsWork(record: ScheduleRecord): boolean {
  return !!record.recovery && (!['completed', 'cancelled'].includes(record.state)
    || !!record.error?.startsWith('Native process exit unconfirmed:'));
}

function deliveryId(scheduleId: string, occurrenceId: string): string {
  return `${scheduleId}:${occurrenceId}`;
}

/**
 * Single service instance per directory. Native processes, never this service, own timing.
 * Delivery is fenced immediately before invoking the callback; an external send already
 * in flight cannot be revoked. A crash between sending and persisting acknowledgement
 * can replay an outbox entry after explicit reconnect. Consumers receive a stable ID.
 */
export class ScheduleService {
  private readonly options: ScheduleServiceOptions;
  private readonly maxLive: number;
  private readonly maxRecords: number;
  private readonly maxPending: number;
  private readonly maxOccurrences: number;
  private readonly now: () => number;
  private records = new Map<string, ScheduleRecord>();
  private pending = new Map<string, PendingDelivery>();
  private runtimes = new Map<string, Runtime>();
  private tail: Promise<unknown> = Promise.resolve();
  private deliveryTail: Promise<unknown> = Promise.resolve();
  private tasks = new Set<Promise<unknown>>();
  private operations = new Set<Promise<unknown>>();
  private initialization?: Promise<void>;
  private initialized = false;
  private closing = false;
  private destruction?: Promise<void>;
  private fault?: Error;
  private catalogPath = '';
  private recoveryRun?: Promise<void>;
  private suspending = false;
  private handoffUnresolved = false;
  private suspension?: Promise<void>;

  constructor(options: ScheduleServiceOptions) {
    this.options = { ...options };
    this.now = options.now ?? Date.now;
    const limit = (value: number | undefined, fallback: number, ceiling: number): number => {
      const result = value ?? fallback;
      if (!Number.isInteger(result) || result < 1 || result > ceiling) throw new Error('Invalid schedule capacity.');
      return result;
    };
    if (options.recoveryTimeoutMs !== undefined && (!Number.isInteger(options.recoveryTimeoutMs)
      || options.recoveryTimeoutMs < 1 || options.recoveryTimeoutMs > 60_000)) throw new Error('Invalid recovery timeout.');
    this.maxLive = limit(options.maxLiveSchedules, 5, 5);
    this.maxRecords = limit(options.maxRecords, 100, 1000);
    this.maxPending = limit(options.maxPendingDeliveries, 100, 1000);
    this.maxOccurrences = limit(options.maxOccurrencesPerSchedule, 1000, 10_000);
  }

  initialize(): Promise<void> {
    if (this.closing) return Promise.reject(new Error('Schedule service is closed.'));
    return this.initialization ??= this.serial(async () => {
      await fs.mkdir(this.options.directory, { recursive: true, mode: 0o700 });
      const directory = await fs.realpath(this.options.directory);
      this.catalogPath = path.join(directory, SCHEDULE_CATALOG_FILE);
      const data = await this.readCatalog();
      if (data !== undefined) this.load(data);
      let changed = false;
      for (const record of this.records.values()) {
        if (['completed', 'cancelled', 'failed'].includes(record.state)) {
          if (record.recovery?.status === 'pending') { record.recovery.status = 'blocked'; changed = true; }
          continue; // Terminal tombstones always win over a stale recovery checkpoint.
        }
        if (LIVE.has(record.state) || record.recovery?.status === 'pending') {
          const recoverable = record.recovery && !record.cancelRequested && this.current(record)
            && record.state !== 'running' && record.state !== 'failed'
            && (!record.recovery.orderlyOnly || record.recovery.handoff === 'clean')
            && (record.state === 'active' || record.recovery.status === 'pending');
          if (record.recovery) record.recovery.status = recoverable ? 'pending' : 'blocked';
          record.error = recoverable ? 'Waiting for native recovery capability and owner readiness.'
            : record.recovery?.orderlyOnly ? 'Dirty shutdown: original native work is unconfirmed; automatic reconstruction is blocked.' : RESTART_REASON;
          record.state = 'interrupted'; changed = true;
        }
      }
      for (const [id, delivery] of this.pending) {
        const record = this.records.get(delivery.scheduleId)!;
        if (record.state === 'cancelled' && !delivery.afterCancellation || !this.current(record)) { this.pending.delete(id); changed = true; }
      }
      if (changed || data === undefined) await this.persist();
      this.initialized = true;
    });
  }

  /** Sequential startup/reconnect reconciliation. Never drives the native schedule clock. */
  recover(): Promise<void> {
    this.checkReady();
    if (this.recoveryRun) return this.recoveryRun;
    const run = this.operation(this.recoverWaiting());
    this.recoveryRun = run;
    void run.finally(() => { if (this.recoveryRun === run) this.recoveryRun = undefined; }).catch(() => {});
    return run;
  }

  private async recoverWaiting(): Promise<void> {
    const candidates = await this.serial(async () => [...this.records.values()]
      .filter(record => record.recovery?.status === 'pending' && record.state === 'interrupted').map(record => record.id));
    // Catalog capacity is bounded, and only one native admission runs at a time.
    for (const id of candidates.slice(0, this.maxLive)) {
      if (this.closing || this.fault) return;
      const record = this.records.get(id)!;
      if (record.cancelRequested || !this.current(record)) {
        await this.blockRecovery(record, 'Recovery owner retired or cancellation was requested.'); continue;
      }
      if (record.rule.kind === 'once' && Date.parse(record.rule.at) <= this.now()) {
        await this.blockRecovery(record, 'One-shot deadline expired; no late execution was requested.');
        if (record.recovery?.handoff === 'clean' && record.recovery.nativeDefinitionAbsent) await this.serial(async () => { delete record.recovery; await this.persist(); });
        continue;
      }
      const input: NativeScheduleInput = { id, threadId: record.threadId, backend: record.backend,
        cwd: record.cwd, prompt: record.prompt, rule: structuredClone(record.rule), ...record.execution,
        recovery: this.checkpoint(record.recovery!) };
      if (!this.options.canRecover || !this.options.canRecover(structuredClone(record))) {
        await this.recoveryDiagnostic(record, 'Original owner configuration or transport is not ready for recovery.'); continue;
      }
      const provider = this.options.provider.recoveryFor?.(input);
      if (!provider || provider.provider !== record.recovery!.provider || provider.strategy !== record.recovery!.strategy
        || (provider.handoffPolicy ?? 'drain-all') !== (record.recovery!.handoffPolicy ?? 'drain-all')) {
        await this.recoveryDiagnostic(record, 'Native restart recovery is unsupported or provider identity changed.'); continue;
      }
      if (this.runtimes.has(id)) continue; // An unresolved/late operation retains exclusive ownership.
      const restoreRecord = structuredClone(record);
      const runtime = this.newRuntime();
      runtime.completed = new Set(record.completedOccurrences);
      const controller = new AbortController(); runtime.recoveryAbort = controller;
      this.runtimes.set(id, runtime);
      const current = () => !controller.signal.aborted && !this.closing && !this.fault && !record.cancelRequested
        && this.current(record) && this.options.canRecover?.(structuredClone(record)) === true;
      const emit = (event: NativeScheduleEvent) => {
        if (this.runtimes.get(id) !== runtime) return;
        this.track(this.onEvent(id, structuredClone(event)));
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      let admitted = false;
      let succeeded = false;
      try {
        runtime.releaseAdmission = this.options.acquireRecovery?.(structuredClone(record));
        await this.serial(async () => {
          if (!current()) throw new Error('Recovery admission expired.');
          // Consume clean proof before mutation. A crash must not replay an orderly-only restore.
          record.state = 'creating'; delete record.recovery!.handoff; delete record.recovery!.nativeDefinitionAbsent; await this.persist();
        });
        admitted = true;
        const admission = Promise.resolve().then(() => provider.reconcile(restoreRecord,
          { notBefore: this.now(), signal: controller.signal, isCurrent: current,
            isOwnerCurrent: () => !record.cancelRequested && !this.fault && this.current(record) }, emit));
        const adopt = async (handle: NativeScheduleHandle) => {
          runtime.handle = handle; runtime.resolveReady(handle);
          text(handle.nativeId);
          await this.serial(async () => { record.nativeId = handle.nativeId; if (!this.fault) await this.persist(); });
        };
        const receipt = admission.then(async handle => {
          await adopt(handle);
          if (!current()) { await this.stop(id, runtime); throw new Error('Late recovery receipt requires cleanup; no successor was admitted.'); }
          if (!await handle.list() || !current()) throw new Error('Recovered native inventory or owner is unconfirmed.');
          return handle;
        }, async error => {
          if (error instanceof NativeScheduleCleanupError) {
            await adopt(error.handle);
            if (controller.signal.aborted) await this.stop(id, runtime).catch(() => {});
          }
          runtime.resolveReady(runtime.handle);
          // A rejection without a handle is not proof that native admission never happened.
          throw error;
        });
        const handle = await Promise.race([receipt, new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error('Native recovery timed out; ownership retained, do not recreate.')); },
            this.options.recoveryTimeoutMs ?? 30_000);
        })]);
        text(handle.nativeId);
        // The provider's reconcile contract includes inventory validation; list is
        // additionally required to verify the returned handle before activating it.
        if (!current()) throw new Error('Recovered native owner is unconfirmed.');
        await this.serial(async () => {
          if (!current()) throw new Error('Recovery owner retired before receipt persistence.');
          record.nativeId = handle.nativeId;
          if (record.state === 'creating') record.state = 'active';
          record.recovery!.status = 'eligible'; delete record.error;
          await this.persist();
        });
        succeeded = true;
      } catch (error) {
        controller.abort();
        if (!admitted) { runtime.stopped = true; runtime.resolveReady(undefined); }
        // Do not retry an ambiguous mutation or release its handle on a timeout.
        await this.blockRecovery(record, errorText(error));
        if (runtime.handle) await this.stop(id, runtime).catch(() => {});
        else if (runtime.stopped) this.runtimes.delete(id);
      } finally {
        if (timer) clearTimeout(timer);
        if (succeeded || runtime.stopped) {
          runtime.releaseAdmission?.(); runtime.releaseAdmission = undefined;
        }
      }
    }
    // A handoff containing only skipped/expired one-shots has nothing to
    // reconcile. It must still release the predecessor's local input fence.
    const released = new Set<string>();
    for (const record of this.records.values()) {
      if (released.has(record.threadId) || this.closing || this.fault || this.handoffUnresolved
        || !this.current(record) || !this.options.canRecover?.(structuredClone(record))) continue;
      if ([...this.records.values()].some(other => other.threadId === record.threadId
        && (LIVE.has(other.state) || recoveryOwnsWork(other) || this.runtimes.has(other.id)))) continue;
      this.options.provider.recoveryFor?.({ id: record.id, threadId: record.threadId, backend: record.backend,
        cwd: record.cwd, prompt: record.prompt, rule: record.rule, ...record.execution })?.releaseRestartAdmission?.();
      released.add(record.threadId);
    }
  }

  private checkpoint(value: ScheduleRecoveryCheckpoint): ScheduleRecoveryCheckpoint {
    return { version: 1, provider: value.provider, strategy: value.strategy, identity: value.identity,
      ...(value.orderlyOnly && { orderlyOnly: true }), ...(value.handoffPolicy && { handoffPolicy: value.handoffPolicy }), ...(value.handoff && { handoff: value.handoff }),
      ...(value.nativeDefinitionAbsent && { nativeDefinitionAbsent: true }) };
  }

  private validateCheckpoint(value: any): void {
    if (value.version !== 1 || !['reattach', 'reconstruct'].includes(value.strategy)) throw new Error('Invalid recovery checkpoint.');
    if (value.orderlyOnly !== undefined && value.orderlyOnly !== true || value.handoff !== undefined && value.handoff !== 'clean') throw new Error('Invalid handoff evidence.');
    if (value.nativeDefinitionAbsent !== undefined && (value.nativeDefinitionAbsent !== true || value.handoff !== 'clean')) throw new Error('Invalid native absence evidence.');
    if (value.handoffPolicy !== undefined && !['drain-all', 'skip-unadmitted'].includes(value.handoffPolicy)) throw new Error('Invalid handoff policy.');
    text(value.provider); text(value.identity, 8192);
  }

  private async recoveryDiagnostic(record: ScheduleRecord, reason: string): Promise<void> {
    await this.serial(async () => { record.error = reason; await this.persist(); });
  }

  private async blockRecovery(record: ScheduleRecord, reason: string): Promise<void> {
    await this.serial(async () => {
      if (!['completed', 'cancelled'].includes(record.state)) record.state = 'interrupted';
      record.recovery!.status = 'blocked'; record.error = reason;
      if (!this.fault) await this.persist();
    });
  }

  create(owner: ScheduleOwner, input: NativeScheduleInput): Promise<ScheduleRecord> {
    return this.operation(this.createSchedule(owner, input));
  }

  private async createSchedule(owner: ScheduleOwner, input: NativeScheduleInput): Promise<ScheduleRecord> {
    this.checkReady();
    const backend = input.backend === undefined ? 'claude' : input.backend;
    assertNativeScheduleBackend(backend);
    const createdAt = this.now();
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error('Invalid schedule clock.');
    validateOwner(owner);
    validateScheduleId(input.id);
    validateSchedulePrompt(input.prompt);
    validateScheduleRule(input.rule, createdAt);
    text(input.cwd, 4096);
    if (!path.isAbsolute(input.cwd)) throw new Error('Schedule working directory must be absolute.');
    const originalOwner = ownerOf(owner);
    const nativeInput = { ...structuredClone(input), backend, threadId: owner.threadId };
    // Never trust a caller-supplied provider checkpoint.
    delete nativeInput.recovery;
    for (const value of [input.command, input.model, input.effort]) if (value !== undefined) text(value, 4096);
    const recovery = this.options.provider.recoveryFor?.(nativeInput);
    if (recovery) {
      nativeInput.recovery = { version: 1, provider: recovery.provider, strategy: recovery.strategy,
        identity: recovery.describe(structuredClone(nativeInput), originalOwner), ...(recovery.orderlyOnly && { orderlyOnly: true }), ...(recovery.handoffPolicy && { handoffPolicy: recovery.handoffPolicy }) };
      this.validateCheckpoint(nativeInput.recovery);
    }
    const runtime = this.newRuntime();
    await this.serial(async () => {
      this.checkReady();
      if (!this.current(originalOwner)) throw new Error('Schedule owner is no longer current.');
      if (this.records.has(nativeInput.id)) throw new Error('Schedule ID already exists.');
      if (this.records.size >= this.maxRecords) throw new Error('Schedule catalog is full; history was not pruned.');
      const liveCount = [...this.records.values()].filter(record => LIVE.has(record.state)
        || recoveryOwnsWork(record)
        || (this.runtimes.has(record.id) && !this.runtimes.get(record.id)!.stopped)).length;
      if (liveCount >= this.maxLive) throw new Error('Live native schedule limit reached.');
      this.records.set(nativeInput.id, { ...originalOwner, id: nativeInput.id, backend,
        cwd: nativeInput.cwd, prompt: nativeInput.prompt, rule: structuredClone(nativeInput.rule),
        createdAt, state: 'creating', execution: { command: input.command, model: input.model, effort: input.effort },
        ...(nativeInput.recovery && { recovery: { ...nativeInput.recovery, status: 'eligible' } }) });
      await this.persist();
      this.runtimes.set(nativeInput.id, runtime);
    });
    try {
      const handle = await this.options.provider.create(structuredClone(nativeInput), event => {
        if (this.runtimes.get(nativeInput.id) !== runtime) return;
        const task = this.onEvent(nativeInput.id, structuredClone(event));
        this.track(task);
      });
      runtime.handle = handle;
      runtime.resolveReady(handle);
      text(handle.nativeId);
      await this.serial(async () => {
        const record = this.records.get(nativeInput.id)!;
        record.nativeId = handle.nativeId;
        if (record.recovery && handle.recoveryIdentity) { text(handle.recoveryIdentity, 8192); record.recovery.identity = handle.recoveryIdentity; }
        const ownerCurrent = this.current(originalOwner);
        if (this.closing || !ownerCurrent) {
          if (LIVE.has(record.state)) { record.state = 'interrupted'; record.error = 'Schedule owner or service retired during creation.'; }
          if (!ownerCurrent) this.dropPending(record.id);
        } else if (record.state === 'creating') record.state = 'active';
        await this.persist();
      });
      const record = this.records.get(nativeInput.id)!;
      if (!LIVE.has(record.state) && !runtime.cancelling) await this.stop(nativeInput.id, runtime);
      return structuredClone(this.records.get(nativeInput.id)!);
    } catch (error) {
      if (error instanceof NativeScheduleCleanupError) runtime.handle = error.handle;
      runtime.resolveReady(runtime.handle);
      await this.serial(async () => {
        const record = this.records.get(nativeInput.id)!;
        if (LIVE.has(record.state)) { record.state = 'failed'; record.error = errorText(error); }
        if (!this.fault) await this.persist();
      });
      if (runtime.handle) await this.stop(nativeInput.id, runtime).catch(() => {});
      else runtime.stopped = true;
      throw error;
    }
  }

  /** Catalog lookup only; this does not probe or recreate native jobs. */
  async list(owner: ScheduleOwner): Promise<ScheduleRecord[]> {
    this.checkReady(); validateOwner(owner);
    return this.serial(async () => [...this.records.values()].filter(record => sameOwner(record, owner)).map(record => structuredClone(record)));
  }

  /** Includes terminal jobs whose native process exit is still unconfirmed. */
  hasActiveSchedules(threadId?: string): boolean {
    return [...this.records.values()].some(record => (!threadId || record.threadId === threadId)
      && (LIVE.has(record.state) || recoveryOwnsWork(record) || (this.runtimes.has(record.id) && !this.runtimes.get(record.id)!.stopped)));
  }

  /** Card eligibility includes retryable cleanup even for a terminal catalog record. */
  canCancel(owner: ScheduleOwner, id: string): boolean {
    this.checkReady();
    const record = this.owned(owner, id);
    const runtime = this.runtimes.get(id);
    if (record.state === 'cancelled' && runtime?.handle?.cancellationKeepsRunning && !record.error) return false;
    return LIVE.has(record.state) || recoveryOwnsWork(record) || Boolean(runtime && !runtime.stopped);
  }

  /** Keep admitted native work visible when cleanup cannot safely acquire its host. */
  async retainCleanupError(owner: ScheduleOwner, id: string, error: unknown): Promise<void> {
    this.checkReady(); validateOwner(owner); validateScheduleId(id);
    await this.serial(async () => {
      const record = this.owned(owner, id);
      if (this.runtimes.get(id)?.stopped) return;
      record.error = errorText(error);
      await this.persist();
    });
  }

  /** User-requested native reconciliation only; no background polling is installed. */
  refresh(owner: ScheduleOwner): Promise<void> {
    return this.operation(this.refreshNative(owner));
  }

  private async refreshNative(owner: ScheduleOwner): Promise<void> {
    this.checkReady(); validateOwner(owner);
    const candidates = await this.serial(async () => [...this.records.values()]
      .filter(record => sameOwner(record, owner)).map(record => record.id));
    for (const id of candidates) {
      const runtime = this.runtimes.get(id);
      if (!runtime?.handle || runtime.stopped || runtime.cancelling || runtime.running.size || !this.current(owner)) continue;
      if (!LIVE.has(this.records.get(id)!.state)) { await this.stop(id, runtime); continue; }
      try {
        const present = await runtime.handle.list();
        if (present) continue;
        await this.serial(async () => {
          const record = this.records.get(id)!;
          if (LIVE.has(record.state)) {
            record.state = 'interrupted';
            record.error = 'Native schedule is no longer listed; execution completion is not confirmed.';
            await this.persist();
          }
        });
        await this.stop(id, runtime);
      } catch (error) {
        await this.serial(async () => {
          const record = this.records.get(id)!;
          if (LIVE.has(record.state)) record.state = 'interrupted';
          record.error = errorText(error);
          if (!this.fault) await this.persist();
        });
        await this.stop(id, runtime);
      }
    }
  }

  cancel(owner: ScheduleOwner, id: string): Promise<ScheduleRecord> {
    return this.operation(this.cancelSchedule(owner, id));
  }

  private async cancelSchedule(owner: ScheduleOwner, id: string): Promise<ScheduleRecord> {
    this.checkReady(); validateOwner(owner); validateScheduleId(id);
    let runtime: Runtime | undefined;
    let existing: Promise<ScheduleRecord> | undefined;
    let operation: Promise<ScheduleRecord> | undefined;
    await this.serial(async () => {
      const record = this.owned(owner, id);
      runtime = this.runtimes.get(id);
      record.cancelRequested = true;
      runtime?.recoveryAbort?.abort();
      if (record.recovery) record.recovery.status = 'blocked';
      await this.persist();
      if (!runtime && record.recovery?.handoff === 'clean' && record.recovery.nativeDefinitionAbsent) { record.state = 'cancelled'; delete record.error; await this.persist(); }
      if (!runtime && recoveryOwnsWork(record)) {
        record.error = 'Cancellation intent retained; native cleanup is unconfirmed. Recovery will not recreate this job.';
        await this.persist();
        throw new Error(record.error);
      }
      if (runtime?.cancelPromise) { existing = runtime.cancelPromise; return; }
      if (!LIVE.has(record.state) && !runtime?.cancelling && (!runtime || runtime.stopped)) {
        if (record.recovery && runtime?.stopped) { record.state = 'cancelled'; delete record.error; }
        for (const [key, pending] of this.pending) {
          if (pending.scheduleId === id && !pending.afterCancellation) this.pending.delete(key);
        }
        await this.persist();
        operation = Promise.resolve(structuredClone(record));
        return;
      }
      if (!runtime) throw new Error('Native schedule handle is unavailable.');
      if (runtime.recoveryAbort && !runtime.handle && !runtime.stopped) {
        throw new Error('Recovery receipt is unresolved; cancellation intent retained until native cleanup can be confirmed.');
      }
      runtime.cancelling = true;
      // Starting outside the state queue also permits synchronous provider callbacks.
      operation = Promise.resolve().then(() => this.cancelNative(id, runtime!));
      runtime.cancelPromise = operation;
    });
    return (existing ?? operation)!;
  }

  /** Explicit reconnect retry. No timer or periodic retry is installed. */
  async retryDeliveries(): Promise<void> {
    this.checkReady();
    const ids = await this.serial(async () => [...this.pending.keys()]);
    await this.attemptDeliveries(ids);
  }

  hasUnresolvedHandoff(): boolean { return this.handoffUnresolved; }

  hasUnresolvedRecovery(): boolean {
    return [...this.records.values()].some(record => recoveryOwnsWork(record)
      && record.recovery?.status !== 'eligible');
  }

  hasPendingRecovery(): boolean {
    return [...this.records.values()].some(record => record.state === 'interrupted' && record.recovery?.status === 'pending');
  }

  /** Snapshot eligibility is only admission to a handoff, never permission to install. */
  canSuspendForRestart(): boolean {
    if (!this.initialized || this.closing || this.fault || this.suspending || this.recoveryRun || this.operations.size || this.pending.size) return false;
    return [...this.records.values()].filter(record => LIVE.has(record.state) || recoveryOwnsWork(record)
      || !!this.runtimes.get(record.id) && !this.runtimes.get(record.id)!.stopped).every(record => {
      const runtime = this.runtimes.get(record.id);
      return record.state === 'active' && !!record.recovery && !record.cancelRequested && !record.error
        && !!runtime?.handle?.releaseForRestart && !runtime.running.size && !runtime.cancelling;
    });
  }

  /** Delete future definitions, drain native work, join owned hosts, then publish restart proof. */
  suspendForRestart(): Promise<void> {
    if (this.suspension) return this.suspension;
    if (!this.canSuspendForRestart()) return Promise.reject(new Error('Schedules are not ready for restart handoff.'));
    this.suspending = true;
    this.handoffUnresolved = true;
    const entries = [...this.runtimes].filter(([id]) => this.records.get(id)?.state === 'active');
    const run = (async () => {
      try {
        // Checkpoints remain dirty throughout deletion/drain and actual host exit.
        await this.serial(async () => {
          for (const [id, runtime] of entries) {
            if (runtime.handle?.recoveryIdentity) {
              text(runtime.handle.recoveryIdentity, 8192);
              this.records.get(id)!.recovery!.identity = runtime.handle.recoveryIdentity;
            }
            delete this.records.get(id)!.recovery!.handoff;
            delete this.records.get(id)!.recovery!.nativeDefinitionAbsent;
          }
          await this.persist();
        });
        const releases = await Promise.allSettled(entries.map(([, runtime]) =>
          this.boundRecovery(runtime.handle!.releaseForRestart!(), 'Native schedule drain remains unresolved.')));
        const failed = releases.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failed) throw failed.reason;
        for (const [index, result] of releases.entries()) {
          const policy = this.records.get(entries[index][0])!.recovery!.handoffPolicy ?? 'drain-all';
          if (result.status === 'fulfilled' && (result.value?.policy ?? 'drain-all') !== policy) throw new Error('Native handoff policy receipt changed.');
        }
        const absentOneShots = new Set<string>();
        for (const [index, result] of releases.entries()) if (result.status === 'fulfilled' && result.value?.onceDefinitionAlreadyAbsent) {
          const record = this.records.get(entries[index][0])!;
          if (record.rule.kind !== 'once' || record.recovery?.handoffPolicy !== 'skip-unadmitted') throw new Error('Invalid absent one-shot handoff receipt.');
          absentOneShots.add(record.id);
        }
        const absent = new Set(entries.filter((_, index) => {
          const result = releases[index];
          return result.status === 'fulfilled' && result.value?.nativeDefinitionAbsent === true;
        }).map(([id]) => id));
        await this.boundRecovery((async () => {
          while (this.tasks.size) await Promise.allSettled([...this.tasks]);
        })(), 'Scheduled result drain remains unresolved.');
        await this.tail;
        if (this.pending.size) throw new Error('Scheduled result acknowledgement is pending.');
        if (this.fault || entries.some(([, runtime]) => runtime.running.size)) throw this.fault ?? new Error('Native occurrence is still running.');
        const finished = new Set<string>();
        for (const [id] of entries) {
          const record = this.records.get(id)!;
          const provider = this.options.provider.recoveryFor?.({ id, threadId: record.threadId, backend: record.backend,
            cwd: record.cwd, rule: record.rule, prompt: record.prompt, ...record.execution });
          if (!provider || provider.provider !== record.recovery!.provider) throw new Error('Native recovery provider changed during handoff.');
          const key = `${record.threadId}:${provider.provider}`;
          if (finished.has(key)) continue;
          if (provider.orderlyOnly && !provider.finishRestart) throw new Error('Owned native host exit cannot be confirmed.');
          if (provider.finishRestart) await this.boundRecovery(provider.finishRestart(), 'Owned native host exit remains unresolved.');
          finished.add(key);
        }
        await this.boundRecovery((async () => {
          while (this.tasks.size) await Promise.allSettled([...this.tasks]);
        })(), 'Scheduled result drain remains unresolved.');
        await this.serial(async () => {
          if (this.fault) throw this.fault;
          for (const [id, runtime] of entries) {
            const record = this.records.get(id)!;
            if (!this.current(record) || record.cancelRequested) throw new Error('Schedule owner retired during handoff.');
            if (record.state === 'active' && absentOneShots.has(id)) {
              record.state = 'interrupted'; record.error = 'One-shot native definition was already absent at handoff; it will not be replayed.';
              delete record.recovery;
            } else if (record.state === 'active') {
              record.state = 'interrupted'; record.recovery!.status = 'pending'; record.recovery!.handoff = 'clean';
              if (absent.has(id)) record.recovery!.nativeDefinitionAbsent = true;
              record.error = 'Native host drained and exited; waiting for automatic recovery.';
            } else if (record.state === 'interrupted' && record.rule.kind === 'once' && record.recovery?.handoffPolicy === 'skip-unadmitted' && !runtime.running.size) {
              delete record.recovery;
            } else if (record.state !== 'completed') throw new Error('Occurrence outcome changed during handoff.');
            runtime.stopped = true;
          }
          await this.persist();
          for (const [id] of entries) this.runtimes.delete(id);
          this.handoffUnresolved = false;
        });
      } catch (error) {
        await this.serial(async () => {
          for (const [id] of entries) {
            const record = this.records.get(id)!;
            delete record.recovery?.handoff;
            delete record.recovery?.nativeDefinitionAbsent;
            record.error = `Restart handoff unconfirmed: ${errorText(error)}`;
          }
          if (!this.fault) await this.persist();
        });
        throw error;
      } finally { this.suspending = false; }
    })();
    this.suspension = run;
    void run.finally(() => { if (this.suspension === run) this.suspension = undefined; }).catch(() => {});
    return run;
  }

  /** Providers with durable intent must complete handoff before unrelated host teardown. */
  requiresShutdownHandoff(): boolean {
    return [...this.records.values()].some(record => !!record.recovery);
  }

  destroy(): Promise<void> {
    if (this.destruction) return this.destruction;
    const preserve = !this.closing && this.hasActiveSchedules() && this.canSuspendForRestart();
    if (!preserve) this.closing = true;
    return this.destruction = (async () => {
      if (preserve) await this.suspendForRestart();
      this.closing = true;
      for (const runtime of this.runtimes.values()) runtime.recoveryAbort?.abort();
      await this.initialization?.catch(() => {});
      let failure: unknown;
      await this.serial(async () => {
        for (const record of this.records.values()) {
          if (LIVE.has(record.state)) {
            const runtime = this.runtimes.get(record.id);
            if (record.recovery && record.state === 'active' && !record.cancelRequested && !record.error
              && runtime?.handle?.releaseForRestart && !runtime.running.size && !runtime.cancelling) {
              runtime.releasing = true;
              record.recovery.status = 'pending';
              record.error = 'Native restart handoff pending verification.';
            } else {
              if (record.recovery) record.recovery.status = 'blocked';
              record.error = 'Native schedule interrupted by service shutdown.';
            }
            record.state = 'interrupted';
          }
        }
        if (this.initialized && !this.fault) await this.persist();
      }).catch(error => { failure = error; });
      const stops = await Promise.allSettled([...this.runtimes].map(async ([id, runtime]) => {
        if (!runtime.releasing) return this.stop(id, runtime);
        try {
          runtime.releasePromise ??= runtime.handle!.releaseForRestart!();
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([runtime.releasePromise, new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('Native shutdown handoff timed out; ownership retained.')),
                this.options.recoveryTimeoutMs ?? 30_000);
            })]);
          } finally { if (timer) clearTimeout(timer); }
          await this.serial(async () => {
            const record = this.records.get(id)!;
            if (record.recovery?.status !== 'pending') throw new Error('Occurrence raced native handoff; recovery is blocked.');
            runtime.stopped = true;
            record.error = 'Waiting for native recovery after orderly shutdown.';
            await this.persist();
          });
        } catch (error) {
          await this.blockRecovery(this.records.get(id)!, errorText(error));
          throw error;
        }
      }));
      while (this.operations.size) await Promise.allSettled([...this.operations]);
      while (this.tasks.size) await Promise.allSettled([...this.tasks]);
      await this.deliveryTail;
      await this.tail;
      const rejected = stops.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failure || rejected || this.fault) throw failure ?? rejected?.reason ?? this.fault;
    })().catch(error => {
      // Keep admission closed and retain handles, but allow explicit cleanup retries.
      this.destruction = undefined;
      throw error;
    });
  }

  private async cancelNative(id: string, runtime: Runtime): Promise<ScheduleRecord> {
    try {
      const handle = await runtime.ready;
      if (handle && !runtime.stopped) {
        if (LIVE.has(this.records.get(id)!.state) || handle.cancellationKeepsRunning) await handle.cancel();
        else await this.stop(id, runtime);
      }
      await this.serial(async () => {
        const record = this.records.get(id)!;
        record.state = 'cancelled'; delete record.error;
        if (handle?.cancellationKeepsRunning) {
          for (const pending of this.pending.values()) if (pending.scheduleId === id) pending.afterCancellation = true;
        } else this.dropPending(id);
        await this.persist();
      });
      runtime.cancelling = false;
      runtime.heldDeliveries.clear();
      await this.stop(id, runtime);
      if (handle?.cancellationKeepsRunning) await this.attemptDeliveries([...this.pending.keys()]);
      return structuredClone(this.records.get(id)!);
    } catch (error) {
      runtime.cancelling = false;
      await this.serial(async () => {
        this.records.get(id)!.error = errorText(error);
        if (!this.fault) await this.persist();
      });
      if (!LIVE.has(this.records.get(id)!.state)) await this.stop(id, runtime).catch(() => {});
      const ids = [...runtime.heldDeliveries];
      runtime.heldDeliveries.clear();
      await this.attemptDeliveries(ids, true);
      throw error;
    } finally { runtime.cancelPromise = undefined; }
  }

  private async onEvent(id: string, event: NativeScheduleEvent): Promise<void> {
    let delivery: string | undefined;
    let cleanup = false;
    const runtime = this.runtimes.get(id)!;
    await this.serial(async () => {
      if (this.fault) throw this.fault;
      const record = this.records.get(id)!;
      if (this.suspending && event.type === 'stopped') {
        if (event.exitConfirmed === false) throw new Error('Native handoff exit unconfirmed.');
        runtime.stopped = true; return;
      }
      if (runtime.releasing && runtime.stopped) return;
      // Process exit evidence is independent of task state, including late exit
      // after a failed cancellation cleanup. Never downgrade confirmed exit.
      if (event.type === 'stopped' && event.exitConfirmed !== false) {
        runtime.stopped = true;
        runtime.releaseAdmission?.(); runtime.releaseAdmission = undefined;
        if (record.error?.startsWith('Native process exit unconfirmed:')) {
          delete record.error;
          await this.persist();
        }
      }
      if (runtime.releasing && event.type === 'stopped' && event.exitConfirmed !== false) return;
      const ownerCurrent = this.current(record);
      if (this.closing || !ownerCurrent) {
        if (record.recovery && (!ownerCurrent || event.type !== 'stopped' || event.exitConfirmed === false)) record.recovery.status = 'blocked';
        if (LIVE.has(record.state)) { record.state = 'interrupted'; record.error = 'Schedule owner or service is no longer current.'; }
        // Native stop notifications during shutdown must preserve completed outbox
        // entries for restart. Only actual ownership invalidation discards them.
        if (!ownerCurrent) this.dropPending(id);
        cleanup = true;
        await this.persist(); return;
      }
      const finishingCancelled = record.state === 'cancelled' && runtime.handle?.cancellationKeepsRunning
        && event.type === 'completed' && runtime.running.has(event.occurrenceId);
      if ((!finishingCancelled && record.state === 'cancelled') || record.state === 'failed' || record.state === 'completed') return;
      if (event.type === 'stopped') {
        if (LIVE.has(record.state)) { record.state = 'interrupted'; record.error = bounded(event.reason, ERROR_BYTES); }
      } else {
        text(event.occurrenceId);
        if (runtime.completed.has(event.occurrenceId)) return;
        if (record.state === 'interrupted' && (event.type !== 'completed' || !runtime.running.has(event.occurrenceId))) return;
        if (runtime.completed.size + runtime.running.size >= this.maxOccurrences && !runtime.running.has(event.occurrenceId)) {
          record.state = 'interrupted'; record.error = 'Occurrence tracking limit reached; native schedule stopped.'; cleanup = true;
        } else if (event.type === 'skipped') {
          if (record.recovery?.handoffPolicy !== 'skip-unadmitted' || runtime.running.has(event.occurrenceId)) throw new Error('Unnegotiated occurrence skip.');
          runtime.completed.add(event.occurrenceId);
          record.completedOccurrences = [...runtime.completed];
          // No delivery and no invented success. Unseen skipped wakes are not counted.
          (record.skippedOccurrences ??= []).push(event.occurrenceId);
          if (record.rule.kind === 'once') { record.state = 'interrupted'; record.error = bounded(event.reason, ERROR_BYTES); }
        } else if (event.type === 'started') {
          runtime.running.add(event.occurrenceId); record.state = 'running';
          if (record.recovery) record.recovery.status = 'blocked';
        } else if (event.type === 'completed') {
          if (typeof event.success !== 'boolean') throw new Error('Invalid native completion event.');
          runtime.running.delete(event.occurrenceId);
          runtime.completed.add(event.occurrenceId);
          record.completedOccurrences = [...runtime.completed];
          if (this.pending.size >= this.maxPending) {
            record.state = 'interrupted'; record.error = 'Delivery outbox is full; latest result could not be retained. Native schedule stopped.';
            cleanup = true;
          } else {
            delivery = deliveryId(id, event.occurrenceId);
            this.pending.set(delivery, { id: delivery, scheduleId: id, occurrenceId: event.occurrenceId,
              success: event.success, ...(finishingCancelled ? { afterCancellation: true } : {}), ...(event.output !== undefined && { output: bounded(event.output, OUTPUT_BYTES) }),
              ...(event.error !== undefined && { error: bounded(event.error, ERROR_BYTES) }) });
            if (finishingCancelled) { cleanup = true; }
            else if (record.rule.kind === 'once') { record.state = 'completed'; cleanup = true; }
            else if (record.state !== 'interrupted') {
              record.state = runtime.running.size ? 'running' : 'active';
              if (record.recovery && !runtime.running.size) record.recovery.status = 'eligible';
            }
          }
        } else throw new Error('Invalid native schedule event.');
      }
      await this.persist();
    });
    // Do not wait for a create handle before recording or delivering an early result.
    // stop() records retryable exit failures itself. A cleanup timeout must not
    // fault the entire service or prevent a later explicit cancellation retry.
    // Persistence failures still set the service fault inside persist().
    if (cleanup && !runtime.cancelling) this.track(this.stop(id, runtime).catch(() => {}));
    if (delivery) await this.attemptDeliveries([delivery], true);
  }

  private attemptDeliveries(ids: string[], firstAttempt = false): Promise<void> {
    const run = this.deliveryTail.then(async () => {
      for (const id of ids) {
        let delivery: ScheduleDelivery | undefined;
        await this.serial(async () => {
          if (this.closing || this.fault) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          const record = this.records.get(pending.scheduleId)!;
          if (!this.current(record) || record.state === 'cancelled' && !pending.afterCancellation) {
            this.pending.delete(id); await this.persist(); return;
          }
          const runtime = this.runtimes.get(record.id);
          if (runtime?.cancelling) {
            if (firstAttempt) runtime.heldDeliveries.add(id);
            return;
          }
          delivery = { id, schedule: structuredClone(record), occurrenceId: pending.occurrenceId,
            success: pending.success, ...(pending.output !== undefined && { output: pending.output }),
            ...(pending.error !== undefined && { error: pending.error }) };
        });
        if (!delivery || this.closing || !this.current(delivery.schedule) || !this.pending.has(id)) continue;
        const runtime = this.runtimes.get(delivery.schedule.id);
        if (runtime?.cancelling) {
          if (firstAttempt) runtime.heldDeliveries.add(id);
          continue;
        }
        try { await this.options.deliver(delivery); }
        catch { continue; } // Keep the persisted outbox; only explicit reconnect retries it.
        await this.serial(async () => { this.pending.delete(id); await this.persist(); });
      }
    });
    this.deliveryTail = run.catch(() => {});
    return run;
  }

  private stop(id: string, runtime: Runtime): Promise<void> {
    if (runtime.stopped) return Promise.resolve();
    if (runtime.stopPromise) return runtime.recoveryAbort ? this.boundRecovery(runtime.stopPromise, 'Native cleanup remains unresolved; ownership retained.') : runtime.stopPromise;
    const operation = (async () => {
      try {
        if (runtime.recoveryAbort?.signal.aborted && !runtime.handle && !runtime.stopped) {
          throw new Error('Recovery receipt is unresolved; native ownership retained.');
        }
        const handle = await runtime.ready;
        if (handle && !runtime.stopped) await handle.stop();
        // A shared session can delete future firings while an occurrence still
        // finishes. Keep ownership until its terminal stopped notification.
        if (!handle?.cancellationKeepsRunning || !runtime.running.size) runtime.stopped = true;
        if (runtime.stopped) { runtime.releaseAdmission?.(); runtime.releaseAdmission = undefined; }
      } catch (error) {
        await this.serial(async () => {
          this.records.get(id)!.error = `Native process exit unconfirmed: ${errorText(error)}`.slice(0, ERROR_BYTES / 4);
          if (!this.fault) await this.persist();
        });
        throw error;
      }
    })();
    runtime.stopPromise = operation;
    void operation.finally(() => { if (!runtime.stopped) runtime.stopPromise = undefined; }).catch(() => {});
    return runtime.recoveryAbort ? this.boundRecovery(operation, 'Native cleanup remains unresolved; ownership retained.') : operation;
  }

  private async boundRecovery<T>(operation: Promise<T>, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), this.options.recoveryTimeoutMs ?? 30_000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private newRuntime(): Runtime {
    let resolveReady!: Runtime['resolveReady'];
    const ready = new Promise<NativeScheduleHandle | undefined>(resolve => { resolveReady = resolve; });
    return { ready, resolveReady, running: new Set(), completed: new Set(), heldDeliveries: new Set(), cancelling: false, stopped: false };
  }

  private track(task: Promise<unknown>): void {
    this.tasks.add(task);
    void task.catch(error => {
      // Persistence/protocol failures fail closed and stop native producers.
      this.fault ??= error instanceof Error ? error : new Error('Schedule service failed.');
      for (const [id, runtime] of this.runtimes) void this.stop(id, runtime).catch(() => {});
    }).finally(() => this.tasks.delete(task));
  }

  private operation<T>(task: Promise<T>): Promise<T> {
    this.operations.add(task);
    void task.finally(() => this.operations.delete(task)).catch(() => {});
    return task;
  }

  private current(owner: ScheduleOwner): boolean {
    try { return this.options.isOwnerCurrent(ownerOf(owner)) === true; } catch { return false; }
  }

  private owned(owner: ScheduleOwner, id: string): ScheduleRecord {
    const record = this.records.get(id);
    if (!record || !sameOwner(record, owner)) throw new Error('Schedule not found for this owner.');
    return record;
  }

  private dropPending(id: string): void {
    for (const [key, item] of this.pending) if (item.scheduleId === id) this.pending.delete(key);
  }

  private checkReady(): void {
    if (this.fault) throw this.fault;
    if (!this.initialized || this.closing || this.suspending) throw new Error('Schedule service is not initialized or is closed.');
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.tail.then(operation);
    this.tail = task.catch(() => {});
    return task;
  }

  private async readCatalog(): Promise<unknown | undefined> {
    let handle: fs.FileHandle;
    try {
      const stat = await fs.lstat(this.catalogPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Schedule catalog must be a regular file, not a symlink.');
      handle = await fs.open(this.catalogPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    try {
      // JSON can expand one control byte to six bytes (for example, "\\u0001").
      const maxBytes = (this.maxRecords + this.maxPending) * (160 * 1024)
        + this.maxRecords * this.maxOccurrences * 515 + 4096;
      const size = (await handle.stat()).size;
      if (size > maxBytes) throw new Error('Schedule catalog exceeds its size limit.');
      const buffer = Buffer.alloc(size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > maxBytes) throw new Error('Schedule catalog exceeds its size limit.');
      return JSON.parse(buffer.subarray(0, length).toString('utf8'), (key, value: unknown) => {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Unsafe schedule catalog key.');
        return value;
      });
    } finally { await handle.close(); }
  }

  private load(data: unknown): void {
    const catalog = object(data, ['version', 'records', 'pending']);
    if (![1, 2].includes(catalog.version as number) || !Array.isArray(catalog.records) || catalog.records.length > this.maxRecords
      || !Array.isArray(catalog.pending) || catalog.pending.length > this.maxPending) throw new Error('Invalid schedule catalog envelope.');
    const records = new Map<string, ScheduleRecord>();
    const pending = new Map<string, PendingDelivery>();
    for (const value of catalog.records) {
      const record = object(value, ['id', 'backend', 'cwd', 'prompt', 'rule', 'createdAt', 'nativeId', 'state', 'error', 'threadId', 'openId', 'generation', 'execution', 'cancelRequested', 'recovery', 'completedOccurrences', 'skippedOccurrences']);
      validateScheduleId(record.id); validateOwner(record as unknown as ScheduleOwner); validateSchedulePrompt(record.prompt);
      text(record.cwd, 4096);
      if (!path.isAbsolute(record.cwd) || !isNativeScheduleBackend(record.backend) || !STATES.has(record.state as ScheduleRecord['state'])
        || typeof record.createdAt !== 'number' || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0
        || records.has(record.id)) throw new Error('Invalid schedule catalog record.');
      if (record.nativeId !== undefined) text(record.nativeId);
      if (record.error !== undefined && (typeof record.error !== 'string' || Buffer.byteLength(record.error) > ERROR_BYTES)) throw new Error('Invalid schedule error.');
      if (record.cancelRequested !== undefined && record.cancelRequested !== true) throw new Error('Invalid cancellation intent.');
      if (record.execution !== undefined) {
        const execution = object(record.execution, ['command', 'model', 'effort']);
        for (const value of Object.values(execution)) if (value !== undefined) text(value, 4096);
      }
      if (record.recovery !== undefined) {
        if (catalog.version !== 2) throw new Error('Recovery requires catalog version 2.');
        const recovery = object(record.recovery, ['version', 'provider', 'strategy', 'identity', 'status', 'orderlyOnly', 'handoff', 'nativeDefinitionAbsent', 'handoffPolicy']);
        this.validateCheckpoint(recovery);
        if (!['eligible', 'pending', 'blocked'].includes(recovery.status as string)) throw new Error('Invalid recovery status.');
      }
      if (record.completedOccurrences !== undefined) {
        if (!Array.isArray(record.completedOccurrences) || record.completedOccurrences.length > this.maxOccurrences
          || new Set(record.completedOccurrences).size !== record.completedOccurrences.length) throw new Error('Invalid occurrence history.');
        record.completedOccurrences.forEach(value => text(value));
      }
      if (record.skippedOccurrences !== undefined) {
        if (!Array.isArray(record.skippedOccurrences) || record.skippedOccurrences.length > this.maxOccurrences
          || new Set(record.skippedOccurrences).size !== record.skippedOccurrences.length
          || record.skippedOccurrences.some(value => !Array.isArray(record.completedOccurrences) || !record.completedOccurrences.includes(value))) {
          throw new Error('Invalid skipped occurrence history.');
        }
      }
      const rule = object(record.rule, ['kind', 'at', 'expression', 'timezone']);
      if (rule.kind === 'once') object(rule, ['kind', 'at']);
      else object(rule, ['kind', 'expression', 'timezone']);
      validateScheduleRule(rule as unknown as ScheduleRule);
      records.set(record.id, structuredClone(record) as unknown as ScheduleRecord);
    }
    for (const value of catalog.pending) {
      const item = object(value, ['id', 'scheduleId', 'occurrenceId', 'success', 'output', 'error', 'afterCancellation']);
      validateScheduleId(item.scheduleId); text(item.occurrenceId);
      if (item.id !== deliveryId(item.scheduleId, item.occurrenceId) || !records.has(item.scheduleId)
        || pending.has(item.id as string) || typeof item.success !== 'boolean') throw new Error('Invalid pending schedule delivery.');
      for (const [field, limit] of [['output', OUTPUT_BYTES], ['error', ERROR_BYTES]] as const) {
        if (item[field] !== undefined && (typeof item[field] !== 'string' || Buffer.byteLength(item[field] as string) > limit)) throw new Error('Invalid delivery text.');
      }
      if (item.afterCancellation !== undefined && item.afterCancellation !== true) throw new Error('Invalid cancellation delivery flag.');
      pending.set(item.id as string, structuredClone(item) as unknown as PendingDelivery);
    }
    this.records = records; this.pending = pending;
  }

  private async persist(): Promise<void> {
    if (this.fault) throw this.fault;
    const temporary = path.join(path.dirname(this.catalogPath), `.schedule-${randomUUID()}.tmp`);
    try {
      try {
        const stat = await fs.lstat(this.catalogPath);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Schedule catalog is not a regular file.');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const handle = await fs.open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ version: 2, records: [...this.records.values()], pending: [...this.pending.values()] }), 'utf8');
        await handle.sync();
      } finally { await handle.close(); }
      await fs.rename(temporary, this.catalogPath);
    } catch (error) {
      this.fault = error instanceof Error ? error : new Error('Schedule catalog write failed.');
      for (const [id, runtime] of this.runtimes) void this.stop(id, runtime).catch(() => {});
      throw this.fault;
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }
}
