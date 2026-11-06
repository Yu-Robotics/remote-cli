import { supportsFileSymlinks } from './symlinkFixture';
import { DelegatedWorkspaceManager } from '../../src/delegation/DelegatedWorkspaceManager';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
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
  let factory: ReturnType<typeof vi.fn<any[], IExecutor>>;
  let pendingCalls: Set<Promise<unknown>>;
  let phaseListeners: Set<() => void>;
  let terminalRecords: Map<string, DelegatedTaskRecord>;
  let observedStores: WeakSet<DelegationManager['store']>;
  let draining: boolean;
  let phaseAdmissionClosed: boolean;
  type Scope = ReturnType<DelegationManager['begin']>;
  type NativeStep = { taskId: string; kind: 'capture' | 'reclaim'; operation: Promise<unknown> };
  let nativeSteps: NativeStep[];
  let consumedSteps: Set<NativeStep>;
  let scopeTasks: WeakMap<Scope, Set<string>>;
  let terminalProgress: Set<string>;
  const makeWorkspace = () => {
    const workspace = new DelegatedWorkspaceManager(undefined, true);
    const collect = workspace.collect.bind(workspace), reclaim = workspace.reclaim.bind(workspace);
    // Observe original promises. A fixture timeout must never release runtime
    // ownership, and fault-injection mockRestore() must retain these forwarders.
    workspace.collect = (task, ...args) => {
      const operation = trackCall(collect(task, ...args));
      nativeSteps.push({ taskId: task.taskId, kind: 'capture', operation }); notifyPhase();
      return operation;
    };
    workspace.reclaim = (taskId, ...args) => {
      const operation = trackCall(reclaim(taskId, ...args));
      nativeSteps.push({ taskId, kind: 'reclaim', operation }); notifyPhase();
      return operation;
    };
    return workspace;
  };
  const notifyPhase = () => { for (const listener of phaseListeners) listener(); };
  beforeEach(async () => {
    fixture = await gitFixture();
    vi.spyOn(os, 'homedir').mockReturnValue(fixture.directory);
    vi.stubEnv('HOME', fixture.directory);
    vi.stubEnv('USERPROFILE', fixture.directory);
    workers = [];
    pendingCalls = new Set();
    nativeSteps = []; consumedSteps = new Set(); scopeTasks = new WeakMap(); terminalProgress = new Set();
    phaseListeners = new Set(); terminalRecords = new Map(); observedStores = new WeakSet(); draining = false; phaseAdmissionClosed = false;
    factory = vi.fn((guard: DirectoryGuard, _config, cwd: string) => {
      expect(guard.resolveWorkingDirectory(cwd)).toBe(cwd);
      const worker = controlledWorker(cwd, notifyPhase); workers.push(worker);
      if (draining) worker.finish({ success: false, error: 'Synthetic fixture teardown' });
      return worker.executor;
    });
    manager = new DelegationManager(new DirectoryGuard([fixture.directory]), factory as any,
      new BackendRegistry(async () => 'fixture 1.0'), undefined, undefined, undefined, undefined,
      makeWorkspace());
    parent = { thread: { id: 'fixture-owner', name: 'default', workingDirectory: fixture.root,
      sessionId: null, createdAt: 0, lastActiveAt: 0 }, cwd: fixture.root, messageId: 'parent',
    backend: 'claude', config: { type: 'auto' }, onToolUse: vi.fn(), onToolResult: vi.fn(), onNotice: vi.fn(),
    onProgress: vi.fn(event => {
      // finishTask reports terminal progress after native cleanup and metadata
      // pruning; its synchronous continuation settles the task before this
      // signal's promise reactions run. A terminal store write alone is earlier.
      if (['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(event.phase)) {
        terminalProgress.add(event.taskId); notifyPhase();
      }
      return true;
    }), onApproval: vi.fn(() => true), onApprovalResolved: vi.fn() };
  });
  const settleFixture = async (): Promise<void> => {
    // Settle controlled execution even when an assertion or phase deadline fired.
    // Keep mocks, home and ownership intact until all admitted work has exited.
    draining = true; notifyPhase();
    workers.forEach(worker => worker.finish({ success: false, error: 'Synthetic fixture teardown' }));
    while (pendingCalls.size) await Promise.allSettled([...pendingCalls]);
    await manager.destroy();
    while (pendingCalls.size) await Promise.allSettled([...pendingCalls]);
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
  const assertAdmission = () => {
    if (draining || phaseAdmissionClosed) throw new Error('Fixture is draining; no new Git phases may start');
  };
  const phaseBudget = (steps: number) => steps * 30_000 + 5_000;
  const waitForSignal = async <T>(read: () => T | undefined): Promise<T> => {
    let listener!: () => void;
    try {
      return await new Promise<T>((resolve, reject) => {
        listener = () => {
          try { assertAdmission(); const value = read(); if (value !== undefined) resolve(value); }
          catch (error) { reject(error); }
        };
        phaseListeners.add(listener); listener();
      });
    } finally { phaseListeners.delete(listener); }
  };
  // Waiting for a drain must not add that drain to the set it drains.
  const gitWait = async <T>(name: string | (() => string), operation: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          phaseAdmissionClosed = true;
          reject(new Error(`Git lifecycle phase exceeded 30 seconds: ${typeof name === 'string' ? name : name()}`));
          notifyPhase();
        }, 30_000);
      })]);
    } finally { clearTimeout(timer); }
  };
  const gitPhase = <T>(name: string | (() => string), action: () => Promise<T>): Promise<T> => {
    try { assertAdmission(); } catch (error) { return Promise.reject(error); }
    return gitWait(name, trackCall(Promise.resolve().then(() => { assertAdmission(); return action(); })));
  };
  const awaitEntry = (name: string, entered: Promise<void>, operation: Promise<unknown>) => Promise.race([
    entered, operation.then(() => { throw new Error(`Fixture operation ended before entry: ${name}`); }),
  ]);
  const acceptTask = async (scope: Scope, id: string, backend = 'codex'): Promise<DelegatedTaskResult> => {
    assertAdmission(); observeTaskStates();
    const accepting = trackCall(scope.invoke('remote_cli_delegate', { backend, objective: `Independent task ${id}` }, id) as Promise<DelegatedTaskResult>);
    // A queued response does not own the task's lifetime. Track its actual scope
    // completion even when an execution waiter fails or teardown starts later.
    trackCall(scope.collectPendingResults());
    const accepted = await accepting;
    const ids = scopeTasks.get(scope) ?? new Set<string>(); ids.add(accepted.taskId); scopeTasks.set(scope, ids);
    return accepted;
  };
  const start = (scope: Scope, id: string, backend = 'codex') => gitPhase(`accept ${id}`, () => acceptTask(scope, id, backend));
  const pollResult = (scope: Scope, taskId: string, id: string) => {
    assertAdmission();
    return trackCall(scope.invoke('remote_cli_result', { taskId, waitSeconds: 25 }, id) as Promise<DelegatedTaskResult>);
  };
  const result = (scope: Scope, taskId: string, id: string) => collectFinished(scope, taskId, id);

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
  }, phaseBudget(3));

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
  }, phaseBudget(3));

  it('does not enter a scheduled Git phase once teardown has begun', async () => {
    const action = vi.fn(async () => undefined);
    const scheduled = gitPhase('scheduled before teardown', action);
    const outcome = scheduled.catch(error => error);
    const shutdown = settleFixture();
    try {
      expect(await outcome).toMatchObject({ message: expect.stringContaining('Fixture is draining') });
      expect(action).not.toHaveBeenCalled();
    } finally { await Promise.allSettled([scheduled, shutdown]); }
  }, phaseBudget(1));

  const observeTaskStates = () => {
    if (!observedStores.has(manager.store)) {
      observedStores.add(manager.store);
      const store = manager.store;
      const write = store.write.bind(store), prune = store.prune.bind(store);
      store.write = record => {
        const operation = trackCall(write(record));
        const observed = () => {
          if (isTerminalTaskState(record.state)) terminalRecords.set(record.id, { ...record });
          notifyPhase();
        };
        void operation.then(observed, observed);
        return operation;
      };
      // Runtime storage deadlines do not cancel their original filesystem work.
      // Drain these promises too before mocks, ownership and roots are released.
      store.prune = () => trackCall(prune());
    }
  };
  const waitForExecution = async (scope: ReturnType<DelegationManager['begin']>, id: string, accepted: DelegatedTaskResult) => {
    const fail = (state: string, error?: string) => new Error(`Fixture worker ${id} ended before execution: ${state}${error ? `: ${error}` : ''}`);
    if (isTerminalTaskState(accepted.state)) throw fail(accepted.state, accepted.error);
    let listener!: () => void;
    try {
      await new Promise<void>((resolve, reject) => {
        listener = () => {
          if (draining || phaseAdmissionClosed) { reject(new Error('Fixture is draining before worker execution.')); return; }
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
  // Acceptance and execution are distinct bounded steps for every ordinary launch.
  // Intentional queue, discovery and setup-failure tests retain raw start().
  const startExecuting = async (scope: Scope, id: string, backend = 'codex') => {
    const accepted = await start(scope, id, backend);
    return gitPhase(`execute ${id}`, () => waitForExecution(scope, id, accepted));
  };
  const startInPhases = startExecuting;

  const settleNativeSteps = async <T>(ids: Set<string>, readTerminal: () => T | undefined, name: string,
    labels = { capture: `capture artifact ${name}`, reclaim: `reclaim checkout ${name}` }): Promise<T> => {
    for (;;) {
      let label = `finish collection ${name}`;
      const finished = await gitPhase(() => label, async () => {
        const next = await waitForSignal(() => {
          const step = nativeSteps.find(value => ids.has(value.taskId) && !consumedSteps.has(value));
          if (step) return { step };
          const value = readTerminal(); return value === undefined ? undefined : { value };
        });
        if ('value' in next) return next;
        consumedSteps.add(next.step); label = labels[next.step.kind];
        // The manager classifies native failures. Keep the original promise and
        // assert the resulting task state rather than converting rejection to success.
        await Promise.allSettled([next.step.operation]);
        return undefined;
      });
      if (finished) return finished.value!;
    }
  };
  const collectFinished = async (scope: Scope, taskId: string, id: string): Promise<DelegatedTaskResult> => {
    assertAdmission();
    await settleNativeSteps(new Set([taskId]), () => {
      if (terminalProgress.has(taskId)) return true;
      const record = terminalRecords.get(taskId);
      return record?.startedAt === undefined && record?.finishedAt !== undefined ? false : undefined;
    }, id);
    if (!terminalProgress.has(taskId)) {
      // Never-started tasks have no terminal progress card. These failure tests
      // await the scope's real completion, including metadata pruning.
      await collectAll(scope, `${id} unstarted task`);
    }
    return gitPhase(`read completed result ${id}`, async () => {
      const completed = await trackCall(scope.invoke('remote_cli_result', { taskId, waitSeconds: 0 }, id) as Promise<DelegatedTaskResult>);
      if (!isTerminalTaskState(completed.state)) throw new Error(`Fixture task ${id} did not finish collection`);
      return completed;
    });
  };
  const settleScope = async <T>(scope: Scope, name: string, terminal: Promise<T>, labels?: { capture: string; reclaim: string }): Promise<T> => {
    let settled = false, value: T | undefined, failure: unknown;
    trackCall(terminal);
    void terminal.then(results => { value = results; settled = true; notifyPhase(); },
      error => { failure = error; settled = true; notifyPhase(); });
    const completed = await settleNativeSteps(scopeTasks.get(scope) ?? new Set(), () => {
      if (failure) throw failure;
      return settled ? { value: value as T } : undefined;
    }, name, labels);
    return completed.value;
  };
  const collectAll = (scope: Scope, name = 'scope', labels?: { capture: string; reclaim: string }) => {
    assertAdmission(); return settleScope(scope, name, scope.collectPendingResults(), labels);
  };
  const closeScope = (scope: Scope) => {
    assertAdmission(); return settleScope(scope, 'close scope', scope.close());
  };
  const checkCloseout = (scope: Scope) => {
    assertAdmission(); return settleScope(scope, 'artifact closeout', scope.checkArtifactCloseout());
  };
  const finishAndReclaim = async (scope: Scope, _taskId: string, finish: () => void) => {
    assertAdmission(); finish();
    return collectAll(scope, 'the reused pooled task metadata', {
      capture: 'capture the reused pooled worker artifact', reclaim: 'reclaim the reused pooled checkout',
    });
  };

  it('drains original storage work after its runtime deadline before releasing fixture ownership', async () => {
    let entered!: () => void, release!: () => void;
    const pruning = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ownership = `${manager.laneStore.storageDirectory}.ownership`;
    const marker = path.join(fixture.directory, 'storage-settled.txt');
    const prune = manager.store.prune.bind(manager.store);
    // Install beneath the common forwarder before the first admission.
    vi.spyOn(manager.store, 'prune').mockImplementationOnce(async () => {
      entered(); await gate;
      expect((await fs.lstat(ownership)).isFile()).toBe(true);
      await fs.writeFile(marker, 'storage settled before ownership release');
      return prune();
    });
    const scope = manager.begin(parent);
    const task = await startExecuting(scope, 'late-storage');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const destroy = vi.spyOn(manager, 'destroy');
    const releaseOwnership = vi.spyOn(DelegationOwnership.prototype, 'release');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    workers[0].finish({ success: true });
    const collecting = result(scope, task.taskId, 'storage-result');
    void collecting.catch(() => undefined);
    let shutdown: Promise<void> | undefined;
    try {
      await awaitEntry('storage pruning', pruning, collecting);
      await vi.advanceTimersByTimeAsync(DELEGATION_LIMITS.storageTimeoutMs + 1);
      expect(await collecting).toMatchObject({ state: 'succeeded' });
      expect(warning).toHaveBeenCalledWith('[Delegation] Final task metadata could not be saved or pruned');
      expect(pendingCalls.size).toBeGreaterThan(0);
      vi.useRealTimers();
      let drained = false;
      shutdown = settleFixture().then(() => { drained = true; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(drained).toBe(false); expect(destroy).not.toHaveBeenCalled();
      expect(releaseOwnership).not.toHaveBeenCalled();
      release(); await gitWait('drain original storage work', shutdown);
      expect(await fs.readFile(marker, 'utf8')).toBe('storage settled before ownership release');
      expect(releaseOwnership).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers(); release();
      await Promise.allSettled([collecting, shutdown ?? settleFixture()]);
    }
    expect(pendingCalls.size).toBe(0);
  }, phaseBudget(7));

  it.each(['completed', 'late resolution', 'late rejection'] as const)(
    'keeps ordinary result collection behind native phases and metadata settlement (%s)', async completion => {
      const scope = manager.begin(parent);
      const task = await startExecuting(scope, 'ordinary-finalization');
      let enteredCapture!: () => void, releaseCapture!: () => void, enteredReclaim!: () => void, releaseReclaim!: () => void;
      let enteredMetadata!: () => void, releaseMetadata!: () => void;
      const capturing = new Promise<void>(resolve => { enteredCapture = resolve; });
      const captureGate = new Promise<void>(resolve => { releaseCapture = resolve; });
      const reclaiming = new Promise<void>(resolve => { enteredReclaim = resolve; });
      const reclaimGate = new Promise<void>(resolve => { releaseReclaim = resolve; });
      const pruning = new Promise<void>(resolve => { enteredMetadata = resolve; });
      const metadataGate = new Promise<void>(resolve => { releaseMetadata = resolve; });
      const ownership = `${manager.laneStore.storageDirectory}.ownership`;
      const marker = path.join(fixture.directory, 'native-settled.txt');
      const workspace = manager.workspaceManager as any;
      const forwardCollect = workspace.collect;
      const captureSpy = vi.spyOn(workspace, 'collect');
      const verify = workspace.verifyCheckout.bind(workspace);
      let checks = 0;
      vi.spyOn(workspace, 'verifyCheckout').mockImplementation(async (...args) => {
        if (++checks === 1) {
          enteredCapture(); await captureGate;
          expect((await fs.lstat(ownership)).isFile()).toBe(true);
          await fs.writeFile(marker, 'native collection settled under ownership');
          if (completion === 'late rejection') throw new Error('Synthetic late native failure');
        } else if (checks === 2) { enteredReclaim(); await reclaimGate; }
        return verify(...args);
      });
      if (completion === 'completed') {
        const prune = manager.store.prune.bind(manager.store);
        vi.spyOn(manager.store, 'prune').mockImplementationOnce(async () => {
          enteredMetadata(); await metadataGate; return prune();
        });
      }
      const calls = vi.spyOn(scope, 'invoke');
      const releaseOwnership = vi.spyOn(DelegationOwnership.prototype, 'release');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      workers[0].finish({ success: true });
      const polling = pollResult(scope, task.taskId, 'early-native-poll');
      let settled = false;
      const collecting = result(scope, task.taskId, 'ordinary-terminal');
      const outcome = collecting.then(value => { settled = true; return { value, error: undefined }; },
        error => { settled = true; return { value: undefined, error }; });
      let shutdown: Promise<void> | undefined;
      try {
        await awaitEntry('capture', capturing, collecting);
        captureSpy.mockRestore();
        expect(workspace.collect).toBe(forwardCollect);
        if (completion === 'completed') {
          await vi.advanceTimersByTimeAsync(16_000); releaseCapture();
          await awaitEntry('reclamation', reclaiming, collecting);
          await vi.advanceTimersByTimeAsync(16_000);
          expect(await polling).toMatchObject({ state: 'running' });
          expect(settled).toBe(false);
          releaseReclaim();
          await awaitEntry('metadata pruning', pruning, collecting);
          // A terminal record precedes task.done. Preserve the runtime's separate
          // 10-second storage bound while holding its pruning below that limit.
          expect(await scope.invoke('remote_cli_result', { taskId: task.taskId, waitSeconds: 0 }, 'early-metadata-poll'))
            .toMatchObject({ state: 'succeeded' });
          expect(terminalProgress.has(task.taskId)).toBe(false); expect(settled).toBe(false);
          await vi.advanceTimersByTimeAsync(5_000);
          expect(settled).toBe(false);
          vi.useRealTimers(); releaseMetadata();
          expect(await collecting).toMatchObject({ state: 'succeeded', artifact: { disposition: 'applied' } });
        } else {
          await vi.advanceTimersByTimeAsync(30_001);
          expect((await outcome).error).toMatchObject({ message: 'Git lifecycle phase exceeded 30 seconds: capture artifact ordinary-terminal' });
          await expect(startExecuting(scope, 'late-start')).rejects.toThrow('Fixture is draining');
          await expect(result(scope, task.taskId, 'late-result')).rejects.toThrow('Fixture is draining');
          expect(calls.mock.calls.some(([, , id]) => id === 'ordinary-terminal' || id === 'late-result')).toBe(false);
          vi.useRealTimers();
          let drained = false;
          shutdown = settleFixture().then(() => { drained = true; });
          await new Promise<void>(resolve => setImmediate(resolve));
          expect(drained).toBe(false); expect(releaseOwnership).not.toHaveBeenCalled();
          expect((await fs.stat(fixture.directory)).isDirectory()).toBe(true);
          releaseReclaim(); releaseCapture();
          await gitWait('drain late native collection under ownership', shutdown);
          expect(await fs.readFile(marker, 'utf8')).toBe('native collection settled under ownership');
          expect(releaseOwnership).toHaveBeenCalledOnce();
        }
      } finally {
        vi.useRealTimers(); releaseCapture(); releaseReclaim(); releaseMetadata();
        await Promise.allSettled([polling, collecting, shutdown ?? settleFixture()]);
      }
      expect(pendingCalls.size).toBe(0); expect(phaseListeners.size).toBe(0);
    }, phaseBudget(8));

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
  }, phaseBudget(6));

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
  }, phaseBudget(6));

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
    const starting = startExecuting(scope, 'successive-preparation');
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
  }, phaseBudget(7));

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
      const polling = pollResult(scope, task.taskId, 'bounded-poll');
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
    }, phaseBudget(7));

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
        await awaitEntry('held preparation', preparing, starting);
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
    }, phaseBudget(6));

  it.skipIf(!supportsFileSymlinks)('warns a managed worker and its result about direct shared-data edits', async () => {
    await gitPhase('destroy fixture state', () => manager.destroy());
    const target = path.join(fixture.directory, 'shared.txt'); await fs.writeFile(target, 'synthetic shared bytes\n');
    await gitPhase('fixture Git config', () => runGit(fixture.root, ['config', 'core.symlinks', 'true']));
    await fs.symlink(path.relative(fixture.root, target), path.join(fixture.root, 'shared-link'), 'file');
    manager = new DelegationManager(new DirectoryGuard([fixture.directory]), factory as any,
      new BackendRegistry(async () => 'fixture 1.0'), undefined, undefined, undefined, undefined,
      makeWorkspace());
    const scope = manager.begin(parent);
    const task = await startExecuting(scope, 'shared-warning');
    expect(task.state).toBe('running');
    const prompt = vi.mocked(workers[0].executor.execute).mock.calls[0][0];
    expect(prompt).toContain('Shared external links: "shared-link"');
    expect(prompt).toContain('NOT captured, merged, reverted, or backed up');
    workers[0].finish({ success: true, output: 'Synthetic result' });
    const completed = await result(scope, task.taskId, 'shared-result');
    expect(completed.artifact?.sharingWarning).toContain('shared original data');
    await closeScope(scope);
    expect(await fs.readFile(target, 'utf8')).toBe('synthetic shared bytes\n');
  }, phaseBudget(9));

  it('settles an unfinished worker and result call after an assertion failure before releasing fixture ownership', async () => {
    const scope = manager.begin(parent);
    const first = await startExecuting(scope, 'unfinished');
    expect(first.state).toBe('running');
    const collecting = pollResult(scope, first.taskId, 'pending-result');
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
  }, phaseBudget(6));

  // Acceptance, bounded dispatch polling and real Git collection have cumulative costs on Windows.
  it('keeps concurrent worker metadata independent while bounding combined retained results', async () => {
    factory.mockImplementation((_guard, configuration, cwd) => {
      const worker = controlledWorker(cwd, notifyPhase);
      worker.executor.getExecutionMetadata = vi.fn(() => configuredExecutionMetadata(`${configuration.type}-selected`, 'low'));
      workers.push(worker);
      return worker.executor;
    });
    const scope = manager.begin(parent);
    const backends = ['codex', 'agy', 'dsh'];
    const tasks = await Promise.all(backends.map(backend => startExecuting(scope, backend, backend)));
    expect(tasks.every(task => task.state === 'running'), `Dispatch snapshots: ${JSON.stringify(tasks)}`).toBe(true);
    tasks.forEach(task => expect(task.executionMetadata).toMatchObject({ backend: task.backend, model: `${task.backend}-selected`, modelSource: 'configured' }));
    workers.forEach(worker => {
      const backend = worker.executor.getExecutionMetadata!().model!.replace(/-selected$/, '');
      const index = backends.indexOf(backend);
      vi.mocked(worker.executor.getExecutionMetadata!).mockReturnValue({ model: `${backend}-native`, modelSource: 'reported', reasoningEffort: ['high', 'low', 'medium'][index], effortSource: 'reported' });
      worker.finish({ success: true, output: 'x'.repeat(32_000) });
    });
    const results = await collectAll(scope);
    expect(results).toHaveLength(3);
    expect(Buffer.byteLength(JSON.stringify(results))).toBeLessThanOrEqual(DELEGATION_LIMITS.continuationBytes);
    results.forEach(task => expect(task.executionMetadata).toMatchObject({ backend: task.backend, model: `${task.backend}-native`, modelSource: 'reported' }));
    expect(results.every(task => task.truncated)).toBe(true);
    for (const task of results) {
      expect(parent.onProgress).toHaveBeenCalledWith(expect.objectContaining({ taskId: task.taskId, phase: 'succeeded', executionMetadata: task.executionMetadata }));
    }
  }, phaseBudget(13));

  // Five concurrent executions, queued admission and later native cleanup retain
  // individual phase limits; the watchdog sums the six worker lifecycles.
  it.each(['mixed', 'same-backend'] as const)('runs five isolated %s tasks concurrently and keeps a sixth queued', async mode => {
    const scope = manager.begin(parent);
    const tasks: DelegatedTaskResult[] = [];
    const backends = mode === 'mixed' ? ['codex', 'agy', 'dsh', 'kimi', 'agy', 'codex'] : Array(6).fill(parent.backend);
    expect(await gitPhase('discover concurrent scheduling', () => scope.invoke('remote_cli_list_backends', {}, 'discover'))).toMatchObject({
      maxConcurrentChildren: 5, scheduling: 'isolated-worktrees', workspace: fixture.root });
    for (const [index, backend] of backends.entries()) {
      tasks.push(index < 5 ? await startExecuting(scope, `task-${index}`, backend)
        : await start(scope, `task-${index}`, backend));
    }
    const first = tasks[0];
    expect(tasks.map(task => task.state)).toEqual(['running', 'running', 'running', 'running', 'running', 'queued']);
    expect(new Set(workers.map(worker => worker.cwd)).size).toBe(5);
    expect(new Set(factory.mock.calls.map(call => call[3])).size).toBe(5);
    expect(factory.mock.calls.every(call => call[3] !== parent.thread.id && call[6].delegationWorker)).toBe(true);
    expect(workers.every(worker => worker.cwd !== fixture.root)).toBe(true);
    await fs.writeFile(path.join(workers[0].cwd, 'source.txt'), 'first worker only\n');
    expect(await fs.readFile(path.join(workers[1].cwd, 'source.txt'), 'utf8')).toContain('first\nsecond');
    expect(await fs.readFile(path.join(fixture.root, 'source.txt'), 'utf8')).toContain('first\nsecond');
    await expect(gitPhase('remote_cli_integrate fixture state', () => scope.invoke('remote_cli_integrate', { taskId: first.taskId }, 'too-soon'))).rejects.toThrow('finish');
    workers[0].finish({ success: true, output: 'Changed source' });
    expect(await result(scope, first.taskId, 'first-result')).toMatchObject({ artifact: { disposition: 'pending' } });
    await gitPhase('execute the queued sixth worker', () => waitForExecution(scope, 'task-5', tasks[5]));
    expect(workers).toHaveLength(6);
    expect(workers[0].executor.waitForExit).toHaveBeenCalledOnce();
    workers.slice(1).forEach(worker => worker.finish({ success: true, output: 'Read-only review' }));
    const terminal = await collectAll(scope, 'remaining concurrent workers');
    expect(terminal.every(task => task.state === 'succeeded')).toBe(true);
    expect(await gitPhase('fixture Git rev-parse', () => gitText(fixture.root, ['rev-parse', 'HEAD']))).toBe(fixture.head);
    expect(await gitPhase('fixture Git for-each-ref', () => gitText(fixture.root, ['for-each-ref', '--format=%(refname)', 'refs/heads']))).toBe('refs/heads/main');
    await retainAndCheckCloseout(scope, first.taskId);
  }, phaseBudget(35));

  // Two worker lifecycles and explicit integration each retain bounded operations;
  // only the outer watchdog accounts for the sum of the bounded steps.
  it('reuses native conversation and worktree after explicit integration, including sibling changes in the next baseline', async () => {
    const scope = manager.begin(parent);
    const first = await startExecuting(scope, 'first');
    const { pointer } = await gitPhase('prepare and edit the first conversation', async () => {
      const pointer = path.join(fixture.directory, '.remote-cli', 'codex-sessions', `${factory.mock.calls[0][3]}.json`);
      await fs.mkdir(path.dirname(pointer), { recursive: true });
      await fs.writeFile(pointer, JSON.stringify({ threadId: 'fixture-conversation', cwd: workers[0].cwd }));
      await fs.writeFile(path.join(workers[0].cwd, 'source.txt'), 'integrated result\n');
      workers[0].finish({ success: true, output: 'Ready' });
      return { first, pointer };
    });
    await result(scope, first.taskId, 'first-result');
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
    const second = await startExecuting(scope, 'second');
    await gitPhase('reuse the conversation with the current baseline', async () => {
      expect(workers[1].cwd).toBe(workers[0].cwd);
      expect(factory.mock.calls[1][3]).toBe(factory.mock.calls[0][3]);
      expect(JSON.parse(await fs.readFile(pointer, 'utf8')).cwd).toBe(workers[1].cwd);
      expect(await fs.readFile(path.join(workers[1].cwd, 'sibling.txt'), 'utf8')).toContain('mainline input');
      expect(vi.mocked(workers[1].executor.execute).mock.calls[0][0]).toContain('earlier conversation context may be stale');
      workers[1].finish({ success: true, output: 'Rechecked current files' });
      return second;
    });
    await result(scope, second.taskId, 'second-result');
  }, phaseBudget(17));

  it('reuses a historically delivered lane before the next worker without deleting its checkout at admission', async () => {
    const scope = manager.begin(parent);
    const first = await startExecuting(scope, 'first');
    const { originalCwd, executorId } = await gitPhase('prepare and edit the historical handoff', async () => {
      const originalCwd = workers[0].cwd;
      const executorId = factory.mock.calls[0][3];
      await fs.writeFile(path.join(originalCwd, 'source.txt'), 'manual handoff\n');
      workers[0].finish({ success: true });
      return { first, originalCwd, executorId };
    });
    const completed = await result(scope, first.taskId, 'first-result');
    await gitPhase('merge the handoff and update coordinator input', async () => {
      await runGit(fixture.root, ['merge', '--ff-only', completed.artifact!.outputCommit]);
      await fs.writeFile(path.join(fixture.root, 'sibling.txt'), 'fresh coordinator input\n');
    });
    const removal = vi.spyOn(manager.workspaceManager, 'reclaim');
    const second = await startExecuting(scope, 'second');
    await gitPhase('reuse the historical lane without admission-time reclamation', async () => {
      expect(removal).not.toHaveBeenCalled();
      expect(workers[1].cwd).toBe(originalCwd);
      expect(factory.mock.calls[1][3]).toBe(executorId);
      expect(await manager.workspaceManager.describe(first.taskId)).toMatchObject({ disposition: 'applied',
        deliveredAtHead: completed.artifact!.outputCommit });
      expect(await fs.readFile(path.join(workers[1].cwd, 'sibling.txt'), 'utf8')).toBe('fresh coordinator input\n');
      workers[1].finish({ success: true });
      return second;
    });
    await result(scope, second.taskId, 'second-result');
  }, phaseBudget(15));

  it('does not charge optional history reconciliation to the native worker startup deadline', async () => {
    const scope = manager.begin(parent);
    const first = await startExecuting(scope, 'first');
    // This tests startup timing, not Git's same-size racy-stat detection.
    await fs.writeFile(path.join(workers[0].cwd, 'source.txt'), 'slow-query handoff captured before startup delay\n');
    workers[0].finish({ success: true });
    const completed = await result(scope, first.taskId, 'first-result');
    expect(completed).toMatchObject({ state: 'succeeded', artifact: { disposition: 'pending' } });
    await gitPhase('fixture Git merge', () => runGit(fixture.root, ['merge', '--ff-only', completed.artifact!.outputCommit]));
    let release!: () => void;
    let entered!: () => void;
    const entering = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = manager.workspaceManager.reconcileHistoricalDelivery.bind(manager.workspaceManager);
    vi.spyOn(manager.workspaceManager, 'reconcileHistoricalDelivery').mockImplementation(async (...args) => {
      entered(); await gate; return original(...args);
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const starting = startExecuting(scope, 'slow-history');
    void starting.catch(() => undefined);
    try {
      await awaitEntry('history reconciliation', entering, starting);
      await vi.advanceTimersByTimeAsync(DELEGATION_LIMITS.storageTimeoutMs + 1);
      expect(workers).toHaveLength(1);
      vi.useRealTimers();
      release();
      const second = await starting;
      expect(second.state).toBe('running');
      expect(workers[1].cwd).toBe(workers[0].cwd);
      workers[1].finish({ success: true });
      expect(await result(scope, second.taskId, 'second-result')).toMatchObject({ state: 'succeeded' });
    } finally { vi.useRealTimers(); release(); await Promise.allSettled([starting]); }
  }, phaseBudget(13));

  it('automatically recognizes manual handoff at idle turn closure and awaits reclamation', async () => {
    const scope = manager.begin(parent);
    const first = await startExecuting(scope, 'first');
    await gitPhase('prepare and edit the idle-close handoff', async () => {
      await fs.writeFile(path.join(workers[0].cwd, 'source.txt'), 'closure handoff\n');
      workers[0].finish({ success: true });
      return first;
    });
    const completed = await result(scope, first.taskId, 'first-result');
    const pointer = await gitPhase('merge the idle handoff and retain its native pointer', async () => {
      await runGit(fixture.root, ['merge', '--ff-only', completed.artifact!.outputCommit]);
      const pointer = path.join(fixture.directory, '.remote-cli', 'codex-sessions', `${factory.mock.calls[0][3]}.json`);
      await fs.mkdir(path.dirname(pointer), { recursive: true });
      await fs.writeFile(pointer, JSON.stringify({ threadId: 'fixture-conversation', cwd: workers[0].cwd }));
      return pointer;
    });
    let release!: () => void, entered!: () => void;
    const entering = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = manager.workspaceManager.reclaim.bind(manager.workspaceManager);
    vi.spyOn(manager.workspaceManager, 'reclaim').mockImplementation(async taskId => { entered(); await gate; return original(taskId); });
    let closed = false;
    const closing = closeScope(scope).then(() => { closed = true; });
    try {
      await gitPhase('enter idle-close reclamation', () => awaitEntry('idle-close reclamation', entering, closing));
      expect(closed).toBe(false);
      expect((await fs.stat(workers[0].cwd)).isDirectory()).toBe(true);
    } finally { release(); await closing; }
    await expect(fs.lstat(workers[0].cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await fs.readFile(pointer, 'utf8')).threadId).toBe('fixture-conversation');
    expect(await gitPhase('inspect idle-close receipt', () => manager.workspaceManager.describe(first.taskId))).toMatchObject({ disposition: 'applied' });
    const nextScope = manager.begin({ ...parent, messageId: 'next-parent' });
    const next = await startExecuting(nextScope, 'recreated');
    await gitPhase('recreate the idle-closed lane with its existing conversation', async () => {
      expect(workers[1].cwd).toBe(workers[0].cwd);
      expect(factory.mock.calls[1][3]).toBe(factory.mock.calls[0][3]);
      workers[1].finish({ success: true });
      return next;
    });
    await result(nextScope, next.taskId, 'next-result');
  }, phaseBudget(20));

  it('defers close-time recognition when another owner holds the delivery workspace', async () => {
    const scope = manager.begin(parent);
    const first = await startExecuting(scope, 'first');
    await fs.writeFile(path.join(workers[0].cwd, 'source.txt'), 'deferred handoff\n');
    workers[0].finish({ success: true });
    const completed = await result(scope, first.taskId, 'first-result');
    await gitPhase('fixture Git merge', () => runGit(fixture.root, ['merge', '--ff-only', completed.artifact!.outputCommit]));
    const otherScope = manager.begin({ ...parent, thread: { ...parent.thread, id: 'other-owner' } });
    const other = await startExecuting(otherScope, 'independent');
    await closeScope(scope);
    expect(await gitPhase('describe fixture state', () => manager.workspaceManager.describe(first.taskId))).toMatchObject({ disposition: 'pending' });
    expect((await fs.stat(workers[0].cwd)).isDirectory()).toBe(true);
    workers[1].finish({ success: true });
    await result(otherScope, other.taskId, 'other-result');
  }, phaseBudget(15));

  it('defers close-time recognition instead of waiting for an unfinished discovery admission', async () => {
    const scope = manager.begin(parent);
    const first = await startExecuting(scope, 'first');
    await fs.writeFile(path.join(workers[0].cwd, 'source.txt'), 'discovery handoff\n');
    workers[0].finish({ success: true });
    const completed = await result(scope, first.taskId, 'first-result');
    await gitPhase('fixture Git merge', () => runGit(fixture.root, ['merge', '--ff-only', completed.artifact!.outputCommit]));
    const available = await manager.registry.get('agy', parent.config);
    let release!: (value: typeof available) => void;
    vi.spyOn(manager.registry, 'get').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const starting = start(scope, 'discovering', 'agy');
    const failure = expect(starting).rejects.toThrow('ended');
    const reconciliation = vi.spyOn(manager.workspaceManager, 'reconcileHistoricalDelivery');
    // Enter the admission's probe wait; cancellation before admission starts is already idle.
    await new Promise<void>(resolve => setImmediate(resolve));
    try {
      await closeScope(scope);
      expect(reconciliation).not.toHaveBeenCalled();
      expect(await gitPhase('describe fixture state', () => manager.workspaceManager.describe(first.taskId))).toMatchObject({ disposition: 'pending' });
    } finally { release(available); await failure; }
    expect(workers).toHaveLength(1);
    expect((await fs.stat(workers[0].cwd)).isDirectory()).toBe(true);
  }, phaseBudget(10));

  it('waits for native exit before reclaiming a successful no-change checkout', async () => {
    const scope = manager.begin(parent);
    const first = await startExecuting(scope, 'first');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const entering = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(workers[0].executor.waitForExit!).mockImplementation(() => { entered(); return gate; });
    workers[0].finish({ success: true, output: 'No changes' });
    try {
      await gitPhase('enter native exit confirmation', () => awaitEntry('native exit', entering, trackCall(scope.collectPendingResults())));
      expect(workers[0].executor.waitForExit).toHaveBeenCalled();
      expect((await fs.lstat(workers[0].cwd)).isDirectory()).toBe(true);
    } finally { release(); }
    expect(await result(scope, first.taskId, 'r1')).toMatchObject({ state: 'succeeded', artifact: { disposition: 'applied' } });
    await expect(fs.lstat(workers[0].cwd)).rejects.toMatchObject({ code: 'ENOENT' });
  }, phaseBudget(7));

  it.each(['failed', 'cancelled'])('reclaims a %s no-change checkout', async outcome => {
    const scope = manager.begin(parent);
    const first = await startExecuting(scope, 'first');
    if (outcome === 'failed') workers[0].finish({ success: false, error: 'Fixture failure' });
    else await gitPhase('remote_cli_cancel fixture state', () => scope.invoke('remote_cli_cancel', { taskId: first.taskId }, 'cancel'));
    expect(await result(scope, first.taskId, 'r1')).toMatchObject({ state: outcome, artifact: { disposition: 'applied' } });
    expect(await gitPhase('describe fixture state', () => manager.workspaceManager.describe(first.taskId))).toMatchObject({ successful: false });
    await expect(fs.lstat(workers[0].cwd)).rejects.toMatchObject({ code: 'ENOENT' });
  }, phaseBudget(8));

  it.each([false, true])('settles gated reclamation even after an early assertion failure (earlyFailure=%s)', async earlyFailure => {
    const scope = manager.begin(parent);
    const first = await startExecuting(scope, 'first');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const entering = new Promise<void>(resolve => { entered = resolve; });
    const reclaim = vi.spyOn(manager.workspaceManager, 'reclaim').mockImplementation(async () => { entered(); await gate; return false; });
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
        await gitPhase('enter gated reclamation', () => awaitEntry('reclamation', entering, trackCall(scope.collectPendingResults())));
        expect(reclaim).toHaveBeenCalledWith(first.taskId);
        expect((await gitPhase('lanesForThread fixture state', () => manager.laneStore.lanesForThread(parent.thread.id)))[0].state).toBe('running');
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
        await closeScope(scope);
      }
    };
    if (earlyFailure) await expect(exercise()).rejects.toBe(assertionFailure);
    else await exercise();
    expect((await gitPhase('lanesForThread fixture state', () => manager.laneStore.lanesForThread(parent.thread.id))).every(lane => lane.state === 'ready')).toBe(true);
    expect((await fs.lstat(workers[0].cwd)).isDirectory()).toBe(true);
  }, phaseBudget(16));

  it.each([false, true])('admits a different lane during byte verification and drains a released gate (earlyFailure=%s)', async earlyFailure => {
    const scope = manager.begin(parent);
    let entered!: () => void;
    const verifying = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    let released = false;
    const gate = new Promise<void>(resolve => { release = () => { released = true; resolve(); }; });
    const first = await startExecuting(scope, 'first');
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
        await gitPhase('reach full byte verification', () => awaitEntry('byte verification', verifying, trackCall(scope.collectPendingResults())));
        if (earlyFailure) throw assertionFailure;
        following = startExecuting(scope, 'follower');
        await following;
        expect(released).toBe(false);
        expect(workers).toHaveLength(2);
        expect(workers[1].cwd).not.toBe(workers[0].cwd);
      } finally {
        release();
        // Track collection before teardown, including any unfinished admission.
        await (async () => {
          try { if (following) await following; }
          finally { workers.forEach(worker => worker.finish({ success: true })); }
          const terminal = await collectAll(scope);
          expect(terminal).toHaveLength(earlyFailure ? 1 : 2);
          expect(terminal.every(task => task.state === 'succeeded')).toBe(true);
        })();
      }
    };
    if (earlyFailure) await expect(exercise()).rejects.toBe(assertionFailure);
    else await exercise();
    expect(released).toBe(true);
    expect(await result(scope, first.taskId, 'r1')).toMatchObject({ state: 'succeeded' });
    if (following) expect(await result(scope, (await following).taskId, 'r2')).toMatchObject({ state: 'succeeded' });
  }, phaseBudget(14));

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
      const oldLane = (await gitPhase('lanesForThread fixture state', () => manager.laneStore.lanesForThread(parent.thread.id)))[0];
      if (condition === 'occupied') {
        await fs.mkdir(oldCwd);
        await fs.writeFile(path.join(oldCwd, 'retained.txt'), 'do not overwrite\n');
      } else if (condition === 'partial-registration') {
        const artifact = await gitPhase('describe fixture state', () => manager.workspaceManager.describe(first.taskId));
        await gitPhase('fixture Git worktree', () => runGit(fixture.root, ['worktree', 'add', '--detach', oldCwd, artifact!.outputCommit]));
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
      expect((await gitPhase('lanesForThread fixture state', () => manager.laneStore.lanesForThread(parent.thread.id)))[0]).toMatchObject({
        id: oldLane.id, state: 'dirty', cleanupPending: false,
      });
      expect((await gitPhase('unavailableLanes fixture state', () => manager.workspaceManager.unavailableLanes())).has(oldLane.id)).toBe(true);
      await gitPhase('reconcilePendingWorkerLanes fixture state', () => manager.reconcilePendingWorkerLanes());
      expect(await fs.readFile(pointer, 'utf8')).toBe(saved);
      const recovered = await startExecuting(scope, 'independent-lane');
      expect(factory.mock.calls[1][3]).not.toBe(executorId);
      expect(workers[1].cwd).not.toBe(oldCwd);
      if (condition === 'occupied') expect(await fs.readFile(path.join(oldCwd, 'retained.txt'), 'utf8')).toBe('do not overwrite\n');
      workers[1].finish({ success: true });
      expect(await result(scope, recovered.taskId, 'r3')).toMatchObject({ state: 'succeeded' });
    }, phaseBudget(23));

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
  }, phaseBudget(12));

  // These multi-turn cases need separate deadlines for each real-Git phase.
  // Preserve the 30-second phase limit; the outer budgets cover their sum.
  it('pools same-target conversations without reusing pending artifacts or routing ambiguous input', async () => {
    const scope = manager.begin(parent);
    const [first, second] = await Promise.all([startExecuting(scope, 'first'), startExecuting(scope, 'second')]);
    expect([first.state, second.state]).toEqual(['running', 'running']);
    workers.forEach(worker => { worker.executor.isWaitingInput = () => true; });
    expect(manager.hasAmbiguousInput(parent.thread.id)).toBe(true);
    expect(scope.waitingExecutor()).toBeUndefined();
    workers[1].executor.isWaitingInput = () => false;
    expect(scope.waitingExecutor()).toBe(workers[0].executor);
    await fs.writeFile(path.join(workers[0].cwd, 'pending.txt'), 'pending result\n');
    workers.forEach(worker => worker.finish({ success: true }));
    await collectAll(scope);
    const third = await startExecuting(scope, 'third');
    expect(third.state).toBe('running');
    expect(workers[2].cwd).toBe(workers[1].cwd);
    expect(workers[2].cwd).not.toBe(workers[0].cwd);
    expect(factory.mock.calls[2][3]).toBe(factory.mock.calls[1][3]);
    expect(factory.mock.calls[2][3]).not.toBe(factory.mock.calls[0][3]);
    expect((await gitPhase('lanesForThread fixture state', () => manager.laneStore.lanesForThread(parent.thread.id))).some(lane => lane.state === 'dirty')).toBe(false);
    const completed = await finishAndReclaim(scope, third.taskId, () => workers[2].finish({ success: true }));
    expect(completed.find(task => task.taskId === third.taskId)).toMatchObject({ state: 'succeeded', artifact: { disposition: 'applied' } });
    expect(await fs.readFile(path.join(workers[0].cwd, 'pending.txt'), 'utf8')).toBe('pending result\n');
  }, phaseBudget(16));

  it('returns an untouched reused lane to ready when baseline capture fails', async () => {
    const scope = manager.begin(parent);
    const first = await startExecuting(scope, 'first');
    expect(first.state).toBe('running');
    const executorId = factory.mock.calls[0][3];
    const pointer = path.join(fixture.directory, '.remote-cli', 'codex-sessions', `${executorId}.json`);
    await fs.mkdir(path.dirname(pointer), { recursive: true });
    await fs.writeFile(pointer, 'retained context');
    workers[0].finish({ success: true });
    await collectAll(scope);
    const lane = (await gitPhase('lanesForThread fixture state', () => manager.laneStore.lanesForThread(parent.thread.id)))[0];
    const savedPath = path.join(fixture.directory, '.remote-cli', 'delegation-workspaces', 'lanes', `${lane.id}.json`);
    const saved = await fs.readFile(savedPath, 'utf8');
    const prepare = vi.spyOn(manager.workspaceManager, 'prepare');
    vi.spyOn(manager.workspaceManager, 'baseline').mockRejectedValueOnce(new Error('Synthetic baseline failure'));
    const accepted = await start(scope, 'failed-baseline');
    const failed = await result(scope, accepted.taskId, 'failed-baseline-result');
    expect(failed).toMatchObject({ state: 'failed' });
    expect(prepare).not.toHaveBeenCalled();
    expect(await fs.readFile(savedPath, 'utf8')).toBe(saved);
    expect((await gitPhase('lanesForThread fixture state', () => manager.laneStore.lanesForThread(parent.thread.id)))[0]).toMatchObject({ id: lane.id, state: 'ready' });
    expect((await gitPhase('unavailableLanes fixture state', () => manager.workspaceManager.unavailableLanes())).has(lane.id)).toBe(false);
    expect(await fs.readFile(pointer, 'utf8')).toBe('retained context');
    const next = await startExecuting(scope, 'retry-baseline');
    expect(next.state).toBe('running');
    expect(factory.mock.calls[1][3]).toBe(executorId);
    workers[1].finish({ success: true });
    expect(await collectAll(scope))
      .toEqual(expect.arrayContaining([expect.objectContaining({ taskId: next.taskId, state: 'succeeded' })]));
  }, phaseBudget(18));

  it('retains a prepared lane on executor setup failure without blaming checkout preparation', async () => {
    const scope = manager.begin(parent);
    const first = await startExecuting(scope, 'first');
    workers[0].finish({ success: true });
    await result(scope, first.taskId, 'first-result');
    const lane = (await gitPhase('lanesForThread fixture state', () => manager.laneStore.lanesForThread(parent.thread.id)))[0];
    factory.mockImplementationOnce(() => { throw new Error('Synthetic executor failure'); });
    const failed = await start(scope, 'factory-failure');
    expect(await result(scope, failed.taskId, 'failed-result')).toMatchObject({ state: 'failed' });
    expect((await gitPhase('lanesForThread fixture state', () => manager.laneStore.lanesForThread(parent.thread.id)))[0]).toMatchObject({
      id: lane.id, state: 'dirty', cleanupPending: false,
      cleanupError: expect.stringContaining('Worker process setup did not complete'),
    });
    expect((await gitPhase('unavailableLanes fixture state', () => manager.workspaceManager.unavailableLanes())).has(lane.id)).toBe(true);
    expect(await gitPhase('cleanupCandidates fixture state', () => manager.laneStore.cleanupCandidates())).toEqual([]);
  }, phaseBudget(14));

  describe('missing native session replacement', () => {
    let scope: ReturnType<DelegationManager['begin']>;

    beforeEach(async () => {
      scope = manager.begin(parent);
      // Warm both lanes before completing either worker so this is not one reused lane.
      // Admissions, execution entry, native operations and terminal reads are bounded separately.
      const first = await startInPhases(scope, 'warm-first');
      const second = await startInPhases(scope, 'warm-second');
      expect(first.state).toBe('running');
      expect(second.state).toBe('running');
      workers[0].finish({ success: true });
      workers[1].finish({ success: true });
      expect(await collectFinished(scope, first.taskId, 'first-result')).toMatchObject({ state: 'succeeded' });
      expect(await collectFinished(scope, second.taskId, 'second-result')).toMatchObject({ state: 'succeeded' });
      const lanes = await gitPhase('lanesForThread fixture state', () => manager.laneStore.lanesForThread(parent.thread.id));
      expect(lanes).toHaveLength(2);
      expect(new Set(lanes.map(lane => lane.executorThreadId)).size).toBe(2);
      expect(lanes.every(lane => lane.state === 'ready')).toBe(true);
    }, phaseBudget(13));

    // The replacement and subsequent reuse each retain their own bounded lifecycle steps.
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
      const healthy = (await gitPhase('lanesForThread fixture state', () => manager.laneStore.lanesForThread(parent.thread.id))).find(lane => lane.executorThreadId === healthyId);
      expect(healthy).toMatchObject({ state: 'ready', cleanupPending: false });
      expect((await gitPhase('unavailableLanes fixture state', () => manager.workspaceManager.unavailableLanes())).has(healthy!.id)).toBe(false);
      parent.isWorkspaceBusy = () => false;
      const recovered = await startInPhases(scope, 'retry-after-busy');
      expect(factory.mock.calls[3][3]).toBe(healthyId);
      workers[3].finish({ success: true });
      expect(await collectFinished(scope, recovered.taskId, 'recovered-result')).toMatchObject({ state: 'succeeded' });
    }, phaseBudget(15));
  });

  // Two admissions/executions, two native lifecycles/terminal reads, an edit and an input check.
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
  }, phaseBudget(14));

  it('collects cancelled same-backend edits for recovery without modifying the coordinator and rejects foreign integration', async () => {
    const scope = manager.begin(parent);
    const first = await startExecuting(scope, 'first', parent.backend);
    await gitPhase('prepare and edit the cancellation worker', async () => {
      await fs.writeFile(path.join(workers[0].cwd, 'partial.txt'), 'partial output\n');
      return first;
    });
    await gitPhase('request worker cancellation', () => scope.invoke('remote_cli_cancel', { taskId: first.taskId }, 'cancel'));
    expect(await result(scope, first.taskId, 'completed-cancellation')).toMatchObject({
      state: 'cancelled', artifact: { disposition: 'retained' } });
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
    await closeScope(other);
  }, phaseBudget(14));

  it('fails closed on damaged Git metadata instead of starting shared-directory workers', async () => {
    await gitPhase('fixture Git symbolic-ref', () => runGit(fixture.root, ['symbolic-ref', 'HEAD', 'refs/heads/unborn']));
    const scope = manager.begin(parent);
    await expect(start(scope, 'unborn')).rejects.toThrow('Git rev-parse failed');
    expect(factory).not.toHaveBeenCalled();
  }, phaseBudget(2));

  it('waits for native cleanup and collection before checking artifact closeout', async () => {
    const scope = manager.begin(parent);
    await startExecuting(scope, 'cleanup');
    let release!: () => void;
    let entered!: () => void;
    const entering = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(workers[0].executor.destroy).mockImplementation(() => new Promise<void>(resolve => { release = resolve; entered(); }));
    workers[0].finish({ success: true });
    scope.finishExecution(true);
    let settled = false;
    const checking = checkCloseout(scope).finally(() => { settled = true; });
    try {
      await gitPhase('enter the cleanup gate', () => awaitEntry('cleanup gate', entering, checking));
      expect(release).toBeTypeOf('function');
      expect(settled).toBe(false);
    } finally {
      // A late destroy invocation must not acquire a new unresolved gate.
      vi.mocked(workers[0].executor.destroy).mockResolvedValue(undefined);
      release?.();
      await checking;
    }
    expect(await checking).toEqual([]);
  }, phaseBudget(6));

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
    expect(await checkCloseout(scope)).toEqual([{ taskId: task.taskId, backend: 'codex', status: 'unavailable' }]);
    expect(reconciliation).not.toHaveBeenCalled();
    expect(await gitPhase('describe fixture state', () => manager.workspaceManager.describe(task.taskId))).toMatchObject({ disposition: 'pending' });
    busy.mockReturnValue(false);
    expect(await checkCloseout(scope)).toEqual([{ taskId: task.taskId, backend: 'codex', status: 'pending', outputCommit: done.artifact!.outputCommit }]);
  }, phaseBudget(9));

  it.each(['no-change', 'apply', 'retain'])(
    'accepts validated %s receipts while another thread is busy without reconciling history', async disposition => {
      const scope = manager.begin(parent);
      const task = await startExecuting(scope, 'delivered');
      if (disposition !== 'no-change') await fs.writeFile(path.join(workers[0].cwd, 'source.txt'), 'delivered output\n');
      workers[0].finish({ success: true });
      await result(scope, task.taskId, 'done');
      if (disposition !== 'no-change') {
        const inspected: any = await gitPhase('remote_cli_integrate fixture state', () => scope.invoke('remote_cli_integrate', { taskId: task.taskId, action: 'inspect' }, 'inspect'));
        await gitPhase('remote_cli_integrate fixture state', () => scope.invoke('remote_cli_integrate', {
          taskId: task.taskId, action: disposition, expectedRevision: inspected.revision,
        }, 'integrate'));
      }
      scope.finishExecution(true);
      parent.isWorkspaceBusy = () => true;
      const reconcile = vi.spyOn(manager.workspaceManager, 'reconcileHistoricalDelivery');
      expect(await checkCloseout(scope)).toEqual([]);
      expect(reconcile).not.toHaveBeenCalled();
    }, phaseBudget(9));

  it('does not take another active scope lease to validate an already settled receipt', async () => {
    const scope = manager.begin(parent);
    const task = await startExecuting(scope, 'delivered');
    workers[0].finish({ success: true });
    await result(scope, task.taskId, 'done');
    scope.finishExecution(true);
    const sibling = manager.begin({ ...parent, thread: { ...parent.thread, id: 'another-thread' } });
    const active = await startExecuting(sibling, 'active');
    expect(await checkCloseout(scope)).toEqual([]);
    expect(manager.blocksWorkspace(fixture.root, parent.thread.id)).toBe(true);
    workers[1].finish({ success: true });
    expect(await result(sibling, active.taskId, 'sibling-done')).toMatchObject({ state: 'succeeded' });
  }, phaseBudget(13));

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
      } else await gitPhase('fixture Git update-ref', () => runGit(fixture.root, ['update-ref', `refs/remote-cli/artifacts/${task.taskId}`, fixture.head]));
      parent.isWorkspaceBusy = () => true;
      expect(await checkCloseout(scope)).toEqual([{ taskId: task.taskId, backend: 'codex', status: 'unavailable' }]);
    }, phaseBudget(8));

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
    expect(await checkCloseout(scope)).toEqual([{ taskId: pending.taskId, backend: 'codex', status: 'unavailable' }]);
  }, phaseBudget(13));

  it('allows deliberate retention of recovery-bearing output without deleting recovery refs', async () => {
    const scope = manager.begin(parent);
    const task = await startExecuting(scope, 'recovery');
    await fs.writeFile(path.join(workers[0].cwd, 'source.txt'), 'recovery output\n');
    workers[0].finish({ success: true });
    await result(scope, task.taskId, 'done');
    const file = path.join(fixture.directory, '.remote-cli', 'delegation-workspaces', 'artifacts', `${task.taskId}.json`);
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    const recovery = { beforeRef: `refs/remote-cli/integrations/${task.taskId}/before`, targetRef: `refs/remote-cli/integrations/${task.taskId}/target` };
    await gitPhase('fixture Git update-ref', () => runGit(fixture.root, ['update-ref', recovery.beforeRef, saved.input.commit]));
    await gitPhase('fixture Git update-ref', () => runGit(fixture.root, ['update-ref', recovery.targetRef, saved.output]));
    await fs.writeFile(file, JSON.stringify({ ...saved, recovery }));
    scope.finishExecution(true);
    expect(await checkCloseout(scope)).toMatchObject([{ taskId: task.taskId, status: 'recovery' }]);
    scope.beginExecution();
    const view: any = await gitPhase('remote_cli_integrate fixture state', () => scope.invoke('remote_cli_integrate', { taskId: task.taskId, action: 'inspect' }, 'inspect-recovery'));
    await gitPhase('remote_cli_integrate fixture state', () => scope.invoke('remote_cli_integrate', { taskId: task.taskId, action: 'retain', expectedRevision: view.revision }, 'retain-recovery'));
    scope.finishExecution(true);
    expect(await checkCloseout(scope)).toEqual([]);
    expect(await gitPhase('fixture Git rev-parse', () => gitText(fixture.root, ['rev-parse', recovery.targetRef]))).toBe(saved.output);
    expect(await fs.readFile(path.join(workers[0].cwd, 'source.txt'), 'utf8')).toBe('recovery output\n');
  }, phaseBudget(13));

  it('serializes cancellation with an active closeout inspection without continuing after it', async () => {
    const scope = manager.begin(parent);
    const task = await startExecuting(scope, 'cancel-closeout');
    workers[0].finish({ success: true });
    await result(scope, task.taskId, 'done');
    scope.finishExecution(true);
    let release!: () => void;
    let entered!: () => void;
    const entering = new Promise<void>(resolve => { entered = resolve; });
    const inspect = manager.workspaceManager.inspectCloseout.bind(manager.workspaceManager);
    vi.spyOn(manager.workspaceManager, 'inspectCloseout').mockImplementation(async (...args) => {
      await new Promise<void>(resolve => { release = resolve; entered(); });
      return inspect(...args);
    });
    const checking = checkCloseout(scope);
    const rejected = expect(checking).rejects.toThrow('cancelled');
    let closing: Promise<void> | undefined;
    try {
      await gitPhase('enter active closeout inspection', () => awaitEntry('closeout inspection', entering, checking));
      expect(release).toBeTypeOf('function');
      closing = closeScope(scope);
    } finally {
      vi.mocked(manager.workspaceManager.inspectCloseout).mockImplementation(inspect);
      release?.();
      await Promise.allSettled([rejected, closing]);
    }
    await rejected;
    await closing;
    expect(scope.isClosed()).toBe(true);
  }, phaseBudget(9));
});
