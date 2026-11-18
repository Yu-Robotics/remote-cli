import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { ClaudePersistentExecutor } from '../src/executor/ClaudePersistentExecutor';
import { DirectoryGuard } from '../src/security/DirectoryGuard';
import { ScheduleToolOperations } from '../src/scheduling/ScheduleToolScope';
import { SCHEDULE_HOOK } from '../src/scheduling/claude/ClaudeSessionSchedules';
import { NativeScheduleCleanupError, NativeScheduleNotAdmittedError, type NativeScheduleInput } from '../src/scheduling/types';
import { ScheduleService, SCHEDULE_CATALOG_FILE } from '../src/scheduling/ScheduleService';
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
  async function reserve(id = 'job-a') {
    const input: NativeScheduleInput = { id, cwd: root, prompt: 'Use the latest conversation state',
      rule: { kind: 'cron', expression: '* * * * *', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } };
    const events = vi.fn();
    const pending = executor.withNativeScheduleOperation(id, () => true, () => executor.createNativeSchedule(input, events), true);
    await vi.waitFor(() => expect(executor.nativeScheduleAction(id)).toBeDefined());
    const action = executor.nativeScheduleAction(id)!;
    hook(action, `tool-${id}`); receipt(created(`native-${id}`), `tool-${id}`);
    const handle = await pending;
    raw.sessionSchedules.foregroundEnded();
    return { handle, action, events };
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
    const restricted = executor.createNativeSchedule(input, vi.fn());
    await expect(restricted).rejects.toThrow('sandbox');
    await expect(restricted).rejects.toBeInstanceOf(NativeScheduleNotAdmittedError);
    vi.spyOn(raw.sandbox, 'isRestricted').mockReturnValue(false); raw.delegationWorker = true;
    await expect(executor.withNativeScheduleOperation('worker', () => true, async () => {}, true)).rejects.toThrow('owner');
    const worker = executor.createNativeSchedule(input, vi.fn());
    await expect(worker).rejects.toThrow('sandbox');
    await expect(worker).rejects.toBeInstanceOf(NativeScheduleNotAdmittedError);
    raw.delegationWorker = false; expect(nativeTools).toHaveLength(0);
  });

  it.each(['modelChange', 'isDestroyed', 'isStopping', 'hooks', 'cwd', 'protocol', 'ownership', 'model-race'])(
    'refuses %s before calling the session adapter or admitting an occurrence', async reason => {
      const input: NativeScheduleInput = { id: 'refused', cwd: root, prompt: 'Synthetic',
        rule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' } };
      const create = vi.spyOn(raw.sessionSchedules, 'create');
      const admit = vi.fn(() => true); const events = vi.fn();
      const original = { modelChange: raw.modelChange,
        isDestroyed: raw.isDestroyed, isStopping: raw.isStopping, scheduleHooksReady: raw.scheduleHooksReady };
      if (['modelChange', 'isDestroyed', 'isStopping'].includes(reason)) raw[reason] = true;
      if (reason === 'hooks') raw.scheduleHooksReady = false;
      if (reason === 'cwd') input.cwd = path.join(root, 'different-directory');
      if (reason === 'protocol' || reason === 'ownership') {
        input.recovery = { version: 1, provider: 'fixture', strategy: 'reconstruct', identity: '{}' };
        vi.spyOn(raw.turnLedger, 'supported').mockReturnValue(reason === 'ownership');
        if (reason === 'ownership') vi.spyOn(raw, 'scheduleHostOwnership').mockReturnValue({
          reserve: () => { throw new Error('Synthetic ownership reservation refused'); },
        });
      }
      if (reason === 'model-race') vi.spyOn(raw, 'readNativeScheduleTimezone').mockImplementation(async () => {
        raw.modelChange = true; return 'UTC';
      });
      try {
        await expect(executor.createNativeSchedule(input, events, () => true, admit)).rejects.toBeInstanceOf(NativeScheduleNotAdmittedError);
        expect(create).not.toHaveBeenCalled(); expect(admit).not.toHaveBeenCalled(); expect(events).not.toHaveBeenCalled();
        expect(nativeTools).toEqual([]); expect(wire.filter(row => row.type === 'user')).toEqual([]);
      } finally { Object.assign(raw, original); }
    });

  it.each(['unavailable', 'write-throw', 'write-callback', 'timeout', 'host-changed'])(
    'classifies %s timezone preflight failure as never admitted', async reason => {
      vi.useFakeTimers();
      const child = raw.claudeProcess;
      const create = vi.spyOn(raw.sessionSchedules, 'create');
      if (reason === 'unavailable') child.stdin.writable = false;
      else child.stdin.write.mockImplementation((line: string, callback?: (error?: Error) => void) => {
        if (reason === 'write-throw') throw new Error('Synthetic settings write failed');
        if (reason === 'write-callback') callback?.(new Error('Synthetic settings write failed'));
        if (reason === 'host-changed') {
          raw.claudeProcess = { ...child };
          raw.pendingControlRequests.get(JSON.parse(line).request_id).resolve(nativeSettings);
        }
        return true;
      });
      try {
        const failure = executor.createNativeSchedule({ id: 'timezone-refused', cwd: root, prompt: 'Synthetic',
          rule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' } }, vi.fn()).catch(error => error);
        if (reason === 'timeout') await vi.advanceTimersByTimeAsync(10_001);
        expect(await failure).toBeInstanceOf(NativeScheduleNotAdmittedError);
        expect(create).not.toHaveBeenCalled(); expect(raw.pendingControlRequests.size).toBe(0);
        expect(nativeTools).toEqual([]);
      } finally { raw.claudeProcess = child; child.stdin.writable = true; vi.useRealTimers(); }
    });

  it.each(['timezone', 'missing-tools'])('automatically compacts a %s refusal without native cleanup', async reason => {
    if (reason === 'timezone') nativeSettings = {};
    else frame({ type: 'system', subtype: 'init', session_id: 'original-native-session',
      tools: ['ToolSearch'], capabilities: ['msg_lifecycle_v1', 'lifecycle_wakeup_source_v1'] });
    const directory = path.join(root, 'synthetic-schedule-catalog');
    const options = { directory, provider: { create: (input: NativeScheduleInput, emit: any, admit?: () => boolean) =>
      executor.createNativeSchedule(input, emit, undefined, admit) }, deliver: vi.fn(async () => {}), isOwnerCurrent: () => true };
    const owner = { threadId: 'synthetic-thread', openId: 'synthetic-owner', generation: 'epoch' };
    const service = new ScheduleService(options);
    let restored: ScheduleService | undefined;
    const create = vi.spyOn(raw.sessionSchedules, 'create');
    const timezone = vi.spyOn(raw, 'readNativeScheduleTimezone');
    try {
      await service.initialize();
      await expect(service.create(owner, { id: 'timezone-refused', cwd: root, prompt: 'Synthetic',
        rule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' } })).rejects.toBeInstanceOf(NativeScheduleNotAdmittedError);
      if (reason === 'missing-tools') expect(timezone).not.toHaveBeenCalled();
      expect(await service.list(owner)).toEqual([]);
      await service.destroy();
      restored = new ScheduleService(options); await restored.initialize();
      expect(await restored.purge(owner, { ids: ['timezone-refused'] })).toMatchObject({
        removedIds: [], alreadyRemovedIds: ['timezone-refused'], nativeCleanupUnresolved: [], errors: [],
      });
      expect(await restored.listCleanup(owner)).toEqual([]);
      const catalog = JSON.parse(await fs.readFile(path.join(directory, SCHEDULE_CATALOG_FILE), 'utf8'));
      expect(catalog.records).toEqual([]); expect(catalog.cleanup ?? []).toEqual([]);
      expect(create).not.toHaveBeenCalled(); expect(nativeTools).toEqual([]);
    } finally { await restored?.destroy(); await service.destroy(); }
  });

  it('removes a fresh timezone mismatch from the catalog without issuing Cron tools', async () => {
    nativeSettings = { effective: { env: { TZ: 'Pacific/Auckland' } } };
    const directory = path.join(root, 'timezone-mismatch-catalog');
    const owner = { threadId: 'synthetic-thread', openId: 'synthetic-owner', generation: 'epoch' };
    const service = new ScheduleService({ directory, provider: { create: (input, emit, admit) =>
      executor.createNativeSchedule(input, emit, undefined, admit) }, deliver: vi.fn(async () => {}), isOwnerCurrent: () => true });
    try {
      await service.initialize();
      await expect(service.create(owner, { id: 'timezone-mismatch', cwd: root, prompt: 'Synthetic',
        rule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' } })).rejects.toThrow('native session timezone');
      expect(await service.list(owner)).toEqual([]); expect(nativeTools).toEqual([]);
      const catalog = JSON.parse(await fs.readFile(path.join(directory, SCHEDULE_CATALOG_FILE), 'utf8'));
      expect(catalog.purged).toEqual([{ id: 'timezone-mismatch', ...owner }]);
      expect(catalog.cleanup ?? []).toEqual([]);
    } finally { await service.destroy(); }
  });

  it('preserves uncertain adapter creation errors and their original cleanup handle', async () => {
    const handle = { nativeId: 'unconfirmed-synthetic', list: vi.fn(), cancel: vi.fn(), stop: vi.fn() };
    const failure = new NativeScheduleCleanupError('Synthetic mutation without a receipt', handle);
    const create = vi.spyOn(raw.sessionSchedules, 'create').mockRejectedValueOnce(failure);
    await expect(executor.createNativeSchedule({ id: 'uncertain', cwd: root, prompt: 'Synthetic',
      rule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' } }, vi.fn())).rejects.toBe(failure);
    expect(create).toHaveBeenCalledOnce(); expect(failure.handle).toBe(handle);
    expect(failure).not.toBeInstanceOf(NativeScheduleNotAdmittedError);
  });

  it('uses the effective native timezone without exposing unrelated native settings', async () => {
    nativeSettings = { effective: { env: { TZ: 'Pacific/Auckland', SYNTHETIC_PRIVATE: 'do-not-forward-fixture' } }, sources: [] };
    const input: NativeScheduleInput = { id: 'timezone', cwd: root, prompt: 'Synthetic',
      rule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' } };
    await expect(executor.withNativeScheduleOperation('timezone', () => true,
      () => executor.createNativeSchedule(input, vi.fn()), true)).rejects.toMatchObject({
      constructor: NativeScheduleNotAdmittedError, message: expect.stringContaining('Pacific/Auckland'),
    });
    expect(executor.nativeScheduleAction('timezone')).toBeUndefined();
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('do-not-forward-fixture'));
    nativeSettings = {};
    const unverified = executor.createNativeSchedule(input, vi.fn());
    await expect(unverified).rejects.toThrow('timezone could not be verified');
    await expect(unverified).rejects.toBeInstanceOf(NativeScheduleNotAdmittedError);
    nativeSettings = { effective: { disableAllHooks: true } };
    await expect(executor.createNativeSchedule(input, vi.fn())).rejects.toMatchObject({
      constructor: NativeScheduleNotAdmittedError, message: expect.stringContaining('active SDK callback hooks'),
    });
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
