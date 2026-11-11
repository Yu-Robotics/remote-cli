import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateScheduleId, validateSchedulePrompt, validateScheduleRule } from './ScheduleCommand';
import type { NativeScheduleEvent, NativeScheduleHandle, NativeScheduleInput, NativeScheduleProvider,
  ScheduleDelivery, ScheduleOwner, ScheduleRecord, ScheduleRule } from './types';
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
  maxLiveSchedules?: number;
  maxRecords?: number;
  maxPendingDeliveries?: number;
  maxOccurrencesPerSchedule?: number;
}

interface PendingDelivery {
  id: string;
  scheduleId: string;
  occurrenceId: string;
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
      const data = await this.readCatalog();
      if (data !== undefined) this.load(data);
      let changed = false;
      for (const record of this.records.values()) {
        if (LIVE.has(record.state)) { record.state = 'interrupted'; record.error = RESTART_REASON; changed = true; }
      }
      for (const [id, delivery] of this.pending) {
        const record = this.records.get(delivery.scheduleId)!;
        if (record.state === 'cancelled' || !this.current(record)) { this.pending.delete(id); changed = true; }
      }
      if (changed || data === undefined) await this.persist();
      this.initialized = true;
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
    const nativeInput = { ...structuredClone(input), backend };
    const runtime = this.newRuntime();
    await this.serial(async () => {
      this.checkReady();
      if (!this.current(originalOwner)) throw new Error('Schedule owner is no longer current.');
      if (this.records.has(nativeInput.id)) throw new Error('Schedule ID already exists.');
      if (this.records.size >= this.maxRecords) throw new Error('Schedule catalog is full; history was not pruned.');
      const liveCount = [...this.records.values()].filter(record => LIVE.has(record.state)
        || (this.runtimes.has(record.id) && !this.runtimes.get(record.id)!.stopped)).length;
      if (liveCount >= this.maxLive) throw new Error('Live native schedule limit reached.');
      this.records.set(nativeInput.id, { ...originalOwner, id: nativeInput.id, backend,
        cwd: nativeInput.cwd, prompt: nativeInput.prompt, rule: structuredClone(nativeInput.rule),
        createdAt, state: 'creating' });
      await this.persist();
      this.runtimes.set(nativeInput.id, runtime);
    });
    try {
      const handle = await this.options.provider.create(structuredClone(nativeInput), event => {
        const task = this.onEvent(nativeInput.id, structuredClone(event));
        this.track(task);
      });
      runtime.handle = handle;
      runtime.resolveReady(handle);
      text(handle.nativeId);
      await this.serial(async () => {
        const record = this.records.get(nativeInput.id)!;
        record.nativeId = handle.nativeId;
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
      && (LIVE.has(record.state) || (this.runtimes.has(record.id) && !this.runtimes.get(record.id)!.stopped)));
  }

  /** User-requested native reconciliation only; no background polling is installed. */
  refresh(owner: ScheduleOwner): Promise<void> {
    return this.operation(this.refreshNative(owner));
  }

  private async refreshNative(owner: ScheduleOwner): Promise<void> {
    this.checkReady(); validateOwner(owner);
    const candidates = await this.serial(async () => [...this.records.values()]
      .filter(record => sameOwner(record, owner)).map(record => record.id));
    await Promise.all(candidates.map(async id => {
      const runtime = this.runtimes.get(id);
      if (!runtime?.handle || runtime.stopped || runtime.cancelling || runtime.running.size || !this.current(owner)) return;
      if (!LIVE.has(this.records.get(id)!.state)) { await this.stop(id, runtime); return; }
      try {
        const present = await runtime.handle.list();
        if (present) return;
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
    }));
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
      if (runtime?.cancelPromise) { existing = runtime.cancelPromise; return; }
      if (!LIVE.has(record.state) && !runtime?.cancelling && (!runtime || runtime.stopped)) {
        this.dropPending(id);
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

  /** Explicit reconnect retry. No timer or periodic retry is installed. */
  async retryDeliveries(): Promise<void> {
    this.checkReady();
    const ids = await this.serial(async () => [...this.pending.keys()]);
    await this.attemptDeliveries(ids);
  }

  destroy(): Promise<void> {
    if (this.destruction) return this.destruction;
    this.closing = true;
    return this.destruction = (async () => {
      await this.initialization?.catch(() => {});
      let failure: unknown;
      await this.serial(async () => {
        for (const record of this.records.values()) {
          if (LIVE.has(record.state)) { record.state = 'interrupted'; record.error = 'Native schedule interrupted by service shutdown.'; }
        }
        if (this.initialized && !this.fault) await this.persist();
      }).catch(error => { failure = error; });
      const stops = await Promise.allSettled([...this.runtimes].map(([id, runtime]) => this.stop(id, runtime)));
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
        if (LIVE.has(this.records.get(id)!.state)) await handle.cancel();
        else await this.stop(id, runtime);
      }
      await this.serial(async () => {
        const record = this.records.get(id)!;
        record.state = 'cancelled'; delete record.error;
        this.dropPending(id);
        await this.persist();
      });
      runtime.cancelling = false;
      runtime.heldDeliveries.clear();
      await this.stop(id, runtime);
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
      if (this.closing || !ownerCurrent) {
        if (LIVE.has(record.state)) { record.state = 'interrupted'; record.error = 'Schedule owner or service is no longer current.'; }
        // Native stop notifications during shutdown must preserve completed outbox
        // entries for restart. Only actual ownership invalidation discards them.
        if (!ownerCurrent) this.dropPending(id);
        cleanup = true;
        await this.persist(); return;
      }
      if (record.state === 'cancelled' || record.state === 'failed' || record.state === 'completed') return;
      if (event.type === 'stopped') {
        if (LIVE.has(record.state)) { record.state = 'interrupted'; record.error = bounded(event.reason, ERROR_BYTES); }
      } else {
        text(event.occurrenceId);
        if (runtime.completed.has(event.occurrenceId)) return;
        if (record.state === 'interrupted' && (event.type !== 'completed' || !runtime.running.has(event.occurrenceId))) return;
        if (runtime.completed.size + runtime.running.size >= this.maxOccurrences && !runtime.running.has(event.occurrenceId)) {
          record.state = 'interrupted'; record.error = 'Occurrence tracking limit reached; native schedule stopped.'; cleanup = true;
        } else if (event.type === 'started') {
          runtime.running.add(event.occurrenceId); record.state = 'running';
        } else if (event.type === 'completed') {
          if (typeof event.success !== 'boolean') throw new Error('Invalid native completion event.');
          runtime.running.delete(event.occurrenceId);
          runtime.completed.add(event.occurrenceId);
          if (this.pending.size >= this.maxPending) {
            record.state = 'interrupted'; record.error = 'Delivery outbox is full; latest result could not be retained. Native schedule stopped.';
            cleanup = true;
          } else {
            delivery = deliveryId(id, event.occurrenceId);
            this.pending.set(delivery, { id: delivery, scheduleId: id, occurrenceId: event.occurrenceId,
              success: event.success, ...(event.output !== undefined && { output: bounded(event.output, OUTPUT_BYTES) }),
              ...(event.error !== undefined && { error: bounded(event.error, ERROR_BYTES) }) });
            if (record.rule.kind === 'once') { record.state = 'completed'; cleanup = true; }
            else if (record.state !== 'interrupted') record.state = runtime.running.size ? 'running' : 'active';
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
          if (!this.current(record) || record.state === 'cancelled') {
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
    if (runtime.stopPromise) return runtime.stopPromise;
    const operation = (async () => {
      try {
        const handle = await runtime.ready;
        if (handle && !runtime.stopped) await handle.stop();
        runtime.stopped = true;
      } catch (error) {
        await this.serial(async () => {
          this.records.get(id)!.error = `Native process exit unconfirmed: ${errorText(error)}`.slice(0, ERROR_BYTES / 4);
          if (!this.fault) await this.persist();
        });
        throw error;
      }
    })();
    runtime.stopPromise = operation;
    void operation.catch(() => { runtime.stopPromise = undefined; });
    return operation;
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
      const maxBytes = (this.maxRecords + this.maxPending) * (160 * 1024) + 4096;
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
    if (catalog.version !== 1 || !Array.isArray(catalog.records) || catalog.records.length > this.maxRecords
      || !Array.isArray(catalog.pending) || catalog.pending.length > this.maxPending) throw new Error('Invalid schedule catalog envelope.');
    const records = new Map<string, ScheduleRecord>();
    const pending = new Map<string, PendingDelivery>();
    for (const value of catalog.records) {
      const record = object(value, ['id', 'backend', 'cwd', 'prompt', 'rule', 'createdAt', 'nativeId', 'state', 'error', 'threadId', 'openId', 'generation']);
      validateScheduleId(record.id); validateOwner(record as unknown as ScheduleOwner); validateSchedulePrompt(record.prompt);
      text(record.cwd, 4096);
      if (!path.isAbsolute(record.cwd) || !isNativeScheduleBackend(record.backend) || !STATES.has(record.state as ScheduleRecord['state'])
        || typeof record.createdAt !== 'number' || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0
        || records.has(record.id)) throw new Error('Invalid schedule catalog record.');
      if (record.nativeId !== undefined) text(record.nativeId);
      if (record.error !== undefined && (typeof record.error !== 'string' || Buffer.byteLength(record.error) > ERROR_BYTES)) throw new Error('Invalid schedule error.');
      const rule = object(record.rule, ['kind', 'at', 'expression', 'timezone']);
      if (rule.kind === 'once') object(rule, ['kind', 'at']);
      else object(rule, ['kind', 'expression', 'timezone']);
      validateScheduleRule(rule as unknown as ScheduleRule);
      records.set(record.id, structuredClone(record) as unknown as ScheduleRecord);
    }
    for (const value of catalog.pending) {
      const item = object(value, ['id', 'scheduleId', 'occurrenceId', 'success', 'output', 'error']);
      validateScheduleId(item.scheduleId); text(item.occurrenceId);
      if (item.id !== deliveryId(item.scheduleId, item.occurrenceId) || !records.has(item.scheduleId)
        || pending.has(item.id as string) || typeof item.success !== 'boolean') throw new Error('Invalid pending schedule delivery.');
      for (const [field, limit] of [['output', OUTPUT_BYTES], ['error', ERROR_BYTES]] as const) {
        if (item[field] !== undefined && (typeof item[field] !== 'string' || Buffer.byteLength(item[field] as string) > limit)) throw new Error('Invalid delivery text.');
      }
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
        await handle.writeFile(JSON.stringify({ version: 1, records: [...this.records.values()], pending: [...this.pending.values()] }), 'utf8');
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
