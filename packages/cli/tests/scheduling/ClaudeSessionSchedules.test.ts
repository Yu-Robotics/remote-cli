import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScheduleToolOperations } from '../../src/scheduling/ScheduleToolScope';
import { ClaudeSessionSchedules, SCHEDULE_HOOK, type NativeScheduleAction } from '../../src/scheduling/claude/ClaudeSessionSchedules';
import { NativeScheduleCleanupError, NativeScheduleNotAdmittedError, type NativeScheduleEvent, type NativeScheduleInput } from '../../src/scheduling/types';

const input = (id = 'job-one'): NativeScheduleInput => ({ id, prompt: 'Use this conversation to report progress.', cwd: process.cwd(),
  rule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' } });
const initialized = { type: 'system', subtype: 'init', tools: ['CronCreate', 'CronList', 'CronDelete'],
  capabilities: ['msg_lifecycle_v1', 'lifecycle_wakeup_source_v1'] };
function harness() {
  const send = vi.fn(); const manage = vi.fn(async () => ({ success: true })); const wake = vi.fn();
  const adapter = new ClaudeSessionSchedules({ send, manage, wake, timezone: 'UTC', timeoutMs: 100 });
  adapter.accept(initialized);
  adapter.foregroundDispatched('synthetic-foreground');
  const hook = (tool: string, value: unknown, id = 'tool-one') => {
    adapter.accept({ type: 'control_request', request_id: `hook-${id}`, request: { subtype: 'hook_callback', callback_id: SCHEDULE_HOOK,
      tool_use_id: id, input: { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: value } } });
    return send.mock.calls.at(-1)![0].response.response;
  };
  const receipt = (text: string, toolId = 'tool-one', is_error = false, structured?: unknown) => adapter.accept({ type: 'user', tool_use_result: structured, message: { content: [
    { type: 'tool_result', tool_use_id: toolId, content: text, is_error },
  ] } });
  const created = (id = 'native-one', recurring = true) => `Scheduled ${recurring ? 'recurring job' : 'one-shot task'} ${id} (every minute). Next run: later. Session-only (not written to disk, dies when Claude exits).`;
  const occurrence = (prompt: string, id = 'occurrence-one', hookFirst = false) => {
    adapter.foregroundEnded();
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
  async function create(id = 'job-one', nativeId = 'native-one', onEvent = vi.fn(), rule = input().rule, admit?: () => boolean) {
    const promise = adapter.inToolOperation(`operation-${id}`, () => true, () => adapter.create({ ...input(id), rule }, onEvent, undefined, undefined, admit));
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
  it('requires a current foreground lifecycle for unclassified prompts on a managed resume', () => {
    const h = harness();
    h.adapter.guardResumedPrompts();
    h.adapter.foregroundDispatched('synthetic-foreground', false, 'Fixture input');
    const submit = (prompt = 'Fixture input') => {
      h.adapter.accept({ type: 'control_request', request_id: 'submit', request: {
        subtype: 'hook_callback', callback_id: SCHEDULE_HOOK, input: { hook_event_name: 'UserPromptSubmit', prompt },
      } });
      return h.send.mock.calls.at(-1)![0].response.response;
    };
    expect(submit()).toMatchObject({ decision: 'block' });
    h.adapter.accept({ type: 'command_lifecycle', state: 'started', command_uuid: 'synthetic-foreground' });
    expect(submit('Old timer')).toMatchObject({ decision: 'block' });
    expect(submit()).toEqual({});
    expect(submit()).toMatchObject({ decision: 'block' });
    h.adapter.accept({ type: 'command_lifecycle', state: 'completed', command_uuid: 'synthetic-foreground' });
    expect(submit()).toMatchObject({ decision: 'block' });
    h.adapter.foregroundEnded();
    expect(submit()).toMatchObject({ decision: 'block' });
  });

  it.each([true, false])('refuses partial historical inventory before dispatch (inTurn=%s)', async inTurn => {
    const h = harness();
    h.adapter.accept({ ...initialized, tools: ['CronList', 'CronDelete'] });
    for (const operation of ['review', 'delete'] as const) {
      const pending = h.adapter.inToolOperation(operation, () => true, async () => {
        if (operation === 'review') return h.adapter.reviewedInventory(() => true);
        await h.adapter.reviewedDelete({ id: 'old', prompt: 'Old scheduled work', cron: '* * * * *', durable: false }, () => true);
      }, inTurn);
      const settled = pending.catch(error => error);
      try {
        expect(h.adapter.action(operation)).toBeUndefined();
        expect(h.manage).not.toHaveBeenCalled();
        expect(await settled).toBeInstanceOf(NativeScheduleNotAdmittedError);
        expect(h.adapter.cleanupMutationPending).toBe(false);
      } finally {
        if (h.adapter.action(operation) || h.manage.mock.calls.length) h.adapter.processClosed();
        await settled;
      }
    }
    expect(h.hook('CronDelete', { id: 'old' })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });
  it('does not admit management tools while a submitted wake awaits its lifecycle frame', async () => {
    const h = harness(); const job = await h.create(); h.adapter.foregroundEnded();
    h.adapter.accept({ type: 'control_request', request_id: 'submitted-wake', request: {
      subtype: 'hook_callback', callback_id: SCHEDULE_HOOK,
      input: { hook_event_name: 'UserPromptSubmit', source: 'schedule_wakeup', prompt: job.action.input.prompt },
    } });
    expect(h.adapter.busy).toBe(true);
    const pending = h.adapter.inToolOperation('outside-management', () => true, () => job.handle.list(), false);
    const settled = pending.catch(() => {});
    try {
      h.adapter.foregroundDispatched('outside-management', true);
      expect(h.hook('CronList', {}, 'outside-list')).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
    } finally { h.adapter.processClosed(); await settled; }
  });

  it('revokes uninvoked delete authorization synchronously when its scheduled invocation finishes', async () => {
    vi.useFakeTimers();
    const h = harness(); const created = await h.create();
    h.occurrence(created.action.input.prompt as string);
    const settled = vi.fn();
    const pending = h.adapter.inToolOperation('scheduled-cancel', () => true, () => created.handle.cancel());
    const done = pending.then(settled, settled);
    try {
      h.complete();
      expect(h.adapter.action('scheduled-cancel')).toBeUndefined();
      await vi.advanceTimersByTimeAsync(300);
      h.adapter.foregroundDispatched('unrelated-foreground', false);
      const stale = h.adapter.action('scheduled-cancel');
      const lateHook = h.hook('CronDelete', { id: 'native-one' }, 'unrelated-delete');
      expect({ settled: settled.mock.calls.length, stale, lateHook }).toMatchObject({
        settled: 1, stale: undefined,
        lateHook: { hookSpecificOutput: { permissionDecision: 'deny' } },
      });
    } finally { h.adapter.processClosed(); await done; }
  });

  it.each(['result-first', 'terminals-first'] as const)('ends batch authorization at the first complete boundary (%s)', async order => {
    const h = harness(); const a = await h.create('a', 'native-a'), b = await h.create('b', 'native-b');
    h.adapter.foregroundEnded();
    for (const id of ['wake-a', 'wake-b']) h.adapter.accept({ type: 'command_lifecycle', command_uuid: id,
      state: 'started', wakeup_source: 'schedule_wakeup' });
    h.adapter.accept({ type: 'control_request', request_id: 'batch-submit', request: { subtype: 'hook_callback', callback_id: SCHEDULE_HOOK,
      input: { hook_event_name: 'UserPromptSubmit', source: 'schedule_wakeup', prompt: `${a.action.input.prompt}\n${b.action.input.prompt}` } } });
    const lease = h.adapter.invocationLease();
    const pending = h.adapter.inToolOperation('batch-cancel', () => true, () => a.handle.cancel());
    const failed = expect(pending).rejects.toThrow('no longer current');
    const result = () => h.adapter.accept({ type: 'result', uuid: 'batch-result', is_error: false, terminal_reason: 'completed', result: 'Combined output' });
    const terminal = (id: string) => h.adapter.accept({ type: 'command_lifecycle', command_uuid: id, state: 'completed' });
    if (order === 'result-first') result();
    terminal('wake-a');
    if (order === 'terminals-first') expect(h.adapter.action('batch-cancel')?.tool).toBe('CronDelete');
    terminal('wake-b');
    expect(lease()).toBe(false);
    expect(h.adapter.action('batch-cancel')).toBeUndefined();
    if (order === 'terminals-first') result();
    await failed;
    expect(a.onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'completed', success: true }));
    expect(b.onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'completed', success: true }));
    h.adapter.foregroundDispatched('later');
    expect(lease()).toBe(false);
    const review = h.adapter.inToolOperation('fresh-review', () => true, () => h.adapter.reviewedInventory(() => true));
    expect(h.hook('CronList', {}, 'fresh-list')).toEqual({});
    h.adapter.accept({ type: 'user', tool_use_result: { jobs: [] }, message: { content: [
      { type: 'tool_result', tool_use_id: 'fresh-list', content: 'Synthetic inventory' },
    ] } });
    expect(await review).toEqual([]);
    h.adapter.processClosed();
  });

  it('settles an invoked scheduled deletion and preserves its already admitted result', async () => {
    const h = harness(); const a = await h.create();
    h.occurrence(String(a.action.input.prompt));
    const pending = h.adapter.inToolOperation('self-cancel', () => true, () => a.handle.cancel());
    expect(h.hook('CronDelete', { id: 'native-one' }, 'scheduled-delete')).toEqual({});
    h.receipt('Cancelled job native-one.', 'scheduled-delete'); await pending;
    expect(a.handle.nativeDefinitionAbsent).toBe(true);
    h.complete();
    expect(a.onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'completed', success: true }));
    h.adapter.processClosed();
  });

  it('joins an exact late mutation receipt during another batch without renewing tool authority', async () => {
    const h = harness(); const a = await h.create('a', 'native-a'), b = await h.create('b', 'native-b');
    h.occurrence(String(a.action.input.prompt), 'wake-a');
    const pending = h.adapter.inToolOperation('late-delete', () => true, () => a.handle.cancel());
    const failed = expect(pending).rejects.toThrow('no longer current');
    expect(h.hook('CronDelete', { id: 'native-a' }, 'authorized-delete')).toEqual({});
    h.complete('wake-a'); await failed;
    expect(a.handle.nativeDefinitionAbsent).toBe(false);
    expect(h.adapter.cleanupMutationPending).toBe(true);
    h.occurrence(String(b.action.input.prompt), 'wake-b');
    expect(h.hook('CronDelete', { id: 'native-a' }, 'different-delete')).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny');
    h.receipt('Cancelled job native-a.', 'wrong-receipt');
    expect(a.handle.nativeDefinitionAbsent).toBe(false);
    h.receipt('Cancelled job native-a.', 'authorized-delete');
    expect(a.handle.nativeDefinitionAbsent).toBe(true);
    expect(h.adapter.cleanupMutationPending).toBe(false);
    h.complete('wake-b');
    expect(b.onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'completed', success: true }));
    h.adapter.processClosed();
  });

  it('cannot reuse an unresolved mutation tool ID for a later invocation', async () => {
    const h = harness(); const a = await h.create('a', 'native-a'), b = await h.create('b', 'native-b');
    h.occurrence(String(a.action.input.prompt), 'wake-a');
    const old = h.adapter.inToolOperation('old-delete', () => true, () => a.handle.cancel());
    const failed = expect(old).rejects.toThrow('no longer current');
    h.hook('CronDelete', { id: 'native-a' }, 'held-tool-id'); h.complete('wake-a'); await failed;
    h.occurrence(String(b.action.input.prompt), 'wake-b');
    const next = h.adapter.inToolOperation('new-delete', () => true, () => b.handle.cancel());
    expect(h.hook('CronDelete', { id: 'native-b' }, 'held-tool-id')).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny');
    h.receipt('Cancelled job native-a.', 'held-tool-id');
    expect(a.handle.nativeDefinitionAbsent).toBe(true);
    expect(b.handle.nativeDefinitionAbsent).toBe(false);
    expect(h.adapter.action('new-delete')).toEqual({ tool: 'CronDelete', input: { id: 'native-b' } });
    expect(h.hook('CronDelete', { id: 'native-b' }, 'new-tool-id')).toEqual({});
    h.receipt('Cancelled job native-b.', 'new-tool-id'); await next;
    h.complete('wake-b'); h.adapter.processClosed();
  });

  it('never revives foreground authority after an overlapping scheduled batch drains', async () => {
    const h = harness(); const a = await h.create();
    const lease = h.adapter.invocationLease();
    h.adapter.accept({ type: 'command_lifecycle', command_uuid: 'overlap', state: 'started', wakeup_source: 'schedule_wakeup' });
    expect(lease()).toBe(false);
    await expect(h.adapter.inToolOperation('ambiguous', () => true, () => a.handle.cancel())).rejects.toThrow('unambiguous');
    h.complete('overlap');
    expect(lease()).toBe(false);
    await expect(h.adapter.inToolOperation('ended', () => true, () => a.handle.cancel())).rejects.toThrow('unambiguous');
    h.adapter.foregroundDispatched('synthetic-foreground');
    expect(h.adapter.invocationLease()()).toBe(true);
    expect(lease()).toBe(false);
    h.adapter.processClosed();
  });

  it.each(['cron', 'timezone', 'mismatch', 'one-shot', 'marker-json', 'marker-shape', 'native-timezone'])(
    'refuses invalid %s before requesting CronCreate or admitting an occurrence', async reason => {
      const h = harness(); const value = input(); const admit = vi.fn(() => true); const events = vi.fn();
      let timezone = 'UTC';
      if (reason === 'cron') value.rule = { kind: 'cron', expression: '90 * * * *', timezone: 'UTC' };
      if (reason === 'timezone') value.rule = { kind: 'cron', expression: '* * * * *', timezone: 'Invalid/Timezone' };
      if (reason === 'mismatch') value.rule = { kind: 'cron', expression: '* * * * *', timezone: 'America/New_York' };
      if (reason === 'one-shot') value.rule = { kind: 'once', at: 'not-a-timestamp' };
      if (reason === 'marker-json' || reason === 'marker-shape') value.recovery = {
        version: 1, provider: 'fixture', strategy: 'reconstruct', identity: reason === 'marker-json' ? '{' : '{}',
      };
      if (reason === 'native-timezone') timezone = 'Invalid/Timezone';
      await expect(h.adapter.inToolOperation('refused', () => true,
        () => h.adapter.create(value, events, () => true, timezone, admit)))
        .rejects.toBeInstanceOf(NativeScheduleNotAdmittedError);
      expect(h.adapter.action('refused')).toBeUndefined(); expect(h.adapter.hasJobs).toBe(false);
      expect(h.send).not.toHaveBeenCalled(); expect(h.manage).not.toHaveBeenCalled();
      expect(admit).not.toHaveBeenCalled(); expect(events).not.toHaveBeenCalled(); h.adapter.processClosed();
    });

  it.each(['closed', 'capacity'])(
    'refuses a fresh job before dispatch when the adapter is blocked by %s', async reason => {
      const h = harness();
      if (reason === 'closed') h.adapter.processClosed();
      if (reason === 'restart') (h.adapter as any).definitionRemoval = { lease: { isCurrent: () => true } };
      if (reason === 'capacity') for (let index = 0; index < 5; index++) await h.create(`existing-${index}`, `native-${index}`);
      h.send.mockClear(); h.manage.mockClear();
      await expect(h.adapter.create(input('fresh'), vi.fn())).rejects.toBeInstanceOf(NativeScheduleNotAdmittedError);
      expect(h.send).not.toHaveBeenCalled(); expect(h.manage).not.toHaveBeenCalled(); h.adapter.processClosed();
    });

  it('does not classify a duplicate owned ID as harmless or revoke its existing callbacks', async () => {
    const h = harness(); const existing = await h.create();
    h.send.mockClear(); h.manage.mockClear();
    const failure = await h.adapter.create(input(), vi.fn()).catch(error => error);
    expect(failure).toBeInstanceOf(Error); expect(failure).not.toBeInstanceOf(NativeScheduleNotAdmittedError);
    expect(h.send).not.toHaveBeenCalled(); expect(h.manage).not.toHaveBeenCalled();
    expect(existing.handle.nativeDefinitionAbsent).toBe(false);
    expect(h.occurrence(String(existing.action.input.prompt))).toEqual({}); h.complete();
    expect(existing.onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'completed' })); h.adapter.processClosed();
  });

  it('inventories arbitrary reviewed native definitions without granting admission or accepting uncorrelated receipts', async () => {
    const h = harness(); let current = true;
    const target = { id: 'legacy-native', prompt: 'Synthetic unmarked native task', cron: '* * * * *', durable: false };
    const pending = h.adapter.inToolOperation('review', () => current, () => h.adapter.reviewedInventory(() => current));
    expect(h.hook('CronDelete', { id: target.id }, 'wrong-tool')).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny');
    expect(h.hook('CronList', {}, 'inventory')).toEqual({});
    h.adapter.accept({ type: 'user', tool_use_result: { jobs: [target] }, message: { content: [
      { type: 'tool_result', tool_use_id: 'inventory', content: 'Untrusted display text' },
    ] } });
    expect(await pending).toEqual([target]);
    expect(h.adapter.hasJobs).toBe(false);
    expect(h.occurrence(target.prompt)).toMatchObject({ decision: 'block' }); h.complete();
    h.adapter.foregroundDispatched('review-foreground');
    await expect(h.adapter.inToolOperation('project-delete', () => current, () => h.adapter.reviewedDelete({ ...target, durable: true }, () => current))).rejects.toThrow('session-only provenance');
    const deletion = h.adapter.inToolOperation('delete', () => current, () => h.adapter.reviewedDelete(target, () => current));
    expect(h.hook('CronDelete', { id: 'other' }, 'foreign')).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny');
    expect(h.hook('CronDelete', { id: target.id }, 'delete')).toEqual({});
    h.receipt('Cancelled job legacy-native.', 'delete', false, { id: target.id }); await deletion;
    expect(h.hook('CronDelete', { id: target.id }, 'delete')).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny');
    current = false;
    await expect(h.adapter.inToolOperation('stale', () => current, () => h.adapter.reviewedInventory(() => current))).rejects.toThrow('lease');
  });
  it('rejects display-only cleanup inventory and preserves sibling callbacks during exact reviewed removal', async () => {
    const h = harness();
    const a = await h.create('a', 'native-a'); const b = await h.create('b', 'native-b');
    const query = h.adapter.inToolOperation('review', () => true, () => h.adapter.reviewedInventory(() => true));
    const failed = expect(query).rejects.toThrow('structured');
    h.hook('CronList', {}, 'list'); h.receipt('No scheduled jobs.', 'list'); await failed;
    const deletion = h.adapter.inToolOperation('delete', () => true, () => h.adapter.reviewedDelete({
      id: 'native-a', prompt: String(a.action.input.prompt), cron: '* * * * *', recurring: true, durable: false,
    }, () => true));
    h.hook('CronDelete', { id: 'native-a' }, 'delete'); h.receipt('Cancelled job native-a.', 'delete', false, { id: 'native-a' }); await deletion;
    expect(h.occurrence(String(a.action.input.prompt), 'refused-a')).toMatchObject({ decision: 'block' }); h.complete('refused-a');
    expect(h.occurrence(String(b.action.input.prompt), 'admitted-b')).toEqual({}); h.complete('admitted-b');
    expect(b.onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'completed', success: true }));
    expect(a.onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'completed' }));
  });
  it('drains an already admitted result during reviewed deletion without admitting another occurrence', async () => {
    const h = harness(); const a = await h.create('a', 'native-a');
    expect(h.occurrence(String(a.action.input.prompt), 'already-started')).toEqual({});
    const deletion = h.adapter.inToolOperation('delete', () => true, () => h.adapter.reviewedDelete({
      id: 'native-a', prompt: String(a.action.input.prompt), cron: '* * * * *', recurring: true, durable: false,
    }, () => true), false);
    expect(h.hook('CronDelete', { id: 'native-a' }, 'premature')).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny');
    h.complete('already-started');
    expect(a.onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'completed', occurrenceId: 'already-started', success: true }));
    h.adapter.foregroundDispatched('review-management', true);
    expect(h.hook('CronDelete', { id: 'native-a' }, 'delete')).toEqual({});
    h.receipt('Cancelled job native-a.', 'delete', false, { id: 'native-a' }); await deletion;
    expect(h.occurrence(String(a.action.input.prompt), 'next')).toMatchObject({ decision: 'block' }); h.complete('next');
    expect(a.onEvent.mock.calls.filter(([event]) => event.type === 'completed')).toHaveLength(1);
  });
  it('keeps the exact reviewed ID reserved across a lost turn and consumes its late native receipt', async () => {
    const h = harness(); const a = await h.create('a', 'native-a');
    const target = { id: 'native-a', prompt: String(a.action.input.prompt), cron: '* * * * *', recurring: true, durable: false };
    const remove = () => h.adapter.inToolOperation('delete', () => true, () => h.adapter.reviewedDelete(target, () => true));
    const ended = expect(remove()).rejects.toThrow('ended');
    expect(h.hook('CronDelete', { id: target.id }, 'late')).toEqual({});
    h.adapter.foregroundEnded(); await ended;
    h.adapter.foregroundDispatched('next-turn');
    await expect(remove()).rejects.toThrow('remains unresolved');
    expect(h.adapter.cleanupMutationPending).toBe(true);
    h.receipt('Cancelled job native-a.', 'late', false, { id: target.id });
    expect(h.adapter.cleanupMutationPending).toBe(false);
    expect(a.handle.nativeDefinitionAbsent).toBe(false);
    const inventory = h.adapter.inToolOperation('verify', () => true, () => h.adapter.reviewedInventory(() => true));
    expect(h.hook('CronList', {}, 'verify')).toEqual({});
    h.receipt('No scheduled jobs.', 'verify', false, { jobs: [] }); await inventory;
    expect(a.handle.nativeDefinitionAbsent).toBe(true);
    h.adapter.processClosed();
  });
  it.each(['native error', 'wrong ID', 'missing ID', 'ambiguous', 'confirmed'])('requires an exact reviewed delete receipt and fresh absence (%s)', async variant => {
    const h = harness(); const a = await h.create('a', 'native-a');
    const target = { id: 'native-a', prompt: String(a.action.input.prompt), cron: '* * * * *', recurring: true, durable: false };
    const deletion = h.adapter.inToolOperation('delete', () => true, () => h.adapter.reviewedDelete(target, () => true));
    const result = variant === 'confirmed' ? expect(deletion).resolves.toBeUndefined() : expect(deletion).rejects.toThrow();
    expect(a.handle.nativeDefinitionAbsent).toBe(false);
    h.hook('CronDelete', { id: 'native-a' }, 'delete');
    const block = { type: 'tool_result', tool_use_id: 'delete', content: 'Cancelled job native-a.', is_error: variant === 'native error' };
    h.adapter.accept({ type: 'user', tool_use_result: variant === 'missing ID' ? undefined : { id: variant === 'wrong ID' ? 'other' : target.id },
      message: { content: variant === 'ambiguous' ? [block, { ...block, tool_use_id: 'other-tool' }] : [block] } });
    await result;
    expect(h.adapter.cleanupMutationPending).toBe(['wrong ID', 'missing ID', 'ambiguous'].includes(variant));
    expect(a.handle.nativeDefinitionAbsent).toBe(false);
    expect(h.occurrence(target.prompt, 'denied-after-failure')).toMatchObject({ decision: 'block' }); h.complete('denied-after-failure');
    h.adapter.foregroundDispatched('review-foreground');
    for (const present of [true, false]) {
      const query = h.adapter.inToolOperation(`verify-${present}`, () => true, () => h.adapter.reviewedInventory(() => true));
      h.hook('CronList', {}, 'list');
      h.adapter.accept({ type: 'user', tool_use_result: { jobs: present ? [target] : [] }, message: { content: [
        { type: 'tool_result', tool_use_id: 'list', content: 'Synthetic structured inventory' },
      ] } });
      await query;
      expect(a.handle.nativeDefinitionAbsent).toBe(variant === 'confirmed' && !present);
    }
    h.adapter.processClosed();
    expect(a.handle.nativeDefinitionAbsent).toBe(false);
  });
  it('fails closed when the occurrence admission check throws without discarding a prior result', async () => {
    const h = harness(); const admit = vi.fn(() => true);
    const { action, onEvent } = await h.create('job-one', 'native-one', vi.fn(), input().rule, admit);
    expect(h.occurrence(action.input.prompt as string, 'admitted')).toEqual({});
    admit.mockImplementation(() => { throw new Error('Synthetic catalog unavailable'); });
    h.complete('admitted');
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'completed', occurrenceId: 'admitted' }));
    expect(h.occurrence(action.input.prompt as string, 'denied')).toMatchObject({ decision: 'block' });
    h.complete('denied');
    expect(onEvent.mock.calls.filter(([event]) => event.type === 'completed')).toHaveLength(1);
  });
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

  it('unwinds an uninvoked creation on abort without a terminal frame or native cleanup turn', async () => {
    vi.useFakeTimers(); const h = harness();
    const pending = h.adapter.inToolOperation('aborted', () => true, () => h.adapter.create(input(), vi.fn()));
    const action = h.adapter.action('aborted')!;
    const rejected = expect(pending).rejects.toThrow('aborted');
    const cleanup = h.adapter.captureCancellation()(() => true);
    expect(h.adapter.action('aborted')).toBeUndefined();
    expect(h.hook(action.tool, action.input)).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny');
    await rejected; await cleanup;
    expect(h.adapter.hasJobs).toBe(false);
    expect(h.adapter.cleanupRetirementReady).toBe(true);
    expect(h.manage).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    await h.create('replacement'); h.adapter.processClosed();
  });

  it('rejects one-shot clock rollback ambiguity rather than selecting an earlier native wall minute', async () => {
    vi.useFakeTimers(); vi.setSystemTime(Date.parse('2030-11-03T04:00:00Z'));
    const h = harness();
    const pending = h.adapter.create({ ...input(), rule: { kind: 'once', at: '2030-11-03T06:30:00Z' } },
      vi.fn(), () => true, 'America/New_York');
    await expect(pending).rejects.toThrow('clock rollback');
    await expect(pending).rejects.toBeInstanceOf(NativeScheduleNotAdmittedError);
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
    expect(error).not.toBeInstanceOf(NativeScheduleNotAdmittedError);
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

  it('rejects duplicate IDs and mismatched timezones', async () => {
    const h = harness(); await expect(h.adapter.create({ ...input(), rule: { kind: 'cron', expression: '* * * * *', timezone: 'America/New_York' } }, vi.fn())).rejects.toThrow('timezone');
    await h.create(); await expect(h.adapter.create(input(), vi.fn())).rejects.toThrow('identity');
    h.adapter.processClosed();
  });

  it.each([{ tools: ['ToolSearch'] }, { capabilities: ['msg_lifecycle_v1'] }])(
    'refuses creation before offering an action when init lacks scheduling support', async missing => {
      const h = harness();
      h.adapter.accept({ ...initialized, ...missing });
      const pending = h.adapter.inToolOperation('create', () => true, () => h.adapter.create(input(), vi.fn()));
      expect(h.adapter.action('create')).toBeUndefined();
      await expect(pending).rejects.toBeInstanceOf(NativeScheduleNotAdmittedError);
      expect(h.adapter.hasJobs).toBe(false);
      expect(h.manage).not.toHaveBeenCalled();
      h.adapter.accept(initialized);
      await h.create();
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

  describe('retained cancellation without execution recovery', () => {
    const marker = '11111111-1111-4111-8111-111111111111';
    const retained = (): NativeScheduleInput => ({ ...input(), recovery: { version: 1, provider: 'fixture',
      strategy: 'reconstruct', identity: JSON.stringify({ marker }) } });
    const row = () => ({ id: 'original-native', prompt: `[remote-cli:${marker}]\n${input().prompt}`,
      cron: '* * * * *', recurring: true, durable: false });
    const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
    function list(h: ReturnType<typeof harness>, jobs: unknown[], id: string) {
      expect(h.adapter.action('cancel')?.tool).toBe('CronList');
      expect(h.hook('CronList', {}, id)).toEqual({});
      h.adapter.accept({ type: 'user', tool_use_result: { jobs }, message: { content: [
        { type: 'tool_result', tool_use_id: id, content: 'Native inventory summary.' },
      ] } });
    }
    it.each([false, true])('verifies exact deletion or absence, never creates, and preserves siblings (absent=%s)', async absent => {
      const h = harness(); const sibling = await h.create('sibling', 'native-sibling');
      const operation = h.adapter.inToolOperation('cancel', () => true,
        () => h.adapter.cancelRetained(retained(), 'original-native', () => true, 'UTC'));
      const other = { ...row(), id: 'native-sibling', prompt: String(sibling.action.input.prompt) };
      list(h, absent ? [other] : [row(), other], 'list-before'); await settle();
      if (!absent) {
        expect(h.adapter.action('cancel')).toEqual({ tool: 'CronDelete', input: { id: 'original-native' } });
        expect(h.hook('CronDelete', { id: 'native-sibling' }, 'wrong-target')).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny');
        expect(h.hook('CronDelete', { id: 'original-native' }, 'delete')).toEqual({});
        expect(h.hook('CronDelete', { id: 'original-native' }, 'duplicate')).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny');
        h.receipt('Cancelled job original-native.', 'delete'); await settle();
      }
      list(h, [other], 'list-after'); await operation;
      expect(h.adapter.action('cancel')).toBeUndefined();
      expect(h.occurrence(row().prompt, 'cancelled-wake')).toHaveProperty('decision', 'block'); h.complete('cancelled-wake');
      expect(h.occurrence(other.prompt, 'sibling-wake')).toEqual({}); h.complete('sibling-wake');
      expect(sibling.onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'completed', success: true }));
      expect(h.manage).not.toHaveBeenCalled(); h.adapter.processClosed();
    });
    it.each(['prompt', 'marker', 'id', 'cron', 'recurring', 'durable', 'duplicate', 'missing-structure'])(
      'rejects mismatched or unavailable inventory before deletion (%s)', async variant => {
        const h = harness(); const operation = h.adapter.inToolOperation('cancel', () => true,
          () => h.adapter.cancelRetained(retained(), 'original-native', () => true, 'UTC'));
        const failure = expect(operation).rejects.toThrow();
        const entry = row(); const jobs = [entry];
        if (variant === 'prompt') entry.prompt += ' changed';
        if (variant === 'marker') entry.prompt = 'Unrelated native prompt';
        if (variant === 'id') entry.id = 'different-native';
        if (variant === 'cron') entry.cron = '0 * * * *';
        if (variant === 'recurring') entry.recurring = false;
        if (variant === 'durable') entry.durable = true;
        if (variant === 'duplicate') jobs.push({ ...entry, id: 'duplicate-native' });
        if (variant === 'missing-structure') { h.hook('CronList', {}, 'list'); h.receipt('No scheduled jobs.', 'list'); }
        else list(h, jobs, 'list');
        await failure; expect(h.adapter.action('cancel')).toBeUndefined();
        expect(h.hook('CronDelete', { id: 'original-native' })).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny');
        h.adapter.processClosed();
      });
    it('returns current-turn native actions for managed cancellation and makes request retries idempotent', async () => {
      const h = harness(); const operations = new ScheduleToolOperations(); const run = vi.fn(async (command, id) => {
        expect(command).toEqual({ kind: 'cancel', id: 'managed-fixture-target' });
        await h.adapter.inToolOperation(id, () => true,
          () => h.adapter.cancelRetained(retained(), 'original-native', () => true, 'UTC'));
        return [{ id: command.id, state: 'cancelled', backend: 'claude', rule: input().rule, prompt: input().prompt }] as any;
      });
      const scope = operations.scope({ owner: { threadId: 'fixture-thread', openId: 'fixture-owner', generation: 'fixture-generation' },
        messageId: 'fixture-message', backend: 'claude', current: () => true, run, waitMs: 1,
        nativeAction: id => h.adapter.action(id), present: async () => 'Fixture card confirmed.' });
      const request = { requestId: 'cancel-request', scheduleId: 'managed-fixture-target' };
      const inspect = () => scope.invoke('remote_cli_schedule_operation', { requestId: request.requestId }) as Promise<any>;
      try {
        const first: any = await scope.invoke('remote_cli_schedule_cancel', request);
        expect(first).toMatchObject({ status: 'pending', nativeAction: { tool: 'CronList', input: {} } });
        expect(await scope.invoke('remote_cli_schedule_cancel', request)).toEqual(first);
        expect(h.hook('CronList', {}, 'before')).toEqual({});
        h.adapter.accept({ type: 'user', tool_use_result: { jobs: [row()] }, message: { content: [
          { type: 'tool_result', tool_use_id: 'before', content: 'Inventory.' },
        ] } });
        const deletion = await inspect();
        expect(deletion.nativeAction).toEqual({ tool: 'CronDelete', input: { id: 'original-native' } });
        h.hook('CronDelete', deletion.nativeAction.input, 'delete'); h.receipt('Cancelled job original-native.', 'delete');
        expect((await inspect()).nativeAction.tool).toBe('CronList');
        h.hook('CronList', {}, 'after');
        h.adapter.accept({ type: 'user', tool_use_result: { jobs: [] }, message: { content: [
          { type: 'tool_result', tool_use_id: 'after', content: 'Inventory.' },
        ] } });
        const complete = await inspect();
        expect(complete).toMatchObject({ status: 'succeeded', records: [{ id: request.scheduleId, state: 'cancelled' }] });
        expect(complete.nativeAction).toBeUndefined();
        expect(await scope.invoke('remote_cli_schedule_cancel', request)).toEqual(complete);
        await expect(scope.invoke('remote_cli_schedule_cancel', { ...request, scheduleId: 'original-native' })).rejects.toThrow('different scheduling arguments');
        expect(run).toHaveBeenCalledOnce();
      } finally { h.adapter.processClosed(); await scope.close(); }
    });
    it.each(['omitted', 'false'])('deletes an expired one-shot without moving its original wall-clock minute (recurring=%s)', async recurrence => {
      const h = harness(); const target = { ...retained(), rule: { kind: 'once' as const, at: '2000-01-01T00:00:00Z' } };
      const operation = h.adapter.inToolOperation('cancel', () => true,
        () => h.adapter.cancelRetained(target, 'original-native', () => true, 'UTC'));
      void operation.catch(() => {}); // The awaited operation below still reports failure after action assertions.
      const { recurring: _recurring, ...entry } = row();
      list(h, [{ ...entry, cron: '0 0 1 1 *', ...(recurrence === 'false' ? { recurring: false } : {}) }], 'list'); await settle();
      expect(h.adapter.action('cancel')).toEqual({ tool: 'CronDelete', input: { id: 'original-native' } });
      h.hook('CronDelete', { id: 'original-native' }, 'delete'); h.receipt('Cancelled job original-native.', 'delete'); await settle();
      list(h, [], 'confirmed'); await operation; h.adapter.processClosed();
    });
    it.each([true, null, 0, 1, 'false', 'true', [], {}, undefined])(
      'rejects mismatched or malformed one-shot recurrence (%j) before deletion', async recurring => {
        const h = harness(); const target = { ...retained(), rule: { kind: 'once' as const, at: '2000-01-01T00:00:00Z' } };
        const operation = h.adapter.inToolOperation('cancel', () => true,
          () => h.adapter.cancelRetained(target, 'original-native', () => true, 'UTC'));
        const failure = expect(operation).rejects.toThrow();
        list(h, [{ ...row(), cron: '0 0 1 1 *', recurring }], 'list');
        await failure;
        expect(h.adapter.action('cancel')).toBeUndefined();
        expect(h.hook('CronDelete', { id: 'original-native' })).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny');
        expect(h.manage).not.toHaveBeenCalled(); h.adapter.processClosed();
      });
    it('does not interpret omitted recurrence as a recurring job', async () => {
      const h = harness();
      const operation = h.adapter.inToolOperation('cancel', () => true,
        () => h.adapter.cancelRetained(retained(), 'original-native', () => true, 'UTC'));
      const failure = expect(operation).rejects.toThrow('definition or ownership changed');
      const { recurring: _recurring, ...entry } = row();
      list(h, [entry], 'list'); await failure;
      expect(h.hook('CronDelete', { id: 'original-native' })).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny');
      h.adapter.processClosed();
    });
    it('fences late authorized receipts, retries from fresh inventory, and rejects stale scopes', async () => {
      const h = harness(); let current = true;
      const run = () => h.adapter.inToolOperation('cancel', () => current,
        () => h.adapter.cancelRetained(retained(), 'original-native', () => current, 'UTC'));
      const first = run(); const failure = expect(first).rejects.toThrow('no longer current');
      list(h, [row()], 'before'); await settle();
      h.hook('CronDelete', { id: 'original-native' }, 'late-delete');
      h.adapter.foregroundEnded(); await failure;
      h.adapter.foregroundDispatched('retry-foreground');
      await expect(run()).rejects.toThrow('receipt remains unresolved');
      h.receipt('Cancelled job original-native.', 'late-delete');
      const retry = run(); list(h, [], 'retry-before'); await settle(); list(h, [], 'retry-after'); await retry;
      const stale = run(); const staleFailure = expect(stale).rejects.toThrow('ended'); current = false;
      expect(h.hook('CronList', {}, 'stale')).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny');
      h.adapter.foregroundEnded(); await staleFailure; h.adapter.processClosed();
    });
    it('does not mistake process exit for a still-current native deletion receipt', async () => {
      const h = harness(); const job = await h.create();
      expect(job.handle.nativeDefinitionAbsent).toBe(false);
      const cancellation = h.adapter.inToolOperation('cancel', () => true, () => job.handle.cancel());
      h.hook('CronDelete', { id: 'native-one' }, 'delete'); h.receipt('Cancelled job native-one.', 'delete');
      await cancellation; expect(job.handle.nativeDefinitionAbsent).toBe(true);
      h.adapter.processClosed(); expect(job.handle.nativeDefinitionAbsent).toBe(false);
    });
    it('does not revoke an already admitted sibling occurrence to obtain cleanup admission', async () => {
      const h = harness(); const sibling = await h.create('sibling', 'native-sibling');
      expect(h.occurrence(String(sibling.action.input.prompt))).toEqual({});
      await expect(h.adapter.inToolOperation('cancel', () => true,
        () => h.adapter.cancelRetained(retained(), 'original-native', () => true, 'UTC'))).rejects.toThrow('idle original session');
      expect(h.adapter.action('cancel')).toBeUndefined();
      h.complete(); expect(sibling.onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'completed', success: true }));
      h.adapter.processClosed();
    });
    it('retains failed cleanup without blocking an unrelated admitted native occurrence', async () => {
      const h = harness(); const sibling = await h.create('sibling', 'native-sibling');
      const operation = h.adapter.inToolOperation('cancel', () => true,
        () => h.adapter.cancelRetained(retained(), 'original-native', () => true, 'UTC'));
      const failure = expect(operation).rejects.toThrow('different definition');
      list(h, [{ ...row(), prompt: 'Unrelated native prompt' }], 'mismatch'); await failure;
      expect(h.occurrence(String(sibling.action.input.prompt))).toEqual({}); h.complete();
      expect(sibling.onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'completed', success: true }));
      h.adapter.processClosed();
    });
  });

  it('does not activate management or consume ordinary frames when never used', () => {
    const h = harness();
    expect(h.adapter.accept({ type: 'result', is_error: false })).toBe(false);
    expect(h.hook('Read', { file_path: 'synthetic' })).toEqual({});
    expect(h.adapter.hasJobs).toBe(false); expect(h.manage).not.toHaveBeenCalled();
    h.adapter.processClosed();
  });
});
