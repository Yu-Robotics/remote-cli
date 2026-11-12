import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScheduleCardService } from '../src/scheduling/ScheduleCardService';
import type { ScheduleActionMessage } from '../src/types/ScheduleCards';
import type { ScheduleRecord } from '../src/scheduling/types';

function fixture() {
  const owner = { openId: 'owner', threadId: 'thread', generation: 'generation' };
  const records: ScheduleRecord[] = [{ ...owner, id: 'schedule', backend: 'claude', cwd: '.', prompt: 'Synthetic task',
    rule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' }, state: 'active', createdAt: 1 }];
  const dependencies = { current: vi.fn(() => true), threadName: () => 'Original thread',
    records: vi.fn(async () => records), canCancel: vi.fn(() => true), refresh: vi.fn(async () => {}),
    cancel: vi.fn(async () => { records[0].state = 'cancelled'; }),
    exclusive: async <T>(_owner: typeof owner, body: () => Promise<T>) => body() };
  const service = new ScheduleCardService(dependencies);
  const menu = service.open(owner, records);
  const request: ScheduleActionMessage = { type: 'schedule_action', messageId: 'request', openId: owner.openId,
    threadId: owner.threadId, snapshotId: menu.snapshotId, operation: 'cancel', value: menu.entries[0].value, timestamp: 1 };
  return { service, dependencies, menu, records, request, owner };
}
afterEach(() => { vi.useRealTimers(); });

describe('ScheduleCardService', () => {
  it('captures opaque choices and refreshes using the original owner without creating schedules', async () => {
    const f = fixture();
    expect(f.menu.entries[0].value).not.toBe(f.records[0].id);
    f.menu.entries[0].value = 'tampered';
    const result = await f.service.action({ ...f.request, operation: 'refresh', value: undefined });
    expect(result.success).toBe(true);
    expect(f.dependencies.refresh).toHaveBeenCalledWith(f.owner);
    expect(f.dependencies.cancel).not.toHaveBeenCalled();
    expect(result.menu?.snapshotId).not.toBe(f.menu.snapshotId);
  });

  it('deduplicates concurrent and lost-ack retries, rejecting request-ID payload substitution', async () => {
    const f = fixture();
    let release!: () => void;
    f.dependencies.cancel.mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); });
    const first = f.service.action(f.request);
    const second = f.service.action(f.request);
    await vi.waitFor(() => expect(f.dependencies.cancel).toHaveBeenCalledOnce());
    release();
    expect(await second).toEqual(await first);
    expect(await f.service.action(f.request)).toEqual(await first);
    expect((await f.service.action({ ...f.request, operation: 'refresh', value: undefined })).success).toBe(false);
    expect(f.dependencies.cancel).toHaveBeenCalledOnce();
  });

  it.each([{ openId: 'foreign' }, { threadId: 'other' }, { snapshotId: 'unknown' }, { value: 'raw-schedule-id' },
    { messageId: '' }, { operation: 'execute' }, { value: {} }])('rejects malformed or foreign references %j', async change => {
    const f = fixture();
    expect((await f.service.action({ ...f.request, ...change } as any)).success).toBe(false);
    expect(f.dependencies.cancel).not.toHaveBeenCalled();
  });

  it('rejects retired conversation generations and rechecks before an admitted operation starts', async () => {
    const f = fixture();
    const result = f.service.action(f.request);
    f.dependencies.current.mockReturnValue(false);
    expect((await result).success).toBe(false);
    expect(f.dependencies.cancel).not.toHaveBeenCalled();
    expect((await f.service.action({ ...f.request, messageId: 'new' })).success).toBe(false);
  });

  it('returns no false success on cleanup failure and retains retry eligibility', async () => {
    const f = fixture();
    f.dependencies.cancel.mockRejectedValue(new Error('synthetic private provider detail'));
    const result = await f.service.action(f.request);
    expect(result).toMatchObject({ success: false, menu: { entries: [{ canCancel: true }] } });
    expect(result.error).not.toContain('private');
    f.dependencies.cancel.mockResolvedValue();
    expect((await f.service.action({ ...f.request, messageId: 'retry' })).success).toBe(true);
  });

  it('invalidates disconnected controls without leaking a late operation view', async () => {
    const f = fixture();
    let release!: () => void;
    f.dependencies.cancel.mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); });
    const task = f.service.action(f.request);
    await vi.waitFor(() => expect(f.dependencies.cancel).toHaveBeenCalledOnce());
    f.service.invalidate(); release();
    expect((await task).menu).toBeUndefined();
    expect((await f.service.action(f.request)).success).toBe(false);
    f.service.destroy();
  });

  it('bounds snapshots, literal fields and expiration', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.records[0].prompt = '\n'.repeat(1000);
    f.records[0].error = 'e'.repeat(1000);
    f.records[0].rule = { kind: 'once', at: '2030-01-01T00:00:00Z' };
    for (let i = 0; i < 101; i++) f.service.open(f.owner, f.records);
    expect((await f.service.action(f.request)).success).toBe(false);
    const menu = f.service.open(f.owner, f.records);
    expect(menu.entries[0].prompt.length).toBe(240);
    expect(menu.entries[0].error?.length).toBe(240);
    await vi.advanceTimersByTimeAsync(16 * 60_000);
    expect((await f.service.action({ ...f.request, snapshotId: menu.snapshotId })).success).toBe(false);
  });

  it('keeps the operation receipt if fetching its new view fails', async () => {
    const f = fixture();
    f.dependencies.records.mockRejectedValue(new Error('storage'));
    expect(await f.service.action(f.request)).toMatchObject({ success: true });
    expect((await f.service.action(f.request)).menu).toBeUndefined();
  });
});
