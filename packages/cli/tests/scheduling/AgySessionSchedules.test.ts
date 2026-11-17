import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgySessionSchedules } from '../../src/scheduling/agy/AgySessionSchedules';
import { NativeScheduleCleanupError } from '../../src/scheduling/types';
import type { NativeScheduleEvent, NativeScheduleInput, NativeScheduleToolAction } from '../../src/scheduling/types';
import { NOTIFICATION_PREFIX, type TranscriptRecord } from '../../src/scheduling/agy/transcript';

const cwd = process.cwd();
const session = 'synthetic-session';
const input = (id = 'job-a', prompt = 'Equal work'): NativeScheduleInput => ({ id, backend: 'agy', threadId: 'synthetic-thread', cwd, prompt,
  rule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' } });
function harness() {
  let cursor = 0;
  let invocationStart = 0;
  const records: TranscriptRecord[] = [];
  const tasks = new Map<string, string>();
  const current = vi.fn(() => true);
  const events: NativeScheduleEvent[] = [];
  let override: ((action: NativeScheduleToolAction) => Promise<{ stopReason: string }>) | undefined;
  const bridge = new AgySessionSchedules({ sessionId: session, threadId: 'synthetic-thread', hostId: 'synthetic-host', cwd, timezone: 'UTC', timeoutMs: 20,
    isCurrent: current, manage: async action => override ? override(action) : manage(action) });
  const hook = (event: string, extra: Record<string, unknown> = {}) => bridge.accept(event,
    { conversationId: session, cwd, hookEventName: event,
      ...(event === 'PostInvocation' ? { initialNumSteps: invocationStart, invocationNum: 0 } : {}), ...extra }, records);
  const record = (type: string, content: string, source = 'MODEL', status = 'DONE', step = cursor++) => {
    const row = { step_index: step, type, source, status, content };
    const index = records.findIndex(r => r.step_index === step);
    if (index === -1) records.push(row); else records[index] = row;
    return row;
  };
  const begin = () => { invocationStart = cursor; return hook('PreInvocation', { initialNumSteps: cursor, invocationNum: 0 }); };
  const stop = (output = 'Native result') => {
    record('PLANNER_RESPONSE', output);
    hook('PostInvocation'); hook('Stop', { terminationReason: 'NO_TOOL_CALL', error: '', fullyIdle: true });
  };
  const tool = (action: NativeScheduleToolAction, step = cursor++) => {
    const decision = hook('PreToolUse', { stepIdx: step, toolCall: { id: `call-${step}`, name: action.tool, args: action.input } });
    return { decision, step };
  };
  const manage = async (action: NativeScheduleToolAction) => {
    hook('SessionStart'); begin();
    const { decision, step } = tool(action);
    expect(decision).toEqual({ decision: 'allow' });
    let text = '';
    if (action.tool === 'schedule') {
      const id = `${session}/task-${step}`;
      tasks.set(id, action.input.Prompt as string);
      text = `Tool is running as a background task with task id: ${id}\nTask Description: Timer: synthetic, Prompt: ${action.input.Prompt}\nTask logs are available at: file://synthetic/log`;
      record('GENERIC', text, 'MODEL', 'RUNNING', step);
    } else {
      if (action.input.Action === 'kill') {
        tasks.delete(action.input.TaskId as string); text = `Task "${action.input.TaskId}" cancelled.`;
      } else text = tasks.size ? `You have ${tasks.size} background task(s) currently running:\n` + JSON.stringify([...tasks].map(([taskId, prompt]) => ({ taskId, toolName: 'schedule', description: `Timer: synthetic, Prompt: ${prompt}`, isDaemon: true })))
        : 'No background tasks are currently running.';
      record('GENERIC', `Created At: synthetic\nCompleted At: synthetic\n${text}`, 'MODEL', 'DONE', step);
    }
    stop('Management done'); return { stopReason: 'end_turn' };
  };
  const wake = (id: string, prompt = 'Equal work (iteration 1)', source = 'SYSTEM') => record('SYSTEM_MESSAGE',
    `${NOTIFICATION_PREFIX}[Message] timestamp=2030-01-01T00:00:00Z sender=${id} priority=MESSAGE_PRIORITY_HIGH content=${prompt}\n</SYSTEM_MESSAGE>`, source);
  return { bridge, records, tasks, current, events, hook, begin, stop, record, tool, wake, manage,
    override: (fn: typeof override) => { override = fn; },
    create: (id = 'job-a', prompt = 'Equal work', admit?: () => boolean) => bridge.create(input(id, prompt), event => events.push(event), admit) };
}

describe('AGY original-session native provider', () => {
  it('distinguishes an admitted scope from an unsettled or failed native receipt', async () => {
    const h = harness(); await h.bridge.qualify();
    let entered!: () => void, fail!: (error: Error) => void;
    const admission = new Promise<void>(resolve => { entered = resolve; });
    h.override(async () => { entered(); return new Promise((_, reject) => { fail = reject; }); });
    await h.bridge.withOperation('synthetic-operation', () => true, async () => {
      expect(h.bridge.pendingMutation).toBe(true);
      expect(h.bridge.cleanupMutationPending).toBe(false);
      const creating = h.create();
      const rejected = expect(creating).rejects.toBeInstanceOf(NativeScheduleCleanupError);
      await admission;
      expect(h.bridge.cleanupMutationPending).toBe(true);
      fail(new Error('Synthetic unknown native mutation'));
      await rejected;
    }, false);
    expect(h.bridge.pendingMutation).toBe(false);
    expect(h.bridge.cleanupMutationPending).toBe(true);
    h.bridge.processClosed(false);
    expect(h.bridge.cleanupMutationPending).toBe(true);
    h.bridge.processClosed(true);
    expect(h.bridge.cleanupMutationPending).toBe(false);
  });

  it('retains a new occurrence when a stale Stop arrives before its invocation has finished', async () => {
    const h = harness(); await h.bridge.qualify(); const a = await h.create();
    h.begin(); h.wake(a.nativeId); h.stop();
    h.begin(); h.wake(a.nativeId, 'Equal work (iteration 2)');
    h.hook('Stop', { executionNum: 0, terminationReason: 'NO_TOOL_CALL', error: '' });
    expect(h.events.filter(e => e.type === 'completed')).toHaveLength(1);
    expect(h.bridge.status.blocked).toBeTruthy();
  });
  it('does not admit a first wake after its definition was cancelled', async () => {
    const h = harness(); await h.bridge.qualify(); const a = await h.create(); await a.cancel();
    h.begin(); h.wake(a.nativeId); h.stop();
    expect(h.events.filter(e => e.type === 'started' || e.type === 'completed')).toEqual([]);
    expect(h.bridge.status.blocked).toBeTruthy();
  });
  it('rechecks a wake admission predicate after PreInvocation', async () => {
    const h = harness(); await h.bridge.qualify(); let allowed = true;
    const a = await h.create('job-a', 'Equal work', () => allowed);
    h.begin(); allowed = false; h.wake(a.nativeId); h.stop();
    expect(h.events.filter(e => e.type === 'started' || e.type === 'completed')).toEqual([]);
    expect(h.bridge.status.blocked).toBeTruthy();
  });
  it('rechecks original host ownership after PreInvocation', async () => {
    const h = harness(); await h.bridge.qualify(); const a = await h.create();
    h.begin(); h.current.mockReturnValue(false); h.wake(a.nativeId); h.stop();
    expect(h.events.filter(e => e.type === 'started' || e.type === 'completed')).toEqual([]);
    expect(h.bridge.status.blocked).toBeTruthy();
  });
  it('does not settle a foreground prompt from the previous management Stop', async () => {
    const h = harness(); await h.bridge.qualify();
    h.bridge.beginForeground(); h.begin();
    h.hook('Stop', { executionNum: 0, terminationReason: 'NO_TOOL_CALL', error: '' });
    expect(h.bridge.endForeground()).toBeUndefined();
    expect(h.bridge.status.blocked).toBeTruthy();
  });
  it('rejects a stale PostInvocation even when native invocation counters reset', async () => {
    const h = harness(); await h.bridge.qualify(); const a = await h.create();
    h.begin(); h.wake(a.nativeId); h.record('PLANNER_RESPONSE', 'Current output');
    h.hook('PostInvocation', { initialNumSteps: 0, invocationNum: 0 });
    h.hook('Stop', { executionNum: 0, terminationReason: 'NO_TOOL_CALL', error: '' });
    expect(h.events.filter(e => e.type === 'completed')).toEqual([]);
    expect(h.bridge.status.blocked).toBeTruthy();
  });
  it('retains uncertain work if output changes between PostInvocation and Stop', async () => {
    const h = harness(); await h.bridge.qualify(); const a = await h.create();
    h.begin(); h.wake(a.nativeId); const row = h.record('PLANNER_RESPONSE', 'Observed output');
    h.hook('PostInvocation'); row.content = 'Rewritten output';
    h.hook('Stop', { executionNum: 0, terminationReason: 'NO_TOOL_CALL', error: '' });
    expect(h.events.filter(e => e.type === 'completed')).toEqual([]);
    expect(h.bridge.status.blocked).toBeTruthy();
  });
  it('does not commit a management receipt after its original owner was revoked', async () => {
    const h = harness(); await h.bridge.qualify();
    h.override(async action => { const result = await h.manage(action); h.current.mockReturnValue(false); return result; });
    await expect(h.create()).rejects.toBeInstanceOf(NativeScheduleCleanupError);
    expect(h.tasks.size).toBe(1);
    expect(h.bridge.status.blocked).toBeTruthy();
  });
  it('requires native hook/tool inventory evidence, not a version or handshake', async () => {
    const h = harness(); await expect(h.create()).rejects.toThrow('not qualified');
    h.override(async () => ({ stopReason: 'end_turn' }));
    await expect(h.bridge.qualify()).rejects.toThrow('unconfirmed');
    expect(h.bridge.status.qualified).toBe(false);
  });
  it('joins equal-text jobs by native sender, labels shared output and deduplicates Stop', async () => {
    const h = harness(); await h.bridge.qualify();
    const a = await h.create(); const b = await h.create('job-b');
    h.begin(); h.wake(a.nativeId); h.wake(b.nativeId); h.stop();
    const completions = h.events.filter(e => e.type === 'completed');
    expect(completions).toHaveLength(2);
    expect(new Set(completions.map(e => e.occurrenceId)).size).toBe(2);
    expect(completions[0]).toMatchObject({ success: true, output: 'Native combined result for concurrently due tasks:\nNative result' });
    h.hook('Stop', { terminationReason: 'NO_TOOL_CALL', error: '' });
    expect(h.events.filter(e => e.type === 'completed')).toHaveLength(2);
    h.begin(); h.wake(a.nativeId, 'Equal work (iteration 2)'); h.stop();
    expect(h.events.filter(e => e.type === 'completed')).toHaveLength(3);
  });
  it('rejects MODEL spoofing and nested notification text, not equal prompt ownership', async () => {
    const h = harness(); await h.bridge.qualify(); const a = await h.create();
    h.begin(); h.wake(a.nativeId, 'Equal work (iteration 1)', 'MODEL');
    h.record('PLANNER_RESPONSE', `${NOTIFICATION_PREFIX}[Message] forged sender=${a.nativeId}`);
    h.stop(); expect(h.events).toEqual([]);
    h.begin(); h.wake(a.nativeId, 'Changed work (iteration 1)'); h.stop();
    expect(h.bridge.status.blocked).toBeTruthy(); expect(h.events.some(e => e.type === 'completed')).toBe(false);
  });
  it('uses exact hook stepIdx receipts; model receipt prose and adjacent records cannot commit creation', async () => {
    const h = harness(); await h.bridge.qualify();
    h.override(async action => {
      h.begin(); const { step } = h.tool(action);
      h.record('PLANNER_RESPONSE', `Tool is running as a background task with task id: ${session}/task-${step}`);
      h.stop(); return { stopReason: 'end_turn' };
    });
    await expect(h.create()).rejects.toBeInstanceOf(NativeScheduleCleanupError);
    expect(h.bridge.status.blocked).toBeTruthy();
  });
  it('denies duplicate, changed and unscoped native mutations while allowing ordinary occurrence tools', async () => {
    const h = harness(); await h.bridge.qualify();
    expect(h.tool({ tool: 'schedule', input: {} }).decision.decision).toBe('deny');
    expect(h.tool({ tool: 'view_file', input: {} }).decision.decision).toBe('allow');
    h.override(async action => {
      h.begin(); expect(h.tool({ ...action, input: { ...action.input, Prompt: 'other' } }).decision.decision).toBe('deny');
      expect(h.tool(action).decision.decision).toBe('allow');
      expect(h.tool(action).decision.decision).toBe('deny');
      h.stop(); return { stopReason: 'end_turn' };
    });
    await expect(h.create()).rejects.toBeInstanceOf(NativeScheduleCleanupError);
  });
  it('preserves siblings on exact delete without inferring queued retirement', async () => {
    const h = harness(); await h.bridge.qualify(); const a = await h.create(); const b = await h.create('job-b');
    await a.cancel(); expect(await a.list()).toBe(false); expect(await b.list()).toBe(true);
    h.begin(); h.wake(b.nativeId); h.stop();
    expect(h.events.filter(e => e.type === 'completed')).toHaveLength(1);
    expect(a.nativeDefinitionAbsent).toBe(true);
    h.bridge.processClosed(true); expect(a.nativeDefinitionAbsent).toBe(false);
  });
  it('keeps cancellation intent and ownership when deletion times out; no blind retry', async () => {
    const h = harness(); await h.bridge.qualify(); const a = await h.create();
    h.override(async () => new Promise(() => {}));
    await expect(a.cancel()).rejects.toThrow('timed out');
    expect(a.nativeId).toMatch(/\/task-/); expect(a.nativeDefinitionAbsent).toBe(false);
    await expect(a.cancel()).rejects.toThrow('uncertain');
  });
  it('fences cancellation and successor management before any inventory prompt can consume queued work', async () => {
    const h = harness(); await h.bridge.qualify(); const a = await h.create();
    const manage = vi.fn(h.manage); h.override(manage);
    h.bridge.foregroundCancelled();
    await expect(a.list()).rejects.toThrow('queued'); await expect(a.cancel()).rejects.toThrow('queued');
    await expect(h.create('another')).rejects.toThrow('queued'); expect(manage).not.toHaveBeenCalled();
    expect(h.bridge.status).not.toHaveProperty('recovery');
    expect('recoveryFor' in h.bridge).toBe(false);
  });
  it('blocks admission before model invocation when owner/generation changes, including throwing guards', async () => {
    const h = harness(); await h.bridge.qualify(); const admit = vi.fn(() => true); await h.create('job-a', 'Equal work', admit);
    admit.mockImplementation(() => { throw new Error('Synthetic owner unavailable'); });
    expect(h.begin()).toMatchObject({ terminationBehavior: 'terminate' });
    expect(h.bridge.status.blocked).toBeTruthy();
  });
  it('allows native earlier GENERIC revisions but fences compaction/rewrite of delivered evidence', async () => {
    const h = harness(); await h.bridge.qualify(); const a = await h.create();
    h.records.find(r => r.status === 'RUNNING')!.status = 'DONE';
    h.begin(); const wake = h.wake(a.nativeId); h.stop();
    expect(h.bridge.status.blocked).toBeUndefined();
    wake.content += ' changed'; h.hook('PostToolUse');
    expect(h.bridge.status.blocked).toBeTruthy();
  });
  it('rejects mismatched session/cwd, timezone, past one-shot and occupied foreground without mutation', async () => {
    const h = harness(); await h.bridge.qualify();
    await expect(h.bridge.create({ ...input(), rule: { kind: 'cron', expression: '* * * * *', timezone: 'Asia/Shanghai' } }, () => {})).rejects.toThrow('timezone');
    await expect(h.bridge.create({ ...input(), rule: { kind: 'once', at: '2000-01-01T00:00:00Z' } }, () => {})).rejects.toThrow('seven days');
    h.bridge.beginForeground(); await expect(h.create()).rejects.toThrow(); h.bridge.endForeground();
    h.hook('PreInvocation', { cwd: 'other', initialNumSteps: 100 });
    expect(h.bridge.status.blocked).toBeTruthy();
  });
  it('does not launch cleanup inference from a completed one-shot or block later foreground admission', async () => {
    const h = harness(); await h.bridge.qualify(); let admitted = true;
    const handle = await h.bridge.create({ ...input(), rule: { kind: 'once', at: new Date(Date.now() + 60000).toISOString() } },
      event => { h.events.push(event); if (event.type === 'completed') admitted = false; }, () => admitted);
    h.begin(); h.wake(handle.nativeId, 'Equal work'); h.stop();
    h.override(async () => { throw new Error('No cleanup model turn is allowed'); });
    await handle.stop();
    h.bridge.beginForeground(); expect(h.begin()).toEqual({}); h.stop('Later foreground');
    expect(h.bridge.endForeground()).toEqual({ success: true, output: 'Later foreground' });
    expect(handle.retirementConfirmed).toBe(false); expect(handle.nativeDefinitionAbsent).toBe(false);
  });
  it('reports unconfirmed retirement explicitly and accepts later proven group exit without replay', async () => {
    const h = harness(); await h.bridge.qualify(); await h.create();
    h.bridge.processClosed(false); expect(h.events.at(-1)).toMatchObject({ type: 'stopped', exitConfirmed: false });
    h.bridge.processClosed(true); expect(h.events.at(-1)).toMatchObject({ type: 'stopped', exitConfirmed: true });
    await expect(h.create('later')).rejects.toThrow();
  });
  it('records admission before Stop and joins a late authoritative result after an uncertain interruption', async () => {
    const h = harness(); await h.bridge.qualify(); const a = await h.create();
    h.begin(); h.wake(a.nativeId); h.hook('PostInvocation');
    expect(h.events.at(-1)).toMatchObject({ type: 'started' });
    h.bridge.fence('Synthetic uncertain foreground cancellation'); h.stop();
    expect(h.events.at(-1)).toMatchObject({ type: 'completed', success: true });
  });
  it('joins an already observed wake after cancellation intent without admitting another wake', async () => {
    const h = harness(); await h.bridge.qualify(); const a = await h.create();
    h.begin(); h.wake(a.nativeId); h.hook('PostInvocation');
    await expect(a.cancel()).rejects.toThrow('busy');
    h.stop();
    expect(h.events.filter(e => e.type === 'completed')).toHaveLength(1);
  });
  it('rejects another thread before creating a native definition', async () => {
    const h = harness(); await h.bridge.qualify();
    await expect(h.bridge.create({ ...input(), threadId: 'other-thread' }, () => {})).rejects.toThrow('not qualified');
    expect(h.tasks.size).toBe(0);
  });
  it('bounds output explicitly and reports failed native terminals without a fake success', async () => {
    const h = harness(); await h.bridge.qualify(); const a = await h.create();
    h.begin(); h.wake(a.nativeId); h.stop('x'.repeat(300 * 1024));
    expect(h.events.find(e => e.type === 'completed')).toMatchObject({ output: expect.stringContaining('[Native output truncated]') });
    h.begin(); h.wake(a.nativeId, 'Equal work (iteration 2)'); h.hook('PostInvocation');
    h.hook('Stop', { terminationReason: 'ERROR', error: 'synthetic' });
    expect(h.events.at(-1)).toMatchObject({ type: 'completed', success: false });
  });
});


describe('AGY before-first-wake quiescence proof', () => {
  afterEach(() => vi.restoreAllMocks());
  const clock = () => vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2030-01-01T00:00:05Z'));
  it('permits captured cancellation/exit only before the native first possible wake', async () => {
    const time = clock(); const h = harness(); await h.bridge.qualify(); await h.create();
    const check = h.bridge.cancellationWindow();
    h.bridge.foregroundCancelled(); h.bridge.processClosed(true); expect(check).not.toThrow();
    time.mockReturnValue(Date.parse('2030-01-01T00:01:00Z'));
    expect(check).toThrow('deadline');
  });
  it('retires an exactly deleted never-fired job without retiring its live sibling', async () => {
    clock(); const h = harness(); await h.bridge.qualify(); const first = await h.create(); const sibling = await h.create('job-b');
    await h.bridge.withOperation('cancel-first', () => true, () => first.cancel(), false);
    expect(first.retirementConfirmed).toBe(true); expect(sibling.retirementConfirmed).toBe(false);
    expect(await sibling.list()).toBe(true); expect(h.bridge.cancellationWindow()).toBeTypeOf('function');
  });
  it('rejects unknown native tools, foreign SYSTEM senders and provider faults after capture', async () => {
    clock();
    for (const invalidate of [
      (h: ReturnType<typeof harness>) => h.tool({ tool: 'run_command', input: {} }),
      (h: ReturnType<typeof harness>) => { h.wake('external-session/task-42'); h.hook('PostToolUse'); },
      (h: ReturnType<typeof harness>) => h.bridge.fence('Relay lost authenticated evidence'),
    ]) {
      const h = harness(); await h.bridge.qualify(); await h.create(); const check = h.bridge.cancellationWindow();
      invalidate(h); expect(check).toThrow();
    }
  });
  it('never treats an observed completed cron occurrence as an empty queue', async () => {
    clock(); const h = harness(); await h.bridge.qualify(); const job = await h.create();
    h.begin(); h.wake(job.nativeId); h.stop();
    expect(() => h.bridge.cancellationWindow()).toThrow('never-fired');
  });
  it('rejects incomplete foreground or a deadline whose setup has already consumed the margin', async () => {
    const time = clock(); const h = harness(); await h.bridge.qualify(); await h.create();
    h.bridge.beginForeground(); h.begin();
    expect(() => h.bridge.cancellationWindow()).toThrow('never-fired');
    expect(h.bridge.cancellationWindow(true)).toBeTypeOf('function');
    time.mockReturnValue(Date.parse('2030-01-01T00:00:59.500Z'));
    expect(() => h.bridge.cancellationWindow(true)).toThrow('deadline');
  });
});
