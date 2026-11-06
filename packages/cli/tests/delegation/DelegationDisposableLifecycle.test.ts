import { OutputSnapshots } from '../../src/output/OutputSnapshots';
import { DelegatedWorkspaceManager } from '../../src/delegation/DelegatedWorkspaceManager';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { BackendRegistry } from '../../src/delegation/BackendRegistry';
import { DelegationOwnership } from '../../src/delegation/DelegationOwnership';
import { LegacyWorkspaceCleanup } from '../../src/delegation/LegacyWorkspaceCleanup';
import { gitText } from '../../src/delegation/GitCheckpoint';
import { DelegationManager, type DelegationParent, type DelegatedTaskResult } from '../../src/delegation/DelegationManager';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { ThreadContextReset } from '../../src/thread/ThreadContextReset';
import type { ExecuteResult, IExecutor } from '../../src/executor/IExecutor';
import { gitFixture } from './gitFixture';

vi.mock('../../src/delegation/OwnershipRuntime', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/delegation/OwnershipRuntime')>();
  const { syntheticOwnershipRuntime } = await import('./syntheticOwnershipRuntime');
  return syntheticOwnershipRuntime(actual);
});

describe('disposable delegation lifecycle', { timeout: 30_000 }, () => {
  let fixture: Awaited<ReturnType<typeof gitFixture>>;
  let manager: DelegationManager;
  let parent: DelegationParent;
  let workers: { cwd: string; executor: IExecutor; finish: (result: ExecuteResult) => void }[];
  let onWorkerCreated: ((worker: typeof workers[number]) => void) | undefined;
  let expectedShutdownFailure = false;
  let settlingFixture = false;
  let pendingPhases: Set<Promise<unknown>>;
  let phaseTimings: { name: string; elapsedMs: number }[];
  let phaseAdmissionClosed: boolean;
  const makeManager = (disposalSupported = true) => new DelegationManager(new DirectoryGuard([fixture.directory]), (_guard, _config, cwd) => {
    if (!cwd) throw new Error('Fixture worker requires a working directory');
    let finish!: (result: ExecuteResult) => void;
    const done = new Promise<ExecuteResult>(resolve => { finish = resolve; });
    const executor = { execute: vi.fn(() => done), abort: vi.fn(async () => true),
      destroy: vi.fn(async () => undefined), waitForExit: vi.fn(async () => undefined), waitForManagedProcessGroupExit: vi.fn(async () => undefined),
      resetContext: vi.fn(), getCurrentWorkingDirectory: () => cwd, setWorkingDirectory: vi.fn(),
    } as unknown as IExecutor;
    workers.push({ cwd, executor, finish });
    if (settlingFixture) finish({ success: false, error: 'Synthetic fixture teardown' });
    onWorkerCreated?.(workers[workers.length - 1]);
    return executor;
  }, new BackendRegistry(async () => 'fixture 1.0'), undefined, undefined, undefined, undefined,
      new DelegatedWorkspaceManager(undefined, disposalSupported));
  beforeEach(async () => {
    expectedShutdownFailure = false;
    settlingFixture = false;
    pendingPhases = new Set();
    phaseTimings = [];
    phaseAdmissionClosed = false;
    fixture = await gitFixture();
    vi.spyOn(os, 'homedir').mockReturnValue(fixture.directory);
    vi.stubEnv('HOME', fixture.directory);
    vi.stubEnv('USERPROFILE', fixture.directory);
    workers = [];
    onWorkerCreated = undefined;
    manager = makeManager();
    parent = { thread: { id: 'fixture-owner', name: 'default', workingDirectory: fixture.root,
      sessionId: null, createdAt: 0, lastActiveAt: 0 }, cwd: fixture.root, messageId: 'message',
      backend: 'codex', config: { type: 'auto' }, onToolUse: vi.fn(), onToolResult: vi.fn(), onNotice: vi.fn(),
      onApproval: vi.fn(), onApprovalResolved: vi.fn() };
  });
  const settleFixture = async (): Promise<void> => {
    settlingFixture = true;
    workers.forEach(worker => worker.finish({ success: false, error: 'Synthetic fixture teardown' }));
    // A deadline rejects the phase waiter, not its filesystem/Git operation.
    // Drain that operation before destroy can release storage ownership.
    while (pendingPhases.size) await Promise.allSettled([...pendingPhases]);
    if (expectedShutdownFailure) await expect(manager.destroy()).rejects.toThrow('storage ownership was retained');
    else await manager.destroy();
  };
  afterEach(async () => {
    const ownedFixture = fixture;
    let settled = false;
    try {
      await settleFixture();
      settled = true;
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      if (settled) await fs.rm(ownedFixture.directory, { recursive: true, force: true });
    }
  }, 60_000);

  const lifecyclePhase = async <T>(name: string, action: () => Promise<T>, timeoutMs = 30_000): Promise<T> => {
    if (settlingFixture || phaseAdmissionClosed) throw new Error('Fixture is draining; no new Git phases may start');
    const began = Date.now();
    const operation = Promise.resolve().then(() => {
      if (settlingFixture || phaseAdmissionClosed) throw new Error('Fixture is draining; no new Git phases may start');
      return action();
    });
    pendingPhases.add(operation);
    void operation.then(() => pendingPhases.delete(operation), () => pendingPhases.delete(operation));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          phaseAdmissionClosed = true;
          reject(new Error(`Phase exceeded ${timeoutMs}ms`));
        }, timeoutMs);
      })]);
    } catch (error) {
      throw new Error(`Git lifecycle phase failed: ${name}; elapsedMs=${Date.now() - began}; workers=${workers.length}; `
        + `completed=${JSON.stringify(phaseTimings)}`, { cause: error });
    } finally {
      clearTimeout(timer);
      phaseTimings.push({ name, elapsedMs: Date.now() - began });
    }
  };

  it.each(['assertion', 'deadline'] as const)('drains unfinished phase work before fixture ownership release after a %s failure', async failure => {
    await manager.reconcilePendingWorkerLanes();
    const scope = manager.begin(parent);
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const marker = path.join(fixture.directory, 'settled-phase.txt');
    const ownership = `${manager.laneStore.storageDirectory}.ownership`;
    let operationEntered!: () => void;
    const operationStarted = new Promise<void>(resolve => { operationEntered = resolve; });
    const collecting = lifecyclePhase('gated result collection', async () => {
      operationEntered(); await gate;
      // Exercise a launch which finishes preparation only after teardown starts.
      await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Read the fixture' }, 'launch');
      const results = await scope.collectPendingResults();
      expect((await fs.lstat(ownership)).isFile()).toBe(true);
      await fs.writeFile(marker, 'phase settled before ownership release');
      return results;
    }, failure === 'deadline' ? 10 : 30_000);
    // Observe rejection immediately; a deadline leaves the original action tracked.
    const outcome = collecting.catch(error => error as Error);
    const destroy = vi.spyOn(manager, 'destroy');
    const release = vi.spyOn(DelegationOwnership.prototype, 'release');
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    // This exercises draining admitted work; a phase not yet entered is rejected separately.
    await operationStarted;
    const exercise = (async () => {
      try {
        if (failure === 'deadline') await collecting;
        else expect(workers).toHaveLength(1);
      } finally {
        const shutdown = settleFixture();
        entered();
        await shutdown;
      }
    })().catch(error => error as Error);
    await started;
    try {
      expect(pendingPhases.size).toBe(1);
      expect(destroy).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
      expect((await fs.lstat(ownership)).isFile()).toBe(true);
      await expect(fs.lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      resume();
      await exercise;
    }
    const error = await exercise;
    expect(error).toBeInstanceOf(Error);
    if (failure === 'deadline') {
      expect((error as Error).message).toContain('gated result collection');
      expect((error as Error).cause).toMatchObject({ message: 'Phase exceeded 10ms' });
    } else {
      expect((error as Error).message).toContain('to have a length of 1');
      expect(await outcome).toHaveLength(1);
    }
    expect(pendingPhases.size).toBe(0);
    expect(workers).toHaveLength(1);
    expect(workers[0].executor.waitForManagedProcessGroupExit).toHaveBeenCalled();
    expect(await fs.readFile(marker, 'utf8')).toBe('phase settled before ownership release');
    expect(release).toHaveBeenCalledOnce();
    await expect(fs.lstat(ownership)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.stat(fixture.directory)).isDirectory()).toBe(true);
  });

  it.each(['resolve', 'reject'] as const)('blocks lifecycle admission after a deadline while late work %ss under ownership', async completion => {
    await manager.reconcilePendingWorkerLanes();
    const ownership = `${manager.laneStore.storageDirectory}.ownership`;
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const marker = path.join(fixture.directory, 'late-operation');
    const destroy = vi.spyOn(manager, 'destroy');
    const releaseOwnership = vi.spyOn(DelegationOwnership.prototype, 'release');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const running = lifecyclePhase('held lifecycle operation', async () => {
      entered(); await gate;
      expect((await fs.lstat(ownership)).isFile()).toBe(true);
      await fs.writeFile(marker, 'completed under fixture ownership');
      if (completion === 'reject') throw new Error('Synthetic late lifecycle rejection');
    });
    const outcome = running.catch(error => error);
    let shutdown: Promise<void> | undefined;
    try {
      await started; await vi.advanceTimersByTimeAsync(30_001);
      expect(await outcome).toMatchObject({ cause: { message: 'Phase exceeded 30000ms' } });
      const later = vi.fn(async () => undefined);
      await expect(lifecyclePhase('must not integrate after deadline', later)).rejects.toThrow('Fixture is draining');
      expect(later).not.toHaveBeenCalled();
      vi.useRealTimers();
      shutdown = settleFixture();
      expect(pendingPhases.size).toBe(1);
      expect(destroy).not.toHaveBeenCalled(); expect(releaseOwnership).not.toHaveBeenCalled();
      expect((await fs.lstat(ownership)).isFile()).toBe(true);
      release(); await shutdown;
      expect(await fs.readFile(marker, 'utf8')).toBe('completed under fixture ownership');
      expect(releaseOwnership).toHaveBeenCalledOnce();
      expect(pendingPhases.size).toBe(0);
    } finally {
      vi.useRealTimers(); release();
      await Promise.allSettled([running, ...(shutdown ? [shutdown] : [])]);
    }
  });

  it('does not enter a scheduled lifecycle phase once teardown has begun', async () => {
    const action = vi.fn(async () => undefined);
    const scheduled = lifecyclePhase('scheduled before teardown', action);
    const outcome = scheduled.catch(error => error);
    const shutdown = settleFixture();
    try {
      expect(await outcome).toBeInstanceOf(Error);
      expect(action).not.toHaveBeenCalled();
    } finally { await Promise.allSettled([scheduled, shutdown]); }
  });

  it('waits for managed group confirmation after direct transport exit before collecting or deleting', async () => {
    const scope = manager.begin(parent);
    await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Inspect' }, 'launch');
    let confirm!: () => void;
    const group = vi.mocked(workers[0].executor.waitForManagedProcessGroupExit!)
      .mockImplementation(() => new Promise<void>(resolve => { confirm = resolve; }));
    workers[0].finish({ success: true });
    await vi.waitFor(() => expect(group).toHaveBeenCalled());
    expect((await fs.stat(workers[0].cwd)).isDirectory()).toBe(true);
    expect((await manager.workspaceManager.enumerateArtifacts()).items[0].disposition).toBeUndefined();
    confirm();
    expect((await scope.collectPendingResults())[0].state).toBe('succeeded');
    await expect(fs.stat(workers[0].cwd)).rejects.toHaveProperty('code', 'ENOENT');
  });

  it.each(['missing', 'rejected'])('preserves the checkout when group-exit evidence is %s', async failure => {
    const scope = manager.begin(parent);
    await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Inspect' }, 'launch');
    if (failure === 'missing') workers[0].executor.waitForManagedProcessGroupExit = undefined;
    else vi.mocked(workers[0].executor.waitForManagedProcessGroupExit!).mockRejectedValue(new Error('Unconfirmed descendant'));
    expectedShutdownFailure = true;
    workers[0].finish({ success: true });
    expect((await scope.collectPendingResults())[0].state).toBe('interrupted');
    expect((await fs.stat(workers[0].cwd)).isDirectory()).toBe(true);
    expect(manager.blocksWorkspace(fixture.root, 'other')).toBe(true);
    const [lane] = await manager.laneStore.lanesForThread(parent.thread.id);
    expect(lane.shutdownConfirmedGeneration).toBeUndefined();
    await expect(manager.laneStore.assertThreadContextResettable(parent.thread.id)).rejects.toThrow('unconfirmed');
  });

  it('keeps unsupported-platform delegation working under conservative checkout rules', async () => {
    await manager.destroy();
    manager = makeManager(false);
    const scope = manager.begin(parent);
    await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Inspect' }, 'launch');
    workers[0].executor.waitForManagedProcessGroupExit = undefined;
    await fs.mkdir(path.join(workers[0].cwd, 'node_modules'));
    await fs.writeFile(path.join(workers[0].cwd, 'node_modules', 'keep.txt'), 'legacy retained');
    workers[0].finish({ success: true });
    expect((await scope.collectPendingResults())[0].state).toBe('succeeded');
    expect(await fs.readFile(path.join(workers[0].cwd, 'node_modules', 'keep.txt'), 'utf8')).toBe('legacy retained');
  });

  const missingSessionTask = async () => {
    const scope = manager.begin(parent);
    await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Resume safely' }, 'launch');
    const original = workers[0];
    original.executor.consumeSessionResumeFailure = vi.fn(() => true);
    const [lane] = await manager.laneStore.lanesForThread(parent.thread.id);
    const pointer = path.join(fixture.directory, '.remote-cli', 'codex-sessions', `${lane.executorThreadId}.json`);
    await fs.mkdir(path.dirname(pointer), { recursive: true });
    await fs.writeFile(pointer, 'synthetic native continuation');
    return { scope, original, lane, pointer };
  };

  const observeReplacement = (scope: ReturnType<DelegationManager['begin']>) => {
    const created = new Promise<typeof workers[number]>(resolve => { onWorkerCreated = resolve; });
    const completed = scope.collectPendingResults();
    // Real Git reclamation and fresh checkout creation are bounded by the test's
    // deadline, not vi.waitFor's unrelated one-second default. Surface terminal
    // task failures immediately instead of reporting only a missing worker.
    const replacement = Promise.race([created, completed.then(results => {
      throw new Error(`Task ended before replacement worker creation: ${JSON.stringify(results)}`);
    })]);
    void replacement.catch(() => undefined);
    return { replacement, completed };
  };

  it('defers missing-session replacement and native cleanup until managed group exit is confirmed', async () => {
    const { scope, original, lane, pointer } = await missingSessionTask();
    let confirm!: () => void;
    const proof = new Promise<void>(resolve => { confirm = resolve; });
    const group = vi.mocked(original.executor.waitForManagedProcessGroupExit!).mockReturnValue(proof);
    const remove = vi.spyOn(manager.laneStore, 'remove');
    const saveExit = vi.spyOn(manager.laneStore, 'markShutdownConfirmed');
    const { replacement, completed } = observeReplacement(scope);
    original.finish({ success: false, error: 'Stored native session is missing' });
    try {
      await vi.waitFor(() => expect(group).toHaveBeenCalledOnce());
      expect(original.executor.waitForExit).toHaveBeenCalledOnce();
      expect(workers).toHaveLength(1);
      expect(remove).not.toHaveBeenCalled();
      expect(await manager.laneStore.lanesForThread(parent.thread.id)).toMatchObject([{ id: lane.id }]);
      expect(await fs.readFile(pointer, 'utf8')).toBe('synthetic native continuation');
      expect((await fs.stat(original.cwd)).isDirectory()).toBe(true);
    } finally { confirm(); }
    const next = await replacement;
    expect(workers).toHaveLength(2);
    await expect(fs.stat(pointer)).rejects.toHaveProperty('code', 'ENOENT');
    expect(remove).toHaveBeenCalledWith(lane.id);
    expect(saveExit).toHaveBeenCalledWith(lane.id, lane.contextGeneration ?? 0, true);
    expect(saveExit.mock.invocationCallOrder[0]).toBeLessThan(remove.mock.invocationCallOrder[0]);
    expect(next.cwd).not.toBe(original.cwd);
    next.finish({ success: true });
    expect((await completed)[0].state).toBe('succeeded');
  });

  it.each(['missing', 'rejected'])('retains the missing-session executor and context when group evidence is %s', async failure => {
    const { scope, original, lane, pointer } = await missingSessionTask();
    if (failure === 'missing') original.executor.waitForManagedProcessGroupExit = undefined;
    else vi.mocked(original.executor.waitForManagedProcessGroupExit!).mockRejectedValue(new Error('Unconfirmed descendant'));
    const remove = vi.spyOn(manager.laneStore, 'remove');
    expectedShutdownFailure = true;
    original.finish({ success: false, error: 'Stored native session is missing' });
    expect((await scope.collectPendingResults())[0].state).toBe('interrupted');
    expect(workers).toHaveLength(1);
    expect(remove).not.toHaveBeenCalled();
    // Finalization must still own and retry the original executor, not lose it to a replacement.
    expect(original.executor.destroy).toHaveBeenCalledTimes(2);
    expect(original.executor.waitForExit).toHaveBeenCalledTimes(2);
    if (failure === 'rejected') expect(original.executor.waitForManagedProcessGroupExit).toHaveBeenCalledTimes(2);
    expect(await manager.laneStore.lanesForThread(parent.thread.id)).toMatchObject([{ id: lane.id, state: 'dirty' }]);
    expect(await fs.readFile(pointer, 'utf8')).toBe('synthetic native continuation');
    expect((await fs.stat(original.cwd)).isDirectory()).toBe(true);
    expect(manager.blocksWorkspace(fixture.root, 'other')).toBe(true);
  });

  it('preserves legacy missing-session retry without requiring managed group evidence', async () => {
    await manager.destroy();
    manager = makeManager(false);
    const { scope, original, lane, pointer } = await missingSessionTask();
    original.executor.waitForManagedProcessGroupExit = undefined;
    const { replacement, completed } = observeReplacement(scope);
    original.finish({ success: false, error: 'Stored native session is missing' });
    const next = await replacement;
    expect(workers).toHaveLength(2);
    await expect(fs.stat(pointer)).rejects.toHaveProperty('code', 'ENOENT');
    expect((await manager.laneStore.lanesForThread(parent.thread.id)).some(item => item.id === lane.id)).toBe(false);
    next.finish({ success: true });
    expect((await completed)[0].state).toBe('succeeded');
  });

  it.each([true, false])('cleans temporary dependencies after an unchanged task succeeds=%s', async success => {
    const scope = manager.begin(parent);
    const task = await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Read the fixture' }, 'launch') as DelegatedTaskResult;
    const directory = workers[0].cwd;
    await fs.mkdir(path.join(directory, 'node_modules'));
    await fs.writeFile(path.join(directory, 'node_modules', 'cache'), 'disposable dependency');
    workers[0].finish({ success, error: success ? undefined : 'Fixture failure' });
    const [result] = await scope.collectPendingResults();
    expect(result.state).toBe(success ? 'succeeded' : 'failed');
    expect(result.artifact?.disposition).toBe('applied');
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await scope.checkArtifactCloseout()).toEqual([]);
    expect(await fs.readFile(path.join(fixture.root, 'source.txt'), 'utf8')).toContain('first');
    expect(task.taskId).toBe(result.taskId);
  });

  it('removes dependency file links without removing their outside targets', async context => {
    const scope = manager.begin(parent);
    await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Use fixture dependencies' }, 'launch');
    const outside = path.join(fixture.directory, 'outside-dependency');
    await fs.writeFile(outside, 'keep outside data');
    await fs.mkdir(path.join(workers[0].cwd, 'node_modules'));
    try { await fs.symlink(outside, path.join(workers[0].cwd, 'node_modules', 'tool'), 'file'); }
    catch (error) {
      if (!['EPERM', 'ENOTSUP', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      workers[0].finish({ success: true });
      await scope.collectPendingResults();
      context.skip(); return;
    }
    workers[0].finish({ success: true });
    const [result] = await scope.collectPendingResults();
    expect(result).toMatchObject({ state: 'succeeded', artifact: { disposition: 'applied' } });
    const summary = (await manager.workspaceManager.enumerateArtifacts()).items.find(item => item.taskId === result.taskId);
    expect(summary?.cleanup).toBeUndefined();
    expect(summary?.checkoutState).toBe('reclaimed');
    expect(await fs.readFile(outside, 'utf8')).toBe('keep outside data');
    await expect(fs.lstat(workers[0].cwd)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('exports required ignored reports before deleting the checkout', async () => {
    const snapshots = new OutputSnapshots(path.join(fixture.directory, 'output-snapshots'));
    await snapshots.initialize();
    parent.onOutputFiles = async (links, cwd, taskId, final) => {
      for (const candidate of links.finish(final).paths) await snapshots.snapshot(candidate, {
        cwd, taskId, messageId: 'message', threadId: parent.thread.id, generation: 0, source: 'worker',
      });
    };
    parent.onVerifiedExports = vi.fn();
    try {
    const scope = manager.begin(parent);
    await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Produce a report',
      exports: ['node_modules/report.txt'] }, 'launch');
    await fs.mkdir(path.join(workers[0].cwd, 'node_modules'));
    await fs.writeFile(path.join(workers[0].cwd, 'node_modules', 'report.txt'), 'delivered report');
    workers[0].finish({ success: true, output: '[report](node_modules/report.txt)' });
    const [result] = await scope.collectPendingResults();
    expect(result.state).toBe('succeeded');
    await expect(fs.stat(workers[0].cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    const inspected = await scope.invoke('remote_cli_integrate', { taskId: result.taskId, action: 'inspect' }, 'inspect') as {
      exportedFiles: { path: string; file: string; sha256: string }[];
    };
    expect(inspected.exportedFiles).toHaveLength(1);
    expect(inspected.exportedFiles[0].path).toBe('node_modules/report.txt');
    expect(await fs.readFile(inspected.exportedFiles[0].file, 'utf8')).toBe('delivered report');
    expect(parent.onVerifiedExports).toHaveBeenCalledWith([expect.objectContaining({ taskId: result.taskId, file: inspected.exportedFiles[0].file })]);
    expect(snapshots.references()).toHaveLength(1);
    const parts: Buffer[] = [];
    await snapshots.read(snapshots.references()[0].id, async bytes => { for await (const part of bytes) parts.push(part); });
    expect(Buffer.concat(parts).toString()).toBe('delivered report');
    } finally { await snapshots.destroy(); }
  });

  it('holds the checkout when a required report was not delivered', async () => {
    const scope = manager.begin(parent);
    await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Produce a required report',
      exports: ['missing-report.txt'] }, 'launch');
    workers[0].finish({ success: true });
    const [result] = await scope.collectPendingResults();
    expect(result.state).toBe('failed');
    expect((await fs.stat(workers[0].cwd)).isDirectory()).toBe(true);
    expect(await scope.checkArtifactCloseout()).toMatchObject([{ taskId: result.taskId, status: 'unavailable' }]);
    const [lane] = await manager.laneStore.lanesForThread(parent.thread.id);
    const pointer = path.join(fixture.directory, '.remote-cli', 'codex-sessions', `${lane.executorThreadId}.json`);
    await fs.mkdir(path.dirname(pointer), { recursive: true });
    await fs.writeFile(pointer, 'synthetic continuation');
    await scope.close();
    await expect(manager.resetWorkerLanes(parent.thread.id)).rejects.toThrow('cleanup failed');
    expect(await fs.readFile(pointer, 'utf8')).toBe('synthetic continuation');
    expect(await manager.laneStore.lanesForThread(parent.thread.id)).toMatchObject([
      { id: lane.id, cleanupError: expect.stringContaining('[artifact-recovery-required]') },
    ]);
  });

  // Four real-Git phases retain their individual 30-second deadlines. The outer
  // budget covers their sum and diagnostic overhead, rather than all work competing
  // for one 30-second window on native Windows. Teardown has its own drain window.
  it('preserves a failed code snapshot, removes its directory and recreates the lane', async () => {
    let scope = manager.begin(parent);
    const directory = await lifecyclePhase('prepare and edit the first checkout', async () => {
      await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Change the fixture' }, 'launch');
      const cwd = workers[0].cwd;
      await fs.writeFile(path.join(cwd, 'source.txt'), 'recoverable failure\n');
      return cwd;
    });
    await lifecyclePhase('capture the failed snapshot, reclaim and inspect it', async () => {
      workers[0].finish({ success: false, error: 'Fixture test failed' });
      const [failed] = await scope.collectPendingResults();
      expect(failed.state).toBe('failed');
      expect(failed.artifact?.disposition).toBe('retained');
      await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await scope.checkArtifactCloseout()).toEqual([]);
      const artifact = await scope.invoke('remote_cli_integrate', { taskId: failed.taskId, action: 'inspect' }, 'inspect') as { changedFiles: string[] };
      expect(artifact.changedFiles).toContain('source.txt');
      await scope.close();
    });
    await lifecyclePhase('recreate the same lane with fresh input', async () => {
      scope = manager.begin(parent);
      await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Read fresh input' }, 'second');
      expect(workers[1].cwd).toBe(directory);
      expect(await fs.readFile(path.join(directory, 'source.txt'), 'utf8')).toContain('first');
    });
    await lifecyclePhase('collect the second worker and reset the lane', async () => {
      workers[1].finish({ success: true });
      await scope.collectPendingResults();
      await scope.close();
      expect(await manager.resetWorkerLanes(parent.thread.id)).toBe(1);
    });
  }, 125_000);

  it('excludes old artifacts and lanes after durable conversation detachment and restart', async () => {
    const scope = manager.begin(parent);
    await lifecyclePhase('prepare and edit the old generation worker', async () => {
      await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Old changes' }, 'old');
      await fs.writeFile(path.join(workers[0].cwd, 'source.txt'), 'historical changes\n');
      workers[0].finish({ success: true });
    });
    const { old, oldLane } = await lifecyclePhase('collect the old generation artifact and lane', async () => {
      const [old] = await scope.collectPendingResults();
      const [oldLane] = await manager.laneStore.lanesForThread(parent.thread.id);
      return { old, oldLane };
    });
    await lifecyclePhase('close the old generation scope', () => scope.close());
    await lifecyclePhase('persist conversation detachment and stop the old manager', async () => {
      const resets = new ThreadContextReset(path.join(fixture.directory, 'reset-state'));
      await resets.begin(parent.thread.id);
      await resets.advanceGeneration(parent.thread.id);
      await resets.complete(parent.thread.id);
      await manager.destroy();
    });
    await lifecyclePhase('restart and distinguish historical artifacts from current obligations', async () => {
      manager = makeManager();
      parent.thread = { ...parent.thread, delegationWorkspaceGeneration: new ThreadContextReset(path.join(fixture.directory, 'reset-state')).generation(parent.thread.id) };
      expect(await manager.pendingArtifactContext(parent.thread, fixture.root)).toBe('');
      const historical = await manager.workspaceManager.enumerateArtifacts({ threadId: parent.thread.id });
      expect(historical.items).toEqual(expect.arrayContaining([expect.objectContaining({ taskId: old.taskId })]));
    });
    const next = manager.begin(parent);
    await lifecyclePhase('prepare a fresh generation without reusing the detached lane', async () => {
      await next.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Fresh work' }, 'new');
      const lanes = await manager.laneStore.lanesForThread(parent.thread.id);
      expect(lanes).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: oldLane.id, workspaceGeneration: 0 }),
        expect.objectContaining({ workspaceGeneration: 1, state: 'running' }),
      ]));
      expect(workers[1].cwd).not.toBe(workers[0].cwd);
      workers[1].finish({ success: true });
    });
    await lifecyclePhase('collect the fresh generation worker', () => next.collectPendingResults());
    await lifecyclePhase('verify fresh closeout while retaining historical bytes', async () => {
      expect(await next.checkArtifactCloseout()).toEqual([]);
      expect(await fs.readFile(path.join(workers[0].cwd, 'source.txt'), 'utf8')).toBe('historical changes\n');
    });
  }, 8 * 30_000 + 5_000);

  it('rediscovers pending output after restart without diagnostic task records', async () => {
    const scope = manager.begin(parent);
    await lifecyclePhase('prepare and edit the pending restart artifact', async () => {
      await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Change fixture' }, 'launch');
      await fs.writeFile(path.join(workers[0].cwd, 'source.txt'), 'pending change\n');
      workers[0].finish({ success: true });
    });
    const result = await lifecyclePhase('collect the pending restart artifact', async () => {
      const [result] = await scope.collectPendingResults();
      expect(result.artifact?.disposition).toBe('pending');
      return result;
    });
    await lifecyclePhase('close and stop before removing only diagnostic records', async () => {
      await scope.close();
      await manager.destroy();
      const diagnosticRoot = path.join(fixture.directory, '.remote-cli', 'delegation');
      await fs.rm(diagnosticRoot, { recursive: true, force: true });
    });
    const next = await lifecyclePhase('restart and rediscover pending output without inventing obligations', async () => {
      manager = makeManager();
      expect(await manager.pendingArtifactContext(parent.thread, fixture.root)).toContain(result.taskId);
      const next = manager.begin(parent);
      // Ordinary turns do not inherit mandatory managed-work closeout. Explicit inspection remains available.
      expect(await next.checkArtifactCloseout()).toEqual([]);
      return next;
    });
    const inspected = await lifecyclePhase('inspect the rediscovered artifact', () =>
      next.invoke('remote_cli_integrate', { taskId: result.taskId, action: 'inspect' }, 'inspect') as Promise<{ revision: string }>);
    await lifecyclePhase('retain and reclaim the rediscovered artifact', () =>
      next.invoke('remote_cli_integrate', { taskId: result.taskId, action: 'retain', expectedRevision: inspected.revision }, 'retain'));
    await lifecyclePhase('verify rediscovered artifact closeout and directory removal', async () => {
      expect(await next.checkArtifactCloseout()).toEqual([]);
      await expect(fs.stat(workers[0].cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  }, 7 * 30_000 + 5_000);

  it('retires only a completed exact offline discard after failed capture, preserving native history and refs', async () => {
    const scope = manager.begin(parent);
    const capture = vi.spyOn(manager.workspaceManager, 'collect').mockRejectedValue(new Error('Synthetic capture failure before artifact persistence'));
    await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Produce required fixture output', exports: ['missing.txt'] }, 'launch');
    workers[0].finish({ success: true });
    const [result] = await scope.collectPendingResults();
    capture.mockRestore();
    expect(await scope.checkArtifactCloseout()).toMatchObject([{ taskId: result.taskId, status: 'unavailable' }]);
    const [lane] = await manager.laneStore.lanesForThread(parent.thread.id);
    await scope.close();
    await manager.destroy();
    const root = path.join(fixture.directory, '.remote-cli');
    const pointer = path.join(root, 'codex-sessions', `${lane.executorThreadId}.json`);
    await fs.mkdir(path.dirname(pointer), { recursive: true });
    await fs.writeFile(pointer, 'synthetic native continuation');
    const refs = await gitText(fixture.root, ['show-ref']);
    const cleanup = new LegacyWorkspaceCleanup(root, { mountPoints: async () => [], assertOffline: async () => undefined });
    const plan = path.join(fixture.directory, 'discard.json');
    expect((await cleanup.plan(plan)).items).toHaveLength(1);
    expect(await cleanup.discard(plan, { discardContents: true, confirmWorkersStopped: true })).toEqual({ removed: 1, errors: [] });
    const markerFile = path.join(root, 'delegation-workers', 'legacy-discarded', `${lane.id}.json`);
    const marker = JSON.parse(await fs.readFile(markerFile, 'utf8'));
    const controls = [
      { ...marker, state: 'pending' }, { ...marker, taskId: randomUUID() },
      { ...marker, workspaceFingerprint: '0'.repeat(64) }, { ...marker, directory: fixture.root },
      { ...marker, kind: 'scratch' }, { ...marker, fingerprint: 'invalid' },
      { ...marker, registration: fixture.root }, { ...marker, version: 99 },
      { ...marker, taskId: undefined, workspaceFingerprint: undefined },
    ];
    for (const control of controls) {
      await fs.writeFile(markerFile, JSON.stringify(control));
      manager = makeManager();
      expect(await manager.pendingArtifactContext(parent.thread, fixture.root)).toContain(result.taskId);
      const next = manager.begin(parent);
      expect(await next.checkArtifactCloseout()).toEqual([]);
      await next.close();
      await manager.destroy();
    }
    await fs.writeFile(markerFile, JSON.stringify(marker));
    manager = makeManager();
    expect(await manager.pendingArtifactContext(parent.thread, fixture.root)).toBe('');
    expect(await manager.begin(parent).checkArtifactCloseout()).toEqual([]);
    const inventory = await manager.workspaceManager.enumerateArtifacts();
    expect(inventory).toMatchObject({ incomplete: false, total: 1, items: [{ taskId: result.taskId,
      discarded: { fingerprint: marker.fingerprint, planHash: marker.planHash }, exitConfirmed: false, recoverable: false }] });
    expect(inventory.items[0].successful).toBeUndefined();
    expect(inventory.items[0].disposition).toBeUndefined();
    expect(await fs.readFile(pointer, 'utf8')).toBe('synthetic native continuation');
    expect(await gitText(fixture.root, ['show-ref'])).toBe(refs);
    await expect(fs.stat(workers[0].cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    const artifactFile = path.join(root, 'delegation-workspaces', 'artifacts', `${result.taskId}.json`);
    await fs.writeFile(artifactFile, '{corrupt-existing-artifact');
    expect(await manager.pendingArtifactContext(parent.thread, fixture.root)).toContain(result.taskId);
    expect((await manager.workspaceManager.enumerateArtifacts()).items[0].discarded).toBeUndefined();
    await fs.unlink(artifactFile);
  });

  it.each(['reset', 'delete'] as const)('allows %s after more than 200 settled artifacts on the same lane', async action => {
    const scope = manager.begin(parent);
    await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Read fixture' }, 'launch');
    workers[0].finish({ success: true });
    const [result] = await scope.collectPendingResults();
    await scope.close();
    const directory = path.join(fixture.directory, '.remote-cli', 'delegation-workspaces', 'artifacts');
    const artifact = JSON.parse(await fs.readFile(path.join(directory, `${result.taskId}.json`), 'utf8'));
    for (let index = 0; index < 205; index++) {
      const taskId = randomUUID();
      await fs.writeFile(path.join(directory, `${taskId}.json`), JSON.stringify({ ...artifact, taskId,
        closeout: { ...artifact.closeout, taskId } }));
    }
    expect((await manager.workspaceManager.enumerateArtifacts({ laneId: artifact.laneId, limit: 10_000 })).total).toBe(206);
    expect(await (action === 'reset' ? manager.resetWorkerLanes(parent.thread.id) : manager.deleteWorkerLanes(parent.thread.id))).toBe(1);
    expect(await fs.readdir(directory)).toHaveLength(206);
  });

  it('reports unrelated corrupt metadata without inventing a closeout task or allowing automatic deletion', async () => {
    const directory = path.join(fixture.directory, '.remote-cli', 'delegation-workspaces', 'artifacts');
    await fs.mkdir(directory, { recursive: true });
    const corrupt = path.join(directory, `${randomUUID()}.json`);
    await fs.writeFile(corrupt, '{synthetic-invalid-json');
    const context = await manager.pendingArtifactContext(parent.thread, fixture.root);
    expect(context).toContain('inventory is incomplete');
    expect(context).not.toContain('storage-inventory');
    const scope = manager.begin(parent);
    expect(await scope.checkArtifactCloseout()).toEqual([]);
    expect(parent.onNotice).not.toHaveBeenCalled();
    expect(await manager.workspaceManager.retryReclamation()).toMatchObject({ incomplete: true, attempted: 0 });
    // A real task in this turn is still checked even with global uncertainty.
    const capture = vi.spyOn(manager.workspaceManager, 'collect').mockRejectedValue(new Error('Synthetic capture failure before artifact persistence'));
    await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Missing required output', exports: ['missing.txt'] }, 'launch');
    workers[0].finish({ success: true });
    const [result] = await scope.collectPendingResults();
    capture.mockRestore();
    expect(await scope.checkArtifactCloseout()).toMatchObject([{ taskId: result.taskId, status: 'unavailable' }]);
    expect(await manager.pendingArtifactContext(parent.thread, fixture.root)).toContain(result.taskId);
    expect(await fs.readFile(corrupt, 'utf8')).toBe('{synthetic-invalid-json');
  });

  it('refuses a second owner before loading mutable lane metadata', async () => {
    await manager.reconcilePendingWorkerLanes();
    const other = makeManager();
    const acquire = vi.spyOn(other.laneStore, 'cleanupCandidates');
    await expect(other.reconcilePendingWorkerLanes()).rejects.toThrow();
    expect(acquire).not.toHaveBeenCalled();
    await other.destroy();
  });

  const pendingTask = async (exports?: string[]) => {
    const scope = manager.begin(parent);
    await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Change fixture', exports }, 'launch');
    await fs.writeFile(path.join(workers[0].cwd, 'source.txt'), 'captured change\n');
    if (exports) {
      await fs.mkdir(path.join(workers[0].cwd, 'node_modules'));
      await fs.writeFile(path.join(workers[0].cwd, exports[0]), 'required report');
    }
    workers[0].finish({ success: true });
    const [result] = await scope.collectPendingResults();
    const [lane] = await manager.laneStore.lanesForThread(parent.thread.id);
    const pointer = path.join(fixture.directory, '.remote-cli', 'codex-sessions', `${lane.executorThreadId}.json`);
    await fs.mkdir(path.dirname(pointer), { recursive: true });
    await fs.writeFile(pointer, 'synthetic native continuation');
    return { scope, result, lane, pointer };
  };

  it.each(['reset', 'delete', 'cd', 'reset-without-checkout-state'] as const)('preserves native continuation after failed reclamation during %s and retries', async action => {
    const { scope, result, lane, pointer } = await pendingTask();
    const inspection = await scope.invoke('remote_cli_integrate', { taskId: result.taskId, action: 'inspect' }, 'inspect') as { revision: string };
    await fs.writeFile(path.join(workers[0].cwd, 'source.txt'), 'changed after capture\n');
    await scope.invoke('remote_cli_integrate', { taskId: result.taskId, action: 'retain', expectedRevision: inspection.revision }, 'retain');
    await scope.close();
    if (action === 'reset-without-checkout-state') {
      const file = path.join(fixture.directory, '.remote-cli', 'delegation-workspaces', 'lanes', `${lane.id}.json`);
      const workspace = JSON.parse(await fs.readFile(file, 'utf8'));
      delete workspace.checkoutState;
      await fs.writeFile(file, JSON.stringify(workspace));
    }
    const remove = () => action === 'cd' ? manager.invalidateWorkspaceGeneration(parent.thread.id, 1)
      : action === 'delete' ? manager.deleteWorkerLanes(parent.thread.id) : manager.resetWorkerLanes(parent.thread.id);
    if (action === 'cd') expect(await remove()).toEqual({ removed: 0, failed: 1 });
    else await expect(remove()).rejects.toThrow('cleanup failed');
    expect(await manager.laneStore.lanesForThread(parent.thread.id)).toMatchObject([
      { id: lane.id, cleanupPending: true, cleanupError: expect.stringContaining('[reclamation-incomplete]') },
    ]);
    expect(await fs.readFile(pointer, 'utf8')).toBe('synthetic native continuation');
    expect((await fs.stat(workers[0].cwd)).isDirectory()).toBe(true);
    await fs.writeFile(path.join(workers[0].cwd, 'source.txt'), 'captured change\n');
    expect(await remove()).toEqual(action === 'cd' ? { removed: 1, failed: 0 } : 1);
    expect(await manager.laneStore.lanesForThread(parent.thread.id)).toEqual([]);
    await expect(fs.stat(pointer)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(workers[0].cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await manager.workspaceManager.enumerateArtifacts()).items).toMatchObject([{ taskId: result.taskId, disposition: 'retained' }]);
  });

  it('holds missing pending exports but permits native reset after restoring durable output', async () => {
    const { scope, result, pointer } = await pendingTask(['node_modules/report.txt']);
    const [exported] = await manager.workspaceManager.getArtifactExports(result.taskId);
    await scope.close();
    await fs.unlink(exported.file);
    await expect(manager.deleteWorkerLanes(parent.thread.id)).rejects.toThrow('cleanup failed');
    expect(await fs.readFile(pointer, 'utf8')).toBe('synthetic native continuation');
    expect(await manager.laneStore.lanesForThread(parent.thread.id)).toMatchObject([
      { cleanupError: expect.stringContaining('[artifact-export-unavailable]') },
    ]);
    await fs.writeFile(exported.file, 'required report');
    expect(await manager.deleteWorkerLanes(parent.thread.id)).toBe(1);
    await expect(fs.stat(pointer)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.stat(workers[0].cwd)).isDirectory()).toBe(true);
    expect((await manager.workspaceManager.enumerateArtifacts()).items).toMatchObject([{ disposition: 'pending' }]);
  });

  it('keeps safe pending artifacts while clearing native context', async () => {
    const { scope, pointer } = await pendingTask();
    await scope.close();
    const reset = new ThreadContextReset();
    await reset.begin(parent.thread.id);
    await manager.clearThreadContexts(parent.thread.id);
    await reset.complete(parent.thread.id);
    await expect(fs.stat(pointer)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await manager.laneStore.lanesForThread(parent.thread.id)).toHaveLength(1);
    expect((await fs.stat(workers[0].cwd)).isDirectory()).toBe(true);
  });

  it('preserves native context until uncertain parent application is resolved', async () => {
    const { scope, result, pointer } = await pendingTask();
    await scope.close();
    const file = path.join(fixture.directory, '.remote-cli', 'delegation-workspaces', 'artifacts', `${result.taskId}.json`);
    const original = await fs.readFile(file, 'utf8');
    const artifact = JSON.parse(original);
    await fs.writeFile(file, JSON.stringify({ ...artifact, recovery: { beforeRef: artifact.input.commit, targetRef: artifact.output } }));
    await expect(manager.deleteWorkerLanes(parent.thread.id)).rejects.toThrow('cleanup failed');
    expect(await fs.readFile(pointer, 'utf8')).toBe('synthetic native continuation');
    expect(await manager.laneStore.lanesForThread(parent.thread.id)).toMatchObject([
      { cleanupError: expect.stringContaining('[artifact-recovery-required]') },
    ]);
    await fs.writeFile(file, original);
    expect(await manager.deleteWorkerLanes(parent.thread.id)).toBe(1);
  });

  it('fences new operations after destroy without reacquiring ownership', async () => {
    const acquire = vi.spyOn(DelegationOwnership.prototype, 'acquire');
    const release = vi.spyOn(DelegationOwnership.prototype, 'release');
    await manager.reconcilePendingWorkerLanes();
    await manager.destroy();
    const count = acquire.mock.calls.length;
    const operations = [
      () => manager.reconcilePendingWorkerLanes(),
      () => manager.invalidateWorkspaceGeneration(parent.thread.id, 1),
      () => manager.resetWorkerContext(parent.thread, 'unused', 1),
      () => manager.assertThreadContextResettable(parent.thread.id),
      () => manager.clearThreadContexts(parent.thread.id),
      () => manager.resetWorkerLanes(parent.thread.id),
      () => manager.deleteWorkerLanes(parent.thread.id),
      () => manager.pendingArtifactContext(parent.thread, fixture.root),
      () => manager.cancelThread(parent.thread.id),
      () => manager.workspaceManager.unavailableLanes(),
    ];
    for (const operation of operations) await expect(operation()).rejects.toThrow('shutting down');
    expect(() => manager.begin(parent)).toThrow('shutting down');
    await manager.destroy();
    expect(acquire).toHaveBeenCalledTimes(count);
    expect(release).toHaveBeenCalledTimes(1);
    await expect(fs.stat(`${manager.laneStore.storageDirectory}.ownership`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retries a failed ownership release without reopening admission', async () => {
    await manager.reconcilePendingWorkerLanes();
    const acquire = vi.spyOn(DelegationOwnership.prototype, 'acquire');
    const lock = `${manager.laneStore.storageDirectory}.ownership`;
    const unlink = fs.unlink.bind(fs);
    const failure = vi.spyOn(fs, 'unlink').mockImplementation(async file => {
      if (file === lock) throw Object.assign(new Error('Synthetic locked ownership file'), { code: 'EBUSY' });
      return unlink(file);
    });
    await expect(manager.destroy()).rejects.toThrow('Synthetic locked');
    expect((await fs.stat(lock)).isFile()).toBe(true);
    await expect(manager.reconcilePendingWorkerLanes()).rejects.toThrow('shutting down');
    failure.mockRestore();
    await manager.destroy();
    expect(acquire).not.toHaveBeenCalled();
    await expect(fs.stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retries failed scope shutdown while retaining ownership and fencing new work', async () => {
    await manager.reconcilePendingWorkerLanes();
    const scope = manager.begin(parent);
    const close = vi.spyOn(scope, 'close').mockRejectedValueOnce(new Error('Synthetic close failure'));
    const acquire = vi.spyOn(DelegationOwnership.prototype, 'acquire');
    const release = vi.spyOn(DelegationOwnership.prototype, 'release');
    await expect(manager.destroy()).rejects.toThrow('shutdown is unresolved');
    expect(release).not.toHaveBeenCalled();
    expect(() => manager.begin(parent)).toThrow('shutting down');
    expect((await fs.stat(`${manager.laneStore.storageDirectory}.ownership`)).isFile()).toBe(true);
    await manager.destroy();
    expect(close).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(1);
    expect(acquire).not.toHaveBeenCalled();
  });

  it('drains an admitted metadata operation before releasing ownership', async () => {
    await manager.reconcilePendingWorkerLanes();
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const enumerate = manager.workspaceManager.enumerateArtifacts.bind(manager.workspaceManager);
    vi.spyOn(manager.workspaceManager, 'enumerateArtifacts').mockImplementation(async options => {
      entered(); await gate; return enumerate(options);
    });
    const release = vi.spyOn(DelegationOwnership.prototype, 'release');
    const pending = manager.pendingArtifactContext(parent.thread, fixture.root);
    await started;
    const shutdown = manager.destroy();
    await Promise.resolve();
    expect(release).not.toHaveBeenCalled();
    resume();
    await pending;
    await shutdown;
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('allows active finalization to reclaim under the existing owner while shutdown drains', async () => {
    const scope = manager.begin(parent);
    await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Read fixture' }, 'launch');
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const collect = manager.workspaceManager.collect.bind(manager.workspaceManager);
    vi.spyOn(manager.workspaceManager, 'collect').mockImplementation(async (...args) => {
      entered(); await gate; return collect(...args);
    });
    workers[0].finish({ success: true });
    await started;
    const acquire = vi.spyOn(DelegationOwnership.prototype, 'acquire');
    const shutdown = manager.destroy();
    await expect(manager.pendingArtifactContext(parent.thread, fixture.root)).rejects.toThrow('shutting down');
    resume();
    await shutdown;
    await expect(scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Too late' }, 'late')).rejects.toThrow();
    await expect(scope.checkArtifactCloseout()).rejects.toThrow('cancelled');
    await scope.close();
    expect(acquire).not.toHaveBeenCalled();
    await expect(fs.stat(workers[0].cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(`${manager.laneStore.storageDirectory}.ownership`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
