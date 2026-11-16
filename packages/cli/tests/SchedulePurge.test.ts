import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ScheduleService, SCHEDULE_CATALOG_FILE, type ScheduleServiceOptions } from '../src/scheduling/ScheduleService';
import { NativeScheduleNotAdmittedError, type NativeScheduleEvent, type NativeScheduleInput,
  type NativeScheduleHandle, type ScheduleRecord, type ScheduleOwner } from '../src/scheduling/types';

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }));
const owner: ScheduleOwner = { threadId: 'thread', openId: 'owner', generation: 'generation' };
const now = Date.parse('2030-01-01T00:00:00Z');
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
let root: string;
let services: ScheduleService[];
let cleanups: (() => void)[];
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'schedule-purge-')));
  services = []; cleanups = [];
});
afterEach(async () => {
  for (const cleanup of cleanups) cleanup();
  await Promise.allSettled(services.map(service => service.destroy()));
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
async function fixture(options: Partial<ScheduleServiceOptions> = {}, records: ScheduleRecord[] = [], pending: object[] = []) {
  const directory = path.join(root, `catalog-${services.length}`);
  await fs.mkdir(directory);
  if (records.length || pending.length) await fs.writeFile(path.join(directory, SCHEDULE_CATALOG_FILE), JSON.stringify({ version: 2, records, pending }));
  const native = new Set<string>();
  const events = new Map<string, (event: NativeScheduleEvent) => void>();
  const admissions = new Map<string, () => boolean>();
  const handles = new Map<string, NativeScheduleHandle>();
  const cancel = vi.fn(async (id: string) => { native.delete(id); });
  const stop = vi.fn(async (id: string) => { native.delete(id); });
  const create = vi.fn(async (input: NativeScheduleInput, emit: (event: NativeScheduleEvent) => void, admit?: () => boolean) => {
    native.add(input.id); events.set(input.id, emit); admissions.set(input.id, admit!);
    const handle: NativeScheduleHandle = {
      nativeId: `native-${input.id}`, cancellationKeepsRunning: true,
      get nativeDefinitionAbsent() { return !native.has(input.id); },
      list: async () => native.has(input.id), cancel: () => cancel(input.id), stop: () => stop(input.id),
    };
    handles.set(input.id, handle); return handle;
  });
  const deliver = vi.fn(async () => {});
  const service = new ScheduleService({ directory, provider: { create }, deliver, isOwnerCurrent: () => true, now: () => now, ...options });
  services.push(service); await service.initialize();
  return { service, create, cancel, stop, native, events, admissions, handles, deliver, directory,
    read: async () => JSON.parse(await fs.readFile(path.join(directory, SCHEDULE_CATALOG_FILE), 'utf8')) };
}
function input(id: string): NativeScheduleInput {
  return { id, backend: 'claude', cwd: root, prompt: `Synthetic task ${id}`,
    rule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' } };
}
function row(id: string, state: ScheduleRecord['state'] = 'cancelled'): ScheduleRecord {
  return { ...owner, ...input(id), backend: 'claude', createdAt: now, state, nativeId: `native-${id}` };
}
async function reload(f: Awaited<ReturnType<typeof fixture>>) {
  const catalog = await f.read();
  // A fresh directory tests serialized restart state without a sibling test's
  // fork transiently inheriting the original catalog lock descriptor.
  const directory = path.join(root, `reload-${services.length}`); await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, SCHEDULE_CATALOG_FILE), JSON.stringify(catalog));
  const create = vi.fn(async () => { throw new Error('Purged jobs must not be recreated'); });
  const service = new ScheduleService({ directory, provider: { create }, deliver: async () => {}, isOwnerCurrent: () => true, now: () => now });
  services.push(service); await service.initialize(); await service.recover();
  return { service, create };
}

describe('ScheduleService purge', () => {
  it('forgets selected unattributed residue, preserves siblings and fences replay after reload', async () => {
    const failed = { ...row('failed', 'failed'), nativeId: undefined };
    const f = await fixture({}, [failed, row('sibling')]);
    const first = await f.service.purge(owner, { ids: ['failed'] });
    expect(first).toMatchObject({ status: 'partial', nativeCleanupUnresolved: [{ id: 'failed', reason: 'native_absence_unknown' }] });
    expect(await f.service.purge(owner, { ids: ['failed'] })).toMatchObject({ alreadyRemovedIds: ['failed'], nativeCleanupUnresolved: [{ id: 'failed' }] });
    const forgotten = await f.service.purge(owner, { ids: ['failed'], forgetUnresolved: true });
    expect(forgotten).toMatchObject({ status: 'complete', removedIds: [], historyRemovedIds: [], alreadyRemovedIds: ['failed'],
      forgottenCleanupIds: ['failed'], nativeCleanupUnresolved: [], pending: [], errors: [], warning: expect.stringContaining('does not confirm native definition absence') });
    expect(await f.service.listCleanup(owner)).toEqual([]);
    expect((await f.service.list(owner)).map(record => record.id)).toEqual(['sibling']);
    const stored = await f.read();
    expect(stored.purged).toEqual([{ id: 'failed', ...owner }]);
    expect(stored.cleanup ?? []).toEqual([]);
    const restored = await reload(f);
    expect(await restored.service.listCleanup(owner)).toEqual([]);
    expect(await restored.service.purge(owner, { all: true })).toMatchObject({ selectedIds: ['sibling'] });
    await expect(restored.service.create(owner, input('failed'))).rejects.toThrow('purged');
    expect(restored.create).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled(); expect(f.cancel).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled();
  });

  it('forgets an existing unattributed ledger without consulting native verification and is idempotent', async () => {
    const verify = vi.fn(async (_record, _context, accept) => accept({ status: 'unresolved', reason: 'unattributed', detail: 'Missing original attribution' }));
    const f = await fixture({ withPurgeVerification: verify }, [row('legacy')]);
    await f.service.purge(owner, { ids: ['legacy'] });
    const restored = await reload(f);
    const selection = { ids: ['legacy'], forgetUnresolved: true as const };
    const currentOwner = { ...owner, generation: 'after-context-reset' };
    expect(await restored.service.purge(currentOwner, selection)).toMatchObject({ forgottenCleanupIds: ['legacy'], status: 'complete', nativeCleanupUnresolved: [] });
    expect(await restored.service.purge(currentOwner, selection)).toMatchObject({ forgottenCleanupIds: [], alreadyRemovedIds: ['legacy'], nativeCleanupUnresolved: [],
      warning: expect.stringContaining('does not confirm') });
    expect(verify).toHaveBeenCalledOnce();
    expect(restored.create).not.toHaveBeenCalled();
  });

  it('does not forget live history, unknown IDs or another owner\'s cleanup', async () => {
    const f = await fixture();
    await f.service.create(owner, input('active'));
    await f.service.create({ ...owner, openId: 'other-user' }, input('foreign'));
    await f.service.purge({ ...owner, openId: 'other-user' }, { ids: ['foreign'] });
    const result = await f.service.purge(owner, { ids: ['active', 'foreign', 'missing'], forgetUnresolved: true });
    expect(result).toMatchObject({ status: 'partial', forgottenCleanupIds: [], alreadyRemovedIds: [], removedIds: [] });
    expect(result.errors.map(entry => entry.id)).toEqual(['active', 'foreign', 'missing']);
    const active = (await f.service.list(owner))[0];
    expect(active.state).toBe('active'); expect(active.cancelRequested).toBeUndefined();
    expect(f.admissions.get('active')!()).toBe(true);
    expect(f.native.has('active')).toBe(true);
  });

  it('keeps unresolved tracking during pending native mutations and stale owner contexts', async () => {
    let pending = false;
    const f = await fixture({ isNativeMutationPending: () => pending }, [row('legacy')]);
    await f.service.purge(owner, { ids: ['legacy'] });
    pending = true;
    expect(await f.service.purge(owner, { ids: ['legacy'], forgetUnresolved: true })).toMatchObject({ status: 'partial', forgottenCleanupIds: [],
      pending: [{ id: 'legacy', reason: 'operation_pending' }], nativeCleanupUnresolved: [{ id: 'legacy' }] });
    pending = false;
    await expect(f.service.purge(owner, { ids: ['legacy'], forgetUnresolved: true }, () => false)).rejects.toThrow('no longer current');
    expect(await f.service.listCleanup(owner)).toHaveLength(1);
  });

  it('retains cleanup and its replay fence if forgetting cannot be persisted', async () => {
    const f = await fixture({}, [row('legacy')]);
    await f.service.purge(owner, { ids: ['legacy'] });
    const before = await f.read();
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('Synthetic forget persistence failure'));
    expect(await f.service.purge(owner, { ids: ['legacy'], forgetUnresolved: true })).toMatchObject({ status: 'partial', forgottenCleanupIds: [],
      errors: [{ id: 'legacy', error: expect.stringContaining('forget persistence') }], nativeCleanupUnresolved: [{ id: 'legacy' }] });
    expect(await f.read()).toEqual(before);
    vi.restoreAllMocks();
    const restored = await reload(f);
    expect(await restored.service.listCleanup(owner)).toHaveLength(1);
    await expect(restored.service.create(owner, input('legacy'))).rejects.toThrow('purged');
  });

  it('binds forget mode to durable request receipts and rejects broad or malformed forgetting', async () => {
    const f = await fixture({}, [row('legacy')]);
    const selection = { ids: ['legacy'], forgetUnresolved: true as const };
    await f.service.freezePurgeSelection(owner, selection, 'forget', () => true);
    const restored = await reload(f);
    expect(await restored.service.freezePurgeSelection(owner, selection, 'forget', () => true)).toEqual(['legacy']);
    await expect(restored.service.freezePurgeSelection(owner, { ids: ['legacy'] }, 'forget', () => true)).rejects.toThrow('different selection');
    for (const value of [{ all: true, forgetUnresolved: true }, { ids: [], forgetUnresolved: true }, { ids: ['legacy'], forgetUnresolved: false }, { ids: ['legacy'], forgetUnresolved: 'true' }]) {
      await expect(f.service.purge(owner, value as any)).rejects.toThrow('exact schedule IDs');
    }
  });

  it('does not coalesce forgetting into an ordinary purge while native verification is pending', async () => {
    const gate = deferred(); const entered = deferred(); cleanups.push(() => gate.resolve());
    const verify = vi.fn(async (record, _context, accept) => {
      if ('historyRemoved' in record) { entered.resolve(); await gate.promise; }
      return accept({ status: 'unresolved', reason: 'unattributed', detail: 'Synthetic missing attribution' });
    });
    const f = await fixture({ withPurgeVerification: verify }, [row('legacy')]);
    await f.service.purge(owner, { ids: ['legacy'] });
    const normal = f.service.purge(owner, { ids: ['legacy'] }); await entered.promise;
    expect(await f.service.purge(owner, { ids: ['legacy'], forgetUnresolved: true })).toMatchObject({ status: 'partial',
      forgottenCleanupIds: [], removedIds: [], pending: [{ id: 'legacy', reason: 'operation_pending' }], nativeCleanupUnresolved: [{ id: 'legacy' }] });
    expect(await f.service.listCleanup(owner)).toHaveLength(1);
    gate.resolve(); await normal;
    expect(await f.service.purge(owner, { ids: ['legacy'], forgetUnresolved: true })).toMatchObject({ status: 'complete', forgottenCleanupIds: ['legacy'] });
  });

  it('forgets attributed metadata only on explicit request without native calls or sibling route loss', async () => {
    const attributed = (id: string) => ({ ...row(id), recovery: { version: 1 as const, strategy: 'reconstruct' as const,
      provider: 'claude-session-skip-unadmitted-v1', status: 'blocked' as const,
      identity: JSON.stringify({ threadId: owner.threadId, cwd: root, sessionId: `session-${id}`, marker: '11111111-1111-4111-8111-111111111111' }) } });
    const f = await fixture({}, [attributed('first'), attributed('sibling')]);
    await f.service.purge(owner, { all: true });
    expect(f.service.hasCleanupContext(owner.threadId)).toBe(true);
    expect(await f.service.purge(owner, { ids: ['first'], forgetUnresolved: true })).toMatchObject({ forgottenCleanupIds: ['first'], warning: expect.stringContaining('does not confirm') });
    expect(f.service.hasCleanupContext(owner.threadId)).toBe(true);
    expect((await f.service.listCleanup(owner)).map(entry => entry.id)).toEqual(['sibling']);
    expect(await f.service.purge(owner, { ids: ['sibling'], forgetUnresolved: true })).toMatchObject({ forgottenCleanupIds: ['sibling'] });
    expect(f.service.hasCleanupContext(owner.threadId)).toBe(false);
    expect(f.create).not.toHaveBeenCalled(); expect(f.cancel).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled();
    const restored = await reload(f);
    await expect(restored.service.create(owner, input('first'))).rejects.toThrow('purged');
    await expect(restored.service.create(owner, input('sibling'))).rejects.toThrow('purged');
  });

  it('freezes owned selections durably, validates replay arguments and rejects stale request admission', async () => {
    const f = await fixture({}, [row('legacy')]);
    expect(await f.service.freezePurgeSelection(owner, { all: true }, 'request', () => true)).toEqual(['legacy']);
    const restored = await reload(f);
    await expect(restored.service.freezePurgeSelection(owner, { ids: [] }, 'request', () => true)).rejects.toThrow('different selection');
    expect(await restored.service.freezePurgeSelection(owner, { all: true }, 'request', () => true)).toEqual(['legacy']);
    await expect(restored.service.freezePurgeSelection(owner, { all: true }, 'stale', () => false)).rejects.toThrow('context changed');
    expect(await restored.service.freezePurgeSelection({ ...owner, openId: 'another' }, { all: true }, 'request', () => true)).toEqual([]);
  });

  it('does not acknowledge an unpersisted selection or discard full durable request fences', async () => {
    const f = await fixture({}, [row('legacy')]);
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('Synthetic selection persistence failure'));
    await expect(f.service.freezePurgeSelection(owner, { all: true }, 'request', () => true)).rejects.toThrow('selection persistence');
    expect((await f.read()).purgeRequests).toBeUndefined(); vi.restoreAllMocks();
    const directory = path.join(root, 'full-requests'); await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, SCHEDULE_CATALOG_FILE), JSON.stringify({ version: 5, records: [row('legacy')], pending: [], purged: [], cleanup: [],
      purgeRequests: Array.from({ length: 1000 }, (_, i) => ({ key: i.toString(16).padStart(64, '0'), digest: 'a'.repeat(64), ids: [] })) }));
    const full = new ScheduleService({ directory, provider: { create: vi.fn() }, deliver: async () => {}, isOwnerCurrent: () => true });
    services.push(full); await full.initialize();
    await expect(full.freezePurgeSelection(owner, { all: true }, 'new', () => true)).rejects.toThrow('capacity reached');
    expect(await full.list(owner)).toHaveLength(1);
  });

  it.each(['envelope', 'key', 'digest', 'duplicate', 'ids'])('rejects malformed durable purge request %s', async kind => {
    const f = await fixture({}, [row('legacy')]);
    await f.service.freezePurgeSelection(owner, { all: true }, 'request', () => true);
    const stored = await f.read();
    if (kind === 'envelope') stored.purgeRequests = {};
    if (kind === 'key') stored.purgeRequests[0].key = 'bad';
    if (kind === 'digest') stored.purgeRequests[0].digest = 'bad';
    if (kind === 'duplicate') stored.purgeRequests.push(stored.purgeRequests[0]);
    if (kind === 'ids') stored.purgeRequests[0].ids = ['legacy', 'legacy'];
    const directory = path.join(root, 'invalid-requests'); await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, SCHEDULE_CATALOG_FILE), JSON.stringify(stored));
    const invalid = new ScheduleService({ directory, provider: { create: vi.fn() }, deliver: async () => {}, isOwnerCurrent: () => true });
    services.push(invalid); await expect(invalid.initialize()).rejects.toThrow('purge request');
  });

  it.each(['claude', 'dsh'] as const)('erases %s legacy text/output atomically, retains a minimal ledger and fences reload/replay', async backend => {
    const record = { ...row('legacy'), backend };
    const f = await fixture({}, [record], [{ id: 'legacy:result', scheduleId: 'legacy', occurrenceId: 'result',
      success: true, afterCancellation: true, output: 'Synthetic private result' }]);
    expect(await f.service.purge(owner, { all: true })).toMatchObject({ historyRemovedIds: ['legacy'],
      nativeCleanupUnresolved: [{ id: 'legacy' }], pending: [], errors: [] });
    const stored = await f.read();
    expect(stored.version).toBe(5); expect(stored.pending).toEqual([]); expect(stored.records).toEqual([]);
    expect(JSON.stringify(stored)).not.toContain('Synthetic');
    expect(Object.keys(stored.cleanup[0]).sort()).toEqual(['backend', 'cwd', 'generation', 'historyRemoved', 'id', 'nativeId', 'openId', 'reason', 'threadId']);
    const restored = await reload(f);
    expect(await restored.service.list(owner)).toEqual([]); expect(await restored.service.listCleanup(owner)).toHaveLength(1);
    expect(await restored.service.purge(owner, { all: true })).toMatchObject({ selectedIds: ['legacy'], alreadyRemovedIds: ['legacy'], nativeCleanupUnresolved: [{ id: 'legacy' }] });
    await expect(restored.service.create(owner, input('legacy'))).rejects.toThrow('purged');
    expect(await restored.service.listCleanup({ ...owner, generation: 'other' })).toEqual(await restored.service.listCleanup(owner));
    expect(await restored.service.listCleanup({ ...owner, openId: 'other' })).toEqual([]);
    expect(await restored.service.listCleanup({ ...owner, threadId: 'other' })).toEqual([]);
    expect((await restored.service.purge({ ...owner, openId: 'other' }, { ids: ['legacy'] })).errors).toHaveLength(1);
    expect(restored.create).not.toHaveBeenCalled();
  });

  it('retains history and output together if the ledger commit fails', async () => {
    const f = await fixture({}, [row('legacy')], [{ id: 'legacy:result', scheduleId: 'legacy', occurrenceId: 'result',
      success: true, afterCancellation: true, output: 'Synthetic result' }]);
    const rename = fs.rename;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (JSON.parse(await fs.readFile(from, 'utf8')).cleanup?.length) throw new Error('Synthetic ledger write failure');
      return rename(from, to);
    });
    expect((await f.service.purge(owner, { all: true })).errors[0].error).toContain('ledger write');
    expect((await f.read()).records).toHaveLength(1); expect((await f.read()).pending).toHaveLength(1);
    expect((await f.read()).cleanup).toBeUndefined();
  });

  it('does not erase history when the framework scope expires during cancellation-intent persistence', async () => {
    const f = await fixture({}, [row('legacy')]); let current = true;
    const rename = fs.rename;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => { await rename(from, to); current = false; });
    expect((await f.service.purge(owner, { all: true }, () => current)).errors[0].error).toContain('no longer current');
    expect((await f.read()).records).toHaveLength(1); expect((await f.read()).cleanup).toBeUndefined();
  });

  it('keeps an unresolved ledger on stale proof, reason-write failure or absence-write failure', async () => {
    const verify = vi.fn(async (_record, _context, accept) => accept({ status: 'unresolved', reason: 'native_absence_unknown', detail: 'Synthetic uncertainty' }));
    const f = await fixture({ withPurgeVerification: verify }, [row('legacy')]);
    await f.service.purge(owner, { all: true });
    verify.mockImplementationOnce(async (_record, _context, accept) => accept({ status: 'verified', isCurrent: () => false }));
    expect((await f.service.purge(owner, { all: true })).errors[0].error).toContain('expired');
    verify.mockImplementationOnce(async (_record, _context, accept) => accept({ status: 'unresolved', reason: 'predecessor_unknown', detail: 'Synthetic predecessor' }));
    expect((await f.service.purge(owner, { all: true })).nativeCleanupUnresolved[0].reason).toBe('predecessor_unknown');
    verify.mockImplementationOnce(async (_record, _context, accept) => accept({ status: 'verified', isCurrent: () => true }));
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('Synthetic receipt persistence failure'));
    expect((await f.service.purge(owner, { all: true })).errors[0].error).toContain('persistence failure');
    expect((await f.read()).cleanup).toHaveLength(1); expect((await f.read()).records).toEqual([]);
  });

  it('bounds cleanup capacity without dropping prior selectors or replay fences', async () => {
    const f = await fixture({}, [row('legacy')]);
    const directory = path.join(root, 'full-cleanup'); await fs.mkdir(directory);
    const fences = Array.from({ length: 1000 }, (_, i) => ({ id: `old-${i}`, ...owner }));
    await fs.writeFile(path.join(directory, SCHEDULE_CATALOG_FILE), JSON.stringify({ version: 5, records: [row('legacy')], pending: [], purged: fences,
      cleanup: fences.map(fence => ({ ...fence, backend: 'claude', cwd: root, historyRemoved: true, reason: 'unattributed' })) }));
    const service = new ScheduleService({ directory, provider: { create: vi.fn() }, deliver: async () => {}, isOwnerCurrent: () => true });
    services.push(service); await service.initialize();
    expect(await service.purge(owner, { ids: ['legacy'] })).toMatchObject({ removedIds: [], pending: [{ reason: 'fence_capacity' }] });
    expect(await service.list(owner)).toHaveLength(1); expect(await service.listCleanup(owner)).toHaveLength(1000);
    expect(f.create).not.toHaveBeenCalled();
  });

  it('preserves the deletion-only owner incarnation across catalog reload', async () => {
    const record = row('owned-history', 'failed');
    const ownerToken = '22222222-2222-4222-8222-222222222222';
    record.recovery = { version: 1, provider: 'claude-session-skip-unadmitted-v1', strategy: 'reconstruct', status: 'blocked', futureOnly: true,
      identity: JSON.stringify({ sessionId: 'original', threadId: owner.threadId, cwd: root,
        marker: '11111111-1111-4111-8111-111111111111', ownerToken }) };
    const f = await fixture({}, [record]);
    await f.service.purge(owner, { all: true });
    expect((await f.read()).cleanup[0].attribution.ownerToken).toBe(ownerToken);
    const restored = await reload(f);
    expect((await restored.service.listCleanup(owner))[0].id).toBe('owned-history');
    expect((restored.service as any).cleanup.get('owned-history').attribution.ownerToken).toBe(ownerToken);
    expect(restored.create).not.toHaveBeenCalled();
  });

  it.each(['owner', 'duplicate', 'version', 'reason', 'text', 'attribution', 'hash', 'rule', 'marker', 'ownerToken'])('rejects malformed cleanup persistence: %s', async field => {
    const f = await fixture({}, [row('legacy')]); await f.service.purge(owner, { all: true });
    const stored = await f.read(); const item = stored.cleanup[0];
    if (field === 'owner') item.generation = 'foreign';
    if (field === 'duplicate') stored.cleanup.push(item);
    if (field === 'version') stored.version = 4;
    if (field === 'reason') item.reason = 'verified';
    if (field === 'text') item.prompt = 'Forbidden historical text';
    if (['attribution', 'hash', 'rule', 'marker', 'ownerToken'].includes(field)) item.attribution = {
      ...(field === 'ownerToken' && { ownerToken: 'invalid' }),
      sessionId: field === 'attribution' ? '' : 'original', promptHash: field === 'hash' ? 'bad' : 'a'.repeat(64),
      marker: field === 'marker' ? 'bad' : '11111111-1111-4111-8111-111111111111',
      rule: field === 'rule' ? { kind: 'cron', expression: 'bad', timezone: 'UTC' } : input('a').rule };
    const directory = path.join(root, 'invalid-ledger'); await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, SCHEDULE_CATALOG_FILE), JSON.stringify(stored));
    const invalid = new ScheduleService({ directory, provider: { create: vi.fn() }, deliver: async () => {}, isOwnerCurrent: () => true });
    services.push(invalid); await expect(invalid.initialize()).rejects.toThrow();
  });

  it.each([
    { version: 3, state: 'cancelled', cancelRequested: true, cleanupConfirmed: true },
    { version: 4, state: 'interrupted', cancelRequested: true, cleanupConfirmed: true },
    { version: 4, state: 'cancelled', cleanupConfirmed: true },
    { version: 4, state: 'cancelled', cancelRequested: true, cleanupConfirmed: false },
  ])('rejects invalid durable cleanup evidence %#', async ({ version, ...fields }) => {
    const directory = path.join(root, 'invalid-cleanup'); await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, SCHEDULE_CATALOG_FILE), JSON.stringify({ version, records: [{ ...row('invalid'), ...fields }], pending: [], purged: [] }));
    const service = new ScheduleService({ directory, provider: { create: vi.fn() }, deliver: async () => {}, isOwnerCurrent: () => true });
    services.push(service); await expect(service.initialize()).rejects.toThrow('Invalid confirmed cleanup receipt');
  });

  it('does not persist an undefined native absence claim from a retired cancellation handle', async () => {
    const f = await fixture();
    f.create.mockImplementationOnce(async () => ({ nativeId: 'unknown', cancel: async () => {}, stop: async () => {}, list: async () => false }));
    await f.service.create(owner, input('unknown')); await f.service.cancel(owner, 'unknown');
    expect((await f.read()).records[0]).not.toHaveProperty('cleanupConfirmed');
    const restored = await reload(f);
    expect(await restored.service.purge(owner, { all: true })).toMatchObject({ removedIds: ['unknown'], nativeCleanupUnresolved: [{ reason: 'native_absence_unknown' }] });
  });

  it('checks reviewed cleanup retirement separately for each original record', async () => {
    const f = await fixture({}, [row('old-owner', 'interrupted'), row('current-owner', 'interrupted')]);
    const proof = vi.fn((record: Readonly<ScheduleRecord>) => record.id === 'current-owner');
    await f.service.recordReviewedCleanup(owner, ['old-owner', 'current-owner'], true, proof);
    expect(proof).toHaveBeenCalledTimes(2);
    const restored = await reload(f);
    expect((await restored.service.list(owner)).map(record => ({ id: record.id, state: record.state, clean: record.cleanupConfirmed })))
      .toEqual([{ id: 'old-owner', state: 'interrupted', clean: undefined },
        { id: 'current-owner', state: 'cancelled', clean: true }]);
  });

  it('keeps queued results across restart after reviewed cleanup until explicit history purge', async () => {
    const record = row('reviewed', 'interrupted');
    const f = await fixture({ deliver: async () => { throw new Error('Synthetic disconnected result transport'); } }, [record],
      [{ id: 'reviewed:occurrence', scheduleId: 'reviewed', occurrenceId: 'occurrence', success: true, output: 'Synthetic retained result' }]);
    await f.service.recordReviewedCleanup(owner, ['reviewed'], true, () => true);
    expect((await f.read()).pending[0]).toMatchObject({ afterCancellation: true, output: 'Synthetic retained result' });
    const restored = await reload(f);
    expect((await restored.service.list(owner))[0]).toMatchObject({ cleanupConfirmed: true, state: 'cancelled' });
    expect((restored.service as any).pending.size).toBe(1);
    expect(await restored.service.purge(owner, { ids: ['reviewed'] })).toMatchObject({ removedIds: ['reviewed'] });
  });

  it.each(['claude', 'dsh'] as const)('retains a completed %s cancellation receipt across restart before purge', async backend => {
    const f = await fixture();
    await f.service.create(owner, { ...input('retired'), backend });
    await f.service.cancel(owner, 'retired');
    expect((await f.read()).records[0]).toMatchObject({ cleanupConfirmed: true, cancelRequested: true, state: 'cancelled' });
    const restarted = await reload(f);
    expect(await restarted.service.purge(owner, { ids: ['retired'] })).toMatchObject({ removedIds: ['retired'], pending: [], errors: [] });
    expect(restarted.create).not.toHaveBeenCalled();
  });

  it('cancels and removes selected active jobs, preserves siblings and fences replay after reload', async () => {
    const f = await fixture();
    await f.service.create(owner, input('a')); await f.service.create(owner, input('b'));
    const sibling = (await f.service.list(owner)).find(record => record.id === 'b');
    expect(await f.service.purge(owner, { ids: ['a'] })).toMatchObject({ removedIds: ['a'], pending: [], errors: [] });
    expect(f.native).toEqual(new Set(['b'])); expect(f.admissions.get('a')!()).toBe(false);
    expect(await f.service.list(owner)).toEqual([sibling]);
    expect(f.cancel).toHaveBeenCalledTimes(1);
    expect(await f.service.purge(owner, { ids: ['a'] })).toMatchObject({ alreadyRemovedIds: ['a'], errors: [] });
    f.events.get('a')!({ type: 'completed', occurrenceId: 'late', success: true, output: 'Must not return' });
    await f.service.retryDeliveries(); expect(f.deliver).not.toHaveBeenCalled();
    const stored = await f.read();
    expect(stored.purged).toEqual([{ id: 'a', ...owner }]);
    expect(JSON.stringify(stored.purged)).not.toContain('Synthetic');
    const restored = await reload(f);
    expect((await restored.service.list(owner)).map(record => record.id)).toEqual(['b']);
    expect(restored.create).not.toHaveBeenCalled();
    await expect(restored.service.create(owner, input('a'))).rejects.toThrow('purged');
    expect(await restored.service.purge(owner, { ids: ['a'] })).toMatchObject({ alreadyRemovedIds: ['a'] });
  });

  it('purges completed, failed, cancelled and interrupted history only after trusted exact verification', async () => {
    const withPurgeVerification = vi.fn(async (_record, context, accept) => accept({ status: 'verified', isCurrent: context.isCurrent }));
    const records = (['completed', 'failed', 'cancelled', 'interrupted'] as const).map(state => row(state, state));
    const f = await fixture({ withPurgeVerification }, records);
    expect(await f.service.purge(owner, { all: true })).toMatchObject({ removedIds: records.map(r => r.id), pending: [], errors: [] });
    expect(withPurgeVerification).toHaveBeenCalledTimes(4); expect(f.create).not.toHaveBeenCalled();
    expect(await f.service.list(owner)).toEqual([]);
    expect((await f.read()).records).toEqual([]);
    expect((await reload(f)).create).not.toHaveBeenCalled();
  });

  it('does not infer absence from terminal state, missing native IDs or reviewed current-host absence', async () => {
    const records = ['completed', 'failed', 'cancelled', 'interrupted'].map(state => row(state, state as ScheduleRecord['state']));
    delete records[1].nativeId;
    const f = await fixture({}, records);
    await f.service.recordReviewedCleanup(owner, ['interrupted'], true);
    const result = await f.service.purge(owner, { all: true });
    expect(result.removedIds).toEqual(records.map(record => record.id)); expect(result.pending).toEqual([]);
    expect(result.nativeCleanupUnresolved).toHaveLength(4);
    expect(result.nativeCleanupUnresolved.every(item => item.reason === 'native_absence_unknown')).toBe(true);
    expect((await f.read()).records).toEqual([]);
    expect(await f.service.listCleanup(owner)).toHaveLength(4);
  });

  it('returns explicit predecessor/attribution uncertainty and permits a later exact evidence retry', async () => {
    const withPurgeVerification = vi.fn(async (_record, _context, accept) => accept({ status: 'unresolved', reason: 'predecessor_unknown', detail: 'Current session absent; predecessor work unknown.' }));
    const f = await fixture({ withPurgeVerification }, [row('legacy')]);
    expect(await f.service.purge(owner, { ids: ['legacy'] })).toMatchObject({ removedIds: ['legacy'], nativeCleanupUnresolved: [{ id: 'legacy', reason: 'predecessor_unknown' }] });
    withPurgeVerification.mockImplementationOnce(async (_record, _context, accept) => accept({ status: 'verified', isCurrent: () => true }));
    expect(await f.service.purge(owner, { ids: ['legacy'] })).toMatchObject({ alreadyRemovedIds: ['legacy'], nativeCleanupUnresolved: [] });
    expect(f.create).not.toHaveBeenCalled();
  });

  it('removes harmless explicit pre-admission failures across storage reload', async () => {
    const f = await fixture();
    f.create.mockRejectedValueOnce(new NativeScheduleNotAdmittedError('Synthetic refusal before admission'));
    await expect(f.service.create(owner, input('refused'))).rejects.toThrow('refusal');
    const restored = await reload(f);
    expect(await restored.service.purge(owner, { ids: ['refused'] })).toMatchObject({ removedIds: ['refused'], errors: [] });
    expect(restored.create).not.toHaveBeenCalled();
  });

  it('keeps live generation isolation while allowing same-thread deletion receipts across reset', async () => {
    const foreign = { ...owner, generation: 'other-generation' };
    const f = await fixture(); await f.service.create(owner, input('a')); await f.service.create(foreign, input('b'));
    expect(await f.service.purge(owner, { all: true })).toMatchObject({ selectedIds: ['a'], removedIds: ['a'] });
    expect((await f.service.list(foreign)).map(r => r.id)).toEqual(['b']);
    expect((await f.service.purge(owner, { ids: ['missing', 'b'] })).errors).toHaveLength(2);
    expect(await f.service.purge(foreign, { ids: ['a'] })).toMatchObject({ alreadyRemovedIds: ['a'], errors: [] });
    expect((await f.service.purge({ ...owner, openId: 'another-owner' }, { ids: ['a'] })).errors).toHaveLength(1);
    expect((await f.service.purge({ ...owner, threadId: 'another-thread' }, { ids: ['a'] })).errors).toHaveLength(1);
    expect(f.native.has('b')).toBe(true);
  });

  it('persists cancellation before cleanup and retries partial failures without duplicate creation', async () => {
    const f = await fixture(); await f.service.create(owner, input('a')); await f.service.create(owner, input('b'));
    f.cancel.mockImplementation(async id => {
      expect((await f.read()).records.find(record => record.id === id).cancelRequested).toBe(true);
      if (id === 'a') throw new Error('Synthetic native cleanup failure');
      f.native.delete(id);
    });
    const result = await f.service.purge(owner, { all: true });
    expect(result.removedIds).toEqual(['b']); expect(result.errors).toEqual([{ id: 'a', error: 'Synthetic native cleanup failure' }]);
    expect(f.admissions.get('a')!()).toBe(false);
    f.cancel.mockImplementation(async id => { f.native.delete(id); });
    expect(await f.service.purge(owner, { ids: result.selectedIds })).toMatchObject({ removedIds: ['a'], alreadyRemovedIds: ['b'], errors: [] });
    expect(f.create).toHaveBeenCalledTimes(2);
  });

  it('joins concurrent purges and removes no row before native cancellation resolves', async () => {
    const f = await fixture(); await f.service.create(owner, input('a'));
    const gate = deferred(); const entered = deferred(); cleanups.push(() => gate.resolve());
    f.cancel.mockImplementation(async id => { entered.resolve(); await gate.promise; f.native.delete(id); });
    const first = f.service.purge(owner, { ids: ['a'] }); await entered.promise;
    const second = f.service.purge(owner, { ids: ['a'] });
    expect((await f.service.list(owner))[0].cancelRequested).toBe(true);
    gate.resolve();
    expect((await first).removedIds).toEqual(['a']); expect((await second).errors).toEqual([]);
    expect(f.cancel).toHaveBeenCalledTimes(1);
  });

  it('keeps admitted occurrences and pending metadata until retirement, then drops only selected outputs', async () => {
    const f = await fixture(); f.deliver.mockRejectedValue(new Error('Synthetic disconnected delivery'));
    await f.service.create(owner, input('a')); await f.service.create(owner, input('b'));
    f.events.get('a')!({ type: 'started', occurrenceId: 'running' }); await f.service.list(owner);
    expect(await f.service.purge(owner, { ids: ['a'] })).toMatchObject({ pending: [{ reason: 'occurrence_running' }] });
    expect(f.native.has('a')).toBe(false);
    f.events.get('a')!({ type: 'completed', occurrenceId: 'running', success: true, output: 'Synthetic result a' });
    f.events.get('b')!({ type: 'started', occurrenceId: 'sibling' });
    f.events.get('b')!({ type: 'completed', occurrenceId: 'sibling', success: true, output: 'Synthetic result b' });
    await f.service.list(owner); await f.service.retryDeliveries(); await f.service.refresh(owner);
    expect(await f.service.purge(owner, { ids: ['a'] })).toMatchObject({ removedIds: ['a'] });
    expect((await f.read()).pending.map(entry => entry.scheduleId)).toEqual(['b']);
    expect(f.admissions.get('b')!()).toBe(true);
  });

  it('reports in-flight external delivery instead of erasing its unsettled obligation', async () => {
    const gate = deferred(); const entered = deferred(); cleanups.push(() => gate.resolve());
    const f = await fixture({ deliver: async () => { entered.resolve(); await gate.promise; } });
    await f.service.create(owner, input('a'));
    f.events.get('a')!({ type: 'started', occurrenceId: 'delivery' });
    f.events.get('a')!({ type: 'completed', occurrenceId: 'delivery', success: true });
    await entered.promise;
    expect(await f.service.purge(owner, { ids: ['a'] })).toMatchObject({ pending: [{ reason: 'delivery_pending' }] });
    gate.resolve(); await f.service.retryDeliveries();
    expect(await f.service.purge(owner, { ids: ['a'] })).toMatchObject({ removedIds: ['a'] });
  });

  it('does not treat stopping a completed job as proof that its native definition was deleted', async () => {
    const f = await fixture();
    let emit!: (event: NativeScheduleEvent) => void;
    const stop = vi.fn(async () => {});
    f.create.mockImplementationOnce(async (_input, callback) => {
      emit = callback;
      return { nativeId: 'persisted-native', list: async () => true, cancel: vi.fn(async () => {}), stop };
    });
    await f.service.create(owner, { ...input('once'), rule: { kind: 'once', at: new Date(now + 120_000).toISOString() } });
    emit({ type: 'started', occurrenceId: 'once-run' });
    emit({ type: 'completed', occurrenceId: 'once-run', success: true });
    await Promise.allSettled([...(f.service as any).tasks]);
    expect(stop).toHaveBeenCalled();
    expect(await f.service.purge(owner, { ids: ['once'] })).toMatchObject({ removedIds: ['once'], nativeCleanupUnresolved: [{ reason: 'native_absence_unknown' }] });
    expect(await f.service.list(owner)).toEqual([]);
  });

  it('blocks removal during CREATE and consumes its later handle only for cleanup', async () => {
    const gate = deferred<NativeScheduleHandle>(); const entered = deferred();
    const f = await fixture();
    const handle = { nativeId: 'native-a', list: async () => false, cancel: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    cleanups.push(() => gate.resolve(handle));
    f.create.mockImplementationOnce(async () => { entered.resolve(); return gate.promise; });
    const creating = f.service.create(owner, input('a')); await entered.promise;
    expect(await f.service.purge(owner, { ids: ['a'] })).toMatchObject({ pending: [{ reason: 'operation_pending' }] });
    gate.resolve(handle); await creating;
    expect(await f.service.purge(owner, { ids: ['a'] })).toMatchObject({ removedIds: ['a'] });
    expect(f.create).toHaveBeenCalledTimes(1);
  });

  it('rejects stale provider leases or owner changes before catalog removal', async () => {
    let current = true;
    const withPurgeVerification = vi.fn(async (_record, _context, accept) => accept({ status: 'verified', isCurrent: () => false }));
    const f = await fixture({ withPurgeVerification, isOwnerCurrent: () => current }, [row('legacy')]);
    expect((await f.service.purge(owner, { all: true })).errors[0].error).toContain('expired');
    withPurgeVerification.mockImplementationOnce(async (_record, _context, accept) => { current = false; return accept({ status: 'verified', isCurrent: () => true }); });
    expect((await f.service.purge(owner, { all: true })).errors[0].error).toContain('context changed');
    expect((await f.read()).records).toHaveLength(1);
    await expect(f.service.purge(owner, { all: true })).rejects.toThrow('no longer current');
  });

  it('holds the verification lease through persistence and consumes its proof only once', async () => {
    let leased = false;
    const f = await fixture({ withPurgeVerification: async (_record, _context, accept) => {
      leased = true;
      try {
        const evidence = { status: 'verified' as const, isCurrent: () => leased };
        const outcome = await accept(evidence);
        await expect(accept(evidence)).rejects.toThrow('already consumed');
        return outcome;
      } finally { leased = false; }
    } }, [row('legacy')]);
    const rename = fs.rename;
    const persistedUnderLease = vi.fn();
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      const candidate = JSON.parse(await fs.readFile(from, 'utf8'));
      if (candidate.purged?.length) { expect(leased).toBe(true); persistedUnderLease(); }
      return rename(from, to);
    });
    expect(await f.service.purge(owner, { ids: ['legacy'] })).toMatchObject({ removedIds: ['legacy'], errors: [] });
    expect(persistedUnderLease).toHaveBeenCalledOnce(); expect(leased).toBe(false);
  });

  it('reports committed removal separately from a later verification lease cleanup error', async () => {
    const verification = vi.fn(async (_record, _context, accept) => {
      await accept({ status: 'verified', isCurrent: () => true });
      throw new Error('Synthetic verification lease close failure');
    });
    const f = await fixture({ withPurgeVerification: verification }, [row('legacy')]);
    expect(await f.service.purge(owner, { ids: ['legacy'] })).toMatchObject({ removedIds: ['legacy'],
      errors: [{ id: 'legacy', error: 'Synthetic verification lease close failure' }] });
    expect((await f.read()).records).toEqual([]);
    expect(await f.service.purge(owner, { ids: ['legacy'] })).toMatchObject({ alreadyRemovedIds: ['legacy'], errors: [] });
    expect(verification).toHaveBeenCalledOnce();
  });

  it('uses clean handoff proof or matching retained cancellation without recreating jobs', async () => {
    const clean = row('clean', 'interrupted');
    clean.recovery = { version: 1, provider: 'synthetic', strategy: 'reattach', identity: 'synthetic-identity',
      status: 'blocked', handoff: 'clean', nativeDefinitionAbsent: true };
    const retained = structuredClone(clean); retained.id = 'retained'; delete retained.recovery!.handoff; delete retained.recovery!.nativeDefinitionAbsent;
    const cancelRetained = vi.fn(async () => {});
    const f = await fixture({ provider: { create: vi.fn(), recoveryFor: () => ({ provider: 'synthetic', strategy: 'reattach',
      describe: () => 'synthetic-identity', reconcile: vi.fn(), cancelRetained }) } }, [clean, retained]);
    expect(await f.service.purge(owner, { all: true })).toMatchObject({ removedIds: ['clean', 'retained'], errors: [] });
    expect(cancelRetained).toHaveBeenCalledTimes(1);
  });

  it('keeps two unselected active schedules recoverable after purging history and reloading', async () => {
    const records = ['a', 'b'].map(id => ({ ...row(id, 'active'), recovery: {
      version: 1 as const, provider: 'synthetic', strategy: 'reattach' as const, identity: `original-${id}`,
      status: 'eligible' as const, handoff: 'clean' as const, nativeDefinitionAbsent: true as const,
    } }));
    const f = await fixture({ withPurgeVerification: async (_record, _context, accept) => accept({ status: 'verified', isCurrent: () => true }) }, [...records, row('history')]);
    const siblings = (await f.service.list(owner)).filter(record => record.id !== 'history');
    expect(await f.service.purge(owner, { ids: ['history'] })).toMatchObject({ removedIds: ['history'] });
    expect(await f.service.list(owner)).toEqual(siblings);
    const directory = path.join(root, 'recover-two'); await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, SCHEDULE_CATALOG_FILE), JSON.stringify(await f.read()));
    const emitters = new Map<string, (event: NativeScheduleEvent) => void>();
    const reconcile = vi.fn(async (record, _context, emit) => {
      emitters.set(record.id, emit);
      return { nativeId: record.nativeId, list: async () => true, cancel: async () => {}, stop: async () => {} };
    });
    const deliver = vi.fn(async () => {});
    const restored = new ScheduleService({ directory, now: () => now, canRecover: () => true, isOwnerCurrent: () => true, deliver,
      provider: { create: vi.fn(), recoveryFor: () => ({ provider: 'synthetic', strategy: 'reattach', describe: () => '', reconcile }) } });
    services.push(restored); await restored.initialize(); await restored.recover();
    expect((await restored.list(owner)).map(record => [record.id, record.state])).toEqual([['a', 'active'], ['b', 'active']]);
    expect(reconcile.mock.calls.map(([record]) => record.id)).toEqual(['a', 'b']);
    for (const [id, emit] of emitters) { emit({ type: 'started', occurrenceId: id }); emit({ type: 'completed', occurrenceId: id, success: true }); }
    await restored.list(owner); await restored.retryDeliveries();
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('reconciles a retained deletion error-after-commit only through fresh framework proof', async () => {
    const record = row('retained', 'interrupted');
    record.recovery = { version: 1, provider: 'synthetic', strategy: 'reattach', identity: 'original', status: 'blocked' };
    let present = true;
    const cancelRetained = vi.fn(async () => { present = false; throw new Error('Synthetic lost deletion receipt'); });
    const verify = vi.fn(async (_record, _context, accept) => {
      expect(present).toBe(false);
      return accept({ status: 'verified', isCurrent: () => !present });
    });
    const f = await fixture({ withPurgeVerification: verify, provider: { create: vi.fn(), recoveryFor: () => ({
      provider: 'synthetic', strategy: 'reattach', describe: () => 'original', reconcile: vi.fn(), cancelRetained,
    }) } }, [record]);
    expect(await f.service.purge(owner, { ids: ['retained'] })).toMatchObject({ removedIds: ['retained'], errors: [] });
    expect(await f.service.purge(owner, { ids: ['retained'] })).toMatchObject({ alreadyRemovedIds: ['retained'] });
    expect(cancelRetained).toHaveBeenCalledOnce(); expect(verify).toHaveBeenCalledOnce();
  });

  it('retains a row while recovery is in flight and cleans its late handle on retry', async () => {
    const record = row('recover', 'active');
    record.recovery = { version: 1, provider: 'synthetic', strategy: 'reattach', identity: 'original', status: 'eligible' };
    const gate = deferred<NativeScheduleHandle>(); const entered = deferred();
    const handle = { nativeId: 'native-recover', nativeDefinitionAbsent: true, list: async () => false, cancel: async () => {}, stop: vi.fn(async () => {}) };
    cleanups.push(() => gate.resolve(handle));
    const f = await fixture({ canRecover: () => true, provider: { create: vi.fn(), recoveryFor: () => ({
      provider: 'synthetic', strategy: 'reattach', describe: () => 'original',
      reconcile: async () => { entered.resolve(); return gate.promise; },
    }) } }, [record]);
    const recovery = f.service.recover(); await entered.promise;
    expect(await f.service.purge(owner, { ids: ['recover'] })).toMatchObject({ pending: [{ reason: 'operation_pending' }] });
    gate.resolve(handle); await recovery;
    expect(await f.service.purge(owner, { ids: ['recover'] })).toMatchObject({ removedIds: ['recover'] });
    expect(handle.stop).toHaveBeenCalled();
  });

  it('fences events queued while the final atomic removal is being persisted', async () => {
    const f = await fixture(); await f.service.create(owner, input('a'));
    const gate = deferred(); const entered = deferred(); cleanups.push(() => gate.resolve());
    const rename = fs.rename;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      const candidate = JSON.parse(await fs.readFile(from, 'utf8'));
      if (candidate.purged?.length) { entered.resolve(); await gate.promise; }
      return rename(from, to);
    });
    const purging = f.service.purge(owner, { ids: ['a'] }); await entered.promise;
    f.events.get('a')!({ type: 'completed', occurrenceId: 'late', success: true });
    f.events.get('a')!({ type: 'stopped', reason: 'Late close', exitConfirmed: true });
    gate.resolve(); expect((await purging).removedIds).toEqual(['a']);
    await f.service.retryDeliveries(); expect(await f.service.list(owner)).toEqual([]);
    expect((await f.read()).pending).toEqual([]); expect(f.deliver).not.toHaveBeenCalled();
  });

  it('does not accept malformed verifier results or an invalidated native absence receipt', async () => {
    const f = await fixture({ withPurgeVerification: async (_record, _context, accept) => accept({ status: 'unchecked' } as any) }, [row('legacy')]);
    expect((await f.service.purge(owner, { ids: ['legacy'] })).errors[0].error).toContain('Invalid native purge');
    await f.service.create(owner, input('active'));
    await f.service.cancel(owner, 'active');
    f.native.add('active'); // Models an invalidated receipt, not a new provider creation.
    expect(await f.service.purge(owner, { ids: ['active'] })).toMatchObject({ removedIds: [], errors: [{ id: 'active' }] });
    expect((await f.service.list(owner)).map(record => record.id)).toEqual(['legacy', 'active']);
  });

  it('validates persisted fences and refuses to discard a full replay fence set', async () => {
    const f = await fixture({ withPurgeVerification: async (_record, _context, accept) => accept({ status: 'verified', isCurrent: () => true }) }, [row('legacy')]);
    const snapshot = await f.read();
    for (const [index, fences] of [[{ id: 'legacy', ...owner }], [{ id: 'x', ...owner }, { id: 'x', ...owner }], [{ id: '../bad', ...owner }]].entries()) {
      const directory = path.join(root, `invalid-${index}`); await fs.mkdir(directory);
      await fs.writeFile(path.join(directory, SCHEDULE_CATALOG_FILE), JSON.stringify({ ...snapshot, version: 3, purged: fences }));
      const invalid = new ScheduleService({ directory, provider: { create: vi.fn() }, deliver: async () => {}, isOwnerCurrent: () => true });
      services.push(invalid); await expect(invalid.initialize()).rejects.toThrow();
    }
    const directory = path.join(root, 'full'); await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, SCHEDULE_CATALOG_FILE), JSON.stringify({ ...snapshot, version: 3,
      purged: Array.from({ length: 10_000 }, (_, index) => ({ id: `retired-${index}`, ...owner })) }));
    const full = new ScheduleService({ directory, provider: { create: vi.fn() }, deliver: async () => {}, isOwnerCurrent: () => true });
    services.push(full); await full.initialize();
    expect(await full.purge(owner, { all: true })).toMatchObject({ pending: [{ reason: 'fence_capacity' }], removedIds: [] });
    expect(await full.list(owner)).toHaveLength(1);
  });

  it('retains the previous durable catalog when atomic purge persistence fails', async () => {
    const f = await fixture({ withPurgeVerification: async (_record, _context, accept) => accept({ status: 'verified', isCurrent: () => true }) }, [row('a')]);
    const rename = fs.rename;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      const candidate = JSON.parse(await fs.readFile(from, 'utf8'));
      if (candidate.purged?.length) throw new Error('Synthetic atomic rename failure');
      return rename(from, to);
    });
    expect((await f.service.purge(owner, { all: true })).errors[0].error).toContain('rename failure');
    expect((await f.read()).records).toHaveLength(1);
    expect((await f.read()).purged).toBeUndefined();
  });

  it.each([{ ids: ['a', 'a'] }, { ids: ['../invalid'] }, { all: true, ids: [] }, {}])('rejects invalid selection %j', async selection => {
    const f = await fixture(); await expect(f.service.purge(owner, selection as any)).rejects.toThrow();
  });
});
