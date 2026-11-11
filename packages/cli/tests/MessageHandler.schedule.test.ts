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
  const executor = { execute: vi.fn(async () => ({ success: true })), getCurrentWorkingDirectory: () => cwd,
    abort: vi.fn(async () => true), destroy: vi.fn(), isBusy: () => false, resetContext: vi.fn(),
    getSandboxStatus: () => 'Unrestricted', configureSandbox: vi.fn(async () => ({ success: true })) };
  const pool = {
    getExistingExecutor: () => executor, getExecutor: () => executor, getBackendKey: () => backend,
    getSummaries: () => threads.map(thread => ({ id: thread.id, name: thread.name, status: 'idle' })),
    isThreadBusy: () => false, setThreadBusy: vi.fn(), setThreadError: vi.fn(), destroyAll: vi.fn(async () => {}),
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
  const bind = () => handler.handleMessage({ type: 'binding_confirm', data: { success: true,
    capabilities: { scheduleResultsV1: true, taskRecovery: true } } } as any);
  const responses = () => ws.send.mock.calls.map(([message]) => message).filter(message => message.type === 'response');
  return { cwd, threads, get handler() { return handler; }, pool, manager, ws, jobs, send, bind, responses, executor, config,
    acknowledgements, closeHandlers,
    restart: async () => { await handler.destroy(); handler = makeHandler(); scheduledMessages.clear(); ws.send.mockClear(); },
    setBackend: (value: string) => { backend = value; }, setSandbox: (value: { mode: string }) => { sandbox = value; },
    disconnect: () => { connected = false; closeHandlers.forEach(handler => handler(1006, '')); },
    reconnect: async () => { connected = true; await bind(); },
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

  it('keeps never-used scheduling dormant across binding, reconnect, chat and ordinary controls', async () => {
    const recover = vi.spyOn(f.handler as any, 'recoverSchedules');
    const initialize = vi.spyOn(ScheduleService.prototype, 'initialize');
    const closeListeners = f.closeHandlers.size;
    await f.bind();
    f.disconnect();
    await f.reconnect();
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
