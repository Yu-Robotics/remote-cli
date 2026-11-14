import { describe, expect, it, vi } from 'vitest';
import { ClaudeSessionSchedules, SCHEDULE_HOOK, type NativeScheduleAction } from '../../src/scheduling/claude/ClaudeSessionSchedules';

function fixture() {
  const native = new Map<string, string>();
  const calls: string[] = [];
  const sent: any[] = [];
  let serial = 0;
  let malformed = false;
  let errorAfterDelete = false;
  let keepDefinition = false;
  let dropDeleteReceipt = false;
  let current = true;
  let afterDelete = () => {};
  const lease = { isCurrent: () => current };
  const adapter = new ClaudeSessionSchedules({ timezone: 'UTC', timeoutMs: 100,
    send: frame => { sent.push(frame); }, wake: () => {},
    manage: async (prompt, isCurrent) => {
      const action: NativeScheduleAction = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1));
      const id = `management-${++serial}`;
      adapter.foregroundDispatched(id, true);
      await Promise.resolve();
      if (!isCurrent()) { adapter.foregroundEnded(); return { success: false }; }
      calls.push(action.tool);
      adapter.accept({ type: 'control_request', request_id: id, request: { subtype: 'hook_callback', callback_id: SCHEDULE_HOOK,
        tool_use_id: id, input: { hook_event_name: 'PreToolUse', tool_name: action.tool, tool_input: action.input } } });
      expect(sent.at(-1).response.response).toEqual({});
      let content = '';
      let error = false;
      if (action.tool === 'CronCreate') {
        native.set(id, String(action.input.prompt).split('\n')[0]);
        content = `Scheduled recurring job ${id} (every minute). Next run: later. Session-only (not written to disk, dies when Claude exits).`;
      } else if (action.tool === 'CronList') {
        content = malformed ? 'Unverifiable fixture inventory' : native.size
          ? [...native].map(([key, marker]) => `${key} — ${marker} [session-only]`).join('\n') : 'No scheduled jobs.';
      } else {
        if (!keepDefinition) native.delete(String(action.input.id));
        content = `Cancelled job ${action.input.id}.`;
        error = errorAfterDelete;
        afterDelete();
        if (dropDeleteReceipt) { adapter.foregroundEnded(); return { success: false }; }
      }
      adapter.accept({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: error }] } });
      adapter.foregroundEnded();
      return { success: true };
    },
  });
  adapter.accept({ type: 'system', subtype: 'init', tools: ['CronCreate', 'CronList', 'CronDelete'],
    capabilities: ['msg_lifecycle_v1', 'lifecycle_wakeup_source_v1'] });
  const create = async (id: string) => {
    const emit = vi.fn();
    const handle = await adapter.create({ id, cwd: process.cwd(), prompt: 'Synthetic work',
      rule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' } }, emit, () => current);
    return { handle, emit, prompt: `${native.get(handle.nativeId)}\nSynthetic work` };
  };
  const wake = (prompt: string) => {
    adapter.accept({ type: 'command_lifecycle', state: 'started', wakeup_source: 'schedule_wakeup', command_uuid: 'fired-before-delete' });
    adapter.accept({ type: 'control_request', request_id: 'wake', request: { subtype: 'hook_callback', callback_id: SCHEDULE_HOOK,
      input: { hook_event_name: 'UserPromptSubmit', prompt } } });
    return sent.at(-1).response.response;
  };
  return { adapter, native, calls, lease, create, wake,
    malformed: (value: boolean) => { malformed = value; },
    errorAfterDelete: () => { errorAfterDelete = true; },
    keepDefinition: () => { keepDefinition = true; },
    dropDeleteReceipt: () => { dropDeleteReceipt = true; },
    expire: () => { current = false; },
    afterDelete: (fn: () => void) => { afterDelete = fn; },
  };
}

describe('Claude definition removal without claiming native quiescence', () => {
  it('serializes two deletes, verifies inventory and retains already-fired occurrence authority', async () => {
    const f = fixture(); const a = await f.create('one'); const b = await f.create('two');
    f.calls.length = 0;
    const removal = f.adapter.removeFutureDefinitionsForRestart(f.lease);
    expect(f.adapter.removeFutureDefinitionsForRestart(f.lease)).toBe(removal);
    expect(await removal).toEqual({ ownedDefinitionsAbsent: true, quiescence: 'unverified' });
    expect(f.calls).toEqual(['CronList', 'CronDelete', 'CronList', 'CronList', 'CronDelete', 'CronList']);
    expect(f.native.size).toBe(0);
    expect(f.adapter.hasJobs).toBe(true);
    expect(a.handle.releaseForRestart).toBeUndefined();
    expect(a.emit).not.toHaveBeenCalled(); expect(b.emit).not.toHaveBeenCalled();
    expect(f.wake(a.prompt)).toEqual({});
    expect(a.emit).toHaveBeenCalledWith({ type: 'started', occurrenceId: 'fired-before-delete' });
    f.adapter.accept({ type: 'result', uuid: 'fired-result', is_error: false, terminal_reason: 'completed', result: 'Synthetic completed occurrence' });
    f.adapter.accept({ type: 'command_lifecycle', command_uuid: 'fired-before-delete', state: 'completed' });
    expect(a.emit).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'completed', success: true }));
    expect(f.adapter.hasJobs).toBe(true);
    await expect(f.create('new')).rejects.toThrow('unavailable');
    await expect(a.handle.list()).rejects.toThrow('not completion');
    f.adapter.processClosed();
  });

  it('does not interpret absent one-shot/native inventory as an executed occurrence', async () => {
    const f = fixture(); const a = await f.create('one'); f.native.clear();
    f.calls.length = 0;
    await f.adapter.removeFutureDefinitionsForRestart(f.lease);
    expect(f.calls).toEqual(['CronList', 'CronList']); expect(a.emit).not.toHaveBeenCalled();
    expect(f.wake(a.prompt)).toEqual({}); f.adapter.processClosed();
  });

  it('verifies error-after-commit through inventory and permits explicit cancellation afterward', async () => {
    const f = fixture(); const a = await f.create('one'); f.errorAfterDelete();
    await f.adapter.removeFutureDefinitionsForRestart(f.lease);
    expect(f.native.size).toBe(0); expect(a.emit).not.toHaveBeenCalled();
    f.calls.length = 0;
    await a.handle.cancel(); await a.handle.stop();
    expect(f.calls).toEqual([]);
    expect(f.wake(a.prompt)).toHaveProperty('decision', 'block');
    expect(a.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'stopped' }));
    f.adapter.processClosed();
  });

  it('refuses false deletion receipts while retaining ownership and the creation fence', async () => {
    const f = fixture(); const a = await f.create('one'); f.keepDefinition();
    await expect(f.adapter.removeFutureDefinitionsForRestart(f.lease)).rejects.toThrow('unconfirmed');
    expect(f.native.size).toBe(1); expect(a.emit).not.toHaveBeenCalled();
    await expect(f.create('new')).rejects.toThrow('unavailable');
    expect(f.wake(a.prompt)).toEqual({}); f.adapter.processClosed();
  });

  it('keeps a late authorized deletion receipt distinct from explicit cancellation', async () => {
    const f = fixture(); const a = await f.create('one');
    // Terminal/error can precede the tool receipt. The retained authorization
    // must keep its original purpose when that late receipt is consumed.
    f.afterDelete(() => f.adapter.foregroundEnded());
    await f.adapter.removeFutureDefinitionsForRestart(f.lease);
    expect(f.native.size).toBe(0);
    expect(f.wake(a.prompt)).toEqual({});
    expect(a.emit).toHaveBeenCalledWith({ type: 'started', occurrenceId: 'fired-before-delete' });
    f.adapter.processClosed();
  });

  it('does not turn a process close after native deletion into a clean preparation receipt', async () => {
    const f = fixture(); await f.create('one');
    f.afterDelete(() => f.adapter.processClosed());
    await expect(f.adapter.removeFutureDefinitionsForRestart(f.lease)).rejects.toThrow('process exited');
    await expect(f.create('new')).rejects.toThrow('unavailable');
  });

  it('allows same-lease inventory retry but never transfers an unresolved lease', async () => {
    const f = fixture(); await f.create('one'); f.malformed(true);
    await expect(f.adapter.removeFutureDefinitionsForRestart(f.lease)).rejects.toThrow('Unverified');
    await expect(f.adapter.removeFutureDefinitionsForRestart({ isCurrent: () => true })).rejects.toThrow('ownership');
    f.malformed(false); await f.adapter.removeFutureDefinitionsForRestart(f.lease);
    await f.adapter.removeFutureDefinitionsForRestart(f.lease);
    expect(f.calls.filter(x => x === 'CronDelete')).toHaveLength(1); f.adapter.processClosed();
  });

  it('checks retirement again after deletion and never grants an old owner occurrence authority', async () => {
    const f = fixture(); const a = await f.create('one'); await f.create('two');
    f.afterDelete(f.expire);
    await expect(f.adapter.removeFutureDefinitionsForRestart(f.lease)).rejects.toThrow('expired');
    expect(f.calls.filter(x => x === 'CronDelete')).toHaveLength(1);
    expect(f.wake(a.prompt)).toHaveProperty('decision', 'block'); f.adapter.processClosed();
  });

  it('rejects closed, expired and active-mutation admission without changing native state', async () => {
    const f = fixture(); await f.create('one');
    await f.adapter.inToolOperation('active', () => true, async () => {
      await expect(f.adapter.removeFutureDefinitionsForRestart(f.lease)).rejects.toThrow('ownership');
    });
    f.expire(); await expect(f.adapter.removeFutureDefinitionsForRestart(f.lease)).rejects.toThrow('ownership');
    f.adapter.processClosed(); await expect(f.adapter.removeFutureDefinitionsForRestart(f.lease)).rejects.toThrow('ownership');
    expect(f.native.size).toBe(1);
  });

  it('refuses admission while an older authorized native mutation receipt is unresolved', async () => {
    const f = fixture(); const a = await f.create('one'); f.dropDeleteReceipt();
    await a.handle.cancel();
    expect(f.native.size).toBe(0);
    await expect(f.adapter.removeFutureDefinitionsForRestart(f.lease)).rejects.toThrow('ownership');
    f.adapter.processClosed();
  });

  it('skips explicitly cancelled jobs and rejects close between removal admission and mutation', async () => {
    const f = fixture(); const a = await f.create('one'); await a.handle.cancel();
    await f.adapter.removeFutureDefinitionsForRestart(f.lease); expect(f.native.size).toBe(0);
    f.adapter.processClosed();
    const g = fixture(); await g.create('one');
    const removal = g.adapter.removeFutureDefinitionsForRestart(g.lease); g.adapter.processClosed();
    // A closed host may retire every job before the asynchronous loop begins;
    // it must still reject, never report verified absence on a replacement host.
    await expect(removal).rejects.toThrow('expired');
  });
});
