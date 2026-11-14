import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
vi.mock('child_process', () => ({ spawn: vi.fn(), exec: vi.fn(), execFile: vi.fn(), spawnSync: vi.fn() }));
import { ClaudePersistentExecutor } from '../src/executor/ClaudePersistentExecutor';
import { DirectoryGuard } from '../src/security/DirectoryGuard';
import { MessageHandler } from '../src/client/MessageHandler';
import { ThreadExecutorPool } from '../src/thread/ThreadExecutorPool';
import { ThreadContextReset } from '../src/thread/ThreadContextReset';
import { AutomaticUpdater } from '../src/update/AutomaticUpdater';
import { ScheduleService } from '../src/scheduling/ScheduleService';
import { SCHEDULE_HOOK } from '../src/scheduling/claude/ClaudeSessionSchedules';

const owner = { threadId: 'fixture-thread', openId: 'fixture-owner', generation: 'fixture-generation' };
let root: string, executor: ClaudePersistentExecutor, raw: any, service: ScheduleService;
let child: any, hosts: any[], inventory: Map<string, string>, deliver: any, serial: number;
let onCreate: undefined | (() => Promise<void>);
let modelReply: any;
let modelReplyType: 'success' | 'error' | 'missing';
let background: string[], closeCode: number, withholdClose: boolean, errorAfterCreate: boolean, failCleanup: boolean;
const frame = (value: object, host = child) => host.stdout.emit('data', Buffer.from(JSON.stringify(value) + '\n'));
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const terminal = (id: string) => {
  frame({ type: 'result', uuid: `result-${++serial}`, user_message_uuid: id, user_message_uuids: [id], is_error: false, terminal_reason: 'completed', result: 'Synthetic result' });
  frame({ type: 'command_lifecycle', command_uuid: id, state: 'completed' });
};
function spawnFixture() {
  const host: any = Object.assign(new EventEmitter(), { pid: 4000 + hosts.length, killed: false,
    stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(() => { host.emit('close', null, 'SIGTERM'); return true; }) });
  hosts.push(host); child = host;
  host.stdin = { writable: true, end: vi.fn(() => { if (!withholdClose) queueMicrotask(() => host.emit('close', closeCode, null)); }),
    write: vi.fn((line: string, done?: () => void) => {
      const packet = JSON.parse(line);
      queueMicrotask(async () => {
        if (packet.type === 'control_request') {
          if (packet.request.subtype === 'set_model') {
            if (modelReplyType !== 'missing') frame({ type: 'control_response', response: {
              request_id: packet.request_id, subtype: modelReplyType, response: modelReply,
              ...(modelReplyType === 'error' && { error: 'Synthetic refusal', error_code: 'not_found', model: 'synthetic-other' }),
            } }, host);
            return;
          }
          const response = packet.request.subtype === 'initialize'
            ? { claude_code_version: '2.1.311', pid: host.pid, models: [{ value: 'synthetic-model' }] }
            : { effective: { env: { TZ: 'UTC' } } };
          frame({ type: 'control_response', response: { request_id: packet.request_id, subtype: 'success', response } }, host);
          if (packet.request.subtype === 'initialize') {
            frame({ type: 'system', subtype: 'init', session_id: 'synthetic-original-session', model: 'synthetic-model',
              tools: ['CronCreate', 'CronList', 'CronDelete'], capabilities: ['interrupt_receipt_v1', 'msg_lifecycle_v1', 'lifecycle_wakeup_source_v1'] }, host);
            frame({ type: 'system', subtype: 'background_tasks_changed', tasks: background.map(task_id => ({ task_id })) }, host);
          }
        } else if (packet.type === 'user') {
          frame({ type: 'command_lifecycle', command_uuid: packet.uuid, state: 'started' }, host);
          const action = raw.sessionSchedules?.pending?.action;
          if (action) {
            const id = `tool-${++serial}`;
            frame({ type: 'control_request', request_id: id, request: { subtype: 'hook_callback', callback_id: SCHEDULE_HOOK,
              tool_use_id: id, input: { hook_event_name: 'PreToolUse', tool_name: action.tool, tool_input: action.input } } }, host);
            const reply = JSON.parse(host.stdin.write.mock.calls.at(-1)[0]);
            expect(reply.response.response).toEqual({});
            let content: string;
            if (action.tool === 'CronCreate') {
              inventory.set(id, action.input.prompt);
              await onCreate?.();
              content = `Scheduled ${action.input.recurring ? 'recurring job' : 'one-shot task'} ${id} (fixture). Next run: later. Session-only (not written to disk, dies when Claude exits).`;
            } else if (action.tool === 'CronDelete') { if (!failCleanup) inventory.delete(action.input.id); content = `Cancelled job ${action.input.id}.`; }
            else content = inventory.size ? [...inventory].map(([key, prompt]) => `${key} — ${prompt.split('\n')[0]} [session-only]`).join('\n') : 'No scheduled jobs.';
            frame({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content,
              is_error: action.tool === 'CronCreate' && errorAfterCreate || action.tool === 'CronDelete' && failCleanup }] } }, host);
          }
          terminal(packet.uuid);
        }
      });
      done?.(); return true;
    }) };
  return host;
}
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'claude-recovery-')));
  vi.spyOn(os, 'homedir').mockReturnValue(root); vi.stubEnv('HOME', root); vi.stubEnv('USERPROFILE', root);
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux'); vi.spyOn(process, 'arch', 'get').mockReturnValue('x64');
  for (const name of ['log', 'warn', 'error'] as const) vi.spyOn(console, name).mockImplementation(() => {});
  onCreate = undefined;
  modelReply = { model: 'synthetic-model' }; modelReplyType = 'success';
  hosts = []; inventory = new Map(); background = []; serial = 0; closeCode = 0; withholdClose = false; errorAfterCreate = false; failCleanup = false;
  vi.mocked(spawn).mockImplementation(spawnFixture as any);
  executor = new ClaudePersistentExecutor(new DirectoryGuard([root]), root, owner.threadId, 'synthetic-model', undefined, 'synthetic-native');
  raw = executor; deliver = vi.fn();
  service = new ScheduleService({ directory: path.join(root, 'catalog'), now: () => Date.now(), canRecover: () => true, isOwnerCurrent: () => true,
    provider: { recoveryFor: () => executor.nativeScheduleRecovery, create: (input, emit) => executor.createNativeSchedule(input, emit) }, deliver });
  await service.initialize(); await executor.listModels();
});
afterEach(async () => {
  withholdClose = false; failCleanup = false;
  await executor.destroy(); await Promise.allSettled([service.destroy()]);
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});
async function create(id = 'first', once = false) {
  return executor.withNativeScheduleOperation(id, () => true, () => service.create(owner, { id, backend: 'claude', threadId: owner.threadId,
    cwd: root, prompt: 'Synthetic future work', rule: once ? { kind: 'once', at: new Date(Math.ceil((Date.now() + 120000) / 60000) * 60000).toISOString() }
      : { kind: 'cron', expression: '* * * * *', timezone: 'UTC' } }), false);
}
async function drain() { for (let i = 0; i < 10; i++) await tick(); }
function wake(id: string, prompt: string) {
  frame({ type: 'command_lifecycle', command_uuid: id, wakeup_source: 'schedule_wakeup', state: 'started' });
  frame({ type: 'control_request', request_id: id, request: { subtype: 'hook_callback', callback_id: SCHEDULE_HOOK,
    input: { hook_event_name: 'UserPromptSubmit', source: 'schedule_wakeup', prompt } } });
}
describe('Claude production orderly recovery', () => {
  it.each([[false, false], [true, false], [false, true]])('uses real handler and updater after installation (failure=%s, skippedOnce=%s)', async (fails, skippedOnce) => {
    const thread: any = { id: owner.threadId, name: 'Synthetic', workingDirectory: root, delegation: false };
    const manager: any = { contextResets: new ThreadContextReset(path.join(root, 'resets')),
      getThread: () => thread, getDefaultThread: () => thread, listThreads: () => [thread],
      updateThread: vi.fn(async (_id, fields) => Object.assign(thread, fields)) };
    const guard = new DirectoryGuard([root]);
    const pool = new ThreadExecutorPool(manager, guard, { type: 'claude-persistent' }, () => executor);
    const ws: any = { send: vi.fn(), isConnected: () => true, hasPendingTaskResults: () => false,
      trackTask: vi.fn(), onClose: () => () => {}, onTaskResultAck: () => () => {} };
    const config: any = { get: (key: string) => key === 'executor' ? { type: 'claude-persistent' } : undefined,
      getConfigDir: () => path.join(root, 'handler-config'), getSharedSymlinks: () => [] };
    const handler = new MessageHandler(ws, pool, manager, guard, config);
    vi.spyOn(handler as any, 'detectBackends').mockResolvedValue([{ id: 'auto', label: 'Claude', installed: true }]);
    vi.spyOn((handler as any).delegation.registry, 'list').mockResolvedValue([]);
    const install = vi.fn(async () => {
      expect(raw.claudeProcess).toBeNull(); expect(inventory.size).toBe(0);
      if (fails) throw new Error('Synthetic installer unavailable');
    });
    const updater = new AutomaticUpdater('1.6.237', handler, { installVersion: install, restartAfterUpdate: false });
    try {
      await handler.handleMessage({ type: 'binding_confirm', data: { success: true,
        capabilities: { scheduleResultsV1: true, taskRecovery: true } } } as any);
      await handler.handleMessage({ type: 'command', threadId: thread.id, messageId: 'synthetic-create', openId: owner.openId,
        content: skippedOnce ? '/schedule after 5m -- Synthetic reminder' : '/schedule cron "* * * * *" --tz UTC -- Synthetic reminder', isSlashCommand: true, timestamp: Date.now() } as any);
      const record = (await (handler as any).schedules.list((handler as any).scheduleOwners.get(thread.id)))[0];
      expect(record.state).toBe('active');
      const old = child;
      if (skippedOnce) inventory.clear();
      await updater.handleRouterVersion('1.6.238');
      expect(install).toHaveBeenCalledOnce();
      expect((await (handler as any).schedules.list((handler as any).scheduleOwners.get(thread.id)))[0].state).toBe(skippedOnce ? 'interrupted' : 'active');
      expect((handler as any).automaticUpdateInProgress).toBe(false);
      expect(old.kill).not.toHaveBeenCalled();
      expect((await executor.execute('Synthetic next foreground')).success).toBe(true);
      expect(child).not.toBe(old);
    } finally {
      clearTimeout((updater as any).retryTimer);
      await handler.destroy();
    }
  });

  it('persists stable identity, releases two jobs once and restores on the original session without user input', async () => {
    await create(); await create('second');
    const records = await service.list(owner); const firstMarker = JSON.parse(records[0].recovery!.identity).marker;
    const old = child;
    await service.suspendForRestart();
    expect(old.stdin.end).toHaveBeenCalledTimes(1); expect(old.kill).not.toHaveBeenCalled(); expect(inventory.size).toBe(0);
    expect((await service.list(owner)).every(r => r.recovery?.handoff === 'clean')).toBe(true);
    await service.recover();
    expect(hosts).toHaveLength(2); expect(inventory.size).toBe(2);
    expect((await service.list(owner)).every(r => r.state === 'active')).toBe(true);
    expect([...inventory.values()].some(p => p.includes(firstMarker))).toBe(true);
    const restored = child; expect((await executor.execute('Synthetic next turn')).success).toBe(true);
    expect(child).toBe(restored); expect(executor.getSessionId()).toBe('synthetic-original-session');
  });
  it('blocks pending prompt admission without delivering a successful result', async () => {
    await create(); const prompt = [...inventory.values()][0];
    raw.schedules().beginRestart(); wake('pending-occurrence', prompt);
    const response = JSON.parse(child.stdin.write.mock.calls.at(-1)[0]); expect(response.response.response.decision).toBe('block');
    frame({ type: 'result', uuid: 'skipped-result', is_error: false, terminal_reason: 'completed', result: 'Not executed' });
    frame({ type: 'command_lifecycle', command_uuid: 'pending-occurrence', state: 'completed' }); await drain();
    expect(deliver).not.toHaveBeenCalled();
    expect((await service.list(owner))[0].completedOccurrences).toContain('pending-occurrence');
    expect((await service.list(owner))[0].skippedOccurrences).toEqual(['pending-occurrence']);
    await service.suspendForRestart();
  });
  it('pins the resolved default model on restore without changing the saved model preference', async () => {
    raw.model = undefined;
    await create(); await service.suspendForRestart(); await service.recover();
    const controls = child.stdin.write.mock.calls.map(([line]: [string]) => JSON.parse(line))
      .filter((packet: any) => packet.type === 'control_request' && packet.request.subtype === 'set_model');
    expect(controls).toHaveLength(1);
    expect(controls[0].request.model).toBe('synthetic-model');
    expect(raw.model).toBeUndefined();
    expect(executor.getExecutionMetadata().model).toBe('synthetic-model');
    expect((await service.list(owner))[0].state).toBe('active');
  });
  it.each([undefined, {}, { model: 'synthetic-other' }, { model: '' }, { model: 42 }])(
    'rejects an unconfirmed restored model receipt (%j) before recreating jobs', async reply => {
      raw.model = undefined;
      await create(); await service.suspendForRestart();
      modelReply = reply;
      await service.recover();
      expect((await service.list(owner))[0].recovery?.status).toBe('blocked');
      expect(inventory.size).toBe(0);
      expect(raw.acknowledgedModel).not.toBe('synthetic-model');
      expect((await executor.execute('Must stay fenced')).success).toBe(false);
    });
  it.each(['error', 'missing'] as const)('keeps a %s restored model reply fenced and does not replay CREATE', async replyType => {
    raw.model = undefined;
    await create(); await service.suspendForRestart(); modelReplyType = replyType;
    const originalTimer = global.setTimeout;
    vi.spyOn(global, 'setTimeout').mockImplementation(((callback: any, delay: any, ...args: any[]) =>
      originalTimer(callback, delay === 10000 ? 20 : delay, ...args)) as any);
    await service.recover();
    expect((await service.list(owner))[0].recovery?.status).toBe('blocked');
    expect(inventory.size).toBe(0);
    await service.recover(); expect(inventory.size).toBe(0);
    if (replyType === 'missing') {
      const request = child.stdin.write.mock.calls.map(([line]: [string]) => JSON.parse(line))
        .find((packet: any) => packet.request?.subtype === 'set_model');
      frame({ type: 'control_response', response: { request_id: request.request_id, subtype: 'success', response: { model: 'synthetic-model' } } });
      await drain();
      expect((await service.list(owner))[0].recovery?.status).toBe('blocked');
      expect(inventory.size).toBe(0);
    }
    expect((await executor.execute('Must stay fenced')).success).toBe(false);
  });
  it('defers updater admission for admitted work and waits for background completion without killing', async () => {
    await create(); wake('active-occurrence', [...inventory.values()][0]); await drain();
    expect(service.canSuspendForRestart()).toBe(false); expect(child.kill).not.toHaveBeenCalled();
    frame({ type: 'result', uuid: 'active-result', is_error: false, terminal_reason: 'completed', result: 'Completed' });
    frame({ type: 'command_lifecycle', command_uuid: 'active-occurrence', state: 'completed' }); await vi.waitFor(() => expect(service.canSuspendForRestart()).toBe(true));
    background = ['owned-background']; const old = child;
    const handoff = service.suspendForRestart(); await drain();
    expect(old.stdin.end).not.toHaveBeenCalled(); expect(old.kill).not.toHaveBeenCalled();
    background = []; frame({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    await handoff; expect(old.stdin.end).toHaveBeenCalledTimes(1);
  });
  it('does not let another recovered job cleanup release a later unresolved restoration fence', async () => {
    raw.model = undefined;
    await create(); await create('second'); await service.suspendForRestart();
    onCreate = async () => { modelReplyType = 'missing'; onCreate = undefined; };
    const originalTimer = global.setTimeout;
    vi.spyOn(global, 'setTimeout').mockImplementation(((callback: any, delay: any, ...args: any[]) =>
      originalTimer(callback, delay === 10000 ? 20 : delay, ...args)) as any);
    await service.recover();
    expect((await service.list(owner)).find(record => record.id === 'second')!.recovery?.status).toBe('blocked');
    expect((await executor.execute('Before cleanup')).success).toBe(false);
    await service.cancel(owner, 'first');
    expect((await executor.execute('After unrelated cleanup')).success).toBe(false);
  });
  it('retains an error-after-commit restore handle and never automatically duplicates creation', async () => {
    await create(); await service.suspendForRestart(); errorAfterCreate = true; failCleanup = true;
    await service.recover(); const count = inventory.size;
    expect((await service.list(owner))[0].recovery?.status).toBe('blocked'); expect(count).toBe(1);
    await service.recover(); expect(inventory.size).toBe(count);
  });
  it('retains cleanup ownership when inspection throws after native recreation succeeded', async () => {
    await create(); await service.suspendForRestart(); failCleanup = true;
    await executor.listModels();
    const adapter = raw.schedules();
    const createNative = adapter.create.bind(adapter);
    vi.spyOn(adapter, 'create').mockImplementation(async (...args: any[]) => {
      const handle = await createNative(...args);
      vi.spyOn(raw.turnLedger, 'supported').mockImplementationOnce(() => { throw new Error('Synthetic post-create inspection failure'); });
      return handle;
    });
    await service.recover();
    expect(inventory.size).toBe(1);
    expect((service as any).runtimes.get('first').handle).toBeDefined();
    failCleanup = false;
    await service.cancel(owner, 'first');
    expect(inventory.size).toBe(0);
  });
  it('persists cancellation during restore before the late CREATE receipt and deletes only that owned job', async () => {
    await create(); await service.suspendForRestart();
    let cancellation: Promise<unknown> | undefined;
    onCreate = async () => {
      onCreate = undefined;
      cancellation = service.cancel(owner, 'first'); void cancellation.catch(() => {});
      await (service as any).tail;
      expect((await service.list(owner))[0].cancelRequested).toBe(true);
    };
    await service.recover(); await expect(cancellation).rejects.toThrow('receipt is unresolved');
    await service.cancel(owner, 'first');
    expect(inventory.size).toBe(0);
    expect((await service.list(owner))[0].state).toBe('cancelled');
    await service.recover(); expect(hosts).toHaveLength(2);
  });

  it('refuses identity changes and does not start a new host after explicit reset', async () => {
    await create(); await service.suspendForRestart(); executor.resetContext(); await drain();
    await service.recover(); expect(hosts).toHaveLength(1);
    expect((await service.list(owner))[0].state).toBe('interrupted');
  });
  it('refuses unowned native definitions without deleting them or closing the host', async () => {
    await create(); inventory.set('foreign-native-job', '[synthetic-unmanaged]\nForeign reminder');
    await expect(service.suspendForRestart()).rejects.toThrow('Unmanaged');
    expect(inventory.size).toBe(2); expect(child.stdin.end).not.toHaveBeenCalled(); expect(child.kill).not.toHaveBeenCalled();
    expect((await executor.execute('Conflicting successor')).success).toBe(false);
  });
  it('keeps absolute one-shot deadlines and expires them without a late CREATE', async () => {
    await create('once', true); const first = (await service.list(owner))[0];
    await service.suspendForRestart();
    const deadline = Date.parse((first.rule as { at: string }).at);
    vi.spyOn(Date, 'now').mockReturnValue(deadline + 1);
    await service.recover(); const record = (await service.list(owner))[0];
    expect(record.rule).toEqual(first.rule); expect(record.state).toBe('interrupted');
    expect(record.error).toContain('expired'); expect(hosts).toHaveLength(1); expect(inventory.size).toBe(0);
    expect((await executor.execute('Synthetic next turn after expiration')).success).toBe(true);
    expect(inventory.size).toBe(0);
  });
  it('does not reconstruct an unseen one-shot already absent in native inventory, even before its deadline', async () => {
    await create('once', true); inventory.clear();
    await service.suspendForRestart(); await service.recover();
    const record = (await service.list(owner))[0];
    expect(record.state).toBe('interrupted'); expect(record.error).toContain('already absent');
    expect(record.recovery).toBeUndefined(); expect(record.completedOccurrences ?? []).toEqual([]);
    expect(hosts).toHaveLength(1); expect(deliver).not.toHaveBeenCalled();
    expect((await executor.execute('Synthetic next turn after skipped one-shot')).success).toBe(true);
    expect(inventory.size).toBe(0);
  });
  it('keeps a one-shot skipped before admission terminal without a successful delivery or resurrection', async () => {
    await create('once', true); const prompt = [...inventory.values()][0];
    const original = raw.schedules().beginRestart.bind(raw.schedules());
    vi.spyOn(raw.schedules(), 'beginRestart').mockImplementation(() => {
      original(); wake('skipped-once', prompt);
      frame({ type: 'result', uuid: 'skipped-once-result', is_error: false, terminal_reason: 'completed', result: 'Not executed' });
      frame({ type: 'command_lifecycle', command_uuid: 'skipped-once', state: 'completed' });
    });
    await service.suspendForRestart(); await service.recover();
    const record = (await service.list(owner))[0]; expect(record.state).toBe('interrupted');
    expect(record.error).toContain('skipped'); expect(record.recovery).toBeUndefined();
    expect(deliver).not.toHaveBeenCalled(); expect(hosts).toHaveLength(1);
  });
  it('keeps the host and upgrade fenced when native background quiescence is unconfirmed', async () => {
    await create(); background = ['synthetic-background'];
    const nativeWait = raw.turnLedger.wait.bind(raw.turnLedger);
    vi.spyOn(raw.turnLedger, 'wait').mockImplementation((check: any, ms: any, label: any) =>
      label === 'Native background drain' ? Promise.reject(new Error('Synthetic background timeout')) : nativeWait(check, ms, label));
    await expect(service.suspendForRestart()).rejects.toThrow('background timeout');
    expect(child.stdin.end).not.toHaveBeenCalled(); expect(child.kill).not.toHaveBeenCalled();
    expect((await service.list(owner))[0].recovery?.handoff).toBeUndefined();
    expect((await executor.setModel('synthetic-other')).success).toBe(false);
  });
  it('does not certify an EOF timeout and retains the exact late exit separately', async () => {
    await create(); withholdClose = true;
    const originalTimer = global.setTimeout;
    vi.spyOn(global, 'setTimeout').mockImplementation(((callback: any, delay: any, ...args: any[]) =>
      originalTimer(callback, delay === 20000 ? 25 : delay, ...args)) as any);
    await expect(service.suspendForRestart()).rejects.toThrow('exit remains unconfirmed');
    expect(child.kill).not.toHaveBeenCalled(); expect(raw.claudeProcess).toBe(child);
    expect((await service.list(owner))[0].recovery?.handoff).toBeUndefined();
    child.emit('close', 0, null);
    expect(raw.scheduleRestart.exit.code).toBe(0);
    await service.recover(); expect(hosts).toHaveLength(1);
  });
  it('gates recovery by native version, platform and restricted execution mode', async () => {
    raw.turnLedger.version = 'unsupported-build'; expect(executor.nativeScheduleRecovery).toBeUndefined();
    raw.turnLedger.version = '2.1.311';
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32'); expect(executor.nativeScheduleRecovery).toBeUndefined();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.spyOn(raw.sandbox, 'isRestricted').mockReturnValue(true); expect(executor.nativeScheduleRecovery).toBeUndefined();
  });

  it('fails closed on a nonzero exit and does not publish a clean checkpoint', async () => {
    await create(); closeCode = 2;
    await expect(service.suspendForRestart()).rejects.toThrow('exit');
    expect((await service.list(owner))[0].recovery?.handoff).toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
  });
});
