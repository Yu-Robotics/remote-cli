import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { AcpEventCallbacks } from '../../src/executor/acp/AcpClient';
import type { HookPayload } from '../../src/scheduling/agy/AgySessionSchedules';
import type { TranscriptRecord } from '../../src/scheduling/agy/transcript';
import { NOTIFICATION_PREFIX } from '../../src/scheduling/agy/transcript';
import { createExecutor } from '../../src/executor';
import { AgyExecutor } from '../../src/executor/AgyExecutor';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';

const native = vi.hoisted(() => ({
  clients: [] as any[], accept: undefined as any, fault: undefined as any,
  restore: vi.fn(async () => {}), configure: vi.fn(async () => {}), bind: vi.fn(),
  nativeAvailable: true, exitConfirmed: true, home: '', initializeWait: undefined as Promise<void> | undefined,
}));
vi.mock('os', async importOriginal => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => native.home, default: { ...actual, homedir: () => native.home } };
});
vi.mock('../../src/native/NativeBindings', () => ({ nativeBindings: () => {
  if (!native.nativeAvailable) throw new Error('Synthetic helper unavailable');
  return { readChunk: () => {}, openOutputChild: () => {} };
} }));
vi.mock('../../src/executor/agy/AgyDelegationConfig', () => ({ configureAgyDelegation: native.configure }));
vi.mock('../../src/scheduling/agy/AgyHookRelay', () => ({
  installAgyScheduleHooks: async () => native.restore,
  AgyHookRelay: class {
    constructor(_home: string, accept: any, fault: any) { native.accept = accept; native.fault = fault; }
    async start() { return { url: 'http://127.0.0.1:1/hook', token: 'synthetic-token' }; }
    bindSession = native.bind;
    async close() {}
  },
}));
vi.mock('../../src/executor/acp/AcpClient', () => ({ AcpClient: class {
  session = 'synthetic-session'; token: object | undefined = {}; cursor = 0; rows: TranscriptRecord[] = [];
  tasks = new Map<string, string>(); prompts: string[] = []; cancelled = false; closed = false;
  release?: (value: { stopReason: string }) => void;
  exited: Promise<void>; onExit!: () => void;
  constructor(public command: string, public args: string[], public cwd: string, public callbacks: AcpEventCallbacks, _managed: boolean, public launch: any) {
    native.clients.push(this); this.exited = new Promise(resolve => { this.onExit = resolve; });
  }
  async initialize() { await native.initializeWait; return {}; }
  async newSession() { return { sessionId: this.session }; }
  async loadSession(id: string) {
    this.session = id;
    const predecessor = native.clients.at(-2);
    if (predecessor) { this.rows = structuredClone(predecessor.rows); this.cursor = predecessor.cursor; }
    this.token = undefined;
    return { sessionId: id };
  }
  sessionAdmission(id: string) { return id === this.session ? this.token : undefined; }
  invocationStart = 0;
  hook(event: string, extra: Record<string, unknown> = {}) {
    if (event === 'PreInvocation') this.invocationStart = extra.initialNumSteps as number;
    return native.accept(event, { conversationId: this.session, cwd: this.cwd, hookEventName: event,
      ...(['PreInvocation', 'PostInvocation'].includes(event) ? { invocationNum: 0, initialNumSteps: this.invocationStart } : {}), ...extra }, this.rows);
  }
  row(type: string, content: string, source = 'MODEL', status = 'DONE', step = this.cursor++) {
    this.rows.push({ type, content, source, status, step_index: step });
  }
  tool(action: { tool: string; input: any }) {
    const step = this.cursor++;
    const decision = this.hook('PreToolUse', { stepIdx: step, toolCall: { id: `call-${step}`, name: action.tool, args: action.input } });
    expect(decision).toEqual({ decision: 'allow' });
    if (action.tool === 'schedule') {
      const id = `${this.session}/task-${step}`;
      const description = `Timer: synthetic, Prompt: ${action.input.Prompt}`;
      this.tasks.set(id, description);
      this.row('GENERIC', `Tool is running as a background task with task id: ${id}\nTask Description: ${description}\nTask logs are available at: file://synthetic/log`, 'MODEL', 'RUNNING', step);
    } else if (action.input.Action === 'kill') {
      this.tasks.delete(action.input.TaskId);
      this.row('GENERIC', `Task "${action.input.TaskId}" cancelled.`, 'MODEL', 'DONE', step);
    } else {
      this.row('GENERIC', this.tasks.size ? `You have ${this.tasks.size} background task(s) currently running:\n` + JSON.stringify([...this.tasks].map(([taskId, description]) => ({ taskId, description, toolName: 'schedule', isDaemon: true })))
        : 'No background tasks are currently running.', 'MODEL', 'DONE', step);
    }
    this.hook('PostToolUse');
  }
  finish(text = 'Synthetic result') {
    this.row('PLANNER_RESPONSE', text); this.hook('PostInvocation');
    this.hook('Stop', { terminationReason: 'NO_TOOL_CALL', error: '' });
  }
  async prompt(_id: string, blocks: any[]) {
    const text = blocks[0].text; this.prompts.push(text);
    this.hook('SessionStart'); this.hook('PreInvocation', { initialNumSteps: this.cursor });
    if (text === 'hold') return new Promise<{ stopReason: string }>(resolve => { this.release = resolve; });
    if (text.startsWith('Execute exactly this native tool once')) this.tool(JSON.parse(text.slice(text.indexOf('\n') + 1)));
    this.callbacks.onTextChunk?.({ type: 'text', text: 'Synthetic streamed text' });
    this.finish(); return { stopReason: 'end_turn' };
  }
  sendCancel() { this.token = undefined; this.cancelled = true; this.hook('PostToolUse'); this.release?.({ stopReason: 'cancelled' }); }
  destroy() { this.closed = true; this.token = undefined; this.release?.({ stopReason: 'cancelled' }); this.onExit(); }
  waitForExit() { return this.exited; }
  async waitForManagedProcessGroupExit() { if (!native.exitConfirmed) throw new Error('Synthetic group unconfirmed'); }
} }));

let home: string, cwd: string, executor: AgyExecutor;
const last = () => native.clients.at(-1)!;
const input = () => ({ backend: 'agy' as const, threadId: 'synthetic-thread', id: 'job-a', cwd, prompt: 'Equal work',
  model: 'synthetic-model', effort: 'high', rule: { kind: 'cron' as const, expression: '* * * * *', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } });
const make = () => createExecutor(new DirectoryGuard([cwd]), { type: 'agy', agy: { model: 'synthetic-model' } }, cwd, 'synthetic-thread', undefined, 'high') as AgyExecutor;
beforeEach(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agy-entry-'))); cwd = path.join(home, 'work'); await fs.mkdir(cwd);
  native.home = home; vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home);
  native.clients.length = 0; native.initializeWait = undefined; native.nativeAvailable = true; native.exitConfirmed = true;
  native.restore.mockClear(); native.configure.mockClear(); native.bind.mockClear();
  executor = make();
});
afterEach(async () => { native.exitConfirmed = true; await executor.destroy(); await fs.rm(home, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('AGY production fresh-session entry (synthetic native records)', () => {
  it.each([false, true])('refuses saved no-journal ACP chat but explicit clear preserves old history and erasure fences (retired=%s)', async retired => {
    await executor.execute('hello'); await executor.destroy();
    const pointer = path.join(home, '.remote-cli', 'agy-sessions', 'synthetic-thread.json');
    const original = { id: 'synthetic-old-session', transport: 'acp', retired };
    await fs.writeFile(pointer, JSON.stringify(original));
    if (retired) await fs.writeFile(pointer + '.checkpoint', 'Legacy diagnostic evidence');
    const history = path.join(home, '.remote-cli', 'agy-homes', 'synthetic-thread', 'history.fixture');
    await fs.writeFile(history, 'Original native history');
    executor = make(); const count = native.clients.length;
    await expect(executor.execute('unsafe resume')).rejects.toThrow('cannot safely resume');
    await expect(executor.compactWhenFull()).rejects.toThrow('explicit /clear');
    await expect(executor.deleteThreadData('synthetic-thread')).rejects.toThrow('unconfirmed');
    expect(native.clients).toHaveLength(count);
    await executor.resetContext(); expect(executor.getSessionId()).toBeNull();
    expect(await fs.readFile(history, 'utf8')).toBe('Original native history');
    const archive = pointer + '.detached-acp';
    const files = await fs.readdir(archive); expect(files).toHaveLength(1);
    expect(JSON.parse(await fs.readFile(path.join(archive, files[0]), 'utf8'))).toEqual({ session: original, retirement: 'unconfirmed', ...(retired ? { legacyCheckpoint: 'Legacy diagnostic evidence' } : {}) });
    await executor.destroy(); executor = make();
    await executor.execute('fresh chat'); expect(native.clients).toHaveLength(count + 1);
    expect(executor.getSessionId()).not.toBe(original.id);
    await expect(executor.deleteThreadData('synthetic-thread')).rejects.toThrow('Detached');
    expect(await fs.readFile(history, 'utf8')).toBe('Original native history');
  });

  it('leaves the selected ACP pointer intact if explicit-detach evidence cannot be saved', async () => {
    await executor.execute('hello'); await executor.destroy(); executor = make();
    const pointer = path.join(home, '.remote-cli', 'agy-sessions', 'synthetic-thread.json');
    const original = await fs.readFile(pointer, 'utf8');
    await fs.writeFile(pointer + '.detached-acp', 'Synthetic storage obstruction');
    await expect(executor.resetContext()).rejects.toThrow();
    expect(await fs.readFile(pointer, 'utf8')).toBe(original);
    await expect(executor.execute('unsafe resume')).rejects.toThrow('cannot safely resume');
    expect(native.clients).toHaveLength(1);
  });

  it('keeps explicit ACP clear fenced by a checkpoint transition or retained schedule owner', async () => {
    await executor.execute('hello'); await executor.destroy(); executor = make();
    const pointer = path.join(home, '.remote-cli', 'agy-sessions', 'synthetic-thread.json');
    await fs.writeFile(pointer + '.checkpoint.lock', 'synthetic lock');
    await expect(executor.resetContext()).rejects.toThrow('checkpoint transition');
    await fs.unlink(pointer + '.checkpoint.lock');
    await fs.writeFile(pointer + '.native-schedules', JSON.stringify({ sessionId: 'synthetic-session', hostId: 'synthetic-host', retired: false }));
    await executor.destroy(); executor = make();
    await expect(executor.resetContext()).rejects.toThrow('unconfirmed');
    expect(executor.getSessionId()).toBe('synthetic-session');
    expect(native.clients).toHaveLength(1);
  });

  it('keeps factory/chat/schedule on the same original host, retaining settings and private HOME', async () => {
    const stream = vi.fn(), display = vi.fn();
    expect(native.clients).toHaveLength(0);
    await executor.execute('hello', { onStream: stream, onDisplayText: display, resolvePrompt: id => `hello ${id}` });
    const client = last(); expect(client.prompts[0]).toBe('hello synthetic-session');
    expect(client.args).toContain('acp'); expect(client.args).toContain('synthetic-model'); expect(client.args).toContain('high');
    expect(client.launch.env.HOME).toBe(path.join(home, '.remote-cli', 'agy-homes', 'synthetic-thread'));
    expect(client.launch.env.USERPROFILE).toBe(client.launch.env.HOME);
    expect(stream).toHaveBeenCalledWith('Synthetic streamed text'); expect(display).toHaveBeenCalled();
    const events: any[] = [];
    const handle = await executor.withNativeScheduleOperation('op', () => true, () => executor.createNativeSchedule(input(), e => events.push(e)), false);
    expect(native.clients).toHaveLength(1); expect(handle.nativeId).toMatch(/^synthetic-session\/task-/);
    const retained = JSON.parse(await fs.readFile(path.join(home, '.remote-cli', 'agy-sessions', 'synthetic-thread.json.native-schedules'), 'utf8'));
    expect(retained).toMatchObject({ sessionId: executor.getSessionId(), retired: false });
    client.hook('PreInvocation', { initialNumSteps: client.cursor });
    client.row('SYSTEM_MESSAGE', `${NOTIFICATION_PREFIX}[Message] timestamp=2030-01-01T00:00:00Z sender=${handle.nativeId} priority=MESSAGE_PRIORITY_HIGH content=Equal work (iteration 1)\n</SYSTEM_MESSAGE>`, 'SYSTEM');
    client.finish('Idle native result');
    expect(events.at(-1)).toMatchObject({ type: 'completed', output: 'Idle native result' });
    stream.mockClear(); await executor.execute('later foreground', { onStream: stream });
    expect(stream).toHaveBeenCalledTimes(1); expect(stream).toHaveBeenCalledWith('Synthetic result'); // No buffered ACP replay.
    await handle.cancel(); expect(await handle.list()).toBe(false);
    expect(handle.retirementConfirmed).toBe(false);
  });
  it('authorizes in-turn MCP actions without nesting a client prompt, including initial qualification', async () => {
    const foreground = executor.execute('hold'); await vi.waitFor(() => expect(last()?.release).toBeTypeOf('function'));
    const work = executor.withNativeScheduleOperation('op', () => true, () => executor.createNativeSchedule(input(), () => {}), true);
    await vi.waitFor(() => expect(executor.nativeScheduleAction('op')?.tool).toBe('manage_task'));
    expect(executor.hasPendingScheduleMutation()).toBe(true);
    expect(executor.nativeScheduleAction('wrong')).toBeUndefined();
    last().tool(executor.nativeScheduleAction('op'));
    await vi.waitFor(() => expect(executor.nativeScheduleAction('op')?.tool).toBe('schedule'));
    last().tool(executor.nativeScheduleAction('op'));
    const handle = await work;
    expect(executor.hasPendingScheduleMutation()).toBe(false);
    expect(handle.nativeId).toBeTruthy(); expect(last().prompts).toEqual(['hold']);
    last().finish('Creation acknowledged'); last().release({ stopReason: 'end_turn' }); await foreground;
  });
  it('retains cancelled ownership when an ordinary tool leaves unknown background work', async () => {
    const events: any[] = [];
    await executor.createNativeSchedule(input(), e => events.push(e));
    last().hook('PreToolUse', { stepIdx: 200, toolCall: { id: 'ordinary', name: 'run_command', args: {} } });
    const foreground = executor.execute('hold'); await vi.waitFor(() => expect(last().release).toBeTypeOf('function'));
    expect(await executor.abort()).toBe(true); expect((await foreground).success).toBe(false);
    expect(executor.hasPendingCancellation()).toBe(true); expect(last().closed).toBe(false);
    expect(executor.abortStatusMessage()).toContain('may still queue');
    expect(events.at(-1)).toMatchObject({ type: 'stopped', exitConfirmed: false });
    await expect(executor.execute('unsafe nudge')).rejects.toThrow();
    await expect(executor.setModel('other')).rejects.toThrow('notifications');
    await expect(executor.setEffort('low')).rejects.toThrow('notifications');
    await expect(executor.clearModel()).rejects.toThrow('notifications');
    await expect(executor.resetContext()).rejects.toThrow('notifications');
    await expect(executor.compactWhenFull()).rejects.toThrow('notifications');
    await expect(executor.configureManagedTools({ url: 'http://127.0.0.1:1', token: 'synthetic' })).rejects.toThrow('notifications');
    await expect(executor.deleteThreadData('synthetic-thread')).rejects.toThrow('notifications');
    await executor.destroy();
    expect(events.at(-1)).toMatchObject({ type: 'stopped', exitConfirmed: true });
    executor = make();
    await expect(executor.execute('resume')).rejects.toThrow('unconfirmed');
    expect(native.clients).toHaveLength(1);
  });
  it('never reconstructs scheduled ACP work or produces an exit checkpoint', async () => {
    const handle = await executor.createNativeSchedule(input(), () => {});
    const original = executor.getSessionId(), old = last(), prompts = [...old.prompts];
    await executor.destroy();
    expect(old.prompts).toEqual(prompts);
    await expect(fs.stat(path.join(home, '.remote-cli', 'agy-sessions', 'synthetic-thread.json.checkpoint'))).rejects.toMatchObject({ code: 'ENOENT' });
    executor = make();
    await expect(executor.execute('must not replay')).rejects.toThrow('cannot safely resume');
    expect(executor.getSessionId()).toBe(original); expect(native.clients).toHaveLength(1);
  });
  it('keeps cancelled original ACP history without claiming automatic resume safety', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2030-01-01T00:00:05Z'));
    const handle = await executor.createNativeSchedule(input(), () => {}); await handle.cancel();
    const original = executor.getSessionId(); await executor.destroy(); executor = make();
    await expect(executor.execute('must not assume native hook safety')).rejects.toThrow('cannot safely resume');
    expect(executor.getSessionId()).toBe(original); expect(native.clients).toHaveLength(1);
  });
  it('preserves ordinary chat abort compatibility when no schedules have ever been created', async () => {
    const foreground = executor.execute('hold'); await vi.waitFor(() => expect(last()?.release).toBeTypeOf('function'));
    const session = executor.getSessionId();
    expect(await executor.abort()).toBe(true); await foreground;
    expect(last().closed).toBe(true); expect(executor.getSessionId()).toBe(session);
    expect(executor.hasPendingCancellation()).toBe(false);
    expect(native.restore).toHaveBeenCalledOnce();
    await expect(executor.createNativeSchedule(input(), () => {})).rejects.toThrow('saved/legacy');
  });
  it.each(['setModel', 'setEffort', 'clearModel'] as const)('retires an ordinary ACP host before %s without losing context', async operation => {
    await executor.execute('hello'); const session = executor.getSessionId();
    if (operation === 'setModel') await executor.setModel('other');
    if (operation === 'setEffort') await executor.setEffort('low');
    if (operation === 'clearModel') await executor.clearModel();
    expect(last().closed).toBe(true); expect(executor.getSessionId()).toBe(session);
    await expect(executor.createNativeSchedule(input(), () => {})).rejects.toThrow();
  });
  it.each(['timeout', 'inactivityTimeout'] as const)('bounds %s and retires ordinary cancelled hosts without losing the pointer', async field => {
    const pending = executor.execute('hold', { [field]: 15 });
    const result = await pending;
    expect(result.success).toBe(false); expect(last().cancelled).toBe(true); expect(last().closed).toBe(true);
    expect(executor.getSessionId()).toBe('synthetic-session'); expect(executor.hasPendingCancellation()).toBe(false);
  });
  it('projects in-turn native tool cards and exposes only the requested local permission choice', async () => {
    const onToolUse = vi.fn(), onToolResult = vi.fn();
    const pending = executor.execute('hold', { onToolUse, onToolResult });
    await vi.waitFor(() => expect(last()?.release).toBeTypeOf('function'));
    expect(await last().callbacks.onPermissionRequest('Synthetic tool', [{ kind: 'reject_once', optionId: 'no' }, { kind: 'allow_once', optionId: 'yes' }])).toBe(1);
    const create = executor.withNativeScheduleOperation('op', () => true, () => executor.createNativeSchedule(input(), () => {}), true);
    await vi.waitFor(() => expect(executor.nativeScheduleAction('op')?.tool).toBe('manage_task'));
    last().tool(executor.nativeScheduleAction('op'));
    await vi.waitFor(() => expect(executor.nativeScheduleAction('op')?.tool).toBe('schedule'));
    last().tool(executor.nativeScheduleAction('op')); await create;
    expect(onToolUse).toHaveBeenCalledTimes(2); expect(onToolResult).toHaveBeenCalledWith(expect.objectContaining({ is_error: false }));
    last().finish(); last().release({ stopReason: 'end_turn' }); await pending;
  });
  it('joins startup before shutdown and never admits a session after concurrent destroy', async () => {
    let release!: () => void;
    native.initializeWait = new Promise(resolve => { release = resolve; });
    const executing = executor.execute('must not dispatch');
    const rejected = expect(executing).resolves.toMatchObject({ success: false });
    await vi.waitFor(() => expect(native.clients).toHaveLength(1));
    const closing = executor.destroy(); release(); await closing; await rejected;
    expect(last().closed).toBe(true); expect(last().prompts).toEqual([]);
    expect(executor.getSessionId()).toBeNull(); expect(native.restore).toHaveBeenCalledOnce();
  });
  it.each(['delete', 'reset', 'directory'] as const)('joins the owned host before %s after cancellation before the first wake', async operation => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2030-01-01T00:00:05Z'));
    const handle = await executor.createNativeSchedule(input(), () => {});
    await handle.cancel();
    expect(handle.nativeDefinitionAbsent).toBe(true); expect(handle.retirementConfirmed).toBe(true);
    const pointer = path.join(home, '.remote-cli', 'agy-sessions', 'synthetic-thread.json');
    const privateHome = path.join(home, '.remote-cli', 'agy-homes', 'synthetic-thread');
    const nextDirectory = path.join(cwd, 'next'); await fs.mkdir(nextDirectory);
    let entered!: () => void, release!: () => void;
    const joining = new Promise<void>(resolve => { entered = resolve; });
    const exit = new Promise<void>(resolve => { release = resolve; });
    last().waitForManagedProcessGroupExit = async () => { entered(); await exit; };
    const run = operation === 'delete' ? executor.deleteThreadData('synthetic-thread')
      : operation === 'reset' ? executor.resetContext() : executor.setWorkingDirectory(nextDirectory);
    try {
      await joining;
      expect(JSON.parse(await fs.readFile(pointer, 'utf8')).id).toBe('synthetic-session');
      expect(JSON.parse(await fs.readFile(pointer + '.native-schedules', 'utf8')).retired).toBe(false);
      expect((await fs.stat(privateHome)).isDirectory()).toBe(true);
      expect(executor.getCurrentWorkingDirectory()).toBe(cwd);
    } finally { release(); await run; }
    expect(native.restore).toHaveBeenCalledOnce();
    expect(executor.getSessionId()).toBeNull();
    await expect(fs.stat(pointer)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(pointer + '.native-schedules')).rejects.toMatchObject({ code: 'ENOENT' });
    if (operation === 'directory') expect(executor.getCurrentWorkingDirectory()).toBe(nextDirectory);
    if (operation === 'delete') {
      await expect(fs.stat(privateHome)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(executor.deleteThreadData('synthetic-thread')).resolves.toBeUndefined();
    }
  });

  it.each(['delete', 'reset'] as const)('rechecks a checkpoint fence acquired during owned retirement before %s erases data', async operation => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2030-01-01T00:00:05Z'));
    const handle = await executor.createNativeSchedule(input(), () => {}); await handle.cancel();
    const pointer = path.join(home, '.remote-cli', 'agy-sessions', 'synthetic-thread.json');
    last().waitForManagedProcessGroupExit = async () => { await fs.mkdir(pointer + '.checkpoint.lock'); };
    try {
      await expect(operation === 'delete' ? executor.deleteThreadData('synthetic-thread') : executor.resetContext()).rejects.toThrow('checkpoint transition');
      expect(JSON.parse(await fs.readFile(pointer, 'utf8')).id).toBe('synthetic-session');
      expect(JSON.parse(await fs.readFile(pointer + '.native-schedules', 'utf8')).retired).toBe(true);
      expect((await fs.stat(path.join(home, '.remote-cli', 'agy-homes', 'synthetic-thread'))).isDirectory()).toBe(true);
    } finally { await fs.rm(pointer + '.checkpoint.lock', { recursive: true, force: true }); }
  });

  it.each(['lock', 'foreign-owner', 'unknown-host', 'live-sibling', 'unconfirmed-exit'] as const)(
    'preserves AGY context deletion evidence for %s', async fault => {
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2030-01-01T00:00:05Z'));
      const handle = await executor.createNativeSchedule(input(), () => {});
      await handle.cancel();
      const raw = executor as any, runtime = raw.acp, owner = { ...raw.scheduleOwner };
      const pointer = path.join(home, '.remote-cli', 'agy-sessions', 'synthetic-thread.json');
      if (fault === 'lock') await fs.mkdir(pointer + '.checkpoint.lock');
      if (fault === 'foreign-owner') raw.scheduleOwner.sessionId = 'other-session';
      if (fault === 'unknown-host') raw.acp = undefined;
      if (fault === 'live-sibling') await executor.createNativeSchedule({ ...input(), id: 'sibling' }, () => {});
      if (fault === 'unconfirmed-exit') native.exitConfirmed = false;
      try {
        await expect(executor.deleteThreadData('synthetic-thread')).rejects.toThrow();
        expect(JSON.parse(await fs.readFile(pointer, 'utf8')).id).toBe('synthetic-session');
        expect(JSON.parse(await fs.readFile(pointer + '.native-schedules', 'utf8')).retired).toBe(false);
        expect(native.restore).not.toHaveBeenCalled();
        if (fault !== 'unconfirmed-exit') expect(last().closed).toBe(false);
      } finally {
        await fs.rm(pointer + '.checkpoint.lock', { recursive: true, force: true });
        raw.acp = runtime; raw.scheduleOwner = owner; native.exitConfirmed = true;
      }
    });

  it('permits explicit fresh-context reset only after exact group retirement, never a scheduled resume', async () => {
    await executor.createNativeSchedule(input(), () => {});
    await expect(executor.resetContext()).rejects.toThrow('unresolved ownership');
    await executor.stopForContextReset(); await executor.resetContext();
    expect(executor.getSessionId()).toBeNull();
    await expect(fs.stat(path.join(home, '.remote-cli', 'agy-sessions', 'synthetic-thread.json.native-schedules'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(native.clients).toHaveLength(1);
  });
  it('does not certify group retirement or remove hooks on uncertain exit', async () => {
    await executor.createNativeSchedule(input(), () => {}); native.exitConfirmed = false;
    await expect(executor.destroy()).rejects.toThrow('unconfirmed');
    expect(native.restore).not.toHaveBeenCalled();
    const retained = JSON.parse(await fs.readFile(path.join(home, '.remote-cli', 'agy-sessions', 'synthetic-thread.json.native-schedules'), 'utf8'));
    expect(retained.retired).toBe(false);
    native.exitConfirmed = true; await (executor as any).acp.close();
  });
  it('fails before native mutation for changed owner/settings and preserves legacy saved identity', async () => {
    await expect(executor.createNativeSchedule({ ...input(), cwd: home }, () => {})).rejects.toThrow('configuration');
    await expect(executor.withNativeScheduleOperation('op', () => false, () => executor.createNativeSchedule(input(), () => {}), false)).rejects.toThrow();
    expect(last().prompts).toEqual([]);
    await executor.destroy(); executor = make();
    await expect(executor.withNativeScheduleOperation('op', () => true, async () => {}, false)).rejects.toThrow('fresh ACP');
    expect(last().session).toBe('synthetic-session');
  });
  it('refuses a saved ACP host with unknown retirement even without a schedule catalog', async () => {
    await executor.execute('hello');
    const replacement = make();
    await expect(replacement.execute('must not resume')).rejects.toThrow('unconfirmed');
    await replacement.resetContext();
    await expect(replacement.deleteThreadData('synthetic-thread')).rejects.toThrow('Detached');
    await replacement.destroy(); expect(native.clients).toHaveLength(1);
  });
  it('never turns normal close or a legacy retired flag into successor chat permission', async () => {
    await executor.execute('hello');
    const pointer = path.join(home, '.remote-cli', 'agy-sessions', 'synthetic-thread.json');
    const original = await fs.readFile(pointer, 'utf8');
    await executor.destroy(); expect(await fs.readFile(pointer, 'utf8')).toBe(original);
    const legacy = JSON.parse(original); legacy.retired = true;
    await fs.writeFile(pointer, JSON.stringify(legacy));
    executor = make();
    await expect(executor.execute('resume')).rejects.toThrow('unconfirmed');
    expect(native.clients).toHaveLength(1); expect(executor.getSessionId()).toBe(legacy.id);
  });
  it('refuses stale or malformed journal data before starting a native process', async () => {
    await executor.destroy();
    await fs.writeFile(path.join(home, '.remote-cli', 'agy-sessions', 'synthetic-thread.json.native-schedules'), '{}');
    expect(make).toThrow('journal is unreadable'); expect(native.clients).toHaveLength(0);
  });
  it('keeps a genuine foreground relay failure visible and prevents later prompting', async () => {
    await executor.execute('hello'); native.fault();
    await expect(executor.execute('later')).rejects.toThrow('relay failed');
    expect(last().prompts).toHaveLength(1);
  });
});
