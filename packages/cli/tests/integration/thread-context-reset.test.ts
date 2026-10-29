import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
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
    expectedShutdownFailure = false;
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'thread-context-reset-')));
    vi.stubEnv('HOME', home);
    vi.spyOn(os, 'homedir').mockImplementation(() => process.env.HOME || originalHomedir());
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
    expect(current.abort).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledTimes(1);
    for (const backend of DELEGATION_BACKENDS) {
      expect(existsSync(pointer(backend, threadId))).toBe(false);
      expect(await fs.readFile(pointer(backend, siblingId), 'utf8')).toBe('sibling conversation');
    }
    expect(existsSync(pointer('dsh', threadId).replace('.json', '.handoff.json'))).toBe(false);
    for (const value of lanes) {
      expect(existsSync(pointer(value.backend, value.executorThreadId))).toBe(false);
      if (value.backend === 'dsh') expect(existsSync(pointer('dsh', value.executorThreadId).replace('.json', '.handoff.json'))).toBe(false);
    }
    expect(await fs.readFile(pointer('codex', sibling.executorThreadId), 'utf8')).toBe('old worker conversation');
    for (const file of preserved) expect(await fs.readFile(file, 'utf8')).toBe('preserved fixture');
    expect(threads.getThread(threadId)).toEqual({ ...metadata, sessionId: null });
    expect(threads.getThread(siblingId)).toEqual(siblingMetadata);
    const reloaded = new DelegatedWorkerSessionStore(undefined, threads.contextResets);
    const saved = await reloaded.lanesForThread(threadId);
    expect(saved).toHaveLength(lanes.length);
    expect(saved.every(value => value.state === 'ready' && value.contextGeneration === 1)).toBe(true);
    const acquired: string[] = [];
    for (const value of lanes) {
      const next = await reloaded.acquire(value, { pooled: true });
      acquired.push(next.lane.id);
      expect(next.reused).toBe(true);
      expect(next.lane.contextGeneration).toBe(2);
      expect(existsSync(pointer(next.lane.backend, next.lane.executorThreadId))).toBe(false);
    }
    expect(acquired.sort()).toEqual(lanes.map(value => value.id).sort());
    const clear = vi.fn(async () => {});
    // A duplicate old card is harmless even after a fresh context has been acquired.
    await reloaded.clearContext(lanes[0].id, 0, lanes[0], clear);
    expect(clear).not.toHaveBeenCalled();
    await expect(reloaded.clearContext(lanes[0].id, 1, lanes[0], clear)).rejects.toThrow('has changed');
    expect((pool.getExecutor(threadId) as any).saved).toBeNull();
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
    expect(existsSync(pointer('codex', worker.executorThreadId))).toBe(false);
    expect(factory).not.toHaveBeenCalled();
    expect((pool.getExecutor(threadId) as any).saved).toBeNull();
  });

  it('blocks ready lanes after a later worker unlink fails, preserving the retry across restart', async () => {
    const lanes = [await lane('codex'), await lane('codex'), await lane('dsh')];
    await ready(...lanes);
    const original = fs.unlink.bind(fs);
    const fail = vi.spyOn(fs, 'unlink').mockImplementation(async file => {
      if (String(file) === pointer('codex', lanes[1].executorThreadId)) throw new Error('Synthetic worker failure');
      return original(file);
    });
    expect(await send('/clear')).toMatchObject({ success: false });
    expect(existsSync(pointer('codex', lanes[0].executorThreadId))).toBe(false);
    expect(existsSync(pointer('dsh', lanes[2].executorThreadId))).toBe(true);
    fail.mockRestore();
    await reload();
    await assertBlocked();
    expect(await send('/clear')).toMatchObject({ success: true });
    expect((await delegation.laneStore.lanesForThread(threadId)).every(value => value.state === 'ready')).toBe(true);
    for (const value of lanes) expect(existsSync(pointer(value.backend, value.executorThreadId))).toBe(false);
  });

  it('does not touch any pointer when reset intent cannot be persisted, and retries safely', async () => {
    await seedDirect();
    const original = fs.writeFile.bind(fs);
    const fail = vi.spyOn(fs, 'writeFile').mockImplementation(async (file, ...args: any[]) => {
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

  it.each(['enumeration', 'record-read'] as const)('keeps an interrupted reset blocked after an inventory %s failure and permits retry', async operation => {
    const worker = await lane('codex');
    await ready(worker);
    await seedDirect();
    await threads.contextResets.begin(threadId);
    await reload();
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

    expect(await send('/clear')).toMatchObject({ success: false, error: expect.stringContaining('inventory') });
    expect(threads.contextResets.isPending(threadId)).toBe(true);
    expect(await readFile(pointer('codex', threadId), 'utf8')).toBe('old direct conversation');
    expect(await readFile(pointer('codex', worker.executorThreadId), 'utf8')).toBe('old worker conversation');
    expect(factory).not.toHaveBeenCalled();
    fault.mockRestore();
    expect(await send('ordinary prompt')).toMatchObject({ success: false, error: expect.stringContaining('incomplete') });
    expect(await send('/new')).toMatchObject({ success: true });
    expect(existsSync(pointer('codex', worker.executorThreadId))).toBe(false);
    expect(existsSync(pointer('codex', threadId))).toBe(false);
    expect(threads.contextResets.isPending(threadId)).toBe(false);
    expect(factory).not.toHaveBeenCalled();
    await reload();
    expect((pool.getExecutor(threadId) as any).saved).toBeNull();
  });

  it('retains the whole-thread barrier when persisting a cleared lane fails', async () => {
    const lanes = [await lane('codex'), await lane('codex'), await lane('pi')];
    await ready(...lanes);
    const original = fs.rename.bind(fs);
    let writes = 0;
    const fail = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (String(destination).endsWith(`${lanes[1].id}.json`) && ++writes === 2) throw new Error('Synthetic lane persist failure');
      return original(source, destination);
    });
    expect(await send('/clear')).toMatchObject({ success: false });
    expect(existsSync(pointer('codex', lanes[1].executorThreadId))).toBe(false);
    expect(existsSync(pointer('pi', lanes[2].executorThreadId))).toBe(true);
    fail.mockRestore();
    await reload();
    await assertBlocked();
    expect(await send('/new')).toMatchObject({ success: true });
    expect((await delegation.laneStore.lanesForThread(threadId)).every(value => !value.contextResetPending && value.state === 'ready')).toBe(true);
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
    expect(await send('/new')).toMatchObject({ success: false, error: expect.stringContaining('busy') });
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
    'refuses an unsafe %s reset without aborting or detaching context', async state => {
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
      expect(await send('/clear')).toMatchObject({ success: false });
      expect(threads.contextResets.isPending(threadId)).toBe(false);
      expect(existsSync(pointer('codex', threadId))).toBe(true);
      expect(existsSync(pointer('codex', worker.executorThreadId))).toBe(true);
      expect(current.destroy).not.toHaveBeenCalled();
      expect(current.abort).not.toHaveBeenCalled();
      if (state === 'running' || state === 'preparing') {
        await reload();
        expect(await send('/new')).toMatchObject({ success: false, error: expect.stringContaining('shutdown is unconfirmed') });
      }
    });

  it('keeps the reset pending when direct process exit cannot be confirmed', async () => {
    await seedDirect();
    current = pool.getExecutor(threadId);
    vi.mocked(current.waitForExit!).mockRejectedValueOnce(new Error('Synthetic unconfirmed exit'));
    expect(await send('/clear')).toMatchObject({ success: false });
    expect(existsSync(pointer('codex', threadId))).toBe(true);
    expect(() => pool.getExecutor(threadId)).toThrow('incomplete');
    expect(current.abort).not.toHaveBeenCalled();
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
