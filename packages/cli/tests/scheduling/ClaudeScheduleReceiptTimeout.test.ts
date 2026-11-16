import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeSessionSchedules, SCHEDULE_HOOK } from '../../src/scheduling/claude/ClaudeSessionSchedules';

const adapters: ClaudeSessionSchedules[] = [];
const managementEnds: ((value: { success: boolean }) => void)[] = [];
function fixture(timeoutMs = 100) {
  vi.useFakeTimers();
  const send = vi.fn();
  const manage = vi.fn(() => new Promise<{ success: boolean }>(resolve => { managementEnds.push(resolve); }));
  const adapter = new ClaudeSessionSchedules({ send, manage, wake: vi.fn(), timeoutMs });
  adapters.push(adapter);
  adapter.accept({ type: 'system', subtype: 'init', tools: ['CronCreate', 'CronList', 'CronDelete'],
    capabilities: ['msg_lifecycle_v1', 'lifecycle_wakeup_source_v1'] });
  adapter.foregroundDispatched('synthetic-foreground');
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
  const review = (id: string, inTurn = true, current = () => true) => adapter.inToolOperation(id, current,
    () => adapter.reviewedInventory(current), inTurn);
  return { adapter, manage, hook, receipt, review };
}
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.processClosed();
  for (const finish of managementEnds.splice(0)) finish({ success: false });
  vi.useRealTimers();
});

describe('Claude native invocation and receipt deadlines', () => {
  it.each(['CronList', 'CronCreate'] as const)('keeps an exact in-turn %s callable after 63 seconds of model delay', async tool => {
    const h = fixture(60_000);
    const pending = tool === 'CronList' ? h.review('delayed')
      : h.adapter.inToolOperation('delayed', () => true, () => h.adapter.create({
        id: 'synthetic-job', prompt: 'Synthetic task', cwd: process.cwd(),
        rule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' },
      }, vi.fn(), () => true, 'UTC'));
    const settled = vi.fn(); void pending.then(settled, settled);
    const action = h.adapter.action('delayed')!;
    await vi.advanceTimersByTimeAsync(63_000);
    expect(settled).not.toHaveBeenCalled();
    expect(h.adapter.action('other-operation')).toBeUndefined();
    expect(h.adapter.action('delayed')).toEqual(action);
    expect(h.manage).not.toHaveBeenCalled();
    expect(h.hook('wrong-tool', 'CronDelete', { id: 'unrelated-job' })).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny');
    expect(h.hook('wrong-input', action.tool, { ...action.input, unexpected: true })).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny');
    expect(h.hook('native-tool', action.tool, action.input)).toEqual({});
    expect(h.hook('replayed-tool', action.tool, action.input)).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny');
    expect(h.adapter.action('delayed')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(settled).not.toHaveBeenCalled();
    h.receipt('native-tool', { jobs: [] }, tool === 'CronList' ? 'Synthetic inventory'
      : 'Scheduled recurring job native-created (every minute). Next run: later. Session-only (not written to disk, dies when Claude exits).');
    if (tool === 'CronList') expect(await pending).toEqual([]);
    else expect(await pending).toHaveProperty('nativeId', 'native-created');
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['terminal', 'replacement'] as const)('revokes foreground scope synchronously on %s before Promise continuations', async boundary => {
    const h = fixture(); const lease = h.adapter.invocationLease();
    const pending = h.review('stale'); const failed = expect(pending).rejects.toThrow('authorization ended');
    if (boundary === 'terminal') h.adapter.accept({ type: 'command_lifecycle', command_uuid: 'synthetic-foreground', state: 'completed' });
    else h.adapter.foregroundDispatched('replacement');
    expect(lease()).toBe(false);
    expect(h.adapter.action('stale')).toBeUndefined();
    expect(h.hook('stale-list')).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny');
    await failed;
    h.adapter.foregroundDispatched('next');
    const next = h.review('fresh'); h.hook('fresh-list'); h.receipt('fresh-list');
    expect(await next).toEqual([]);
    expect(lease()).toBe(false);
    expect(h.manage).not.toHaveBeenCalled();
  });

  it('starts the result deadline at invocation after a delayed in-turn action', async () => {
    const h = fixture(60_000);
    const rejected = expect(h.review('delayed')).rejects.toThrow('authorized tool result missing');
    await vi.advanceTimersByTimeAsync(63_000);
    expect(h.hook('delayed-read')).toEqual({});
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    const retry = h.review('retry');
    expect(h.hook('retry-read')).toEqual({});
    const settled = vi.fn(); void retry.then(settled, settled);
    h.receipt('delayed-read');
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled();
    h.receipt('retry-read'); expect(await retry).toEqual([]);
  });

  it.each(['terminal', 'abort', 'close', 'owner', 'owner-error'] as const)('disposes an uninvoked current-turn reservation on %s', async reason => {
    const h = fixture(60_000); let current = true, ownerError = false;
    const rejected = expect(h.review('abandoned', true, () => {
      if (ownerError) throw new Error('Synthetic owner lookup failure');
      return current;
    })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(63_000);
    let cleanup: Promise<void> | undefined;
    if (reason === 'terminal') h.adapter.foregroundEnded();
    if (reason === 'abort') cleanup = h.adapter.captureCancellation()(() => true);
    if (reason === 'close') h.adapter.processClosed();
    if (reason === 'owner') { current = false; await vi.advanceTimersByTimeAsync(1000); }
    if (reason === 'owner-error') { ownerError = true; await vi.advanceTimersByTimeAsync(1000); }
    await rejected; await cleanup;
    expect(h.adapter.action('abandoned')).toBeUndefined();
    expect(h.hook('abandoned-read')).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny');
    expect(vi.getTimerCount()).toBe(0);
    expect(h.manage).not.toHaveBeenCalled();
    if (reason !== 'close') {
      h.adapter.foregroundDispatched('retry-foreground');
      const retry = h.review('retry'); expect(h.hook('retry-read')).toEqual({});
      h.receipt('retry-read'); expect(await retry).toEqual([]);
    }
  });

  it('unwinds an aborted operation before its queued management turn is dispatched', async () => {
    const h = fixture(); h.adapter.foregroundDispatched('foreground');
    const rejected = expect(h.review('queued-review', false)).rejects.toThrow('aborted');
    const cleanup = h.adapter.captureCancellation()(() => true);
    await rejected; await cleanup;
    expect(vi.getTimerCount()).toBe(0);
    h.adapter.foregroundDispatched('late-management', true);
    expect(h.hook('late-read')).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny');
  });

  it('keeps a queued management reservation after duplicate foreground completion', async () => {
    const h = fixture(); h.adapter.foregroundDispatched('old-foreground');
    const pending = h.review('queued-review', false);
    const observed = pending.then(value => ({ value }), error => ({ error }));
    h.adapter.foregroundEnded(); h.adapter.foregroundEnded();
    h.adapter.foregroundDispatched('new-management', true);
    expect(h.hook('queued-read')).toEqual({});
    h.receipt('queued-read');
    expect(await observed).toEqual({ value: [] });
    expect(vi.getTimerCount()).toBe(0);
  });

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

  it.each(['queued', 'dispatched', 'authorized'] as const)('identifies the %s timeout stage without claiming an existing task', async stage => {
    const h = fixture();
    const pending = h.review('review', false);
    const observed = pending.catch(error => error as Error);
    if (stage === 'dispatched' || stage === 'authorized') h.adapter.foregroundDispatched('management', true);
    if (stage === 'authorized') expect(h.hook('read')).toEqual({});
    await vi.advanceTimersByTimeAsync(100);
    const error = await observed;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('CronList');
    expect((error as Error).message).toContain({ queued: 'not dispatched', dispatched: 'matching tool invocation',
      authorized: 'authorized tool result' }[stage]);
    expect((error as Error).message).not.toContain('existing task');
    expect((error as Error).message).toContain('No inventory was verified');
    expect(h.adapter.hasJobs).toBe(false);
    expect(h.adapter.cleanupMutationPending).toBe(false);
    expect(h.manage).toHaveBeenCalledTimes(1);
    h.adapter.foregroundDispatched('late-management', true);
    expect(h.hook('late-management-read')).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny');
  });

  it.each(['timeout', 'terminal', 'abort', 'owner'] as const)('ignores a retired read after %s and requires the retry receipt', async reason => {
    const h = fixture(); let current = true;
    const rejected = expect(h.review('old', true, () => current)).rejects.toThrow();
    expect(h.hook('old-read')).toEqual({});
    if (reason === 'timeout') await vi.advanceTimersByTimeAsync(100);
    if (reason === 'terminal') h.adapter.foregroundEnded();
    if (reason === 'abort') await h.adapter.captureCancellation()(() => true);
    if (reason === 'owner') { current = false; h.receipt('old-read'); }
    await rejected;
    h.adapter.foregroundDispatched('new-foreground');
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

  it('accepts a slow correlated inventory before the result deadline', async () => {
    const h = fixture(); const pending = h.review('slow');
    expect(h.hook('slow-read')).toEqual({});
    await vi.advanceTimersByTimeAsync(99);
    h.receipt('slow-read');
    expect(await pending).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives a management invocation its own result budget without an old timer expiring the next operation', async () => {
    const h = fixture(); const pending = h.review('managed', false);
    h.adapter.foregroundDispatched('management', true);
    await vi.advanceTimersByTimeAsync(99);
    expect(h.hook('management-read')).toEqual({});
    await vi.advanceTimersByTimeAsync(99);
    h.receipt('management-read'); expect(await pending).toEqual([]);
    h.adapter.foregroundEnded();
    h.adapter.foregroundDispatched('next-foreground');
    const next = h.review('next'); expect(h.hook('next-read')).toEqual({});
    const settled = vi.fn(); void next.then(settled, settled);
    await vi.advanceTimersByTimeAsync(99);
    expect(settled).not.toHaveBeenCalled();
    h.receipt('next-read'); expect(await next).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles an out-of-turn review and isolates a late management completion from the next read', async () => {
    const h = fixture(); const pending = h.review('slash-review', false);
    h.adapter.foregroundDispatched('management', true);
    expect(h.hook('slash-read')).toEqual({});
    h.receipt('slash-read');
    expect(await pending).toEqual([]);
    h.adapter.foregroundEnded();
    h.adapter.foregroundDispatched('next-foreground');
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

  it('retains an aborted invocation for late mutation ownership and explicit cleanup on the same host', async () => {
    const h = fixture();
    const create = h.adapter.inToolOperation('create', () => true, () => h.adapter.create({
      id: 'synthetic-job', prompt: 'Synthetic task', cwd: process.cwd(),
      rule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' },
    }, vi.fn(), () => true, 'UTC'));
    const failed = create.catch(error => error);
    const action = h.adapter.action('create')!;
    expect(h.hook('late-create', action.tool, action.input)).toEqual({});
    const cleanup = h.adapter.captureCancellation();
    const error = await failed;
    expect(error.handle.nativeId).toBe('unconfirmed-synthetic-job');
    expect(h.adapter.cleanupMutationPending).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    h.receipt('late-create', undefined,
      'Scheduled recurring job native-created (every minute). Next run: later. Session-only (not written to disk, dies when Claude exits).');
    expect(error.handle.nativeId).toBe('native-created');
    expect(error.handle.nativeDefinitionAbsent).toBe(false);
    const cleaned = cleanup(() => true);
    await vi.advanceTimersByTimeAsync(0);
    h.adapter.foregroundDispatched('cleanup-delete', true);
    expect(h.hook('cleanup-delete', 'CronDelete', { id: 'native-created' })).toEqual({});
    h.receipt('cleanup-delete', undefined, 'Cancelled job native-created.');
    h.adapter.foregroundEnded(); await vi.advanceTimersByTimeAsync(0);
    h.adapter.foregroundDispatched('cleanup-list', true);
    expect(h.hook('cleanup-list')).toEqual({});
    h.receipt('cleanup-list', undefined, 'No scheduled jobs.');
    await cleaned; h.adapter.foregroundEnded();
    expect(error.handle.nativeDefinitionAbsent).toBe(true);
    expect(h.adapter.hasJobs).toBe(false);
    expect(h.adapter.cleanupMutationPending).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects malformed inventory immediately and permits a fresh review', async () => {
    const h = fixture(); const rejected = expect(h.review('bad')).rejects.toThrow('structured native inventory');
    h.hook('bad-read'); h.receipt('bad-read', {}); await rejected;
    expect(vi.getTimerCount()).toBe(0);
    const pending = h.review('retry'); h.hook('retry-read'); h.receipt('retry-read');
    expect(await pending).toEqual([]);
  });
});
