import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough, Writable } from 'stream';
import { mkdtemp, realpath, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import { ClaudeNativeScheduleProvider, type ClaudeNativeScheduleProviderOptions } from '../src/scheduling/ClaudeNativeScheduleProvider';
import type { NativeScheduleEvent, NativeScheduleHandle, NativeScheduleInput } from '../src/scheduling/types';

type Frame = Record<string, any>;
const NOW = Date.parse('2030-01-02T10:00:00Z');
const JOB = 'synthetic-job';
const CAPS = ['msg_lifecycle_v1', 'lifecycle_wakeup_source_v1'];
const TOOLS = ['CronCreate', 'CronList', 'CronDelete', 'Read', 'Bash'];
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

class NativeFixture extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new Writable({ write: (chunk, _encoding, callback) => {
    const message = JSON.parse(String(chunk));
    this.sent.push(message);
    queueMicrotask(() => this.receive(message));
    callback();
  } });
  sent: Frame[] = [];
  turns: Frame[] = [];
  tools = [...TOOLS];
  capabilities = [...CAPS];
  nativeInput?: Frame;
  alive = true;
  graceful = true;
  killOn: string | undefined = 'SIGTERM';
  signals: string[] = [];
  initialized = true;
  onTurn?: (message: Frame) => void;
  mutateReceipt?: (frame: Frame) => void;
  constructor() {
    super();
    this.stdin.on('finish', () => { if (this.graceful) queueMicrotask(() => this.exit()); });
  }
  kill(signal: string) { this.signals.push(signal); if (signal === this.killOn) this.exit(); return true; }
  exit() { if (this.alive) { this.alive = false; this.emit('exit', 0, null); this.emit('close', 0, null); } }
  frame(frame: Frame) { if (!this.stdout.destroyed) this.stdout.write(JSON.stringify(frame) + '\n'); }
  init() { this.frame({ type: 'system', subtype: 'init', session_id: 'synthetic-session', tools: this.tools, capabilities: this.capabilities }); }
  life(id: string, state: string, extras: Frame = {}) { this.frame({ type: 'command_lifecycle', command_uuid: id, state, ...extras }); }
  receive(message: Frame) {
    if (!this.alive) return;
    if (message.type === 'control_request' && this.initialized) {
      this.frame({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id } });
    } else if (message.type === 'user') {
      this.turns.push(message);
      if (this.onTurn) this.onTurn(message); else this.reply(message);
    }
  }
  operation(message: Frame) {
    const text = message.message.content;
    return { name: /Call exactly once (\w+)/.exec(text)![1], input: JSON.parse(text.slice(text.indexOf('\n') + 1)) };
  }
  begin(message: Frame) { this.life(message.uuid, 'queued'); this.life(message.uuid, 'started'); this.init(); }
  tool(message: Frame, extras: { hook?: boolean; toolId?: string; content?: string; input?: Frame; error?: boolean } = {}) {
    const { name, input: expected } = this.operation(message);
    const input = extras.input ?? expected;
    const toolId = extras.toolId ?? `tool-${this.turns.length}`;
    this.frame({ type: 'assistant', message: { content: [{ type: 'tool_use', id: toolId, name, input }] } });
    if (extras.hook !== false) this.frame({ type: 'control_request', request_id: `hook-${toolId}`, request: {
      subtype: 'hook_callback', callback_id: 'native-schedule-tool-guard', tool_use_id: toolId,
      input: { hook_event_name: 'PreToolUse', tool_name: name, tool_input: input, tool_use_id: toolId },
    } });
    let content: string;
    if (name === 'CronCreate') {
      this.nativeInput = input;
      content = `Scheduled ${input.recurring ? 'recurring job' : 'one-shot task'} ${JOB} (Every minute). Next run: Jan 2 10:01am. Session-only (not written to disk, dies when Claude exits). ${input.recurring ? 'Auto-expires after 7 days. Use CronDelete to cancel sooner.' : 'It will fire once then auto-delete.'}`;
    } else if (name === 'CronDelete') {
      this.nativeInput = undefined;
      content = `Cancelled job ${JOB}.`;
    } else content = this.nativeInput ? `${JOB} \u2014 Every minute (recurring) [session-only], next run Jan 2 10:02am: synthetic task` : 'No scheduled jobs.';
    const result = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolId, content: extras.content ?? content, ...(extras.error ? { is_error: true } : {}) }] } };
    this.mutateReceipt?.(result);
    this.frame(result);
  }
  terminal(message: Frame, extras: Frame = {}) {
    this.frame({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', result: 'Management finished.',
      uuid: 'synthetic-result', user_message_uuid: message.uuid, user_message_uuids: [message.uuid], ...extras });
  }
  reply(message: Frame) { this.begin(message); this.tool(message); this.terminal(message); this.life(message.uuid, 'completed'); }
  fire(id = 'synthetic-fire') { this.life(id, 'started', { wakeup_source: 'schedule_wakeup' }); this.init(); }
  fireResult(output = 'synthetic output', extras: Frame = {}) {
    this.frame({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', uuid: 'synthetic-occurrence-result', result: output, ...extras });
  }
}

let cwd: string;
let fixtures: NativeFixture[];
let handles: NativeScheduleHandle[];
beforeEach(async () => {
  cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'native-schedule-test-')));
  vi.spyOn(os, 'homedir').mockReturnValue(cwd);
  fixtures = []; handles = [];
});
afterEach(async () => {
  fixtures.forEach(fixture => fixture.exit());
  await Promise.allSettled(handles.map(handle => handle.stop()));
  vi.useRealTimers(); vi.restoreAllMocks();
  await rm(cwd, { recursive: true, force: true });
});

function setup(options: ClaudeNativeScheduleProviderOptions = {}) {
  const fixture = new NativeFixture(); fixtures.push(fixture);
  const spawn = vi.fn(() => fixture as unknown as ChildProcessWithoutNullStreams);
  const events: NativeScheduleEvent[] = [];
  const provider = new ClaudeNativeScheduleProvider({ spawn, now: () => NOW, managementTimeoutMs: 1000, shutdownTimeoutMs: 10, ...options });
  const input: NativeScheduleInput = { id: 'synthetic-schedule', cwd, rule: { kind: 'cron', expression: '* * * * *', timezone: 'America/New_York' }, prompt: 'synthetic task' };
  const create = async (override: Partial<NativeScheduleInput> = {}) => {
    const handle = await provider.create({ ...input, ...override }, event => events.push(event));
    handles.push(handle); return handle;
  };
  return { fixture, spawn, events, provider, input, create };
}

describe('ClaudeNativeScheduleProvider', () => {
  it('creates, lists, and cancels through exact native receipts with isolated launch options', async () => {
    const { fixture, spawn, create, events } = setup();
    const handle = await create({ model: 'synthetic-model', effort: 'low' });
    expect(handle.nativeId).toBe(JOB);
    expect(fixture.nativeInput).toEqual({ cron: '* * * * *', prompt: 'synthetic task', recurring: true, durable: false });
    expect(await handle.list()).toBe(true);
    await handle.cancel();
    expect(fixture.alive).toBe(false);
    expect(events).toEqual([{ type: 'stopped', reason: 'Native schedule cancelled.' }]);
    expect(fixture.turns.map(turn => fixture.operation(turn).name)).toEqual(['CronList', 'CronCreate', 'CronList', 'CronDelete']);
    const [command, args, options] = spawn.mock.calls[0] as unknown as [string, string[], Frame];
    expect(command).toBe('claude');
    expect(args).toEqual(expect.arrayContaining(['--safe-mode', '--no-session-persistence', '--permission-prompt-tool', 'stdio', '--model', 'synthetic-model', '--effort', 'low']));
    expect(args).not.toContain('--setting-sources');
    expect(args).not.toContain('--tools');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(options.cwd).toBe(cwd);
    expect(options.shell).toBe(false);
    expect(options.windowsHide).toBe(true);
    expect(options.env.TZ).toBe('America/New_York');
    expect(options.env.ENABLE_TOOL_SEARCH).toBe('false');
    expect(JSON.parse(args[args.indexOf('--settings') + 1])).toEqual({ env: { TZ: 'America/New_York', ENABLE_TOOL_SEARCH: 'false' } });
  });

  it('converts an absolute one-shot to UTC and exits only after result plus lifecycle completion', async () => {
    const { fixture, spawn, create, events } = setup();
    const handle = await create({ rule: { kind: 'once', at: '2030-01-02T12:01:00+02:00' } });
    expect(fixture.nativeInput).toMatchObject({ cron: '1 10 2 1 *', recurring: false, durable: false });
    expect((spawn.mock.calls[0] as unknown as [string, string[], Frame])[2].env.TZ).toBe('UTC');
    fixture.fire(); fixture.fireResult();
    expect(events).toEqual([{ type: 'started', occurrenceId: 'synthetic-fire' }]);
    expect(fixture.alive).toBe(true);
    fixture.life('synthetic-fire', 'completed');
    await handle.stop();
    expect(events[1]).toEqual({ type: 'completed', occurrenceId: 'synthetic-fire', success: true, output: 'synthetic output' });
    expect(await handle.list()).toBe(false);
    await handle.cancel();
    expect(fixture.turns).toHaveLength(2);
  });

  it('snapshots caller input before asynchronous initialization', async () => {
    const { fixture, provider, input } = setup();
    const creating = provider.create(input, () => {});
    input.prompt = 'changed task';
    input.rule = { kind: 'cron', expression: '5 * * * *', timezone: 'UTC' };
    const handle = await creating; handles.push(handle);
    expect(fixture.nativeInput).toMatchObject({ prompt: 'synthetic task', cron: '* * * * *' });
  });

  it('keeps recurring occurrences distinct and permits ordinary tools without nested schedules', async () => {
    const { fixture, create, events } = setup();
    const handle = await create();
    for (const id of ['fire-a', 'fire-b']) {
      fixture.fire(id);
      fixture.frame({ type: 'control_request', request_id: `pre-${id}`, request: { subtype: 'hook_callback', callback_id: 'native-schedule-tool-guard', tool_use_id: `tool-${id}`, input: { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {}, tool_use_id: `tool-${id}` } } });
      fixture.frame({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'Read', input: { file_path: path.join(cwd, 'synthetic.txt') } } });
      fixture.fireResult(id); fixture.life(id, 'completed');
      fixture.life(id, 'completed');
    }
    expect(events.filter(event => event.type === 'completed')).toHaveLength(2);
    expect(fixture.sent.find(frame => frame.response?.request_id === 'fire-a')?.response.response.behavior).toBe('allow');
    expect(fixture.sent.find(frame => frame.response?.request_id === 'pre-fire-a')?.response.response).toEqual({});
    expect(fixture.alive).toBe(true);
    await handle.stop();
  });

  it.each(['msg_lifecycle_v1', 'lifecycle_wakeup_source_v1', 'CronCreate', 'CronList', 'CronDelete'])('fails closed without advertised %s', async missing => {
    const { fixture, create } = setup();
    fixture.capabilities = CAPS.filter(capability => capability !== missing);
    fixture.tools = TOOLS.filter(tool => tool !== missing);
    await expect(create()).rejects.toThrow('required native scheduling');
    expect(fixture.nativeInput).toBeUndefined();
    expect(fixture.alive).toBe(false);
  });

  it.each(['prose', 'wrong-result-id', 'wrong-tool-id', 'tool-error', 'no-hook', 'existing-job', 'extra-create', 'wrong-prompt', 'durable'])('rejects %s and proves failed-create process exit', async variant => {
    const { fixture, create } = setup();
    fixture.onTurn = message => {
      if (fixture.turns.length === 1 && variant !== 'existing-job') { fixture.reply(message); return; }
      fixture.begin(message);
      if (variant === 'prose') fixture.terminal(message);
      else {
        if (variant === 'wrong-tool-id') fixture.mutateReceipt = result => { result.message.content[0].tool_use_id = 'unrelated-tool'; };
        const expected = fixture.operation(message).input;
        fixture.tool(message, {
          hook: variant !== 'no-hook', error: variant === 'tool-error',
          ...(variant === 'existing-job' ? { content: 'unrelated-job \u2014 Every minute (recurring) [session-only]: other task' } : {}),
          ...(variant === 'wrong-prompt' ? { input: { ...expected, prompt: 'different task' } } : {}),
          ...(variant === 'durable' ? { input: { ...expected, durable: true } } : {}),
        });
        if (variant === 'extra-create') fixture.tool(message);
        fixture.terminal(message, variant === 'wrong-result-id' ? { user_message_uuid: 'unrelated-request' } : {});
      }
      fixture.life(message.uuid, 'completed');
    };
    await expect(create()).rejects.toThrow();
    expect(fixture.alive).toBe(false);
  });

  it('rejects fake deletion prose even when the management result claims success', async () => {
    const { fixture, create } = setup(); const handle = await create();
    fixture.onTurn = message => { fixture.begin(message); fixture.tool(message, { content: 'The job is cancelled.' }); fixture.terminal(message); fixture.life(message.uuid, 'completed'); };
    await expect(handle.cancel()).rejects.toThrow();
    expect(fixture.alive).toBe(false);
  });

  it('denies one-shot creation when the target minute passes before tool authorization', async () => {
    let now = NOW;
    const { fixture, create } = setup({ now: () => now });
    fixture.onTurn = message => {
      if (fixture.operation(message).name !== 'CronCreate') { fixture.reply(message); return; }
      fixture.begin(message);
      const { name, input } = fixture.operation(message);
      fixture.frame({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'expired-create', name, input }] } });
      now = NOW + 60_000;
      fixture.frame({ type: 'control_request', request_id: 'expired-hook', request: {
        subtype: 'hook_callback', callback_id: 'native-schedule-tool-guard', tool_use_id: 'expired-create',
        input: { hook_event_name: 'PreToolUse', tool_name: name, tool_input: input, tool_use_id: 'expired-create' },
      } });
    };
    await expect(create({ rule: { kind: 'once', at: '2030-01-02T10:01:00Z' } })).rejects.toThrow();
    const denial = fixture.sent.find(frame => frame.type === 'control_response' && frame.response.request_id === 'expired-hook');
    expect(denial.response.response.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(fixture.nativeInput).toBeUndefined();
    expect(fixture.alive).toBe(false);
  });

  it('serializes list and cancellation through lifecycle end, not merely the result', async () => {
    const { fixture, create } = setup(); const handle = await create();
    fixture.onTurn = message => { fixture.begin(message); fixture.tool(message); fixture.terminal(message); };
    const list = handle.list(); const cancel = handle.cancel();
    await flush(); expect(fixture.turns).toHaveLength(3);
    fixture.life(fixture.turns[2].uuid, 'completed');
    expect(await list).toBe(true);
    await flush(); expect(fixture.turns).toHaveLength(4);
    fixture.life(fixture.turns[3].uuid, 'completed');
    await cancel;
  });

  it('waits for an active firing before sending cancellation', async () => {
    const { fixture, create, events } = setup(); const handle = await create();
    fixture.fire();
    const cancelled = handle.cancel(); await flush();
    expect(fixture.turns).toHaveLength(2);
    fixture.fireResult(); fixture.life('synthetic-fire', 'completed');
    await cancelled;
    expect(events[1]).toMatchObject({ type: 'completed', success: true });
    expect(fixture.turns).toHaveLength(3);
  });

  it('does not resolve a queued management request with an autonomous result', async () => {
    const { fixture, create, events } = setup(); const handle = await create();
    fixture.onTurn = message => { fixture.life(message.uuid, 'queued'); fixture.fire(); };
    let settled = false;
    const list = handle.list().then(value => { settled = true; return value; }); await flush();
    fixture.fireResult(); fixture.life('synthetic-fire', 'completed'); await flush();
    expect(settled).toBe(false);
    const request = fixture.turns[2];
    fixture.life(request.uuid, 'started'); fixture.init(); fixture.tool(request); fixture.terminal(request); fixture.life(request.uuid, 'completed');
    expect(await list).toBe(true);
    expect(events.filter(event => event.type === 'completed')).toHaveLength(1);
  });

  it('rejects management folded into an occurrence rather than joining by FIFO', async () => {
    const { fixture, create } = setup(); const handle = await create();
    fixture.onTurn = message => { fixture.fire(); fixture.life(message.uuid, 'started'); };
    await expect(handle.list()).rejects.toThrow();
    expect(fixture.alive).toBe(false);
  });

  it('rejects a result listing more than one management UUID', async () => {
    const { fixture, create } = setup(); const handle = await create();
    fixture.onTurn = message => { fixture.begin(message); fixture.tool(message); fixture.terminal(message, { user_message_uuids: [message.uuid, 'other-send'] }); };
    await expect(handle.list()).rejects.toThrow();
  });

  it.each(['user_message_uuid', 'user_message_uuids'])('accepts a management result joined through %s alone', async keep => {
    const { fixture, create } = setup(); const handle = await create();
    fixture.onTurn = message => {
      fixture.begin(message); fixture.tool(message);
      fixture.terminal(message, keep === 'user_message_uuid' ? { user_message_uuids: undefined } : { user_message_uuid: undefined });
      fixture.life(message.uuid, 'completed');
    };
    expect(await handle.list()).toBe(true);
  });

  it('handles wakeup in the same stdout chunk as native creation completion', async () => {
    const { fixture, create, events } = setup();
    fixture.onTurn = message => {
      fixture.reply(message);
      if (fixture.operation(message).name === 'CronCreate') fixture.fire('immediate-fire');
    };
    const handle = await create();
    expect(events).toEqual([{ type: 'started', occurrenceId: 'immediate-fire' }]);
    fixture.fireResult(); fixture.life('immediate-fire', 'completed'); await handle.stop();
  });

  it('settles a waiting list when a one-shot completes and closes automatically', async () => {
    const { fixture, create } = setup();
    const handle = await create({ rule: { kind: 'once', at: '2030-01-02T10:01:00Z' } });
    fixture.fire(); const listed = handle.list(); await flush();
    fixture.fireResult(); fixture.life('synthetic-fire', 'completed');
    expect(await listed).toBe(false);
    expect(fixture.alive).toBe(false);
  });

  it('does not silently ignore changed sessions or foreign native job inventory', async () => {
    const { fixture, create } = setup(); const handle = await create();
    fixture.onTurn = message => {
      fixture.begin(message); fixture.tool(message);
      fixture.terminal(message, { session_id: 'foreign-session' });
    };
    await expect(handle.list()).rejects.toThrow();
  });

  it('stops after native list confirms that a recurring schedule has disappeared', async () => {
    const { fixture, create } = setup(); const handle = await create(); fixture.nativeInput = undefined;
    expect(await handle.list()).toBe(false);
    expect(fixture.alive).toBe(false);
  });

  it('rejects native management errors even after a successful tool receipt', async () => {
    const { fixture, create } = setup(); const handle = await create();
    fixture.onTurn = message => { fixture.begin(message); fixture.tool(message); fixture.terminal(message, { is_error: true, terminal_reason: 'api_error' }); };
    await expect(handle.list()).rejects.toThrow('management failed');
    expect(fixture.alive).toBe(false);
  });

  it('blocks an unexpected ordinary management tool instead of silently allowing it', async () => {
    const { fixture, create } = setup(); const handle = await create();
    fixture.onTurn = message => {
      fixture.begin(message);
      fixture.frame({ type: 'control_request', request_id: 'unexpected', request: { subtype: 'hook_callback', callback_id: 'native-schedule-tool-guard', tool_use_id: 'unexpected-tool', input: { tool_name: 'Bash', tool_input: { command: 'synthetic-command' } } } });
    };
    await expect(handle.list()).rejects.toThrow('unexpected tool');
    expect(fixture.sent.find(frame => frame.response?.request_id === 'unexpected')?.response.response.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('fails closed if a scheduled turn begins during a native deletion turn', async () => {
    const { fixture, create } = setup(); const handle = await create();
    fixture.onTurn = message => { fixture.begin(message); fixture.fire(); };
    await expect(handle.cancel()).rejects.toThrow();
    expect(fixture.alive).toBe(false);
  });

  it('reports native task errors without leaking native error text', async () => {
    const { fixture, create, events } = setup(); const handle = await create();
    fixture.fire(); fixture.fireResult('synthetic-private-diagnostic', { is_error: true, terminal_reason: 'api_error' }); fixture.life('synthetic-fire', 'completed');
    expect(events[1]).toEqual({ type: 'completed', occurrenceId: 'synthetic-fire', success: false, error: 'Native scheduled task failed.' });
    await handle.stop();
  });

  it('retains a recurring schedule after a failed native occurrence ends as cancelled', async () => {
    const { fixture, create, events } = setup(); const handle = await create();
    fixture.fire(); fixture.fireResult('synthetic diagnostic', { is_error: true, terminal_reason: 'api_error' });
    fixture.life('synthetic-fire', 'cancelled');
    expect(events[1]).toMatchObject({ type: 'completed', success: false });
    expect(fixture.alive).toBe(true);
    fixture.fire('next-fire'); fixture.fireResult(); fixture.life('next-fire', 'completed');
    expect(events[3]).toMatchObject({ type: 'completed', occurrenceId: 'next-fire', success: true });
    await handle.stop();
  });

  it('reports process death as lost without recreating or publishing an unconfirmed success', async () => {
    const { fixture, create, spawn, events } = setup(); const handle = await create();
    fixture.fire(); fixture.fireResult(); fixture.exit();
    expect(events[1]).toMatchObject({ type: 'completed', success: false });
    expect(events[2]).toMatchObject({ type: 'stopped', reason: expect.stringContaining('lost') });
    await expect(handle.list()).rejects.toThrow('lost');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('denies nested Cron operations before approving a tool callback', async () => {
    const { fixture, create } = setup(); const handle = await create();
    fixture.fire();
    fixture.frame({ type: 'control_request', request_id: 'nested', request: { subtype: 'hook_callback', callback_id: 'native-schedule-tool-guard', tool_use_id: 'nested-tool', input: { tool_name: 'CronCreate', tool_input: { durable: true } } } });
    const response = fixture.sent.find(frame => frame.response?.request_id === 'nested');
    expect(response?.response.response.hookSpecificOutput.permissionDecision).toBe('deny');
    await handle.stop(); expect(fixture.alive).toBe(false);
  });

  it.each(['unterminated-frame', 'oversized-result', 'malformed-json', 'terminal-before-result', 'joined-occurrence'])('stops on %s', async variant => {
    const { fixture, create } = setup({ maxFrameBytes: 4096, maxOutputBytes: 32 }); const handle = await create();
    fixture.fire();
    if (variant === 'unterminated-frame') fixture.stdout.write('x'.repeat(4097));
    if (variant === 'oversized-result') fixture.fireResult('x'.repeat(33));
    if (variant === 'malformed-json') fixture.stdout.write('{invalid}\n');
    if (variant === 'terminal-before-result') fixture.life('synthetic-fire', 'completed');
    if (variant === 'joined-occurrence') fixture.fireResult('text', { user_message_uuid: 'other-command' });
    await handle.stop(); expect(fixture.alive).toBe(false);
  });

  it('handles split UTF-8 frames without corrupting output', async () => {
    const { fixture, create, events } = setup(); const handle = await create(); fixture.fire();
    const frame = Buffer.from(JSON.stringify({ type: 'result', is_error: false, terminal_reason: 'completed', uuid: 'result', result: '\u2603' }) + '\n');
    const index = frame.indexOf(Buffer.from('\u2603')) + 1;
    fixture.stdout.write(frame.subarray(0, index)); fixture.stdout.write(frame.subarray(index));
    fixture.life('synthetic-fire', 'completed');
    expect(events[1]).toMatchObject({ output: '\u2603' }); await handle.stop();
  });

  it('times out initialization and confirms cleanup', async () => {
    vi.useFakeTimers(); const { fixture, create } = setup(); fixture.initialized = false;
    const result = create(); const assertion = expect(result).rejects.toThrow('initialization timed out');
    await vi.advanceTimersByTimeAsync(1001); await assertion;
    expect(fixture.alive).toBe(false);
  });

  it('handles an asynchronous spawn failure with close as exit proof', async () => {
    const { fixture, create } = setup(); fixture.initialized = false;
    const result = create(); const assertion = expect(result).rejects.toThrow('could not start');
    fixture.emit('error', new Error('synthetic-private-error'));
    fixture.emit('close', -1, null);
    await assertion;
  });

  it('sanitizes synchronous spawn failures', async () => {
    const { create } = setup({ spawn: () => { throw new Error('synthetic-private-error'); } });
    await expect(create()).rejects.toThrow('Native schedule process could not start.');
  });

  it('times out management without a tool receipt or lifecycle completion', async () => {
    vi.useFakeTimers(); const { fixture, create } = setup(); fixture.onTurn = message => fixture.begin(message);
    const result = create(); const assertion = expect(result).rejects.toThrow('management timed out');
    await vi.advanceTimersByTimeAsync(1001); await assertion;
    expect(fixture.alive).toBe(false);
  });

  it('escalates shutdown and waits for exit instead of trusting kill return values', async () => {
    vi.useFakeTimers(); const { fixture, create } = setup(); const handle = await create();
    fixture.graceful = false; fixture.killOn = 'SIGKILL';
    const stopped = handle.stop();
    await vi.advanceTimersByTimeAsync(21); await stopped;
    expect(fixture.signals).toEqual(['SIGTERM', 'SIGKILL']); expect(fixture.alive).toBe(false);
  });

  it('rejects shutdown when process exit cannot be proven', async () => {
    vi.useFakeTimers(); const { fixture, create, events } = setup(); const handle = await create();
    fixture.graceful = false; fixture.killOn = undefined;
    const assertion = expect(handle.stop()).rejects.toThrow('could not be confirmed');
    await vi.advanceTimersByTimeAsync(31); await assertion;
    expect(events).toContainEqual({ type: 'stopped', reason: 'Native schedule shutdown failed: process exit is unconfirmed.', exitConfirmed: false });
    fixture.killOn = 'SIGTERM';
    const retry = handle.stop();
    await vi.advanceTimersByTimeAsync(11); await retry;
    expect(fixture.alive).toBe(false);
  });

  it.each([
    { kind: 'once', at: '2030-01-02T09:00:00Z' },
    { kind: 'once', at: '2030-01-02T10:01:01Z' },
    { kind: 'once', at: '2030-02-31T10:01:00Z' },
    { kind: 'once', at: '2030-01-02T10:01:00' },
    { kind: 'once', at: '2032-01-02T10:01:00Z' },
    { kind: 'cron', expression: '60 * * * *', timezone: 'UTC' },
    { kind: 'cron', expression: '*/0 * * * *', timezone: 'UTC' },
    { kind: 'cron', expression: '* * * * * *', timezone: 'UTC' },
    { kind: 'cron', expression: '* * * * *', timezone: 'Invalid/Zone' },
  ] as NativeScheduleInput['rule'][])('rejects invalid rule before spawning: %j', async rule => {
    const { create, spawn } = setup(); await expect(create({ rule })).rejects.toThrow(); expect(spawn).not.toHaveBeenCalled();
  });
});
