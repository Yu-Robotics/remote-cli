import { ScheduleCards } from '../../router/src/feishu/ScheduleCards';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'fs/promises';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MessageHandler } from '../src/client/MessageHandler';
import { DirectoryGuard } from '../src/security/DirectoryGuard';
import { ThreadContextReset } from '../src/thread/ThreadContextReset';
import type { Thread } from '../src/thread/types';
import type { NativeScheduleEvent, NativeScheduleInput } from '../src/scheduling/types';
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
  const executor = { createNativeSchedule: vi.fn((input: any, emit: any) => (input.backend === 'dsh' ? native.createDsh : native.create)(input, emit)),
    withNativeScheduleOperation: vi.fn(async (_id: string, current: () => boolean, run: () => Promise<unknown>) => {
      if (!current()) throw new Error('Stale scheduling operation');
      return run();
    }), configureManagedTools: vi.fn(async (_connection?: any) => {}), configureDelegation: vi.fn(async (_connection?: any) => {}), execute: vi.fn(async () => ({ success: true })), getCurrentWorkingDirectory: () => cwd,
    abort: vi.fn(async () => true), destroy: vi.fn(), isBusy: () => executorBusy, resetContext: vi.fn(),
    getSandboxStatus: () => 'Unrestricted', configureSandbox: vi.fn(async () => ({ success: true })) };
  const pool = {
    getExistingExecutor: () => executor, getExecutor: () => executor, getBackendKey: () => backend,
    getSummaries: () => threads.map(thread => ({ id: thread.id, name: thread.name, status: 'idle' })),
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

  it.each(['claude', 'dsh'])('creates %s managed schedules from model tools with delegation off and a separate card', async backend => {
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
    job.emit({ type: 'completed', occurrenceId: 'shutdown-run', success: true, output: 'Retained across shutdown' });
    const catalog = path.join((f.handler as any).scheduleDirectory(), SCHEDULE_CATALOG_FILE);
    await vi.waitFor(async () => expect(JSON.parse(await readFile(catalog, 'utf8')).pending).toHaveLength(1));
    job.handle.stop.mockImplementation(async () => {
      job.emit({ type: 'stopped', exitConfirmed: true, reason: 'Shutdown completed' });
    });
    await f.restart();
    expect(job.handle.stop).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(catalog, 'utf8')).pending).toHaveLength(1);
    expect(f.scheduledResults()).toHaveLength(0);
    await f.reconnect();
    await vi.waitFor(() => expect(f.scheduledResults()).toHaveLength(1));
    expect(f.scheduledResults()[0]).toMatchObject({ output: 'Retained across shutdown', threadId: 'thread-a' });
    await vi.waitFor(async () => expect(JSON.parse(await readFile(catalog, 'utf8')).pending).toEqual([]));
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
      expect(f.responses().at(-1).success, `${command}: ${f.responses().at(-1).error}`).toBe(true);
    }
    expect(f.acknowledgements.size).toBe(0);
    expect(f.handler.tryBeginAutomaticUpdate()).toBe(true);
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
    ['codex', 'app-server'], ['agy', 'stream-json'], ['kimi', 'ACP'],
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
