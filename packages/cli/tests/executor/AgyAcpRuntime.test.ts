import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import fsSync from 'fs';
import { AgyAcpRuntime } from '../../src/executor/agy/AgyAcpRuntime';
import type { AcpSessionSetup } from '../../src/executor/acp/AcpClient';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import type { AcpEventCallbacks } from '../../src/executor/acp/AcpClient';
import type { HookPayload } from '../../src/scheduling/agy/AgySessionSchedules';
import type { NativeScheduleEvent } from '../../src/scheduling/types';
import type { TranscriptRecord } from '../../src/scheduling/agy/transcript';
import { NOTIFICATION_PREFIX } from '../../src/scheduling/agy/transcript';
import { createExecutor } from '../../src/executor';
import { AgyExecutor } from '../../src/executor/AgyExecutor';
import { crashAgyOverlay } from '../scheduling/agyHookCrashFixture';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { MessageHandler } from '../../src/client/MessageHandler';
import { ThreadExecutorPool } from '../../src/thread/ThreadExecutorPool';
import { ThreadManager } from '../../src/thread/ThreadManager';

const native = vi.hoisted(() => ({
  clients: [] as any[], accept: undefined as any, fault: undefined as any,
  restore: vi.fn(async () => {}), configure: vi.fn(async () => {}), bind: vi.fn(),
  settingFailure: false, settingWait: undefined as Promise<void> | undefined, sessionId: 'synthetic-session',
  realHooks: false, nativeAvailable: true, exitConfirmed: true, home: '', initializeWait: undefined as Promise<void> | undefined,
  loadedRows: undefined as TranscriptRecord[] | undefined,
  confirmTranscript: vi.fn(async (_records: TranscriptRecord[]) => true),
}));
vi.mock('os', async importOriginal => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => native.home, default: { ...actual, homedir: () => native.home } };
});
vi.mock('../../src/native/NativeBindings', () => ({ nativeBindings: () => {
  if (!native.nativeAvailable) throw new Error('Synthetic helper unavailable');
  return { readChunk: () => {}, openOutputChild: () => {} };
} }));
vi.mock('../../src/scheduling/agy/AgyHookRelay', () => ({
  installAgyScheduleHooks: async (...args: any[]) => native.realHooks
    ? (await vi.importActual<any>('../../src/scheduling/agy/AgyHookRelay')).installAgyScheduleHooks(...args)
    : Object.assign(native.restore, { run: (callback: () => unknown) => callback() }),
  AgyHookRelay: class {
    constructor(_home: string, accept: any, fault: any) { native.accept = accept; native.fault = fault; }
    async start() { return { url: 'http://127.0.0.1:1/hook', token: 'synthetic-token' }; }
    bindSession = native.bind;
    confirmsTerminal = native.confirmTranscript;
    async close() {}
  },
}));
vi.mock('../../src/executor/acp/AcpClient', () => ({ AcpClient: class {
  session = native.sessionId; token: object | undefined = {}; cursor = 0; rows: TranscriptRecord[] = [];
  tasks = new Map<string, string>(); prompts: string[] = []; cancelled = false; closed = false;
  questionStep?: number;
  controls: Array<[string, string]> = []; model = 'synthetic-default'; thought = 'low'; mode = 'default';
  release?: (value: { stopReason: string }) => void;
  exited: Promise<void>; onExit!: () => void;
  constructor(public command: string, public args: string[], public cwd: string, public callbacks: AcpEventCallbacks, _managed: boolean, public launch: any) {
    native.clients.push(this); this.exited = new Promise(resolve => { this.onExit = resolve; });
  }
  async initialize() { await native.initializeWait; return {}; }
  state() { return { sessionId: this.session, configOptions: [
    { id: 'model', category: 'model', type: 'select', currentValue: this.model },
    { id: 'thought_level', category: 'thought_level', type: 'select', currentValue: this.thought },
    { id: 'mode', category: 'mode', type: 'select', currentValue: this.mode },
  ] }; }
  async configure(configId: string, value: string) {
    this.controls.push([configId, value]); await native.settingWait;
    if (native.settingFailure) throw new Error('Synthetic private native error');
    if (configId === 'model') this.model = value;
    if (configId === 'thought_level') this.thought = value;
    if (configId === 'mode') this.mode = value;
    return this.state();
  }
  servers?: unknown;
  async newSessionWithSetup(_cwd: string, servers: unknown, setup?: AcpSessionSetup) {
    this.servers = servers;
    this.token = undefined; const state = this.state();
    await setup?.(state, (id, value) => this.configure(id, value));
    this.token = {}; return state;
  }
  async loadSession() { throw new Error('Unqualified saved ACP resume is forbidden'); }
  async loadSessionWithSetup(id: string, _cwd: string, _servers: unknown, setup: AcpSessionSetup) {
    if (native.loadedRows) {
      this.rows = structuredClone(native.loadedRows);
      this.cursor = Math.max(...this.rows.map(row => row.step_index)) + 1;
    }
    this.session = id; this.token = undefined; const state = this.state(); await setup(state, (key, value) => this.configure(key, value)); return state;
  }
  async setConfigOption(_id: string, key: string, value: string) { this.token = undefined; return this.configure(key, value); }
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
    this.hook('Stop', { terminationReason: 'NO_TOOL_CALL', error: '', fullyIdle: true, continuationActive: false });
  }
  async prompt(_id: string, blocks: any[]) {
    const text = blocks[0].text; this.prompts.push(text);
    if (this.questionStep !== undefined) {
      this.row('GENERIC', 'Answered: ' + text, 'MODEL', 'DONE', this.questionStep);
      this.questionStep = undefined;
      this.hook('PostToolUse'); this.hook('PostInvocation');
    }
    this.hook('SessionStart'); this.hook('PreInvocation', { initialNumSteps: this.cursor });
    if (/(?:^|\n)hold$/.test(text)) return new Promise<{ stopReason: string }>(resolve => { this.release = resolve; });
    if (text === 'missing terminal') return { stopReason: 'end_turn' };
    if (text === 'ask' || text === 'ask again') {
      const args = { questions: [{ question: 'Choose a fixture option.', options: ['First', 'Second'] }] };
      this.row('PLANNER_RESPONSE', '');
      this.rows.at(-1)!.tool_calls = [{ name: 'ask_question', args }];
      const step = this.cursor++;
      this.questionStep = step;
      expect(this.hook('PreToolUse', { stepIdx: step, toolCall: { id: `call-${step}`, name: 'ask_question', args } })).toEqual({ decision: 'allow' });
      const update = { toolCallId: `toolCallId-${step}`, name: 'ask_question', status: 'pending', rawInput: args };
      this.callbacks.onToolCall?.(update);
      this.callbacks.onTextChunk?.({ type: 'text', text: 'Choose a fixture option.\n- [1] First\n- [2] Second' });
      return { stopReason: 'end_turn' };
    }
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
/** A previously acknowledged task and its ownership journal on this synthetic ACP host. */
async function legacyJob(emit: (event: NativeScheduleEvent) => void = () => {}, definition = input()) {
  await executor.withNativeScheduleOperation('fixture-legacy-inventory', () => true, async () => {}, false);
  const runtime = executor['acp']!;
  const schedules = runtime['host']!.schedules;
  const nativeId = last().session + '/task-' + last().cursor++;
  const description = 'Timer: synthetic, Prompt: ' + definition.prompt;
  const job = { input: definition, id: nativeId, description, emit, admit: () => true,
    cancelled: false, absent: false, firstPossibleWake: Date.now() + 60_000 };
  await schedules['options'].beforeMutation!();
  schedules['jobs'].set(definition.id, job);
  schedules['ready'] = true;
  last().tasks.set(nativeId, description);
  return schedules['handle'](job);
}
const make = () => createExecutor(new DirectoryGuard([cwd]), { type: 'agy', agy: { model: 'synthetic-model' } }, cwd, 'synthetic-thread', undefined, 'high') as AgyExecutor;
beforeEach(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agy-entry-'))); cwd = path.join(home, 'work'); await fs.mkdir(cwd);
  native.home = home; vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home);
  native.realHooks = false; native.clients.length = 0; native.initializeWait = undefined; native.nativeAvailable = true; native.exitConfirmed = true;
  native.loadedRows = undefined;
  native.confirmTranscript.mockReset().mockResolvedValue(true);
  native.settingFailure = false; native.settingWait = undefined; native.sessionId = 'synthetic-session';
  native.restore.mockClear(); native.configure.mockClear(); native.bind.mockClear();
  executor = make();
});
afterEach(async () => { native.exitConfirmed = true; await executor.destroy(); for (const runtime of runtimes) await runtime.close(); runtimes.clear(); await fs.rm(home, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function initialRuntime(overrides: Partial<ConstructorParameters<typeof AgyAcpRuntime>[0]> = {}) {
  const pointer = path.join(home, 'synthetic-startup-pointer.json');
  const saveSession = vi.fn((id: string) => fsSync.writeFileSync(pointer, JSON.stringify({ id, transport: 'acp', retired: false })));
  const ownedSessionClosed = vi.fn();
  const runtime = new AgyAcpRuntime({ command: 'synthetic-agy', home, cwd, threadId: 'synthetic-thread', env: {},
    autoApprove: true, model: 'synthetic-model', effort: 'high', saveSession, ownedSessionClosed,
    retainScheduleOwner: vi.fn(), mapTool: (name, input) => ({ name, input }), ...overrides });
  runtimes.add(runtime); return { runtime, pointer, saveSession, ownedSessionClosed };
}

describe('AGY production fresh-session entry (synthetic native records)', () => {
  it.each(['confirmed', 'worker', 'mutation', 'extra args', 'planner mismatch', 'missing', 'wrong nonce',
    'wrong step', 'wrong status', 'late post-tool', 'other unfinished tool', 'failed Stop', 'rewritten receipt', 'idle tool'])(
    'continues only the original main foreground session after a verified list denial: %s', async scenario => {
      const worker = scenario === 'worker';
      const { runtime, ownedSessionClosed } = initialRuntime({ hostScheduleChat: !worker, worker });
      const turn = runtime.execute('hold', {});
      await vi.waitFor(() => expect(last()?.release).toBeDefined());
      const client = last();
      const args = scenario === 'mutation' ? { Action: 'kill' } : scenario === 'extra args' ? { Action: 'list', TaskId: 'other' } : { Action: 'list' };
      client.row('PLANNER_RESPONSE', '');
      client.rows.at(-1).tool_calls = [{ name: 'manage_task', args: scenario === 'planner mismatch' ? {} : args }];
      const step = client.cursor++;
      const decision = client.hook('PreToolUse', { stepIdx: step, toolCall: { name: 'manage_task', id: 'list-call', args } });
      expect(decision.decision).toBe('deny');
      if (scenario !== 'missing') {
        const text = 'Encountered error in step execution: tool call denied by pre-tool hook: ' +
          (scenario === 'wrong nonce' ? 'unrelated' : decision.reason);
        client.row('GENERIC', text, 'MODEL', scenario === 'wrong status' ? 'DONE' : 'ERROR',
          scenario === 'wrong step' ? client.cursor++ : step);
      }
      client.hook('PostInvocation');
      if (scenario === 'late post-tool') client.hook('PostToolUse', { stepIdx: step });
      client.hook('PreInvocation', { initialNumSteps: client.cursor });
      if (scenario === 'other unfinished tool') {
        client.hook('PreToolUse', { stepIdx: client.cursor, toolCall: { id: 'other', name: 'other_tool', args: {} } });
        client.row('GENERIC', '', 'MODEL', 'RUNNING');
      }
      client.row('PLANNER_RESPONSE', 'Listing unavailable.');
      client.hook('PostInvocation');
      client.hook('Stop', { terminationReason: scenario === 'failed Stop' ? 'ERROR' : 'NO_TOOL_CALL', error: scenario === 'failed Stop' ? 'failed' : '' });
      client.release({ stopReason: 'end_turn' });
      if (['confirmed', 'rewritten receipt', 'idle tool'].includes(scenario)) {
        expect(await turn).toMatchObject({ success: true, output: 'Listing unavailable.' });
        if (scenario === 'confirmed') {
          expect(await runtime.execute('next ordinary prompt', {})).toMatchObject({ success: true });
          expect(client.prompts).toEqual(['hold', 'next ordinary prompt']);
        } else if (scenario === 'rewritten receipt') {
          client.rows.find((r: TranscriptRecord) => r.step_index === step).content = 'changed';
          await expect(runtime.execute('next ordinary prompt', {})).rejects.toThrow();
        } else {
          expect(client.hook('PreToolUse', { stepIdx: client.cursor, toolCall: { id: 'idle', name: 'manage_task', args } }).decision).toBe('deny');
          await expect(runtime.execute('next ordinary prompt', {})).rejects.toThrow();
          expect(client.prompts).toEqual(['hold']);
        }
      } else {
        await expect(turn).rejects.toThrow();
        await expect(runtime.execute('next ordinary prompt', {})).rejects.toThrow();
        expect(client.prompts).toEqual(['hold']);
      }
      expect(native.clients).toHaveLength(1);
      expect(runtime.reusable).toBe(false);
      expect(runtime.hostScheduleAvailable).toBe(false);
      await runtime.close();
      expect(ownedSessionClosed).toHaveBeenCalledWith(client.session, undefined, undefined, undefined);
    });

  async function captureTimedSession(checkOwnership = true) {
    if (checkOwnership) await executor.configureManagedTools({ url: 'http://127.0.0.1:1', token: 'synthetic', groups: ['scheduling'] });
    const creating = executor.execute('hold');
    await vi.waitFor(() => expect(last()?.release).toBeDefined());
    const id = executor.getSessionId()!;
    if (checkOwnership) {
      expect(() => executor.checkHostScheduleSession('different-session')).toThrow();
      executor.checkHostScheduleSession(id);
    }
    const store = path.join(home, '.remote-cli', 'agy-homes', 'synthetic-thread', '.gemini', 'antigravity-cli');
    const db = path.join(store, 'conversations', id + '.db');
    const transcript = path.join(store, 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl');
    for (const file of [db, transcript]) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, 'Synthetic history');
    }
    last().finish(); last().release({ stopReason: 'end_turn' });
    await expect(creating).resolves.toMatchObject({ success: true });
    return { id, db };
  }
  function yieldCommand(client: ReturnType<typeof last>, tool = 'run_command') {
    const step = client.cursor++;
    client.hook('PreToolUse', { stepIdx: step, toolCall: { id: `call-${step}`, name: tool, args: {} } });
    const id = client.session + '/task-' + step;
    const log = pathToFileURL(path.join(client.launch.env.HOME, '.gemini', 'antigravity-cli', 'brain', client.session,
      '.system_generated', 'tasks', `task-${step}.log`)).href;
    client.row('GENERIC', `Created At: synthetic\nTool is running as a background task with task id: ${id}\nTask Description: First line\nSecond line\nTask logs are available at: ${log}\nAdditional native instructions\ncontinued`, 'MODEL', 'RUNNING', step);
    client.hook('PostToolUse');
    return { id, log, step };
  }
  function completion(client: ReturnType<typeof last>, task: { id: string; log: string }) {
    const result = `Task id "${task.id}" finished with result:\nCommand exited with code 0.\n\nCommand output:\nFirst line\r\nSecond line\r\n\nLog: ${task.log}`;
    client.row('SYSTEM_MESSAGE', NOTIFICATION_PREFIX + `[Message] timestamp=2026-01-01T00:00:00Z sender=${task.id} priority=MESSAGE_PRIORITY_HIGH content=${result}\n</SYSTEM_MESSAGE>`, 'SYSTEM');
  }
  function manageCommand(client: ReturnType<typeof last>, args: Record<string, string>) {
    client.row('PLANNER_RESPONSE', '');
    client.rows.at(-1).tool_calls = [{ name: 'manage_task', args }];
    const stepIdx = client.cursor++;
    const payload = { stepIdx, toolCall: { name: 'manage_task', id: 'manage-' + stepIdx, args } };
    return { payload, decision: client.hook('PreToolUse', payload) };
  }
  it.each(['foreground completion', 'delayed completion', 'missing completion', 'active continuation'])(
    'preserves only live chat after listing an outstanding foreground command: %s', async timing => {
      const { runtime, ownedSessionClosed } = initialRuntime({ hostScheduleChat: true, env: { HOME: home } });
      const turn = runtime.execute('hold', {});
      await vi.waitFor(() => expect(last()?.release).toBeDefined());
      const client = last(), task = yieldCommand(client);
      const { decision, payload } = manageCommand(client, { Action: 'list' });
      expect(decision.decision).toBe('deny');
      client.row('GENERIC', 'Encountered error in step execution: tool call denied by pre-tool hook: ' + decision.reason,
        'MODEL', 'ERROR', payload.stepIdx);
      client.hook('PostInvocation');
      client.hook('PreInvocation', { initialNumSteps: client.cursor });
      if (timing === 'foreground completion') completion(client, task);
      client.finish(); client.release({ stopReason: 'end_turn' });
      await expect(turn).resolves.toMatchObject({ success: true });
      if (timing !== 'foreground completion') {
        await expect(runtime.execute('too soon', {})).rejects.toThrow('completion is pending');
        expect(client.prompts).toEqual(['hold']);
        if (timing !== 'missing completion') {
          client.hook('PostToolUse', { stepIdx: task.step, toolCall: { name: 'run_command', id: 'call-' + task.step, args: {} } });
          client.hook('PreInvocation', { initialNumSteps: client.cursor });
          completion(client, task);
          client.row('PLANNER_RESPONSE', 'Command finished.');
          client.hook('PostInvocation');
          await expect(runtime.execute('before idle Stop', {})).rejects.toThrow('completion is pending');
          client.hook('Stop', { terminationReason: 'NO_TOOL_CALL', error: '', fullyIdle: true, continuationActive: timing === 'active continuation' });
        }
      }
      if (timing === 'active continuation') {
        await expect(runtime.execute('next ordinary prompt', {})).rejects.toThrow();
        expect(client.prompts).toEqual(['hold']);
      } else if (timing !== 'missing completion') {
        await expect(runtime.execute('next ordinary prompt', {})).resolves.toMatchObject({ success: true });
        expect(client.prompts).toEqual(['hold', 'next ordinary prompt']);
      }
      expect(native.clients).toHaveLength(1);
      expect(runtime.reusable).toBe(false);
      expect(runtime.hostScheduleAvailable).toBe(false);
      await runtime.close();
      expect(ownedSessionClosed).toHaveBeenCalledWith(client.session, undefined, undefined, undefined);
    });
  it.each(['cancelled', 'after list', 'missing notice', 'wrong exit log', 'wrong sender', 'rewritten receipt', 'delayed receipt', 'missing receipt', 'wrong receipt', 'missing callback',
    'wrong callback', 'foreign target', 'extra argument', 'worker', 'scheduled', 'loaded'])(
    'limits native kill to an owned live foreground command: %s', async scenario => {
      const { runtime, ownedSessionClosed } = initialRuntime({ hostScheduleChat: true, env: { HOME: home },
        worker: scenario === 'worker', sessionId: scenario === 'loaded' ? native.sessionId : undefined });
      const turn = runtime.execute('hold', scenario === 'scheduled' ? { hostScheduleSessionId: native.sessionId } : {});
      await vi.waitFor(() => expect(last()?.release).toBeDefined());
      const client = last(), task = yieldCommand(client);
      if (scenario === 'after list') {
        const list = manageCommand(client, { Action: 'list' });
        expect(list.decision.decision).toBe('deny');
        client.row('GENERIC', 'Encountered error in step execution: tool call denied by pre-tool hook: ' + list.decision.reason,
          'MODEL', 'ERROR', list.payload.stepIdx);
        client.hook('PostInvocation');
        client.hook('PreInvocation', { initialNumSteps: client.cursor });
      }
      const args: Record<string, string> = { Action: 'kill', TaskId: scenario === 'foreign target' ? 'other/task-0' : task.id };
      if (scenario === 'extra argument') args.extra = 'unexpected';
      const { decision, payload } = manageCommand(client, args);
      const denied = ['foreign target', 'extra argument', 'worker', 'scheduled', 'loaded'].includes(scenario);
      expect(decision.decision).toBe(denied ? 'deny' : 'allow');
      const receipt = () => client.row('GENERIC', 'Task "' + (scenario === 'wrong receipt' ? 'other/task-0' : task.id) + '" cancelled.',
        'MODEL', 'DONE', payload.stepIdx);
      if (denied) client.row('GENERIC', 'Encountered error in step execution: tool call denied by pre-tool hook: ' + decision.reason,
        'MODEL', 'ERROR', payload.stepIdx);
      else {
        if (!['delayed receipt', 'missing receipt'].includes(scenario)) receipt();
        if (scenario !== 'missing callback') client.hook('PostToolUse', scenario === 'wrong callback'
          ? { ...payload, toolCall: { ...payload.toolCall, id: 'another-call' } } : payload);
        if (scenario === 'delayed receipt') receipt();
        if (scenario === 'rewritten receipt') client.rows.at(-1).content = 'Changed terminal';
        if (scenario !== 'missing notice') {
          const sender = scenario === 'wrong sender' ? 'other/task-0' : task.id;
          const log = scenario === 'wrong exit log' ? task.log + '.other' : task.log;
          client.row('SYSTEM_MESSAGE', NOTIFICATION_PREFIX + '[Message] timestamp=2026-01-01T00:00:00Z sender=' + sender
            + ' priority=MESSAGE_PRIORITY_LOW content=Task id "' + task.id + '" was canceled with result:\nTool execution was canceled\nLog: '
            + log + '\n</SYSTEM_MESSAGE>', 'SYSTEM');
        }
      }
      client.finish(); client.release({ stopReason: 'end_turn' });
      if (['cancelled', 'after list', 'delayed receipt'].includes(scenario)) {
        await expect(turn).resolves.toMatchObject({ success: true });
        await expect(runtime.execute('next ordinary prompt', {})).resolves.toMatchObject({ success: true });
        expect(client.prompts).toEqual(['hold', 'next ordinary prompt']);
      } else {
        await expect(turn).rejects.toThrow();
        await expect(runtime.execute('next ordinary prompt', {})).rejects.toThrow();
        expect(client.prompts).toEqual(['hold']);
      }
      expect(native.clients).toHaveLength(1);
      expect(runtime.reusable).toBe(false);
      expect(runtime.hostScheduleAvailable).toBe(false);
      await runtime.close();
      expect(ownedSessionClosed).toHaveBeenCalledWith(client.session, undefined, undefined, undefined);
    });
  it('denies another tool during an idle command notification', async () => {
    const { id } = await captureTimedSession();
    const running = executor.execute('hold', { hostScheduleSessionId: id });
    await vi.waitFor(() => expect(last().prompts).toHaveLength(2));
    const client = last();
    const { step } = yieldCommand(client);
    client.finish(); client.release({ stopReason: 'end_turn' });
    expect((await running).success).toBe(true);
    const original = { id: `call-${step}`, name: 'run_command', args: {} };
    client.hook('PostToolUse', { stepIdx: step, toolCall: original });
    client.hook('PreInvocation', { initialNumSteps: client.cursor });
    expect(executor.isHostScheduleWaitingForCommand(id, cwd)).toBe(true);
    expect(client.hook('PreToolUse', { stepIdx: client.cursor, toolCall: original })).toMatchObject({ decision: 'deny' });
    expect(() => executor.checkHostScheduleSession(id)).toThrow();
  });
  it.each(['confirmed', 'ordinary turn', 'different planner', 'wrong nonce', 'post-tool', 'changed history',
    'extra row', 'missing Stop', 'wrong Stop', 'still busy', 'continued'])(
    'admits the next slot only after a proven idle shell denial: %s', async scenario => {
      const { id } = await captureTimedSession();
      const running = executor.execute('hold', scenario === 'ordinary turn' ? {} : { hostScheduleSessionId: id });
      await vi.waitFor(() => expect(last().prompts).toHaveLength(2));
      const client = last();
      const task = yieldCommand(client);
      client.finish(); client.release({ stopReason: 'end_turn' });
      await expect(running).resolves.toMatchObject({ success: true });
      client.hook('PostToolUse', { stepIdx: task.step, toolCall: { name: 'run_command', id: `call-${task.step}`, args: {} } });
      client.hook('PreInvocation', { initialNumSteps: client.cursor });
      completion(client, task);
      const args = { CommandLine: 'echo synthetic' };
      client.row('PLANNER_RESPONSE', '');
      client.rows.at(-1).tool_calls = [{ name: 'run_command', args: scenario === 'different planner' ? {} : args }];
      const step = client.cursor++;
      const decision = client.hook('PreToolUse', { stepIdx: step, toolCall: { name: 'run_command', id: 'idle-shell', args } });
      expect(decision.decision).toBe('deny');
      expect(() => executor.checkHostScheduleSession(id)).toThrow();
      client.row('GENERIC', 'Encountered error in step execution: tool call denied by pre-tool hook: ' +
        (scenario === 'wrong nonce' ? 'different' : decision.reason), 'MODEL', 'ERROR', step);
      if (scenario === 'post-tool') client.hook('PostToolUse', { stepIdx: step });
      if (scenario === 'changed history') client.rows[0].content += 'changed';
      const ending = client.hook('PostInvocation');
      if (scenario === 'confirmed') expect(ending).toEqual({ terminationBehavior: 'terminate' });
      if (scenario === 'extra row') client.row('GENERIC', 'unexpected');
      if (scenario !== 'missing Stop') client.hook('Stop', {
        terminationReason: scenario === 'wrong Stop' ? 'NO_TOOL_CALL' : 'TERMINAL_CUSTOM_HOOK',
        error: '', fullyIdle: scenario !== 'still busy', continuationActive: scenario === 'continued',
      });
      if (scenario !== 'confirmed') {
        expect(() => executor.checkHostScheduleSession(id)).toThrow();
        expect(client.prompts).toEqual(['hold', 'hold']);
        return;
      }
      executor.checkHostScheduleSession(id);
      await expect(executor.execute('next slot', { hostScheduleSessionId: id })).resolves.toMatchObject({ success: true });
      expect(client.prompts).toEqual(['hold', 'hold', 'next slot']);
      await executor.destroy();
      expect(() => make().checkHostScheduleSession(id)).toThrow();
    });
  it.each(['foreground', 'idle'])('recovers multiple commands after matched %s completion without replay', async timing => {
    const { id } = await captureTimedSession();
    const running = executor.execute('hold', { hostScheduleSessionId: id });
    await vi.waitFor(() => expect(last().prompts).toHaveLength(2));
    const client = last();
    const first = yieldCommand(client), second = yieldCommand(client);
    completion(client, second);
    client.hook('PostToolUse');
    if (timing === 'foreground') completion(client, first);
    client.finish(); client.release({ stopReason: 'end_turn' });
    await expect(running).resolves.toMatchObject({ success: true });
    if (timing === 'idle') {
      expect(executor.isHostScheduleWaitingForCommand(id, cwd)).toBe(true);
      expect(executor.isHostScheduleWaitingForCommand(id, home)).toBe(false);
      expect(executor.isHostScheduleWaitingForCommand('another-session', cwd)).toBe(false);
      expect(() => executor.checkHostScheduleSession(id)).toThrow();
      const pointer = path.join(home, '.remote-cli', 'agy-sessions', 'synthetic-thread.json');
      const original = await fs.readFile(pointer, 'utf8');
      await fs.writeFile(pointer, JSON.stringify({ ...JSON.parse(original), hostGeneration: 'changed' }));
      expect(executor.isHostScheduleWaitingForCommand(id, cwd)).toBe(false);
      await fs.writeFile(pointer, original);
      completion(client, first);
      client.hook('PreInvocation', { initialNumSteps: client.cursor });
      expect(executor.isHostScheduleWaitingForCommand(id, cwd)).toBe(true);
      client.finish();
    }
    expect(executor.isHostScheduleWaitingForCommand(id, cwd)).toBe(false);
    executor.checkHostScheduleSession(id);
    expect(client.prompts).toEqual(['hold', 'hold']);
    native.loadedRows = structuredClone(client.rows);
    await executor.destroy();
    expect(native.confirmTranscript).toHaveBeenCalledWith(client.rows);
    executor = make();
    executor.checkHostScheduleSession(id);
    await expect(executor.execute('next slot', { hostScheduleSessionId: id })).resolves.toMatchObject({ success: true });
    expect(last().prompts).toEqual(['next slot']);
  });
  it.each(['changed receipt', 'wrong log', 'denied tool', 'unknown idle hook', 'different tool', 'failed foreground'])(
    'withholds transient admission after %s', async failure => {
      const { id } = await captureTimedSession();
      const running = executor.execute('hold');
      await vi.waitFor(() => expect(last().prompts).toHaveLength(2));
      const client = last();
      const task = yieldCommand(client, failure === 'different tool' ? 'other' : 'run_command');
      if (failure === 'changed receipt') client.rows.at(-1).content += 'changed';
      if (failure === 'wrong log') completion(client, { ...task, log: task.log + '.other' });
      if (failure === 'denied tool') client.hook('PreToolUse', { stepIdx: client.cursor++, toolCall: { id: 'denied', name: 'schedule', args: {} } });
      client.finish(); client.release({ stopReason: failure === 'failed foreground' ? 'cancelled' : 'end_turn' });
      await running.catch(() => {});
      if (failure === 'unknown idle hook') client.hook('PreInvocation', { initialNumSteps: client.cursor });
      expect(executor.isHostScheduleWaitingForCommand(id, cwd)).toBe(false);
      expect(() => executor.checkHostScheduleSession(id)).toThrow();
      await executor.destroy();
      expect(() => make().checkHostScheduleSession(id)).toThrow();
    });
  it.each(['outstanding', 'unconfirmed transcript'])('withholds a clean checkpoint on close with %s', async failure => {
    const { id } = await captureTimedSession();
    const running = executor.execute('hold');
    await vi.waitFor(() => expect(last().prompts).toHaveLength(2));
    const client = last(), task = yieldCommand(client);
    if (failure === 'unconfirmed transcript') {
      completion(client, task);
      native.confirmTranscript.mockResolvedValue(false);
    }
    client.finish(); client.release({ stopReason: 'end_turn' });
    await expect(running).resolves.toMatchObject({ success: true });
    await executor.destroy();
    expect(() => make().checkHostScheduleSession(id)).toThrow();
  });
  it('can schedule after a clean restart even when the first chat had no tools or timer', async () => {
    const { id } = await captureTimedSession(false);
    await executor.destroy();
    expect(last().prompts).toEqual(['hold']);
    executor = make();
    executor.checkHostScheduleSession(id);
    expect(native.clients).toHaveLength(1);
    await expect(executor.execute('first timed task', { hostScheduleSessionId: id })).resolves.toMatchObject({ success: true });
    expect(last().prompts).toEqual(['first timed task']);
    expect(last().session).toBe(id);
  });
  it('installs scheduling tools on the first allocation even when settings open it before chat', async () => {
    await executor.configureManagedTools({ url: 'http://127.0.0.1:1', token: 'synthetic', groups: ['scheduling'] });
    await executor.setEffort('high');
    expect(last().servers[0].env).toContainEqual({ name: 'REMOTE_CLI_TOOL_GROUPS', value: '["scheduling"]' });
    expect(last().prompts).toEqual([]);
    await executor.execute('first chat');
    executor.checkHostScheduleSession(executor.getSessionId()!);
    expect(last().prompts).toEqual(['first chat']);
    expect(native.clients).toHaveLength(1);
  });
  it.each(['intact', 'changed', 'unexpected-transcript'] as const)(
    'binds a late tool connection to the original settings-only allocation (%s)', async state => {
      await executor.setEffort('high');
      const id = executor.getSessionId()!;
      const root = path.join(last().launch.env.HOME, '.gemini', 'antigravity-cli');
      const db = path.join(root, 'conversations', id + '.db');
      await fs.mkdir(path.dirname(db), { recursive: true });
      await fs.writeFile(db, 'Original settings');
      if (state === 'unexpected-transcript') {
        const transcript = path.join(root, 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl');
        await fs.mkdir(path.dirname(transcript), { recursive: true });
        await fs.writeFile(transcript, 'Unexplained history');
      }
      await executor.configureManagedTools({ url: 'http://127.0.0.1:1', token: 'synthetic', groups: ['scheduling'] });
      expect(last().prompts).toEqual([]);
      expect(() => make().checkHostScheduleSession(id)).toThrow();
      if (state === 'changed') {
        await fs.appendFile(db, 'Changed');
        await expect(executor.execute('first chat')).rejects.toThrow();
        expect(native.clients).toHaveLength(1);
        return;
      }
      await executor.execute('first chat');
      expect(last().session).toBe(id);
      if (state === 'intact') executor.checkHostScheduleSession(id);
      else expect(() => executor.checkHostScheduleSession(id)).toThrow();
      expect(last().prompts).toEqual(['first chat']);
    });
  it('runs a host-timed turn after exact close and reconstruction in the original main conversation', async () => {
    const { id } = await captureTimedSession();
    expect(() => make().checkHostScheduleSession(id)).toThrow();
    native.exitConfirmed = false;
    await expect(executor.destroy()).rejects.toMatchObject({
      message: expect.stringContaining('AGY host retirement is unconfirmed'),
      cause: expect.objectContaining({ message: expect.stringContaining('group unconfirmed') }),
    });
    expect(() => make().checkHostScheduleSession(id)).toThrow();
    native.exitConfirmed = true; await executor.destroy();
    executor = make();
    executor.checkHostScheduleSession(id);
    await expect(executor.execute('scheduled foreground', { hostScheduleSessionId: id })).resolves.toMatchObject({ success: true });
    expect(last().token).toBeUndefined(); expect(last().session).toBe(id);
    expect(last().prompts).toEqual(['scheduled foreground']); expect(last().tasks.size).toBe(0);
    expect(() => make().checkHostScheduleSession(id)).toThrow();
    await executor.destroy(); make().checkHostScheduleSession(id);
  });
  it.each(['conversations', 'brain'])('withholds host timing for a preexisting identity in %s', async directory => {
    const store = path.join(home, '.remote-cli', 'agy-homes', 'synthetic-thread', '.gemini', 'antigravity-cli', directory);
    await fs.mkdir(store, { recursive: true });
    if (directory === 'brain') await fs.mkdir(path.join(store, native.sessionId));
    else await fs.writeFile(path.join(store, native.sessionId + '.db'), 'Preexisting history');
    await executor.configureManagedTools({ url: 'http://127.0.0.1:1', token: 'synthetic', groups: ['scheduling'] });
    await executor.execute('ordinary');
    expect(() => executor.checkHostScheduleSession(native.sessionId)).toThrow();
    await executor.destroy(); expect(() => make().checkHostScheduleSession(native.sessionId)).toThrow();
  });
  it.each(['changed-history', 'failed-load', 'native-owner', 'missing-terminal'] as const)(
    'refuses an unsafe host-timed continuation (%s)', async fault => {
      const { id, db } = await captureTimedSession();
      if (fault === 'missing-terminal') await expect(executor.execute('missing terminal')).rejects.toThrow();
      await executor.destroy(); executor = make();
      if (fault === 'changed-history') await fs.appendFile(db, 'Changed native history');
      if (fault === 'failed-load') native.settingFailure = true;
      if (fault === 'native-owner') {
        await fs.writeFile(path.join(home, '.remote-cli', 'agy-sessions', 'synthetic-thread.json.native-schedules'), '{}');
      }
      await expect(executor.execute('must not run', { hostScheduleSessionId: id })).rejects.toThrow();
      expect(last().prompts).not.toContain('must not run');
      expect(() => executor.checkHostScheduleSession(id)).toThrow();
    });
  it.each([false, true])('keeps questions open and forwards free-form replies on the same ACP host (worker=%s)', async worker => {
    const { runtime } = initialRuntime({ worker });
    const onStream = vi.fn();
    const execution = runtime.execute('ask', { onStream });
    await vi.waitFor(() => expect(runtime.isWaitingInput()).toBe(true));
    expect(runtime.busy).toBe(true);
    await expect(runtime.withOperation('waiting', () => true, async () => {}, true)).rejects.toThrow('waiting for the answer');
    expect(onStream.mock.calls.flat().join('')).toContain('Choose a fixture option.');
    expect(runtime.sendInput('   ')).toBe(false);
    expect(runtime.sendInput('ask again')).toBe(true);
    await vi.waitFor(() => expect(runtime.isWaitingInput()).toBe(true));
    expect(runtime.sendInput('First, with extra details.')).toBe(true);
    await expect(execution).resolves.toMatchObject({ success: true, output: 'Synthetic result' });
    expect(native.clients).toHaveLength(1);
    expect(last().prompts).toEqual(['ask', 'ask again', 'First, with extra details.']);
    expect(runtime.sessionId).toBe(native.sessionId);
    expect(runtime.isWaitingInput()).toBe(false);
    expect(runtime.busy).toBe(false);
  });

  it('clears the wait on abort and does not send an answer after cancellation', async () => {
    const { runtime } = initialRuntime();
    const execution = runtime.execute('ask', {});
    await vi.waitFor(() => expect(runtime.isWaitingInput()).toBe(true));
    await expect(runtime.abort()).resolves.toBe(true);
    await expect(execution).resolves.toMatchObject({ success: false });
    expect(last().cancelled).toBe(true);
    expect(runtime.sendInput('Late response')).toBe(false);
    expect(last().prompts).toEqual(['ask']);
    expect(runtime.busy).toBe(false);
    expect(runtime.blocked).toBeTruthy();
  });

  it('keeps an unexplained missing Stop fenced without leaving the queue busy', async () => {
    const { runtime } = initialRuntime();
    await expect(runtime.execute('missing terminal', {})).rejects.toThrow('foreground output is unconfirmed');
    expect(runtime.isWaitingInput()).toBe(false);
    expect(runtime.busy).toBe(false);
    await expect(runtime.execute('next', {})).rejects.toThrow('terminal is missing');
    expect(last().prompts).toEqual(['missing terminal']);
  });

  it('leaves native defaults unchanged when no settings are requested', async () => {
    const { runtime } = initialRuntime({ model: undefined, effort: undefined });
    await runtime.start(); expect(last().controls).toEqual([]); expect(last().prompts).toEqual([]);
  });
  it('does not admit a host when hook verification failed before allocation completed', async () => {
    let release!: () => void; native.settingWait = new Promise(resolve => { release = resolve; });
    const { runtime } = initialRuntime(); const starting = runtime.start();
    const refused = expect(starting).rejects.toThrow('stage=host-admission');
    await vi.waitFor(() => expect(last()?.controls).toHaveLength(1)); native.fault(); release();
    await refused; expect(last().prompts).toEqual([]); expect(native.bind).not.toHaveBeenCalled();
  });
  it('holds prompts and host admission until settings finish, after durable selection', async () => {
    let release!: () => void; native.settingWait = new Promise(resolve => { release = resolve; });
    const { runtime, pointer } = initialRuntime(); const starting = runtime.start();
    await vi.waitFor(() => expect(last()?.controls).toHaveLength(1));
    expect(JSON.parse(await fs.readFile(pointer, 'utf8'))).toMatchObject({ transport: 'acp', retired: false });
    expect(last().token).toBeUndefined(); expect(native.bind).not.toHaveBeenCalled(); expect(last().prompts).toEqual([]);
    release(); await starting; expect(last().token).toBeDefined(); expect(native.bind).toHaveBeenCalledOnce();
    await runtime.execute('hello', {}); expect(last().prompts).toEqual(['hello']);
  });
  it('keeps failed settings unretired and guides the next chat through explicit archival reset', async () => {
    native.settingFailure = true;
    await expect(executor.execute('do not send')).rejects.toThrow('stage=session-settings, reason=unsupported-setting');
    const client = last(), pointer = path.join(home, '.remote-cli', 'agy-sessions', 'synthetic-thread.json');
    expect(JSON.parse(await fs.readFile(pointer, 'utf8'))).toMatchObject({ transport: 'acp', retired: false });
    expect(client.closed).toBe(true); expect(client.prompts).toEqual([]); expect(client.token).toBeUndefined();
    await expect(executor.execute('still refused')).rejects.toThrow('explicit /clear');
    expect(native.clients).toHaveLength(1);
    await executor.destroy(); executor = make();
    await expect(executor.execute('refused after restart')).rejects.toThrow('explicit /clear');
    await executor.resetContext(); expect(await fs.readdir(pointer + '.detached-acp')).toHaveLength(1);
    native.settingFailure = false; native.sessionId = 'fresh-synthetic-session';
    await executor.execute('fresh chat'); expect(last().session).toBe('fresh-synthetic-session');
    expect(last().prompts).toEqual(['fresh chat']);
  });
  it('retains an unconfirmed cleanup runtime until its exact group can be joined', async () => {
    native.settingFailure = true; native.exitConfirmed = false;
    await expect(executor.execute('do not send')).rejects.toThrow('stage=cleanup');
    expect(native.restore).not.toHaveBeenCalled();
    native.exitConfirmed = true; await executor.destroy();
    expect(native.restore).toHaveBeenCalledOnce();
    const pointer = path.join(home, '.remote-cli', 'agy-sessions', 'synthetic-thread.json');
    expect(JSON.parse(await fs.readFile(pointer, 'utf8')).retired).toBe(false);
  });
  it('does not fall back after allocation when saving the initial pointer fails', async () => {
    const { runtime, ownedSessionClosed } = initialRuntime({ saveSession: () => { throw new Error('Synthetic private filesystem material'); } });
    await expect(runtime.start()).rejects.toThrow('stage=session-save'); expect(last().prompts).toEqual([]);
    expect(last().controls).toEqual([]); expect(ownedSessionClosed).not.toHaveBeenCalled();
  });
  it.each(['', '../outside', 'x'.repeat(129), 123])('never falls back after malformed allocation %#', async id => {
    native.sessionId = id as string; const { runtime, saveSession } = initialRuntime();
    await expect(runtime.start()).rejects.toThrow('stage=session-create');
    expect(saveSession).not.toHaveBeenCalled(); expect(last().prompts).toEqual([]); expect(native.bind).not.toHaveBeenCalled();
  });
  it('joins shutdown during initial settings without prompting or granting successor permission', async () => {
    let release!: () => void; native.settingWait = new Promise(resolve => { release = resolve; });
    const { runtime, ownedSessionClosed } = initialRuntime();
    const pending = runtime.start(); const rejected = expect(pending).rejects.toThrow('stage=session-settings');
    await vi.waitFor(() => expect(last()?.controls).toHaveLength(1));
    const closing = runtime.close(); release(); await rejected; await closing;
    expect(last().controls).toHaveLength(1); expect(last().prompts).toEqual([]); expect(ownedSessionClosed).not.toHaveBeenCalled();
  });
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
    await executor.withNativeScheduleOperation('legacy-host', () => true, async () => {}, false);
    await executor.execute('hello', { onStream: stream, onDisplayText: display, resolvePrompt: id => `hello ${id}` });
    const client = last(); expect(client.prompts[0]).toBe('hello synthetic-session');
    expect(client.args).toContain('acp'); expect(client.args).not.toContain('--model'); expect(client.args).not.toContain('--effort');
    expect(client.controls).toEqual([['model', 'synthetic-model'], ['thought_level', 'high']]);
    expect(client.launch.env.HOME).toBe(path.join(home, '.remote-cli', 'agy-homes', 'synthetic-thread'));
    expect(client.launch.env.USERPROFILE).toBe(client.launch.env.HOME);
    expect(stream).toHaveBeenCalledWith('Synthetic streamed text'); expect(display).toHaveBeenCalled();
    const events: any[] = [];
    const handle = await legacyJob(e => events.push(e));
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
  it('retains cancelled ownership when an ordinary tool leaves unknown background work', async () => {
    const events: any[] = [];
    await legacyJob(e => events.push(e));
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
  it('authorizes exact in-turn cancellation receipts and projects their tool cards on the original turn', async () => {
    const handle = await legacyJob();
    const onToolUse = vi.fn(), onToolResult = vi.fn();
    const pending = executor.execute('hold', { onToolUse, onToolResult });
    await vi.waitFor(() => expect(last().release).toBeTypeOf('function'));
    expect(await last().callbacks.onPermissionRequest('Synthetic tool', [
      { kind: 'reject_once', optionId: 'no' }, { kind: 'allow_once', optionId: 'yes' },
    ])).toBe(1);
    const cancelling = executor.withNativeScheduleOperation('cancel', () => true, () => handle.cancel(), true);
    for (const args of [{ Action: 'list' }, { Action: 'kill', TaskId: handle.nativeId }, { Action: 'list' }]) {
      const action = { tool: 'manage_task', input: args };
      await vi.waitFor(() => expect(executor.nativeScheduleAction('cancel')).toEqual(action));
      expect(executor.nativeScheduleAction('wrong')).toBeUndefined();
      expect(executor.hasPendingScheduleMutation()).toBe(true);
      last().tool(action);
    }
    await cancelling;
    expect(executor.hasPendingScheduleMutation()).toBe(false);
    expect(onToolUse).toHaveBeenCalledTimes(3);
    expect(onToolResult).toHaveBeenCalledWith(expect.objectContaining({ is_error: false }));
    expect(last().prompts).toEqual(['hold']);
    last().finish(); last().release({ stopReason: 'end_turn' }); await pending;
  });
  it('never reconstructs scheduled ACP work or produces an exit checkpoint', async () => {
    const handle = await legacyJob();
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
    const handle = await legacyJob(); await handle.cancel();
    const original = executor.getSessionId(); await executor.destroy(); executor = make();
    await expect(executor.execute('must not assume native hook safety')).rejects.toThrow('cannot safely resume');
    expect(executor.getSessionId()).toBe(original); expect(native.clients).toHaveLength(1);
  });
  it('preserves ordinary chat abort compatibility when no schedules have ever been created', async () => {
    const foreground = executor.execute('hold'); await vi.waitFor(() => expect(last()?.release).toBeTypeOf('function'));
    const session = executor.getSessionId();
    expect(await executor.abort()).toBe(true); await foreground;
    expect(last().closed).toBe(false); expect(executor.getSessionId()).toBe(session);
    expect(executor.hasPendingCancellation()).toBe(false);
    expect(native.restore).not.toHaveBeenCalled();
    await expect(executor.execute('continue original')).resolves.toMatchObject({ success: true });
    expect(native.clients).toHaveLength(1);
  });
  it.each(['setModel', 'setEffort', 'clearModel'] as const)('confirms %s on the same ACP host and permanently removes schedule admission', async operation => {
    await executor.execute('hello'); const session = executor.getSessionId();
    if (operation === 'setModel') await executor.setModel('other');
    if (operation === 'setEffort') await executor.setEffort('low');
    if (operation === 'clearModel') await executor.clearModel();
    expect(last().closed).toBe(false); expect(executor.getSessionId()).toBe(session);
  });
  it.each(['timeout', 'inactivityTimeout'] as const)('bounds %s and continues ordinary ACP chat without losing the pointer', async field => {
    const pending = executor.execute('hold', { [field]: 15 });
    const result = await pending;
    expect(result.success).toBe(false); expect(last().cancelled).toBe(true); expect(last().closed).toBe(false);
    expect(executor.getSessionId()).toBe('synthetic-session'); expect(executor.hasPendingCancellation()).toBe(false);
  });
  it('joins startup before shutdown and never admits a session after concurrent destroy', async () => {
    let release!: () => void;
    native.initializeWait = new Promise(resolve => { release = resolve; });
    const executing = executor.execute('must not dispatch');
    const rejected = expect(executing).rejects.toThrow('stage=initialize');
    await vi.waitFor(() => expect(native.clients).toHaveLength(1));
    const closing = executor.destroy(); release(); await closing; await rejected;
    expect(last().closed).toBe(true); expect(last().prompts).toEqual([]);
    expect(executor.getSessionId()).toBeNull(); expect(native.restore).toHaveBeenCalledOnce();
  });
  it.each(['delete', 'reset', 'directory'] as const)('joins the owned host before %s after cancellation before the first wake', async operation => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2030-01-01T00:00:05Z'));
    const handle = await legacyJob();
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
    const handle = await legacyJob(); await handle.cancel();
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
      const handle = await legacyJob();
      await handle.cancel();
      const raw = executor as any, runtime = raw.acp, owner = { ...raw.scheduleOwner };
      const pointer = path.join(home, '.remote-cli', 'agy-sessions', 'synthetic-thread.json');
      if (fault === 'lock') await fs.mkdir(pointer + '.checkpoint.lock');
      if (fault === 'foreign-owner') raw.scheduleOwner.sessionId = 'other-session';
      if (fault === 'unknown-host') raw.acp = undefined;
      if (fault === 'live-sibling') await legacyJob(undefined, { ...input(), id: 'sibling' });
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
    await legacyJob();
    await expect(executor.resetContext()).rejects.toThrow('unresolved ownership');
    await executor.stopForContextReset(); await executor.resetContext();
    expect(executor.getSessionId()).toBeNull();
    await expect(fs.stat(path.join(home, '.remote-cli', 'agy-sessions', 'synthetic-thread.json.native-schedules'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(native.clients).toHaveLength(1);
  });
  it('does not certify group retirement or remove hooks on uncertain exit', async () => {
    await legacyJob(); native.exitConfirmed = false;
    await expect(executor.destroy()).rejects.toThrow('unconfirmed');
    expect(native.restore).not.toHaveBeenCalled();
    const retained = JSON.parse(await fs.readFile(path.join(home, '.remote-cli', 'agy-sessions', 'synthetic-thread.json.native-schedules'), 'utf8'));
    expect(retained.retired).toBe(false);
    native.exitConfirmed = true; await (executor as any).acp.close();
  });
  it('exposes no executor or runtime method to install a native definition', async () => {
    expect(executor).not.toHaveProperty('createNativeSchedule');
    await executor.execute('ordinary chat');
    expect(executor['acp']).not.toHaveProperty('create');
    expect(last().tasks.size).toBe(0);
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
  it('loads only the supplied worker identity without granting schedule admission', async () => {
    const { runtime, saveSession } = initialRuntime({ worker: true, sessionId: 'synthetic-retained' });
    await runtime.start(); expect(saveSession).toHaveBeenCalledWith('synthetic-retained'); expect(last().token).toBeUndefined();
    await expect(runtime.withOperation('op', () => true, async () => undefined, false)).rejects.toThrow('loaded sessions');
    expect((await runtime.execute('new task', {})).success).toBe(true);
    expect(last().prompts).toEqual(['new task']);
  });
  it('serializes confirmed mode controls with prompts and schedule admission', async () => {
    const { runtime } = initialRuntime(); await runtime.start();
    let release!: () => void; native.settingWait = new Promise(resolve => { release = resolve; });
    const changing = runtime.changeSettings({ mode: 'plan' });
    await vi.waitFor(() => expect(last().controls.at(-1)).toEqual(['mode', 'plan']));
    await expect(runtime.execute('overlap', {})).rejects.toThrow('active');
    await expect(runtime.withOperation('overlap', () => true, async () => undefined, false)).rejects.toThrow('settings');
    release(); await changing; expect(last().mode).toBe('plan'); expect(last().token).toBeUndefined();
    await runtime.execute('after control', {}); expect(last().prompts).toEqual(['after control']);
  });
  it('projects worker ERROR as failure even when ACP ends normally', async () => {
    const { runtime } = initialRuntime({ worker: true }); await runtime.start();
    const client = last(); client.prompt = async () => {
      client.hook('PreInvocation', { initialNumSteps: 0 });
      client.hook('PostInvocation'); client.hook('Stop', { terminationReason: 'ERROR', error: 'Synthetic native failure' });
      return { stopReason: 'end_turn' };
    };
    expect(await runtime.execute('worker task', {})).toMatchObject({ success: false, error: 'AGY native turn failed.' });
  });
  it('forwards image blocks and text exactly once with activity on ordinary worker chat', async () => {
    const { runtime } = initialRuntime({ worker: true }); await runtime.start(); const client = last();
    const prompt = vi.spyOn(client, 'prompt'); const stream = vi.fn(), activity = vi.fn();
    await runtime.execute('image task', { onStream: stream, onActivity: activity,
      attachments: [{ type: 'image', data: 'c3ludGhldGlj', mimeType: 'image/png' }] });
    expect(prompt.mock.calls[0][1]).toEqual([{ type: 'text', text: 'image task' }, { type: 'image', data: 'c3ludGhldGlj', mimeType: 'image/png' }]);
    expect(stream).toHaveBeenCalledOnce(); expect(activity).toHaveBeenCalled();
  });

  it('preserves observed background uncertainty through foreground cancellation', async () => {
    const { runtime } = initialRuntime(); const pending = runtime.execute('hold', {});
    await vi.waitFor(() => expect(last()?.release).toBeDefined());
    const client = last(); client.row('GENERIC', 'Synthetic unfinished native tool', 'MODEL', 'RUNNING');
    client.hook('PostToolUse'); expect(runtime.reusable).toBe(false);
    await runtime.abort(); expect((await pending).success).toBe(false);
    await expect(runtime.execute('do not resume', {})).rejects.toThrow('unsettled native work');
    expect(client.prompts).toEqual(['hold']);
  });

  it('does not clear an earlier invalid hook boundary when cancellation later confirms', async () => {
    const { runtime } = initialRuntime(); const pending = runtime.execute('hold', {});
    await vi.waitFor(() => expect(last()?.release).toBeDefined());
    last().hook('PostInvocation', { invocationNum: 99 });
    await runtime.abort(); expect((await pending).success).toBe(false);
    await expect(runtime.execute('refused successor', {})).rejects.toThrow('invalid or incomplete');
    expect(last().prompts).toEqual(['hold']);
  });

});

vi.mock('../../src/delegation/OwnershipRuntime', async load => {
  const actual = await load<typeof import('../../src/delegation/OwnershipRuntime')>();
  const { syntheticOwnershipRuntime } = await import('../delegation/syntheticOwnershipRuntime');
  return syntheticOwnershipRuntime(actual);
});
describe('review regressions through the AGY executor and runtime', () => {
  it('opens fresh ACP after explicit main clear of a crash-left owned overlay', async () => {
    const pointer = path.join(home, '.remote-cli', 'agy-sessions', 'synthetic-thread.json');
    await fs.writeFile(pointer, JSON.stringify({ id: 'synthetic-old-main', transport: 'acp', retired: false }));
    const threadHome = path.join(home, '.remote-cli', 'agy-homes', 'synthetic-thread');
    await fs.mkdir(threadHome, { recursive: true }); await crashAgyOverlay(threadHome);
    executor = make(); native.realHooks = true;
    await expect(executor.execute('refused before clear')).rejects.toThrow('explicit /clear');
    await executor.resetContext(); expect((await executor.execute('fresh task')).success).toBe(true);
    expect(last().prompts).toEqual(['fresh task']); expect(executor.getSessionId()).toBe('synthetic-session');
    expect(await fs.readdir(pointer + '.detached-acp')).toHaveLength(1);
  });
  it.each(['schedule', 'manage_task', 'missed-hook'])('cannot persist reusable worker proof after %s followed by DONE and Stop success', async name => {
    executor = new AgyExecutor(new DirectoryGuard([cwd]), { threadId: 'synthetic-thread', initialWorkingDirectory: cwd, delegationWorker: true });
    const pending = executor.execute('hold');
    await vi.waitFor(() => expect(last()?.prompts).toContain('hold'));
    const client = last(), step = client.cursor++;
    if (name !== 'missed-hook') expect(client.hook('PreToolUse', { stepIdx: step, toolCall: { id: 'synthetic-call', name, args: {} } }).decision).toBe('deny');
    client.row('GENERIC', `Tool is running as a background task with task id: ${client.session}/task-${step}\nTask Description: synthetic timer\nTask logs are available at: file://synthetic/log`, 'MODEL', 'DONE', step);
    client.finish(); client.release({ stopReason: 'end_turn' });
    await expect(pending).rejects.toThrow();
    await expect(executor.configureManagedTools()).resolves.toBeUndefined(); // identical configuration does no reconnect
    expect((executor as any).acp.reusable).toBe(false);
    await expect(executor.setModel('synthetic-next')).rejects.toThrow('uncertain work');
    await expect(executor.execute('next task')).rejects.toThrow();
    await executor.destroy();
    const pointer = path.join(home, '.remote-cli', 'agy-sessions', 'synthetic-thread.json');
    expect(JSON.parse(await fs.readFile(pointer + '.worker-policy', 'utf8'))).toMatchObject({ policy: 'hook-denial-v2', settled: false, closed: true });
    executor = new AgyExecutor(new DirectoryGuard([cwd]), { threadId: 'synthetic-thread', initialWorkingDirectory: cwd, delegationWorker: true });
    await expect(executor.execute('unsafe load')).rejects.toThrow('explicit /clear'); expect(native.clients).toHaveLength(1);
    await executor.resetContext(); expect((await executor.execute('fresh after clear')).success).toBe(true);
  });
  it('refuses controlled reconnect of a main host that returned a denial', async () => {
    const pending = executor.execute('hold'); await vi.waitFor(() => expect(last()?.prompts).toContain('hold'));
    expect(last().hook('PreToolUse', { stepIdx: 0, toolCall: { id: 'synthetic-deny', name: 'schedule', args: {} } }).decision).toBe('deny');
    last().finish(); last().release({ stopReason: 'end_turn' });
    await expect(pending).rejects.toThrow('tool denial');
    await expect(executor.configureManagedTools({ url: 'http://127.0.0.1:1', token: 'synthetic-next' })).rejects.toThrow('reconnect was refused');
    expect(native.clients).toHaveLength(1);
  });
  it.each(['setModel', 'setEffort'] as const)('releases closed startup reached through %s and guides later settings to clear', async method => {
    native.settingFailure = true;
    await expect(executor[method](method === 'setModel' ? 'synthetic-model' : 'high')).rejects.toThrow('stage=session-settings');
    native.settingFailure = false;
    await expect(executor.setModel('synthetic-model')).rejects.toThrow('explicit /clear');
    await expect(executor.setEffort('high')).rejects.toThrow('explicit /clear');
    expect(native.clients).toHaveLength(1);
  });
  it('does not advertise destructive settings recovery while a confirmed control is in flight', async () => {
    await executor.execute('first'); let release!: () => void; native.settingWait = new Promise(resolve => { release = resolve; });
    const pending = executor.setModel('synthetic-next'); await vi.waitFor(() => expect(last().controls.at(-1)).toEqual(['model', 'synthetic-next']));
    expect(executor.hasPendingSettingsChange()).toBe(false); expect(executor.isBusy()).toBe(true);
    await expect(executor.resetContext()).rejects.toThrow('pending'); release(); await pending;
  });

  it('routes /abort to an active AGY foreground turn without a settings change', async () => {
    const threads = await ThreadManager.initialize(home);
    const threadId = threads.getDefaultThread().id;
    await threads.updateThread(threadId, { workingDirectory: cwd, delegation: false });
    const guard = new DirectoryGuard([cwd]);
    const config = { type: 'agy' as const };
    const pool = new ThreadExecutorPool(threads, guard, config);
    const send = vi.fn();
    const handler = new MessageHandler({ send, trackTask: vi.fn(), isConnected: () => true } as any,
      pool, threads, guard, { get: (key: string) => key === 'executor' ? config : undefined, getConfigDir: () => home } as any);
    const command = (content: string, messageId: string) => handler.handleMessage({
      type: 'command', threadId, messageId, openId: 'synthetic-owner', content, timestamp: Date.now(),
    });
    const turn = command('hold', 'foreground');
    try {
      await vi.waitFor(() => {
        const response = send.mock.calls.find(([message]) => message.type === 'response' && message.messageId === 'foreground');
        expect(response?.[0].error).toBeUndefined();
        expect(last()?.release).toBeTypeOf('function');
      });
      expect(pool.getExecutor(threadId).isBusy?.()).toBe(true);
      expect(last().controls).toEqual([]);
      await command('/abort', 'abort');
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'response', messageId: 'abort',
        openId: 'synthetic-owner', threadId, success: true, output: expect.stringContaining('AGY foreground cancelled') }));
      expect(last().cancelled).toBe(true);
    } finally {
      last()?.release?.({ stopReason: 'cancelled' });
      await turn;
      await handler.destroy();
    }
  });
});

describe('AGY review persistence at idle boundaries', () => {
  it('invalidates a settled worker proof immediately on an idle denial', async () => {
    executor = new AgyExecutor(new DirectoryGuard([cwd]), { threadId: 'synthetic-thread', initialWorkingDirectory: cwd, delegationWorker: true });
    await executor.execute('clean task');
    const pointer = path.join(home, '.remote-cli', 'agy-sessions', 'synthetic-thread.json.worker-policy');
    expect(JSON.parse(await fs.readFile(pointer, 'utf8')).settled).toBe(true);
    last().hook('PreToolUse', { stepIdx: last().cursor++, toolCall: { id: 'idle-call', name: 'manage_task', args: {} } });
    expect(JSON.parse(await fs.readFile(pointer, 'utf8')).settled).toBe(false);
    await executor.destroy(); expect(JSON.parse(await fs.readFile(pointer, 'utf8'))).toMatchObject({ settled: false, closed: true });
  });
  it('preserves allocation uncertainty reached through a settings startup', async () => {
    native.sessionId = '';
    await expect(executor.setModel('synthetic-model')).rejects.toThrow('stage=session-create');
    await expect(executor.setEffort('high')).rejects.toThrow('allocation');
    await expect(executor.resetContext()).rejects.toThrow('allocation');
    expect(native.clients).toHaveLength(1);
  });
});

it('lets owned restoration resolve a missing config directory before HOME relinking on fresh startup', async () => {
  const shared = path.join(home, '.gemini', 'config'); await fs.mkdir(shared, { recursive: true });
  await fs.writeFile(path.join(shared, 'hooks.json'), '{}');
  const threadHome = path.join(home, '.remote-cli', 'agy-homes', 'synthetic-thread');
  await fs.mkdir(path.join(threadHome, '.gemini'), { recursive: true });
  await fs.symlink(shared, path.join(threadHome, '.gemini', 'config'), process.platform === 'win32' ? 'junction' : 'dir');
  await crashAgyOverlay(threadHome, { crashRename: 3 });
  await expect(fs.lstat(path.join(threadHome, '.gemini', 'config'))).rejects.toMatchObject({ code: 'ENOENT' });
  executor = make(); native.realHooks = true;
  expect((await executor.execute('fresh startup')).success).toBe(true);
  await executor.destroy();
  expect((await fs.lstat(path.join(threadHome, '.gemini', 'config'))).isSymbolicLink()).toBe(true);
  expect(await fs.readFile(path.join(shared, 'hooks.json'), 'utf8')).toBe('{}');
});
