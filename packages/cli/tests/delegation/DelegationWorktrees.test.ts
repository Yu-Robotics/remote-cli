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
import { gitFixture } from './gitFixture';

function controlledWorker(cwd: string) {
  let finish!: (result: ExecuteResult) => void;
  const completed = new Promise<ExecuteResult>(resolve => { finish = resolve; });
  const executor: IExecutor = { execute: vi.fn(() => completed), abort: vi.fn(async () => true),
    destroy: vi.fn(async () => undefined), waitForExit: vi.fn(async () => undefined),
    resetContext: vi.fn(), getCurrentWorkingDirectory: () => cwd, setWorkingDirectory: vi.fn() };
  return { executor, cwd, finish };
}

describe('Git-aware delegated scheduling and lane reuse', () => {
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
    await fs.writeFile(path.join(workers[0].cwd, 'source.txt'), 'integrated result\n');
    workers[0].finish({ success: true, output: 'Ready' });
    await result(scope, first.taskId, 'first-result');
    const inspection: any = await scope.invoke('remote_cli_integrate', { taskId: first.taskId }, 'inspect');
    expect(await scope.invoke('remote_cli_integrate', { taskId: first.taskId, action: 'apply',
      expectedRevision: inspection.revision }, 'apply')).toMatchObject({ disposition: 'applied' });
    await fs.writeFile(path.join(fixture.root, 'sibling.txt'), 'new mainline input\n');
    const second = await start(scope, 'second');
    expect(workers[1].cwd).toBe(workers[0].cwd);
    expect(factory.mock.calls[1][3]).toBe(factory.mock.calls[0][3]);
    expect(await fs.readFile(path.join(workers[1].cwd, 'sibling.txt'), 'utf8')).toContain('mainline input');
    expect(vi.mocked(workers[1].executor.execute).mock.calls[0][0]).toContain('earlier conversation context may be stale');
    workers[1].finish({ success: true, output: 'Rechecked current files' });
    await result(scope, second.taskId, 'second-result');
  });

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
});
