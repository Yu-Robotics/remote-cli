import { cleanupRecord, cleanupSummary, type ScheduleCleanupSummary, type CleanupReason, type ScheduleCleanupRecord } from './ScheduleCleanup';
import { kernelGate, syncDirectory, type KernelGate } from '../delegation/OwnershipRuntime';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validateScheduleId, validateSchedulePrompt, validateScheduleRule } from './ScheduleCommand';
import type { NativeScheduleEvent, NativeScheduleHandle, NativeScheduleInput, NativeScheduleProvider,
  ScheduleDelivery, ScheduleOwner, ScheduleRecord, ScheduleRule } from './types';
import { NativeScheduleNotAdmittedError, NativeScheduleCleanupError } from './types';
import { assertNativeScheduleBackend, isNativeScheduleBackend } from './ScheduleCapabilities';

export const SCHEDULE_CATALOG_FILE = 'schedule-catalog.json';
const OUTPUT_BYTES = 16 * 1024;
const ERROR_BYTES = 4096;
const LIVE = new Set<ScheduleRecord['state']>(['creating', 'active', 'running']);
const STATES = new Set<ScheduleRecord['state']>([...LIVE, 'completed', 'cancelled', 'interrupted', 'failed']);
const RESTART_REASON = 'Native schedule interrupted by service restart; not recreated or resumed.';
const MAX_PURGED_IDS = 10_000;
const MAX_CLEANUP_RECORDS = 1000;
const MAX_PURGE_REQUESTS = 1000;
const MAX_PURGE_SELECTION_IDS = 20_000;
const FORGOTTEN_CLEANUP_WARNING = 'Forgetting cleanup tracking does not confirm native definition absence or predecessor termination. Replay protection is retained. Use native cleanup review/delete in the original session for any remaining native tasks.';

export type SchedulePurgeSelection = { ids: readonly string[]; forgetUnresolved?: true } | { all: true };
export type SchedulePurgeReason = 'operation_pending' | 'occurrence_running' | 'delivery_pending'
  | 'native_absence_unknown' | 'predecessor_unknown' | 'unattributed' | 'fence_capacity';
/** Framework/provider evidence, never deserialized from model or command arguments.
 * Verification must cover this original definition and all its execution owners,
 * not just absence of a short ID in some current session. */
export type SchedulePurgeEvidence =
  | { status: 'verified'; isCurrent(): boolean }
  | { status: 'unresolved'; reason: SchedulePurgeReason; detail: string };
export interface SchedulePurgeResult {
  /** Freeze these IDs for retries of an all-owner request. */
  selectedIds: string[];
  status: 'complete' | 'partial';
  /** History deletion only; inspect nativeCleanupUnresolved before claiming complete cleanup. */
  removedIds: string[];
  historyRemovedIds: string[];
  nativeCleanupUnresolved: ScheduleCleanupSummary[];
  /** Explicitly forgotten tracking only; never a native absence or retirement receipt. */
  forgottenCleanupIds?: string[];
  warning?: string;
  alreadyRemovedIds: string[];
  pending: { id: string; reason: SchedulePurgeReason; detail: string }[];
  errors: { id: string; error: string }[];
}
type PurgeOutcome = { status: 'removed' | 'alreadyRemoved'; forgottenCleanup?: true }
  | { status: 'pending'; reason: SchedulePurgeReason; detail: string };

export interface ScheduleServiceOptions {
  directory: string;
  provider: NativeScheduleProvider;
  /** Reject when disconnected or not delivered. Success is not an exactly-once receipt. */
  deliver: (delivery: ScheduleDelivery) => Promise<void>;
  isOwnerCurrent: (owner: ScheduleOwner) => boolean;
  /** Framework observation of late native mutations, never model-supplied proof. */
  isNativeMutationPending?: (owner: ScheduleOwner) => boolean;
  now?: () => number;
  /** Optional exact native cleanup/absence verification for retired or legacy rows.
   * Installed by trusted framework wiring. Must not recreate jobs, infer session
   * attribution from short IDs, or treat local absence as predecessor quiescence.
   * A verified result remains valid only while its captured lease is current. */
  withPurgeVerification?<T>(record: Readonly<ScheduleRecord | ScheduleCleanupRecord>, context: { isCurrent(): boolean },
    accept: (evidence: SchedulePurgeEvidence) => Promise<T>): Promise<T>;
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
  observedOccurrence?: true;
  cancelling: boolean;
  cancelPromise?: Promise<ScheduleRecord>;
  stopPromise?: Promise<void>;
  stopped: boolean;
  removalConfirmed?: boolean;
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

/** Deletion-only obligations and receipts remain manageable by the same user in
 * the same thread after reset. Original provenance stays immutable; live records
 * and all execution admission continue to require exact generation ownership. */
function sameCleanupOwner(left: ScheduleOwner, right: ScheduleOwner): boolean {
  return left.threadId === right.threadId && left.openId === right.openId;
}

/** Unknown native mutation/queued reminders remain cleanup obligations after host loss. */
function unsettledNativeWork(record: ScheduleRecord): boolean {
  return !record.creationRefused && !record.cleanupConfirmed
    && (['interrupted', 'failed', 'creating'].includes(record.state)
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
  private retainedCancellations = new Map<string, Promise<ScheduleRecord>>();
  private purged = new Map<string, ScheduleOwner>();
  private cleanup = new Map<string, ScheduleCleanupRecord>();
  private purgeRequests = new Map<string, { digest: string; ids: string[] }>();
  private purges = new Map<string, { forgetUnresolved: boolean; task: Promise<PurgeOutcome> }>();
  private recordOperations = new Map<string, number>();
  private delivering = new Set<string>();
  private refreshes = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private deliveryTail: Promise<unknown> = Promise.resolve();
  private tasks = new Set<Promise<unknown>>();
  private operations = new Set<Promise<unknown>>();
  private initialization?: Promise<void>;
  private initialized = false;
  private closing = false;
  private destruction?: Promise<void>;
  private pendingCreates = 0;
  private fault?: Error;
  private catalogPath = '';
  private catalogGate?: KernelGate;

  constructor(options: ScheduleServiceOptions) {
    this.options = { ...options };
    this.now = options.now ?? Date.now;
    const limit = (value: number | undefined, fallback: number, ceiling: number): number => {
      const result = value ?? fallback;
      if (!Number.isInteger(result) || result < 1 || result > ceiling) throw new Error('Invalid schedule capacity.');
      return result;
    };
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
      this.catalogGate = kernelGate(`${this.catalogPath}.lock`);
      if (!this.catalogGate) throw new Error('Another client owns the schedule catalog.');
      const data = await this.readCatalog();
      if (data !== undefined) this.load(data);
      // Inspect the loaded outbox before ordinary startup pruning. Missing
      // delivery ownership must not turn a refused row into an absence claim.
      for (const record of [...this.records.values()]) await this.compactRefusedCreation(record);
      let changed = false;
      for (const record of this.records.values()) {
        if (record.recovery && record.recovery.status !== 'blocked') {
          record.recovery.status = 'blocked'; changed = true;
        }
        if (LIVE.has(record.state)) {
          record.state = 'interrupted'; record.error = RESTART_REASON; changed = true;
        }
      }
      for (const [id, delivery] of this.pending) {
        const record = this.records.get(delivery.scheduleId)!;
        if (record.state === 'cancelled' && !delivery.afterCancellation || !this.current(record)) { this.pending.delete(id); changed = true; }
      }
      if (changed || data === undefined || (data as { version?: number }).version !== 6) await this.persist();
      this.initialized = true;
    }).catch(error => { this.catalogGate?.close(); this.catalogGate = undefined; throw error; });
  }

  private validateOwnershipMetadata(value: any): void {
    if (value.futureOnly !== undefined && value.futureOnly !== true) throw new Error('Invalid future recovery policy.');
    if (value.abrupt !== undefined && value.abrupt !== true) throw new Error('Invalid abrupt recovery capability.');
    if (value.version !== 1 || !['reattach', 'reconstruct'].includes(value.strategy)) throw new Error('Invalid recovery checkpoint.');
    if (value.orderlyOnly !== undefined && value.orderlyOnly !== true || value.handoff !== undefined && value.handoff !== 'clean') throw new Error('Invalid handoff evidence.');
    if (value.nativeDefinitionAbsent !== undefined && (value.nativeDefinitionAbsent !== true || value.handoff !== 'clean')) throw new Error('Invalid native absence evidence.');
    if (value.handoffPolicy !== undefined && !['drain-all', 'skip-unadmitted'].includes(value.handoffPolicy)) throw new Error('Invalid handoff policy.');
    text(value.provider); text(value.identity, 8192);
  }

  create(owner: ScheduleOwner, input: NativeScheduleInput): Promise<ScheduleRecord> {
    this.pendingCreates++;
    const creation = this.recordOperation(input.id, this.createSchedule(owner, input).finally(async () => {
      this.pendingCreates--;
      if (this.closing && !this.pendingCreates) {
        await this.tail;
        this.catalogGate?.close(); this.catalogGate = undefined;
      }
    }));
    return this.operation(creation.catch(async error => {
      if (error instanceof NativeScheduleNotAdmittedError) {
        // The create operation has settled. Concurrent cancel/purge operations
        // retain their own record lease and must finish before any compaction.
        await this.serial(async () => {
          const record = this.records.get(input.id);
          if (record && sameOwner(record, owner)) await this.compactRefusedCreation(record);
        }).catch(() => {}); // Keep the original failure receipt; persistence faults remain fenced.
      }
      throw error;
    }));
  }

  private async createSchedule(owner: ScheduleOwner, input: NativeScheduleInput): Promise<ScheduleRecord> {
    this.checkReady();
    const backend = input.backend === undefined ? 'claude' : input.backend;
    // The service accepts installed providers independently of the foreground
    // executor availability policy. MessageHandler keeps that admission gate.
    if (!isNativeScheduleBackend(backend)) assertNativeScheduleBackend(backend);
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
    const cleanup = this.options.provider.cleanupFor?.(nativeInput);
    if (cleanup) {
      nativeInput.recovery = { version: 1, provider: cleanup.provider, strategy: cleanup.strategy,
        identity: cleanup.describe(structuredClone(nativeInput), originalOwner) };
      this.validateOwnershipMetadata(nativeInput.recovery);
    }
    const runtime = this.newRuntime();
    await this.serial(async () => {
      this.checkReady();
      if (!this.current(originalOwner)) throw new Error('Schedule owner is no longer current.');
      if (this.records.has(nativeInput.id) || this.purged.has(nativeInput.id)) throw new Error('Schedule ID already exists or was purged.');
      if (this.records.size >= this.maxRecords) throw new Error('Schedule catalog is full; history was not pruned.');
      const liveCount = [...this.records.values()].filter(record => LIVE.has(record.state)
        || this.hasRetainedCleanupRoute(record)
        || (this.runtimes.has(record.id) && !this.runtimes.get(record.id)!.stopped)).length;
      if (liveCount >= this.maxLive) throw new Error('Live native schedule limit reached.');
      this.records.set(nativeInput.id, { ...originalOwner, id: nativeInput.id, backend,
        cwd: nativeInput.cwd, prompt: nativeInput.prompt, rule: structuredClone(nativeInput.rule),
        createdAt, state: 'creating', execution: { command: input.command, model: input.model, effort: input.effort },
        ...(nativeInput.recovery && { recovery: { ...nativeInput.recovery, status: 'blocked' } }) });
      await this.persist();
      this.runtimes.set(nativeInput.id, runtime);
    });
    try {
      const handle = await this.options.provider.create(structuredClone(nativeInput), event => {
        if (this.runtimes.get(nativeInput.id) !== runtime) {
          return;
        }
        if (event.type === 'started' || event.type === 'completed') runtime.observedOccurrence = true;
        const task = this.onEvent(nativeInput.id, structuredClone(event));
        // A rejected pre-CREATE attribution is an admission refusal, not a
        // runtime event fault. persist() still fences actual storage failures.
        if (event.type !== 'attributed') this.track(task);
        return task;
      }, () => this.canAdmitOccurrence(nativeInput.id, runtime));
      runtime.handle = handle;
      runtime.resolveReady(handle);
      text(handle.nativeId);
      await this.serial(async () => {
        const record = this.records.get(nativeInput.id)!;
        record.nativeId = handle.nativeId;
        if (record.recovery && handle.cleanupIdentity) { text(handle.cleanupIdentity, 8192); record.recovery.identity = handle.cleanupIdentity; }
        const ownerCurrent = this.current(originalOwner);
        if (this.closing) { await this.persist(); return; }
        if (!ownerCurrent) {
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
        if (error instanceof NativeScheduleCleanupError) {
          if (error.handle.nativeId) { text(error.handle.nativeId); record.nativeId = error.handle.nativeId; }
          if (record.recovery && error.handle.cleanupIdentity) {
            text(error.handle.cleanupIdentity, 8192); record.recovery.identity = error.handle.cleanupIdentity;
          }
        }
        if (this.closing) { if (!this.fault) await this.persist(); return; }
        if (LIVE.has(record.state)) { record.state = 'failed'; record.error = errorText(error); }
        if (error instanceof NativeScheduleNotAdmittedError && !runtime.handle && !runtime.observedOccurrence
          && !record.nativeId && !runtime.running.size && !runtime.completed.size
          && !record.completedOccurrences?.length && !record.skippedOccurrences?.length) {
          record.creationRefused = true;
        }
        if (!this.fault) await this.persist();
      });
      if (runtime.handle) await this.stop(nativeInput.id, runtime).catch(() => {});
      else runtime.stopped = true;
      throw error;
    }
  }

  /** Called under the catalog serial queue, never through output-erasing purge.
   * A refusal is proof about this fresh attempt, not historical native absence. */
  private async compactRefusedCreation(record: ScheduleRecord): Promise<void> {
    const id = record.id, runtime = this.runtimes.get(id);
    if (record.state !== 'failed' || record.creationRefused !== true || record.nativeId !== undefined
      || record.cancelRequested || record.cleanupConfirmed || record.completedOccurrences?.length || record.skippedOccurrences?.length
      || this.records.get(id) !== record || this.cleanup.has(id) || this.purged.has(id)
      || this.fault || this.closing || this.refreshes
      || this.recordOperations.has(id) || this.retainedCancellations.has(id) || this.purges.has(id)
      || this.delivering.has(id) || [...this.pending.values()].some(item => item.scheduleId === id)
      || this.options.isNativeMutationPending?.(ownerOf(record))
      || runtime && (!runtime.stopped || runtime.handle || runtime.observedOccurrence || runtime.running.size || runtime.completed.size
        || runtime.heldDeliveries.size || runtime.cancelling || runtime.cancelPromise || runtime.stopPromise)
      || this.purged.size >= MAX_PURGED_IDS) return;
    this.purged.set(id, ownerOf(record));
    this.records.delete(id);
    try { await this.persist(); }
    catch (error) { this.records.set(id, record); this.purged.delete(id); throw error; }
    if (runtime) this.runtimes.delete(id);
  }

  /** Catalog lookup only; this does not probe or recreate native jobs. */
  async list(owner: ScheduleOwner): Promise<ScheduleRecord[]> {
    this.checkReady(); validateOwner(owner);
    return this.serial(async () => [...this.records.values()].filter(record => sameOwner(record, owner)).map(record => structuredClone(record)));
  }

  /** Operational deletion ledger, separate from user history and never recoverable. */
  async listCleanup(owner: ScheduleOwner): Promise<ScheduleCleanupRecord[]> {
    this.checkReady(); validateOwner(owner);
    return this.serial(async () => [...this.cleanup.values()].filter(record => sameCleanupOwner(record, owner)).map(record => structuredClone(record)));
  }

  /** Preserve the last known original-session route while deletion is unresolved. */
  hasCleanupContext(threadId: string): boolean {
    return [...this.cleanup.values()].some(item => item.threadId === threadId && item.backend === 'claude' && !!item.attribution);
  }

  /** Freeze production request selection durably before acquiring a native lease.
   * Keys bind authenticated ownership and the framework operation ID, not model proof. */
  freezePurgeSelection(owner: ScheduleOwner, selection: SchedulePurgeSelection, requestId: string,
    isCurrent: () => boolean): Promise<string[]> {
    this.checkReady(); validateOwner(owner); validateScheduleId(requestId);
    owner = structuredClone(owner); selection = structuredClone(selection);
    return this.operation(this.serial(async () => {
      if (!this.current(owner) || !isCurrent()) throw new Error('Schedule purge request context changed.');
      const ids = this.purgeIds(owner, selection);
      const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
      const key = hash([ownerOf(owner), requestId]);
      const digest = hash('all' in selection ? { all: true } : { ids: [...selection.ids].sort(),
        ...(selection.forgetUnresolved ? { forgetUnresolved: true } : {}) });
      const previous = this.purgeRequests.get(key);
      if (previous) {
        if (previous.digest !== digest) throw new Error('Purge requestId was reused with a different selection.');
        return [...previous.ids];
      }
      const references = [...this.purgeRequests.values()].reduce((count, receipt) => count + receipt.ids.length, 0);
      if (this.purgeRequests.size >= MAX_PURGE_REQUESTS || references + ids.length > MAX_PURGE_SELECTION_IDS)
        throw new Error('Durable purge request capacity reached (1000 requests / 20000 selected IDs); no retry selection was discarded.');
      this.purgeRequests.set(key, { digest, ids });
      try { await this.persist(); } catch (error) { this.purgeRequests.delete(key); throw error; }
      return [...ids];
    }));
  }

  private purgeIds(owner: ScheduleOwner, selection: SchedulePurgeSelection): string[] {
    const value = object(selection, ['ids', 'all', 'forgetUnresolved']);
    if (value.all !== undefined ? value.all !== true || value.ids !== undefined : !Array.isArray(value.ids))
      throw new Error('Select exact schedule IDs or all current-owner schedules.');
    if (value.forgetUnresolved !== undefined && (value.forgetUnresolved !== true || value.all !== undefined || !Array.isArray(value.ids) || !value.ids.length))
      throw new Error('Forgetting unresolved cleanup requires exact schedule IDs and forgetUnresolved: true.');
    const ids = value.all === true ? [...this.records.values()].filter(record => sameOwner(record, owner)).map(record => record.id)
      .concat([...this.cleanup.values()].filter(record => sameCleanupOwner(record, owner)).map(record => record.id))
      : [...value.ids as string[]];
    if (ids.length > this.maxRecords + MAX_CLEANUP_RECORDS || new Set(ids).size !== ids.length) throw new Error('Invalid schedule purge selection.');
    ids.forEach(validateScheduleId);
    return ids;
  }

  /** Cancel first. Remove eligible history independently of unresolved native
   * absence, preserving a minimal deletion ledger and permanent replay fence. */
  purge(owner: ScheduleOwner, selection: SchedulePurgeSelection, isCurrent: () => boolean = () => true): Promise<SchedulePurgeResult> {
    return this.operation(this.purgeSelected(structuredClone(owner), structuredClone(selection), isCurrent));
  }

  private async purgeSelected(owner: ScheduleOwner, selection: SchedulePurgeSelection, isCurrent: () => boolean): Promise<SchedulePurgeResult> {
    this.checkReady(); validateOwner(owner);
    const forgetUnresolved = 'forgetUnresolved' in selection && selection.forgetUnresolved === true;
    const selectedIds = await this.serial(async () => {
      if (!this.current(owner) || !isCurrent()) throw new Error('Schedule purge owner is no longer current.');
      const ids = this.purgeIds(owner, selection);
      let changed = false;
      for (const id of ids) {
        const record = this.records.get(id);
        if (!record || !sameOwner(record, owner)) continue;
        if (forgetUnresolved) continue;
        record.cancelRequested = true;
        if (record.recovery) record.recovery.status = 'blocked';
        changed = true;
      }
      // Persist admission denial before any external cleanup attempt.
      if (changed) await this.persist();
      return ids;
    });
    const result: SchedulePurgeResult = { selectedIds, status: 'complete', removedIds: [], historyRemovedIds: [], nativeCleanupUnresolved: [], alreadyRemovedIds: [], pending: [], errors: [] };
    if (forgetUnresolved) {
      result.forgottenCleanupIds = [];
      result.warning = FORGOTTEN_CLEANUP_WARNING;
    }
    for (const id of selectedIds) {
      const previouslyPurged = this.purged.has(id);
      try {
        const record = this.records.get(id);
        const prior = this.purged.get(id);
        if ((!record || !sameOwner(record, owner)) && (!prior || !sameCleanupOwner(prior, owner))) {
          throw new Error('Schedule not found for this owner.');
        }
        let entry = this.purges.get(id);
        if (entry && entry.forgetUnresolved !== forgetUnresolved) {
          result.pending.push({ id, reason: 'operation_pending', detail: 'A different purge mode is pending; retry this selection after it settles.' });
          continue;
        }
        if (!entry) {
          const task = forgetUnresolved ? this.forgetCleanup(owner, id, isCurrent) : this.purgeRecord(owner, id, isCurrent);
          entry = { forgetUnresolved, task };
          this.purges.set(id, entry);
          const admitted = entry;
          void task.finally(() => { if (this.purges.get(id) === admitted) this.purges.delete(id); }).catch(() => {});
        }
        const outcome = await entry.task;
        if (outcome.status === 'pending') result.pending.push({ id, reason: outcome.reason, detail: outcome.detail });
        else {
          (outcome.status === 'removed' ? result.removedIds : result.alreadyRemovedIds).push(id);
          if (outcome.forgottenCleanup) {
            (result.forgottenCleanupIds ??= []).push(id);
            result.warning = FORGOTTEN_CLEANUP_WARNING;
          }
        }
      } catch (error) {
        if (this.purged.has(id) && sameCleanupOwner(this.purged.get(id)!, owner))
          (previouslyPurged ? result.alreadyRemovedIds : result.removedIds).push(id);
        result.errors.push({ id, error: errorText(error) });
      }
    }
    result.historyRemovedIds = [...result.removedIds];
    result.nativeCleanupUnresolved = selectedIds.flatMap(id => {
      const item = this.cleanup.get(id);
      return item && sameCleanupOwner(item, owner) ? [cleanupSummary(item)] : [];
    });
    if (result.pending.length || result.errors.length || result.nativeCleanupUnresolved.length) result.status = 'partial';
    return result;
  }

  /** User-requested metadata erasure, not verification or native mutation. The
   * permanent ID/owner fence survives even when the deletion selector is gone. */
  private forgetCleanup(owner: ScheduleOwner, id: string, isCurrent: () => boolean): Promise<PurgeOutcome> {
    return this.serial(async () => {
      this.checkReady();
      if (!this.current(owner) || !isCurrent() || this.closing)
        throw new Error('Schedule cleanup context changed.');
      const prior = this.purged.get(id);
      if (!prior || !sameCleanupOwner(prior, owner) || this.records.has(id))
        throw new Error('Purge owned history before forgetting unresolved cleanup tracking.');
      if (this.options.isNativeMutationPending?.(owner) || this.recordOperations.has(id)
        || this.refreshes || this.retainedCancellations.has(id) || this.runtimes.has(id))
        return { status: 'pending', reason: 'operation_pending', detail: 'Native work or cleanup is still pending; tracking was not forgotten.' };
      if (this.delivering.has(id))
        return { status: 'pending', reason: 'delivery_pending', detail: 'An external delivery is already in flight; tracking was not forgotten.' };
      const item = this.cleanup.get(id);
      if (!item) return { status: 'alreadyRemoved' };
      if (!sameCleanupOwner(item, owner)) throw new Error('Schedule cleanup not found for this owner.');
      this.cleanup.delete(id);
      try { await this.persist(); } catch (error) { this.cleanup.set(id, item); throw error; }
      return { status: 'alreadyRemoved', forgottenCleanup: true };
    });
  }

  private async retryCleanup(owner: ScheduleOwner, id: string, isCurrent: () => boolean): Promise<PurgeOutcome> {
    const item = this.cleanup.get(id);
    if (this.options.isNativeMutationPending?.(owner)) return { status: 'pending', reason: 'operation_pending', detail: 'A native mutation receipt is unsettled; retry after reconciliation.' };
    if (!item || !this.options.withPurgeVerification) return { status: 'alreadyRemoved' };
    const current = () => !this.closing && !this.fault && isCurrent() && this.current(owner) && this.cleanup.get(id) === item;
    let accepted = false;
    return this.options.withPurgeVerification(structuredClone(item), { isCurrent: current }, async evidence => {
      if (accepted) throw new Error('Purge verification was already consumed.');
      accepted = true;
      return this.serial(async () => {
        this.checkReady();
        if (!current()) throw new Error('Schedule cleanup context changed.');
        if (evidence.status === 'unresolved') {
          if (!['unattributed', 'native_absence_unknown', 'predecessor_unknown'].includes(evidence.reason))
            return { status: 'pending', reason: evidence.reason, detail: bounded(evidence.detail, ERROR_BYTES) };
          if (['unattributed', 'native_absence_unknown', 'predecessor_unknown'].includes(evidence.reason) && item.reason !== evidence.reason) {
            const previous = item.reason; item.reason = evidence.reason as CleanupReason;
            try { await this.persist(); } catch (error) { item.reason = previous; throw error; }
          }
          return { status: 'alreadyRemoved' };
        }
        if (evidence.status !== 'verified' || !evidence.isCurrent()) throw new Error('Schedule cleanup evidence expired.');
        this.cleanup.delete(id);
        try { await this.persist(); } catch (error) { this.cleanup.set(id, item); throw error; }
        return { status: 'alreadyRemoved' };
      });
    });
  }

  private async purgeRecord(owner: ScheduleOwner, id: string, isCurrent: () => boolean): Promise<PurgeOutcome> {
    const pending = (reason: SchedulePurgeReason, detail: string): PurgeOutcome => ({ status: 'pending', reason, detail });
    this.checkReady();
    if (!this.current(owner) || !isCurrent()) throw new Error('Schedule purge owner is no longer current.');
    if (this.purged.has(id)) return this.retryCleanup(owner, id, isCurrent);
    const record = this.owned(owner, id);
    const current = () => !this.closing && !this.fault && isCurrent() && this.current(owner)
      && this.records.get(id) === record && record.cancelRequested === true;
    const busy = (): PurgeOutcome | undefined => {
      if (this.options.isNativeMutationPending?.(owner) || this.recordOperations.has(id) || this.refreshes || this.retainedCancellations.has(id)) {
        return pending('operation_pending', 'Creation, inspection or cleanup is still pending. Retry these same IDs.');
      }
      if (this.delivering.has(id)) return pending('delivery_pending', 'An external delivery is already in flight; its outcome cannot be revoked.');
    };
    const active = busy(); if (active) return active;
    if (this.purged.size >= MAX_PURGED_IDS) return pending('fence_capacity', 'Durable purge ID capacity reached; no replay fence was discarded.');
    const runtime = this.runtimes.get(id);
    // Do not interpret terminal state, an absent handle or a stopped process as
    // native definition absence. Existing cancelRetained owns its stronger proof.
    let retainedVerified = false;
    const clean = !runtime && record.cleanupConfirmed === true;
    if (runtime?.handle && !runtime.stopped) {
      await this.cancel(owner, id);
    } else if (!runtime && !record.creationRefused && !clean && record.recovery && this.supportsRetainedCancellation(record)) {
      try {
        await this.recordOperation(id, this.cancelRetained(record));
        retainedVerified = true;
      } catch (error) {
        // A failed receipt (including error-after-commit) is not absence proof.
        // Exact framework verification may still resolve it without recreating.
        // The settled failed mutation remains an unresolved cleanup obligation.
        // It cannot veto deletion of text after all local work has retired.
      }
    }
    if (!current()) throw new Error('Schedule purge context changed during cleanup.');
    const unfinished = busy(); if (unfinished) return unfinished;
    if (runtime?.running.size) return pending('occurrence_running', 'Future cancellation does not revoke an already admitted occurrence.');
    if (runtime && (!runtime.stopped)) return pending('operation_pending', 'Native runtime retirement is unconfirmed.');

    const handleProof = runtime?.removalConfirmed && runtime.handle?.nativeDefinitionAbsent !== false;
    const erase = (evidence?: Extract<SchedulePurgeEvidence, { status: 'verified' }>, unresolved?: CleanupReason): Promise<PurgeOutcome> => this.serial(async () => {
      this.checkReady();
      if (!current() || evidence?.status === 'verified' && !evidence.isCurrent()) throw new Error('Schedule purge evidence expired before persistence.');
      const changed = busy(); if (changed) return changed;
      if (this.purged.size >= MAX_PURGED_IDS) return pending('fence_capacity', 'Durable purge ID capacity reached; no replay fence was discarded.');
      if (this.runtimes.get(id) !== runtime || runtime?.running.size || runtime && !runtime.stopped
        || handleProof && runtime?.handle?.nativeDefinitionAbsent === false) {
        return pending('operation_pending', 'Native ownership changed before history removal.');
      }
      if (unresolved && this.cleanup.size >= MAX_CLEANUP_RECORDS) return pending('fence_capacity',
        'Native cleanup ledger capacity reached (1000); resolve existing cleanup before removing more history.');
      // Commit history/output deletion, minimal operational selector and replay
      // denial in the same atomic catalog replacement. Never retain user text.
      const outputs = [...this.pending].filter(([, entry]) => entry.scheduleId === id);
      this.purged.set(id, ownerOf(record));
      if (unresolved) this.cleanup.set(id, cleanupRecord(record, unresolved));
      this.records.delete(id); this.dropPending(id);
      try { await this.persist(); }
      catch (error) {
        this.records.set(id, record); this.purged.delete(id); this.cleanup.delete(id);
        for (const [key, entry] of outputs) this.pending.set(key, entry);
        throw error;
      }
      this.runtimes.delete(id);
      return { status: 'removed' };
    });
    if (record.creationRefused || clean || retainedVerified || handleProof) return erase();
    if (!this.options.withPurgeVerification) return erase(undefined, 'native_absence_unknown');
    let accepted = false;
    // The framework keeps its native scope/lease open until accept() finishes
    // persisting removal. A receipt returned after closing that lease is unsafe.
    return this.options.withPurgeVerification(structuredClone(record), { isCurrent: current }, async evidence => {
      if (accepted) throw new Error('Purge verification was already consumed.');
      accepted = true;
      if (!current()) throw new Error('Schedule purge context changed during verification.');
      if (evidence.status === 'unresolved') return ['unattributed', 'native_absence_unknown', 'predecessor_unknown'].includes(evidence.reason)
        ? erase(undefined, evidence.reason as CleanupReason) : pending(evidence.reason, bounded(evidence.detail, ERROR_BYTES));
      if (evidence.status !== 'verified' || typeof evidence.isCurrent !== 'function') throw new Error('Invalid native purge verification.');
      return erase(evidence);
    });
  }

  /** Durable outputs still awaiting their external delivery receipt. */
  hasPendingResults(): boolean { return this.pending.size > 0; }

  /** Includes terminal jobs whose native process exit is still unconfirmed. */
  hasActiveSchedules(threadId?: string): boolean {
    return [...this.records.values()].some(record => (!threadId || record.threadId === threadId)
      && (LIVE.has(record.state) || this.hasRetainedCleanupRoute(record) || (this.runtimes.has(record.id) && !this.runtimes.get(record.id)!.stopped)));
  }

  /** Read-only admission for purge of an owned runtime, including cancelled jobs. */
  needsNativePurge(owner: ScheduleOwner, id: string): boolean {
    this.checkReady(); this.owned(owner, id);
    const runtime = this.runtimes.get(id);
    // Cancellation can hide the card while its native runtime still needs retirement.
    return !!runtime?.handle && !runtime.stopped;
  }

  /** Card eligibility includes retryable cleanup even for a terminal catalog record. */
  canCancel(owner: ScheduleOwner, id: string): boolean {
    this.checkReady();
    const record = this.owned(owner, id);
    const runtime = this.runtimes.get(id);
    if (record.state === 'cancelled' && runtime?.handle?.cancellationKeepsRunning && !record.error) return false;
    return LIVE.has(record.state) || this.hasRetainedCleanupRoute(record) || ['interrupted', 'failed'].includes(record.state) && !!record.nativeId && this.supportsRetainedCancellation(record)
      || Boolean(runtime && !runtime.stopped);
  }

  /** Newly observed cleanup facts never supply historical recovery proof. The optional
   * retirement callback is framework-owned and checked under the native cleanup lease. */
  async recordReviewedCleanup(owner: ScheduleOwner, ids: string[], absent: boolean, retirementConfirmed?: (record: Readonly<ScheduleRecord>) => boolean): Promise<void> {
    this.checkReady(); validateOwner(owner); ids.forEach(validateScheduleId);
    if (!ids.length) return;
    await this.serial(async () => {
      if (!this.options.isOwnerCurrent(owner)) throw new Error('Cleanup catalog owner changed.');
      for (const id of ids) {
        const record = this.owned(owner, id);
        delete record.cleanupConfirmed;
        record.cancelRequested = true;
        if (record.recovery) record.recovery.status = 'blocked';
        if (record.state !== 'running') record.state = 'interrupted';
        record.error = absent ? 'Owner-reviewed native definition absent on current host; predecessor work remains unknown.'
          : 'Owner-reviewed native deletion requested; absence and predecessor work remain unconfirmed.';
        const runtime = this.runtimes.get(id);
        if (absent && retirementConfirmed?.(record) === true && (!runtime || runtime.stopped && !runtime.running.size)
          && !this.recordOperations.has(id) && !this.refreshes && !this.retainedCancellations.has(id)) {
          record.state = 'cancelled'; record.cleanupConfirmed = true; delete record.error;
          // Native-only cleanup must not discard already-admitted output. History
          // purge owns output removal after checking in-flight delivery fences.
          for (const pending of this.pending.values()) if (pending.scheduleId === id) pending.afterCancellation = true;
        }
      }
      await this.persist();
    });
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

  /** Observe native inventory without deleting definitions or retiring native work. */
  refresh(owner: ScheduleOwner): Promise<void> {
    this.refreshes++;
    return this.operation(this.refreshNative(structuredClone(owner)).finally(() => { this.refreshes--; }));
  }

  private async refreshNative(owner: ScheduleOwner): Promise<void> {
    this.checkReady(); validateOwner(owner);
    const candidates = await this.serial(async () => [...this.records.values()]
      .filter(record => sameOwner(record, owner)).map(record => record.id));
    let failure: Error | undefined;
    for (const id of candidates) {
      const record = this.records.get(id);
      const runtime = this.runtimes.get(id);
      const handle = runtime?.handle;
      if (!record || !runtime || !handle) continue;
      const nativeId = record.nativeId;
      const completed = runtime.completed.size;
      // Recheck after every read: cancellation or execution may have
      // advanced while inventory was awaiting its native receipt.
      const readable = () => !this.closing && !this.fault && this.current(owner)
        && this.records.get(id) === record && record.nativeId === nativeId && record.state === 'active' && !record.cancelRequested
        && this.runtimes.get(id) === runtime && runtime.handle === handle && !runtime.stopped && !runtime.cancelling
        && !runtime.running.size && runtime.completed.size === completed && !runtime.stopPromise
        && !this.recordOperations.has(id) && !this.retainedCancellations.has(id);
      if (!readable()) continue;
      let present: boolean;
      try {
        present = await handle.list();
        if (typeof present !== 'boolean') throw new Error('Native inventory returned no verified presence or absence.');
      } catch (error) {
        // Read uncertainty is not absence or cancellation authority. Leave the
        // durable record, recovery fences and future occurrence admission intact.
        if (readable()) failure ??= new Error(`Native inventory could not be verified for ${id}: ${errorText(error)}`);
        continue;
      }
      if (present) continue;
      await this.serial(async () => {
        if (!readable()) return;
        record.state = 'interrupted';
        const detail = 'Native schedule is no longer listed; execution completion and cleanup are not confirmed.';
        record.error = record.error ? `${bounded(record.error, ERROR_BYTES - Buffer.byteLength(detail) - 1)}\n${detail}` : detail;
        await this.persist();
      });
    }
    if (failure) throw failure;
  }

  cancel(owner: ScheduleOwner, id: string): Promise<ScheduleRecord> {
    return this.operation(this.recordOperation(id, this.cancelSchedule(owner, id)));
  }

  private async cancelSchedule(owner: ScheduleOwner, id: string): Promise<ScheduleRecord> {
    this.checkReady(); validateOwner(owner); validateScheduleId(id);
    let runtime: Runtime | undefined;
    let existing: Promise<ScheduleRecord> | undefined;
    let operation: Promise<ScheduleRecord> | undefined;
    await this.serial(async () => {
      const record = this.owned(owner, id);
      existing = this.retainedCancellations.get(id);
      if (existing) return;
      runtime = this.runtimes.get(id);
      record.cancelRequested = true;
      if (record.recovery) record.recovery.status = 'blocked';
      await this.persist();
      const retainedCleanup = !runtime || runtime.stopped && !runtime.handle?.nativeDefinitionAbsent;
      if (retainedCleanup && (unsettledNativeWork(record) || record.state === 'failed' && !!record.recovery
        || ['interrupted', 'failed'].includes(record.state) && !!record.nativeId && this.supportsRetainedCancellation(record))) {
        operation = Promise.resolve().then(() => this.cancelRetained(record));
        this.retainedCancellations.set(id, operation);
        return;
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
      runtime.cancelling = true;
      // Starting outside the state queue also permits synchronous provider callbacks.
      operation = Promise.resolve().then(() => this.cancelNative(id, runtime!));
      runtime.cancelPromise = operation;
    });
    return (existing ?? operation)!;
  }

  /** Historical uncertainty is not live work. Only an exact supported cleanup route
   * can keep a retired row in runtime admission and management controls. */
  private hasRetainedCleanupRoute(record: ScheduleRecord): boolean {
    return unsettledNativeWork(record) && !!record.recovery && this.supportsRetainedCancellation(record);
  }

  private supportsRetainedCancellation(record: ScheduleRecord): boolean {
    const cleanup = this.options.provider.cleanupFor?.({ ...record, ...record.execution });
    return !!record.recovery && !!cleanup?.cancelRetained && cleanup.provider === record.recovery.provider
      && cleanup.strategy === record.recovery.strategy;
  }

  private async cancelRetained(record: ScheduleRecord): Promise<ScheduleRecord> {
    const current = () => !this.closing && !this.fault && this.current(record) && record.cancelRequested === true;
    try {
      const ownership = record.recovery;
      const provider = this.options.provider.cleanupFor?.({ id: record.id, threadId: record.threadId,
        backend: record.backend, cwd: record.cwd, prompt: record.prompt, rule: record.rule,
        ...record.execution, recovery: ownership });
      if (!ownership || !provider?.cancelRetained || provider.provider !== ownership.provider || provider.strategy !== ownership.strategy) {
        throw new Error('Cancellation intent retained; native cleanup is unconfirmed. Original native ownership metadata or cleanup support is unavailable. Preserve the original session. For Claude, use /schedule cleanup review in the bound original thread for explicit deletion-only review; do not recreate this job.');
      }
      if (!current()) throw new Error('Native cancellation owner is no longer current.');
      await provider.cancelRetained(structuredClone(record), { isCurrent: current });
      await this.serial(async () => {
        if (!current()) throw new Error('Native cancellation owner changed before its receipt was saved.');
        record.state = 'cancelled'; record.cleanupConfirmed = true; delete record.error;
        for (const [key, pending] of this.pending) if (pending.scheduleId === record.id && !pending.afterCancellation) this.pending.delete(key);
        await this.persist();
      });
      return structuredClone(record);
    } catch (error) {
      await this.serial(async () => { record.error = errorText(error); if (!this.fault) await this.persist(); });
      throw error;
    } finally { this.retainedCancellations.delete(record.id); }
  }

  /** Explicit reconnect retry. No timer or periodic retry is installed. */
  async retryDeliveries(): Promise<void> {
    this.checkReady();
    const ids = await this.serial(async () => [...this.pending.keys()]);
    await this.attemptDeliveries(ids);
  }

  /** Idle future definitions do not block updates. Active work and durable deliveries still do. */
  canRestartWithoutActiveWork(): boolean {
    return this.initialized && !this.closing && !this.fault && !this.operations.size
      && !this.pending.size && !this.delivering.size && [...this.runtimes].every(([id, runtime]) =>
        (!['cancelled', 'failed', 'completed', 'interrupted'].includes(this.records.get(id)?.state ?? '') || runtime.stopped) &&
        !runtime.running.size && !runtime.cancelling) && ![...this.records.values()].some(record => record.state === 'creating');
  }

  /** Shutdown revokes admission only. It never invokes native schedule RPCs or waits for result ACKs. */
  destroy(): Promise<void> {
    if (this.destruction) return this.destruction;
    this.closing = true;
    return this.destruction = (async () => {
      await this.initialization?.catch(() => {});
      // Complete only writes already in this process's serial filesystem queue.
      // Native requests, results and delivery are independently durable or remain unknown after exit.
      await this.tail;
      // An already admitted CREATE may still return a deletion identity. Keep
      // catalog ownership until that receipt is saved, without awaiting native
      // work here. Process exit releases the kernel gate even if it never returns.
      if (!this.pendingCreates) { this.catalogGate?.close(); this.catalogGate = undefined; }
    })();
  }

  private async cancelNative(id: string, runtime: Runtime): Promise<ScheduleRecord> {
    try {
      const handle = await runtime.ready;
      if (handle && !runtime.stopped) {
        if (LIVE.has(this.records.get(id)!.state) || handle.cancellationKeepsRunning) {
          await handle.cancel(); runtime.removalConfirmed = true;
        }
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
      if (!runtime || this.runtimes.get(id) !== runtime || !this.records.has(id)) {
        return;
      }
      if (this.fault) throw this.fault;
      if (this.closing) {
        if (event.type === 'attributed') throw new Error('Schedule service closed before native creation attribution.');
        return;
      }
      const record = this.records.get(id)!;
      if (event.type === 'attributed') {
        if (!record.recovery || record.state !== 'creating' || !this.current(record) || record.cancelRequested) {
          throw new Error('Native creation attribution is no longer admissible.');
        }
        text(event.cleanupIdentity, 8192);
        record.recovery.identity = event.cleanupIdentity;
        await this.persist(); return;
      }
      // Process exit evidence is independent of task state, including late exit
      // after a failed cancellation cleanup. Never downgrade confirmed exit.
      if (event.type === 'stopped' && event.exitConfirmed !== false) {
        runtime.stopped = true;
        if (record.error?.startsWith('Native process exit unconfirmed:')) {
          delete record.error;
          await this.persist();
        }
      }
      const ownerCurrent = this.current(record);
      if (this.closing) return;
      if (!ownerCurrent) {
        if (record.recovery && (!ownerCurrent || event.type !== 'stopped' || event.exitConfirmed === false)) record.recovery.status = 'blocked';
        if (LIVE.has(record.state)) { record.state = 'interrupted'; record.error = 'Schedule owner or service is no longer current.'; }
        // Native stop notifications during shutdown must preserve completed outbox
        // entries for restart. Only actual ownership invalidation discards them.
        if (!ownerCurrent) this.dropPending(id);
        cleanup = true;
        await this.persist(); return;
      }
      const finishingFailed = record.state === 'failed' && event.type === 'completed' && runtime.running.has(event.occurrenceId);
      const finishingCancelled = record.state === 'cancelled' && runtime.handle?.cancellationKeepsRunning
        && event.type === 'completed' && runtime.running.has(event.occurrenceId);
      if ((!finishingCancelled && record.state === 'cancelled') || record.state === 'failed' && !finishingFailed || record.state === 'completed') return;
      if (event.type === 'stopped') {
        if (record.recovery) record.recovery.status = 'blocked';
        if (LIVE.has(record.state)) { record.state = 'interrupted'; record.error = bounded(event.reason, ERROR_BYTES); }
      } else {
        text(event.occurrenceId);
        if (runtime.completed.has(event.occurrenceId)) return;
        if (record.state === 'interrupted' && (event.type !== 'completed' || !runtime.running.has(event.occurrenceId))) return;
        if (runtime.completed.size + runtime.running.size >= this.maxOccurrences && !runtime.running.has(event.occurrenceId)) {
          record.state = 'interrupted'; record.error = 'Occurrence tracking limit reached; native schedule stopped.'; cleanup = true;
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
            else if (record.state !== 'interrupted' && record.state !== 'failed') {
              record.state = runtime.running.size ? 'running' : 'active';
              if (record.recovery && !runtime.running.size) record.recovery.status = 'blocked';
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
    if (cleanup && !this.closing && !runtime.cancelling) this.track(this.stop(id, runtime).catch(() => {}));
    if (delivery) {
      await this.attemptDeliveries([delivery], true);
    }
  }

  private attemptDeliveries(ids: string[], firstAttempt = false): Promise<void> {
    const run = this.deliveryTail.then(async () => {
      for (const id of ids) {
        let delivery: ScheduleDelivery | undefined;
        await this.serial(async () => {
          if (this.closing || this.fault) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          if (this.purges.has(pending.scheduleId)) return;
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
        if (!delivery || this.closing || !this.current(delivery.schedule) || !this.pending.has(id)
          || this.purges.has(delivery.schedule.id)) continue;
        const runtime = this.runtimes.get(delivery.schedule.id);
        if (runtime?.cancelling) {
          if (firstAttempt) runtime.heldDeliveries.add(id);
          continue;
        }
        this.delivering.add(delivery.schedule.id);
        try { await this.options.deliver(delivery); }
        catch { continue; } // Keep the persisted outbox; only explicit reconnect retries it.
        finally { this.delivering.delete(delivery.schedule.id); }
        await this.serial(async () => {
          this.pending.delete(id);
          await this.persist();
        });
      }
    });
    this.deliveryTail = run.catch(() => {});
    return run;
  }

  private stop(id: string, runtime: Runtime): Promise<void> {
    if (this.closing || this.runtimes.get(id) !== runtime) return Promise.resolve();
    if (runtime.stopped) return this.rememberCleanup(id, runtime);
    if (runtime.stopPromise) return runtime.stopPromise;
    const operation = (async () => {
      try {
        const handle = await runtime.ready;
        if (this.closing) return;
        if (handle && !runtime.stopped) {
          await handle.stop();
          // Process/job retirement is not itself proof that persisted timing was deleted.
          if (handle.nativeDefinitionAbsent === true) runtime.removalConfirmed = true;
        }
        // A shared session can delete future firings while an occurrence still
        // finishes. Keep ownership until its terminal stopped notification.
        if (handle?.retirementConfirmed !== false && (!handle?.cancellationKeepsRunning || !runtime.running.size)) runtime.stopped = true;
        if (runtime.stopped) {
          await this.rememberCleanup(id, runtime);
        }
      } catch (error) {
        await this.serial(async () => {
          this.records.get(id)!.error = `Native process exit unconfirmed: ${errorText(error)}`.slice(0, ERROR_BYTES / 4);
          if (!this.fault) await this.persist();
        });
        throw error;
      }
    })();
    const tracked = this.recordOperation(id, operation);
    runtime.stopPromise = tracked;
    void operation.finally(() => { if (!runtime.stopped) runtime.stopPromise = undefined; }).catch(() => {});
    return tracked;
  }

  private rememberCleanup(id: string, runtime: Runtime): Promise<void> {
    return this.serial(async () => {
      const record = this.records.get(id);
      if (this.runtimes.get(id) === runtime && runtime.stopped && !runtime.running.size
        && runtime.removalConfirmed && runtime.handle?.nativeDefinitionAbsent === true
        && record?.cancelRequested && record.state === 'cancelled' && !record.cleanupConfirmed) {
        record.cleanupConfirmed = true;
        await this.persist();
      }
    });
  }

  private canAdmitOccurrence(id: string, runtime: Runtime): boolean {
    const record = this.records.get(id);
    return !!record && this.runtimes.get(id) === runtime && !this.closing && !this.fault
      && !runtime.stopped && !runtime.cancelling && !record.cancelRequested
      && LIVE.has(record.state) && this.current(record);
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

  private recordOperation<T>(id: string, task: Promise<T>): Promise<T> {
    this.recordOperations.set(id, (this.recordOperations.get(id) ?? 0) + 1);
    return task.finally(() => {
      const remaining = this.recordOperations.get(id)! - 1;
      if (remaining) this.recordOperations.set(id, remaining); else this.recordOperations.delete(id);
    });
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
    if (!this.initialized || this.closing) throw new Error('Schedule service is not initialized or is closed.');
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
        + this.maxRecords * this.maxOccurrences * 515 + MAX_PURGED_IDS * 2048
        + MAX_CLEANUP_RECORDS * 8192 + MAX_PURGE_SELECTION_IDS * 1024 + 4096;
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
    const catalog = object(data, ['version', 'records', 'pending', 'purged', 'cleanup', 'purgeRequests']);
    if (![1, 2, 3, 4, 5, 6].includes(catalog.version as number) || !Array.isArray(catalog.records) || catalog.records.length > this.maxRecords
      || !Array.isArray(catalog.pending) || catalog.pending.length > this.maxPending) throw new Error('Invalid schedule catalog envelope.');
    const records = new Map<string, ScheduleRecord>();
    const pending = new Map<string, PendingDelivery>();
    for (const value of catalog.records) {
      const record = object(value, ['id', 'backend', 'cwd', 'prompt', 'rule', 'createdAt', 'nativeId', 'state', 'error', 'threadId', 'openId', 'generation', 'execution', 'cancelRequested', 'creationRefused', 'cleanupConfirmed', 'recovery', 'completedOccurrences', 'skippedOccurrences']);
      validateScheduleId(record.id); validateOwner(record as unknown as ScheduleOwner); validateSchedulePrompt(record.prompt);
      text(record.cwd, 4096);
      if (!path.isAbsolute(record.cwd) || !isNativeScheduleBackend(record.backend) || !STATES.has(record.state as ScheduleRecord['state'])
        || typeof record.createdAt !== 'number' || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0
        || records.has(record.id)) throw new Error('Invalid schedule catalog record.');
      if (record.nativeId !== undefined) text(record.nativeId);
      if (record.error !== undefined && (typeof record.error !== 'string' || Buffer.byteLength(record.error) > ERROR_BYTES)) throw new Error('Invalid schedule error.');
      if (record.cancelRequested !== undefined && record.cancelRequested !== true) throw new Error('Invalid cancellation intent.');
      if (record.creationRefused !== undefined && (Number(catalog.version) < 3 || record.creationRefused !== true || record.nativeId !== undefined
        || !['failed', 'cancelled', 'interrupted'].includes(record.state as string)
        || record.completedOccurrences !== undefined)) throw new Error('Invalid native admission refusal.');
      if (record.cleanupConfirmed !== undefined && (Number(catalog.version) < 4 || record.cleanupConfirmed !== true
        || record.cancelRequested !== true || record.state !== 'cancelled')) throw new Error('Invalid confirmed cleanup receipt.');
      if (record.execution !== undefined) {
        const execution = object(record.execution, ['command', 'model', 'effort']);
        for (const value of Object.values(execution)) if (value !== undefined) text(value, 4096);
      }
      if (record.recovery !== undefined) {
        if (catalog.version === 1) throw new Error('Recovery requires catalog version 2 or newer.');
        const recovery = object(record.recovery, ['version', 'provider', 'strategy', 'identity', 'status', 'orderlyOnly', 'futureOnly', 'handoff', 'nativeDefinitionAbsent', 'handoffPolicy', 'abrupt']);
        this.validateOwnershipMetadata(recovery);
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
    const purged = new Map<string, ScheduleOwner>();
    if (Number(catalog.version) >= 3) {
      if (!Array.isArray(catalog.purged) || catalog.purged.length > MAX_PURGED_IDS) throw new Error('Invalid purge fences.');
      for (const value of catalog.purged) {
        const fence = object(value, ['id', 'threadId', 'openId', 'generation']);
        validateScheduleId(fence.id); validateOwner(fence as unknown as ScheduleOwner);
        if (records.has(fence.id) || purged.has(fence.id)) throw new Error('Conflicting purge fence.');
        purged.set(fence.id, ownerOf(fence as unknown as ScheduleOwner));
      }
    } else if (catalog.purged !== undefined) throw new Error('Purge fences require catalog version 3 or newer.');
    const cleanup = new Map<string, ScheduleCleanupRecord>();
    const purgeRequests = new Map<string, { digest: string; ids: string[] }>();
    if (catalog.version === 5 || catalog.version === 6) {
      if (!Array.isArray(catalog.cleanup) || catalog.cleanup.length > MAX_CLEANUP_RECORDS) throw new Error('Invalid cleanup ledger.');
      for (const value of catalog.cleanup) {
        const entry = object(value, ['id', 'threadId', 'openId', 'generation', 'backend', 'cwd', 'nativeId', 'historyRemoved', 'reason', 'attribution']);
        validateScheduleId(entry.id); validateOwner(entry as unknown as ScheduleOwner); text(entry.cwd, 4096);
        const fence = purged.get(entry.id);
        if (!fence || !sameOwner(fence, entry as unknown as ScheduleOwner) || cleanup.has(entry.id)
          || !path.isAbsolute(entry.cwd) || !isNativeScheduleBackend(entry.backend) || entry.historyRemoved !== true
          || !['unattributed', 'native_absence_unknown', 'predecessor_unknown'].includes(entry.reason as string)) throw new Error('Invalid cleanup selector.');
        if (entry.nativeId !== undefined) text(entry.nativeId);
        if (entry.attribution !== undefined) {
          const a = object(entry.attribution, ['sessionId', 'marker', 'ownerToken', 'promptHash', 'rule']);
          text(a.sessionId);
          if (a.ownerToken !== undefined && (entry.backend !== 'claude' || typeof a.ownerToken !== 'string' || !/^[a-f0-9-]{36}$/.test(a.ownerToken))) throw new Error('Invalid cleanup owner incarnation.');
          if (typeof a.promptHash !== 'string' || !/^[a-f0-9]{64}$/.test(a.promptHash)
            || (entry.backend === 'claude' ? typeof a.marker !== 'string' || !/^[a-f0-9-]{36}$/.test(a.marker) : a.marker !== undefined)) throw new Error('Invalid cleanup attribution.');
          const rule = object(a.rule, ['kind', 'at', 'expression', 'timezone']);
          object(rule, rule.kind === 'once' ? ['kind', 'at'] : ['kind', 'expression', 'timezone']);
          validateScheduleRule(rule as unknown as ScheduleRule);
        }
        cleanup.set(entry.id, structuredClone(entry) as unknown as ScheduleCleanupRecord);
      }
      if (catalog.purgeRequests !== undefined) {
        if (!Array.isArray(catalog.purgeRequests) || catalog.purgeRequests.length > MAX_PURGE_REQUESTS) throw new Error('Invalid purge requests.');
        let references = 0;
        for (const value of catalog.purgeRequests) {
          const receipt = object(value, ['key', 'digest', 'ids']);
          if (typeof receipt.key !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.key) || purgeRequests.has(receipt.key)
            || typeof receipt.digest !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.digest)
            || !Array.isArray(receipt.ids) || new Set(receipt.ids).size !== receipt.ids.length
            || (references += receipt.ids.length) > MAX_PURGE_SELECTION_IDS) throw new Error('Invalid purge request receipt.');
          receipt.ids.forEach(validateScheduleId);
          purgeRequests.set(receipt.key, { digest: receipt.digest, ids: [...receipt.ids] });
        }
      }
    } else if (catalog.cleanup !== undefined || catalog.purgeRequests !== undefined) throw new Error('Cleanup ledger requires catalog version 5 or newer.');
    this.records = records; this.pending = pending; this.purged = purged; this.cleanup = cleanup; this.purgeRequests = purgeRequests;
  }

  private async persist(): Promise<void> {
    if (!this.catalogGate) throw new Error('Schedule catalog ownership is unavailable.');
    this.catalogGate.verify();
    if (this.fault) throw this.fault;
    const temporary = path.join(path.dirname(this.catalogPath), `.schedule-${randomUUID()}.tmp`);
    try {
      try {
        const stat = await fs.lstat(this.catalogPath);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Schedule catalog is not a regular file.');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const handle = await fs.open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ version: 6, records: [...this.records.values()], pending: [...this.pending.values()],
          cleanup: [...this.cleanup.values()], purgeRequests: [...this.purgeRequests].map(([key, receipt]) => ({ key, ...receipt })),
          purged: [...this.purged].map(([id, owner]) => ({ id, ...owner })) }), 'utf8');
        await handle.sync();
      } finally { await handle.close(); }
      await fs.rename(temporary, this.catalogPath);
      syncDirectory(path.dirname(this.catalogPath));
    } catch (error) {
      this.fault = error instanceof Error ? error : new Error('Schedule catalog write failed.');
      for (const [id, runtime] of this.runtimes) void this.stop(id, runtime).catch(() => {});
      throw this.fault;
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }
}
