import { AgyManualResumeScheduleSkip } from '../src/scheduling/types';
import { ScheduleCards } from '../../router/src/feishu/ScheduleCards';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'fs/promises';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { AgyExecutor } from '../src/executor/AgyExecutor';
import * as acp from '../src/executor/acp/AcpClient';
import * as hooks from '../src/scheduling/agy/AgyHookRelay';
import { NOTIFICATION_PREFIX } from '../src/scheduling/agy/transcript';
import { agyActivity, SyntheticAgyActivityClient, syntheticAgyHooks } from './executor/agyActivityFixture';
import { AutomaticUpdater } from '../src/update/AutomaticUpdater';
import { MessageHandler } from '../src/client/MessageHandler';
import { DirectoryGuard } from '../src/security/DirectoryGuard';
import { ThreadContextReset } from '../src/thread/ThreadContextReset';
import type { Thread } from '../src/thread/types';
import { ScheduleService, SCHEDULE_CATALOG_FILE, HOST_SCHEDULE_CATALOG_FILE } from '../src/scheduling/ScheduleService';

const backends = ['claude', 'dsh', 'agy', 'codex', 'kimi', 'opencode', 'pi', 'zcode'] as const;
const binding = { deviceId: 'fixture-device', openId: 'owner', epoch: 'original-binding' };

async function fixture() {
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'schedule-handler-')));
  await mkdir(path.join(cwd, '.remote-cli'));
  vi.spyOn(os, 'homedir').mockReturnValue(cwd); vi.stubEnv('HOME', cwd); vi.stubEnv('USERPROFILE', cwd);
  const threads: Thread[] = ['thread-a', 'thread-b'].map(id => ({ id, name: id, workingDirectory: cwd,
    sessionId: null, createdAt: 0, lastActiveAt: 0, delegation: false }));
  let backend = 'claude';
  let sandbox: { mode: string } | undefined;
  let connected = true;
  let autoAck = true;
  let executorBusy = false;
  const busyThreads = new Set<string>();
  const executor = { getSessionId: vi.fn((): string | null => 'bound'), checkHostScheduleSession: vi.fn((_id: string) => {}),
    withNativeScheduleOperation: vi.fn(async (_id: string, current: () => boolean, run: () => Promise<unknown>, _inTurn?: boolean) => {
      if (!current()) throw new Error('Stale scheduling operation');
      return run();
    }), configureManagedTools: vi.fn(async (_connection?: any) => {}), configureDelegation: vi.fn(async (_connection?: any) => {}), execute: vi.fn(async (_prompt: string, _options: import('../src/executor/IExecutor').ExecuteOptions) => ({ success: true })), getCurrentWorkingDirectory: () => cwd,
    abort: vi.fn(async () => true), destroy: vi.fn(), isBusy: () => executorBusy, resetContext: vi.fn(),
    getSandboxStatus: () => 'Unrestricted', configureSandbox: vi.fn(async () => ({ success: true })) };
  const pool = {
    getExistingExecutor: () => executor, getExecutor: () => executor, getBackendKey: () => backend,
    getSummaries: () => threads.map(thread => ({ id: thread.id, name: thread.name, status: 'idle', backend })),
    isThreadBusy: (id: string) => executorBusy || busyThreads.has(id),
    setThreadBusy: vi.fn((id: string, busy: boolean) => { if (busy) busyThreads.add(id); else busyThreads.delete(id); }),
    setThreadError: vi.fn(), destroyAll: vi.fn(async () => {}),
    setWorkingDirectory: vi.fn(async () => ({ cwd, changed: false })),
    assertThreadDeletionAllowed: vi.fn(),
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
      if (autoAck && message.type === 'response' && scheduledMessages.has(message.messageId)) {
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
  const makeHandler = () => new MessageHandler(ws as any, pool as any, manager as any, new DirectoryGuard([cwd]), config as any);
  let handler = makeHandler();
  let sequence = 0;
  const send = (content: string, threadId = 'thread-a', extra: Record<string, unknown> = {}) => handler.handleMessage({
    type: 'command', messageId: `command-${++sequence}`, openId: 'owner', threadId, content,
    isSlashCommand: true, timestamp: Date.now(),
    ...extra,
  } as any);
  const bind = (cards = false, tools = false, scheduleBinding = binding) => handler.handleMessage({ type: 'binding_confirm', data: { success: true,
    scheduleBinding, registrationId: 'authenticated-fixture', capabilities: { scheduleResultsV1: true, hostSchedulesV1: true, taskRecovery: true,
      ...(cards ? { scheduleCardsV1: true } : {}), ...(tools ? { scheduleToolCardsV1: true } : {}) } } } as any);
  const responses = () => ws.send.mock.calls.map(([message]) => message).filter(message => message.type === 'response');
  return { cwd, threads, get handler() { return handler; }, pool, manager, ws, send, bind, responses, executor, config,
    acknowledgements, closeHandlers, holdResultAck: () => { autoAck = false; },
    restart: async () => { await handler.destroy(); handler = makeHandler(); scheduledMessages.clear(); ws.send.mockClear(); },
    setBackend: (value: string) => { backend = value; }, setSandbox: (value: { mode: string }) => { sandbox = value; },
    setExecutorBusy: (value: boolean) => { executorBusy = value; },
    disconnect: () => { connected = false; closeHandlers.forEach(handler => handler(1006, '')); },
    reconnect: async (cards = false, newBinding = binding) => { connected = true; await bind(cards, false, newBinding); },
    scheduledResults: () => responses().filter(message => scheduledMessages.has(message.messageId)),
  };
}

describe('MessageHandler schedule management and delivery', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    f = await fixture();
  });
  afterEach(async () => { await f.handler.destroy(); await rm(f.cwd, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  const owner = () => ({ threadId: 'thread-a', openId: 'owner', generation: (f.handler as any).scheduleGeneration('thread-a') });
  const records = () => ((f.handler as any).schedules as ScheduleService).list({ ...owner(), bindingEpoch: binding.epoch });

  it.each(['/clear', '/new'])('%s erases only the original thread host records and durably fences their IDs', async command => {
    await f.bind();
    await f.send('/schedule after 5m -- Original task');
    const [original] = await records();
    await f.send('/schedule after 10m -- Sibling task', 'thread-b');
    const siblingOwner = (f.handler as any).scheduleOwner('thread-b', 'owner');
    const service: ScheduleService = (f.handler as any).schedules;
    await f.send(command, 'thread-a', { openId: 'other' });
    expect(f.responses().at(-1).success).toBe(false);
    expect(await records()).toHaveLength(1);
    await f.send(command);
    expect(f.responses().at(-1)).toMatchObject({ success: true, output: expect.stringContaining('Removed 1 host schedule') });
    expect(f.pool.clearThreadContext).toHaveBeenCalledOnce();
    await f.restart(); await f.bind(); await (f.handler as any).loadScheduleCatalog();
    const restored: ScheduleService = (f.handler as any).schedules;
    expect(restored).not.toBe(service);
    expect(await restored.list(original)).toEqual([]);
    expect(await restored.list(siblingOwner)).toHaveLength(1);
    await expect(restored.create((f.handler as any).scheduleOwner('thread-a', 'owner'), { ...original, engine: 'host' })).rejects.toThrow(/purged/);
    expect(f.executor.execute).not.toHaveBeenCalled();
  });

  it('keeps cleared timers retired through a failed backend reset, restart and retry', async () => {
    await f.bind(); await f.send('/schedule after 5m -- Retire on clear');
    const [original] = await records();
    f.pool.clearThreadContext.mockRejectedValueOnce(new Error('Synthetic backend reset failed'));
    await f.send('/clear');
    expect(f.responses().at(-1).error).toContain('Synthetic backend reset failed');
    expect(f.responses().at(-1).error).toContain('Removed 1 host schedule');
    expect(f.manager.contextResets.isPending('thread-a')).toBe(true);
    await f.restart(); await f.bind(); await (f.handler as any).loadScheduleCatalog();
    expect(await (f.handler as any).schedules.list(original)).toEqual([]);
    await f.send('/new');
    expect(f.responses().at(-1).success).toBe(true);
    expect(f.manager.contextResets.isPending('thread-a')).toBe(false);
  });

  it('leaves host definitions intact when retained native cleanup blocks clear', async () => {
    await history(); installRetainedCleanup();
    await f.bind(); await f.send('/schedule after 5m -- Retain with native sibling');
    await f.send('/clear');
    expect(f.responses().at(-1).error).toMatch(/native schedules/);
    expect(await records()).toHaveLength(2);
    expect(f.pool.clearThreadContext).not.toHaveBeenCalled();
  });

  it('lets an authenticated clear stop an admitted host turn and discards its late result', async () => {
    await f.bind(); await f.send('/schedule after 5m -- Running task');
    const [original] = await records();
    const service = (f.handler as any).schedules;
    let finish!: () => void;
    f.executor.execute.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { finish = resolve; });
      return { success: true, output: 'Late scheduled result' };
    });
    vi.spyOn(service, 'now').mockReturnValue(original.nextDueAt);
    await service.wakeHosts();
    await vi.waitFor(() => expect(f.executor.execute).toHaveBeenCalledOnce());
    try {
      await f.send('/clear');
      expect(f.responses().at(-1).success).toBe(true);
      expect(f.executor.abort).toHaveBeenCalledOnce();
      expect(await service.list(original)).toEqual([]);
    } finally { finish(); }
    await vi.waitFor(() => expect(service.canRestartWithoutActiveWork()).toBe(true));
    expect(f.scheduledResults()).toEqual([]);
  });

  const invoke = (name: string, args: Record<string, unknown>) => (f.handler as any).delegationBridges.get('thread-a').handler(name, args, 'native-call');
  const createArgs = { requestId: 'create-one', when: { kind: 'after', amount: 5, unit: 'm' }, prompt: 'Synthetic scheduled task' };

  async function dispatchFixture() {
    await f.bind();
    const service = await (f.handler as any).initializeSchedules();
    const record = { ...owner(), bindingEpoch: binding.epoch, cwd: f.cwd, id: 'host-task', engine: 'host', backend: f.pool.getBackendKey(),
      sessionId: 'bound', prompt: 'Synthetic occurrence', rule: { kind: 'once', at: new Date().toISOString() } };
    const dispatch = (admit = async () => true, signal?: AbortSignal, occurrenceId = 'run') =>
      service.options.hostDispatch(record, occurrenceId, admit, signal);
    return { record, dispatch, deliver: () => service.options.deliver({ schedule: record, id: 'host-task:run', occurrenceId: 'run', success: true, output: 'Synthetic result' }) };
  }

  it('allows cancellation while host admission is pending, alongside retained native history', async () => {
    await history(); installRetainedCleanup();
    const { record, dispatch } = await dispatchFixture();
    const service = (f.handler as any).schedules;
    const siblings = await records();
    vi.spyOn(service, 'list').mockResolvedValue([...siblings, { ...record, state: 'active' }]);
    vi.spyOn(service, 'cancel').mockResolvedValue({ ...record, state: 'cancelled' });
    f.executor.withNativeScheduleOperation.mockClear();
    const result = await dispatch(async () => {
      await f.send('/schedule cancel ' + record.id);
      expect(f.responses().at(-1)).toMatchObject({ success: true });
      return true;
    });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('cancelled') });
    expect(f.executor.execute).not.toHaveBeenCalled();
    expect(f.executor.withNativeScheduleOperation).not.toHaveBeenCalled();
  });

  it('routes approvals to the occurrence owner and expires outstanding requests at completion', async () => {
    const { dispatch } = await dispatchFixture();
    (f.handler as any).approvalCardsSupported = true;
    f.executor.execute.mockImplementationOnce(async (_prompt, options) => {
      expect(options.onApprovalRequest?.({ requestId: 'approval-one', kind: 'permissions', description: 'Synthetic approval', canRemember: false })).toBe(true);
      await f.send('/abort', 'thread-a', { openId: 'other' });
      expect(f.executor.abort).not.toHaveBeenCalled();
      return { success: false, error: 'Native execution failed' };
    });
    expect(await dispatch()).toMatchObject({ success: false, error: 'Native execution failed' });
    const frames = f.ws.send.mock.calls.map(([message]) => message);
    expect(frames).toContainEqual(expect.objectContaining({ type: 'approval_request', taskMessageId: 'host-task:run', openId: 'owner', threadId: 'thread-a' }));
    expect(frames).toContainEqual(expect.objectContaining({ type: 'approval_resolved', messageId: 'approval-one', status: 'expired' }));
  });

  it('joins host admission during shutdown without starting its pending prompt', async () => {
    const { dispatch } = await dispatchFixture();
    let release!: (allowed: boolean) => void;
    const admit = vi.fn(() => new Promise<boolean>(resolve => { release = resolve; }));
    const running = dispatch(admit);
    await vi.waitFor(() => expect(admit).toHaveBeenCalledOnce());
    let closed = false;
    const closing = f.handler.destroy().then(() => { closed = true; });
    await vi.waitFor(() => expect(f.pool.destroyAll).toHaveBeenCalledOnce());
    expect(closed).toBe(false);
    release(true);
    expect(await running).toMatchObject({ success: false });
    await closing;
    expect(f.executor.execute).not.toHaveBeenCalled();
  });

  it('retires a pending host approval on same-user rebinding without replaying its contents', async () => {
    const { dispatch } = await dispatchFixture();
    const respond = vi.fn(() => true);
    Object.assign(f.executor, { respondToApproval: respond });
    (f.handler as any).approvalCardsSupported = true;
    f.executor.execute.mockImplementationOnce(async (_prompt, options) => {
      options.onApprovalRequest!({ requestId: 'binding-request', kind: 'permissions', description: 'Synthetic approval', canRemember: false });
      await f.handler.handleMessage({ type: 'binding_confirm', data: { success: true, scheduleBinding: { ...binding, epoch: 'replacement' },
        capabilities: { approvalCards: true, hostSchedulesV1: true, scheduleResultsV1: true } } } as any);
      return { success: true };
    });
    expect(await dispatch()).toMatchObject({ success: false });
    expect(respond.mock.calls).toEqual([['binding-request', 'deny']]);
    expect(f.ws.send.mock.calls.filter(([frame]) => frame.type === 'approval_request')).toHaveLength(1);
  });

  const source = (threadId: string | null = 'thread-a') => ({ originalMessageId: 'original-' + threadId, createdAt: Date.now(),
    deviceId: binding.deviceId, bindingEpoch: binding.epoch, registrationId: 'authenticated-fixture', threadId });

  it.each([null, 'thread-b'])('recovers with the ordinary human text on the original route %s and preserves schedules', async target => {
    f.setBackend('agy');
    await history(1, false);
    await f.bind();
    await (f.handler as any).loadScheduleCatalog();
    const threadId = target ?? 'thread-a';
    await f.send('/schedule after 5m -- Preserve this timer', threadId);
    const originalTimers = () => f.handler['schedules']!.list({ ...owner(), threadId,
      generation: (f.handler as any).scheduleGeneration(threadId), bindingEpoch: binding.epoch });
    const before = await originalTimers();
    expect(before).toEqual(expect.arrayContaining([expect.objectContaining({ engine: 'host', state: 'active' })]));
    await f.send('/schedule after 5m -- Other thread only', threadId === 'thread-a' ? 'thread-b' : 'thread-a');
    let listed: { records: { id: string }[] } | undefined;
    const resume = vi.fn(async (_prompt: string, options: import('../src/executor/IExecutor').ExecuteOptions) => {
      options.onAgyHumanPromptAdmitted!(() => true);
      const bridge = (f.handler as any).delegationBridges.get(threadId);
      listed = await bridge.handler('remote_cli_schedule_list', { requestId: 'owned-list' }, 'native-call');
      return { success: true };
    });
    Object.assign(f.executor, { needsAgyHumanRecovery: vi.fn().mockReturnValueOnce(true), resumeAgyChat: resume });
    const humanSource = source(target);
    await f.send('Continue here', 'thread-a', { threadId: target ?? undefined, isSlashCommand: false, humanSource });
    expect(resume).toHaveBeenCalledWith('Continue here', expect.objectContaining({ onStream: expect.any(Function) }),
      expect.objectContaining({ originalMessageId: humanSource.originalMessageId, current: expect.any(Function) }));
    expect(f.responses().at(-1)).toMatchObject({ success: true, threadId: target ?? 'thread-a' });
    expect(listed?.records.map(record => record.id).sort()).toEqual(before.map(record => record.id).sort());
    expect(await originalTimers()).toEqual(before);
    expect(JSON.stringify(f.ws.trackTask.mock.calls)).not.toContain('Continue here');
    await f.send('Ordinary follow-up', target ?? 'thread-a', { isSlashCommand: false,
      humanSource: { ...source(target ?? 'thread-a'), originalMessageId: 'second-event' } });
    expect(resume).toHaveBeenCalledOnce();
    expect(f.executor.execute).toHaveBeenCalledOnce();
  });

  it('keeps failed recovery single-use and requires a current authenticated human route', async () => {
    await f.bind(); f.setBackend('agy');
    const resume = vi.fn(async () => ({ success: false, error: 'Prompt too long' }));
    Object.assign(f.executor, { needsAgyHumanRecovery: () => true, resumeAgyChat: resume });
    for (const extra of [{ threadId: undefined }, { openId: 'other' }, { humanSource: { ...source(), bindingEpoch: 'old' } },
      { humanSource: { ...source(), registrationId: 'old-connection' } }, { humanSource: { ...source(), deviceId: 'other' } },
      { humanSource: { ...source(), createdAt: Date.now() - 300001 } }]) {
      await f.send('Continue', 'thread-a', { isSlashCommand: false, humanSource: source(), ...extra });
    }
    expect(resume).not.toHaveBeenCalled();
    await f.send('Continue', 'thread-a', { isSlashCommand: false, humanSource: source() });
    expect(resume).toHaveBeenCalledOnce();
    expect(f.responses().at(-1).error).toBe('Prompt too long');
    expect(f.executor.execute).not.toHaveBeenCalled();
  });

  it('accepts a small clock difference and reports invalid timestamps only on the bound route', async () => {
    await f.bind(); f.setBackend('agy');
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const send = (offset: number, openId = 'owner') => f.send('Continue', 'thread-a', { openId, isSlashCommand: false,
      humanSource: { ...source(), createdAt: now + offset } });
    await send(20_000);
    expect(f.executor.execute).toHaveBeenCalledOnce();
    for (const offset of [40_000, -301_000]) {
      await send(offset);
      expect(f.responses().at(-1)).toMatchObject({ success: false, openId: 'owner', error: expect.stringContaining('timestamp') });
    }
    const count = f.responses().length;
    await send(40_000, 'another-owner');
    expect(f.responses()).toHaveLength(count);
    clock.mockReturnValue(now - 10_000);
    await send(-301_000);
    expect(f.responses().at(-1)?.success).toBe(false);
    await send(-10_000);
    expect(f.executor.execute).toHaveBeenCalledTimes(2);
  });

  it('rejects expired queued recovery metadata without dispatching either execution path', async () => {
    await f.bind();
    f.setBackend('agy');
    const resume = vi.fn(async () => ({ success: true }));
    Object.assign(f.executor, { needsAgyHumanRecovery: () => true, resumeAgyChat: resume });
    f.setExecutorBusy(true);
    await f.send('Continue after expiry', 'thread-a', { isSlashCommand: false, humanSource: source() });
    const confirmation = f.responses().at(-1)?.queueConfirmation;
    expect(confirmation).toBeDefined();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 300_001);
    f.setExecutorBusy(false);
    await f.send('/queue confirm ' + confirmation!.id);
    await vi.waitFor(() => expect(f.responses().at(-1)?.success).toBe(false));
    expect(resume).not.toHaveBeenCalled();
    expect(f.executor.execute).not.toHaveBeenCalled();
  });

  it.each([null, 'thread-b'])('recovers a sourced human message through the confirmed queue exactly once on route %s', async target => {
    await f.bind();
    f.setBackend('agy');
    await history(1, false);
    await (f.handler as any).loadScheduleCatalog();
    const threadId = target ?? 'thread-a';
    await f.send('/schedule after 5m -- Preserve queued timer', threadId);
    const originalTimers = () => f.handler['schedules']!.list({ ...owner(), threadId,
      generation: (f.handler as any).scheduleGeneration(threadId), bindingEpoch: binding.epoch });
    const before = await originalTimers();
    let recovered = false;
    const resume = vi.fn(async () => { recovered = true; return { success: true }; });
    const needs = vi.fn(() => !recovered);
    Object.assign(f.executor, { needsAgyHumanRecovery: needs, resumeAgyChat: resume });
    f.setExecutorBusy(true);
    const humanSource = source(target);
    await f.send('Continue queued', 'thread-a', { threadId: target ?? undefined, isSlashCommand: false, humanSource });
    const confirmation = f.responses().at(-1)?.queueConfirmation;
    expect(confirmation).toBeDefined();
    expect(resume).not.toHaveBeenCalled();
    f.setExecutorBusy(false);
    await f.send('/queue confirm ' + confirmation!.id, threadId);
    await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());
    expect(f.executor.execute).not.toHaveBeenCalled();
    expect(await originalTimers()).toEqual(before);
    expect(needs).toHaveBeenCalledWith(humanSource.originalMessageId);
    await f.send('Plain follow-up', target ?? 'thread-a', { isSlashCommand: false,
      humanSource: { ...source(target ?? 'thread-a'), originalMessageId: 'next-event' } });
    expect(f.executor.execute).toHaveBeenCalledWith(expect.stringContaining('Plain follow-up'), expect.objectContaining({ agyHumanMessage: true }));
    expect(resume).toHaveBeenCalledOnce();
  });

  it('identifies an authenticated queued message on the ordinary AGY execution path', async () => {
    await f.bind();
    f.setBackend('agy');
    f.setExecutorBusy(true);
    await f.send('Message while busy', 'thread-a', { isSlashCommand: false, humanSource: source() });
    const confirmation = f.responses().at(-1)?.queueConfirmation;
    expect(confirmation).toBeDefined();
    f.setExecutorBusy(false);
    await f.send('/queue confirm ' + confirmation!.id);
    await vi.waitFor(() => expect(f.executor.execute).toHaveBeenCalledWith(expect.stringContaining('Message while busy'),
      expect.objectContaining({ agyHumanMessage: true })));
  });

  it('rejects queued recovery after the authenticated registration changes', async () => {
    await f.bind();
    f.setBackend('agy');
    const resume = vi.fn(async () => ({ success: true }));
    Object.assign(f.executor, { needsAgyHumanRecovery: () => true, resumeAgyChat: resume });
    f.setExecutorBusy(true);
    await f.send('Continue after reconnect', 'thread-a', { isSlashCommand: false, humanSource: source() });
    const confirmation = f.responses().at(-1)?.queueConfirmation;
    expect(confirmation).toBeDefined();
    f.setExecutorBusy(false);
    f.disconnect();
    await f.reconnect();
    await f.handler.handleMessage({ type: 'binding_confirm', data: { success: true,
      registrationId: 'replacement-registration', scheduleBinding: binding,
      capabilities: { scheduleResultsV1: true, hostSchedulesV1: true } } } as any);
    const original = f.responses().at(-1)!.messageId;
    const before = f.responses().filter(response => response.messageId === original).length;
    await f.send('/queue confirm ' + confirmation!.id);
    await vi.waitFor(() => expect(f.handler['threadQueues'].get('thread-a')).toBeUndefined());
    expect(f.responses().filter(response => response.messageId === original)).toHaveLength(before);
    expect(resume).not.toHaveBeenCalled();
    expect(f.executor.execute).not.toHaveBeenCalled();
  });

  it('executes sourced ordinary text normally on other backends', async () => {
    await f.bind();
    const resume = vi.fn();
    const check = vi.fn(() => true);
    Object.assign(f.executor, { needsAgyHumanRecovery: check, resumeAgyChat: resume });
    await f.send('Continue', 'thread-a', { isSlashCommand: false, humanSource: source() });
    expect(check).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(f.executor.execute).toHaveBeenCalledOnce();
  });

  it('keeps timers and synthetic commands on the normal execution path', async () => {
    f.setBackend('agy');
    const { dispatch } = await dispatchFixture();
    const resume = vi.fn();
    Object.assign(f.executor, { needsAgyHumanRecovery: () => true, resumeAgyChat: resume });
    expect(await dispatch()).toMatchObject({ success: true });
    await f.send('Synthetic command', 'thread-a', { isSlashCommand: false });
    expect(f.executor.execute).toHaveBeenCalledTimes(2);
    expect(resume).not.toHaveBeenCalled();
  });

  it.each(backends)('dispatches a %s host occurrence once in the original session', async backend => {
    f.setBackend(backend);
    const { dispatch, record } = await dispatchFixture();
    const admit = vi.fn(async () => true);
    f.executor.execute.mockImplementation(async (prompt, options) => {
      expect(admit).toHaveBeenCalledOnce();
      expect(options.hostScheduleSessionId).toBe('bound');
      expect(options.resolvePrompt?.('bound')).toBe(record.prompt);
      expect(prompt).toBe(record.prompt);
      options.onDisplayText?.('Visible assistant text.');
      return { success: true, output: 'Internal executor diagnostics' };
    });
    expect(await dispatch(admit)).toMatchObject({ success: true, output: 'Visible assistant text.' });
    expect(f.executor.execute).toHaveBeenCalledOnce();
    expect(f.executor.withNativeScheduleOperation).not.toHaveBeenCalled();
    expect(f.pool.setThreadBusy.mock.calls).toEqual([['thread-a', true], ['thread-a', false]]);
  });

  it.each(['original', 'consumed', 'stale receipt', 'different session', 'legacy', 'missing generation', 'damaged checkpoint', 'native owner'])(
    'classifies an unadmitted AGY timer on a saved selection: %s', async scenario => {
      f.setBackend('agy');
      const { dispatch } = await dispatchFixture();
      const folder = path.join(f.cwd, '.remote-cli', 'agy-sessions');
      await mkdir(folder);
      const file = path.join(folder, 'thread-a.json');
      const pointer = JSON.stringify({ id: 'bound', transport: scenario === 'legacy' ? 'legacy' : 'acp', retired: false,
        hostGeneration: scenario === 'missing generation' ? undefined : '11111111-1111-4111-8111-111111111111',
        ...(scenario === 'consumed' && { manualResumeConsumedGeneration: '11111111-1111-4111-8111-111111111111' }),
        ...(scenario === 'stale receipt' && { manualResumeConsumedGeneration: 'previous-generation' }),
        ...(scenario === 'damaged checkpoint' && { hostScheduleCheckpoint: null }) });
      await writeFile(file, pointer);
      const executor = new AgyExecutor(new DirectoryGuard([f.cwd]), { threadId: 'thread-a', initialWorkingDirectory: f.cwd });
      if (scenario === 'different session') await writeFile(file, pointer.replace('bound', 'replacement'));
      if (scenario === 'native owner') await writeFile(file + '.native-schedules', '{}');
      vi.spyOn(f.pool, 'getExecutor').mockReturnValue(executor as unknown as typeof f.executor);
      vi.spyOn(f.pool, 'getExistingExecutor').mockReturnValue(executor as unknown as typeof f.executor);
      const execute = vi.spyOn(executor, 'execute');
      const admit = vi.fn(async () => true);
      const saved = await readFile(file, 'utf8');
      expect(await dispatch(admit)).toMatchObject(scenario === 'original'
        ? { success: false, skippedBeforeAdmission: true, error: expect.stringContaining('normal Feishu message') }
        : scenario === 'consumed' ? { success: false, skippedBeforeAdmission: true, error: expect.stringContaining('already consumed') }
        : { success: false, stopSchedule: true });
      expect(admit).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(await readFile(file, 'utf8')).toBe(saved);
    });

  it('does not classify an admitted AGY slot as skipped if the checkpoint disappears before dispatch', async () => {
    f.setBackend('agy');
    const { dispatch } = await dispatchFixture();
    const result = await dispatch(async () => {
      f.executor.checkHostScheduleSession.mockImplementation(() => { throw new AgyManualResumeScheduleSkip('required'); });
      return true;
    });
    expect(result).toMatchObject({ success: false, stopSchedule: true });
    expect(result.skippedBeforeAdmission).toBeUndefined();
    expect(f.executor.execute).not.toHaveBeenCalled();
  });

  it.each(backends)('limits deferral for an observed AGY command to the AGY backend (%s)', async backend => {
    f.setBackend(backend);
    const { dispatch } = await dispatchFixture();
    const waiting = vi.fn(() => true);
    Object.assign(f.executor, { isHostScheduleWaitingForCommand: waiting });
    const admit = vi.fn(async () => true);
    if (backend === 'agy') {
      const run = dispatch(admit);
      expect(waiting).toHaveBeenCalledWith('bound', f.cwd);
      expect(admit).not.toHaveBeenCalled();
      expect(f.executor.execute).not.toHaveBeenCalled();
      waiting.mockReturnValue(false);
      await f.send('/queue');
      expect(await run).toMatchObject({ success: true });
    } else {
      expect(await dispatch(admit)).toMatchObject({ success: true });
    }
    expect(f.executor.execute).toHaveBeenCalledOnce();
    expect(admit).toHaveBeenCalledOnce();
    if (backend !== 'agy') expect(waiting).not.toHaveBeenCalled();
  });

  it('delivers the admitted AGY result when its verified command is still pending', async () => {
    f.setBackend('agy');
    const { dispatch } = await dispatchFixture();
    const waiting = vi.fn(() => false);
    Object.assign(f.executor, { isHostScheduleWaitingForCommand: waiting });
    f.executor.execute.mockImplementationOnce(async () => {
      waiting.mockReturnValue(true);
      f.executor.checkHostScheduleSession.mockImplementation(() => { throw new Error('Command still running'); });
      return { success: true, output: 'Foreground result' };
    });
    expect(await dispatch()).toMatchObject({ success: true, output: 'Foreground result' });
    const controller = new AbortController();
    const queued = dispatch(undefined, controller.signal);
    controller.abort();
    expect(await queued).toBeUndefined();
    expect(f.executor.execute).toHaveBeenCalledOnce();
  });

  it.each(['DONE', 'ERROR'])('delivers one pinned AGY occurrence after a foreground %s and command exit', async status => {
    f.setBackend('agy');
    vi.spyOn(hooks, 'installAgyScheduleHooks').mockImplementation(syntheticAgyHooks.installAgyScheduleHooks);
    vi.spyOn(hooks, 'AgyHookRelay').mockImplementation((home, accept) =>
      new syntheticAgyHooks.AgyHookRelay(home, accept) as unknown as hooks.AgyHookRelay);
    const scheduled = 'Report the synthetic scheduled result';
    const prompts: string[] = [];
    let completeCommand!: () => void;
    class Client extends SyntheticAgyActivityClient {
      async prompt(session: string, blocks: { text: string }[]) {
        expect(session).toBe(this.session);
        const prompt = blocks[0].text;
        prompts.push(prompt);
        let initialNumSteps = this.rows.length;
        const invocation = (event: string) => this.hook(event, { initialNumSteps, invocationNum: 0 });
        const begin = () => { initialNumSteps = this.rows.length; invocation('PreInvocation'); };
        const row = (type: string, content: string, status = 'DONE', source = 'MODEL') => {
          this.rows.push({ step_index: this.rows.length, type, content, status, source });
        };
        const plan = (name: string, args: Record<string, string>) => {
          row('PLANNER_RESPONSE', '');
          this.rows.at(-1)!.tool_calls = [{ name, args }];
          const stepIdx = this.rows.length;
          const payload = { stepIdx, toolCall: { id: 'call-' + stepIdx, name, args } };
          expect(this.hook('PreToolUse', payload)).toEqual({ decision: 'allow' });
          return payload;
        };
        const finish = (text: string, fullyIdle = true) => {
          row('PLANNER_RESPONSE', text); invocation('PostInvocation');
          this.hook('Stop', { terminationReason: 'NO_TOOL_CALL', error: '', fullyIdle, continuationActive: false });
        };
        this.hook('SessionStart'); begin();
        if (prompt === 'Ordinary foreground') {
          const tool = plan('write_file', { Path: path.join(f.cwd, 'synthetic.txt'), Content: 'fixture' });
          const error = 'synthetic write failure';
          this.hook('PostToolUse', { ...tool, error: status === 'ERROR' ? error : '' });
          row('GENERIC', status === 'ERROR' ? 'Encountered error in step execution: ' + error : 'File written', status);
          invocation('PostInvocation'); begin();
          const shell = plan('run_command', { CommandLine: 'echo synthetic' });
          const task = session + '/task-' + shell.stepIdx;
          const log = pathToFileURL(path.join(f.cwd, '.remote-cli', 'agy-homes', 'thread-a', '.gemini',
            'antigravity-cli', 'brain', session, '.system_generated', 'tasks', 'task-' + shell.stepIdx + '.log')).href;
          row('GENERIC', 'Tool is running as a background task with task id: ' + task
            + '\nTask Description: Synthetic command\nTask logs are available at: ' + log, 'RUNNING');
          invocation('PostInvocation'); begin(); finish('Foreground answer', false);
          completeCommand = () => {
            this.hook('PostToolUse', shell); begin();
            row('SYSTEM_MESSAGE', NOTIFICATION_PREFIX + '[Message] timestamp=2030-01-01T00:00:00Z sender=' + task
              + ' priority=MESSAGE_PRIORITY_HIGH content=Task id "' + task
              + '" finished with result:\nCommand exited with code 0.\n\nNo output from the command.\nLog: ' + log + '\n</SYSTEM_MESSAGE>', 'DONE', 'SYSTEM');
            finish('Command completed');
          };
        } else finish(prompt === scheduled ? 'Scheduled answer' : 'Ready');
        return { stopReason: 'end_turn' };
      }
    }
    vi.spyOn(acp, 'AcpClient').mockImplementation((command, args, cwd, callbacks) =>
      new Client(command, args, cwd, callbacks!) as unknown as acp.AcpClient);
    const executor = new AgyExecutor(new DirectoryGuard([f.cwd]), { threadId: 'thread-a', initialWorkingDirectory: f.cwd });
    const execute = vi.spyOn(executor, 'execute');
    vi.spyOn(f.pool, 'getExecutor').mockReturnValue(executor as unknown as typeof f.executor);
    vi.spyOn(f.pool, 'getExistingExecutor').mockReturnValue(executor as unknown as typeof f.executor);
    try {
      await f.bind(); await expect(executor.execute('Initialize')).resolves.toMatchObject({ success: true });
      await f.send('/schedule after 5m -- ' + scheduled);
      expect(f.responses().at(-1)).toMatchObject({ success: true });
      const [job] = await records();
      expect(job.sessionId).toBe(executor.getSessionId());
      await expect(executor.execute('Ordinary foreground')).resolves.toMatchObject({ success: true, output: 'Foreground answer' });
      const service = f.handler['schedules']!;
      const now = vi.spyOn(service as any, 'now').mockReturnValue(job.nextDueAt);
      const dispatch = vi.spyOn(service as any, 'dispatchHost');
      await service['wakeHosts']();
      expect(dispatch).toHaveBeenCalledOnce();
      expect(await service.list(job)).toMatchObject([{ state: 'active', nextDueAt: job.nextDueAt }]);
      expect(f.scheduledResults()).toEqual([]);
      expect(prompts).toEqual(['Initialize', 'Ordinary foreground']);
      f.holdResultAck();
      completeCommand();
      await f.send('/queue');
      now.mockReturnValue(job.nextDueAt! + 2000);
      await service['wakeHosts']();
      const id = job.id + ':host-' + job.nextDueAt;
      await vi.waitFor(() => expect(f.scheduledResults()).toMatchObject([
        { messageId: id, success: true, output: 'Scheduled answer', threadId: 'thread-a', openId: 'owner' },
      ]));
      const file = path.join(f.handler['scheduleDirectory'](), HOST_SCHEDULE_CATALOG_FILE);
      const catalog = async () => JSON.parse(await readFile(file, 'utf8'));
      expect(await catalog()).toMatchObject({ records: [{ id: job.id, state: 'completed' }],
        pending: [{ id, scheduleId: job.id, output: 'Scheduled answer' }] });
      for (const acknowledge of f.acknowledgements) acknowledge(id);
      await vi.waitFor(async () => expect((await catalog()).pending).toEqual([]));
      await service['wakeHosts'](); await service.retryDeliveries();
      expect(prompts).toEqual(['Initialize', 'Ordinary foreground', scheduled]);
      expect(execute).toHaveBeenLastCalledWith(scheduled, expect.objectContaining({ hostScheduleSessionId: job.sessionId }));
      expect(acp.AcpClient).toHaveBeenCalledOnce();
      expect(f.scheduledResults()).toHaveLength(1);
    } finally { await executor.destroy(); agyActivity.clients.length = 0; }
  });

  it('continues ordinary and next scheduled chat after an ordinary error inside a due occurrence', async () => {
    f.setBackend('agy');
    vi.spyOn(hooks, 'installAgyScheduleHooks').mockImplementation(syntheticAgyHooks.installAgyScheduleHooks);
    vi.spyOn(hooks, 'AgyHookRelay').mockImplementation((home, accept) =>
      new syntheticAgyHooks.AgyHookRelay(home, accept) as unknown as hooks.AgyHookRelay);
    const first = 'First scheduled occurrence', second = 'Second scheduled occurrence', ordinary = 'Ordinary after error';
    const prompts: string[] = [];
    class Client extends SyntheticAgyActivityClient {
      async prompt(session: string, blocks: { text: string }[]) {
        expect(session).toBe(this.session);
        const prompt = blocks[0].text;
        prompts.push(prompt);
        let initialNumSteps = this.rows.length;
        const invocation = (event: string) => this.hook(event, { initialNumSteps, invocationNum: 0 });
        const begin = () => { initialNumSteps = this.rows.length; invocation('PreInvocation'); };
        const row = (type: string, content: string, status = 'DONE', source = 'MODEL') => {
          this.rows.push({ step_index: this.rows.length, type, content, status, source });
        };
        const plan = (name: string, args: Record<string, string>) => {
          row('PLANNER_RESPONSE', '');
          this.rows.at(-1)!.tool_calls = [{ name, args }];
          const stepIdx = this.rows.length;
          const payload = { stepIdx, toolCall: { id: 'call-' + stepIdx, name, args } };
          expect(this.hook('PreToolUse', payload)).toEqual({ decision: 'allow' });
          return payload;
        };
        const finish = (text: string) => {
          row('PLANNER_RESPONSE', text); invocation('PostInvocation');
          this.hook('Stop', { terminationReason: 'NO_TOOL_CALL', error: '', fullyIdle: true, continuationActive: false });
        };
        this.hook('SessionStart'); begin();
        if (prompt === first) {
          const tool = plan('mcp_fixture_lookup', { query: 'synthetic' });
          const error = 'synthetic scheduled tool failure';
          this.hook('PostToolUse', { ...tool, error });
          row('GENERIC', 'Encountered error in step execution: ' + error, 'ERROR');
          invocation('PostInvocation'); begin(); finish('First scheduled answer');
        } else finish(prompt === second ? 'Second scheduled answer' : prompt === ordinary ? 'Ordinary answer' : 'Ready');
        return { stopReason: 'end_turn' };
      }
    }
    vi.spyOn(acp, 'AcpClient').mockImplementation((command, args, cwd, callbacks) =>
      new Client(command, args, cwd, callbacks!) as unknown as acp.AcpClient);
    const executor = new AgyExecutor(new DirectoryGuard([f.cwd]), { threadId: 'thread-a', initialWorkingDirectory: f.cwd });
    const execute = vi.spyOn(executor, 'execute');
    vi.spyOn(f.pool, 'getExecutor').mockReturnValue(executor as unknown as typeof f.executor);
    vi.spyOn(f.pool, 'getExistingExecutor').mockReturnValue(executor as unknown as typeof f.executor);
    try {
      await f.bind(); await expect(executor.execute('Initialize')).resolves.toMatchObject({ success: true });
      await f.send('/schedule after 5m -- ' + first);
      const [firstJob] = await records();
      expect(firstJob.sessionId).toBe(executor.getSessionId());
      const service = f.handler['schedules']!;
      const now = vi.spyOn(service as any, 'now').mockReturnValue(firstJob.nextDueAt);
      const dispatch = vi.spyOn(service as any, 'dispatchHost');
      await service['wakeHosts']();
      expect(dispatch).toHaveBeenCalledOnce();
      await dispatch.mock.results[0].value;
      await vi.waitFor(() => expect(f.scheduledResults()).toHaveLength(1));
      expect(f.scheduledResults()[0]).toMatchObject({ success: true, output: 'First scheduled answer' });
      expect(prompts).toEqual(['Initialize', first]);
      await expect(executor.execute(ordinary)).resolves.toMatchObject({ success: true, output: 'Ordinary answer' });
      now.mockReturnValue(Date.now());
      await f.send('/schedule after 5m -- ' + second);
      expect(f.responses().at(-1).error).toBeUndefined();
      expect(f.responses().at(-1)).toMatchObject({ success: true });
      const jobs = await records();
      const secondJob = jobs.find(job => job.id !== firstJob.id)!;
      expect(secondJob).toBeDefined();
      expect(secondJob.sessionId).toBe(firstJob.sessionId);
      now.mockReturnValue(secondJob.nextDueAt);
      await service['wakeHosts']();
      expect(dispatch).toHaveBeenCalledTimes(2);
      await dispatch.mock.results[1].value;
      await vi.waitFor(() => expect(f.scheduledResults()).toHaveLength(2));
      expect(f.scheduledResults()[1]).toMatchObject({ success: true, output: 'Second scheduled answer' });
      await service['wakeHosts'](); await service.retryDeliveries();
      expect(prompts).toEqual(['Initialize', first, ordinary, second]);
      expect(execute).toHaveBeenLastCalledWith(second, expect.objectContaining({ hostScheduleSessionId: firstJob.sessionId }));
      expect(acp.AcpClient).toHaveBeenCalledOnce();
    } finally { await executor.destroy(); agyActivity.clients.length = 0; }
  });

  it('holds an occurrence while disconnected and accepts the original binding on reconnect', async () => {
    const { dispatch, deliver } = await dispatchFixture();
    const admit = vi.fn(async () => true);
    f.disconnect();
    expect(await dispatch(admit)).toBeUndefined();
    await expect(deliver()).rejects.toThrow('unavailable');
    expect(admit).not.toHaveBeenCalled();
    await f.reconnect();
    expect(await dispatch(admit)).toMatchObject({ success: true });
    await deliver();
    expect(f.scheduledResults()).toMatchObject([{ threadId: 'thread-a', openId: 'owner', queueStarted: {
      scheduleId: 'host-task', bindingEpoch: binding.epoch }, output: 'Synthetic result' }]);
  });

  it('stops a recurring slot when an idle executor rejects the session or selects a replacement', async () => {
    const { record, dispatch } = await dispatchFixture();
    Object.assign(record, { rule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' } });
    const admit = vi.fn(async () => true);
    f.executor.checkHostScheduleSession.mockImplementationOnce(() => { throw new Error('Saved history is missing'); });
    expect(await dispatch(admit)).toMatchObject({ success: false, stopSchedule: true });
    expect(admit).not.toHaveBeenCalled();
    expect(await dispatch(admit)).toMatchObject({ success: true });
    f.executor.getSessionId.mockReturnValue('replacement');
    expect(await dispatch(admit)).toMatchObject({ success: false, stopSchedule: true });
    expect(f.executor.execute).toHaveBeenCalledOnce();
  });

  it('retires a stale AGY session at the head and releases the following confirmed message', async () => {
    f.setBackend('agy');
    const { dispatch } = await dispatchFixture();
    const controller = new AbortController();
    Object.assign(f.executor, { isHostScheduleWaitingForCommand: () => true });
    const admit = vi.fn(async () => true);
    const waiting = dispatch(admit, controller.signal);
    await f.send('Use the current chat', 'thread-a', { isSlashCommand: false });
    const confirmation = f.responses().at(-1).queueConfirmation;
    await f.send('/queue confirm ' + confirmation.id);
    expect(f.executor.execute).not.toHaveBeenCalled();
    f.executor.getSessionId.mockReturnValue('replacement');
    await f.send('/queue');
    expect(await waiting).toMatchObject({ success: false, stopSchedule: true });
    await vi.waitFor(() => expect(f.executor.execute).toHaveBeenCalledOnce());
    expect(f.executor.execute.mock.calls[0][0]).toContain('Use the current chat');
    expect(admit).not.toHaveBeenCalled();
  });

  it('preserves a returned upstream failure and marks transport loss during execution unknown', async () => {
    const { dispatch } = await dispatchFixture();
    f.executor.execute.mockResolvedValueOnce({ success: false, output: '', error: 'Upstream unavailable' } as any);
    expect(await dispatch()).toEqual({ success: false, output: '', error: 'Upstream unavailable' });
    f.executor.execute.mockRejectedValueOnce(new Error('Connection lost'));
    expect(await dispatch()).toMatchObject({ success: false, outcomeUnknown: true, error: 'Connection lost' });
  });

  it.each([{ ...binding, openId: 'other' }, { ...binding, epoch: 'new-binding' }, { ...binding, deviceId: 'other-device' }])(
    'rechecks binding during admission and before delivering a retained result (%j)', async replacement => {
      const { dispatch, deliver } = await dispatchFixture();
      expect(await dispatch(async () => { await f.bind(false, false, replacement); return true; })).toMatchObject({ success: false });
      await expect(deliver()).rejects.toThrow();
      expect(f.executor.execute).not.toHaveBeenCalled();
      expect(f.scheduledResults()).toHaveLength(0);
    });

  it.each(['busy', 'goal', 'abort', 'delegation', 'shared workspace', 'settings'])('holds cancellable host admission during %s work', async reason => {
    const { dispatch } = await dispatchFixture();
    const raw = f.handler as any;
    if (reason === 'busy') f.setExecutorBusy(true);
    if (reason === 'goal') raw.pendingGoalActivations.set('thread-a', { cancelled: false });
    if (reason === 'abort') raw.abortOperations.set('thread-a', Promise.resolve());
    if (reason === 'delegation') vi.spyOn(raw.delegation, 'hasActiveTasks').mockReturnValue(true);
    if (reason === 'shared workspace') vi.spyOn(raw.delegation, 'blocksWorkspace').mockReturnValue(true);
    if (reason === 'settings') vi.spyOn(raw.settingsAdmission, 'isBlocked').mockReturnValue(true);
    const admit = vi.fn(async () => true);
    const controller = new AbortController();
    const queued = dispatch(admit, controller.signal);
    expect(raw.hostWaiters.get('thread-a')).toHaveLength(1);
    controller.abort();
    expect(raw.hostWaiters.size).toBe(0);
    expect(await queued).toBeUndefined();
    expect(admit).not.toHaveBeenCalled(); expect(f.executor.execute).not.toHaveBeenCalled();
  });

  it.each(['session', 'backend', 'generation', 'guard', 'cancelled'])('rechecks %s after durable host admission', async reason => {
    const { dispatch } = await dispatchFixture();
    const result = await dispatch(async () => {
      if (reason === 'session') f.executor.getSessionId.mockReturnValue('replaced');
      if (reason === 'backend') f.setBackend('codex');
      if (reason === 'generation') f.threads[0].delegationWorkspaceGeneration = 17;
      if (reason === 'guard') f.executor.checkHostScheduleSession.mockImplementation(() => { throw new Error('Retired binding'); });
      return reason !== 'cancelled';
    });
    if (reason === 'cancelled') expect(result).toBeUndefined();
    else expect(result).toMatchObject({ success: false, error: expect.any(String) });
    expect(f.executor.execute).not.toHaveBeenCalled();
  });

  it.each(['scheduled', 'ordinary'])('orders due occurrences and confirmations during an active %s turn', async first => {
    const { dispatch, record } = await dispatchFixture();
    let release!: () => void;
    f.executor.execute.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { release = resolve; });
      return { success: true };
    });
    const ordinary = (text: string) => f.send(text, 'thread-a', { isSlashCommand: false });
    const active = first === 'scheduled' ? dispatch() : ordinary('Active chat');
    await vi.waitFor(() => expect(f.executor.execute).toHaveBeenCalledOnce());
    const confirm = async (text: string) => {
      await ordinary(text);
      const id = f.responses().at(-1)?.queueConfirmation?.id;
      expect(id).toEqual(expect.any(String));
      return () => f.send('/queue confirm ' + id);
    };
    const late = await confirm('Confirmed second');
    await (await confirm('Confirmed first'))();
    const admit = vi.fn(async () => true);
    const due = dispatch(admit, undefined, 'next');
    expect(await dispatch(admit, undefined, 'next')).toBeUndefined();
    await late();
    const later = dispatch(admit, undefined, 'later');
    await f.send('/queue');
    expect(f.responses().at(-1)?.output).toContain('Confirmed: 2; awaiting confirmation: 0');
    expect(admit).not.toHaveBeenCalled();
    release();
    await Promise.all([active, due, later]);
    expect(f.executor.execute.mock.calls.map(([prompt]) => prompt.split('\n').at(-1))).toEqual([
      first === 'scheduled' ? record.prompt : 'Active chat', 'Confirmed first', record.prompt, 'Confirmed second', record.prompt,
    ]);
    expect(admit).toHaveBeenCalledTimes(2);
  });

  it.each(['same binding', 'new binding'])('rechecks a waiting occurrence on reconnect with %s', async scenario => {
    const { dispatch } = await dispatchFixture();
    f.setExecutorBusy(true);
    const admit = vi.fn(async () => true);
    const queued = dispatch(admit);
    f.disconnect();
    f.setExecutorBusy(false);
    expect(admit).not.toHaveBeenCalled();
    if (scenario === 'same binding') {
      await f.reconnect();
      expect(await queued).toMatchObject({ success: true });
      expect(admit).toHaveBeenCalledOnce();
    } else {
      await f.reconnect(false, { ...binding, epoch: 'other' });
      expect(await queued).toBeUndefined();
      expect(admit).not.toHaveBeenCalled();
    }
  });

  it('automatically drains a released shared workspace in the original order', async () => {
    const { dispatch, record } = await dispatchFixture();
    const blocked = vi.spyOn((f.handler as any).delegation, 'blocksWorkspace').mockReturnValue(true);
    const run = dispatch();
    await f.send('Chat after schedule', 'thread-a', { isSlashCommand: false });
    await f.send('/queue confirm ' + f.responses().at(-1).queueConfirmation.id);
    expect(f.executor.execute).not.toHaveBeenCalled();
    blocked.mockReturnValue(false);
    expect(await run).toMatchObject({ success: true });
    await vi.waitFor(() => expect(f.executor.execute.mock.calls.map(([text]) => text.split('\n').at(-1)))
      .toEqual([record.prompt, 'Chat after schedule']));
  });

  it.each(['chat', 'schedule'])('preserves a failure pause with only a schedule behind a failed queued %s', async first => {
    const { dispatch } = await dispatchFixture();
    f.setExecutorBusy(true);
    f.executor.execute.mockResolvedValueOnce({ success: false, error: 'Synthetic failure' });
    let firstRun;
    if (first === 'schedule') {
      firstRun = dispatch();
    } else {
      await f.send('Queued chat', 'thread-a', { isSlashCommand: false });
      await f.send('/queue confirm ' + f.responses().at(-1).queueConfirmation.id);
    }
    const admit = vi.fn(async () => true);
    const next = dispatch(admit, undefined, 'next');
    f.setExecutorBusy(false);
    await f.send('/queue continue');
    await vi.waitFor(() => expect((f.handler as any).pausedQueues.has('thread-a')).toBe(true));
    await firstRun;
    await f.send('/queue');
    expect(f.responses().at(-1).output).toContain('Paused after a failed task');
    expect(admit).not.toHaveBeenCalled();
    await f.send('/queue continue');
    expect(await next).toMatchObject({ success: true });
    expect(admit).toHaveBeenCalledOnce();
  });

  it.each(['continue', 'clear'])('removes a cancelled head while a message queue is paused, then handles /queue %s', async action => {
    const { dispatch, record } = await dispatchFixture();
    f.setExecutorBusy(true);
    const admit = vi.fn(async () => true);
    const controller = new AbortController();
    const cancelled = dispatch(admit, controller.signal);
    await f.send('Queued message', 'thread-a', { isSlashCommand: false });
    const confirmation = f.responses().at(-1).queueConfirmation;
    await f.send('/queue confirm ' + confirmation.id);
    const remaining = dispatch(admit, undefined, 'remaining');
    (f.handler as any).pauseQueueAfterFailure('thread-a', 'Synthetic failure');
    f.setExecutorBusy(false);
    controller.abort();
    expect(await cancelled).toBeUndefined();
    await f.send('/queue');
    expect(f.responses().at(-1).output).toContain('Confirmed: 1');
    expect(admit).not.toHaveBeenCalled();
    expect(f.executor.execute).not.toHaveBeenCalled();
    await f.send('/queue ' + action);
    expect(await remaining).toMatchObject({ success: true });
    expect(admit).toHaveBeenCalledOnce();
    expect(f.executor.execute.mock.calls.map(([prompt]) => prompt.split('\n').at(-1)))
      .toEqual(action === 'clear' ? [record.prompt] : ['Queued message', record.prompt]);
  });

  it('rejects a different session resolved by the native transport', async () => {
    const { dispatch } = await dispatchFixture();
    f.executor.execute.mockImplementationOnce(async (_prompt, options) => {
      options.resolvePrompt!('unexpected-session');
      throw new Error('Wrong session accepted');
    });
    expect(await dispatch()).toMatchObject({ success: false, error: expect.stringContaining('original native session') });
  });

  it('holds thread ownership until a user abort settles and reports only this fire interrupted', async () => {
    const { dispatch } = await dispatchFixture();
    let release!: () => void;
    f.executor.execute.mockImplementationOnce((_prompt, options) => new Promise((_resolve, reject) => {
      options.onDisplayText?.('Partial answer');
      release = () => reject(new Error('Executor interrupted'));
    }));
    f.executor.abort.mockImplementationOnce(async () => { release(); return true; });
    const running = dispatch();
    await vi.waitFor(() => expect(f.executor.execute).toHaveBeenCalledOnce());
    expect(await dispatch()).toBeUndefined();
    await f.send('Continue this conversation', 'thread-a', { isSlashCommand: false });
    const confirmation = f.responses().at(-1)?.queueConfirmation;
    expect(confirmation?.id).toEqual(expect.any(String));
    await f.send(`/queue confirm ${confirmation.id} queued-owner-chat`);
    expect(f.responses().at(-1)).toMatchObject({ success: true, openId: 'owner', threadId: 'thread-a' });
    await f.send('/abort', 'thread-a', { openId: 'other-owner' });
    expect(f.responses().at(-1)).toMatchObject({ success: false });
    expect(f.executor.abort).not.toHaveBeenCalled();
    await f.send('/abort');
    expect(await running).toMatchObject({ success: false, abortedByUser: true, output: 'Partial answer', error: expect.stringContaining('/abort') });
    expect(f.responses()).toContainEqual(expect.objectContaining({ success: true, output: expect.stringContaining('occurrence'), openId: 'owner', threadId: 'thread-a' }));
    await vi.waitFor(() => expect(f.responses()).toContainEqual(expect.objectContaining({
      messageId: 'queued-owner-chat', success: true, openId: 'owner', threadId: 'thread-a',
    })));
    expect(f.executor.execute).toHaveBeenCalledTimes(2);
    expect(f.executor.abort).toHaveBeenCalledOnce();
    expect(f.handler.tryBeginAutomaticUpdate()).toBe(true);
  });

  it('does not abort an executor while the scheduled occurrence is awaiting admission', async () => {
    const { dispatch } = await dispatchFixture();
    const result = await dispatch(async () => {
      await f.send('/abort');
      expect(f.responses().at(-1).output).toContain('has not started');
      return false;
    });
    expect(result).toBeUndefined();
    expect(f.executor.abort).not.toHaveBeenCalled();
    expect(f.executor.execute).not.toHaveBeenCalled();
  });

  it('keeps the executor failure when interruption was not confirmed', async () => {
    const { dispatch } = await dispatchFixture();
    let release!: () => void;
    f.executor.execute.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ success: false, error: 'Provider failure' });
    }));
    f.executor.abort.mockResolvedValueOnce(false);
    const running = dispatch();
    await vi.waitFor(() => expect(f.executor.execute).toHaveBeenCalledOnce());
    await f.send('/abort');
    expect(f.responses().at(-1).success).toBe(false);
    release();
    expect(await running).toEqual({ success: false, error: 'Provider failure', output: undefined });
  });

  it.each(['claude', 'agy', 'dsh'])('reads the stored %s catalog through text and model tools', async backend => {
    f.setBackend(backend); await history(1, false); await f.bind();
    await f.send('/schedule list');
    expect(f.responses().at(-1)).toMatchObject({ success: true, output: expect.stringContaining('historical-0') });
    f.executor.execute.mockImplementationOnce(async () => {
      const listed = await invoke('remote_cli_schedule_list', { requestId: 'read-only-list' });
      expect(listed).toMatchObject({ status: 'succeeded', records: [{ id: 'historical-0', state: 'interrupted' }] });
      return { success: true };
    });
    await f.send('List the historical schedule', 'thread-a', { isSlashCommand: false });
    expect(f.responses().at(-1).success).toBe(true);
    expect(f.executor.withNativeScheduleOperation).not.toHaveBeenCalled();
  });

  function installRetainedCleanup() {
    const cancelRetained = vi.fn(async () => {});
    Object.assign(f.executor, { nativeScheduleCleanup: { provider: 'claude-session-skip-unadmitted-v1',
      strategy: 'reconstruct', cancelRetained } });
    return cancelRetained;
  }

  async function history(count = 1, attributed = true, output?: string) {
    const owner = { threadId: 'thread-a', openId: 'owner', generation: (f.handler as any).scheduleGeneration('thread-a') };
    const records = Array.from({ length: count }, (_, index) => ({ ...owner, id: `historical-${index}`, backend: f.pool.getBackendKey(),
      cwd: f.cwd, state: output ? 'completed' : 'interrupted', nativeId: `native-${index}`, prompt: 'Synthetic historical task', createdAt: Date.now(),
      rule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' },
      ...(attributed ? { recovery: { version: 1, provider: 'claude-session-skip-unadmitted-v1', strategy: 'reconstruct', status: 'blocked',
        identity: JSON.stringify({ marker: '11111111-1111-4111-8111-111111111111', sessionId: 'bound', threadId: owner.threadId, cwd: f.cwd }) } } : {}) }));
    const directory = (f.handler as any).scheduleDirectory();
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, SCHEDULE_CATALOG_FILE), JSON.stringify({ version: 3, records, purged: [], pending: output
      ? [{ id: 'historical-0:done', scheduleId: 'historical-0', occurrenceId: 'done', success: true, output }] : [] }));
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
    expect(catalog.version).toBe(6); expect(catalog.records).toEqual([]); expect(catalog.pending).toEqual([]);
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
    expect(cleanup).not.toHaveBeenCalled();
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
    const [sibling] = await records();
    await f.restart(); await f.bind();
    await f.send('/schedule purge all', 'thread-a', { messageId: 'fixed-purge-request' });
    const catalog = JSON.parse(await readFile(path.join(directory, SCHEDULE_CATALOG_FILE), 'utf8'));
    expect(await records()).toMatchObject([{ id: sibling.id, state: 'active' }]);
    expect(catalog.purgeRequests).toHaveLength(1);
    expect(f.responses().at(-1).output).toContain('Already removed: historical-0');
    await f.send(`/schedule purge ${sibling.id}`, 'thread-a', { messageId: 'fixed-purge-request' });
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
    expect(f.responses().at(-1)).toMatchObject({ success: false, error: expect.stringContaining('device binding') });
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

    await f.restart(); await f.bind(); await f.send('/schedule list');
    expect(f.responses().at(-1).output).toContain('No schedules');
    await f.send('/schedule purge legacy-attributed');
    expect(f.responses().at(-1).output).toContain('Already removed: legacy-attributed.');
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
  it('captures the actual native conversation for a persistent host task without starting a turn', async () => {
    await f.bind(); await f.send('/schedule after 5m -- Synthetic future work');
    expect(f.responses().at(-1)).toMatchObject({ success: true, output: expect.stringContaining('across restarts') });
    expect(await records()).toMatchObject([{ engine: 'host', sessionId: 'bound', threadId: 'thread-a' }]);
    expect(f.executor.execute).not.toHaveBeenCalled();
    expect(f.executor.withNativeScheduleOperation).not.toHaveBeenCalled();
    expect(f.executor.configureManagedTools).not.toHaveBeenCalled();
  });

  it('reloads the host catalog offline at startup and keeps the original session binding', async () => {
    await f.bind();
    await f.send('/schedule cron "15 9 * * 1-5" --tz Asia/Shanghai -- Synthetic recurring task');
    const [original] = await records();
    expect(original).toMatchObject({ engine: 'host', sessionId: 'bound', state: 'active' });
    f.disconnect(); await f.restart();
    await f.handler.prepareScheduleStartup();
    expect(await records()).toMatchObject([{ id: original.id, engine: 'host', sessionId: 'bound', state: 'active' }]);

    await f.reconnect();
    await f.send('/schedule cancel ' + original.id);
    expect(await records()).toMatchObject([{ state: 'cancelled' }]);
  });

  it('does not start shared native management for an empty list or unknown cancellation', async () => {
    await f.bind(); await f.send('/schedule list');
    await f.send('/schedule cancel unknown-synthetic-job');
    expect(f.executor.withNativeScheduleOperation).not.toHaveBeenCalled();
    expect(f.executor.configureManagedTools).not.toHaveBeenCalled();
  });

  it('scopes interrupted legacy cancellation and reports missing native ownership without claiming success', async () => {
    await history(1, false);
    const id = 'historical-0';
    Object.assign(f.executor, { nativeScheduleCleanup: { provider: 'fixture-recovery', strategy: 'reconstruct',
      describe: () => 'fixture-identity', cancelRetained: vi.fn() } });
    await f.bind(); f.executor.withNativeScheduleOperation.mockClear();
    await f.send(`/schedule cancel ${id}`);
    expect(f.executor.withNativeScheduleOperation).not.toHaveBeenCalled();
    expect(f.responses().at(-1)).toMatchObject({ success: false });
    expect(f.responses().at(-1).error).toContain('ownership metadata');
  });

  it.each(backends)('makes stored schedule management available to a %s foreground turn by default', async backend => {
    f.setBackend(backend);
    await f.bind();
    let receipt: unknown;
    f.executor.execute.mockImplementationOnce(async () => {
      receipt = await invoke('remote_cli_schedule_list', { requestId: 'default-list' });
      return { success: true };
    });
    await f.send('List my scheduled tasks.', 'thread-a', { isSlashCommand: false });
    expect(receipt).toMatchObject({ status: 'succeeded', records: [] });
    expect(f.executor.configureManagedTools.mock.calls[0][0].groups).toEqual(['scheduling']);
    expect(f.executor.execute).toHaveBeenCalledOnce();
    expect(f.executor.withNativeScheduleOperation).not.toHaveBeenCalled();
  });

  it.each(backends)('creates %s managed schedules from model tools with delegation off and a separate card', async backend => {
    f.setBackend(backend); await f.bind(true, true);
    f.executor.execute.mockImplementation(async () => {
      const result = await invoke('remote_cli_schedule_create', createArgs);
      expect(result).toMatchObject({ status: 'succeeded', card: 'Management card delivered.' });
      expect(result).not.toHaveProperty('nativeAction');
      expect(await invoke('remote_cli_schedule_create', createArgs)).toEqual(result);
      return { success: true, output: 'Original assistant answer remains independent.' };
    });
    await f.send('Please check the build in five minutes.', 'thread-a', { isSlashCommand: false });
    expect(f.responses().at(-1)).toMatchObject({ success: true });
    expect(await records()).toMatchObject([{ backend, engine: 'host', sessionId: 'bound', bindingEpoch: binding.epoch }]);
    const card = f.ws.send.mock.calls.map(([message]) => message).find(message => message.type === 'schedule_tool_card');
    expect(card).toMatchObject({ openId: 'owner', threadId: 'thread-a', menu: { entries: [{ state: 'active' }] } });
    expect(f.responses().at(-1).scheduleMenu).toBeUndefined();
    expect(f.executor.execute).toHaveBeenCalledOnce();
    expect(f.executor.configureManagedTools.mock.calls[0][0].groups).toEqual(['scheduling']);
    expect(f.threads[0].delegation).toBe(false);
    await action(card.menu, 'cancel');
    expect(await records()).toMatchObject([{ state: 'cancelled' }]);
    expect(f.executor.withNativeScheduleOperation).not.toHaveBeenCalled();
    expect((f.handler as any).delegationBridges.get('thread-a').handler).toBeUndefined();
  });

  it('keeps the old Router usable for chat and explains the required upgrade on host creation', async () => {
    await f.handler.handleMessage({ type: 'binding_confirm', data: { success: true, capabilities: { scheduleResultsV1: true } } } as any);
    let receipt: unknown;
    f.executor.execute.mockImplementation(async () => {
      receipt = await invoke('remote_cli_schedule_create', createArgs);
      return { success: true };
    });
    await f.send('Run this later', 'thread-a', { isSlashCommand: false });
    expect(receipt).toMatchObject({ status: 'failed', error: expect.stringContaining('Upgrade or reconnect the Router') });
    expect(f.responses().at(-1).success).toBe(true);
     expect((f.handler as any).schedules).toBeUndefined();
  });

  it.each([false, true])('preserves scheduling after authorized Codex model recovery without accepting other settings changes (%s)', async changeEffort => {
    await f.bind(true, true);
    await f.send('/schedule after 5m -- Synthetic existing task');
    const [job] = await records();
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
        expect(await invoke('remote_cli_schedule_cancel', { requestId: 'cancel-recovered', scheduleId: job.id })).toMatchObject({ status: 'succeeded' });
      }
      return { success: true };
    });
    await f.send('Inspect and cancel the existing synthetic task', 'thread-a', { isSlashCommand: false });
    expect(f.executor.execute).toHaveBeenCalledTimes(2);
    expect((await records())[0].state).toBe(changeEffort ? 'active' : 'cancelled');
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
      { goalRequest: { objective: 'Synthetic native goal' } })).toBe(true);
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
    expect(await records()).toHaveLength(1);
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
    expect(await records()).toHaveLength(1);
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
     expect((f.handler as any).schedules).toBeUndefined();
  });

  it('keeps a host schedule after a missing card receipt and does not duplicate on tool retry', async () => {
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
    expect(await records()).toHaveLength(1);
  });

  it.each(['abort', 'generation', 'disconnect'])('cancels host creation when %s retires the creating turn', async boundary => {
    await f.bind(true, true);
    const service: ScheduleService = await (f.handler as any).initializeSchedules();
    const create = service.create.bind(service);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const delayed = vi.spyOn(service, 'create').mockImplementation(async (...args) => {
      const record = await create(...args); await gate; return record;
    });
    const cancel = vi.spyOn(service, 'cancel');
    f.executor.execute.mockImplementation(async () => {
      const request = invoke('remote_cli_schedule_create', createArgs);
      await vi.waitFor(() => expect(delayed).toHaveBeenCalledOnce());
      if (boundary === 'abort') (f.handler as any).cancelThreadOperation('thread-a', 'Synthetic abort');
      if (boundary === 'generation') f.threads[0].delegationWorkspaceGeneration = 42;
      if (boundary === 'disconnect') f.disconnect();
      release(); await expect(request).rejects.toThrow('context changed');
      return { success: true };
    });
    await f.send('Synthetic pending request', 'thread-a', { isSlashCommand: false });
    expect(cancel).toHaveBeenCalledOnce();
    expect(f.ws.send.mock.calls.some(([message]) => message.type === 'schedule_tool_card')).toBe(false);
  });

  it('creates a host task from a restricted turn with an older Router and reports its text fallback', async () => {
    await f.bind(); f.setSandbox({ mode: 'read-only' });
    f.executor.execute.mockImplementation(async () => {
      expect(await invoke('remote_cli_schedule_create', createArgs)).toMatchObject({ status: 'succeeded', card: expect.stringContaining('/schedule list') });
      return { success: true };
    });
    await f.send('Synthetic older Router request', 'thread-a', { isSlashCommand: false });
    expect(await records()).toMatchObject([{ engine: 'host' }]);
    expect(f.executor.configureSandbox).not.toHaveBeenCalled();
  });

  it('reports a late creation failure even when the model finishes after receiving pending', async () => {
    await f.bind(true, true);
    let fail!: (error: Error) => void;
    const create = vi.spyOn(ScheduleService.prototype, 'create').mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
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
    expect(create).toHaveBeenCalledOnce();
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
    expect(await records()).toHaveLength(1);
    expect((f.handler as any).delegationBridges.get('thread-a').handler).toBeUndefined();
  });

  it('requires an established session for slash creation', async () => {
    await f.bind();
    f.executor.getSessionId.mockReturnValue(null);
    await f.send('/schedule after 5m -- Synthetic task');
    expect(f.responses().at(-1)).toMatchObject({ success: false, error: expect.stringContaining('ordinary message') });
    expect((f.handler as any).schedules).toBeUndefined();
    expect(f.executor.execute).not.toHaveBeenCalled();
  });

  const action = (menu: any, operation = 'refresh', extra: Record<string, unknown> = {}) => f.handler.handleMessage({
    type: 'schedule_action', messageId: 'card-request', openId: 'owner', threadId: 'thread-a',
    snapshotId: menu.snapshotId, operation, ...(operation === 'cancel' ? { value: menu.entries[0].value } : {}),
    timestamp: Date.now(), ...extra,
  } as any);
  const receipts = () => f.ws.send.mock.calls.map(([message]) => message).filter(message => message.type === 'schedule_action_result');

  it.each(['claude', 'dsh', 'agy'].flatMap(backend => ['slash', 'tool'].map(entry => ({ backend, entry }))))('round trips $backend $entry card confirmation through the host schedule service', async ({ backend, entry }) => {
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
      captureOwnership: openId => () => openId === binding.openId,
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
      expect(await records()).toMatchObject([{ state: 'active' }]);
      await click('confirm');
      expect(JSON.stringify(elements)).toContain('Cancellation confirmed');
      expect(f.executor.withNativeScheduleOperation).not.toHaveBeenCalled();
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
  });

  it('keeps a failed retained deletion retryable from its card', async () => {
    await history();
    const cancel = installRetainedCleanup().mockRejectedValueOnce(new Error('Synthetic lost deletion receipt'));
    await f.bind(true); await f.send('/schedule list');
    await action(f.responses().at(-1).scheduleMenu, 'cancel');
    const failed = receipts().at(-1);
    expect(failed).toMatchObject({ success: false, menu: { entries: [{ state: 'interrupted', canCancel: true }] } });
    await action(failed.menu, 'cancel', { messageId: 'retry-cleanup' });
    expect(receipts().at(-1)).toMatchObject({ success: true, menu: { entries: [{ state: 'cancelled', canCancel: false }] } });
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(f.executor.execute).not.toHaveBeenCalled();
  });

  it('invalidates disconnected card snapshots and reserves cancellation against automatic update', async () => {
    await history(); const cancelRetained = installRetainedCleanup(); await f.bind(true);
    await f.send('/schedule list'); const menu = f.responses().at(-1).scheduleMenu;
    let release!: () => void;
    cancelRetained.mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); });
    const pending = action(menu, 'cancel');
    await vi.waitFor(() => expect(cancelRetained).toHaveBeenCalledOnce());
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
    const recover = vi.spyOn(f.handler as any, 'loadScheduleCatalog');
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

    expect(console.warn).not.toHaveBeenCalled();
    await f.handler.destroy();
    await expect(stat(path.join(f.cwd, 'config', 'schedules'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['missing', 'undefined'])('ignores an optional %s config directory in non-scheduling clients', async mode => {
    (f.config as any).getConfigDir = mode === 'missing' ? undefined : () => undefined;
    const recover = vi.spyOn(f.handler as any, 'loadScheduleCatalog');
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

  it.each(['agy', 'dsh'])('keeps interrupted %s list and purge catalog-only and lets an explicit clear reach the executor guard', async backend => {
    f.setBackend(backend); await history(1, false);
    await f.restart(); await f.reconnect(); await (f.handler as any).loadScheduleCatalog();
    f.executor.withNativeScheduleOperation.mockClear().mockRejectedValue(new Error('No live native host'));
    await f.send('/schedule list');
    expect(f.responses().at(-1).output).toContain('interrupted');
    const service = (f.handler as any).schedules as ScheduleService;
    const owner = { threadId: 'thread-a', openId: 'owner', generation: (f.handler as any).scheduleGeneration('thread-a') };
    const id = (await service.list({ ...owner, bindingEpoch: binding.epoch }))[0].id;
    await f.send(`/schedule purge ${id}`);
    expect(await service.listCleanup(owner)).toMatchObject([{ id, reason: 'unattributed' }]);
    await f.send('/clear');
    expect(f.pool.clearThreadContext).toHaveBeenCalled();
    expect(f.executor.withNativeScheduleOperation).not.toHaveBeenCalled();
  });

  it('loads interrupted schedule status at binding without restoring or touching native inventory', async () => {
    await history(1, false); await f.bind();
    await f.restart(); await f.handler.prepareScheduleStartup();
    expect(f.handler.tryBeginAutomaticUpdate()).toBe(true); await f.handler.endAutomaticUpdate();
    await f.reconnect(); await (f.handler as any).loadScheduleCatalog();
    await f.send('/schedule list');
    expect(f.responses().at(-1).output).toContain('interrupted');

    expect(f.handler.tryBeginAutomaticUpdate()).toBe(true); f.handler.endAutomaticUpdate();
  });

  it.each([false, true])('updates with idle schedules without handoff or recovery (installer failure=%s)', async fail => {
    Object.assign(f.executor, { nativeScheduleCleanup: { provider: 'fixture-persistent-v1', strategy: 'reattach',
      describe: () => 'original-fixture-session' } });
    await history(1, false); await f.bind();
    const install = vi.fn(async () => { if (fail) throw new Error('Synthetic installer failure'); });
    const updater = new AutomaticUpdater('1.6.256', f.handler, { installVersion: install, restartAfterUpdate: false });
    try {
      await updater.handleRouterVersion('1.6.257');
      expect(install).toHaveBeenCalledOnce();

      await f.send('Foreground after install', 'thread-a', { isSlashCommand: false });
      expect(f.responses().at(-1).success).toBe(true);
    } finally { clearTimeout((updater as any).retryTimer); }
  });

  it('does not re-admit updates after handler destruction when no schedules exist', async () => {
    await f.bind(); await f.handler.destroy();
    expect(f.handler.tryBeginAutomaticUpdate()).toBe(false);
  });

  it('loads local interruption state with an older Router without waiting for unsupported result transport', async () => {
    await history(1, false);
    await f.handler.prepareScheduleStartup();
    await f.handler.handleMessage({ type: 'binding_confirm', data: { success: true, capabilities: {} } } as any);
    await (f.handler as any).loadScheduleCatalog();
    expect((f.handler as any).scheduleCatalogPending).toBe(false);
    expect(f.handler.tryBeginAutomaticUpdate()).toBe(true); f.handler.endAutomaticUpdate();
    await f.send('/clear', 'thread-b');
    expect(f.pool.clearThreadContext).toHaveBeenCalled();
    expect(f.scheduledResults()).toEqual([]);
  });

  it('keeps a completed outbox with an older Router and delivers only after capability negotiation', async () => {
    await history(1, false, 'Synthetic saved result'); await f.handler.prepareScheduleStartup();
    await f.handler.handleMessage({ type: 'binding_confirm', data: { success: true, capabilities: {} } } as any);
    await (f.handler as any).loadScheduleCatalog();
    expect((f.handler as any).scheduleCatalogPending).toBe(false);
    expect((f.handler as any).schedules.hasPendingResults()).toBe(true);
    expect(f.scheduledResults()).toEqual([]);
    expect(f.handler.tryBeginAutomaticUpdate()).toBe(false);
    await f.reconnect(); await (f.handler as any).loadScheduleCatalog();
    expect(f.scheduledResults()).toHaveLength(1);
    expect((f.handler as any).schedules.hasPendingResults()).toBe(false);
  });

  it('startup inventory check leaves users without catalogs dormant and update-eligible', async () => {
    await f.handler.prepareScheduleStartup();
    expect(f.handler.tryBeginAutomaticUpdate()).toBe(true);
    f.handler.endAutomaticUpdate();

    expect(f.acknowledgements.size).toBe(0);
  });

  it.each(['claude', 'agy', 'dsh'])('recovers a persisted %s outbox after handler restart', async backend => {
    f.setBackend(backend); await history(1, false, 'Persisted result');
    expect(f.acknowledgements.size).toBe(0);
    await f.reconnect();
    await vi.waitFor(() => expect(f.scheduledResults()).toHaveLength(1));
    expect(f.scheduledResults()[0]).toMatchObject({ output: 'Persisted result', openId: 'owner', threadId: 'thread-a' });
    await f.reconnect();
    await (f.handler as any).loadScheduleCatalog();
    expect(f.scheduledResults()).toHaveLength(1);
    expect(f.acknowledgements.size).toBe(1);
  });

  it('drops a saved native result when the thread generation has changed', async () => {
    const { directory } = await history(1, false, 'Stale generation result');
    f.threads[0].delegationWorkspaceGeneration = 1;
    await f.reconnect(); await (f.handler as any).loadScheduleCatalog();
    expect(f.scheduledResults()).toEqual([]);
    const catalog = JSON.parse(await readFile(path.join(directory, SCHEDULE_CATALOG_FILE), 'utf8'));
    expect(catalog.pending).toEqual([]);
    expect(catalog.records).toHaveLength(1);
  });

  it('isolates a malformed existing catalog from ordinary chat, controls and shutdown', async () => {
    const directory = (f.handler as any).scheduleDirectory();
    await mkdir(directory, { recursive: true });
    const catalog = path.join(directory, SCHEDULE_CATALOG_FILE);
    await writeFile(catalog, 'invalid catalog');
    const recover = vi.spyOn(f.handler as any, 'loadScheduleCatalog');
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
  });

  it('does not block chat or activate recovery after shutdown during a slow catalog check', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const lstat = fs.promises.lstat.bind(fs.promises);
    vi.spyOn(fs.promises, 'lstat').mockImplementation((async (...args: Parameters<typeof lstat>) => {
      if (String(args[0]).endsWith(SCHEDULE_CATALOG_FILE)) { await gate; return {} as any; }
      return lstat(...args);
    }) as typeof fs.promises.lstat);
    const recover = vi.spyOn(f.handler as any, 'loadScheduleCatalog');
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
    const recover = vi.spyOn(f.handler as any, 'loadScheduleCatalog');
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

    expect(f.acknowledgements.size).toBe(1);
    await f.send(`/schedule cancel ${(await records())[0].id}`);
    expect(await records()).toMatchObject([{ state: 'cancelled' }]);
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
  });

  it('shows all eight backend capabilities without executing a model and requires a confirmed Router binding for creation', async () => {
    await f.send('/schedule capabilities');
    const capabilities = f.responses().at(-1).output;
    for (const label of ['Claude', 'DSH', 'AGY', 'Codex', 'Kimi', 'OpenCode', 'Pi', 'ZCode']) {
      expect(capabilities).toContain(label + ': supported');
    }

    await f.send('/schedule after 2m -- Return a summary');
    expect(f.responses().at(-1)).toMatchObject({ success: false, error: expect.stringContaining('Router') });
    expect(f.executor.execute).not.toHaveBeenCalled();
  });

  it('rejects an unknown backend without starting a fallback', async () => {
    await f.bind();
    f.setBackend('unknown');
    for (const command of [
      '/schedule after 2m -- Return a summary',
      '/schedule cron "15 9 * * 1-5" --tz Asia/Shanghai -- Return a summary',
    ]) {
      await f.send(command);
      expect(f.responses().at(-1)).toMatchObject({ success: false,
        error: expect.stringContaining('unsupported') });
      expect(f.responses().at(-1).error).toContain('unknown backend');
      expect(f.responses().at(-1).error).toContain('/schedule capabilities');
    }
    await f.send('/schedule list');
    expect(f.responses().at(-1).output).toContain('No schedules');

    expect(f.executor.execute).not.toHaveBeenCalled();
  });

  it('allows listing and cancelling a captured schedule after switching backends', async () => {
    await f.bind();
    await f.send('/schedule after 2m -- Return a summary');
    const [job] = await records();
    f.setBackend('codex');
    await f.send('/schedule list');
    expect(f.responses().at(-1).output).toContain(job.id);
    await f.send(`/schedule cancel ${job.id}`);
    expect(f.responses().at(-1)).toMatchObject({ success: true, output: expect.stringContaining('cancelled') });

    expect(f.executor.execute).not.toHaveBeenCalled();
  });

  it('keeps restricted sandbox settings and rejects attachment shortcuts', async () => {
    await f.bind();
    f.setSandbox({ mode: 'read-only' });
    await f.send('/schedule after 2m -- Return a summary');
    expect(f.responses().at(-1)).toMatchObject({ success: true });
    expect(f.executor.configureSandbox).not.toHaveBeenCalled();
    await f.send('/schedule after 2m -- Read this', 'thread-a', { fileIds: ['file-fixture'] });
    expect(f.responses().at(-1).success).toBe(false);
  });

  it('honors a persisted per-thread sandbox even when global defaults are unrestricted', async () => {
    await f.bind();
    const directory = path.join(f.cwd, '.remote-cli', 'claude-sandbox');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'thread-a.json'), JSON.stringify({ mode: 'read-only' }));
    await f.send('/schedule after 2m -- Return a summary');
    expect(f.responses().at(-1)).toMatchObject({ success: true });
    expect(f.executor.configureSandbox).not.toHaveBeenCalled();
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

    const [task] = await records();
    expect(task).toMatchObject({ backend: 'dsh', engine: 'host', execution: { command: 'dsh-fixture', model: 'chosen-dsh-model', effort: 'high' } });
    f.setBackend('codex');
    await f.send(`/schedule cancel ${task.id}`);
    expect(f.responses().at(-1).success).toBe(true);
  });

  it('reserves update admission before asynchronous initialization and rechecks before host creation', async () => {
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

    f.handler.endAutomaticUpdate();
  });

});
