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
  service = new ScheduleService({ directory: path.join(root, 'catalog'), now: () => Date.now(), isOwnerCurrent: () => true,
    provider: { cleanupFor: () => executor.nativeScheduleCleanup, create: (input, emit, admit) => executor.createNativeSchedule(input, emit, undefined, admit) }, deliver });
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
describe('Claude abrupt lifecycle and exact cleanup', () => {
  async function abruptRestart(nextBoot: boolean, crashedCatalog?: string) {
    child.emit('close', null, 'SIGKILL'); await drain();
    if (!(service as any).closing) await service.retryDeliveries();
    await service.destroy(); await executor.destroy();
    if (crashedCatalog) { await fs.writeFile((service as any).catalogPath, crashedCatalog); deliver.mockClear(); }
    if (nextBoot) boot = 'fixture-next-boot';
    executor = new ClaudePersistentExecutor(new DirectoryGuard([root]), root, owner.threadId, 'synthetic-model', undefined, 'synthetic-native');
    raw = executor;
    service = new ScheduleService({ directory: path.join(root, 'catalog'), isOwnerCurrent: () => true,
      provider: { cleanupFor: () => executor.nativeScheduleCleanup, create: (input, emit, admit) => executor.createNativeSchedule(input, emit, undefined, admit) }, deliver });
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

  it.each([false])('preserves wakes after read errors and fences only explicit cleanup, preserving siblings (recovered=%s)', async recovered => {
    await create(); await create('second');
    if (recovered) { await abruptRestart(true); }
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
  it('records creation refusal for a live native owner and admits a later explicit request after its exit', async () => {
    const inventoryProbe = vi.mocked(scheduleProcesses.scheduleProcesses);
    const normal = inventoryProbe.getMockImplementation()!;
    inventoryProbe.mockImplementation(() => [...normal(), { pid: 9001, birth: 'other', command: 'synthetic-native --resume synthetic-original-session' }]);
    await expect(create('refused')).rejects.toThrow('Another native host');
    expect(await service.list(owner)).toEqual([]);
    expect(inventory.size).toBe(0);
    inventoryProbe.mockImplementation(normal);
    expect((await create('explicit-after-exit')).state).toBe('active');
    expect(executor.getSessionId()).toBe('synthetic-original-session');
  });

  it('does not infer predecessor death from a same-boot abrupt close', async () => {
    await create(); await abruptRestart(false);
    expect(hosts).toHaveLength(1);
    expect((await service.list(owner))[0].recovery?.status).toBe('blocked');
    expect(inventory.size).toBe(1);
  });
  it.each([false, true])('cancels a retained native definition without recreation (verified reboot=%s)', async nextBoot => {
    await create(); await create('second'); const [target, sibling] = [...inventory.keys()];
    await abruptRestart(false);
    expect((service as any).runtimes.size).toBe(0);
    if (nextBoot) boot = 'fixture-next-boot';
    const cancel = () => executor.withNativeScheduleOperation('cancel-operation', () => true,
      () => service.cancel(owner, 'first'), false);
    if (nextBoot) expect(await cancel()).toMatchObject({ state: 'cancelled', cancelRequested: true });
    else await expect(cancel()).rejects.toThrow('predecessor work remains unconfirmed');
    expect([...inventory.keys()]).toEqual([sibling]); expect(inventory.has(target)).toBe(false);
    const record = (await service.list(owner)).find(r => r.id === 'first')!;
    expect(record.cancelRequested).toBe(true);
    expect(record.state).toBe(nextBoot ? 'cancelled' : 'interrupted');
    expect(executor.getSessionId()).toBe('synthetic-original-session');
    const actions = child.stdin.write.mock.calls.map(([line]: [string]) => JSON.parse(line))
      .filter((p: any) => p.type === 'user');
    expect(actions).toHaveLength(3);
    expect(actions.every((p: any) => !JSON.stringify(p).includes('select:CronCreate'))).toBe(true);

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
  it('preserves cancellation tombstones and uncertain one-shots across a reboot', async () => {
    await create(); await create('once', true); await service.cancel(owner, 'first');
    await abruptRestart(true);
    const records = await service.list(owner);
    expect(records.find(r => r.id === 'first')!.state).toBe('cancelled');
    expect(records.find(r => r.id === 'once')!.state).toBe('interrupted');
    expect(hosts).toHaveLength(1); expect(deliver).not.toHaveBeenCalled();
  });
  it('keeps retained cleanup unavailable to restricted and managed workers', async () => {
    raw.delegationWorker = true; expect(executor.nativeScheduleCleanup).toBeUndefined();
    raw.delegationWorker = false;
    vi.spyOn(raw.sandbox, 'isRestricted').mockReturnValue(true); expect(executor.nativeScheduleCleanup).toBeUndefined();
  });

  it.each([false, true])('treats every exit as abrupt and never adopts or recreates Claude definitions (next boot=%s)', async nextBoot => {
    await create(); await create('second'); const ids = [...inventory.keys()];
    const messages = child.stdin.write.mock.calls.length;
    await service.destroy();
    expect(child.stdin.write.mock.calls.length).toBe(messages);
    await abruptRestart(nextBoot);
    expect(hosts).toHaveLength(1); expect([...inventory.keys()]).toEqual(ids);
    expect((await service.list(owner)).every(row => row.state === 'interrupted' && row.recovery?.status === 'blocked')).toBe(true);
    expect(executor.nativeScheduleCleanup).not.toHaveProperty('reconcile');
    await executor.listModels();
    const options = vi.mocked(spawn).mock.calls.at(-1)![2] as any;
    expect(options.env.CLAUDE_CODE_DISABLE_CRON).toBe('1');
    expect(executor.getSessionId()).toBe('synthetic-original-session');
  });
});
