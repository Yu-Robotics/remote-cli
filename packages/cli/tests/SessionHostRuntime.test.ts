import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { randomBytes } from 'crypto';
import { ThreadManager } from '../src/thread/ThreadManager';
import { ThreadExecutorPool } from '../src/thread/ThreadExecutorPool';
import { DirectoryGuard } from '../src/security/DirectoryGuard';
import type { IExecutor } from '../src/executor/IExecutor';
import type { NativeScheduleEvent, NativeScheduleHandle, NativeScheduleInput } from '../src/scheduling/types';
import { RetainedRuntime } from '../src/sessionHost/RetainedRuntime';
import { RetainedFrontend, descriptorLauncher, retainedIntent, type RetainedConnection, type RuntimeSnapshot } from '../src/sessionHost/RetainedFrontend';
import { HostServer } from '../src/sessionHost/HostServer';
import { HostError } from '../src/sessionHost/HostProtocol';
import { HostClient } from '../src/sessionHost/HostClient';
import { RuntimeJournal } from '../src/sessionHost/RuntimeJournal';
import { AutomaticUpdater } from '../src/update/AutomaticUpdater';
import type { ManagedToolConnection } from '../src/managed/contract';
import { isCompleteThreadCatalog } from '../../router/src/binding/ThreadSelectionManager';

class Router {
  messages: any[] = []; listeners: ((m: any) => void)[] = []; acks: ((id: string) => void)[] = []; closes: (() => void)[] = [];
  autoAck = true; connected = false;
  onMessage(fn: (m: any) => void) { this.listeners.push(fn); }
  onClose(fn: () => void) { this.closes.push(fn); return () => {}; }
  onTaskResultAck(fn: (id: string) => void) { this.acks.push(fn); return () => { this.acks = this.acks.filter(x => x !== fn); }; }
  isConnected() { return this.connected; }
  async connect() { this.connected = true; this.binding(); }
  disconnect() { this.connected = false; this.closes.forEach(fn => fn()); }
  binding() { this.inbound({ type: 'binding_confirm', data: { success: true, capabilities: { taskRecovery: true, scheduleResultsV1: true } } }); }
  inbound(message: any) { this.listeners.forEach(fn => fn(message)); }
  ack(id: string) { this.acks.forEach(fn => fn(id)); }
  send(message: any) { this.messages.push(structuredClone(message)); if (this.autoAck && message.type === 'response') this.ack(message.messageId); return this.connected; }
}
let root: string;
let router: Router;
let runtime: RetainedRuntime;
let host: HostServer;
let connection: RetainedConnection;
let threads: ThreadManager;
let frontend: RetainedFrontend;
let serial = 0;
const frontends: RetainedFrontend[] = [];
const jobs = new Map<string, { input: NativeScheduleInput; emit: (event: NativeScheduleEvent) => void | Promise<void>; admit: () => boolean; nativeId: string }>();
const executors: any[] = [];
let held: (() => void) | undefined;
beforeEach(async () => {
  jobs.clear(); executors.length = 0; held = undefined;
  // Runtime admission uses the native realpath API, which expands Windows aliases.
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'retained-runtime-')));
  expect(await fs.promises.realpath(root)).toBe(root);
  vi.spyOn(os, 'homedir').mockReturnValue(root);
  threads = await ThreadManager.initialize(root); router = new Router();
  const guard = new DirectoryGuard([root]);
  const pool = new ThreadExecutorPool(threads, guard, { type: 'agy' }, (_guard, _config, cwd, threadId) => {
    const executor: any = {
      sessionId: `native-${threadId}`, nativeProcess: randomBytes(8).toString('hex'), connection: undefined as ManagedToolConnection | undefined,
      getCurrentWorkingDirectory: () => cwd, getSessionId: () => executor.sessionId, isBusy: () => false,
      configureManagedTools: vi.fn(async (value: ManagedToolConnection) => { executor.connection = value; }),
      withNativeScheduleOperation: vi.fn(async (_id, _current, run) => run()),
      execute: vi.fn(async (prompt: string) => {
        if (prompt === 'hold foreground') await new Promise<void>(resolve => { held = resolve; });
        return { success: true, output: `native reply: ${prompt}` };
      }),
      createNativeSchedule: vi.fn(async (input, emit, current, admit) => {
        const nativeId = `native-task-${input.id}`;
        jobs.set(input.id, { input, emit, admit: () => current() && admit(), nativeId });
        return { nativeId, cancellationKeepsRunning: true, retirementConfirmed: true, nativeDefinitionAbsent: true,
          list: vi.fn(async () => jobs.has(input.id)), cancel: vi.fn(async () => { jobs.delete(input.id); }), stop: async () => {} } satisfies NativeScheduleHandle;
      }),
      destroy: vi.fn(async () => {}), waitForExit: async () => {}, resetContext: vi.fn(), abort: vi.fn(async () => true),
    };
    executors.push(executor); return executor as IExecutor;
  });
  runtime = new RetainedRuntime({ directory: path.join(root, 'runtime'), runtimeVersion: '1.6.247', config: { type: 'agy' }, threads, pool, guard, router: router as any });
  const directory = path.join(root, 'control'); const secret = randomBytes(32).toString('hex'); const launcherSecret = randomBytes(32).toString('hex');
  host = new HostServer({ directory, secret, launcherSecret, installationId: 'synthetic-installation', runtime });
  await runtime.start(); connection = { address: await host.listen(), secret, launcherSecret, directory };
  frontend = new RetainedFrontend({ connect: async () => connection }, '1.6.248'); frontends.push(frontend); await frontend.start(60_000);
});
afterEach(async () => {
  held?.(); held = undefined;
  for (const front of frontends.splice(0)) await front.close().catch(() => {});
  router.autoAck = true;
  router.messages.filter(row => row.type === 'response').forEach(row => router.ack(row.messageId));
  await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(path.join(root, 'runtime', 'schedule-catalog.json'), 'utf8')).pending).toHaveLength(0));
  // Explicit cancellation is fixture teardown, never frontend handoff behavior.
  for (const job of [...jobs.values()]) {
    const owner = runtime.journal.snapshot().owners.find(row => row.threadId === job.input.threadId)!;
    await (runtime as any).schedule(owner, { kind: 'cancel', id: job.input.id }, `cleanup-${++serial}`, false);
  }
  await host.stop(); jobs.clear(); executors.length = 0;
  vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true });
});
async function command(text: string, threadId?: string, openId = 'synthetic-owner') {
  const messageId = `command-${++serial}`;
  router.inbound({ type: 'command', messageId, openId, content: text, ...(threadId ? { threadId } : {}) });
  await frontend.tick();
  await vi.waitFor(() => expect(router.messages.some(row => row.type === 'response' && row.messageId === messageId)).toBe(true));
  return router.messages.find(row => row.type === 'response' && row.messageId === messageId);
}
async function newThread() {
  const result = await command(`/thread new retained-${++serial} agy ${root}`); expect(result).toMatchObject({ success: true }); return result.threadId as string;
}

it('refuses a native canonical cwd outside the fixture allowlist without creating an owner', async () => {
  const realpath = fs.promises.realpath.bind(fs.promises);
  // Model a native alias expansion that differs from the configured home.
  // No access to the synthetic sibling is performed.
  const canonical = path.join(path.dirname(root), 'synthetic-expanded-home');
  const spy = vi.spyOn(fs.promises, 'realpath').mockImplementation(async (target: any, options: any) => {
    if (target === root) return canonical;
    return realpath(target, options);
  });
  try {
    const result = await command(`/thread new alias-boundary agy ${root}`);
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('not allowed') });
    expect(runtime.journal.snapshot().owners).toEqual([]);
    expect(executors).toHaveLength(0);
  } finally { spy.mockRestore(); }
  await newThread();
});

it('drains bounded ingress pages and explicitly rejects commands too large after transport encoding', async () => {
  const threadId = await newThread();
  const ids = Array.from({ length: 17 }, () => `oversized-${++serial}`);
  for (const messageId of ids) router.inbound({ type: 'command', messageId, openId: 'synthetic-owner', threadId,
    content: '\\'.repeat(16 * 1024) });
  const snapshot = await runtime.inspect('state', null) as unknown as RuntimeSnapshot;
  expect(snapshot.commands).toHaveLength(16);
  for (let index = 0; index < 2; index++) {
    await frontend.tick();
    await vi.waitFor(() => expect(router.messages.filter(row => row.type === 'response' && ids.includes(row.messageId))).toHaveLength(Math.min(ids.length, (index + 1) * 16)));
  }
  expect(router.messages.filter(row => ids.includes(row.messageId))).toEqual(expect.arrayContaining([
    expect.objectContaining({ success: false, error: expect.stringContaining('transport limits') }),
  ]));
  expect(runtime.journal.snapshot().commands.filter(row => ids.includes(row.messageId)).every(row => row.status === 'acknowledged')).toBe(true);
  expect(executors.every(executor => executor.execute.mock.calls.length === 0)).toBe(true);
  expect((await command('/host status', threadId)).success).toBe(true);
});

it('answers real Router status with a complete control-only default and owned native threads', async () => {
  const legacyDefault = threads.getDefaultThread().id;
  router.inbound({ type: 'status', messageId: 'status-empty' });
  const empty = router.messages.find(row => row.messageId === 'status-empty');
  expect(isCompleteThreadCatalog(empty.status.threads)).toBe(true);
  expect(empty.status.threads).toEqual([{ id: 'retained-host-default', name: 'default', status: 'idle' }]);
  expect(executors).toHaveLength(0);
  const threadId = await newThread();
  router.inbound({ type: 'status', messageId: 'status-owned' });
  const catalog = router.messages.find(row => row.messageId === 'status-owned').status.threads;
  expect(isCompleteThreadCatalog(catalog)).toBe(true);
  expect(catalog.map((row: any) => row.id)).toEqual(['retained-host-default', threadId]);
  expect(catalog.map((row: any) => row.id)).not.toContain(legacyDefault);
  expect((await command('/host status', threadId)).threads).toEqual(catalog);
});

it('rejects attachments explicitly without sending the text-only remainder to a native model', async () => {
  const threadId = await newThread();
  router.inbound({ type: 'command', messageId: 'image-command', openId: 'synthetic-owner', threadId,
    content: 'Describe this image', attachments: [{ type: 'image', data: 'synthetic-image' }] });
  await frontend.tick();
  expect(router.messages.find(row => row.messageId === 'image-command')).toMatchObject({ success: false,
    error: expect.stringContaining('Attachments are not supported') });
  expect(executors.every(executor => executor.execute.mock.calls.length === 0)).toBe(true);
  expect(runtime.journal.snapshot().commands.find(row => row.messageId === 'image-command')?.status).toBe('acknowledged');
});

it('resolves ambiguous acceptance before retiring receipts when both submission and status replies are lost', async () => {
  const threadId = await newThread();
  const submit = HostClient.prototype.submitSequenced;
  vi.spyOn(HostClient.prototype, 'submitSequenced').mockImplementationOnce(async function (this: HostClient, ...args) {
    await submit.apply(this, args); throw new HostError('transport_outcome_unknown');
  });
  vi.spyOn(HostClient.prototype, 'status').mockRejectedValueOnce(new HostError('transport_outcome_unknown'));
  router.inbound({ type: 'command', messageId: 'ambiguous-acceptance', openId: 'synthetic-owner', threadId, content: 'execute once' });
  await expect(frontend.tick()).rejects.toThrow('transport_outcome_unknown');
  expect(frontend.tryBeginAutomaticUpdate()).toBe(false);
  await vi.waitFor(() => expect(router.messages.some(row => row.messageId === 'ambiguous-acceptance')).toBe(true));
  await frontend.tick();
  expect((await command('subsequent command', threadId)).success).toBe(true);
  expect(executors[0].execute.mock.calls.map((args: unknown[]) => args[0])).toEqual(['execute once', 'subsequent command']);
});
async function fire(id: string, occurrence: string) {
  const job = jobs.get(id)!; expect(job.admit()).toBe(true);
  await job.emit({ type: 'started', occurrenceId: occurrence });
  await job.emit({ type: 'completed', occurrenceId: occurrence, success: true, output: `scheduled ${occurrence}` });
}

it('joins drained AGY hosts before certifying cancelled cleanup, retaining callbacks and locks across an exit retry', async () => {
  const threadId = await newThread();
  await command('/schedule after 60m -- once', threadId);
  await command('/schedule cron "* * * * *" --tz UTC -- recurring', threadId);
  const native = executors[0];
  const originalJobs = [...jobs.values()];
  const handles: NativeScheduleHandle[] = await Promise.all(native.createNativeSchedule.mock.results.map((row: any) => row.value));
  for (const handle of handles) Object.assign(handle, { retirementConfirmed: false, stop: vi.fn(async () => {}) });
  await fire(originalJobs[0].input.id, 'once-terminal');
  await fire(originalJobs[1].input.id, 'cron-terminal');
  await command('/schedule cancel ' + originalJobs[1].input.id, threadId);
  const catalog = () => JSON.parse(fs.readFileSync(path.join(root, 'runtime', 'schedule-catalog.json'), 'utf8'));
  await vi.waitFor(() => expect((runtime as any).schedules.canRetireDrainedHosts()).toBe(true));
  expect((runtime as any).schedules.hasActiveSchedules()).toBe(true);
  expect(catalog().records.find((row: any) => row.cancelRequested).cleanupConfirmed).toBeUndefined();
  await frontend.close();
  const management = native.withNativeScheduleOperation.mock.calls.length;
  const stops = handles.map(handle => vi.mocked(handle.stop).mock.calls.length);
  const cancellations = handles.map(handle => vi.mocked(handle.cancel).mock.calls.length);
  native.destroy.mockRejectedValueOnce(new Error('Exact group exit is not confirmed'));
  await expect(host.stop()).rejects.toThrow('Exact group exit is not confirmed');
  expect(() => new RuntimeJournal(path.join(root, 'runtime'), 'competing')).toThrow('Another retained runtime');
  await expect(runtime.execute({ requestId: 'late-command', method: 'frontendVersion', args: '1.6.249' })).rejects.toThrow('unavailable');
  expect(originalJobs.every(job => !job.admit())).toBe(true);
  expect(catalog().records.find((row: any) => row.cancelRequested).cleanupConfirmed).toBeUndefined();
  native.destroy.mockImplementationOnce(async () => {
    // Models the provider's exit callback after its exact group join, including
    // AGY invalidating inventory. Native proof is a separate isolated probe.
    for (let index = 0; index < handles.length; index++) {
      Object.assign(handles[index], { retirementConfirmed: true, nativeDefinitionAbsent: false });
      void originalJobs[index].emit({ type: 'stopped', exitConfirmed: true, reason: 'Synthetic exact group joined' });
    }
    expect(runtime.journal.snapshot().nativeEvents).toHaveLength(2);
  });
  await host.stop();
  expect(native.destroy).toHaveBeenCalledTimes(2);
  expect(runtime.journal.snapshot().nativeEvents).toHaveLength(0);
  expect(catalog().records.find((row: any) => row.cancelRequested)).toMatchObject({ state: 'cancelled', cleanupConfirmed: true });
  expect(native.withNativeScheduleOperation).toHaveBeenCalledTimes(management);
  handles.forEach((handle, i) => {
    expect(handle.stop).toHaveBeenCalledTimes(stops[i]); expect(handle.cancel).toHaveBeenCalledTimes(cancellations[i]);
    expect(handle.list).not.toHaveBeenCalled();
  });
  expect(executors).toHaveLength(1);
  jobs.clear();
});

it('refuses explicit retirement for live work, pending ACKs and native mutations without touching the executor', async () => {
  const threadId = await newThread();
  await command('/schedule after 60m -- once', threadId);
  const job = [...jobs.values()][0], native = executors[0];
  await expect(runtime.stop()).rejects.toThrow('Native work');
  await job.emit({ type: 'started', occurrenceId: 'held' });
  await expect(runtime.stop()).rejects.toThrow('Native work');
  router.autoAck = false;
  await job.emit({ type: 'completed', occurrenceId: 'held', success: true, output: 'Pending ACK' });
  await expect(runtime.stop()).rejects.toThrow('Native work');
  router.autoAck = true;
  await vi.waitFor(() => expect(router.messages.some(row => row.queueStarted?.source === 'schedule')).toBe(true));
  router.messages.filter(row => row.type === 'response').forEach(row => router.ack(row.messageId));
  await vi.waitFor(() => expect((runtime as any).schedules.canRetireDrainedHosts()).toBe(true));
  native.hasPendingScheduleMutation = () => true;
  await expect(runtime.stop()).rejects.toThrow('Native work');
  expect(native.destroy).not.toHaveBeenCalled();
  native.hasPendingScheduleMutation = () => false;
});

it('joins overlapping explicit stop calls without repeating the owned executor shutdown', async () => {
  const threadId = await newThread(); await command('idle native host', threadId);
  await frontend.close();
  let joined!: () => void;
  const exit = new Promise<void>(resolve => { joined = resolve; });
  executors[0].destroy.mockImplementationOnce(() => exit);
  const first = runtime.stop();
  expect(runtime.stop()).toBe(first);
  expect(executors[0].destroy).toHaveBeenCalledOnce();
  joined(); await first;
  await runtime.stop();
  expect(executors[0].destroy).toHaveBeenCalledOnce();
});
async function tool(connection: ManagedToolConnection, name: string, args: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const request = http.request(connection.url, { method: 'POST', headers: { authorization: `Bearer ${connection.token}` } }, response => {
      let output = ''; response.on('data', bytes => { output += bytes; }); response.on('end', () => resolve(JSON.parse(output)));
    }); request.on('error', reject); request.end(JSON.stringify({ name, args, callId: 'synthetic-call' }));
  });
}

it('preserves native session/tasks, MCP and Router-ACK output while the new frontend actually changes command logic', async () => {
  const threadId = await newThread();
  await command('/schedule after 60m -- once content', threadId);
  await command('/schedule cron "* * * * *" --tz UTC -- recurring content', threadId);
  const ids = [...jobs.keys()]; const native = executors[0]; const original = { session: native.sessionId, process: native.nativeProcess, endpoint: native.connection.url };
  const creates = native.createNativeSchedule.mock.calls.length; const management = native.withNativeScheduleOperation.mock.calls.length;
  router.autoAck = false;
  expect(frontend.tryBeginAutomaticUpdate()).toBe(true); await frontend.prepareAutomaticUpdate(); await frontend.close();
  expect(native.destroy).not.toHaveBeenCalled();
  await fire(ids[0], 'once-1');
  await jobs.get(ids[1])!.emit({ type: 'started', occurrenceId: 'cron-1' });
  expect((await tool(native.connection, 'remote_cli_schedule_list', { requestId: 'during-gap' })).status).toBe('succeeded');
  await jobs.get(ids[1])!.emit({ type: 'completed', occurrenceId: 'cron-1', success: true, output: 'scheduled cron-1' });
  const delivered = router.messages.filter(row => row.type === 'response' && row.queueStarted?.source === 'schedule');
  expect(delivered).toHaveLength(1); // The durable delivery serializer awaits this ACK.
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'runtime', 'schedule-catalog.json'), 'utf8'));
  expect(catalog.pending).toHaveLength(2);
  expect(runtime.journal.snapshot().nativeEvents).toHaveLength(0);
  frontend = new RetainedFrontend({ connect: async () => connection }, '1.6.249', (row, state, version) =>
    row.command === '/new-dispatch' ? { context: null, intent: { kind: 'reply', output: `new frontend ${version}` } } : retainedIntent(row, state, version));
  frontends.push(frontend); await frontend.start(60_000);
  expect((await command('/new-dispatch', threadId)).output).toBe('new frontend 1.6.249');
  expect(frontend.status()).toMatchObject({ frontendVersion: '1.6.249', runtimeVersion: '1.6.247' });
  expect({ session: native.sessionId, process: native.nativeProcess, endpoint: native.connection.url }).toEqual(original);
  expect(native.createNativeSchedule).toHaveBeenCalledTimes(creates);
  expect(native.withNativeScheduleOperation).toHaveBeenCalledTimes(management);
  router.autoAck = true; delivered.forEach(row => router.ack(row.messageId));
  await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(path.join(root, 'runtime', 'schedule-catalog.json'), 'utf8')).pending).toHaveLength(0));
  await fire(ids[1], 'cron-2');
  expect(native.createNativeSchedule).toHaveBeenCalledTimes(creates);
});

it('scopes native tool receipts to admitted occurrences instead of the whole host lifetime', async () => {
  const threadId = await newThread();
  await command('/schedule cron "* * * * *" --tz UTC -- recurring content', threadId);
  const job = [...jobs.values()][0];
  const native = executors[0];
  await job.emit({ type: 'started', occurrenceId: 'first-native-turn' });
  const first = await tool(native.connection, 'remote_cli_schedule_list', { requestId: 'same-native-request' });
  expect(first.status).toBe('succeeded'); expect(first.records).toHaveLength(1);
  await job.emit({ type: 'completed', occurrenceId: 'first-native-turn', success: true, output: 'first' });
  await command('/schedule after 60m -- new sibling', threadId);
  await job.emit({ type: 'started', occurrenceId: 'second-native-turn' });
  const second = await tool(native.connection, 'remote_cli_schedule_list', { requestId: 'same-native-request' });
  expect(second.status).toBe('succeeded'); expect(second.records).toHaveLength(2);
  await job.emit({ type: 'completed', occurrenceId: 'second-native-turn', success: true, output: 'second' });
  expect((await tool(native.connection, 'remote_cli_schedule_list', { requestId: 'outside-turn' })).status).not.toBe('succeeded');
});

it.each(['scheduled', 'foreground'] as const)('fences a delayed MCP mutation to its original %s invocation across frontend replacement', async kind => {
  const threadId = await newThread();
  await command('/schedule cron "* * * * *" --tz UTC -- recurring content', threadId);
  const job = [...jobs.values()][0], native = executors[0];
  let foreground: Promise<any> | undefined;
  if (kind === 'scheduled') await job.emit({ type: 'started', occurrenceId: 'old-turn' });
  else { foreground = command('hold foreground', threadId); await vi.waitFor(() => expect(held).toBeDefined()); }
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let current: (() => boolean) | undefined;
  native.withNativeScheduleOperation.mockImplementationOnce(async (_id: string, isCurrent: () => boolean, run: () => Promise<any>) => {
    current = isCurrent; await gate; return run();
  });
  const request = tool(native.connection, 'remote_cli_schedule_cancel', { requestId: 'delayed-cancel', scheduleId: job.input.id });
  try {
    await vi.waitFor(() => expect(current).toBeDefined());
    expect(current!()).toBe(true);
    expect(frontend.tryBeginAutomaticUpdate()).toBe(true);
    await frontend.prepareAutomaticUpdate(); await frontend.close();
    const replacement = new RetainedFrontend({ connect: async () => connection }, '1.6.249');
    frontends.push(replacement); await replacement.start(60_000); frontend = replacement;
    expect(current!()).toBe(true);
    if (kind === 'scheduled') {
      const completed = job.emit({ type: 'completed', occurrenceId: 'old-turn', success: true, output: 'Old result' });
      expect(current!()).toBe(false); await completed;
    } else { held!(); held = undefined; await foreground; }
    await job.emit({ type: 'started', occurrenceId: 'next-turn' });
    expect(current!()).toBe(false);
    release();
    expect(await request).toEqual({ error: expect.stringContaining('Scheduling context changed') });
    expect(jobs.has(job.input.id)).toBe(true);
    expect(native.createNativeSchedule).toHaveBeenCalledTimes(1);
    await job.emit({ type: 'completed', occurrenceId: 'next-turn', success: true, output: 'Next result' });
  } finally { release(); held?.(); await request; await foreground; }
});

it('retains an accepted running foreground operation and refuses unsafe ownership/context or legacy adoption', async () => {
  const threadId = await newThread();
  const messageId = `running-${++serial}`;
  router.inbound({ type: 'command', messageId, openId: 'synthetic-owner', threadId, content: 'hold foreground' });
  await frontend.tick(); await vi.waitFor(() => expect(held).toBeTypeOf('function'));
  await frontend.close();
  frontend = new RetainedFrontend({ connect: async () => connection }, '1.6.250'); frontends.push(frontend); await frontend.start(60_000);
  held!(); held = undefined;
  await vi.waitFor(() => expect(router.messages.some(row => row.messageId === messageId && row.output === 'native reply: hold foreground')).toBe(true));
  expect(executors[0].execute).toHaveBeenCalledTimes(1);
  expect((await command('wrong owner', threadId, 'other-owner')).success).toBe(false);
  expect((await command('legacy', threads.getDefaultThread().id)).success).toBe(false);
  await threads.updateThread(threadId, { workingDirectory: path.join(root, 'different') });
  expect((await command('wrong directory', threadId)).success).toBe(false);
  await threads.updateThread(threadId, { workingDirectory: root, backend: 'claude' });
  expect((await command('wrong backend', threadId)).success).toBe(false);
  await threads.updateThread(threadId, { backend: 'agy', delegationWorkspaceGeneration: 1 });
  expect((await command('wrong generation', threadId)).success).toBe(false);
  expect(executors[0].execute).toHaveBeenCalledTimes(1);
});

it('uses real AutomaticUpdater preparation/install failure paths without lifecycle native calls or losing dispatch', async () => {
  const threadId = await newThread(); await command('/schedule after 60m -- retained', threadId);
  const before = executors[0].withNativeScheduleOperation.mock.calls.length;
  const updater = new AutomaticUpdater('1.6.248', frontend, { installVersion: vi.fn(async () => { throw new Error('Synthetic install failure'); }),
    beforeRestart: async () => frontend.close(), failureRetryDelayMs: 60_000, exitProcess: vi.fn() });
  await updater.handleRouterVersion('1.6.249');
  clearTimeout((updater as any).retryTimer);
  expect((await command('/host status', threadId)).output).toContain('Frontend 1.6.248');
  expect(executors[0].withNativeScheduleOperation).toHaveBeenCalledTimes(before);
  expect(executors[0].destroy).not.toHaveBeenCalled();
  await expect(host.stop()).rejects.toThrow();
  expect((await command('/host status', threadId)).success).toBe(true);
  // This test does not close the server while live work remains in production;
  // direct runtime stop refusal is the adapter contract checked here.
});

it('rejects competing frontends, preserves callback evidence on persistence failure, and keeps first adoption explicit', async () => {
  const second = new RetainedFrontend({ connect: async () => connection }, '1.6.249');
  await expect(second.start()).rejects.toThrow('frontend_still_alive');
  const threadId = await newThread(); await command('/schedule after 60m -- retained', threadId);
  expect(() => new RuntimeJournal(path.join(root, 'runtime'), 'other')).toThrow('Another retained runtime');
  const rename = fs.renameSync;
  const failure = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(to).endsWith('runtime.json')) throw new Error('Synthetic IO failure');
    rename(from, to);
  });
  const job = [...jobs.values()][0];
  expect(() => job.emit({ type: 'started', occurrenceId: 'failed-acceptance' })).toThrow('persistence outcome');
  failure.mockRestore(); expect(job.admit()).toBe(false);
  // Restore only the synthetic fixture's explicit cleanup access. Production
  // has no API to clear this fault or infer a missing durable native receipt.
  runtime.journal.healthy = true;
});

it('validates the private launcher descriptor and reports unsupported frontend commands without native work', async () => {
  const descriptor = path.join(root, 'descriptor.json'); fs.writeFileSync(descriptor, JSON.stringify(connection), { mode: 0o600 });
  expect(await descriptorLauncher(descriptor).connect()).toEqual(connection);
  expect((await command('/clear')).output).toContain('not enabled');
  expect((await command('/thread list')).output).toContain('No retained-host');
  expect((await command('/schedule purge all')).output).toContain('not enabled');
  expect((await command('/schedule after nonsense')).output).toBeTruthy();
  expect((await command('/help')).output).toContain('/thread new');
  expect(executors).toHaveLength(0);
});

it('reconciles lost acceptance, output ACK and detach replies without repeating native execution', async () => {
  const threadId = await newThread();
  const submit = HostClient.prototype.submitSequenced;
  vi.spyOn(HostClient.prototype, 'submitSequenced').mockImplementationOnce(async function (this: HostClient, ...args) {
    await submit.apply(this, args); throw new HostError('transport_outcome_unknown');
  });
  expect((await command('one exact turn', threadId)).success).toBe(true);
  expect(executors[0].execute).toHaveBeenCalledTimes(1);
  const ack = HostClient.prototype.ack;
  vi.spyOn(HostClient.prototype, 'ack').mockImplementationOnce(async function (this: HostClient, ...args) {
    await ack.apply(this, args); throw new HostError('transport_outcome_unknown');
  });
  await expect(frontend.tick()).rejects.toThrow('transport_outcome_unknown');
  await frontend.tick(); // Server watermark reconciled the lost ACK response.
  const detach = HostClient.prototype.detach;
  vi.spyOn(HostClient.prototype, 'detach').mockImplementationOnce(async function (this: HostClient, ...args) {
    await detach.apply(this, args); throw new HostError('transport_outcome_unknown');
  });
  await frontend.close();
  frontend = new RetainedFrontend({ connect: async () => connection }, '1.6.249'); frontends.push(frontend); await frontend.start(60_000);
  expect(executors[0].execute).toHaveBeenCalledTimes(1);
});

it('keeps update preparation, failed attach and failed detach separate from native lifecycle', async () => {
  const threadId = await newThread(); await command('/schedule after 60m -- retained', threadId);
  const inspect = HostClient.prototype.inspect;
  expect(frontend.tryBeginAutomaticUpdate()).toBe(true);
  vi.spyOn(HostClient.prototype, 'inspect').mockRejectedValueOnce(new HostError('transport_outcome_unknown'));
  await expect(frontend.prepareAutomaticUpdate()).rejects.toThrow(); await frontend.endAutomaticUpdate();
  expect((await command('/host status', threadId)).success).toBe(true);
  vi.spyOn(HostClient.prototype, 'detach').mockRejectedValueOnce(new HostError('storage_unavailable'));
  await expect(frontend.close()).rejects.toThrow('storage_unavailable');
  expect((await command('/host status', threadId)).success).toBe(true);
  await frontend.close();
  const failed = new RetainedFrontend({ connect: async () => connection }, '1.6.249');
  vi.spyOn(HostClient.prototype, 'inspect').mockImplementationOnce(async () => { throw new HostError('transport_outcome_unknown'); });
  await expect(failed.start()).rejects.toThrow();
  vi.mocked(HostClient.prototype.inspect).mockImplementation(inspect);
  frontend = new RetainedFrontend({ connect: async () => connection }, '1.6.249'); frontends.push(frontend); await frontend.start(60_000);
  expect(executors[0].createNativeSchedule).toHaveBeenCalledTimes(1);
  expect(executors[0].destroy).not.toHaveBeenCalled();
});

it('rejects malformed ingress without poisoning native admission and retries failed tool configuration safely', async () => {
  router.inbound({ type: 'command', messageId: 'invalid-command', openId: 'synthetic-owner', content: 123 });
  await vi.waitFor(() => expect(router.messages.some(row => row.messageId === 'invalid-command' && !row.success)).toBe(true));
  expect(runtime.journal.healthy).toBe(true);
  const threadId = await newThread();
  // Allocate only the synthetic executor; a rejected bridge configuration must
  // not leave a stale authenticated endpoint cached for the next user request.
  const native = (runtime as any).options.pool.getExecutor(threadId);
  native.configureManagedTools.mockRejectedValueOnce(new Error('Fixture registration failure'));
  expect((await command('first', threadId)).success).toBe(false);
  native.execute.mockImplementationOnce(async (_prompt: string, options: any) => { options.onStream('visible delta'); return { success: true, output: 'final' }; });
  expect((await command('second', threadId)).success).toBe(true);
  expect(native.configureManagedTools).toHaveBeenCalledTimes(2);
  expect(router.messages.find(row => row.type === 'stream')).toMatchObject({ chunk: 'visible delta', streamType: 'text' });
  expect(router.messages.find(row => row.type === 'stream')).not.toHaveProperty('content');
  const selection = await command('/t ' + threads.getThread(threadId)!.name);
  expect(selection.threadId).toBe(threadId);
  expect((await command('/t absent')).output).toContain('not found');
});

it('retains Router-unacknowledged foreground output when sends fail and refuses explicit host shutdown', async () => {
  const threadId = await newThread(); router.autoAck = false;
  const result = await command('durable foreground', threadId);
  await expect(host.stop()).rejects.toThrow('unacknowledged output');
  const send = vi.spyOn(router, 'send').mockImplementationOnce(() => { throw new Error('Fixture send failure'); });
  router.binding(); await Promise.resolve();
  expect(runtime.journal.snapshot().commands.find(row => row.messageId === result.messageId)?.status).toBe('completed');
  send.mockRestore(); router.binding();
  expect(router.messages.filter(row => row.messageId === result.messageId)).toHaveLength(2);
  router.ack(result.messageId); expect(executors[0].execute).toHaveBeenCalledTimes(1);
});

it('refuses reimport after native host exit and preserves bounded journal state on capacity failure', () => {
  const directory = path.join(root, 'separate-runtime');
  const journal = new RuntimeJournal(directory, 'original');
  journal.change(state => { state.commands.push({ messageId: 'synthetic', openId: 'owner', command: 'held', status: 'running' }); });
  const before = fs.readFileSync(path.join(directory, 'runtime.json'), 'utf8');
  expect(() => journal.change(state => { for (let i = 0; i < 128; i++) state.commands.push({ messageId: `extra-${i}`, openId: 'owner', command: 'queued', status: 'queued' }); })).toThrow('capacity');
  expect(fs.readFileSync(path.join(directory, 'runtime.json'), 'utf8')).toBe(before);
  journal.close();
  expect(() => new RuntimeJournal(directory, 'replacement')).toThrow('not imported or recreated');
  expect(fs.readFileSync(path.join(directory, 'runtime.json'), 'utf8')).toBe(before);
  const empty = path.join(root, 'empty-runtime'); new RuntimeJournal(empty, 'empty').close();
  new RuntimeJournal(empty, 'fresh').close();
  fs.writeFileSync(path.join(empty, 'runtime.json'), JSON.stringify({ version: 2 }), { mode: 0o600 });
  expect(() => new RuntimeJournal(empty, 'invalid')).toThrow('Invalid runtime journal');
});

it.each(['claude', 'dsh'] as const)('keeps %s adapter ownership and sibling schedules across frontend replacement and exact cancellation', async backend => {
  const first = await command(`/thread new first-${++serial} ${backend} ${root}`);
  const second = await command(`/thread new sibling-${++serial} ${backend} ${root}`);
  expect(first).toMatchObject({ success: true }); expect(second).toMatchObject({ success: true });
  expect((await command('/schedule after 60m -- first task', first.threadId)).success).toBe(true);
  expect((await command('/schedule after 60m -- sibling task', second.threadId)).success).toBe(true);
  const before = [...jobs.entries()];
  await frontend.close();
  frontend = new RetainedFrontend({ connect: async () => connection }, '1.6.249'); frontends.push(frontend); await frontend.start(60_000);
  expect((await command('/schedule cancel ' + before[1][0], first.threadId)).success).toBe(false);
  expect(jobs.size).toBe(2);
  expect((await command('/schedule cancel ' + before[0][0], first.threadId)).success).toBe(true);
  expect(jobs.size).toBe(1); expect(jobs.get(before[1][0])!.admit()).toBe(true);
  await fire(before[1][0], 'surviving-sibling');
  expect(executors.every(executor => executor.createNativeSchedule.mock.calls.length === 1)).toBe(true);
});
