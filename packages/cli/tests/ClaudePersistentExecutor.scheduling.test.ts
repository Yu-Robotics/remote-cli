import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { ClaudePersistentExecutor } from '../src/executor/ClaudePersistentExecutor';
import { DirectoryGuard } from '../src/security/DirectoryGuard';
import { ScheduleToolOperations } from '../src/scheduling/ScheduleToolScope';
import { SCHEDULE_HOOK } from '../src/scheduling/claude/ClaudeSessionSchedules';
import type { NativeScheduleInput } from '../src/scheduling/types';
import { claudeCodeHooks } from '../src/hooks/ClaudeCodeHooks';

/** In-memory native transport only. No backend executable or model is invoked. */
describe('Claude shared foreground scheduling integration', () => {
  let root: string;
  let executor: ClaudePersistentExecutor;
  let wire: any[];
  let raw: any;
  let nativeTools: string[];
  let nativeSettings: unknown;
  const frame = (value: object) => raw.handleOutputLine(JSON.stringify(value));
  const lastUser = () => wire.filter(row => row.type === 'user').at(-1);
  const result = (id: string, text = 'Ordinary foreground answer') => frame({ type: 'result', uuid: `result-${id}`, is_error: false,
    terminal_reason: 'completed', result: text, user_message_uuid: id, user_message_uuids: [id] });
  const hook = (action: any, id: string) => frame({ type: 'control_request', request_id: `hook-${id}`,
    request: { subtype: 'hook_callback', callback_id: SCHEDULE_HOOK, tool_use_id: id,
      input: { hook_event_name: 'PreToolUse', tool_name: action.tool, tool_input: action.input } } });
  const receipt = (text: string, id: string) => frame({ type: 'user', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: id, content: text, is_error: false },
  ] } });
  const created = (id: string) => `Scheduled recurring job ${id} (every minute). Next run: later. Session-only (not written to disk, dies when Claude exits).`;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'claude-shared-session-')));
    vi.spyOn(os, 'homedir').mockReturnValue(root);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    executor = new ClaudePersistentExecutor(new DirectoryGuard([root]), root, 'synthetic-thread');
    raw = executor as any; wire = []; nativeTools = []; nativeSettings = { effective: { env: {} }, sources: [] };
    raw.sessionId = 'original-native-session';
    raw.claudeProcess = { killed: false, stdin: { writable: true, write: vi.fn((line: string, callback?: () => void) => {
      const message = JSON.parse(line); wire.push(message);
      if (message.type === 'control_request' && message.request.subtype === 'initialize') {
        queueMicrotask(() => frame({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id,
          response: { models: [] } } }));
      }
      if (message.type === 'control_request' && message.request.subtype === 'get_settings') {
        queueMicrotask(() => frame({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id,
          response: nativeSettings } }));
      }
      if (message.type === 'user' && message.message.content.startsWith('Perform this authorized native schedule operation')) {
        const action = JSON.parse(message.message.content.split('\n').at(-1)); nativeTools.push(action.tool);
        queueMicrotask(() => {
          hook(action, `tool-${message.uuid}`);
          receipt(action.tool === 'CronDelete' ? `Cancelled job ${action.input.id}.` : 'No scheduled jobs.', `tool-${message.uuid}`);
          result(message.uuid, 'Internal management complete');
        });
      }
      callback?.(); return true;
    }) } };
    await executor.listModels();
    frame({ type: 'system', subtype: 'init', session_id: 'original-native-session',
      tools: ['CronCreate', 'CronList', 'CronDelete'], capabilities: ['msg_lifecycle_v1', 'lifecycle_wakeup_source_v1'] });
  });
  afterEach(async () => {
    raw.sessionSchedules?.processClosed();
    raw.claudeProcess = null;
    await executor.destroy();
    vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true });
  });
  async function reserve(id = 'job-a') {
    const input: NativeScheduleInput = { id, cwd: root, prompt: 'Use the latest conversation state',
      rule: { kind: 'cron', expression: '* * * * *', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } };
    const events = vi.fn();
    const pending = executor.withNativeScheduleOperation(id, () => true, () => executor.createNativeSchedule(input, events), true);
    await vi.waitFor(() => expect(executor.nativeScheduleAction(id)).toBeDefined());
    const action = executor.nativeScheduleAction(id)!;
    hook(action, `tool-${id}`); receipt(created(`native-${id}`), `tool-${id}`);
    return { handle: await pending, action, events };
  }

  it('closes managed MCP creation in the caller turn and preserves subsequent user turns and session identity', async () => {
    const display = vi.fn();
    const foreground = executor.execute('Create a recurring task from this conversation', { onDisplayText: display });
    const first = lastUser(); const present = vi.fn(async () => 'Original-thread card delivered');
    const owner = { openId: 'synthetic-owner', threadId: 'synthetic-thread', generation: 'epoch-a' };
    const scope = new ScheduleToolOperations().scope({ owner, messageId: 'message-a', backend: 'claude', current: () => true, waitMs: 1,
      nativeAction: id => executor.nativeScheduleAction(id),
      run: (command, id) => executor.withNativeScheduleOperation(id, () => true, async () => {
        if (command.kind !== 'create') return [];
        const handle = await executor.createNativeSchedule({ id, cwd: root, rule: command.rule, prompt: command.prompt }, vi.fn());
        return [{ ...owner, id, backend: 'claude', cwd: root, rule: command.rule, prompt: command.prompt, createdAt: Date.now(), state: 'active', nativeId: handle.nativeId }];
      }, true), present });
    const args = { requestId: 'request-a', prompt: 'Use our latest discussion', when: { kind: 'cron', expression: '* * * * *', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } };
    const accepted: any = await scope.invoke('remote_cli_schedule_create', args);
    expect(accepted.status).toBe('pending'); expect(accepted.nativeAction.tool).toBe('CronCreate');
    expect(wire.filter(row => row.type === 'user')).toHaveLength(1);
    expect(await scope.invoke('remote_cli_schedule_create', args)).toEqual(accepted);
    hook(accepted.nativeAction, 'creation-tool'); receipt(created('native-a'), 'creation-tool');
    await scope.drain();
    expect(await scope.invoke('remote_cli_schedule_operation', { requestId: 'request-a' })).toMatchObject({ status: 'succeeded' });
    expect(present).toHaveBeenCalledOnce();
    frame({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Your task is scheduled.' }] } });
    result(first.uuid); await expect(foreground).resolves.toMatchObject({ success: true });
    expect(display).toHaveBeenCalledWith('Your task is scheduled.');
    const next = executor.execute('Here is additional information for future occurrences');
    expect(lastUser().message.content).toBe('Here is additional information for future occurrences');
    expect(raw.sessionId).toBe('original-native-session');
    expect(wire.filter(row => row.type === 'control_request' && row.request.subtype === 'initialize')).toHaveLength(1);
    result(lastUser().uuid); await next; await scope.close();
  });

  it('isolates idle scheduled output and completion from a later foreground request without replaying history', async () => {
    const job = await reserve();
    frame({ type: 'command_lifecycle', state: 'started', wakeup_source: 'schedule_wakeup', command_uuid: 'occurrence-a' });
    frame({ type: 'control_request', request_id: 'submit-a', request: { subtype: 'hook_callback', callback_id: SCHEDULE_HOOK,
      input: { hook_event_name: 'UserPromptSubmit', source: 'schedule_wakeup', prompt: job.action.input.prompt } } });
    expect(executor.isBusy()).toBe(true);
    const onStream = vi.fn(); let foregroundDone = false;
    const next = executor.execute('A later user message', { onStream }).then(value => { foregroundDone = true; return value; });
    expect(lastUser()).toBeUndefined();
    frame({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Scheduled response' }] } });
    frame({ type: 'result', uuid: 'scheduled-result', is_error: false, terminal_reason: 'completed', result: 'Scheduled response' });
    await Promise.resolve(); expect(foregroundDone).toBe(false); expect(onStream).not.toHaveBeenCalled();
    frame({ type: 'command_lifecycle', state: 'completed', command_uuid: 'occurrence-a' });
    expect(lastUser().message.content).toBe('A later user message');
    frame({ type: 'result', uuid: 'scheduled-result', is_error: false, terminal_reason: 'completed', result: 'Duplicate' });
    await Promise.resolve(); expect(foregroundDone).toBe(false);
    expect(job.events).toHaveBeenCalledWith(expect.objectContaining({ type: 'completed', output: 'Scheduled response' }));
    result(lastUser().uuid); await next;
  });

  it('queues a card cancellation behind foreground work without rejecting it when that earlier turn ends', async () => {
    const started = vi.spyOn(claudeCodeHooks, 'notifyTaskStarted');
    const completed = vi.spyOn(claudeCodeHooks, 'notifyTaskCompleted');
    const job = await reserve(); const foreground = executor.execute('Continue the original task'); const firstId = lastUser().uuid;
    const cancel = executor.withNativeScheduleOperation('card-action', () => true, () => job.handle.cancel(), false);
    await Promise.resolve(); await Promise.resolve();
    expect(nativeTools).toHaveLength(0);
    result(firstId); await foreground; await cancel;
    expect(nativeTools).toEqual(['CronDelete']); expect(raw.sessionId).toBe('original-native-session');
    expect(started).toHaveBeenCalledOnce(); expect(completed).toHaveBeenCalledOnce();
    await job.handle.stop(); expect(raw.claudeProcess).not.toBeNull();
  });

  it('uses the native foreground lifecycle for a local result without a user-message join', async () => {
    await reserve();
    const foreground = executor.execute('Synthetic local-command request'); const id = lastUser().uuid;
    frame({ type: 'command_lifecycle', command_uuid: id, state: 'started' });
    frame({ type: 'result', uuid: 'local-result', is_error: false, result: 'Local native result' });
    frame({ type: 'command_lifecycle', command_uuid: id, state: 'completed' });
    await expect(foreground).resolves.toMatchObject({ success: true });
  });

  it('reconciles an owned job only on the existing idle host without initialization or recreation', async () => {
    const job = await reserve();
    const host = raw.claudeProcess;
    const start = vi.spyOn(raw, 'startProcess');
    const catalog = vi.spyOn(executor, 'listModels');
    await executor.reconcileNativeSchedule('cleanup', () => true, () => job.handle.cancel());
    expect(nativeTools).toEqual(['CronDelete']);
    expect(raw.claudeProcess).toBe(host);
    expect(start).not.toHaveBeenCalled(); expect(catalog).not.toHaveBeenCalled();
    await executor.reconcileNativeSchedule('cleanup-again', () => true, () => job.handle.cancel());
    expect(nativeTools).toEqual(['CronDelete']);
    await job.handle.stop();
    expect(raw.sessionSchedules.hasJobs).toBe(false);
    expect(raw.scheduleCleanupHost).toBeUndefined();
  });

  it('rejects a missing native action at foreground completion instead of deadlocking operation drain', async () => {
    const foreground = executor.execute('Request a schedule but omit its native action');
    const pending = executor.withNativeScheduleOperation('missing', () => true, () => executor.createNativeSchedule({
      id: 'missing', cwd: root, prompt: 'Synthetic', rule: { kind: 'cron', expression: '* * * * *', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    }, vi.fn()), true);
    const failure = expect(pending).rejects.toThrow('ended');
    await vi.waitFor(() => expect(executor.nativeScheduleAction('missing')).toBeDefined());
    result(lastUser().uuid); await foreground; await failure;
    expect(raw.sessionSchedules.hasJobs).toBe(false);
  });

  it('does not reserve jobs, start model management, or change native identity for ordinary turns', async () => {
    const foreground = executor.execute('Ordinary chat'); result(lastUser().uuid); await foreground;
    expect(raw.sessionSchedules.hasJobs).toBe(false); expect(nativeTools).toHaveLength(0);
    expect(raw.sessionId).toBe('original-native-session');
  });

  it('drops a queued management turn whose authorization expired without sending another native prompt', async () => {
    const foreground = executor.execute('Ordinary work remains in progress'); const id = lastUser().uuid;
    let current = true;
    const queued = executor.execute('Perform this authorized native schedule operation\n{}', {
      nativeScheduleManagement: true, nativeScheduleCurrent: () => current,
    });
    current = false; result(id); await foreground;
    await expect(queued).resolves.toMatchObject({ success: false, error: expect.stringContaining('expired') });
    expect(wire.filter(row => row.type === 'user')).toHaveLength(1); expect(nativeTools).toHaveLength(0);
  });

  it('rejects native creation for restricted sandboxes and managed child workers', async () => {
    const input: NativeScheduleInput = { id: 'rejected', cwd: root, prompt: 'Synthetic',
      rule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' } };
    vi.spyOn(raw.sandbox, 'isRestricted').mockReturnValue(true);
    await expect(executor.createNativeSchedule(input, vi.fn())).rejects.toThrow('sandbox');
    vi.spyOn(raw.sandbox, 'isRestricted').mockReturnValue(false); raw.delegationWorker = true;
    await expect(executor.withNativeScheduleOperation('worker', () => true, async () => {}, true)).rejects.toThrow('owner');
    await expect(executor.createNativeSchedule(input, vi.fn())).rejects.toThrow('sandbox');
    raw.delegationWorker = false; expect(nativeTools).toHaveLength(0);
  });

  it('uses the effective native timezone without exposing unrelated native settings', async () => {
    nativeSettings = { effective: { env: { TZ: 'Pacific/Auckland', SYNTHETIC_PRIVATE: 'do-not-forward-fixture' } }, sources: [] };
    const input: NativeScheduleInput = { id: 'timezone', cwd: root, prompt: 'Synthetic',
      rule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' } };
    await expect(executor.withNativeScheduleOperation('timezone', () => true,
      () => executor.createNativeSchedule(input, vi.fn()), true)).rejects.toThrow('Pacific/Auckland');
    expect(executor.nativeScheduleAction('timezone')).toBeUndefined();
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('do-not-forward-fixture'));
    nativeSettings = {};
    await expect(executor.createNativeSchedule(input, vi.fn())).rejects.toThrow('timezone could not be verified');
    nativeSettings = { effective: { disableAllHooks: true } };
    await expect(executor.createNativeSchedule(input, vi.fn())).rejects.toThrow('active SDK callback hooks');
    expect(nativeTools).toHaveLength(0);
  });

  it('fails closed when native hook policy rejects the resumed ownership guard', async () => {
    raw.delegation = { groups: ['scheduling'] };
    raw.scheduleHooksReady = false;
    nativeSettings = { effective: { disableAllHooks: true }, sources: [] };
    await expect(raw.performControlInitialization()).rejects.toThrow('active SDK callback hooks');
    expect(raw.scheduleHooksReady).toBe(false);
  });
});
