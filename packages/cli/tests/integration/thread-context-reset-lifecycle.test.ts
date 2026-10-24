import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { MessageHandler } from '../../src/client/MessageHandler';
import { ThreadExecutorPool } from '../../src/thread/ThreadExecutorPool';
import { ThreadManager } from '../../src/thread/ThreadManager';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { ClaudePersistentExecutor } from '../../src/executor/ClaudePersistentExecutor';
import type { IExecutor } from '../../src/executor/IExecutor';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('thread reset shutdown ownership', () => {
  let home: string;
  let manager: ThreadManager;
  let pool: ThreadExecutorPool;
  let handler: MessageHandler;
  let threadId: string;
  let pointer: string;
  let executor: IExecutor;
  let factory: ReturnType<typeof vi.fn>;
  let sent: any[];
  let request = 0;
  let releaseStages: Array<() => void>;
  const send = async (content: string) => {
    const messageId = `reset-lifecycle-${++request}`;
    await handler.handleMessage({ type: 'command', messageId, threadId, content,
      isSlashCommand: content.startsWith('/'), timestamp: Date.now() });
    return sent.find(message => message.type === 'response' && message.messageId === messageId);
  };
  const makeExecutor = (): IExecutor => ({
    execute: vi.fn(async () => ({ success: true, output: 'Fresh result' })),
    getCurrentWorkingDirectory: () => home,
    setWorkingDirectory: vi.fn(async () => {}),
    resetContext: vi.fn(), abort: vi.fn(async () => false),
    destroy: vi.fn(async () => {}), waitForExit: vi.fn(async () => {}),
  });
  const attach = () => {
    const guard = new DirectoryGuard([home]);
    factory = vi.fn().mockImplementation(makeExecutor).mockReturnValueOnce(executor);
    pool = new ThreadExecutorPool(manager, guard, { type: 'codex' }, factory, 25);
    pool.getExecutor(threadId);
    sent = [];
    handler = new MessageHandler({ send: value => { sent.push(value); }, isConnected: () => true } as any,
      pool, manager, guard, { get: key => key === 'executor' ? { type: 'codex' } : undefined,
        getConfigDir: () => path.join(home, '.remote-cli') } as any);
  };

  beforeEach(async () => {
    releaseStages = [];
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'reset-lifecycle-')));
    vi.stubEnv('HOME', home);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    manager = await ThreadManager.initialize(home);
    threadId = manager.getDefaultThread().id;
    await manager.updateThread(threadId, { workingDirectory: home, delegation: false, sessionId: 'old-native-session' });
    pointer = path.join(home, '.remote-cli', 'codex-sessions', `${threadId}.json`);
    await fs.mkdir(path.dirname(pointer), { recursive: true });
    await fs.writeFile(pointer, 'old binding');
    executor = makeExecutor();
    attach();
  });

  afterEach(async () => {
    for (const release of releaseStages) release();
    vi.useRealTimers();
    await handler.destroy();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true });
  });

  it('reuses Claude destruction while its approval server is still waiting for an open socket', async () => {
    await handler.destroy();
    executor = new ClaudePersistentExecutor(new DirectoryGuard([home]), home, threadId);
    const entered = deferred();
    const closed = deferred();
    releaseStages.push(closed.resolve);
    const close = vi.fn((callback: () => void) => {
      entered.resolve();
      void closed.promise.then(callback);
    });
    // Model net.Server.close waiting for an existing connection, without opening a socket.
    (executor as any).approvalServer = { close };
    const destroy = vi.spyOn(executor, 'destroy');
    const reset = vi.spyOn(executor, 'resetContext');
    attach();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const clearing = send('/clear');
    await entered.promise;
    await vi.advanceTimersByTimeAsync(25);
    expect(await clearing).toMatchObject({ success: false, error: expect.stringContaining('shutdown timed out') });
    expect(pool.isThreadBusy(threadId)).toBe(false);
    expect(manager.contextResets.isPending(threadId)).toBe(true);
    expect(await fs.readFile(pointer, 'utf8')).toBe('old binding');

    const retryStarted = deferred();
    const clear = pool.clearThreadContext.bind(pool);
    vi.spyOn(pool, 'clearThreadContext').mockImplementationOnce(id => {
      const pending = clear(id);
      retryStarted.resolve();
      return pending;
    });
    const retry = send('/new');
    await retryStarted.promise;
    await vi.advanceTimersByTimeAsync(25);
    expect(await retry).toMatchObject({ success: false, error: expect.stringContaining('shutdown timed out') });
    expect(destroy).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(reset).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledOnce();

    closed.resolve();
    await destroy.mock.results[0].value;
    expect(manager.contextResets.isPending(threadId)).toBe(true);
    expect(await send('/clear')).toMatchObject({ success: true });
    expect(destroy).toHaveBeenCalledOnce();
    expect(reset).toHaveBeenCalledOnce();
    expect(manager.contextResets.isPending(threadId)).toBe(false);
    await expect(fs.stat(pointer)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['destroy', 'waitForExit', 'resetContext'] as const)(
    'bounds a stalled %s, releases admission, and joins late cleanup before a replacement can run', async phase => {
      const entered = deferred();
      const finish = deferred();
      releaseStages.push(finish.resolve);
      const stage = vi.fn(async () => {
        entered.resolve();
        await finish.promise;
        await fs.writeFile(pointer, 'late native cleanup');
      });
      executor[phase] = stage;
      const sibling = await manager.createThread('sibling', home, 'pi');
      const siblingPointer = path.join(path.dirname(pointer), `${sibling.id}.json`);
      await fs.writeFile(siblingPointer, 'sibling binding');
      const retained = path.join(home, 'retained-transcript.jsonl');
      await fs.writeFile(retained, 'retained history');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

      const clearing = send('/clear');
      await entered.promise;
      await vi.advanceTimersByTimeAsync(25);
      expect(await clearing).toMatchObject({ success: false, error: expect.stringContaining('shutdown timed out') });
      expect(pool.isThreadBusy(threadId)).toBe(false);
      expect(manager.contextResets.isPending(threadId)).toBe(true);
      expect(() => pool.getExecutor(threadId)).toThrow('incomplete');
      expect(await fs.readFile(pointer, 'utf8')).toBe('old binding');
      await expect(pool.destroyThread(threadId)).rejects.toThrow('incomplete');
      await expect(pool.destroyAll({ deleteData: false })).rejects.toThrow('incomplete');

      // This retry must acquire admission and reuse the original native cleanup.
      const retryStarted = deferred();
      const clear = pool.clearThreadContext.bind(pool);
      vi.spyOn(pool, 'clearThreadContext').mockImplementationOnce(id => {
        const clearing = clear(id);
        retryStarted.resolve();
        return clearing;
      });
      const retry = send('/new');
      await retryStarted.promise;
      await vi.advanceTimersByTimeAsync(25);
      expect(await retry).toMatchObject({ success: false, error: expect.stringContaining('shutdown timed out') });
      expect(stage).toHaveBeenCalledOnce();
      expect(executor.destroy).toHaveBeenCalledOnce();
      expect(factory).toHaveBeenCalledOnce();
      finish.resolve();
      await stage.mock.results[0].value;
      expect(manager.contextResets.isPending(threadId)).toBe(true);

      expect(await send('/clear')).toMatchObject({ success: true });
      expect(stage).toHaveBeenCalledOnce();
      expect(executor.resetContext).toHaveBeenCalledOnce();
      expect(manager.contextResets.isPending(threadId)).toBe(false);
      await expect(fs.stat(pointer)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readFile(siblingPointer, 'utf8')).toBe('sibling binding');
      expect(await fs.readFile(retained, 'utf8')).toBe('retained history');
      expect(manager.getThread(sibling.id)).toEqual(sibling);

      expect(await send('fresh task')).toMatchObject({ success: true });
      expect(factory).toHaveBeenCalledTimes(2);
      expect(executor.execute).not.toHaveBeenCalled();
      const replacement = factory.mock.results[1].value;
      expect(replacement.execute).toHaveBeenCalledWith('fresh task', expect.any(Object));
      await vi.advanceTimersByTimeAsync(100);
      await expect(fs.stat(pointer)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(stage).toHaveBeenCalledOnce();
    });

  it('allows a new shutdown attempt after the retained cleanup rejects, without clearing intent early', async () => {
    const entered = deferred();
    const fail = deferred();
    releaseStages.push(fail.resolve);
    vi.mocked(executor.destroy).mockImplementationOnce(async () => {
      entered.resolve();
      await fail.promise;
      throw new Error('Synthetic cleanup failure');
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const clearing = send('/clear');
    await entered.promise;
    await vi.advanceTimersByTimeAsync(25);
    expect(await clearing).toMatchObject({ success: false });
    fail.resolve();
    await expect(vi.mocked(executor.destroy).mock.results[0].value).rejects.toThrow('Synthetic');
    expect(manager.contextResets.isPending(threadId)).toBe(true);
    expect(await send('/new')).toMatchObject({ success: true });
    expect(executor.destroy).toHaveBeenCalledTimes(2);
    expect(executor.resetContext).toHaveBeenCalledOnce();
    expect(manager.contextResets.isPending(threadId)).toBe(false);
  });
});
