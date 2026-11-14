import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeSessionSchedules, SCHEDULE_HOOK, type NativeScheduleAction } from '../../src/scheduling/claude/ClaudeSessionSchedules';
import { NativeScheduleCleanupError, type NativeScheduleEvent, type NativeScheduleInput } from '../../src/scheduling/types';

const input = (id = 'job-one'): NativeScheduleInput => ({ id, prompt: 'Use this conversation to report progress.', cwd: process.cwd(),
  rule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' } });
const initialized = { type: 'system', subtype: 'init', tools: ['CronCreate', 'CronList', 'CronDelete'],
  capabilities: ['msg_lifecycle_v1', 'lifecycle_wakeup_source_v1'] };
function harness() {
  const send = vi.fn(); const manage = vi.fn(async () => ({ success: true })); const wake = vi.fn();
  const adapter = new ClaudeSessionSchedules({ send, manage, wake, timezone: 'UTC', timeoutMs: 100 });
  adapter.accept(initialized);
  const hook = (tool: string, value: unknown, id = 'tool-one') => {
    adapter.accept({ type: 'control_request', request_id: `hook-${id}`, request: { subtype: 'hook_callback', callback_id: SCHEDULE_HOOK,
      tool_use_id: id, input: { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: value } } });
    return send.mock.calls.at(-1)![0].response.response;
  };
  const receipt = (text: string, toolId = 'tool-one', is_error = false) => adapter.accept({ type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: toolId, content: text, is_error },
  ] } });
  const created = (id = 'native-one', recurring = true) => `Scheduled ${recurring ? 'recurring job' : 'one-shot task'} ${id} (every minute). Next run: later. Session-only (not written to disk, dies when Claude exits).`;
  const occurrence = (prompt: string, id = 'occurrence-one', hookFirst = false) => {
    const submit = () => adapter.accept({ type: 'control_request', request_id: 'submit', request: { subtype: 'hook_callback', callback_id: SCHEDULE_HOOK,
      input: { hook_event_name: 'UserPromptSubmit', source: 'schedule_wakeup', prompt } } });
    if (hookFirst) submit();
    adapter.accept({ type: 'command_lifecycle', state: 'started', wakeup_source: 'schedule_wakeup', command_uuid: id });
    if (!hookFirst) submit();
    return send.mock.calls.at(-1)![0].response.response;
  };
  const complete = (id = 'occurrence-one', output = 'Shared conversation result') => {
    adapter.accept({ type: 'result', uuid: `result-${id}`, is_error: false, terminal_reason: 'completed', result: output });
    adapter.accept({ type: 'command_lifecycle', command_uuid: id, state: 'completed' });
  };
  async function create(id = 'job-one', nativeId = 'native-one', onEvent = vi.fn(), rule = input().rule) {
    const promise = adapter.inToolOperation(`operation-${id}`, () => true, () => adapter.create({ ...input(id), rule }, onEvent));
    const action = adapter.action(`operation-${id}`)!;
    expect(action.tool).toBe('CronCreate');
    expect(hook(action.tool, action.input, `tool-${id}`)).toEqual({});
    receipt(created(nativeId, rule.kind === 'cron'), `tool-${id}`);
    return { handle: await promise, action, onEvent };
  }
  return { adapter, send, manage, wake, hook, receipt, created, occurrence, complete, create };
}
afterEach(() => vi.useRealTimers());

describe('Claude foreground native schedule protocol', () => {
  it.each(['cancelled', 'discarded', 'refused'])('does not turn a %s occurrence into success from a successful result', async terminal => {
    for (const resultFirst of [true, false]) {
      const h = harness(); const job = await h.create();
      expect(h.occurrence(String(job.action.input.prompt))).toEqual({});
      const result = { type: 'result', uuid: 'synthetic-result', is_error: false,
        terminal_reason: 'completed', result: 'A successful-looking native response' };
      if (resultFirst) h.adapter.accept(result);
      h.adapter.accept({ type: 'command_lifecycle', command_uuid: 'occurrence-one', state: terminal });
      if (!resultFirst) {
        // A conflicting late terminal cannot erase an observed failed terminal.
        h.adapter.accept({ type: 'command_lifecycle', command_uuid: 'occurrence-one', state: 'completed' });
        h.adapter.accept(result);
      }
      expect(job.onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'completed', success: false }));
      expect(job.onEvent.mock.calls.filter(([event]) => event.type === 'completed')).toHaveLength(1);
      expect(h.adapter.busy).toBe(false);
      h.adapter.processClosed();
    }
  });

  it('returns an exact action without a nested model turn and waits for its matching native receipt', async () => {
    const h = harness(); let done = false;
    const pending = h.adapter.inToolOperation('operation', () => true, () => h.adapter.create(input(), vi.fn())).then(handle => { done = true; return handle; });
    const action = h.adapter.action('operation')!;
    expect(h.manage).not.toHaveBeenCalled();
    expect(action.input).toMatchObject({ durable: false, recurring: true, cron: '* * * * *' });
    expect(h.hook(action.tool, { ...action.input, prompt: 'changed' })).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny');
    h.receipt(h.created(), 'foreign-tool');
    await Promise.resolve(); expect(done).toBe(false);
    expect(h.hook(action.tool, action.input)).toEqual({});
    expect(h.hook(action.tool, action.input, 'replayed-tool')).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny');
    h.receipt(h.created());
    const handle = await pending;
    expect(handle.nativeId).toBe('native-one');
    expect(handle.releaseForRestart).toBeUndefined();
    expect(h.adapter.action('operation')).toBeUndefined();
    h.adapter.processClosed();
  });

  it('fences stale scopes and the one-shot deadline immediately before tool authorization', async () => {
    vi.useFakeTimers(); const h = harness(); let current = true;
    const at = Math.ceil((Date.now() + 60_000) / 60_000) * 60_000;
    const pending = h.adapter.inToolOperation('operation', () => current,
      () => h.adapter.create({ ...input(), rule: { kind: 'once', at: new Date(at).toISOString() } }, vi.fn()));
    const rejected = expect(pending).rejects.toThrow('ended');
    const action = h.adapter.action('operation')!;
    current = false;
    expect(h.hook(action.tool, action.input)).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny');
    current = true; vi.setSystemTime(at);
    expect(h.hook(action.tool, action.input)).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny');
    h.adapter.foregroundEnded(); await rejected;
  });

  it('rejects one-shot clock rollback ambiguity rather than selecting an earlier native wall minute', async () => {
    vi.useFakeTimers(); vi.setSystemTime(Date.parse('2030-11-03T04:00:00Z'));
    const h = harness();
    await expect(h.adapter.create({ ...input(), rule: { kind: 'once', at: '2030-11-03T06:30:00Z' } },
      vi.fn(), () => true, 'America/New_York')).rejects.toThrow('clock rollback');
    expect(h.manage).not.toHaveBeenCalled(); h.adapter.processClosed();
  });

  it('tracks multiple jobs and repeated native turns while passing later user conversation through unchanged', async () => {
    const h = harness(); const a = await h.create(); const b = await h.create('job-two', 'native-two');
    expect(h.adapter.accept({ type: 'assistant', message: { content: [{ type: 'text', text: 'Later user conversation' }] } })).toBe(false);
    h.occurrence(String(a.action.input.prompt));
    expect(h.adapter.accept({ type: 'assistant', message: { content: [{ type: 'text', text: 'Scheduled output' }] } })).toBe(true);
    h.complete();
    h.occurrence(String(b.action.input.prompt), 'occurrence-two', true); h.complete('occurrence-two');
    h.occurrence(String(a.action.input.prompt), 'occurrence-three'); h.complete('occurrence-three', 'Future chat is visible natively');
    expect(a.onEvent.mock.calls.map(([event]) => event.type)).toEqual(['started', 'completed', 'started', 'completed']);
    expect(b.onEvent.mock.calls.map(([event]) => event.type)).toEqual(['started', 'completed']);
    expect(h.manage).not.toHaveBeenCalled(); expect(h.wake).toHaveBeenCalledTimes(3);
    h.adapter.processClosed();
  });

  it('rejects missed notices and unknown markers rather than attributing them to a job', async () => {
    const h = harness(); const job = await h.create();
    expect(h.occurrence('A missed task notice')).toHaveProperty('decision', 'block');
    h.complete(); expect(job.onEvent).not.toHaveBeenCalled();
    h.adapter.processClosed();
  });

  it('blocks a resumed unowned wake even when native reports a successful terminal', () => {
    // Observed on 2.1.311: resume reconstructs memory cron definitions, and a
    // blocked UserPromptSubmit can still end with a successful native result.
    // Neither receipt authorizes adopting the job or delivering its output.
    const h = harness();
    h.adapter.accept({ type: 'command_lifecycle', state: 'started',
      wakeup_source: 'schedule_wakeup', command_uuid: 'resumed-occurrence' });
    h.adapter.accept({ type: 'control_request', request_id: 'resumed-hook', request: {
      subtype: 'hook_callback', callback_id: SCHEDULE_HOOK,
      input: { hook_event_name: 'UserPromptSubmit', prompt: '[remote-cli:synthetic-old-owner]\nSynthetic reminder' },
    } });
    expect(h.send.mock.calls.at(-1)![0].response.response).toHaveProperty('decision', 'block');
    expect(h.adapter.hasJobs).toBe(false);
    expect(h.adapter.busy).toBe(true);
    expect(h.adapter.accept({ type: 'result', uuid: 'resumed-result', is_error: false,
      terminal_reason: 'completed', result: 'Synthetic hook-block terminal' })).toBe(true);
    expect(h.adapter.busy).toBe(true);
    h.adapter.accept({ type: 'command_lifecycle', command_uuid: 'resumed-occurrence', state: 'completed' });
    expect(h.adapter.busy).toBe(false);
    expect(h.manage).not.toHaveBeenCalled();
    expect(h.adapter.hasJobs).toBe(false);
    expect(h.wake).toHaveBeenCalledOnce();
    h.adapter.processClosed();
  });

  it('joins native batched wakeups using exact prompts when the compiled hook omits source', async () => {
    const h = harness(); const a = await h.create(); const b = await h.create('job-two', 'native-two');
    for (const id of ['batch-a', 'batch-b']) h.adapter.accept({ type: 'command_lifecycle',
      state: 'started', wakeup_source: 'schedule_wakeup', command_uuid: id });
    h.adapter.accept({ type: 'control_request', request_id: 'batch-hook', request: {
      subtype: 'hook_callback', callback_id: SCHEDULE_HOOK, input: { hook_event_name: 'UserPromptSubmit',
        prompt: `${a.action.input.prompt}\n${b.action.input.prompt}` },
    } });
    expect(h.send.mock.calls.at(-1)![0].response.response).toEqual({});
    expect(a.onEvent).toHaveBeenCalledWith({ type: 'started', occurrenceId: 'batch-a' });
    expect(b.onEvent).toHaveBeenCalledWith({ type: 'started', occurrenceId: 'batch-b' });
    h.adapter.accept({ type: 'command_lifecycle', state: 'completed', command_uuid: 'batch-a' });
    h.adapter.accept({ type: 'command_lifecycle', state: 'completed', command_uuid: 'batch-b' });
    expect(h.adapter.busy).toBe(true);
    h.adapter.accept({ type: 'result', uuid: 'batch-result', is_error: false, terminal_reason: 'completed', result: 'Combined native answer' });
    for (const job of [a, b]) expect(job.onEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'completed', success: true, output: 'Native combined result for concurrently due tasks:\nCombined native answer',
    }));
    expect(h.adapter.busy).toBe(false); h.adapter.processClosed();
  });

  it('does not treat a marker in ordinary user text as a scheduled occurrence', async () => {
    const h = harness(); const job = await h.create();
    h.adapter.accept({ type: 'control_request', request_id: 'user-hook', request: {
      subtype: 'hook_callback', callback_id: SCHEDULE_HOOK,
      input: { hook_event_name: 'UserPromptSubmit', prompt: job.action.input.prompt },
    } });
    expect(job.onEvent).not.toHaveBeenCalled(); expect(h.adapter.busy).toBe(false); h.adapter.processClosed();
  });

  it('never completes foreground work from a scheduled result with ambiguous user joins', async () => {
    const h = harness(); const job = await h.create(); h.occurrence(String(job.action.input.prompt));
    expect(h.adapter.accept({ type: 'result', user_message_uuid: 'foreground-id', is_error: false, terminal_reason: 'completed', result: 'Wrong attribution' })).toBe(true);
    h.adapter.accept({ type: 'command_lifecycle', command_uuid: 'occurrence-one', state: 'completed' });
    expect(job.onEvent).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'completed', success: false }));
    h.adapter.processClosed();
  });

  it('cancels only the owned job, keeps the other job and shared session alive, and retires without a model turn', async () => {
    const h = harness(); const a = await h.create(); const b = await h.create('job-two', 'native-two');
    const cancel = h.adapter.inToolOperation('cancel', () => true, () => a.handle.cancel());
    const action = h.adapter.action('cancel')!;
    expect(action).toEqual({ tool: 'CronDelete', input: { id: 'native-one' } });
    h.hook(action.tool, action.input, 'cancel-tool'); h.receipt('Cancelled job native-one.', 'cancel-tool'); await cancel;
    await a.handle.stop(); expect(a.onEvent).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'stopped', exitConfirmed: true }));
    h.occurrence(String(b.action.input.prompt)); h.complete();
    expect(b.onEvent).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'completed', success: true }));
    expect(h.manage).not.toHaveBeenCalled(); h.adapter.processClosed();
  });

  it('auto-retires a completed one-shot without stopping the native conversation', async () => {
    const h = harness(); const job = await h.create('once', 'native-once', vi.fn(), { kind: 'once', at: new Date(Math.ceil((Date.now() + 120_000) / 60_000) * 60_000).toISOString() });
    h.occurrence(String(job.action.input.prompt)); h.complete(); await job.handle.stop();
    expect(job.onEvent.mock.calls.map(([event]) => event.type)).toEqual(['started', 'completed', 'stopped']);
    expect(h.manage).not.toHaveBeenCalled(); expect(h.adapter.busy).toBe(false); h.adapter.processClosed();
  });

  it('uses queued same-session management for slash/card controls and denies unrelated tools during it', async () => {
    const h = harness(); const events = vi.fn();
    const pending = h.adapter.create(input(), events);
    expect(h.manage).toHaveBeenCalledTimes(1);
    h.adapter.foregroundDispatched('management', true);
    const action = JSON.parse(h.manage.mock.calls[0][0]!.split('\n').at(-1)!);
    expect(h.hook('Bash', { command: 'not allowed' })).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny');
    expect(h.hook('ToolSearch', { query: 'select:CronCreate' }, 'discovery')).toEqual({});
    expect(h.hook('ToolSearch', { query: 'select:Bash' }, 'foreign-discovery')).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny');
    h.hook(action.tool, action.input); h.receipt(h.created());
    await pending; h.adapter.processClosed();
  });

  it('retains an uncertain creation for explicit reconciliation after a lost tool receipt', async () => {
    vi.useFakeTimers(); const h = harness();
    const pending = h.adapter.inToolOperation('operation', () => true, () => h.adapter.create(input(), vi.fn()));
    const failure = pending.catch(error => error as NativeScheduleCleanupError);
    const action = h.adapter.action('operation')!; h.hook(action.tool, action.input);
    await vi.advanceTimersByTimeAsync(101);
    const error = await failure;
    expect(error).toBeInstanceOf(NativeScheduleCleanupError);
    const cancel = h.adapter.inToolOperation('cancel', () => true, () => (error as NativeScheduleCleanupError).handle.cancel());
    let next = h.adapter.action('cancel')!;
    expect(next.tool).toBe('CronList'); h.hook(next.tool, next.input, 'list-tool');
    const marker = String(action.input.prompt).split('\n')[0];
    h.receipt(`native-one — every minute (recurring) [session-only]: ${marker} task`, 'list-tool');
    await Promise.resolve(); await Promise.resolve();
    next = h.adapter.action('cancel')!; expect(next.tool).toBe('CronDelete');
    h.hook(next.tool, next.input, 'cancel-tool'); h.receipt('Cancelled job native-one.', 'cancel-tool'); await cancel;
    h.adapter.processClosed();
  });

  it('rejects duplicate IDs, unavailable native capabilities, timezone mismatch and malformed receipts', async () => {
    const h = harness(); await expect(h.adapter.create({ ...input(), rule: { kind: 'cron', expression: '* * * * *', timezone: 'America/New_York' } }, vi.fn())).rejects.toThrow('timezone');
    await h.create(); await expect(h.adapter.create(input(), vi.fn())).rejects.toThrow('identity');
    h.adapter.accept({ ...initialized, capabilities: [] });
    const pending = h.adapter.inToolOperation('other', () => true, () => h.adapter.create(input('other'), vi.fn()));
    const action = h.adapter.action('other')!;
    expect(h.hook(action.tool, action.input)).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny');
    h.adapter.foregroundEnded(); await expect(pending).rejects.toThrow('ended');
    h.adapter.processClosed();
  });

  it('rejects invalid cancellation receipts and retains native ownership for retry', async () => {
    const h = harness(); const job = await h.create();
    const pending = h.adapter.inToolOperation('cancel', () => true, () => job.handle.cancel());
    h.hook('CronDelete', { id: 'native-one' }, 'cancel-tool'); h.receipt('Cancelled job foreign-id.', 'cancel-tool');
    await Promise.resolve(); await Promise.resolve();
    h.hook('CronList', {}, 'reconcile-tool');
    h.receipt(`native-one — every minute (recurring) [session-only]: ${String(job.action.input.prompt).split('\n')[0]} task`, 'reconcile-tool');
    await expect(pending).rejects.toThrow('cancellation receipt'); expect(h.adapter.hasJobs).toBe(true);
    h.adapter.processClosed();
  });

  it('retires a verified expired native job without attempting to delete an unknown ID', async () => {
    const h = harness(); const job = await h.create();
    const list = h.adapter.inToolOperation('list', () => true, () => job.handle.list());
    h.hook('CronList', {}, 'list-tool'); h.receipt('No scheduled jobs.', 'list-tool');
    expect(await list).toBe(false); await job.handle.stop();
    expect(h.manage).not.toHaveBeenCalled(); expect(h.adapter.hasJobs).toBe(false); h.adapter.processClosed();
  });

  it('reconciles cancellation after native expiry with an exact empty inventory receipt', async () => {
    const h = harness(); const job = await h.create();
    const pending = h.adapter.inToolOperation('cancel', () => true, () => job.handle.cancel());
    h.hook('CronDelete', { id: 'native-one' }, 'cancel-tool'); h.receipt('Native job expired', 'cancel-tool', true);
    await Promise.resolve(); await Promise.resolve();
    expect(h.adapter.action('cancel')).toEqual({ tool: 'CronList', input: {} });
    h.hook('CronList', {}, 'list-tool'); h.receipt('No scheduled jobs.', 'list-tool');
    await pending; await job.handle.stop(); expect(h.adapter.hasJobs).toBe(false); h.adapter.processClosed();
  });

  it('binds a queued operation to its own management turn, not a previous turn awaiting its result', async () => {
    const h = harness(); const job = await h.create();
    const first = job.handle.list(); h.adapter.foregroundDispatched('first-management', true);
    h.hook('CronList', {}, 'first-list'); h.receipt(`native-one — every minute [session-only]: ${String(job.action.input.prompt).split('\n')[0]}`, 'first-list');
    expect(await first).toBe(true);
    const next = job.handle.cancel();
    expect(h.hook('CronDelete', { id: 'native-one' }, 'previous-turn-tool')).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny');
    h.adapter.foregroundEnded();
    h.adapter.foregroundDispatched('next-management', true);
    expect(h.hook('CronDelete', { id: 'native-one' }, 'next-tool')).toEqual({});
    h.receipt('Cancelled job native-one.', 'next-tool'); await next;
    await job.handle.stop(); h.adapter.processClosed();
  });

  it('reports interruption only on confirmed process close and creates no replacement jobs', async () => {
    const h = harness(); const job = await h.create(); h.occurrence(String(job.action.input.prompt));
    h.adapter.processClosed(); h.adapter.processClosed();
    expect(job.onEvent.mock.calls.map(([event]) => event.type)).toEqual(['started', 'completed', 'stopped']);
    await expect(job.handle.list()).resolves.toBe(false); await job.handle.stop();
    expect(h.manage).not.toHaveBeenCalled();
  });

  it('blocks a previously owned wakeup after its conversation generation changes', async () => {
    const h = harness(); let current = true; const events = vi.fn();
    const pending = h.adapter.inToolOperation('create', () => true, () => h.adapter.create(input(), events, () => current));
    const action = h.adapter.action('create')!; h.hook(action.tool, action.input); h.receipt(h.created()); await pending;
    current = false;
    expect(h.occurrence(String(action.input.prompt))).toHaveProperty('decision', 'block');
    h.complete(); expect(events).not.toHaveBeenCalled(); h.adapter.processClosed();
  });

  it('bounds uncertain cleanup and fails invalid inventories without inventing deletion success', async () => {
    vi.useFakeTimers(); const h = harness();
    const pending = h.adapter.inToolOperation('create', () => true, async () => {
      try { return await h.adapter.create(input(), vi.fn()); }
      catch (error) {
        await expect((error as NativeScheduleCleanupError).handle.stop()).rejects.toThrow('explicit cancellation');
        throw error;
      }
    });
    const failure = expect(pending).rejects.toBeInstanceOf(NativeScheduleCleanupError);
    const action = h.adapter.action('create')!; h.hook(action.tool, action.input);
    h.receipt('A model claim without a native receipt'); await failure;
    h.adapter.processClosed();
    const h2 = harness(); const job = await h2.create();
    const list = h2.adapter.inToolOperation('list', () => true, () => job.handle.list());
    h2.hook('CronList', {}, 'list-tool'); h2.receipt('Unexpected inventory', 'list-tool');
    await expect(list).rejects.toThrow('inventory'); h2.adapter.processClosed();
  });

  it('retains cleanup ownership if a native tool was attempted without its required callback receipt', async () => {
    const h = harness();
    const pending = h.adapter.inToolOperation('create', () => true, () => h.adapter.create(input(), vi.fn()));
    const failure = expect(pending).rejects.toBeInstanceOf(NativeScheduleCleanupError);
    const action = h.adapter.action('create')!;
    h.adapter.accept({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'unguarded', name: action.tool, input: action.input }] } });
    h.receipt(h.created(), 'unguarded'); h.adapter.foregroundEnded();
    await failure; expect(h.adapter.hasJobs).toBe(true); h.adapter.processClosed();
  });

  it.each(['valid', 'missing', 'duplicate', 'prompt', 'cron', 'durable', 'recurring-string', 'recurring-number', 'id-collision', 'changed-id'])(
    'requires exact structured native ownership when adopting (%s)', async variant => {
      const h = harness(); const marker = '11111111-1111-4111-8111-111111111111';
      const restored = { ...input(), recovery: { version: 1 as const, provider: 'fixture', strategy: 'reconstruct' as const,
        identity: JSON.stringify({ marker }) } };
      const events = vi.fn();
      const operation = h.adapter.inToolOperation('restore', () => true,
        () => h.adapter.create(restored, events, () => true, 'UTC', 'adopt', 'original-native'));
      const failure = variant === 'valid' ? undefined : expect(operation).rejects.toThrow();
      const row = { id: 'original-native', prompt: `[remote-cli:${marker}]\n${restored.prompt}`, cron: '* * * * *', recurring: true, durable: false };
      const jobs = [row];
      if (variant === 'duplicate') jobs.push({ ...row, id: 'duplicate-native' });
      if (variant === 'id-collision') jobs.push({ ...row, prompt: 'Unrelated task' });
      if (variant === 'prompt') row.prompt += ' changed';
      if (variant === 'cron') row.cron = '0 * * * *';
      if (variant === 'durable') row.durable = true;
      if (variant === 'recurring-string') Object.assign(row, { recurring: 'false' });
      if (variant === 'recurring-number') Object.assign(row, { recurring: 1 });
      if (variant === 'changed-id') row.id = 'changed-native-id';
      // A restored wake arriving during inspection must not become a later admission.
      expect(h.hook('CronList', {})).toEqual({});
      h.adapter.accept({ type: 'user', ...(variant === 'missing' ? {} : { tool_use_result: { jobs } }),
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-one', content: 'Native human-readable summary.' }] } });
      h.adapter.accept({ type: 'command_lifecycle', command_uuid: 'queued-before-adoption', state: 'started', wakeup_source: 'schedule_wakeup' });
      if (failure) await failure;
      else {
        expect((await operation).nativeId).toBe('original-native');
        expect(h.adapter.action('restore')).toBeUndefined();
        h.adapter.accept({ type: 'control_request', request_id: 'stale-wake', request: { subtype: 'hook_callback', callback_id: SCHEDULE_HOOK,
          input: { hook_event_name: 'UserPromptSubmit', source: 'schedule_wakeup', prompt: row.prompt } } });
        expect(h.send.mock.calls.at(-1)![0].response.response.decision).toBe('block');
        expect(events).not.toHaveBeenCalled();
      }
      h.adapter.processClosed();
    });

  it('does not activate management or consume ordinary frames when never used', () => {
    const h = harness();
    expect(h.adapter.accept({ type: 'result', is_error: false })).toBe(false);
    expect(h.hook('Read', { file_path: 'synthetic' })).toEqual({});
    expect(h.adapter.hasJobs).toBe(false); expect(h.manage).not.toHaveBeenCalled();
    h.adapter.processClosed();
  });
});
