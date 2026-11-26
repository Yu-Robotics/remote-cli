import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isMainThread } from 'node:worker_threads';
import { HOST_SCHEDULE_CATALOG_FILE, SCHEDULE_CATALOG_FILE, ScheduleService } from '../src/scheduling/ScheduleService';
import type { HostScheduleInput, NativeScheduleInput, ScheduleDelivery, ScheduleOwner, ScheduleRecord } from '../src/scheduling/types';
import type { HostResult, ScheduleServiceOptions } from '../src/scheduling/ScheduleService';

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


describe('ScheduleService', () => {
  let directory: string;
  let cleanupFor: ReturnType<typeof vi.fn>;
  let deliver: ReturnType<typeof vi.fn>;
  let current: ReturnType<typeof vi.fn>;
  let services: ScheduleService[];
  const input = (id = 'schedule-a', recurring = false): NativeScheduleInput => ({ id, cwd: directory, prompt: 'Check the synthetic build',
    rule: recurring ? { kind: 'cron', expression: '*/5 * * * *', timezone: 'UTC' }
      : { kind: 'once', at: '2030-01-01T00:05:00.000Z' } });
  const make = (options: Partial<ScheduleServiceOptions> = {}) => {
    const service = new ScheduleService({ directory, cleanupFor: input => cleanupFor(input), deliver: delivery => deliver(delivery),
      isOwnerCurrent: value => current(value), now: () => now, ...options });
    services.push(service);
    return service;
  };
  const read = async () => JSON.parse(await fs.readFile(path.join(directory, SCHEDULE_CATALOG_FILE), 'utf8'));
  beforeEach(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'schedule-service-')));
    vi.spyOn(os, 'homedir').mockReturnValue(directory);
    vi.stubEnv('HOME', directory); vi.stubEnv('USERPROFILE', directory);
    cleanupFor = vi.fn();
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

  describe('host timing', () => {
    const owner: ScheduleOwner = { threadId: 'thread-a', openId: 'user-a', generation: 'epoch-a', bindingEpoch: 'binding-a' };
    const read = async () => JSON.parse(await fs.readFile(path.join(directory, HOST_SCHEDULE_CATALOG_FILE), 'utf8'));
    const interval = 300_000;
    let clock: number;
    const hostInput = (id = 'host-a', cron = false): HostScheduleInput => ({
      ...input(id, cron), engine: 'host', backend: 'claude', sessionId: 'original-session', bindingEpoch: 'binding-a',
    });
    type Dispatch = NonNullable<ScheduleServiceOptions['hostDispatch']>;
    const run = async (hostDispatch: Dispatch, options: Partial<ScheduleServiceOptions> = {}) => {
      const service = make({ now: () => clock, hostDispatch, ...options });
      await service.initialize();
      return service;
    };
    const tick = async (milliseconds: number) => {
      clock += milliseconds;
      await vi.advanceTimersByTimeAsync(milliseconds);
    };
    beforeEach(() => {
      clock = now;
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      cleanupFor.mockImplementation(() => { throw new Error('Unexpected native cleanup lookup'); });
    });
    afterEach(() => vi.useRealTimers());

    it('shares 30 live slots across threads and releases a slot on cancellation', async () => {
      const service = await run(vi.fn());
      const sibling = { ...owner, threadId: 'thread-b' };
      for (let index = 0; index < 30; index++) {
        await service.create(index % 2 === 0 ? owner : sibling, hostInput(`host-${index}`));
      }
      await expect(service.create(sibling, hostInput('next'))).rejects.toThrow('Live host schedule limit');
      await service.cancel(owner, 'host-0');
      await expect(service.create(sibling, hostInput('next'))).resolves.toMatchObject({ state: 'active' });
    });

    it('serializes host creation limits and snapshots the original request', async () => {
      const service = await run(vi.fn(), { maxLiveSchedules: 1, maxRecords: 2 });
      const request = hostInput('first'), original = { ...owner };
      const first = service.create(original, request);
      request.prompt = 'Mutated prompt'; request.id = 'changed'; original.generation = 'changed';
      await expect(service.create(owner, hostInput('second'))).rejects.toThrow('Live host schedule limit');
      expect(await first).toMatchObject({ ...owner, id: 'first', prompt: 'Check the synthetic build' });
      await service.cancel(owner, 'first'); await service.create(owner, hostInput('second'));
      await service.cancel(owner, 'second');
      await expect(service.create(owner, hostInput('third'))).rejects.toThrow('history was not pruned');
      expect(await service.list(owner)).toHaveLength(2);
    });

    it.each([undefined, 'native', 'unknown'])('rejects engine %s before persisting or dispatching', async engine => {
      const dispatch = vi.fn();
      const service = await run(dispatch);
      const before = await fs.readdir(directory);
      await expect(service.create(owner, { ...hostInput(), engine } as HostScheduleInput)).rejects.toThrow('requires the host engine');
      expect(await service.list(owner)).toEqual([]);
      expect(await fs.readdir(directory)).toEqual(before);
      expect(cleanupFor).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
    });

    it.each([false, true])('clears the outbox and fences a due occurrence across restart (admitted=%s)', async admitted => {
      const captured = deferred<() => Promise<boolean>>();
      const release = deferred<void>();
      const dispatch: Dispatch = async (row, _id, admit) => {
        if (row.id === 'queued') return await admit() ? { success: true, output: 'Queued output' } : undefined;
        if (admitted) expect(await admit()).toBe(true);
        captured.resolve(admit);
        await release.promise;
        return admitted ? { success: true, output: 'Late output' } : undefined;
      };
      const service = await run(dispatch);
      deliver.mockRejectedValue(new Error('Offline'));
      await service.create(owner, hostInput('queued'));
      await service.create(owner, { ...hostInput('racing'), rule: { kind: 'once', at: new Date(clock + 2 * interval).toISOString() } });
      await tick(interval);
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
      expect(service.hasPendingResults()).toBe(true);
      expect(service.hasPendingScheduleResult(owner, 'queued')).toBe(true);
      expect(service.hasPendingScheduleResult(owner, 'racing')).toBe(false);
      expect(() => service.hasPendingScheduleResult({ ...owner, openId: 'other' }, 'queued')).toThrow(/owner/);
      await tick(interval);
      const admit = await captured.promise;
      for (const changed of [{ openId: 'other' }, { generation: 'other' }, { bindingEpoch: 'other' }]) {
        await expect(service.clearHostContext(owner.threadId, () => ({ ...owner, ...changed }), false)).rejects.toThrow(/different binding/);
      }
      expect(await service.clearHostContext(owner.threadId, () => owner, false)).toBe(2);
      expect(await admit()).toBe(false);
      release.resolve();
      await vi.waitFor(() => expect(service.canRestartWithoutActiveWork()).toBe(true));
      expect(await read()).toMatchObject({ records: [], pending: [], purged: [{ ...owner, id: 'queued' }, { ...owner, id: 'racing' }] });
      await service.destroy();
      const next = await run(vi.fn());
      await next.retryDeliveries();
      expect(deliver).toHaveBeenCalledOnce();
      await expect(next.create(owner, { ...hostInput('queued', true) })).rejects.toThrow(/purged/);
    });

    it('refuses clear while an external delivery is pending and erases its output on retry', async () => {
      const release = deferred<void>();
      deliver.mockImplementation(async () => { await release.promise; throw new Error('No receipt'); });
      const service = await run(async (_row, _id, admit) => await admit() ? { success: true } : undefined);
      await service.create(owner, hostInput());
      await tick(interval);
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
      await expect(service.clearHostContext(owner.threadId, () => owner, false)).rejects.toThrow(/delivery/);
      expect(service.hasPendingResults(owner.threadId)).toBe(true);
      expect(service.hasPendingResults('unrelated-thread')).toBe(false);
      expect((await read()).purged).toEqual([]);
      release.resolve();
      await vi.waitFor(async () => expect(await service.clearHostContext(owner.threadId, () => owner, false)).toBe(1));
      expect((await read()).pending).toEqual([]);
    });

    it('retains a completed result for a different owner and can retry a failed clear write after restart', async () => {
      const dispatch: Dispatch = async (_row, _id, admit) => await admit() ? { success: true, output: 'Original output' } : undefined;
      let service = await run(dispatch);
      deliver.mockRejectedValue(new Error('Offline'));
      await service.create(owner, hostInput());
      await tick(interval);
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
      const before = await read();
      await expect(service.clearHostContext(owner.threadId, () => ({ ...owner, bindingEpoch: 'other' }), false)).rejects.toThrow(/different binding/);
      vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('Catalog replacement failed'));
      await expect(service.clearHostContext(owner.threadId, () => owner, false)).rejects.toThrow(/replacement failed/);
      expect(await read()).toEqual(before);
      await service.destroy();
      service = await run(dispatch);
      expect(await service.clearHostContext(owner.threadId, () => owner, false)).toBe(1);
      expect(await read()).toMatchObject({ records: [], pending: [] });
    });

    it('requires the captured Router epoch before accepting a host definition', async () => {
      const service = await run(vi.fn());
      for (const bindingEpoch of [undefined, '', 'different']) {
        await expect(service.create(owner, { ...hostInput(), bindingEpoch })).rejects.toThrow();
      }
      await service.create({ ...owner, bindingEpoch: undefined }, hostInput());
      expect(current).toHaveBeenCalledWith(owner);
      expect(await read()).toMatchObject({ version: 8, records: [{ bindingEpoch: owner.bindingEpoch }] });
      const rebound = { ...owner, bindingEpoch: 'new' };
      expect(await service.list(rebound)).toEqual([]);
      await expect(service.cancel(rebound, 'host-a')).rejects.toThrow(/owner/);
      expect((await service.purge(rebound, { ids: ['host-a'] })).removedIds).toEqual([]);
    });

    it.each(['same user', 'different user'])('retires a full outbox on verified rebind to the %s', async identity => {
      const dispatch = vi.fn<Parameters<Dispatch>, ReturnType<Dispatch>>(async (row, _id, admit) =>
        await admit() ? { success: true, output: `Result for ${row.id}` } : undefined);
      const options = { maxPendingDeliveries: 1, maxRecords: 2, maxLiveSchedules: 2 };
      let service = await run(dispatch, options);
      await service.create(owner, hostInput('completed'));
      await service.create(owner, hostInput('queued', true));
      const offlineAttempt = deferred<ScheduleDelivery>();
      deliver.mockImplementation(async (delivery: ScheduleDelivery) => {
        offlineAttempt.resolve(delivery);
        throw new Error('Offline');
      });
      await tick(interval);
      expect(await offlineAttempt.promise).toMatchObject({ schedule: { ...owner, id: 'completed' }, output: 'Result for completed' });
      await service.destroy();
      current.mockReturnValue(undefined);
      service = await run(dispatch, options);
      await service.retryDeliveries();
      expect((await read()).pending).toHaveLength(1);
      expect(service.hasActiveSchedules()).toBe(true);
      const rebound = { ...owner, openId: identity === 'same user' ? owner.openId : 'user-b', bindingEpoch: 'new-binding' };
      current.mockImplementation(candidate => candidate.openId === rebound.openId && candidate.bindingEpoch === rebound.bindingEpoch);
      await service.retryDeliveries();
      expect(service.hasPendingResults()).toBe(false);
      expect(deliver).toHaveBeenCalledOnce();
      expect(service.hasActiveSchedules()).toBe(false);
      expect((await read()).records.every((row: ScheduleRecord) => row.state === 'interrupted')).toBe(true);
      expect(await service.list(rebound)).toEqual([]);
      await service.create(rebound, { ...hostInput('new', true), bindingEpoch: rebound.bindingEpoch });
      expect((await read()).purged).toContainEqual({ ...owner, id: 'completed' });
      await service.destroy();
      service = await run(dispatch, options);
      const reboundDelivery = deferred<ScheduleDelivery>();
      deliver.mockImplementation(async (delivery: ScheduleDelivery) => { reboundDelivery.resolve(delivery); });
      await tick(interval);
      expect(await reboundDelivery.promise).toMatchObject({ schedule: { ...rebound, id: 'new' }, output: 'Result for new' });
      expect(deliver).toHaveBeenCalledTimes(2);
      expect(dispatch.mock.calls.map(([record]) => record.id)).toEqual(['completed', 'new']);
      await expect(service.create(rebound, { ...hostInput('completed', true), bindingEpoch: rebound.bindingEpoch })).rejects.toThrow(/purged/);
    });

    it('holds an admitted result and other due work through unknown binding, then delivers to the original epoch', async () => {
      const admitted = deferred<void>(), finish = deferred<void>();
      const dispatch = vi.fn<Parameters<Dispatch>, ReturnType<Dispatch>>(async (row, _id, admit) => {
        if (!await admit()) return undefined;
        if (row.id === 'running') { admitted.resolve(); await finish.promise; }
        return { success: true, output: row.id };
      });
      let service = await run(dispatch);
      await service.create(owner, hostInput('running'));
      await service.create(owner, { ...hostInput('future'), rule: { kind: 'once', at: new Date(now + 2 * interval).toISOString() } });
      await tick(interval); await admitted.promise;
      current.mockReturnValue(undefined);
      finish.resolve();
      await vi.waitFor(() => expect(service.hasPendingResults()).toBe(true));
      await service.destroy();
      current.mockImplementation(() => { throw new Error('Binding unavailable'); });
      service = await run(dispatch);
      await tick(interval);
      await service.retryDeliveries();
      expect(dispatch).toHaveBeenCalledOnce();
      expect(deliver).not.toHaveBeenCalled();
      expect((await read()).pending[0].output).toBe('running');
      current.mockReturnValue(true);
      await service.retryDeliveries(); await tick(1);
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
      expect(dispatch.mock.calls.map(([row]) => row.id)).toEqual(['running', 'future']);
      expect(deliver.mock.calls.map(([delivery]) => delivery.schedule.bindingEpoch)).toEqual([owner.bindingEpoch, owner.bindingEpoch]);
    });

    it('keeps the same slot when registration disappears while admission is being persisted', async () => {
      const refused = deferred<void>();
      const dispatch = vi.fn<Parameters<Dispatch>, ReturnType<Dispatch>>()
        .mockImplementationOnce(async (_record, _id, admit) => {
          const rename = fs.rename;
          vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => {
            await rename(...args);
            current.mockReturnValue(undefined);
          });
          expect(await admit()).toBe(false);
          refused.resolve();
          return undefined;
        })
        .mockImplementationOnce(async (_record, _id, admit) => await admit() ? { success: true } : undefined);
      const service = await run(dispatch);
      await service.create(owner, hostInput());
      await tick(interval); await refused.promise;
      expect((await read()).records[0]).toMatchObject({ state: 'active', nextDueAt: clock });
      expect(service.hasPendingResults()).toBe(false);
      current.mockReturnValue(true);
      await service.retryDeliveries(); await tick(1);
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
      expect(dispatch.mock.calls[0][1]).toBe(dispatch.mock.calls[1][1]);
    });

    it('releases only the stale owner from a full outbox and runs the waiting current owner', async () => {
      const sibling = { ...other, bindingEpoch: 'binding-b' };
      const dispatch = vi.fn<Parameters<Dispatch>, ReturnType<Dispatch>>(async (record, _id, admit) =>
        await admit() ? { success: true, output: record.openId } : undefined);
      const service = await run(dispatch, { maxPendingDeliveries: 1 });
      await service.create(owner, hostInput('stale'));
      await service.create(sibling, { ...hostInput('sibling'), bindingEpoch: sibling.bindingEpoch });
      deliver.mockRejectedValue(new Error('Offline'));
      await tick(interval);
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
      current.mockImplementation(candidate => candidate.bindingEpoch === sibling.bindingEpoch);
      deliver.mockResolvedValue(undefined);
      await service.retryDeliveries(); await tick(1);
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
      expect(deliver.mock.calls[1][0]).toMatchObject({ output: sibling.openId, schedule: { ...sibling, id: 'sibling' } });
      expect(dispatch.mock.calls.map(([row]) => row.id)).toEqual(['stale', 'sibling']);
      expect((await service.list(sibling)).map(row => row.id)).toEqual(['sibling']);
    });

    it('interrupts an epochless v6 host row without delivering its pending output', async () => {
      const dispatch = vi.fn();
      let service = await run(dispatch);
      await service.create(owner, hostInput('old', true));
      await service.destroy();
      const catalog = await read();
      catalog.version = 6;
      delete catalog.records[0].bindingEpoch;
      catalog.pending.push({ id: 'old:prior', scheduleId: 'old', occurrenceId: 'prior', success: true, output: 'Old private result' });
      await fs.writeFile(path.join(directory, HOST_SCHEDULE_CATALOG_FILE), JSON.stringify(catalog));
      service = await run(dispatch);
      await service.retryDeliveries();
      expect((await read()).records[0].state).toBe('interrupted');
      expect(service.hasPendingResults()).toBe(false);
      expect(dispatch).not.toHaveBeenCalled();
      expect(deliver).not.toHaveBeenCalled();
    });

    it.each(['claude', 'dsh', 'agy', 'codex', 'kimi', 'opencode', 'pi', 'zcode'] as const)('restores future %s work and admits once with a durable original-session receipt', async backend => {
      const native = deferred<void>();
      const dispatch = vi.fn<Parameters<Dispatch>, ReturnType<Dispatch>>(async (record, occurrenceId, admit) => {
        expect(record).toMatchObject({ ...owner, sessionId: 'original-session', backend, engine: 'host' });
        expect(await admit()).toBe(true);
        expect((await read()).records[0]).toMatchObject({ state: 'running', inFlightDueAt: now + interval });
        expect(occurrenceId).toBe(`host-${now + interval}`);
        expect(await admit()).toBe(false);
        native.resolve();
        return { success: true, output: 'native result' };
      });
      const first = await run(dispatch);
      await first.create(owner, { ...hostInput(), backend });
      expect(first.canRestartWithoutActiveWork()).toBe(true);
      await first.destroy();
      expect(vi.getTimerCount()).toBe(0);
      const service = await run(dispatch);
      await tick(interval - 1);
      expect(dispatch).not.toHaveBeenCalled();
      await tick(1); await native.promise;
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
      await service.retryDeliveries();
      expect(deliver.mock.calls[0][0]).toMatchObject({ schedule: { ...owner, state: 'completed' }, success: true, output: 'native result' });
      expect((await read()).pending).toEqual([]);
      expect(service.canRestartWithoutActiveWork()).toBe(true);

      expect(cleanupFor).not.toHaveBeenCalled();
    });

    it('uses one timer, skips offline cron slots, and publishes a missed once without replay', async () => {
      const dispatch = vi.fn<Parameters<Dispatch>, ReturnType<Dispatch>>(async (_record, _id, admit) =>
        await admit() ? { success: true } : undefined);
      let service = await run(dispatch);
      await service.create(owner, hostInput('cron', true));
      await service.create(owner, hostInput('once'));
      expect(vi.getTimerCount()).toBe(1);
      await service.destroy();
      clock += 3 * interval + 10;
      service = await run(dispatch);
      await service.retryDeliveries();
      const records = await service.list(owner);
      expect(records).toEqual([expect.objectContaining({ id: 'cron', state: 'active', nextDueAt: now + 4 * interval,
        lastOccurrence: { dueAt: now + interval, status: 'skipped', error: expect.stringContaining('offline') } }),
        expect.objectContaining({ id: 'once', state: 'failed', error: expect.stringMatching(/missed/) })]);
      expect(deliver.mock.calls[0][0]).toMatchObject({ schedule: { id: 'once' }, success: false, error: expect.stringMatching(/missed/) });
      expect(dispatch).not.toHaveBeenCalled();
      await tick(interval - 10);
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
      expect(dispatch).toHaveBeenCalledOnce();
      expect((await service.list(owner))[0].nextDueAt).toBe(now + 5 * interval);
    });

    it('keeps the earliest timer armed across unrelated catalog writes', async () => {
      const dispatch = vi.fn<Parameters<Dispatch>, ReturnType<Dispatch>>(async (_record, _id, admit) =>
        await admit() ? { success: true } : undefined);
      const service = await run(dispatch);
      await service.create(owner, hostInput('first'));
      const scheduled = service['hostTimer'];
      expect(scheduled).toBeDefined();
      await service.create(owner, { ...hostInput('later'), rule: { kind: 'once', at: new Date(now + interval * 2).toISOString() } });
      await service.cancel(owner, 'later');
      expect(service['hostTimer']).toBe(scheduled);
      await tick(interval);
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
      expect(dispatch.mock.calls[0][0].id).toBe('first');
    });

    it('delivers the interrupted cron fire, skips elapsed slots and executes the next future slot after restart', async () => {
      const started = deferred<void>(), interrupted = deferred<void>();
      const dispatch = vi.fn<Parameters<Dispatch>, ReturnType<Dispatch>>()
        .mockImplementationOnce(async (_record, _id, admit) => {
          if (!await admit()) return;
          started.resolve(); await interrupted.promise;
          return { success: false, abortedByUser: true, error: 'Scheduled occurrence interrupted by /abort.' };
        })
        .mockImplementation(async (_record, _id, admit) => await admit() ? { success: true } : undefined);
      let service = await run(dispatch);
      await service.create(owner, hostInput('recurring', true));
      await tick(interval); await started.promise;
      clock += interval + 1000;
      interrupted.resolve();
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
      expect(deliver.mock.calls[0][0]).toMatchObject({ success: false, occurrenceId: `host-${now + interval}`,
        error: expect.stringContaining('/abort'), schedule: { state: 'active', nextDueAt: now + 3 * interval,
          lastOccurrence: { dueAt: now + interval, status: 'aborted' } } });
      await service.destroy(); service = await run(dispatch);
      await tick(interval - 1000);
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
      expect(deliver.mock.calls[1][0]).toMatchObject({ success: true, occurrenceId: `host-${now + 3 * interval}`,
        schedule: { state: 'active', nextDueAt: now + 4 * interval } });
    });

    it.each(['once', 'cancel', 'permanent failure'])('preserves terminal %s semantics on a failed host fire', async reason => {
      const service = await run(async (_record, _id, admit) => {
        if (!await admit()) return;
        if (reason === 'cancel') await service.cancel(owner, 'job');
        return { success: false, ...(reason === 'permanent failure' ? { stopSchedule: true as const } : { abortedByUser: true as const }), error: 'Occurrence failed' };
      });
      await service.create(owner, hostInput('job', reason !== 'once'));
      await tick(interval);
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
      expect(deliver.mock.calls[0][0]).toMatchObject({ success: false, schedule: { state: reason === 'cancel' ? 'cancelled' : 'failed' } });
      expect((await service.list(owner))[0].nextDueAt).toBeUndefined();
    });

    it('persists unadmitted AGY skips for cron and one-shot timers without replay after restart', async () => {
      const reason = 'Scheduled occurrence skipped without execution. Manual AGY recovery is required.';
      const dispatch = vi.fn<Parameters<Dispatch>, ReturnType<Dispatch>>(async (_record, id, admit) => {
        if (id === `host-${now + interval}`) return { success: false, skippedBeforeAdmission: true, error: reason };
        if (await admit()) return { success: true };
      });
      let service = await run(dispatch);
      for (const cron of [false, true]) {
        await service.create(owner, { ...hostInput(cron ? 'cron' : 'once', cron), backend: 'agy' });
      }
      await tick(interval);
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
      for (const [delivery] of deliver.mock.calls) expect(delivery).toMatchObject({ success: false, error: reason });
      await service.destroy();
      service = await run(dispatch);
      const rows = await service.list(owner);
      for (const row of rows) {
        expect(row.lastOccurrence).toEqual({ dueAt: clock, status: 'skipped', error: reason });
        expect(row.completedOccurrences).toEqual([`host-${clock}`]);
        expect(row.inFlightDueAt).toBeUndefined();
        expect(row.state).toBe(row.id === 'once' ? 'failed' : 'active');
        expect(row.nextDueAt).toBe(row.id === 'once' ? undefined : clock + interval);
      }
      await tick(interval);
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(3));
      expect(dispatch.mock.calls.map(([row, id]) => [row.id, id]).at(-1)).toEqual(['cron', `host-${clock}`]);
      expect(dispatch).toHaveBeenCalledTimes(3);
    });

    it('records two failed cron slots and a later success across restart with independent outbox receipts', async () => {
      const dispatch = vi.fn<Parameters<Dispatch>, ReturnType<Dispatch>>(async (_record, id, admit) => {
        if (!await admit()) return;
        return id === `host-${now + 3 * interval}` ? { success: true, output: 'Recovered' }
          : { success: false, error: 'Upstream unavailable' };
      });
      deliver.mockRejectedValue(new Error('Offline'));
      let service = await run(dispatch);
      await service.create(owner, hostInput('cron', true));
      for (let i = 1; i <= 3; i++) {
        await tick(interval);
        await vi.waitFor(async () => expect((await read()).pending).toHaveLength(i));
        const row = (await service.list(owner))[0];
        expect(row).toMatchObject({ state: 'active', nextDueAt: clock + interval });
        expect(row.lastOccurrence).toEqual(i === 3 ? { dueAt: clock, status: 'succeeded' }
          : { dueAt: clock, status: 'failed', error: 'Upstream unavailable' });
        expect(row.error).toBeUndefined();
        await service.destroy();
        service = await run(dispatch);
        expect((await service.list(owner))[0]).toEqual(row);
      }
      const ids = [1, 2, 3].map(i => `host-${now + i * interval}`);
      expect(dispatch.mock.calls.map(([, id]) => id)).toEqual(ids);
      expect((await read()).pending.map((row: ScheduleDelivery) => [row.occurrenceId, row.success])).toEqual(
        ids.map((id, index) => [id, index === 2]));
      deliver.mockResolvedValue(undefined);
      await service.retryDeliveries();
      expect((await read()).pending).toEqual([]);
    });

    it('defers busy threads under the same occurrence ID and expires the prior admission callback', async () => {
      let stale!: () => Promise<boolean>;
      const dispatch = vi.fn<Parameters<Dispatch>, ReturnType<Dispatch>>()
        .mockImplementationOnce(async (_record, _id, admit) => { stale = admit; return undefined; })
        .mockImplementationOnce(async (_record, _id, admit) => {
          expect(await stale()).toBe(false);
          return await admit() ? { success: true } : undefined;
        });
      const service = await run(dispatch);
      await service.create(owner, hostInput());
      await tick(interval);
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
      expect((await service.list(owner))[0]).toMatchObject({ state: 'active', nextDueAt: clock });
      expect(await stale()).toBe(false);
      await tick(1000);
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
      expect(dispatch.mock.calls[0][1]).toEqual(dispatch.mock.calls[1][1]);
    });

    describe('thread-queued occurrences', () => {
      type Call = { id: string; record: ScheduleRecord; admit: () => Promise<boolean>; signal?: AbortSignal;
        finish: (result: HostResult | undefined) => void };
      /** Models a thread FIFO: hostDispatch enqueues at due time and settles only when the caller finishes it. */
      const queue = () => {
        const calls: Call[] = [];
        const dispatch = vi.fn<Parameters<Dispatch>, ReturnType<Dispatch>>((record, id, admit, signal) =>
          new Promise(finish => { calls.push({ id, record, admit, signal, finish }); }));
        return { calls, dispatch };
      };
      const slot = (n: number) => `host-${now + n * interval}`;
      const start = async (options: Partial<ScheduleServiceOptions> = {}) => {
        const { calls, dispatch } = queue();
        const service = await run(dispatch, options);
        await service.create(owner, hostInput('cron', true));
        await tick(interval);
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        return { calls, dispatch, service };
      };

      it('keeps a due cron occurrence queued past later slots without expiry and resumes at the next real slot', async () => {
        const { calls, service } = await start();
        expect(calls[0]).toMatchObject({ id: slot(1), signal: expect.objectContaining({ aborted: false }) });
        await tick(3 * interval);
        expect(calls).toHaveLength(1);
        expect((await service.list(owner))[0]).toMatchObject({ state: 'active', nextDueAt: now + interval });
        expect(await calls[0].admit()).toBe(true);
        calls[0].finish({ success: true, output: 'Waited behind ordinary messages' });
        await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
        expect(deliver.mock.calls[0][0]).toMatchObject({ occurrenceId: slot(1), success: true });
        const [row] = await service.list(owner);
        expect(row).toMatchObject({ state: 'active', nextDueAt: now + 5 * interval, lastOccurrence: { dueAt: now + interval, status: 'succeeded' } });
        expect(calls).toHaveLength(1);
        await tick(interval);
        await vi.waitFor(() => expect(calls).toHaveLength(2));
        expect(calls[1].id).toBe(slot(5));
      });

      it('queues one follow-up at its own due time while a run continues and admits it after that result', async () => {
        const { calls, service } = await start();
        expect(await calls[0].admit()).toBe(true);
        await tick(interval);
        await vi.waitFor(() => expect(calls).toHaveLength(2));
        expect(calls[1]).toMatchObject({ id: slot(2), signal: expect.objectContaining({ aborted: false }) });
        // The thread may start the follow-up as soon as the earlier turn returns, before its result is recorded.
        let admitted: boolean | undefined;
        const second = calls[1].admit().then(value => admitted = value);
        await tick(2 * interval);
        expect(calls).toHaveLength(2);
        expect(admitted).toBeUndefined();
        expect((await service.list(owner))[0]).toMatchObject({ state: 'running', inFlightDueAt: now + interval });
        calls[0].finish({ success: true, output: 'First' });
        expect(await second).toBe(true);
        expect((await service.list(owner))[0]).toMatchObject({ state: 'running', inFlightDueAt: now + 2 * interval,
          lastOccurrence: { dueAt: now + interval, status: 'succeeded' } });
        calls[1].finish({ success: true, output: 'Second' });
        await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
        expect(deliver.mock.calls.map(([delivery]) => delivery.occurrenceId)).toEqual([slot(1), slot(2)]);
        expect((await service.list(owner))[0]).toMatchObject({ state: 'active', nextDueAt: now + 5 * interval });
        await tick(interval);
        await vi.waitFor(() => expect(calls).toHaveLength(3));
        expect(calls[2].id).toBe(slot(5));
      });

      it('applies an unadmitted follow-up result only after the earlier run is recorded', async () => {
        const { calls, service } = await start();
        expect(await calls[0].admit()).toBe(true);
        await tick(interval);
        await vi.waitFor(() => expect(calls).toHaveLength(2));
        calls[1].finish(undefined);
        await tick(10);
        expect((await service.list(owner))[0]).toMatchObject({ state: 'running', inFlightDueAt: now + interval });
        calls[0].finish({ success: true });
        await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
        expect((await service.list(owner))[0]).toMatchObject({ state: 'active', nextDueAt: now + 2 * interval });
        await tick(1000);
        await vi.waitFor(() => expect(calls).toHaveLength(3));
        expect(calls[2].id).toBe(slot(2));
        expect(await calls[2].admit()).toBe(true);
        calls[2].finish({ success: true });
        await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
        expect(deliver.mock.calls[1][0].occurrenceId).toBe(slot(2));
      });

      it.each(['cancel', 'owner change', 'shutdown'])('aborts only a waiting follow-up after %s', async barrier => {
        const { calls, service } = await start();
        expect(await calls[0].admit()).toBe(true);
        await tick(interval);
        await vi.waitFor(() => expect(calls).toHaveLength(2));
        if (barrier === 'cancel') await service.cancel(owner, 'cron');
        if (barrier === 'owner change') { current.mockReturnValue(false); await service.retryDeliveries(); }
        if (barrier === 'shutdown') await service.destroy();
        expect(calls[1].signal?.aborted).toBe(true);
        expect(calls[0].signal?.aborted).toBe(false);
        expect(await calls[1].admit()).toBe(false);
        calls[1].finish(undefined);
        calls[0].finish({ success: true, output: 'Admitted before ' + barrier });
        await tick(3 * interval);
        expect(calls).toHaveLength(2);
        if (barrier === 'cancel') {
          await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
          expect(deliver.mock.calls[0][0]).toMatchObject({ occurrenceId: slot(1), schedule: { state: 'cancelled' } });
          await vi.waitFor(() => expect(service.canRestartWithoutActiveWork()).toBe(true));
        } else expect(deliver).not.toHaveBeenCalled();
      });

      it('aborts a first waiting occurrence on cancellation and frees its schedule', async () => {
        const { calls, service } = await start();
        await service.cancel(owner, 'cron');
        expect(calls[0].signal?.aborted).toBe(true);
        expect(await calls[0].admit()).toBe(false);
        calls[0].finish(undefined);
        await vi.waitFor(() => expect(service.canRestartWithoutActiveWork()).toBe(true));
        expect((await service.list(owner))[0]).toMatchObject({ state: 'cancelled' });
        expect(deliver).not.toHaveBeenCalled();
      });

      it.each(['running', 'linked'])('never replays a waiting follow-up after restart (%s)', async stage => {
        const { calls, dispatch } = queue();
        let service = await run(dispatch);
        await service.create(owner, hostInput('cron', true));
        await tick(interval); await vi.waitFor(() => expect(calls).toHaveLength(1));
        expect(await calls[0].admit()).toBe(true);
        await tick(interval); await vi.waitFor(() => expect(calls).toHaveLength(2));
        if (stage === 'linked') {
          calls[0].finish({ success: true });
          await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
          expect((await service.list(owner))[0]).toMatchObject({ state: 'active', nextDueAt: now + 2 * interval });
        }
        await service.destroy();
        expect(calls[1].signal?.aborted).toBe(true);
        clock += 1000;
        service = await run(dispatch);
        await service.retryDeliveries();
        const [row] = await service.list(owner);
        expect(row).toMatchObject({ state: 'active', nextDueAt: now + 3 * interval, lastOccurrence: stage === 'running'
          ? { dueAt: now + interval, status: 'unknown' } : { dueAt: now + 2 * interval, status: 'skipped', error: expect.stringContaining('offline') } });
        expect(calls).toHaveLength(2);
        await tick(interval - 1000);
        await vi.waitFor(() => expect(calls).toHaveLength(3));
        expect(calls[2].id).toBe(slot(3));
      });

      it('does not reserve a follow-up beyond the outbox limit', async () => {
        const { calls, service } = await start({ maxPendingDeliveries: 1 });
        expect(await calls[0].admit()).toBe(true);
        await tick(2 * interval);
        expect(calls).toHaveLength(1);
        calls[0].finish({ success: true });
        await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
        expect((await service.list(owner))[0]).toMatchObject({ state: 'active', nextDueAt: now + 4 * interval });
      });

      it('keeps distinct schedules independent and enters simultaneous wakes in due order', async () => {
        const { calls, dispatch } = queue();
        const service = await run(dispatch);
        await service.create(owner, { ...hostInput('late'), rule: { kind: 'once', at: new Date(now + 2 * interval).toISOString() } });
        await service.create(owner, hostInput('early'));
        await service.create(owner, hostInput('cron', true));
        await tick(2 * interval);
        await vi.waitFor(() => expect(calls).toHaveLength(3));
        // Due order first; equal slots fall back to creation time, then ID.
        expect(calls.map(call => [call.record.id, call.id])).toEqual([['cron', slot(1)], ['early', slot(1)], ['late', slot(2)]]);
        // The cron occurrence keeps waiting; other schedules still run and finish.
        expect(await calls[1].admit()).toBe(true);
        calls[1].finish({ success: true });
        expect(await calls[2].admit()).toBe(true);
        calls[2].finish({ success: true });
        await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
        expect(deliver.mock.calls.map(([delivery]) => delivery.schedule.id)).toEqual(['early', 'late']);
        await tick(interval);
        expect(calls).toHaveLength(3);
        expect((await service.list(owner)).find(row => row.id === 'cron')).toMatchObject({ state: 'active', nextDueAt: now + interval });
      });
    });

    it('keeps a historical v7 failed cron stopped without inventing a last outcome', async () => {
      const dispatch = vi.fn();
      let service = await run(dispatch);
      await service.create(owner, hostInput('old', true));
      await service.destroy();
      const catalog = await read();
      catalog.version = 7;
      const [row] = catalog.records;
      delete row.nextDueAt;
      Object.assign(row, { state: 'failed', error: 'Prior failure', completedOccurrences: [`host-${now + interval}`] });
      await fs.writeFile(path.join(directory, HOST_SCHEDULE_CATALOG_FILE), JSON.stringify(catalog));
      service = await run(dispatch);
      await tick(2 * interval);
      expect((await service.list(owner))[0]).toEqual(row);
      expect(dispatch).not.toHaveBeenCalled();
      expect(deliver).not.toHaveBeenCalled();
    });

    it('records a missing admitted result as unknown and starts only the next cron slot', async () => {
      const dispatch = vi.fn<Parameters<Dispatch>, ReturnType<Dispatch>>(async (_record, id, admit) => {
        if (!await admit() || id === `host-${now + interval}`) return undefined;
        return { success: true };
      });
      const service = await run(dispatch);
      await service.create(owner, hostInput('cron', true));
      await tick(interval); await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
      expect((await service.list(owner))[0]).toMatchObject({ state: 'active', nextDueAt: clock + interval,
        lastOccurrence: { dueAt: clock, status: 'unknown', error: expect.stringContaining('outcome is unknown') } });
      await tick(interval); await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
      expect(dispatch.mock.calls.map(([, id]) => id)).toEqual([`host-${now + interval}`, `host-${now + 2 * interval}`]);
    });

    it.each(['cancel', 'owner change', 'shutdown'])('denies admission after %s during reservation', async barrier => {
      const ticket = deferred<() => Promise<boolean>>();
      const release = deferred<void>();
      const dispatch: Dispatch = async (_record, _id, admit) => { ticket.resolve(admit); await release.promise; return undefined; };
      const service = await run(dispatch);
      await service.create(owner, hostInput());
      await tick(interval); const admit = await ticket.promise;
      expect(service.canRestartWithoutActiveWork()).toBe(false);
      if (barrier === 'cancel') await service.cancel(owner, 'host-a');
      if (barrier === 'owner change') current.mockReturnValue(false);
      if (barrier === 'shutdown') await service.destroy();
      expect(await admit()).toBe(false);
      release.resolve();
      if (barrier !== 'shutdown') {
        await vi.waitFor(() => expect(service.canRestartWithoutActiveWork()).toBe(true));
        expect((await service.list(owner))[0].state).toBe(barrier === 'cancel' ? 'cancelled' : 'interrupted');
      }
      expect(deliver).not.toHaveBeenCalled();
    });

    it('retains an admitted result across cancellation, disconnect and restart, then purges without native cleanup', async () => {
      const admitted = deferred<void>(), finish = deferred<void>();
      const dispatch: Dispatch = async (_r, _id, admit) => {
        if (!await admit()) throw new Error('Expected admission');
        admitted.resolve(); await finish.promise;
        return { success: true, output: 'already started' };
      };
      let service = await run(dispatch);
      await service.create(owner, hostInput('cron', true));
      await tick(interval); await admitted.promise;
      await service.cancel(owner, 'cron');
      expect(service.hasActiveSchedules(owner.threadId)).toBe(true);
      expect((await service.purge(owner, { ids: ['cron'] })).pending[0].reason).toBe('occurrence_running');
      deliver.mockRejectedValue(new Error('Disconnected'));
      finish.resolve();
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
      expect(service.canRestartWithoutActiveWork()).toBe(false);
      await service.destroy();
      deliver.mockResolvedValue(undefined);
      service = await run(dispatch);
      await service.retryDeliveries();
      expect(deliver.mock.calls[1][0]).toEqual(deliver.mock.calls[0][0]);
      expect(deliver.mock.calls[1][0]).toMatchObject({ success: true, output: 'already started', schedule: { state: 'cancelled' } });
      expect(await service.purge(owner, { ids: ['cron'] })).toMatchObject({ status: 'complete', removedIds: ['cron'], nativeCleanupUnresolved: [] });
      await expect(service.create(owner, hostInput('cron', true))).rejects.toThrow(/purged/);
      expect(cleanupFor).not.toHaveBeenCalled();
    });

    it.each([false, true])('fences an unknown in-flight slot across restart and ignores late completion (cron=%s)', async cron => {
      const admitted = deferred<void>(), finish = deferred<void>();
      const dispatch = vi.fn<Parameters<Dispatch>, ReturnType<Dispatch>>(async (_record, _id, admit) => {
        if (!await admit()) throw new Error('Expected admission');
        admitted.resolve(); await finish.promise;
        return { success: true, output: 'late' };
      });
      const first = await run(dispatch);
      await first.create(owner, hostInput('host-a', cron));
      await expect(make().initialize()).rejects.toThrow(/owns the schedule catalog/);
      await tick(interval); await admitted.promise; await first.destroy();
      const next = await run(dispatch);
      finish.resolve();
      await next.retryDeliveries();
      expect(deliver.mock.calls[0][0]).toMatchObject({ success: false, error: expect.stringMatching(/outcome is unknown/) });
      expect((await next.list(owner))[0]).toMatchObject({ state: cron ? 'active' : 'failed',
        lastOccurrence: { dueAt: clock, status: 'unknown', error: expect.stringContaining('not replayed') } });
      await tick(interval);
      if (cron) {
        await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
        expect(dispatch.mock.calls.map(([, id]) => id)).toEqual([`host-${now + interval}`, `host-${now + 2 * interval}`]);
        expect((await next.list(owner))[0].lastOccurrence).toEqual({ dueAt: clock, status: 'succeeded' });
      } else {
        expect(dispatch).toHaveBeenCalledOnce();
        expect(deliver).toHaveBeenCalledOnce();
      }
      expect((await read()).pending).toEqual([]);
    });

    it.each(['throw', 'success without admission'])('makes pre-admission %s terminal for only its own job', async mode => {
      const dispatch: Dispatch = async () => {
        if (mode === 'throw') throw new Error('Session mismatch');
        return { success: true };
      };
      const service = await run(dispatch);
      await service.create(owner, hostInput('cron', true));
      await tick(interval);
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
      await service.retryDeliveries();
      expect((await service.list(owner))[0]).toMatchObject({ state: 'failed', error: expect.any(String) });
      expect(service.canRestartWithoutActiveWork()).toBe(true);
      await tick(interval);
      expect(deliver).toHaveBeenCalledOnce();
      expect(await service.create(owner, hostInput('second', true))).toMatchObject({ state: 'active' });
    });

    it('reserves bounded outbox capacity and admits waiting work only after ACK', async () => {
      const dispatch = vi.fn<Parameters<Dispatch>, ReturnType<Dispatch>>(async (_r, _id, admit) =>
        await admit() ? { success: true } : undefined);
      const service = await run(dispatch, { maxPendingDeliveries: 1, maxOccurrencesPerSchedule: 1, maxLiveSchedules: 2 });
      await service.create(owner, hostInput('first', true));
      await service.create(owner, hostInput('second'));
      await expect(service.create(owner, hostInput('third'))).rejects.toThrow(/limit/);
      deliver.mockRejectedValue(new Error('Offline'));
      await tick(interval);
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
      expect(dispatch).toHaveBeenCalledOnce();
      expect((await service.list(owner))[0].state).toBe('active');
      deliver.mockResolvedValue(undefined);
      await service.retryDeliveries();
      await tick(1);
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(3));
      expect(dispatch).toHaveBeenCalledTimes(2);
    });

    it('rolls the bounded cron history without losing future work or replaying an unacknowledged result', async () => {
      const dispatch = vi.fn<Parameters<Dispatch>, ReturnType<Dispatch>>(async (_record, _id, admit) =>
        await admit() ? { success: true } : undefined);
      let service = await run(dispatch, { maxOccurrencesPerSchedule: 1 });
      await service.create(owner, { ...hostInput('recurring', true), backend: 'pi' });
      deliver.mockRejectedValue(new Error('Offline'));
      for (let i = 1; i <= 3; i++) {
        await tick(interval);
        await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(i));
      }
      expect((await read()).pending).toHaveLength(3);
      await service.destroy();
      service = await run(dispatch, { maxOccurrencesPerSchedule: 1 });
      expect(await service.list(owner)).toMatchObject([{ state: 'active', nextDueAt: clock + interval,
        completedOccurrences: [`host-${clock}`] }]);
      deliver.mockResolvedValue(undefined);
      await service.retryDeliveries();
      expect(dispatch).toHaveBeenCalledTimes(3);
      await tick(interval);
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(4));
    });

    it.each([[2, false], [2, true], [6, false], [6, true]] as const)(
      'creates host work independently of a full v%s pre-host catalog (retired schema=%s)', async (version, retired) => {
      const filename = path.join(directory, SCHEDULE_CATALOG_FILE);
      const catalog = { version, ...(version === 6 && { cleanup: [], purged: [] }),
        records: [{ ...input('legacy'), threadId: owner.threadId, openId: owner.openId, generation: owner.generation, backend: 'claude', state: 'interrupted',
        createdAt: now, ...(retired && { faultCleanup: 'pending', cancelRequested: true }),
        recovery: { version: 1, provider: 'fixture', strategy: 'reconstruct', identity: 'fixture', status: 'blocked' } }], pending: [] };
      await fs.writeFile(filename, JSON.stringify(catalog));
      const dispatch = vi.fn(async () => undefined);
      let service = await run(dispatch, { maxRecords: 1 });
      expect(service.legacyCatalogUnavailable).toBe(retired);
      await expect(service.create(owner, { ...hostInput('legacy'), backend: 'codex' })).rejects.toThrow(/already exists/);
      await service.create(owner, { ...hostInput('fresh'), backend: 'codex' });
      await service.destroy();
      service = await run(dispatch, { maxRecords: 1 });
      expect(await service.list(owner)).toContainEqual(expect.objectContaining({ id: 'fresh', state: 'active' }));
      await service.cancel(owner, 'fresh');
      expect(await service.purge(owner, { ids: ['fresh'] })).toMatchObject({ removedIds: ['fresh'] });
      expect(cleanupFor).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      const legacy = JSON.parse(await fs.readFile(filename, 'utf8'));
      expect(legacy.records).toEqual(catalog.records);
      if (retired) expect(legacy).toEqual(catalog);
    });

    it('keeps every missed one-shot receipt when recovery exceeds the outbox limit', async () => {
      const dispatch = vi.fn(async () => undefined);
      let service = await run(dispatch, { maxPendingDeliveries: 1 });
      await service.create(owner, hostInput('first'));
      await service.create(owner, hostInput('second'));
      await service.destroy();
      clock += interval + 1;
      deliver.mockRejectedValue(new Error('Offline'));
      service = await run(dispatch, { maxPendingDeliveries: 1 });
      await service.retryDeliveries();
      expect((await read()).pending).toHaveLength(1);
      await service.destroy();
      deliver.mockResolvedValue(undefined);
      service = await run(dispatch, { maxPendingDeliveries: 1 });
      await service.retryDeliveries();
      await tick(1);
      await vi.waitFor(() => expect(deliver.mock.calls.at(-1)?.[0]).toMatchObject({
        schedule: { id: 'second' }, success: false, error: expect.stringMatching(/missed/),
      }));
      await service.retryDeliveries();
      expect((await service.list(owner)).map(record => record.state)).toEqual(['failed', 'failed']);
      expect(dispatch).not.toHaveBeenCalled();
      expect((await read()).pending).toEqual([]);
    });

    it('purges a host task when the legacy catalog has filled its replay fence limit', async () => {
      const purged = Array.from({ length: 10_000 }, (_, index) => ({
        threadId: owner.threadId, openId: owner.openId, generation: owner.generation, id: `old-${index}`,
      }));
      await fs.writeFile(path.join(directory, SCHEDULE_CATALOG_FILE), JSON.stringify({ version: 3, records: [], pending: [], purged }));
      const service = await run(vi.fn(async () => undefined));
      await service.create(owner, hostInput());
      expect(await service.purge(owner, { ids: ['host-a'] })).toMatchObject({ status: 'complete', removedIds: ['host-a'] });
      expect((await read()).purged).toEqual([{ ...owner, id: 'host-a' }]);
      await expect(service.create(owner, hostInput('old-0'))).rejects.toThrow(/purged/);
    });

    it.each([
      { engine: 'native' }, { engine: undefined }, { nativeId: 'legacy-id' },
      { nextDueAt: null }, { nextDueAt: now + 1 }, { inFlightDueAt: now + interval },
      { completedOccurrences: [`host-${now + interval}`] }, { cancelRequested: true },
      { bindingEpoch: undefined }, { bindingEpoch: null }, { bindingEpoch: '' }, { bindingEpoch: 'x'.repeat(257) },
      { sessionId: undefined },
      { lastOccurrence: { dueAt: now + interval, status: 'unknown' } },
    ])('rejects conflicting host timing receipts %o before arming any work', async fields => {
      const dispatch = vi.fn(async () => undefined);
      const service = await run(dispatch);
      await service.create(owner, hostInput());
      await service.destroy();
      const catalog = await read();
      Object.assign(catalog.records[0], fields);
      await fs.writeFile(path.join(directory, HOST_SCHEDULE_CATALOG_FILE), JSON.stringify(catalog));
      await expect(run(dispatch)).rejects.toThrow(/host|identifier/i);
      expect(vi.getTimerCount()).toBe(0);
      expect(dispatch).not.toHaveBeenCalled();
    });
  });

  it('retains historical refusal evidence when startup compaction fails', async () => {
    const failure = new Error('Original refusal');
    const filename = path.join(directory, SCHEDULE_CATALOG_FILE);
    await fs.writeFile(filename, JSON.stringify({ version: 3, records: [{ ...owner, ...input(), backend: 'claude',
      createdAt: now, state: 'failed', creationRefused: true, error: failure.message }], pending: [], purged: [] }));
    const rename = fs.rename;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      const data = JSON.parse(await fs.readFile(from, 'utf8'));
      if (data.purged?.some((entry: any) => entry.id === 'schedule-a')) throw new Error('Synthetic compaction write failure');
      return rename(from, to);
    });
    const service = make();
    await expect(service.initialize()).rejects.toThrow('compaction write failure');
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

    await service.retryDeliveries(); expect(deliver).toHaveBeenCalledOnce();
    expect((await read()).purged).toEqual([{ ...owner, id: 'legacy' }, { ...owner, id: 'refused' }]);
  });

  it('retains historical refusal evidence at fence capacity', async () => {
    const fences = Array.from({ length: 10000 }, (_, index) => ({ ...owner, id: `purged-${index}` }));
    await fs.writeFile(path.join(directory, SCHEDULE_CATALOG_FILE), JSON.stringify({ version: 3, purged: fences, pending: [],
      records: [{ ...owner, ...input(), backend: 'claude', createdAt: now, state: 'failed', creationRefused: true }] }));
    const service = make(); await service.initialize();
    expect((await service.list(owner))[0]).toMatchObject({ state: 'failed', creationRefused: true });
    expect((await read()).purged).toEqual(fences);
  });

  it('rejects a second catalog writer before reading or overwriting cancellation intent', async () => {
    await fs.writeFile(path.join(directory, SCHEDULE_CATALOG_FILE), JSON.stringify({ version: 2, pending: [],
      records: [{ ...owner, ...input(), backend: 'claude', createdAt: now, state: 'interrupted', cancelRequested: true }] }));
    const first = make(); await first.initialize();
    const before = await fs.readFile(path.join(directory, SCHEDULE_CATALOG_FILE), 'utf8');
    const second = make(); await expect(second.initialize()).rejects.toThrow('Another client');
    expect(await fs.readFile(path.join(directory, SCHEDULE_CATALOG_FILE), 'utf8')).toBe(before);
  });

  it.each([true, false])('retains a shared cancelled occurrence outbox across restart only for its current owner (%s)', async ownerCurrent => {
    await fs.writeFile(path.join(directory, SCHEDULE_CATALOG_FILE), JSON.stringify({ version: 2,
      records: [{ ...owner, ...input('shared'), backend: 'claude', createdAt: now, state: 'cancelled', cancelRequested: true }],
      pending: [{ id: 'shared:done', scheduleId: 'shared', occurrenceId: 'done', success: true, afterCancellation: true, output: 'Saved output' }] }));
    current.mockReturnValue(ownerCurrent);
    const service = make(); await service.initialize(); await service.retryDeliveries(); await service.retryDeliveries();
    expect(deliver).toHaveBeenCalledTimes(ownerCurrent ? 1 : 0);
    if (ownerCurrent) expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ id: 'shared:done', output: 'Saved output', schedule: expect.objectContaining(owner) }));
    expect((await read()).pending).toEqual([]);
  });

  it.each([
    '{broken', '{}', '{"version":999,"records":[],"pending":[]}',
    '{"version":1,"records":{},"pending":[]}', '{"version":1,"records":[],"pending":[],"__proto__":{}}',
    '{"version":1,"records":[],"pending":[{"id":"bad"}]}',
  ])('preserves malformed persisted bytes without overwriting: %s', async bytes => {
    const file = path.join(directory, SCHEDULE_CATALOG_FILE); await fs.writeFile(file, bytes);
    const service = make(); await expect(service.initialize()).rejects.toThrow();
    await expect(service.list(owner)).rejects.toThrow();
    expect(await fs.readFile(file, 'utf8')).toBe(bytes);
    await service.destroy(); expect(await fs.readFile(file, 'utf8')).toBe(bytes);
  });

  it.each(['owner', 'state', 'rule', 'duplicate', 'path', 'outbox', 'oversized', 'backend'])('rejects invalid persisted %s data before recovery writes', async kind => {
    const catalog: any = { version: 2, records: [{ ...owner, ...input(), backend: 'claude', state: 'active', createdAt: now }], pending: [] };
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

});
