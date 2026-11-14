import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ScheduleService, SCHEDULE_CATALOG_FILE, type ScheduleServiceOptions } from '../src/scheduling/ScheduleService';
import { NativeScheduleCleanupError, type NativeScheduleEvent, type NativeScheduleHandle, type NativeScheduleInput,
  type NativeScheduleProvider, type NativeScheduleRecovery, type ScheduleOwner, type ScheduleRecord } from '../src/scheduling/types';

const owner: ScheduleOwner = { threadId: 'thread-a', openId: 'owner-a', generation: 'generation-a' };
const epoch = Date.parse('2030-01-01T00:00:00Z');
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

/** Synthetic native engine. No model, network, native executable or execution timer. */
class NativeInventory implements NativeScheduleProvider {
  store = new Map<string, { input: NativeScheduleInput; paused: boolean; emit(event: NativeScheduleEvent): void }>();
  predecessorExcluded = false;
  capabilities = true;
  handoff = true;
  releaseRace = false;
  calls = 0;
  creations = 0;
  stops = 0;
  hook?: (record: ScheduleRecord, context: Parameters<NativeScheduleRecovery['reconcile']>[1],
    emit: (event: NativeScheduleEvent) => void) => Promise<NativeScheduleHandle>;
  recovery: NativeScheduleRecovery;
  constructor(readonly strategy: 'reattach' | 'reconstruct') {
    this.recovery = {
      provider: `fixture-${strategy}-v1`, strategy,
      describe: (input, identity) => `${identity.threadId}:${identity.generation}:${input.id}:original-session`,
      reconcile: async (record, context, emit) => {
        this.calls++;
        if (this.hook) return this.hook(record, context, emit);
        if (!context.isCurrent() || !this.predecessorExcluded) throw new Error('Predecessor exclusion unconfirmed.');
        const existing = this.store.get(record.id);
        if (strategy === 'reattach' && !existing) throw new Error('Authoritative inventory missing.');
        if (existing && existing.input.recovery?.identity !== record.recovery?.identity) throw new Error('Native ownership mismatch.');
        if (!existing) {
          // Reconstruction is explicitly idempotent, only after predecessor exclusion.
          this.creations++;
          this.store.set(record.id, { input: { id: record.id, cwd: record.cwd, prompt: record.prompt,
            rule: record.rule, recovery: record.recovery }, paused: false, emit });
        } else { existing.emit = emit; existing.paused = false; }
        return this.handle(record.id);
      },
    };
  }
  recoveryFor() { return this.capabilities ? this.recovery : undefined; }
  async create(input: NativeScheduleInput, emit: (event: NativeScheduleEvent) => void) {
    this.creations++;
    this.store.set(input.id, { input, emit, paused: false });
    return this.handle(input.id);
  }
  handle(id: string): NativeScheduleHandle {
    const stop = async () => { this.stops++; this.store.delete(id); };
    return { nativeId: `native-${id}`, list: async () => this.store.has(id), cancel: stop, stop,
      ...(this.handoff ? { releaseForRestart: async () => {
        if (this.releaseRace) { this.emit(id, { type: 'started', occurrenceId: 'raced' }); throw new Error('Native occurrence already started.'); }
        this.predecessorExcluded = true;
        if (this.strategy === 'reattach') this.store.get(id)!.paused = true;
        else this.store.delete(id);
        return this.strategy === 'reconstruct' ? { nativeDefinitionAbsent: true as const } : undefined;
      } } : {}) };
  }
  emit(id: string, event: NativeScheduleEvent) { this.store.get(id)!.emit(event); }
}

describe('durable provider-neutral schedule recovery', () => {
  let directory: string;
  let native: NativeInventory;
  let services: ScheduleService[];
  let current: boolean;
  let ready: boolean;
  let now: number;
  let deliver: ReturnType<typeof vi.fn>;
  const make = (options: Partial<ScheduleServiceOptions> = {}) => {
    const service = new ScheduleService({ directory, provider: native, deliver, now: () => now,
      isOwnerCurrent: () => current, canRecover: () => ready, ...options });
    services.push(service); return service;
  };
  const input = (id = 'job-a', once = false): NativeScheduleInput => ({ id, cwd: directory, backend: 'dsh',
    prompt: 'Inspect synthetic build', model: 'fixture-model', effort: 'low',
    rule: once ? { kind: 'once', at: '2030-01-01T00:10:00.000Z' } : { kind: 'cron', expression: '*/5 * * * *', timezone: 'UTC' } });
  const catalog = () => fs.readFile(path.join(directory, SCHEDULE_CATALOG_FILE), 'utf8').then(JSON.parse);
  const write = (data: unknown) => fs.writeFile(path.join(directory, SCHEDULE_CATALOG_FILE), JSON.stringify(data));
  const start = async () => { const service = make(); await service.initialize(); await service.create(owner, input()); return service; };
  const restart = async (service: ScheduleService, options: Partial<ScheduleServiceOptions> = {}) => {
    await service.destroy(); const next = make(options); await next.initialize(); return next;
  };
  beforeEach(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'schedule-recovery-')));
    vi.spyOn(os, 'homedir').mockReturnValue(directory);
    native = new NativeInventory('reattach'); services = []; current = ready = true; now = epoch;
    deliver = vi.fn(async () => {});
  });
  afterEach(async () => {
    await Promise.allSettled(services.map(service => service.destroy()));
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it.each(['reattach', 'reconstruct'] as const)('restores %s on startup with original identity and no duplicate attempt', async strategy => {
    native = new NativeInventory(strategy);
    const first = await start();
    const before = (await first.list(owner))[0];
    expect(before.execution).toEqual({ model: 'fixture-model', effort: 'low' });
    const next = await restart(first);
    await Promise.all([next.recover(), next.recover(), next.recover()]);
    expect(native.calls).toBe(1);
    expect(native.creations).toBe(strategy === 'reattach' ? 1 : 2);
    expect((await next.list(owner))[0]).toMatchObject({ state: 'active', recovery: { identity: before.recovery!.identity } });
    native.emit('job-a', { type: 'started', occurrenceId: 'future-1' });
    native.emit('job-a', { type: 'completed', occurrenceId: 'future-1', success: true, output: 'Synthetic result' });
    await next.retryDeliveries();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0].schedule.threadId).toBe(owner.threadId);
    await next.recover(); expect(native.calls).toBe(1);
  });

  it('does not acknowledge cancellation of a cleanly paused persistent job as native deletion', async () => {
    const next = await restart(await start());
    expect(native.store.get('job-a')?.paused).toBe(true);
    await expect(next.cancel(owner, 'job-a')).rejects.toThrow('unconfirmed');
    expect((await next.list(owner))[0]).toMatchObject({ state: 'interrupted', cancelRequested: true });
    expect(next.hasActiveSchedules()).toBe(true);
    await next.recover(); expect(native.calls).toBe(0);
  });

  it('keeps cleanup ownership when a cleanly paused persistent one-shot expires', async () => {
    const first = make(); await first.initialize(); await first.create(owner, input('job-a', true));
    const next = await restart(first); now += 20 * 60_000; await next.recover();
    expect(native.store.has('job-a')).toBe(true);
    expect(next.hasActiveSchedules()).toBe(true);
    expect((await next.list(owner))[0]).toMatchObject({ recovery: { status: 'blocked' } });
  });

  it.each(['cancel', 'expire'] as const)('retires a clean absent definition after %s without native mutation', async action => {
    native = new NativeInventory('reconstruct');
    const first = make(); await first.initialize(); await first.create(owner, input('job-a', action === 'expire'));
    const next = await restart(first);
    expect((await next.list(owner))[0].recovery?.nativeDefinitionAbsent).toBe(true);
    if (action === 'cancel') expect((await next.cancel(owner, 'job-a')).state).toBe('cancelled');
    else { now += 20 * 60_000; await next.recover(); }
    expect(next.hasActiveSchedules()).toBe(false); expect(native.calls).toBe(0);
    expect(native.store.size).toBe(0);
  });

  it('consumes native absence evidence together with clean proof before restore', async () => {
    native = new NativeInventory('reconstruct');
    const next = await restart(await start());
    native.hook = async () => {
      const record = (await catalog()).records[0];
      expect(record.recovery.handoff).toBeUndefined();
      expect(record.recovery.nativeDefinitionAbsent).toBeUndefined();
      throw new Error('Synthetic admission uncertainty');
    };
    await next.recover();
    await expect(next.cancel(owner, 'job-a')).rejects.toThrow('unresolved');
  });

  it('keeps occurrence deduplication across restart and preserves failed outbox delivery IDs', async () => {
    const first = await start();
    deliver.mockRejectedValue(new Error('Offline'));
    native.emit('job-a', { type: 'completed', occurrenceId: 'occurrence-a', success: true, output: 'Synthetic result' });
    await first.retryDeliveries();
    const next = await restart(first); await next.recover();
    deliver.mockResolvedValue(undefined); await next.retryDeliveries();
    const delivered = deliver.mock.calls.length;
    native.emit('job-a', { type: 'completed', occurrenceId: 'occurrence-a', success: true, output: 'Duplicate' });
    await next.retryDeliveries();
    expect(deliver).toHaveBeenCalledTimes(delivered);
    expect(deliver.mock.calls.at(-1)![0].id).toBe('job-a:occurrence-a');
  });

  it('waits for readiness and matching provider capability before any native admission', async () => {
    const first = await start(); const next = await restart(first);
    native.capabilities = false; await next.recover(); expect(native.calls).toBe(0);
    native.capabilities = true; ready = false; await next.recover(); expect(native.calls).toBe(0);
    ready = true; await next.recover(); expect(native.calls).toBe(1);
  });

  it('refuses a different provider protocol and retains the pending intent', async () => {
    const next = await restart(await start());
    native.recovery = { ...native.recovery, provider: 'other-v1' };
    await next.recover();
    expect(native.calls).toBe(0);
    expect((await next.list(owner))[0]).toMatchObject({ state: 'interrupted', recovery: { status: 'pending' } });
    expect(next.hasActiveSchedules()).toBe(true);
  });

  it.each(['owner', 'deadline', 'cancel', 'running', 'creating'] as const)('never replays %s after restart', async reason => {
    const first = make(); await first.initialize(); await first.create(owner, input('job-a', reason === 'deadline'));
    if (reason === 'cancel') await first.cancel(owner, 'job-a');
    if (reason === 'running') {
      native.emit('job-a', { type: 'started', occurrenceId: 'in-flight' }); await first.list(owner);
    }
    const bytes = await catalog();
    await first.destroy();
    if (reason === 'creating') bytes.records[0].state = 'creating';
    await write(bytes); // Synthetic crash snapshot, not a real session.
    if (reason === 'owner') current = false;
    if (reason === 'deadline') now += 20 * 60_000;
    const next = make(); await next.initialize(); await next.recover();
    expect(native.calls).toBe(0);
    expect((await next.list(owner))[0].state).not.toBe('active');
  });

  it.each(['completed', 'cancelled', 'failed'] as const)('keeps a %s tombstone terminal even with a stale pending checkpoint', async state => {
    const first = await start(); await first.destroy();
    const data = await catalog(); data.records[0].state = state; data.records[0].recovery.status = 'pending';
    await write(data);
    const next = make(); await next.initialize(); await next.recover();
    expect((await next.list(owner))[0].state).toBe(state); expect(native.calls).toBe(0);
  });

  it('cleans a late error-after-commit receipt without releasing its admission early', async () => {
    const release = vi.fn();
    const next = await restart(await start(), { recoveryTimeoutMs: 20, acquireRecovery: () => release });
    const gate = deferred<void>();
    native.hook = async () => { await gate.promise; throw new NativeScheduleCleanupError('Late commit', native.handle('job-a')); };
    await next.recover(); expect(release).not.toHaveBeenCalled();
    gate.resolve();
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    expect(native.store.size).toBe(0);
    expect((await catalog()).records[0].nativeId).toBe('native-job-a');
  });

  it('holds admission through inventory validation, not only the native receipt', async () => {
    const release = vi.fn(), inventory = deferred<boolean>();
    const next = await restart(await start(), { acquireRecovery: () => release });
    native.hook = async () => ({ ...native.handle('job-a'), list: () => inventory.promise });
    const recovery = next.recover(); await vi.waitFor(() => expect(native.calls).toBe(1));
    expect(release).not.toHaveBeenCalled();
    inventory.resolve(true); await recovery; expect(release).toHaveBeenCalledOnce();
  });

  it('serializes multiple native restorations and never invokes CREATE as a retry', async () => {
    const first = await start(); await first.create(owner, input('job-b'));
    const next = await restart(first), gate = deferred<NativeScheduleHandle>();
    const reconcile = native.recovery.reconcile;
    let entered = 0;
    native.recovery = { ...native.recovery, reconcile: async (record, context, emit) => {
      entered++;
      if (record.id === 'job-a') return gate.promise;
      return reconcile(record, context, emit);
    } };
    const recovering = next.recover(); await vi.waitFor(() => expect(entered).toBe(1));
    gate.resolve(native.handle('job-a')); await recovering;
    expect(entered).toBe(2); expect(native.creations).toBe(2);
  });

  it('counts unresolved recovery ownership against capacity', async () => {
    const first = make({ maxLiveSchedules: 1 }); await first.initialize(); await first.create(owner, input());
    const next = await restart(first, { maxLiveSchedules: 1 });
    native.capabilities = false; await next.recover();
    await expect(next.create(owner, input('job-b'))).rejects.toThrow('limit');
  });

  it('keeps stale callbacks from a released predecessor out of the successor catalog', async () => {
    const first = await start(), oldEmit = native.store.get('job-a')!.emit;
    const next = await restart(first); await next.recover();
    oldEmit({ type: 'started', occurrenceId: 'stale' });
    oldEmit({ type: 'completed', occurrenceId: 'stale', success: true, output: 'Stale' });
    await first.destroy(); await next.retryDeliveries();
    expect(deliver).not.toHaveBeenCalled();
    expect((await catalog()).records[0].state).toBe('active');
  });

  it('never admits native reconciliation when checkpoint persistence fails', async () => {
    const next = await restart(await start());
    const filename = path.join(directory, SCHEDULE_CATALOG_FILE);
    await fs.unlink(filename); await fs.mkdir(filename);
    await next.recover();
    expect(native.calls).toBe(0);
    await expect(next.list(owner)).rejects.toThrow('regular file');
  });

  it('keeps failed recovery ownership upgrade-blocking across a crash, without reviving the job', async () => {
    const first = await start(); await first.destroy();
    const data = await catalog(); data.records[0].state = 'failed'; data.records[0].error = 'Unconfirmed native mutation'; delete data.records[0].recovery.handoff;
    await write(data);
    const next = make(); await next.initialize(); await next.recover();
    expect(next.hasActiveSchedules()).toBe(true); expect(native.calls).toBe(0);
    await expect(next.cancel(owner, 'job-a')).rejects.toThrow('unconfirmed');
    expect((await catalog()).records[0].cancelRequested).toBe(true);
  });

  it('does not interpret a saved absolute deadline as a new delay', async () => {
    const first = make(); await first.initialize(); await first.create(owner, input('job-a', true));
    const next = await restart(first); now += 3 * 60_000;
    await next.recover();
    expect(native.store.get('job-a')!.input.rule).toEqual({ kind: 'once', at: '2030-01-01T00:10:00.000Z' });
  });

  it('blocks recovery when native inventory cannot prove predecessor exclusion', async () => {
    const next = await restart(await start()); native.predecessorExcluded = false;
    await next.recover(); await next.recover();
    expect(native.calls).toBe(1);
    expect((await next.list(owner))[0]).toMatchObject({ recovery: { status: 'blocked' }, error: 'Predecessor exclusion unconfirmed.' });
  });

  it('retains cancellation intent before a failed native delete and never revives it', async () => {
    const first = await start();
    const runtime = native.store.get('job-a')!;
    // Use a fresh fixture handle whose deletion fails, without private service mutation.
    await first.destroy();
    const next = make(); await next.initialize();
    native.hook = async () => ({ ...native.handle('job-a'), cancel: async () => { throw new Error('Deletion unconfirmed'); } });
    await next.recover();
    await expect(next.cancel(owner, 'job-a')).rejects.toThrow('Deletion unconfirmed');
    expect((await catalog()).records[0].cancelRequested).toBe(true);
    expect(runtime.input.prompt).toBe('Inspect synthetic build');
    const snapshot = await catalog(); await next.destroy(); await write(snapshot);
    const again = make(); await again.initialize(); await again.recover(); expect(native.calls).toBe(1);
  });

  it('cancels a pending recovery without acknowledging unknown native deletion, then cleans its late receipt', async () => {
    const next = await restart(await start());
    const gate = deferred<NativeScheduleHandle>(); native.hook = async () => gate.promise;
    const recovery = next.recover(); await vi.waitFor(() => expect(native.calls).toBe(1));
    await expect(next.cancel(owner, 'job-a')).rejects.toThrow('unresolved');
    expect((await catalog()).records[0].cancelRequested).toBe(true);
    gate.resolve(native.handle('job-a')); await recovery;
    expect(native.store.size).toBe(0);
    expect((await next.list(owner))[0].state).not.toBe('active');
  });

  it('bounds a missing receipt, keeps ownership exclusive and cleans a late accepted handle', async () => {
    const next = await restart(await start(), { recoveryTimeoutMs: 20 });
    const gate = deferred<NativeScheduleHandle>(); native.hook = async () => gate.promise;
    await next.recover(); await next.recover();
    expect(native.calls).toBe(1);
    expect((await next.list(owner))[0].error).toContain('timed out');
    await expect(next.destroy()).rejects.toThrow('unresolved');
    gate.resolve(native.handle('job-a'));
    await vi.waitFor(() => expect(native.store.size).toBe(0));
    await next.destroy();
  });

  it('retains an error-after-commit handle when cleanup is unconfirmed', async () => {
    const next = await restart(await start());
    const handle = { ...native.handle('job-a'), stop: vi.fn(async () => { throw new Error('Cleanup unavailable'); }) };
    native.hook = async () => { throw new NativeScheduleCleanupError('Committed without receipt', handle); };
    await next.recover();
    expect(next.hasActiveSchedules()).toBe(true);
    expect((await next.list(owner))[0].error).toContain('Cleanup unavailable');
    expect((await catalog()).records[0].recovery.identity).toContain('original-session');
    handle.stop.mockResolvedValue(undefined); await next.cancel(owner, 'job-a');
    expect((await next.list(owner))[0].state).toBe('cancelled');
  });

  it('fences owner retirement while native recovery is outstanding', async () => {
    const next = await restart(await start());
    const gate = deferred<NativeScheduleHandle>(); native.hook = async () => gate.promise;
    const recovery = next.recover(); await vi.waitFor(() => expect(native.calls).toBe(1));
    current = false; gate.resolve(native.handle('job-a')); await recovery;
    expect(native.store.size).toBe(0); expect(deliver).not.toHaveBeenCalled();
  });

  it('blocks orderly handoff when an occurrence races release', async () => {
    const first = await start(); native.releaseRace = true;
    await expect(first.destroy()).rejects.toThrow('started');
    expect((await catalog()).records[0].recovery.status).toBe('blocked');
    native.releaseRace = false;
  });

  it('requires the release receipt to match the durable negotiated handoff policy', async () => {
    Object.assign(native.recovery, { handoffPolicy: 'skip-unadmitted' });
    const first = await start();
    await expect(first.suspendForRestart()).rejects.toThrow('policy receipt changed');
    expect(first.hasUnresolvedHandoff()).toBe(true);
    expect((await catalog()).records[0].recovery.handoff).toBeUndefined();
  });

  it('does not preserve shutdown eligibility without native quiescence', async () => {
    native.handoff = false;
    const next = await restart(await start()); await next.recover();
    expect(native.calls).toBe(0); expect(native.store.size).toBe(0);
  });

  it('does not revive legacy interrupted records or accept newer unknown schema', async () => {
    const first = await start(); await first.destroy();
    const data = await catalog(); data.version = 1;
    delete data.records[0].recovery; data.records[0].state = 'interrupted';
    await write(data); const next = make(); await next.initialize(); await next.recover(); expect(native.calls).toBe(0);
    await next.destroy(); data.version = 999; await write(data);
    await expect(make().initialize()).rejects.toThrow('envelope');
  });

  it('reloads observed skipped identities separately from successful delivery history', async () => {
    const first = await start(); await first.destroy();
    const data = await catalog();
    data.records[0].completedOccurrences = ['finished', 'skipped'];
    data.records[0].skippedOccurrences = ['skipped'];
    await write(data);
    const next = make(); await next.initialize();
    expect((await next.list(owner))[0].skippedOccurrences).toEqual(['skipped']);
    expect(deliver).not.toHaveBeenCalled();
  });

  it.each([
    { completedOccurrences: ['known'], skippedOccurrences: ['unknown'] },
    { completedOccurrences: ['known'], skippedOccurrences: ['known', 'known'] },
    { skippedOccurrences: 'unknown' },
    { recovery: { version: 1, provider: 'fixture', strategy: 'reattach', identity: 'identity', status: 'pending', handoffPolicy: 'unknown' } },
    { recovery: { version: 9, provider: 'fixture', strategy: 'reattach', identity: 'identity', status: 'pending' } },
    { recovery: { version: 1, provider: 'fixture', strategy: 'unknown', identity: 'identity', status: 'pending' } },
    { recovery: { version: 1, provider: 'fixture', strategy: 'reattach', identity: 'identity', status: 'unknown' } },
    { cancelRequested: false },
    { recovery: { version: 1, provider: 'fixture', strategy: 'reattach', identity: 'original', status: 'pending', nativeDefinitionAbsent: true } }, { execution: { model: 42 } }, { completedOccurrences: ['same', 'same'] },
  ])('preserves corrupt recovery bytes without overwriting: %j', async patch => {
    const first = await start(); await first.destroy();
    const data = await catalog(); Object.assign(data.records[0], patch); await write(data);
    const bytes = await fs.readFile(path.join(directory, SCHEDULE_CATALOG_FILE), 'utf8');
    await expect(make().initialize()).rejects.toThrow();
    expect(await fs.readFile(path.join(directory, SCHEDULE_CATALOG_FILE), 'utf8')).toBe(bytes);
  });
});
