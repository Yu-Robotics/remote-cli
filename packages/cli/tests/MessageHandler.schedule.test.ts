import { ScheduleCards } from '../../router/src/feishu/ScheduleCards';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'fs/promises';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DshExecutor } from '../src/executor/DshExecutor';
import { Host } from './scheduling/SyntheticDshScheduleHost';
import { AutomaticUpdater } from '../src/update/AutomaticUpdater';
import { MessageHandler } from '../src/client/MessageHandler';
import { DirectoryGuard } from '../src/security/DirectoryGuard';
import { ThreadContextReset } from '../src/thread/ThreadContextReset';
import type { Thread } from '../src/thread/types';
import type { NativeScheduleEvent, NativeScheduleInput } from '../src/scheduling/types';
import { NativeScheduleCleanupError, NativeScheduleNotAdmittedError } from '../src/scheduling/types';
import { ScheduleService, SCHEDULE_CATALOG_FILE } from '../src/scheduling/ScheduleService';

const native = vi.hoisted(() => ({ create: vi.fn(), createDsh: vi.fn() }));
vi.mock('../src/scheduling/ClaudeNativeScheduleProvider', () => ({
  ClaudeNativeScheduleProvider: class { create = native.create; },
}));
vi.mock('../src/scheduling/DshNativeScheduleProvider', () => ({
  DshNativeScheduleProvider: class { create = native.createDsh; },
}));

async function fixture() {
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'schedule-handler-')));
  await mkdir(path.join(cwd, '.remote-cli'));
  vi.spyOn(os, 'homedir').mockReturnValue(cwd);
  const threads: Thread[] = ['thread-a', 'thread-b'].map(id => ({ id, name: id, workingDirectory: cwd,
    sessionId: null, createdAt: 0, lastActiveAt: 0, delegation: false }));
  let backend = 'claude';
  let sandbox: { mode: string } | undefined;
  let connected = true;
  let executorBusy = false;
  const executor = { createNativeSchedule: vi.fn((input: any, emit: any, _owner?: () => boolean, _admit?: () => boolean) => (input.backend === 'dsh' ? native.createDsh : native.create)(input, emit)),
    withNativeScheduleOperation: vi.fn(async (_id: string, current: () => boolean, run: () => Promise<unknown>) => {
      if (!current()) throw new Error('Stale scheduling operation');
      return run();
    }), configureManagedTools: vi.fn(async (_connection?: any) => {}), configureDelegation: vi.fn(async (_connection?: any) => {}), execute: vi.fn(async () => ({ success: true })), getCurrentWorkingDirectory: () => cwd,
    reconcileNativeSchedule: vi.fn(async (_id: string, current: () => boolean, run: () => Promise<unknown>) => { if (!current()) throw new Error('Cleanup owner retired'); return run(); }),
    abort: vi.fn(async () => true), destroy: vi.fn(), isBusy: () => executorBusy, resetContext: vi.fn(),
    getSandboxStatus: () => 'Unrestricted', configureSandbox: vi.fn(async () => ({ success: true })) };
  const pool = {
    getExistingExecutor: () => executor, getExecutor: () => executor, getBackendKey: () => backend,
    getSummaries: () => threads.map(thread => ({ id: thread.id, name: thread.name, status: 'idle', backend })),
    isThreadBusy: () => executorBusy, setThreadBusy: vi.fn(), setThreadError: vi.fn(), destroyAll: vi.fn(async () => {}),
    setWorkingDirectory: vi.fn(async () => ({ cwd, changed: false })),
    assertContextResettable: vi.fn(), clearThreadContext: vi.fn(async () => {}), destroyThread: vi.fn(async () => {}),
  };
  const manager = {
    contextResets: new ThreadContextReset(path.join(cwd, 'resets')),
    getDefaultThread: () => threads[0], getThread: (id: string) => threads.find(thread => thread.id === id),
    getThreadByName: (name: string) => threads.find(thread => thread.name === name),
    listThreads: () => threads, updateThread: vi.fn(), deleteThread: vi.fn(),
  };
  const acknowledgements = new Set<(id: string) => void>();
  const closeHandlers = new Set<(...args: any[]) => void>();
  const scheduledMessages = new Set<string>();
  const ws = {
    send: vi.fn((message: any) => {
      if (!connected) throw new Error('Disconnected');
      if (message.type === 'schedule_tool_card') queueMicrotask(() => { void handler.handleMessage({ type: 'schedule_tool_card_ack', messageId: message.messageId, success: true } as any); });
      if (message.type === 'queue_started' && message.queueStarted?.source === 'schedule') scheduledMessages.add(message.messageId);
      if (message.type === 'response' && scheduledMessages.has(message.messageId)) {
        for (const acknowledge of acknowledgements) acknowledge(message.messageId);
      }
      return true;
    }),
    isConnected: () => connected, trackTask: vi.fn(), hasPendingTaskResults: () => false,
    onClose: (handler: (...args: any[]) => void) => { closeHandlers.add(handler); return () => closeHandlers.delete(handler); },
    onTaskResultAck: (handler: (id: string) => void) => { acknowledgements.add(handler); return () => acknowledgements.delete(handler); },
  };
  const config = { get: (key: string) => key === 'executor' ? { type: backend, claude: { sandbox },
    dsh: { command: 'dsh-fixture', model: 'profile-default' } }
    : key === 'serverUrl' ? 'ws://localhost:9999' : key === 'deviceId' ? 'fixture-device' : undefined,
  getConfigDir: () => path.join(cwd, 'config'), getAll: () => ({ executor: { type: backend } }) };
  const makeHandle = (nativeId: string) => ({ nativeId, list: vi.fn(async () => true),
    cancel: vi.fn(async () => {}), stop: vi.fn(async () => {}) });
  const jobs: Array<{ input: NativeScheduleInput; emit: (event: NativeScheduleEvent) => void;
    handle: ReturnType<typeof makeHandle> }> = [];
  const create = async (input: NativeScheduleInput, emit: (event: NativeScheduleEvent) => void) => {
    const handle = makeHandle(`native-${jobs.length}`);
    jobs.push({ input, emit, handle }); return handle;
  };
  native.create.mockImplementation(create);
  native.createDsh.mockImplementation(create);
  const makeHandler = () => new MessageHandler(ws as any, pool as any, manager as any, new DirectoryGuard([cwd]), config as any);
  let handler = makeHandler();
  let sequence = 0;
  const send = (content: string, threadId = 'thread-a', extra: Record<string, unknown> = {}) => handler.handleMessage({
    type: 'command', messageId: `command-${++sequence}`, openId: 'owner', threadId, content,
    isSlashCommand: true, timestamp: Date.now(), ...extra,
  } as any);
  const bind = (cards = false, tools = false) => handler.handleMessage({ type: 'binding_confirm', data: { success: true,
    capabilities: { scheduleResultsV1: true, taskRecovery: true, ...(cards ? { scheduleCardsV1: true } : {}), ...(tools ? { scheduleToolCardsV1: true } : {}) } } } as any);
  const responses = () => ws.send.mock.calls.map(([message]) => message).filter(message => message.type === 'response');
  return { cwd, threads, get handler() { return handler; }, pool, manager, ws, jobs, send, bind, responses, executor, config,
    acknowledgements, closeHandlers,
    restart: async () => { await handler.destroy(); handler = makeHandler(); scheduledMessages.clear(); ws.send.mockClear(); },
    setBackend: (value: string) => { backend = value; }, setSandbox: (value: { mode: string }) => { sandbox = value; },
    setExecutorBusy: (value: boolean) => { executorBusy = value; },
    disconnect: () => { connected = false; closeHandlers.forEach(handler => handler(1006, '')); },
    reconnect: async (cards = false) => { connected = true; await bind(cards); },
    scheduledResults: () => responses().filter(message => scheduledMessages.has(message.messageId)),
  };
}

describe('MessageHandler native schedule closed loop', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    native.create.mockReset();
    native.createDsh.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    f = await fixture();
  });
  afterEach(async () => { await f.handler.destroy(); await rm(f.cwd, { recursive: true, force: true }); vi.restoreAllMocks(); });

  const invoke = (name: string, args: Record<string, unknown>) => (f.handler as any).delegationBridges.get('thread-a').handler(name, args, 'native-call');
  const createArgs = { requestId: 'create-one', when: { kind: 'after', amount: 5, unit: 'm' }, prompt: 'Synthetic scheduled task' };

  it.each(['claude', 'agy', 'dsh'])('keeps %s schedule-list failures observational through text and model tools', async backend => {
    f.setBackend(backend); await f.bind();
    const service = await (f.handler as any).initializeSchedules() as ScheduleService;
    const owner = { threadId: 'thread-a', openId: 'owner', generation: (f.handler as any).scheduleGeneration('thread-a') };
    let admit: (() => boolean) | undefined;
    const create = f.executor.createNativeSchedule.getMockImplementation()!;
    f.executor.createNativeSchedule.mockImplementationOnce((input, emit, current, canAdmit) => {
      admit = canAdmit; return create(input, emit, current, canAdmit);
    });
    await service.create(owner, { id: 'read-only-task', backend: backend as 'claude' | 'agy' | 'dsh', cwd: f.cwd,
      prompt: 'Synthetic waiting task', rule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' } });
    const job = f.jobs[0];
    job.handle.list.mockRejectedValue(new Error('Synthetic native inventory timeout'));
    expect(admit?.()).toBe(true);
    await f.send('/schedule list');
    expect(f.responses().at(-1)).toMatchObject({ success: false, error: expect.stringContaining('Synthetic native inventory timeout') });
    expect((await service.list(owner))[0]).toMatchObject({ state: 'active' });
    expect(admit?.()).toBe(true);
    let listed: any;
    f.executor.execute.mockImplementationOnce(async () => {
      listed = await invoke('remote_cli_schedule_list', { requestId: 'read-only-list' });
      return { success: true };
    });
    await f.send('List the synthetic waiting task', 'thread-a', { isSlashCommand: false });
    expect(listed).toMatchObject({ status: 'failed', error: expect.stringContaining('Synthetic native inventory timeout') });
    expect((await service.list(owner))[0]).toMatchObject({ state: 'active' });
    expect(listed.nativeAction).toBeUndefined();
    expect(admit?.()).toBe(true);
    expect(job.handle.cancel).not.toHaveBeenCalled(); expect(job.handle.stop).not.toHaveBeenCalled();
    expect(job.handle.list).toHaveBeenCalledTimes(2);

    await service.recordReviewedCleanup(owner, ['read-only-task'], false);
    job.handle.list.mockClear();
    await f.send('/schedule list');
    expect((await service.list(owner))[0]).toMatchObject({ state: 'interrupted', cancelRequested: true });
    expect(job.handle.list).not.toHaveBeenCalled();
    expect(job.handle.cancel).not.toHaveBeenCalled(); expect(job.handle.stop).not.toHaveBeenCalled();
  });

  it.each([false, true])('awaits AGY native identity persistence through the production dispatcher (failure=%s)', async fail => {
    f.setBackend('agy');
    const service = await (f.handler as any).initializeSchedules() as ScheduleService;
    const owner = { threadId: 'thread-a', openId: 'owner', generation: (f.handler as any).scheduleGeneration('thread-a') };
    await service.create(owner, { id: 'agy-rebound', backend: 'agy', cwd: f.cwd, prompt: 'Synthetic task',
      rule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' } });
    const job = f.jobs[0];
    const previousNativeId = job.handle.nativeId;
    job.handle.nativeId = 'native-successor';
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const persisting = new Promise<void>(resolve => { entered = resolve; });
    const persist = (service as any).persist.bind(service);
    const failure = new Error('Synthetic catalog persistence failure');
    const persistence = vi.spyOn(service as any, 'persist').mockImplementationOnce(async () => {
      entered(); await gate;
      if (fail) throw failure;
      return persist();
    });
    try {
      const pending = (job.emit as (event: NativeScheduleEvent) => Promise<void>)({
        type: 'rebound', previousNativeId, nativeId: job.handle.nativeId,
      });
      expect(pending).toBeInstanceOf(Promise);
      let finished = false;
      const observed = pending.then(() => { finished = true; }, error => { finished = true; return error; });
      await persisting;
      expect(finished).toBe(false);
      const catalogFile = path.join((service as any).options.directory, SCHEDULE_CATALOG_FILE);
      expect(JSON.parse(await readFile(catalogFile, 'utf8')).records[0].nativeId).toBe(previousNativeId);
      release();
      expect(await observed).toBe(fail ? failure : undefined);
      expect(JSON.parse(await readFile(catalogFile, 'utf8')).records[0].nativeId).toBe(fail ? previousNativeId : 'native-successor');
    } finally {
      release(); persistence.mockRestore();
      if (fail) {
        await expect(service.destroy()).rejects.toBe(failure);
        // A fault deliberately retains the production catalog gate. Release only
        // this synthetic fixture's gate after verifying failed shutdown.
        (service as any).catalogGate?.close();
        vi.spyOn(service, 'destroy').mockResolvedValue();
      }
    }
  });

  it.each(['backend', 'unsupported-executor'])(
    'compacts a %s refusal before executor creation and fences it after reload', async reason => {
      const service = await (f.handler as any).initializeSchedules() as ScheduleService;
      const owner = { threadId: 'thread-a', openId: 'owner', generation: (f.handler as any).scheduleGeneration('thread-a') };
      const create = f.executor.createNativeSchedule;
      if (reason === 'backend') f.setBackend('dsh');
      else Object.assign(f.executor, { createNativeSchedule: undefined });
      await expect(service.create(owner, { id: 'preflight-refused', backend: 'claude', cwd: f.cwd, prompt: 'Synthetic task',
        rule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' } })).rejects.toBeInstanceOf(NativeScheduleNotAdmittedError);
      expect(create).not.toHaveBeenCalled(); expect(native.create).not.toHaveBeenCalled(); expect(native.createDsh).not.toHaveBeenCalled();
      expect(await service.list(owner)).toEqual([]);
      f.setBackend('claude'); Object.assign(f.executor, { createNativeSchedule: create });
      await f.restart();
      const restored = await (f.handler as any).initializeSchedules() as ScheduleService;
      expect(await restored.purge(owner, { ids: ['preflight-refused'] })).toMatchObject({
        removedIds: [], alreadyRemovedIds: ['preflight-refused'], nativeCleanupUnresolved: [], errors: [],
      });
      expect(await restored.purge(owner, { ids: ['preflight-refused'] })).toMatchObject({
        alreadyRemovedIds: ['preflight-refused'], nativeCleanupUnresolved: [], errors: [],
      });
      expect(await restored.listCleanup(owner)).toEqual([]); expect(create).not.toHaveBeenCalled();
    });

  it.each(['thread', 'backend', 'executor-lookup'])(
    'propagates a provider %s guard failure without invoking native creation or admission', async reason => {
      const service = await (f.handler as any).initializeSchedules();
      const value = { id: 'guarded', backend: 'claude', threadId: 'thread-a', cwd: f.cwd, prompt: 'Synthetic task',
        rule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' } };
      if (reason === 'thread') value.threadId = '';
      if (reason === 'backend') value.backend = 'unsupported-fixture';
      if (reason === 'executor-lookup') vi.spyOn(f.pool, 'getExecutor').mockImplementation(() => { throw new Error('Synthetic lookup refusal'); });
      const admit = vi.fn(() => true); const events = vi.fn();
      expect(() => service.options.provider.create(value, events, admit)).toThrow(NativeScheduleNotAdmittedError);
      expect(f.executor.createNativeSchedule).not.toHaveBeenCalled(); expect(native.create).not.toHaveBeenCalled();
      expect(admit).not.toHaveBeenCalled(); expect(events).not.toHaveBeenCalled();
    });

  it('keeps an ordinary error after executor dispatch uncertain despite missing native metadata', async () => {
    const service = await (f.handler as any).initializeSchedules() as ScheduleService;
    const owner = { threadId: 'thread-a', openId: 'owner', generation: (f.handler as any).scheduleGeneration('thread-a') };
    const failure = new Error('Synthetic error after native dispatch without a receipt');
    f.executor.createNativeSchedule.mockRejectedValueOnce(failure);
    await expect(service.create(owner, { id: 'uncertain', cwd: f.cwd, prompt: 'Synthetic task',
      rule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' } })).rejects.toBe(failure);
    expect(f.executor.createNativeSchedule).toHaveBeenCalledOnce();
    expect((await service.list(owner))[0].creationRefused).toBeUndefined();
    expect(await service.purge(owner, { ids: ['uncertain'] })).toMatchObject({
      removedIds: ['uncertain'], nativeCleanupUnresolved: [{ id: 'uncertain', reason: 'unattributed' }],
    });
    expect(await service.listCleanup(owner)).toHaveLength(1);
  });

  it('forwards the exact cleanup handle when executor creation may have mutated native state', async () => {
    const service = await (f.handler as any).initializeSchedules();
    const handle = { nativeId: 'unconfirmed-synthetic', list: vi.fn(), cancel: vi.fn(), stop: vi.fn() };
    const failure = new NativeScheduleCleanupError('Synthetic native mutation without a receipt', handle);
    f.executor.createNativeSchedule.mockRejectedValueOnce(failure);
    await expect(service.options.provider.create({ id: 'uncertain', threadId: 'thread-a', backend: 'claude', cwd: f.cwd,
      prompt: 'Synthetic task', rule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' } }, vi.fn())).rejects.toBe(failure);
    expect(failure.handle).toBe(handle); expect(failure).not.toBeInstanceOf(NativeScheduleNotAdmittedError);
    expect(f.executor.createNativeSchedule).toHaveBeenCalledOnce();
  });

  async function history(count = 1, attributed = true) {
    const owner = { threadId: 'thread-a', openId: 'owner', generation: (f.handler as any).scheduleGeneration('thread-a') };
    const records = Array.from({ length: count }, (_, index) => ({ ...owner, id: `historical-${index}`, backend: 'claude',
      cwd: f.cwd, state: 'interrupted', nativeId: `native-${index}`, prompt: 'Synthetic historical task', createdAt: Date.now(),
      rule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' },
      ...(attributed ? { recovery: { version: 1, provider: 'claude-session-skip-unadmitted-v1', strategy: 'reconstruct', status: 'blocked',
        identity: JSON.stringify({ marker: '11111111-1111-4111-8111-111111111111', sessionId: 'bound', threadId: owner.threadId, cwd: f.cwd }) } } : {}) }));
    const directory = (f.handler as any).scheduleDirectory();
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, SCHEDULE_CATALOG_FILE), JSON.stringify({ version: 3, records, pending: [], purged: [] }));
    return { owner, records, directory };
  }

  it.each(['claude', 'dsh'])('forgets exact residual tracking through text commands without native calls and retains replay fences', async backend => {
    const { directory, records } = await history(2, false);
    records.forEach(record => { record.backend = backend; });
    await writeFile(path.join(directory, SCHEDULE_CATALOG_FILE), JSON.stringify({ version: 3, records, pending: [], purged: [] }));
    f.setBackend(backend); await f.bind(); await f.send('/schedule purge all');
    const review = vi.fn(async () => { throw new Error('Forgetting tracking must not inspect native sessions'); });
    Object.assign(f.executor, { withReviewedNativeCleanup: review });
    f.executor.withNativeScheduleOperation.mockClear();
    await f.send('/schedule purge historical-0 --forget-unresolved', 'thread-a', { messageId: 'forget-fixed' });
    expect(f.responses().at(-1)).toMatchObject({ success: true, output: expect.stringContaining('Forgotten cleanup tracking: historical-0.') });
    expect(f.responses().at(-1).output).toContain('does not confirm native definition absence');
    const catalog = JSON.parse(await readFile(path.join(directory, SCHEDULE_CATALOG_FILE), 'utf8'));
    expect(catalog.cleanup.map((entry: any) => entry.id)).toEqual(['historical-1']);
    expect(catalog.purged.map((entry: any) => entry.id)).toEqual(['historical-0', 'historical-1']);
    expect(review).not.toHaveBeenCalled(); expect(f.executor.withNativeScheduleOperation).not.toHaveBeenCalled();
    expect(native.create).not.toHaveBeenCalled(); expect(native.createDsh).not.toHaveBeenCalled();
    await f.restart(); await f.bind(); await f.send('/schedule list');
    expect(f.responses().at(-1).output).toContain('historical-1');
    expect(f.responses().at(-1).output).not.toContain('historical-0');
    await f.send('/schedule purge historical-0 --forget-unresolved', 'thread-a', { messageId: 'forget-fixed' });
    expect(f.responses().at(-1).success).toBe(true);
    expect(f.responses().at(-1).output).toContain('does not confirm native definition absence');
    await f.send('/schedule purge historical-0', 'thread-a', { messageId: 'forget-fixed' });
    expect(f.responses().at(-1).error).toContain('different selection');
  });

  it('routes model-requested forgetting without native admission and reports unresolved native status honestly', async () => {
    const { directory } = await history(2, false);
    await f.bind(); await f.send('/schedule purge all');
    const review = vi.fn(); Object.assign(f.executor, { withReviewedNativeCleanup: review });
    f.executor.withNativeScheduleOperation.mockClear();
    let reply: any, repeated: any, listed: any;
    f.executor.execute.mockImplementationOnce(async () => {
      const args = { requestId: 'forget-residue', scheduleIds: ['historical-0'], forgetUnresolved: true };
      reply = await invoke('remote_cli_schedule_purge', args);
      repeated = await invoke('remote_cli_schedule_purge', args);
      listed = await invoke('remote_cli_schedule_list', { requestId: 'remaining' });
      return { success: true };
    });
    await f.send('Forget the selected synthetic residual tracking', 'thread-a', { isSlashCommand: false });
    expect(reply).toMatchObject({ status: 'succeeded', purge: { status: 'complete', forgottenCleanupIds: ['historical-0'],
      nativeCleanupUnresolved: [], warning: expect.stringContaining('does not confirm native definition absence') } });
    expect(repeated).toEqual(reply);
    expect(listed.nativeCleanupUnresolved.map((entry: any) => entry.id)).toEqual(['historical-1']);
    expect(review).not.toHaveBeenCalled(); expect(f.executor.withNativeScheduleOperation).not.toHaveBeenCalled();
    const catalog = JSON.parse(await readFile(path.join(directory, SCHEDULE_CATALOG_FILE), 'utf8'));
    expect(catalog.cleanup.map((entry: any) => entry.id)).toEqual(['historical-1']);
    expect(catalog.purged).toHaveLength(2);
  });

  it.each(['claude', 'dsh'])('removes fifteen unattributed %s histories through production text and tool paths while keeping native uncertainty', async backend => {
    const { directory, records } = await history(15, false);
    records.forEach(record => { record.backend = backend; });
    await writeFile(path.join(directory, SCHEDULE_CATALOG_FILE), JSON.stringify({ version: 3, records, pending: records.map(record => ({ id: `${record.id}:result`, scheduleId: record.id, occurrenceId: 'result', success: true, output: 'Synthetic queued result' })), purged: [] }));
    f.setBackend(backend);
    const cleanup = vi.fn(); Object.assign(f.executor, { withReviewedNativeCleanup: cleanup });
    // No autonomous result transport is negotiated: the persisted outbox must
    // be deleted by purge, not by a synthetic acknowledgement during binding.
    await f.handler.handleMessage({ type: 'binding_confirm', data: { success: true, capabilities: {} } } as any);
    let reply: any, repeated: any, listed: any;
    if (backend === 'claude') {
      await f.send('/schedule purge all');
      const response = f.responses().at(-1);
      expect(response.success).toBe(false); // History removed is not complete native cleanup.
      expect(response.output.match(/Native cleanup unresolved historical-/g)).toHaveLength(15);
      expect(response.output).not.toContain('Removed history: none.');
    } else {
      f.executor.execute.mockImplementationOnce(async () => {
        reply = await invoke('remote_cli_schedule_purge', { requestId: 'erase-history', all: true });
        repeated = await invoke('remote_cli_schedule_purge', { requestId: 'erase-history', all: true });
        listed = await invoke('remote_cli_schedule_list', { requestId: 'list-cleanup' });
        return { success: true };
      });
      await f.handler.handleMessage({ type: 'command', messageId: 'model-history', threadId: 'thread-a', openId: 'owner', content: 'Delete synthetic history', timestamp: Date.now() } as any);
      expect(repeated).toEqual(reply);
      expect(listed.records).toEqual([]); expect(listed.nativeCleanupUnresolved).toHaveLength(15);
      expect(reply.purge.status).toBe('partial');
      expect(reply.purge.historyRemovedIds).toHaveLength(15);
      expect(reply.purge.nativeCleanupUnresolved).toHaveLength(15);
    }
    const catalog = JSON.parse(await readFile(path.join(directory, SCHEDULE_CATALOG_FILE), 'utf8'));
    expect(catalog.version).toBe(5); expect(catalog.records).toEqual([]); expect(catalog.pending).toEqual([]);
    expect(catalog.cleanup).toHaveLength(15); expect(catalog.purged).toHaveLength(15);
    expect(JSON.stringify(catalog)).not.toContain('Synthetic historical task');
    expect(JSON.stringify(catalog)).not.toContain('Synthetic queued result');
    expect(f.scheduledResults()).toEqual([]);
    expect(catalog.cleanup.every((item: any) => item.historyRemoved && !item.attribution)).toBe(true);
    await f.restart(); await f.bind(); await f.send('/schedule list');
    expect(f.responses().at(-1).output).toContain('Native cleanup tracking (history removed');
    await f.send('/schedule purge all');
    expect(f.responses().at(-1).output).toContain('Already removed: historical-0');
    expect(JSON.parse(await readFile(path.join(directory, SCHEDULE_CATALOG_FILE), 'utf8')).records).toEqual([]);
    expect(cleanup).not.toHaveBeenCalled(); expect(native.create).not.toHaveBeenCalled(); expect(native.createDsh).not.toHaveBeenCalled();
  });

  it.each(['predecessor', 'session', 'stale', 'present', 'timeout'])('keeps cleanup tracking for %s uncertainty in the production purge command', async reason => {
    const { directory } = await history();
    Object.assign(f.executor, { withReviewedNativeCleanup: async (_id: string, current: () => boolean, run: any) => run({
      binding: 'host', sessionId: reason === 'session' ? 'different' : 'bound', cwd: f.cwd,
      current, retirementConfirmed: () => reason !== 'predecessor', inventory: async () => {
        if (reason === 'timeout') throw new Error('Synthetic native inventory receipt timeout');
        if (reason === 'stale') f.disconnect();
        return reason === 'present' ? [{ id: 'native-0', prompt: 'Changed definition', cron: '* * * * *' }] : [];
      }, remove: vi.fn(),
    }) });
    await f.bind(); await f.send('/schedule purge historical-0');
    const catalog = JSON.parse(await readFile(path.join(directory, SCHEDULE_CATALOG_FILE), 'utf8'));
    if (reason === 'stale' || reason === 'timeout') {
      expect(catalog.records).toHaveLength(1); expect(catalog.purged ?? []).toEqual([]);
    } else {
      expect(catalog.records).toEqual([]); expect(catalog.cleanup).toHaveLength(1); expect(catalog.purged).toHaveLength(1);
    }
    expect(native.create).not.toHaveBeenCalled();
    if (reason !== 'stale') expect(f.responses().at(-1).success).toBe(false);
  });

  it('retains history while a late native mutation is unsettled, then removes it on explicit retry', async () => {
    const { directory } = await history(15, false);
    let pending = true;
    Object.assign(f.executor, { hasPendingScheduleMutation: () => pending });
    await f.bind(); await f.send('/schedule purge all');
    expect(JSON.parse(await readFile(path.join(directory, SCHEDULE_CATALOG_FILE), 'utf8')).records).toHaveLength(15);
    expect(f.responses().at(-1).output).toContain('Pending historical-0');
    pending = false; await f.send('/schedule purge all');
    expect(JSON.parse(await readFile(path.join(directory, SCHEDULE_CATALOG_FILE), 'utf8')).records).toEqual([]);
    expect(f.responses().at(-1).output).toContain('Native cleanup unresolved historical-0');
  });

  it('replays a production purge-all selection after restart without selecting a newer sibling', async () => {
    const { directory } = await history(1, false);
    await f.bind();
    await f.send('/schedule purge all', 'thread-a', { messageId: 'fixed-purge-request' });
    await f.send('/schedule after 5m -- Synthetic later sibling');
    const sibling = f.jobs[0];
    await f.restart(); await f.bind();
    await f.send('/schedule purge all', 'thread-a', { messageId: 'fixed-purge-request' });
    const catalog = JSON.parse(await readFile(path.join(directory, SCHEDULE_CATALOG_FILE), 'utf8'));
    expect(catalog.records.map((record: any) => record.id)).toEqual([sibling.input.id]);
    expect(catalog.records[0].cancelRequested).not.toBe(true);
    expect(catalog.purgeRequests).toHaveLength(1); expect(sibling.handle.cancel).not.toHaveBeenCalled();
    expect(f.responses().at(-1).output).toContain('Already removed: historical-0');
    await f.send(`/schedule purge ${sibling.input.id}`, 'thread-a', { messageId: 'fixed-purge-request' });
    expect(f.responses().at(-1).error).toContain('different selection');
  });

  it.each(['claude', 'dsh'])('keeps unattributed %s cleanup visible and retriable after context reset and restart', async backend => {
    const { directory, records } = await history(15, false);
    records.forEach(record => { record.backend = backend; });
    await writeFile(path.join(directory, SCHEDULE_CATALOG_FILE), JSON.stringify({ version: 3, records, pending: [], purged: [] }));
    f.setBackend(backend); await f.bind(); await f.send('/schedule purge all');
    const originalGeneration = records[0].generation;
    await f.send('/clear');
    expect(f.pool.clearThreadContext).toHaveBeenCalledOnce();
    expect((f.handler as any).scheduleGeneration('thread-a')).not.toBe(originalGeneration);
    await f.restart(); await f.bind(); await f.send('/schedule list');
    expect(f.responses().at(-1).output).toContain('historical-0');
    await f.send('/schedule purge all');
    expect(f.responses().at(-1).output.match(/Native cleanup unresolved historical-/g)).toHaveLength(15);
    await f.send('/schedule purge historical-0');
    expect(f.responses().at(-1).output).toContain('Already removed: historical-0');
    const catalog = JSON.parse(await readFile(path.join(directory, SCHEDULE_CATALOG_FILE), 'utf8'));
    expect(catalog.cleanup).toHaveLength(15); expect(catalog.records).toEqual([]);
    expect(catalog.cleanup.every((item: any) => item.generation === originalGeneration)).toBe(true);
    await f.send('/schedule purge historical-0', 'thread-a', { openId: 'another-owner' });
    expect(f.responses().at(-1).output).toContain('Schedule not found for this owner');
    expect(native.create).not.toHaveBeenCalled(); expect(native.createDsh).not.toHaveBeenCalled();
  });

  it('allows reset without losing attributed DSH cleanup when no supported session cleanup route exists', async () => {
    const { directory, records } = await history();
    records[0].backend = 'dsh';
    records[0].recovery!.provider = 'dsh-session-orderly-v1';
    await writeFile(path.join(directory, SCHEDULE_CATALOG_FILE), JSON.stringify({ version: 3, records, pending: [], purged: [] }));
    f.setBackend('dsh'); await f.bind(); await f.send('/schedule purge all');
    const before = JSON.parse(await readFile(path.join(directory, SCHEDULE_CATALOG_FILE), 'utf8'));
    expect(before.cleanup[0].attribution.sessionId).toBe('bound');
    await f.send('/clear'); expect(f.pool.clearThreadContext).toHaveBeenCalledOnce();
    await f.restart(); await f.bind(); await f.send('/schedule purge historical-0');
    expect(f.responses().at(-1).output).toContain('Native cleanup unresolved historical-0 (predecessor_unknown)');
    expect(JSON.parse(await readFile(path.join(directory, SCHEDULE_CATALOG_FILE), 'utf8')).cleanup).toEqual(before.cleanup);
  });

  it('preserves an attributable cleanup route on reset even after restart without result capability', async () => {
    await history(); await f.bind(); await f.send('/schedule purge all');
    await f.restart();
    await f.handler.handleMessage({ type: 'binding_confirm', data: { success: true, capabilities: {} } } as any);
    await f.send('/clear');
    expect(f.responses().at(-1).error).toContain('original session');
    expect(f.pool.clearThreadContext).not.toHaveBeenCalled();
    Object.assign(f.executor, { withReviewedNativeCleanup: async (_id: string, current: () => boolean, run: any) => run({
      binding: 'host', sessionId: 'bound', cwd: f.cwd, current, retirementConfirmed: () => true,
      inventory: async () => [], remove: vi.fn(),
    }) });
    await f.send('/schedule purge historical-0'); expect(f.responses().at(-1).success).toBe(true);
    await f.send('/clear'); expect(f.pool.clearThreadContext).toHaveBeenCalledOnce();
  });

  it.each(['clean', 'error-after-commit', 'predecessor'])('retries exact native cleanup after history erasure and restart: %s', async mode => {
    const { directory } = await history();
    const target = { id: 'native-0', prompt: '[remote-cli:11111111-1111-4111-8111-111111111111]\nSynthetic historical task',
      cron: '* * * * *', recurring: true, durable: false };
    const sibling = { id: 'native-sibling', prompt: 'Synthetic sibling', cron: '* * * * *', recurring: true, durable: false };
    let entries = [target, sibling], retired = mode !== 'predecessor';
    const remove = vi.fn(async (entry: any) => {
      entries = entries.filter(item => item.id !== entry.id);
      if (mode === 'error-after-commit') throw new Error('Synthetic lost deletion response');
    });
    Object.assign(f.executor, { withReviewedNativeCleanup: async (_id: string, current: () => boolean, run: any) => run({
      binding: 'host', sessionId: 'bound', cwd: f.cwd, current, retirementConfirmed: () => retired,
      inventory: async () => structuredClone(entries), remove,
    }) });
    await f.bind(); await f.send('/schedule purge historical-0');
    let stored = JSON.parse(await readFile(path.join(directory, SCHEDULE_CATALOG_FILE), 'utf8'));
    expect(stored.records).toEqual([]); expect(stored.cleanup).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain('Synthetic historical task');
    await f.restart(); await f.bind();
    await f.send('/schedule purge historical-0');
    expect(entries).toEqual([sibling]); expect(remove).toHaveBeenCalledOnce();
    stored = JSON.parse(await readFile(path.join(directory, SCHEDULE_CATALOG_FILE), 'utf8'));
    if (mode === 'predecessor') {
      expect(stored.cleanup[0].reason).toBe('predecessor_unknown');
      expect(f.responses().at(-1).success).toBe(false); retired = true;
      await f.send('/schedule purge historical-0');
    }
    expect(f.responses().at(-1).success).toBe(true);
    stored = JSON.parse(await readFile(path.join(directory, SCHEDULE_CATALOG_FILE), 'utf8'));
    expect(stored.cleanup ?? []).toEqual([]); expect(stored.purged).toHaveLength(1);
    await f.send('/schedule purge historical-0'); expect(remove).toHaveBeenCalledOnce();
    expect(native.create).not.toHaveBeenCalled();
  });

  it('keeps a model purge correlated to its pending native action and stable retry receipt', async () => {
    await history();
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    let operation: string | undefined, queried = false;
    const inventory = vi.fn(async () => { queried = true; await ready; return []; });
    Object.assign(f.executor, {
      nativeScheduleAction: (id: string) => id === operation && queried ? { tool: 'CronList', input: {} } : undefined,
      withReviewedNativeCleanup: async (id: string, current: () => boolean, run: any, inTurn: boolean) => {
        if (!inTurn) throw new Error('Expected the current managed turn');
        operation = id;
        return run({ binding: 'host', sessionId: 'bound', cwd: f.cwd, current, retirementConfirmed: () => true, inventory, remove: vi.fn() });
      },
    });
    const replies: any[] = [];
    f.executor.execute.mockImplementation(async () => {
      try {
        replies.push(await invoke('remote_cli_schedule_purge', { requestId: 'purge-history', scheduleIds: ['historical-0'] }));
        release();
        replies.push(await invoke('remote_cli_schedule_operation', { requestId: 'purge-history' }));
        replies.push(await invoke('remote_cli_schedule_purge', { requestId: 'purge-history', scheduleIds: ['historical-0'] }));
        return { success: true };
      } finally { release(); }
    });
    await f.bind(); await f.send('Remove the synthetic selected history', 'thread-a', { isSlashCommand: false });
    expect(f.responses().at(-1).success).toBe(true);
    expect(replies[0]).toMatchObject({ status: 'pending', nativeAction: { tool: 'CronList', input: {} } });
    expect(replies[1]).toMatchObject({ status: 'succeeded', purge: { removedIds: ['historical-0'], pending: [] } });
    expect(replies[2]).toEqual(replies[1]); expect(inventory).toHaveBeenCalledOnce();
  });

  it.each([false, true])('purges persisted attributed history after reviewed deletion (restart before purge=%s)', async restartBeforePurge => {
    const owner = { threadId: 'thread-a', openId: 'owner', generation: (f.handler as any).scheduleGeneration('thread-a') };
    const marker = '11111111-1111-4111-8111-111111111111';
    const record = { ...owner, id: 'legacy-attributed', backend: 'claude', cwd: f.cwd, state: 'interrupted', nativeId: 'native-old',
      prompt: 'Synthetic historical task', createdAt: Date.now(), rule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' },
      recovery: { version: 1, provider: 'claude-session-skip-unadmitted-v1', strategy: 'reconstruct', status: 'blocked',
        identity: JSON.stringify({ marker, sessionId: 'bound', threadId: owner.threadId, cwd: f.cwd }) } };
    const directory = (f.handler as any).scheduleDirectory();
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, SCHEDULE_CATALOG_FILE), JSON.stringify({ version: 3, records: [record], pending: [], purged: [] }));
    let rows = [{ id: 'native-old', prompt: `[remote-cli:${marker}]\n${record.prompt}`, cron: '* * * * *', recurring: true, durable: false },
      { id: 'native-sibling', prompt: 'Synthetic unrelated task', cron: '* * * * *', recurring: true, durable: false }];
    const inventory = vi.fn(async () => structuredClone(rows));
    let retired = restartBeforePurge;
    Object.assign(f.executor, { getSessionId: () => 'bound',
      withReviewedNativeCleanup: async (_id: string, current: () => boolean, run: any) => run({ binding: 'host', sessionId: 'bound', cwd: f.cwd,
        current, retirementConfirmed: () => retired, inventory, remove: async (target: any) => { rows = rows.filter(row => row.id !== target.id); } }) });
    await f.bind();
    await f.send('/schedule cleanup review');
    const token = /cleanup confirm ([a-f0-9-]{36})/.exec(f.responses().at(-1).output)![1];
    await f.send(`/schedule cleanup confirm ${token} delete-old native-old`);
    expect(f.responses().at(-1).success).toBe(true);
    if (restartBeforePurge) {
      await f.restart(); await f.bind();
      inventory.mockRejectedValue(new Error('Durable cleanup must not need another host inventory'));
    }
    retired = true;
    await f.send('/schedule purge legacy-attributed');
    expect(f.responses().at(-1)).toMatchObject({ success: true, output: expect.stringContaining('Removed history: legacy-attributed.') });
    expect(rows.map(row => row.id)).toEqual(['native-sibling']);
    expect(native.create).not.toHaveBeenCalled();
    await f.restart(); await f.bind(); await f.send('/schedule list');
    expect(f.responses().at(-1).output).toContain('No schedules');
    await f.send('/schedule purge legacy-attributed');
    expect(f.responses().at(-1).output).toContain('Already removed: legacy-attributed.');
  });

  it.each(['claude', 'dsh'])('purges selected %s history through the text command and preserves siblings', async backend => {
    f.setBackend(backend); await f.bind(true, true);
    await f.send('/schedule after 5m -- Synthetic selected task');
    await f.send('/schedule after 6m -- Synthetic sibling task');
    const selected = f.jobs[0].input.id, sibling = f.jobs[1].input.id;
    await f.send(`/schedule purge ${selected}`);
    expect(f.responses().at(-1)).toMatchObject({ success: true, output: expect.stringContaining(`Removed history: ${selected}`) });
    expect(f.jobs[0].handle.cancel).toHaveBeenCalledOnce();
    expect(f.jobs[1].handle.cancel).not.toHaveBeenCalled();
    const stored = JSON.parse(await readFile(path.join((f.handler as any).scheduleDirectory(), SCHEDULE_CATALOG_FILE), 'utf8'));
    expect(stored.records.map((record: any) => record.id)).toEqual([sibling]);
    await f.send(`/schedule purge ${selected}`);
    expect(f.responses().at(-1).output).toContain(`Already removed: ${selected}`);
    expect(f.jobs[0].handle.cancel).toHaveBeenCalledOnce();
  });

  it('allows model-reviewed native deletion without a manually typed confirmation and preserves unselected tasks', async () => {
    await f.bind(true, true);
    let rows = ['selected-native', 'sibling-native'].map(id => ({ id, prompt: `Synthetic ${id}`, cron: '* * * * *', durable: false }));
    const remove = vi.fn(async (target: any) => { rows = rows.filter(row => row.id !== target.id); });
    Object.assign(f.executor, { getSessionId: () => 'bound',
      withReviewedNativeCleanup: vi.fn(async (_id: string, current: () => boolean, run: any, inTurn: boolean) => {
        expect(inTurn).toBe(true);
        return run({ binding: 'host', sessionId: 'bound', current, inventory: async () => structuredClone(rows), remove });
      }) });
    f.executor.execute.mockImplementation(async () => {
      const review: any = await invoke('remote_cli_schedule_cleanup_review', { requestId: 'review-direct' });
      const args = { requestId: 'delete-direct', token: review.cleanupReview.token, nativeIds: ['selected-native'] };
      expect(await invoke('remote_cli_schedule_cleanup_delete', args)).toMatchObject({ status: 'succeeded', cleanup: { absentIds: ['selected-native'] } });
      expect(await invoke('remote_cli_schedule_cleanup_delete', args)).toMatchObject({ status: 'succeeded' });
      expect(remove).toHaveBeenCalledOnce();
      return { success: true };
    });
    await f.send('Delete the selected synthetic native task', 'thread-a', { isSlashCommand: false });
    expect(f.responses().at(-1).success).toBe(true);
    expect(rows.map(row => row.id)).toEqual(['sibling-native']);
  });

  it('rejects purge if model settings change before native cleanup admission', async () => {
    await f.bind(); await f.send('/schedule after 5m -- Synthetic purge task');
    f.executor.withNativeScheduleOperation.mockImplementationOnce(async (_id, current, run) => {
      f.threads[0].models = { claude: 'changed-model' };
      expect(current()).toBe(false);
      return run();
    });
    await f.send(`/schedule purge ${f.jobs[0].input.id}`);
    expect(f.responses().at(-1).success).toBe(false);
    expect(f.jobs[0].handle.cancel).not.toHaveBeenCalled();
  });

  it('routes model purge through native admission and removes history without user confirmation', async () => {
    await f.bind(true, true);
    await f.send('/schedule after 5m -- Synthetic purge task');
    const selected = f.jobs[0].input.id;
    f.executor.execute.mockImplementation(async () => {
      const result: any = await invoke('remote_cli_schedule_purge', { requestId: 'purge-direct', scheduleIds: [selected] });
      expect(result).toMatchObject({ status: 'succeeded', purge: { removedIds: [selected], pending: [], errors: [] } });
      expect(await invoke('remote_cli_schedule_purge', { requestId: 'purge-direct', scheduleIds: [selected] })).toEqual(result);
      return { success: true };
    });
    await f.send('Purge the selected synthetic schedule', 'thread-a', { isSlashCommand: false });
    expect(f.responses().at(-1).success).toBe(true);
    expect(f.jobs[0].handle.cancel).toHaveBeenCalledOnce();
  });

  it('routes read-only cleanup review through the authenticated tool scope without deleting tasks', async () => {
    await f.bind(true, true);
    const rows = [{ id: 'native-only', prompt: 'Synthetic native-only task', cron: '* * * * *', durable: true }];
    const remove = vi.fn();
    Object.assign(f.executor, { getSessionId: () => 'bound',
      withReviewedNativeCleanup: vi.fn(async (_id: string, current: () => boolean, run: any, inTurn: boolean) => {
        expect(inTurn).toBe(true);
        return run({ binding: 'host', sessionId: 'bound', current, inventory: async () => rows, remove });
      }) });
    f.executor.execute.mockImplementation(async () => {
      expect(await invoke('remote_cli_schedule_cleanup_review', { requestId: 'review' })).toMatchObject({
        status: 'succeeded', cleanupReview: { sessionId: 'bound', candidates: rows, token: expect.any(String) },
      });
      await expect(invoke('remote_cli_schedule_cleanup_confirm', { requestId: 'model-confirm' })).rejects.toThrow('Unknown');
      return { success: true };
    });
    await f.send('Review synthetic legacy native schedules', 'thread-a', { isSlashCommand: false });
    expect(f.responses().at(-1).success).toBe(true); expect(remove).not.toHaveBeenCalled();
  });
  it('exposes authoritative cleanup review and authenticated confirmation without a legacy catalog mapping', async () => {
    await f.bind();
    let rows = [{ id: 'native-legacy', prompt: 'Synthetic legacy definition', cron: '* * * * *', recurring: true, durable: false },
      { id: 'native-sibling', prompt: 'Synthetic sibling', cron: '* * * * *', recurring: true, durable: false }];
    const remove = vi.fn(async (target: any) => { rows = rows.filter(row => row.id !== target.id); });
    Object.assign(f.executor, { getSessionId: () => 'synthetic-bound-session',
      withReviewedNativeCleanup: vi.fn(async (_id: string, current: () => boolean, run: any) => run({
        binding: 'host', sessionId: 'synthetic-bound-session', current,
        inventory: async () => structuredClone(rows), remove,
      })) });
    const service = await (f.handler as any).initializeSchedules();
    const owner = { threadId: 'thread-a', openId: 'owner', generation: (f.handler as any).scheduleGeneration('thread-a') };
    const legacy = { ...owner, id: 'legacy-row', backend: 'claude', cwd: f.cwd, state: 'interrupted',
      nativeId: 'native-legacy', prompt: 'Synthetic legacy definition', createdAt: Date.now(),
      rule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' } };
    service.records.set(legacy.id, legacy); await service.persist();
    await f.send('/schedule cleanup review');
    const output = f.responses().at(-1).output;
    expect(output).toContain('Synthetic legacy definition'); expect(output).toContain('Predecessor');
    const token = /cleanup confirm ([a-f0-9-]{36})/.exec(output)![1];
    expect(output).toContain(`/schedule cleanup confirm ${token} cleanup-${token} native-legacy,native-sibling`);
    expect(output).not.toContain('<request-id>');
    await f.send(`/schedule cleanup confirm ${token} explicit-owner-request native-legacy`);
    expect(f.responses().at(-1)).toMatchObject({ success: true, output: expect.stringContaining('Verified absent') });
    expect(rows.map(row => row.id)).toEqual(['native-sibling']);
    expect((await service.list(owner))[0]).toEqual(legacy);
    await f.send(`/schedule cleanup confirm ${token} explicit-owner-request native-legacy`);
    expect(remove).toHaveBeenCalledTimes(1);
    await f.send('/schedule cleanup review'); const next = /cleanup confirm ([a-f0-9-]{36})/.exec(f.responses().at(-1).output)![1];
    f.disconnect(); await f.reconnect();
    await f.send(`/schedule cleanup confirm ${next} second native-sibling`);
    expect(f.responses().at(-1).success).toBe(false); expect(remove).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])('omits a confirmation command when review has no eligible tasks (project task=%s)', async project => {
    await f.bind();
    const rows = project ? [{ id: 'project-task', prompt: 'Synthetic project task', cron: '* * * * *' }] : [];
    Object.assign(f.executor, { getSessionId: () => 'bound', withReviewedNativeCleanup: async (_id: string, current: () => boolean, run: any) =>
      run({ binding: 'host', sessionId: 'bound', current, inventory: async () => rows, remove: vi.fn() }) });
    await f.send('/schedule cleanup review');
    expect(f.responses().at(-1)).toMatchObject({ success: true, output: expect.stringContaining('No eligible tasks to delete') });
    expect(f.responses().at(-1).output).not.toContain('/schedule cleanup confirm');
    if (project) expect(f.responses().at(-1).output).toContain('project-persisted; deletion unavailable here');
  });
  it('persists only cancellation intent and observed absence for exactly attributable rows', async () => {
    await f.bind();
    const service = await (f.handler as any).initializeSchedules();
    const owner = { threadId: 'thread-a', openId: 'owner', generation: (f.handler as any).scheduleGeneration('thread-a') };
    const marker = '11111111-1111-4111-8111-111111111111';
    const identity = JSON.stringify({ sessionId: 'bound', threadId: owner.threadId, cwd: f.cwd, marker });
    const record = { ...owner, id: 'attributable', backend: 'claude', cwd: f.cwd, state: 'interrupted', nativeId: 'native-a',
      prompt: 'Synthetic attributed prompt', createdAt: Date.now(), rule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' },
      recovery: { version: 1, provider: 'claude-session-skip-unadmitted-v1', strategy: 'reconstruct', identity, status: 'blocked' } };
    service.records.set(record.id, record); await service.persist();
    let rows = [{ id: 'native-a', prompt: `[remote-cli:${marker}]\n${record.prompt}`, cron: '* * * * *', recurring: true, durable: false }];
    Object.assign(f.executor, { getSessionId: () => 'bound',
      withReviewedNativeCleanup: async (_id: string, current: () => boolean, run: any) => run({ binding: 'host', sessionId: 'bound', current,
        inventory: async () => structuredClone(rows), remove: async () => {
          expect((await service.list(owner))[0].cancelRequested).toBe(true); rows = [];
        } }) });
    await f.send('/schedule cleanup review'); const token = /cleanup confirm ([a-f0-9-]{36})/.exec(f.responses().at(-1).output)![1];
    await f.send(`/schedule cleanup confirm ${token} explicit native-a`);
    expect(f.responses().at(-1).success).toBe(true);
    expect((await service.list(owner))[0]).toMatchObject({ state: 'interrupted', cancelRequested: true,
      error: expect.stringContaining('predecessor work remains unknown'), recovery: { identity, status: 'blocked' } });
    const stored = JSON.parse(await readFile(path.join(service.options.directory, SCHEDULE_CATALOG_FILE), 'utf8'));
    expect(stored.records[0].recovery.identity).toBe(identity);
    expect(stored.records[0].recovery).not.toHaveProperty('nativeDefinitionAbsent');
    await expect(service.recordReviewedCleanup({ ...owner, generation: 'retired-generation' }, [record.id], true)).rejects.toThrow('owner changed');
  });
  it('refuses cleanup without an authenticated bound session or while busy', async () => {
    await f.bind();
    await f.send('/schedule cleanup review'); expect(f.responses().at(-1).success).toBe(false);
    Object.assign(f.executor, { withReviewedNativeCleanup: vi.fn(), getSessionId: () => null });
    await f.send('/schedule cleanup review'); expect(f.responses().at(-1).error).toContain('No bound Claude session');
    Object.assign(f.executor, { getSessionId: () => 'bound' }); f.setExecutorBusy(true);
    await f.send('/schedule cleanup review'); expect(f.responses().at(-1).error).toContain('busy');
    f.setExecutorBusy(false); f.setBackend('dsh');
    await f.send('/schedule cleanup review'); expect(f.responses().at(-1).error).toContain('bound to Claude');
    expect((f.executor as any).withReviewedNativeCleanup).not.toHaveBeenCalled();
  });
  it('passes a live admission fence to the foreground executor before cancellation cleanup', async () => {
    await f.bind(); await f.send('/schedule after 5m -- Synthetic future work');
    const [, , ownerCurrent, admit] = f.executor.createNativeSchedule.mock.calls[0];
    expect(ownerCurrent!()).toBe(true); expect(admit!()).toBe(true);
    f.jobs[0].handle.cancel.mockRejectedValue(new Error('Synthetic deletion failure'));
    await f.send(`/schedule cancel ${f.jobs[0].input.id}`);
    expect(ownerCurrent!()).toBe(true);
    expect(admit!()).toBe(false);
  });

  it.each([undefined, 'drain-all', 'skip-unadmitted'])('describes the negotiated recovery policy (%s) after creation', async policy => {
    if (policy) Object.assign(f.executor, { nativeScheduleRecovery: {
      provider: 'synthetic-recovery', strategy: 'reconstruct', handoffPolicy: policy,
      describe: () => 'synthetic-original-owner', reconcile: vi.fn(),
    } });
    await f.bind(); await f.send('/schedule after 5m -- Synthetic future work');
    const response = f.responses().at(-1);
    expect(response.success).toBe(true);
    expect(response.output).toContain(policy ? 'recover automatically after a confirmed orderly restart' : 'does not support automatic schedule recovery');
    if (policy === 'skip-unadmitted') expect(response.output).toContain('may be skipped without replay');
    if (policy === 'drain-all') expect(response.output).toContain('Queued and executing occurrences must finish');
  });

  it('prepares slash creation on the foreground bridge reused by subsequent chat without a dedicated Claude provider', async () => {
    await f.bind(true, true);
    await f.send('/schedule after 5m -- Use future conversation updates');
    expect(f.jobs[0].input.threadId).toBe('thread-a');
    expect(f.executor.withNativeScheduleOperation).toHaveBeenCalledWith(expect.any(String), expect.any(Function), expect.any(Function), false);
    const connection = f.executor.configureManagedTools.mock.calls[0][0];
    expect(connection.groups).toEqual(['scheduling']);
    expect(f.executor.configureManagedTools.mock.invocationCallOrder[0]).toBeLessThan(native.create.mock.invocationCallOrder[0]);
    await f.send('Additional context for the future task', 'thread-a', { isSlashCommand: false });
    expect(f.executor.configureManagedTools.mock.calls.at(-1)![0]).toEqual(connection);
    expect(native.create).toHaveBeenCalledOnce(); expect(f.jobs[0].handle.stop).not.toHaveBeenCalled();
  });

  it('does not start shared native management for an empty list or unknown cancellation', async () => {
    await f.bind(); await f.send('/schedule list');
    await f.send('/schedule cancel unknown-synthetic-job');
    expect(f.executor.withNativeScheduleOperation).not.toHaveBeenCalled();
    expect(f.executor.configureManagedTools).not.toHaveBeenCalled(); expect(native.create).not.toHaveBeenCalled();
  });

  it('scopes interrupted legacy cancellation and reports missing native ownership without claiming success', async () => {
    await f.bind(); await f.send('/schedule after 5m -- Synthetic future work');
    const id = f.jobs[0].input.id;
    await f.restart();
    Object.assign(f.executor, { nativeScheduleRecovery: { provider: 'fixture-recovery', strategy: 'reconstruct',
      describe: () => 'fixture-identity', reconcile: vi.fn(), cancelRetained: vi.fn() } });
    await f.bind(); f.executor.withNativeScheduleOperation.mockClear();
    await f.send(`/schedule cancel ${id}`);
    expect(f.executor.withNativeScheduleOperation).toHaveBeenCalledWith(expect.any(String), expect.any(Function), expect.any(Function), false);
    expect(f.responses().at(-1)).toMatchObject({ success: false });
    expect(f.responses().at(-1).error).toContain('ownership metadata');
    expect(native.create).toHaveBeenCalledOnce();
  });

  it('drains a confirmed foreground queue when an autonomous native occurrence completes', async () => {
    await f.bind(); await f.send('/schedule after 2m -- Synthetic queued occurrence');
    f.setExecutorBusy(true);
    f.jobs[0].emit({ type: 'started', occurrenceId: 'occurrence-1' });
    await f.send('Foreground message waiting behind the native occurrence', 'thread-a', { isSlashCommand: false });
    const confirmation = f.responses().at(-1).queueConfirmation;
    expect(confirmation).toBeDefined();
    await f.send(`/queue confirm ${confirmation.id}`, 'thread-a');
    expect(f.executor.execute).not.toHaveBeenCalled();
    f.setExecutorBusy(false);
    f.jobs[0].emit({ type: 'completed', occurrenceId: 'occurrence-1', success: true, output: 'Synthetic result' });
    await vi.waitFor(() => expect(f.executor.execute).toHaveBeenCalledWith(expect.stringContaining('Foreground message waiting behind the native occurrence'), expect.anything()));
  });

  it.each(['claude', 'dsh', 'agy'])('creates %s managed schedules from model tools with delegation off and a separate card', async backend => {
    f.setBackend(backend); await f.bind(true, true);
    f.executor.execute.mockImplementation(async () => {
      const result = await invoke('remote_cli_schedule_create', createArgs);
      expect(result).toMatchObject({ status: 'succeeded', card: 'Management card delivered.' });
      expect(await invoke('remote_cli_schedule_create', createArgs)).toEqual(result);
      return { success: true, output: 'Original assistant answer remains independent.' };
    });
    await f.send('Please check the build in five minutes.', 'thread-a', { isSlashCommand: false });
    expect(f.jobs).toHaveLength(1); expect(f.jobs[0].input.backend).toBe(backend);
    const card = f.ws.send.mock.calls.map(([message]) => message).find(message => message.type === 'schedule_tool_card');
    expect(card).toMatchObject({ openId: 'owner', threadId: 'thread-a', menu: { entries: [{ state: 'active' }] } });
    expect(f.responses().at(-1).scheduleMenu).toBeUndefined();
    expect(f.executor.execute).toHaveBeenCalledOnce();
    expect(f.executor.configureManagedTools.mock.calls[0][0].groups).toEqual(['scheduling']);
    expect(f.threads[0].delegation).toBe(false);
    await action(card.menu, 'cancel');
    expect(f.jobs[0].handle.cancel).toHaveBeenCalledOnce(); expect(f.jobs[0].handle.stop).toHaveBeenCalledOnce();
    expect((f.handler as any).delegationBridges.get('thread-a').handler).toBeUndefined();
  });

  it('joins AGY executor retirement before catalog stop and never initializes inactive AGY executors at shutdown', async () => {
    await f.bind(); f.setBackend('agy');
    await f.send('/schedule after 2m -- Synthetic owned AGY task');
    const handle = f.jobs[0].handle;
    let retired = false;
    f.executor.destroy.mockImplementation(async () => { retired = true; f.jobs[0].emit({ type: 'stopped', reason: 'Synthetic exact group exit', exitConfirmed: true }); });
    handle.stop.mockImplementation(async () => { expect(retired).toBe(true); });
    await f.handler.destroy();
    expect(f.executor.destroy).toHaveBeenCalled();
    expect(handle.stop).not.toHaveBeenCalled();
  });
  it('keeps tools available for unsupported backends without falling back or activating the catalog', async () => {
    f.setBackend('codex'); await f.bind(true, true);
    f.executor.execute.mockImplementation(async () => {
      expect(await invoke('remote_cli_schedule_capabilities', {})).toMatchObject({ backend: 'codex', capability: { supported: false } });
      expect(await invoke('remote_cli_schedule_create', createArgs)).toMatchObject({ status: 'failed', error: expect.stringContaining('Codex') });
      return { success: true };
    });
    await f.send('Run this later', 'thread-a', { isSlashCommand: false });
    expect(f.jobs).toHaveLength(0); expect((f.handler as any).schedules).toBeUndefined();
  });

  it.each([false, true])('preserves scheduling after authorized Codex model recovery without accepting other settings changes (%s)', async changeEffort => {
    await f.bind(true, true);
    await f.send('/schedule after 5m -- Synthetic existing task');
    f.setBackend('codex');
    f.threads[0].models = { codex: 'unavailable-model' };
    f.manager.updateThread.mockImplementation(async (id: string, patch: any) => {
      Object.assign(f.threads.find(thread => thread.id === id)!, patch);
      if (changeEffort && patch.models) f.threads[0].efforts = { codex: 'high' };
    });
    f.executor.execute.mockResolvedValueOnce({ success: false, error: 'Unknown Codex model' } as any);
    f.executor.execute.mockImplementationOnce(async () => {
      if (changeEffort) {
        await expect(invoke('remote_cli_schedule_list', { requestId: 'list-recovered' })).rejects.toThrow('no longer active');
      } else {
        expect(await invoke('remote_cli_schedule_list', { requestId: 'list-recovered' })).toMatchObject({ status: 'succeeded' });
        expect(await invoke('remote_cli_schedule_cancel', { requestId: 'cancel-recovered', scheduleId: f.jobs[0].input.id })).toMatchObject({ status: 'succeeded' });
      }
      return { success: true };
    });
    await f.send('Inspect and cancel the existing synthetic task', 'thread-a', { isSlashCommand: false });
    expect(f.executor.execute).toHaveBeenCalledTimes(2);
    expect(f.jobs[0].handle.cancel).toHaveBeenCalledTimes(changeEffort ? 0 : 1);
    expect(f.responses().at(-1).success, f.responses().at(-1).error).toBe(true);
  });

  it('removes prior scheduling registration before entering a native goal and restores it for ordinary chat', async () => {
    f.setBackend('codex'); await f.bind(true, true);
    await f.send('Synthetic ordinary chat', 'thread-a', { isSlashCommand: false });
    const previous = (f.handler as any).delegationBridges.get('thread-a');
    const executeGoal = vi.fn(async () => {
      expect(f.executor.configureManagedTools).toHaveBeenLastCalledWith(undefined);
      expect((f.handler as any).delegationBridges.has('thread-a')).toBe(false);
      expect(previous.handler).toBeUndefined();
      return { success: true };
    });
    (f.executor as any).executeGoal = executeGoal;
    expect(await (f.handler as any).executeCommand('goal-message', 'thread-a', '', f.executor, undefined, false,
      { objective: 'Synthetic native goal' })).toBe(true);
    expect(executeGoal).toHaveBeenCalledOnce();
    await f.send('Synthetic ordinary chat again', 'thread-a', { isSlashCommand: false });
    expect(f.executor.configureManagedTools).toHaveBeenLastCalledWith(expect.objectContaining({ groups: ['scheduling'] }));
  });

  it('shares a stable registration with delegation enabled without launching a worker', async () => {
    await f.bind(true, true); f.threads[0].delegation = true;
    const scope = { isClosed: () => false, hasPendingResults: () => false, getLaunchRevision: () => 0,
      beginExecution: vi.fn(), finishExecution: vi.fn(), getRetainedResults: () => [],
      close: vi.fn(async () => {}), checkArtifactCloseout: async () => [], collectPendingResults: async () => [],
      invoke: vi.fn(async () => ({ backends: [] })) };
    vi.spyOn((f.handler as any).delegation, 'begin').mockReturnValue(scope);
    f.executor.execute.mockImplementation(async () => {
      await invoke('remote_cli_list_backends', {});
      expect(await invoke('remote_cli_schedule_create', createArgs)).toMatchObject({ status: 'succeeded' });
      return { success: true };
    });
    await f.send('Synthetic scheduled request', 'thread-a', { isSlashCommand: false });
    expect(f.jobs).toHaveLength(1);
    expect(f.executor.configureManagedTools.mock.calls[0][0].groups).toEqual(['delegation', 'scheduling']);
    expect(scope.invoke).toHaveBeenCalledOnce();
    expect(scope.invoke).toHaveBeenCalledWith('remote_cli_list_backends', {}, 'native-call');
  });

  it('fences durable job IDs after lost operation receipts without creating a second job', async () => {
    await f.bind(true, true);
    f.executor.execute.mockImplementation(async () => {
      expect(await invoke('remote_cli_schedule_create', createArgs)).toMatchObject({ status: 'succeeded' });
      // Model call IDs may differ after a transport retry, but the user request and requestId remain fixed.
      (f.handler as any).scheduleToolOperations.receipts.clear();
      expect(await invoke('remote_cli_schedule_create', createArgs)).toMatchObject({ status: 'failed', error: expect.stringContaining('durable record') });
      return { success: true };
    });
    await f.send('Synthetic retry request', 'thread-a', { isSlashCommand: false });
    expect(f.jobs).toHaveLength(1);
  });

  it.each(['generation', 'backend', 'settings', 'abort'])('rejects retired %s scope before accepting native work', async boundary => {
    await f.bind(true, true);
    f.executor.execute.mockImplementation(async () => {
      if (boundary === 'generation') f.threads[0].delegationWorkspaceGeneration = 42;
      if (boundary === 'backend') f.setBackend('dsh');
      if (boundary === 'settings') f.setSandbox({ mode: 'read-only' });
      if (boundary === 'abort') (f.handler as any).abortOperations.set('thread-a', Promise.resolve());
      await expect(invoke('remote_cli_schedule_create', createArgs)).rejects.toThrow('no longer active');
      (f.handler as any).abortOperations.delete('thread-a');
      return { success: true };
    });
    await f.send('Synthetic stale request', 'thread-a', { isSlashCommand: false });
    expect(f.jobs).toHaveLength(0); expect((f.handler as any).schedules).toBeUndefined();
  });

  it('keeps successful native creation after a missing card receipt and does not duplicate on tool retry', async () => {
    await f.bind(true, true);
    const send = f.ws.send.getMockImplementation()!;
    f.ws.send.mockImplementation(message => message.type === 'schedule_tool_card' ? true : send(message));
    f.executor.execute.mockImplementation(async () => {
      const pending = invoke('remote_cli_schedule_create', createArgs);
      await vi.waitFor(() => expect((f.handler as any).scheduleCardReceipts.size).toBe(1));
      // Simulate receipt loss expiry without waiting for the eight-second network budget.
      (f.handler as any).clearScheduleCardReceipts();
      const result = await pending;
      expect(result).toMatchObject({ status: 'succeeded', card: expect.stringContaining('unknown') });
      expect(await invoke('remote_cli_schedule_create', createArgs)).toEqual(result);
      return { success: true };
    });
    await f.send('Synthetic receipt loss request', 'thread-a', { isSlashCommand: false });
    expect(f.jobs).toHaveLength(1);
  });

  it('keeps unconfirmed native cleanup owned and requires an explicit new cancel attempt after failure', async () => {
    await f.bind(true, true);
    f.executor.execute.mockImplementation(async () => {
      const created = await invoke('remote_cli_schedule_create', createArgs);
      f.jobs[0].handle.stop.mockRejectedValueOnce(new Error('Exit unconfirmed'));
      const args = { requestId: 'cancel', scheduleId: created.scheduleId };
      expect(await invoke('remote_cli_schedule_cancel', args)).toMatchObject({ status: 'failed', error: 'Exit unconfirmed' });
      expect((f.handler as any).schedules.hasActiveSchedules()).toBe(true);
      expect(await invoke('remote_cli_schedule_cancel', args)).toMatchObject({ status: 'failed' });
      expect(f.jobs[0].handle.stop).toHaveBeenCalledOnce();
      expect(await invoke('remote_cli_schedule_cancel', { ...args, requestId: 'retry-cleanup' })).toMatchObject({ status: 'succeeded', records: [{ state: 'cancelled' }] });
      expect((f.handler as any).schedules.hasActiveSchedules()).toBe(false);
      return { success: true };
    });
    await f.send('Synthetic cleanup request', 'thread-a', { isSlashCommand: false });
    expect(f.jobs[0].handle.stop).toHaveBeenCalledTimes(2);
  });

  it.each(['abort', 'generation', 'shutdown'])('owns pending native creation through %s and does not publish its card', async boundary => {
    await f.bind(true, true); const actual = native.create.getMockImplementation()!;
    let release!: () => void;
    native.create.mockImplementation(async (...args: any[]) => {
      const handle = await actual(...args); await new Promise<void>(resolve => { release = resolve; }); return handle;
    });
    let destruction: Promise<void> | undefined;
    f.executor.execute.mockImplementation(async () => {
      const request = invoke('remote_cli_schedule_create', createArgs);
      await vi.waitFor(() => expect(f.jobs).toHaveLength(1));
      if (boundary === 'abort') (f.handler as any).cancelThreadOperation('thread-a', 'Synthetic abort');
      if (boundary === 'generation') f.threads[0].delegationWorkspaceGeneration = 42;
      if (boundary === 'shutdown') destruction = f.handler.destroy();
      release(); await expect(request).rejects.toThrow('context changed');
      return { success: true };
    });
    await f.send('Synthetic pending request', 'thread-a', { isSlashCommand: false });
    await destruction;
    expect(f.jobs[0].handle.stop).toHaveBeenCalled();
    expect((f.handler as any).schedules.hasActiveSchedules()).toBe(false);
    expect(f.ws.send.mock.calls.some(([message]) => message.type === 'schedule_tool_card')).toBe(false);
  });

  it('rejects a restricted sandbox, and keeps successful old-peer creation distinct from missing cards', async () => {
    await f.bind(); f.setSandbox({ mode: 'read-only' });
    f.executor.execute.mockImplementation(async () => {
      expect(await invoke('remote_cli_schedule_create', createArgs)).toMatchObject({ status: 'failed', error: expect.stringContaining('sandbox') });
      return { success: true };
    });
    await f.send('Synthetic restricted request', 'thread-a', { isSlashCommand: false }); expect(f.jobs).toHaveLength(0);
    f.setSandbox(undefined as any);
    f.executor.execute.mockImplementation(async () => {
      expect(await invoke('remote_cli_schedule_create', createArgs)).toMatchObject({ status: 'succeeded', card: expect.stringContaining('/schedule list') });
      return { success: true };
    });
    await f.send('Synthetic older Router request', 'thread-a', { isSlashCommand: false });
    expect(f.jobs).toHaveLength(1);
    expect(f.ws.send.mock.calls.some(([message]) => message.type === 'schedule_tool_card')).toBe(false);
  });

  it('reports a late creation failure even when the model finishes after receiving pending', async () => {
    await f.bind(true, true);
    let fail!: (error: Error) => void;
    native.create.mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
    f.executor.execute.mockImplementation(async () => {
      expect(await invoke('remote_cli_schedule_create', createArgs)).toMatchObject({ status: 'pending' });
      fail(new Error('Synthetic delayed creation failure'));
      return { success: true };
    });
    await f.send('Create a synthetic delayed task', 'thread-a', { isSlashCommand: false });
    const frames = JSON.stringify(f.ws.send.mock.calls.map(([message]) => message));
    expect(frames).toContain('Scheduled operation failed after its pending receipt');
    expect(frames).toContain('Synthetic delayed creation failure');
    expect(f.executor.execute).toHaveBeenCalledOnce();
    expect(native.create).toHaveBeenCalledOnce();
  });

  it('does not replay a model turn after scheduling side effects or expose ended-turn calls', async () => {
    await f.bind(true, true);
    f.executor.execute.mockImplementation(async () => {
      await invoke('remote_cli_schedule_create', createArgs);
      return { success: false, error: 'Prompt too long' } as any;
    });
    (f.executor as any).compactWhenFull = vi.fn(async () => ({ success: true }));
    await f.send('Synthetic request', 'thread-a', { isSlashCommand: false });
    expect(f.executor.execute).toHaveBeenCalledOnce(); expect((f.executor as any).compactWhenFull).not.toHaveBeenCalled();
    expect(f.jobs).toHaveLength(1);
    expect((f.handler as any).delegationBridges.get('thread-a').handler).toBeUndefined();
  });

  it('cancels a native create that finishes after its connection is retired', async () => {
    await f.bind(true, true); const actual = native.create.getMockImplementation()!;
    let release!: () => void;
    native.create.mockImplementation(async (...args: any[]) => { const handle = await actual(...args); await new Promise<void>(resolve => { release = resolve; }); return handle; });
    f.executor.execute.mockImplementation(async () => {
      const request = invoke('remote_cli_schedule_create', createArgs);
      await vi.waitFor(() => expect(f.jobs).toHaveLength(1));
      f.disconnect(); release();
      await expect(request).rejects.toThrow('context changed');
      return { success: true };
    });
    await f.send('Synthetic request', 'thread-a', { isSlashCommand: false });
    expect(f.jobs[0].handle.cancel).toHaveBeenCalledOnce(); expect(f.jobs[0].handle.stop).toHaveBeenCalledOnce();
    expect(f.ws.send.mock.calls.some(([message]) => message.type === 'schedule_tool_card')).toBe(false);
  });

  const action = (menu: any, operation = 'refresh', extra: Record<string, unknown> = {}) => f.handler.handleMessage({
    type: 'schedule_action', messageId: 'card-request', openId: 'owner', threadId: 'thread-a',
    snapshotId: menu.snapshotId, operation, ...(operation === 'cancel' ? { value: menu.entries[0].value } : {}),
    timestamp: Date.now(), ...extra,
  } as any);
  const receipts = () => f.ws.send.mock.calls.map(([message]) => message).filter(message => message.type === 'schedule_action_result');

  it.each(['claude', 'agy', 'dsh'])('preserves waiting %s tasks when card inventory refresh fails', async backend => {
    f.setBackend(backend); await f.bind(true);
    await f.send('/schedule after 2m -- Synthetic waiting task');
    const menu = f.responses().at(-1).scheduleMenu;
    f.jobs[0].handle.list.mockRejectedValue(new Error('Synthetic inventory receipt failure'));
    await action(menu);
    expect(receipts().at(-1)).toMatchObject({ success: false, error: expect.stringContaining('Status refresh failed'),
      menu: { entries: [expect.objectContaining({ state: 'active', canCancel: true })] } });
    expect(f.jobs[0].handle.list).toHaveBeenCalledOnce();
    expect(f.jobs[0].handle.cancel).not.toHaveBeenCalled(); expect(f.jobs[0].handle.stop).not.toHaveBeenCalled();
    expect(f.executor.execute).not.toHaveBeenCalled();
  });

  it.each(['claude', 'dsh'])('refreshes and cancels %s through direct controls without a foreground turn', async backend => {
    f.setBackend(backend); await f.bind(true);
    await f.send('/schedule after 2m -- Synthetic task');
    const menu = f.responses().at(-1).scheduleMenu;
    expect(menu.entries[0]).toMatchObject({ backend, state: 'active', canCancel: true });
    await action(menu);
    expect(receipts().at(-1).success).toBe(true);
    expect(f.jobs[0].handle.list).toHaveBeenCalledOnce();
    await action(menu, 'cancel', { messageId: 'cancel-request' });
    expect(receipts().at(-1)).toMatchObject({ success: true, menu: { entries: [{ state: 'cancelled', canCancel: false }] } });
    await action(menu, 'cancel', { messageId: 'cancel-request' });
    expect(f.jobs[0].handle.cancel).toHaveBeenCalledOnce();
    expect(f.jobs[0].handle.stop).toHaveBeenCalledOnce();
    expect(f.executor.execute).not.toHaveBeenCalled();
    expect(f.ws.trackTask).not.toHaveBeenCalled();
    expect(f.scheduledResults()).toHaveLength(0);
  });

  it.each(['claude', 'dsh'].flatMap(backend => ['slash', 'tool'].map(entry => ({ backend, entry }))))('round trips $backend $entry card confirmation through the real CLI service and native handle', async ({ backend, entry }) => {
    f.setBackend(backend); await f.bind(true, true);
    f.executor.execute.mockImplementation(async () => {
      expect(await invoke('remote_cli_schedule_create', createArgs)).toMatchObject({ status: 'succeeded' });
      return { success: true };
    });
    if (entry === 'slash') await f.send('/schedule after 2m -- Synthetic end-to-end task');
    else await f.send('Please do the synthetic task in five minutes.', 'thread-a', { isSlashCommand: false });
    const menu = entry === 'slash' ? f.responses().at(-1).scheduleMenu
      : f.ws.send.mock.calls.map(([message]) => message).find(message => message.type === 'schedule_tool_card').menu;
    let elements: any[] = [];
    const pendingReplies: Promise<void>[] = [];
    const controller = new ScheduleCards({
      ownsDevice: async openId => openId === 'owner', available: () => true,
      send: async (_device, request) => { await f.handler.handleMessage(request as any); return true; },
      update: async (_card, next) => { elements = next; },
    });
    const originalSend = f.ws.send.getMockImplementation()!;
    f.ws.send.mockImplementation(message => {
      const sent = originalSend(message);
      if (message.type === 'schedule_action_result') pendingReplies.push(controller.resolve('device', message));
      return sent;
    });
    try {
      const prepared = controller.present({ openId: 'owner', deviceId: 'device', menu, expectedThreadId: 'thread-a' })!;
      elements = prepared.elements; prepared.deliver(['delivered-card']);
      const click = async (op: string) => {
        const payload = elements.flatMap(element => element.columns?.flatMap((column: any) => column.elements) ?? [])
          .find((button: any) => button.behaviors?.[0]?.value.op === op).behaviors[0].value;
        await controller.click('owner', 'delivered-card', payload);
        await Promise.all(pendingReplies);
        await (controller as any).states.values().next().value.chain;
      };
      await click('refresh');
      expect(JSON.stringify(elements)).toContain('Status refreshed');
      await click('cancel');
      expect(f.jobs[0].handle.cancel).not.toHaveBeenCalled();
      await click('confirm');
      expect(JSON.stringify(elements)).toContain('Cancellation confirmed');
      expect(f.jobs[0].handle.cancel).toHaveBeenCalledOnce();
      expect(f.jobs[0].handle.stop).toHaveBeenCalledOnce();
      expect(f.executor.execute).toHaveBeenCalledTimes(entry === 'slash' ? 0 : 1);
      expect(f.scheduledResults()).toHaveLength(0);
    } finally { controller.destroy(); }
  });

  it('does not initialize scheduling from forged controls and keeps old peers text-only', async () => {
    await f.bind(true);
    await action({ snapshotId: 'forged' });
    expect((f.handler as any).schedules).toBeUndefined();
    expect(receipts()).toHaveLength(0);
    await f.bind();
    await f.send('/schedule after 2m -- Synthetic task');
    expect(f.responses().at(-1).scheduleMenu).toBeUndefined();
    expect(f.responses().at(-1).output).toContain('/schedule cancel');
    await action({ snapshotId: 'forged' });
    expect(receipts()).toHaveLength(0);
  });

  it('rejects foreign owners and old context generations without native cancellation', async () => {
    await f.bind(true); await f.send('/schedule after 2m -- Synthetic task');
    const menu = f.responses().at(-1).scheduleMenu;
    await action(menu, 'cancel', { openId: 'other' });
    expect(receipts().at(-1).success).toBe(false);
    f.threads[0].delegationWorkspaceGeneration = 42;
    await action(menu, 'cancel', { messageId: 'stale' });
    expect(receipts().at(-1).success).toBe(false);
    expect(f.jobs[0].handle.cancel).not.toHaveBeenCalled();
  });

  it('preserves cleanup retry after native shutdown failure without claiming cancellation success', async () => {
    await f.bind(true); await f.send('/schedule after 2m -- Synthetic task');
    const menu = f.responses().at(-1).scheduleMenu;
    f.jobs[0].handle.stop.mockRejectedValue(new Error('synthetic shutdown failure'));
    await action(menu, 'cancel');
    const failed = receipts().at(-1);
    expect(failed).toMatchObject({ success: false, menu: { entries: [{ state: 'cancelled', canCancel: true }] } });
    expect(f.handler.tryBeginAutomaticUpdate()).toBe(false);
    f.jobs[0].handle.stop.mockResolvedValue();
    await action(failed.menu, 'cancel', { messageId: 'retry-cleanup' });
    expect(receipts().at(-1)).toMatchObject({ success: true, menu: { entries: [{ canCancel: false }] } });
    expect(f.handler.tryBeginAutomaticUpdate()).toBe(true); f.handler.endAutomaticUpdate();
  });

  it('invalidates disconnected card snapshots and reserves cancellation against automatic update', async () => {
    await f.bind(true); await f.send('/schedule after 2m -- Synthetic task');
    const menu = f.responses().at(-1).scheduleMenu;
    let release!: () => void;
    f.jobs[0].handle.cancel.mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); });
    const pending = action(menu, 'cancel');
    await vi.waitFor(() => expect(f.jobs[0].handle.cancel).toHaveBeenCalledOnce());
    expect(f.handler.tryBeginAutomaticUpdate()).toBe(false);
    f.disconnect(); release(); await pending;
    expect(receipts()).toHaveLength(0);
    await f.reconnect(); await f.bind(true);
    await action(menu, 'cancel', { messageId: 'old-card' });
    expect(receipts().at(-1).success).toBe(false);
    await f.send('/schedule list');
    expect(f.responses().at(-1).scheduleMenu.entries[0].state).toBe('cancelled');
  });

  it('keeps never-used scheduling dormant across binding, reconnect, chat and ordinary controls', async () => {
    const recover = vi.spyOn(f.handler as any, 'recoverSchedules');
    const initialize = vi.spyOn(ScheduleService.prototype, 'initialize');
    const closeListeners = f.closeHandlers.size;
    await f.bind(true);
    f.disconnect();
    await f.reconnect(true);
    await Promise.all(recover.mock.results.map(result => result.value));
    await f.send('Return a synthetic greeting', 'thread-a', { isSlashCommand: false });
    expect(f.executor.execute).toHaveBeenCalledOnce();
    expect(f.responses().at(-1).success).toBe(true);
    for (const command of ['/clear', '/cd ' + f.cwd, '/sandbox off', '/thread delete thread-b']) {
      await f.send(command);
      expect(f.responses().at(-1).success, `${command}: ${f.responses().at(-1).error}`).toBe(true);
    }
    expect(f.pool.clearThreadContext).toHaveBeenCalledOnce();
    expect(f.pool.setWorkingDirectory).toHaveBeenCalledOnce();
    expect(f.executor.configureSandbox).toHaveBeenCalledWith('off');
    expect(f.manager.deleteThread).toHaveBeenCalledWith('thread-b');
    expect(f.handler.tryBeginAutomaticUpdate()).toBe(true);
    f.handler.endAutomaticUpdate();
    expect(initialize).not.toHaveBeenCalled();
    expect(f.acknowledgements.size).toBe(0);
    expect(f.closeHandlers.size).toBe(closeListeners);
    expect(f.scheduledResults()).toHaveLength(0);
    expect(f.ws.send.mock.calls.some(([message]) => message.queueStarted?.source === 'schedule')).toBe(false);
    expect(native.create).not.toHaveBeenCalled();
    expect(native.createDsh).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    await f.handler.destroy();
    await expect(stat(path.join(f.cwd, 'config', 'schedules'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['missing', 'undefined'])('ignores an optional %s config directory in non-scheduling clients', async mode => {
    (f.config as any).getConfigDir = mode === 'missing' ? undefined : () => undefined;
    const recover = vi.spyOn(f.handler as any, 'recoverSchedules');
    await f.bind();
    await f.reconnect();
    await Promise.all(recover.mock.results.map(result => result.value));
    await f.send('Synthetic greeting', 'thread-a', { isSlashCommand: false });
    expect(f.executor.execute).toHaveBeenCalledOnce();
    expect(f.responses().at(-1).success).toBe(true);
    expect(console.warn).not.toHaveBeenCalled();
    expect(f.acknowledgements.size).toBe(0);
    expect(f.handler.tryBeginAutomaticUpdate()).toBe(true);
    f.handler.endAutomaticUpdate();
  });

  it('reattaches opted-in native inventory at binding without a foreground message and keeps updates fenced', async () => {
    const reconcile = vi.fn(async (record: any, context: any, emit: any) => {
      expect(context.isCurrent()).toBe(true);
      expect(record.execution).toBeDefined();
      expect(record.recovery.identity).toBe('original-fixture-session');
      f.jobs[0].emit = emit;
      return f.jobs[0].handle;
    });
    Object.assign(f.executor, { nativeScheduleRecovery: { provider: 'fixture-persistent-v1', strategy: 'reattach',
      describe: () => 'original-fixture-session', reconcile } });
    await f.bind();
    await f.send('/schedule cron "*/5 * * * *" --tz UTC -- Inspect synthetic build');
    Object.assign(f.jobs[0].handle, { releaseForRestart: vi.fn(async () => {}) });
    await f.restart();
    await f.handler.prepareScheduleStartup();
    expect(f.handler.tryBeginAutomaticUpdate()).toBe(false);
    const install = vi.fn(async () => {});
    const updater = new AutomaticUpdater('1.6.237', f.handler, { installVersion: install, restartAfterUpdate: false });
    vi.useFakeTimers();
    await updater.handleRouterVersion('1.6.238');
    expect(install).not.toHaveBeenCalled();
    vi.clearAllTimers(); vi.useRealTimers();
    await f.reconnect();
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledOnce());
    await (f.handler as any).recoverSchedules();
    expect(native.create).toHaveBeenCalledOnce();
    expect(f.handler.tryBeginAutomaticUpdate()).toBe(true); // Admission still requires an asynchronous native handoff.
    await f.handler.endAutomaticUpdate();
    f.jobs[0].emit({ type: 'started', occurrenceId: 'recovered-occurrence' });
    f.jobs[0].emit({ type: 'completed', occurrenceId: 'recovered-occurrence', success: true, output: 'Recovered result' });
    await vi.waitFor(() => expect(f.scheduledResults()).toHaveLength(1));
    expect(f.scheduledResults()[0]).toMatchObject({ threadId: 'thread-a', openId: 'owner', output: 'Recovered result' });
  });

  it('hands off actual DSH adapters through handler/updater and restores after install-only update', async () => {
    const hosts: Host[] = [];
    f.setBackend('dsh');
    const executor = new DshExecutor(new DirectoryGuard([f.cwd]), { initialWorkingDirectory: f.cwd, threadId: 'thread-a',
      sessionBaseDir: path.join(f.cwd, 'native-sessions'), clientFactory: () => { const host = new Host([]); hosts.push(host); return host; } });
    f.pool.getExecutor = () => executor as any; f.pool.getExistingExecutor = () => executor as any;
    f.pool.isThreadBusy = () => executor.isBusy();
    const configure = vi.spyOn(executor, 'configureManagedTools');
    try {
      await f.bind(); await f.send('/schedule cron "*/5 * * * *" --tz UTC -- Synthetic DSH reminder');
      expect(f.responses().at(-1).success).toBe(true);
      const connection = configure.mock.calls[0][0];
      const install = vi.fn(async () => { expect(hosts[0].destroy).toHaveBeenCalledOnce(); });
      await new AutomaticUpdater('1.6.237', f.handler, { installVersion: install, restartAfterUpdate: false })
        .handleRouterVersion('1.6.238');
      expect(install).toHaveBeenCalledOnce(); expect(hosts).toHaveLength(2);
      expect(hosts[1].loadSession).toHaveBeenCalled(); expect(hosts[1].prompt).not.toHaveBeenCalled();
      expect(configure.mock.calls.at(-1)![0]).toEqual(connection);
      await f.send('Foreground after update', 'thread-a', { isSlashCommand: false });
      expect(hosts).toHaveLength(2); expect(hosts[1].prompt).toHaveBeenCalledOnce();
      hosts[1].start(hosts[1].rows[0]); hosts[1].finish('Restored scheduled output');
      await vi.waitFor(() => expect(f.scheduledResults()).toHaveLength(1));
      expect(f.scheduledResults()[0].threadId).toBe('thread-a');
    } finally { await f.handler.destroy(); await executor.destroy(); await executor.waitForExit(); }
  });

  it('retains affected thread admission after an unconfirmed native handoff and never installs', async () => {
    Object.assign(f.executor, { nativeScheduleRecovery: { provider: 'fixture-persistent-v1', strategy: 'reattach',
      describe: () => 'original-fixture-session', reconcile: vi.fn() } });
    await f.bind(); await f.send('/schedule cron "*/5 * * * *" --tz UTC -- Synthetic reminder');
    Object.assign(f.jobs[0].handle, { releaseForRestart: vi.fn(async () => { throw new Error('Native drain unresolved'); }) });
    const install = vi.fn();
    await new AutomaticUpdater('1.6.237', f.handler, { installVersion: install }).handleRouterVersion('1.6.238');
    expect(install).not.toHaveBeenCalled(); expect(f.handler.tryBeginAutomaticUpdate()).toBe(false);
    await f.send('Must remain fenced', 'thread-a', { isSlashCommand: false });
    expect(f.executor.execute).not.toHaveBeenCalled(); expect(f.responses().at(-1).success).toBe(false);
    await f.send('/session'); expect(f.responses().at(-1).success).toBe(false);
    await f.send('/schedule list');
    expect(f.responses().at(-1)).toMatchObject({ success: true, output: expect.stringContaining('Restart handoff unconfirmed') });
    expect(f.responses().at(-1).scheduleMenu).toBeUndefined();
  });

  it('releases global admission but retains affected ownership when install-only restoration fails', async () => {
    const reconcile = vi.fn(async () => {
      throw new NativeScheduleCleanupError('Synthetic restoration failure', f.jobs[0].handle);
    });
    Object.assign(f.executor, { nativeScheduleRecovery: { provider: 'fixture-persistent-v1', strategy: 'reattach',
      describe: () => 'original-fixture-session', reconcile } });
    await f.bind(); await f.send('/schedule cron "*/5 * * * *" --tz UTC -- Synthetic reminder');
    Object.assign(f.jobs[0].handle, { releaseForRestart: vi.fn(async () => {}) });
    const install = vi.fn();
    await new AutomaticUpdater('1.6.237', f.handler, { installVersion: install, restartAfterUpdate: false })
      .handleRouterVersion('1.6.238');
    expect(install).toHaveBeenCalledOnce();
    await expect(f.handler.endAutomaticUpdate()).rejects.toThrow('admission is retained');
    await f.send('Must remain fenced', 'thread-a', { isSlashCommand: false });
    expect(f.executor.execute).not.toHaveBeenCalled(); expect(f.responses().at(-1).success).toBe(false);
    expect((f.handler as any).automaticUpdateInProgress).toBe(false);
    await f.send('Other thread after recovery failure', 'thread-b', { isSlashCommand: false });
    expect(f.responses().at(-1).success).toBe(true);
    await f.reconnect(); await (f.handler as any).recoverSchedules();
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it('does not start new recovery on reconnect after install-only finalization fails', async () => {
    const hosts: Host[] = [];
    f.setBackend('dsh');
    const executor = new DshExecutor(new DirectoryGuard([f.cwd]), { initialWorkingDirectory: f.cwd, threadId: 'thread-a',
      sessionBaseDir: path.join(f.cwd, 'native-sessions'), clientFactory: () => { const host = new Host([]); hosts.push(host); return host; } });
    f.pool.getExecutor = () => executor as any; f.pool.getExistingExecutor = () => executor as any;
    f.pool.isThreadBusy = () => executor.isBusy();
    try {
      await f.bind(); await f.send('/schedule cron "*/5 * * * *" --tz UTC -- Synthetic reminder');
      const updater = new AutomaticUpdater('1.6.237', f.handler, { restartAfterUpdate: false, installVersion: async () => {
        f.disconnect(); await f.reconnect(); await (f.handler as any).recoverSchedules();
        expect(hosts).toHaveLength(1); // A reconnect cannot reconstruct jobs under an ongoing installer.
        f.disconnect();
      } });
      await updater.handleRouterVersion('1.6.238');
      expect(hosts).toHaveLength(1); expect(f.handler.tryBeginAutomaticUpdate()).toBe(false);
      await f.reconnect(); await (f.handler as any).recoverSchedules();
      expect(hosts).toHaveLength(1);
      expect((f.handler as any).automaticUpdateInProgress).toBe(false);
      await f.send('Affected thread remains fenced', 'thread-a', { isSlashCommand: false });
      expect(f.responses().at(-1).success).toBe(false);
      expect(hosts[0].prompt).not.toHaveBeenCalled();
    } finally { await f.handler.destroy(); await executor.destroy(); await executor.waitForExit(); }
  });

  it('contains a timed-out handoff and its late mutation without locking unrelated chat or retrying release', async () => {
    const reconcile = vi.fn();
    Object.assign(f.executor, { nativeScheduleRecovery: { provider: 'fixture-persistent-v1', strategy: 'reattach',
      describe: () => 'original-fixture-session', reconcile } });
    await f.bind(true); await f.send('/schedule cron "*/5 * * * *" --tz UTC -- Synthetic reminder');
    const menu = f.responses().at(-1).scheduleMenu;
    const service = (f.handler as any).schedules as ScheduleService;
    (service as any).options.recoveryTimeoutMs = 30;
    let release!: () => void;
    let entered!: () => void;
    const enteredRelease = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const mutation = vi.fn();
    const pendingRelease = vi.fn(async () => { entered(); await gate; mutation(); });
    Object.assign(f.jobs[0].handle, { releaseForRestart: pendingRelease });
    const install = vi.fn(); const beforeRestart = vi.fn();
    vi.useFakeTimers();
    try {
      const updater = new AutomaticUpdater('1.6.247', f.handler, { installVersion: install,
        beforeRestart, retryDelayMs: 10, failureRetryDelayMs: 20 });
      const update = updater.handleRouterVersion('1.6.248');
      await enteredRelease;
      await vi.advanceTimersByTimeAsync(31);
      await update;
      expect(service.hasUnresolvedHandoff()).toBe(true);
      expect((f.handler as any).automaticUpdateInProgress).toBe(false);
      expect(install).not.toHaveBeenCalled();
      expect(beforeRestart).not.toHaveBeenCalled();
      for (const command of ['Synthetic chat', '/abort', '/clear', '/new', '/session', '/model other',
        '/effort low', '/cd ' + f.cwd, '/backend default @', '/sandbox off', '/schedule cancel all']) {
        await f.send(command, 'thread-a', { isSlashCommand: command.startsWith('/') });
        expect(f.responses().at(-1).success, command).toBe(false);
      }
      await f.send('/thread delete thread-a', 'thread-b');
      expect(f.manager.deleteThread).not.toHaveBeenCalled();
      await f.send('/backend default', 'thread-b');
      expect(f.responses().at(-1).success).toBe(false);
      await action(menu, 'cancel');
      expect(receipts().at(-1).success).toBe(false);
      expect(f.jobs[0].handle.cancel).not.toHaveBeenCalled();
      expect(f.executor.abort).not.toHaveBeenCalled();
      expect(f.pool.clearThreadContext).not.toHaveBeenCalled();
      expect(f.pool.setWorkingDirectory).not.toHaveBeenCalled();
      expect(f.executor.execute).not.toHaveBeenCalled();
      await f.send('Unrelated chat continues', 'thread-b', { isSlashCommand: false });
      expect(f.executor.execute).toHaveBeenCalledOnce();
      expect(f.responses().at(-1).success).toBe(true);
      await f.send('/schedule list');
      expect(f.responses().at(-1).success).toBe(true);
      expect(f.responses().at(-1).scheduleMenu).toBeUndefined();
      await vi.advanceTimersByTimeAsync(60);
      expect(pendingRelease).toHaveBeenCalledOnce();
      expect(install).not.toHaveBeenCalled();
      release(); await pendingRelease.mock.results[0].value;
      expect(mutation).toHaveBeenCalledOnce();
      // The original service still owns the receipt. A late provider return is
      // not a service-level clean handoff, retirement, or permission to install.
      expect(service.hasUnresolvedHandoff()).toBe(true);
      await vi.advanceTimersByTimeAsync(30);
      expect(pendingRelease).toHaveBeenCalledOnce();
      expect(f.handler.tryBeginAutomaticUpdate()).toBe(false);
      await f.reconnect(true); await (f.handler as any).recoverSchedules();
      expect(reconcile).not.toHaveBeenCalled();
      expect(install).not.toHaveBeenCalled();
      expect(f.executor.destroy).not.toHaveBeenCalled();
    } finally { release(); vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it('does not run native recovery after installer failure just to release global admission', async () => {
    const reconcile = vi.fn();
    Object.assign(f.executor, { nativeScheduleRecovery: { provider: 'fixture-persistent-v1', strategy: 'reattach',
      describe: () => 'original-fixture-session', reconcile } });
    await f.bind(); await f.send('/schedule cron "*/5 * * * *" --tz UTC -- Synthetic reminder');
    Object.assign(f.jobs[0].handle, { releaseForRestart: vi.fn(async () => {}) });
    vi.useFakeTimers();
    try {
      const install = vi.fn(async () => { throw new Error('Synthetic installer failure'); });
      await new AutomaticUpdater('1.6.247', f.handler, { installVersion: install }).handleRouterVersion('1.6.248');
      expect(install).toHaveBeenCalledOnce();
      expect((f.handler as any).automaticUpdateInProgress).toBe(false);
      expect(reconcile).not.toHaveBeenCalled();
      await f.send('Other thread', 'thread-b', { isSlashCommand: false });
      expect(f.responses().at(-1).success).toBe(true);
      await f.send('Affected thread', 'thread-a', { isSlashCommand: false });
      expect(f.responses().at(-1).success).toBe(false);
      expect(f.handler.tryBeginAutomaticUpdate()).toBe(false);
      await f.reconnect(); await (f.handler as any).recoverSchedules();
      expect(reconcile).not.toHaveBeenCalled();
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it('does not re-admit updates after handler destruction when no schedules exist', async () => {
    await f.bind(); await f.handler.destroy();
    expect(f.handler.tryBeginAutomaticUpdate()).toBe(false);
  });

  it('does not unblock upgrades before an older Router can negotiate recovery transport', async () => {
    await f.bind(); await f.send('/schedule after 5m -- Synthetic reminder'); await f.restart();
    await f.handler.prepareScheduleStartup();
    await f.handler.handleMessage({ type: 'binding_confirm', data: { success: true, capabilities: {} } } as any);
    expect(f.handler.tryBeginAutomaticUpdate()).toBe(false);
    expect(native.create).toHaveBeenCalledOnce();
  });

  it('blocks foreground input throughout recovery inventory validation', async () => {
    let finish!: (present: boolean) => void;
    const inventory = new Promise<boolean>(resolve => { finish = resolve; });
    let entered!: () => void;
    const inventoryEntered = new Promise<void>(resolve => { entered = resolve; });
    const reconcile = vi.fn(async () => {
      entered();
      return { ...f.jobs[0].handle, list: () => inventory };
    });
    Object.assign(f.executor, { nativeScheduleRecovery: { provider: 'fixture-v1', strategy: 'reattach',
      describe: () => 'original-fixture-session', reconcile } });
    await f.bind(); await f.send('/schedule after 5m -- Synthetic reminder');
    Object.assign(f.jobs[0].handle, { releaseForRestart: async () => {} });
    await f.restart(); await f.reconnect();
    const recovery = (f.handler as any).recoverSchedules() as Promise<void>;
    try {
      await Promise.race([inventoryEntered, recovery.then(() => {
        throw new Error('Recovery completed without entering native inventory.');
      })]);
      expect(reconcile).toHaveBeenCalledOnce();
      await f.send('Must not start before inventory', 'thread-a', { isSlashCommand: false });
      expect(f.responses().at(-1)).toMatchObject({ success: false, error: expect.stringContaining('recovery is unresolved') });
      expect(f.executor.execute).not.toHaveBeenCalled();
    } finally {
      finish(true);
      await recovery;
    }
    await f.send('Synthetic new foreground', 'thread-a', { isSlashCommand: false }); expect(f.executor.execute).toHaveBeenCalledOnce();
  });

  it('startup inventory check leaves users without catalogs dormant and update-eligible', async () => {
    await f.handler.prepareScheduleStartup();
    expect(f.handler.tryBeginAutomaticUpdate()).toBe(true);
    f.handler.endAutomaticUpdate();
    expect(native.create).not.toHaveBeenCalled();
    expect(f.acknowledgements.size).toBe(0);
  });

  it('recovers a persisted outbox after handler restart without recreating native jobs', async () => {
    await f.bind();
    await f.send('/schedule after 2m -- Return a synthetic summary');
    f.disconnect();
    f.jobs[0].emit({ type: 'completed', occurrenceId: 'restart-run', success: true, output: 'Persisted result' });
    await vi.waitFor(() => expect(f.jobs[0].handle.stop).toHaveBeenCalled());
    await f.restart();
    expect(f.acknowledgements.size).toBe(0);
    await f.reconnect();
    await vi.waitFor(() => expect(f.scheduledResults()).toHaveLength(1));
    expect(f.scheduledResults()[0]).toMatchObject({ output: 'Persisted result', openId: 'owner', threadId: 'thread-a' });
    await f.reconnect();
    await (f.handler as any).recoverSchedules();
    expect(f.scheduledResults()).toHaveLength(1);
    expect(f.acknowledgements.size).toBe(1);
    expect(native.create).toHaveBeenCalledOnce();
    expect(native.createDsh).not.toHaveBeenCalled();
  });

  it.each(['claude', 'dsh'])('retains offline %s recurring results across provider stop and handler restart', async backend => {
    await f.bind();
    f.setBackend(backend);
    await f.send('/schedule cron "15 9 * * 1-5" --tz Asia/Shanghai -- Return a synthetic summary');
    const job = f.jobs[0];
    f.disconnect();
    await job.emit({ type: 'completed', occurrenceId: 'shutdown-run', success: true, output: 'Retained across shutdown' });
    const catalog = path.join((f.handler as any).scheduleDirectory(), SCHEDULE_CATALOG_FILE);
    expect(JSON.parse(await readFile(catalog, 'utf8')).pending).toHaveLength(1);
    job.handle.stop.mockImplementation(async () => {
      job.emit({ type: 'stopped', exitConfirmed: true, reason: 'Shutdown completed' });
    });
    await f.restart();
    expect(job.handle.stop).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(catalog, 'utf8')).pending).toHaveLength(1);
    expect(f.scheduledResults()).toHaveLength(0);
    const recover = vi.spyOn(f.handler as any, 'recoverSchedules');
    await f.reconnect();
    expect(recover).toHaveBeenCalledOnce();
    // A wire response precedes durable ACK settlement. Join recovery before
    // opening the catalog so Windows readers cannot race its atomic replacement.
    await recover.mock.results[0].value;
    expect(f.scheduledResults()).toHaveLength(1);
    expect(f.scheduledResults()[0]).toMatchObject({ output: 'Retained across shutdown', threadId: 'thread-a' });
    expect(JSON.parse(await readFile(catalog, 'utf8')).pending).toEqual([]);
    await f.reconnect();
    await (f.handler as any).recoverSchedules();
    expect(f.scheduledResults()).toHaveLength(1);
    expect(f.jobs).toHaveLength(1);
  });

  it('isolates a malformed existing catalog from ordinary chat, controls and shutdown', async () => {
    const directory = (f.handler as any).scheduleDirectory();
    await mkdir(directory, { recursive: true });
    const catalog = path.join(directory, SCHEDULE_CATALOG_FILE);
    await writeFile(catalog, 'invalid catalog');
    const recover = vi.spyOn(f.handler as any, 'recoverSchedules');
    await f.bind();
    await Promise.allSettled(recover.mock.results.map(result => result.value));
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalledOnce());
    await f.send('Synthetic greeting', 'thread-a', { isSlashCommand: false });
    expect(f.executor.execute).toHaveBeenCalledOnce();
    for (const command of ['/clear', '/cd ' + f.cwd, '/sandbox off', '/thread delete thread-b']) {
      await f.send(command);
      expect(f.responses().at(-1).success, `${command}: ${f.responses().at(-1).error}`).toBe(!/^\/(clear|cd|backend|thread delete)/.test(command));
    }
    expect(f.acknowledgements.size).toBe(0);
    // A corrupt catalog cannot prove that no recoverable native work is owned.
    expect(f.handler.tryBeginAutomaticUpdate()).toBe(false);
    f.handler.endAutomaticUpdate();
    await f.handler.destroy();
    expect(await readFile(catalog, 'utf8')).toBe('invalid catalog');
    expect(native.create).not.toHaveBeenCalled();
  });

  it('does not block chat or activate recovery after shutdown during a slow catalog check', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const lstat = fs.promises.lstat.bind(fs.promises);
    vi.spyOn(fs.promises, 'lstat').mockImplementation((async (...args: Parameters<typeof lstat>) => {
      if (String(args[0]).endsWith(SCHEDULE_CATALOG_FILE)) { await gate; return {} as any; }
      return lstat(...args);
    }) as typeof fs.promises.lstat);
    const recover = vi.spyOn(f.handler as any, 'recoverSchedules');
    const initialize = vi.spyOn(ScheduleService.prototype, 'initialize');
    await f.bind();
    await f.send('Synthetic greeting', 'thread-a', { isSlashCommand: false });
    expect(f.executor.execute).toHaveBeenCalledOnce();
    expect(f.handler.tryBeginAutomaticUpdate()).toBe(true);
    f.handler.endAutomaticUpdate();
    await f.handler.destroy();
    release();
    await Promise.all(recover.mock.results.map(result => result.value));
    expect(initialize).not.toHaveBeenCalled();
    expect(f.acknowledgements.size).toBe(0);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('shares initialization across persisted recovery, reconnect and explicit creation', async () => {
    const directory = (f.handler as any).scheduleDirectory();
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, SCHEDULE_CATALOG_FILE), JSON.stringify({ version: 1, records: [], pending: [] }));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const initializeService = ScheduleService.prototype.initialize;
    const initialize = vi.spyOn(ScheduleService.prototype, 'initialize').mockImplementation(async function (this: ScheduleService) {
      await gate;
      return initializeService.call(this);
    });
    const recover = vi.spyOn(f.handler as any, 'recoverSchedules');
    await f.bind();
    await vi.waitFor(() => expect(initialize).toHaveBeenCalledOnce());
    const creating = f.send('/schedule after 2m -- Return a synthetic summary');
    await f.reconnect();
    expect(f.acknowledgements.size).toBe(0);
    release();
    await creating;
    await Promise.all(recover.mock.results.map(result => result.value));
    expect(f.responses().at(-1).success).toBe(true);
    expect(initialize).toHaveBeenCalledOnce();
    expect(native.create).toHaveBeenCalledOnce();
    expect(f.acknowledgements.size).toBe(1);
    await f.send(`/schedule cancel ${f.jobs[0].input.id}`);
    expect(f.jobs[0].handle.stop).toHaveBeenCalledOnce();
    expect(f.handler.tryBeginAutomaticUpdate()).toBe(true);
    f.handler.endAutomaticUpdate();
  });

  it('awaits an initializing service at shutdown without adding late delivery listeners', async () => {
    const directory = (f.handler as any).scheduleDirectory();
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, SCHEDULE_CATALOG_FILE), JSON.stringify({ version: 1, records: [], pending: [] }));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const initializeService = ScheduleService.prototype.initialize;
    const initialize = vi.spyOn(ScheduleService.prototype, 'initialize').mockImplementation(async function (this: ScheduleService) {
      await gate;
      return initializeService.call(this);
    });
    const destroy = vi.spyOn(ScheduleService.prototype, 'destroy');
    await f.bind();
    await vi.waitFor(() => expect(initialize).toHaveBeenCalledOnce());
    const shuttingDown = f.handler.destroy();
    release();
    await shuttingDown;
    expect(destroy).toHaveBeenCalledOnce();
    expect(f.acknowledgements.size).toBe(0);
    expect(f.scheduledResults()).toHaveLength(0);
    expect(native.create).not.toHaveBeenCalled();
  });

  it('shows all backend gaps without executing a model and gates unsupported creation', async () => {
    await f.send('/schedule capabilities');
    expect(f.responses().at(-1).output).toContain('Kimi');
    expect(native.create).not.toHaveBeenCalled();
    await f.send('/schedule after 2m -- Return a summary');
    expect(f.responses().at(-1)).toMatchObject({ success: false, error: expect.stringContaining('Router') });
    await f.bind();
    f.setBackend('codex');
    await f.send('/schedule after 2m -- Return a summary');
    expect(f.responses().at(-1)).toMatchObject({ success: false, error: expect.stringContaining('app-server') });
    expect(f.executor.execute).not.toHaveBeenCalled();
    expect(native.create).not.toHaveBeenCalled();
  });

  it.each([
    ['codex', 'app-server'], ['kimi', 'ACP'],
    ['opencode', 'ACP'], ['pi', 'RPC'], ['zcode', 'app-server'], ['unknown', 'unknown backend'],
  ])('rejects %s with its own capability gap, without starting a fallback', async (backend, gap) => {
    await f.bind();
    f.setBackend(backend);
    for (const command of [
      '/schedule after 2m -- Return a summary',
      '/schedule cron "15 9 * * 1-5" --tz Asia/Shanghai -- Return a summary',
    ]) {
      await f.send(command);
      expect(f.responses().at(-1)).toMatchObject({ success: false,
        error: expect.stringContaining('temporarily unsupported') });
      expect(f.responses().at(-1).error).toContain(gap);
    }
    await f.send('/schedule list');
    expect(f.responses().at(-1).output).toContain('No schedules');
    expect(native.create).not.toHaveBeenCalled();
    expect(native.createDsh).not.toHaveBeenCalled();
    expect(f.executor.execute).not.toHaveBeenCalled();
  });

  it('allows listing and cancelling a captured schedule after switching to an unsupported backend', async () => {
    await f.bind();
    await f.send('/schedule after 2m -- Return a summary');
    const job = f.jobs[0];
    f.setBackend('codex');
    await f.send('/schedule list');
    expect(f.responses().at(-1).output).toContain(job.input.id);
    await f.send(`/schedule cancel ${job.input.id}`);
    expect(f.responses().at(-1)).toMatchObject({ success: true, output: expect.stringContaining('cancelled') });
    expect(job.handle.cancel).toHaveBeenCalledOnce();
    expect(job.handle.stop).toHaveBeenCalled();
    expect(native.create).toHaveBeenCalledOnce();
    expect(f.executor.execute).not.toHaveBeenCalled();
  });

  it('keeps restricted sandbox settings and rejects attachment shortcuts', async () => {
    await f.bind();
    f.setSandbox({ mode: 'read-only' });
    await f.send('/schedule after 2m -- Return a summary');
    expect(f.responses().at(-1)).toMatchObject({ success: false, error: expect.stringContaining('sandbox') });
    await f.send('/schedule after 2m -- Read this', 'thread-a', { fileIds: ['file-fixture'] });
    expect(f.responses().at(-1).success).toBe(false);
    expect(native.create).not.toHaveBeenCalled();
  });

  it('honors a persisted per-thread sandbox even when global defaults are unrestricted', async () => {
    await f.bind();
    const directory = path.join(f.cwd, '.remote-cli', 'claude-sandbox');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'thread-a.json'), JSON.stringify({ mode: 'read-only' }));
    await f.send('/schedule after 2m -- Return a summary');
    expect(f.responses().at(-1)).toMatchObject({ success: false, error: expect.stringContaining('sandbox') });
    expect(native.create).not.toHaveBeenCalled();
  });

  it('uses the DSH model and command without falling back to Claude settings or its provider', async () => {
    await f.bind();
    f.setBackend('dsh');
    f.setSandbox({ mode: 'read-only' });
    f.threads[0].model = 'legacy-claude-model';
    f.threads[0].models = { dsh: 'chosen-dsh-model' };
    f.threads[0].efforts = { dsh: 'high', claude: 'low' };
    await f.send('/schedule after 2m -- Return a summary');
    expect(f.responses().at(-1)).toMatchObject({ success: true, output: expect.stringContaining('DSH') });
    expect(native.create).not.toHaveBeenCalled();
    expect(native.createDsh).toHaveBeenCalledOnce();
    expect(f.jobs[0].input).toMatchObject({ backend: 'dsh', command: 'dsh-fixture',
      model: 'chosen-dsh-model', effort: 'high' });
    f.setBackend('codex');
    await f.send(`/schedule cancel ${f.jobs[0].input.id}`);
    expect(f.responses().at(-1).success).toBe(true);
    expect(f.jobs[0].handle.cancel).toHaveBeenCalledOnce();
  });

  it('reserves update admission before asynchronous initialization and rechecks before native creation', async () => {
    await f.bind();
    const service = await (f.handler as any).initializeSchedules();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const initialize = vi.spyOn(f.handler as any, 'initializeSchedules').mockImplementationOnce(async () => {
      await gate; return service;
    });
    const creating = f.send('/schedule after 2m -- Return a summary');
    await vi.waitFor(() => expect(initialize).toHaveBeenCalled());
    expect(f.handler.tryBeginAutomaticUpdate()).toBe(false);
    // A concurrent shutdown/update signal still invalidates admission before native work.
    (f.handler as any).automaticUpdateInProgress = true;
    release(); await creating;
    expect(f.responses().at(-1)).toMatchObject({ success: false, error: expect.stringContaining('updating') });
    expect(native.create).not.toHaveBeenCalled();
    f.handler.endAutomaticUpdate();
  });

  it.each(['claude', 'dsh'])('creates a %s one-shot, delivers its idle result to the original thread, and cleans up', async backend => {
    await f.bind();
    f.setBackend(backend);
    await f.send('/schedule after 2m -- Return a synthetic summary');
    expect(f.responses().at(-1).success).toBe(true);
    const job = f.jobs[0];
    expect(job.input).toMatchObject({ backend, cwd: f.cwd, prompt: 'Return a synthetic summary', rule: { kind: 'once' } });
    await f.send('/schedule list', 'thread-b');
    job.emit({ type: 'started', occurrenceId: 'occurrence-one' });
    job.emit({ type: 'completed', occurrenceId: 'occurrence-one', success: true, output: 'Synthetic result' });
    await vi.waitFor(() => expect(f.scheduledResults()).toHaveLength(1));
    expect(f.scheduledResults()[0]).toMatchObject({ openId: 'owner', threadId: 'thread-a', success: true,
      output: expect.stringContaining('Synthetic result'), queueStarted: { backend } });
    await vi.waitFor(() => expect(job.handle.stop).toHaveBeenCalled());
    await vi.waitFor(() => expect(f.handler.tryBeginAutomaticUpdate()).toBe(true));
    f.handler.endAutomaticUpdate();
    await f.send('/schedule list');
    expect(f.responses().at(-1).output).toContain('completed');
    expect(f.executor.execute).not.toHaveBeenCalled();
  });

  it.each(['claude', 'dsh'])('delivers multiple %s recurring occurrences, fences resets, and permits cancellation', async backend => {
    await f.bind();
    f.setBackend(backend);
    await f.send('/schedule cron "15 9 * * 1-5" --tz Asia/Shanghai -- Return a daily summary');
    const job = f.jobs[0];
    expect(job.input.rule).toEqual({ kind: 'cron', expression: '15 9 * * 1-5', timezone: 'Asia/Shanghai' });
    await f.send('/clear');
    expect(f.responses().at(-1)).toMatchObject({ success: false, error: expect.stringContaining('schedule cancel') });
    expect(f.executor.abort).not.toHaveBeenCalled();
    await f.send('/cd ' + f.cwd);
    expect(f.pool.setWorkingDirectory).not.toHaveBeenCalled();
    for (const occurrenceId of ['first-run', 'second-run']) {
      job.emit({ type: 'started', occurrenceId });
      job.emit({ type: 'completed', occurrenceId, success: true, output: occurrenceId });
    }
    await vi.waitFor(() => expect(f.scheduledResults()).toHaveLength(2));
    await f.send(`/schedule cancel ${job.input.id}`);
    expect(f.responses().at(-1).success).toBe(true);
    expect(job.handle.cancel).toHaveBeenCalled();
    expect(job.handle.stop).toHaveBeenCalled();
    await f.send('/cd ' + f.cwd);
    expect(f.pool.setWorkingDirectory).toHaveBeenCalled();
  });

  it('retains offline results and retries them after capability negotiation', async () => {
    await f.bind();
    await f.send('/schedule after 2m -- Return a synthetic summary');
    f.disconnect();
    f.jobs[0].emit({ type: 'started', occurrenceId: 'offline-run' });
    f.jobs[0].emit({ type: 'completed', occurrenceId: 'offline-run', success: true, output: 'Offline result' });
    await vi.waitFor(() => expect(f.jobs[0].handle.stop).toHaveBeenCalled());
    expect(f.scheduledResults()).toHaveLength(0);
    await f.reconnect();
    await vi.waitFor(() => expect(f.scheduledResults()).toHaveLength(1));
    expect(f.scheduledResults()[0].output).toContain('Offline result');
  });

  it('does not route a result into a replaced conversation generation', async () => {
    await f.bind();
    await f.send('/schedule after 2m -- Return a synthetic summary');
    f.threads[0].delegationWorkspaceGeneration = 1;
    f.jobs[0].emit({ type: 'started', occurrenceId: 'stale-run' });
    f.jobs[0].emit({ type: 'completed', occurrenceId: 'stale-run', success: true, output: 'Stale result' });
    await f.send('/schedule list', 'thread-b');
    expect(f.scheduledResults()).toHaveLength(0);
  });
});
