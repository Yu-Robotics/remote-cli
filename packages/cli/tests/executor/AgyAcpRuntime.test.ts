import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import { randomUUID } from 'crypto';
import type { ExecuteOptions } from '../../src/executor/IExecutor';
import fsSync from 'fs';
import { AgyAcpRuntime } from '../../src/executor/agy/AgyAcpRuntime';
import type { AcpSessionSetup } from '../../src/executor/acp/AcpClient';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import type { AcpEventCallbacks } from '../../src/executor/acp/AcpClient';
import type { HookPayload } from '../../src/scheduling/agy/AgySessionSchedules';
import { AgyManualResumeScheduleSkip, type NativeScheduleEvent } from '../../src/scheduling/types';
import type { TranscriptRecord } from '../../src/scheduling/agy/transcript';
import { NOTIFICATION_PREFIX, parseTranscript } from '../../src/scheduling/agy/transcript';
import { createExecutor } from '../../src/executor';
import { AgyExecutor } from '../../src/executor/AgyExecutor';
import { crashAgyOverlay } from '../scheduling/agyHookCrashFixture';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { MessageHandler } from '../../src/client/MessageHandler';
import { ThreadExecutorPool } from '../../src/thread/ThreadExecutorPool';
import { FeishuLongConnHandler } from '../../../router/src/feishu/FeishuLongConnHandler';
import { BindingManager } from '../../../router/src/binding/BindingManager';
import { JsonStore } from '../../../router/src/storage/JsonStore';
import { ThreadManager } from '../../src/thread/ThreadManager';

const native = vi.hoisted(() => ({
  clients: [] as any[], accept: undefined as any, fault: undefined as any,
  restore: vi.fn(async () => {}), configure: vi.fn(async () => {}), bind: vi.fn(),
  settingFailure: false, settingWait: undefined as Promise<void> | undefined, sessionId: 'synthetic-session',
  duringLoad: undefined as (() => Promise<void>) | undefined, realHooks: false, nativeAvailable: true, exitConfirmed: true, home: '', initializeWait: undefined as Promise<void> | undefined,
  loadedRows: undefined as TranscriptRecord[] | undefined, agentVersion: undefined as string | undefined,
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
    constructor(private home: string, accept: any, fault: any) { native.accept = accept; native.fault = fault; }
    async start() { return { url: 'http://127.0.0.1:1/hook', token: 'synthetic-token' }; }
    bindSession = native.bind;
    async readCheckpointTranscript() {
      return parseTranscript(await fs.readFile(transcriptPath(this.home, native.sessionId), 'utf8'));
    }
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
  async initialize() { await native.initializeWait; return native.agentVersion ? { agentInfo: { name: 'Antigravity ACP Server', version: native.agentVersion } } : {}; }
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
    await native.duringLoad?.();
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
function transcriptPath(agyHome: string, id: string) {
  return path.join(agyHome, '.gemini', 'antigravity-cli', 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl');
}
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
  native.duringLoad = undefined; native.loadedRows = undefined; native.agentVersion = undefined;
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
  it.each(['confirmed', 'worker', 'loaded', 'mutation', 'extra args', 'planner mismatch', 'missing', 'wrong nonce', 'wrong source',
    'rewritten planner', 'malformed call', 'missing Stop',
    'wrong step', 'wrong status', 'late post-tool', 'other unfinished tool', 'failed Stop', 'rewritten receipt', 'idle tool'])(
    'requires a verified management denial on the original main foreground session: %s', async scenario => {
      const worker = scenario === 'worker';
      const { runtime, ownedSessionClosed } = initialRuntime({ hostScheduleChat: !worker, worker,
        sessionId: scenario === 'loaded' ? native.sessionId : undefined });
      const turn = runtime.execute('hold', {});
      await vi.waitFor(() => expect(last()?.release).toBeDefined());
      const client = last();
      const args = scenario === 'malformed call' ? null : scenario === 'mutation' ? { Action: 'kill' }
        : scenario === 'extra args' ? { Action: 'list', TaskId: 'other' } : { Action: 'list' };
      client.row('PLANNER_RESPONSE', '');
      client.rows.at(-1).tool_calls = [{ name: 'manage_task', args: scenario === 'planner mismatch' ? {} : args }];
      const step = client.cursor++;
      const decision = client.hook('PreToolUse', { stepIdx: step, toolCall: { name: 'manage_task', id: 'list-call', args } });
      expect(decision.decision).toBe('deny');
      if (scenario === 'rewritten planner') client.rows.at(-1).content += 'changed';
      if (scenario !== 'missing') {
        const text = 'Encountered error in step execution: tool call denied by pre-tool hook: ' +
          (scenario === 'wrong nonce' ? 'unrelated' : decision.reason);
        client.row('GENERIC', text, scenario === 'wrong source' ? 'SYSTEM' : 'MODEL', scenario === 'wrong status' ? 'DONE' : 'ERROR',
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
      if (scenario !== 'missing Stop') client.hook('Stop', { terminationReason: scenario === 'failed Stop' ? 'ERROR' : 'NO_TOOL_CALL', error: scenario === 'failed Stop' ? 'failed' : '' });
      client.release({ stopReason: 'end_turn' });
      if (['confirmed', 'mutation', 'extra args', 'rewritten receipt', 'idle tool'].includes(scenario)) {
        expect(await turn).toMatchObject({ success: true, output: 'Listing unavailable.' });
        if (['confirmed', 'mutation', 'extra args'].includes(scenario)) {
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
  function manageCommand(client: ReturnType<typeof last>, args: Record<string, string>, plannerArgs = args) {
    client.row('PLANNER_RESPONSE', '');
    client.rows.at(-1).tool_calls = [{ name: 'manage_task', args: plannerArgs }];
    const stepIdx = client.cursor++;
    const payload = { stepIdx, toolCall: { name: 'manage_task', id: 'manage-' + stepIdx, args } };
    return { payload, decision: client.hook('PreToolUse', payload) };
  }
  it.each(['confirmed', 'replayed nonce'])('verifies repeated refusals across ordinary prompts: %s', async scenario => {
    const requests = [{ Action: 'send_input', TaskId: 'other/task-1', Input: 'synthetic input' },
      { Action: 'unsupported' }, {}] as Record<string, string>[];
    const reasons = new Set<string>();
    for (let turnIndex = 0; turnIndex < 2; turnIndex++) {
      const turn = executor.execute('hold');
      await vi.waitFor(() => expect(last()?.prompts).toHaveLength(turnIndex + 1));
      const client = last();
      for (const args of requests) {
        const { decision, payload } = manageCommand(client, args);
        expect(decision.decision).toBe('deny');
        expect(decision.reason).toContain('request is unavailable');
        expect(reasons.has(decision.reason)).toBe(false);
        const replay = scenario === 'replayed nonce' && turnIndex === 1;
        const reason = replay ? [...reasons][0] : decision.reason;
        reasons.add(decision.reason);
        client.row('GENERIC', 'Encountered error in step execution: tool call denied by pre-tool hook: ' + reason,
          'MODEL', 'ERROR', payload.stepIdx);
        client.hook('PostInvocation');
        client.hook('PreInvocation', { initialNumSteps: client.cursor });
        if (replay) break;
      }
      client.finish(); client.release({ stopReason: 'end_turn' });
      if (scenario === 'replayed nonce' && turnIndex === 1) {
        await expect(turn).rejects.toThrow();
        await expect(executor.execute('next ordinary prompt')).rejects.toThrow();
      } else {
        await expect(turn).resolves.toMatchObject({ success: true, sessionAbbr: client.session.slice(0, 8) });
      }
      expect(() => executor.checkHostScheduleSession(client.session)).toThrow();
    }
    if (scenario === 'confirmed') {
      await expect(executor.execute('next ordinary prompt')).resolves.toMatchObject({ success: true });
      expect(last().prompts).toEqual(['hold', 'hold', 'next ordinary prompt']);
    }
    expect(native.clients).toHaveLength(1);
    await expect(executor.configureManagedTools({ url: 'http://127.0.0.1:1', token: 'synthetic', groups: ['scheduling'] }))
      .rejects.toThrow('reconnect was refused');
  });
  it.each(['list', 'send_input'].flatMap(action =>
    ['foreground completion', 'delayed completion', 'missing completion', 'active continuation'].map(timing => ({ action, timing }))))(
    'preserves only live chat after $action on an outstanding foreground command: $timing', async ({ action, timing }) => {
      const { runtime, ownedSessionClosed } = initialRuntime({ hostScheduleChat: true, env: { HOME: home } });
      const turn = runtime.execute('hold', {});
      await vi.waitFor(() => expect(last()?.release).toBeDefined());
      const client = last(), task = yieldCommand(client);
      const { decision, payload } = manageCommand(client, action === 'send_input'
        ? { Action: action, TaskId: task.id, Input: 'synthetic input\n' } : { Action: action });
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
  it.each(['foreign session', 'unknown target', 'extra argument', 'missing creation', 'worker', 'scheduled', 'planner mismatch'])(
    'checks target, scope and receipt for a status refusal: %s', async scenario => {
      const { runtime, ownedSessionClosed } = initialRuntime({ hostScheduleChat: true, env: { HOME: home },
        worker: scenario === 'worker' });
      const turn = runtime.execute('hold', scenario === 'scheduled' ? { hostScheduleSessionId: native.sessionId } : {});
      await vi.waitFor(() => expect(last()?.release).toBeDefined());
      const client = last();
      const task = scenario === 'missing creation' ? undefined : yieldCommand(client);
      const args: Record<string, string> = { Action: 'status', TaskId: task?.id ?? client.session + '/task-0' };
      if (scenario === 'foreign session') args.TaskId = 'other/task-0';
      if (scenario === 'unknown target') args.TaskId = client.session + '/task-999';
      if (scenario === 'extra argument') args.extra = 'unexpected';
      const { decision, payload } = manageCommand(client, args, scenario === 'planner mismatch' ? { Action: 'list' } : args);
      expect(decision.decision).toBe('deny');
      const unavailable = ['foreign session', 'unknown target', 'extra argument', 'missing creation'].includes(scenario);
      if (unavailable) {
        expect(decision.reason).toContain('request is unavailable');
        // A refusal for another target never discloses this session's tasks.
        expect(decision.reason).not.toContain(client.session);
      } else {
        expect(runtime.blocked).toBeTruthy();
      }
      client.row('GENERIC', 'Encountered error in step execution: tool call denied by pre-tool hook: ' + decision.reason,
        'MODEL', 'ERROR', payload.stepIdx);
      client.hook('PostInvocation');
      client.hook('PreInvocation', { initialNumSteps: client.cursor });
      if (unavailable && task) completion(client, task);
      client.finish(); client.release({ stopReason: 'end_turn' });
      if (unavailable) {
        await expect(turn).resolves.toMatchObject({ success: true });
        await expect(runtime.execute('next ordinary prompt', {})).resolves.toMatchObject({ success: true });
        expect(client.prompts).toEqual(['hold', 'next ordinary prompt']);
      } else {
        await expect(turn).rejects.toThrow();
        expect(runtime.blocked).toBeTruthy();
        await expect(runtime.execute('next ordinary prompt', {})).rejects.toThrow();
        expect(client.prompts).toEqual(['hold']);
      }
      expect(runtime.hostScheduleAvailable).toBe(false);
      expect(runtime.reusable).toBe(false);
      await runtime.close();
      expect(ownedSessionClosed).toHaveBeenCalledWith(client.session, undefined, undefined, undefined);
    });
  // Native AGY 1.5.13 status shape (isolated ACP probe): a DONE GENERIC row at the
  // manage_task step, prefixed by repeated timestamps, naming the task, status and log.
  function statusReply(client: ReturnType<typeof last>, payload: { stepIdx: number }, task: { id: string; log: string },
    state: 'RUNNING' | 'DONE', options: { target?: string; status?: string } = {}) {
    const stamp = 'Created At: 2026-01-01T00:00:00Z\nCompleted At: 2026-01-01T00:00:00Z\n';
    const output = state === 'DONE' ? 'Log output:\nFirst line\r\nSecond line\r\n\nLast progress: 1s ago\n' : '';
    client.row('GENERIC', stamp + stamp + `Task: ${options.target ?? task.id}\nStatus: ${state}\nLog: ${task.log}\n` + output,
      'MODEL', options.status ?? 'DONE', payload.stepIdx);
  }
  function ownedStatus(client: ReturnType<typeof last>, task: { id: string; log: string }, state: 'RUNNING' | 'DONE') {
    const { payload, decision } = manageCommand(client, { Action: 'status', TaskId: task.id });
    expect(decision.decision).toBe('allow');
    statusReply(client, payload, task, state);
    client.hook('PostToolUse', payload);
    client.hook('PostInvocation');
    client.hook('PreInvocation', { initialNumSteps: client.cursor });
    return payload;
  }
  function deliverPost(client: ReturnType<typeof last>, task: { step: number }) {
    client.hook('PostToolUse', { stepIdx: task.step, toolCall: { name: 'run_command', id: `call-${task.step}`, args: {} } });
  }
  function ordinaryTool(client: ReturnType<typeof last>, name: string) {
    const args = name === 'write_file' ? { Path: path.join(cwd, 'synthetic'), Content: 'fixture' } : { query: 'synthetic' };
    client.row('PLANNER_RESPONSE', '');
    client.rows.at(-1).tool_calls = [{ name, args }];
    const stepIdx = client.cursor++;
    return { stepIdx, toolCall: { id: 'ordinary-' + stepIdx, name, args } };
  }
  it('continues the same main chat after foreground tool failures and two settled status reads', async () => {
    const { id } = await captureTimedSession();
    const turn = executor.execute('hold');
    turn.catch(() => undefined);
    await vi.waitFor(() => expect(last().prompts).toHaveLength(2));
    const client = last();
    for (const name of ['read_file', 'write_file', 'search_web', 'mcp_fixture_lookup', 'previously_unseen_tool']) {
      const payload = ordinaryTool(client, name);
      expect(client.hook('PreToolUse', payload).decision).toBe('allow');
      client.hook('PostToolUse', { ...payload, error: 'synthetic failure' });
      client.row('GENERIC', 'Completed At: synthetic\nEncountered error in step execution: synthetic failure', 'MODEL', 'ERROR', payload.stepIdx);
      client.hook('PostInvocation');
      client.hook('PreInvocation', { initialNumSteps: client.cursor });
    }
    const first = yieldCommand(client), second = yieldCommand(client);
    for (const task of [first, second]) {
      deliverPost(client, task);
      completion(client, task);
      ownedStatus(client, task, 'DONE');
    }
    client.finish('Synthetic final answer'); client.release({ stopReason: 'end_turn' });
    await expect(turn).resolves.toMatchObject({ success: true, output: 'Synthetic final answer' });
    await expect(executor.execute('ordinary follow-up')).resolves.toMatchObject({ success: true });
    expect(executor.getSessionId()).toBe(id);
    expect(client.prompts).toEqual(['hold', 'hold', 'ordinary follow-up']);
    expect(native.clients).toHaveLength(1);
    executor.checkHostScheduleSession(id);
    await expect(executor.execute('scheduled follow-up', { hostScheduleSessionId: id })).resolves.toMatchObject({ success: true });
    expect(client.prompts.filter((prompt: string) => prompt === 'scheduled follow-up')).toHaveLength(1);
    await expect(executor.configureManagedTools()).rejects.toThrow('reconnect was refused');
    native.loadedRows = structuredClone(client.rows);
    await fs.writeFile(transcriptPath(client.launch.env.HOME, id), client.rows.map((row: TranscriptRecord) => JSON.stringify(row)).join('\n'));
    await executor.destroy();
    expect(native.confirmTranscript).toHaveBeenCalledWith(client.rows);
    executor = make();
    await expect(executor.execute('after clean retirement')).resolves.toMatchObject({ success: true });
    expect(executor.getSessionId()).toBe(id);
    expect(last().prompts).toEqual(['after clean retirement']);
    expect(native.clients).toHaveLength(2);
  });
  it.each(['missing pre', 'duplicate pre', 'duplicate post', 'permission declined', 'missing post and receipt', 'missing post', 'wrong call', 'different error', 'denial text', 'foreign row', 'unfinished',
    'rewritten planner', 'rewritten receipt', 'missing receipt', 'missing Stop', 'continued Stop', 'cancelled'])(
    'refuses main chat reuse with unconfirmed ordinary tool evidence: %s', async scenario => {
      const turn = executor.execute('hold');
      turn.catch(() => undefined);
      await vi.waitFor(() => expect(last()?.release).toBeDefined());
      const client = last();
      const task = yieldCommand(client);
      completion(client, task);
      ownedStatus(client, task, 'DONE');
      const payload = ordinaryTool(client, 'write_file');
      const error = scenario === 'denial text' ? 'tool call denied by pre-tool hook: synthetic' : 'synthetic failure';
      if (scenario !== 'missing pre') expect(client.hook('PreToolUse', payload).decision).toBe('allow');
      if (scenario === 'duplicate pre') client.hook('PreToolUse', payload);
      if (scenario === 'permission declined') {
        expect(await client.callbacks.onPermissionRequest('Synthetic permission', [{ optionId: 'deny', kind: 'reject_once' }])).toBe(-1);
      }
      if (!scenario.startsWith('missing post')) client.hook('PostToolUse', { ...payload, error, toolCall: {
        ...payload.toolCall, id: scenario === 'wrong call' ? 'unrelated' : payload.toolCall.id } });
      if (scenario === 'duplicate post') client.hook('PostToolUse', { ...payload, error });
      if (scenario !== 'missing receipt' && scenario !== 'missing post and receipt') client.row('GENERIC',
        'Encountered error in step execution: ' + (scenario === 'different error' ? 'another failure' : error),
        scenario === 'foreign row' ? 'SYSTEM' : 'MODEL', scenario === 'unfinished' ? 'RUNNING' : 'ERROR', payload.stepIdx);
      client.hook('PostInvocation');
      if (scenario === 'rewritten planner') client.rows.at(-2).content += 'changed';
      if (scenario === 'rewritten receipt') client.rows.at(-1).status = 'DONE';
      client.hook('PreInvocation', { initialNumSteps: client.cursor });
      client.row('PLANNER_RESPONSE', 'Final answer'); client.hook('PostInvocation');
      if (scenario !== 'missing Stop') client.hook('Stop', { terminationReason: 'NO_TOOL_CALL', error: '',
        fullyIdle: true, continuationActive: scenario === 'continued Stop' });
      client.release({ stopReason: scenario === 'cancelled' ? 'cancelled' : 'end_turn' });
      const failure = await turn.catch(error => error);
      if (['missing pre', 'missing post and receipt', 'missing post', 'missing receipt', 'unfinished'].includes(scenario)) {
        expect(failure).toMatchObject({ success: true });
        expect(executor.needsAgyHumanRecovery('next-human-message')).toBe(true);
      } else {
        expect(failure).toBeInstanceOf(Error);
        expect(failure.message).not.toContain('denial enforcement');
      }
      await expect(executor.execute('next ordinary prompt')).rejects.toThrow();
      expect(client.prompts).toEqual(['hold']);
      expect(() => executor.checkHostScheduleSession(client.session)).toThrow();
    });
  /** Native AGY 1.5.13 shape of `read_file` missing `Path`: planner, INVALID, no tool hooks or ACP dispatch. */
  function rejectedRead(client: ReturnType<typeof last>, args: Record<string, unknown> | undefined = {},
    options: { error?: string; text?: string; name?: string } = {}) {
    client.row('PLANNER_RESPONSE', '');
    client.rows.at(-1).tool_calls = [args === undefined ? { name: options.name ?? 'read_file' } : { name: options.name ?? 'read_file', args }];
    const error = options.error ?? "invalid arguments:\n- missing property 'Path'";
    client.row('GENERIC', 'Created At: synthetic\nCompleted At: synthetic\n' + (options.text ?? 'Error invalid tool call: ' + error),
      'MODEL', 'INVALID');
    client.rows.at(-1).error = error;
    return client.cursor - 1;
  }
  function correctedRead(client: ReturnType<typeof last>) {
    const args = { Path: path.join(cwd, 'synthetic.txt') };
    client.row('PLANNER_RESPONSE', '');
    client.rows.at(-1).tool_calls = [{ name: 'read_file', args }];
    const stepIdx = client.cursor++;
    const payload = { stepIdx, toolCall: { id: 'corrected-' + stepIdx, name: 'read_file', args } };
    expect(client.hook('PreToolUse', payload).decision).toBe('allow');
    client.callbacks.onToolCall?.({ toolCallId: payload.toolCall.id, name: 'read_file', status: 'in_progress', rawInput: args });
    client.row('GENERIC', 'Showing lines 1-1 of 1\n1: synthetic', 'MODEL', 'DONE', stepIdx);
    client.hook('PostToolUse', { ...payload, error: '' });
    client.callbacks.onToolResult?.({ toolCallId: payload.toolCall.id, name: 'read_file', status: 'completed', rawInput: args });
  }
  it.each(['same turn', 'next turn', 'optional argument', 'scheduled turn'])(
    'continues the same session after a verified native argument rejection: %s', async scenario => {
      native.agentVersion = '1.5.13';
      const { id } = await captureTimedSession();
      const turn = executor.execute('hold', scenario === 'scheduled turn' ? { hostScheduleSessionId: id } : {});
      turn.catch(() => undefined);
      await vi.waitFor(() => expect(last().prompts).toHaveLength(2));
      const client = last();
      rejectedRead(client, scenario === 'optional argument' ? { StartLine: 1 } : undefined);
      client.hook('PostInvocation');
      client.hook('PreInvocation', { initialNumSteps: client.cursor });
      if (scenario === 'same turn') {
        correctedRead(client);
        client.hook('PostInvocation');
        client.hook('PreInvocation', { initialNumSteps: client.cursor });
      }
      client.finish('Synthetic final answer'); client.release({ stopReason: 'end_turn' });
      await expect(turn).resolves.toMatchObject({ success: true, output: 'Synthetic final answer' });
      if (scenario === 'next turn') {
        const next = executor.execute('hold');
        next.catch(() => undefined);
        await vi.waitFor(() => expect(client.prompts).toHaveLength(3));
        correctedRead(client);
        client.hook('PostInvocation');
        client.hook('PreInvocation', { initialNumSteps: client.cursor });
        client.finish(); client.release({ stopReason: 'end_turn' });
        await expect(next).resolves.toMatchObject({ success: true });
      }
      await expect(executor.execute('ordinary follow-up')).resolves.toMatchObject({ success: true });
      expect(executor.getSessionId()).toBe(id);
      expect(native.clients).toHaveLength(1);
      await expect(executor.configureManagedTools()).rejects.toThrow('reconnect was refused');
      native.loadedRows = structuredClone(client.rows);
      await fs.writeFile(transcriptPath(client.launch.env.HOME, id), client.rows.map((row: TranscriptRecord) => JSON.stringify(row)).join('\n'));
      await executor.destroy();
      executor = make();
      await expect(executor.setModel('synthetic-model')).rejects.toThrow();
      await expect(executor.execute('resume once')).resolves.toMatchObject({ success: true });
      expect(executor.getSessionId()).toBe(id);
      expect(last().prompts).toEqual(['resume once']);
    });
  it.each(['unknown version', 'other version', 'unknown tool', 'protected tool', 'present Path', 'extra argument', 'mistyped argument',
    'wrong error field', 'wrong receipt text', 'ERROR status', 'foreign source', 'planner text', 'two calls', 'non-adjacent planner',
    'pre hook', 'post before receipt', 'post hook', 'ACP dispatch', 'ACP dispatch without input', 'rewritten receipt', 'rewritten planner',
    'previous invocation', 'continued Stop', 'cancelled', 'worker'])(
    'keeps an unverified argument rejection blocked: %s', async scenario => {
      native.agentVersion = scenario === 'unknown version' ? undefined : scenario === 'other version' ? '1.5.14' : '1.5.13';
      const { runtime } = initialRuntime({ hostScheduleChat: scenario !== 'worker', worker: scenario === 'worker' });
      const turn = runtime.execute('hold', {});
      turn.catch(() => undefined);
      await vi.waitFor(() => expect(last()?.release).toBeDefined());
      const client = last();
      if (scenario === 'previous invocation') {
        // The receipt predates the invocation whose PostInvocation observes it.
        rejectedRead(client);
        client.hook('PreInvocation', { initialNumSteps: client.cursor });
        client.hook('PostInvocation');
      } else {
        const args = scenario === 'present Path' ? { Path: path.join(cwd, 'x') } : scenario === 'extra argument' ? { AbsolutePath: 'x' }
          : scenario === 'mistyped argument' ? { StartLine: '1' } : {};
        const step = rejectedRead(client, args, {
          name: scenario === 'unknown tool' ? 'previously_unseen_tool' : scenario === 'protected tool' ? 'run_command' : undefined,
          error: scenario === 'wrong error field' ? 'invalid arguments' : undefined,
          text: scenario === 'wrong receipt text' ? "Error invalid tool call: missing property 'Path'" : undefined });
        const receipt = client.rows.at(-1), planner = client.rows.at(-2);
        if (scenario === 'ERROR status') receipt.status = 'ERROR';
        if (scenario === 'foreign source') receipt.source = 'SYSTEM';
        if (scenario === 'planner text') planner.content = 'Reading.';
        if (scenario === 'two calls') planner.tool_calls.push({ name: 'read_file', args: {} });
        if (scenario === 'non-adjacent planner') { planner.step_index -= 1; client.rows.sort((a: TranscriptRecord, b: TranscriptRecord) => a.step_index - b.step_index); }
        const payload = { stepIdx: step, toolCall: { id: 'rejected', name: 'read_file', args } };
        if (scenario === 'pre hook') client.hook('PreToolUse', payload);
        if (scenario === 'post before receipt') client.hook('PostToolUse', payload);
        client.hook('PostInvocation');
        if (scenario === 'post hook') client.hook('PostToolUse', { ...payload, error: '' });
        if (scenario === 'ACP dispatch') client.callbacks.onToolCall?.({ toolCallId: 'x', name: 'read_file', status: 'in_progress', rawInput: {} });
        if (scenario === 'ACP dispatch without input') client.callbacks.onToolResult?.({ toolCallId: 'x', name: 'read_file', status: 'completed' });
        if (scenario === 'rewritten receipt') receipt.content += 'changed';
        if (scenario === 'rewritten planner') planner.tool_calls = [{ name: 'read_file', args: { StartLine: 2 } }];
      }
      client.hook('PreInvocation', { initialNumSteps: client.cursor });
      client.row('PLANNER_RESPONSE', 'Final answer'); client.hook('PostInvocation');
      client.hook('Stop', { terminationReason: 'NO_TOOL_CALL', error: '', fullyIdle: true, continuationActive: scenario === 'continued Stop' });
      client.release({ stopReason: scenario === 'cancelled' ? 'cancelled' : 'end_turn' });
      await turn.catch(() => undefined);
      await expect(runtime.execute('next ordinary prompt', {})).rejects.toThrow();
      expect(client.prompts).toEqual(['hold']);
      expect(runtime.reusable).toBe(false);
    });
  it('requires a fresh human message to continue after a terminal with missing tool evidence', async () => {
    const turn = executor.execute('hold');
    turn.catch(() => undefined);
    await vi.waitFor(() => expect(last()?.release).toBeDefined());
    const client = last();
    client.row('PLANNER_RESPONSE', '');
    client.rows.at(-1).tool_calls = [{ name: 'read_file', args: {} }];
    client.row('GENERIC', "Error invalid tool call: invalid arguments:\n- missing property 'Path'", 'MODEL', 'INVALID');
    client.hook('PostInvocation');
    client.hook('PreInvocation', { initialNumSteps: client.cursor });
    client.finish(); client.release({ stopReason: 'end_turn' });
    await expect(turn).resolves.toMatchObject({ success: true });
    await expect(executor.execute('follow-up')).rejects.toThrow();
    expect(client.prompts).toEqual(['hold']);
  });
  it('keeps ordinary failed-tool evidence scoped away from a worker turn', async () => {
    const { runtime } = initialRuntime({ worker: true, env: { HOME: home } });
    const turn = runtime.execute('hold', {});
    await vi.waitFor(() => expect(last()?.release).toBeDefined());
    const client = last(), payload = ordinaryTool(client, 'write_file');
    expect(client.hook('PreToolUse', payload).decision).toBe('allow');
    client.hook('PostToolUse', { ...payload, error: 'synthetic failure' });
    client.row('GENERIC', 'Encountered error in step execution: synthetic failure', 'MODEL', 'ERROR', payload.stepIdx);
    client.hook('PostInvocation');
    client.hook('PreInvocation', { initialNumSteps: client.cursor });
    client.finish(); client.release({ stopReason: 'end_turn' });
    await turn;
    await expect(runtime.execute('next ordinary prompt', {})).rejects.toThrow();
    expect(runtime.reusable).toBe(false);
    expect(client.prompts).toEqual(['hold']);
  });
  it('continues ordinary and pinned chat after a verified scheduled-turn tool error', async () => {
    const { runtime, ownedSessionClosed } = initialRuntime({ hostScheduleChat: true, env: { HOME: home } });
    const turn = runtime.execute('hold', { hostScheduleSessionId: native.sessionId });
    await vi.waitFor(() => expect(last()?.release).toBeDefined());
    const client = last(), payload = ordinaryTool(client, 'mcp_fixture_lookup');
    expect(client.hook('PreToolUse', payload).decision).toBe('allow');
    client.hook('PostToolUse', { ...payload, error: 'synthetic failure' });
    client.row('GENERIC', 'Encountered error in step execution: synthetic failure', 'MODEL', 'ERROR', payload.stepIdx);
    client.hook('PostInvocation');
    const task = yieldCommand(client);
    client.hook('PreInvocation', { initialNumSteps: client.cursor });
    client.row('PLANNER_RESPONSE', 'Scheduled answer'); client.hook('PostInvocation');
    client.hook('Stop', { terminationReason: 'NO_TOOL_CALL', error: '', fullyIdle: false, continuationActive: false });
    client.release({ stopReason: 'end_turn' });
    await expect(turn).resolves.toMatchObject({ success: true });
    expect(runtime.reusable).toBe(false);
    expect(runtime.hostScheduleAvailable).toBe(false);
    expect(runtime.waitingForCommand).toBe(true);
    await expect(runtime.execute('next ordinary prompt', {})).rejects.toThrow('pending');
    await expect(runtime.execute('next scheduled prompt', { hostScheduleSessionId: native.sessionId })).rejects.toThrow();
    idleShell(client, task);
    expect(runtime.waitingForCommand).toBe(false);
    expect(runtime.hostScheduleAvailable).toBe(true);
    await expect(runtime.execute('next ordinary prompt', {})).resolves.toMatchObject({ success: true });
    await expect(runtime.execute('next scheduled prompt', { hostScheduleSessionId: native.sessionId })).resolves.toMatchObject({ success: true });
    expect(client.prompts).toEqual(['hold', 'next ordinary prompt', 'next scheduled prompt']);
    expect(native.clients).toHaveLength(1);
    expect(runtime.reusable).toBe(false);
    await runtime.close();
    expect(ownedSessionClosed).toHaveBeenCalledWith(client.session, undefined, undefined, undefined);
  });
  it.each(['wrong call', 'different error', 'missing Stop', 'permission declined'])(
    'refuses scheduled-turn reuse with unconfirmed ordinary evidence: %s', async scenario => {
      const { runtime } = initialRuntime({ hostScheduleChat: true, env: { HOME: home } });
      const turn = runtime.execute('hold', { hostScheduleSessionId: native.sessionId });
      turn.catch(() => undefined);
      await vi.waitFor(() => expect(last()?.release).toBeDefined());
      const client = last(), payload = ordinaryTool(client, 'write_file');
      expect(client.hook('PreToolUse', payload).decision).toBe('allow');
      if (scenario === 'permission declined') {
        expect(await client.callbacks.onPermissionRequest('Synthetic permission', [{ optionId: 'deny', kind: 'reject_once' }])).toBe(-1);
      }
      client.hook('PostToolUse', { ...payload, error: 'synthetic failure', toolCall: {
        ...payload.toolCall, id: scenario === 'wrong call' ? 'unrelated' : payload.toolCall.id } });
      client.row('GENERIC', 'Encountered error in step execution: ' +
        (scenario === 'different error' ? 'another failure' : 'synthetic failure'), 'MODEL', 'ERROR', payload.stepIdx);
      client.hook('PostInvocation');
      client.hook('PreInvocation', { initialNumSteps: client.cursor });
      client.row('PLANNER_RESPONSE', 'Final answer'); client.hook('PostInvocation');
      if (scenario !== 'missing Stop') client.hook('Stop', { terminationReason: 'NO_TOOL_CALL', error: '',
        fullyIdle: true, continuationActive: false });
      client.release({ stopReason: 'end_turn' });
      await expect(turn).rejects.toThrow();
      await expect(runtime.execute('next ordinary prompt', {})).rejects.toThrow();
      await expect(runtime.execute('next scheduled prompt', { hostScheduleSessionId: native.sessionId })).rejects.toThrow();
      expect(client.prompts).toEqual(['hold']);
    });
  it.each(['list', 'status', 'kill'])('does not grant management %s during scheduled error recovery', async action => {
    const { runtime } = initialRuntime({ hostScheduleChat: true, env: { HOME: home } });
    const turn = runtime.execute('hold', { hostScheduleSessionId: native.sessionId });
    turn.catch(() => undefined);
    await vi.waitFor(() => expect(last()?.release).toBeDefined());
    const client = last(), task = yieldCommand(client);
    const args = action === 'list' ? { Action: action } : { Action: action, TaskId: task.id };
    const { decision } = manageCommand(client, args);
    expect(decision.decision).toBe('deny');
    client.row('GENERIC', 'Encountered error in step execution: tool call denied by pre-tool hook: ' + decision.reason,
      'MODEL', 'ERROR', client.cursor - 1);
    client.hook('PostInvocation');
    client.finish(); client.release({ stopReason: 'end_turn' });
    await expect(turn).rejects.toThrow();
    await expect(runtime.execute('next ordinary prompt', {})).rejects.toThrow();
    await expect(runtime.execute('next scheduled prompt', { hostScheduleSessionId: native.sessionId })).rejects.toThrow();
    expect(client.prompts).toEqual(['hold']);
  });
  /** A completion notification that proposes one more shell. The shell is always denied. */
  function idleShell(client: ReturnType<typeof last>, task: { id: string; log: string; step: number }, post = true) {
    if (post) deliverPost(client, task);
    client.hook('PreInvocation', { initialNumSteps: client.cursor });
    completion(client, task);
    const args = { CommandLine: 'touch synthetic-extra-shell' };
    client.row('PLANNER_RESPONSE', '');
    client.rows.at(-1).tool_calls = [{ name: 'run_command', args }];
    const step = client.cursor++;
    const decision = client.hook('PreToolUse', { stepIdx: step, toolCall: { name: 'run_command', id: 'idle-shell-' + step, args } });
    expect(decision.decision).toBe('deny');
    client.row('GENERIC', 'Encountered error in step execution: tool call denied by pre-tool hook: ' + decision.reason, 'MODEL', 'ERROR', step);
    const ending = client.hook('PostInvocation');
    expect(ending?.decision).not.toBe('allow');
    if (ending?.terminationBehavior === 'terminate') {
      client.hook('Stop', { terminationReason: 'TERMINAL_CUSTOM_HOOK', error: '', fullyIdle: true, continuationActive: false });
    } else {
      client.hook('PreInvocation', { initialNumSteps: client.cursor });
      client.row('PLANNER_RESPONSE', 'The extra command was not run.');
      client.hook('PostInvocation');
      client.hook('Stop', { terminationReason: 'NO_TOOL_CALL', error: '', fullyIdle: true, continuationActive: false });
    }
  }
  function idleQuiet(client: ReturnType<typeof last>, task: { id: string; log: string; step: number }, post = true) {
    if (post) deliverPost(client, task);
    client.hook('PreInvocation', { initialNumSteps: client.cursor });
    completion(client, task);
    client.row('PLANNER_RESPONSE', 'Command finished.');
    client.hook('PostInvocation');
    client.hook('Stop', { terminationReason: 'NO_TOOL_CALL', error: '', fullyIdle: true, continuationActive: false });
  }
  it.each(['two restarts', 'with tool error', 'changed planner', 'changed nonce', 'missing Stop', 'unconfirmed exit'])(
    'restores only clean ordinary chat after an idle shell refusal: %s', async scenario => {
      const { id } = await captureTimedSession();
      const { client, task } = await commandTurn(prompt => executor.execute(prompt), 2, false);
      if (scenario === 'missing Stop') {
        const hook = client.hook.bind(client);
        client.hook = (event: string, ...args: unknown[]) => event === 'Stop' ? {} : hook(event, ...args);
      }
      idleShell(client, task);
      if (scenario === 'with tool error') {
        const turn = executor.execute('hold');
        await vi.waitFor(() => expect(client.prompts).toHaveLength(3));
        const payload = ordinaryTool(client, 'read_file');
        expect(client.hook('PreToolUse', payload).decision).toBe('allow');
        client.hook('PostToolUse', { ...payload, error: 'synthetic error' });
        client.row('GENERIC', 'Encountered error in step execution: synthetic error', 'MODEL', 'ERROR', payload.stepIdx);
        client.hook('PostInvocation');
        client.hook('PreInvocation', { initialNumSteps: client.cursor });
        client.finish(); client.release({ stopReason: 'end_turn' });
        await expect(turn).resolves.toMatchObject({ success: true });
      }
      const pointer = path.join(home, '.remote-cli', 'agy-sessions', 'synthetic-thread.json');
      for (let restart = 1; restart <= 2; restart++) {
        const rows = structuredClone(last().rows) as TranscriptRecord[];
        const denied = rows.findIndex(row => row.content?.includes('tool call denied by pre-tool hook'));
        expect(denied).toBeGreaterThan(0);
        if (scenario === 'changed nonce') rows[denied].content += 'changed';
        if (scenario === 'changed planner') rows[denied - 1].content += 'changed';
        // Model a mismatch even when the filesystem fingerprint at retirement is intact.
        await fs.writeFile(transcriptPath(last().launch.env.HOME, id), rows.map(row => JSON.stringify(row)).join('\n'));
        native.loadedRows = rows;
        if (scenario === 'unconfirmed exit') {
          native.exitConfirmed = false;
          await expect(executor.destroy()).rejects.toThrow();
          expect(JSON.parse(await fs.readFile(pointer, 'utf8')).hostScheduleCheckpoint).toBeUndefined();
          return;
        }
        await executor.destroy();
        executor = make();
        expect(() => executor.checkHostScheduleSession(id)).toThrow();
        if (scenario === 'missing Stop') {
          await expect(executor.execute('unconfirmed')).rejects.toThrow('pending work is unconfirmed');
          expect(native.clients).toHaveLength(1);
          return;
        }
        const saved = JSON.parse(await fs.readFile(pointer, 'utf8')).hostScheduleCheckpoint;
        expect(saved).toMatchObject({ policy: 'host-timed-chat-v3', commands: { idleDenialHistory: expect.stringMatching(/^[a-f0-9]{64}$/) } });
        if (scenario.startsWith('changed')) {
          await expect(executor.execute('changed evidence')).rejects.toThrow();
          expect(native.clients).toHaveLength(1);
          expect(JSON.parse(await fs.readFile(pointer, 'utf8')).hostScheduleCheckpoint).toEqual(saved);
          return;
        }
        await expect(executor.setModel('synthetic-model')).rejects.toThrow('idle chat');
        const prompt = 'ordinary restart ' + restart;
        await expect(executor.execute(prompt)).resolves.toMatchObject({ success: true });
        expect(executor.getSessionId()).toBe(id);
        expect(native.clients).toHaveLength(restart + 1);
        expect(last().prompts).toEqual([prompt]);
        expect(() => executor.checkHostScheduleSession(id)).toThrow();
        await expect(executor.configureManagedTools({ url: 'http://127.0.0.1:1', token: 'synthetic-new', groups: [] }))
          .rejects.toThrow('reconnect was refused');
      }
      const stale = executor.execute('hold');
      await vi.waitFor(() => expect(last().prompts).toHaveLength(2));
      const { decision, payload } = manageCommand(last(), { Action: 'status', TaskId: task.id });
      expect(decision.decision).toBe('deny');
      last().row('GENERIC', 'Encountered error in step execution: tool call denied by pre-tool hook: ' + decision.reason,
        'MODEL', 'ERROR', payload.stepIdx);
      last().finish(); last().release({ stopReason: 'end_turn' });
      await expect(stale).resolves.toMatchObject({ success: true });
    });
  async function commandTurn(run: (prompt: string) => Promise<unknown>, count: number, complete: boolean) {
    const turn = run('hold');
    turn.catch(() => undefined);
    await vi.waitFor(() => expect(last()?.prompts).toHaveLength(count));
    const client = last(), task = yieldCommand(client);
    if (complete) completion(client, task);
    client.finish(); client.release({ stopReason: 'end_turn' });
    await expect(turn).resolves.toMatchObject({ success: true });
    return { client, task };
  }
  it.each(['running', 'done', 'running then done', 'exit race', 'late query on a later turn'])(
    'admits a read-only native status for an owned ordinary command: %s', async scenario => {
      const { runtime } = initialRuntime({ hostScheduleChat: true, env: { HOME: home } });
      let prompts = ['hold'];
      if (scenario === 'late query on a later turn') {
        const { task } = await commandTurn(prompt => runtime.execute(prompt, {}), 1, true);
        const turn = runtime.execute('hold', {});
        turn.catch(() => undefined);
        await vi.waitFor(() => expect(last().prompts).toHaveLength(2));
        ownedStatus(last(), task, 'DONE');
        last().finish(); last().release({ stopReason: 'end_turn' });
        await expect(turn).resolves.toMatchObject({ success: true });
        prompts = ['hold', 'hold'];
      } else {
        const turn = runtime.execute('hold', {});
        turn.catch(() => undefined);
        await vi.waitFor(() => expect(last()?.release).toBeDefined());
        const client = last(), task = yieldCommand(client);
        if (scenario === 'done') completion(client, task);
        if (scenario === 'exit race') {
          // Native looked up a running task, then reported its exit before flushing the wake.
          const { payload, decision } = manageCommand(client, { Action: 'status', TaskId: task.id });
          expect(decision.decision).toBe('allow');
          statusReply(client, payload, task, 'DONE');
          client.hook('PostToolUse', payload);
          completion(client, task);
          client.hook('PostInvocation');
          client.hook('PreInvocation', { initialNumSteps: client.cursor });
        } else {
          ownedStatus(client, task, scenario === 'done' ? 'DONE' : 'RUNNING');
        }
        if (scenario === 'running then done') {
          completion(client, task);
          ownedStatus(client, task, 'DONE');
          ownedStatus(client, task, 'DONE');
        }
        if (scenario === 'running') completion(client, task);
        client.finish(); client.release({ stopReason: 'end_turn' });
        await expect(turn).resolves.toMatchObject({ success: true, output: 'Synthetic result' });
      }
      expect(runtime.blocked).toBeUndefined();
      await expect(runtime.execute('next ordinary prompt', {})).resolves.toMatchObject({ success: true });
      expect(last().prompts).toEqual([...prompts, 'next ordinary prompt']);
      expect(native.clients).toHaveLength(1);
      // A read-only query does not revoke the host's existing schedule eligibility.
      expect(runtime.hostScheduleAvailable).toBe(true);
    });
  it.each(['wrong reply target', 'error reply', 'missing reply', 'changed reply', 'wrong callback', 'repeated callback', 'replayed step'])(
    'fails closed when an admitted status has forged evidence: %s', async scenario => {
      const { runtime } = initialRuntime({ hostScheduleChat: true, env: { HOME: home } });
      const turn = runtime.execute('hold', {});
      turn.catch(() => undefined);
      await vi.waitFor(() => expect(last()?.release).toBeDefined());
      const client = last(), task = yieldCommand(client);
      const { payload, decision } = manageCommand(client, { Action: 'status', TaskId: task.id });
      expect(decision.decision).toBe('allow');
      if (scenario !== 'missing reply') statusReply(client, payload, task, 'RUNNING', {
        target: scenario === 'wrong reply target' ? client.session + '/task-999' : undefined,
        status: scenario === 'error reply' ? 'ERROR' : undefined });
      client.hook('PostToolUse', scenario === 'wrong callback' ? { ...payload, toolCall: { ...payload.toolCall, id: 'another-call' } } : payload);
      if (scenario === 'repeated callback') client.hook('PostToolUse', payload);
      if (scenario === 'changed reply') client.rows.at(-1).content += 'changed';
      if (scenario === 'replayed step') expect(client.hook('PreToolUse', payload).decision).toBe('deny');
      completion(client, task);
      client.finish(); client.release({ stopReason: 'end_turn' });
      await turn.catch(() => undefined);
      await expect(runtime.execute('next ordinary prompt', {})).rejects.toThrow();
      expect(client.prompts).toEqual(['hold']);
      expect(runtime.hostScheduleAvailable).toBe(false);
    });
  it.each(['list', 'send_input', 'status'])(
    'composes a prior %s request with a delayed completion that proposes another shell', async action => {
      const { id } = await captureTimedSession();
      const turn = executor.execute('hold');
      turn.catch(() => undefined);
      await vi.waitFor(() => expect(last().prompts).toHaveLength(2));
      const client = last(), task = yieldCommand(client);
      if (action === 'status') ownedStatus(client, task, 'RUNNING');
      else {
        const { payload, decision } = manageCommand(client, action === 'list' ? { Action: 'list' }
          : { Action: 'send_input', TaskId: task.id, Input: 'synthetic input\n' });
        expect(decision.decision).toBe('deny');
        client.row('GENERIC', 'Encountered error in step execution: tool call denied by pre-tool hook: ' + decision.reason,
          'MODEL', 'ERROR', payload.stepIdx);
        client.hook('PostInvocation');
        client.hook('PreInvocation', { initialNumSteps: client.cursor });
      }
      client.finish(); client.release({ stopReason: 'end_turn' });
      await expect(turn).resolves.toMatchObject({ success: true });
      // A premature message stays outside ACP. A due timer waits only on an eligible host.
      await expect(executor.execute('too soon')).rejects.toThrow('pending');
      expect(() => executor.checkHostScheduleSession(id)).toThrow();
      expect(executor.isHostScheduleWaitingForCommand(id, cwd)).toBe(action === 'status');
      idleShell(client, task);
      await expect(executor.execute('follow-up')).resolves.toMatchObject({ success: true });
      await commandTurn(prompt => executor.execute(prompt), 4, true);
      expect(client.prompts).toEqual(['hold', 'hold', 'follow-up', 'hold']);
      expect(executor.getSessionId()).toBe(id);
      expect(native.clients).toHaveLength(1);
      if (action === 'status') {
        executor.checkHostScheduleSession(id);
        await expect(executor.execute('next slot', { hostScheduleSessionId: id })).resolves.toMatchObject({ success: true });
        expect(client.prompts.filter(prompt => prompt === 'next slot')).toHaveLength(1);
      } else {
        expect(() => executor.checkHostScheduleSession(id)).toThrow();
        await expect(executor.execute('must not schedule', { hostScheduleSessionId: id })).rejects.toThrow();
        expect(client.prompts).not.toContain('must not schedule');
      }
    });
  it.each(['idle denial then status', 'status then idle denial', 'two idle denials'])(
    'keeps live ordinary chat across repeated turns: %s', async scenario => {
      const { runtime } = initialRuntime({ hostScheduleChat: true, env: { HOME: home } });
      const run = (prompt: string) => runtime.execute(prompt, {});
      if (scenario === 'status then idle denial') {
        const turn = run('hold');
        turn.catch(() => undefined);
        await vi.waitFor(() => expect(last()?.release).toBeDefined());
        const client = last(), task = yieldCommand(client);
        ownedStatus(client, task, 'RUNNING'); completion(client, task); ownedStatus(client, task, 'DONE');
        client.finish(); client.release({ stopReason: 'end_turn' });
        await expect(turn).resolves.toMatchObject({ success: true });
      } else {
        const first = await commandTurn(run, 1, false);
        idleShell(first.client, first.task);
      }
      const turn = run('hold');
      turn.catch(() => undefined);
      await vi.waitFor(() => expect(last().prompts).toHaveLength(2));
      const client = last(), task = yieldCommand(client);
      if (scenario === 'idle denial then status') {
        ownedStatus(client, task, 'RUNNING');
        completion(client, task);
      }
      client.finish(); client.release({ stopReason: 'end_turn' });
      await expect(turn).resolves.toMatchObject({ success: true });
      if (scenario !== 'idle denial then status') idleShell(client, task);
      await expect(run('next ordinary prompt')).resolves.toMatchObject({ success: true });
      expect(client.prompts).toEqual(['hold', 'hold', 'next ordinary prompt']);
      expect(native.clients).toHaveLength(1);
      expect(runtime.blocked).toBeUndefined();
    });
  it.each([['A', 'B'], ['B', 'A']].flatMap(order => (['first', 'last'] as const).map(shell => ({ order, shell }))))(
    'attributes two overlapping ordinary commands to their own exits: $order, shell on $shell notification', async ({ order, shell }) => {
      const { runtime } = initialRuntime({ hostScheduleChat: true, env: { HOME: home } });
      const turn = runtime.execute('hold', {});
      turn.catch(() => undefined);
      await vi.waitFor(() => expect(last()?.release).toBeDefined());
      const client = last();
      const tasks = { A: yieldCommand(client), B: yieldCommand(client) };
      client.finish(); client.release({ stopReason: 'end_turn' });
      await expect(turn).resolves.toMatchObject({ success: true });
      deliverPost(client, tasks.A); deliverPost(client, tasks.B);
      const [first, second] = order.map(name => tasks[name as 'A' | 'B']);
      if (shell === 'first') idleShell(client, first, false); else idleQuiet(client, first, false);
      expect(runtime.blocked).toBeUndefined();
      await expect(runtime.execute('interim', {})).rejects.toThrow('pending');
      expect(client.prompts).toEqual(['hold']);
      if (shell === 'last') idleShell(client, second, false); else idleQuiet(client, second, false);
      await expect(runtime.execute('next ordinary prompt', {})).resolves.toMatchObject({ success: true });
      expect(client.prompts).toEqual(['hold', 'next ordinary prompt']);
      expect(native.clients).toHaveLength(1);
    });
  it.each(['new command', 'new command without status', 'stale target'])('observes commands admitted after an actual clean reload: %s', async scenario => {
    const { id } = await captureTimedSession();
    const { client: original, task: prior } = await commandTurn(prompt => executor.execute(prompt), 2, true);
    native.loadedRows = structuredClone(original.rows);
    await executor.destroy();
    executor = make();
    executor.checkHostScheduleSession(id);
    const turn = executor.execute('hold');
    turn.catch(() => undefined);
    await vi.waitFor(() => expect(native.clients).toHaveLength(2));
    await vi.waitFor(() => expect(last().release).toBeDefined());
    const client = last();
    expect(client.session).toBe(id);
    if (scenario === 'stale target') {
      // Earlier records stay historical: no ownership is inherited across the process boundary.
      const { payload, decision } = manageCommand(client, { Action: 'status', TaskId: prior.id });
      expect(decision.decision).toBe('deny');
      expect(decision.reason).not.toContain('Status:');
      client.row('GENERIC', 'Encountered error in step execution: tool call denied by pre-tool hook: ' + decision.reason,
        'MODEL', 'ERROR', payload.stepIdx);
      client.hook('PostInvocation');
      client.hook('PreInvocation', { initialNumSteps: client.cursor });
      client.finish(); client.release({ stopReason: 'end_turn' });
      await turn.catch(() => undefined);
      expect(client.prompts).toEqual(['hold']);
      return;
    }
    const task = yieldCommand(client);
    if (scenario === 'new command') ownedStatus(client, task, 'RUNNING');
    client.finish(); client.release({ stopReason: 'end_turn' });
    await expect(turn).resolves.toMatchObject({ success: true });
    await expect(executor.execute('too soon')).rejects.toThrow('pending');
    idleShell(client, task);
    await expect(executor.execute('next ordinary prompt')).resolves.toMatchObject({ success: true });
    expect(client.prompts).toEqual(['hold', 'next ordinary prompt']);
    expect(executor.getSessionId()).toBe(id);
    expect(native.clients).toHaveLength(2);
  });
  it.each(['cancelled', 'after list', 'missing notice', 'wrong exit log', 'wrong sender', 'rewritten receipt', 'delayed receipt', 'missing receipt', 'wrong receipt', 'missing callback',
    'wrong callback', 'foreign target', 'extra argument', 'already completed', 'worker', 'scheduled', 'loaded'])(
    'limits native kill to an owned live foreground command: %s', async scenario => {
      const { runtime, ownedSessionClosed } = initialRuntime({ hostScheduleChat: true, env: { HOME: home },
        worker: scenario === 'worker', sessionId: scenario === 'loaded' ? native.sessionId : undefined });
      const turn = runtime.execute('hold', scenario === 'scheduled' ? { hostScheduleSessionId: native.sessionId } : {});
      await vi.waitFor(() => expect(last()?.release).toBeDefined());
      const client = last(), task = yieldCommand(client);
      if (scenario === 'already completed') completion(client, task);
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
      const refused = ['foreign target', 'extra argument', 'already completed'].includes(scenario);
      const denied = refused || ['worker', 'scheduled', 'loaded'].includes(scenario);
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
      if (refused && scenario !== 'already completed') completion(client, task);
      client.finish(); client.release({ stopReason: 'end_turn' });
      if (refused || ['cancelled', 'after list', 'delayed receipt'].includes(scenario)) {
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
  it.each(['confirmed', 'ordinary turn', 'ordinary wrong nonce', 'ordinary missing Stop', 'different planner', 'wrong nonce', 'post-tool', 'changed history',
    'extra row', 'missing Stop', 'wrong Stop', 'still busy', 'continued'])(
    'admits the next turn only after a proven idle shell denial: %s', async scenario => {
      const { id } = await captureTimedSession();
      const ordinary = scenario.startsWith('ordinary');
      const running = executor.execute('hold', ordinary ? {} : { hostScheduleSessionId: id });
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
        (scenario.endsWith('wrong nonce') ? 'different' : decision.reason), 'MODEL', 'ERROR', step);
      if (scenario === 'post-tool') client.hook('PostToolUse', { stepIdx: step });
      if (scenario === 'changed history') client.rows[0].content += 'changed';
      const ending = client.hook('PostInvocation');
      if (scenario === 'confirmed' || scenario === 'ordinary turn') expect(ending).toEqual({ terminationBehavior: 'terminate' });
      if (scenario === 'extra row') client.row('GENERIC', 'unexpected');
      if (!scenario.endsWith('missing Stop')) client.hook('Stop', {
        terminationReason: scenario === 'wrong Stop' ? 'NO_TOOL_CALL' : 'TERMINAL_CUSTOM_HOOK',
        error: '', fullyIdle: scenario !== 'still busy', continuationActive: scenario === 'continued',
      });
      if (ordinary) {
        if (scenario === 'ordinary turn') {
          executor.checkHostScheduleSession(id);
          await expect(executor.execute('ordinary follow-up', {})).resolves.toMatchObject({ success: true });
          expect(client.prompts).toEqual(['hold', 'hold', 'ordinary follow-up']);
          expect(executor.getSessionId()).toBe(id);
          executor.checkHostScheduleSession(id);
          await executor.destroy();
          expect(() => make().checkHostScheduleSession(id)).toThrow();
        } else {
          expect(() => executor.checkHostScheduleSession(id)).toThrow();
          const reason = scenario === 'ordinary missing Stop' ? 'AGY command completion is pending.' : 'AGY idle command denial is unconfirmed.';
          await expect(executor.execute('ordinary follow-up', {})).rejects.toThrow(reason);
          expect(client.prompts).toEqual(['hold', 'hold']);
        }
        return;
      }
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
  it('keeps a live main host fenced for timers when its exact manual recovery receipt is consumed', async () => {
    const { id } = await captureTimedSession();
    const file = path.join(home, '.remote-cli', 'agy-sessions', 'synthetic-thread.json');
    const pointer = JSON.parse(await fs.readFile(file, 'utf8'));
    const saved = JSON.stringify({ ...pointer, manualResumeConsumedGeneration: pointer.hostGeneration });
    await fs.writeFile(file, saved);
    await expect(executor.execute('timer', { hostScheduleSessionId: id })).rejects.toThrow('already consumed');
    expect(last().prompts).toEqual(['hold']);
    expect(await fs.readFile(file, 'utf8')).toBe(saved);
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
  it.each(['intact', 'intact parallel', 'changed parallel sibling', 'changed digest', 'missing digest', 'changed generation', 'changed configuration', 'changed stored history',
    'changed saved planner', 'missing saved receipt', 'changed loaded receipt', 'extra loaded error', 'unconfirmed terminal', 'unconfirmed exit'])(
    'binds ordinary tool error history to its clean retirement: %s', async scenario => {
      const { id, db } = await captureTimedSession();
      const turn = executor.execute('hold');
      await vi.waitFor(() => expect(last().prompts).toHaveLength(2));
      const client = last();
      const payload = ordinaryTool(client, 'read_file');
      if (scenario === 'intact parallel' || scenario === 'changed parallel sibling') {
        const sibling = { name: 'run_command', args: {} };
        client.rows.at(-1).tool_calls.unshift(sibling);
        const command = { stepIdx: payload.stepIdx, toolCall: { ...sibling, id: 'command' } };
        payload.stepIdx = client.cursor++;
        expect(client.hook('PreToolUse', command).decision).toBe('allow');
        client.hook('PostToolUse', command);
        client.row('GENERIC', 'Synthetic command output', 'MODEL', 'DONE', command.stepIdx);
      }
      expect(client.hook('PreToolUse', payload).decision).toBe('allow');
      client.hook('PostToolUse', { ...payload, error: 'synthetic failure' });
      client.row('GENERIC', 'Encountered error in step execution: synthetic failure', 'MODEL', 'ERROR', payload.stepIdx);
      client.hook('PostInvocation'); client.hook('PreInvocation', { initialNumSteps: client.cursor });
      client.finish(); client.release({ stopReason: 'end_turn' });
      await expect(turn).resolves.toMatchObject({ success: true });
      native.loadedRows = structuredClone(client.rows) as TranscriptRecord[];
      const rows = structuredClone(native.loadedRows);
      if (scenario === 'changed saved planner') rows.find(row => row.step_index === payload.stepIdx - 1)!.content += 'changed';
      if (scenario === 'missing saved receipt') rows.splice(rows.findIndex(row => row.step_index === payload.stepIdx), 1);
      await fs.writeFile(transcriptPath(client.launch.env.HOME, id), rows.map(row => JSON.stringify(row)).join('\n'));
      const file = path.join(home, '.remote-cli', 'agy-sessions', 'synthetic-thread.json');
      const pointer = async () => JSON.parse(await fs.readFile(file, 'utf8'));
      if (scenario === 'unconfirmed exit') {
        native.exitConfirmed = false;
        await expect(executor.destroy()).rejects.toThrow();
        expect((await pointer()).hostScheduleCheckpoint).toBeUndefined();
        return;
      }
      if (scenario === 'unconfirmed terminal') native.confirmTranscript.mockResolvedValue(false);
      await executor.destroy();
      const selected = await pointer();
      if (scenario === 'unconfirmed terminal') {
        expect(selected.hostScheduleCheckpoint).toBeUndefined();
      } else {
        expect(selected.hostScheduleCheckpoint).toMatchObject({ policy: 'host-timed-chat-v2', toolErrorDigest: expect.stringMatching(/^[0-9a-f]{64}$/) });
        expect(JSON.stringify(selected)).not.toContain('synthetic failure');
      }
      if (scenario === 'changed digest' || scenario === 'missing digest') {
        if (scenario === 'changed digest') selected.hostScheduleCheckpoint.toolErrorDigest = '0'.repeat(64);
        else delete selected.hostScheduleCheckpoint.toolErrorDigest;
        await fs.writeFile(file, JSON.stringify(selected));
      }
      if (scenario === 'changed stored history') await fs.appendFile(db, 'changed');
      if (scenario === 'changed generation') {
        selected.hostGeneration = selected.hostScheduleCheckpoint.generation = 'replacement-generation';
        await fs.writeFile(file, JSON.stringify(selected));
      }
      if (scenario === 'changed parallel sibling') native.loadedRows.find(row => row.step_index === payload.stepIdx - 1)!.content += 'changed';
      if (scenario === 'changed loaded receipt') {
        native.loadedRows.find(row => row.step_index === payload.stepIdx)!.content += 'changed';
      }
      if (scenario === 'extra loaded error') native.loadedRows.push({ source: 'MODEL', type: 'GENERIC', status: 'ERROR',
        content: 'unexpected', step_index: native.loadedRows.at(-1)!.step_index + 1 });
      executor = scenario === 'changed configuration'
        ? new AgyExecutor(new DirectoryGuard([cwd]), { threadId: 'synthetic-thread', initialWorkingDirectory: cwd, model: 'different-model' }) : make();
      if (scenario === 'intact' || scenario === 'intact parallel') {
        await expect(executor.execute('new request', { hostScheduleSessionId: id })).resolves.toMatchObject({ success: true });
        expect(last().session).toBe(id);
        expect(last().prompts).toEqual(['new request']);
      } else {
        await expect(executor.execute('stale request')).rejects.toThrow();
        if (scenario !== 'changed loaded receipt' && scenario !== 'extra loaded error' && scenario !== 'changed parallel sibling') expect(native.clients).toHaveLength(1);
      }
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
  const humanConfirmation = () => ({ originalMessageId: randomUUID(), createdAt: Date.now(), current: () => true });
  const resume = (text: string, options: ExecuteOptions = {}) => executor.resumeAgyChat(text, options, humanConfirmation());
  async function savedManualChat(threadId = 'synthetic-thread') {
    const pointer = path.join(home, '.remote-cli', 'agy-sessions', threadId + '.json');
    const threadHome = path.join(home, '.remote-cli', 'agy-homes', threadId);
    const id = native.sessionId;
    const db = path.join(threadHome, '.gemini', 'antigravity-cli', 'conversations', id + '.db');
    const transcript = transcriptPath(threadHome, id);
    native.loadedRows = [
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'Previous human message' },
      { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Previous response' },
    ];
    for (const file of [db, transcript]) await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(db, 'Synthetic conversation store');
    await fs.writeFile(transcript, native.loadedRows.map(row => JSON.stringify(row)).join('\n'));
    await fs.writeFile(pointer, JSON.stringify({ id, transport: 'acp', retired: false,
      hostGeneration: '01234567-89ab-4cde-8123-0123456789ab' }));
    executor = make();
    return { id, pointer, threadHome, db };
  }

  it.each(['default', 'named'])('loads the original AGY conversation from an ordinary Feishu event on the %s thread', async target => {
    const store = new JsonStore(path.join(home, 'bindings.json'), 0);
    await store.initialize();
    const owner = 'synthetic-owner', device = 'synthetic-device';
    const bindings = new BindingManager(store);
    await bindings.bindUser(owner, device, 'Fixture');
    const epoch = bindings.getCardThreadEpoch(owner, device, 'schedule');
    const config = { type: 'agy' as const };
    const threads = await ThreadManager.initialize(home);
    const thread = target === 'named' ? await threads.createThread('named', cwd) : threads.getDefaultThread();
    await threads.updateThread(thread.id, { workingDirectory: cwd, delegation: target === 'named' });
    const { id } = await savedManualChat(thread.id);
    const guard = new DirectoryGuard([cwd]);
    const pool = new ThreadExecutorPool(threads, guard, config);
    const send = vi.fn();
    const cli = new MessageHandler({ send, trackTask: vi.fn(), onTaskResultAck: () => () => {}, onClose: () => () => {}, isConnected: () => true } as any, pool, threads, guard,
      { get: (key: string) => key === 'executor' ? config : key === 'deviceId' ? device : undefined, getConfigDir: () => home } as any);
    const router = new FeishuLongConnHandler({ appId: 'fixture', appSecret: 'fixture', store });
    const registration = { openId: owner, registrationId: 'registered' };
    let delivered: Parameters<MessageHandler['handleMessage']>[0] | undefined;
    router.setConnectionHub({ isDeviceOnline: () => true, supportsAgyHumanRecovery: () => true, getAuthenticatedRoute: () => registration,
      sendToDevice: async (_device: string, frame: Parameters<MessageHandler['handleMessage']>[0]) => {
        delivered = frame;
        await cli.handleMessage(frame);
        return true;
      } } as any);
    router.setOnResolveActiveThread(async () => target === 'named' ? { threadId: thread.id, threadName: thread.name } : undefined);
    vi.spyOn(router as any, 'sendStreamingStart').mockResolvedValue('fixture-card');
    vi.spyOn(router as any, 'replyToMessage').mockResolvedValue(undefined);
    const event = { sender: { sender_type: 'user', sender_id: { open_id: owner } }, message: {
      message_type: 'text', create_time: String(Date.now()), message_id: 'original-human', content: JSON.stringify({ text: 'hold' }),
    } };
    try {
      await cli.handleMessage({ type: 'binding_confirm', data: { success: true, registrationId: registration.registrationId,
        scheduleBinding: { openId: owner, deviceId: device, epoch }, capabilities: { scheduleResultsV1: true, hostSchedulesV1: true } } } as any);
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const env = last().launch.env;
        const response = await fetch(env.REMOTE_CLI_DELEGATION_URL, { method: 'POST',
          headers: { authorization: 'Bearer ' + env.REMOTE_CLI_DELEGATION_TOKEN, 'content-type': 'application/json' },
          body: JSON.stringify({ name, args, callId: randomUUID() }) });
        return { status: response.status, body: await response.json() };
      };
      native.duringLoad = async () => {
        expect(await call('remote_cli_schedule_list', { requestId: 'before-load' })).toMatchObject({ status: 409 });
      };
      const recovery = router['handleMessageEvent'](event);
      await vi.waitFor(() => expect(last()?.release).toBeDefined());
      const client = last();
      expect(await call('remote_cli_schedule_capabilities')).toMatchObject({ status: 200, body: { backend: 'agy' } });
      const originalRegistration = cli['authenticatedRegistration'];
      cli['authenticatedRegistration'] = 'different-registration';
      expect(await call('remote_cli_schedule_capabilities')).toMatchObject({ status: 400 });
      cli['authenticatedRegistration'] = originalRegistration;
      const listed = await call('remote_cli_schedule_list', { requestId: 'inventory' });
      expect(listed).toMatchObject({ status: 200, body: { status: 'succeeded', records: [] } });
      expect(await call('remote_cli_schedule_operation', { requestId: 'inventory' })).toEqual(listed);
      for (const name of ['create', 'cancel', 'purge', 'cleanup_review', 'cleanup_delete']) {
        expect(await call('remote_cli_schedule_' + name, { requestId: 'forbidden' })).toMatchObject({ status: 400, body: { error: expect.stringContaining('Only schedule list') } });
      }
      expect(await call('remote_cli_schedule_operation', { requestId: 'forbidden' })).toMatchObject({ status: 400 });
      if (target === 'named') {
        expect(await call('remote_cli_delegate', { task: 'Synthetic task' })).toMatchObject({
          status: 400, body: { error: expect.stringContaining('Only schedule list') },
        });
      }
      client.row('PLANNER_RESPONSE', '');
      client.rows.at(-1).tool_calls = [{ name: 'run_command', args: {} }, { name: 'unknown_tool', args: {} }];
      client.row('GENERIC', 'Historical command output', 'MODEL', 'DONE');
      client.row('GENERIC', 'Historical error', 'MODEL', 'ERROR');
      client.row('UNKNOWN_TOOL_RESULT', 'Additional output', 'MODEL', 'UNKNOWN');
      client.finish();
      expect(await call('remote_cli_schedule_capabilities')).toMatchObject({ status: 400 });
      client.release({ stopReason: 'end_turn' });
      await recovery;
      expect(send.mock.calls.filter(([frame]) => frame.type === 'response').at(-1)?.[0]).toMatchObject({ threadId: thread.id, success: true });
      expect(last().session).toBe(id);
      expect(last().prompts).toEqual(['hold']);
      await router['handleMessageEvent'](event);
      await cli.handleMessage(delivered!);
      expect(native.clients).toHaveLength(1);
      expect(last().prompts).toEqual(['hold']);
      for (const text of ['first follow-up\nhold', 'second follow-up']) {
        const prior = client.prompts.length;
        const next = router['handleMessageEvent']({ ...event, message: { ...event.message, message_id: 'next-' + prior,
          content: JSON.stringify({ text }) } });
        if (text.endsWith('hold')) {
          await vi.waitFor(() => expect(client.prompts).toHaveLength(prior + 1));
          expect(await call('remote_cli_schedule_operation', { requestId: 'inventory' })).toMatchObject({ status: 400 });
          expect(await call('remote_cli_schedule_list', { requestId: 'another-list' })).toMatchObject({ status: 200, body: { status: 'succeeded' } });
          client.finish(); client.release({ stopReason: 'end_turn' });
        }
        await next;
        expect(send.mock.calls.filter(([frame]) => frame.type === 'response').at(-1)?.[0]).toMatchObject({ success: true });
        await cli.handleMessage(delivered!);
      }
      expect(last().session).toBe(id);
      expect(native.clients).toHaveLength(1);
      expect(client.prompts).toEqual(['hold', 'first follow-up\nhold', 'second follow-up']);
      const live = pool.getExecutor(thread.id) as AgyExecutor;
      expect(() => live.checkHostScheduleSession(id)).toThrow();
      await expect(live.execute('automatic continuation')).rejects.toThrow();
      const first = last();
      first.onExit();
      await Promise.resolve();
      await router['handleMessageEvent']({ ...event, message: { ...event.message, create_time: String(Date.now()),
        message_id: 'next-human-message', content: JSON.stringify({ text: 'Continue after exit' }) } });
      expect(send.mock.calls.filter(([frame]) => frame.type === 'response').at(-1)?.[0]).toMatchObject({ threadId: thread.id, success: true });
      expect(native.clients).toHaveLength(2);
      expect(first.prompts).toEqual(['hold', 'first follow-up\nhold', 'second follow-up']);
      expect(last().session).toBe(id);
      expect(last().prompts).toEqual(['Continue after exit']);
    } finally { await cli.destroy(); await store.flush(); }
  });

  it('continues a freshly allocated main host after historical background work without granting timer or command ownership', async () => {
    const { id } = await captureTimedSession();
    const work = executor.execute('hold');
    await vi.waitFor(() => expect(last().prompts).toHaveLength(2));
    const client = last(), step = client.cursor;
    client.row('GENERIC', 'Tool is running as a background task with task id: ' + id + '/task-' + step
      + '\nTask Description: Synthetic tool\nTask logs are available at: file:///fixture', 'MODEL', 'RUNNING');
    client.finish(); client.release({ stopReason: 'end_turn' });
    await expect(work).resolves.toMatchObject({ success: true });
    const source = humanConfirmation();
    expect(executor.needsAgyHumanRecovery(source.originalMessageId)).toBe(true);
    expect(() => executor.checkHostScheduleSession(id)).toThrow();
    await expect(executor.resumeAgyChat('expired route', {}, { ...source, current: () => false })).rejects.toThrow();
    await expect(executor.resumeAgyChat('next human request', {}, source)).resolves.toMatchObject({ success: true });
    expect(() => executor.needsAgyHumanRecovery(source.originalMessageId)).toThrow();
    expect(client.prompts).toEqual(['hold', 'hold', 'next human request']);
    expect(native.clients).toHaveLength(1);
  });

  it.each(['active continuation', 'not idle', 'failed Stop', 'wrong session', 'missing PostInvocation',
    'relay fault', 'missing Stop', 'ACP limit', 'permission declined', 'outstanding command', 'worker', 'coordinator', 'timer'])(
    'withholds human continuation despite historical tool records when there is %s', async scenario => {
      const { runtime } = initialRuntime({ hostScheduleChat: true, env: { HOME: home },
        worker: scenario === 'worker', managedCoordinator: scenario === 'coordinator' });
      const work = runtime.execute('hold', scenario === 'timer' ? { hostScheduleSessionId: native.sessionId } : {});
      work.catch(() => undefined);
      await vi.waitFor(() => expect(last()?.release).toBeDefined());
      const client = last();
      client.row('GENERIC', 'Unobserved result', 'MODEL', 'ERROR');
      if (scenario === 'outstanding command') yieldCommand(client);
      if (scenario === 'permission declined') {
        await client.callbacks.onPermissionRequest('Synthetic permission', [{ optionId: 'deny', kind: 'reject_once' }]);
      }
      if (scenario === 'relay fault') native.fault();
      client.row('PLANNER_RESPONSE', 'Synthetic final output');
      if (scenario !== 'missing PostInvocation') client.hook('PostInvocation');
      if (scenario !== 'missing Stop') client.hook('Stop', { terminationReason: scenario === 'failed Stop' ? 'ERROR' : 'NO_TOOL_CALL',
        error: scenario === 'failed Stop' ? 'Synthetic error' : '', fullyIdle: scenario !== 'not idle',
        continuationActive: scenario === 'active continuation', conversationId: scenario === 'wrong session' ? 'other' : client.session });
      client.release({ stopReason: scenario === 'ACP limit' ? 'max_turn_requests' : 'end_turn' });
      await work.catch(() => undefined);
      expect(runtime.needsHumanContinuation).toBe(false);
      const confirm = vi.fn();
      await expect(runtime.execute('human follow-up', {}, confirm)).rejects.toThrow();
      expect(confirm).not.toHaveBeenCalled();
      expect(client.prompts).toEqual(['hold']);
      expect(runtime.hostScheduleAvailable).toBe(false);
    });

  it.each(['pointer', 'transcript'])('fences an authenticated live continuation when its %s changes', async changed => {
    const { id, pointer } = await savedManualChat();
    const work = resume('hold');
    await vi.waitFor(() => expect(last()?.release).toBeDefined());
    const client = last();
    client.row('GENERIC', 'Unobserved result', 'MODEL', 'ERROR');
    client.finish(); client.release({ stopReason: 'end_turn' });
    await expect(work).resolves.toMatchObject({ success: true });
    if (changed === 'pointer') {
      const replacement = pointer + '.replacement';
      await fs.copyFile(pointer, replacement); await fs.rename(replacement, pointer);
    } else {
      client.rows.at(-2).content = 'Changed tool result';
      client.hook('SessionStart');
    }
    await expect(resume('follow-up')).rejects.toThrow();
    expect(client.prompts).toEqual(['hold']);
    expect(() => executor.checkHostScheduleSession(id)).toThrow();
  });

  it.each(['confirmed', 'group unknown', 'lease unknown'] as const)(
    'recovers the same idle chat only after exact retirement: %s', async evidence => {
      const { id } = await savedManualChat();
      const previous = humanConfirmation();
      await executor.resumeAgyChat('previous input', {}, previous);
      const oldClient = last();
      const next = humanConfirmation();
      expect(executor.needsAgyHumanRecovery(next.originalMessageId)).toBe(false);
      oldClient.onExit();
      await Promise.resolve();
      expect(executor.needsAgyHumanRecovery(next.originalMessageId)).toBe(true);
      expect(() => executor.needsAgyHumanRecovery(previous.originalMessageId)).toThrow('already resumed');
      await expect(executor.execute('scheduled work', { hostScheduleSessionId: id })).rejects.toThrow();
      await expect(executor.execute('unverified input')).rejects.toThrow();
      if (evidence === 'group unknown') native.exitConfirmed = false;
      if (evidence === 'lease unknown') native.restore.mockRejectedValueOnce(new Error('Unconfirmed hook lease'));
      if (evidence !== 'confirmed') {
        await expect(executor.resumeAgyChat('withheld input', {}, next)).rejects.toThrow();
        expect(native.clients).toHaveLength(1);
        expect(executor.needsAgyHumanRecovery(next.originalMessageId)).toBe(true);
        native.exitConfirmed = true;
      }
      await expect(executor.resumeAgyChat('fresh input', {}, next)).resolves.toMatchObject({ success: true });
      expect(native.clients).toHaveLength(2);
      expect(oldClient.prompts).toEqual(['previous input']);
      expect(last().session).toBe(id);
      expect(last().token).toBeUndefined();
      expect(last().prompts).toEqual(['fresh input']);
      expect(() => executor.needsAgyHumanRecovery(next.originalMessageId)).toThrow('already resumed');
    });

  it('preserves the original selection when a fresh main host exits before its first recovery', async () => {
    native.realHooks = true;
    const { id } = await captureTimedSession();
    const first = last();
    native.loadedRows = structuredClone(first.rows);
    await fs.writeFile(transcriptPath(first.launch.env.HOME, id), first.rows.map((row: TranscriptRecord) => JSON.stringify(row)).join('\n'));
    first.onExit();
    await Promise.resolve();
    const source = humanConfirmation();
    expect(executor.needsAgyHumanRecovery(source.originalMessageId)).toBe(true);
    await expect(executor.execute('timer', { hostScheduleSessionId: id })).rejects.toBeInstanceOf(AgyManualResumeScheduleSkip);
    await expect(executor.resumeAgyChat('next human', {}, source)).resolves.toMatchObject({ success: true });
    expect(first.prompts).toEqual(['hold']);
    expect(last().session).toBe(id);
    expect(last().prompts).toEqual(['next human']);
  });

  it('rechecks the human route after cleanup before starting a successor', async () => {
    await savedManualChat();
    await resume('previous input');
    last().onExit();
    await Promise.resolve();
    let current = true;
    native.restore.mockImplementationOnce(async () => { current = false; });
    await expect(executor.resumeAgyChat('expired input', {}, { ...humanConfirmation(), current: () => current }))
      .rejects.toThrow('route changed');
    expect(native.clients).toHaveLength(1);
    await expect(resume('fresh input')).resolves.toMatchObject({ success: true });
    expect(last().prompts).toEqual(['fresh input']);
  });

  it('keeps an in-turn exit ineligible after the interrupted input settles', async () => {
    await savedManualChat();
    await resume('first chat');
    const interrupted = executor.execute('hold');
    await vi.waitFor(() => expect(last().release).toBeDefined());
    last().onExit();
    await Promise.resolve();
    last().release({ stopReason: 'end_turn' });
    await expect(interrupted).rejects.toThrow();
    const source = humanConfirmation();
    expect(executor.needsAgyHumanRecovery(source.originalMessageId)).toBe(false);
    await expect(executor.resumeAgyChat('retry', {}, source)).rejects.toThrow();
    expect(native.clients).toHaveLength(1);
  });

  it('refuses worker recovery even after an observed idle process exit', async () => {
    executor = new AgyExecutor(new DirectoryGuard([cwd]), {
      initialWorkingDirectory: cwd, threadId: 'synthetic-worker', delegationWorker: true,
    });
    await executor.execute('worker input');
    last().onExit();
    await Promise.resolve();
    const source = humanConfirmation();
    expect(executor.needsAgyHumanRecovery(source.originalMessageId)).toBe(false);
    await expect(executor.resumeAgyChat('human input', {}, source)).rejects.toThrow();
    expect(native.clients).toHaveLength(1);
    expect(last().prompts).toEqual(['worker input']);
  });

  it('refuses a replaced pointer even when its conversation and generation match the exited host', async () => {
    const { pointer } = await savedManualChat();
    await resume('first chat');
    last().onExit();
    await Promise.resolve();
    await fs.copyFile(pointer, pointer + '.replacement');
    await fs.rename(pointer + '.replacement', pointer);
    await expect(resume('new input')).rejects.toThrow('no longer owns');
    expect(native.clients).toHaveLength(1);
  });

  it('accepts one human message after owner loss and resumes future bound host turns after its verified terminal', async () => {
    const { id, threadHome } = await savedManualChat();
    await crashAgyOverlay(threadHome);
    native.realHooks = true;
    await expect(executor.execute('ordinary')).rejects.toThrow('cannot safely resume');
    await expect(executor.execute('old occurrence', { hostScheduleSessionId: id })).rejects.toThrow();
    expect(native.clients).toHaveLength(0);
    const onStream = vi.fn();
    const recovery = resume('hold', { onStream });
    await vi.waitFor(() => expect(last()?.release).toBeDefined());
    expect(last().session).toBe(id);
    expect(last().prompts).toEqual(['hold']);
    expect(() => executor.checkHostScheduleSession(id)).toThrow();
    await expect(executor.execute('concurrent')).rejects.toThrow();
    last().finish(); last().release({ stopReason: 'end_turn' });
    await expect(recovery).resolves.toMatchObject({ success: true });
    expect(onStream).toHaveBeenCalledWith('Synthetic result');
    expect(last().token).toBeUndefined();
    await expect(executor.execute('next due occurrence', { hostScheduleSessionId: id })).resolves.toMatchObject({ success: true });
    expect(last().prompts).toEqual(['hold', 'next due occurrence']);
    expect(last().tasks.size).toBe(0);
    const operation = vi.fn();
    await expect(executor.withNativeScheduleOperation('native-create', () => true, operation, false)).rejects.toThrow('Native scheduling is unavailable');
    expect(operation).not.toHaveBeenCalled();
    await executor.destroy(); executor = make();
    executor.checkHostScheduleSession(id);
  });

  it('continues foreground chat with historical RUNNING receipts and a bundled old command wake, without admitting its timer', async () => {
    const { id, threadHome } = await savedManualChat();
    const task = id + '/task-2';
    native.loadedRows!.push({ step_index: 2, type: 'GENERIC', source: 'MODEL', status: 'RUNNING',
      content: 'Tool is running as a background task with task id: ' + task + '\nTask Description: Fixture\nTask logs are available at: file:///fixture' },
    { step_index: 3, type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', content: 'Saved answer' });
    await fs.writeFile(transcriptPath(threadHome, id), native.loadedRows!.map(row => JSON.stringify(row)).join('\n'));
    const work = resume('hold');
    await vi.waitFor(() => expect(last()?.release).toBeDefined());
    completion(last(), { id: task, log: 'file:///fixture' });
    last().finish(); last().release({ stopReason: 'end_turn' });
    await expect(work).resolves.toMatchObject({ success: true });
    expect(() => executor.checkHostScheduleSession(id)).toThrow();
    await expect(executor.execute('follow-up')).resolves.toMatchObject({ success: true });
    expect(last().prompts).toEqual(['hold', 'follow-up']);
  });

  it.each(['recovery', 'follow-up'])('retains live foreground tool error evidence during the %s turn on a timer-fenced recovered chat', async phase => {
    const { id, threadHome } = await savedManualChat();
    native.loadedRows!.push({ step_index: 2, type: 'GENERIC', source: 'MODEL', status: 'ERROR', content: 'Historical failure' });
    await fs.writeFile(transcriptPath(threadHome, id), native.loadedRows!.map(row => JSON.stringify(row)).join('\n'));
    if (phase === 'follow-up') await expect(resume('recover')).resolves.toMatchObject({ success: true });
    const turn = phase === 'recovery' ? resume('hold') : executor.execute('hold');
    await vi.waitFor(() => expect(last()?.release).toBeDefined());
    const client = last(), payload = ordinaryTool(client, 'read_file');
    expect(client.hook('PreToolUse', payload).decision).toBe('allow');
    client.hook('PostToolUse', { ...payload, error: 'synthetic failure' });
    client.row('GENERIC', 'Encountered error in step execution: synthetic failure', 'MODEL', 'ERROR', payload.stepIdx);
    client.hook('PostInvocation');
    client.hook('PreInvocation', { initialNumSteps: client.cursor });
    client.finish(); client.release({ stopReason: 'end_turn' });
    await expect(turn).resolves.toMatchObject({ success: true });
    expect(() => executor.checkHostScheduleSession(id)).toThrow();
    await expect(executor.execute('first follow-up')).resolves.toMatchObject({ success: true });
    await expect(executor.execute('second follow-up')).resolves.toMatchObject({ success: true });
    expect(client.prompts).toEqual([...(phase === 'follow-up' ? ['recover'] : []), 'hold', 'first follow-up', 'second follow-up']);
    expect(native.clients).toHaveLength(1);
    expect(executor.getSessionId()).toBe(id);
    expect(() => executor.checkHostScheduleSession(id)).toThrow();
  });

  it.each(['both pre-hooks before receipts', 'both posts before receipts', 'sibling visible at pre-hook', 'wrong slot', 'changed hook id',
    'changed planner', 'changed sibling receipt', 'changed error receipt', 'missing sibling receipt', 'missing sibling post', 'missing error post'])(
    'joins recovered parallel tool hooks to their planner slots: %s', async scenario => {
      const { id } = await savedManualChat();
      const work = resume('hold');
      work.catch(() => undefined);
      await vi.waitFor(() => expect(last()?.release).toBeDefined());
      const client = last();
      const shell = { name: 'run_command', args: { CommandLine: 'echo synthetic' } };
      const list = { name: 'mcp_remote-cli-delegation_remote_cli_schedule_list', args: {} };
      const error = JSON.stringify({ error: 'No active delegation turn' });
      client.row('PLANNER_RESPONSE', '');
      const planner = client.rows.at(-1);
      planner.tool_calls = scenario === 'wrong slot' ? [list, shell] : [shell, list];
      const first = { stepIdx: client.cursor++, toolCall: { id: 'command', ...shell } };
      const second = { stepIdx: client.cursor++, toolCall: { id: 'list', ...list } };
      expect(client.hook('PreToolUse', first).decision).toBe('allow');
      if (scenario !== 'sibling visible at pre-hook') client.hook('PreToolUse', second);
      if (scenario === 'both posts before receipts') client.hook('PostToolUse', { ...second, error });
      if (scenario !== 'missing sibling post') client.hook('PostToolUse', first);
      if (scenario !== 'missing sibling receipt') client.row('GENERIC', 'Synthetic command output', 'MODEL', 'DONE', first.stepIdx);
      if (scenario === 'sibling visible at pre-hook') client.hook('PreToolUse', second);
      if (scenario !== 'missing error post' && scenario !== 'both posts before receipts') client.hook('PostToolUse', { ...second, error,
        toolCall: { ...second.toolCall, id: scenario === 'changed hook id' ? 'other' : second.toolCall.id } });
      client.row('GENERIC', 'Encountered error in step execution: ' + error, 'MODEL', 'ERROR', second.stepIdx);
      client.hook('PostInvocation');
      if (scenario === 'changed planner') planner.content += 'changed';
      if (scenario === 'changed sibling receipt') client.rows.at(-2).content += 'changed';
      if (scenario === 'changed error receipt') client.rows.at(-1).content += 'changed';
      if (scenario === 'both posts before receipts') {
        client.row('SYSTEM_MESSAGE', NOTIFICATION_PREFIX +
          '[Message] timestamp=2026-01-01T00:00:00Z sender=fixture priority=MESSAGE_PRIORITY_HIGH content=Queued input\n</SYSTEM_MESSAGE>', 'SYSTEM');
        client.hook('PreInvocation', { initialNumSteps: client.cursor });
        const next = ordinaryTool(client, 'read_file');
        expect(client.hook('PreToolUse', next).decision).toBe('allow');
        client.hook('PostToolUse', next);
        client.row('GENERIC', 'Synthetic read', 'MODEL', 'DONE', next.stepIdx);
        client.hook('PostInvocation');
      }
      client.hook('PreInvocation', { initialNumSteps: client.cursor });
      client.finish(); client.release({ stopReason: 'end_turn' });
      if (['both pre-hooks before receipts', 'both posts before receipts', 'sibling visible at pre-hook'].includes(scenario)) {
        await expect(work).resolves.toMatchObject({ success: true });
        await expect(executor.execute('first follow-up')).resolves.toMatchObject({ success: true });
        await expect(executor.execute('second follow-up')).resolves.toMatchObject({ success: true });
        expect(client.prompts).toEqual(['hold', 'first follow-up', 'second follow-up']);
        expect(executor.getSessionId()).toBe(id);
        expect(native.clients).toHaveLength(1);
      } else {
        await work.catch(() => undefined);
        await expect(executor.execute('follow-up')).rejects.toThrow();
        expect(client.prompts).toEqual(['hold']);
      }
      expect(() => executor.checkHostScheduleSession(id)).toThrow();
    });

  it('refuses follow-up chat when the live recovery tool receipt differs from its hook', async () => {
    const { id } = await savedManualChat();
    const turn = resume('hold');
    await vi.waitFor(() => expect(last()?.release).toBeDefined());
    const client = last(), payload = ordinaryTool(client, 'read_file');
    expect(client.hook('PreToolUse', payload).decision).toBe('allow');
    client.hook('PostToolUse', { ...payload, error: 'synthetic failure' });
    client.row('GENERIC', 'Encountered error in step execution: different failure', 'MODEL', 'ERROR', payload.stepIdx);
    client.hook('PostInvocation'); client.finish(); client.release({ stopReason: 'end_turn' });
    await expect(turn).rejects.toThrow();
    await expect(executor.execute('follow-up')).rejects.toThrow();
    expect(client.prompts).toEqual(['hold']);
    expect(() => executor.checkHostScheduleSession(id)).toThrow();
  });

  it('fences changed historical evidence during the recovery prompt', async () => {
    await savedManualChat();
    const work = resume('hold');
    await vi.waitFor(() => expect(last()?.release).toBeDefined());
    last().rows[0].content = 'Replaced historical message';
    last().finish(); last().release({ stopReason: 'end_turn' });
    await expect(work).rejects.toThrow();
    expect(last().prompts).toEqual(['hold']);
  });

  it('delivers a manually accepted foreground batch with foreign input without enabling host timers', async () => {
    const { id } = await savedManualChat();
    const recovery = resume('hold');
    await vi.waitFor(() => expect(last()?.release).toBeDefined());
    last().row('SYSTEM_MESSAGE', NOTIFICATION_PREFIX +
      '[Message] timestamp=2026-01-01T00:00:00Z sender=another-agent priority=MESSAGE_PRIORITY_HIGH content=Previously queued message\n</SYSTEM_MESSAGE>', 'SYSTEM');
    last().finish(); last().release({ stopReason: 'end_turn' });
    await expect(recovery).resolves.toMatchObject({ success: true });
    expect(last().prompts).toEqual(['hold']);
    expect(() => executor.checkHostScheduleSession(id)).toThrow();
    await expect(executor.execute('continue chatting')).resolves.toMatchObject({ success: true });
    expect(() => executor.checkHostScheduleSession(id)).toThrow();
    last().row('SYSTEM_MESSAGE', NOTIFICATION_PREFIX +
      '[Message] timestamp=2026-01-01T00:01:00Z sender=another-agent priority=MESSAGE_PRIORITY_HIGH content=New message\n</SYSTEM_MESSAGE>', 'SYSTEM');
    await expect(executor.execute('check new arrival')).rejects.toThrow();
  });

  it.each(['pointer', 'history', 'native-schedules', 'allocation-unconfirmed', 'checkpoint.lock'] as const)(
    'rechecks %s after gated startup and before the manual load', async changed => {
      const { pointer, db } = await savedManualChat();
      let release!: () => void;
      native.initializeWait = new Promise(resolve => { release = resolve; });
      const recovery = resume('fresh human message');
      await vi.waitFor(() => expect(native.clients).toHaveLength(1));
      if (changed === 'history') await fs.appendFile(db, 'changed');
      else if (changed === 'pointer') {
        const copy = pointer + '.replacement';
        await fs.copyFile(pointer, copy); await fs.rename(copy, pointer);
      } else await fs.writeFile(pointer + '.' + changed, '{}');
      release();
      await expect(recovery).rejects.toThrow();
      expect(last().prompts).toEqual([]);
      expect(native.bind).not.toHaveBeenCalled();
      expect(last().closed).toBe(true);
      await expect(executor.execute('automatic retry')).rejects.toThrow();
    });

  it.each(['worker', 'worker-policy', 'checkpoint', 'missing generation', 'stale generation', 'legacy'] as const)(
    'keeps manual recovery outside the %s path', async kind => {
      const { pointer } = await savedManualChat();
      const selected = JSON.parse(await fs.readFile(pointer, 'utf8'));
      if (kind === 'worker-policy') await fs.writeFile(pointer + '.worker-policy', '{}');
      if (kind === 'checkpoint') selected.hostScheduleCheckpoint = {};
      if (kind === 'missing generation') delete selected.hostGeneration;
      if (kind === 'stale generation') selected.manualResumeConsumedGeneration = 'previous';
      if (kind === 'legacy') selected.transport = 'stream-json';
      await fs.writeFile(pointer, JSON.stringify(selected));
      executor = kind === 'worker' ? new AgyExecutor(new DirectoryGuard([cwd]), {
        initialWorkingDirectory: cwd, threadId: 'synthetic-thread', delegationWorker: true,
      }) : make();
      await expect(resume('fresh text')).rejects.toThrow();
      expect(native.clients).toHaveLength(0);
      expect(JSON.parse(await fs.readFile(pointer, 'utf8'))).toEqual(selected);
    });

  it('rechecks the claimed pointer before dispatch and never sends an automatic follow-up prompt', async () => {
    const { pointer } = await savedManualChat();
    let release!: () => void;
    native.settingWait = new Promise(resolve => { release = resolve; });
    const recovery = resume('fresh text');
    await vi.waitFor(() => expect(last()?.controls.length).toBeGreaterThan(0));
    const replacement = pointer + '.copy';
    await fs.copyFile(pointer, replacement); await fs.rename(replacement, pointer);
    release();
    await expect(recovery).rejects.toThrow('changed before dispatch');
    expect(last().prompts).toEqual([]);
    const onToolUse = vi.fn();
    await expect(resume('ask', { onToolUse })).rejects.toThrow();
    expect(onToolUse).toHaveBeenCalled();
    expect(last().prompts).toEqual(['ask']);
    await expect(executor.execute('retry')).rejects.toThrow('cannot safely resume');
  });

  it('keeps manual admission single-use on failure and rejects automated prompt substitution', async () => {
    const { id } = await savedManualChat();
    const resolvePrompt = vi.fn(() => 'scheduled text');
    for (const options of [{ resolvePrompt }, { hostScheduleSessionId: id }]) {
      await expect(resume('text', options)).rejects.toThrow('human text');
    }
    expect(resolvePrompt).not.toHaveBeenCalled();
    expect(native.clients).toHaveLength(0);
    await expect(resume('missing terminal')).rejects.toThrow();
    expect(last().closed).toBe(true);
    await expect(executor.execute('automatic retry')).rejects.toThrow('cannot safely resume');
    await expect(resume('new explicit message')).resolves.toMatchObject({ success: true });
    expect(native.clients.map(client => client.prompts)).toEqual([['missing terminal'], ['new explicit message']]);
  });

  it('retains a failed human confirmation across executor restart and replacement of the saved pointer', async () => {
    const { pointer } = await savedManualChat();
    const original = await fs.readFile(pointer);
    const source = humanConfirmation();
    await expect(executor.resumeAgyChat('missing terminal', {}, source)).rejects.toThrow();
    await executor.destroy();
    await fs.writeFile(pointer, original);
    executor = make();
    await expect(executor.resumeAgyChat('duplicate', {}, source)).rejects.toThrow();
    expect(native.clients.map(client => client.prompts)).toEqual([['missing terminal']]);
    const ledger = await fs.readFile(path.join(home, '.remote-cli', 'agy-confirmations.json'), 'utf8');
    expect(ledger).not.toContain(source.originalMessageId);
    expect(ledger).not.toContain('missing terminal');
    await expect(resume('new human input')).resolves.toMatchObject({ success: true });
  });

  it.each(['before load', 'before prompt'])('revokes manual confirmation after connection replacement %s', async stage => {
    await savedManualChat();
    const source = humanConfirmation();
    let current = true;
    source.current = () => current;
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    if (stage === 'before load') native.initializeWait = wait;
    else native.settingWait = wait;
    const work = executor.resumeAgyChat('confirmed', {}, source);
    await vi.waitFor(() => expect(stage === 'before load' ? native.clients.length : last()?.controls.length).toBeGreaterThan(0));
    current = false;
    release();
    await expect(work).rejects.toThrow();
    expect(last().prompts).toEqual([]);
    current = true;
    executor = make();
    await expect(executor.resumeAgyChat('duplicate', {}, source)).rejects.toThrow();
    expect(native.clients).toHaveLength(1);
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
