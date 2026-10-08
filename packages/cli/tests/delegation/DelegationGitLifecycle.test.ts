import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { setTimeout as realDelay } from 'node:timers/promises';
import { BackendRegistry } from '../../src/delegation/BackendRegistry';
import { DELEGATION_LIMITS, DelegationManager, type DelegationParent, type DelegatedTaskResult } from '../../src/delegation/DelegationManager';
import { runGit } from '../../src/delegation/GitCheckpoint';
import type { ExecuteResult, IExecutor } from '../../src/executor/IExecutor';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { gitFixture } from './gitFixture';

// Git and filesystem phases still use wall-clock I/O while worker deadlines are virtual.
const PHASE_WAIT_OPTIONS = { timeout: 10_000 };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('managed Git phases and native worker deadlines', { timeout: 30_000 }, () => {
  let fixture: Awaited<ReturnType<typeof gitFixture>>;
  let manager: DelegationManager;
  let parent: DelegationParent;
  let workers: { executor: IExecutor; cwd: string; finish: (result: ExecuteResult) => void }[];
  beforeEach(async () => {
    fixture = await gitFixture();
    vi.spyOn(os, 'homedir').mockReturnValue(fixture.directory);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    workers = [];
    manager = new DelegationManager(new DirectoryGuard([fixture.directory]), (_guard, _config, cwd) => {
      let finish!: (result: ExecuteResult) => void;
      const completion = new Promise<ExecuteResult>(resolve => { finish = resolve; });
      const executor: IExecutor = {
        execute: vi.fn(() => completion), abort: vi.fn(async () => true), destroy: vi.fn(async () => undefined),
        waitForExit: vi.fn(async () => undefined), resetContext: vi.fn(),
        getCurrentWorkingDirectory: () => cwd, setWorkingDirectory: vi.fn(),
      };
      workers.push({ executor, cwd, finish });
      return executor;
    }, new BackendRegistry(async () => 'fixture 1.0'));
    parent = {
      thread: { id: 'fixture-owner', name: 'default', workingDirectory: fixture.root,
        sessionId: null, createdAt: 0, lastActiveAt: 0 },
      cwd: fixture.root, messageId: 'parent', backend: 'claude', config: { type: 'auto' },
      onToolUse: vi.fn(), onToolResult: vi.fn(), onNotice: vi.fn(), onProgress: vi.fn(() => true),
      onApproval: vi.fn(() => true), onApprovalResolved: vi.fn(),
    };
  });
  afterEach(async () => {
    vi.useRealTimers();
    await manager.destroy();
    vi.restoreAllMocks();
    await fs.rm(fixture.directory, { recursive: true, force: true });
  });
  const start = (scope: ReturnType<DelegationManager['begin']>, id = 'task') =>
    scope.invoke('remote_cli_delegate', { backend: 'codex', objective: `Independent ${id}` }, id) as Promise<DelegatedTaskResult>;
  const result = (scope: ReturnType<DelegationManager['begin']>, taskId: string) =>
    scope.invoke('remote_cli_result', { taskId, waitSeconds: 25 }, `result-${taskId}`) as Promise<DelegatedTaskResult>;

  it.each(['baseline', 'prepare'] as const)('awaits slow %s without charging native startup or releasing its slot', async phase => {
    const gate = deferred();
    let entered = false;
    if (phase === 'prepare') {
      const baseline = manager.workspaceManager.baseline.bind(manager.workspaceManager);
      vi.spyOn(manager.workspaceManager, 'baseline').mockImplementation(async (...args) => {
        // Real Git setup can exceed waitFor's default one-second observation window.
        await realDelay(1_100);
        return baseline(...args);
      });
    }
    const original = manager.workspaceManager[phase].bind(manager.workspaceManager);
    vi.spyOn(manager.workspaceManager, phase).mockImplementation(async (...args: any[]) => {
      entered = true;
      await gate.promise;
      return (original as any)(...args);
    });
    const scope = manager.begin(parent);
    vi.useFakeTimers();
    const starting = start(scope);
    try {
      await vi.waitFor(() => expect(entered).toBe(true), PHASE_WAIT_OPTIONS);
      await vi.advanceTimersByTimeAsync(DELEGATION_LIMITS.storageTimeoutMs + 1);
      expect(workers).toHaveLength(0);
      expect((manager as any).running).toBe(1);
      expect(manager.hasActiveTasks(parent.thread.id)).toBe(true);
      expect(manager.blocksWorkspace(fixture.root, 'other')).toBe(true);
    } finally { vi.useRealTimers(); gate.resolve(); }
    const task = await starting;
    expect(task.state).toBe('running');
    workers[0].finish({ success: true });
    expect(await result(scope, task.taskId)).toMatchObject({ state: 'succeeded' });
    expect((manager as any).running).toBe(0);
    expect(manager.blocksWorkspace(fixture.root, 'other')).toBe(false);
  });

  it('waits for preparation to settle on scope cancellation and never constructs a late worker', async () => {
    const gate = deferred();
    const original = manager.workspaceManager.prepare.bind(manager.workspaceManager);
    const prepare = vi.spyOn(manager.workspaceManager, 'prepare').mockImplementation(async (...args) => {
      await gate.promise;
      return original(...args);
    });
    const scope = manager.begin(parent);
    vi.useFakeTimers();
    const starting = start(scope);
    let closed = false;
    let closing: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce(), PHASE_WAIT_OPTIONS);
      closing = scope.close().then(() => { closed = true; });
      await vi.advanceTimersByTimeAsync(DELEGATION_LIMITS.storageTimeoutMs + 1);
      expect(closed).toBe(false);
      expect((manager as any).running).toBe(1);
      expect(manager.blocksWorkspace(fixture.root, 'other')).toBe(true);
    } finally { vi.useRealTimers(); gate.resolve(); }
    await closing;
    expect(await starting).toMatchObject({ state: 'cancelled' });
    expect(workers).toHaveLength(0);
    expect((manager as any).running).toBe(0);
    expect(manager.blocksWorkspace(fixture.root, 'other')).toBe(false);
  });

  it.each(['baseline', 'prepare'] as const)('returns an accepted task before transport timeout during slow %s', async phase => {
    const gate = deferred();
    let entered = false;
    const original = manager.workspaceManager[phase].bind(manager.workspaceManager);
    vi.spyOn(manager.workspaceManager, phase).mockImplementation(async (...args: any[]) => {
      entered = true;
      await gate.promise;
      return (original as any)(...args);
    });
    const scope = manager.begin(parent);
    vi.useFakeTimers();
    const invokedAt = Date.now();
    let returnedAt: number | undefined;
    let response: DelegatedTaskResult | undefined;
    const starting = start(scope).then(value => { response = value; returnedAt = Date.now(); return value; });
    try {
      await vi.waitFor(() => expect(entered).toBe(true), PHASE_WAIT_OPTIONS);
      await vi.advanceTimersByTimeAsync(31_000);
      expect(returnedAt).toBeDefined();
      expect(returnedAt! - invokedAt).toBeLessThan(25_000);
      expect(response).toMatchObject({ state: 'queued', statusDetail: expect.stringContaining('remote_cli_result') });
      expect(await start(scope)).toEqual(response);
      expect(workers).toHaveLength(0);
      expect((manager as any).running).toBe(1);
      expect(manager.blocksWorkspace(fixture.root, 'other')).toBe(true);
    } finally { vi.useRealTimers(); gate.resolve(); }
    const task = await starting;
    await vi.waitFor(() => expect(workers).toHaveLength(1), { timeout: 5000 });
    workers[0].finish({ success: true });
    expect(await result(scope, task.taskId)).toMatchObject({ state: 'succeeded' });
    expect((manager as any).running).toBe(0);
  });

  it.each(['prepare', 'collect'] as const)('acknowledges cancellation without waiting for slow %s or releasing ownership', async phase => {
    const gate = deferred();
    const entered = deferred();
    const original = manager.workspaceManager[phase].bind(manager.workspaceManager);
    vi.spyOn(manager.workspaceManager, phase).mockImplementation(async (...args: any[]) => {
      entered.resolve();
      await gate.promise;
      return (original as any)(...args);
    });
    const scope = manager.begin(parent);
    vi.useFakeTimers();
    const starting = start(scope);
    if (phase === 'collect') {
      // Let native dispatch settle without advancing its inactivity clock.
      await starting;
      expect(workers).toHaveLength(1);
      workers[0].finish({ success: true });
    }
    let cancelling: Promise<unknown> | undefined;
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(21_000);
      const task = await starting;
      let response: any;
      cancelling = scope.invoke('remote_cli_cancel', { taskId: task.taskId }, 'cancel')
        .then(value => { response = value; });
      await vi.advanceTimersByTimeAsync(21_000);
      expect(response).toMatchObject({ taskId: task.taskId, state: phase === 'prepare' ? 'queued' : 'running',
        statusDetail: expect.stringContaining('remote_cli_result') });
      expect((manager as any).running).toBe(1);
      expect(manager.blocksWorkspace(fixture.root, 'other')).toBe(true);
    } finally { vi.useRealTimers(); gate.resolve(); }
    await cancelling;
    const terminal = await result(scope, (await starting).taskId);
    expect(terminal.state).toBe(phase === 'prepare' ? 'cancelled' : 'succeeded');
    expect(terminal.statusDetail).toBeUndefined();
    expect(workers).toHaveLength(phase === 'prepare' ? 0 : 1);
    expect((manager as any).running).toBe(0);
    expect(manager.blocksWorkspace(fixture.root, 'other')).toBe(false);
  });

  it('keeps five preparation slots while repository metadata admission is queued', async () => {
    const gate = deferred();
    const source = (await manager.workspaceManager.discover(fixture.root))!;
    // Hold the actual repository guard, not a worker process or a Git command.
    const holding = (manager.workspaceManager as any).withRepository(source, () => gate.promise);
    const prepare = vi.spyOn(manager.workspaceManager, 'prepare');
    const scope = manager.begin(parent);
    vi.useFakeTimers();
    const starting = Array.from({ length: 5 }, (_, index) => start(scope, `queued-prepare-${index}`));
    try {
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(5), PHASE_WAIT_OPTIONS);
      const queued = await start(scope, 'sixth');
      expect(queued.state).toBe('queued');
      await vi.advanceTimersByTimeAsync(DELEGATION_LIMITS.storageTimeoutMs + 1);
      expect(workers).toHaveLength(0);
      expect((manager as any).running).toBe(5);
    } finally { vi.useRealTimers(); gate.resolve(); await holding; }
    const tasks = await Promise.all(starting);
    expect(tasks.every(task => task.state === 'running')).toBe(true);
    expect(new Set(workers.map(worker => worker.cwd)).size).toBe(5);
    workers[0].finish({ success: true });
    // Concurrent preparation may dispatch workers in a different order from
    // admission. Observe slot-driven dispatch, not an unrelated task's result.
    await vi.waitFor(() => expect(workers).toHaveLength(6), { timeout: 5000 });
    workers.slice(1).forEach(worker => worker.finish({ success: true }));
    expect((await scope.collectPendingResults()).every(task => task.state === 'succeeded')).toBe(true);
    expect((manager as any).running).toBe(0);
  });

  it('preserves an untouched warm lane after cancellation during slow baseline capture', async () => {
    const scope = manager.begin(parent);
    const first = await start(scope);
    workers[0].finish({ success: true });
    await result(scope, first.taskId);
    const lane = (await manager.laneStore.lanesForThread(parent.thread.id))[0];
    const gate = deferred();
    const original = manager.workspaceManager.baseline.bind(manager.workspaceManager);
    const baseline = vi.spyOn(manager.workspaceManager, 'baseline').mockImplementation(async (...args) => {
      await gate.promise;
      return original(...args);
    });
    vi.useFakeTimers();
    const starting = start(scope, 'cancelled-warm-lane');
    let closing: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(baseline).toHaveBeenCalledOnce(), PHASE_WAIT_OPTIONS);
      closing = scope.close();
      await vi.advanceTimersByTimeAsync(DELEGATION_LIMITS.storageTimeoutMs + 1);
      expect((manager as any).running).toBe(1);
    } finally { vi.useRealTimers(); gate.resolve(); }
    await closing;
    expect(await starting).toMatchObject({ state: 'cancelled' });
    expect(workers).toHaveLength(1);
    expect(await manager.laneStore.lanesForThread(parent.thread.id)).toEqual([
      expect.objectContaining({ id: lane.id, state: 'ready', cleanupPending: false }),
    ]);
    expect((manager as any).running).toBe(0);
    expect(manager.blocksWorkspace(fixture.root, 'other')).toBe(false);
  });

  it('isolates persistence failure after known exit instead of quarantining the source', async () => {
    const scope = manager.begin(parent);
    const first = await start(scope);
    workers[0].finish({ success: true });
    await result(scope, first.taskId);
    const lane = (await manager.laneStore.lanesForThread(parent.thread.id))[0];
    vi.spyOn(manager.workspaceManager, 'baseline').mockRejectedValueOnce(new Error('Synthetic baseline failure'));
    vi.spyOn(manager.laneStore, 'markReady').mockRejectedValueOnce(new Error('Synthetic persistence failure'));
    const failed = await start(scope, 'failed-metadata');
    expect(await result(scope, failed.taskId)).toMatchObject({ state: 'failed',
      error: expect.stringContaining('Files were retained for manual recovery') });
    expect((await manager.laneStore.lanesForThread(parent.thread.id))[0]).toMatchObject({ id: lane.id, state: 'dirty' });
    expect((await manager.workspaceManager.unavailableLanes()).has(lane.id)).toBe(true);
    expect(workers).toHaveLength(1);
    expect((manager as any).running).toBe(0);
    expect(manager.blocksWorkspace(fixture.root, 'other')).toBe(false);
  });

  it.each(['success', 'failure'] as const)('awaits slow collection after confirmed exit and releases capacity on %s', async outcome => {
    const gate = deferred();
    const original = manager.workspaceManager.collect.bind(manager.workspaceManager);
    const collect = vi.spyOn(manager.workspaceManager, 'collect').mockImplementation(async (...args) => {
      await gate.promise;
      if (outcome === 'failure') throw new Error('Synthetic collection failure');
      return original(...args);
    });
    const scope = manager.begin(parent);
    const task = await start(scope);
    await fs.writeFile(path.join(workers[0].cwd, 'result.txt'), 'retained output\n');
    vi.useFakeTimers();
    workers[0].finish({ success: true });
    let settled = false;
    const finishing = result(scope, task.taskId).then(value => { settled = true; return value; });
    try {
      await vi.waitFor(() => expect(collect).toHaveBeenCalledOnce(), PHASE_WAIT_OPTIONS);
      expect(workers[0].executor.waitForExit).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(DELEGATION_LIMITS.storageTimeoutMs + 1);
      expect(settled).toBe(false);
      expect((manager as any).running).toBe(1);
      expect(manager.blocksWorkspace(fixture.root, 'other')).toBe(true);
    } finally { vi.useRealTimers(); gate.resolve(); }
    const terminal = await finishing;
    expect(terminal.state).toBe(outcome === 'success' ? 'succeeded' : 'failed');
    if (outcome === 'success') expect(terminal.artifact?.disposition).toBe('pending');
    else expect(terminal.error).toContain('Files were retained for manual recovery');
    expect(await fs.readFile(path.join(workers[0].cwd, 'result.txt'), 'utf8')).toBe('retained output\n');
    expect((manager as any).running).toBe(0);
    expect(manager.blocksWorkspace(fixture.root, 'other')).toBe(false);
    const lane = (await manager.laneStore.lanesForThread(parent.thread.id))[0];
    expect(lane.state).toBe(outcome === 'success' ? 'ready' : 'dirty');
    const next = await start(scope, 'following');
    expect(workers[1].cwd).not.toBe(workers[0].cwd);
    // Only the first collection is gated/failing.
    if (outcome === 'failure') collect.mockImplementation(original);
    workers[1].finish({ success: true });
    expect(await result(scope, next.taskId)).toMatchObject({ state: 'succeeded' });
  });

  it('preserves hidden worker edits instead of publishing a stale no-change artifact', async () => {
    const scope = manager.begin(parent);
    const task = await start(scope);
    const cwd = workers[0].cwd;
    await runGit(cwd, ['update-index', '--assume-unchanged', 'source.txt']);
    await fs.writeFile(path.join(cwd, 'source.txt'), 'hidden worker output\n');
    workers[0].finish({ success: true });
    expect(await result(scope, task.taskId)).toMatchObject({ state: 'failed',
      error: expect.stringContaining('assume-unchanged or skip-worktree') });
    expect(await manager.workspaceManager.describe(task.taskId)).toBeUndefined();
    expect(await fs.readFile(path.join(cwd, 'source.txt'), 'utf8')).toBe('hidden worker output\n');
    expect((await manager.laneStore.lanesForThread(parent.thread.id))[0]).toMatchObject({ state: 'dirty', cleanupPending: false });
    expect((manager as any).running).toBe(0);
    expect(manager.blocksWorkspace(fixture.root, 'other')).toBe(false);
  });

  it('still quarantines an unconfirmed native exit and never starts artifact collection', async () => {
    const scope = manager.begin(parent);
    const task = await start(scope);
    const exit = vi.mocked(workers[0].executor.waitForExit!).mockImplementation(() => new Promise(() => undefined));
    const collect = vi.spyOn(manager.workspaceManager, 'collect');
    vi.useFakeTimers();
    try {
      workers[0].finish({ success: true });
      await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce(), PHASE_WAIT_OPTIONS);
      await vi.advanceTimersByTimeAsync(DELEGATION_LIMITS.storageTimeoutMs + 1);
      expect(await result(scope, task.taskId)).toMatchObject({ state: 'interrupted' });
      expect(collect).not.toHaveBeenCalled();
      expect((manager as any).running).toBe(1);
      expect(manager.blocksWorkspace(fixture.root, 'other')).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});
