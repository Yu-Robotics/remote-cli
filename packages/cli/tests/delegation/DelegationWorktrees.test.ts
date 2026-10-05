import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { DELEGATION_LIMITS, DelegationManager, type DelegationParent, type DelegatedTaskResult } from '../../src/delegation/DelegationManager';
import { configuredExecutionMetadata } from '../../src/executor/ExecutionMetadata';
import { BackendRegistry } from '../../src/delegation/BackendRegistry';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import type { ExecuteResult, IExecutor } from '../../src/executor/IExecutor';
import { gitText, runGit } from '../../src/delegation/GitCheckpoint';
import * as gitCommands from '../../src/delegation/GitCheckpoint';
import { gitFixture } from './gitFixture';

function controlledWorker(cwd: string) {
  let finish!: (result: ExecuteResult) => void;
  const completed = new Promise<ExecuteResult>(resolve => { finish = resolve; });
  const executor: IExecutor = { execute: vi.fn(() => completed), abort: vi.fn(async () => true),
    destroy: vi.fn(async () => undefined), waitForExit: vi.fn(async () => undefined),
    resetContext: vi.fn(), getCurrentWorkingDirectory: () => cwd, setWorkingDirectory: vi.fn() };
  return { executor, cwd, finish };
}

describe('Git-aware delegated scheduling and lane reuse', { timeout: 30_000 }, () => {
  let fixture: Awaited<ReturnType<typeof gitFixture>>;
  let manager: DelegationManager;
  let parent: DelegationParent;
  let workers: ReturnType<typeof controlledWorker>[];
  let factory: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    fixture = await gitFixture();
    vi.spyOn(os, 'homedir').mockReturnValue(fixture.directory);
    workers = [];
    factory = vi.fn((guard: DirectoryGuard, _config, cwd: string) => {
      expect(guard.resolveWorkingDirectory(cwd)).toBe(cwd);
      const worker = controlledWorker(cwd); workers.push(worker); return worker.executor;
    });
    manager = new DelegationManager(new DirectoryGuard([fixture.directory]), factory as any,
      new BackendRegistry(async () => 'fixture 1.0'));
    parent = { thread: { id: 'fixture-owner', name: 'default', workingDirectory: fixture.root,
      sessionId: null, createdAt: 0, lastActiveAt: 0 }, cwd: fixture.root, messageId: 'parent',
    backend: 'claude', config: { type: 'auto' }, onToolUse: vi.fn(), onToolResult: vi.fn(), onNotice: vi.fn(),
    onProgress: vi.fn(() => true), onApproval: vi.fn(() => true), onApprovalResolved: vi.fn() };
  });
  afterEach(async () => { await manager.destroy(); vi.restoreAllMocks(); await fs.rm(fixture.directory, { recursive: true, force: true }); });
  const start = (scope: ReturnType<DelegationManager['begin']>, id: string, backend = 'codex') =>
    scope.invoke('remote_cli_delegate', { backend, objective: `Independent task ${id}` }, id) as Promise<DelegatedTaskResult>;
  const result = (scope: ReturnType<DelegationManager['begin']>, taskId: string, id: string) =>
    scope.invoke('remote_cli_result', { taskId, waitSeconds: 25 }, id) as Promise<DelegatedTaskResult>;

  it('keeps concurrent worker metadata independent while bounding combined retained results', async () => {
    factory.mockImplementation((_guard, configuration, cwd) => {
      const worker = controlledWorker(cwd);
      worker.executor.getExecutionMetadata = vi.fn(() => configuredExecutionMetadata(`${configuration.type}-selected`, 'low'));
      workers.push(worker);
      return worker.executor;
    });
    const scope = manager.begin(parent);
    const backends = ['codex', 'agy', 'dsh'];
    const tasks = await Promise.all(backends.map(backend => start(scope, backend, backend)));
    expect(tasks.every(task => task.state === 'running')).toBe(true);
    tasks.forEach(task => expect(task.executionMetadata).toMatchObject({ backend: task.backend, model: `${task.backend}-selected`, modelSource: 'configured' }));
    workers.forEach(worker => {
      const backend = worker.executor.getExecutionMetadata!().model!.replace(/-selected$/, '');
      const index = backends.indexOf(backend);
      vi.mocked(worker.executor.getExecutionMetadata!).mockReturnValue({ model: `${backend}-native`, modelSource: 'reported', reasoningEffort: ['high', 'low', 'medium'][index], effortSource: 'reported' });
      worker.finish({ success: true, output: 'x'.repeat(32_000) });
    });
    const results = await scope.collectPendingResults();
    expect(results).toHaveLength(3);
    expect(Buffer.byteLength(JSON.stringify(results))).toBeLessThanOrEqual(DELEGATION_LIMITS.continuationBytes);
    results.forEach(task => expect(task.executionMetadata).toMatchObject({ backend: task.backend, model: `${task.backend}-native`, modelSource: 'reported' }));
    expect(results.every(task => task.truncated)).toBe(true);
    for (const task of results) {
      expect(parent.onProgress).toHaveBeenCalledWith(expect.objectContaining({ taskId: task.taskId, phase: 'succeeded', executionMetadata: task.executionMetadata }));
    }
  }, 30_000);

  it('runs five isolated tasks concurrently, keeps a sixth queued, and never edits the delivery checkout', async () => {
    const scope = manager.begin(parent);
    expect(await scope.invoke('remote_cli_list_backends', {}, 'discover')).toMatchObject({
      maxConcurrentChildren: 5, scheduling: 'isolated-worktrees', workspace: fixture.root });
    const tasks: DelegatedTaskResult[] = [];
    for (const [index, backend] of ['codex', 'agy', 'dsh', 'kimi', 'agy', 'codex'].entries()) {
      tasks.push(await start(scope, `task-${index}`, backend));
    }
    const first = tasks[0];
    expect(tasks.map(task => task.state)).toEqual(['running', 'running', 'running', 'running', 'running', 'queued']);
    expect(new Set(workers.map(worker => worker.cwd)).size).toBe(5);
    expect(workers.every(worker => worker.cwd !== fixture.root)).toBe(true);
    await fs.writeFile(path.join(workers[0].cwd, 'source.txt'), 'first worker only\n');
    expect(await fs.readFile(path.join(workers[1].cwd, 'source.txt'), 'utf8')).toContain('first\nsecond');
    expect(await fs.readFile(path.join(fixture.root, 'source.txt'), 'utf8')).toContain('first\nsecond');
    await expect(scope.invoke('remote_cli_integrate', { taskId: first.taskId }, 'too-soon')).rejects.toThrow('finish');
    workers[0].finish({ success: true, output: 'Changed source' });
    expect(await result(scope, first.taskId, 'first-result')).toMatchObject({ artifact: { disposition: 'pending' } });
    await vi.waitFor(() => expect(workers).toHaveLength(6), { timeout: 10_000 });
    expect(workers[0].executor.waitForExit).toHaveBeenCalledOnce();
    workers.slice(1).forEach(worker => worker.finish({ success: true, output: 'Read-only review' }));
    const terminal = await scope.collectPendingResults();
    expect(terminal.every(task => task.state === 'succeeded')).toBe(true);
    expect(await gitText(fixture.root, ['rev-parse', 'HEAD'])).toBe(fixture.head);
    expect(await gitText(fixture.root, ['for-each-ref', '--format=%(refname)', 'refs/heads'])).toBe('refs/heads/main');
  }, 30_000);

  it('reuses native conversation and worktree after explicit integration, including sibling changes in the next baseline', async () => {
    const scope = manager.begin(parent);
    const first = await start(scope, 'first');
    const pointer = path.join(fixture.directory, '.remote-cli', 'codex-sessions', `${factory.mock.calls[0][3]}.json`);
    await fs.mkdir(path.dirname(pointer), { recursive: true });
    await fs.writeFile(pointer, JSON.stringify({ threadId: 'fixture-conversation', cwd: workers[0].cwd }));
    await fs.writeFile(path.join(workers[0].cwd, 'source.txt'), 'integrated result\n');
    workers[0].finish({ success: true, output: 'Ready' });
    await result(scope, first.taskId, 'first-result');
    const inspection: any = await scope.invoke('remote_cli_integrate', { taskId: first.taskId }, 'inspect');
    expect(await scope.invoke('remote_cli_integrate', { taskId: first.taskId, action: 'apply',
      expectedRevision: inspection.revision }, 'apply')).toMatchObject({ disposition: 'applied' });
    await expect(fs.lstat(workers[0].cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await fs.readFile(pointer, 'utf8')).threadId).toBe('fixture-conversation');
    await fs.writeFile(path.join(fixture.root, 'sibling.txt'), 'new mainline input\n');
    const second = await start(scope, 'second');
    expect(workers[1].cwd).toBe(workers[0].cwd);
    expect(factory.mock.calls[1][3]).toBe(factory.mock.calls[0][3]);
    expect(JSON.parse(await fs.readFile(pointer, 'utf8')).cwd).toBe(workers[1].cwd);
    expect(await fs.readFile(path.join(workers[1].cwd, 'sibling.txt'), 'utf8')).toContain('mainline input');
    expect(vi.mocked(workers[1].executor.execute).mock.calls[0][0]).toContain('earlier conversation context may be stale');
    workers[1].finish({ success: true, output: 'Rechecked current files' });
    await result(scope, second.taskId, 'second-result');
  }, 30_000);

  it('reuses a historically delivered lane before the next worker without deleting its checkout at admission', async () => {
    const scope = manager.begin(parent);
    const first = await start(scope, 'first');
    const originalCwd = workers[0].cwd;
    const executorId = factory.mock.calls[0][3];
    await fs.writeFile(path.join(originalCwd, 'source.txt'), 'manual handoff\n');
    workers[0].finish({ success: true });
    const completed = await result(scope, first.taskId, 'first-result');
    await runGit(fixture.root, ['merge', '--ff-only', completed.artifact!.outputCommit]);
    await fs.writeFile(path.join(fixture.root, 'sibling.txt'), 'fresh coordinator input\n');
    const removal = vi.spyOn(manager.workspaceManager, 'reclaim');
    const second = await start(scope, 'second');
    expect(removal).not.toHaveBeenCalled();
    expect(workers[1].cwd).toBe(originalCwd);
    expect(factory.mock.calls[1][3]).toBe(executorId);
    expect(await manager.workspaceManager.describe(first.taskId)).toMatchObject({ disposition: 'applied',
      deliveredAtHead: completed.artifact!.outputCommit });
    expect(await fs.readFile(path.join(workers[1].cwd, 'sibling.txt'), 'utf8')).toBe('fresh coordinator input\n');
    workers[1].finish({ success: true });
    await result(scope, second.taskId, 'second-result');
  });

  it('does not charge optional history reconciliation to the native worker startup deadline', async () => {
    const scope = manager.begin(parent);
    const first = await start(scope, 'first');
    // This tests startup timing, not Git's same-size racy-stat detection.
    await fs.writeFile(path.join(workers[0].cwd, 'source.txt'), 'slow-query handoff captured before startup delay\n');
    workers[0].finish({ success: true });
    const completed = await result(scope, first.taskId, 'first-result');
    expect(completed).toMatchObject({ state: 'succeeded', artifact: { disposition: 'pending' } });
    await runGit(fixture.root, ['merge', '--ff-only', completed.artifact!.outputCommit]);
    let release!: () => void;
    let entered = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = manager.workspaceManager.reconcileHistoricalDelivery.bind(manager.workspaceManager);
    vi.spyOn(manager.workspaceManager, 'reconcileHistoricalDelivery').mockImplementation(async (...args) => {
      entered = true; await gate; return original(...args);
    });
    vi.useFakeTimers();
    try {
      const starting = start(scope, 'slow-history');
      await vi.waitFor(() => expect(entered).toBe(true));
      await vi.advanceTimersByTimeAsync(DELEGATION_LIMITS.storageTimeoutMs + 1);
      expect(workers).toHaveLength(1);
      vi.useRealTimers();
      release();
      const second = await starting;
      expect(second.state).toBe('running');
      expect(workers[1].cwd).toBe(workers[0].cwd);
      workers[1].finish({ success: true });
      expect(await result(scope, second.taskId, 'second-result')).toMatchObject({ state: 'succeeded' });
    } finally { vi.useRealTimers(); release(); }
  });

  it('automatically recognizes manual handoff at idle turn closure and awaits reclamation', async () => {
    const scope = manager.begin(parent);
    const first = await start(scope, 'first');
    await fs.writeFile(path.join(workers[0].cwd, 'source.txt'), 'closure handoff\n');
    workers[0].finish({ success: true });
    const completed = await result(scope, first.taskId, 'first-result');
    await runGit(fixture.root, ['merge', '--ff-only', completed.artifact!.outputCommit]);
    const pointer = path.join(fixture.directory, '.remote-cli', 'codex-sessions', `${factory.mock.calls[0][3]}.json`);
    await fs.mkdir(path.dirname(pointer), { recursive: true });
    await fs.writeFile(pointer, JSON.stringify({ threadId: 'fixture-conversation', cwd: workers[0].cwd }));
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reclaiming = new Promise<void>(resolve => { entered = resolve; });
    const original = manager.workspaceManager.reclaim.bind(manager.workspaceManager);
    vi.spyOn(manager.workspaceManager, 'reclaim').mockImplementation(async taskId => { entered(); await gate; return original(taskId); });
    let closed = false;
    const closing = scope.close().then(() => { closed = true; });
    await reclaiming;
    expect(closed).toBe(false);
    expect((await fs.stat(workers[0].cwd)).isDirectory()).toBe(true);
    release();
    await closing;
    await expect(fs.lstat(workers[0].cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await fs.readFile(pointer, 'utf8')).threadId).toBe('fixture-conversation');
    expect(await manager.workspaceManager.describe(first.taskId)).toMatchObject({ disposition: 'applied' });
    const nextScope = manager.begin({ ...parent, messageId: 'next-parent' });
    const next = await start(nextScope, 'recreated');
    expect(workers[1].cwd).toBe(workers[0].cwd);
    expect(factory.mock.calls[1][3]).toBe(factory.mock.calls[0][3]);
    workers[1].finish({ success: true });
    await result(nextScope, next.taskId, 'next-result');
  }, 30_000);

  it('defers close-time recognition when another owner holds the delivery workspace', async () => {
    const scope = manager.begin(parent);
    const first = await start(scope, 'first');
    await fs.writeFile(path.join(workers[0].cwd, 'source.txt'), 'deferred handoff\n');
    workers[0].finish({ success: true });
    const completed = await result(scope, first.taskId, 'first-result');
    await runGit(fixture.root, ['merge', '--ff-only', completed.artifact!.outputCommit]);
    const otherScope = manager.begin({ ...parent, thread: { ...parent.thread, id: 'other-owner' } });
    const other = await start(otherScope, 'independent');
    await scope.close();
    expect(await manager.workspaceManager.describe(first.taskId)).toMatchObject({ disposition: 'pending' });
    expect((await fs.stat(workers[0].cwd)).isDirectory()).toBe(true);
    workers[1].finish({ success: true });
    await result(otherScope, other.taskId, 'other-result');
  });

  it('defers close-time recognition instead of waiting for an unfinished discovery admission', async () => {
    const scope = manager.begin(parent);
    const first = await start(scope, 'first');
    await fs.writeFile(path.join(workers[0].cwd, 'source.txt'), 'discovery handoff\n');
    workers[0].finish({ success: true });
    const completed = await result(scope, first.taskId, 'first-result');
    await runGit(fixture.root, ['merge', '--ff-only', completed.artifact!.outputCommit]);
    const available = await manager.registry.get('agy', parent.config);
    let release!: (value: typeof available) => void;
    vi.spyOn(manager.registry, 'get').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const starting = start(scope, 'discovering', 'agy');
    const failure = expect(starting).rejects.toThrow('ended');
    const reconciliation = vi.spyOn(manager.workspaceManager, 'reconcileHistoricalDelivery');
    // Enter the admission's probe wait; cancellation before admission starts is already idle.
    await new Promise<void>(resolve => setImmediate(resolve));
    try {
      await scope.close();
      expect(reconciliation).not.toHaveBeenCalled();
      expect(await manager.workspaceManager.describe(first.taskId)).toMatchObject({ disposition: 'pending' });
    } finally { release(available); await failure; }
    expect(workers).toHaveLength(1);
    expect((await fs.stat(workers[0].cwd)).isDirectory()).toBe(true);
  });

  it('waits for native exit before reclaiming a successful no-change checkout', async () => {
    const scope = manager.begin(parent);
    const first = await start(scope, 'first');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(workers[0].executor.waitForExit!).mockImplementation(() => gate);
    workers[0].finish({ success: true, output: 'No changes' });
    await vi.waitFor(() => expect(workers[0].executor.waitForExit).toHaveBeenCalled());
    expect((await fs.lstat(workers[0].cwd)).isDirectory()).toBe(true);
    release();
    expect(await result(scope, first.taskId, 'r1')).toMatchObject({ state: 'succeeded', artifact: { disposition: 'applied' } });
    await expect(fs.lstat(workers[0].cwd)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['failed', 'cancelled'])('preserves a %s no-change checkout', async outcome => {
    const scope = manager.begin(parent);
    const first = await start(scope, 'first');
    if (outcome === 'failed') workers[0].finish({ success: false, error: 'Fixture failure' });
    else await scope.invoke('remote_cli_cancel', { taskId: first.taskId }, 'cancel');
    expect(await result(scope, first.taskId, 'r1')).toMatchObject({ state: outcome, artifact: { disposition: 'applied' } });
    expect(await manager.workspaceManager.describe(first.taskId)).toMatchObject({ successful: false });
    expect((await fs.lstat(workers[0].cwd)).isDirectory()).toBe(true);
  });

  it('keeps a reclaiming lane non-ready and task success independent of optional cleanup', async () => {
    const scope = manager.begin(parent);
    const first = await start(scope, 'first');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reclaim = vi.spyOn(manager.workspaceManager, 'reclaim').mockImplementation(async () => { await gate; return false; });
    workers[0].finish({ success: true });
    await vi.waitFor(() => expect(reclaim).toHaveBeenCalledWith(first.taskId));
    expect((await manager.laneStore.lanesForThread(parent.thread.id))[0].state).toBe('running');
    const second = await start(scope, 'follower');
    expect(workers[1].cwd).not.toBe(workers[0].cwd);
    expect(factory.mock.calls[1][3]).not.toBe(factory.mock.calls[0][3]);
    release();
    workers[1].finish({ success: true });
    expect(await result(scope, first.taskId, 'r1')).toMatchObject({ state: 'succeeded' });
    expect(await result(scope, second.taskId, 'r2')).toMatchObject({ state: 'succeeded' });
    expect((await fs.lstat(workers[0].cwd)).isDirectory()).toBe(true);
  });

  it('admits a different lane while full byte verification is waiting', async () => {
    const scope = manager.begin(parent);
    const first = await start(scope, 'first');
    let release!: () => void;
    let verifying!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { verifying = resolve; });
    const original = gitCommands.runGit;
    vi.spyOn(gitCommands, 'runGit').mockImplementation(async (cwd, args, ...rest) => {
      if (args[0] === 'ls-tree' && args.includes('--full-tree')) { verifying(); await gate; }
      return original(cwd, args, ...rest);
    });
    workers[0].finish({ success: true });
    await entered;
    const following = start(scope, 'follower');
    try { await vi.waitFor(() => expect(workers).toHaveLength(2), { timeout: 4000 }); }
    finally { release(); }
    const second = await following;
    expect(workers[1].cwd).not.toBe(workers[0].cwd);
    workers[1].finish({ success: true });
    expect(await result(scope, first.taskId, 'r1')).toMatchObject({ state: 'succeeded' });
    expect(await result(scope, second.taskId, 'r2')).toMatchObject({ state: 'succeeded' });
  }, 30_000);

  it.each(['occupied', 'partial-registration', 'corrupt-receipt'])(
    'preserves existing context and isolates a %s checkout instead of discarding the lane', async condition => {
      const scope = manager.begin(parent);
      const first = await start(scope, 'first');
      const oldCwd = workers[0].cwd;
      const executorId = factory.mock.calls[0][3];
      const pointer = path.join(fixture.directory, '.remote-cli', 'codex-sessions', `${executorId}.json`);
      await fs.mkdir(path.dirname(pointer), { recursive: true });
      const saved = JSON.stringify({ threadId: 'fixture-conversation', cwd: oldCwd });
      await fs.writeFile(pointer, saved);
      workers[0].finish({ success: true });
      await result(scope, first.taskId, 'r1');
      const oldLane = (await manager.laneStore.lanesForThread(parent.thread.id))[0];
      if (condition === 'occupied') {
        await fs.mkdir(oldCwd);
        await fs.writeFile(path.join(oldCwd, 'retained.txt'), 'do not overwrite\n');
      } else if (condition === 'partial-registration') {
        const artifact = await manager.workspaceManager.describe(first.taskId);
        await runGit(fixture.root, ['worktree', 'add', '--detach', oldCwd, artifact!.outputCommit]);
        await fs.rm(oldCwd, { recursive: true });
      } else {
        const file = path.join(fixture.directory, '.remote-cli', 'delegation-workspaces', 'lanes', `${oldLane.id}.json`);
        const record = JSON.parse(await fs.readFile(file, 'utf8'));
        await fs.writeFile(file, JSON.stringify({ ...record, reclamation: { ...record.reclamation, output: fixture.head } }));
      }
      const failed = await start(scope, 'unavailable');
      expect(await result(scope, failed.taskId, 'r2')).toMatchObject({ state: 'failed' });
      expect(workers).toHaveLength(1);
      expect(await fs.readFile(pointer, 'utf8')).toBe(saved);
      expect((await manager.laneStore.lanesForThread(parent.thread.id))[0]).toMatchObject({
        id: oldLane.id, state: 'dirty', cleanupPending: false,
      });
      expect((await manager.workspaceManager.unavailableLanes()).has(oldLane.id)).toBe(true);
      await manager.reconcilePendingWorkerLanes();
      expect(await fs.readFile(pointer, 'utf8')).toBe(saved);
      const recovered = await start(scope, 'independent-lane');
      expect(factory.mock.calls[1][3]).not.toBe(executorId);
      expect(workers[1].cwd).not.toBe(oldCwd);
      if (condition === 'occupied') expect(await fs.readFile(path.join(oldCwd, 'retained.txt'), 'utf8')).toBe('do not overwrite\n');
      workers[1].finish({ success: true });
      expect(await result(scope, recovered.taskId, 'r3')).toMatchObject({ state: 'succeeded' });
    }, 30_000);

  it('lazily resolves a ready interrupted removal without abandoning its native conversation', async () => {
    const scope = manager.begin(parent);
    const first = await start(scope, 'first');
    const executorId = factory.mock.calls[0][3];
    let refused = false;
    const original = gitCommands.runGit;
    vi.spyOn(gitCommands, 'runGit').mockImplementation(async (cwd, args, ...rest) => {
      if (!refused && args[0] === 'worktree' && args[1] === 'remove' && args[2] === workers[0].cwd) {
        refused = true; throw new Error('Fixture removal refusal');
      }
      return original(cwd, args, ...rest);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    workers[0].finish({ success: true });
    expect(await result(scope, first.taskId, 'r1')).toMatchObject({ state: 'succeeded' });
    expect(refused).toBe(true);
    const second = await start(scope, 'reuse');
    expect(factory.mock.calls[1][3]).toBe(executorId);
    expect(workers[1].cwd).toBe(workers[0].cwd);
    workers[1].finish({ success: true });
    expect(await result(scope, second.taskId, 'r2')).toMatchObject({ state: 'succeeded' });
  }, 30_000);

  it('pools same-target conversations without reusing pending artifacts or routing ambiguous input', async () => {
    const scope = manager.begin(parent);
    const [first, second] = await Promise.all([start(scope, 'first'), start(scope, 'second')]);
    workers.forEach(worker => { worker.executor.isWaitingInput = () => true; });
    expect(manager.hasAmbiguousInput(parent.thread.id)).toBe(true);
    expect(scope.waitingExecutor()).toBeUndefined();
    workers[1].executor.isWaitingInput = () => false;
    expect(scope.waitingExecutor()).toBe(workers[0].executor);
    await fs.writeFile(path.join(workers[0].cwd, 'pending.txt'), 'pending result\n');
    workers.forEach(worker => worker.finish({ success: true }));
    await Promise.all([result(scope, first.taskId, 'r1'), result(scope, second.taskId, 'r2')]);
    const third = await start(scope, 'third');
    expect(workers[2].cwd).toBe(workers[1].cwd);
    expect(workers[2].cwd).not.toBe(workers[0].cwd);
    expect((await manager.laneStore.lanesForThread(parent.thread.id)).some(lane => lane.state === 'dirty')).toBe(false);
    workers[2].finish({ success: true });
    await result(scope, third.taskId, 'r3');
  });

  it('returns an untouched reused lane to ready when baseline capture fails', async () => {
    const scope = manager.begin(parent);
    const first = await start(scope, 'first');
    const executorId = factory.mock.calls[0][3];
    const pointer = path.join(fixture.directory, '.remote-cli', 'codex-sessions', `${executorId}.json`);
    await fs.mkdir(path.dirname(pointer), { recursive: true });
    await fs.writeFile(pointer, 'retained context');
    workers[0].finish({ success: true });
    await result(scope, first.taskId, 'first-result');
    const lane = (await manager.laneStore.lanesForThread(parent.thread.id))[0];
    const savedPath = path.join(fixture.directory, '.remote-cli', 'delegation-workspaces', 'lanes', `${lane.id}.json`);
    const saved = await fs.readFile(savedPath, 'utf8');
    const prepare = vi.spyOn(manager.workspaceManager, 'prepare');
    vi.spyOn(manager.workspaceManager, 'baseline').mockRejectedValueOnce(new Error('Synthetic baseline failure'));
    const failed = await start(scope, 'failed-baseline');
    expect(await result(scope, failed.taskId, 'failed-result')).toMatchObject({ state: 'failed' });
    expect(prepare).not.toHaveBeenCalled();
    expect(await fs.readFile(savedPath, 'utf8')).toBe(saved);
    expect((await manager.laneStore.lanesForThread(parent.thread.id))[0]).toMatchObject({ id: lane.id, state: 'ready' });
    expect((await manager.workspaceManager.unavailableLanes()).has(lane.id)).toBe(false);
    expect(await fs.readFile(pointer, 'utf8')).toBe('retained context');
    const next = await start(scope, 'retry-baseline');
    expect(factory.mock.calls[1][3]).toBe(executorId);
    workers[1].finish({ success: true });
    expect(await result(scope, next.taskId, 'next-result')).toMatchObject({ state: 'succeeded' });
  });

  it('retains a prepared lane on executor setup failure without blaming checkout preparation', async () => {
    const scope = manager.begin(parent);
    const first = await start(scope, 'first');
    workers[0].finish({ success: true });
    await result(scope, first.taskId, 'first-result');
    const lane = (await manager.laneStore.lanesForThread(parent.thread.id))[0];
    factory.mockImplementationOnce(() => { throw new Error('Synthetic executor failure'); });
    const failed = await start(scope, 'factory-failure');
    expect(await result(scope, failed.taskId, 'failed-result')).toMatchObject({ state: 'failed' });
    expect((await manager.laneStore.lanesForThread(parent.thread.id))[0]).toMatchObject({
      id: lane.id, state: 'dirty', cleanupPending: false,
      cleanupError: expect.stringContaining('Worker process setup did not complete'),
    });
    expect((await manager.workspaceManager.unavailableLanes()).has(lane.id)).toBe(true);
    expect(await manager.laneStore.cleanupCandidates()).toEqual([]);
  });

  it('resets preparation tracking before reusing a replacement for a missing native session', async () => {
    const scope = manager.begin(parent);
    const first = await start(scope, 'warm-first');
    const second = await start(scope, 'warm-second');
    workers[0].finish({ success: true });
    workers[1].finish({ success: true });
    await result(scope, first.taskId, 'first-result');
    await result(scope, second.taskId, 'second-result');
    const retrying = await start(scope, 'missing-session');
    workers[2].executor.consumeSessionResumeFailure = () => true;
    const staleId = factory.mock.calls[2][3];
    const healthyId = factory.mock.calls.slice(0, 2).map(call => call[3]).find(id => id !== staleId);
    const acquire = manager.laneStore.acquire.bind(manager.laneStore);
    const acquisition = vi.spyOn(manager.laneStore, 'acquire').mockImplementationOnce(async (...args) => {
      const acquired = await acquire(...args);
      expect(acquired.reused).toBe(true);
      expect(acquired.lane.executorThreadId).toBe(healthyId);
      parent.isWorkspaceBusy = () => true;
      return acquired;
    });
    workers[2].finish({ success: false, error: 'Stored native session is missing' });
    expect(await result(scope, retrying.taskId, 'retry-result')).toMatchObject({ state: 'failed' });
    expect(acquisition).toHaveBeenCalledOnce();
    const healthy = (await manager.laneStore.lanesForThread(parent.thread.id)).find(lane => lane.executorThreadId === healthyId);
    expect(healthy).toMatchObject({ state: 'ready', cleanupPending: false });
    expect((await manager.workspaceManager.unavailableLanes()).has(healthy!.id)).toBe(false);
    parent.isWorkspaceBusy = () => false;
    const recovered = await start(scope, 'retry-after-busy');
    expect(factory.mock.calls[3][3]).toBe(healthyId);
    workers[3].finish({ success: true });
    expect(await result(scope, recovered.taskId, 'recovered-result')).toMatchObject({ state: 'succeeded' });
  });

  it('captures fresh input for a later idle cohort even when the earlier review changed no files', async () => {
    const scope = manager.begin(parent);
    const first = await start(scope, 'first');
    workers[0].finish({ success: true });
    await result(scope, first.taskId, 'r1');
    await fs.writeFile(path.join(fixture.root, 'source.txt'), 'coordinator updated input\n');
    const second = await start(scope, 'second');
    expect(await fs.readFile(path.join(workers[1].cwd, 'source.txt'), 'utf8')).toBe('coordinator updated input\n');
    workers[1].finish({ success: true });
    await result(scope, second.taskId, 'r2');
  });

  it('collects cancelled partial files for recovery and rejects same-backend or foreign integration', async () => {
    const scope = manager.begin(parent);
    await expect(start(scope, 'same', 'claude')).rejects.toThrow('Same-backend');
    const first = await start(scope, 'first');
    await fs.writeFile(path.join(workers[0].cwd, 'partial.txt'), 'partial output\n');
    expect(await scope.invoke('remote_cli_cancel', { taskId: first.taskId }, 'cancel')).toMatchObject({
      state: 'cancelled', artifact: { disposition: 'pending' } });
    const inspection: any = await scope.invoke('remote_cli_integrate', { taskId: first.taskId }, 'inspect');
    await expect(scope.invoke('remote_cli_integrate', { taskId: first.taskId, action: 'apply',
      expectedRevision: inspection.revision }, 'apply')).rejects.toThrow('manual recovery');
    const other = manager.begin({ ...parent, thread: { ...parent.thread, id: 'other' } });
    await expect(other.invoke('remote_cli_integrate', { taskId: first.taskId }, 'foreign')).rejects.toThrow('foreign');
    expect(await fs.readFile(path.join(workers[0].cwd, 'partial.txt'), 'utf8')).toContain('partial output');
    await other.close();
  });

  it('fails closed on damaged Git metadata instead of starting shared-directory workers', async () => {
    await runGit(fixture.root, ['symbolic-ref', 'HEAD', 'refs/heads/unborn']);
    const scope = manager.begin(parent);
    await expect(start(scope, 'unborn')).rejects.toThrow('Git rev-parse failed');
    expect(factory).not.toHaveBeenCalled();
  });

  it('waits for native cleanup and collection before checking artifact closeout', async () => {
    const scope = manager.begin(parent);
    await start(scope, 'cleanup');
    let release!: () => void;
    vi.mocked(workers[0].executor.destroy).mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    workers[0].finish({ success: true });
    scope.finishExecution(true);
    let settled = false;
    const checking = scope.checkArtifactCloseout().finally(() => { settled = true; });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(settled).toBe(false);
    release();
    expect(await checking).toEqual([]);
  });

  it('preserves pending artifacts while another thread owns the delivery workspace', async () => {
    const busy = vi.fn(() => false);
    parent.isWorkspaceBusy = busy;
    const scope = manager.begin(parent);
    const task = await start(scope, 'busy-delivery');
    await fs.writeFile(path.join(workers[0].cwd, 'source.txt'), 'worker output\n');
    workers[0].finish({ success: true });
    const done = await result(scope, task.taskId, 'done');
    scope.finishExecution(true);
    busy.mockReturnValue(true);
    const reconciliation = vi.spyOn(manager.workspaceManager, 'reconcileHistoricalDelivery');
    expect(await scope.checkArtifactCloseout()).toEqual([{ taskId: task.taskId, backend: 'codex', status: 'unavailable' }]);
    expect(reconciliation).not.toHaveBeenCalled();
    expect(await manager.workspaceManager.describe(task.taskId)).toMatchObject({ disposition: 'pending' });
    busy.mockReturnValue(false);
    expect(await scope.checkArtifactCloseout()).toEqual([{ taskId: task.taskId, backend: 'codex', status: 'pending', outputCommit: done.artifact!.outputCommit }]);
  });

  it.each(['no-change', 'apply', 'retain'])(
    'accepts validated %s receipts while another thread is busy without reconciling history', async disposition => {
      const scope = manager.begin(parent);
      const task = await start(scope, 'delivered');
      if (disposition !== 'no-change') await fs.writeFile(path.join(workers[0].cwd, 'source.txt'), 'delivered output\n');
      workers[0].finish({ success: true });
      await result(scope, task.taskId, 'done');
      if (disposition !== 'no-change') {
        const inspected: any = await scope.invoke('remote_cli_integrate', { taskId: task.taskId, action: 'inspect' }, 'inspect');
        await scope.invoke('remote_cli_integrate', {
          taskId: task.taskId, action: disposition, expectedRevision: inspected.revision,
        }, 'integrate');
      }
      scope.finishExecution(true);
      parent.isWorkspaceBusy = () => true;
      const reconcile = vi.spyOn(manager.workspaceManager, 'reconcileHistoricalDelivery');
      expect(await scope.checkArtifactCloseout()).toEqual([]);
      expect(reconcile).not.toHaveBeenCalled();
    });

  it('does not take another active scope lease to validate an already settled receipt', async () => {
    const scope = manager.begin(parent);
    const task = await start(scope, 'delivered');
    workers[0].finish({ success: true });
    await result(scope, task.taskId, 'done');
    scope.finishExecution(true);
    const sibling = manager.begin({ ...parent, thread: { ...parent.thread, id: 'another-thread' } });
    const active = await start(sibling, 'active');
    expect(await scope.checkArtifactCloseout()).toEqual([]);
    expect(manager.blocksWorkspace(fixture.root, parent.thread.id)).toBe(true);
    workers[1].finish({ success: true });
    expect(await result(sibling, active.taskId, 'sibling-done')).toMatchObject({ state: 'succeeded' });
  });

  it.each(['missing', 'foreign-owner', 'changed-ref'])(
    'does not accept a %s settled receipt merely because the source is busy', async corruption => {
      const scope = manager.begin(parent);
      const task = await start(scope, 'delivered');
      workers[0].finish({ success: true });
      await result(scope, task.taskId, 'done');
      scope.finishExecution(true);
      const file = path.join(fixture.directory, '.remote-cli', 'delegation-workspaces', 'artifacts', `${task.taskId}.json`);
      if (corruption === 'missing') await fs.unlink(file);
      else if (corruption === 'foreign-owner') {
        const record = JSON.parse(await fs.readFile(file, 'utf8'));
        await fs.writeFile(file, JSON.stringify({ ...record, threadId: 'other-owner' }));
      } else await runGit(fixture.root, ['update-ref', `refs/remote-cli/artifacts/${task.taskId}`, fixture.head]);
      parent.isWorkspaceBusy = () => true;
      expect(await scope.checkArtifactCloseout()).toEqual([{ taskId: task.taskId, backend: 'codex', status: 'unavailable' }]);
    });

  it('reports only unresolved artifacts when the source is busy', async () => {
    const scope = manager.begin(parent);
    const done = await start(scope, 'settled');
    const pending = await start(scope, 'pending');
    await fs.writeFile(path.join(workers[1].cwd, 'source.txt'), 'pending output\n');
    workers[0].finish({ success: true });
    workers[1].finish({ success: true });
    await result(scope, done.taskId, 'done');
    await result(scope, pending.taskId, 'pending-result');
    scope.finishExecution(true);
    parent.isWorkspaceBusy = () => true;
    expect(await scope.checkArtifactCloseout()).toEqual([{ taskId: pending.taskId, backend: 'codex', status: 'unavailable' }]);
  });

  it('allows deliberate retention of recovery-bearing output without deleting recovery refs', async () => {
    const scope = manager.begin(parent);
    const task = await start(scope, 'recovery');
    await fs.writeFile(path.join(workers[0].cwd, 'source.txt'), 'recovery output\n');
    workers[0].finish({ success: true });
    await result(scope, task.taskId, 'done');
    const file = path.join(fixture.directory, '.remote-cli', 'delegation-workspaces', 'artifacts', `${task.taskId}.json`);
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    const recovery = { beforeRef: `refs/remote-cli/integrations/${task.taskId}/before`, targetRef: `refs/remote-cli/integrations/${task.taskId}/target` };
    await runGit(fixture.root, ['update-ref', recovery.beforeRef, saved.input.commit]);
    await runGit(fixture.root, ['update-ref', recovery.targetRef, saved.output]);
    await fs.writeFile(file, JSON.stringify({ ...saved, recovery }));
    scope.finishExecution(true);
    expect(await scope.checkArtifactCloseout()).toMatchObject([{ taskId: task.taskId, status: 'recovery' }]);
    scope.beginExecution();
    const view: any = await scope.invoke('remote_cli_integrate', { taskId: task.taskId, action: 'inspect' }, 'inspect-recovery');
    await scope.invoke('remote_cli_integrate', { taskId: task.taskId, action: 'retain', expectedRevision: view.revision }, 'retain-recovery');
    scope.finishExecution(true);
    expect(await scope.checkArtifactCloseout()).toEqual([]);
    expect(await gitText(fixture.root, ['rev-parse', recovery.targetRef])).toBe(saved.output);
    expect(await fs.readFile(path.join(workers[0].cwd, 'source.txt'), 'utf8')).toBe('recovery output\n');
  });

  it('serializes cancellation with an active closeout inspection without continuing after it', async () => {
    const scope = manager.begin(parent);
    const task = await start(scope, 'cancel-closeout');
    workers[0].finish({ success: true });
    await result(scope, task.taskId, 'done');
    scope.finishExecution(true);
    let release!: () => void;
    const inspect = manager.workspaceManager.inspectCloseout.bind(manager.workspaceManager);
    vi.spyOn(manager.workspaceManager, 'inspectCloseout').mockImplementation(async (...args) => {
      await new Promise<void>(resolve => { release = resolve; });
      return inspect(...args);
    });
    const checking = scope.checkArtifactCloseout();
    const rejected = expect(checking).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const closing = scope.close();
    release();
    await rejected;
    await closing;
    expect(scope.isClosed()).toBe(true);
  });
});
