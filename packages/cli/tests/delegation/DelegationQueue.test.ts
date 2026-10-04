import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DelegationManager, type DelegationParent, type DelegatedTaskResult } from '../../src/delegation/DelegationManager';
import { BackendRegistry } from '../../src/delegation/BackendRegistry';
import { DelegationStore, type DelegatedTaskRecord } from '../../src/delegation/DelegationStore';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import type { ExecuteResult, IExecutor } from '../../src/executor/IExecutor';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}

function controlledWorker(cwd: string) {
  const completion = deferred<ExecuteResult>();
  const executor: IExecutor = {
    execute: vi.fn(() => completion.promise), abort: vi.fn().mockResolvedValue(true),
    destroy: vi.fn().mockResolvedValue(undefined), waitForExit: vi.fn().mockResolvedValue(undefined),
    resetContext: vi.fn(), getCurrentWorkingDirectory: () => cwd, setWorkingDirectory: vi.fn(),
  };
  return { executor, finish: completion.resolve };
}

describe('multiple accepted delegated tasks', () => {
  let directory: string;
  let guard: DirectoryGuard;
  let manager: DelegationManager;
  let parent: DelegationParent;
  let workers: ReturnType<typeof controlledWorker>[];
  let factory: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-queue-test-')));
    vi.spyOn(os, 'homedir').mockReturnValue(directory);
    guard = new DirectoryGuard([directory]);
    workers = [];
    factory = vi.fn((_guard, _config, cwd) => {
      const worker = controlledWorker(cwd);
      workers.push(worker);
      return worker.executor;
    });
    manager = new DelegationManager(guard, factory as any, new BackendRegistry(async () => 'test 1.0'));
    parent = {
      thread: { id: 'owner', name: 'default', workingDirectory: directory, sessionId: null, createdAt: 0, lastActiveAt: 0 },
      cwd: directory, messageId: 'message-1', backend: 'claude', config: { type: 'auto' },
      onToolUse: vi.fn(), onToolResult: vi.fn(), onNotice: vi.fn(), onProgress: vi.fn(() => true),
      onApproval: vi.fn(() => true), onApprovalResolved: vi.fn(),
    };
  });

  afterEach(async () => {
    await manager.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const delegate = (scope: ReturnType<DelegationManager['begin']>, id: string, backend = 'codex') =>
    scope.invoke('remote_cli_delegate', { backend, objective: `Independent review ${id}` }, id) as Promise<DelegatedTaskResult>;
  const status = (scope: ReturnType<DelegationManager['begin']>, taskId: string, id = 'status') =>
    scope.invoke('remote_cli_result', { taskId, waitSeconds: 0 }, id) as Promise<DelegatedTaskResult>;
  const readRecord = (taskId: string): DelegatedTaskRecord =>
    JSON.parse(fs.readFileSync(path.join(directory, '.remote-cli', 'delegation', `${taskId}.json`), 'utf8'));

  it('drains independent FIFO tasks after early return, isolates failures, and acknowledges only a successful continuation', async () => {
    const scope = manager.begin(parent);
    const first = await delegate(scope, 'first');
    const second = await delegate(scope, 'second', 'agy');
    const third = await delegate(scope, 'third', 'dsh');
    expect(first.state).toBe('running');
    expect(second.state).toBe('queued');
    expect(third.state).toBe('queued');
    expect(readRecord(second.taskId)).toMatchObject({ state: 'queued', acceptedAt: expect.any(Number) });
    expect(readRecord(second.taskId).startedAt).toBeUndefined();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(vi.mocked(parent.onProgress!).mock.calls.map(([event]) => event.phase)).toEqual(['started']);

    scope.finishExecution(true);
    const collected = scope.collectPendingResults();
    workers[0].finish({ success: false, error: 'Authentication required' });
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    expect(workers[0].executor.waitForExit).toHaveBeenCalledOnce();
    expect(factory.mock.calls[1][1].type).toBe('agy');
    expect(await status(scope, third.taskId, 'third-queued')).toMatchObject({ state: 'queued' });
    workers[1].finish({ success: true, output: 'Second independent finding' });
    await vi.waitFor(() => expect(workers).toHaveLength(3));
    expect(factory.mock.calls[2][1].type).toBe('dsh');
    workers[2].finish({ success: true, output: 'Third independent finding' });
    const results = await collected;
    expect(results.map(result => [result.taskId, result.state])).toEqual([
      [first.taskId, 'failed'], [second.taskId, 'succeeded'], [third.taskId, 'succeeded'],
    ]);
    expect(vi.mocked(workers[2].executor.execute).mock.calls[0][0]).not.toContain('Second independent finding');
    expect(manager.blocksWorkspace(directory, 'other')).toBe(false);
    expect(scope.hasPendingResults()).toBe(true);
    const ids = results.map(result => result.taskId);
    scope.beginExecution(ids);
    scope.finishExecution(false);
    expect(scope.getRetainedResults()).toHaveLength(3);
    scope.beginExecution(ids);
    scope.finishExecution(true);
    expect(await scope.collectPendingResults()).toEqual([]);
  });

  it('cancels one queued task without a worker or terminal progress phase, leaving its sibling runnable', async () => {
    const scope = manager.begin(parent);
    const first = await delegate(scope, 'first');
    const second = await delegate(scope, 'second', 'agy');
    const third = await delegate(scope, 'third', 'dsh');
    const cancelled = await scope.invoke('remote_cli_cancel', { taskId: second.taskId }, 'cancel');
    expect(cancelled).toMatchObject({ state: 'cancelled', error: expect.stringContaining('before') });
    expect(readRecord(second.taskId).startedAt).toBeUndefined();
    expect(vi.mocked(parent.onProgress!).mock.calls.some(([event]) => event.taskId === second.taskId)).toBe(false);
    expect(parent.onToolResult).not.toHaveBeenCalled();
    expect(parent.onNotice).toHaveBeenCalledWith(expect.stringContaining('Not started'));
    expect(workers[0].executor.abort).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledTimes(1);
    workers[0].finish({ success: true, output: 'First' });
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    expect(factory.mock.calls[1][1].type).toBe('dsh');
    workers[1].finish({ success: true, output: 'Third' });
    expect((await scope.collectPendingResults()).map(result => result.state)).toEqual(['succeeded', 'cancelled', 'succeeded']);
    expect(await status(scope, first.taskId, 'first-final')).toMatchObject({ state: 'succeeded' });
  });

  it('deduplicates concurrent admissions and keeps the cumulative quota after queued cancellations', async () => {
    const scope = manager.begin(parent);
    const attempts = await Promise.allSettled(Array.from({ length: 13 }, (_, index) => delegate(scope, `task-${index}`)));
    const accepted = attempts.filter((item): item is PromiseFulfilledResult<DelegatedTaskResult> => item.status === 'fulfilled').map(item => item.value);
    expect(accepted).toHaveLength(12);
    expect(new Set(accepted.map(task => task.taskId)).size).toBe(12);
    expect(attempts[12]).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: 'Delegated task limit reached' }) });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(await delegate(scope, 'task-1')).toEqual(accepted[1]);
    await expect(scope.invoke('remote_cli_delegate', { backend: 'agy', objective: 'Changed' }, 'task-1')).rejects.toThrow('reused');
    await Promise.all(accepted.slice(1).map(task => scope.invoke('remote_cli_cancel', { taskId: task.taskId }, `cancel-${task.taskId}`)));
    await expect(delegate(scope, 'new-task')).rejects.toThrow('task limit');
    await scope.invoke('remote_cli_cancel', { taskId: accepted[0].taskId }, 'cancel-first');
    expect((await scope.collectPendingResults()).every(result => result.state === 'cancelled')).toBe(true);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('counts accepted setup failures but rolls back an unaccepted initial write failure', async () => {
    const store = new DelegationStore();
    vi.spyOn(store, 'write').mockRejectedValueOnce(new Error('Initial disk failure'));
    manager = new DelegationManager(guard, factory as any, new BackendRegistry(async () => '1.0'), store);
    vi.spyOn(manager.laneStore, 'acquire').mockRejectedValue(new Error('Lane disk failure'));
    const scope = manager.begin(parent);
    await expect(delegate(scope, 'unaccepted')).rejects.toThrow('Initial disk failure');
    expect(manager.blocksWorkspace(directory, 'other')).toBe(false);
    for (let index = 0; index < 12; index++) {
      expect(await delegate(scope, `accepted-${index}`)).toMatchObject({ state: 'failed', error: 'Lane disk failure' });
    }
    await expect(delegate(scope, 'overflow')).rejects.toThrow('task limit');
    expect((await scope.collectPendingResults())).toHaveLength(12);
    expect(factory).not.toHaveBeenCalled();
  });

  it('keeps the workspace and same-backend lane exclusive until exit and lane readiness are confirmed', async () => {
    const exited = deferred<void>();
    const ready = deferred<void>();
    const markReady = manager.laneStore.markReady.bind(manager.laneStore);
    vi.spyOn(manager.laneStore, 'markReady').mockImplementationOnce(async id => { await ready.promise; return markReady(id); });
    const scope = manager.begin(parent);
    await delegate(scope, 'first');
    vi.mocked(workers[0].executor.waitForExit!).mockReturnValue(exited.promise);
    const second = await delegate(scope, 'second');
    workers[0].finish({ success: true });
    await vi.waitFor(() => expect(workers[0].executor.waitForExit).toHaveBeenCalled());
    expect(factory).toHaveBeenCalledTimes(1);
    expect(manager.blocksWorkspace(directory, 'other')).toBe(true);
    exited.resolve();
    await vi.waitFor(() => expect(manager.laneStore.markReady).toHaveBeenCalled());
    expect(factory).toHaveBeenCalledTimes(1);
    expect(await status(scope, second.taskId)).toMatchObject({ state: 'queued' });
    ready.resolve();
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    expect(factory.mock.calls[1][3]).toBe(factory.mock.calls[0][3]);
    workers[1].finish({ success: true });
    await scope.collectPendingResults();
    expect(manager.blocksWorkspace(directory, 'other')).toBe(false);
  });

  it('quarantines uncertain exits and terminates queued siblings without starting them', async () => {
    manager = new DelegationManager(guard, factory as any, new BackendRegistry(async () => '1.0'), new DelegationStore(), 1000, 20);
    const scope = manager.begin(parent);
    await delegate(scope, 'first');
    vi.mocked(workers[0].executor.waitForExit!).mockImplementation(() => new Promise(() => undefined));
    const second = await delegate(scope, 'second', 'agy');
    workers[0].finish({ success: true });
    const results = await scope.collectPendingResults();
    expect(results).toHaveLength(2);
    expect(results.every(result => result.state === 'interrupted')).toBe(true);
    expect(readRecord(second.taskId).startedAt).toBeUndefined();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(manager.blocksWorkspace(directory, parent.thread.id)).toBe(true);
    await expect(delegate(scope, 'later')).rejects.toThrow('busy');
  });

  it.each(['generation', 'busy', 'deleted'] as const)('revalidates the %s workspace at dequeue and reports a not-started failure', async kind => {
    let busy = false;
    parent.isWorkspaceBusy = () => busy;
    const scope = manager.begin(parent);
    await delegate(scope, 'first');
    const second = await delegate(scope, 'second');
    if (kind === 'generation') parent.thread.delegationWorkspaceGeneration = 1;
    else if (kind === 'busy') busy = true;
    else {
      const project = path.join(directory, 'project');
      fs.mkdirSync(project);
      parent.cwd = project;
      fs.rmdirSync(project);
    }
    workers[0].finish({ success: true });
    const results = await scope.collectPendingResults();
    expect(results[1]).toMatchObject({ taskId: second.taskId, state: 'failed' });
    expect(readRecord(second.taskId).startedAt).toBeUndefined();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(manager.blocksWorkspace(directory, 'other')).toBe(false);
  });

  it('closes the queue before a pending lane acquisition can create a late worker', async () => {
    const acquired = deferred<void>();
    const release = deferred<void>();
    const acquire = manager.laneStore.acquire.bind(manager.laneStore);
    vi.spyOn(manager.laneStore, 'acquire').mockImplementationOnce(async identity => {
      const lane = await acquire(identity);
      acquired.resolve();
      await release.promise;
      return lane;
    });
    const scope = manager.begin(parent);
    const first = delegate(scope, 'first');
    await acquired.promise;
    const second = await delegate(scope, 'second', 'agy');
    expect(second.state).toBe('queued');
    const closed = scope.close();
    release.resolve();
    await closed;
    expect(await first).toMatchObject({ state: 'cancelled' });
    expect(readRecord(second.taskId)).toMatchObject({ state: 'cancelled' });
    expect(factory).not.toHaveBeenCalled();
    expect(manager.blocksWorkspace(directory, 'other')).toBe(false);
    expect(await manager.laneStore.lanesForThread(parent.thread.id)).toEqual([]);
  });

  it('does not reset an older queue deadline when another task is submitted', async () => {
    manager = new DelegationManager(guard, factory as any, new BackendRegistry(async () => '1.0'), new DelegationStore(),
      { idleTimeoutMs: 5000, toolIdleTimeoutMs: 5000, queueTimeoutMs: 100 });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const scope = manager.begin(parent);
    await delegate(scope, 'first');
    const second = await delegate(scope, 'second');
    await vi.advanceTimersByTimeAsync(60);
    const third = await delegate(scope, 'third');
    await vi.advanceTimersByTimeAsync(40);
    expect(await status(scope, second.taskId, 'expired')).toMatchObject({ state: 'timed_out', error: expect.stringContaining('not started') });
    expect(await status(scope, third.taskId, 'still-queued')).toMatchObject({ state: 'queued' });
    expect(factory).toHaveBeenCalledTimes(1);
    await scope.close();
  });

  it('reserves first-task slots while initial persistence is pending, without oversubscribing the device', async () => {
    const release = deferred<void>();
    const write = manager.store.write.bind(manager.store);
    const writes = vi.spyOn(manager.store, 'write').mockImplementation(async record => {
      if (record.state === 'queued') await release.promise;
      return write(record);
    });
    const scopes = Array.from({ length: 4 }, (_, index) => {
      const cwd = path.join(directory, `project-${index}`); fs.mkdirSync(cwd);
      return manager.begin({ ...parent, cwd, thread: { ...parent.thread, id: `owner-${index}`, workingDirectory: cwd } });
    });
    const launches = scopes.slice(0, 3).map((scope, index) => delegate(scope, `first-${index}`));
    await vi.waitFor(() => expect(writes).toHaveBeenCalledTimes(3));
    expect(factory).not.toHaveBeenCalled();
    await expect(delegate(scopes[3], 'full-during-persistence')).rejects.toThrow('capacity');
    release.resolve();
    expect((await Promise.all(launches)).every(task => task.state === 'running')).toBe(true);
    expect(factory).toHaveBeenCalledTimes(3);
  });

  it('fences a provisional write after close and preserves the later request on the same thread', async () => {
    const release = deferred<void>();
    const write = manager.store.write.bind(manager.store);
    const writes = vi.spyOn(manager.store, 'write').mockImplementationOnce(async record => {
      await release.promise;
      return write(record);
    });
    const scope = manager.begin(parent);
    const launch = delegate(scope, 'before-close');
    await vi.waitFor(() => expect(writes).toHaveBeenCalledOnce());
    await scope.close();
    const next = manager.begin(parent);
    release.resolve();
    const task = await launch;
    expect(task.state).toBe('cancelled');
    expect(readRecord(task.taskId).startedAt).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
    expect(manager.blocksWorkspace(directory, 'other')).toBe(false);
    expect(await delegate(next, 'next-scope')).toMatchObject({ state: 'running' });
    expect(factory).toHaveBeenCalledOnce();
    expect(manager.hasActiveTasks(parent.thread.id)).toBe(true);
    expect(manager.blocksWorkspace(directory, 'other')).toBe(true);
  });

  it('quarantines timed-out setup and prevents a late lane acquisition from constructing a worker', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const release = deferred<Awaited<ReturnType<typeof manager.laneStore.acquire>>>();
    const acquire = manager.laneStore.acquire.bind(manager.laneStore);
    const acquisitions = vi.spyOn(manager.laneStore, 'acquire').mockImplementationOnce(() => release.promise);
    const dirty = vi.spyOn(manager.laneStore, 'markDirty');
    const scope = manager.begin(parent);
    const launch = delegate(scope, 'starting');
    await vi.waitFor(() => expect(acquisitions).toHaveBeenCalledOnce());
    const queued = await delegate(scope, 'follower', 'agy');
    await vi.advanceTimersByTimeAsync(10_000);
    const first = await launch;
    expect(first.state).toBe('interrupted');
    expect((await scope.collectPendingResults()).map(result => result.state)).toEqual(['interrupted', 'interrupted']);
    const late = await acquire(acquisitions.mock.calls[0][0]);
    release.resolve(late);
    await vi.waitFor(() => expect(dirty).toHaveBeenCalledWith(late.lane.id, expect.stringContaining('after its task ended'), true));
    await dirty.mock.results[0].value;
    const lanes = await manager.laneStore.lanesForThread(parent.thread.id);
    expect(lanes[0]).toMatchObject({ state: 'dirty', cleanupPending: true });
    expect(readRecord(queued.taskId).startedAt).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
    expect(manager.blocksWorkspace(directory, 'other')).toBe(true);
  });

  it('recognizes a terminal timestamp of zero and acknowledges its result', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    const scope = manager.begin(parent);
    const task = await delegate(scope, 'epoch-task');
    workers[0].finish({ success: true, output: 'Epoch result' });
    await scope.collectPendingResults();
    expect(readRecord(task.taskId)).toMatchObject({ startedAt: 0, finishedAt: 0 });
    expect(await status(scope, task.taskId)).toMatchObject({ state: 'succeeded', output: 'Epoch result' });
    scope.finishExecution(true);
    expect(scope.hasPendingResults()).toBe(false);
    expect(await scope.collectPendingResults()).toEqual([]);
  });

  it('keeps the global execution cap without charging queued followers another slot', async () => {
    const scopes = Array.from({ length: 4 }, (_, index) => {
      const cwd = path.join(directory, `project-${index}`); fs.mkdirSync(cwd);
      return manager.begin({ ...parent, cwd, thread: { ...parent.thread, id: `owner-${index}`, workingDirectory: cwd } });
    });
    const initial = await Promise.all(scopes.slice(0, 3).map((scope, index) => delegate(scope, `first-${index}`)));
    const follower = await delegate(scopes[0], 'follower');
    expect(follower.state).toBe('queued');
    expect(factory).toHaveBeenCalledTimes(3);
    await expect(delegate(scopes[3], 'full')).rejects.toThrow('capacity');
    const firstWorker = workers.find(worker => worker.executor.getCurrentWorkingDirectory() === path.join(directory, 'project-0'))!;
    firstWorker.finish({ success: true });
    await vi.waitFor(() => expect(workers).toHaveLength(4));
    await expect(delegate(scopes[3], 'still-full')).rejects.toThrow('capacity');
    await scopes[1].invoke('remote_cli_cancel', { taskId: initial[1].taskId }, 'cancel');
    expect(await delegate(scopes[3], 'retry')).toMatchObject({ state: 'running' });
    expect(factory).toHaveBeenCalledTimes(5);
  });

  it('rejects cross-root overlap immediately instead of creating mutually waiting queues', async () => {
    parent.isWorkspaceBusy = () => true;
    const first = manager.begin(parent);
    const other = manager.begin({ ...parent, thread: { ...parent.thread, id: 'other' }, isWorkspaceBusy: () => true });
    const attempts = await Promise.allSettled([delegate(first, 'a'), delegate(other, 'b')]);
    expect(attempts.every(result => result.status === 'rejected')).toBe(true);
    expect(factory).not.toHaveBeenCalled();
    expect(first.hasPendingResults()).toBe(false);
    expect(other.hasPendingResults()).toBe(false);
  });

  it('advertises serial scheduling and uses only existing wire phases on older peers', async () => {
    parent.onProgress = undefined;
    const scope = manager.begin(parent);
    expect(await scope.invoke('remote_cli_list_backends', {}, 'list')).toMatchObject({
      maxConcurrentChildren: 1, maxTasksPerRequest: 12, scheduling: 'serial', queueTimeoutSeconds: 3600,
    });
    await delegate(scope, 'first');
    const second = await delegate(scope, 'second');
    expect(parent.onToolUse).toHaveBeenCalledTimes(1);
    expect(parent.onNotice).toHaveBeenCalledWith(expect.stringContaining('queued'));
    await scope.invoke('remote_cli_cancel', { taskId: second.taskId }, 'cancel');
    expect(parent.onToolResult).not.toHaveBeenCalled();
    workers[0].finish({ success: true });
    await scope.collectPendingResults();
    expect(parent.onToolResult).toHaveBeenCalledTimes(1);
  });
});
