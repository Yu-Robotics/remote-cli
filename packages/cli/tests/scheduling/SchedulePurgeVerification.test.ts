import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { verifySchedulePurge } from '../../src/scheduling/SchedulePurgeVerification';
import type { NativeCleanupSession } from '../../src/scheduling/ReviewedNativeCleanup';
import type { SchedulePurgeEvidence } from '../../src/scheduling/ScheduleService';
import type { ScheduleRecord } from '../../src/scheduling/types';

function fixture() {
  const cwd = path.join(os.tmpdir(), 'synthetic-purge-context');
  const identity = { marker: '11111111-1111-4111-8111-111111111111', sessionId: 'original', threadId: 'thread', cwd };
  const record: ScheduleRecord = { id: 'managed', nativeId: 'native', backend: 'claude', cwd, threadId: 'thread',
    openId: 'owner', generation: 'generation', prompt: 'Synthetic task', state: 'interrupted', createdAt: 1,
    rule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' },
    recovery: { version: 1, provider: 'claude-session-skip-unadmitted-v1', strategy: 'reconstruct', status: 'blocked', identity: JSON.stringify(identity) } };
  const inventory = vi.fn(async () => [] as any[]);
  const current = vi.fn(() => true), retirementConfirmed = vi.fn(() => true);
  const host: NativeCleanupSession = { binding: 'lease', sessionId: 'original', cwd, current, retirementConfirmed, inventory, remove: vi.fn() };
  const accept = vi.fn(async (evidence: SchedulePurgeEvidence) => evidence);
  return { record, host, identity, inventory, current, retirementConfirmed, accept,
    run: () => verifySchedulePurge(record, host, current, accept) };
}
describe('framework schedule purge verification', () => {
  it('checks retirement against the original job incarnation on every evidence use', async () => {
    const f = fixture();
    const ownerToken = '22222222-2222-4222-8222-222222222222';
    f.record.recovery!.identity = JSON.stringify({ ...f.identity, ownerToken });
    let currentToken = ownerToken;
    f.host.retirementConfirmed = token => token === currentToken;
    const evidence = await f.run();
    expect(evidence.status).toBe('verified');
    if (evidence.status !== 'verified') throw new Error('Missing exact owner evidence');
    expect(evidence.isCurrent()).toBe(true);
    currentToken = '33333333-3333-4333-8333-333333333333';
    expect(evidence.isCurrent()).toBe(false);
    expect(await f.run()).toMatchObject({ reason: 'predecessor_unknown' });
  });
  it('verifies fresh original-session absence while preserving all siblings', async () => {
    const f = fixture();
    f.inventory.mockResolvedValue([{ id: 'sibling', prompt: 'Unrelated task', cron: '* * * * *', durable: false }]);
    const proof = await f.run(); expect(proof.status).toBe('verified');
    if (proof.status !== 'verified') throw new Error('Missing proof');
    expect(proof.isCurrent()).toBe(true);
    f.retirementConfirmed.mockReturnValue(false); expect(proof.isCurrent()).toBe(false);
    f.retirementConfirmed.mockReturnValue(true); f.current.mockReturnValue(false); expect(proof.isCurrent()).toBe(false);
    expect(f.host.remove).not.toHaveBeenCalled();
  });
  it.each(['recovery', 'nativeId', 'invalid-json', 'null', 'marker', 'session', 'thread', 'cwd', 'provider', 'strategy'])('refuses missing or malformed attribution: %s', async field => {
    const f = fixture();
    if (field === 'recovery') delete f.record.recovery;
    else if (field === 'nativeId') delete f.record.nativeId;
    else if (field === 'invalid-json') f.record.recovery!.identity = '{';
    else if (field === 'null') f.record.recovery!.identity = 'null';
    else if (field === 'provider') f.record.recovery!.provider = 'other';
    else if (field === 'strategy') f.record.recovery!.strategy = 'reattach';
    else f.record.recovery!.identity = JSON.stringify({ ...f.identity,
      [({ session: 'sessionId', thread: 'threadId' } as any)[field] ?? field]: field === 'session' ? '' : 'wrong' });
    expect(await f.run()).toMatchObject({ status: 'unresolved', reason: 'unattributed' });
    expect(f.inventory).not.toHaveBeenCalled();
  });
  it.each(['host', 'session', 'cwd'])('requires the original live binding: %s', async field => {
    const f = fixture();
    if (field === 'session') f.host.sessionId = 'another';
    if (field === 'cwd') f.host.cwd = path.join(f.record.cwd, 'another');
    expect(await verifySchedulePurge(f.record, field === 'host' ? undefined : f.host, f.current, f.accept))
      .toMatchObject({ status: 'unresolved', reason: 'unattributed' });
    expect(f.inventory).not.toHaveBeenCalled();
  });
  it('never treats a DSH current-session list as predecessor proof', async () => {
    const f = fixture(); f.record.backend = 'dsh';
    expect(await f.run()).toMatchObject({ status: 'unresolved', reason: 'predecessor_unknown' });
    expect(f.inventory).not.toHaveBeenCalled();
  });
  it.each(['id', 'marker'])('blocks a still-present or changed definition matched by %s', async field => {
    const f = fixture();
    f.inventory.mockResolvedValue([{ id: field === 'id' ? 'native' : 'changed-id',
      prompt: field === 'marker' ? `[remote-cli:${f.identity.marker}]\nChanged prompt` : 'Changed prompt', cron: '* * * * *' }]);
    expect(await f.run()).toMatchObject({ status: 'unresolved', reason: 'native_absence_unknown' });
    expect(f.host.remove).not.toHaveBeenCalled();
  });
  it.each(['missing', 'running'])('requires framework retirement proof: %s', async kind => {
    const f = fixture();
    if (kind === 'missing') delete f.host.retirementConfirmed;
    else f.retirementConfirmed.mockReturnValue(false);
    expect(await f.run()).toMatchObject({ status: 'unresolved', reason: 'predecessor_unknown' });
    expect(f.inventory).toHaveBeenCalledOnce();
  });
  it.each(['before', 'during'])('rejects context retirement %s inventory', async when => {
    const f = fixture();
    if (when === 'before') f.current.mockReturnValue(false);
    else f.inventory.mockImplementation(async () => { f.current.mockReturnValue(false); return []; });
    await expect(f.run()).rejects.toThrow('context changed'); expect(f.accept).not.toHaveBeenCalled();
  });
  it('does not interpret malformed or failed inventory as absence', async () => {
    const f = fixture(); f.inventory.mockResolvedValue([{ id: 'bad' }]);
    await expect(f.run()).rejects.toThrow('Invalid native');
    f.inventory.mockRejectedValue(new Error('Synthetic receipt timeout'));
    await expect(f.run()).rejects.toThrow('receipt timeout'); expect(f.accept).not.toHaveBeenCalled();
  });
});
