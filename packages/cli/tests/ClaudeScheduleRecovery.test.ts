import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import syncFs from 'node:fs';
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
import * as scheduleProcesses from '../src/scheduling/claude/ClaudeScheduleProcesses';
import * as ownershipRuntime from '../src/delegation/OwnershipRuntime';
import { SCHEDULE_HOOK } from '../src/scheduling/claude/ClaudeSessionSchedules';

const owner = { threadId: 'fixture-thread', openId: 'fixture-owner', generation: 'fixture-generation' };
const filesystemPlatform = process.platform;
const nativeFsync = syncFs.fsyncSync;
let persistencePlatforms: NodeJS.Platform[];
let root: string, executor: ClaudePersistentExecutor, raw: any, service: ScheduleService;
let child: any, hosts: any[], inventory: Map<string, string>, deliver: any, serial: number;
let onManagement: undefined | (() => Promise<void>);
let onCreate: undefined | (() => Promise<void>);
let modelReply: any;
let nativeVersion: string;
let boot: string;
let nativeCapabilities: string[];
let modelReplyType: 'success' | 'error' | 'missing';
let background: string[], closeCode: number, withholdClose: boolean, errorAfterCreate: boolean, failCleanup: boolean;
const frame = (value: object, host = child) => host.stdout.emit('data', Buffer.from(JSON.stringify(value) + '\n'));
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const terminal = (id: string, host = child) => {
  frame({ type: 'result', uuid: `result-${++serial}`, user_message_uuid: id, user_message_uuids: [id], is_error: false, terminal_reason: 'completed', result: 'Synthetic result' }, host);
  frame({ type: 'command_lifecycle', command_uuid: id, state: 'completed' }, host);
};
function spawnFixture() {
  const host: any = Object.assign(new EventEmitter(), { pid: 4000 + hosts.length, killed: false,
    stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(() => { host.emit('close', null, 'SIGTERM'); return true; }) });
  hosts.push(host); child = host;
  host.on('close', () => { host.closed = true; });
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
            ? { claude_code_version: nativeVersion, pid: host.pid, models: [{ value: 'synthetic-model' }] }
            : { effective: { env: { TZ: 'UTC' } } };
          frame({ type: 'control_response', response: { request_id: packet.request_id, subtype: 'success', response } }, host);
          if (packet.request.subtype === 'initialize') {
            frame({ type: 'system', subtype: 'init', session_id: 'synthetic-original-session', model: 'synthetic-model',
              tools: ['CronCreate', 'CronList', 'CronDelete'], capabilities: nativeCapabilities }, host);
            frame({ type: 'system', subtype: 'background_tasks_changed', tasks: background.map(task_id => ({ task_id })) }, host);
          }
        } else if (packet.type === 'user') {
          frame({ type: 'command_lifecycle', command_uuid: packet.uuid, state: 'started' }, host);
          const action = raw.sessionSchedules?.pending?.action;
          if (action) {
            await onManagement?.();
            if (host.closed) return;
            const id = `tool-${++serial}`;
            frame({ type: 'control_request', request_id: id, request: { subtype: 'hook_callback', callback_id: SCHEDULE_HOOK,
              tool_use_id: id, input: { hook_event_name: 'PreToolUse', tool_name: action.tool, tool_input: action.input } } }, host);
            const reply = JSON.parse(host.stdin.write.mock.calls.at(-1)[0]);
            if (reply.response.response.hookSpecificOutput?.permissionDecision === 'deny') { terminal(packet.uuid, host); return; }
            expect(reply.response.response).toEqual({});
            let content: string;
            if (action.tool === 'CronCreate') {
              inventory.set(id, action.input.prompt);
              await onCreate?.();
              content = `Scheduled ${action.input.recurring ? 'recurring job' : 'one-shot task'} ${id} (fixture). Next run: later. Session-only (not written to disk, dies when Claude exits).`;
            } else if (action.tool === 'CronDelete') { if (!failCleanup) inventory.delete(action.input.id); content = `Cancelled job ${action.input.id}.`; }
            else content = inventory.size ? [...inventory].map(([key, prompt]) => `${key} — * * * * * (recurring) [session-only]: ${prompt.split('\n')[0]}`).join('\n') : 'No scheduled jobs.';
            frame({ type: 'user', ...(action.tool === 'CronList' ? { tool_use_result: { jobs: [...inventory].map(([key, prompt]) => ({ id: key, prompt, cron: '* * * * *', recurring: true, durable: false })) } } : {}), message: { content: [{ type: 'tool_result', tool_use_id: id, content,
              is_error: action.tool === 'CronCreate' && errorAfterCreate || action.tool === 'CronDelete' && failCleanup }] } }, host);
          }
          terminal(packet.uuid, host);
        }
      });
      done?.(); return true;
    }) };
  return host;
}
beforeEach(async () => {
  persistencePlatforms = [];
  // Keep real persistence, and detect protocol platform mocks leaking into it.
  vi.spyOn(syncFs, 'fsyncSync').mockImplementation(fd => {
    persistencePlatforms.push(process.platform);
    return nativeFsync(fd);
  });
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'claude-recovery-')));
  vi.spyOn(os, 'homedir').mockReturnValue(root); vi.stubEnv('HOME', root); vi.stubEnv('USERPROFILE', root);
  for (const name of ['log', 'warn', 'error'] as const) vi.spyOn(console, name).mockImplementation(() => {});
  boot = 'fixture-boot';
  vi.spyOn(ownershipRuntime, 'bootIdentity').mockImplementation(() => ({ host: 'fixture-host', boot, namespace: 'fixture-pid-namespace' }));
  vi.spyOn(ownershipRuntime, 'kernelGate').mockReturnValue({ verify: () => {}, close: () => {} });
  onCreate = undefined; onManagement = undefined;
  nativeVersion = '2.1.311';
  nativeCapabilities = ['interrupt_receipt_v1', 'msg_lifecycle_v1', 'lifecycle_wakeup_source_v1'];
  modelReply = { model: 'synthetic-model' }; modelReplyType = 'success';
  hosts = []; inventory = new Map(); background = []; serial = 0; closeCode = 0; withholdClose = false; errorAfterCreate = false; failCleanup = false;
  vi.mocked(spawn).mockImplementation(spawnFixture as any);
  vi.spyOn(scheduleProcesses, 'scheduleProcesses').mockImplementation(() => hosts.filter(host => !host.closed).map(host => ({
    pid: host.pid, birth: String(host.pid), command: 'synthetic-native --resume synthetic-original-session' })));
  executor = new ClaudePersistentExecutor(new DirectoryGuard([root]), root, owner.threadId, 'synthetic-model', undefined, 'synthetic-native');
  raw = executor; deliver = vi.fn();
  service = new ScheduleService({ directory: path.join(root, 'catalog'), now: () => Date.now(), canRecover: () => true, isOwnerCurrent: () => true,
    provider: { recoveryFor: () => executor.nativeScheduleRecovery, create: (input, emit, admit) => executor.createNativeSchedule(input, emit, undefined, admit) }, deliver });
  await service.initialize(); await executor.listModels();
});
afterEach(async () => {
  const teardownPlatform = process.platform;
  withholdClose = false; failCleanup = false;
  await executor.destroy(); await Promise.allSettled([service.destroy()]);
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
  expect(teardownPlatform).toBe(filesystemPlatform);
  expect(persistencePlatforms.filter(platform => platform !== filesystemPlatform)).toEqual([]);
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
    let installationHostCount = 0;
    let installationWrites = 0;
    const install = vi.fn(async () => {
      expect(raw.claudeProcess).toBeNull(); expect(inventory.size).toBe(0);
      installationHostCount = hosts.length;
      installationWrites = hosts.reduce((count, host) => count + host.stdin.write.mock.calls.length, 0);
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
      expect((await (handler as any).schedules.list((handler as any).scheduleOwners.get(thread.id)))[0].state).toBe(fails || skippedOnce ? 'interrupted' : 'active');
      expect((handler as any).automaticUpdateInProgress).toBe(false);
      expect(old.kill).not.toHaveBeenCalled();
      if (fails) {
        // Installer failure must not start a model-mediated recovery to release
        // global admission. Exercise the dispatcher rather than bypassing its fence.
        await handler.handleMessage({ type: 'command', threadId: thread.id, messageId: 'synthetic-fenced',
          openId: owner.openId, content: 'Synthetic next foreground', isSlashCommand: false, timestamp: Date.now() } as any);
        expect(ws.send.mock.calls.map(([message]: any[]) => message).find((message: any) => message.messageId === 'synthetic-fenced')).toMatchObject({
          success: false, error: expect.stringContaining('remain fenced'),
        });
        expect(handler.tryBeginAutomaticUpdate()).toBe(false);
        await handler.handleMessage({ type: 'binding_confirm', data: { success: true,
          capabilities: { scheduleResultsV1: true, taskRecovery: true } } } as any);
        expect(hosts).toHaveLength(installationHostCount);
        expect(hosts.reduce((count, host) => count + host.stdin.write.mock.calls.length, 0)).toBe(installationWrites);
        expect(raw.claudeProcess).toBeNull();
        return;
      }
      expect((await executor.execute('Synthetic next foreground')).success).toBe(true);
      expect(child).not.toBe(old);
    } finally {
      clearTimeout((updater as any).retryTimer);
      await handler.destroy();
    }
  });

  async function abruptRestart(nextBoot: boolean, crashedCatalog?: string) {
    child.emit('close', null, 'SIGKILL'); await drain();
    await service.retryDeliveries();
    await executor.destroy();
    if (crashedCatalog) { await fs.writeFile((service as any).catalogPath, crashedCatalog); deliver.mockClear(); }
    if (nextBoot) boot = 'fixture-next-boot';
    executor = new ClaudePersistentExecutor(new DirectoryGuard([root]), root, owner.threadId, 'synthetic-model', undefined, 'synthetic-native');
    raw = executor;
    service = new ScheduleService({ directory: path.join(root, 'catalog'), isOwnerCurrent: () => true, canRecover: () => true,
      provider: { recoveryFor: () => executor.nativeScheduleRecovery, create: (input, emit, admit) => executor.createNativeSchedule(input, emit, undefined, admit) }, deliver });
    await service.initialize();
  }
  it.each([false, true])('uses production handler, native hooks and ownership proof for reviewed deletion then purge (retired=%s)', async retired => {
    await create(); await create('second');
    const target = [...inventory.keys()][0], sibling = [...inventory.keys()][1];
    const original = (await service.list(owner))[0];
    await abruptRestart(retired);
    const thread: any = { id: owner.threadId, name: 'Synthetic', workingDirectory: root, delegation: false };
    const manager: any = { contextResets: new ThreadContextReset(path.join(root, 'purge-resets')),
      getThread: () => thread, getDefaultThread: () => thread, listThreads: () => [thread],
      updateThread: vi.fn(async (_id, fields) => Object.assign(thread, fields)) };
    const guard = new DirectoryGuard([root]);
    const pool = new ThreadExecutorPool(manager, guard, { type: 'claude-persistent' }, () => executor);
    const ws: any = { send: vi.fn(), isConnected: () => true, hasPendingTaskResults: () => false,
      trackTask: vi.fn(), onClose: () => () => {}, onTaskResultAck: () => () => {} };
    const config: any = { get: (key: string) => key === 'executor' ? { type: 'claude-persistent' } : undefined,
      getConfigDir: () => path.join(root, 'purge-handler-config'), getSharedSymlinks: () => [] };
    const handler = new MessageHandler(ws, pool, manager, guard, config);
    vi.spyOn(handler as any, 'detectBackends').mockResolvedValue([{ id: 'auto', label: 'Claude', installed: true }]);
    vi.spyOn((handler as any).delegation.registry, 'list').mockResolvedValue([]);
    const directory = (handler as any).scheduleDirectory();
    const identity = JSON.parse(original.recovery!.identity);
    // Legacy attribution is sufficient for deletion/absence, but not execution recovery.
    delete identity.effectiveModel;
    const record = { ...original, generation: (handler as any).scheduleGeneration(thread.id), state: 'cancelled', cancelRequested: true,
      recovery: { ...original.recovery, identity: JSON.stringify(identity), status: 'blocked' } };
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'schedule-catalog.json'), JSON.stringify({ version: 3, records: [record], pending: [], purged: [] }));
    let sequence = 0;
    const send = (content: string) => handler.handleMessage({ type: 'command', threadId: thread.id, openId: owner.openId,
      messageId: `purge-${++sequence}`, content, isSlashCommand: true, timestamp: Date.now() } as any);
    const response = () => ws.send.mock.calls.map(([message]: any[]) => message).filter((message: any) => message.type === 'response').at(-1);
    try {
      await send('/schedule cleanup review');
      expect(response().success).toBe(true);
      const token = /cleanup confirm ([a-f0-9-]{36})/.exec(response().output)![1];
      await send(`/schedule cleanup confirm ${token} remove-original ${target}`);
      expect(response().success).toBe(true); expect([...inventory.keys()]).toEqual([sibling]);
      const deletionReceipt = JSON.parse(await fs.readFile(path.join(directory, 'schedule-catalog.json'), 'utf8')).records[0];
      expect(deletionReceipt.cleanupConfirmed === true).toBe(retired);
      await send('/schedule purge first');
      expect(response().success).toBe(retired);
      expect(response().output).toContain(retired ? 'Removed history: first.' : 'predecessor or admitted work is unconfirmed');
      expect([...inventory.keys()]).toEqual([sibling]);
      const catalog = JSON.parse(await fs.readFile(path.join(directory, 'schedule-catalog.json'), 'utf8'));
      expect(catalog.records).toHaveLength(0);
      expect(catalog.cleanup ?? []).toHaveLength(retired ? 0 : 1);
      if (!retired) expect(catalog.cleanup[0]).toMatchObject({ historyRemoved: true, reason: 'predecessor_unknown' });
      const actions = child.stdin.write.mock.calls.map(([line]: [string]) => JSON.parse(line)).filter((packet: any) => packet.type === 'user');
      expect(actions.every((packet: any) => !JSON.stringify(packet).includes('select:CronCreate'))).toBe(true);
    } finally { await handler.destroy(); }
  });

  it('adopts two exact native definitions after verified reboot without CREATE or DELETE', async () => {
    await create(); await create('second'); const ids = [...inventory.keys()];
    await abruptRestart(true); await service.recover();
    expect([...inventory.keys()]).toEqual(ids);
    expect((await service.list(owner)).every(record => record.state === 'active')).toBe(true);
    const actions = child.stdin.write.mock.calls.map(([line]: [string]) => JSON.parse(line)).filter((p: any) => p.type === 'user');
    expect(actions.every((p: any) => !JSON.stringify(p).includes('CronCreate') && !JSON.stringify(p).includes('CronDelete'))).toBe(true);
    expect(executor.getSessionId()).toBe('synthetic-original-session');
    const resumed = child;
    wake('future-after-reboot', [...inventory.values()][0]); terminal('future-after-reboot');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect((await executor.execute('Subsequent conversation')).success).toBe(true); expect(child).toBe(resumed);
  });
  it('does not recreate unexplained missing definitions after an unclean restart', async () => {
    await create(); await create('second'); const retained = [...inventory.keys()][1];
    inventory.delete([...inventory.keys()][0]);
    await abruptRestart(true); await service.recover();
    expect(inventory.size).toBe(1); expect(inventory.has(retained)).toBe(true);
    expect((await service.list(owner)).find(r => r.id === 'first')!.error).toContain('expiry or deletion');
    await service.recover(); expect(inventory.size).toBe(1);
    expect((await executor.execute('Foreground after confirmed absence')).success).toBe(true);
    wake('retained-after-absence', inventory.get(retained)!);
    frame({ type: 'result', uuid: 'retained-result', is_error: false, terminal_reason: 'completed', result: 'Future result' });
    frame({ type: 'command_lifecycle', command_uuid: 'retained-after-absence', state: 'completed' });
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
  });
  it.each([false, true])('preserves wakes after read errors and fences only explicit cleanup, preserving siblings (recovered=%s)', async recovered => {
    await create(); await create('second');
    if (recovered) { await abruptRestart(true); await service.recover(); }
    const [target, sibling] = [...inventory.values()];
    const handle = (service as any).runtimes.get('first').handle;
    const list = vi.spyOn(handle, 'list').mockRejectedValue(new Error('Synthetic inventory failure'));
    const stop = vi.spyOn(handle, 'stop').mockRejectedValue(new Error('Synthetic cleanup failure'));
    await expect(service.refresh(owner)).rejects.toThrow('Synthetic inventory failure');
    expect((await service.list(owner)).find(row => row.id === 'first')!.state).toBe('active');
    expect(stop).not.toHaveBeenCalled();
    wake('admitted-after-read-error', target);
    expect(JSON.parse(child.stdin.write.mock.calls.at(-1)[0]).response.response).toEqual({});
    terminal('admitted-after-read-error');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    await service.recordReviewedCleanup(owner, ['first'], false);
    expect((await service.list(owner)).find(row => row.id === 'first')!.state).toBe('interrupted');
    expect(stop).not.toHaveBeenCalled();
    wake('blocked-after-interruption', target);
    expect(JSON.parse(child.stdin.write.mock.calls.at(-1)[0]).response.response.decision).toBe('block');
    terminal('blocked-after-interruption'); await drain();
    expect(deliver).toHaveBeenCalledTimes(1);
    wake('sibling-still-admitted', sibling);
    expect(JSON.parse(child.stdin.write.mock.calls.at(-1)[0]).response.response).toEqual({});
    terminal('sibling-still-admitted');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    expect(inventory.size).toBe(2);
    list.mockRestore(); stop.mockRestore();
  });
  it.each([false, true])('quarantines a refused restore and admits new explicit work in the original session and boot (legacy=%s)', async legacy => {
    if (legacy) {
      const ownership = raw.scheduleHostOwnership();
      vi.spyOn(ownership, 'reserveForNewJob').mockImplementationOnce(() => ownership.reserve(true));
    }
    await create(); const original = executor.getSessionId();
    await abruptRestart(false); await service.recover();
    expect((await executor.execute('Continue the original conversation')).success).toBe(true);
    raw.delegation = { groups: ['scheduling'] };
    await executor.withReviewedNativeCleanup('cleanup', () => true, async session => {
      for (const definition of await session.inventory()) await session.remove(definition);
    });
    expect(inventory.size).toBe(0);
    raw.delegation = undefined;
    expect((await create('new-explicit-job')).state).toBe('active');
    expect((await service.list(owner))[0]).toMatchObject({ state: 'failed', recovery: { status: 'blocked' } });
    expect(service.hasUnresolvedRecovery()).toBe(false);
    expect(executor.getSessionId()).toBe(original);
    expect(boot).toBe('fixture-boot');
  });

  it.each([false, true])('binds clean recovery and retained cancellation to the new owner after dirty rearm (recover=%s)', async recover => {
    const ownership = raw.scheduleHostOwnership();
    vi.spyOn(ownership, 'reserveForNewJob').mockImplementationOnce(() => ownership.reserve(true));
    const old = await create();
    const oldIdentity = JSON.parse(old.recovery!.identity);
    await abruptRestart(false); await service.recover();
    await executor.execute('Continue the original session');
    raw.delegation = { groups: ['scheduling'] };
    await executor.withReviewedNativeCleanup('remove-old-definition', () => true, async host => {
      for (const entry of await host.inventory()) await host.remove(entry);
    });
    raw.delegation = undefined;
    const fresh = await create('new-owner-job');
    const freshIdentity = JSON.parse(fresh.recovery!.identity);
    expect(freshIdentity.ownerToken).toMatch(/^[a-f0-9-]{36}$/);
    expect(freshIdentity.ownerToken).not.toBe(oldIdentity.ownerToken);
    const filename = raw.scheduleHostOwnership().filename;
    const archives = (await fs.readdir(path.dirname(filename))).filter(name => name.includes('.retired-'));
    expect(archives).toHaveLength(1);
    const archive = path.join(path.dirname(filename), archives[0]);
    const diagnostic = await fs.readFile(archive, 'utf8');
    expect(JSON.parse(diagnostic).clean).toBe(false);
    await service.suspendForRestart();
    await service.destroy(); await executor.destroy();
    executor = new ClaudePersistentExecutor(new DirectoryGuard([root]), root, owner.threadId, 'synthetic-model', undefined, 'synthetic-native');
    raw = executor;
    service = new ScheduleService({ directory: path.join(root, 'catalog'), canRecover: () => true, isOwnerCurrent: () => true,
      provider: { recoveryFor: () => executor.nativeScheduleRecovery,
        create: (input, emit, admit) => executor.createNativeSchedule(input, emit, undefined, admit) }, deliver });
    await service.initialize();
    if (recover) {
      await service.recover();
      expect((await service.list(owner)).map(record => record.state)).toEqual(['failed', 'active']);
      expect(JSON.parse((await service.list(owner))[1].recovery!.identity).ownerToken).toBe(freshIdentity.ownerToken);
      await service.suspendForRestart();
    }
    raw.effort = 'high'; // Fail synchronous preflight before any native admission.
    const spawnCount = hosts.length;
    await service.recover();
    expect(hosts).toHaveLength(spawnCount);
    expect((await service.list(owner))[1].state).toBe('failed');
    raw.effort = undefined;
    await executor.listModels();
    raw.delegation = { groups: ['scheduling'] };
    await executor.withReviewedNativeCleanup('check-owner-proof', () => true, async host => {
      expect(await host.inventory()).toEqual([]);
      expect(host.retirementConfirmed?.(freshIdentity.ownerToken)).toBe(true);
      expect(host.retirementConfirmed?.(oldIdentity.ownerToken)).toBe(false);
      expect(host.retirementConfirmed?.()).toBe(false);
    });
    raw.delegation = undefined;
    await executor.withNativeScheduleOperation('cancel-new', () => true,
      async () => expect(await service.cancel(owner, fresh.id)).toMatchObject({ state: 'cancelled' }), false);
    await expect(executor.withNativeScheduleOperation('cancel-old', () => true,
      () => service.cancel(owner, old.id), false)).rejects.toThrow('predecessor work remains unconfirmed');
    expect(inventory.size).toBe(0);
    expect(await fs.readFile(archive, 'utf8')).toBe(diagnostic);
    expect(JSON.parse(await fs.readFile(filename, 'utf8')).predecessorUncertain).toBe(true);
    expect(executor.getSessionId()).toBe('synthetic-original-session');
    await service.recover();
    expect((await service.list(owner)).map(record => record.state)).toEqual(['failed', 'cancelled']);
  });

  it('records creation refusal for a live native owner and admits a later explicit request after its exit', async () => {
    const inventoryProbe = vi.mocked(scheduleProcesses.scheduleProcesses);
    const normal = inventoryProbe.getMockImplementation()!;
    inventoryProbe.mockImplementation(() => [...normal(), { pid: 9001, birth: 'other', command: 'synthetic-native --resume synthetic-original-session' }]);
    await expect(create('refused')).rejects.toThrow('Another native host');
    expect((await service.list(owner))[0]).toMatchObject({ state: 'failed', creationRefused: true });
    expect(inventory.size).toBe(0);
    inventoryProbe.mockImplementation(normal);
    expect((await create('explicit-after-exit')).state).toBe('active');
    expect(executor.getSessionId()).toBe('synthetic-original-session');
  });

  it.each([[false, false], [true, false], [true, true]])('settles a no-handle timeout through public chat and new scheduling (late terminal=%s, sibling=%s)', (lateTerminal, sibling) => {
    return (async () => {
      const session = executor.getSessionId();
      const thread: any = { id: owner.threadId, name: 'Synthetic', workingDirectory: root, delegation: false };
      const manager: any = { contextResets: new ThreadContextReset(path.join(root, 'timeout-resets')),
        getThread: () => thread, getDefaultThread: () => thread, listThreads: () => [thread],
        updateThread: vi.fn(async (_id, fields) => Object.assign(thread, fields)) };
      const guard = new DirectoryGuard([root]);
      const pool = new ThreadExecutorPool(manager, guard, { type: 'claude-persistent' }, () => executor);
      const ws: any = { send: vi.fn(), isConnected: () => true, hasPendingTaskResults: () => false,
        trackTask: vi.fn(), onClose: () => () => {}, onTaskResultAck: () => () => {} };
      const config: any = { get: (key: string) => key === 'executor' ? { type: 'claude-persistent' } : undefined,
        getConfigDir: () => path.join(root, 'timeout-handler'), getSharedSymlinks: () => [] };
      const handler = new MessageHandler(ws, pool, manager, guard, config);
      const state = handler as any;
      state.schedules = service; state.scheduleInitialization = Promise.resolve(service); state.scheduleResultsSupported = true;
      vi.spyOn(state, 'detectBackends').mockResolvedValue([{ id: 'auto', label: 'Claude', installed: true }]);
      vi.spyOn(state.delegation.registry, 'list').mockResolvedValue([]);
      (service as any).options.recoveryTimeoutMs = 20;
      (service as any).options.acquireRecovery = () => {
        if (state.scheduleRecoveryThreads.has(thread.id)) throw new Error('Recovery thread admission unavailable.');
        state.scheduleRecoveryThreads.add(thread.id);
        return () => state.scheduleRecoveryThreads.delete(thread.id);
      };
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let recoveryHost: typeof child;
      const originalTimer = global.setTimeout;
      vi.spyOn(global, 'setTimeout').mockImplementation(((callback: any, delay: any, ...args: any[]) =>
        originalTimer(callback, delay === 60_000 ? 100 : delay, ...args)) as any);
      let sequence = 0;
      const send = (content: string) => handler.handleMessage({ type: 'command', threadId: thread.id, openId: owner.openId,
        messageId: `timeout-${++sequence}`, content, isSlashCommand: content.startsWith('/'), timestamp: Date.now() } as any);
      const response = () => ws.send.mock.calls.map(([message]: any[]) => message).filter((message: any) => message.type === 'response').at(-1);
      try {
        await send('Initialize synthetic managed tools'); expect(response().success).toBe(true);
        await create(); if (sibling) await create('second');
        await service.suspendForRestart(); await executor.listModels();
        recoveryHost = child;
        onManagement = () => raw.sessionSchedules?.scope?.id === 'restore-first' ? gate : Promise.resolve();
        await service.recover();
        expect((await service.list(owner))[0]).toMatchObject({ state: 'failed', recovery: { status: 'blocked' } });
        if (sibling) {
          expect((await service.list(owner))[1]).toMatchObject({ state: 'interrupted',
            recovery: { status: 'pending', handoff: 'clean', nativeDefinitionAbsent: true } });
          expect(inventory.size).toBe(0);
        }
        await send('Before settlement'); expect(response().success).toBe(false);
        expect(response().openId).toBe(owner.openId);
        if (lateTerminal) release();
        await vi.waitFor(() => expect(state.scheduleRecoveryThreads.size).toBe(0));
        if (sibling) {
          await vi.waitFor(async () => expect((await service.list(owner))[1].state).toBe('active'));
          expect((await service.list(owner))[0].state).toBe('failed');
        }
        onManagement = undefined;
        await send('Continue the original conversation'); expect(response().success, JSON.stringify(response())).toBe(true);
        expect(executor.getSessionId()).toBe(session);
        expect(service.hasUnresolvedRecovery()).toBe(false);
        if (sibling) {
          expect((await service.list(owner)).map(record => record.state)).toEqual(['failed', 'active']);
          wake('recovered-untouched-sibling', [...inventory.values()][0]); terminal('recovered-untouched-sibling');
          await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
          await service.recover();
          expect((await service.list(owner))[0].state).toBe('failed');
          expect(child).toBe(recoveryHost);
          return;
        }
        expect(service.canSuspendForRestart()).toBe(true);
        expect(service.requiresShutdownHandoff()).toBe(false);
        expect(handler.tryBeginAutomaticUpdate()).toBe(true);
        await handler.prepareAutomaticUpdate(); await handler.endAutomaticUpdate();
        await send('/schedule cleanup review'); expect(response().success).toBe(true);
        expect(inventory.size).toBe(0);
        await send('/schedule cron "* * * * *" --tz UTC -- New explicit work');
        expect(response().success).toBe(true);
        expect(inventory.size).toBe(1); expect(executor.getSessionId()).toBe(session);
        expect(boot).toBe('fixture-boot');
        if (recoveryHost !== child) {
          recoveryHost.emit('close', null, 'SIGTERM');
          expect(raw.claudeProcess).toBe(child); expect(state.scheduleRecoveryThreads.size).toBe(0);
          await send('Continue after the stale host callback'); expect(response().success).toBe(true);
          expect(inventory.size).toBe(1);
        }
      } finally { onManagement = undefined; release(); await executor.destroy(); await drain(); await handler.destroy(); }
    })();
  });

  it('joins a late management terminal without recycling a healthy sibling host', async () => {
    await create(); await create('second'); await service.suspendForRestart(); await executor.listModels();
    // Establish the healthy sibling before applying the short failure deadline.
    // Coverage and concurrent filesystem work must not time out that first job.
    (service as any).options.recoveryTimeoutMs = 2000;
    onCreate = async () => { (service as any).options.recoveryTimeoutMs = 20; onCreate = undefined; };
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    onManagement = () => raw.sessionSchedules?.scope?.id === 'restore-second' ? gate : Promise.resolve();
    const originalTimer = global.setTimeout;
    vi.spyOn(global, 'setTimeout').mockImplementation(((callback: any, delay: any, ...args: any[]) =>
      originalTimer(callback, delay === 60_000 ? 100 : delay, ...args)) as any);
    const originalHost = child;
    try {
      await service.recover();
      await new Promise(resolve => originalTimer(resolve, 150));
      expect(originalHost.stdin.end).not.toHaveBeenCalled(); expect(originalHost.kill).not.toHaveBeenCalled();
      expect((await executor.execute('Wait for the exact management turn')).success).toBe(false);
      release(); await vi.waitFor(() => expect(service.hasUnresolvedRecovery()).toBe(false));
      expect((await service.list(owner)).map(record => record.state)).toEqual(['active', 'failed']);
      onManagement = undefined;
      expect((await executor.execute('Continue with the healthy sibling')).success).toBe(true);
      wake('healthy-sibling', [...inventory.values()][0]); terminal('healthy-sibling');
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
      expect(child).toBe(originalHost);
    } finally { release(); onManagement = undefined; }
  });

  it('does not infer predecessor death from a same-boot abrupt close', async () => {
    await create(); await abruptRestart(false); await service.recover();
    expect(hosts).toHaveLength(1);
    expect((await service.list(owner))[0].error).toContain('PID absence');
    expect(inventory.size).toBe(1);
  });
  it.each([false, true])('cancels a retained native definition without recreation (verified reboot=%s)', async nextBoot => {
    await create(); await create('second'); const [target, sibling] = [...inventory.keys()];
    await abruptRestart(false); await service.recover();
    expect((service as any).runtimes.size).toBe(0);
    if (nextBoot) boot = 'fixture-next-boot';
    const cancel = () => executor.withNativeScheduleOperation('cancel-operation', () => true,
      () => service.cancel(owner, 'first'), false);
    if (nextBoot) expect(await cancel()).toMatchObject({ state: 'cancelled', cancelRequested: true });
    else await expect(cancel()).rejects.toThrow('predecessor work remains unconfirmed');
    expect([...inventory.keys()]).toEqual([sibling]); expect(inventory.has(target)).toBe(false);
    const record = (await service.list(owner)).find(r => r.id === 'first')!;
    expect(record.cancelRequested).toBe(true);
    expect(record.state).toBe(nextBoot ? 'cancelled' : 'failed');
    expect(executor.getSessionId()).toBe('synthetic-original-session');
    const actions = child.stdin.write.mock.calls.map(([line]: [string]) => JSON.parse(line))
      .filter((p: any) => p.type === 'user');
    expect(actions).toHaveLength(3);
    expect(actions.every((p: any) => !JSON.stringify(p).includes('select:CronCreate'))).toBe(true);
    await service.recover();
    expect(inventory.has(target)).toBe(false); expect(inventory.has(sibling)).toBe(true);
    expect((await service.list(owner)).find(r => r.id === 'first')!.cancelRequested).toBe(true);
  });
  it.each(['session', 'model', 'host', 'capabilities'])('refuses retained cancellation after %s identity changes', async variant => {
    await create(); const target = [...inventory.keys()][0]; await abruptRestart(true); await executor.listModels();
    if (variant === 'session') raw.sessionId = 'synthetic-other-session';
    if (variant === 'model') raw.model = 'synthetic-other-model';
    if (variant === 'host') vi.mocked(ownershipRuntime.bootIdentity).mockReturnValue({ host: 'foreign-host', boot, namespace: 'fixture-namespace' });
    if (variant === 'capabilities') raw.turnLedger.capabilities.clear();
    await expect(executor.withNativeScheduleOperation('cancel-operation', () => true,
      () => service.cancel(owner, 'first'), false)).rejects.toThrow();
    expect(inventory.has(target)).toBe(true);
    expect((await service.list(owner))[0]).toMatchObject({ state: 'interrupted', cancelRequested: true });
  });
  it('rechecks model ownership after asynchronous timezone inspection before authorizing deletion', async () => {
    await create(); const target = [...inventory.keys()][0]; await abruptRestart(true); await executor.listModels();
    vi.spyOn(raw, 'readNativeScheduleTimezone').mockImplementation(async () => {
      raw.model = 'synthetic-changed-model'; return 'UTC';
    });
    await expect(executor.withNativeScheduleOperation('cancel-operation', () => true,
      () => service.cancel(owner, 'first'), false)).rejects.toThrow('host changed');
    expect(inventory.has(target)).toBe(true);
    expect((await service.list(owner))[0]).toMatchObject({ state: 'interrupted', cancelRequested: true });
  });
  it('recovers future cron intent but never retries an unknown admitted occurrence', async () => {
    await create(); wake('unknown-past', [...inventory.values()][0]); await drain();
    expect((await service.list(owner))[0].state).toBe('running');
    const crashedCatalog = await fs.readFile((service as any).catalogPath, 'utf8');
    await abruptRestart(true, crashedCatalog); await service.recover();
    expect((await service.list(owner))[0].state).toBe('active');
    expect(deliver).not.toHaveBeenCalled(); expect(inventory.size).toBe(1);
  });
  it('preserves cancellation tombstones and uncertain one-shots across a reboot', async () => {
    await create(); await create('once', true); await service.cancel(owner, 'first');
    await abruptRestart(true); await service.recover();
    const records = await service.list(owner);
    expect(records.find(r => r.id === 'first')!.state).toBe('cancelled');
    expect(records.find(r => r.id === 'once')!.state).toBe('interrupted');
    expect(hosts).toHaveLength(1); expect(deliver).not.toHaveBeenCalled();
  });
  it('keeps unowned native definitions untouched while adopting owned tasks', async () => {
    await create(); inventory.set('foreign', '[unmanaged-fixture]');
    await abruptRestart(true); await service.recover();
    expect((await service.list(owner))[0].state).toBe('active');
    expect(inventory.get('foreign')).toBe('[unmanaged-fixture]');
    wake('foreign-wake', '[unmanaged-fixture]');
    expect(JSON.parse(child.stdin.write.mock.calls.at(-1)[0]).response.response.decision).toBe('block');
    inventory.delete('foreign');
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
      expect((await executor.execute('Chat after failed restoration')).success).toBe(true);
    });
  it.each(['error', 'missing'] as const)('quarantines a %s restored model reply without blocking chat or replaying CREATE', async replyType => {
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
    expect((await executor.execute('Chat after failed restoration')).success).toBe(true);
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
  it('keeps a healthy sibling after a later read-only restoration failure', async () => {
    raw.model = undefined;
    await create(); await create('second'); await service.suspendForRestart();
    onCreate = async () => { modelReplyType = 'missing'; onCreate = undefined; };
    const originalTimer = global.setTimeout;
    vi.spyOn(global, 'setTimeout').mockImplementation(((callback: any, delay: any, ...args: any[]) =>
      originalTimer(callback, delay === 10000 ? 20 : delay, ...args)) as any);
    await service.recover();
    expect((await service.list(owner)).find(record => record.id === 'second')!.recovery?.status).toBe('blocked');
    expect((await executor.execute('Before cleanup')).success).toBe(true);
    await service.cancel(owner, 'first');
    expect((await executor.execute('After unrelated cleanup')).success).toBe(true);
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
      onCreate = undefined; onManagement = undefined;
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
    expect((await service.list(owner))[0].state).toBe('failed');
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
  it('publishes the durable clean receipt when handoff completion retries after a late EOF exit', async () => {
    await create(); withholdClose = true;
    const originalTimer = global.setTimeout;
    vi.spyOn(global, 'setTimeout').mockImplementation(((callback: any, delay: any, ...args: any[]) =>
      originalTimer(callback, delay === 20000 ? 25 : delay, ...args)) as any);
    await expect(service.suspendForRestart()).rejects.toThrow('exit remains unconfirmed');
    const filename = raw.scheduleOwnership.filename;
    expect(JSON.parse(await fs.readFile(filename, 'utf8')).clean).toBe(false);
    child.emit('close', 0, null);
    await executor.nativeScheduleRecovery!.finishRestart!();
    expect(JSON.parse(await fs.readFile(filename, 'utf8')).clean).toBe(true);
    // Repeating receipt publication must not spawn a successor or repeat EOF.
    await executor.nativeScheduleRecovery!.finishRestart!();
    expect(hosts).toHaveLength(1); expect(child.stdin.end).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
  });
  it('retries failed clean receipt publication without repeating native shutdown', async () => {
    await create();
    const publish = vi.spyOn(raw.scheduleOwnership, 'confirmClean')
      .mockImplementationOnce(() => { throw new Error('Synthetic receipt publication failure'); });
    await expect(service.suspendForRestart()).rejects.toThrow('receipt publication failure');
    expect(JSON.parse(await fs.readFile(raw.scheduleOwnership.filename, 'utf8')).clean).toBe(false);
    await executor.nativeScheduleRecovery!.finishRestart!();
    expect(publish).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await fs.readFile(raw.scheduleOwnership.filename, 'utf8')).clean).toBe(true);
    expect(hosts).toHaveLength(1); expect(child.stdin.end).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
  });
  it('does not certify a clean process exit before the explicit drained EOF boundary', async () => {
    await create(); await raw.releaseScheduleDefinitions();
    child.emit('close', 0, null);
    await expect(executor.nativeScheduleRecovery!.finishRestart!()).rejects.toThrow('exited unsuccessfully');
    expect(JSON.parse(await fs.readFile(raw.scheduleOwnership.filename, 'utf8')).clean).toBe(false);
    expect(child.stdin.end).not.toHaveBeenCalled();
  });
  it.each([
    ['linux', 'arm64'], ['darwin', 'arm64'], ['win32', 'x64'],
  ] as const)('accepts %s/%s capabilities and restores on the actual filesystem host', async (platform, arch) => {
    nativeVersion = '2.1.318'; raw.turnLedger.version = nativeVersion;
    // Only synchronous capability selection is simulated, never filesystem work.
    const platformMock = vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    const archMock = vi.spyOn(process, 'arch', 'get').mockReturnValue(arch);
    try {
      expect(executor.nativeScheduleRecovery).toBeDefined();
      expect(executor.preservesProcessOnAbort()).toBe(true);
    } finally { archMock.mockRestore(); platformMock.mockRestore(); }
    await create('first'); await create('second');
    await service.suspendForRestart(); await service.recover();
    expect(hosts).toHaveLength(2); expect(inventory.size).toBe(2);
    expect((await service.list(owner)).every(record => record.state === 'active')).toBe(true);
    expect(executor.getSessionId()).toBe('synthetic-original-session');
    const restored = child;
    expect((await executor.execute('Next foreground')).success).toBe(true);
    expect(child).toBe(restored);
  });
  it.each(['interrupt_receipt_v1', 'msg_lifecycle_v1', 'lifecycle_wakeup_source_v1', 'pid', 'session'])('refuses handoff with missing or changed %s evidence', async missing => {
    await create();
    if (missing === 'pid') raw.turnLedger.pid++;
    else if (missing === 'session') frame({ session_id: 'foreign-session' });
    else raw.turnLedger.capabilities.delete(missing);
    await expect(service.suspendForRestart()).rejects.toThrow('admission');
    expect(child.stdin.end).not.toHaveBeenCalled(); expect(child.kill).not.toHaveBeenCalled();
    expect((await service.list(owner))[0].recovery?.handoff).toBeUndefined();
  });
  it('blocks restoration when a successor does not advertise lifecycle support', async () => {
    await create(); await service.suspendForRestart();
    nativeCapabilities = [];
    await service.recover();
    expect(inventory.size).toBe(0);
    expect((await service.list(owner))[0].recovery?.status).toBe('blocked');
    expect((await executor.execute('Chat after failed restoration')).success).toBe(true);
  });
  it('keeps restricted and managed worker recovery disabled', async () => {
    raw.delegationWorker = true; expect(executor.nativeScheduleRecovery).toBeUndefined();
    raw.delegationWorker = false;
    vi.spyOn(raw.sandbox, 'isRestricted').mockReturnValue(true); expect(executor.nativeScheduleRecovery).toBeUndefined();
  });

  it('fails closed on a nonzero exit and does not publish a clean checkpoint', async () => {
    await create(); closeCode = 2;
    await expect(service.suspendForRestart()).rejects.toThrow('exit');
    expect((await service.list(owner))[0].recovery?.handoff).toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
  });
});
