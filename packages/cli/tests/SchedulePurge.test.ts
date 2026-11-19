import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ScheduleService, SCHEDULE_CATALOG_FILE, type ScheduleServiceOptions } from '../src/scheduling/ScheduleService';
import type { HostScheduleInput, NativeScheduleInput, ScheduleRecord, ScheduleOwner } from '../src/scheduling/types';

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
  if (records.length || pending.length) await fs.writeFile(path.join(directory, SCHEDULE_CATALOG_FILE), JSON.stringify({ version: 4, records, pending, purged: [] }));
  const deliver = vi.fn(async () => {});
  const service = new ScheduleService({ directory, hostDispatch: vi.fn(), deliver, isOwnerCurrent: () => true, now: () => now, ...options });
  services.push(service); await service.initialize();
  return { service, deliver, directory,
    read: async () => JSON.parse(await fs.readFile(path.join(directory, SCHEDULE_CATALOG_FILE), 'utf8')) };
}
function input(id: string): NativeScheduleInput {
  return { id, backend: 'claude', cwd: root, prompt: `Synthetic task ${id}`,
    rule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' } };
}
function hostInput(id: string): HostScheduleInput {
  return { ...input(id), engine: 'host', backend: 'claude', sessionId: 'session', bindingEpoch: 'binding' };
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
  const service = new ScheduleService({ directory, hostDispatch: vi.fn(), deliver: async () => {}, isOwnerCurrent: () => true, now: () => now });
  services.push(service); await service.initialize();
  return { service };
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
    await expect(restored.service.create(owner, hostInput('failed'))).rejects.toThrow('purged');

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
    await expect(restored.service.create(owner, hostInput('legacy'))).rejects.toThrow('purged');
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

    const restored = await reload(f);
    await expect(restored.service.create(owner, hostInput('first'))).rejects.toThrow('purged');
    await expect(restored.service.create(owner, hostInput('sibling'))).rejects.toThrow('purged');
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
    expect((await f.read()).purgeRequests).toEqual([]); vi.restoreAllMocks();
    const directory = path.join(root, 'full-requests'); await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, SCHEDULE_CATALOG_FILE), JSON.stringify({ version: 5, records: [row('legacy')], pending: [], purged: [], cleanup: [],
      purgeRequests: Array.from({ length: 1000 }, (_, i) => ({ key: i.toString(16).padStart(64, '0'), digest: 'a'.repeat(64), ids: [] })) }));
    const full = new ScheduleService({ directory, deliver: async () => {}, isOwnerCurrent: () => true });
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
    const invalid = new ScheduleService({ directory, deliver: async () => {}, isOwnerCurrent: () => true });
    services.push(invalid); await expect(invalid.initialize()).rejects.toThrow('purge request');
  });

  it.each(['claude', 'dsh'] as const)('erases %s legacy text/output atomically, retains a minimal ledger and fences reload/replay', async backend => {
    const record = { ...row('legacy'), backend };
    const f = await fixture({}, [record], [{ id: 'legacy:result', scheduleId: 'legacy', occurrenceId: 'result',
      success: true, afterCancellation: true, output: 'Synthetic private result' }]);
    expect(await f.service.purge(owner, { all: true })).toMatchObject({ historyRemovedIds: ['legacy'],
      nativeCleanupUnresolved: [{ id: 'legacy' }], pending: [], errors: [] });
    const stored = await f.read();
    expect(stored.version).toBe(6); expect(stored.pending).toEqual([]); expect(stored.records).toEqual([]);
    expect(JSON.stringify(stored)).not.toContain('Synthetic');
    expect(Object.keys(stored.cleanup[0]).sort()).toEqual(['backend', 'cwd', 'generation', 'historyRemoved', 'id', 'nativeId', 'openId', 'reason', 'threadId']);
    const restored = await reload(f);
    expect(await restored.service.list(owner)).toEqual([]); expect(await restored.service.listCleanup(owner)).toHaveLength(1);
    expect(await restored.service.purge(owner, { all: true })).toMatchObject({ selectedIds: ['legacy'], alreadyRemovedIds: ['legacy'], nativeCleanupUnresolved: [{ id: 'legacy' }] });
    await expect(restored.service.create(owner, hostInput('legacy'))).rejects.toThrow('purged');
    expect(await restored.service.listCleanup({ ...owner, generation: 'other' })).toEqual(await restored.service.listCleanup(owner));
    expect(await restored.service.listCleanup({ ...owner, openId: 'other' })).toEqual([]);
    expect(await restored.service.listCleanup({ ...owner, threadId: 'other' })).toEqual([]);
    expect((await restored.service.purge({ ...owner, openId: 'other' }, { ids: ['legacy'] })).errors).toHaveLength(1);

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
    expect((await f.read()).cleanup).toEqual([]);
  });

  it('does not erase history when the framework scope expires during cancellation-intent persistence', async () => {
    const f = await fixture({}, [row('legacy')]); let current = true;
    const rename = fs.rename;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => { await rename(from, to); current = false; });
    expect((await f.service.purge(owner, { all: true }, () => current)).errors[0].error).toContain('no longer current');
    expect((await f.read()).records).toHaveLength(1); expect((await f.read()).cleanup).toEqual([]);
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
    const service = new ScheduleService({ directory, deliver: async () => {}, isOwnerCurrent: () => true });
    services.push(service); await service.initialize();
    expect(await service.purge(owner, { ids: ['legacy'] })).toMatchObject({ removedIds: [], pending: [{ reason: 'fence_capacity' }] });
    expect(await service.list(owner)).toHaveLength(1); expect(await service.listCleanup(owner)).toHaveLength(1000);

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
    expect(await restored.service.listCleanup(owner)).toMatchObject([
      { id: 'owned-history', attribution: { ownerToken } },
    ]);

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
    const invalid = new ScheduleService({ directory, deliver: async () => {}, isOwnerCurrent: () => true });
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
    const service = new ScheduleService({ directory, deliver: async () => {}, isOwnerCurrent: () => true });
    services.push(service); await expect(service.initialize()).rejects.toThrow('Invalid confirmed cleanup receipt');
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
    expect(restored.service.hasPendingResults(owner.threadId)).toBe(true);
    expect(await restored.service.purge(owner, { ids: ['reviewed'] })).toMatchObject({ removedIds: ['reviewed'] });
    expect(restored.service.hasPendingResults(owner.threadId)).toBe(false);
  });

  it.each(['claude', 'dsh'] as const)('retains a completed %s cancellation receipt across restart before purge', async backend => {
    const f = await fixture({}, [{ ...row('retired'), backend, cancelRequested: true, cleanupConfirmed: true }]);
    expect((await f.read()).records[0]).toMatchObject({ cleanupConfirmed: true, cancelRequested: true, state: 'cancelled' });
    const restarted = await reload(f);
    expect(await restarted.service.purge(owner, { ids: ['retired'] })).toMatchObject({ removedIds: ['retired'], pending: [], errors: [] });

  });

  it('purges completed, failed, cancelled and interrupted history only after trusted exact verification', async () => {
    const withPurgeVerification = vi.fn(async (_record, context, accept) => accept({ status: 'verified', isCurrent: context.isCurrent }));
    const records = (['completed', 'failed', 'cancelled', 'interrupted'] as const).map(state => row(state, state));
    const f = await fixture({ withPurgeVerification }, records);
    expect(await f.service.purge(owner, { all: true })).toMatchObject({ removedIds: records.map(r => r.id), pending: [], errors: [] });
    expect(withPurgeVerification).toHaveBeenCalledTimes(4);
    expect(await f.service.list(owner)).toEqual([]);
    expect((await f.read()).records).toEqual([]);

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

  });

  it('keeps original generation isolation while allowing same-thread deletion receipts across reset', async () => {
    const foreign = { ...owner, generation: 'other-generation' };
    const f = await fixture({}, [row('a'), { ...row('b'), ...foreign }]);
    expect(await f.service.purge(owner, { all: true })).toMatchObject({ selectedIds: ['a'], removedIds: ['a'] });
    expect((await f.service.list(foreign)).map(r => r.id)).toEqual(['b']);
    expect((await f.service.purge(owner, { ids: ['missing', 'b'] })).errors).toHaveLength(2);
    expect(await f.service.purge(foreign, { ids: ['a'] })).toMatchObject({ alreadyRemovedIds: ['a'], errors: [] });
    expect((await f.service.purge({ ...owner, openId: 'another-owner' }, { ids: ['a'] })).errors).toHaveLength(1);
    expect((await f.service.purge({ ...owner, threadId: 'another-thread' }, { ids: ['a'] })).errors).toHaveLength(1);
    expect(await f.service.list(foreign)).toMatchObject([{ id: 'b' }]);
  });

  it('reports in-flight external delivery instead of erasing its unsettled obligation', async () => {
    const gate = deferred(); const entered = deferred(); cleanups.push(() => gate.resolve());
    const f = await fixture({ deliver: async () => { entered.resolve(); await gate.promise; } }, [row('a', 'completed')],
      [{ id: 'a:delivery', scheduleId: 'a', occurrenceId: 'delivery', success: true }]);
    const sending = f.service.retryDeliveries(); await entered.promise;
    expect(await f.service.purge(owner, { ids: ['a'] })).toMatchObject({ pending: [{ reason: 'delivery_pending' }] });
    gate.resolve(); await sending;
    expect(await f.service.purge(owner, { ids: ['a'] })).toMatchObject({ removedIds: ['a'] });
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

  it('ignores legacy clean flags and requires matching retained cancellation without recreation', async () => {
    const clean = row('clean', 'interrupted');
    clean.recovery = { version: 1, provider: 'synthetic', strategy: 'reattach', abrupt: true, identity: 'synthetic-identity',
      status: 'blocked', handoff: 'clean', nativeDefinitionAbsent: true };
    const retained = structuredClone(clean); retained.id = 'retained'; delete retained.recovery!.handoff; delete retained.recovery!.nativeDefinitionAbsent;
    const cancelRetained = vi.fn(async () => {});
    const f = await fixture({ cleanupFor: () => ({ provider: 'synthetic', strategy: 'reattach', abrupt: true,
      describe: () => 'synthetic-identity', reconcile: vi.fn(), cancelRetained }) }, [clean, retained]);
    expect(await f.service.purge(owner, { all: true })).toMatchObject({ removedIds: ['clean', 'retained'], errors: [] });
    expect(cancelRetained).toHaveBeenCalledTimes(2);
  });

  it('keeps unselected interrupted history intact after purging another row and reloading', async () => {
    const records = ['a', 'b'].map(id => ({ ...row(id, 'active'), recovery: {
      version: 1 as const, provider: 'synthetic', strategy: 'reattach', abrupt: true as const, identity: `original-${id}`,
      status: 'eligible' as const, handoff: 'clean' as const, nativeDefinitionAbsent: true as const,
    } }));
    const f = await fixture({ withPurgeVerification: async (_record, _context, accept) => accept({ status: 'verified', isCurrent: () => true }) }, [...records, row('history')]);
    const siblings = (await f.service.list(owner)).filter(record => record.id !== 'history');
    expect(await f.service.purge(owner, { ids: ['history'] })).toMatchObject({ removedIds: ['history'] });
    expect(await f.service.list(owner)).toEqual(siblings);
    const directory = path.join(root, 'recover-two'); await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, SCHEDULE_CATALOG_FILE), JSON.stringify(await f.read()));
    const restored = new ScheduleService({ directory, now: () => now, isOwnerCurrent: () => true,
      deliver: vi.fn() });
    services.push(restored); await restored.initialize();
    expect(await restored.list(owner)).toEqual(siblings);
    expect((await restored.list(owner)).map(record => record.state)).toEqual(['interrupted', 'interrupted']);

  });

  it('reconciles a retained deletion error-after-commit only through fresh framework proof', async () => {
    const record = row('retained', 'interrupted');
    record.recovery = { version: 1, provider: 'synthetic', strategy: 'reattach', abrupt: true, identity: 'original', status: 'blocked' };
    let present = true;
    const cancelRetained = vi.fn(async () => { present = false; throw new Error('Synthetic lost deletion receipt'); });
    const verify = vi.fn(async (_record, _context, accept) => {
      expect(present).toBe(false);
      return accept({ status: 'verified', isCurrent: () => !present });
    });
    const f = await fixture({ withPurgeVerification: verify, cleanupFor: () => ({
      provider: 'synthetic', strategy: 'reattach', abrupt: true, describe: () => 'original', reconcile: vi.fn(), cancelRetained,
    }) }, [record]);
    expect(await f.service.purge(owner, { ids: ['retained'] })).toMatchObject({ removedIds: ['retained'], errors: [] });
    expect(await f.service.purge(owner, { ids: ['retained'] })).toMatchObject({ alreadyRemovedIds: ['retained'] });
    expect(cancelRetained).toHaveBeenCalledOnce(); expect(verify).toHaveBeenCalledOnce();
  });

  it('rejects malformed verifier results before history removal', async () => {
    const f = await fixture({ withPurgeVerification: async (_record, _context, accept) => accept({ status: 'unchecked' } as any) }, [row('legacy')]);
    expect((await f.service.purge(owner, { ids: ['legacy'] })).errors[0].error).toContain('Invalid native purge');
  });

  it('validates persisted fences and refuses to discard a full replay fence set', async () => {
    const f = await fixture({ withPurgeVerification: async (_record, _context, accept) => accept({ status: 'verified', isCurrent: () => true }) }, [row('legacy')]);
    const snapshot = await f.read();
    for (const [index, fences] of [[{ id: 'legacy', ...owner }], [{ id: 'x', ...owner }, { id: 'x', ...owner }], [{ id: '../bad', ...owner }]].entries()) {
      const directory = path.join(root, `invalid-${index}`); await fs.mkdir(directory);
      await fs.writeFile(path.join(directory, SCHEDULE_CATALOG_FILE), JSON.stringify({ ...snapshot, cleanup: undefined, purgeRequests: undefined, version: 3, purged: fences }));
      const invalid = new ScheduleService({ directory, deliver: async () => {}, isOwnerCurrent: () => true });
      services.push(invalid); await expect(invalid.initialize()).rejects.toThrow();
    }
    const directory = path.join(root, 'full'); await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, SCHEDULE_CATALOG_FILE), JSON.stringify({ ...snapshot, cleanup: undefined, purgeRequests: undefined, version: 3,
      purged: Array.from({ length: 10_000 }, (_, index) => ({ id: `retired-${index}`, ...owner })) }));
    const full = new ScheduleService({ directory, deliver: async () => {}, isOwnerCurrent: () => true });
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
    expect((await f.read()).purged).toEqual([]);
  });

  it.each([{ ids: ['a', 'a'] }, { ids: ['../invalid'] }, { all: true, ids: [] }, {}])('rejects invalid selection %j', async selection => {
    const f = await fixture(); await expect(f.service.purge(owner, selection as any)).rejects.toThrow();
  });
});
