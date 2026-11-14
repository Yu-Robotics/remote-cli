import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SCHEDULE_CATALOG_FILE, ScheduleService } from '../src/scheduling/ScheduleService';
import type { ScheduleServiceOptions } from '../src/scheduling/ScheduleService';
import { NativeScheduleCleanupError } from '../src/scheduling/types';
import type { NativeScheduleEvent, NativeScheduleHandle, NativeScheduleInput, NativeScheduleProvider,
  ScheduleDelivery, ScheduleOwner } from '../src/scheduling/types';

// Keep real filesystem operations, with configurable exports for the write barrier test.
vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
}));

const now = Date.parse('2030-01-01T00:00:00Z');
const owner: ScheduleOwner = { threadId: 'thread-a', openId: 'user-a', generation: 'epoch-a' };
const other: ScheduleOwner = { threadId: 'thread-b', openId: 'user-b', generation: 'epoch-b' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class Provider implements NativeScheduleProvider {
  events = new Map<string, (event: NativeScheduleEvent) => void>();
  handles = new Map<string, NativeScheduleHandle>();
  beforeResolve?: (id: string, event: (event: NativeScheduleEvent) => void) => Promise<void>;
  create = vi.fn(async (input: NativeScheduleInput, onEvent: (event: NativeScheduleEvent) => void) => {
    this.events.set(input.id, onEvent);
    const handle = { nativeId: `native-${input.id}`, list: vi.fn(async () => true),
      cancel: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    this.handles.set(input.id, handle);
    await this.beforeResolve?.(input.id, onEvent);
    return handle;
  });
  emit(id: string, event: NativeScheduleEvent) { this.events.get(id)!(event); }
}

describe('ScheduleService', () => {
  let directory: string;
  let provider: Provider;
  let deliver: ReturnType<typeof vi.fn>;
  let current: ReturnType<typeof vi.fn>;
  let services: ScheduleService[];
  const input = (id = 'schedule-a', recurring = false): NativeScheduleInput => ({ id, cwd: directory, prompt: 'Check the synthetic build',
    rule: recurring ? { kind: 'cron', expression: '*/5 * * * *', timezone: 'UTC' }
      : { kind: 'once', at: '2030-01-01T00:05:00.000Z' } });
  const make = (options: Partial<ScheduleServiceOptions> = {}) => {
    const service = new ScheduleService({ directory, provider, deliver: delivery => deliver(delivery),
      isOwnerCurrent: value => current(value), now: () => now, ...options });
    services.push(service);
    return service;
  };
  const read = async () => JSON.parse(await fs.readFile(path.join(directory, SCHEDULE_CATALOG_FILE), 'utf8'));
  const complete = (id = 'schedule-a', occurrenceId = 'occurrence-1') => provider.emit(id, {
    type: 'completed', occurrenceId, success: true, output: `Result ${occurrenceId}`,
  });
  const settled = async (service: ScheduleService) => {
    // retryDeliveries is a public synchronization point for queued state and delivery work.
    await service.list(owner);
    await service.retryDeliveries();
  };

  beforeEach(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'schedule-service-')));
    provider = new Provider();
    deliver = vi.fn(async (_delivery: ScheduleDelivery) => {});
    current = vi.fn(() => true);
    services = [];
  });
  afterEach(async () => {
    await Promise.allSettled(services.map(service => service.destroy()));
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('persists private catalog entries and never invokes native list for local listing', async () => {
    const service = make(); await service.initialize();
    const record = await service.create(owner, input());
    expect(record).toMatchObject({ ...owner, id: 'schedule-a', nativeId: 'native-schedule-a', backend: 'claude', state: 'active' });
    expect((await read()).records).toEqual([record]);
    expect(await service.list(owner)).toEqual([record]);
    expect(provider.handles.get(record.id)!.list).not.toHaveBeenCalled();
    expect(await fs.readdir(directory)).toEqual([SCHEDULE_CATALOG_FILE]);
    if (process.platform !== 'win32') expect((await fs.stat(path.join(directory, SCHEDULE_CATALOG_FILE))).mode & 0o777).toBe(0o600);
    record.openId = 'mutated'; record.rule = { kind: 'cron', expression: '* * * * *', timezone: 'UTC' };
    expect((await service.list(owner))[0].openId).toBe(owner.openId);
  });

  it('isolates listing and cancellation by the full immutable owner', async () => {
    const service = make(); await service.initialize();
    await service.create(owner, input());
    for (const stranger of [other, { ...owner, openId: 'other-user' }, { ...owner, generation: 'new-epoch' }]) {
      expect(await service.list(stranger)).toEqual([]);
      await expect(service.cancel(stranger, 'schedule-a')).rejects.toThrow('not found');
    }
    expect(provider.handles.get('schedule-a')!.cancel).not.toHaveBeenCalled();
    current.mockReturnValue(false);
    await expect(service.create(owner, input('schedule-b'))).rejects.toThrow('no longer current');
    expect(provider.create).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])('retains a shared cancelled occurrence outbox across restart only for its current owner (%s)', async ownerCurrent => {
    deliver.mockRejectedValue(new Error('Disconnected'));
    const service = make(); await service.initialize(); await service.create(owner, input('shared', true));
    Object.assign(provider.handles.get('shared')!, { cancellationKeepsRunning: true });
    provider.emit('shared', { type: 'started', occurrenceId: 'running-at-cancel' });
    await service.list(owner);
    await expect(service.cancel(owner, 'shared')).resolves.toMatchObject({ state: 'cancelled' });
    expect(service.hasActiveSchedules()).toBe(true);
    expect(service.canCancel(owner, 'shared')).toBe(false);
    complete('shared', 'running-at-cancel');
    provider.emit('shared', { type: 'stopped', exitConfirmed: true, reason: 'Owned job retired' });
    await settled(service);
    expect(service.hasActiveSchedules()).toBe(false);
    expect((await read()).pending).toMatchObject([{ afterCancellation: true, occurrenceId: 'running-at-cancel' }]);
    // Repeated cancellation must not erase an honest result from a started turn.
    await service.cancel(owner, 'shared');
    expect((await read()).pending).toHaveLength(1);
    await service.destroy(); current.mockReturnValue(ownerCurrent); deliver.mockClear(); deliver.mockResolvedValue(undefined);
    const restored = make(); await restored.initialize(); await restored.retryDeliveries(); await restored.retryDeliveries();
    expect(deliver).toHaveBeenCalledTimes(ownerCurrent ? 1 : 0);
    expect(provider.create).toHaveBeenCalledOnce(); expect((await read()).pending).toHaveLength(0);
  });

  it('retains a shared completion racing the native delete receipt', async () => {
    const service = make(); await service.initialize(); await service.create(owner, input('shared', true));
    const handle = provider.handles.get('shared')!; Object.assign(handle, { cancellationKeepsRunning: true });
    const gate = deferred<void>(); vi.mocked(handle.cancel).mockImplementation(() => gate.promise);
    provider.emit('shared', { type: 'started', occurrenceId: 'race' }); await service.list(owner);
    const cancellation = service.cancel(owner, 'shared');
    await vi.waitFor(() => expect(handle.cancel).toHaveBeenCalledOnce());
    complete('shared', 'race'); await service.list(owner);
    expect(deliver).not.toHaveBeenCalled(); gate.resolve(); await cancellation;
    await settled(service);
    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver.mock.calls[0][0]).toMatchObject({ occurrenceId: 'race', schedule: { state: 'cancelled' } });
  });

  it('serializes native refresh operations for jobs sharing a conversation', async () => {
    const service = make(); await service.initialize();
    await service.create(owner, input('first', true)); await service.create(owner, input('second', true));
    const gate = deferred<boolean>();
    vi.mocked(provider.handles.get('first')!.list).mockImplementation(() => gate.promise);
    const refresh = service.refresh(owner);
    await vi.waitFor(() => expect(provider.handles.get('first')!.list).toHaveBeenCalledOnce());
    expect(provider.handles.get('second')!.list).not.toHaveBeenCalled();
    gate.resolve(true); await refresh;
    expect(provider.handles.get('second')!.list).toHaveBeenCalledOnce();
  });

  it('uses explicit shared-job cancellation to reconcile failed creation instead of repeating automatic stop', async () => {
    let cancelled = false;
    const handle: NativeScheduleHandle = { nativeId: 'unconfirmed-synthetic', cancellationKeepsRunning: true,
      list: vi.fn(async () => true), cancel: vi.fn(async () => { cancelled = true; }),
      stop: vi.fn(async () => { if (!cancelled) throw new Error('Explicit reconciliation required'); }),
    };
    provider.create.mockRejectedValueOnce(new NativeScheduleCleanupError('Uncertain creation', handle));
    const service = make(); await service.initialize();
    await expect(service.create(owner, input())).rejects.toThrow('Uncertain creation');
    expect(service.hasActiveSchedules()).toBe(true);
    await expect(service.cancel(owner, 'schedule-a')).resolves.toMatchObject({ state: 'cancelled' });
    expect(handle.cancel).toHaveBeenCalledOnce(); expect(service.hasActiveSchedules()).toBe(false);
    expect(provider.create).toHaveBeenCalledOnce();
  });

  it('preserves DSH identity across native creation, outbox persistence, and restart without recreating jobs', async () => {
    deliver.mockRejectedValue(new Error('Disconnected'));
    const service = make(); await service.initialize();
    const record = await service.create(owner, { ...input(), backend: 'dsh' });
    expect(record.backend).toBe('dsh');
    expect(provider.create.mock.calls[0][0].backend).toBe('dsh');
    provider.emit(record.id, { type: 'started', occurrenceId: 'native-dsh-occurrence' });
    complete(record.id, 'native-dsh-occurrence');
    await settled(service);
    await service.destroy();
    deliver.mockResolvedValue(undefined);
    const restored = make(); await restored.initialize();
    await restored.retryDeliveries();
    expect(deliver.mock.calls.at(-1)![0]).toMatchObject({ occurrenceId: 'native-dsh-occurrence',
      schedule: { backend: 'dsh', threadId: owner.threadId, state: 'completed' } });
    expect(provider.create).toHaveBeenCalledOnce();
    expect((await read()).records[0].backend).toBe('dsh');
  });

  it.each([true, false])('preserves shutdown outbox only for a current owner (%s)', async ownerCurrent => {
    deliver.mockRejectedValue(new Error('Disconnected'));
    const service = make(); await service.initialize();
    await service.create(owner, input('recurring', true));
    complete('recurring', 'offline-result');
    await settled(service);
    expect((await read()).pending).toHaveLength(1);
    vi.mocked(provider.handles.get('recurring')!.stop).mockImplementation(async () => {
      provider.emit('recurring', { type: 'stopped', exitConfirmed: true, reason: 'Shutdown completed' });
    });
    current.mockReturnValue(ownerCurrent);
    await service.destroy();
    expect((await read()).pending).toHaveLength(ownerCurrent ? 1 : 0);
    expect((await read()).records[0].state).toBe('interrupted');
    deliver.mockClear().mockResolvedValue(undefined);
    const restored = make(); await restored.initialize();
    await restored.retryDeliveries();
    expect(deliver).toHaveBeenCalledTimes(ownerCurrent ? 1 : 0);
    expect((await read()).pending).toEqual([]);
    expect(provider.create).toHaveBeenCalledOnce();
  });

  it('retains an early completed result when shutdown precedes the native create receipt', async () => {
    deliver.mockRejectedValue(new Error('Disconnected'));
    const gate = deferred<void>();
    provider.beforeResolve = async () => gate.promise;
    const service = make(); await service.initialize();
    const creating = service.create(owner, input('early', true));
    await vi.waitFor(() => expect(provider.handles.has('early')).toBe(true));
    complete('early', 'early-result');
    await settled(service);
    expect((await read()).pending).toHaveLength(1);
    const stopping = service.destroy();
    gate.resolve();
    await creating;
    await stopping;
    expect((await read()).pending).toHaveLength(1);
    deliver.mockClear().mockResolvedValue(undefined);
    const restored = make(); await restored.initialize();
    await restored.retryDeliveries();
    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver.mock.calls[0][0].occurrenceId).toBe('early-result');
    expect(provider.create).toHaveBeenCalledOnce();
  });

  it.each(['codex', 'unknown', '__proto__', null])('rejects unsupported backend %s before invoking a provider or saving a job', async backend => {
    const service = make(); await service.initialize();
    await expect(service.create(owner, { ...input(), backend } as NativeScheduleInput)).rejects.toThrow('unsupported');
    expect(provider.create).not.toHaveBeenCalled();
    expect((await read()).records).toEqual([]);
  });

  it('preserves early completion before create returns and stops a one-shot process', async () => {
    const gate = deferred<void>();
    provider.beforeResolve = async (_id, emit) => {
      emit({ type: 'started', occurrenceId: 'early-1' });
      emit({ type: 'completed', occurrenceId: 'early-1', success: true, output: 'Early result' });
      await gate.promise;
    };
    const service = make(); await service.initialize();
    const creation = service.create(owner, input());
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect((await read()).records[0].state).toBe('completed');
    expect((await read()).records[0].nativeId).toBeUndefined();
    gate.resolve();
    expect(await creation).toMatchObject({ state: 'completed', nativeId: 'native-schedule-a' });
    expect(provider.handles.get('schedule-a')!.stop).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0]).toMatchObject({ id: 'schedule-a:early-1', occurrenceId: 'early-1', schedule: owner });
  });

  it('queues failed delivery durably and only retries on explicit reconnect', async () => {
    deliver.mockRejectedValue(new Error('Disconnected'));
    const service = make(); await service.initialize(); await service.create(owner, input('schedule-a', true));
    complete();
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    complete();
    await service.list(owner);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect((await read()).pending).toHaveLength(1);
    complete('schedule-a', 'occurrence-2');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    expect((await read()).pending).toHaveLength(2);
    deliver.mockResolvedValue(undefined);
    await Promise.all([service.retryDeliveries(), service.retryDeliveries()]);
    expect(deliver).toHaveBeenCalledTimes(4);
    expect((await read()).pending).toEqual([]);
    complete(); complete('schedule-a', 'occurrence-2');
    await settled(service);
    expect(deliver).toHaveBeenCalledTimes(4);
  });

  it('supports multiple recurring occurrences and preserves running state for overlapping events', async () => {
    const service = make(); await service.initialize(); await service.create(owner, input('schedule-a', true));
    provider.emit('schedule-a', { type: 'started', occurrenceId: 'occurrence-1' });
    provider.emit('schedule-a', { type: 'started', occurrenceId: 'occurrence-2' });
    complete(); await settled(service);
    expect((await service.list(owner))[0].state).toBe('running');
    complete('schedule-a', 'occurrence-2'); await settled(service);
    expect((await service.list(owner))[0].state).toBe('active');
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(provider.handles.get('schedule-a')!.stop).not.toHaveBeenCalled();
  });

  it('gives confirmed cancellation precedence over an in-flight completion and trailing events', async () => {
    const service = make(); await service.initialize(); await service.create(owner, input());
    const gate = deferred<void>();
    const handle = provider.handles.get('schedule-a')!;
    vi.mocked(handle.cancel).mockImplementation(async () => { complete(); await gate.promise; });
    const cancellation = service.cancel(owner, 'schedule-a');
    await vi.waitFor(() => expect(handle.cancel).toHaveBeenCalledTimes(1));
    await service.list(owner);
    expect(deliver).not.toHaveBeenCalled();
    expect(handle.stop).not.toHaveBeenCalled();
    gate.resolve();
    expect(await cancellation).toMatchObject({ state: 'cancelled' });
    complete('schedule-a', 'late'); provider.emit('schedule-a', { type: 'stopped', reason: 'Cancelled process exited' });
    await settled(service);
    expect((await service.list(owner))[0].state).toBe('cancelled');
    expect((await read()).pending).toEqual([]);
    expect(deliver).not.toHaveBeenCalled(); expect(handle.stop).toHaveBeenCalledTimes(1);
  });

  it('cancels a creating schedule once its handle exists and coalesces duplicate cancellation', async () => {
    const gate = deferred<void>(); provider.beforeResolve = () => gate.promise;
    const service = make(); await service.initialize();
    const creation = service.create(owner, input());
    await vi.waitFor(() => expect(provider.create).toHaveBeenCalledTimes(1));
    const one = service.cancel(owner, 'schedule-a'); const two = service.cancel(owner, 'schedule-a');
    await service.list(owner); gate.resolve();
    await creation;
    expect(await one).toMatchObject({ state: 'cancelled' }); expect(await two).toMatchObject({ state: 'cancelled' });
    expect(provider.handles.get('schedule-a')!.cancel).toHaveBeenCalledTimes(1);
    expect(provider.handles.get('schedule-a')!.stop).toHaveBeenCalledTimes(1);
  });

  it('retains a completion if native cancellation fails', async () => {
    const service = make(); await service.initialize(); await service.create(owner, input());
    vi.mocked(provider.handles.get('schedule-a')!.cancel).mockImplementation(async () => { complete(); throw new Error('Native cancellation refused'); });
    await expect(service.cancel(owner, 'schedule-a')).rejects.toThrow('refused');
    await settled(service);
    expect((await service.list(owner))[0].state).toBe('completed');
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(provider.handles.get('schedule-a')!.stop).toHaveBeenCalledTimes(1);
  });

  it('does not retry older disconnected results when cancellation fails', async () => {
    deliver.mockRejectedValue(new Error('Disconnected'));
    const service = make(); await service.initialize(); await service.create(owner, input('schedule-a', true));
    complete(); await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    const gate = deferred<void>();
    const entered = deferred<void>();
    vi.mocked(provider.handles.get('schedule-a')!.cancel).mockImplementation(async () => {
      complete('schedule-a', 'occurrence-2'); entered.resolve();
      await gate.promise; throw new Error('Native cancellation refused');
    });
    const cancellation = service.cancel(owner, 'schedule-a');
    const rejected = expect(cancellation).rejects.toThrow('refused');
    try {
      // Native entry follows durable cancellation intent. Join the completion's
      // serialized write before opening the catalog, rather than polling it
      // during atomic replacement (which can deny rename on Windows).
      await entered.promise;
      await service.list(owner);
      expect((await read()).pending).toHaveLength(2);
    } finally { gate.resolve(); await rejected; }
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    expect(deliver.mock.calls.map(([delivery]) => delivery.occurrenceId)).toEqual(['occurrence-1', 'occurrence-2']);
  });

  it('keeps native cancellation behind the durable intent replacement', async () => {
    const service = make(); await service.initialize(); await service.create(owner, input());
    const replacing = deferred<void>(), release = deferred<void>();
    const rename = fs.rename.bind(fs);
    const replacement = vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => {
      replacing.resolve(); await release.promise;
      return rename(...args);
    });
    const handle = provider.handles.get('schedule-a')!;
    vi.mocked(handle.cancel).mockImplementation(async () => {
      expect((await read()).records[0].cancelRequested).toBe(true);
    });
    const cancellation = service.cancel(owner, 'schedule-a');
    // Observe rejection immediately, including assertion failures inside the
    // native callback, while the test controls the persistence boundary.
    const cancelled = expect(cancellation).resolves.toMatchObject({ state: 'cancelled' });
    try {
      await replacing.promise;
      expect(handle.cancel).not.toHaveBeenCalled();
      expect(handle.stop).not.toHaveBeenCalled();
      expect((await read()).records[0].cancelRequested).toBeUndefined();
    } finally {
      release.resolve();
      try { await cancelled; } finally { replacement.mockRestore(); }
    }
    expect(handle.cancel).toHaveBeenCalledOnce();
    expect(handle.stop).toHaveBeenCalledOnce();
    expect((await read()).records[0]).toMatchObject({ state: 'cancelled', cancelRequested: true });
  });

  it('suppresses queued deliveries after owner reset and stops a stale live schedule', async () => {
    deliver.mockRejectedValue(new Error('Disconnected'));
    const service = make(); await service.initialize(); await service.create(owner, input('schedule-a', true));
    complete(); await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    current.mockReturnValue(false); deliver.mockResolvedValue(undefined);
    await service.retryDeliveries();
    expect((await read()).pending).toEqual([]);
    complete('schedule-a', 'occurrence-2'); await service.list(owner);
    await vi.waitFor(() => expect(provider.handles.get('schedule-a')!.stop).toHaveBeenCalledTimes(1));
    expect((await service.list(owner))[0]).toMatchObject({ state: 'interrupted', ...owner });
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('rechecks ownership when creation finishes', async () => {
    const gate = deferred<void>(); provider.beforeResolve = () => gate.promise;
    const service = make(); await service.initialize();
    const creation = service.create(owner, input());
    await vi.waitFor(() => expect(provider.create).toHaveBeenCalledTimes(1));
    current.mockReturnValue(false); gate.resolve();
    expect(await creation).toMatchObject({ state: 'interrupted', ...owner });
    expect(provider.handles.get('schedule-a')!.stop).toHaveBeenCalledTimes(1);
  });

  it('records unexpected process interruption without overwriting a completed one-shot', async () => {
    const service = make(); await service.initialize(); await service.create(owner, input());
    provider.emit('schedule-a', { type: 'started', occurrenceId: 'occurrence-1' });
    provider.emit('schedule-a', { type: 'stopped', reason: 'Native process crashed' });
    expect((await service.list(owner))[0]).toMatchObject({ state: 'interrupted', error: 'Native process crashed' });
    complete(); await settled(service);
    expect((await service.list(owner))[0].state).toBe('completed');
    provider.emit('schedule-a', { type: 'stopped', reason: 'Trailing close' });
    expect((await service.list(owner))[0].state).toBe('completed');
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('records provider creation failure and stops a returned invalid handle', async () => {
    const service = make(); await service.initialize();
    provider.create.mockRejectedValueOnce(new Error('Native creation failed'));
    await expect(service.create(owner, input())).rejects.toThrow('creation failed');
    expect((await service.list(owner))[0].state).toBe('failed');
    provider.beforeResolve = async id => { Object.assign(provider.handles.get(id)!, { nativeId: '' }); };
    await expect(service.create(owner, input('schedule-b'))).rejects.toThrow('Invalid schedule');
    expect(provider.handles.get('schedule-b')!.stop).toHaveBeenCalledTimes(1);
  });

  it('marks live records interrupted on restart without recreating jobs or automatically delivering pending results', async () => {
    deliver.mockRejectedValue(new Error('Disconnected'));
    const service = make(); await service.initialize();
    await service.create(owner, input()); complete(); await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    await service.create(owner, input('schedule-b', true));
    await service.create(owner, input('schedule-c')); await service.cancel(owner, 'schedule-c');
    await service.destroy();
    // Simulate an unclean process exit by restoring the persisted live states only.
    const catalog = await read();
    catalog.records.find((record: { id: string }) => record.id === 'schedule-b').state = 'running';
    await fs.writeFile(path.join(directory, SCHEDULE_CATALOG_FILE), JSON.stringify(catalog));
    const restartedProvider = new Provider(); const restarted = make({ provider: restartedProvider });
    await restarted.initialize();
    expect(restartedProvider.create).not.toHaveBeenCalled(); expect(deliver).toHaveBeenCalledTimes(1);
    expect((await restarted.list(owner)).map(record => record.state)).toEqual(['completed', 'interrupted', 'cancelled']);
    expect((await restarted.list(owner))[1].error).toContain('not recreated');
    deliver.mockResolvedValue(undefined); await restarted.retryDeliveries(); await restarted.retryDeliveries();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect((await read()).pending).toEqual([]);
  });

  it.each(['creating', 'active', 'running'])('recovers stored %s state without native recreation', async state => {
    const service = make(); await service.initialize(); await service.create(owner, input()); await service.destroy();
    const catalog = await read(); catalog.records[0].state = state;
    await fs.writeFile(path.join(directory, SCHEDULE_CATALOG_FILE), JSON.stringify(catalog));
    const restarted = make(); await restarted.initialize();
    expect((await restarted.list(owner))[0].state).toBe('interrupted'); expect(provider.create).toHaveBeenCalledTimes(1);
  });

  it('suppresses an old generation outbox during initialization without changing its recorded owner', async () => {
    deliver.mockRejectedValue(new Error('Disconnected'));
    const service = make(); await service.initialize(); await service.create(owner, input());
    complete(); await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1)); await service.destroy();
    current.mockReturnValue(false);
    const restarted = make(); await restarted.initialize(); await restarted.retryDeliveries();
    expect((await read()).pending).toEqual([]);
    expect((await restarted.list(owner))[0]).toMatchObject({ ...owner, state: 'completed' });
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it.each([
    '{broken', '{}', '{"version":999,"records":[],"pending":[]}',
    '{"version":1,"records":{},"pending":[]}', '{"version":1,"records":[],"pending":[],"__proto__":{}}',
    '{"version":1,"records":[],"pending":[{"id":"bad"}]}',
  ])('preserves malformed persisted bytes without overwriting: %s', async bytes => {
    const file = path.join(directory, SCHEDULE_CATALOG_FILE); await fs.writeFile(file, bytes);
    const service = make(); await expect(service.initialize()).rejects.toThrow();
    await expect(service.create(owner, input())).rejects.toThrow();
    expect(await fs.readFile(file, 'utf8')).toBe(bytes); expect(provider.create).not.toHaveBeenCalled();
    await service.destroy(); expect(await fs.readFile(file, 'utf8')).toBe(bytes);
  });

  it.each(['owner', 'state', 'rule', 'duplicate', 'path', 'outbox', 'oversized', 'backend'])('rejects invalid persisted %s data before recovery writes', async kind => {
    const service = make(); await service.initialize(); await service.create(owner, input()); await service.destroy();
    const catalog = await read();
    if (kind === 'owner') catalog.records[0].generation = null;
    if (kind === 'state') catalog.records[0].state = 'invented';
    if (kind === 'backend') catalog.records[0].backend = 'codex';
    if (kind === 'rule') catalog.records[0].rule = { kind: 'cron', expression: '60 * * * *', timezone: 'UTC' };
    if (kind === 'duplicate') catalog.records.push(catalog.records[0]);
    if (kind === 'path') catalog.records[0].id = '../escape';
    if (kind === 'oversized') catalog.records[0].prompt = 'x'.repeat(16 * 1024 + 1);
    if (kind === 'outbox') catalog.pending.push({ id: 'unknown:occurrence', scheduleId: 'unknown', occurrenceId: 'occurrence', success: true });
    const bytes = JSON.stringify(catalog); await fs.writeFile(path.join(directory, SCHEDULE_CATALOG_FILE), bytes);
    await expect(make().initialize()).rejects.toThrow();
    expect(await fs.readFile(path.join(directory, SCHEDULE_CATALOG_FILE), 'utf8')).toBe(bytes);
  });

  it('rejects a symlink catalog without modifying its target', async context => {
    const target = path.join(directory, 'target.json'); await fs.writeFile(target, 'private fixture');
    try { await fs.symlink(target, path.join(directory, SCHEDULE_CATALOG_FILE), 'file'); }
    catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        context.skip(); return; // Windows may require developer mode or symlink privileges.
      }
      throw error;
    }
    await expect(make().initialize()).rejects.toThrow('regular file');
    expect(await fs.readFile(target, 'utf8')).toBe('private fixture');
  });

  it('enforces live and history limits without pruning records', async () => {
    const service = make({ maxLiveSchedules: 1, maxRecords: 2 }); await service.initialize();
    await service.create(owner, input());
    await expect(service.create(owner, input('schedule-b'))).rejects.toThrow('Live native');
    await service.cancel(owner, 'schedule-a'); await service.create(owner, input('schedule-b'));
    await service.cancel(owner, 'schedule-b');
    await expect(service.create(owner, input('schedule-c'))).rejects.toThrow('history was not pruned');
    expect(await service.list(owner)).toHaveLength(2); expect(provider.create).toHaveBeenCalledTimes(2);
  });

  it('serializes concurrent creation capacity checks and preserves caller ownership snapshots', async () => {
    const service = make({ maxLiveSchedules: 1 }); await service.initialize();
    const original = { ...owner }; const request = input();
    const first = service.create(original, request);
    original.generation = 'changed'; request.prompt = 'Changed after submission'; request.id = 'changed-id';
    const second = service.create(owner, input('schedule-b'));
    const results = await Promise.allSettled([first, second]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect((await service.list(owner))[0]).toMatchObject({ ...owner, id: 'schedule-a', prompt: 'Check the synthetic build' });
    expect(provider.create).toHaveBeenCalledTimes(1);
  });

  it('retains completed history while cancellation suppresses an undelivered terminal result', async () => {
    deliver.mockRejectedValue(new Error('Disconnected'));
    const service = make(); await service.initialize(); await service.create(owner, input());
    complete(); await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect(await service.cancel(owner, 'schedule-a')).toMatchObject({ state: 'completed' });
    deliver.mockResolvedValue(undefined); await service.retryDeliveries();
    expect(deliver).toHaveBeenCalledTimes(1); expect((await read()).pending).toEqual([]);
  });

  it('persists JSON-escaped maximum-size prompts and outputs that remain loadable', async () => {
    deliver.mockRejectedValue(new Error('Disconnected'));
    const service = make({ maxRecords: 1, maxPendingDeliveries: 1 }); await service.initialize();
    await service.create(owner, { ...input(), prompt: '\u0001'.repeat(16 * 1024) });
    provider.emit('schedule-a', { type: 'completed', occurrenceId: 'occurrence-1', success: true, output: '\u0001'.repeat(16 * 1024) });
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1)); await service.destroy();
    const restarted = make({ maxRecords: 1, maxPendingDeliveries: 1 }); await restarted.initialize();
    expect((await restarted.list(owner))[0].prompt.length).toBe(16 * 1024);
    expect((await read()).pending).toHaveLength(1);
  });

  it('fails closed on persistence failure and confirms native process cleanup', async () => {
    const service = make(); await service.initialize(); await service.create(owner, input('schedule-a', true));
    const file = path.join(directory, SCHEDULE_CATALOG_FILE);
    await fs.unlink(file); await fs.mkdir(file);
    complete();
    await vi.waitFor(() => expect(provider.handles.get('schedule-a')!.stop).toHaveBeenCalledTimes(1));
    await expect(service.retryDeliveries()).rejects.toThrow('regular file');
    expect(deliver).not.toHaveBeenCalled(); expect((await fs.stat(file)).isDirectory()).toBe(true);
  });

  it('reports unconfirmed exit after cancellation without treating trailing results as completed', async () => {
    const service = make(); await service.initialize(); await service.create(owner, input());
    const handle = provider.handles.get('schedule-a')!;
    vi.mocked(handle.stop).mockRejectedValue(new Error('Exit not confirmed'));
    await expect(service.cancel(owner, 'schedule-a')).rejects.toThrow('Exit not confirmed');
    expect((await service.list(owner))[0]).toMatchObject({ state: 'cancelled', error: expect.stringContaining('exit unconfirmed') });
    expect(service.hasActiveSchedules(owner.threadId)).toBe(true);
    complete(); await service.list(owner); expect(deliver).not.toHaveBeenCalled();
    vi.mocked(handle.stop).mockResolvedValue(undefined);
    await service.cancel(owner, 'schedule-a');
    expect(service.hasActiveSchedules(owner.threadId)).toBe(false);
  });

  it('retains failed-create cleanup ownership until native process exit is confirmed', async () => {
    const service = make(); await service.initialize();
    const handle = { nativeId: '', list: vi.fn(async () => false), cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => { throw new Error('Exit not confirmed'); }) };
    provider.create.mockRejectedValue(new NativeScheduleCleanupError('Creation cleanup failed', handle));
    await expect(service.create(owner, input())).rejects.toThrow('Creation cleanup failed');
    expect(service.hasActiveSchedules(owner.threadId)).toBe(true);
    handle.stop.mockResolvedValue(undefined);
    await service.cancel(owner, 'schedule-a');
    expect(service.hasActiveSchedules(owner.threadId)).toBe(false);
    expect(handle.cancel).not.toHaveBeenCalled();
  });

  it('does not mistake an unconfirmed stopped event for process exit', async () => {
    const service = make(); await service.initialize(); await service.create(owner, input());
    provider.emit('schedule-a', { type: 'stopped', exitConfirmed: false, reason: 'Exit unconfirmed' });
    await service.list(owner);
    expect(service.hasActiveSchedules(owner.threadId)).toBe(true);
    await service.cancel(owner, 'schedule-a');
    expect(provider.handles.get('schedule-a')!.stop).toHaveBeenCalled();
    expect(service.hasActiveSchedules(owner.threadId)).toBe(false);
  });

  it('allows cleanup retry after automatic one-shot shutdown fails without stopping siblings', async () => {
    const service = make(); await service.initialize(); await service.create(owner, input());
    await service.create(other, input('schedule-b', true));
    const handle = provider.handles.get('schedule-a')!;
    vi.mocked(handle.stop).mockRejectedValue(new Error('Exit not confirmed'));
    complete();
    await vi.waitFor(() => expect(handle.stop).toHaveBeenCalled());
    await vi.waitFor(async () => expect((await service.list(owner))[0].error).toContain('exit unconfirmed'));
    expect(service.hasActiveSchedules(owner.threadId)).toBe(true);
    expect(provider.handles.get('schedule-b')!.stop).not.toHaveBeenCalled();
    vi.mocked(handle.stop).mockResolvedValue(undefined);
    await service.cancel(owner, 'schedule-a');
    expect(service.hasActiveSchedules(owner.threadId)).toBe(false);
    expect(service.hasActiveSchedules(other.threadId)).toBe(true);
  });

  it('accepts late confirmed process exit after cancelled cleanup failed', async () => {
    const service = make(); await service.initialize(); await service.create(owner, input());
    const handle = provider.handles.get('schedule-a')!;
    vi.mocked(handle.stop).mockRejectedValue(new Error('Exit not confirmed'));
    await expect(service.cancel(owner, 'schedule-a')).rejects.toThrow('Exit not confirmed');
    expect(service.hasActiveSchedules()).toBe(true);
    provider.emit('schedule-a', { type: 'stopped', reason: 'Process exited.' });
    await service.list(owner);
    expect(service.hasActiveSchedules()).toBe(false);
    const record = (await service.list(owner))[0];
    expect(record.state).toBe('cancelled');
    expect(record.error).toBeUndefined();
    provider.emit('schedule-a', { type: 'stopped', reason: 'Late shutdown warning', exitConfirmed: false });
    await service.list(owner);
    expect(service.hasActiveSchedules()).toBe(false);
  });

  it('reconciles a disappeared native job only when explicitly refreshed', async () => {
    const service = make(); await service.initialize(); await service.create(owner, input('schedule-a', true));
    const handle = provider.handles.get('schedule-a')!;
    vi.mocked(handle.list).mockResolvedValue(false);
    await service.list(owner);
    expect(handle.list).not.toHaveBeenCalled();
    await service.refresh(owner);
    expect(handle.list).toHaveBeenCalledOnce();
    expect((await service.list(owner))[0]).toMatchObject({ state: 'interrupted', error: expect.stringContaining('not confirmed') });
    expect(handle.stop).toHaveBeenCalled();
    expect(service.hasActiveSchedules()).toBe(false);
  });

  it('bounds UTF-8 output and records explicit outbox saturation rather than pruning pending results', async () => {
    deliver.mockRejectedValue(new Error('Disconnected'));
    const service = make({ maxPendingDeliveries: 1 }); await service.initialize(); await service.create(owner, input('schedule-a', true));
    provider.emit('schedule-a', { type: 'completed', occurrenceId: 'occurrence-1', success: false,
      output: '\u{1f680}'.repeat(9000), error: 'x'.repeat(9000) });
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    const [pending] = (await read()).pending;
    expect(Buffer.byteLength(pending.output)).toBeLessThanOrEqual(16 * 1024);
    expect(Buffer.byteLength(pending.error)).toBeLessThanOrEqual(4096);
    expect(pending.output).toContain('[Truncated]');
    complete('schedule-a', 'occurrence-2'); await service.list(owner);
    expect((await service.list(owner))[0]).toMatchObject({ state: 'interrupted', error: expect.stringContaining('outbox is full') });
    expect((await read()).pending).toHaveLength(1);
    await vi.waitFor(() => expect(provider.handles.get('schedule-a')!.stop).toHaveBeenCalledTimes(1));
  });

  it('bounds occurrence tracking and stops further native work explicitly', async () => {
    const service = make({ maxOccurrencesPerSchedule: 1 }); await service.initialize(); await service.create(owner, input('schedule-a', true));
    complete(); await settled(service); complete('schedule-a', 'occurrence-2'); await service.list(owner);
    expect((await service.list(owner))[0].error).toContain('tracking limit');
    await vi.waitFor(() => expect(provider.handles.get('schedule-a')!.stop).toHaveBeenCalledTimes(1));
  });

  it('waits for delayed handles on destroy and never creates replacement schedules', async () => {
    const gate = deferred<void>(); provider.beforeResolve = () => gate.promise;
    const service = make(); await service.initialize(); const creation = service.create(owner, input());
    await vi.waitFor(() => expect(provider.create).toHaveBeenCalledTimes(1));
    const destruction = service.destroy(); gate.resolve();
    let creationSettled = false;
    void creation.then(() => { creationSettled = true; });
    await destruction;
    expect(creationSettled).toBe(true);
    await creation;
    expect((await read()).records[0].state).toBe('interrupted');
    expect(provider.create).toHaveBeenCalledTimes(1); expect(provider.handles.get('schedule-a')!.stop).toHaveBeenCalledTimes(1);
    await expect(service.create(owner, input('schedule-b'))).rejects.toThrow('closed');
  });

  it('retries failed shutdown cleanup while keeping admission closed and successful siblings stopped', async () => {
    const service = make(); await service.initialize();
    await service.create(owner, input()); await service.create(other, input('schedule-b', true));
    const handle = provider.handles.get('schedule-a')!;
    const sibling = provider.handles.get('schedule-b')!;
    vi.mocked(handle.stop).mockRejectedValueOnce(new Error('Exit not confirmed'));
    const first = service.destroy();
    expect(service.destroy()).toBe(first);
    await expect(first).rejects.toThrow('Exit not confirmed');
    expect(service.hasActiveSchedules(owner.threadId)).toBe(true);
    await expect(service.create(owner, input('schedule-c'))).rejects.toThrow('closed');
    await expect(service.destroy()).resolves.toBeUndefined();
    expect(handle.stop).toHaveBeenCalledTimes(2);
    expect(sibling.stop).toHaveBeenCalledOnce();
    expect(service.hasActiveSchedules()).toBe(false);
    await service.destroy();
    expect(handle.stop).toHaveBeenCalledTimes(2);
    expect(provider.create).toHaveBeenCalledTimes(2);
  });
});
