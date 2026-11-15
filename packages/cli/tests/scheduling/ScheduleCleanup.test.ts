import { describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { cleanupRecord, cleanupDetail } from '../../src/scheduling/ScheduleCleanup';
import { verifySchedulePurge } from '../../src/scheduling/SchedulePurgeVerification';
import type { ScheduleRecord } from '../../src/scheduling/types';

function fixture(backend: 'claude' | 'dsh' = 'claude') {
  const cwd = path.join(os.tmpdir(), 'synthetic-cleanup');
  const identity = { sessionId: 'session', threadId: 'thread', cwd, marker: '11111111-1111-4111-8111-111111111111' };
  const record: ScheduleRecord = { id: 'managed', backend, cwd, threadId: 'thread', openId: 'owner', generation: 'generation',
    prompt: 'Synthetic private task text', state: 'interrupted', createdAt: 1, nativeId: 'native',
    rule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' },
    recovery: { version: 1, provider: backend === 'claude' ? 'claude-session-skip-unadmitted-v1' : 'dsh-session-orderly-v1',
      strategy: 'reconstruct', identity: JSON.stringify(identity), status: 'blocked' } };
  const target = { id: 'native', prompt: `[remote-cli:${identity.marker}]\n${record.prompt}`, cron: '* * * * *', recurring: true, durable: false };
  const inventory = vi.fn(async () => [target]);
  const current = vi.fn(() => true);
  const host = { binding: 'host', cwd, sessionId: 'session', current, inventory, retirementConfirmed: vi.fn(() => true),
    remove: vi.fn(async () => { inventory.mockResolvedValue([]); }) };
  const receipt = cleanupRecord(record, 'native_absence_unknown');
  const accept = vi.fn(async (evidence: any) => evidence);
  return { record, receipt, target, host, current, accept, run: () => verifySchedulePurge(receipt, host, current, accept) };
}

describe('deletion-only schedule selectors', () => {
  it.each(['claude', 'dsh'] as const)('retains only operational %s fields and a digest', backend => {
    const f = fixture(backend);
    expect(f.receipt.attribution?.sessionId).toBe('session');
    expect(JSON.stringify(f.receipt)).not.toContain(f.record.prompt);
    expect(f.receipt).not.toHaveProperty('recovery'); expect(f.receipt).not.toHaveProperty('execution');
    expect(cleanupDetail(f.receipt.reason)).toContain('History removed');
  });
  it.each(['missing', 'invalid', 'null', 'foreign', 'provider', 'control'])('does not invent attribution: %s', field => {
    const f = fixture();
    if (field === 'missing') delete f.record.recovery;
    else if (field === 'invalid') f.record.recovery!.identity = '{';
    else if (field === 'null') f.record.recovery!.identity = 'null';
    else if (field === 'provider') f.record.recovery!.provider = 'unknown';
    else {
      const identity = JSON.parse(f.record.recovery!.identity);
      if (field === 'foreign') identity.threadId = 'foreign'; else identity.sessionId = '\n';
      f.record.recovery!.identity = JSON.stringify(identity);
    }
    expect(cleanupRecord(f.record, 'unattributed').attribution).toBeUndefined();
    expect(cleanupDetail('unattributed')).toContain('original session');
  });
  it('does not turn DSH inventory into unproven predecessor retirement', async () => {
    const f = fixture('dsh');
    expect(await f.run()).toMatchObject({ reason: 'predecessor_unknown' });
    expect(f.host.inventory).not.toHaveBeenCalled(); expect(f.host.remove).not.toHaveBeenCalled();
    expect(cleanupDetail('predecessor_unknown')).toContain('predecessor');
  });
  it.each(['attribution', 'nativeId', 'host', 'session', 'cwd'])('leaves unavailable original selectors unresolved: %s', async field => {
    const f = fixture();
    if (field === 'attribution') delete f.receipt.attribution;
    if (field === 'nativeId') delete f.receipt.nativeId;
    if (field === 'session') f.host.sessionId = 'other';
    if (field === 'cwd') f.host.cwd = path.join(f.record.cwd, 'other');
    const result = await verifySchedulePurge(f.receipt, field === 'host' ? undefined : f.host, f.current, f.accept);
    expect(result).toMatchObject({ reason: 'unattributed' }); expect(f.host.inventory).not.toHaveBeenCalled();
  });
  it.each(['id', 'prompt', 'cron', 'recurring', 'durable', 'duplicate'])('never deletes changed or ambiguous definitions: %s', async field => {
    const f = fixture();
    const changed = { ...f.target, [field]: field === 'recurring' || field === 'durable' ? !f.target[field] : 'changed' };
    f.host.inventory.mockResolvedValue(field === 'duplicate' ? [f.target, { ...f.target, id: 'other' }] : [changed] as any);
    expect(await f.run()).toMatchObject({ reason: 'native_absence_unknown' }); expect(f.host.remove).not.toHaveBeenCalled();
  });
  it.each(['before', 'during', 'after-delete'])('rejects stale native context %s', async when => {
    const f = fixture();
    if (when === 'before') f.current.mockReturnValue(false);
    if (when === 'during') f.host.inventory.mockImplementation(async () => { f.current.mockReturnValue(false); return []; });
    if (when === 'after-delete') f.host.remove.mockImplementation(async () => { f.current.mockReturnValue(false); });
    await expect(f.run()).rejects.toThrow('context changed'); expect(f.accept).not.toHaveBeenCalled();
  });
  it.each([false, true])('reconciles deletion receipt failure only when absence is fresh (%s)', async removed => {
    const f = fixture();
    f.host.remove.mockImplementation(async () => {
      if (removed) f.host.inventory.mockResolvedValue([]);
      throw new Error('Synthetic lost receipt');
    });
    expect((await f.run()).status).toBe(removed ? 'verified' : 'unresolved');
  });
  it('does not trust a successful delete response without absence or retirement', async () => {
    const f = fixture(); f.host.remove.mockImplementation(async () => {});
    expect(await f.run()).toMatchObject({ reason: 'native_absence_unknown' });
    f.host.inventory.mockResolvedValue([]); f.host.retirementConfirmed.mockReturnValue(false);
    expect(await f.run()).toMatchObject({ reason: 'predecessor_unknown' });
    f.host.retirementConfirmed.mockReturnValue(true);
    const evidence = await f.run(); expect(evidence.isCurrent()).toBe(true);
    f.host.sessionId = 'other'; expect(evidence.isCurrent()).toBe(false);
  });
  it('does not interpret malformed inventory as an empty session', async () => {
    const f = fixture(); f.host.inventory.mockResolvedValue([{ id: 'bad' }] as any);
    await expect(f.run()).rejects.toThrow('Invalid native'); expect(f.host.remove).not.toHaveBeenCalled();
  });
  it('keeps deletion-only tracking while a native mutation receipt is unsettled', async () => {
    const f = fixture(); Object.assign(f.host, { mutationPending: () => true });
    expect(await f.run()).toMatchObject({ status: 'unresolved', reason: 'operation_pending' });
    expect(f.host.inventory).not.toHaveBeenCalled(); expect(f.host.remove).not.toHaveBeenCalled();
  });
  it('requires reviewed deletion for one-shots missing their original native timezone', async () => {
    const f = fixture();
    f.receipt.attribution!.rule = { kind: 'once', at: '2020-01-02T03:04:00Z' };
    const { recurring: _recurring, ...target } = f.target;
    f.host.inventory.mockResolvedValue([{ ...target, cron: '4 3 2 1 *' }] as any);
    expect(await f.run()).toMatchObject({ reason: 'native_absence_unknown' }); expect(f.host.remove).not.toHaveBeenCalled();
    f.host.inventory.mockResolvedValue([]); expect((await f.run()).status).toBe('verified');
  });
  it.each(['before-delete', 'after-delete'])('retains cleanup on a sibling inventory race %s', async stage => {
    const f = fixture();
    const sibling = { ...f.target, id: 'sibling', prompt: 'Unrelated sibling' };
    if (stage === 'before-delete') f.host.inventory.mockResolvedValueOnce([f.target]).mockResolvedValue([f.target, sibling]);
    else f.host.remove.mockImplementation(async () => { f.host.inventory.mockResolvedValue([sibling]); });
    expect(await f.run()).toMatchObject({ reason: 'native_absence_unknown' });
    expect(f.host.remove).toHaveBeenCalledTimes(stage === 'before-delete' ? 0 : 1);
  });
});
