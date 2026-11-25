import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ScheduleService, SCHEDULE_CATALOG_FILE, type ScheduleServiceOptions } from '../src/scheduling/ScheduleService';
import type { NativeScheduleInput, ScheduleRecord, ScheduleOwner } from '../src/scheduling/types';

const owner: ScheduleOwner = { threadId: 'thread-a', openId: 'owner-a', generation: 'generation-a' };
const epoch = Date.parse('2030-01-01T00:00:00Z');

describe('schedule interruption without restart restoration', () => {
  let directory: string;
  let services: ScheduleService[];
  let current: boolean;
  let deliver: ReturnType<typeof vi.fn>;
  let cancelRetained: ReturnType<typeof vi.fn>;
  let cleanupFor: ScheduleServiceOptions['cleanupFor'];
  const catalog = async () => JSON.parse(await fs.readFile(path.join(directory, SCHEDULE_CATALOG_FILE), 'utf8'));
  const write = (value: unknown) => fs.writeFile(path.join(directory, SCHEDULE_CATALOG_FILE), JSON.stringify(value));
  const input = (id = 'job-a'): NativeScheduleInput => ({ id, backend: 'claude', cwd: directory, prompt: 'Synthetic reminder',
    rule: { kind: 'cron', expression: '*/5 * * * *', timezone: 'UTC' } });
  const make = (options: Partial<ScheduleServiceOptions> = {}) => {
    const service = new ScheduleService({ directory, cleanupFor, deliver, now: () => epoch, isOwnerCurrent: () => current, ...options });
    services.push(service); return service;
  };
  const row = (id = 'job-a'): ScheduleRecord => ({ ...owner, ...input(id), backend: 'claude', createdAt: epoch,
    state: 'active', nativeId: 'synthetic-native', recovery: { version: 1, provider: 'fixture', strategy: 'reattach',
      status: 'blocked', identity: 'original-session' } });
  const start = async () => {
    await write({ version: 2, records: [row()], pending: [] });
    const service = make(); await service.initialize(); return service;
  };
  const restart = async (service: ScheduleService) => { await service.destroy(); const next = make(); await next.initialize(); return next; };
  beforeEach(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'schedule-interruption-')));
    vi.spyOn(os, 'homedir').mockReturnValue(directory);
    vi.stubEnv('HOME', directory); vi.stubEnv('USERPROFILE', directory);
    services = []; current = true;
    deliver = vi.fn(async () => {}); cancelRetained = vi.fn(async () => {});
    cleanupFor = () => ({ provider: 'fixture', strategy: 'reattach', describe: () => 'original-session', cancelRetained });
  });
  afterEach(async () => {
    await Promise.allSettled(services.map(service => service.destroy()));
    vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(directory, { recursive: true, force: true });
  });

  it.each(['creating', 'active', 'running'] as const)('marks %s interrupted despite legacy positive flags and never reads native inventory', async state => {
    const first = await start(); await first.destroy(); const data = await catalog();
    Object.assign(data.records[0], { state, recovery: { ...data.records[0].recovery, abrupt: true,
      futureOnly: true, handoff: 'clean', nativeDefinitionAbsent: true, status: 'pending' } });
    await write(data);
    const provider = vi.fn(cleanupFor!);
    const next = make({ cleanupFor: provider }); await next.initialize(); await next.retryDeliveries();
    expect((await next.list(owner))[0]).toMatchObject({ state: 'interrupted', recovery: { status: 'blocked', identity: 'original-session' },
      error: expect.stringContaining('not recreated or resumed') });
    expect(cancelRetained).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
    expect(next.canRestartWithoutActiveWork()).toBe(true);
    expect(next.hasActiveSchedules(owner.threadId)).toBe(true);
  });

  it('preserves interrupted diagnostics and unresolved evidence across repeated startup', async () => {
    const first = await start(); await first.destroy(); const data = await catalog();
    Object.assign(data.records[0], { state: 'interrupted', error: 'Owner-reviewed absence; predecessor unknown' });
    await write(data); const next = await restart(await restart(first));
    expect((await next.list(owner))[0].error).toBe(data.records[0].error);
  });

  it.each(['agy', 'dsh'] as const)('keeps %s historical uncertainty out of live quota and management admission', async backend => {
    cleanupFor = undefined;
    await write({ version: 2, records: Array.from({ length: 5 }, (_, i) => ({ ...row(`old-${i}`), backend, recovery: undefined })), pending: [] });
    const next = make({ hostDispatch: vi.fn(), maxLiveSchedules: 5 }); await next.initialize();
    expect(next.hasActiveSchedules()).toBe(false);
    expect(next.canCancel(owner, 'old-0')).toBe(false);
    await expect(next.cancel(owner, 'old-0')).rejects.toThrow('unconfirmed');
    expect((await next.list(owner))[0]).toMatchObject({ state: 'interrupted', cancelRequested: true });
    await next.create({ ...owner, threadId: 'other-thread' }, { ...input('new-job'), engine: 'host', sessionId: 'session', bindingEpoch: 'binding', backend });
    const result = await next.purge(owner, { ids: ['old-0'] });
    expect(result.historyRemovedIds).toEqual(['old-0']);
    expect(await next.listCleanup(owner)).toMatchObject([{ id: 'old-0', reason: 'native_absence_unknown' }]);
    expect(next.hasActiveSchedules(owner.threadId)).toBe(false);
  });

  it.each([1, 2, 3, 4, 5, 6])('preserves version %s history and outbox without executing a job', async version => {
    const first = await start(); await first.destroy(); const data = await catalog(); data.version = version;
    if (version < 6) delete data.purgeRequests;
    if (version < 5) delete data.cleanup;
    if (version < 3) delete data.purged;
    if (version === 1) { delete data.records[0].recovery; delete data.records[0].execution; }
    data.records[0].completedOccurrences = ['finished', 'skipped']; data.records[0].skippedOccurrences = ['skipped'];
    data.pending = [{ id: 'job-a:finished', scheduleId: 'job-a', occurrenceId: 'finished', success: true, output: 'Synthetic completed result' }];
    await write(data); const next = make(); await next.initialize();
    expect((await catalog()).version).toBe(6);
    expect((await next.list(owner))[0]).toMatchObject({ state: 'interrupted', prompt: input().prompt, skippedOccurrences: ['skipped'] });
    expect(next.hasPendingResults()).toBe(true); await next.retryDeliveries();
    expect(deliver).toHaveBeenCalledOnce();
    expect((await catalog()).records[0].completedOccurrences).toEqual(['finished', 'skipped']);
  });

  it('does not call native management or write an exit checkpoint during destruction', async () => {
    const provider = vi.fn(cleanupFor!);
    cleanupFor = provider;
    const first = await start(); const before = await catalog(); await first.destroy();
    expect(await catalog()).toEqual(before);
    expect(provider).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('keeps failed future-only and unattributed interrupted mutations unsettled across repeated restarts', async () => {
    const first = await start(); await first.destroy(); const data = await catalog();
    Object.assign(data.records[0], { state: 'failed', error: 'Uncertain creation' }); data.records[0].recovery.futureOnly = true;
    await write(data); let next = make(); await next.initialize();
    expect(next.hasActiveSchedules(owner.threadId)).toBe(true);
    next = await restart(next); expect((await next.list(owner))[0].state).toBe('failed');
    expect(next.hasActiveSchedules(owner.threadId)).toBe(true);
  });

  it('coalesces exact retained cancellation and preserves its receipt across restart', async () => {
    const next = await restart(await start());
    let finish!: () => void; cancelRetained.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const first = next.cancel(owner, 'job-a'), second = next.cancel(owner, 'job-a');
    await vi.waitFor(() => expect(cancelRetained).toHaveBeenCalledOnce());
    expect((await catalog()).records[0].cancelRequested).toBe(true); finish(); await Promise.all([first, second]);
    const again = await restart(next); expect((await again.list(owner))[0]).toMatchObject({ state: 'cancelled', cleanupConfirmed: true });
    expect(again.hasActiveSchedules(owner.threadId)).toBe(false);
  });

  it('preserves the interruption receipt when supported retained cleanup refuses deletion', async () => {
    const first = await start(); await first.destroy();
    const data = await catalog();
    Object.assign(data.records[0], { state: 'interrupted', error: 'Confirmed original process exit' });
    await write(data);
    cancelRetained.mockRejectedValue(new Error('Synthetic original-session cleanup refusal'));
    const next = make(); await next.initialize();
    await expect(next.cancel(owner, 'job-a')).rejects.toThrow('original-session cleanup refusal');
    expect(cancelRetained).toHaveBeenCalledOnce();
    const again = await restart(next), record = (await again.list(owner))[0];
    expect(record).toMatchObject({ state: 'interrupted', error: 'Confirmed original process exit',
      cancelRequested: true, recovery: { identity: 'original-session', status: 'blocked' } });
    expect(record.cleanupConfirmed).toBeUndefined();
  });

  it.each(['provider', 'identity', 'unsupported', 'owner'])('does not invent cancellation success with %s uncertainty', async variant => {
    const first = await start(); await first.destroy(); const data = await catalog();
    if (variant === 'provider') data.records[0].recovery.provider = 'different';
    if (variant === 'identity') delete data.records[0].recovery;
    if (variant === 'unsupported') cleanupFor = undefined;
    if (variant === 'owner') cancelRetained.mockImplementation(async () => { current = false; });
    await write(data); const next = make(); await next.initialize();
    await expect(next.cancel(owner, 'job-a')).rejects.toThrow();
    expect((await catalog()).records[0]).toMatchObject({ state: 'interrupted', cancelRequested: true });
    expect((await catalog()).records[0].cleanupConfirmed).toBeUndefined();
  });

  it('rejects future catalog versions without rewriting bytes', async () => {
    const first = await start(); await first.destroy(); const data = await catalog(); data.version = 999; await write(data);
    const bytes = await fs.readFile(path.join(directory, SCHEDULE_CATALOG_FILE), 'utf8');
    await expect(make().initialize()).rejects.toThrow();
    expect(await fs.readFile(path.join(directory, SCHEDULE_CATALOG_FILE), 'utf8')).toBe(bytes);
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
