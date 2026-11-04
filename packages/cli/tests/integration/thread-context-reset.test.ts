import { randomUUID } from 'crypto';
import { captureCodexDeletionTarget } from '../../src/delegation/NativeSessionDeletion';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { isMainThread } from 'worker_threads';
import { MessageHandler } from '../../src/client/MessageHandler';
import { ThreadManager } from '../../src/thread/ThreadManager';
import { ThreadExecutorPool } from '../../src/thread/ThreadExecutorPool';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { DelegationManager } from '../../src/delegation/DelegationManager';
import { DelegatedWorkerSessionStore, type DelegatedWorkerLane } from '../../src/delegation/DelegatedWorkerSessionStore';
import { DELEGATION_BACKENDS, type DelegationBackend } from '../../src/delegation/contract';
import type { IExecutor } from '../../src/executor/IExecutor';
import type { ExecutorConfig } from '../../src/types/config';
import { DshExecutor } from '../../src/executor/DshExecutor';
import { runGit } from '../../src/delegation/GitCheckpoint';

describe('thread-wide conversation reset', () => {
  let home: string;
  let project: string;
  let threads: ThreadManager;
  let pool: ThreadExecutorPool;
  let handler: MessageHandler;
  let expectedShutdownFailure = false;
  let delegation: DelegationManager;
  let threadId: string;
  let siblingId: string;
  let sent: any[];
  let requestNumber: number;
  let factory: ReturnType<typeof vi.fn>;
  let current: IExecutor;
  const originalHomedir = os.homedir.bind(os);
  const pointer = (backend: string, id: string) => path.join(home, '.remote-cli', `${backend}-sessions`, `${id}.json`);
  const write = async (file: string, value = 'preserved fixture') => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, value);
    return file;
  };
  const send = async (content: string, target = threadId) => {
    const messageId = `request-${++requestNumber}`;
    await handler.handleMessage({ type: 'command', messageId, threadId: target, content,
      isSlashCommand: content.startsWith('/'), timestamp: Date.now() } as any);
    return sent.filter(message => message.type === 'response' && message.messageId === messageId).at(-1);
  };
  const attach = () => {
    const guard = new DirectoryGuard([home]);
    const config: ExecutorConfig = { type: 'codex' };
    factory = vi.fn((_guard, _config, cwd, id) => {
      const saved = existsSync(pointer('codex', id)) ? readFileSync(pointer('codex', id), 'utf8') : null;
      return { saved, execute: vi.fn(async () => ({ success: true, output: 'Fresh answer' })),
        getCurrentWorkingDirectory: () => cwd, setWorkingDirectory: vi.fn(), resetContext: vi.fn(),
        abort: vi.fn(), destroy: vi.fn(async () => {}), waitForExit: vi.fn(async () => {}) };
    });
    pool = new ThreadExecutorPool(threads, guard, config, factory);
    sent = [];
    requestNumber = 0;
    handler = new MessageHandler({ send: message => sent.push(message), isConnected: () => true } as any,
      pool, threads, guard, { get: key => key === 'executor' ? config : undefined,
        getSharedSymlinks: () => [],
        getConfigDir: () => path.join(home, '.remote-cli') } as any);
    delegation = (handler as any).delegation;
  };
  const reload = async () => {
    await handler.destroy();
    threads = await ThreadManager.initialize(home);
    attach();
  };
  const lane = async (backend: DelegationBackend, owner = threadId, generation = 3) => {
    const result = await delegation.laneStore.acquire({ threadId: owner, backend, workingDirectory: project,
      workspaceGeneration: generation }, { pooled: true });
    await write(pointer(backend, result.lane.executorThreadId), 'old worker conversation');
    if (backend === 'dsh') await write(pointer(backend, result.lane.executorThreadId).replace('.json', '.handoff.json'), 'old worker summary');
    return result.lane;
  };
  const ready = async (...lanes: DelegatedWorkerLane[]) => {
    for (const value of lanes) await delegation.laneStore.markReady(value.id);
  };
  const seedDirect = async () => {
    for (const backend of DELEGATION_BACKENDS) {
      await write(pointer(backend, threadId), 'old direct conversation');
      await write(pointer(backend, siblingId), 'sibling conversation');
    }
    await write(pointer('dsh', threadId).replace('.json', '.handoff.json'), 'old compact summary');
  };
  const assertBlocked = async () => {
    expect(() => pool.getExecutor(threadId)).toThrow('incomplete');
    await expect(delegation.laneStore.acquire({ threadId, backend: 'codex', workingDirectory: project, workspaceGeneration: 3 },
      { pooled: true })).rejects.toThrow('incomplete');
    expect(() => delegation.begin({ thread: threads.getThread(threadId)!, cwd: project,
      backend: 'codex', config: { type: 'codex' }, messageId: 'blocked', onToolUse: vi.fn(), onToolResult: vi.fn(), onNotice: vi.fn() }))
      .toThrow('incomplete');
    await expect(pool.switchThreadBackend(threadId, 'pi')).rejects.toThrow('incomplete');
    await expect(pool.switchBackend({ type: 'pi' })).rejects.toThrow('incomplete');
    for (const command of ['ordinary prompt', '/skills', '/compact', '/backend 1 @', '/resume', '/session detach', '/model']) {
      expect(await send(command)).toMatchObject({ success: false, error: expect.stringContaining('incomplete') });
    }
    expect(factory).not.toHaveBeenCalled();
  };

  beforeEach(async () => {
    expect(isMainThread).toBe(true);
    expectedShutdownFailure = false;
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'thread-context-reset-')));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.spyOn(os, 'homedir').mockImplementation(() => process.env.HOME || process.env.USERPROFILE || originalHomedir());
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    project = path.join(home, 'project');
    await fs.mkdir(project);
    threads = await ThreadManager.initialize(home);
    threadId = threads.getDefaultThread().id;
    siblingId = (await threads.createThread('sibling', project, 'pi')).id;
    await threads.updateThread(threadId, { workingDirectory: project, delegationWorkspaceGeneration: 3,
      sessionId: 'old-session', delegation: false, backend: 'codex', models: { codex: 'saved-model' }, efforts: { codex: 'high' } });
    attach();
  });
  afterEach(async () => {
    if (expectedShutdownFailure) await expect(handler.destroy()).rejects.toThrow('storage ownership was retained');
    else await handler?.destroy();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true });
  });

  it.each(['/clear', '/new'])('queues A and B for permanent deletion on %s without touching main, siblings or newer generations', async command => {
    const a = await lane('codex');
    const b = await lane('codex');
    const sibling = await lane('codex', siblingId);
    const future = await lane('codex', threadId, 4);
    await ready(a, b, sibling, future);
    const nativeHome = path.join(home, '.codex');
    await fs.mkdir(nativeHome);
    vi.stubEnv('CODEX_HOME', nativeHome);
    const ids = new Map<string, string>();
    for (const value of [a, b, sibling, future]) {
      const sessionId = randomUUID(); ids.set(value.id, sessionId);
      await write(pointer('codex', value.executorThreadId), JSON.stringify({ id: sessionId }));
      await delegation.laneStore.captureNativeSession(value.id, 0, await captureCodexDeletionTarget({
        sessionId, executorThreadId: value.executorThreadId, home, nativeHome, cwd: project, command: 'synthetic-codex' }));
      await delegation.laneStore.markShutdownConfirmed(value.id, 0, true);
    }
    const nativeThread = (id: string) => ({ id, sessionId: id, cwd: project, source: 'appServer',
      status: { type: 'notLoaded' }, ephemeral: false, turns: [], cliVersion: '0.166.0',
      createdAt: 1, updatedAt: 1, modelProvider: 'synthetic', preview: '', projectId: null });
    const request = vi.fn(async (method: string, params: any) => method === 'thread/read'
      ? { thread: nativeThread(params.threadId) }
      : method === 'thread/list' ? { data: params.archived ? [] : [...ids.values()].map(nativeThread), nextCursor: null } : {});
    const maintenance = vi.fn(() => ({ start: vi.fn(async () => {}), stop: vi.fn(async () => {}),
      getServerVersion: () => '0.166.0', request }));
    (delegation as any).nativeDeletionClientFactory = maintenance;
    const artifacts = await write(path.join(home, 'immutable-export'), 'preserved result');
    await seedDirect();
    const foregroundPointer = JSON.stringify({ id: randomUUID() });
    await write(pointer('codex', siblingId), foregroundPointer);
    expect(await send(command)).toMatchObject({ success: true, output: expect.stringContaining('queued') });
    expect(maintenance).not.toHaveBeenCalled();
    expect(threads.contextResets.isPending(threadId)).toBe(false);
    expect(await delegation.nativeSessionDeletions.requests()).toEqual([expect.objectContaining({ threadId, throughGeneration: 3 })]);
    // Simulate a restart after the reset marker was removed but before cleanup.
    await reload();
    (delegation as any).nativeDeletionClientFactory = maintenance;
    await delegation.reconcileNativeSessionDeletions();
    expect(request.mock.calls.filter(([method]) => method === 'thread/delete').map(([, params]) => params.threadId).sort())
      .toEqual([ids.get(a.id), ids.get(b.id)].sort());
    await delegation.reconcileNativeSessionDeletions();
    expect(request.mock.calls.filter(([method]) => method === 'thread/delete')).toHaveLength(2);
    expect(await fs.readFile(artifacts, 'utf8')).toBe('preserved result');
    expect(await fs.readFile(pointer('codex', siblingId), 'utf8')).toBe(foregroundPointer);
    expect((await delegation.laneStore.lanesForThread(siblingId))[0].nativeDeleteRequested).toBeUndefined();
    expect((await delegation.laneStore.lanesForThread(threadId)).find(value => value.id === future.id)?.nativeDeleteRequested).toBeUndefined();
  });

  it('keeps a durable deletion request through a failed main reset and a retry after restart', async () => {
    const worker = await lane('codex');
    current = pool.getExecutor(threadId);
    vi.mocked(current.waitForExit!).mockRejectedValueOnce(new Error('Synthetic exit failure'));
    expect(await send('/clear')).toMatchObject({ success: false });
    expect(await delegation.nativeSessionDeletions.requests()).toHaveLength(1);
    expect((await delegation.laneStore.lanesForThread(threadId))[0].nativeDeleteRequested).toBe(true);
    await reload();
    expect(await send('/new')).toMatchObject({ success: true });
    await delegation.reconcileNativeSessionDeletions();
    expect((await delegation.laneStore.lanesForThread(threadId)).find(value => value.id === worker.id)?.nativeDeletion?.state).toBe('waiting-exit');
  });

  it('does not cross the reset boundary if the separate native deletion intent cannot be persisted', async () => {
    const worker = await lane('codex');
    await ready(worker);
    await seedDirect();
    const failure = vi.spyOn(delegation.nativeSessionDeletions, 'enqueue').mockRejectedValueOnce(new Error('Synthetic queue failure'));
    expect(await send('/clear')).toMatchObject({ success: false });
    expect(threads.contextResets.generation(threadId, 3)).toBe(3);
    expect(existsSync(pointer('codex', threadId))).toBe(true);
    expect(existsSync(pointer('codex', worker.executorThreadId))).toBe(true);
    expect(threads.contextResets.isPending(threadId)).toBe(true);
    failure.mockRestore();
    expect(await send('/new')).toMatchObject({ success: true });
    expect(await delegation.nativeSessionDeletions.requests()).toHaveLength(1);
  });

  it.each(['/clear', '/new'])('detaches every direct backend and pooled worker with %s, preserving files and sibling state', async command => {
    const lanes = [await lane('codex'), ...await Promise.all(DELEGATION_BACKENDS.map(backend => lane(backend)))];
    const sibling = await lane('codex', siblingId);
    await ready(...lanes, sibling);
    await seedDirect();
    const preserved = [
      await write(path.join(project, 'source.txt')),
      await write(path.join(home, '.remote-cli', 'delegation-workspaces', 'trees', 'owned', 'work.txt')),
      await write(path.join(home, '.remote-cli', 'delegation-workspaces', 'artifacts', 'saved.json')),
      await write(path.join(home, '.remote-cli', 'pi-sessions', 'store', 'archived.jsonl')),
      await write(path.join(home, '.remote-cli', 'codex-sandbox', `${threadId}.json`)),
      await write(path.join(home, '.remote-cli', 'agy-homes', lanes.find(value => value.backend === 'agy')!.executorThreadId, 'login.json')),
      await write(path.join(home, '.remote-cli', 'agy-homes', lanes.find(value => value.backend === 'agy')!.executorThreadId, 'brain', 'archive.json')),
      await write(path.join(home, '.remote-cli', 'claude-sandbox', `${lanes[0].executorThreadId}.json`)),
    ];
    const metadata = { ...threads.getThread(threadId)! };
    const siblingMetadata = { ...threads.getThread(siblingId)! };
    current = pool.getExecutor(threadId);
    expect(await send(command)).toMatchObject({ success: true, output: expect.stringContaining('managed workers') });
    expect(current.destroy).toHaveBeenCalledOnce();
    expect(current.waitForExit).toHaveBeenCalledOnce();
    expect(current.resetContext).toHaveBeenCalledOnce();
    expect(current.abort).toHaveBeenCalled();
    expect(factory).toHaveBeenCalledTimes(1);
    for (const backend of DELEGATION_BACKENDS) {
      expect(existsSync(pointer(backend, threadId))).toBe(false);
      expect(await fs.readFile(pointer(backend, siblingId), 'utf8')).toBe('sibling conversation');
    }
    expect(existsSync(pointer('dsh', threadId).replace('.json', '.handoff.json'))).toBe(false);
    for (const value of lanes) {
      expect(existsSync(pointer(value.backend, value.executorThreadId))).toBe(true);
      if (value.backend === 'dsh') expect(existsSync(pointer('dsh', value.executorThreadId).replace('.json', '.handoff.json'))).toBe(true);
    }
    expect(await fs.readFile(pointer('codex', sibling.executorThreadId), 'utf8')).toBe('old worker conversation');
    for (const file of preserved) expect(await fs.readFile(file, 'utf8')).toBe('preserved fixture');
    expect(threads.getThread(threadId)).toEqual({ ...metadata, sessionId: null, delegationWorkspaceGeneration: 4 });
    expect(threads.getThread(siblingId)).toEqual(siblingMetadata);
    const reloaded = new DelegatedWorkerSessionStore(undefined, threads.contextResets);
    const saved = await reloaded.lanesForThread(threadId);
    expect(saved).toHaveLength(lanes.length);
    expect(saved.every(value => value.state === 'dirty' && value.nativeDeleteRequested && value.workspaceGeneration === 3)).toBe(true);
    for (const value of lanes) {
      await expect(reloaded.acquire(value, { pooled: true })).rejects.toThrow('generation has changed');
      const next = await reloaded.acquire({ ...value, workspaceGeneration: 4 }, { pooled: true });
      expect(next.reused).toBe(false);
      expect(lanes.some(old => old.id === next.lane.id)).toBe(false);
      expect(existsSync(pointer(next.lane.backend, next.lane.executorThreadId))).toBe(false);
    }
    await expect(delegation.resetWorkerContext(threads.getThread(threadId)!, lanes[0].id, 0)).rejects.toThrow();
    expect((pool.getExecutor(threadId) as any).saved).toBeNull();
  });

  it.each(['/clear', '/new'])('recovers with %s after aborting a worker before its required export exists', async command => {
    // Exercise export finalization with synthetic process-group evidence on every host.
    (delegation.workspaceManager as any).disposalSupported = true;
    await runGit(project, ['init', '-b', 'main']);
    await runGit(project, ['config', 'user.name', 'Test User']);
    await runGit(project, ['config', 'user.email', 'test@example.com']);
    await write(path.join(project, 'source.txt'), 'original source\n');
    await runGit(project, ['add', '.']);
    await runGit(project, ['commit', '-m', 'Initial synthetic fixture']);
    await threads.updateThread(threadId, { delegation: true });
    await seedDirect();
    current = pool.getExecutor(threadId);
    vi.mocked(current.abort).mockResolvedValue(true);
    const worker: IExecutor = {
      execute: vi.fn(() => new Promise(() => {})), abort: vi.fn(async () => true),
      destroy: vi.fn(async () => {}), waitForExit: vi.fn(async () => {}),
      waitForManagedProcessGroupExit: vi.fn(async () => {}), resetContext: vi.fn(),
      getCurrentWorkingDirectory: () => project, setWorkingDirectory: vi.fn(),
    };
    let workerDirectory = '';
    (delegation as any).factory = vi.fn((_guard, _config, cwd) => {
      workerDirectory = cwd;
      worker.getCurrentWorkingDirectory = () => cwd;
      return worker;
    });
    vi.spyOn((delegation as any).registry, 'get').mockResolvedValue({ backend: 'codex', installed: true });
    const scope = delegation.begin({ thread: threads.getThread(threadId)!, cwd: project,
      backend: 'codex', config: { type: 'codex' }, messageId: 'aborted-parent',
      onToolUse: vi.fn(), onToolResult: vi.fn(), onNotice: vi.fn(),
      onApproval: vi.fn(() => true), onApprovalResolved: vi.fn() });
    const task: any = await scope.invoke('remote_cli_delegate', {
      backend: 'codex', objective: 'Prepare a synthetic export', exports: ['unfinished.txt'],
    }, 'start');
    expect(task.state).toBe('running');
    const workerLane = (await delegation.laneStore.lanesForThread(threadId))[0];
    await write(pointer('codex', workerLane.executorThreadId), 'old worker conversation');
    const retainedFile = await write(path.join(workerDirectory, 'partial.txt'), 'partial worker output\n');
    const archive = await write(path.join(home, '.remote-cli', 'codex-archive', 'history.jsonl'));
    pool.setThreadBusy(threadId, true);
    expect(await send('/abort')).toMatchObject({ success: true });
    expect(worker.waitForExit).toHaveBeenCalled();
    expect(worker.waitForManagedProcessGroupExit).toHaveBeenCalled();
    await scope.close();
    expect((await delegation.laneStore.lanesForThread(threadId))[0]).toMatchObject({ state: 'dirty' });
    const artifact = await delegation.workspaceManager.describe(task.taskId);

    expect(await send(command)).toMatchObject({ success: true });
    expect(existsSync(pointer('codex', threadId))).toBe(false);
    expect(existsSync(pointer('codex', workerLane.executorThreadId))).toBe(true);
    expect(await fs.readFile(retainedFile, 'utf8')).toBe('partial worker output\n');
    expect(await fs.readFile(archive, 'utf8')).toBe('preserved fixture');
    expect(await delegation.workspaceManager.describe(task.taskId)).toEqual(artifact);
    expect((await delegation.laneStore.lanesForThread(threadId))[0])
      .toMatchObject({ state: 'dirty', workspaceGeneration: 3, shutdownConfirmedGeneration: 0 });
    expect(await send('/clear')).toMatchObject({ success: true });
  });

  it('blocks every old context after later direct-pointer cleanup fails, including reload, and allows an explicit retry', async () => {
    const worker = await lane('codex');
    await ready(worker);
    await seedDirect();
    current = pool.getExecutor(threadId);
    const original = fs.rm.bind(fs);
    const fail = vi.spyOn(fs, 'rm').mockImplementation(async (file, options) => {
      if (String(file) === pointer('opencode', threadId)) throw new Error('Synthetic pointer failure');
      return original(file, options);
    });
    expect(await send('/clear')).toMatchObject({ success: false, error: expect.stringContaining('retry /clear') });
    expect(existsSync(pointer('claude', threadId))).toBe(false);
    expect(existsSync(pointer('opencode', threadId))).toBe(true);
    expect(existsSync(pointer('codex', worker.executorThreadId))).toBe(true);
    fail.mockRestore();
    await reload();
    await assertBlocked();
    expect(await send('/new')).toMatchObject({ success: true });
    expect(existsSync(pointer('codex', worker.executorThreadId))).toBe(true);
    expect(factory).not.toHaveBeenCalled();
    expect((pool.getExecutor(threadId) as any).saved).toBeNull();
  });

  it('detaches safely without unlinking old worker pointers, even when their storage is unwritable', async () => {
    const lanes = [await lane('codex'), await lane('codex'), await lane('dsh')];
    await ready(...lanes);
    const original = fs.unlink.bind(fs);
    const fail = vi.spyOn(fs, 'unlink').mockImplementation(async file => {
      if (String(file) === pointer('codex', lanes[1].executorThreadId)) throw new Error('Synthetic worker failure');
      return original(file);
    });
    expect(await send('/clear')).toMatchObject({ success: true });
    fail.mockRestore();
    await reload();
    expect(threads.getThread(threadId)?.delegationWorkspaceGeneration).toBe(4);
    expect(await send('Fresh direct chat')).toMatchObject({ success: true });
    for (const value of lanes) expect(existsSync(pointer(value.backend, value.executorThreadId))).toBe(true);
  });

  it('does not touch any pointer when reset intent cannot be persisted, and retries safely', async () => {
    await seedDirect();
    const original = fs.open.bind(fs);
    const fail = vi.spyOn(fs, 'open').mockImplementation(async (file, ...args: any[]) => {
      if (String(file).endsWith('.pending')) throw new Error('Synthetic intent failure');
      return (original as any)(file, ...args);
    });
    expect(await send('/new')).toMatchObject({ success: false });
    for (const backend of DELEGATION_BACKENDS) expect(existsSync(pointer(backend, threadId))).toBe(true);
    expect(() => pool.getExecutor(threadId)).toThrow('incomplete');
    fail.mockRestore();
    expect(await send('/clear')).toMatchObject({ success: true });
    expect(factory).not.toHaveBeenCalled();
  });

  it('honors interrupted thread intent at startup before any pointer or worker has been cleared', async () => {
    const worker = await lane('codex');
    await ready(worker);
    await seedDirect();
    await threads.contextResets.begin(threadId);
    await reload();
    await assertBlocked();
    expect(await send('/clear', siblingId)).toMatchObject({ success: true });
    expect(existsSync(pointer('codex', threadId))).toBe(true);
    expect(await send('/clear')).toMatchObject({ success: true });
    expect(existsSync(pointer('codex', threadId))).toBe(false);
  });

  it.each(['enumeration', 'record-read'] as const)('completes an interrupted reset independently of an inventory %s failure', async operation => {
    const worker = await lane('codex');
    await ready(worker);
    await seedDirect();
    await threads.contextResets.begin(threadId);
    await reload();
    // Establish verified native ownership before making legacy metadata inaccessible.
    await delegation.reconcilePendingWorkerLanes();
    const directory = path.join(home, '.remote-cli', 'delegation-workers');
    const record = path.join(directory, `${worker.id}.json`);
    const readdir = fs.readdir.bind(fs);
    const readFile = fs.readFile.bind(fs);
    const failure = Object.assign(new Error('Synthetic inventory access failure'), { code: 'EACCES' });
    const fault = operation === 'enumeration'
      ? vi.spyOn(fs, 'readdir').mockImplementation((...args: any[]) => {
        if (String(args[0]) === directory) return Promise.reject(failure);
        return (readdir as any)(...args);
      })
      : vi.spyOn(fs, 'readFile').mockImplementation((...args: any[]) => {
        if (String(args[0]) === record) return Promise.reject(failure);
        return (readFile as any)(...args);
      });

    expect(await send('/clear')).toMatchObject({ success: true });
    expect(threads.contextResets.isPending(threadId)).toBe(false);
    expect(existsSync(pointer('codex', threadId))).toBe(false);
    expect(await readFile(pointer('codex', worker.executorThreadId), 'utf8')).toBe('old worker conversation');
    expect(factory).not.toHaveBeenCalled();
    expect(await send('ordinary prompt')).toMatchObject({ success: true });
    fault.mockRestore();
    await reload();
    expect((pool.getExecutor(threadId) as any).saved).toBeNull();
  });

  it('does not require lane metadata writes to detach the conversation', async () => {
    const lanes = [await lane('codex'), await lane('codex'), await lane('pi')];
    await ready(...lanes);
    const original = fs.rename.bind(fs);
    let writes = 0;
    const fail = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (String(destination).endsWith(`${lanes[1].id}.json`) && ++writes === 1) throw new Error('Synthetic lane persist failure');
      return original(source, destination);
    });
    expect(await send('/clear')).toMatchObject({ success: true });
    expect(writes).toBe(1);
    expect(await delegation.nativeSessionDeletions.requests()).toHaveLength(1);
    expect(existsSync(pointer('codex', lanes[1].executorThreadId))).toBe(true);
    expect(existsSync(pointer('pi', lanes[2].executorThreadId))).toBe(true);
    fail.mockRestore();
    await reload();
    expect(threads.getThread(threadId)?.delegationWorkspaceGeneration).toBe(4);
    expect(await send('/new')).toMatchObject({ success: true });
    expect((await delegation.laneStore.lanesForThread(threadId)).every(value => !value.contextResetPending && value.nativeDeleteRequested && value.state === 'dirty')).toBe(true);
  });

  it('retains reset intent when thread metadata persistence fails without changing unrelated persistence semantics', async () => {
    await seedDirect();
    const original = fs.writeFile.bind(fs);
    const fail = vi.spyOn(fs, 'writeFile').mockImplementation(async (file, ...args: any[]) => {
      if (String(file) === path.join(home, '.remote-cli', 'threads.json')) throw new Error('Synthetic metadata failure');
      return (original as any)(file, ...args);
    });
    expect(await send('/clear')).toMatchObject({ success: false });
    expect(existsSync(pointer('codex', threadId))).toBe(false);
    fail.mockRestore();
    await reload();
    expect(threads.getThread(threadId)!.sessionId).toBe('old-session');
    await assertBlocked();
    expect(await send('/clear')).toMatchObject({ success: true });
    expect((await ThreadManager.initialize(home)).getThread(threadId)!.sessionId).toBeNull();
  });

  it('excludes concurrent commands until a successful reset has detached the current native process', async () => {
    await seedDirect();
    current = pool.getExecutor(threadId);
    let finish!: () => void;
    vi.mocked(current.waitForExit!).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const resetting = send('/clear');
    await vi.waitFor(() => expect(finish).toBeDefined());
    const next = send('fresh task');
    expect(current.execute).not.toHaveBeenCalled();
    expect(await send('/new')).toMatchObject({ success: false, error: expect.stringContaining('operation') });
    expect(await send('/resume')).toMatchObject({ success: false, error: expect.stringContaining('incomplete') });
    finish();
    expect(await resetting).toMatchObject({ success: true });
    await next;
    expect(factory).toHaveBeenCalledTimes(2);
    const fresh = factory.mock.results[1].value;
    expect(fresh.saved).toBeNull();
    expect(fresh.execute).toHaveBeenCalledWith('fresh task', expect.any(Object));
    expect(current.execute).not.toHaveBeenCalled();
  });

  it.each(['preparing', 'running', 'dirty', 'cleanup-pending', 'queued', 'quarantined', 'native-busy', 'queue', 'queue-confirmation', 'busy'])(
    'detaches %s worker obligations while retaining direct process safeguards', async state => {
      await seedDirect();
      const worker = await lane('codex');
      if (state === 'running') await delegation.laneStore.markRunning(worker.id);
      else if (state === 'dirty' || state === 'cleanup-pending') await delegation.laneStore.markDirty(worker.id, 'Unconfirmed exit', state === 'cleanup-pending');
      else if (state !== 'preparing') await ready(worker);
      current = pool.getExecutor(threadId);
      if (state === 'native-busy') current.isBusy = () => true;
      if (state === 'queued') vi.spyOn(delegation, 'hasActiveTasks').mockReturnValue(true);
      if (state === 'quarantined') {
        expectedShutdownFailure = true;
        (delegation as any).workspaces.set(project, { id: 'lease', threadId, quarantined: true });
      }
      if (state === 'queue') (handler as any).threadQueues.set(threadId, [{ content: 'queued prompt' }]);
      if (state === 'queue-confirmation') (handler as any).pendingQueueConfirmations.set('pending', { info: { threadId } });
      if (state === 'busy') pool.setThreadBusy(threadId, true);
      expect(await send('/clear')).toMatchObject({ success: state !== 'native-busy' });
      expect(threads.contextResets.isPending(threadId)).toBe(state === 'native-busy');
      expect(existsSync(pointer('codex', threadId))).toBe(state === 'native-busy');
      expect(existsSync(pointer('codex', worker.executorThreadId))).toBe(true);
      expect(current.abort).toHaveBeenCalled();
      if (state === 'native-busy') {
        expect(current.destroy).not.toHaveBeenCalled();
        current.isBusy = () => false;
        expect(await send('/new')).toMatchObject({ success: true });
      } else {
        expect(current.destroy).toHaveBeenCalled();
        expect(threads.getThread(threadId)?.delegationWorkspaceGeneration).toBe(4);
      }
    });

  it('keeps the reset pending when direct process exit cannot be confirmed', async () => {
    await seedDirect();
    current = pool.getExecutor(threadId);
    vi.mocked(current.waitForExit!).mockRejectedValueOnce(new Error('Synthetic unconfirmed exit'));
    expect(await send('/clear')).toMatchObject({ success: false });
    expect(existsSync(pointer('codex', threadId))).toBe(true);
    expect(() => pool.getExecutor(threadId)).toThrow('incomplete');
    expect(current.abort).toHaveBeenCalled();
    expect(await send('/clear')).toMatchObject({ success: true });
  });

  it('drops the active DSH in-memory handoff as well as its saved compact summary', async () => {
    await write(pointer('dsh', threadId).replace('.json', '.handoff.json'),
      JSON.stringify({ text: 'old compact context', cwd: project, sourceSessionId: 'old-dsh' }));
    const dsh = new DshExecutor(new DirectoryGuard([home]), { initialWorkingDirectory: project, threadId });
    const state = (dsh as any).state;
    expect(state.handoff.text).toBe('old compact context');
    factory.mockReturnValueOnce(dsh);
    pool.getExecutor(threadId);
    expect(await send('/new')).toMatchObject({ success: true });
    expect(state.handoff).toBeUndefined();
    expect(dsh.getSessionId()).toBeNull();
    expect(existsSync(pointer('dsh', threadId).replace('.json', '.handoff.json'))).toBe(false);
  });
});
