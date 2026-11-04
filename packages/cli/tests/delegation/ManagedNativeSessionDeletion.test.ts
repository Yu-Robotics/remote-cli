import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { isMainThread } from 'worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DelegationManager, type DelegationParent } from '../../src/delegation/DelegationManager';
import { BackendRegistry } from '../../src/delegation/BackendRegistry';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { captureCodexDeletionTarget, type NativeSessionDeletionTarget } from '../../src/delegation/NativeSessionDeletion';
import { DELEGATION_BACKENDS } from '../../src/delegation/contract';

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
describe('managed child native deletion lifecycle', () => {
  it('runs native ownership lifecycle in an isolated process', () => {
    expect(isMainThread).toBe(true);
  });
  let home: string;
  let manager: DelegationManager;
  let parent: DelegationParent;
  let creation: ReturnType<typeof gate>;
  let execution: ReturnType<typeof gate>;
  let exit: ReturnType<typeof gate>;
  let deletion: ReturnType<typeof vi.fn>;
  let targets: NativeSessionDeletionTarget[];
  let factory: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'managed-native-delete-')));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home); vi.stubEnv('CODEX_HOME', path.join(home, '.codex'));
    await fs.mkdir(path.join(home, '.codex'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    creation = gate(); execution = gate(); exit = gate(); targets = [];
    factory = vi.fn((_guard, _config, cwd, executorThreadId) => {
      let observer: ((target: NativeSessionDeletionTarget) => Promise<void>) | undefined;
      let sessionId: string | undefined;
      return {
        observeNativeSessionCreation: (value: typeof observer) => { observer = value; },
        execute: vi.fn(async () => {
          await creation.promise;
          const pointer = path.join(home, '.remote-cli', 'codex-sessions', `${executorThreadId}.json`);
          await fs.mkdir(path.dirname(pointer), { recursive: true });
          try { sessionId = JSON.parse(await fs.readFile(pointer, 'utf8')).id; }
          catch {
            sessionId = randomUUID();
            await fs.writeFile(pointer, JSON.stringify({ id: sessionId }));
            const target = await captureCodexDeletionTarget({ sessionId: sessionId!, executorThreadId,
              home, nativeHome: path.join(home, '.codex'), cwd, command: 'synthetic-codex' });
            targets.push(target); await observer!(target);
          }
          await execution.promise;
          return { success: true, output: 'Preserved task result' };
        }),
        getSessionId: () => sessionId, getCurrentWorkingDirectory: () => cwd,
        setWorkingDirectory: vi.fn(), resetContext: vi.fn(), abort: vi.fn(async () => true),
        destroy: vi.fn(async () => { creation.resolve(); execution.resolve(); }),
        waitForExit: vi.fn(async () => {}), waitForManagedProcessGroupExit: vi.fn(() => exit.promise),
      };
    });
    const nativeThread = (id: string) => ({ id, sessionId: id, cwd: home, source: 'appServer',
      status: { type: 'notLoaded' }, ephemeral: false, turns: [], cliVersion: '0.166.0',
      createdAt: 1, updatedAt: 1, modelProvider: 'synthetic', preview: '', projectId: null });
    deletion = vi.fn(async (method, params) => method === 'thread/read'
      ? { thread: nativeThread(params.threadId) }
      : method === 'thread/list' ? { data: params.archived ? [] : targets.map(target => nativeThread(target.sessionId)), nextCursor: null } : {});
    manager = new DelegationManager(new DirectoryGuard([home]), factory as any,
      new BackendRegistry(async () => 'synthetic 1.0'), undefined, undefined, 1000, undefined, undefined,
      () => ({ start: async () => {}, stop: async () => {}, getServerVersion: () => '0.166.0', request: deletion }));
    parent = { thread: { id: 'parent', name: 'parent', workingDirectory: home, sessionId: null, createdAt: 0, lastActiveAt: 0 },
      cwd: home, backend: 'codex', config: { type: 'codex' }, messageId: 'synthetic',
      onToolUse: vi.fn(), onToolResult: vi.fn(), onNotice: vi.fn(), onApproval: vi.fn(() => true), onApprovalResolved: vi.fn() };
  });
  afterEach(async () => {
    creation.resolve(); execution.resolve(); exit.resolve(); await manager.destroy();
    vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(home, { recursive: true, force: true });
  });
  const launch = async () => {
    const scope = manager.begin(parent);
    const task: any = await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Synthetic work' }, randomUUID());
    return { scope, task };
  };
  const finish = async ({ scope, task }: Awaited<ReturnType<typeof launch>>) => {
    await scope.invoke('remote_cli_result', { taskId: task.taskId, waitSeconds: 25 }, randomUUID());
    await scope.close();
  };

  it('reuses the same child before reset and preserves its strong exit evidence', async () => {
    creation.resolve(); execution.resolve(); exit.resolve();
    await finish(await launch());
    await finish(await launch());
    expect(targets).toHaveLength(1);
    const lane = (await manager.laneStore.lanesForThread('parent'))[0];
    expect(lane.nativeGroupExitGeneration).toBe(lane.contextGeneration);
    expect(lane.state).toBe('ready');
    await manager.reconcileNativeSessionDeletions();
    expect(deletion).not.toHaveBeenCalled();
    await manager.requestNativeSessionDeletion('parent', 0);
    await manager.reconcileNativeSessionDeletions();
    expect(deletion).toHaveBeenLastCalledWith('thread/delete', { threadId: targets[0].sessionId });
    expect((await manager.laneStore.lanesForThread('parent'))[0]).toMatchObject({ state: 'dirty', nativeDeletion: { state: 'deleted' } });
  });

  it.each(['startup', 'execution', 'finalization'] as const)(
    'retains reset intent during %s, waits for group exit and accepts late identity without reviving the lane', async phase => {
      if (phase !== 'startup') creation.resolve();
      const work = await launch();
      if (phase !== 'startup') await vi.waitFor(() => expect(targets).toHaveLength(1));
      if (phase === 'finalization') execution.resolve();
      await manager.requestNativeSessionDeletion('parent', 0);
      await manager.reconcileNativeSessionDeletions();
      expect(deletion).not.toHaveBeenCalled();
      expect((await manager.laneStore.lanesForThread('parent'))[0].nativeDeletion?.state).toBe('waiting-exit');
      creation.resolve(); execution.resolve(); exit.resolve();
      await finish(work);
      await manager.reconcileNativeSessionDeletions();
      expect(deletion).toHaveBeenLastCalledWith('thread/delete', { threadId: targets[0].sessionId });
      const lane = (await manager.laneStore.lanesForThread('parent'))[0];
      expect(lane.state).toBe('dirty');
      await manager.laneStore.markReady(lane.id);
      expect((await manager.laneStore.lanesForThread('parent'))[0].state).toBe('dirty');
      await expect(manager.laneStore.markRunning(lane.id)).rejects.toThrow('retired');
      await expect(manager.laneStore.remove(lane.id)).rejects.toThrow('retained');
    });

  it('does not promote transport exit to deletion permission when group proof is unavailable', async () => {
    creation.resolve(); execution.resolve(); exit.resolve();
    const original = factory.getMockImplementation()!;
    factory.mockImplementation((...args) => ({ ...original(...args), waitForManagedProcessGroupExit: undefined }));
    await finish(await launch());
    await manager.requestNativeSessionDeletion('parent', 0);
    await manager.reconcileNativeSessionDeletions();
    expect(deletion).not.toHaveBeenCalled();
    expect((await manager.laneStore.lanesForThread('parent'))[0].nativeDeletion?.state).toBe('waiting-exit');
  });

  it('keeps a completed shared task successful when optional group proof times out', async () => {
    creation.resolve(); execution.resolve();
    const { scope, task } = await launch();
    try {
      await expect(scope.invoke('remote_cli_result', { taskId: task.taskId, waitSeconds: 25 }, randomUUID()))
        .resolves.toMatchObject({ state: 'succeeded', output: 'Preserved task result' });
      await manager.requestNativeSessionDeletion('parent', 0);
      await manager.reconcileNativeSessionDeletions();
      expect(deletion).not.toHaveBeenCalled();
      expect((await manager.laneStore.lanesForThread('parent'))[0].nativeDeletion?.state).toBe('waiting-exit');
    } finally { exit.resolve(); await scope.close(); }
  });

  it('holds a native identity also referenced by another parent instead of deleting either history', async () => {
    creation.resolve(); execution.resolve(); exit.resolve();
    await finish(await launch());
    const other = await manager.laneStore.acquire({ threadId: 'foreign', backend: 'codex', workingDirectory: home, workspaceGeneration: 0 });
    await manager.laneStore.markPromptInitialized(other.lane.id, targets[0].sessionId, 'shared');
    await manager.laneStore.markReady(other.lane.id);
    await manager.requestNativeSessionDeletion('parent', 0);
    await manager.reconcileNativeSessionDeletions();
    expect(deletion).not.toHaveBeenCalled();
    expect((await manager.laneStore.lanesForThread('parent'))[0].nativeDeletion?.state).toBe('held');
  });

  it('persists reset intent without waiting behind unrelated admission work', async () => {
    creation.resolve(); execution.resolve(); exit.resolve();
    await finish(await launch());
    const blocked = gate();
    const maintenance = (manager as any).withAdmission(() => blocked.promise);
    try {
      await manager.requestNativeSessionDeletion('parent', 0);
      expect(await manager.nativeSessionDeletions.requests()).toHaveLength(1);
      expect(deletion).not.toHaveBeenCalled();
    } finally { blocked.resolve(); await maintenance; }
  });

  it('rejects stale creation callbacks after reuse without replacing the owned target', async () => {
    creation.resolve(); execution.resolve(); exit.resolve();
    await finish(await launch());
    await finish(await launch());
    const lane = (await manager.laneStore.lanesForThread('parent'))[0];
    await expect(manager.laneStore.captureNativeSession(lane.id, lane.contextGeneration! - 1, targets[0])).rejects.toThrow('identity changed');
    expect((await manager.laneStore.lanesForThread('parent'))[0].nativeSession).toEqual(targets[0]);
  });

  it('preserves exit proof when reuse is cancelled before native startup', async () => {
    creation.resolve(); execution.resolve(); exit.resolve();
    await finish(await launch());
    const acquired = await manager.laneStore.acquire({ threadId: 'parent', backend: 'codex',
      workingDirectory: home, workspaceGeneration: 0 });
    expect(acquired.reused).toBe(true);
    expect(acquired.lane.nativeGroupExitGeneration).toBe(acquired.lane.contextGeneration);
    await manager.requestNativeSessionDeletion('parent', 0);
    await manager.reconcileNativeSessionDeletions();
    expect(deletion).toHaveBeenLastCalledWith('thread/delete', { threadId: targets[0].sessionId });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('does not treat a lane flag alone as durable parent reset authorization', async () => {
    creation.resolve(); execution.resolve(); exit.resolve();
    await finish(await launch());
    await manager.laneStore.requestNativeDeletion('parent', 0);
    await manager.reconcileNativeSessionDeletions();
    expect(deletion).not.toHaveBeenCalled();
    expect((await manager.laneStore.lanesForThread('parent'))[0].nativeDeletion?.state).toBe('held');
    await manager.requestNativeSessionDeletion('parent', 0);
    await manager.reconcileNativeSessionDeletions();
    expect(deletion).toHaveBeenLastCalledWith('thread/delete', { threadId: targets[0].sessionId });
  });

  it('holds conflicting late identities instead of replacing or deleting the first receipt', async () => {
    creation.resolve(); execution.resolve(); exit.resolve();
    await finish(await launch());
    const lane = (await manager.laneStore.lanesForThread('parent'))[0];
    await manager.requestNativeSessionDeletion('parent', 0);
    await manager.laneStore.captureNativeSession(lane.id, lane.contextGeneration ?? 0, { ...targets[0], command: 'different-synthetic-codex' });
    await manager.reconcileNativeSessionDeletions();
    expect(deletion).not.toHaveBeenCalled();
    expect((await manager.laneStore.lanesForThread('parent'))[0]).toMatchObject({
      nativeSession: targets[0], nativeSessionConflict: true, state: 'dirty', nativeDeletion: { state: 'held' },
    });
  });

  it('deletes both old and new native identities after a worker-only context reset', async () => {
    creation.resolve(); execution.resolve(); exit.resolve();
    await finish(await launch());
    const lane = (await manager.laneStore.lanesForThread('parent'))[0];
    await manager.resetWorkerContext(parent.thread, lane.id, lane.contextGeneration ?? 0);
    expect((await manager.laneStore.lanesForThread('parent'))[0].nativeSessionHistory).toEqual([targets[0]]);
    await finish(await launch());
    expect(targets).toHaveLength(2);
    await manager.requestNativeSessionDeletion('parent', 0);
    await manager.reconcileNativeSessionDeletions();
    expect(deletion.mock.calls.filter(([method]) => method === 'thread/delete').map(([, params]) => params.threadId))
      .toEqual(targets.map(target => target.sessionId));
    expect((await manager.laneStore.lanesForThread('parent'))[0].nativeDeletion?.state).toBe('deleted');
  });

  it('retains native ownership after a pool reset until parent clear deletes it', async () => {
    creation.resolve(); execution.resolve(); exit.resolve();
    await finish(await launch());
    await manager.resetWorkerLanes('parent', 'codex');
    const retained = (await manager.laneStore.lanesForThread('parent'))[0];
    expect(retained).toMatchObject({ contextRetired: true, nativeSession: targets[0] });
    await manager.requestNativeSessionDeletion('parent', 0);
    await manager.reconcileNativeSessionDeletions();
    expect(deletion).toHaveBeenLastCalledWith('thread/delete', { threadId: targets[0].sessionId });
  });

  it.each(['reset', 'reuse'])('never uses a later executor proof to clear an earlier unconfirmed writer: %s', async mode => {
    creation.resolve(); execution.resolve(); exit.resolve();
    const create = factory.getMockImplementation()!;
    let executions = 0;
    factory.mockImplementation((...args) => {
      const worker = create(...args);
      if (++executions === 1) worker.waitForManagedProcessGroupExit = vi.fn(async () => { throw new Error('Synthetic earlier live writer'); });
      return worker;
    });
    await finish(await launch());
    const first = (await manager.laneStore.lanesForThread('parent'))[0];
    if (mode === 'reset') await manager.resetWorkerContext(parent.thread, first.id, first.contextGeneration ?? 0);
    await finish(await launch());
    const current = (await manager.laneStore.lanesForThread('parent'))[0];
    expect(current.nativeGroupExitGeneration).toBe(current.contextGeneration);
    expect(current.nativeHistoryExitUnconfirmed).toBe(true);
    await manager.requestNativeSessionDeletion('parent', 0);
    await manager.reconcileNativeSessionDeletions();
    expect(deletion).not.toHaveBeenCalled();
    expect((await manager.laneStore.lanesForThread('parent'))[0].nativeDeletion?.state).toBe('waiting-exit');
  });

  it('persists exact deletion preparation and recovers lost acknowledgement after restart', async () => {
    creation.resolve(); execution.resolve(); exit.resolve();
    await finish(await launch());
    const normal = deletion.getMockImplementation()!;
    let removed = false;
    deletion.mockImplementation(async (method, params) => {
      if (method === 'thread/list' && removed) return { data: [], nextCursor: null };
      if (method !== 'thread/delete') return normal(method, params);
      if (removed) throw Object.assign(new Error(`no rollout found for thread id ${params.threadId}`), { code: -32600 });
      removed = true;
      throw new Error('Synthetic acknowledgement loss');
    });
    await manager.requestNativeSessionDeletion('parent', 0);
    await manager.reconcileNativeSessionDeletions();
    const lane = (await manager.laneStore.lanesForThread('parent'))[0];
    expect(lane.nativeDeletion?.state).toBe('uncertain');
    expect(lane.nativeDeletionPreparations?.[targets[0].sessionId]).toMatchObject({ version: 1, nativeVersion: '0.166.0' });
    await manager.destroy();
    manager = new DelegationManager(new DirectoryGuard([home]), factory as any,
      new BackendRegistry(async () => 'synthetic 1.0'), undefined, undefined, 1000, undefined, undefined,
      () => ({ start: async () => {}, stop: async () => {}, getServerVersion: () => '0.166.0', request: deletion }));
    await manager.reconcileNativeSessionDeletions();
    expect((await manager.laneStore.lanesForThread('parent'))[0].nativeDeletion?.state).toBe('deleted');
  });

  it('reports unaudited backends unsupported without removing their lane evidence', async () => {
    const lanes = [];
    for (const backend of DELEGATION_BACKENDS.filter(value => !['codex', 'kimi', 'pi', 'claude'].includes(value))) {
      const { lane } = await manager.laneStore.acquire({ threadId: 'parent', backend, workingDirectory: home, workspaceGeneration: 0 });
      lanes.push(lane);
      await manager.laneStore.markReady(lane.id);
    }
    await manager.requestNativeSessionDeletion('parent', 0);
    await manager.reconcileNativeSessionDeletions();
    expect(deletion).not.toHaveBeenCalled();
    expect(await manager.laneStore.lanesForThread('parent')).toEqual(expect.arrayContaining(lanes.map(lane => expect.objectContaining({
      id: lane.id, nativeDeletion: expect.objectContaining({ state: 'unsupported' }),
    }))));
  });
});
