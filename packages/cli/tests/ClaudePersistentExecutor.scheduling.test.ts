import { legacyClaudeJob } from './scheduling/legacyClaudeJob';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { ClaudePersistentExecutor } from '../src/executor/ClaudePersistentExecutor';
import { DirectoryGuard } from '../src/security/DirectoryGuard';
import { ScheduleToolOperations } from '../src/scheduling/ScheduleToolScope';
import { SCHEDULE_HOOK } from '../src/scheduling/claude/ClaudeSessionSchedules';
import { ScheduleService } from '../src/scheduling/ScheduleService';
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

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'claude-shared-session-')));
    vi.spyOn(os, 'homedir').mockReturnValue(root);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    executor = new ClaudePersistentExecutor(new DirectoryGuard([root]), root, 'synthetic-thread');
    raw = executor as any; wire = []; nativeTools = []; nativeSettings = { effective: { env: {} }, sources: [] };
    vi.spyOn(raw, 'startProcessImpl').mockImplementation(async () => {
      if (!raw.claudeProcess) throw new Error('Unexpected native process launch in synthetic test');
    });
    raw.sessionId = 'original-native-session';
    // This fixture injects the resumed host instead of executing startProcess.
    raw.scheduleGuardRequired = true;
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
    // The injected host starts with an explicit synthetic MCP caller turn.
    raw.sessionSchedules.foregroundDispatched('synthetic-tool-turn');
  });
  afterEach(async () => {
    raw.sessionSchedules?.processClosed();
    raw.claudeProcess = null;
    await executor.destroy();
    vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true });
  });
  it('pins host-timed dispatch and blocks absent or divergent native submit identities', async () => {
    const id = 'original-native-session';
    executor.checkHostScheduleSession(id);
    const active = executor.execute('timed foreground', { hostScheduleSessionId: id });
    executor.checkHostScheduleSession(id);
    for (const session_id of [undefined, 'other', id]) {
      frame({ type: 'control_request', request_id: 'submit', request: { subtype: 'hook_callback', callback_id: SCHEDULE_HOOK,
        input: { hook_event_name: 'UserPromptSubmit', session_id, prompt: 'timed foreground' } } });
      expect(wire.at(-1).response.response.decision).toBe(session_id === id ? undefined : 'block');
    }
    expect(nativeTools).toEqual([]); result(lastUser().uuid); await active;
    frame({ type: 'system', subtype: 'init', session_id: 'other' });
    expect(() => executor.checkHostScheduleSession(id)).toThrow();
    await expect(executor.execute('refused', { hostScheduleSessionId: id })).resolves.toMatchObject({ success: false });
    expect(lastUser().message.content).toBe('timed foreground');
  });
  it('dispatches with verified hooks even when native Cron and its timezone are unavailable', async () => {
    const id = 'original-native-session';
    raw.clearCatalogCache();
    raw.scheduleHooksReady = false;
    raw.sessionSchedules.cronDisabledAtStartup();
    nativeSettings = { effective: { env: { TZ: 'fixture-invalid-timezone' } } };
    frame({ type: 'system', subtype: 'init', session_id: id, tools: [], capabilities: [] });
    wire.length = 0;
    const active = executor.execute('timed task', { hostScheduleSessionId: id });
    await vi.waitFor(() => expect(lastUser()?.message.content).toBe('timed task'));
    expect(wire.filter(row => row.type === 'control_request').map(row => row.request.subtype))
      .toEqual(['initialize', 'get_settings']);
    expect(wire.filter(row => row.type === 'user')).toHaveLength(1);
    result(lastUser().uuid);
    await expect(active).resolves.toMatchObject({ success: true });
  });
  it('verifies hook policy before pinned dispatch on a previously initialized ordinary host', async () => {
    raw.scheduleGuardRequired = false;
    nativeSettings = { effective: { allowManagedHooksOnly: true } };
    const stopped = vi.spyOn(raw, 'stopProcess').mockResolvedValue(undefined);
    await expect(executor.execute('refused timed task', { hostScheduleSessionId: 'original-native-session' }))
      .resolves.toMatchObject({ success: false });
    expect(stopped).toHaveBeenCalledOnce();
    expect(lastUser()).toBeUndefined();
  });
  it('refuses pinned dispatch if a cached catalog cannot establish callback registration', async () => {
    raw.scheduleHooksReady = false;
    const stopped = vi.spyOn(raw, 'stopProcess').mockResolvedValue(undefined);
    await expect(executor.execute('unverified task', { hostScheduleSessionId: 'original-native-session' }))
      .resolves.toMatchObject({ success: false });
    expect(stopped).toHaveBeenCalledOnce();
    expect(lastUser()).toBeUndefined();
  });
  it('retains the original pointer if a pinned Claude turn observes a different initialized session', async () => {
    const id = 'original-native-session';
    const stop = vi.spyOn(raw, 'stopProcess').mockResolvedValue(undefined);
    const active = executor.execute('timed foreground', { hostScheduleSessionId: id });
    frame({ type: 'system', subtype: 'init', session_id: 'unexpected-session' });
    await expect(active).rejects.toThrow('different conversation');
    expect(stop).toHaveBeenCalledOnce(); expect(executor.getSessionId()).toBe(id);
    expect(JSON.parse(await fs.readFile(raw.sessionFilePath, 'utf8')).id).toBe(id);
  });
  it('combines predecessor proof with current native work and host validity for purge', async () => {
    raw.delegation = { groups: ['scheduling'] };
    const ownership = raw.scheduleHostOwnership();
    ownership.dependencies.processes = () => [{ pid: 4242, birth: 'fixture-birth', command: 'fixture-claude' }];
    ownership.reserveForNewJob(4242, 'fixture-claude');
    await executor.withReviewedNativeCleanup('purge-proof', () => true, async host => {
      expect(host.cwd).toBe(root); expect(host.retirementConfirmed?.()).toBe(true);
      raw.sessionSchedules.submitted = { synthetic: true };
      expect(host.retirementConfirmed?.()).toBe(false); raw.sessionSchedules.submitted = undefined;
      raw.sessionSchedules.scope.mutations.add('synthetic-mutation');
      expect(host.retirementConfirmed?.()).toBe(true); raw.sessionSchedules.scope.mutations.clear();
      raw.sessionSchedules.authorized.set('unsettled', { action: { tool: 'CronDelete' } });
      expect(host.retirementConfirmed?.()).toBe(false); raw.sessionSchedules.authorized.clear();
      raw.sessionSchedules.jobs.set('uncertain', { retired: false, uncertain: true });
      expect(host.retirementConfirmed?.()).toBe(false); raw.sessionSchedules.jobs.clear();
      raw.sessionSchedules.pending = { synthetic: true };
      expect(host.retirementConfirmed?.()).toBe(false); raw.sessionSchedules.pending = undefined;
      expect(host.retirementConfirmed?.()).toBe(true);
      raw.stopEpoch++; expect(host.retirementConfirmed?.()).toBe(false);
    }, true);
  });
  it('leases reviewed cleanup on the bound host without creating ownership proof or admitting ordinary work', async () => {
    raw.delegation = { url: 'http://127.0.0.1:1/', token: 'synthetic', groups: ['scheduling'] };
    const definition = { id: 'legacy', prompt: 'Synthetic legacy', cron: '* * * * *', durable: false };
    const inventory = vi.spyOn(raw.sessionSchedules, 'reviewedInventory').mockResolvedValue([definition]);
    const remove = vi.spyOn(raw.sessionSchedules, 'reviewedDelete').mockResolvedValue(undefined);
    let binding = '';
    await executor.withReviewedNativeCleanup('review', () => true, async host => {
      binding = host.binding; expect(host.current()).toBe(true); expect(host.sessionId).toBe('original-native-session');
      expect(await host.inventory()).toEqual([definition]); await host.remove(definition);
      expect((await executor.execute('Unrelated ordinary work')).success).toBe(false);
      await expect(executor.withReviewedNativeCleanup('concurrent', () => true, async () => {})).rejects.toThrow('busy');
    });
    expect(inventory).toHaveBeenCalledOnce(); expect(remove).toHaveBeenCalledOnce();
    expect(raw.reviewedCleanupActive).toBe(false); expect(raw.scheduleCleanupHost).toBeUndefined();
    expect(raw.scheduleOwnership.exists()).toBe(false);
    await executor.withReviewedNativeCleanup('again', () => true, async host => {
      expect(host.binding).toBe(binding);
      raw.stopEpoch++; expect(host.current()).toBe(false);
    }, true);
    await executor.withReviewedNativeCleanup('epoch', () => true, async host => expect(host.binding).not.toBe(binding), true);
    const child = raw.claudeProcess;
    raw.claudeProcess = { ...child };
    await executor.withReviewedNativeCleanup('replacement', () => true, async host => expect(host.binding).not.toBe(binding), true);
  });
  it('rejects missing session, retired owner and failed cleanup exclusion without leaking admission', async () => {
    raw.delegation = { groups: ['scheduling'] };
    raw.sessionId = null;
    await expect(executor.withReviewedNativeCleanup('review', () => true, async () => {})).rejects.toThrow('No bound');
    raw.sessionId = 'original-native-session';
    await expect(executor.withReviewedNativeCleanup('review', () => false, async () => {})).rejects.toThrow('unavailable');
    const ownership = raw.scheduleHostOwnership();
    const locked = vi.spyOn(ownership, 'reviewedRemovalLease').mockImplementation(() => { throw new Error('Locked'); });
    await expect(executor.withReviewedNativeCleanup('review', () => true, async () => {})).rejects.toThrow('Locked');
    expect(raw.reviewedCleanupActive).toBe(false); locked.mockRestore();
    await expect(executor.withReviewedNativeCleanup('review', () => true, async () => { throw new Error('Operation failed'); }, true)).rejects.toThrow('Operation failed');
    expect(raw.reviewedCleanupActive).toBe(false);
    raw.scheduleHooksReady = false;
    await expect(executor.withReviewedNativeCleanup('review', () => true, async () => {}, true)).rejects.toThrow('changed during');
  });
  function reserve(id = 'job-a') {
    raw.sessionSchedules.foregroundEnded();
    return legacyClaudeJob(raw.sessionSchedules, id, 'native-' + id);
  }

  it('creates a host schedule in the MCP caller turn and preserves subsequent user turns and session identity', async () => {
    const service = new ScheduleService({ directory: path.join(root, 'schedules'),
      hostDispatch: vi.fn(), deliver: vi.fn(), isOwnerCurrent: () => true, now: () => Date.UTC(2026, 0, 1) });
    await service.initialize();
    const display = vi.fn();
    const foreground = executor.execute('Create a recurring task from this conversation', { onDisplayText: display });
    const first = lastUser(); const present = vi.fn(async () => 'Original-thread card delivered');
    const owner = { openId: 'synthetic-owner', threadId: 'synthetic-thread', generation: 'epoch-a', bindingEpoch: 'synthetic-binding' };
    let admit!: () => void;
    const admission = new Promise<void>(resolve => { admit = resolve; });
    const nativeAction = vi.spyOn(executor, 'nativeScheduleAction');
    const scope = new ScheduleToolOperations().scope({ owner, messageId: 'message-a', backend: 'claude', current: () => true, waitMs: 1,
      nativeAction: id => executor.nativeScheduleAction(id),
      run: async (command, id) => {
        if (command.kind !== 'create') throw new Error('Expected host schedule creation');
        const sessionId = executor.getSessionId()!;
        executor.checkHostScheduleSession(sessionId);
        await admission;
        return [await service.create(owner, { engine: 'host', backend: 'claude', bindingEpoch: owner.bindingEpoch,
          sessionId, id, cwd: root, rule: command.rule, prompt: command.prompt })];
      }, present });
    const args = { requestId: 'request-a', prompt: 'Use our latest discussion', when: { kind: 'cron', expression: '* * * * *', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } };
    try {
      const accepted: any = await scope.invoke('remote_cli_schedule_create', args);
      expect(accepted).toMatchObject({ status: 'pending', scheduleId: expect.any(String) });
      expect(accepted).not.toHaveProperty('nativeAction');
      expect(await scope.invoke('remote_cli_schedule_create', args)).toEqual(accepted);
      admit(); await scope.drain();
      const completed = await scope.invoke('remote_cli_schedule_operation', { requestId: 'request-a' });
      expect(completed).toMatchObject({ status: 'succeeded', records: [{ id: accepted.scheduleId, state: 'active' }] });
      expect(completed).not.toHaveProperty('nativeAction');
      expect(await service.list(owner)).toMatchObject([{ id: accepted.scheduleId, engine: 'host', sessionId: 'original-native-session' }]);
      expect(nativeAction).not.toHaveBeenCalled();
      expect(wire.filter(row => row.type === 'user')).toHaveLength(1);
      expect(present).toHaveBeenCalledOnce();
      frame({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Your task is scheduled.' }] } });
      result(first.uuid); await expect(foreground).resolves.toMatchObject({ success: true });
      expect(display).toHaveBeenCalledWith('Your task is scheduled.');
      const next = executor.execute('Here is additional information for future occurrences');
      expect(lastUser().message.content).toBe('Here is additional information for future occurrences');
      expect(executor.getSessionId()).toBe('original-native-session');
      expect(wire.filter(row => row.type === 'control_request' && row.request.subtype === 'initialize')).toHaveLength(1);
      result(lastUser().uuid); await next;
    } finally {
      if (raw.isProcessing) result(lastUser().uuid);
      admit(); await scope.close(); await service.destroy();
    }
  });

  it('isolates idle scheduled output and completion from a later foreground request without replaying history', async () => {
    const job = await reserve();
    frame({ type: 'command_lifecycle', state: 'started', wakeup_source: 'schedule_wakeup', command_uuid: 'occurrence-a' });
    frame({ type: 'control_request', request_id: 'submit-a', request: { subtype: 'hook_callback', callback_id: SCHEDULE_HOOK,
      input: { hook_event_name: 'UserPromptSubmit', source: 'schedule_wakeup', prompt: job.prompt } } });
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

  it('does not reserve jobs, start model management, or change native identity for ordinary turns', async () => {
    const foreground = executor.execute('Ordinary chat'); result(lastUser().uuid); await foreground;
    expect(raw.sessionSchedules.hasJobs).toBe(false); expect(nativeTools).toHaveLength(0);
    expect(raw.sessionId).toBe('original-native-session');
  });

  it('expires an unacknowledged inventory request when its foreground turn ends', async () => {
    const foreground = executor.execute('Review existing native timers');
    const pending = executor.withNativeScheduleOperation('inventory', () => true,
      () => raw.sessionSchedules.reviewedInventory(() => true), true);
    const failure = expect(pending).rejects.toThrow('ended');
    await vi.waitFor(() => expect(executor.nativeScheduleAction('inventory')).toEqual({ tool: 'CronList', input: {} }));
    result(lastUser().uuid); await foreground; await failure;
    expect(executor.nativeScheduleAction('inventory')).toBeUndefined();
    expect(nativeTools).toEqual([]);
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

  it('denies unreserved CronCreate on a guarded foreground turn', () => {
    expect(executor).not.toHaveProperty('createNativeSchedule');
    hook({ tool: 'CronCreate', input: { cron: '* * * * *', prompt: 'Unmanaged' } }, 'unexpected');
    expect(wire.at(-1).response.response.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(raw.sessionSchedules.hasJobs).toBe(false);
  });

  it('fails closed when native hook policy rejects the resumed ownership guard', async () => {
    raw.delegation = { groups: ['scheduling'] };
    raw.scheduleHooksReady = false;
    nativeSettings = { effective: { disableAllHooks: true }, sources: [] };
    await expect(raw.performControlInitialization()).rejects.toThrow('active SDK callback hooks');
    expect(raw.scheduleHooksReady).toBe(false);
  });

  it('reads only the effective native timezone for retained cancellation', async () => {
    nativeSettings = { effective: { env: { TZ: 'Pacific/Auckland', SYNTHETIC_PRIVATE: 'do-not-forward-fixture' } } };
    await expect(raw.readNativeScheduleTimezone()).resolves.toBe('Pacific/Auckland');
    nativeSettings = {};
    await expect(raw.readNativeScheduleTimezone()).rejects.toThrow('timezone could not be verified');
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('do-not-forward-fixture'));
    expect(nativeTools).toEqual([]);
  });
});
