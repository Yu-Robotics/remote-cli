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
import { DELEGATION_LIMITS, DelegationManager, type DelegationParent, type DelegatedTaskResult } from '../../src/delegation/DelegationManager';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { ThreadContextReset } from '../../src/thread/ThreadContextReset';
import type { ExecuteResult, IExecutor } from '../../src/executor/IExecutor';
import { gitFixture } from './gitFixture';
import { isTerminalTaskState } from '../../src/delegation/DelegationStore';

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
  let expectedShutdownFailure = false;
  let settlingFixture = false;
  let pendingPhases: Set<Promise<unknown>>;
  let phaseTimings: { name: string; elapsedMs: number }[];
  let phaseAdmissionClosed: boolean;
  type Scope = ReturnType<DelegationManager['begin']>;
  type NativeStep = { taskId: string; name: string; operation: Promise<unknown> };
  let listeners: Set<() => void>;
  let nativeSteps: NativeStep[];
  let scopeTasks: WeakMap<Scope, Set<string>>;
  let consumedSteps: WeakMap<Scope, Set<NativeStep>>;
  const notifyLifecycle = () => { for (const listener of listeners) listener(); };
  const trackOperation = <T>(operation: Promise<T>): Promise<T> => {
    pendingPhases.add(operation);
    void operation.then(() => pendingPhases.delete(operation), () => pendingPhases.delete(operation));
    return operation;
  };
  const makeManager = (disposalSupported = true) => {
    const workspace = new DelegatedWorkspaceManager(undefined, disposalSupported);
    const collect = workspace.collect.bind(workspace);
    const reclaim = workspace.reclaim.bind(workspace);
    // Observe the original promises, never return fixture deadline races to the runtime.
    // These plain forwarders also survive test-specific spies and mockRestore().
    workspace.collect = (task, ...args) => {
      const operation = trackOperation(collect(task, ...args));
      nativeSteps.push({ taskId: task.taskId, name: 'capture artifact', operation }); notifyLifecycle();
      return operation;
    };
    workspace.reclaim = (taskId, ...args) => {
      const operation = trackOperation(reclaim(taskId, ...args));
      nativeSteps.push({ taskId, name: 'reclaim checkout', operation }); notifyLifecycle();
      return operation;
    };
    return new DelegationManager(new DirectoryGuard([fixture.directory]), (_guard, _config, cwd) => {
      if (!cwd) throw new Error('Fixture worker requires a working directory');
      let finish!: (result: ExecuteResult) => void;
      const done = new Promise<ExecuteResult>(resolve => { finish = resolve; });
      const executor = { execute: vi.fn(() => { notifyLifecycle(); return done; }), abort: vi.fn(async () => true),
        destroy: vi.fn(async () => undefined), waitForExit: vi.fn(async () => undefined), waitForManagedProcessGroupExit: vi.fn(async () => undefined),
        resetContext: vi.fn(), getCurrentWorkingDirectory: () => cwd, setWorkingDirectory: vi.fn(),
      } as unknown as IExecutor;
      workers.push({ cwd, executor, finish });
      if (settlingFixture) finish({ success: false, error: 'Synthetic fixture teardown' });
      notifyLifecycle();
      return executor;
    }, new BackendRegistry(async () => 'fixture 1.0'), undefined, undefined, undefined, undefined,
      workspace);
  };
  beforeEach(async () => {
    expectedShutdownFailure = false;
    settlingFixture = false;
    pendingPhases = new Set();
    phaseTimings = [];
    phaseAdmissionClosed = false;
    listeners = new Set(); nativeSteps = []; scopeTasks = new WeakMap(); consumedSteps = new WeakMap();
    fixture = await gitFixture();
    vi.spyOn(os, 'homedir').mockReturnValue(fixture.directory);
    vi.stubEnv('HOME', fixture.directory);
    vi.stubEnv('USERPROFILE', fixture.directory);
    workers = [];
    manager = makeManager();
    parent = { thread: { id: 'fixture-owner', name: 'default', workingDirectory: fixture.root,
      sessionId: null, createdAt: 0, lastActiveAt: 0 }, cwd: fixture.root, messageId: 'message',
      backend: 'codex', config: { type: 'auto' }, onToolUse: vi.fn(), onToolResult: vi.fn(), onNotice: vi.fn(),
      onApproval: vi.fn(), onApprovalResolved: vi.fn() };
  });
  const settleFixture = async (): Promise<void> => {
    settlingFixture = true; notifyLifecycle();
    workers.forEach(worker => worker.finish({ success: false, error: 'Synthetic fixture teardown' }));
    // A deadline rejects the phase waiter, not its filesystem/Git operation.
    // Drain that operation before destroy can release storage ownership.
    while (pendingPhases.size) await Promise.allSettled([...pendingPhases]);
    if (expectedShutdownFailure) await expect(manager.destroy()).rejects.toThrow('storage ownership was retained');
    else await manager.destroy();
    while (pendingPhases.size) await Promise.allSettled([...pendingPhases]);
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

  // A drain waits for admitted work; tracking the drain itself would make it wait on itself.
  const lifecycleWait = async <T>(name: string | (() => string), operation: Promise<T>, timeoutMs = 30_000): Promise<T> => {
    const label = () => typeof name === 'string' ? name : name();
    const began = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          phaseAdmissionClosed = true;
          notifyLifecycle();
          reject(new Error(`Phase exceeded ${timeoutMs}ms`));
        }, timeoutMs);
      })]);
    } catch (error) {
      throw new Error(`Git lifecycle phase failed: ${label()}; elapsedMs=${Date.now() - began}; workers=${workers.length}; `
        + `completed=${JSON.stringify(phaseTimings)}; error=${error instanceof Error ? error.message : 'unknown'}`, { cause: error });
    } finally {
      clearTimeout(timer);
      phaseTimings.push({ name: label(), elapsedMs: Date.now() - began });
    }
  };

  const lifecyclePhase = <T>(name: string | (() => string), action: () => Promise<T>, timeoutMs = 30_000): Promise<T> => {
    if (settlingFixture || phaseAdmissionClosed) return Promise.reject(new Error('Fixture is draining; no new Git phases may start'));
    const operation = Promise.resolve().then(() => {
      if (settlingFixture || phaseAdmissionClosed) throw new Error('Fixture is draining; no new Git phases may start');
      return action();
    });
    trackOperation(operation);
    return lifecycleWait(name, operation, timeoutMs);
  };

  const awaitPhaseEntry = (name: string, entered: Promise<void>, phase: Promise<unknown>): Promise<void> => Promise.race([
    entered,
    phase.then(() => { throw new Error(`Git lifecycle phase finished before entry: ${name}`); }),
  ]);

  const lifecycleBudget = (steps: number) => steps * 30_000 + 5_000;
  const waitForSignal = async <T>(read: () => T | undefined): Promise<T> => {
    let listener!: () => void;
    try {
      return await new Promise<T>((resolve, reject) => {
        listener = () => {
          try {
            if (settlingFixture || phaseAdmissionClosed) throw new Error('Fixture is draining; no new lifecycle work may start');
            const value = read(); if (value !== undefined) resolve(value);
          } catch (error) { reject(error); }
        };
        listeners.add(listener); listener();
      });
    } finally { listeners.delete(listener); }
  };
  const watchOperation = <T>(pending: Promise<T>) => {
    const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
    const operation = trackOperation(pending);
    void operation.then(value => { state.value = value; state.settled = true; notifyLifecycle(); },
      error => { state.error = error; state.settled = true; notifyLifecycle(); });
    return { state, operation };
  };
  const watchTerminal = (scope: Scope) => watchOperation(scope.collectPendingResults());
  const launchExecuting = async (scope: Scope, args: Record<string, unknown>, callId: string): Promise<DelegatedTaskResult> => {
    const firstWorker = workers.length;
    let terminal!: ReturnType<typeof watchTerminal>;
    const task = await lifecyclePhase(`accept ${callId}`, () => {
      const accepted = scope.invoke('remote_cli_delegate', args, callId) as Promise<DelegatedTaskResult>;
      // Keep the admitted task tracked even if its tool response returns queued or
      // the execution waiter times out. Teardown must drain its actual finalization.
      terminal = watchTerminal(scope);
      return accepted;
    });
    const ids = scopeTasks.get(scope) ?? new Set<string>(); ids.add(task.taskId); scopeTasks.set(scope, ids);
    return lifecyclePhase(`execute ${callId}`, async () => {
      const failed = (value?: DelegatedTaskResult) => new Error(`Fixture task ${callId} ended before execution: ${value?.state}; ${value?.error ?? ''}`);
      if (isTerminalTaskState(task.state)) throw failed(task);
      await waitForSignal(() => {
        if (terminal.state.error) throw terminal.state.error;
        if (terminal.state.value) throw failed(terminal.state.value.find(value => value.taskId === task.taskId));
        // Fixture launches are serial; observe the new executor's entry, including
        // prompts which carry required-export instructions after the objective.
        return workers.slice(firstWorker).find(worker => vi.mocked(worker.executor.execute).mock.calls.length > 0);
      });
      const running = await scope.invoke('remote_cli_result', { taskId: task.taskId, waitSeconds: 0 }, `${callId}-executing`) as DelegatedTaskResult;
      if (running.state !== 'running') throw failed(running);
      return running;
    });
  };
  const settleFinalization = async <T>(scope: Scope, terminal: ReturnType<typeof watchOperation<T>>, name: string): Promise<T> => {
    const consumed = consumedSteps.get(scope) ?? new Set<NativeStep>(); consumedSteps.set(scope, consumed);
    for (;;) {
      let label = `wait for finalization ${name}`;
      const result = await lifecyclePhase(() => label, async () => {
        const next = await waitForSignal(() => {
          const step = nativeSteps.find(value => scopeTasks.get(scope)?.has(value.taskId) && !consumed.has(value));
          if (step) return { step };
          if (terminal.state.error) throw terminal.state.error;
          if (terminal.state.settled) return { value: terminal.state.value as T };
          return undefined;
        });
        if ('value' in next) return next;
        consumed.add(next.step); label = `${next.step.name} ${name}`;
        // Native failures are classified by the manager and asserted from its final
        // result. Observe settlement without replacing its promise or inventing success.
        await Promise.allSettled([next.step.operation]);
        return undefined;
      });
      if (result) return result.value!;
    }
  };
  const collectResults = (scope: Scope, name = 'worker'): Promise<DelegatedTaskResult[]> => {
    if (settlingFixture || phaseAdmissionClosed) return Promise.reject(new Error('Fixture is draining; no new collection may start'));
    return settleFinalization(scope, watchTerminal(scope), name);
  };

  it.each(['execute', 'setup failure', 'teardown', 'deadline'] as const)(
    'distinguishes queued acceptance from execution and drains delayed preparation (%s)', async completion => {
      const scope = manager.begin(parent);
      let entered!: () => void, release!: () => void, received!: (task: DelegatedTaskResult) => void;
      const preparing = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const acceptance = new Promise<DelegatedTaskResult>(resolve => { received = resolve; });
      const prepare = manager.workspaceManager.prepare.bind(manager.workspaceManager);
      vi.spyOn(manager.workspaceManager, 'prepare').mockImplementationOnce(async (...args) => {
        entered(); await gate;
        if (completion === 'setup failure') throw new Error('Synthetic delayed preparation failure');
        return prepare(...args);
      });
      const invoke = scope.invoke.bind(scope);
      const calls = vi.spyOn(scope, 'invoke').mockImplementation(async (...args) => {
        const value = await invoke(...args);
        if (args[0] === 'remote_cli_delegate') received(value as DelegatedTaskResult);
        return value;
      });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let settled = false;
      const starting = launchExecuting(scope, { backend: 'codex', objective: 'Held fixture setup' }, 'delayed');
      const outcome = starting.then(value => { settled = true; return { value, error: undefined }; },
        error => { settled = true; return { value: undefined, error }; });
      let shutdown: Promise<void> | undefined;
      const releaseOwnership = vi.spyOn(DelegationOwnership.prototype, 'release');
      try {
        await awaitPhaseEntry('delayed preparation', preparing, starting);
        await vi.advanceTimersByTimeAsync(DELEGATION_LIMITS.toolResponseWaitMs + 1);
        expect(await acceptance).toMatchObject({ state: 'queued' });
        expect(workers).toHaveLength(0); expect(settled).toBe(false);
        if (completion === 'deadline') {
          await vi.advanceTimersByTimeAsync(30_001);
          expect((await outcome).error).toMatchObject({ cause: { message: 'Phase exceeded 30000ms' } });
          const count = calls.mock.calls.length;
          await expect(launchExecuting(scope, { backend: 'codex', objective: 'Too late' }, 'late')).rejects.toThrow('Fixture is draining');
          await expect(collectResults(scope)).rejects.toThrow('Fixture is draining');
          expect(calls.mock.calls.length).toBe(count);
        }
        vi.useRealTimers();
        if (completion === 'teardown' || completion === 'deadline') {
          shutdown = settleFixture();
          expect(releaseOwnership).not.toHaveBeenCalled();
          expect(pendingPhases.size).toBeGreaterThan(0);
          expect((await fs.stat(fixture.directory)).isDirectory()).toBe(true);
        }
        release();
        const result = await lifecycleWait('finish the admitted delayed setup', outcome);
        if (completion === 'execute') {
          expect(result.value).toMatchObject({ state: 'running' });
          expect(workers[0].executor.execute).toHaveBeenCalledOnce();
          workers[0].finish({ success: true });
          expect((await collectResults(scope))[0].state).toBe('succeeded');
        } else {
          expect(result.error).toBeInstanceOf(Error);
          expect(result.error.message).toContain(completion === 'setup failure'
            ? 'Synthetic delayed preparation failure' : completion === 'deadline' ? 'Phase exceeded 30000ms' : 'Fixture is draining');
          if (completion === 'setup failure') expect(workers).toHaveLength(0);
        }
        if (shutdown) await lifecycleWait('drain delayed preparation before release', shutdown);
      } finally {
        vi.useRealTimers(); release();
        await Promise.allSettled([starting, shutdown ?? settleFixture()]);
      }
      expect(pendingPhases.size).toBe(0); expect(listeners.size).toBe(0);
    }, lifecycleBudget(6));

  it.each(['resolve', 'reject'] as const)('keeps collection terminal and drains original native operations after late %s', async completion => {
    const scope = manager.begin(parent);
    const task = await launchExecuting(scope, { backend: 'codex', objective: 'Observe terminal collection' }, 'terminal');
    const ownership = `${manager.laneStore.storageDirectory}.ownership`;
    const marker = path.join(fixture.directory, 'native-operation-settled');
    let enteredCapture!: () => void, releaseCapture!: () => void, enteredReclaim!: () => void, releaseReclaim!: () => void;
    const capturing = new Promise<void>(resolve => { enteredCapture = resolve; });
    const captureGate = new Promise<void>(resolve => { releaseCapture = resolve; });
    const reclaiming = new Promise<void>(resolve => { enteredReclaim = resolve; });
    const reclaimGate = new Promise<void>(resolve => { releaseReclaim = resolve; });
    const workspaceManager = manager.workspaceManager as any;
    const verify = workspaceManager.verifyCheckout.bind(workspaceManager);
    let checks = 0;
    vi.spyOn(workspaceManager, 'verifyCheckout').mockImplementation(async (...args) => {
      if (++checks === 1) {
        enteredCapture(); await captureGate;
        expect((await fs.lstat(ownership)).isFile()).toBe(true);
        await fs.writeFile(marker, 'native capture settled under ownership');
        if (completion === 'reject') throw new Error('Synthetic late native rejection');
      } else if (checks === 2) { enteredReclaim(); await reclaimGate; }
      return verify(...args);
    });
    const releaseOwnership = vi.spyOn(DelegationOwnership.prototype, 'release');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    workers[0].finish({ success: true });
    const polling = trackOperation(scope.invoke('remote_cli_result', { taskId: task.taskId, waitSeconds: 25 }, 'poll') as Promise<DelegatedTaskResult>);
    let settled = false;
    const collecting = collectResults(scope, 'gated native task');
    const outcome = collecting.then(value => { settled = true; return { value, error: undefined }; },
      error => { settled = true; return { value: undefined, error }; });
    let shutdown: Promise<void> | undefined;
    try {
      await awaitPhaseEntry('native capture', capturing, collecting);
      if (completion === 'resolve') {
        await vi.advanceTimersByTimeAsync(16_000); releaseCapture();
        await awaitPhaseEntry('native reclamation', reclaiming, collecting);
        await vi.advanceTimersByTimeAsync(9_001);
        expect(await polling).toMatchObject({ state: 'running' });
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(7_000);
        expect(settled).toBe(false); // Two distinct native units may exceed 30 seconds together.
        vi.useRealTimers(); releaseReclaim();
        const results = await lifecycleWait('complete released native operations', collecting);
        expect(results[0]).toMatchObject({ state: 'succeeded', artifact: { disposition: 'applied' } });
        await expect(fs.stat(workers[0].cwd)).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        await vi.advanceTimersByTimeAsync(30_001);
        expect((await outcome).error).toMatchObject({ cause: { message: 'Phase exceeded 30000ms' } });
        expect((await outcome).error.message).toContain('capture artifact gated native task');
        await expect(collectResults(scope)).rejects.toThrow('Fixture is draining');
        vi.useRealTimers();
        let drained = false;
        shutdown = settleFixture().then(() => { drained = true; });
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(drained).toBe(false); expect(releaseOwnership).not.toHaveBeenCalled();
        expect((await fs.stat(fixture.directory)).isDirectory()).toBe(true);
        releaseCapture();
        await lifecycleWait('drain the rejected native operation', shutdown);
        expect(await fs.readFile(marker, 'utf8')).toBe('native capture settled under ownership');
        expect(releaseOwnership).toHaveBeenCalledOnce();
      }
    } finally {
      vi.useRealTimers(); releaseCapture(); releaseReclaim();
      await Promise.allSettled([polling, collecting, shutdown ?? settleFixture()]);
    }
    expect(pendingPhases.size).toBe(0); expect(listeners.size).toBe(0);
  }, lifecycleBudget(6));

  // Ownership preparation, admitted collection and in-test teardown each keep a
  // 30-second boundary. The outer watchdog covers their sum plus assertion overhead.
  it.each(['assertion', 'deadline'] as const)('drains unfinished phase work before fixture ownership release after a %s failure', async failure => {
    await lifecyclePhase('reconcile fixture ownership before gated collection', () => manager.reconcilePendingWorkerLanes());
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
    await awaitPhaseEntry('gated result collection', operationStarted, collecting);
    const exercise = (async () => {
      try {
        if (failure === 'deadline') await collecting;
        else expect(workers).toHaveLength(1);
      } finally {
        const shutdown = lifecycleWait('drain gated collection and release fixture ownership', settleFixture());
        entered();
        await shutdown;
      }
    })().catch(error => error as Error);
    await awaitPhaseEntry('fixture drain', started, exercise);
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
  }, 3 * 30_000 + 5_000);

  it.each(['resolve', 'reject'] as const)('blocks lifecycle admission after a deadline while late work %ss under ownership', async completion => {
    await lifecyclePhase('reconcile fixture ownership before the admission deadline', () => manager.reconcilePendingWorkerLanes());
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
      await awaitPhaseEntry('held lifecycle operation', started, running);
      await vi.advanceTimersByTimeAsync(30_001);
      expect(await outcome).toMatchObject({ cause: { message: 'Phase exceeded 30000ms' } });
      const later = vi.fn(async () => undefined);
      await expect(lifecyclePhase('must not integrate after deadline', later)).rejects.toThrow('Fixture is draining');
      expect(later).not.toHaveBeenCalled();
      vi.useRealTimers();
      shutdown = lifecycleWait('drain the expired operation and release fixture ownership', settleFixture());
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
  }, 3 * 30_000 + 5_000);

  it.each(['resolve', 'reject'] as const)('rejects an entry waiter when a lifecycle phase %ss without signalling entry', async completion => {
    const entered = new Promise<void>(() => undefined);
    const phase = lifecyclePhase('missing entry signal', async () => {
      if (completion === 'reject') throw new Error('Synthetic failure before entry');
    });
    let settled = false;
    let error: unknown;
    const entering = awaitPhaseEntry('missing entry signal', entered, phase)
      .catch(cause => { error = cause; }).finally(() => { settled = true; });
    await Promise.allSettled([phase]);
    // All promise reactions must finish before the next event-loop turn. A missing
    // signal must fail promptly instead of stranding the test until its watchdog.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(true);
    await entering;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(completion === 'reject'
      ? 'Git lifecycle phase failed: missing entry signal' : 'finished before entry: missing entry signal');
    expect(pendingPhases.size).toBe(0);
  });

  it('does not enter a scheduled lifecycle phase once teardown has begun', async () => {
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const action = vi.fn(async () => { entered(); });
    const scheduled = lifecyclePhase('scheduled before teardown', action);
    const outcome = scheduled.catch(error => error);
    const entering = awaitPhaseEntry('scheduled before teardown', started, scheduled).catch(error => error);
    const shutdown = settleFixture();
    try {
      expect(await outcome).toBeInstanceOf(Error);
      expect(await entering).toBeInstanceOf(Error);
      expect(action).not.toHaveBeenCalled();
    } finally { await Promise.allSettled([scheduled, shutdown]); }
  });

  it('waits for managed group confirmation after direct transport exit before collecting or deleting', async () => {
    const scope = manager.begin(parent);
    await launchExecuting(scope, { backend: 'codex', objective: 'Inspect' }, 'launch');
    let confirm!: () => void, entered!: () => void;
    const proof = new Promise<void>(resolve => { confirm = resolve; });
    const proving = new Promise<void>(resolve => { entered = resolve; });
    const group = vi.mocked(workers[0].executor.waitForManagedProcessGroupExit!)
      .mockImplementation(() => { entered(); return proof; });
    workers[0].finish({ success: true });
    try {
      await lifecyclePhase('enter managed group proof', () => awaitPhaseEntry('managed group proof', proving, watchTerminal(scope).operation));
      expect(group).toHaveBeenCalled();
      expect((await fs.stat(workers[0].cwd)).isDirectory()).toBe(true);
      expect((await lifecyclePhase('enumerateArtifacts fixture state', () => manager.workspaceManager.enumerateArtifacts())).items[0].disposition).toBeUndefined();
    } finally { confirm(); }
    expect((await collectResults(scope))[0].state).toBe('succeeded');
    await expect(fs.stat(workers[0].cwd)).rejects.toHaveProperty('code', 'ENOENT');
  }, lifecycleBudget(7));

  it.each(['missing', 'rejected'])('preserves the checkout when group-exit evidence is %s', async failure => {
    const scope = manager.begin(parent);
    await launchExecuting(scope, { backend: 'codex', objective: 'Inspect' }, 'launch');
    if (failure === 'missing') workers[0].executor.waitForManagedProcessGroupExit = undefined;
    else vi.mocked(workers[0].executor.waitForManagedProcessGroupExit!).mockRejectedValue(new Error('Unconfirmed descendant'));
    expectedShutdownFailure = true;
    workers[0].finish({ success: true });
    expect((await collectResults(scope))[0].state).toBe('interrupted');
    expect((await fs.stat(workers[0].cwd)).isDirectory()).toBe(true);
    expect(manager.blocksWorkspace(fixture.root, 'other')).toBe(true);
    const [lane] = await manager.laneStore.lanesForThread(parent.thread.id);
    expect(lane.shutdownConfirmedGeneration).toBeUndefined();
    await expect(manager.laneStore.assertThreadContextResettable(parent.thread.id)).rejects.toThrow('unconfirmed');
  }, lifecycleBudget(3));

  it('keeps unsupported-platform delegation working under conservative checkout rules', async () => {
    await lifecyclePhase('destroy fixture state', () => manager.destroy());
    manager = makeManager(false);
    const scope = manager.begin(parent);
    await launchExecuting(scope, { backend: 'codex', objective: 'Inspect' }, 'launch');
    workers[0].executor.waitForManagedProcessGroupExit = undefined;
    await fs.mkdir(path.join(workers[0].cwd, 'node_modules'));
    await fs.writeFile(path.join(workers[0].cwd, 'node_modules', 'keep.txt'), 'legacy retained');
    workers[0].finish({ success: true });
    expect((await collectResults(scope))[0].state).toBe('succeeded');
    expect(await fs.readFile(path.join(workers[0].cwd, 'node_modules', 'keep.txt'), 'utf8')).toBe('legacy retained');
  }, lifecycleBudget(6));

  const missingSessionTask = async () => {
    const scope = manager.begin(parent);
    await launchExecuting(scope, { backend: 'codex', objective: 'Resume safely' }, 'launch');
    const original = workers[0];
    original.executor.consumeSessionResumeFailure = vi.fn(() => true);
    const [lane] = await manager.laneStore.lanesForThread(parent.thread.id);
    const pointer = path.join(fixture.directory, '.remote-cli', 'codex-sessions', `${lane.executorThreadId}.json`);
    await fs.mkdir(path.dirname(pointer), { recursive: true });
    await fs.writeFile(pointer, 'synthetic native continuation');
    return { scope, original, lane, pointer };
  };

  const observeReplacement = (scope: ReturnType<DelegationManager['begin']>) => {
    const firstWorker = workers.length;
    const terminal = watchTerminal(scope);
    const completed = collectResults(scope, 'replacement');
    void completed.catch(() => undefined);
    const replacement = lifecyclePhase('execute the replacement worker', () => waitForSignal(() => {
      if (terminal.state.error) throw terminal.state.error;
      if (terminal.state.value) throw new Error(`Task ended before replacement execution: ${JSON.stringify(terminal.state.value)}`);
      return workers.slice(firstWorker).find(worker => vi.mocked(worker.executor.execute).mock.calls.length > 0);
    }));
    void replacement.catch(() => undefined);
    return { replacement, completed };
  };

  it('defers missing-session replacement and native cleanup until managed group exit is confirmed', async () => {
    const { scope, original, lane, pointer } = await missingSessionTask();
    let confirm!: () => void, entered!: () => void;
    const proof = new Promise<void>(resolve => { confirm = resolve; });
    const proving = new Promise<void>(resolve => { entered = resolve; });
    const group = vi.mocked(original.executor.waitForManagedProcessGroupExit!).mockImplementation(() => { entered(); return proof; });
    const remove = vi.spyOn(manager.laneStore, 'remove');
    const saveExit = vi.spyOn(manager.laneStore, 'markShutdownConfirmed');
    const { replacement, completed } = observeReplacement(scope);
    original.finish({ success: false, error: 'Stored native session is missing' });
    try {
      await lifecyclePhase('enter replacement group proof', () => awaitPhaseEntry('replacement group proof', proving, completed));
      expect(group).toHaveBeenCalledOnce();
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
  }, lifecycleBudget(8));

  it.each(['missing', 'rejected'])('retains the missing-session executor and context when group evidence is %s', async failure => {
    const { scope, original, lane, pointer } = await missingSessionTask();
    if (failure === 'missing') original.executor.waitForManagedProcessGroupExit = undefined;
    else vi.mocked(original.executor.waitForManagedProcessGroupExit!).mockRejectedValue(new Error('Unconfirmed descendant'));
    const remove = vi.spyOn(manager.laneStore, 'remove');
    expectedShutdownFailure = true;
    original.finish({ success: false, error: 'Stored native session is missing' });
    expect((await collectResults(scope))[0].state).toBe('interrupted');
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
  }, lifecycleBudget(3));

  it('preserves legacy missing-session retry without requiring managed group evidence', async () => {
    await lifecyclePhase('destroy fixture state', () => manager.destroy());
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
  }, lifecycleBudget(8));

  it.each([true, false])('cleans temporary dependencies after an unchanged task succeeds=%s', async success => {
    const scope = manager.begin(parent);
    const task = await launchExecuting(scope, { backend: 'codex', objective: 'Read the fixture' }, 'launch') as DelegatedTaskResult;
    const directory = workers[0].cwd;
    await fs.mkdir(path.join(directory, 'node_modules'));
    await fs.writeFile(path.join(directory, 'node_modules', 'cache'), 'disposable dependency');
    workers[0].finish({ success, error: success ? undefined : 'Fixture failure' });
    const [result] = await collectResults(scope);
    expect(result.state).toBe(success ? 'succeeded' : 'failed');
    expect(result.artifact?.disposition).toBe('applied');
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await lifecyclePhase('checkArtifactCloseout fixture state', () => scope.checkArtifactCloseout())).toEqual([]);
    expect(await fs.readFile(path.join(fixture.root, 'source.txt'), 'utf8')).toContain('first');
    expect(task.taskId).toBe(result.taskId);
  }, lifecycleBudget(6));

  it('removes dependency file links without removing their outside targets', async context => {
    const scope = manager.begin(parent);
    await launchExecuting(scope, { backend: 'codex', objective: 'Use fixture dependencies' }, 'launch');
    const outside = path.join(fixture.directory, 'outside-dependency');
    await fs.writeFile(outside, 'keep outside data');
    await fs.mkdir(path.join(workers[0].cwd, 'node_modules'));
    try { await fs.symlink(outside, path.join(workers[0].cwd, 'node_modules', 'tool'), 'file'); }
    catch (error) {
      if (!['EPERM', 'ENOTSUP', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      workers[0].finish({ success: true });
      await collectResults(scope);
      context.skip(); return;
    }
    workers[0].finish({ success: true });
    const [result] = await collectResults(scope);
    expect(result).toMatchObject({ state: 'succeeded', artifact: { disposition: 'applied' } });
    const summary = (await lifecyclePhase('enumerateArtifacts fixture state', () => manager.workspaceManager.enumerateArtifacts())).items.find(item => item.taskId === result.taskId);
    expect(summary?.cleanup).toBeUndefined();
    expect(summary?.checkoutState).toBe('reclaimed');
    expect(await fs.readFile(outside, 'utf8')).toBe('keep outside data');
    await expect(fs.lstat(workers[0].cwd)).rejects.toMatchObject({ code: 'ENOENT' });
  }, lifecycleBudget(6));

  it('exports required ignored reports before deleting the checkout', async () => {
    const snapshots = new OutputSnapshots(path.join(fixture.directory, 'output-snapshots'));
    await snapshots.initialize();
    let hiddenId = '';
    parent.onOutputFiles = async (links, cwd, taskId, final) => {
      for (const candidate of links.finish(final).paths) hiddenId = (await snapshots.snapshot(candidate, {
        owner: 'synthetic-owner', cwd, taskId, messageId: 'message', threadId: parent.thread.id, generation: 0, source: 'worker',
      })).id;
    };
    parent.onVerifiedExports = vi.fn();
    try {
    const scope = manager.begin(parent);
    await launchExecuting(scope, { backend: 'codex', objective: 'Produce a report',
      exports: ['node_modules/report.txt'] }, 'launch');
    await fs.mkdir(path.join(workers[0].cwd, 'node_modules'));
    await fs.writeFile(path.join(workers[0].cwd, 'node_modules', 'report.txt'), 'delivered report');
    workers[0].finish({ success: true, output: '[report](node_modules/report.txt)' });
    const [result] = await collectResults(scope);
    expect(result.state).toBe('succeeded');
    await expect(fs.stat(workers[0].cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(hiddenId).not.toBe(''); expect(snapshots.references()).toEqual([]);
    const inspected = await lifecyclePhase('integrate fixture artifact', () => scope.invoke('remote_cli_integrate', { taskId: result.taskId, action: 'inspect' }, 'inspect')) as {
      exportedFiles: { path: string; file: string; sha256: string; bytes: number }[];
    };
    expect(inspected.exportedFiles).toHaveLength(1);
    expect(inspected.exportedFiles[0].path).toBe('node_modules/report.txt');
    expect(await fs.readFile(inspected.exportedFiles[0].file, 'utf8')).toBe('delivered report');
    expect(parent.onVerifiedExports).toHaveBeenCalledWith([expect.objectContaining({ taskId: result.taskId, file: inspected.exportedFiles[0].file })]);
    const selected = await snapshots.snapshot(inspected.exportedFiles[0].file, {
      owner: 'synthetic-owner', cwd: parent.cwd, messageId: 'selected-reply', threadId: parent.thread.id,
      taskId: 'coordinator', generation: 0, source: 'workspace',
      exports: inspected.exportedFiles.map(entry => ({ ...entry, taskId: result.taskId })),
    });
    expect(selected.id).toBe(hiddenId); expect(snapshots.references()).toHaveLength(1);
    const parts: Buffer[] = [];
    await snapshots.read(snapshots.references()[0].id, async bytes => { for await (const part of bytes) parts.push(part); });
    expect(Buffer.concat(parts).toString()).toBe('delivered report');
    } finally { await snapshots.destroy(); }
  }, lifecycleBudget(6));

  it('holds the checkout when a required report was not delivered', async () => {
    const scope = manager.begin(parent);
    await launchExecuting(scope, { backend: 'codex', objective: 'Produce a required report',
      exports: ['missing-report.txt'] }, 'launch');
    workers[0].finish({ success: true });
    const [result] = await collectResults(scope);
    expect(result.state).toBe('failed');
    expect((await fs.stat(workers[0].cwd)).isDirectory()).toBe(true);
    expect(await lifecyclePhase('check the missing report obligation', () => scope.checkArtifactCloseout()))
      .toMatchObject([{ taskId: result.taskId, status: 'unavailable' }]);
    const [lane] = await manager.laneStore.lanesForThread(parent.thread.id);
    const pointer = path.join(fixture.directory, '.remote-cli', 'codex-sessions', `${lane.executorThreadId}.json`);
    await fs.mkdir(path.dirname(pointer), { recursive: true });
    await fs.writeFile(pointer, 'synthetic continuation');
    await lifecyclePhase('close the missing report scope', () => scope.close());
    await expect(lifecyclePhase('reject reset while the required report is missing', () => manager.resetWorkerLanes(parent.thread.id)))
      .rejects.toMatchObject({ cause: { message: expect.stringContaining('cleanup failed') } });
    expect(await fs.readFile(pointer, 'utf8')).toBe('synthetic continuation');
    expect(await manager.laneStore.lanesForThread(parent.thread.id)).toMatchObject([
      { id: lane.id, cleanupError: expect.stringContaining('[artifact-recovery-required]') },
    ]);
  }, lifecycleBudget(8));

  // Each admission, execution, native finalization and explicit Git operation has
  // its own boundary. The outer watchdog covers their sum, not one combined wait.
  it('preserves a failed code snapshot, removes its directory and recreates the lane', async () => {
    let scope = manager.begin(parent);
    await launchExecuting(scope, { backend: 'codex', objective: 'Change the fixture' }, 'launch');
    const directory = await lifecyclePhase('edit the executing first checkout', async () => {
      const cwd = workers[0].cwd;
      await fs.writeFile(path.join(cwd, 'source.txt'), 'recoverable failure\n');
      return cwd;
    });
    workers[0].finish({ success: false, error: 'Fixture test failed' });
    const [failed] = await collectResults(scope, 'failed snapshot');
    expect(failed.state).toBe('failed');
    expect(failed.artifact?.disposition).toBe('retained');
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await lifecyclePhase('check the failed snapshot closeout', () => scope.checkArtifactCloseout())).toEqual([]);
    const artifact = await lifecyclePhase('inspect the failed code snapshot', () =>
      scope.invoke('remote_cli_integrate', { taskId: failed.taskId, action: 'inspect' }, 'inspect')) as { changedFiles: string[] };
    expect(artifact.changedFiles).toContain('source.txt');
    await lifecyclePhase('close the failed worker scope', () => scope.close());
    scope = manager.begin(parent);
    await launchExecuting(scope, { backend: 'codex', objective: 'Read fresh input' }, 'second');
    await lifecyclePhase('verify the recreated lane and fresh input', async () => {
      expect(workers[1].cwd).toBe(directory);
      expect(await fs.readFile(path.join(directory, 'source.txt'), 'utf8')).toContain('first');
    });
    workers[1].finish({ success: true });
    await collectResults(scope, 'second worker');
    await lifecyclePhase('close the recreated worker scope', () => scope.close());
    expect(await lifecyclePhase('reset the reclaimed lane', () => manager.resetWorkerLanes(parent.thread.id))).toBe(1);
  }, lifecycleBudget(17));

  it('excludes old artifacts and lanes after durable conversation detachment and restart', async () => {
    const scope = manager.begin(parent);
    await launchExecuting(scope, { backend: 'codex', objective: 'Old changes' }, 'old');
    await lifecyclePhase('edit the executing old generation worker', async () => {
      await fs.writeFile(path.join(workers[0].cwd, 'source.txt'), 'historical changes\n');
      workers[0].finish({ success: true });
    });
    const [old] = await collectResults(scope, 'old generation');
    const [oldLane] = await manager.laneStore.lanesForThread(parent.thread.id);
    await lifecyclePhase('close the old generation scope', () => scope.close());
    await lifecyclePhase('persist conversation detachment and stop the old manager', async () => {
      const resets = new ThreadContextReset(path.join(fixture.directory, 'reset-state'));
      await resets.begin(parent.thread.id);
      await resets.advanceGeneration(parent.thread.id);
      await resets.complete(parent.thread.id);
    });
    await lifecyclePhase('stop the detached generation manager', () => manager.destroy());
    manager = makeManager();
    parent.thread = { ...parent.thread, delegationWorkspaceGeneration: new ThreadContextReset(path.join(fixture.directory, 'reset-state')).generation(parent.thread.id) };
    expect(await lifecyclePhase('rediscover current obligations after detachment', () => manager.pendingArtifactContext(parent.thread, fixture.root))).toBe('');
    const historical = await lifecyclePhase('enumerate historical artifacts after restart', () => manager.workspaceManager.enumerateArtifacts({ threadId: parent.thread.id }));
    expect(historical.items).toEqual(expect.arrayContaining([expect.objectContaining({ taskId: old.taskId })]));
    const next = manager.begin(parent);
    await launchExecuting(next, { backend: 'codex', objective: 'Fresh work' }, 'new');
    await lifecyclePhase('verify the fresh generation does not reuse the detached lane', async () => {
      const lanes = await manager.laneStore.lanesForThread(parent.thread.id);
      expect(lanes).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: oldLane.id, workspaceGeneration: 0 }),
        expect.objectContaining({ workspaceGeneration: 1, state: 'running' }),
      ]));
      expect(workers[1].cwd).not.toBe(workers[0].cwd);
      workers[1].finish({ success: true });
    });
    await collectResults(next, 'fresh generation');
    await lifecyclePhase('verify fresh closeout while retaining historical bytes', async () => {
      expect(await next.checkArtifactCloseout()).toEqual([]);
      expect(await fs.readFile(path.join(workers[0].cwd, 'source.txt'), 'utf8')).toBe('historical changes\n');
    });
  }, lifecycleBudget(18));

  it('rediscovers pending output after restart without diagnostic task records', async () => {
    const scope = manager.begin(parent);
    await launchExecuting(scope, { backend: 'codex', objective: 'Change fixture' }, 'launch');
    await lifecyclePhase('edit the executing pending restart artifact', async () => {
      await fs.writeFile(path.join(workers[0].cwd, 'source.txt'), 'pending change\n');
      workers[0].finish({ success: true });
    });
    const [result] = await collectResults(scope, 'pending restart artifact');
    expect(result.artifact?.disposition).toBe('pending');
    await lifecyclePhase('close the pending restart scope', () => scope.close());
    await lifecyclePhase('stop before removing only diagnostic records', () => manager.destroy());
    const diagnosticRoot = path.join(fixture.directory, '.remote-cli', 'delegation');
    await lifecyclePhase('remove only diagnostic task records', () => fs.rm(diagnosticRoot, { recursive: true, force: true }));
    manager = makeManager();
    expect(await lifecyclePhase('rediscover pending output after restart', () => manager.pendingArtifactContext(parent.thread, fixture.root))).toContain(result.taskId);
    const next = manager.begin(parent);
    // Ordinary turns do not inherit mandatory managed-work closeout. Explicit inspection remains available.
    expect(await lifecyclePhase('check restarted pending output obligations', () => next.checkArtifactCloseout())).toEqual([]);
    const inspected = await lifecyclePhase('inspect the rediscovered artifact', () =>
      next.invoke('remote_cli_integrate', { taskId: result.taskId, action: 'inspect' }, 'inspect') as Promise<{ revision: string }>);
    await lifecyclePhase('retain and reclaim the rediscovered artifact', () =>
      next.invoke('remote_cli_integrate', { taskId: result.taskId, action: 'retain', expectedRevision: inspected.revision }, 'retain'));
    await lifecyclePhase('verify rediscovered artifact closeout and directory removal', async () => {
      expect(await next.checkArtifactCloseout()).toEqual([]);
      await expect(fs.stat(workers[0].cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  }, lifecycleBudget(14));

  it('retires only a completed exact offline discard after failed capture, preserving native history and refs', async () => {
    const scope = manager.begin(parent);
    const capture = vi.spyOn(manager.workspaceManager, 'collect').mockRejectedValue(new Error('Synthetic capture failure before artifact persistence'));
    await launchExecuting(scope, { backend: 'codex', objective: 'Produce required fixture output', exports: ['missing.txt'] }, 'launch');
    workers[0].finish({ success: true });
    const [result] = await collectResults(scope);
    capture.mockRestore();
    expect(await lifecyclePhase('checkArtifactCloseout fixture state', () => scope.checkArtifactCloseout())).toMatchObject([{ taskId: result.taskId, status: 'unavailable' }]);
    const [lane] = await manager.laneStore.lanesForThread(parent.thread.id);
    await lifecyclePhase('close fixture state', () => scope.close());
    await lifecyclePhase('destroy fixture state', () => manager.destroy());
    const root = path.join(fixture.directory, '.remote-cli');
    const pointer = path.join(root, 'codex-sessions', `${lane.executorThreadId}.json`);
    await fs.mkdir(path.dirname(pointer), { recursive: true });
    await fs.writeFile(pointer, 'synthetic native continuation');
    const refs = await gitText(fixture.root, ['show-ref']);
    const cleanup = new LegacyWorkspaceCleanup(root, { mountPoints: async () => [], assertOffline: async () => undefined });
    const plan = path.join(fixture.directory, 'discard.json');
    expect((await lifecyclePhase('plan fixture state', () => cleanup.plan(plan))).items).toHaveLength(1);
    expect(await lifecyclePhase('discard fixture state', () => cleanup.discard(plan, { discardContents: true, confirmWorkersStopped: true }))).toEqual({ removed: 1, errors: [] });
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
      await lifecyclePhase('write an incomplete offline discard marker', () => fs.writeFile(markerFile, JSON.stringify(control)));
      manager = makeManager();
      expect(await lifecyclePhase('rediscover an incomplete offline discard marker', () => manager.pendingArtifactContext(parent.thread, fixture.root))).toContain(result.taskId);
      const next = manager.begin(parent);
      expect(await lifecyclePhase('check the incomplete discard closeout', () => next.checkArtifactCloseout())).toEqual([]);
      await lifecyclePhase('close the incomplete discard scope', () => next.close());
      await lifecyclePhase('stop the incomplete discard manager', () => manager.destroy());
    }
    await fs.writeFile(markerFile, JSON.stringify(marker));
    manager = makeManager();
    expect(await lifecyclePhase('pendingArtifactContext fixture state', () => manager.pendingArtifactContext(parent.thread, fixture.root))).toBe('');
    expect(await lifecyclePhase('checkArtifactCloseout fixture state', () => manager.begin(parent).checkArtifactCloseout())).toEqual([]);
    const inventory = await lifecyclePhase('enumerateArtifacts fixture state', () => manager.workspaceManager.enumerateArtifacts());
    expect(inventory).toMatchObject({ incomplete: false, total: 1, items: [{ taskId: result.taskId,
      discarded: { fingerprint: marker.fingerprint, planHash: marker.planHash }, exitConfirmed: false, recoverable: false }] });
    expect(inventory.items[0].successful).toBeUndefined();
    expect(inventory.items[0].disposition).toBeUndefined();
    expect(await fs.readFile(pointer, 'utf8')).toBe('synthetic native continuation');
    expect(await gitText(fixture.root, ['show-ref'])).toBe(refs);
    await expect(fs.stat(workers[0].cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    const artifactFile = path.join(root, 'delegation-workspaces', 'artifacts', `${result.taskId}.json`);
    await fs.writeFile(artifactFile, '{corrupt-existing-artifact');
    expect(await lifecyclePhase('pendingArtifactContext fixture state', () => manager.pendingArtifactContext(parent.thread, fixture.root))).toContain(result.taskId);
    expect((await lifecyclePhase('enumerateArtifacts fixture state', () => manager.workspaceManager.enumerateArtifacts())).items[0].discarded).toBeUndefined();
    await fs.unlink(artifactFile);
  }, lifecycleBudget(17 + 9 * 5)); // Nine invalid markers each require five independent restart/control steps.

  it.each(['reset', 'delete'] as const)('allows %s after more than 200 settled artifacts on the same lane', async action => {
    const scope = manager.begin(parent);
    await launchExecuting(scope, { backend: 'codex', objective: 'Read fixture' }, 'launch');
    workers[0].finish({ success: true });
    const [result] = await collectResults(scope);
    await lifecyclePhase('close fixture state', () => scope.close());
    const directory = path.join(fixture.directory, '.remote-cli', 'delegation-workspaces', 'artifacts');
    const artifact = JSON.parse(await fs.readFile(path.join(directory, `${result.taskId}.json`), 'utf8'));
    await lifecyclePhase('populate the settled artifact inventory', async () => {
      for (let index = 0; index < 205; index++) {
        const taskId = randomUUID();
        await fs.writeFile(path.join(directory, `${taskId}.json`), JSON.stringify({ ...artifact, taskId,
          closeout: { ...artifact.closeout, taskId } }));
      }
    });
    expect((await lifecyclePhase('enumerateArtifacts fixture state', () => manager.workspaceManager.enumerateArtifacts({ laneId: artifact.laneId, limit: 10_000 }))).total).toBe(206);
    expect(await (action === 'reset' ? lifecyclePhase('resetWorkerLanes fixture state', () => manager.resetWorkerLanes(parent.thread.id)) : lifecyclePhase('deleteWorkerLanes fixture state', () => manager.deleteWorkerLanes(parent.thread.id)))).toBe(1);
    expect(await fs.readdir(directory)).toHaveLength(206);
  }, lifecycleBudget(9));

  it('reports unrelated corrupt metadata without inventing a closeout task or allowing automatic deletion', async () => {
    const directory = path.join(fixture.directory, '.remote-cli', 'delegation-workspaces', 'artifacts');
    await fs.mkdir(directory, { recursive: true });
    const corrupt = path.join(directory, `${randomUUID()}.json`);
    await fs.writeFile(corrupt, '{synthetic-invalid-json');
    const context = await lifecyclePhase('pendingArtifactContext fixture state', () => manager.pendingArtifactContext(parent.thread, fixture.root));
    expect(context).toContain('inventory is incomplete');
    expect(context).not.toContain('storage-inventory');
    const scope = manager.begin(parent);
    expect(await lifecyclePhase('checkArtifactCloseout fixture state', () => scope.checkArtifactCloseout())).toEqual([]);
    expect(parent.onNotice).not.toHaveBeenCalled();
    expect(await lifecyclePhase('retryReclamation fixture state', () => manager.workspaceManager.retryReclamation())).toMatchObject({ incomplete: true, attempted: 0 });
    // A real task in this turn is still checked even with global uncertainty.
    const capture = vi.spyOn(manager.workspaceManager, 'collect').mockRejectedValue(new Error('Synthetic capture failure before artifact persistence'));
    await launchExecuting(scope, { backend: 'codex', objective: 'Missing required output', exports: ['missing.txt'] }, 'launch');
    workers[0].finish({ success: true });
    const [result] = await collectResults(scope);
    capture.mockRestore();
    expect(await lifecyclePhase('checkArtifactCloseout fixture state', () => scope.checkArtifactCloseout())).toMatchObject([{ taskId: result.taskId, status: 'unavailable' }]);
    expect(await lifecyclePhase('pendingArtifactContext fixture state', () => manager.pendingArtifactContext(parent.thread, fixture.root))).toContain(result.taskId);
    expect(await fs.readFile(corrupt, 'utf8')).toBe('{synthetic-invalid-json');
  }, lifecycleBudget(8));

  it('refuses a second owner before loading mutable lane metadata', async () => {
    await lifecyclePhase('reconcilePendingWorkerLanes fixture state', () => manager.reconcilePendingWorkerLanes());
    const other = makeManager();
    const acquire = vi.spyOn(other.laneStore, 'cleanupCandidates');
    await expect(lifecyclePhase('reconcilePendingWorkerLanes fixture state', () => other.reconcilePendingWorkerLanes())).rejects.toThrow();
    expect(acquire).not.toHaveBeenCalled();
    await lifecyclePhase('destroy fixture state', () => other.destroy());
  }, lifecycleBudget(3));

  const pendingTask = async (exports?: string[]) => {
    const scope = manager.begin(parent);
    await launchExecuting(scope, { backend: 'codex', objective: 'Change fixture', exports }, 'launch');
    await lifecyclePhase('edit the executing pending-artifact worker', async () => {
      await fs.writeFile(path.join(workers[0].cwd, 'source.txt'), 'captured change\n');
      if (exports) {
        await fs.mkdir(path.join(workers[0].cwd, 'node_modules'));
        await fs.writeFile(path.join(workers[0].cwd, exports[0]), 'required report');
      }
    });
    workers[0].finish({ success: true });
    const [result] = await collectResults(scope);
    const [lane] = await manager.laneStore.lanesForThread(parent.thread.id);
    const pointer = path.join(fixture.directory, '.remote-cli', 'codex-sessions', `${lane.executorThreadId}.json`);
    await lifecyclePhase('persist the pending-artifact native pointer', async () => {
      await fs.mkdir(path.dirname(pointer), { recursive: true });
      await fs.writeFile(pointer, 'synthetic native continuation');
    });
    return { scope, result, lane, pointer };
  };

  it.each(['reset', 'delete', 'cd', 'reset-without-checkout-state'] as const)('preserves native continuation after failed reclamation during %s and retries', async action => {
    const { scope, result, lane, pointer } = await pendingTask();
    const inspection = await lifecyclePhase('integrate fixture artifact', () => scope.invoke('remote_cli_integrate', { taskId: result.taskId, action: 'inspect' }, 'inspect')) as { revision: string };
    await fs.writeFile(path.join(workers[0].cwd, 'source.txt'), 'changed after capture\n');
    await lifecyclePhase('integrate fixture artifact', () => scope.invoke('remote_cli_integrate', { taskId: result.taskId, action: 'retain', expectedRevision: inspection.revision }, 'retain'));
    await lifecyclePhase('close fixture state', () => scope.close());
    if (action === 'reset-without-checkout-state') {
      const file = path.join(fixture.directory, '.remote-cli', 'delegation-workspaces', 'lanes', `${lane.id}.json`);
      const workspace = JSON.parse(await fs.readFile(file, 'utf8'));
      delete workspace.checkoutState;
      await fs.writeFile(file, JSON.stringify(workspace));
    }
    const remove = () => action === 'cd' ? lifecyclePhase('invalidateWorkspaceGeneration fixture state', () => manager.invalidateWorkspaceGeneration(parent.thread.id, 1))
      : action === 'delete' ? lifecyclePhase('deleteWorkerLanes fixture state', () => manager.deleteWorkerLanes(parent.thread.id)) : lifecyclePhase('resetWorkerLanes fixture state', () => manager.resetWorkerLanes(parent.thread.id));
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
    expect((await lifecyclePhase('enumerateArtifacts fixture state', () => manager.workspaceManager.enumerateArtifacts())).items).toMatchObject([{ taskId: result.taskId, disposition: 'retained' }]);
  }, lifecycleBudget(15));

  it('holds missing pending exports but permits native reset after restoring durable output', async () => {
    const { scope, result, pointer } = await pendingTask(['node_modules/report.txt']);
    const [exported] = await lifecyclePhase('getArtifactExports fixture state', () => manager.workspaceManager.getArtifactExports(result.taskId));
    await lifecyclePhase('close fixture state', () => scope.close());
    await fs.unlink(exported.file);
    await expect(lifecyclePhase('deleteWorkerLanes fixture state', () => manager.deleteWorkerLanes(parent.thread.id))).rejects.toThrow('cleanup failed');
    expect(await fs.readFile(pointer, 'utf8')).toBe('synthetic native continuation');
    expect(await manager.laneStore.lanesForThread(parent.thread.id)).toMatchObject([
      { cleanupError: expect.stringContaining('[artifact-export-unavailable]') },
    ]);
    await fs.writeFile(exported.file, 'required report');
    expect(await lifecyclePhase('deleteWorkerLanes fixture state', () => manager.deleteWorkerLanes(parent.thread.id))).toBe(1);
    await expect(fs.stat(pointer)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.stat(workers[0].cwd)).isDirectory()).toBe(true);
    expect((await lifecyclePhase('enumerateArtifacts fixture state', () => manager.workspaceManager.enumerateArtifacts())).items).toMatchObject([{ disposition: 'pending' }]);
  }, lifecycleBudget(13));

  it('keeps safe pending artifacts while clearing native context', async () => {
    const { scope, pointer } = await pendingTask();
    await lifecyclePhase('close fixture state', () => scope.close());
    const reset = new ThreadContextReset();
    await reset.begin(parent.thread.id);
    await lifecyclePhase('clearThreadContexts fixture state', () => manager.clearThreadContexts(parent.thread.id));
    await reset.complete(parent.thread.id);
    await expect(fs.stat(pointer)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await manager.laneStore.lanesForThread(parent.thread.id)).toHaveLength(1);
    expect((await fs.stat(workers[0].cwd)).isDirectory()).toBe(true);
  }, lifecycleBudget(10));

  it('preserves native context until uncertain parent application is resolved', async () => {
    const { scope, result, pointer } = await pendingTask();
    await lifecyclePhase('close fixture state', () => scope.close());
    const file = path.join(fixture.directory, '.remote-cli', 'delegation-workspaces', 'artifacts', `${result.taskId}.json`);
    const original = await fs.readFile(file, 'utf8');
    const artifact = JSON.parse(original);
    await fs.writeFile(file, JSON.stringify({ ...artifact, recovery: { beforeRef: artifact.input.commit, targetRef: artifact.output } }));
    await expect(lifecyclePhase('deleteWorkerLanes fixture state', () => manager.deleteWorkerLanes(parent.thread.id))).rejects.toThrow('cleanup failed');
    expect(await fs.readFile(pointer, 'utf8')).toBe('synthetic native continuation');
    expect(await manager.laneStore.lanesForThread(parent.thread.id)).toMatchObject([
      { cleanupError: expect.stringContaining('[artifact-recovery-required]') },
    ]);
    await fs.writeFile(file, original);
    expect(await lifecyclePhase('deleteWorkerLanes fixture state', () => manager.deleteWorkerLanes(parent.thread.id))).toBe(1);
  }, lifecycleBudget(11));

  it('fences new operations after destroy without reacquiring ownership', async () => {
    const acquire = vi.spyOn(DelegationOwnership.prototype, 'acquire');
    const release = vi.spyOn(DelegationOwnership.prototype, 'release');
    await lifecyclePhase('reconcilePendingWorkerLanes fixture state', () => manager.reconcilePendingWorkerLanes());
    await lifecyclePhase('destroy fixture state', () => manager.destroy());
    const count = acquire.mock.calls.length;
    const operations = [
      () => lifecyclePhase('reconcilePendingWorkerLanes fixture state', () => manager.reconcilePendingWorkerLanes()),
      () => lifecyclePhase('invalidateWorkspaceGeneration fixture state', () => manager.invalidateWorkspaceGeneration(parent.thread.id, 1)),
      () => lifecyclePhase('resetWorkerContext fixture state', () => manager.resetWorkerContext(parent.thread, 'unused', 1)),
      () => lifecyclePhase('assertThreadContextResettable fixture state', () => manager.assertThreadContextResettable(parent.thread.id)),
      () => lifecyclePhase('clearThreadContexts fixture state', () => manager.clearThreadContexts(parent.thread.id)),
      () => lifecyclePhase('resetWorkerLanes fixture state', () => manager.resetWorkerLanes(parent.thread.id)),
      () => lifecyclePhase('deleteWorkerLanes fixture state', () => manager.deleteWorkerLanes(parent.thread.id)),
      () => lifecyclePhase('pendingArtifactContext fixture state', () => manager.pendingArtifactContext(parent.thread, fixture.root)),
      () => manager.cancelThread(parent.thread.id),
      () => lifecyclePhase('unavailableLanes fixture state', () => manager.workspaceManager.unavailableLanes()),
    ];
    for (const operation of operations) await expect(operation()).rejects.toThrow('shutting down');
    expect(() => manager.begin(parent)).toThrow('shutting down');
    await lifecyclePhase('destroy fixture state', () => manager.destroy());
    expect(acquire).toHaveBeenCalledTimes(count);
    expect(release).toHaveBeenCalledTimes(1);
    await expect(fs.stat(`${manager.laneStore.storageDirectory}.ownership`)).rejects.toMatchObject({ code: 'ENOENT' });
  }, lifecycleBudget(13));

  it('retries a failed ownership release without reopening admission', async () => {
    await lifecyclePhase('reconcilePendingWorkerLanes fixture state', () => manager.reconcilePendingWorkerLanes());
    const acquire = vi.spyOn(DelegationOwnership.prototype, 'acquire');
    const lock = `${manager.laneStore.storageDirectory}.ownership`;
    const unlink = fs.unlink.bind(fs);
    const failure = vi.spyOn(fs, 'unlink').mockImplementation(async file => {
      if (file === lock) throw Object.assign(new Error('Synthetic locked ownership file'), { code: 'EBUSY' });
      return unlink(file);
    });
    await expect(lifecyclePhase('destroy fixture state', () => manager.destroy())).rejects.toThrow('Synthetic locked');
    expect((await fs.stat(lock)).isFile()).toBe(true);
    await expect(lifecyclePhase('reconcilePendingWorkerLanes fixture state', () => manager.reconcilePendingWorkerLanes())).rejects.toThrow('shutting down');
    failure.mockRestore();
    await lifecyclePhase('destroy fixture state', () => manager.destroy());
    expect(acquire).not.toHaveBeenCalled();
    await expect(fs.stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
  }, lifecycleBudget(4));

  it('retries failed scope shutdown while retaining ownership and fencing new work', async () => {
    await lifecyclePhase('reconcilePendingWorkerLanes fixture state', () => manager.reconcilePendingWorkerLanes());
    const scope = manager.begin(parent);
    const close = vi.spyOn(scope, 'close').mockRejectedValueOnce(new Error('Synthetic close failure'));
    const acquire = vi.spyOn(DelegationOwnership.prototype, 'acquire');
    const release = vi.spyOn(DelegationOwnership.prototype, 'release');
    await expect(lifecyclePhase('destroy fixture state', () => manager.destroy())).rejects.toThrow('shutdown is unresolved');
    expect(release).not.toHaveBeenCalled();
    expect(() => manager.begin(parent)).toThrow('shutting down');
    expect((await fs.stat(`${manager.laneStore.storageDirectory}.ownership`)).isFile()).toBe(true);
    await lifecyclePhase('destroy fixture state', () => manager.destroy());
    expect(close).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(1);
    expect(acquire).not.toHaveBeenCalled();
  }, lifecycleBudget(3));

  it('drains an admitted metadata operation before releasing ownership', async () => {
    await lifecyclePhase('reconcilePendingWorkerLanes fixture state', () => manager.reconcilePendingWorkerLanes());
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const enumerate = manager.workspaceManager.enumerateArtifacts.bind(manager.workspaceManager);
    vi.spyOn(manager.workspaceManager, 'enumerateArtifacts').mockImplementation(async options => {
      entered(); await gate; return enumerate(options);
    });
    const release = vi.spyOn(DelegationOwnership.prototype, 'release');
    const pending = lifecyclePhase('pendingArtifactContext fixture state', () => manager.pendingArtifactContext(parent.thread, fixture.root));
    let shutdown: Promise<void> | undefined;
    try {
      await lifecyclePhase('enter held metadata enumeration', () => awaitPhaseEntry('metadata enumeration', started, pending));
      shutdown = lifecyclePhase('destroy fixture state', () => manager.destroy());
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(release).not.toHaveBeenCalled();
      resume(); await pending; await shutdown;
    } finally { resume(); await Promise.allSettled([pending, ...(shutdown ? [shutdown] : [])]); }
    expect(release).toHaveBeenCalledTimes(1);
  }, lifecycleBudget(4));

  it('allows active finalization to reclaim under the existing owner while shutdown drains', async () => {
    const scope = manager.begin(parent);
    await launchExecuting(scope, { backend: 'codex', objective: 'Read fixture' }, 'launch');
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const collect = manager.workspaceManager.collect.bind(manager.workspaceManager);
    vi.spyOn(manager.workspaceManager, 'collect').mockImplementation(async (...args) => {
      entered(); await gate; return collect(...args);
    });
    workers[0].finish({ success: true });
    const acquire = vi.spyOn(DelegationOwnership.prototype, 'acquire');
    let shutdown: Promise<void> | undefined;
    try {
      await lifecyclePhase('enter held finalization', () => awaitPhaseEntry('finalization', started, watchTerminal(scope).operation));
      shutdown = settleFinalization(scope, watchOperation(manager.destroy()), 'shutdown');
      await expect(lifecyclePhase('pendingArtifactContext fixture state', () => manager.pendingArtifactContext(parent.thread, fixture.root))).rejects.toThrow('shutting down');
      resume(); await shutdown;
    } finally { resume(); await Promise.allSettled(shutdown ? [shutdown] : []); }
    await expect(scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Too late' }, 'late')).rejects.toThrow();
    await expect(lifecyclePhase('checkArtifactCloseout fixture state', () => scope.checkArtifactCloseout())).rejects.toThrow('cancelled');
    await lifecyclePhase('close fixture state', () => scope.close());
    expect(acquire).not.toHaveBeenCalled();
    await expect(fs.stat(workers[0].cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(`${manager.laneStore.storageDirectory}.ownership`)).rejects.toMatchObject({ code: 'ENOENT' });
  }, lifecycleBudget(9));
});
