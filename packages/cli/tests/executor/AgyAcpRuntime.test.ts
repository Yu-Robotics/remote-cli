import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import type { AcpEventCallbacks } from '../../src/executor/acp/AcpClient';
import type { HookPayload } from '../../src/scheduling/agy/AgySessionSchedules';
import type { TranscriptRecord } from '../../src/scheduling/agy/transcript';
import { NOTIFICATION_PREFIX } from '../../src/scheduling/agy/transcript';
import { createExecutor } from '../../src/executor';
import { AgyExecutor } from '../../src/executor/AgyExecutor';
import { AgyAcpRuntime } from '../../src/executor/agy/AgyAcpRuntime';
import type { AcpSessionSetup } from '../../src/executor/acp/AcpClient';
import { AgyCheckpoint } from '../../src/scheduling/agy/AgyCheckpoint';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';

const native = vi.hoisted(() => ({
  clients: [] as any[], accept: undefined as any, fault: undefined as any,
  restore: vi.fn(async () => {}), configure: vi.fn(async () => {}), bind: vi.fn(),
  nativeAvailable: true, exitConfirmed: true, home: '', initializeWait: undefined as Promise<void> | undefined,
  settingFailure: false, settingWait: undefined as Promise<void> | undefined,
  sessionId: 'synthetic-session',
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
  session = native.sessionId; token: object | undefined = {}; cursor = 0; rows: TranscriptRecord[] = [];
  tasks = new Map<string, string>(); prompts: string[] = []; cancelled = false; closed = false;
  controls: Array<[string, string]> = []; model = 'synthetic-default'; thought = 'low';
  epoch: object | undefined = {};
  release?: (value: { stopReason: string }) => void;
  exited: Promise<void>; onExit!: () => void;
  constructor(public command: string, public args: string[], public cwd: string, public callbacks: AcpEventCallbacks, _managed: boolean, public launch: any) {
    native.clients.push(this); this.exited = new Promise(resolve => { this.onExit = resolve; });
  }
  async initialize() { await native.initializeWait; return {}; }
  state() { return { sessionId: this.session, configOptions: [
    { id: 'model', category: 'model', type: 'select', currentValue: this.model },
    { id: 'thought_level', category: 'thought_level', type: 'select', currentValue: this.thought },
  ] }; }
  async configure(configId: string, value: string) {
    this.controls.push([configId, value]); await native.settingWait;
    if (native.settingFailure) throw new Error('Synthetic private native error');
    if (configId === 'model') this.model = value;
    if (configId === 'thought_level') this.thought = value;
    return this.state();
  }
  async newSessionWithSetup(_cwd: string, _servers: unknown, setup?: AcpSessionSetup) {
    this.token = undefined; const state = this.state();
    await setup?.(state, (id, value) => this.configure(id, value));
    this.token = {}; return state;
  }
  async loadSessionWithSetup(id: string, _cwd: string, _servers: unknown, setup?: AcpSessionSetup) {
    this.session = id;
    const predecessor = native.clients.at(-2);
    if (predecessor) { this.rows = structuredClone(predecessor.rows); this.cursor = predecessor.cursor; }
    this.token = undefined;
    const state = this.state(); await setup?.(state, (key, value) => this.configure(key, value)); return state;
  }
  sessionAdmission(id: string) { return id === this.session ? this.token : undefined; }
  sessionLifecycle() { return this.epoch; }
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
const runtimes = new Set<AgyAcpRuntime>();
const last = () => native.clients.at(-1)!;
const input = () => ({ backend: 'agy' as const, threadId: 'synthetic-thread', id: 'job-a', cwd, prompt: 'Equal work',
  model: 'synthetic-model', effort: 'high', rule: { kind: 'cron' as const, expression: '* * * * *', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } });
const make = () => createExecutor(new DirectoryGuard([cwd]), { type: 'agy', agy: { model: 'synthetic-model' } }, cwd, 'synthetic-thread', undefined, 'high') as AgyExecutor;
beforeEach(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agy-entry-'))); cwd = path.join(home, 'work'); await fs.mkdir(cwd);
  native.home = home;
  native.clients.length = 0; native.initializeWait = undefined; native.nativeAvailable = true; native.exitConfirmed = true;
  native.settingFailure = false; native.settingWait = undefined;
  native.sessionId = 'synthetic-session';
  native.restore.mockClear(); native.configure.mockClear(); native.bind.mockClear();
  executor = make();
});
afterEach(async () => {
  native.exitConfirmed = true; await executor.destroy();
  for (const runtime of runtimes) await runtime.close(); runtimes.clear();
  await fs.rm(home, { recursive: true, force: true }); vi.restoreAllMocks();
});

function initialRuntime(resume?: ConstructorParameters<typeof AgyAcpRuntime>[0]['resume'],
  overrides: Partial<ConstructorParameters<typeof AgyAcpRuntime>[0]> = {}) {
  const pointer = path.join(home, 'synthetic-startup-pointer.json');
  const saveSession = vi.fn((id: string) => {
    // This synchronous fixture mirrors production pointer persistence before controls.
    fsSync.writeFileSync(pointer, JSON.stringify({ id, retired: false }));
  });
  const retireSession = vi.fn((id: string, setupFailed?: boolean) => {
    fsSync.writeFileSync(pointer, JSON.stringify({ id, retired: true, setupFailed }));
  });
  const runtime = new AgyAcpRuntime({ command: 'synthetic-agy', home, cwd, threadId: 'synthetic-thread', env: {},
    autoApprove: true, model: 'synthetic-model', effort: 'high', resume, saveSession, retireSession,
    retainScheduleOwner: vi.fn(), mapTool: (name, input) => ({ name, input }), ...overrides });
  runtimes.add(runtime); return { runtime, pointer, saveSession, retireSession };
}

describe('AGY production fresh-session entry (synthetic native records)', () => {
  it('leaves unspecified native defaults alone and configures checkpoint resumes before prompting', async () => {
    const fresh = initialRuntime(undefined, { model: undefined, effort: undefined });
    await fresh.runtime.start(); expect(last().controls).toEqual([]); await fresh.runtime.close();
    const checkpoint = new AgyCheckpoint(path.join(home, 'synthetic-checkpoint'), 'synthetic-settings');
    checkpoint.confirm(checkpoint.prepare('synthetic-session', {}));
    const resumed = initialRuntime(checkpoint.consume('synthetic-session'));
    await resumed.runtime.start();
    expect(last().controls).toEqual([['model', 'synthetic-model'], ['thought_level', 'high']]);
    expect(last().prompts).toEqual([]); expect(resumed.saveSession).toHaveBeenCalledWith('synthetic-session');
    await resumed.runtime.execute('hello', {}); expect(last().prompts).toEqual(['hello']);
    await resumed.runtime.close(); expect(resumed.retireSession).toHaveBeenCalledWith('synthetic-session', false);
  });
  it('joins and retires an allocation even when its initial pointer cannot be saved', async () => {
    const { runtime, retireSession } = initialRuntime(undefined, { saveSession: () => { throw new Error('Synthetic private filesystem material'); } });
    const error = await runtime.start().catch(error => error);
    expect(error.message).toContain('stage=session-save'); expect(error.message).not.toContain('private');
    expect(last().controls).toEqual([]); expect(last().prompts).toEqual([]); expect(last().closed).toBe(true);
    expect(retireSession).toHaveBeenCalledWith('synthetic-session', true); expect(runtime.safeFallback).toBe(false);
    expect(native.restore).toHaveBeenCalledOnce();
  });
  it.each(['', '../outside', 'x'.repeat(129), 123])('does not allow compatible fallback after malformed allocation reply %#', async sessionId => {
    native.sessionId = sessionId as string; const { runtime, saveSession, retireSession } = initialRuntime();
    await expect(runtime.start()).rejects.toThrow('stage=session-create');
    expect(saveSession).not.toHaveBeenCalled(); expect(retireSession).not.toHaveBeenCalled();
    expect(last().closed).toBe(true); expect(last().controls).toEqual([]); expect(last().prompts).toEqual([]);
    expect(runtime.safeFallback).toBe(false);
  });
  it('retains the allocation fence if persisting failed-setup retirement fails', async () => {
    native.settingFailure = true;
    const retirement = vi.fn(() => { throw new Error('Synthetic private filesystem material'); });
    const { runtime, pointer } = initialRuntime(undefined, { retireSession: retirement });
    const error = await runtime.start().catch(error => error);
    expect(error.message).toContain('stage=cleanup'); expect(error.message).not.toContain('private');
    expect(JSON.parse(await fs.readFile(pointer, 'utf8'))).toMatchObject({ id: 'synthetic-session', retired: false });
    expect(runtime.safeFallback).toBe(false); expect(last().prompts).toEqual([]);
    retirement.mockImplementation(() => {}); await runtime.close();
  });
  it('keeps failed setup unretired while exact process-group exit is unconfirmed', async () => {
    native.settingFailure = true; native.exitConfirmed = false;
    const { runtime, pointer, retireSession } = initialRuntime();
    await expect(runtime.start()).rejects.toThrow('stage=cleanup');
    expect(retireSession).not.toHaveBeenCalled(); expect(native.restore).not.toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(pointer, 'utf8'))).toMatchObject({ id: 'synthetic-session', retired: false });
    expect(runtime.safeFallback).toBe(false); expect(last().prompts).toEqual([]);
    native.exitConfirmed = true; await runtime.close();
    expect(retireSession).toHaveBeenCalledWith('synthetic-session', true);
  });
  it('persists allocation before failed settings and retires without losing the setup fence', async () => {
    native.settingFailure = true; const { runtime, pointer, retireSession } = initialRuntime();
    const error = await runtime.start().catch(error => error);
    expect(error.message).toContain('stage=session-settings, reason=unsupported-setting'); expect(error.message).not.toContain('private');
    expect(last().controls).toEqual([['model', 'synthetic-model']]); expect(last().prompts).toEqual([]);
    expect(last().closed).toBe(true); expect(native.restore).toHaveBeenCalledOnce();
    expect(retireSession).toHaveBeenCalledWith('synthetic-session', true);
    expect(JSON.parse(await fs.readFile(pointer, 'utf8'))).toMatchObject({ id: 'synthetic-session', retired: true, setupFailed: true });
    expect(runtime.safeFallback).toBe(false);
  });
  it('retains a consumed checkpoint when resumed settings fail before host admission', async () => {
    const checkpoint = new AgyCheckpoint(path.join(home, 'synthetic-checkpoint'), 'synthetic-settings');
    const prepared = checkpoint.prepare('synthetic-session', {}); checkpoint.confirm(prepared);
    native.settingFailure = true;
    const { runtime, retireSession } = initialRuntime(checkpoint.consume('synthetic-session'));
    await expect(runtime.start()).rejects.toThrow('stage=session-settings, reason=unsupported-setting');
    expect(checkpoint.read()?.state).toBe('consumed'); expect(() => checkpoint.consume('synthetic-session')).toThrow('unavailable');
    expect(retireSession).toHaveBeenCalledWith('synthetic-session', true); expect(last().prompts).toEqual([]);
  });
  it('persists failed setup through the production executor and keeps recreation fenced', async () => {
    native.settingFailure = true;
    await expect(executor.execute('do not send')).rejects.toThrow('stage=session-settings');
    const pointer = path.join(home, '.remote-cli', 'agy-sessions', 'synthetic-thread.json');
    expect(JSON.parse(await fs.readFile(pointer, 'utf8'))).toMatchObject({ transport: 'acp', retired: true, setupFailed: true });
    expect(last().prompts).toEqual([]);
    const count = native.clients.length;
    const replacement = new AgyExecutor(new DirectoryGuard([home]), {
      initialWorkingDirectory: cwd, threadId: 'synthetic-thread', nativeAcp: true,
      model: 'synthetic-model', effort: 'high',
    });
    try {
      await expect(replacement.execute('still do not send')).rejects.toThrow('session setup failed');
      await expect(replacement.createNativeSchedule(input(), () => {})).rejects.toThrow('session setup failed');
      expect(native.clients).toHaveLength(count);
    } finally { await replacement.destroy(); }
  });
  it('joins shutdown during initial model selection without applying thought level or prompting', async () => {
    let release!: () => void; native.settingWait = new Promise(resolve => { release = resolve; });
    const { runtime, retireSession } = initialRuntime();
    const pending = runtime.start(); const rejected = expect(pending).rejects.toThrow('stage=session-settings, reason=unsupported-setting');
    await vi.waitFor(() => expect(last()?.controls).toHaveLength(1));
    const closing = runtime.close(); release(); await rejected; await closing;
    expect(last().controls).toEqual([['model', 'synthetic-model']]); expect(last().prompts).toEqual([]);
    expect(retireSession).toHaveBeenCalledWith('synthetic-session', true);
  });
  it('keeps factory/chat/schedule on the same original host, retaining settings and private HOME', async () => {
    const stream = vi.fn(), display = vi.fn();
    expect(native.clients).toHaveLength(0);
    await executor.execute('hello', { onStream: stream, onDisplayText: display, resolvePrompt: id => `hello ${id}` });
    const client = last(); expect(client.prompts[0]).toBe('hello synthetic-session');
    expect(client.args).toContain('acp'); expect(client.args).not.toContain('--model'); expect(client.args).not.toContain('--effort');
    expect(client.controls).toEqual([['model', 'synthetic-model'], ['thought_level', 'high']]);
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
    expect(executor.nativeScheduleAction('wrong')).toBeUndefined();
    last().tool(executor.nativeScheduleAction('op'));
    await vi.waitFor(() => expect(executor.nativeScheduleAction('op')?.tool).toBe('schedule'));
    last().tool(executor.nativeScheduleAction('op'));
    const handle = await work;
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
    await expect(executor.execute('resume')).rejects.toThrow('unresolved queue');
    expect(native.clients).toHaveLength(1);
  });
  it('continues never-fired native schedules after confirmed cancellation in the exact original conversation', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2030-01-01T00:00:05Z'));
    const events: any[] = []; const handle = await executor.createNativeSchedule(input(), event => events.push(event));
    const old = last(), original = executor.getSessionId(), nativeId = handle.nativeId;
    const foreground = executor.execute('hold'); await vi.waitFor(() => expect(old.release).toBeTypeOf('function'));
    expect(await executor.abort()).toBe(true); await foreground;
    expect(old.closed).toBe(true); expect(native.clients).toHaveLength(2);
    expect(executor.getSessionId()).toBe(original); expect(handle.nativeId).not.toBe(nativeId);
    expect(events).toEqual([{ type: 'rebound', previousNativeId: nativeId, nativeId: handle.nativeId }]);
    expect(executor.hasPendingCancellation()).toBe(false);
    expect(executor.abortStatusMessage()).toContain('resumed automatically');
    expect(last().prompts).toHaveLength(2); // real inventory and create only, no nudge
    expect(await executor.abort()).toBe(false);
    expect(executor.abortStatusMessage()).toContain('No foreground command');
    expect(native.clients).toHaveLength(2);
  });
  it('does not report successful continuation before durable native rebinding succeeds', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2030-01-01T00:00:05Z'));
    await executor.createNativeSchedule(input(), async event => {
      if (event.type === 'rebound') throw new Error('Synthetic catalog write failure');
    });
    const old = last(), foreground = executor.execute('hold');
    await vi.waitFor(() => expect(old.release).toBeTypeOf('function'));
    await executor.abort(); await foreground;
    expect(native.clients).toHaveLength(2);
    expect(executor.hasPendingCancellation()).toBe(true);
    expect(executor.abortStatusMessage()).not.toContain('resumed automatically');
  });
  it('keeps a missing cancellation terminal dirty instead of consuming recovery proof', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2030-01-01T00:00:05Z'));
    await executor.createNativeSchedule(input(), () => {});
    const old = last(), foreground = executor.execute('hold').catch(error => error);
    await vi.waitFor(() => expect(old.release).toBeTypeOf('function'));
    old.sendCancel = () => { old.token = undefined; };
    (executor as any).acp.host.cancelTimeoutMs = 15;
    await executor.abort(); expect(await foreground).toBeInstanceOf(Error);
    expect(native.clients).toHaveLength(1); expect(executor.hasPendingCancellation()).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(home, '.remote-cli', 'agy-sessions', 'synthetic-thread.json.checkpoint'), 'utf8')).state).toBe('prepared');
  });
  it('does not reconstruct if group retirement or the cancellation terminal is unconfirmed', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2030-01-01T00:00:05Z'));
    await executor.createNativeSchedule(input(), () => {});
    const old = last(), foreground = executor.execute('hold');
    await vi.waitFor(() => expect(old.release).toBeTypeOf('function'));
    native.exitConfirmed = false;
    await executor.abort(); await foreground;
    expect(native.clients).toHaveLength(1); expect(executor.hasPendingCancellation()).toBe(true);
    const file = path.join(home, '.remote-cli', 'agy-sessions', 'synthetic-thread.json.checkpoint');
    expect(JSON.parse(await fs.readFile(file, 'utf8')).state).toBe('prepared');
  });
  it('recovers a shared orderly checkpoint once and preserves sibling definitions', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2030-01-01T00:00:05Z'));
    const recovery = executor.nativeScheduleRecovery!;
    const checkpoint = { provider: recovery.provider, strategy: recovery.strategy, identity: recovery.describe!(input()), status: 'eligible' as const };
    const a = await executor.createNativeSchedule({ ...input(), recovery: checkpoint }, () => {});
    const b = await executor.createNativeSchedule({ ...input(), id: 'job-b', recovery: checkpoint }, () => {});
    const original = executor.getSessionId();
    await Promise.all([a.releaseForRestart!(), b.releaseForRestart!()]); await recovery.finishRestart!();
    await executor.destroy(); executor = make();
    const context = { notBefore: Date.now(), signal: new AbortController().signal, isCurrent: () => true };
    const record = { ...input(), openId: 'synthetic-owner', generation: 'epoch', createdAt: 0, state: 'interrupted' as const,
      execution: { model: input().model, effort: input().effort }, recovery: { ...checkpoint, identity: a.recoveryIdentity!, handoff: 'clean' as const } };
    const restored = await executor.nativeScheduleRecovery!.reconcile(record, context, () => {});
    const sibling = await executor.nativeScheduleRecovery!.reconcile({ ...record, id: 'job-b' }, context, () => {});
    expect(executor.getSessionId()).toBe(original); expect(last().tasks.size).toBe(2);
    expect(restored.nativeId).not.toBe(sibling.nativeId);
    await expect(executor.nativeScheduleRecovery!.reconcile(record, context, () => {})).rejects.toThrow('proof');
  });
  it('allows a later orderly retry after refusing a still-active foreground before mutation', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2030-01-01T00:00:05Z'));
    const handle = await executor.createNativeSchedule(input(), () => {});
    const old = last(), foreground = executor.execute('hold');
    await vi.waitFor(() => expect(old.release).toBeTypeOf('function'));
    await expect(handle.releaseForRestart!()).rejects.toThrow('busy');
    old.finish(); old.release({ stopReason: 'end_turn' }); await foreground;
    await expect(handle.releaseForRestart!()).resolves.toEqual({ nativeDefinitionAbsent: true });
    expect(old.closed).toBe(true);
  });
  it('restores ordinary ACP context after every task was proved cancelled before its first wake', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2030-01-01T00:00:05Z'));
    const handle = await executor.createNativeSchedule(input(), () => {});
    await handle.cancel(); expect(handle.retirementConfirmed).toBe(true);
    const original = executor.getSessionId(); await executor.destroy(); executor = make();
    await executor.execute('continue after cancelled tasks');
    expect(executor.getSessionId()).toBe(original); expect(native.clients).toHaveLength(2);
    await expect(fs.stat(path.join(home, '.remote-cli', 'agy-sessions', 'synthetic-thread.json.native-schedules'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('migrates a saved checkpointed no-job ACP conversation without a new session or model nudge', async () => {
    await executor.execute('remember synthetic context'); const original = executor.getSessionId();
    await executor.destroy(); executor = make();
    const pending = executor.execute('continue original context'); await pending;
    expect(executor.getSessionId()).toBe(original);
    expect(last().rows.some((row: TranscriptRecord) => row.content === 'Synthetic result')).toBe(true);
    expect(last().prompts).toEqual(['continue original context']);
    expect(native.clients).toHaveLength(2);
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
    await expect(executor.withNativeScheduleOperation('op', () => true, async () => {}, false)).resolves.toBeUndefined();
    expect(last().session).toBe('synthetic-session');
  });
  it('refuses a saved ACP host with unknown retirement even without a schedule catalog', async () => {
    await executor.execute('hello');
    const replacement = make();
    await expect(replacement.execute('must not resume')).rejects.toThrow('unconfirmed');
    await expect(replacement.resetContext()).rejects.toThrow('unconfirmed');
    await replacement.destroy(); expect(native.clients).toHaveLength(1);
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
