import { cleanupRecord, cleanupSummary, type ScheduleCleanupSummary, type CleanupReason, type ScheduleCleanupRecord } from './ScheduleCleanup';
import { kernelGate, syncDirectory, type KernelGate } from '../delegation/OwnershipRuntime';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validateScheduleId, validateSchedulePrompt, validateScheduleRule } from './ScheduleCommand';
import type { NativeScheduleInput, NativeScheduleCleanup, HostScheduleInput,
  ScheduleDelivery, ScheduleOwner, ScheduleRecord, ScheduleRule } from './types';
import { assertHostScheduleBackend, isHostScheduleBackend, isNativeScheduleBackend } from './ScheduleCapabilities';
import { nextHostDue } from './host/HostScheduleRule';

export const SCHEDULE_CATALOG_FILE = 'schedule-catalog.json';
export const HOST_SCHEDULE_CATALOG_FILE = 'host-schedule-catalog.json';
const OUTPUT_BYTES = 16 * 1024;
const ERROR_BYTES = 4096;
const HOST_BUSY_RETRY_MS = 1000;
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

export type HostResult = { success: boolean; output?: string; error?: string; abortedByUser?: true;
  outcomeUnknown?: true; stopSchedule?: true };

export interface ScheduleServiceOptions {
  directory: string;
  /** Look up deletion support for a persisted native definition. */
  cleanupFor?(input: NativeScheduleInput): NativeScheduleCleanup | undefined;
  /** Reserve the original thread, then await admit() immediately before starting its turn. */
  hostDispatch?(record: Readonly<ScheduleRecord>, occurrenceId: string, admit: () => Promise<boolean>):
    Promise<HostResult | undefined>;
  /** Reject when disconnected or not delivered. Success is not an exactly-once receipt. */
  deliver: (delivery: ScheduleDelivery) => Promise<void>;
  /** For a host owner, false means a verified mismatch. Undefined defers until binding is known. */
  isOwnerCurrent: (owner: ScheduleOwner) => boolean | undefined;
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
  return { threadId: record.threadId, openId: record.openId, generation: record.generation,
    ...(record.bindingEpoch !== undefined && { bindingEpoch: record.bindingEpoch }) };
}

function validateOwner(owner: ScheduleOwner): void {
  if (!owner || typeof owner !== 'object') throw new Error('Invalid schedule owner.');
  text(owner.threadId); text(owner.openId); text(owner.generation);
  if (owner.bindingEpoch !== undefined) text(owner.bindingEpoch);
}

function sameOwner(left: ScheduleOwner & { engine?: 'host' }, right: ScheduleOwner): boolean {
  return left.threadId === right.threadId && left.openId === right.openId && left.generation === right.generation
    && (left.bindingEpoch === undefined ? left.engine !== 'host' : left.bindingEpoch === right.bindingEpoch);
}

/** Deletion-only obligations and receipts remain manageable by the same user in
 * the same thread after reset. Original provenance stays immutable; live records
 * and all execution admission continue to require exact generation ownership. */
function sameCleanupOwner(left: ScheduleOwner, right: ScheduleOwner): boolean {
  return left.threadId === right.threadId && left.openId === right.openId
    && (left.bindingEpoch === undefined || sameOwner(left, right));
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
 * Single timing and catalog owner per directory.
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
  private retainedCancellations = new Map<string, Promise<ScheduleRecord>>();
  private purged = new Map<string, ScheduleOwner>();
  private cleanup = new Map<string, ScheduleCleanupRecord>();
  private purgeRequests = new Map<string, { digest: string; ids: string[] }>();
  private purges = new Map<string, { forgetUnresolved: boolean; task: Promise<PurgeOutcome> }>();
  private recordOperations = new Map<string, number>();
  private delivering = new Set<string>();
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
  private hostCatalogPath = '';
  private readonly hostCatalogIds = new Set<string>();
  private readonly hostPurgeRequests = new Set<string>();
  private readonly catalogDigests = new Map<string, string>();
  private readonly unavailableLegacyIds = new Set<string>();
  private legacyUnavailable = false;
  get legacyCatalogUnavailable(): boolean { return this.legacyUnavailable; }
  private catalogGate?: KernelGate;
  private hostTimer?: NodeJS.Timeout;
  private hostTimerAt?: number;
  private hostStartup = 0;
  private readonly hostAttempts = new Set<string>();
  private readonly hostRetryAt = new Map<string, number>();

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
      this.hostCatalogPath = path.join(directory, HOST_SCHEDULE_CATALOG_FILE);
      this.catalogGate = kernelGate(`${this.catalogPath}.lock`);
      if (!this.catalogGate) throw new Error('Another client owns the schedule catalog.');
      const data = await this.readCatalog(this.catalogPath);
      if (data !== undefined) {
        try { this.load(data); }
        catch (error) {
          // Published pre-host formats can carry retired provider checkpoints.
          // Preserve their bytes and replay fences without interpreting them as host work.
          const legacy = data as { version?: number; records?: { id?: string }[]; purged?: { id?: string }[] };
          if (!this.options.hostDispatch || ![1, 2, 3, 4, 5, 6].includes(legacy?.version ?? 0)
            || !Array.isArray(legacy.records) || legacy.purged !== undefined && !Array.isArray(legacy.purged)
            || legacy.records.some(row => row && ['engine', 'sessionId', 'bindingEpoch', 'nextDueAt', 'inFlightDueAt'].some(key => Object.hasOwn(row, key)))) throw error;
          this.legacyUnavailable = true;
          for (const row of [...legacy.records, ...(legacy.purged ?? [])]) {
            if (typeof row?.id === 'string') this.unavailableLegacyIds.add(row.id);
          }
          console.warn('[Schedules] The legacy native catalog is incompatible and has been preserved. Only host schedules are available.');
        }
      }
      const hostData = await this.readCatalog(this.hostCatalogPath);
      if (hostData !== undefined) this.load(hostData, true);
      // Inspect the loaded outbox before ordinary startup pruning. Missing
      // delivery ownership must not turn a refused row into an absence claim.
      for (const record of [...this.records.values()]) await this.compactRefusedCreation(record);
      let changed = false;
      this.hostStartup = this.now();
      for (const record of this.records.values()) {
        if (record.engine === 'host') continue;
        if (record.recovery && record.recovery.status !== 'blocked') {
          record.recovery.status = 'blocked'; changed = true;
        }
        if (LIVE.has(record.state)) {
          record.state = 'interrupted'; record.error = RESTART_REASON; changed = true;
        }
      }
      for (const [id, delivery] of this.pending) {
        const record = this.records.get(delivery.scheduleId)!;
        if (record.state === 'cancelled' && !delivery.afterCancellation || record.engine !== 'host' && !this.current(record)) {
          this.pending.delete(id); changed = true;
        }
      }
      if (this.retireStaleHosts()) changed = true;
      const recoveryDeliveries: string[] = [];
      for (const record of this.records.values()) {
        if (record.engine === 'host' && this.reconcileHost(record, this.hostStartup, recoveryDeliveries)) changed = true;
      }
      if (changed || data === undefined || (data as { version?: number }).version !== 6) await this.persist();
      this.initialized = true;
      this.armHostTimer();
      if (recoveryDeliveries.length) this.track(this.attemptDeliveries(recoveryDeliveries));
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

  create(owner: ScheduleOwner, input: HostScheduleInput): Promise<ScheduleRecord> {
    return this.operation(this.recordOperation(input.id, this.createSchedule(owner, input)));
  }

  private async createSchedule(owner: ScheduleOwner, input: HostScheduleInput): Promise<ScheduleRecord> {
    this.checkReady();
    if (input.engine !== 'host') throw new Error('Schedule creation requires the host engine.');
    const { backend } = input;
    assertHostScheduleBackend(backend);
    const createdAt = this.now();
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error('Invalid schedule clock.');
    validateOwner(owner);
    validateScheduleId(input.id);
    validateSchedulePrompt(input.prompt);
    validateScheduleRule(input.rule, createdAt);
    text(input.sessionId);
    text(input.bindingEpoch);
    if (owner.bindingEpoch !== undefined && owner.bindingEpoch !== input.bindingEpoch) throw new Error('Host schedule binding epoch changed.');
    if (!this.options.hostDispatch) throw new Error('Host schedule dispatch is unavailable.');
    const nextDueAt = this.hostDue(input.rule, createdAt);
    text(input.cwd, 4096);
    if (!path.isAbsolute(input.cwd)) throw new Error('Schedule working directory must be absolute.');
    for (const value of [input.command, input.model, input.effort]) if (value !== undefined) text(value, 4096);
    const record: ScheduleRecord = { ...ownerOf(owner), bindingEpoch: input.bindingEpoch,
      id: input.id, engine: 'host', backend, sessionId: input.sessionId, cwd: input.cwd,
      prompt: input.prompt, rule: structuredClone(input.rule), createdAt, state: 'active', nextDueAt,
      execution: { command: input.command, model: input.model, effort: input.effort } };
    return this.serial(async () => {
      this.checkReady();
      if (!this.current(record)) throw new Error('Schedule owner is no longer current.');
      if (this.records.has(record.id) || this.purged.has(record.id) || this.unavailableLegacyIds.has(record.id)) {
        throw new Error('Schedule ID already exists or was purged.');
      }
      if (this.retireStaleHosts()) {
        await this.persist();
        if (!this.current(record)) throw new Error('Schedule owner changed during creation.');
      }
      const records = [...this.records.values()].filter(row => row.engine === 'host');
      if (records.filter(row => LIVE.has(row.state) || row.inFlightDueAt !== undefined).length >= this.maxLive) {
        throw new Error('Live host schedule limit reached.');
      }
      if (records.filter(row => this.hostCatalogIds.has(row.id)).length >= this.maxRecords) {
        const stale = records.find(row => this.hostCatalogIds.has(row.id) && row.state === 'interrupted'
          && this.hostOwnerStatus(row) === false && !this.hostAttempts.has(row.id) && !this.delivering.has(row.id)
          && !this.recordOperations.has(row.id) && !this.purges.has(row.id));
        if (!stale || this.purgeFencesFull(stale.id)) throw new Error('Schedule catalog is full; history was not pruned.');
        this.purged.set(stale.id, ownerOf(stale));
        this.records.delete(stale.id);
      }
      this.hostCatalogIds.add(record.id);
      this.records.set(record.id, record);
      await this.persist();
      return structuredClone(record);
    });
  }

  private hostDue(rule: ScheduleRule, after: number): number {
    const due = nextHostDue(rule, after);
    if (due === undefined || !Number.isSafeInteger(due) || due <= after) throw new Error('Schedule has no future occurrence.');
    return due;
  }

  private advanceHost(record: ScheduleRecord, after: number): void {
    try {
      record.nextDueAt = this.hostDue(record.rule, after);
      record.state = 'active';
    } catch (error) {
      delete record.nextDueAt;
      record.state = 'failed';
      record.error = errorText(error);
    }
  }

  /** All calls hold the catalog queue and have a reserved outbox slot. */
  private finishHost(record: ScheduleRecord, due: number, result: HostResult): string {
    const occurrenceId = `host-${due}`;
    const id = deliveryId(record.id, occurrenceId);
    const admitted = record.inFlightDueAt === due;
    const error = result.success ? undefined : bounded(result.error ?? 'Host schedule execution failed.', ERROR_BYTES);
    const status = result.success ? 'succeeded' : result.outcomeUnknown ? 'unknown' : result.abortedByUser ? 'aborted' : 'failed';
    record.lastOccurrence = { dueAt: due, status,
      ...(error !== undefined && { error }) };
    delete record.inFlightDueAt;
    delete record.nextDueAt;
    // Host slots advance monotonically. The persisted next/in-flight slot
    // fences replay even after an old diagnostic receipt leaves this window.
    record.completedOccurrences = [...(record.completedOccurrences ?? []), occurrenceId].slice(-this.maxOccurrences);
    this.pending.set(id, { id, scheduleId: record.id, occurrenceId, success: result.success,
      ...(record.cancelRequested && { afterCancellation: true }),
      ...(result.output !== undefined && { output: bounded(result.output, OUTPUT_BYTES) }),
      ...(result.error !== undefined && { error: bounded(result.error, ERROR_BYTES) }) });
    if (record.cancelRequested) record.state = 'cancelled';
    else if (!result.success && (record.rule.kind === 'once' || !admitted || result.stopSchedule)) {
      record.state = 'failed';
      record.error = error;
    } else if (record.rule.kind === 'once') record.state = 'completed';
    else this.advanceHost(record, Math.max(due, this.now()));
    return id;
  }

  private cancelHost(record: ScheduleRecord): void {
    record.cancelRequested = true;
    if (LIVE.has(record.state)) record.state = 'cancelled';
    delete record.nextDueAt;
    this.hostRetryAt.delete(record.id);
    for (const delivery of this.pending.values()) if (delivery.scheduleId === record.id) delivery.afterCancellation = true;
  }

  private hostOwnerStatus(record: ScheduleRecord): boolean | undefined {
    return record.bindingEpoch === undefined ? false : this.ownerStatus(record);
  }

  private retireHost(record: ScheduleRecord): boolean {
    const reason = 'Host schedule owner is no longer current.';
    const changed = record.state !== 'interrupted' || record.error !== reason;
    record.state = 'interrupted';
    record.error = reason;
    delete record.nextDueAt;
    delete record.inFlightDueAt;
    this.hostRetryAt.delete(record.id);
    const count = this.pending.size;
    this.dropPending(record.id);
    return changed || count !== this.pending.size;
  }

  private retireStaleHosts(): boolean {
    let changed = false;
    for (const record of this.records.values()) {
      if (record.engine === 'host' && this.hostOwnerStatus(record) === false && this.retireHost(record)) changed = true;
    }
    return changed;
  }

  /** An unresolved admission is never executed again. If the outbox is full,
   * its original disk receipt stays intact until an ACK releases capacity. */
  private reconcileHost(record: ScheduleRecord, now: number, deliveries: string[]): boolean {
    if (this.hostAttempts.has(record.id)) return false;
    const due = record.inFlightDueAt ?? record.nextDueAt;
    if (due === undefined) return false;
    if (this.hostOwnerStatus(record) !== true) return false;
    if (record.inFlightDueAt === undefined && record.cancelRequested) {
      this.cancelHost(record);
      return true;
    }
    const missed = due < this.hostStartup;
    if (record.inFlightDueAt === undefined && record.rule.kind === 'cron' && (missed || now - due >= 60_000)) {
      record.lastOccurrence = { dueAt: due, status: 'skipped', error: missed
        ? 'The slot elapsed while the scheduler was offline.' : 'The slot expired before dispatch.' };
      this.advanceHost(record, Math.max(now, this.hostStartup));
      return true;
    }
    if (record.inFlightDueAt === undefined && !missed) return false;
    if (this.outboxFull(record.id)) return false;
    const error = record.inFlightDueAt !== undefined
      ? 'Host schedule execution outcome is unknown after restart. The occurrence was not replayed.'
      : 'One-shot schedule was missed while the service was offline.';
    deliveries.push(this.finishHost(record, due, { success: false, error,
      ...(record.inFlightDueAt !== undefined && { outcomeUnknown: true }) }));
    return true;
  }

  private armHostTimer(): void {
    let earliest = Infinity;
    if (this.initialized && !this.closing && !this.fault) {
      for (const record of this.records.values()) {
        if (record.engine !== 'host' || this.hostAttempts.has(record.id) || this.outboxFull(record.id)
          || this.hostOwnerStatus(record) === undefined) continue;
        const due = record.inFlightDueAt !== undefined ? 0 : record.nextDueAt;
        if (due !== undefined) earliest = Math.min(earliest, Math.max(due, this.hostRetryAt.get(record.id) ?? 0));
      }
    }
    if (this.hostTimer && this.hostTimerAt === earliest) return;
    clearTimeout(this.hostTimer);
    this.hostTimer = undefined;
    this.hostTimerAt = earliest;
    if (earliest === Infinity) return;
    // Node clamps overflowing timer delays to one millisecond.
    const delay = Math.min(0x7fffffff, Math.max(0, earliest - this.now()));
    this.hostTimer = setTimeout(() => {
      this.hostTimer = undefined;
      this.track(this.wakeHosts());
    }, delay);
    this.hostTimer.unref();
  }

  private outboxFull(id: string): boolean {
    const host = this.hostCatalogIds.has(id);
    const pending = [...this.pending.values()].filter(item => this.hostCatalogIds.has(item.scheduleId) === host);
    const reservations = [...this.hostAttempts].filter(key => this.hostCatalogIds.has(key) === host && this.records.get(key)?.state !== 'interrupted');
    return pending.length + reservations.length >= this.maxPending;
  }

  private async wakeHosts(): Promise<void> {
    const deliveries: string[] = [];
    const ready: { record: ScheduleRecord; due: number }[] = [];
    await this.serial(async () => {
      if (this.closing || this.fault) return;
      let changed = this.retireStaleHosts();
      const now = this.now();
      for (const record of this.records.values()) {
        if (record.engine !== 'host' || this.hostAttempts.has(record.id)) continue;
        if (this.reconcileHost(record, now, deliveries)) changed = true;
        const due = record.nextDueAt;
        if (due === undefined || due > now || this.hostOwnerStatus(record) !== true || (this.hostRetryAt.get(record.id) ?? 0) > now
          || this.outboxFull(record.id)) continue;
        this.hostAttempts.add(record.id);
        ready.push({ record, due });
      }
      if (changed) await this.persist();
      else this.armHostTimer();
    });
    for (const { record, due } of ready) this.track(this.dispatchHost(record, due));
    if (deliveries.length) await this.attemptDeliveries(deliveries);
  }

  private async dispatchHost(record: ScheduleRecord, due: number): Promise<void> {
    const eligible = () => !this.closing && !this.fault && this.records.get(record.id) === record
      && !record.cancelRequested && record.state === 'active' && record.nextDueAt === due && this.current(record);
    let open = true;
    const admit = () => this.serial(async () => {
      if (!open || !eligible()) return false;
      record.state = 'running';
      record.inFlightDueAt = due;
      delete record.nextDueAt;
      await this.persist();
      if (!open || this.closing) return false;
      const status = this.hostOwnerStatus(record);
      if (status === true) return true;
      // No execution authority left this callback. Keep the original slot when
      // registration changed while the admission receipt was being written.
      if (status === false) this.retireHost(record);
      else {
        delete record.inFlightDueAt;
        record.nextDueAt = due;
        record.state = 'active';
      }
      await this.persist();
      return false;
    });
    let result: HostResult | undefined;
    try {
      if (eligible()) {
        if (!this.options.hostDispatch) throw new Error('Host schedule dispatch is unavailable.');
        result = await this.options.hostDispatch(structuredClone(record), `host-${due}`, admit);
        if (result?.success && record.inFlightDueAt !== due) throw new Error('Host dispatch completed without admission.');
        if (!result && record.inFlightDueAt === due) throw new Error('Admitted host occurrence returned no result. Its outcome is unknown.');
      }
    } catch (error) {
      result = { success: false, error: errorText(error), ...(record.inFlightDueAt === due && { outcomeUnknown: true }) };
    }
    finally { open = false; }
    const delivery = await this.serial(async () => {
      this.hostAttempts.delete(record.id);
      this.hostRetryAt.delete(record.id);
      if (this.closing || this.fault || this.records.get(record.id) !== record) return;
      let id: string | undefined;
      if (this.hostOwnerStatus(record) === false) {
        this.retireHost(record);
        await this.persist();
      } else if (result && (record.inFlightDueAt === due || eligible())) {
        id = this.finishHost(record, due, result);
        await this.persist();
      } else {
        if (eligible()) this.hostRetryAt.set(record.id, this.now() + HOST_BUSY_RETRY_MS);
        this.armHostTimer();
      }
      return id;
    });
    if (delivery) await this.attemptDeliveries([delivery]);
  }

  /** Called under the catalog serial queue, never through output-erasing purge.
   * A refusal is proof about this fresh attempt, not historical native absence. */
  private async compactRefusedCreation(record: ScheduleRecord): Promise<void> {
    const id = record.id;
    if (record.state !== 'failed' || record.creationRefused !== true || record.nativeId !== undefined
      || record.cancelRequested || record.cleanupConfirmed || record.completedOccurrences?.length || record.skippedOccurrences?.length
      || this.records.get(id) !== record || this.cleanup.has(id) || this.purged.has(id)
      || this.fault || this.closing
      || this.recordOperations.has(id) || this.retainedCancellations.has(id) || this.purges.has(id)
      || this.delivering.has(id) || [...this.pending.values()].some(item => item.scheduleId === id)
      || this.options.isNativeMutationPending?.(ownerOf(record))
      || this.purgeFencesFull(id)) return;
    this.purged.set(id, ownerOf(record));
    this.records.delete(id);
    try { await this.persist(); }
    catch (error) { this.records.set(id, record); this.purged.delete(id); throw error; }
  }

  /** Catalog lookup only; this does not probe or recreate native jobs. */
  async list(owner: ScheduleOwner): Promise<ScheduleRecord[]> {
    this.checkReady(); validateOwner(owner);
    return this.serial(async () => [...this.records.values()].filter(record => sameOwner(record, owner)).map(record => structuredClone(record)));
  }

  /** Commit context erasure before reset advances its generation. Late host results
   * require their original record object and cannot recreate a removed definition. */
  clearHostContext(threadId: string, authorize: () => ScheduleOwner | undefined, allowNativeRecovery: boolean): Promise<number> {
    return this.operation(this.serial(async () => {
      this.checkReady();
      const thread = [...this.records.values()].filter(row => row.threadId === threadId);
      if (!allowNativeRecovery && thread.some(row => row.engine !== 'host' && this.isActiveSchedule(row))) {
        throw new Error('Cancel this thread\'s native schedules with /schedule cancel <id> before resetting its conversation.');
      }
      const hosts = thread.filter(row => row.engine === 'host');
      if (!hosts.length) return 0;
      const owner = authorize();
      if (owner && (!owner.bindingEpoch || owner.threadId !== threadId || !this.current(owner))) {
        throw new Error('The schedule binding changed before conversation reset.');
      }
      const selected = hosts.filter(row => owner && sameOwner(row, owner));
      const pendingSchedules = new Set([...this.pending.values()].map(delivery => delivery.scheduleId));
      if (hosts.some(row => (!owner || !sameOwner(row, owner)) && (this.isActiveSchedule(row)
        || pendingSchedules.has(row.id) || this.delivering.has(row.id) || this.hostAttempts.has(row.id)))) {
        throw new Error('A host schedule still owns a different binding or conversation context.');
      }
      if (!selected.length) return 0;
      if (selected.some(row => this.delivering.has(row.id) || this.purges.has(row.id) || this.recordOperations.has(row.id))) {
        throw new Error('Schedule delivery or management is in progress. Retry the conversation reset after it settles.');
      }
      if ([...this.purged.keys()].filter(id => this.hostCatalogIds.has(id)).length + selected.length > MAX_PURGED_IDS) {
        throw new Error('Host schedule replay fence capacity reached. Conversation reset was refused.');
      }
      for (const row of selected) {
        this.purged.set(row.id, ownerOf(row));
        this.records.delete(row.id);
        this.dropPending(row.id);
        this.hostRetryAt.delete(row.id);
      }
      await this.persist();
      return selected.length;
    }));
  }

  /** Operational deletion ledger, separate from user history and never recoverable. */
  async listCleanup(owner: ScheduleOwner): Promise<ScheduleCleanupRecord[]> {
    this.checkReady(); validateOwner(owner);
    return this.serial(async () => [...this.cleanup.values()].filter(record => sameCleanupOwner(record, owner)).map(record => structuredClone(record)));
  }

  private purgeFencesFull(id: string): boolean {
    const host = this.hostCatalogIds.has(id);
    return [...this.purged.keys()].filter(key => this.hostCatalogIds.has(key) === host).length >= MAX_PURGED_IDS;
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
      const host = ids.some(id => this.hostCatalogIds.has(id)) || this.legacyUnavailable;
      const receipts = [...this.purgeRequests].filter(([key]) => this.hostPurgeRequests.has(key) === host);
      const references = receipts.reduce((count, [, receipt]) => count + receipt.ids.length, 0);
      if (receipts.length >= MAX_PURGE_REQUESTS || references + ids.length > MAX_PURGE_SELECTION_IDS)
        throw new Error('Durable purge request capacity reached (1000 requests / 20000 selected IDs); no retry selection was discarded.');
      if (host) this.hostPurgeRequests.add(key);
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
    if (ids.length > 2 * this.maxRecords + MAX_CLEANUP_RECORDS || new Set(ids).size !== ids.length) throw new Error('Invalid schedule purge selection.');
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
        if (record.engine === 'host') this.cancelHost(record);
        else record.cancelRequested = true;
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
        || this.retainedCancellations.has(id))
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
    if (this.hostCatalogIds.has(id)) return { status: 'alreadyRemoved' };
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
      if (record.inFlightDueAt !== undefined) return pending('occurrence_running', 'An admitted host occurrence is awaiting its result.');
      if (this.hostAttempts.has(id)) return pending('operation_pending', 'Host dispatch is reserving the thread.');
      if ((record.engine !== 'host' && this.options.isNativeMutationPending?.(owner)) || this.recordOperations.has(id)
        || this.retainedCancellations.has(id)) {
        return pending('operation_pending', 'Creation, inspection or cleanup is still pending. Retry these same IDs.');
      }
      if (this.delivering.has(id)) return pending('delivery_pending', 'An external delivery is already in flight; its outcome cannot be revoked.');
    };
    const active = busy(); if (active) return active;
    if (this.purgeFencesFull(id)) return pending('fence_capacity', 'Durable purge ID capacity reached; no replay fence was discarded.');
    // Do not interpret terminal state, an absent handle or a stopped process as
    // native definition absence. Existing cancelRetained owns its stronger proof.
    let retainedVerified = false;
    const clean = record.engine === 'host' || record.cleanupConfirmed === true;
    if (!record.creationRefused && !clean && record.recovery && this.supportsRetainedCancellation(record)) {
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
    const erase = (evidence?: Extract<SchedulePurgeEvidence, { status: 'verified' }>, unresolved?: CleanupReason): Promise<PurgeOutcome> => this.serial(async () => {
      this.checkReady();
      if (!current() || evidence?.status === 'verified' && !evidence.isCurrent()) throw new Error('Schedule purge evidence expired before persistence.');
      const changed = busy(); if (changed) return changed;
      if (this.purgeFencesFull(id)) return pending('fence_capacity', 'Durable purge ID capacity reached; no replay fence was discarded.');
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
      return { status: 'removed' };
    });
    if (record.creationRefused || clean || retainedVerified) return erase();
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

  hasPendingScheduleResult(owner: ScheduleOwner, id: string): boolean {
    this.owned(owner, id);
    return this.delivering.has(id) || [...this.pending.values()].some(delivery => delivery.scheduleId === id);
  }

  /** Durable outputs still awaiting their external delivery receipt. */
  hasPendingResults(threadId?: string): boolean {
    if (threadId === undefined) return this.pending.size > 0;
    return [...this.pending.values()].some(delivery => this.records.get(delivery.scheduleId)?.threadId === threadId);
  }

  /** Includes terminal jobs whose native process exit is still unconfirmed. */
  hasActiveSchedules(threadId?: string): boolean {
    return [...this.records.values()].some(record => (!threadId || record.threadId === threadId) && this.isActiveSchedule(record));
  }

  private isActiveSchedule(record: ScheduleRecord): boolean {
    return LIVE.has(record.state) || record.inFlightDueAt !== undefined || this.hasRetainedCleanupRoute(record);
  }


  /** Card eligibility includes retryable cleanup even for a terminal catalog record. */
  canCancel(owner: ScheduleOwner, id: string): boolean {
    this.checkReady();
    const record = this.owned(owner, id);
    return LIVE.has(record.state) || this.hasRetainedCleanupRoute(record)
      || ['interrupted', 'failed'].includes(record.state) && !!record.nativeId && this.supportsRetainedCancellation(record);
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
        if (record.engine === 'host') continue;
        delete record.cleanupConfirmed;
        record.cancelRequested = true;
        if (record.recovery) record.recovery.status = 'blocked';
        if (record.state !== 'running') record.state = 'interrupted';
        record.error = absent ? 'Owner-reviewed native definition absent on current host; predecessor work remains unknown.'
          : 'Owner-reviewed native deletion requested; absence and predecessor work remain unconfirmed.';
        if (absent && retirementConfirmed?.(record) === true
          && !this.recordOperations.has(id) && !this.retainedCancellations.has(id)) {
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
      if (record.engine === 'host') return;
      record.error = errorText(error);
      await this.persist();
    });
  }

  cancel(owner: ScheduleOwner, id: string): Promise<ScheduleRecord> {
    return this.operation(this.recordOperation(id, this.cancelSchedule(owner, id)));
  }

  private async cancelSchedule(owner: ScheduleOwner, id: string): Promise<ScheduleRecord> {
    this.checkReady(); validateOwner(owner); validateScheduleId(id);
    let existing: Promise<ScheduleRecord> | undefined;
    let operation: Promise<ScheduleRecord> | undefined;
    await this.serial(async () => {
      const record = this.owned(owner, id);
      if (record.engine === 'host') {
        if (!this.current(owner)) throw new Error('Host schedule owner is no longer current.');
        this.cancelHost(record);
        await this.persist();
        operation = Promise.resolve(structuredClone(record));
        return;
      }
      existing = this.retainedCancellations.get(id);
      if (existing) return;
      record.cancelRequested = true;
      if (record.recovery) record.recovery.status = 'blocked';
      await this.persist();
      if (unsettledNativeWork(record) || record.state === 'failed' && !!record.recovery
        || ['interrupted', 'failed'].includes(record.state) && !!record.nativeId && this.supportsRetainedCancellation(record)) {
        operation = Promise.resolve().then(() => this.cancelRetained(record));
        this.retainedCancellations.set(id, operation);
        return;
      }
      if (LIVE.has(record.state)) throw new Error('Native schedule handle is unavailable.');
      for (const [key, pending] of this.pending) {
        if (pending.scheduleId === id && !pending.afterCancellation) this.pending.delete(key);
      }
      await this.persist();
      operation = Promise.resolve(structuredClone(record));
    });
    return (existing ?? operation)!;
  }

  /** Historical uncertainty is not live work. Only an exact supported cleanup route
   * can keep a retired row in runtime admission and management controls. */
  private hasRetainedCleanupRoute(record: ScheduleRecord): boolean {
    return unsettledNativeWork(record) && !!record.recovery && this.supportsRetainedCancellation(record);
  }

  private supportsRetainedCancellation(record: ScheduleRecord): boolean {
    if (record.engine === 'host' || !isNativeScheduleBackend(record.backend)) return false;
    const cleanup = this.options.cleanupFor?.({ ...record, backend: record.backend, ...record.execution });
    return !!record.recovery && !!cleanup?.cancelRetained && cleanup.provider === record.recovery.provider
      && cleanup.strategy === record.recovery.strategy;
  }

  private async cancelRetained(record: ScheduleRecord): Promise<ScheduleRecord> {
    const current = () => !this.closing && !this.fault && this.current(record) && record.cancelRequested === true;
    try {
      const ownership = record.recovery;
      if (record.engine === 'host' || !isNativeScheduleBackend(record.backend)) throw new Error('Native cleanup requires a legacy schedule.');
      const provider = this.options.cleanupFor?.({ id: record.id, threadId: record.threadId,
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
      await this.serial(async () => {
        // A failed deletion attempt is not a new interruption. Keep the
        // original exit/ownership diagnostic while returning the cleanup error.
        if (record.state !== 'interrupted' || !record.error) record.error = errorText(error);
        if (!this.fault) await this.persist();
      });
      throw error;
    } finally { this.retainedCancellations.delete(record.id); }
  }

  /** Explicit reconnect retry. No timer or periodic retry is installed. */
  async retryDeliveries(): Promise<void> {
    this.checkReady();
    const ids = await this.serial(async () => {
      if (this.retireStaleHosts()) await this.persist();
      else this.armHostTimer();
      return [...this.pending.keys()];
    });
    await this.attemptDeliveries(ids);
  }

  /** Idle future definitions do not block updates. Active work and durable deliveries still do. */
  canRestartWithoutActiveWork(): boolean {
    return this.initialized && !this.closing && !this.fault && !this.operations.size
      && !this.hostAttempts.size && !this.pending.size && !this.delivering.size
      && ![...this.records.values()].some(record => record.inFlightDueAt !== undefined || record.state === 'creating');
  }

  /** Shutdown revokes admission only. It never invokes native schedule RPCs or waits for result ACKs. */
  destroy(): Promise<void> {
    if (this.destruction) return this.destruction;
    this.closing = true;
    clearTimeout(this.hostTimer);
    return this.destruction = (async () => {
      await this.initialization?.catch(() => {});
      // Complete only writes already in this process's serial filesystem queue.
      // Native requests, results and delivery are independently durable or remain unknown after exit.
      await this.tail;
      this.catalogGate?.close(); this.catalogGate = undefined;
    })();
  }


  private attemptDeliveries(ids: string[]): Promise<void> {
    const run = this.deliveryTail.then(async () => {
      for (const id of ids) {
        let delivery: ScheduleDelivery | undefined;
        await this.serial(async () => {
          if (this.closing || this.fault) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          if (this.purges.has(pending.scheduleId)) return;
          const record = this.records.get(pending.scheduleId)!;
          if (record.engine === 'host') {
            const status = this.hostOwnerStatus(record);
            if (status === undefined) return;
            if (!status) { this.retireHost(record); await this.persist(); return; }
          }
          if (record.engine !== 'host' && !this.current(record) || record.state === 'cancelled' && !pending.afterCancellation) {
            this.pending.delete(id); await this.persist(); return;
          }
          delivery = { id, schedule: structuredClone(record), occurrenceId: pending.occurrenceId,
            success: pending.success, ...(pending.output !== undefined && { output: pending.output }),
            ...(pending.error !== undefined && { error: pending.error }) };
        });
        if (!delivery || this.closing || !this.current(delivery.schedule) || !this.pending.has(id)
          || this.purges.has(delivery.schedule.id)) continue;
        this.delivering.add(delivery.schedule.id);
        try { await this.options.deliver(delivery); }
        catch { continue; } // Keep the persisted outbox; only explicit reconnect retries it.
        finally { this.delivering.delete(delivery.schedule.id); }
        await this.serial(async () => {
          if (this.closing) return; // A successor retries the durably unacknowledged result.
          this.pending.delete(id);
          await this.persist();
        });
      }
    });
    this.deliveryTail = run.catch(() => {});
    return run;
  }


  private track(task: Promise<unknown>): void {
    this.tasks.add(task);
    void task.catch(error => {
      this.fault ??= error instanceof Error ? error : new Error('Schedule service failed.');
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

  private ownerStatus(owner: ScheduleOwner): boolean | undefined {
    try { return this.options.isOwnerCurrent(ownerOf(owner)); } catch { return undefined; }
  }

  private current(owner: ScheduleOwner): boolean {
    return this.ownerStatus(owner) === true;
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

  private async readCatalog(filename: string): Promise<unknown | undefined> {
    let handle: fs.FileHandle;
    try {
      const stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Schedule catalog must be a regular file, not a symlink.');
      handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
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

  private load(data: unknown, hostCatalog = false): void {
    const catalog = object(data, ['version', 'records', 'pending', 'purged', 'cleanup', 'purgeRequests']);
    if (!(hostCatalog ? [6, 7, 8] : [1, 2, 3, 4, 5, 6]).includes(catalog.version as number) || !Array.isArray(catalog.records) || catalog.records.length > this.maxRecords
      || !Array.isArray(catalog.pending) || catalog.pending.length > this.maxPending) throw new Error('Invalid schedule catalog envelope.');
    const records = new Map<string, ScheduleRecord>();
    const pending = new Map<string, PendingDelivery>();
    for (const value of catalog.records) {
      const record = object(value, ['id', 'backend', 'cwd', 'prompt', 'rule', 'createdAt', 'nativeId', 'state', 'error', 'threadId', 'openId', 'generation', 'execution', 'cancelRequested', 'creationRefused', 'cleanupConfirmed', 'recovery', 'completedOccurrences', 'skippedOccurrences',
        'engine', 'sessionId', ...(Number(catalog.version) >= 7 ? ['bindingEpoch'] : []),
        ...(catalog.version === 8 ? ['lastOccurrence'] : []), 'nextDueAt', 'inFlightDueAt']);
      validateScheduleId(record.id); validateOwner(record as unknown as ScheduleOwner); validateSchedulePrompt(record.prompt);
      text(record.cwd, 4096);
      if (!path.isAbsolute(record.cwd) || !(record.engine === 'host' ? isHostScheduleBackend(record.backend) : isNativeScheduleBackend(record.backend))
        || !STATES.has(record.state as ScheduleRecord['state'])
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
      if (record.engine === 'host') {
        if (Number(catalog.version) < 6 || record.nativeId !== undefined || record.recovery !== undefined
          || record.cleanupConfirmed !== undefined || record.creationRefused !== undefined || record.skippedOccurrences !== undefined
          || record.state === 'creating') throw new Error('Invalid host schedule identity.');
        if (Number(catalog.version) >= 7 && record.bindingEpoch === undefined && record.state !== 'interrupted') throw new Error('Missing host binding epoch.');
        if (record.bindingEpoch !== undefined || record.sessionId !== undefined) text(record.sessionId);
        const due = record.nextDueAt !== undefined ? record.nextDueAt : record.inFlightDueAt;
        if (record.lastOccurrence !== undefined) {
          const last = object(record.lastOccurrence, ['dueAt', 'status', 'error']);
          if (typeof last.dueAt !== 'number' || !Number.isSafeInteger(last.dueAt) || last.dueAt <= record.createdAt
            || (last.status === 'skipped' ? rule.kind !== 'cron' || nextHostDue(rule as unknown as ScheduleRule, last.dueAt - 1) !== last.dueAt
              : !Array.isArray(record.completedOccurrences) || record.completedOccurrences.at(-1) !== `host-${last.dueAt}`)
            || typeof due === 'number' && due <= last.dueAt || !['succeeded', 'failed', 'unknown', 'aborted', 'skipped'].includes(last.status as string)
            || last.error !== undefined && (last.status === 'succeeded' || typeof last.error !== 'string'
              || Buffer.byteLength(last.error) > ERROR_BYTES)) throw new Error('Invalid host occurrence outcome.');
        }
        if ((record.nextDueAt !== undefined) !== (record.state === 'active')
          || (record.state === 'running' && record.inFlightDueAt === undefined)
          || record.inFlightDueAt !== undefined && !['running', 'cancelled'].includes(record.state as string)
          || record.cancelRequested && LIVE.has(record.state as ScheduleRecord['state'])
          || record.state === 'cancelled' && !record.cancelRequested) throw new Error('Invalid host schedule state.');
        if (due !== undefined && (typeof due !== 'number' || !Number.isSafeInteger(due) || due <= record.createdAt
          || nextHostDue(rule as unknown as ScheduleRule, due - 1) !== due
          || Array.isArray(record.completedOccurrences) && record.completedOccurrences.includes(`host-${due}`))) throw new Error('Invalid host occurrence receipt.');
      } else if (record.engine !== undefined || record.sessionId !== undefined || record.nextDueAt !== undefined
        || record.inFlightDueAt !== undefined || record.lastOccurrence !== undefined) throw new Error('Unexpected host schedule fields.');
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
        const fence = object(value, ['id', 'threadId', 'openId', 'generation', ...(Number(catalog.version) >= 7 ? ['bindingEpoch'] : [])]);
        validateScheduleId(fence.id); validateOwner(fence as unknown as ScheduleOwner);
        if (records.has(fence.id) || purged.has(fence.id)) throw new Error('Conflicting purge fence.');
        purged.set(fence.id, ownerOf(fence as unknown as ScheduleOwner));
      }
    } else if (catalog.purged !== undefined) throw new Error('Purge fences require catalog version 3 or newer.');
    const cleanup = new Map<string, ScheduleCleanupRecord>();
    const purgeRequests = new Map<string, { digest: string; ids: string[] }>();
    if (Number(catalog.version) >= 5) {
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
    if (hostCatalog) {
      if (cleanup.size || [...records.values()].some(row => row.engine !== 'host')) {
        throw new Error('Invalid host schedule catalog.');
      }
      for (const id of [...records.keys(), ...purged.keys()]) {
        if (this.records.has(id) || this.purged.has(id) || this.unavailableLegacyIds.has(id)) throw new Error('Conflicting schedule catalog ID.');
        this.hostCatalogIds.add(id);
      }
      for (const key of purgeRequests.keys()) {
        if (this.purgeRequests.has(key)) throw new Error('Conflicting schedule purge request.');
        this.hostPurgeRequests.add(key);
      }
    }
    for (const [id, row] of records) this.records.set(id, row);
    for (const [id, row] of pending) this.pending.set(id, row);
    for (const [id, row] of purged) this.purged.set(id, row);
    for (const [id, row] of cleanup) this.cleanup.set(id, row);
    for (const [key, row] of purgeRequests) this.purgeRequests.set(key, row);
    this.catalogDigests.set(hostCatalog ? this.hostCatalogPath : this.catalogPath,
      createHash('sha256').update(JSON.stringify(data)).digest('hex'));
  }

  private async persist(): Promise<void> {
    if (!this.catalogGate) throw new Error('Schedule catalog ownership is unavailable.');
    this.catalogGate.verify();
    if (this.fault) throw this.fault;
    try {
      if (!this.legacyUnavailable) await this.persistCatalog(false);
      if (this.hostCatalogIds.size || this.hostPurgeRequests.size) await this.persistCatalog(true);
      this.armHostTimer();
    } catch (error) {
      this.fault = error instanceof Error ? error : new Error('Schedule catalog write failed.');
      throw this.fault;
    }
  }

  private async persistCatalog(host: boolean): Promise<void> {
    const filename = host ? this.hostCatalogPath : this.catalogPath;
    const belongs = (id: string) => this.hostCatalogIds.has(id) === host;
    const snapshot = JSON.stringify({ version: host ? 8 : 6,
      records: [...this.records.values()].filter(row => belongs(row.id)),
      pending: [...this.pending.values()].filter(row => belongs(row.scheduleId)),
      cleanup: host ? [] : [...this.cleanup.values()],
      purgeRequests: [...this.purgeRequests].filter(([key]) => this.hostPurgeRequests.has(key) === host).map(([key, receipt]) => ({ key, ...receipt })),
      purged: [...this.purged].filter(([id]) => belongs(id)).map(([id, owner]) => ({ id, ...owner })) });
    const digest = createHash('sha256').update(snapshot).digest('hex');
    if (this.catalogDigests.get(filename) === digest) return;
    const temporary = path.join(path.dirname(filename), `.schedule-${randomUUID()}.tmp`);
    try {
      try {
        const stat = await fs.lstat(filename);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Schedule catalog is not a regular file.');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const handle = await fs.open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(snapshot, 'utf8');
        await handle.sync();
      } finally { await handle.close(); }
      await fs.rename(temporary, filename);
      syncDirectory(path.dirname(filename));
      this.catalogDigests.set(filename, digest);
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }
}
