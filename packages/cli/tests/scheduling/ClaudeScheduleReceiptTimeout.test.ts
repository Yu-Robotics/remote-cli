import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeSessionSchedules, SCHEDULE_HOOK } from '../../src/scheduling/claude/ClaudeSessionSchedules';

const adapters: ClaudeSessionSchedules[] = [];
const managementEnds: ((value: { success: boolean }) => void)[] = [];
function fixture() {
  vi.useFakeTimers();
  const send = vi.fn();
  const manage = vi.fn(() => new Promise<{ success: boolean }>(resolve => { managementEnds.push(resolve); }));
  const adapter = new ClaudeSessionSchedules({ send, manage, wake: vi.fn(), timeoutMs: 100 });
  adapters.push(adapter);
  adapter.accept({ type: 'system', subtype: 'init', tools: ['CronCreate', 'CronList', 'CronDelete'],
    capabilities: ['msg_lifecycle_v1', 'lifecycle_wakeup_source_v1'] });
  const hook = (id: string, tool = 'CronList', input = {}) => {
    adapter.accept({ type: 'control_request', request_id: `hook-${id}`, request: {
      subtype: 'hook_callback', callback_id: SCHEDULE_HOOK, tool_use_id: id,
      input: { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input },
    } });
    return send.mock.calls.at(-1)![0].response.response;
  };
  const receipt = (id: string, inventory: unknown = { jobs: [] }, content = 'Synthetic inventory') => {
    adapter.accept({ type: 'user', tool_use_result: inventory, message: { content: [
      { type: 'tool_result', tool_use_id: id, content },
    ] } });
  };
  const review = (id: string, inTurn = true) => adapter.inToolOperation(id, () => true,
    () => adapter.reviewedInventory(() => true), inTurn);
  return { adapter, manage, hook, receipt, review };
}
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.processClosed();
  for (const finish of managementEnds.splice(0)) finish({ success: false });
  vi.useRealTimers();
});

describe('Claude inventory receipt deadlines', () => {
  it('does not exhaust authorization capacity after repeated missing read receipts', async () => {
    const h = fixture();
    for (let index = 0; index < 100; index++) {
      const rejected = expect(h.review(`review-${index}`)).rejects.toThrow('timed out');
      expect(h.hook(`read-${index}`)).toEqual({});
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
    }
    const final = h.review('final');
    const settled = final.then(value => ({ value }), error => ({ error }));
    try {
      expect(h.hook('final-read')).toEqual({});
      h.receipt('final-read');
      expect(await settled).toEqual({ value: [] });
    } finally { h.adapter.processClosed(); await settled; }
  });

  it.each(['queued', 'dispatched', 'in-turn', 'authorized'] as const)('identifies the %s timeout stage without claiming an existing task', async stage => {
    const h = fixture();
    const pending = h.review('review', stage === 'in-turn');
    const observed = pending.catch(error => error as Error);
    if (stage === 'dispatched' || stage === 'authorized') h.adapter.foregroundDispatched('management', true);
    if (stage === 'authorized') expect(h.hook('read')).toEqual({});
    await vi.advanceTimersByTimeAsync(100);
    const error = await observed;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('CronList');
    expect((error as Error).message).toContain({ queued: 'not dispatched', dispatched: 'matching tool invocation',
      'in-turn': 'current turn', authorized: 'authorized tool result' }[stage]);
    expect((error as Error).message).not.toContain('existing task');
    expect((error as Error).message).toContain('No inventory was verified');
    expect(h.adapter.hasJobs).toBe(false);
    expect(h.adapter.cleanupMutationPending).toBe(false);
    expect(h.manage).toHaveBeenCalledTimes(stage === 'in-turn' ? 0 : 1);
  });

  it.each(['timeout', 'terminal'] as const)('ignores a retired read after %s and requires the retry receipt', async reason => {
    const h = fixture();
    const rejected = expect(h.review('old')).rejects.toThrow();
    expect(h.hook('old-read')).toEqual({});
    if (reason === 'timeout') await vi.advanceTimersByTimeAsync(100);
    else h.adapter.foregroundEnded();
    await rejected;
    const pending = h.review('new');
    expect(h.hook('new-read')).toEqual({});
    let complete = false;
    const result = pending.then(value => { complete = true; return value; });
    h.receipt('old-read');
    await vi.advanceTimersByTimeAsync(0);
    expect(complete).toBe(false);
    h.receipt('new-read');
    expect(await result).toEqual([]);
    expect(h.manage).not.toHaveBeenCalled();
  });

  it('accepts a slow correlated inventory before the unchanged deadline', async () => {
    const h = fixture(); const pending = h.review('slow');
    expect(h.hook('slow-read')).toEqual({});
    await vi.advanceTimersByTimeAsync(99);
    h.receipt('slow-read');
    expect(await pending).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles an out-of-turn review and isolates a late management completion from the next read', async () => {
    const h = fixture(); const pending = h.review('slash-review', false);
    h.adapter.foregroundDispatched('management', true);
    expect(h.hook('slash-read')).toEqual({});
    h.receipt('slash-read');
    expect(await pending).toEqual([]);
    h.adapter.foregroundEnded();
    const next = h.review('next-review');
    managementEnds.at(-1)!({ success: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.adapter.action('next-review')).toEqual({ tool: 'CronList', input: {} });
    h.hook('next-read'); h.receipt('next-read');
    expect(await next).toEqual([]);
    expect(h.manage).toHaveBeenCalledTimes(1);
  });

  it('retains late mutation receipts while retiring unrelated read reservations', async () => {
    const h = fixture();
    const create = h.adapter.inToolOperation('create', () => true, () => h.adapter.create({
      id: 'synthetic-job', prompt: 'Synthetic task', cwd: process.cwd(),
      rule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' },
    }, vi.fn(), () => true, 'UTC'));
    const failed = create.catch(error => error);
    const action = h.adapter.action('create')!;
    expect(h.adapter.cleanupMutationPending).toBe(true);
    expect(h.hook('late-create', action.tool, action.input)).toEqual({});
    await vi.advanceTimersByTimeAsync(100);
    const error = await failed;
    expect(error.handle.nativeId).toBe('unconfirmed-synthetic-job');
    expect(h.adapter.cleanupMutationPending).toBe(true);
    const rejected = expect(h.review('expired-read')).rejects.toThrow('timed out');
    h.hook('expired-read'); await vi.advanceTimersByTimeAsync(100); await rejected;
    h.receipt('late-create', undefined,
      'Scheduled recurring job native-created (every minute). Next run: later. Session-only (not written to disk, dies when Claude exits).');
    expect(error.handle.nativeId).toBe('native-created');
    expect(h.adapter.cleanupMutationPending).toBe(false);
    expect(error.handle.nativeDefinitionAbsent).toBe(false);
    expect(h.manage).not.toHaveBeenCalled();
  });

  it('rejects malformed inventory immediately and permits a fresh review', async () => {
    const h = fixture(); const rejected = expect(h.review('bad')).rejects.toThrow('structured native inventory');
    h.hook('bad-read'); h.receipt('bad-read', {}); await rejected;
    expect(vi.getTimerCount()).toBe(0);
    const pending = h.review('retry'); h.hook('retry-read'); h.receipt('retry-read');
    expect(await pending).toEqual([]);
  });
});
