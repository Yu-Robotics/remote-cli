import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { MessageHandler } from '../src/client/MessageHandler';
import { ThreadManager } from '../src/thread/ThreadManager';
import { ThreadExecutorPool } from '../src/thread/ThreadExecutorPool';
import { DirectoryGuard } from '../src/security/DirectoryGuard';
import { DelegationManager, type DelegationScope } from '../src/delegation/DelegationManager';
import type { ExecuteOptions, ExecuteResult, IExecutor } from '../src/executor/IExecutor';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('managed conversation recovery', () => {
  let home: string;
  let manager: ThreadManager;
  let pool: ThreadExecutorPool;
  let handler: MessageHandler;
  let delegation: DelegationManager;
  let executor: IExecutor;
  let send: ReturnType<typeof vi.fn>;
  let threadId: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'conversation-recovery-')));
    originalHome = process.env.HOME;
    process.env.HOME = home;
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    manager = await ThreadManager.initialize(home);
    threadId = manager.getDefaultThread().id;
    await manager.updateThread(threadId, { workingDirectory: home });
    executor = {
      execute: vi.fn().mockResolvedValue({ success: true, output: 'Fresh response' }),
      abort: vi.fn().mockResolvedValue(true), destroy: vi.fn().mockResolvedValue(undefined),
      waitForExit: vi.fn().mockResolvedValue(undefined), resetContext: vi.fn(),
      getCurrentWorkingDirectory: () => home, setWorkingDirectory: vi.fn(),
    };
    const guard = new DirectoryGuard([home]);
    pool = new ThreadExecutorPool(manager, guard, { type: 'codex' }, () => executor, 5);
    send = vi.fn();
    handler = new MessageHandler({ send, trackTask: vi.fn(), onClose: vi.fn(), isConnected: () => true } as any,
      pool, manager, guard, { get: vi.fn(), set: vi.fn(), getAll: () => ({}), getConfigDir: () => home } as any);
    delegation = (handler as any).delegation;
  });

  afterEach(async () => {
    await handler.destroy();
    vi.restoreAllMocks();
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    await fs.rm(home, { recursive: true, force: true });
  });

  const command = async (content: string, id = content) => handler.handleMessage({ type: 'command', messageId: id, content, threadId });
  const response = (id: string) => send.mock.calls.map(([value]) => value).find(value => value.type === 'response' && value.messageId === id);

  it.each(['/abort', '/clear', '/new'])('completes admission cancellation once during attachment initialization via %s', async recovery => {
    const initialization = deferred<void>();
    const inbox = {
      initialize: vi.fn(() => initialization.promise), mark: vi.fn(() => 1), claim: vi.fn(),
      cancelThread: vi.fn(), release: vi.fn(), destroy: vi.fn(), hasClaim: vi.fn(() => false),
    };
    (handler as any).fileInbox = inbox;
    const original = command('Request before recovery', 'pending-admission');
    await vi.waitFor(() => expect(inbox.initialize).toHaveBeenCalledOnce());
    await command(recovery);
    // Cancellation must not wait for attachment initialization to return.
    expect(response('pending-admission')).toMatchObject({ success: false });
    expect(inbox.release).toHaveBeenCalledWith('pending-admission', true);
    initialization.resolve();
    await original;
    expect(inbox.claim).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
    expect(send.mock.calls.filter(([value]) => value.type === 'response' && value.messageId === 'pending-admission')).toHaveLength(1);
    expect(response(recovery)).toMatchObject({ success: true });
  });

  it.each(['malformed', 'unreadable'])('isolates a %s sibling generation from healthy requests and preserves its execution barrier', async failure => {
    await manager.updateThread(threadId, { delegation: false });
    const sibling = await manager.createThread('broken-sibling', home, 'codex');
    await manager.contextResets.begin(sibling.id);
    await manager.contextResets.advanceGeneration(sibling.id);
    await manager.contextResets.complete(sibling.id);
    const filename = (manager.contextResets as any).file(sibling.id) + '.generation';
    if (failure === 'malformed') await fs.writeFile(filename, '{');
    else {
      await fs.rm(filename);
      await fs.mkdir(filename);
    }
    await command('Independent conversation', 'healthy');
    expect(response('healthy')).toMatchObject({ success: true });
    expect(executor.execute).toHaveBeenCalledOnce();
    expect(pool.getSummaries().find(thread => thread.id === sibling.id)).toMatchObject({ status: 'error' });
    expect(() => pool.getExecutor(sibling.id)).toThrow('generation');
    await command('/thread list');
    expect(response('/thread list')).toMatchObject({ success: true });
    await expect(pool.switchBackend({ type: 'pi' })).rejects.toThrow('generation');
    expect(executor.destroy).not.toHaveBeenCalled();
    const loaded = await ThreadManager.initialize(home);
    expect(loaded.listThreads()).toHaveLength(2);
    expect(() => loaded.getThread(sibling.id)).toThrow('generation');
  });

  it.each(['Ordinary request', '/status'])('finishes an invalidated %s waiting for abort cleanup exactly once', async content => {
    const cleanup = deferred<void>();
    (handler as any).abortOperations.set(threadId, cleanup.promise);
    const original = command(content, 'waiting-for-abort');
    await vi.waitFor(() => expect(send.mock.calls.some(([value]) => value.messageId === 'waiting-for-abort')).toBe(true));
    const abort = command('/abort', 'repeat-abort');
    await handler.destroy();
    cleanup.resolve();
    await Promise.all([original, abort]);
    (handler as any).abortOperations.delete(threadId);
    expect(response('waiting-for-abort')).toMatchObject({ success: false });
    expect(send.mock.calls.filter(([value]) => value.type === 'response' && value.messageId === 'waiting-for-abort')).toHaveLength(1);
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('detaches legacy unknown lanes despite inaccessible ownership, preserving preferences, files and sibling threads across restart', async () => {
    await manager.updateThread(threadId, { delegation: false, backend: 'codex', models: { codex: 'model' }, efforts: { codex: 'high' } });
    const sibling = await manager.createThread('sibling', home, 'pi');
    const before = manager.getThread(threadId)!;
    const ownership = `${delegation.laneStore.storageDirectory}.ownership`;
    await fs.mkdir(path.dirname(ownership), { recursive: true });
    await fs.writeFile(ownership, 'legacy unknown owner');
    const retained = path.join(home, 'retained-worker-files');
    await fs.writeFile(retained, 'uncollected changes');
    const preflight = vi.spyOn(delegation, 'assertThreadContextResettable').mockRejectedValue(new Error('Unknown legacy exit'));
    const cleanup = vi.spyOn(delegation, 'clearThreadContexts').mockRejectedValue(new Error('Inaccessible inventory'));
    await command('/clear');
    expect(response('/clear')).toMatchObject({ success: true });
    expect(preflight).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    const loaded = await ThreadManager.initialize(home);
    expect(loaded.getThread(threadId)).toEqual({ ...before, delegationWorkspaceGeneration: 1 });
    expect(loaded.getThread(sibling.id)).toEqual(sibling);
    expect(await fs.readFile(retained, 'utf8')).toBe('uncollected changes');
    expect(await fs.readFile(ownership, 'utf8')).toBe('legacy unknown owner');
    await handler.destroy();
    manager = loaded;
    const guard = new DirectoryGuard([home]);
    pool = new ThreadExecutorPool(manager, guard, { type: 'codex' }, () => executor, 5);
    handler = new MessageHandler({ send, trackTask: vi.fn(), onClose: vi.fn(), isConnected: () => true } as any,
      pool, manager, guard, { get: vi.fn(), set: vi.fn(), getAll: () => ({}), getConfigDir: () => home } as any);
    delegation = (handler as any).delegation;
    await command('Try execution');
    expect(response('Try execution')).toMatchObject({ success: true });
    expect(executor.execute).toHaveBeenCalledOnce();
    await command('/thread new recovered');
    expect(manager.getThreadByName('recovered')).toBeDefined();
    expect(await fs.readFile(ownership, 'utf8')).toBe('legacy unknown owner');
  });

  it.each([false, true])('keeps both threads usable with legacy storage before and after reset with delegation=%s', async enabled => {
    await manager.updateThread(threadId, { delegation: enabled });
    executor.configureDelegation = vi.fn();
    const sibling = await manager.createThread('unaffected', home, 'codex');
    await manager.updateThread(sibling.id, { delegation: enabled });
    const ownership = `${delegation.laneStore.storageDirectory}.ownership`;
    await fs.mkdir(path.dirname(ownership), { recursive: true });
    await fs.writeFile(ownership, 'legacy unknown owner');

    await command('Existing conversation', 'before-reset');
    expect(response('before-reset')).toMatchObject({ success: true });
    for (const reset of ['/clear', '/new']) {
      await command(reset);
      expect(response(reset)).toMatchObject({ success: true });
      await command('Continue conversation', `after-${reset}`);
      expect(response(`after-${reset}`)).toMatchObject({ success: true });
    }
    await handler.handleMessage({ type: 'command', messageId: 'sibling-chat', content: 'Existing sibling conversation', threadId: sibling.id });
    expect(response('sibling-chat')).toMatchObject({ success: true });
    expect(executor.execute).toHaveBeenCalledTimes(4);
    expect(await fs.readFile(ownership, 'utf8')).toBe('legacy unknown owner');
  });

  it.each(['/skill:fixture', '/compact'])('allows supported native %s despite historical ownership metadata', async content => {
    await manager.updateThread(threadId, { backend: 'pi', delegation: false });
    executor.compactWhenFull = vi.fn().mockResolvedValue({ success: true });
    const ownership = `${delegation.laneStore.storageDirectory}.ownership`;
    await fs.mkdir(path.dirname(ownership), { recursive: true });
    await fs.writeFile(ownership, 'legacy unknown owner');
    await handler.handleMessage({ type: 'command', messageId: 'native-with-history', content, threadId, isSlashCommand: true });
    expect(response('native-with-history')).toMatchObject({ success: true });
    expect(content === '/compact' ? executor.compactWhenFull : executor.execute).toHaveBeenCalledOnce();
    expect(await fs.readFile(ownership, 'utf8')).toBe('legacy unknown owner');
  });

  it('keeps corrupt worker inventory intact while starting a fresh conversation', async () => {
    executor.configureDelegation = vi.fn();
    const directory = delegation.laneStore.storageDirectory;
    await fs.mkdir(directory, { recursive: true });
    const record = path.join(directory, 'interrupted-worker.json');
    await fs.writeFile(record, '{"state":');
    await command('/new');
    expect(response('/new')).toMatchObject({ success: true });
    await command('Continue after interrupted storage');
    expect(response('Continue after interrupted storage')).toMatchObject({ success: true });
    expect(executor.execute).toHaveBeenCalledOnce();
    expect(await fs.readFile(record, 'utf8')).toBe('{"state":');
  });

  it('starts ordinary managed-enabled chat without inventory or ownership initialization', async () => {
    executor.configureDelegation = vi.fn();
    const inventory = vi.spyOn(delegation, 'pendingArtifactContext').mockRejectedValue(new Error('Inventory unavailable'));
    const initialize = vi.spyOn(delegation.laneStore, 'initialize').mockRejectedValue(new Error('Legacy dirty metadata'));
    const ownership = vi.spyOn((delegation as any).ownership, 'acquire').mockRejectedValue(new Error('Ownership unavailable'));
    await command('Answer without workers');
    expect(response('Answer without workers')).toMatchObject({ success: true });
    expect(executor.execute).toHaveBeenCalledOnce();
    expect(inventory).not.toHaveBeenCalled();
    expect(initialize).not.toHaveBeenCalled();
    expect(ownership).not.toHaveBeenCalled();
  });

  it('uses verified native ownership evidence without depending on legacy inventory health', async () => {
    await (delegation as any).ownership.acquire();
    const inventory = vi.spyOn(delegation.laneStore, 'initialize').mockRejectedValue(new Error('Metadata unreadable'));
    await manager.updateThread(threadId, { delegation: false });
    await command('Direct chat after proven shutdown');
    expect(response('Direct chat after proven shutdown')).toMatchObject({ success: true });
    expect(inventory).not.toHaveBeenCalled();
  });

  it('does not reuse a direct pointer while cancelled backend preparation can still write it', async () => {
    const preparing = deferred<void>();
    executor.configureDelegation = vi.fn(() => preparing.promise);
    const original = command('Configure backend', 'preparing');
    await vi.waitFor(() => expect(executor.configureDelegation).toHaveBeenCalled());
    await command('/abort');
    await command('Too early');
    expect(response('Too early')).toMatchObject({ success: false, error: expect.stringContaining('preparation is still pending') });
    await command('/clear');
    expect(response('/clear')).toMatchObject({ success: false, error: expect.stringContaining('preparation is still pending') });
    expect(executor.destroy).not.toHaveBeenCalled();
    expect(executor.resetContext).not.toHaveBeenCalled();
    preparing.resolve();
    await original;
    await command('/new');
    expect(response('/new')).toMatchObject({ success: true });
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('aborts a hanging result collection, recovers, and ignores late callbacks and old busy completion', async () => {
    executor.configureDelegation = vi.fn();
    const collection = deferred<any[]>();
    const cleanup = deferred<void>();
    let closed = false;
    const scope: DelegationScope = {
      isClosed: () => closed, hasTasks: () => true, hasPendingResults: () => true,
      getLaunchRevision: () => 1, beginExecution: vi.fn(), finishExecution: vi.fn(),
      getRetainedResults: () => [], collectPendingResults: vi.fn(() => collection.promise),
      checkArtifactCloseout: vi.fn(async () => []), invoke: vi.fn(), waitingExecutor: () => undefined,
      waitingInputCount: () => 0, close: vi.fn(() => { closed = true; return cleanup.promise; }),
    };
    vi.spyOn(delegation, 'begin').mockReturnValueOnce(scope);
    // Register the synthetic scope so cancellation exercises the real bounded wait.
    (delegation as any).scopes.set(threadId, scope);
    let oldOptions!: ExecuteOptions;
    vi.mocked(executor.execute).mockImplementationOnce(async (_text, options) => { oldOptions = options!; return { success: true }; });
    const oldTurn = command('Old request', 'old');
    await vi.waitFor(() => expect(scope.collectPendingResults).toHaveBeenCalledOnce());
    const abort = command('/abort');
    await vi.waitFor(() => expect(executor.abort).toHaveBeenCalled());
    expect(closed).toBe(true);
    await abort;
    expect(response('/abort')).toMatchObject({ success: true });
    await command('/clear');
    expect(response('/clear')).toMatchObject({ success: true });
    (delegation as any).scopes.delete(threadId);
    await manager.updateThread(threadId, { delegation: false });
    const nextResult = deferred<ExecuteResult>();
    vi.mocked(executor.execute).mockImplementationOnce(() => nextResult.promise);
    const nextTurn = command('New request', 'next');
    await vi.waitFor(() => expect(executor.execute).toHaveBeenCalledTimes(2));
    send.mockClear();
    oldOptions.onStream?.('Late text');
    oldOptions.onToolUse?.({ id: 'late-tool', name: 'Read', input: {} });
    expect(oldOptions.onApprovalRequest?.({ requestId: 'late-approval', description: 'Late approval' } as any)).toBe(false);
    collection.resolve([]);
    cleanup.resolve();
    await oldTurn;
    expect(send).not.toHaveBeenCalled();
    expect(pool.isThreadBusy(threadId)).toBe(true);
    nextResult.resolve({ success: true });
    await nextTurn;
    expect(response('next')).toMatchObject({ success: true });
    expect(pool.isThreadBusy(threadId)).toBe(false);
  });

  it('blocks conflicting execution with delegation off but keeps management and reset available', async () => {
    await manager.updateThread(threadId, { delegation: false });
    (delegation as any).workspaces.set(home, { id: 'old-worker', threadId, quarantined: true, detached: true });
    await command('Run code');
    expect(response('Run code')).toMatchObject({ success: false, error: expect.stringContaining('confirmed worker exit') });
    expect(executor.execute).not.toHaveBeenCalled();
    await command('/clear');
    await command('/thread list');
    await command('/thread new safe');
    expect(response('/clear')).toMatchObject({ success: true });
    expect(response('/thread list')).toMatchObject({ success: true });
    expect(manager.getThreadByName('safe')).toBeDefined();
    await command('Still blocked');
    expect(executor.execute).not.toHaveBeenCalled();
    (delegation as any).workspaces.clear();
  });

  it.each(['dsh', 'codex'] as const)('reports unsupported %s native commands without requiring writer evidence', async backend => {
    await manager.updateThread(threadId, { backend });
    const safety = vi.spyOn(delegation, 'assertExecutionSafe').mockRejectedValue(new Error('Synthetic uncertain writer'));
    await handler.handleMessage({ type: 'command', messageId: 'unsupported-native',
      content: '/unsupported', threadId, isSlashCommand: true });
    expect(response('unsupported-native')).toMatchObject({ success: false,
      error: expect.stringContaining(backend === 'dsh' ? 'DSH' : 'Codex') });
    expect(safety).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it.each(['chat', 'compact'] as const)('sends one cancellation response on shutdown before late %s completion', async mode => {
    const result = deferred<ExecuteResult>();
    const run = vi.fn(() => result.promise);
    if (mode === 'chat') executor.execute = run;
    else executor.compactWhenFull = run;
    const active = command(mode === 'chat' ? 'Wait for shutdown' : '/compact', 'shutdown-request');
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    try {
      await handler.destroy();
      await handler.destroy();
      expect(response('shutdown-request')).toMatchObject({ success: false, error: expect.stringMatching(/cancel.*shutting down/i) });
    } finally {
      result.resolve({ success: true, output: 'Late native completion' });
      await active;
    }
    expect(send.mock.calls.map(([value]) => value).filter(value => value.type === 'response' && value.messageId === 'shutdown-request')).toHaveLength(1);
  });

  it.each([
    ['/skill:fixture', false], ['/skill:fixture', true], ['/compact', false], ['/compact', true],
  ] as const)('guards native %s after bounded abort with delegation=%s until worker exit is confirmed', async (content, enabled) => {
    await manager.updateThread(threadId, { backend: 'pi', delegation: enabled });
    executor.compactWhenFull = vi.fn().mockResolvedValue({ success: true });
    let stopped = false;
    const workspaces = (delegation as any).workspaces;
    workspaces.set(home, { id: 'detached-worker', threadId, quarantined: false, detached: true,
      permitsDirectExecution: () => stopped });
    const native = (id: string) => handler.handleMessage({ type: 'command', messageId: id,
      content, threadId, isSlashCommand: true });
    try {
      pool.setThreadBusy(threadId, true);
      await command('/abort');
      expect(pool.isThreadBusy(threadId)).toBe(false);
      await native('blocked-native');
      expect(response('blocked-native')).toMatchObject({ success: false, error: expect.stringContaining('may still write files') });
      await command('/clear');
      expect(response('/clear')).toMatchObject({ success: true });
      await native('blocked-after-clear');
      expect(response('blocked-after-clear')).toMatchObject({ success: false });
      expect(executor.execute).not.toHaveBeenCalled();
      expect(executor.compactWhenFull).not.toHaveBeenCalled();
      stopped = true;
      await native('safe-native');
      expect(response('safe-native')).toMatchObject({ success: true });
      expect(content === '/compact' ? executor.compactWhenFull : executor.execute).toHaveBeenCalledOnce();
    } finally { workspaces.clear(); }
  });

  it.each(['/skill:fixture', '/compact'])('does not dispatch native %s after cancellation during writer checks', async content => {
    await manager.updateThread(threadId, { backend: 'pi', delegation: false });
    executor.compactWhenFull = vi.fn().mockResolvedValue({ success: true });
    const checking = deferred<void>();
    const guard = vi.spyOn(delegation, 'assertExecutionSafe').mockReturnValueOnce(checking.promise);
    const running = handler.handleMessage({ type: 'command', messageId: 'native-check', content, threadId, isSlashCommand: true });
    await vi.waitFor(() => expect(guard).toHaveBeenCalledOnce());
    const aborting = command('/abort');
    try {
      await vi.waitFor(() => expect(executor.abort).toHaveBeenCalledOnce());
    } finally {
      checking.resolve();
      await Promise.all([running, aborting]);
    }
    expect(executor.execute).not.toHaveBeenCalled();
    expect(executor.compactWhenFull).not.toHaveBeenCalled();
    expect(response('/abort')).toMatchObject({ success: true });
  });

  it.each(['/skill:fixture', '/compact'])('blocks native %s while cancelled backend preparation remains pending', async content => {
    await manager.updateThread(threadId, { backend: 'pi', delegation: false });
    executor.compactWhenFull = vi.fn().mockResolvedValue({ success: true });
    const preparation = deferred<void>();
    (handler as any).coordinatorPreparations.set(threadId, preparation.promise);
    try {
      await handler.handleMessage({ type: 'command', messageId: 'pending-native', content, threadId, isSlashCommand: true });
      expect(response('pending-native')).toMatchObject({ success: false, error: expect.stringContaining('preparation is still pending') });
      expect(executor.execute).not.toHaveBeenCalled();
      expect(executor.compactWhenFull).not.toHaveBeenCalled();
    } finally {
      preparation.resolve();
      (handler as any).coordinatorPreparations.delete(threadId);
    }
  });

  it('preserves model settings when recovery cancels the request before native retry preparation starts', async () => {
    await manager.updateThread(threadId, { models: { codex: 'saved-model' } });
    executor.clearModel = vi.fn();
    vi.mocked(executor.execute).mockResolvedValueOnce({ success: false, error: 'model saved-model not found' });
    vi.spyOn(handler as any, 'withCoordinatorPreparation').mockImplementationOnce(async (_id, operation) => {
      await command('/abort', 'cancel-before-retry');
      return (operation as () => Promise<unknown>)();
    });
    await command('Request before recovery', 'old-model-request');
    expect(response('cancel-before-retry')).toMatchObject({ success: true });
    expect(manager.getThread(threadId)?.models?.codex).toBe('saved-model');
    expect(executor.clearModel).not.toHaveBeenCalled();
    expect(executor.execute).toHaveBeenCalledOnce();
  });

  it('retains a direct pointer until shutdown settles, permits management, then retries reset', async () => {
    pool.getExecutor(threadId);
    const pointer = manager.getSessionFilePath(threadId);
    await fs.writeFile(pointer, 'native-pointer');
    const exit = deferred<void>();
    vi.mocked(executor.destroy).mockReturnValue(exit.promise);
    await command('/clear');
    expect(response('/clear')).toMatchObject({ success: false, error: expect.stringContaining('shutdown timed out') });
    expect(await fs.readFile(pointer, 'utf8')).toBe('native-pointer');
    expect(executor.resetContext).not.toHaveBeenCalled();
    await command('/thread new after-partial');
    await command('/thread list');
    await command('/abort');
    expect(response('/abort')).toMatchObject({ success: true });
    expect(manager.getThreadByName('after-partial')).toBeDefined();
    await command('Do not resume');
    expect(executor.execute).not.toHaveBeenCalled();
    exit.resolve();
    await command('/new');
    expect(response('/new')).toMatchObject({ success: true });
    expect(executor.destroy).toHaveBeenCalledOnce();
    expect(executor.resetContext).toHaveBeenCalledOnce();
    await expect(fs.stat(pointer)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serializes concurrent resets and remains retryable after durable generation persistence fails', async () => {
    const hold = deferred<void>();
    const begin = manager.contextResets.begin.bind(manager.contextResets);
    vi.spyOn(manager.contextResets, 'begin').mockImplementationOnce(async id => { await begin(id); await hold.promise; });
    const first = command('/clear', 'first');
    await vi.waitFor(() => expect(manager.contextResets.isPending(threadId)).toBe(true));
    await command('/new', 'concurrent');
    expect(response('concurrent')).toMatchObject({ success: false, error: expect.stringContaining('operation') });
    const fail = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('Synthetic reset persistence failure'));
    hold.resolve();
    await first;
    expect(response('first')).toMatchObject({ success: false });
    expect(manager.contextResets.generation(threadId)).toBe(0);
    const loaded = await ThreadManager.initialize(home);
    expect(() => loaded.contextResets.assertReady(threadId)).toThrow('incomplete');
    expect(executor.resetContext).not.toHaveBeenCalled();
    fail.mockRestore();
    await command('/new', 'retry');
    expect(response('retry')).toMatchObject({ success: true });
    expect(manager.getThread(threadId)?.delegationWorkspaceGeneration).toBe(1);
    await command('/clear', 'repeated');
    expect(manager.getThread(threadId)?.delegationWorkspaceGeneration).toBe(2);
  });

  it('releases an orphaned foreground busy flag after confirmed reset', async () => {
    pool.setThreadBusy(threadId, true);
    await command('/clear');
    expect(response('/clear')).toMatchObject({ success: true });
    expect(pool.isThreadBusy(threadId)).toBe(false);
    await command('Fresh request');
    expect(response('Fresh request')).toMatchObject({ success: true });
  });

  it('keeps reset pending when a concurrent abort can still rewrite the direct pointer', async () => {
    pool.getExecutor(threadId);
    (pool as any).contextResetShutdownTimeoutMs = 2_000;
    const pointer = manager.getSessionFilePath(threadId);
    await fs.writeFile(pointer, 'old pointer');
    const destruction = deferred<void>();
    const abortion = deferred<boolean>();
    vi.mocked(executor.destroy).mockReturnValueOnce(destruction.promise);
    vi.mocked(executor.abort).mockResolvedValueOnce(true).mockImplementationOnce(async () => {
      await abortion.promise;
      await fs.writeFile(pointer, 'late abort write');
      return true;
    });
    const clearing = command('/clear', 'clearing');
    await vi.waitFor(() => expect(executor.destroy).toHaveBeenCalled());
    const aborting = command('/abort', 'concurrent-abort');
    await vi.waitFor(() => expect(executor.abort).toHaveBeenCalledTimes(2));
    try {
      destruction.resolve();
      await clearing;
      expect(response('clearing')).toMatchObject({ success: false, error: expect.stringContaining('abort is still pending') });
      expect(manager.contextResets.isPending(threadId)).toBe(true);
    } finally {
      destruction.resolve();
      abortion.resolve(true);
      await aborting;
    }
    expect(await fs.readFile(pointer, 'utf8')).toBe('late abort write');
    await command('/new', 'retry');
    expect(response('retry')).toMatchObject({ success: true });
    await expect(fs.stat(pointer)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
