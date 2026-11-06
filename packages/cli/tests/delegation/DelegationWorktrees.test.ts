import { supportsFileSymlinks } from './symlinkFixture';
import { DelegatedWorkspaceManager } from '../../src/delegation/DelegatedWorkspaceManager';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { setTimeout as realDelay } from 'node:timers/promises';
import { DELEGATION_LIMITS, DelegationManager, type DelegationParent, type DelegatedTaskResult } from '../../src/delegation/DelegationManager';
import { configuredExecutionMetadata } from '../../src/executor/ExecutionMetadata';
import { BackendRegistry } from '../../src/delegation/BackendRegistry';
import { DelegationOwnership } from '../../src/delegation/DelegationOwnership';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import type { ExecuteResult, IExecutor } from '../../src/executor/IExecutor';
import { gitText, runGit } from '../../src/delegation/GitCheckpoint';
import * as gitCommands from '../../src/delegation/GitCheckpoint';
import { gitFixture } from './gitFixture';
import { isTerminalTaskState, type DelegatedTaskRecord } from '../../src/delegation/DelegationStore';

vi.mock('../../src/delegation/OwnershipRuntime', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/delegation/OwnershipRuntime')>();
  const { syntheticOwnershipRuntime } = await import('./syntheticOwnershipRuntime');
  return syntheticOwnershipRuntime(actual);
});

function controlledWorker(cwd: string, onExecute = () => {}) {
  let finish!: (result: ExecuteResult) => void;
  const completed = new Promise<ExecuteResult>(resolve => { finish = resolve; });
  const executor: IExecutor = { execute: vi.fn(() => { onExecute(); return completed; }), abort: vi.fn(async () => true),
    destroy: vi.fn(async () => undefined), waitForExit: vi.fn(async () => undefined), waitForManagedProcessGroupExit: vi.fn(async () => undefined),
    resetContext: vi.fn(), getCurrentWorkingDirectory: () => cwd, setWorkingDirectory: vi.fn() };
  return { executor, cwd, finish };
}

describe('Git-aware delegated scheduling and lane reuse', { timeout: 30_000 }, () => {
  let fixture: Awaited<ReturnType<typeof gitFixture>>;
  let manager: DelegationManager;
  let parent: DelegationParent;
  let workers: ReturnType<typeof controlledWorker>[];
  let factory: ReturnType<typeof vi.fn>;
  let pendingCalls: Set<Promise<unknown>>;
  let phaseListeners: Set<() => void>;
  let terminalRecords: Map<string, DelegatedTaskRecord>;
  let observedStores: WeakSet<DelegationManager['store']>;
  let draining: boolean;
  let phaseAdmissionClosed: boolean;
  const notifyPhase = () => { for (const listener of phaseListeners) listener(); };
  beforeEach(async () => {
    fixture = await gitFixture();
    vi.spyOn(os, 'homedir').mockReturnValue(fixture.directory);
    vi.stubEnv('HOME', fixture.directory);
    vi.stubEnv('USERPROFILE', fixture.directory);
    workers = [];
    pendingCalls = new Set();
    phaseListeners = new Set(); terminalRecords = new Map(); observedStores = new WeakSet(); draining = false; phaseAdmissionClosed = false;
    factory = vi.fn((guard: DirectoryGuard, _config, cwd: string) => {
      expect(guard.resolveWorkingDirectory(cwd)).toBe(cwd);
      const worker = controlledWorker(cwd, notifyPhase); workers.push(worker);
      if (draining) worker.finish({ success: false, error: 'Synthetic fixture teardown' });
      return worker.executor;
    });
    manager = new DelegationManager(new DirectoryGuard([fixture.directory]), factory as any,
      new BackendRegistry(async () => 'fixture 1.0'), undefined, undefined, undefined, undefined,
      new DelegatedWorkspaceManager(undefined, true));
    parent = { thread: { id: 'fixture-owner', name: 'default', workingDirectory: fixture.root,
      sessionId: null, createdAt: 0, lastActiveAt: 0 }, cwd: fixture.root, messageId: 'parent',
    backend: 'claude', config: { type: 'auto' }, onToolUse: vi.fn(), onToolResult: vi.fn(), onNotice: vi.fn(),
    onProgress: vi.fn(() => true), onApproval: vi.fn(() => true), onApprovalResolved: vi.fn() };
  });
  const settleFixture = async (): Promise<void> => {
    // Settle controlled execution even when an assertion or phase deadline fired.
    // Keep mocks, home and ownership intact until all admitted work has exited.
    draining = true; notifyPhase();
    workers.forEach(worker => worker.finish({ success: false, error: 'Synthetic fixture teardown' }));
    const shutdown = manager.destroy();
    await Promise.allSettled([...pendingCalls, shutdown]);
    await shutdown;
  };
  // The native Windows pooling failure also exceeded the ten-second hook.
  // Keep a separate bounded window while tracked Git calls settle under ownership.
  afterEach(async () => {
    const ownedFixture = fixture;
    let released = false;
    try {
      await settleFixture();
      released = true;
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      if (released) await fs.rm(ownedFixture.directory, { recursive: true, force: true });
    }
  }, 60_000);
  const trackCall = <T>(call: Promise<T>): Promise<T> => {
    pendingCalls.add(call);
    void call.then(() => pendingCalls.delete(call), () => pendingCalls.delete(call));
    return call;
  };
  const start = (scope: ReturnType<DelegationManager['begin']>, id: string, backend = 'codex') =>
    trackCall(scope.invoke('remote_cli_delegate', { backend, objective: `Independent task ${id}` }, id) as Promise<DelegatedTaskResult>);
  const result = (scope: ReturnType<DelegationManager['begin']>, taskId: string, id: string) =>
    trackCall(scope.invoke('remote_cli_result', { taskId, waitSeconds: 25 }, id) as Promise<DelegatedTaskResult>);
  const gitPhase = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
    if (draining || phaseAdmissionClosed) throw new Error('Fixture is draining; no new Git phases may start');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([trackCall(Promise.resolve().then(() => {
        if (draining || phaseAdmissionClosed) throw new Error('Fixture is draining; no new Git phases may start');
        return action();
      })), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          phaseAdmissionClosed = true;
          reject(new Error(`Git lifecycle phase exceeded 30 seconds: ${name}`));
        }, 30_000);
      })]);
    } finally { clearTimeout(timer); }
  };

  const retainAndCheckCloseout = async (
    scope: Pick<ReturnType<DelegationManager['begin']>, 'invoke' | 'checkArtifactCloseout'>, taskId: string,
  ) => {
    const inspection: any = await gitPhase('inspect the changed artifact', () =>
      scope.invoke('remote_cli_integrate', { taskId }, 'inspect'));
    await gitPhase('retain and reclaim the changed artifact', () => scope.invoke('remote_cli_integrate', {
      taskId, action: 'retain', expectedRevision: inspection.revision,
    }, 'retain'));
    expect(await gitPhase('verify artifact closeout', () => scope.checkArtifactCloseout())).toEqual([]);
  };

  it('gives artifact inspection, retention and closeout independent bounded phases', async () => {
    const releases: (() => void)[] = [];
    const invoke = vi.fn(async () => {
      await new Promise<void>(resolve => { releases.push(resolve); });
      return { revision: 'synthetic-revision' };
    });
    const checkArtifactCloseout = vi.fn(async () => {
      await new Promise<void>(resolve => { releases.push(resolve); });
      return [];
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const running = retainAndCheckCloseout({ invoke, checkArtifactCloseout }, 'synthetic-task');
    const outcome = running.then(() => undefined, error => error);
    try {
      // Each operation is below 30 seconds, but their sum is above it.
      for (let phase = 0; phase < 3; phase++) {
        await vi.advanceTimersByTimeAsync(0);
        expect(releases).toHaveLength(phase + 1);
        await vi.advanceTimersByTimeAsync(11_000);
        releases[phase]();
      }
      expect(await outcome).toBeUndefined();
      expect(invoke).toHaveBeenNthCalledWith(2, 'remote_cli_integrate', {
        taskId: 'synthetic-task', action: 'retain', expectedRevision: 'synthetic-revision',
      }, 'retain');
      expect(checkArtifactCloseout).toHaveBeenCalledOnce();
      expect(pendingCalls.size).toBe(0);
    } finally {
      vi.useRealTimers(); releases.forEach(release => release());
      await Promise.allSettled([running, ...pendingCalls]);
    }
  });

  it.each(['resolve', 'reject'] as const)('drains a timed-out artifact operation that later %ss without admitting closeout', async completion => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const invoke = vi.fn(async () => {
      await gate;
      if (completion === 'reject') throw new Error('Synthetic late inspection failure');
      return { revision: 'synthetic-revision' };
    });
    const checkArtifactCloseout = vi.fn(async () => []);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const running = retainAndCheckCloseout({ invoke, checkArtifactCloseout }, 'synthetic-task');
    const outcome = running.then(() => undefined, error => error);
    let settling: Promise<void> | undefined;
    try {
      await vi.advanceTimersByTimeAsync(30_001);
      expect(await outcome).toBeInstanceOf(Error);
      expect(pendingCalls.size).toBe(1);
      const afterTimeout = vi.fn(async () => undefined);
      await expect(gitPhase('after timeout', afterTimeout)).rejects.toThrow('Fixture is draining');
      expect(afterTimeout).not.toHaveBeenCalled();
      vi.useRealTimers();
      let settled = false;
      settling = settleFixture().then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);
      const latePhase = vi.fn(async () => undefined);
      await expect(gitPhase('late admission', latePhase)).rejects.toThrow('Fixture is draining');
      expect(latePhase).not.toHaveBeenCalled();
      expect(await fs.stat(fixture.directory)).toBeDefined();
      release(); await settling;
      expect(invoke).toHaveBeenCalledOnce();
      expect(checkArtifactCloseout).not.toHaveBeenCalled();
      expect(pendingCalls.size).toBe(0);
    } finally {
      vi.useRealTimers(); release();
      await Promise.allSettled([running, ...(settling ? [settling] : []), ...pendingCalls]);
    }
  });

  it('does not enter a scheduled Git phase once teardown has begun', async () => {
    const action = vi.fn(async () => undefined);
    const scheduled = gitPhase('scheduled before teardown', action);
    const outcome = scheduled.catch(error => error);
    const shutdown = settleFixture();
    try {
      expect(await outcome).toMatchObject({ message: expect.stringContaining('Fixture is draining') });
      expect(action).not.toHaveBeenCalled();
    } finally { await Promise.allSettled([scheduled, shutdown]); }
  });

  const observeTaskStates = () => {
    if (!observedStores.has(manager.store)) {
      observedStores.add(manager.store);
      const write = manager.store.write.bind(manager.store);
      vi.spyOn(manager.store, 'write').mockImplementation(record => write(record).finally(() => {
        if (isTerminalTaskState(record.state)) terminalRecords.set(record.id, { ...record });
        notifyPhase();
      }));
    }
  };
  const waitForExecution = async (scope: ReturnType<DelegationManager['begin']>, id: string, accepted: DelegatedTaskResult) => {
    const fail = (state: string, error?: string) => new Error(`Fixture worker ${id} ended before execution: ${state}${error ? `: ${error}` : ''}`);
    if (isTerminalTaskState(accepted.state)) throw fail(accepted.state, accepted.error);
    let listener!: () => void;
    try {
      await new Promise<void>((resolve, reject) => {
        listener = () => {
          if (draining) { reject(new Error('Fixture is draining before worker execution.')); return; }
          const terminal = terminalRecords.get(accepted.taskId);
          if (terminal) { reject(fail(terminal.state, terminal.error)); return; }
          // The exact synthetic objective identifies dispatch, including concurrent lanes.
          if (workers.some(worker => vi.mocked(worker.executor.execute).mock.calls.some(([prompt]) =>
            prompt.endsWith(`\n\nIndependent task ${id}`)))) resolve();
        };
        phaseListeners.add(listener); listener();
      });
    } finally { phaseListeners.delete(listener); }
    const current = await trackCall(scope.invoke('remote_cli_result', { taskId: accepted.taskId, waitSeconds: 0 },
      `${id}-execution-phase`) as Promise<DelegatedTaskResult>);
    if (current.state !== 'running') throw fail(current.state, current.error);
    return current;
  };
  // Acceptance is intentionally bounded and may return queued before the factory.
  // Queue/admission tests keep start(); existing single-window dispatch tests keep this helper.
  const startExecuting = (scope: ReturnType<DelegationManager['begin']>, id: string, backend = 'codex') =>
    gitPhase(`dispatch ${id}`, async () => {
      observeTaskStates();
      return waitForExecution(scope, id, await start(scope, id, backend));
    });

  // Slow multi-cohort fixtures give admission and eventual execution separate
  // 30-second boundaries, including when the tool response returns queued.
  const startInPhases = async (scope: ReturnType<DelegationManager['begin']>, id: string, backend = 'codex') => {
    observeTaskStates();
    const accepted = await gitPhase(`accept ${id}`, () => start(scope, id, backend));
    return gitPhase(`execute ${id}`, () => waitForExecution(scope, id, accepted));
  };
  const collectFinished = (
    scope: Pick<ReturnType<DelegationManager['begin']>, 'collectPendingResults' | 'invoke'>, taskId: string, id: string,
  ) => gitPhase(`finish collection ${id}`, async () => {
    // A 25-second result poll can return running. Only task completion establishes
    // an idle cohort and permits the fixture to change coordinator input.
    const completed = (await scope.collectPendingResults()).find(task => task.taskId === taskId);
    if (!completed || !isTerminalTaskState(completed.state)) throw new Error(`Fixture task ${id} did not finish collection`);
    if (draining || phaseAdmissionClosed) throw new Error('Fixture is draining; no new result reads may start');
    return trackCall(scope.invoke('remote_cli_result', { taskId, waitSeconds: 0 }, id) as Promise<DelegatedTaskResult>);
  });

  const finishAndReclaim = async (
    scope: ReturnType<DelegationManager['begin']>, taskId: string, finish: () => void,
  ) => {
    if (draining || phaseAdmissionClosed) throw new Error('Fixture is draining; no new finalization phases may start');
    type Entry = { operation: Promise<unknown> };
    let captured!: (entry: Entry) => void, reclaimed!: (entry: Entry) => void;
    const captureEntry = new Promise<Entry>(resolve => { captured = resolve; });
    const reclaimEntry = new Promise<Entry>(resolve => { reclaimed = resolve; });
    const collect = manager.workspaceManager.collect.bind(manager.workspaceManager);
    const reclaim = manager.workspaceManager.reclaim.bind(manager.workspaceManager);
    const captureSpy = vi.spyOn(manager.workspaceManager, 'collect').mockImplementation((workspace, ...args) => {
      const operation = collect(workspace, ...args);
      if (workspace.taskId === taskId) captured({ operation: trackCall(operation) });
      // Return the original promise: a fixture deadline must not let runtime
      // finalization release ownership while its Git operation is still running.
      return operation;
    });
    const reclaimSpy = vi.spyOn(manager.workspaceManager, 'reclaim').mockImplementation((id, ...args) => {
      const operation = reclaim(id, ...args);
      if (id === taskId) reclaimed({ operation: trackCall(operation) });
      return operation;
    });
    const completed = trackCall(scope.collectPendingResults());
    void completed.catch(() => undefined);
    const awaitOperation = (name: string, entry: Promise<Entry>) => gitPhase(name, async () => {
      const entered = await Promise.race([entry, completed.then(results => {
        const task = results.find(result => result.taskId === taskId);
        throw new Error(`Fixture task ended before ${name}: ${JSON.stringify(task)}`);
      })]);
      await entered.operation;
    });
    try {
      finish();
      await awaitOperation('capture the reused pooled worker artifact', captureEntry);
      await awaitOperation('reclaim the reused pooled checkout', reclaimEntry);
      return await gitPhase('finish the reused pooled task metadata', () => completed);
    } finally {
      captureSpy.mockRestore(); reclaimSpy.mockRestore();
    }
  };

  it('bounds artifact capture and reclamation separately without replacing their runtime promises', async () => {
    const scope = manager.begin(parent);
    const task = await startInPhases(scope, 'separate-finalization');
    let enteredCapture!: () => void, releaseCapture!: () => void, enteredReclaim!: () => void, releaseReclaim!: () => void;
    const captureEntered = new Promise<void>(resolve => { enteredCapture = resolve; });
    const captureGate = new Promise<void>(resolve => { releaseCapture = resolve; });
    const reclaimEntered = new Promise<void>(resolve => { enteredReclaim = resolve; });
    const reclaimGate = new Promise<void>(resolve => { releaseReclaim = resolve; });
    // Collection verifies once; reclamation verifies again before recording/removing
    // the checkout. Hold only these entries, never advance timers during real Git I/O.
    const workspaceManager = manager.workspaceManager as any;
    const verify = workspaceManager.verifyCheckout.bind(workspaceManager);
    let checks = 0;
    vi.spyOn(workspaceManager, 'verifyCheckout').mockImplementation(async (...args) => {
      if (++checks === 1) { enteredCapture(); await captureGate; }
      else if (checks === 2) { enteredReclaim(); await reclaimGate; }
      return verify(...args);
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let settled = false;
    const finishing = finishAndReclaim(scope, task.taskId, () => workers[0].finish({ success: true }));
    const outcome = finishing.then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
    const endedBeforeEntry = () => { throw new Error('Task finalization ended before the verification entry signal'); };
    try {
      await Promise.race([captureEntered, finishing.then(endedBeforeEntry)]);
      await vi.advanceTimersByTimeAsync(16_000); releaseCapture();
      await Promise.race([reclaimEntered, finishing.then(endedBeforeEntry)]);
      await vi.advanceTimersByTimeAsync(16_000);
      expect(settled).toBe(false);
      expect((await fs.lstat(`${manager.laneStore.storageDirectory}.ownership`)).isFile()).toBe(true);
      vi.useRealTimers(); releaseReclaim();
      const results = await gitPhase('complete real reclamation after the controlled holds', () => finishing);
      expect(results.find(result => result.taskId === task.taskId)).toMatchObject({ state: 'succeeded', artifact: { disposition: 'applied' } });
      await expect(fs.lstat(workers[0].cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      vi.useRealTimers(); releaseCapture(); releaseReclaim();
      await Promise.allSettled([outcome, settleFixture()]);
    }
    expect(pendingCalls.size).toBe(0);
  }, 6 * 30_000 + 5_000);

  it.each(['resolve', 'reject'] as const)('drains a timed-out native collection that later %ss before fixture removal', async completion => {
    const scope = manager.begin(parent);
    const task = await startInPhases(scope, 'timed-finalization');
    const ownership = `${manager.laneStore.storageDirectory}.ownership`;
    const marker = path.join(fixture.directory, 'late-capture.txt');
    let entered!: () => void, release!: () => void;
    const verifying = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const workspaceManager = manager.workspaceManager as any;
    const verify = workspaceManager.verifyCheckout.bind(workspaceManager);
    vi.spyOn(workspaceManager, 'verifyCheckout').mockImplementationOnce(async (...args) => {
      entered(); await gate;
      expect((await fs.lstat(ownership)).isFile()).toBe(true);
      await fs.writeFile(marker, 'capture settled under fixture ownership');
      if (completion === 'reject') throw new Error('Synthetic late capture rejection');
      return verify(...args);
    });
    const releaseOwnership = vi.spyOn(DelegationOwnership.prototype, 'release');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const finishing = finishAndReclaim(scope, task.taskId, () => workers[0].finish({ success: true }));
    const outcome = finishing.catch(error => error);
    let shutdown: Promise<void> | undefined;
    try {
      await Promise.race([verifying, finishing.then(() => { throw new Error('Task ended before capture verification'); })]);
      await vi.advanceTimersByTimeAsync(30_001);
      expect(await outcome).toMatchObject({ message: 'Git lifecycle phase exceeded 30 seconds: capture the reused pooled worker artifact' });
      expect(pendingCalls.size).toBeGreaterThan(0);
      await expect(startInPhases(scope, 'must-not-start')).rejects.toThrow('Fixture is draining');
      const lateFinish = vi.fn();
      await expect(finishAndReclaim(scope, task.taskId, lateFinish)).rejects.toThrow('Fixture is draining');
      expect(lateFinish).not.toHaveBeenCalled();
      expect(workers).toHaveLength(1);
      vi.useRealTimers();
      let drained = false;
      shutdown = settleFixture().then(() => { drained = true; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(drained).toBe(false);
      expect(releaseOwnership).not.toHaveBeenCalled();
      expect((await fs.stat(fixture.directory)).isDirectory()).toBe(true);
      release(); await shutdown;
      expect(await fs.readFile(marker, 'utf8')).toBe('capture settled under fixture ownership');
      expect(releaseOwnership).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers(); release();
      await Promise.allSettled([finishing, shutdown ?? settleFixture()]);
    }
    expect(pendingCalls.size).toBe(0);
  }, 6 * 30_000 + 5_000);

  it('bounds acceptance and execution separately across successive input and checkout preparation', async () => {
    const scope = manager.begin(parent);
    let enteredInput!: () => void, releaseInput!: () => void, enteredCheckout!: () => void, releaseCheckout!: () => void;
    const inputEntered = new Promise<void>(resolve => { enteredInput = resolve; });
    const inputGate = new Promise<void>(resolve => { releaseInput = resolve; });
    const checkoutEntered = new Promise<void>(resolve => { enteredCheckout = resolve; });
    const checkoutGate = new Promise<void>(resolve => { releaseCheckout = resolve; });
    const baseline = manager.workspaceManager.baseline.bind(manager.workspaceManager);
    const prepare = manager.workspaceManager.prepare.bind(manager.workspaceManager);
    vi.spyOn(manager.workspaceManager, 'baseline').mockImplementationOnce(async (...args) => {
      enteredInput(); await inputGate; return baseline(...args);
    });
    vi.spyOn(manager.workspaceManager, 'prepare').mockImplementationOnce(async (...args) => {
      enteredCheckout(); await checkoutGate; return prepare(...args);
    });
    const invoke = scope.invoke.bind(scope);
    let accepted: DelegatedTaskResult | undefined;
    vi.spyOn(scope, 'invoke').mockImplementation(async (...args) => {
      const value = await invoke(...args);
      if (args[0] === 'remote_cli_delegate') accepted = value as DelegatedTaskResult;
      return value;
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let settled = false;
    const starting = startInPhases(scope, 'successive-preparation');
    const outcome = starting.then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
    const endedBeforeEntry = () => { throw new Error('Fixture dispatch ended before its preparation phase entered'); };
    try {
      await Promise.race([inputEntered, starting.then(endedBeforeEntry)]);
      await vi.advanceTimersByTimeAsync(16_000);
      releaseInput();
      await Promise.race([checkoutEntered, starting.then(endedBeforeEntry)]);
      await vi.advanceTimersByTimeAsync(16_000);
      // Each held operation is below 30 seconds, while their sum exceeds it.
      expect(accepted).toMatchObject({ state: 'queued' });
      expect(settled).toBe(false);
      expect(factory).not.toHaveBeenCalled();
      vi.useRealTimers(); releaseCheckout();
      // Restore wall-clock bounds before allowing any remaining real Git work.
      const started = await gitPhase('complete the controlled checkout and dispatch', () => starting);
      expect(started.state).toBe('running');
      workers[0].finish({ success: true });
      expect(await collectFinished(scope, started.taskId, 'successive-result')).toMatchObject({ state: 'succeeded' });
    } finally {
      vi.useRealTimers(); releaseInput(); releaseCheckout();
      await Promise.allSettled([outcome, settleFixture()]);
    }
    expect(pendingCalls.size).toBe(0);
    expect(phaseListeners.size).toBe(0);
  }, 4 * 30_000 + 5_000);

  it.each(['completed', 'late resolution', 'late rejection'] as const)(
    'waits past a bounded result poll and drains collection before fixture removal (%s)', async completion => {
      const scope = manager.begin(parent);
      const task = await startInPhases(scope, 'held-collection');
      const invoke = vi.spyOn(scope, 'invoke');
      const ownership = `${manager.laneStore.storageDirectory}.ownership`;
      const marker = path.join(fixture.directory, 'collection-drained.txt');
      const releaseOwnership = vi.spyOn(DelegationOwnership.prototype, 'release');
      let entered!: () => void, release!: () => void;
      const enteredCollection = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const collect = manager.workspaceManager.collect.bind(manager.workspaceManager);
      vi.spyOn(manager.workspaceManager, 'collect').mockImplementationOnce(async (...args) => {
        entered(); await gate;
        expect((await fs.lstat(ownership)).isFile()).toBe(true);
        await fs.writeFile(marker, 'collection settled under fixture ownership');
        if (completion === 'late rejection') throw new Error('Synthetic late collection failure');
        return collect(...args);
      });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      workers[0].finish({ success: true });
      const polling = result(scope, task.taskId, 'bounded-poll');
      let settled = false;
      const collecting = collectFinished(scope, task.taskId, 'terminal-result');
      const outcome = collecting.then(value => { settled = true; return { value, error: undefined }; },
        error => { settled = true; return { value: undefined, error }; });
      let shutdown: Promise<void> | undefined;
      try {
        await Promise.race([enteredCollection, collecting.then(() => { throw new Error('Collection ended before its entry signal'); })]);
        await vi.advanceTimersByTimeAsync(25_001);
        expect(await polling).toMatchObject({ state: 'running' });
        expect(settled).toBe(false);
        expect(await fs.readFile(path.join(fixture.root, 'source.txt'), 'utf8')).toContain('first');
        if (completion === 'completed') {
          vi.useRealTimers(); release();
          expect(await gitPhase('complete the held terminal collection', () => collecting)).toMatchObject({ state: 'succeeded' });
        } else {
          await vi.advanceTimersByTimeAsync(5_000);
          expect((await outcome).error).toMatchObject({ message: 'Git lifecycle phase exceeded 30 seconds: finish collection terminal-result' });
          await expect(startInPhases(scope, 'must-not-start')).rejects.toThrow('Fixture is draining');
          expect(workers).toHaveLength(1);
          expect(pendingCalls.size).toBeGreaterThan(0);
          vi.useRealTimers();
          let drained = false;
          shutdown = settleFixture().then(() => { drained = true; });
          await new Promise<void>(resolve => setImmediate(resolve));
          expect(drained).toBe(false);
          expect(releaseOwnership).not.toHaveBeenCalled();
          expect((await fs.lstat(ownership)).isFile()).toBe(true);
          expect((await fs.stat(fixture.directory)).isDirectory()).toBe(true);
          release(); await shutdown;
          expect(await fs.readFile(marker, 'utf8')).toBe('collection settled under fixture ownership');
          expect(releaseOwnership).toHaveBeenCalledOnce();
          expect(invoke.mock.calls.some(([, , id]) => id === 'terminal-result')).toBe(false);
        }
      } finally {
        vi.useRealTimers(); release();
        await Promise.allSettled([polling, collecting, shutdown ?? settleFixture()]);
      }
      expect(pendingCalls.size).toBe(0);
    }, 4 * 30_000 + 5_000);

  it.each(['execute', 'setup failure', 'teardown'] as const)(
    'handles accepted-but-unprepared workers through explicit %s phases', async outcome => {
      const scope = manager.begin(parent);
      let entered!: () => void, release!: () => void, accepted!: (task: DelegatedTaskResult) => void;
      const preparing = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const acceptance = new Promise<DelegatedTaskResult>(resolve => { accepted = resolve; });
      const prepare = manager.workspaceManager.prepare.bind(manager.workspaceManager);
      vi.spyOn(manager.workspaceManager, 'prepare').mockImplementation(async (...args) => {
        entered(); await gate;
        if (outcome === 'setup failure') throw new Error('Synthetic gated preparation failure');
        return prepare(...args);
      });
      const invoke = scope.invoke.bind(scope);
      vi.spyOn(scope, 'invoke').mockImplementation(async (...args) => {
        const value = await invoke(...args);
        if (args[0] === 'remote_cli_delegate') accepted(value as DelegatedTaskResult);
        return value;
      });
      // Only advance the tool-response timer once real setup has entered its held phase.
      // Native startup has not begun; no filesystem operation is simulated by the clock.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let settled = false;
      const starting = startExecuting(scope, 'held-start');
      const observed = starting.then(value => { settled = true; return { value, error: undefined }; },
        error => { settled = true; return { value: undefined, error }; });
      let shuttingDown: Promise<void> | undefined;
      try {
        await preparing;
        await vi.advanceTimersByTimeAsync(DELEGATION_LIMITS.toolResponseWaitMs + 1);
        const admitted = await acceptance;
        expect(admitted).toMatchObject({ state: 'queued', statusDetail: expect.stringContaining('preparation') });
        expect(workers).toHaveLength(0); expect(factory).not.toHaveBeenCalled(); expect(settled).toBe(false);
        vi.useRealTimers();
        if (outcome === 'teardown') shuttingDown = settleFixture();
        release();
        const completion = await observed;
        if (outcome === 'execute') {
          expect(completion.value).toMatchObject({ taskId: admitted.taskId, state: 'running' });
          expect(workers[0].executor.execute).toHaveBeenCalledOnce();
          workers[0].finish({ success: true });
          expect(await result(scope, admitted.taskId, 'held-result')).toMatchObject({ state: 'succeeded' });
        } else {
          expect(completion.error).toBeInstanceOf(Error);
          expect(completion.error.message).toContain(outcome === 'teardown' ? 'Fixture is draining' : 'Synthetic gated preparation failure');
          expect(factory).not.toHaveBeenCalled();
        }
      } finally {
        vi.useRealTimers(); release();
        await Promise.allSettled([starting, ...(shuttingDown ? [shuttingDown] : [])]);
        workers.forEach(worker => worker.finish({ success: false, error: 'Synthetic fixture completion' }));
      }
      expect(phaseListeners.size).toBe(0);
    });

  it.skipIf(!supportsFileSymlinks)('warns a managed worker and its result about direct shared-data edits', async () => {
    await manager.destroy();
    const target = path.join(fixture.directory, 'shared.txt'); await fs.writeFile(target, 'synthetic shared bytes\n');
    await runGit(fixture.root, ['config', 'core.symlinks', 'true']);
    await fs.symlink(path.relative(fixture.root, target), path.join(fixture.root, 'shared-link'), 'file');
    manager = new DelegationManager(new DirectoryGuard([fixture.directory]), factory as any,
      new BackendRegistry(async () => 'fixture 1.0'), undefined, undefined, undefined, undefined,
      new DelegatedWorkspaceManager(undefined, true));
    const scope = manager.begin(parent);
    const task = await startExecuting(scope, 'shared-warning');
    expect(task.state).toBe('running');
    const prompt = vi.mocked(workers[0].executor.execute).mock.calls[0][0];
    expect(prompt).toContain('Shared external links: "shared-link"');
    expect(prompt).toContain('NOT captured, merged, reverted, or backed up');
    workers[0].finish({ success: true, output: 'Synthetic result' });
    const completed = await result(scope, task.taskId, 'shared-result');
    expect(completed.artifact?.sharingWarning).toContain('shared original data');
    await scope.close();
    expect(await fs.readFile(target, 'utf8')).toBe('synthetic shared bytes\n');
  });

  it('settles an unfinished worker and result call after an assertion failure before releasing fixture ownership', async () => {
    const scope = manager.begin(parent);
    const first = await startExecuting(scope, 'unfinished');
    expect(first.state).toBe('running');
    const collecting = result(scope, first.taskId, 'pending-result');
    expect(pendingCalls.has(collecting)).toBe(true);
    const failure = new Error('Synthetic assertion failure with an unfinished worker');
    const exercise = async () => {
      try { throw failure; }
      finally { await settleFixture(); }
    };
    await expect(exercise()).rejects.toBe(failure);
    const completed = await collecting;
    expect(['succeeded', 'failed', 'cancelled']).toContain(completed.state);
    expect(pendingCalls.size).toBe(0);
    const ownership = path.join(fixture.directory, '.remote-cli', 'delegation-workers.ownership');
    await expect(fs.lstat(ownership)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.stat(fixture.directory)).isDirectory()).toBe(true);
  });

  // Acceptance, bounded dispatch polling and real Git collection have cumulative costs on Windows.
  it('keeps concurrent worker metadata independent while bounding combined retained results', async () => {
    factory.mockImplementation((_guard, configuration, cwd) => {
      const worker = controlledWorker(cwd);
      worker.executor.getExecutionMetadata = vi.fn(() => configuredExecutionMetadata(`${configuration.type}-selected`, 'low'));
      workers.push(worker);
      return worker.executor;
    });
    const scope = manager.begin(parent);
    const backends = ['codex', 'agy', 'dsh'];
    let tasks = await Promise.all(backends.map(backend => start(scope, backend, backend)));
    // A bounded acceptance response can precede real Git preparation and dispatch.
    const dispatchDeadline = Date.now() + 45_000;
    for (let poll = 0; poll < 45 && !tasks.every(task => task.state === 'running'); poll++) {
      if (Date.now() >= dispatchDeadline) break;
      tasks = await Promise.all(tasks.map(task => trackCall(scope.invoke('remote_cli_result',
        { taskId: task.taskId, waitSeconds: 0 }, `metadata-dispatch-${task.taskId}-${poll}`) as Promise<DelegatedTaskResult>)));
      const terminal = tasks.find(task => task.state !== 'queued' && task.state !== 'running');
      if (terminal) throw new Error(`Worker ended before metadata dispatch: ${JSON.stringify(terminal)}`);
      if (!tasks.every(task => task.state === 'running')) await realDelay(1000);
    }
    expect(tasks.every(task => task.state === 'running'), `Dispatch snapshots: ${JSON.stringify(tasks)}`).toBe(true);
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
  }, 120_000);

  // Six real-Git phases have independent deadlines. Do not make their combined
  // filesystem/process cost compete for a single 30-second unit-test budget.
  it.each(['mixed', 'same-backend'] as const)('runs five isolated %s tasks concurrently and keeps a sixth queued', async mode => {
    const scope = manager.begin(parent);
    const phases: { name: string; elapsedMs: number }[] = [];
    const phase = async <T>(name: string, action: () => Promise<T>, timeoutMs = 30_000): Promise<T> => {
      const began = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([trackCall(Promise.resolve().then(action)), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(
            `Git scheduling phase timed out: ${name}; workers=${workers.length}; completed=${JSON.stringify(phases)}`,
          )), timeoutMs);
        })]);
      } finally {
        clearTimeout(timer);
        phases.push({ name, elapsedMs: Date.now() - began });
      }
    };
    const tasks: DelegatedTaskResult[] = [];
    const backends = mode === 'mixed' ? ['codex', 'agy', 'dsh', 'kimi', 'agy', 'codex'] : Array(6).fill(parent.backend);
    await phase('prepare five workers and queue the sixth', async () => {
      expect(await scope.invoke('remote_cli_list_backends', {}, 'discover')).toMatchObject({
        maxConcurrentChildren: 5, scheduling: 'isolated-worktrees', workspace: fixture.root });
      for (const [index, backend] of backends.entries()) {
        tasks.push(await start(scope, `task-${index}`, backend));
      }
    });
    const first = tasks[0];
    expect(tasks.map(task => task.state)).toEqual(['running', 'running', 'running', 'running', 'running', 'queued']);
    expect(new Set(workers.map(worker => worker.cwd)).size).toBe(5);
    expect(new Set(factory.mock.calls.map(call => call[3])).size).toBe(5);
    expect(factory.mock.calls.every(call => call[3] !== parent.thread.id && call[6].delegationWorker)).toBe(true);
    expect(workers.every(worker => worker.cwd !== fixture.root)).toBe(true);
    await fs.writeFile(path.join(workers[0].cwd, 'source.txt'), 'first worker only\n');
    expect(await fs.readFile(path.join(workers[1].cwd, 'source.txt'), 'utf8')).toContain('first\nsecond');
    expect(await fs.readFile(path.join(fixture.root, 'source.txt'), 'utf8')).toContain('first\nsecond');
    await expect(scope.invoke('remote_cli_integrate', { taskId: first.taskId }, 'too-soon')).rejects.toThrow('finish');
    workers[0].finish({ success: true, output: 'Changed source' });
    await phase('collect the first result and dispatch the queued worker', async () => {
      expect(await result(scope, first.taskId, 'first-result')).toMatchObject({ artifact: { disposition: 'pending' } });
      await vi.waitFor(() => expect(workers).toHaveLength(6), { timeout: 10_000 });
    });
    expect(workers[0].executor.waitForExit).toHaveBeenCalledOnce();
    workers.slice(1).forEach(worker => worker.finish({ success: true, output: 'Read-only review' }));
    // Five serialized captures plus repeated full-byte proofs and removals are
    // substantially more work than the single-worker phases on native runners.
    const terminal = await phase('collect and reclaim the remaining five workers', () => scope.collectPendingResults(), 90_000);
    expect(terminal.every(task => task.state === 'succeeded')).toBe(true);
    expect(await gitText(fixture.root, ['rev-parse', 'HEAD'])).toBe(fixture.head);
    expect(await gitText(fixture.root, ['for-each-ref', '--format=%(refname)', 'refs/heads'])).toBe('refs/heads/main');
    await retainAndCheckCloseout(scope, first.taskId);
  }, 5 * 30_000 + 90_000 + 5_000);

  // Two worker lifecycles and explicit integration each retain bounded operations;
  // only the outer watchdog accounts for the sum of the seven phase budgets.
  it('reuses native conversation and worktree after explicit integration, including sibling changes in the next baseline', async () => {
    const scope = manager.begin(parent);
    const { first, pointer } = await gitPhase('prepare and edit the first conversation', async () => {
      const first = await startExecuting(scope, 'first');
      const pointer = path.join(fixture.directory, '.remote-cli', 'codex-sessions', `${factory.mock.calls[0][3]}.json`);
      await fs.mkdir(path.dirname(pointer), { recursive: true });
      await fs.writeFile(pointer, JSON.stringify({ threadId: 'fixture-conversation', cwd: workers[0].cwd }));
      await fs.writeFile(path.join(workers[0].cwd, 'source.txt'), 'integrated result\n');
      workers[0].finish({ success: true, output: 'Ready' });
      return { first, pointer };
    });
    await gitPhase('collect the first conversation result', () => result(scope, first.taskId, 'first-result'));
    const inspection: any = await gitPhase('inspect the first conversation artifact', () =>
      scope.invoke('remote_cli_integrate', { taskId: first.taskId }, 'inspect'));
    await gitPhase('apply and reclaim the first conversation artifact', async () => {
      expect(await scope.invoke('remote_cli_integrate', { taskId: first.taskId, action: 'apply',
        expectedRevision: inspection.revision }, 'apply')).toMatchObject({ disposition: 'applied' });
    });
    await gitPhase('verify reclamation and add sibling changes', async () => {
      await expect(fs.lstat(workers[0].cwd)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(JSON.parse(await fs.readFile(pointer, 'utf8')).threadId).toBe('fixture-conversation');
      await fs.writeFile(path.join(fixture.root, 'sibling.txt'), 'new mainline input\n');
    });
    const second = await gitPhase('reuse the conversation with the current baseline', async () => {
      const second = await startExecuting(scope, 'second');
      expect(workers[1].cwd).toBe(workers[0].cwd);
      expect(factory.mock.calls[1][3]).toBe(factory.mock.calls[0][3]);
      expect(JSON.parse(await fs.readFile(pointer, 'utf8')).cwd).toBe(workers[1].cwd);
      expect(await fs.readFile(path.join(workers[1].cwd, 'sibling.txt'), 'utf8')).toContain('mainline input');
      expect(vi.mocked(workers[1].executor.execute).mock.calls[0][0]).toContain('earlier conversation context may be stale');
      workers[1].finish({ success: true, output: 'Rechecked current files' });
      return second;
    });
    await gitPhase('collect the reused conversation result', () => result(scope, second.taskId, 'second-result'));
  }, 7 * 30_000 + 5_000);

  it('reuses a historically delivered lane before the next worker without deleting its checkout at admission', async () => {
    const scope = manager.begin(parent);
    const { first, originalCwd, executorId } = await gitPhase('prepare and edit the historical handoff', async () => {
      const first = await startExecuting(scope, 'first');
      const originalCwd = workers[0].cwd;
      const executorId = factory.mock.calls[0][3];
      await fs.writeFile(path.join(originalCwd, 'source.txt'), 'manual handoff\n');
      workers[0].finish({ success: true });
      return { first, originalCwd, executorId };
    });
    const completed = await gitPhase('collect the historical handoff', () => result(scope, first.taskId, 'first-result'));
    await gitPhase('merge the handoff and update coordinator input', async () => {
      await runGit(fixture.root, ['merge', '--ff-only', completed.artifact!.outputCommit]);
      await fs.writeFile(path.join(fixture.root, 'sibling.txt'), 'fresh coordinator input\n');
    });
    const removal = vi.spyOn(manager.workspaceManager, 'reclaim');
    const second = await gitPhase('reuse the historical lane without admission-time reclamation', async () => {
      const second = await startExecuting(scope, 'second');
      expect(removal).not.toHaveBeenCalled();
      expect(workers[1].cwd).toBe(originalCwd);
      expect(factory.mock.calls[1][3]).toBe(executorId);
      expect(await manager.workspaceManager.describe(first.taskId)).toMatchObject({ disposition: 'applied',
        deliveredAtHead: completed.artifact!.outputCommit });
      expect(await fs.readFile(path.join(workers[1].cwd, 'sibling.txt'), 'utf8')).toBe('fresh coordinator input\n');
      workers[1].finish({ success: true });
      return second;
    });
    await gitPhase('collect the reused historical lane', () => result(scope, second.taskId, 'second-result'));
  }, 5 * 30_000 + 5_000);

  it('does not charge optional history reconciliation to the native worker startup deadline', async () => {
    const scope = manager.begin(parent);
    const first = await startExecuting(scope, 'first');
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
      await vi.waitFor(() => expect(entered).toBe(true), { timeout: 10_000 });
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
    const first = await gitPhase('prepare and edit the idle-close handoff', async () => {
      const first = await startExecuting(scope, 'first');
      await fs.writeFile(path.join(workers[0].cwd, 'source.txt'), 'closure handoff\n');
      workers[0].finish({ success: true });
      return first;
    });
    const completed = await gitPhase('collect the idle-close handoff', () => result(scope, first.taskId, 'first-result'));
    const pointer = await gitPhase('merge the idle handoff and retain its native pointer', async () => {
      await runGit(fixture.root, ['merge', '--ff-only', completed.artifact!.outputCommit]);
      const pointer = path.join(fixture.directory, '.remote-cli', 'codex-sessions', `${factory.mock.calls[0][3]}.json`);
      await fs.mkdir(path.dirname(pointer), { recursive: true });
      await fs.writeFile(pointer, JSON.stringify({ threadId: 'fixture-conversation', cwd: workers[0].cwd }));
      return pointer;
    });
    await gitPhase('await gated idle-close reclamation and verify its receipt', async () => {
      let release!: () => void;
      let entered = false;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const original = manager.workspaceManager.reclaim.bind(manager.workspaceManager);
      vi.spyOn(manager.workspaceManager, 'reclaim').mockImplementation(async taskId => { entered = true; await gate; return original(taskId); });
      let closed = false;
      const closing = scope.close().then(() => { closed = true; });
      try {
        await vi.waitFor(() => expect(entered).toBe(true), { timeout: 10_000 });
        expect(closed).toBe(false);
        expect((await fs.stat(workers[0].cwd)).isDirectory()).toBe(true);
      } finally { release(); await closing; }
      await expect(fs.lstat(workers[0].cwd)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(JSON.parse(await fs.readFile(pointer, 'utf8')).threadId).toBe('fixture-conversation');
      expect(await manager.workspaceManager.describe(first.taskId)).toMatchObject({ disposition: 'applied' });
    });
    const nextScope = manager.begin({ ...parent, messageId: 'next-parent' });
    const next = await gitPhase('recreate the idle-closed lane with its existing conversation', async () => {
      const next = await startExecuting(nextScope, 'recreated');
      expect(workers[1].cwd).toBe(workers[0].cwd);
      expect(factory.mock.calls[1][3]).toBe(factory.mock.calls[0][3]);
      workers[1].finish({ success: true });
      return next;
    });
    await gitPhase('collect the recreated idle-closed lane', () => result(nextScope, next.taskId, 'next-result'));
  }, 6 * 30_000 + 5_000);

  it('defers close-time recognition when another owner holds the delivery workspace', async () => {
    const scope = manager.begin(parent);
    const first = await startExecuting(scope, 'first');
    await fs.writeFile(path.join(workers[0].cwd, 'source.txt'), 'deferred handoff\n');
    workers[0].finish({ success: true });
    const completed = await result(scope, first.taskId, 'first-result');
    await runGit(fixture.root, ['merge', '--ff-only', completed.artifact!.outputCommit]);
    const otherScope = manager.begin({ ...parent, thread: { ...parent.thread, id: 'other-owner' } });
    const other = await startExecuting(otherScope, 'independent');
    await scope.close();
    expect(await manager.workspaceManager.describe(first.taskId)).toMatchObject({ disposition: 'pending' });
    expect((await fs.stat(workers[0].cwd)).isDirectory()).toBe(true);
    workers[1].finish({ success: true });
    await result(otherScope, other.taskId, 'other-result');
  });

  it('defers close-time recognition instead of waiting for an unfinished discovery admission', async () => {
    const scope = manager.begin(parent);
    const first = await startExecuting(scope, 'first');
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
    const first = await startExecuting(scope, 'first');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(workers[0].executor.waitForExit!).mockImplementation(() => gate);
    workers[0].finish({ success: true, output: 'No changes' });
    try {
      await vi.waitFor(() => expect(workers[0].executor.waitForExit).toHaveBeenCalled(), { timeout: 10_000 });
      expect((await fs.lstat(workers[0].cwd)).isDirectory()).toBe(true);
    } finally { release(); }
    expect(await result(scope, first.taskId, 'r1')).toMatchObject({ state: 'succeeded', artifact: { disposition: 'applied' } });
    await expect(fs.lstat(workers[0].cwd)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['failed', 'cancelled'])('reclaims a %s no-change checkout', async outcome => {
    const scope = manager.begin(parent);
    const first = await startExecuting(scope, 'first');
    if (outcome === 'failed') workers[0].finish({ success: false, error: 'Fixture failure' });
    else await scope.invoke('remote_cli_cancel', { taskId: first.taskId }, 'cancel');
    expect(await result(scope, first.taskId, 'r1')).toMatchObject({ state: outcome, artifact: { disposition: 'applied' } });
    expect(await manager.workspaceManager.describe(first.taskId)).toMatchObject({ successful: false });
    await expect(fs.lstat(workers[0].cwd)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([false, true])('settles gated reclamation even after an early assertion failure (earlyFailure=%s)', async earlyFailure => {
    const scope = manager.begin(parent);
    const first = await startExecuting(scope, 'first');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reclaim = vi.spyOn(manager.workspaceManager, 'reclaim').mockImplementation(async () => { await gate; return false; });
    if (!earlyFailure) {
      const collect = manager.workspaceManager.collect.bind(manager.workspaceManager);
      vi.spyOn(manager.workspaceManager, 'collect').mockImplementationOnce(async (...args) => {
        // Real Git collection can exceed vi.waitFor's default one-second budget.
        await new Promise(resolve => setTimeout(resolve, 1100));
        return collect(...args);
      });
    }
    const assertionFailure = new Error('Synthetic assertion failure while reclamation is gated');
    const exercise = async () => {
      try {
        workers[0].finish({ success: true });
        await vi.waitFor(() => expect(reclaim).toHaveBeenCalledWith(first.taskId), { timeout: 10_000 });
        expect((await manager.laneStore.lanesForThread(parent.thread.id))[0].state).toBe('running');
        if (earlyFailure) throw assertionFailure;
        const second = await startExecuting(scope, 'follower');
        expect(workers[1].cwd).not.toBe(workers[0].cwd);
        expect(factory.mock.calls[1][3]).not.toBe(factory.mock.calls[0][3]);
        release();
        workers[1].finish({ success: true });
        expect(await result(scope, first.taskId, 'r1')).toMatchObject({ state: 'succeeded' });
        expect(await result(scope, second.taskId, 'r2')).toMatchObject({ state: 'succeeded' });
      } finally {
        release();
        workers.forEach(worker => worker.finish({ success: true }));
        await scope.close();
      }
    };
    if (earlyFailure) await expect(exercise()).rejects.toBe(assertionFailure);
    else await exercise();
    expect((await manager.laneStore.lanesForThread(parent.thread.id)).every(lane => lane.state === 'ready')).toBe(true);
    expect((await fs.lstat(workers[0].cwd)).isDirectory()).toBe(true);
  });

  it.each([false, true])('admits a different lane during byte verification and drains a released gate (earlyFailure=%s)', async earlyFailure => {
    const scope = manager.begin(parent);
    const phase = async <T>(name: string, pending: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`Byte verification fixture phase timed out: ${name}; workers=${workers.length}`)), 45_000);
        })]);
      } finally { clearTimeout(timer); }
    };
    let entered!: () => void;
    const verifying = new Promise<void>(resolve => { entered = resolve; });
    let firstDispatched!: () => void;
    const firstDispatch = new Promise<void>(resolve => { firstDispatched = resolve; });
    let dispatched!: () => void;
    const followerDispatched = new Promise<void>(resolve => { dispatched = resolve; });
    let release!: () => void;
    let released = false;
    const gate = new Promise<void>(resolve => { release = () => { released = true; resolve(); }; });
    // Signal actual executor dispatch, not a bounded acceptance response that
    // may still report queued while native Git preparation continues.
    const create = factory.getMockImplementation()!;
    factory.mockImplementation((...args) => {
      const executor = create(...args);
      const workerNumber = workers.length;
      if (workerNumber <= 2) {
        const execute = vi.mocked(executor.execute).getMockImplementation()!;
        vi.mocked(executor.execute).mockImplementation((...executionArgs) => {
          if (workerNumber === 1) firstDispatched(); else dispatched();
          return execute(...executionArgs);
        });
      }
      return executor;
    });
    const first = await phase('prepare and dispatch the first worker', (async () => {
      const accepted = await start(scope, 'first');
      await firstDispatch;
      return accepted;
    })());
    const original = gitCommands.runGit;
    vi.spyOn(gitCommands, 'runGit').mockImplementation(async (cwd, args, ...rest) => {
      if (args[0] === 'ls-tree' && args.includes('--full-tree')) { entered(); await gate; }
      return original(cwd, args, ...rest);
    });
    workers[0].finish({ success: true });
    let following: Promise<DelegatedTaskResult> | undefined;
    const assertionFailure = new Error('Synthetic assertion before follower admission');
    const exercise = async () => {
      try {
        // Reaching verification includes a real capture, reset and index audit.
        // Its duration is independent of the admission concurrency contract.
        await phase('reach full byte verification', verifying);
        if (earlyFailure) throw assertionFailure;
        following = start(scope, 'follower');
        await phase('dispatch another lane while verification is held', followerDispatched);
        expect(released).toBe(false);
        expect(workers).toHaveLength(2);
        expect(workers[1].cwd).not.toBe(workers[0].cwd);
      } finally {
        release();
        // Track collection before teardown, including any unfinished admission.
        await phase('drain admitted workers after releasing verification', trackCall((async () => {
          try { if (following) await following; }
          finally { workers.forEach(worker => worker.finish({ success: true })); }
          const terminal = await scope.collectPendingResults();
          expect(terminal).toHaveLength(earlyFailure ? 1 : 2);
          expect(terminal.every(task => task.state === 'succeeded')).toBe(true);
        })()));
      }
    };
    if (earlyFailure) await expect(exercise()).rejects.toBe(assertionFailure);
    else await exercise();
    expect(released).toBe(true);
    expect(await result(scope, first.taskId, 'r1')).toMatchObject({ state: 'succeeded' });
    if (following) expect(await result(scope, (await following).taskId, 'r2')).toMatchObject({ state: 'succeeded' });
  }, 185_000);

  it.each(['occupied', 'partial-registration', 'corrupt-receipt'])(
    'preserves existing context and isolates a %s checkout instead of discarding the lane', async condition => {
      const scope = manager.begin(parent);
      const first = await startExecuting(scope, 'first');
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
      const recovered = await startExecuting(scope, 'independent-lane');
      expect(factory.mock.calls[1][3]).not.toBe(executorId);
      expect(workers[1].cwd).not.toBe(oldCwd);
      if (condition === 'occupied') expect(await fs.readFile(path.join(oldCwd, 'retained.txt'), 'utf8')).toBe('do not overwrite\n');
      workers[1].finish({ success: true });
      expect(await result(scope, recovered.taskId, 'r3')).toMatchObject({ state: 'succeeded' });
    }, 30_000);

  it('lazily resolves a ready interrupted removal without abandoning its native conversation', async () => {
    const scope = manager.begin(parent);
    const first = await startExecuting(scope, 'first');
    const executorId = factory.mock.calls[0][3];
    let refused = false;
    const original = gitCommands.runGit;
    vi.spyOn(gitCommands, 'runGit').mockImplementation(async (cwd, args, ...rest) => {
      if (!refused && args[0] === 'worktree' && args[1] === 'remove' && args.includes(workers[0].cwd)) {
        refused = true; throw new Error('Fixture removal refusal');
      }
      return original(cwd, args, ...rest);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    workers[0].finish({ success: true });
    expect(await result(scope, first.taskId, 'r1')).toMatchObject({ state: 'succeeded' });
    expect(refused).toBe(true);
    const second = await startExecuting(scope, 'reuse');
    expect(factory.mock.calls[1][3]).toBe(executorId);
    expect(workers[1].cwd).toBe(workers[0].cwd);
    workers[1].finish({ success: true });
    expect(await result(scope, second.taskId, 'r2')).toMatchObject({ state: 'succeeded' });
  }, 30_000);

  // These multi-turn cases need separate deadlines for each real-Git phase.
  // Preserve the 30-second phase limit; the outer budgets cover their sum.
  it('pools same-target conversations without reusing pending artifacts or routing ambiguous input', async () => {
    const scope = manager.begin(parent);
    const [first, second] = await gitPhase('prepare two pooled workers', () => Promise.all([startExecuting(scope, 'first'), startExecuting(scope, 'second')]));
    expect([first.state, second.state]).toEqual(['running', 'running']);
    workers.forEach(worker => { worker.executor.isWaitingInput = () => true; });
    expect(manager.hasAmbiguousInput(parent.thread.id)).toBe(true);
    expect(scope.waitingExecutor()).toBeUndefined();
    workers[1].executor.isWaitingInput = () => false;
    expect(scope.waitingExecutor()).toBe(workers[0].executor);
    await fs.writeFile(path.join(workers[0].cwd, 'pending.txt'), 'pending result\n');
    workers.forEach(worker => worker.finish({ success: true }));
    await gitPhase('collect both pooled workers', () => scope.collectPendingResults());
    const third = await gitPhase('prepare the reusable pooled lane', () => startExecuting(scope, 'third'));
    expect(third.state).toBe('running');
    expect(workers[2].cwd).toBe(workers[1].cwd);
    expect(workers[2].cwd).not.toBe(workers[0].cwd);
    expect(factory.mock.calls[2][3]).toBe(factory.mock.calls[1][3]);
    expect(factory.mock.calls[2][3]).not.toBe(factory.mock.calls[0][3]);
    expect((await manager.laneStore.lanesForThread(parent.thread.id)).some(lane => lane.state === 'dirty')).toBe(false);
    const completed = await finishAndReclaim(scope, third.taskId, () => workers[2].finish({ success: true }));
    expect(completed.find(task => task.taskId === third.taskId)).toMatchObject({ state: 'succeeded', artifact: { disposition: 'applied' } });
    expect(await fs.readFile(path.join(workers[0].cwd, 'pending.txt'), 'utf8')).toBe('pending result\n');
  }, 6 * 30_000 + 5_000);

  it('returns an untouched reused lane to ready when baseline capture fails', async () => {
    const scope = manager.begin(parent);
    const first = await gitPhase('prepare the baseline worker', () => startExecuting(scope, 'first'));
    expect(first.state).toBe('running');
    const executorId = factory.mock.calls[0][3];
    const pointer = path.join(fixture.directory, '.remote-cli', 'codex-sessions', `${executorId}.json`);
    await fs.mkdir(path.dirname(pointer), { recursive: true });
    await fs.writeFile(pointer, 'retained context');
    workers[0].finish({ success: true });
    await gitPhase('collect the baseline worker', () => scope.collectPendingResults());
    const lane = (await manager.laneStore.lanesForThread(parent.thread.id))[0];
    const savedPath = path.join(fixture.directory, '.remote-cli', 'delegation-workspaces', 'lanes', `${lane.id}.json`);
    const saved = await fs.readFile(savedPath, 'utf8');
    const prepare = vi.spyOn(manager.workspaceManager, 'prepare');
    vi.spyOn(manager.workspaceManager, 'baseline').mockRejectedValueOnce(new Error('Synthetic baseline failure'));
    const failed = await gitPhase('reject the failed baseline', () => start(scope, 'failed-baseline'));
    expect(failed).toMatchObject({ state: 'failed' });
    expect(prepare).not.toHaveBeenCalled();
    expect(await fs.readFile(savedPath, 'utf8')).toBe(saved);
    expect((await manager.laneStore.lanesForThread(parent.thread.id))[0]).toMatchObject({ id: lane.id, state: 'ready' });
    expect((await manager.workspaceManager.unavailableLanes()).has(lane.id)).toBe(false);
    expect(await fs.readFile(pointer, 'utf8')).toBe('retained context');
    const next = await gitPhase('prepare the baseline retry', () => startExecuting(scope, 'retry-baseline'));
    expect(next.state).toBe('running');
    expect(factory.mock.calls[1][3]).toBe(executorId);
    workers[1].finish({ success: true });
    expect(await gitPhase('collect the baseline retry', () => scope.collectPendingResults()))
      .toEqual(expect.arrayContaining([expect.objectContaining({ taskId: next.taskId, state: 'succeeded' })]));
  }, 155_000);

  it('retains a prepared lane on executor setup failure without blaming checkout preparation', async () => {
    const scope = manager.begin(parent);
    const first = await startExecuting(scope, 'first');
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

  describe('missing native session replacement', () => {
    let scope: ReturnType<DelegationManager['begin']>;

    beforeEach(async () => {
      scope = manager.begin(parent);
      // Warm both lanes before completing either worker so this is not one reused lane.
      // Two admissions, two execution waits and two collections each retain 30 seconds.
      const first = await startInPhases(scope, 'warm-first');
      const second = await startInPhases(scope, 'warm-second');
      expect(first.state).toBe('running');
      expect(second.state).toBe('running');
      workers[0].finish({ success: true });
      workers[1].finish({ success: true });
      expect(await collectFinished(scope, first.taskId, 'first-result')).toMatchObject({ state: 'succeeded' });
      expect(await collectFinished(scope, second.taskId, 'second-result')).toMatchObject({ state: 'succeeded' });
      const lanes = await manager.laneStore.lanesForThread(parent.thread.id);
      expect(lanes).toHaveLength(2);
      expect(new Set(lanes.map(lane => lane.executorThreadId)).size).toBe(2);
      expect(lanes.every(lane => lane.state === 'ready')).toBe(true);
    }, 6 * 30_000 + 5_000);

    // Two dispatch/collection cycles plus the replacement acquisition use seven bounded steps.
    it('resets preparation tracking before reusing a replacement for a missing native session', async () => {
      const retrying = await startInPhases(scope, 'missing-session');
      workers[2].executor.consumeSessionResumeFailure = () => true;
      const staleId = factory.mock.calls[2][3];
      const healthyId = factory.mock.calls.slice(0, 2).map(call => call[3]).find(id => id !== staleId);
      const acquire = manager.laneStore.acquire.bind(manager.laneStore);
      let acquiredReplacement!: () => void;
      const replacement = new Promise<void>(resolve => { acquiredReplacement = resolve; });
      const acquisition = vi.spyOn(manager.laneStore, 'acquire').mockImplementationOnce(async (...args) => {
        const acquired = await acquire(...args);
        expect(acquired.reused).toBe(true);
        expect(acquired.lane.executorThreadId).toBe(healthyId);
        parent.isWorkspaceBusy = () => true;
        acquiredReplacement();
        return acquired;
      });
      workers[2].finish({ success: false, error: 'Stored native session is missing' });
      const collecting = collectFinished(scope, retrying.taskId, 'retry-result');
      void collecting.catch(() => undefined);
      await gitPhase('observe the healthy replacement acquisition', () => Promise.race([
        replacement, collecting.then(task => { throw new Error(`Task ended before replacement acquisition: ${JSON.stringify(task)}`); }),
      ]));
      expect(await collecting).toMatchObject({ state: 'failed' });
      expect(acquisition).toHaveBeenCalledOnce();
      const healthy = (await manager.laneStore.lanesForThread(parent.thread.id)).find(lane => lane.executorThreadId === healthyId);
      expect(healthy).toMatchObject({ state: 'ready', cleanupPending: false });
      expect((await manager.workspaceManager.unavailableLanes()).has(healthy!.id)).toBe(false);
      parent.isWorkspaceBusy = () => false;
      const recovered = await startInPhases(scope, 'retry-after-busy');
      expect(factory.mock.calls[3][3]).toBe(healthyId);
      workers[3].finish({ success: true });
      expect(await collectFinished(scope, recovered.taskId, 'recovered-result')).toMatchObject({ state: 'succeeded' });
    }, 7 * 30_000 + 5_000);
  });

  // Four dispatch steps, two terminal collections, one edit and one input check.
  it('captures fresh input for a later idle cohort even when the earlier review changed no files', async () => {
    const scope = manager.begin(parent);
    const first = await startInPhases(scope, 'first');
    workers[0].finish({ success: true });
    expect(await collectFinished(scope, first.taskId, 'r1')).toMatchObject({ state: 'succeeded' });
    await gitPhase('update coordinator input after the earlier cohort is idle', () =>
      fs.writeFile(path.join(fixture.root, 'source.txt'), 'coordinator updated input\n'));
    const second = await startInPhases(scope, 'second');
    await gitPhase('verify the later cohort received fresh coordinator input', async () => {
      expect(await fs.readFile(path.join(workers[1].cwd, 'source.txt'), 'utf8')).toBe('coordinator updated input\n');
      workers[1].finish({ success: true });
    });
    expect(await collectFinished(scope, second.taskId, 'r2')).toMatchObject({ state: 'succeeded' });
  }, 8 * 30_000 + 5_000);

  it('collects cancelled same-backend edits for recovery without modifying the coordinator and rejects foreign integration', async () => {
    const scope = manager.begin(parent);
    const first = await gitPhase('prepare and edit the cancellation worker', async () => {
      const first = await startExecuting(scope, 'first', parent.backend);
      await fs.writeFile(path.join(workers[0].cwd, 'partial.txt'), 'partial output\n');
      return first;
    });
    await gitPhase('cancel and capture the worker recovery artifact', async () => {
      expect(await scope.invoke('remote_cli_cancel', { taskId: first.taskId }, 'cancel')).toMatchObject({
        state: 'cancelled', artifact: { disposition: 'retained' } });
    });
    const inspection: any = await gitPhase('inspect the retained cancellation artifact', () =>
      scope.invoke('remote_cli_integrate', { taskId: first.taskId }, 'inspect'));
    await gitPhase('preserve retained disposition on explicit apply', async () => {
      await expect(scope.invoke('remote_cli_integrate', { taskId: first.taskId, action: 'apply',
        expectedRevision: inspection.revision }, 'apply')).resolves.toMatchObject({ disposition: 'retained' });
    });
    const other = manager.begin({ ...parent, thread: { ...parent.thread, id: 'other' } });
    await gitPhase('reject foreign artifact integration', async () => {
      await expect(other.invoke('remote_cli_integrate', { taskId: first.taskId }, 'foreign')).rejects.toThrow('foreign');
    });
    await gitPhase('verify recovery bytes and coordinator isolation', async () => {
      expect(await gitText(fixture.root, ['show', `${inspection.outputCommit}:partial.txt`])).toContain('partial output');
      await expect(fs.stat(workers[0].cwd)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(path.join(fixture.root, 'partial.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
    await gitPhase('close the foreign scope', () => other.close());
  }, 7 * 30_000 + 5_000);

  it('fails closed on damaged Git metadata instead of starting shared-directory workers', async () => {
    await runGit(fixture.root, ['symbolic-ref', 'HEAD', 'refs/heads/unborn']);
    const scope = manager.begin(parent);
    await expect(start(scope, 'unborn')).rejects.toThrow('Git rev-parse failed');
    expect(factory).not.toHaveBeenCalled();
  });

  it('waits for native cleanup and collection before checking artifact closeout', async () => {
    const scope = manager.begin(parent);
    await startExecuting(scope, 'cleanup');
    let release!: () => void;
    vi.mocked(workers[0].executor.destroy).mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    workers[0].finish({ success: true });
    scope.finishExecution(true);
    let settled = false;
    const checking = scope.checkArtifactCloseout().finally(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(release).toBeTypeOf('function'), { timeout: 10_000 });
      expect(settled).toBe(false);
    } finally {
      // A late destroy invocation must not acquire a new unresolved gate.
      vi.mocked(workers[0].executor.destroy).mockResolvedValue(undefined);
      release?.();
      await checking;
    }
    expect(await checking).toEqual([]);
  });

  it('preserves pending artifacts while another thread owns the delivery workspace', async () => {
    const busy = vi.fn(() => false);
    parent.isWorkspaceBusy = busy;
    const scope = manager.begin(parent);
    const task = await startExecuting(scope, 'busy-delivery');
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
      const task = await startExecuting(scope, 'delivered');
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
    const task = await startExecuting(scope, 'delivered');
    workers[0].finish({ success: true });
    await result(scope, task.taskId, 'done');
    scope.finishExecution(true);
    const sibling = manager.begin({ ...parent, thread: { ...parent.thread, id: 'another-thread' } });
    const active = await startExecuting(sibling, 'active');
    expect(await scope.checkArtifactCloseout()).toEqual([]);
    expect(manager.blocksWorkspace(fixture.root, parent.thread.id)).toBe(true);
    workers[1].finish({ success: true });
    expect(await result(sibling, active.taskId, 'sibling-done')).toMatchObject({ state: 'succeeded' });
  });

  it.each(['missing', 'foreign-owner', 'changed-ref'])(
    'does not accept a %s settled receipt merely because the source is busy', async corruption => {
      const scope = manager.begin(parent);
      const task = await startExecuting(scope, 'delivered');
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
    const done = await startExecuting(scope, 'settled');
    const pending = await startExecuting(scope, 'pending');
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
    const task = await startExecuting(scope, 'recovery');
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
    const task = await startExecuting(scope, 'cancel-closeout');
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
    let closing: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(release).toBeTypeOf('function'), { timeout: 10_000 });
      closing = scope.close();
    } finally {
      vi.mocked(manager.workspaceManager.inspectCloseout).mockImplementation(inspect);
      release?.();
      await Promise.allSettled([rejected, closing]);
    }
    await rejected;
    await closing;
    expect(scope.isClosed()).toBe(true);
  });
});
