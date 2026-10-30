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

describe('disposable delegation lifecycle', { timeout: 30_000 }, () => {
  let fixture: Awaited<ReturnType<typeof gitFixture>>;
  let manager: DelegationManager;
  let parent: DelegationParent;
  let workers: { cwd: string; executor: IExecutor; finish: (result: ExecuteResult) => void }[];
  let onWorkerCreated: ((worker: typeof workers[number]) => void) | undefined;
  let expectedShutdownFailure = false;
  const makeManager = (disposalSupported = true) => new DelegationManager(new DirectoryGuard([fixture.directory]), (_guard, _config, cwd) => {
    if (!cwd) throw new Error('Fixture worker requires a working directory');
    let finish!: (result: ExecuteResult) => void;
    const done = new Promise<ExecuteResult>(resolve => { finish = resolve; });
    const executor = { execute: vi.fn(() => done), abort: vi.fn(async () => true),
      destroy: vi.fn(async () => undefined), waitForExit: vi.fn(async () => undefined), waitForManagedProcessGroupExit: vi.fn(async () => undefined),
      resetContext: vi.fn(), getCurrentWorkingDirectory: () => cwd, setWorkingDirectory: vi.fn(),
    } as unknown as IExecutor;
    workers.push({ cwd, executor, finish });
    onWorkerCreated?.(workers[workers.length - 1]);
    return executor;
  }, new BackendRegistry(async () => 'fixture 1.0'), undefined, undefined, undefined, undefined,
      new DelegatedWorkspaceManager(undefined, disposalSupported));
  beforeEach(async () => {
    expectedShutdownFailure = false;
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
  afterEach(async () => {
    if (expectedShutdownFailure) await expect(manager.destroy()).rejects.toThrow('storage ownership was retained');
    else await manager.destroy();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(fixture.directory, { recursive: true, force: true });
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

  it('removes dependency links without removing their outside targets', async context => {
    const scope = manager.begin(parent);
    await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Use fixture dependencies' }, 'launch');
    const outside = path.join(fixture.directory, 'outside-dependency');
    await fs.writeFile(outside, 'keep outside data');
    await fs.mkdir(path.join(workers[0].cwd, 'node_modules'));
    try { await fs.symlink(outside, path.join(workers[0].cwd, 'node_modules', 'tool')); }
    catch (error) {
      if (!['EPERM', 'ENOTSUP', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      workers[0].finish({ success: true });
      await scope.collectPendingResults();
      context.skip(); return;
    }
    workers[0].finish({ success: true });
    await scope.collectPendingResults();
    await expect(fs.stat(workers[0].cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(outside, 'utf8')).toBe('keep outside data');
  });

  it('exports required ignored reports before deleting the checkout', async () => {
    const scope = manager.begin(parent);
    await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Produce a report',
      exports: ['node_modules/report.txt'] }, 'launch');
    await fs.mkdir(path.join(workers[0].cwd, 'node_modules'));
    await fs.writeFile(path.join(workers[0].cwd, 'node_modules', 'report.txt'), 'delivered report');
    workers[0].finish({ success: true });
    const [result] = await scope.collectPendingResults();
    expect(result.state).toBe('succeeded');
    await expect(fs.stat(workers[0].cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    const inspected = await scope.invoke('remote_cli_integrate', { taskId: result.taskId, action: 'inspect' }, 'inspect') as {
      exportedFiles: { path: string; file: string; sha256: string }[];
    };
    expect(inspected.exportedFiles).toHaveLength(1);
    expect(inspected.exportedFiles[0].path).toBe('node_modules/report.txt');
    expect(await fs.readFile(inspected.exportedFiles[0].file, 'utf8')).toBe('delivered report');
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

  it('preserves a failed code snapshot, removes its directory and recreates the lane', async () => {
    let scope = manager.begin(parent);
    await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Change the fixture' }, 'launch');
    const directory = workers[0].cwd;
    await fs.writeFile(path.join(directory, 'source.txt'), 'recoverable failure\n');
    workers[0].finish({ success: false, error: 'Fixture test failed' });
    const [failed] = await scope.collectPendingResults();
    expect(failed.state).toBe('failed');
    expect(failed.artifact?.disposition).toBe('retained');
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await scope.checkArtifactCloseout()).toEqual([]);
    const artifact = await scope.invoke('remote_cli_integrate', { taskId: failed.taskId, action: 'inspect' }, 'inspect') as { changedFiles: string[] };
    expect(artifact.changedFiles).toContain('source.txt');
    await scope.close();
    scope = manager.begin(parent);
    await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Read fresh input' }, 'second');
    expect(workers[1].cwd).toBe(directory);
    expect(await fs.readFile(path.join(directory, 'source.txt'), 'utf8')).toContain('first');
    workers[1].finish({ success: true });
    await scope.collectPendingResults();
    await scope.close();
    expect(await manager.resetWorkerLanes(parent.thread.id)).toBe(1);
  });

  it('rediscovers pending output after restart without diagnostic task records', async () => {
    const scope = manager.begin(parent);
    await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Change fixture' }, 'launch');
    await fs.writeFile(path.join(workers[0].cwd, 'source.txt'), 'pending change\n');
    workers[0].finish({ success: true });
    const [result] = await scope.collectPendingResults();
    expect(result.artifact?.disposition).toBe('pending');
    await scope.close();
    await manager.destroy();
    const diagnosticRoot = path.join(fixture.directory, '.remote-cli', 'delegation');
    await fs.rm(diagnosticRoot, { recursive: true, force: true });
    manager = makeManager();
    expect(await manager.pendingArtifactContext(parent.thread, fixture.root)).toContain(result.taskId);
    const next = manager.begin(parent);
    expect(await next.checkArtifactCloseout()).toMatchObject([{ taskId: result.taskId, status: 'pending' }]);
    const inspected = await next.invoke('remote_cli_integrate', { taskId: result.taskId, action: 'inspect' }, 'inspect') as { revision: string };
    await next.invoke('remote_cli_integrate', { taskId: result.taskId, action: 'retain', expectedRevision: inspected.revision }, 'retain');
    expect(await next.checkArtifactCloseout()).toEqual([]);
    await expect(fs.stat(workers[0].cwd)).rejects.toMatchObject({ code: 'ENOENT' });
  });

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
      expect(await next.checkArtifactCloseout()).toMatchObject([{ taskId: result.taskId, status: 'unavailable' }]);
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
    expect(parent.onNotice).toHaveBeenCalledWith(expect.stringContaining('inventory is incomplete'));
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
