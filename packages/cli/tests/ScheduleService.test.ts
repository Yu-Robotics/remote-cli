import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isMainThread } from 'node:worker_threads';
import { SCHEDULE_CATALOG_FILE, ScheduleService } from '../src/scheduling/ScheduleService';
import { ScheduleToolOperations } from '../src/scheduling/ScheduleToolScope';
import type { ScheduleServiceOptions } from '../src/scheduling/ScheduleService';
import { NativeScheduleCleanupError, NativeScheduleNotAdmittedError } from '../src/scheduling/types';
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
  admissions = new Map<string, () => boolean>();
  cleanupFor?: NativeScheduleProvider['cleanupFor'];
  beforeResolve?: (id: string, event: (event: NativeScheduleEvent) => void) => Promise<void>;
  create = vi.fn(async (input: NativeScheduleInput, onEvent: (event: NativeScheduleEvent) => void, canAdmitOccurrence?: () => boolean) => {
    this.events.set(input.id, onEvent);
    if (canAdmitOccurrence) this.admissions.set(input.id, canAdmitOccurrence);
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
    vi.spyOn(os, 'homedir').mockReturnValue(directory);
    vi.stubEnv('HOME', directory); vi.stubEnv('USERPROFILE', directory);
    provider = new Provider();
    deliver = vi.fn(async (_delivery: ScheduleDelivery) => {});
    current = vi.fn(() => true);
    services = [];
    // Sibling worker threads can fork with this suite's native lock descriptors.
    // Keep real release/reacquire checks in an independent process.
    expect(isMainThread).toBe(true);
  });
  afterEach(async () => {
    await Promise.allSettled(services.map(service => service.destroy()));
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it.each([false, true])('saves a late CREATE cleanup identity while destruction never waits for native work (failure=%s)', async failure => {
    provider.cleanupFor = () => ({ provider: 'fixture', strategy: 'reattach', describe: () => 'pending' });
    const gate = deferred<void>();
    provider.beforeResolve = async () => {
      await gate.promise;
      const handle = provider.handles.get('late')!;
      Object.assign(handle, { cleanupIdentity: 'original-session' });
      if (failure) throw new NativeScheduleCleanupError('Ambiguous native creation', handle);
    };
    const service = make(); await service.initialize();
    const pending = service.create(owner, input('late'));
    const result = pending.catch(error => error);
    await vi.waitFor(() => expect(provider.handles.has('late')).toBe(true));
    await service.destroy();
    expect(provider.admissions.get('late')!()).toBe(false);
    await expect(make().initialize()).rejects.toThrow('owns the schedule catalog');
    gate.resolve(); await result;
    expect((await read()).records[0]).toMatchObject({ state: 'creating', nativeId: 'native-late', recovery: { identity: 'original-session' } });
    const next = make(); await next.initialize();
    expect((await next.list(owner))[0]).toMatchObject({ state: 'interrupted', nativeId: 'native-late' });
    expect(provider.create).toHaveBeenCalledOnce();
    expect(provider.handles.get('late')!.stop).not.toHaveBeenCalled();
    expect(provider.handles.get('late')!.cancel).not.toHaveBeenCalled();
  });

  it('persists original-session attribution before CREATE and refuses late attribution after destruction', async () => {
    provider.cleanupFor = () => ({ provider: 'fixture', strategy: 'reattach', describe: () => 'pending' });
    provider.beforeResolve = async (_id, emit) => {
      await emit({ type: 'attributed', cleanupIdentity: 'original-session' });
      expect((await read()).records[0].recovery.identity).toBe('original-session');
      throw new Error('Ambiguous CREATE failure');
    };
    const service = make(); await service.initialize();
    await expect(service.create(owner, input())).rejects.toThrow('Ambiguous CREATE');
    expect((await read()).records[0]).toMatchObject({ state: 'failed', recovery: { identity: 'original-session' } });
    await service.destroy();
    await expect(provider.events.get('schedule-a')!({ type: 'attributed', cleanupIdentity: 'late' })).rejects.toThrow('closed');
    expect((await read()).records[0].recovery.identity).toBe('original-session');
  });

  it('compacts refused creation while preserving failed tool receipts and restart replay denial', async () => {
    let service = make(); await service.initialize();
    await service.create(owner, input('sibling', true));
    const failure = new NativeScheduleNotAdmittedError('Synthetic native preflight refusal');
    const gate = deferred<never>(); provider.create.mockImplementationOnce(() => gate.promise);
    const operations = new ScheduleToolOperations();
    const options = { owner, messageId: 'synthetic-request', backend: 'claude' as const, current: () => true, waitMs: 1,
      run: async (_command: unknown, id: string) => [await service.create(owner, input(id))], present: vi.fn(async () => 'card') };
    const scope = operations.scope(options);
    const args = { requestId: 'create', when: { kind: 'after', amount: 5, unit: 'm' }, prompt: 'Synthetic task' };
    const pending: any = await scope.invoke('remote_cli_schedule_create', args);
    expect(pending.status).toBe('pending');
    await vi.waitFor(() => expect(provider.create).toHaveBeenCalledTimes(2));
    gate.reject(failure); await scope.drain();
    expect(scope.unreportedFailures()).toEqual([{ ...pending, status: 'failed', error: failure.message }]);
    const receipt = await scope.invoke('remote_cli_schedule_operation', { requestId: 'create' });
    expect(receipt).toEqual({ ...pending, status: 'failed', error: failure.message });
    expect(await operations.scope(options).invoke('remote_cli_schedule_create', args)).toEqual(receipt);
    await expect(scope.invoke('remote_cli_schedule_create', { ...args, prompt: 'Changed' })).rejects.toThrow('different');
    expect(scope.hasSideEffects).toBe(true); expect(scope.unreportedFailures()).toEqual([]);
    expect(options.present).not.toHaveBeenCalled(); expect(provider.create).toHaveBeenCalledTimes(2);
    expect((await service.list(owner)).map(record => record.id)).toEqual(['sibling']);
    expect((await read()).purged).toEqual([{ id: pending.scheduleId, ...owner }]);
    expect(await service.listCleanup(owner)).toEqual([]);
    await service.destroy(); service = make(); await service.initialize();
    await expect(service.create(owner, input(pending.scheduleId))).rejects.toThrow('purged');
    expect(provider.create).toHaveBeenCalledTimes(2);
  });

  it.each(['generic', 'ambiguous', 'started', 'completed'] as const)('retains %s evidence instead of compacting creation', async kind => {
    const service = make(); await service.initialize();
    const handle = { nativeId: 'uncertain-native', list: vi.fn(async () => true), cancel: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    provider.create.mockImplementationOnce(async (_input, emit) => {
      if (kind === 'started') emit({ type: 'started', occurrenceId: 'observed' });
      if (kind === 'completed') emit({ type: 'completed', occurrenceId: 'observed', success: false, error: 'Synthetic failed wake' });
      if (kind === 'ambiguous') throw new NativeScheduleCleanupError('Synthetic ambiguous mutation', handle);
      if (kind === 'generic') throw new Error('Synthetic missing receipt');
      throw new NativeScheduleNotAdmittedError('Contradicted refusal');
    });
    await expect(service.create(owner, input())).rejects.toThrow();
    expect((await service.list(owner))[0]).not.toHaveProperty('creationRefused');
    expect((await read()).purged ?? []).toEqual([]);
    if (kind === 'started') {
      // A late result remains ingestible after the create promise failed.
      await (service as any).onEvent('schedule-a', { type: 'completed', occurrenceId: 'observed', success: true, output: 'Late result' });
      await service.retryDeliveries(); expect(deliver).toHaveBeenCalledOnce();
    }
  });

  it('preserves a sibling outbox and ACK while removing only the refused attempt', async () => {
    const ack = deferred<void>(); deliver.mockImplementationOnce(() => ack.promise);
    const service = make(); await service.initialize();
    await service.create(owner, input('sibling', true));
    provider.emit('sibling', { type: 'started', occurrenceId: 'sibling-result' });
    complete('sibling', 'sibling-result');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
    provider.create.mockRejectedValueOnce(new NativeScheduleNotAdmittedError('Refused fresh attempt'));
    await expect(service.create(owner, input('refused'))).rejects.toThrow('Refused');
    expect((await read()).pending).toHaveLength(1);
    expect((await service.list(owner)).map(record => record.id)).toEqual(['sibling']);
    ack.resolve(); await service.retryDeliveries(); expect((await read()).pending).toEqual([]);
    expect(provider.handles.get('sibling')!.cancel).not.toHaveBeenCalled();
  });

  it('does not compact a create while concurrent cancellation owns the record', async () => {
    const service = make(); await service.initialize();
    const gate = deferred<never>(); provider.create.mockImplementationOnce(() => gate.promise);
    const creating = service.create(owner, input()); const rejected = expect(creating).rejects.toThrow('Refused');
    await vi.waitFor(() => expect(provider.create).toHaveBeenCalledOnce());
    const cancel = service.cancel(owner, 'schedule-a');
    await vi.waitFor(async () => expect((await read()).records[0].cancelRequested).toBe(true));
    gate.reject(new NativeScheduleNotAdmittedError('Refused before native admission'));
    await rejected; expect((await cancel).state).toBe('cancelled');
    expect((await service.list(owner))[0].state).toBe('cancelled');
    expect((await read()).purged ?? []).toEqual([]);
  });

  it.each([false, true])('retains refusal evidence when compaction persistence fails (startup=%s)', async startup => {
    const failure = new NativeScheduleNotAdmittedError('Original refusal');
    const filename = path.join(directory, SCHEDULE_CATALOG_FILE);
    if (startup) await fs.writeFile(filename, JSON.stringify({ version: 3, records: [{ ...owner, ...input(), backend: 'claude',
      createdAt: now, state: 'failed', creationRefused: true, error: failure.message }], pending: [], purged: [] }));
    const rename = fs.rename;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      const data = JSON.parse(await fs.readFile(from, 'utf8'));
      if (data.purged?.some((entry: any) => entry.id === 'schedule-a')) throw new Error('Synthetic compaction write failure');
      return rename(from, to);
    });
    const service = make();
    if (startup) await expect(service.initialize()).rejects.toThrow('compaction write failure');
    else {
      await service.initialize(); provider.create.mockRejectedValueOnce(failure);
      await expect(service.create(owner, input())).rejects.toBe(failure);
    }
    expect((await read()).records[0]).toMatchObject({ state: 'failed', creationRefused: true, error: failure.message });
    expect((await read()).purged).toEqual([]);
    expect((service as any).records.get('schedule-a').creationRefused).toBe(true);
    expect((service as any).purged.has('schedule-a')).toBe(false);
  });

  it('compacts only proven startup refusals before outbox pruning and preserves legacy cleanup', async () => {
    const refused = (id: string) => ({ ...owner, ...input(id), backend: 'claude', createdAt: now, state: 'failed', creationRefused: true });
    const unproven = { ...refused('unproven'), creationRefused: undefined };
    const skipped = { ...refused('skipped'), creationRefused: undefined, completedOccurrences: ['native-wake'], skippedOccurrences: ['native-wake'] };
    const outstanding = { ...refused('outstanding') };
    const cleanup = { ...owner, id: 'legacy', backend: 'claude', cwd: directory, historyRemoved: true, reason: 'unattributed' };
    await fs.writeFile(path.join(directory, SCHEDULE_CATALOG_FILE), JSON.stringify({ version: 5,
      records: [refused('refused'), unproven, skipped, outstanding],
      pending: [{ id: 'outstanding:result', scheduleId: 'outstanding', occurrenceId: 'result', success: true, output: 'Retained output' }],
      purged: [{ ...owner, id: 'legacy' }], cleanup: [cleanup], purgeRequests: [] }));
    const service = make(); await service.initialize();
    expect((await service.list(owner)).map(record => record.id)).toEqual(['unproven', 'skipped', 'outstanding']);
    expect((await read()).pending).toHaveLength(1);
    expect(await service.listCleanup(owner)).toEqual([cleanup]);
    expect(provider.create).not.toHaveBeenCalled();
    await service.retryDeliveries(); expect(deliver).toHaveBeenCalledOnce();
    expect((await read()).purged).toEqual([{ ...owner, id: 'legacy' }, { ...owner, id: 'refused' }]);
  });

  it.each([false, true])('retains refused evidence at fence capacity (startup=%s)', async startup => {
    const fences = Array.from({ length: 10000 }, (_, index) => ({ ...owner, id: `purged-${index}` }));
    await fs.writeFile(path.join(directory, SCHEDULE_CATALOG_FILE), JSON.stringify({ version: 3, purged: fences, pending: [],
      records: startup ? [{ ...owner, ...input(), backend: 'claude', createdAt: now, state: 'failed', creationRefused: true }] : [] }));
    const service = make(); await service.initialize();
    if (!startup) {
      provider.create.mockRejectedValueOnce(new NativeScheduleNotAdmittedError('Refused'));
      await expect(service.create(owner, input())).rejects.toThrow('Refused');
    }
    expect((await service.list(owner))[0]).toMatchObject({ state: 'failed', creationRefused: true });
    expect((await read()).purged).toEqual(fences);
  });

  it('retains a fresh refusal while native mutation ownership is unsettled', async () => {
    const service = make({ isNativeMutationPending: () => true }); await service.initialize();
    provider.create.mockRejectedValueOnce(new NativeScheduleNotAdmittedError('Refused'));
    await expect(service.create(owner, input())).rejects.toThrow('Refused');
    expect((await service.list(owner))[0].creationRefused).toBe(true);
    expect((await read()).purged).toEqual([]);
  });

  it('rejects a second catalog writer before reading or overwriting cancellation intent', async () => {
    const first = make(); await first.initialize(); await first.create(owner, input());
    await first.cancel(owner, 'schedule-a');
    const before = await fs.readFile(path.join(directory, SCHEDULE_CATALOG_FILE), 'utf8');
    const second = make(); await expect(second.initialize()).rejects.toThrow('Another client');
    expect(await fs.readFile(path.join(directory, SCHEDULE_CATALOG_FILE), 'utf8')).toBe(before);
  });

  it('persists private catalog entries and never invokes native list for local listing', async () => {
    const service = make(); await service.initialize();
    const record = await service.create(owner, input());
    expect(record).toMatchObject({ ...owner, id: 'schedule-a', nativeId: 'native-schedule-a', backend: 'claude', state: 'active' });
    expect((await read()).records).toEqual([record]);
    expect(await service.list(owner)).toEqual([record]);
    expect(provider.handles.get(record.id)!.list).not.toHaveBeenCalled();
    expect((await fs.readdir(directory)).sort()).toEqual([SCHEDULE_CATALOG_FILE, `${SCHEDULE_CATALOG_FILE}.lock`]);
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
    const requestOwner = { ...owner };
    const refresh = service.refresh(requestOwner);
    requestOwner.generation = 'changed-after-request';
    await vi.waitFor(() => expect(provider.handles.get('first')!.list).toHaveBeenCalledOnce());
    expect(provider.handles.get('second')!.list).not.toHaveBeenCalled();
    gate.resolve(true); await refresh;
    expect(provider.handles.get('second')!.list).toHaveBeenCalledOnce();
  });

  it('leaves successful native inventory observations and existing diagnostics unchanged', async () => {
    const service = make(); await service.initialize(); await service.create(owner, input('schedule-a', true));
    await service.retainCleanupError(owner, 'schedule-a', new Error('Earlier cleanup remains unverified'));
    const before = await read();
    const handle = provider.handles.get('schedule-a')!;
    await service.refresh(owner);
    expect(await read()).toEqual(before);
    expect(handle.list).toHaveBeenCalledOnce();
    expect(handle.cancel).not.toHaveBeenCalled(); expect(handle.stop).not.toHaveBeenCalled();
    expect(provider.admissions.get('schedule-a')!()).toBe(true);
  });

  it.each(['Native inventory read failed', 'Native receipt timed out', 'Native ownership mismatch'])(
    'preserves active work, recovery metadata and admission after %s', async detail => {
      provider.cleanupFor = () => ({ provider: 'synthetic-recovery', strategy: 'reattach',
        describe: () => 'synthetic-session-identity' });
      const service = make(); await service.initialize();
      await service.create(owner, input('schedule-a', true)); await service.create(owner, input('sibling', true));
      await service.retainCleanupError(owner, 'schedule-a', new Error('Earlier cleanup remains unverified'));
      const before = await read();
      const handle = provider.handles.get('schedule-a')!;
      vi.mocked(handle.list).mockRejectedValueOnce(new Error(detail));
      await expect(service.refresh(owner)).rejects.toThrow(`Native inventory could not be verified for schedule-a: ${detail}`);
      expect(await read()).toEqual(before);
      expect((await service.list(owner))[0]).toMatchObject({ state: 'active', recovery: { status: 'blocked' } });
      expect(service.hasActiveSchedules(owner.threadId)).toBe(true);
      expect(provider.admissions.get('schedule-a')!()).toBe(true);
      // One uncertain definition must not stop observation or admission of its siblings.
      expect(provider.handles.get('sibling')!.list).toHaveBeenCalledOnce();
      await service.refresh(owner);
      expect(await read()).toEqual(before);
      provider.emit('schedule-a', { type: 'started', occurrenceId: 'after-read-failure' });
      complete('schedule-a', 'after-read-failure'); await settled(service);
      expect(deliver).toHaveBeenCalledOnce();
      expect((await service.list(owner))[0].state).toBe('active');
      for (const native of provider.handles.values()) {
        expect(native.cancel).not.toHaveBeenCalled(); expect(native.stop).not.toHaveBeenCalled();
      }
    });

  it('does not infer absence from a malformed native inventory response', async () => {
    const service = make(); await service.initialize(); await service.create(owner, input());
    const handle = provider.handles.get('schedule-a')!;
    vi.mocked(handle.list).mockResolvedValue(undefined as unknown as boolean);
    const before = await read();
    await expect(service.refresh(owner)).rejects.toThrow('no verified presence or absence');
    expect(await read()).toEqual(before);
    expect(provider.admissions.get('schedule-a')!()).toBe(true);
    expect(handle.cancel).not.toHaveBeenCalled(); expect(handle.stop).not.toHaveBeenCalled();
  });

  it('does not reconcile failed creation cleanup as a side effect of refresh', async () => {
    const handle: NativeScheduleHandle = { nativeId: 'synthetic-unresolved',
      list: vi.fn(async () => true), cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => { throw new Error('Cleanup remains unverified'); }) };
    provider.create.mockRejectedValueOnce(new NativeScheduleCleanupError('Creation unverified', handle));
    const service = make(); await service.initialize();
    await expect(service.create(owner, input())).rejects.toThrow('Creation unverified');
    const before = await read();
    vi.mocked(handle.stop).mockClear().mockResolvedValue(undefined);
    await service.refresh(owner);
    expect(await read()).toEqual(before);
    expect((await service.list(owner))[0].state).toBe('failed');
    expect(service.hasActiveSchedules()).toBe(true);
    expect(handle.list).not.toHaveBeenCalled();
    expect(handle.cancel).not.toHaveBeenCalled(); expect(handle.stop).not.toHaveBeenCalled();
  });

  it('preserves reviewed cleanup, cancellation and recovery fences without native reads', async () => {
    provider.cleanupFor = () => ({ provider: 'synthetic-recovery', strategy: 'reattach',
      describe: () => 'synthetic-session-identity' });
    const service = make(); await service.initialize();
    await service.create(owner, input('reviewed', true)); await service.create(owner, input('cancelled', true));
    await service.recordReviewedCleanup(owner, ['reviewed'], false);
    Object.assign(provider.handles.get('cancelled')!, { nativeDefinitionAbsent: true });
    await service.cancel(owner, 'cancelled');
    const before = await read();
    expect(before.records).toMatchObject([
      { state: 'interrupted', cancelRequested: true, recovery: { status: 'blocked' } },
      { state: 'cancelled', cancelRequested: true, cleanupConfirmed: true, recovery: { status: 'blocked' } },
    ]);
    for (const native of provider.handles.values()) {
      vi.mocked(native.stop).mockClear(); vi.mocked(native.cancel).mockClear();
    }
    await service.refresh(owner);
    expect(await read()).toEqual(before);
    for (const native of provider.handles.values()) {
      expect(native.list).not.toHaveBeenCalled();
      expect(native.cancel).not.toHaveBeenCalled(); expect(native.stop).not.toHaveBeenCalled();
    }
  });

  it('skips inventory for an already running occurrence', async () => {
    const service = make(); await service.initialize(); await service.create(owner, input('schedule-a', true));
    const handle = provider.handles.get('schedule-a')!;
    provider.emit('schedule-a', { type: 'started', occurrenceId: 'ongoing' }); await service.list(owner);
    const before = await read();
    await service.refresh(owner);
    expect(await read()).toEqual(before);
    expect((await service.list(owner))[0].state).toBe('running');
    expect(provider.admissions.get('schedule-a')!()).toBe(true);
    expect(handle.list).not.toHaveBeenCalled();
    expect(handle.cancel).not.toHaveBeenCalled(); expect(handle.stop).not.toHaveBeenCalled();
    complete('schedule-a', 'ongoing'); await settled(service);
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('does not read or retry native mutation while explicit cancellation is pending', async () => {
    const service = make(); await service.initialize(); await service.create(owner, input('schedule-a', true));
    const handle = provider.handles.get('schedule-a')!;
    const entered = deferred<void>(), gate = deferred<void>();
    vi.mocked(handle.cancel).mockImplementation(async () => { entered.resolve(); await gate.promise; });
    const cancellation = service.cancel(owner, 'schedule-a');
    try {
      await entered.promise;
      const before = await read();
      await service.refresh(owner);
      expect(await read()).toEqual(before);
      expect(handle.list).not.toHaveBeenCalled(); expect(handle.stop).not.toHaveBeenCalled();
      expect(handle.cancel).toHaveBeenCalledOnce();
      expect(provider.admissions.get('schedule-a')!()).toBe(false);
    } finally { gate.resolve(); await cancellation; }
    expect((await service.list(owner))[0]).toMatchObject({ state: 'cancelled', cancelRequested: true });
    expect(handle.stop).toHaveBeenCalledOnce();
  });

  it.each([false, true])('ignores late absence after an occurrence starts (completed=%s)', async completed => {
    const service = make(); await service.initialize(); await service.create(owner, input('schedule-a', true));
    const handle = provider.handles.get('schedule-a')!;
    const entered = deferred<void>(), gate = deferred<boolean>();
    vi.mocked(handle.list).mockImplementation(async () => { entered.resolve(); return gate.promise; });
    const refresh = service.refresh(owner);
    try {
      await entered.promise;
      provider.emit('schedule-a', { type: 'started', occurrenceId: 'racing-read' }); await service.list(owner);
      if (completed) { complete('schedule-a', 'racing-read'); await settled(service); }
      const before = await read();
      gate.resolve(false); await refresh;
      expect(await read()).toEqual(before);
      expect((await service.list(owner))[0].state).toBe(completed ? 'active' : 'running');
      expect(provider.admissions.get('schedule-a')!()).toBe(true);
      expect(handle.cancel).not.toHaveBeenCalled(); expect(handle.stop).not.toHaveBeenCalled();
      if (!completed) { complete('schedule-a', 'racing-read'); await settled(service); }
      expect(deliver).toHaveBeenCalledOnce();
    } finally { gate.resolve(true); await refresh; }
  });

  it.each(['cancel', 'reviewed cleanup'] as const)('does not overwrite %s with a late inventory absence', async operation => {
    const service = make(); await service.initialize(); await service.create(owner, input('schedule-a', true));
    const handle = provider.handles.get('schedule-a')!;
    const entered = deferred<void>(), gate = deferred<boolean>();
    vi.mocked(handle.list).mockImplementation(async () => { entered.resolve(); return gate.promise; });
    const refresh = service.refresh(owner);
    try {
      await entered.promise;
      if (operation === 'cancel') await service.cancel(owner, 'schedule-a');
      else await service.recordReviewedCleanup(owner, ['schedule-a'], false);
      const before = await read();
      const stops = vi.mocked(handle.stop).mock.calls.length, cancels = vi.mocked(handle.cancel).mock.calls.length;
      gate.resolve(false); await refresh;
      expect(await read()).toEqual(before);
      expect(handle.stop).toHaveBeenCalledTimes(stops); expect(handle.cancel).toHaveBeenCalledTimes(cancels);
      expect(provider.admissions.get('schedule-a')!()).toBe(false);
    } finally { gate.resolve(true); await refresh; }
  });

  it.each([false, true])('ignores late inventory results after ownership changes (readFailed=%s)', async readFailed => {
    const service = make(); await service.initialize(); await service.create(owner, input('schedule-a', true));
    const handle = provider.handles.get('schedule-a')!;
    const entered = deferred<void>(), gate = deferred<boolean>();
    vi.mocked(handle.list).mockImplementation(async () => { entered.resolve(); return gate.promise; });
    const before = await read();
    // A different generation has no authority to inspect the old native job.
    for (const foreign of [other, { ...owner, openId: 'another-owner' }, { ...owner, generation: 'new-generation' }]) {
      await service.refresh(foreign);
    }
    expect(handle.list).not.toHaveBeenCalled();
    const refresh = service.refresh(owner);
    try {
      await entered.promise; current.mockReturnValue(false);
      if (readFailed) gate.reject(new Error('Native ownership changed')); else gate.resolve(false);
      await refresh;
      expect(await read()).toEqual(before);
      expect(handle.cancel).not.toHaveBeenCalled(); expect(handle.stop).not.toHaveBeenCalled();
      expect(provider.admissions.get('schedule-a')!()).toBe(false);
      current.mockReturnValue(true);
      expect(provider.admissions.get('schedule-a')!()).toBe(true);
    } finally { gate.resolve(true); await refresh; }
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

  it.each(['dsh', 'agy'] as const)('preserves %s identity across native creation, outbox persistence, and restart without recreating jobs', async backend => {
    deliver.mockRejectedValue(new Error('Disconnected'));
    const service = make(); await service.initialize();
    const record = await service.create(owner, { ...input(), backend });
    expect(record.backend).toBe(backend);
    expect(provider.create.mock.calls[0][0].backend).toBe(backend);
    provider.emit(record.id, { type: 'started', occurrenceId: 'native-dsh-occurrence' });
    complete(record.id, 'native-dsh-occurrence');
    await settled(service);
    await service.destroy();
    deliver.mockResolvedValue(undefined);
    const restored = make(); await restored.initialize();
    await restored.retryDeliveries();
    expect(deliver.mock.calls.at(-1)![0]).toMatchObject({ occurrenceId: 'native-dsh-occurrence',
      schedule: { backend, threadId: owner.threadId, state: 'completed' } });
    expect(provider.create).toHaveBeenCalledOnce();
    expect((await read()).records[0].backend).toBe(backend);
  });

  it('does not certify queued-work cleanup from an AGY definition-only deletion receipt', async () => {
    const service = make(); await service.initialize();
    await service.create(owner, { ...input('queued-agy', true), backend: 'agy' });
    const handle = provider.handles.get('queued-agy')!;
    Object.assign(handle, { cancellationKeepsRunning: true, nativeDefinitionAbsent: true, retirementConfirmed: false });
    const cancelled = await service.cancel(owner, 'queued-agy');
    expect(cancelled.state).toBe('cancelled'); expect(cancelled.cleanupConfirmed).toBeUndefined();
    expect((await read()).records[0].cleanupConfirmed).toBeUndefined();
    provider.emit('queued-agy', { type: 'stopped', reason: 'Exact synthetic group exit', exitConfirmed: true });
    await service.list(owner);
  });

  it.each([true, false])('preserves outbox at abrupt shutdown and validates its owner at startup (%s)', async ownerCurrent => {
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
    expect((await read()).pending).toHaveLength(1);
    expect((await read()).records[0].state).toBe('active');
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

  it.each([false, true])('preserves early completion before create returns and stops a one-shot process (delayed ACK: %s)', async delayAck => {
    const gate = deferred<void>();
    const replacing = deferred<void>(), release = deferred<void>();
    provider.beforeResolve = async (_id, emit) => {
      emit({ type: 'started', occurrenceId: 'early-1' });
      emit({ type: 'completed', occurrenceId: 'early-1', success: true, output: 'Early result' });
      await gate.promise;
    };
    const service = make(); await service.initialize();
    const rename = fs.rename.bind(fs);
    let ackReplaced = false;
    const replacement = vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      // With the create receipt held, the first write after delivery is its ACK.
      if (delayAck && deliver.mock.calls.length === 1 && !ackReplaced) {
        replacing.resolve();
        await release.promise;
        await rename(...args);
        ackReplaced = true;
        return;
      }
      return rename(...args);
    });
    const creation = service.create(owner, input());
    let deliverySettled: Promise<void> | undefined;
    let joined = false;
    try {
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
      // Delivery invocation precedes the ACK's atomic replacement. Join it
      // before opening the catalog, without waiting for the held create receipt.
      deliverySettled = settled(service).then(() => { joined = true; });
      if (delayAck) {
        await replacing.promise;
        expect(joined).toBe(false);
        expect(ackReplaced).toBe(false);
        release.resolve();
      }
      await deliverySettled;
      if (delayAck) expect(ackReplaced).toBe(true);
      const catalog = await read();
      expect(catalog.records[0].state).toBe('completed');
      expect(catalog.records[0].nativeId).toBeUndefined();
      expect(catalog.pending).toEqual([]);
      gate.resolve();
      expect(await creation).toMatchObject({ state: 'completed', nativeId: 'native-schedule-a' });
      expect(provider.handles.get('schedule-a')!.stop).toHaveBeenCalledTimes(1);
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(deliver.mock.calls[0][0]).toMatchObject({ id: 'schedule-a:early-1', occurrenceId: 'early-1', schedule: owner });
    } finally {
      release.resolve(); gate.resolve();
      try {
        await Promise.allSettled([creation, ...(deliverySettled ? [deliverySettled] : [])]);
        await service.destroy();
      }
      finally { replacement.mockRestore(); }
    }
  });

  it('queues failed delivery durably and only retries on explicit reconnect', async () => {
    // Rejected delivery has no ACK write; joining via retryDeliveries here
    // would change the explicit retry counts this test verifies.
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
    expect((await restarted.list(owner))[1].error).toContain('not recreated or resumed');
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

  it('reports confirmed native absence without retiring work or claiming completion', async () => {
    const service = make(); await service.initialize(); await service.create(owner, input('schedule-a', true));
    await service.retainCleanupError(owner, 'schedule-a', new Error('Earlier cleanup remains unverified: ' + 'x'.repeat(4096)));
    const handle = provider.handles.get('schedule-a')!;
    vi.mocked(handle.list).mockResolvedValue(false);
    await service.list(owner);
    expect(handle.list).not.toHaveBeenCalled();
    await service.refresh(owner);
    expect(handle.list).toHaveBeenCalledOnce();
    const [record] = await service.list(owner);
    expect(record).toMatchObject({ state: 'interrupted', error: expect.stringContaining('no longer listed') });
    expect(record.error).toContain('Earlier cleanup remains unverified');
    expect(record.error).toContain('execution completion and cleanup are not confirmed');
    expect(Buffer.byteLength(record.error!)).toBeLessThanOrEqual(4096);
    expect(record.completedOccurrences).toBeUndefined();
    expect(record.cancelRequested).toBeUndefined(); expect(record.cleanupConfirmed).toBeUndefined();
    expect((await read()).records).toEqual([record]);
    expect(provider.admissions.get('schedule-a')!()).toBe(false);
    expect(service.hasActiveSchedules()).toBe(true);
    await service.refresh(owner);
    expect(handle.list).toHaveBeenCalledOnce();
    expect(handle.cancel).not.toHaveBeenCalled(); expect(handle.stop).not.toHaveBeenCalled();
    // Explicit cancellation still owns retirement of an interrupted definition.
    await service.cancel(owner, 'schedule-a');
    expect((await service.list(owner))[0].state).toBe('cancelled');
    expect(handle.stop).toHaveBeenCalledOnce();
    expect(service.hasActiveSchedules()).toBe(false);
  });

  it('bounds UTF-8 output and records explicit outbox saturation rather than pruning pending results', async () => {
    deliver.mockRejectedValue(new Error('Disconnected'));
    const service = make({ maxPendingDeliveries: 1 }); await service.initialize(); await service.create(owner, input('schedule-a', true));
    provider.emit('schedule-a', { type: 'completed', occurrenceId: 'occurrence-1', success: false,
      output: '\u{1f680}'.repeat(9000), error: 'x'.repeat(9000) });
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    // This delivery rejects, so its persisted outbox has no trailing ACK write.
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

  it('does not wait for a native CREATE receipt or call native cleanup at shutdown', async () => {
    const gate = deferred<void>(); provider.beforeResolve = () => gate.promise;
    const service = make(); await service.initialize(); const creation = service.create(owner, input());
    await vi.waitFor(() => expect(provider.create).toHaveBeenCalledOnce());
    await service.destroy();
    expect((await read()).records[0].state).toBe('creating');
    gate.resolve(); await creation;
    expect((await read()).records[0].state).toBe('creating');
    expect(provider.handles.get('schedule-a')!.stop).not.toHaveBeenCalled();
    await expect(service.create(owner, input('schedule-b'))).rejects.toThrow('closed');
  });
  it('never invokes native shutdown cleanup even when it would reject, retaining sibling evidence', async () => {
    const service = make(); await service.initialize();
    await service.create(owner, input()); await service.create(other, input('schedule-b', true));
    for (const handle of provider.handles.values()) vi.mocked(handle.stop).mockRejectedValue(new Error('Unconfirmed native exit'));
    const before = await read(); await service.destroy(); await service.destroy();
    expect(await read()).toEqual(before);
    for (const handle of provider.handles.values()) expect(handle.stop).not.toHaveBeenCalled();
    await expect(service.create(owner, input('schedule-c'))).rejects.toThrow('closed');
  });
});
