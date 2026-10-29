import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  DelegatedWorkerSessionStore,
  workerLaneExecutorId,
  type DelegatedWorkerLaneIdentity,
} from '../../src/delegation/DelegatedWorkerSessionStore';

const identity = (workingDirectory: string, workspaceGeneration = 0): DelegatedWorkerLaneIdentity => ({
  threadId: 'parent-thread',
  backend: 'codex',
  workingDirectory,
  workspaceGeneration,
});

describe('DelegatedWorkerSessionStore', () => {
  let home: string;
  let directory: string;
  let workspace: string;

  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'delegated-worker-store-')));
    directory = path.join(home, 'lanes');
    workspace = path.join(home, 'workspace');
    await fs.mkdir(workspace);
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it('checks ownership before creating or reconciling inventory and retries acquisition failures', async () => {
    const store = new DelegatedWorkerSessionStore(directory);
    let permitted = false;
    store.setInitializationGuard(async () => {
      if (!permitted) throw new Error('Another owner is active');
    });
    await expect(store.initialize()).rejects.toThrow('Another owner is active');
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    permitted = true;
    await store.initialize();
    expect((await fs.stat(directory)).isDirectory()).toBe(true);
  });

  it.each(['pending', 'removed'])('never resumes a %s historical discard, even with ready native metadata', async state => {
    const store = new DelegatedWorkerSessionStore(directory);
    const first = await store.acquire(identity(workspace));
    await store.markReady(first.lane.id);
    const tombstones = path.join(directory, 'legacy-discarded');
    await fs.mkdir(tombstones);
    await fs.writeFile(path.join(tombstones, `${first.lane.id}.json`), JSON.stringify({ state }));
    const next = await store.acquire(identity(workspace));
    expect(next.reused).toBe(false);
    expect(next.lane.id).not.toBe(first.lane.id);
    await store.markReady(next.lane.id);
    const restarted = new DelegatedWorkerSessionStore(directory);
    const lanes = await restarted.lanesForThread('parent-thread');
    expect(lanes.find(lane => lane.id === first.lane.id)).toMatchObject({ workspaceDiscarded: true, cleanupPending: false });
    expect((await restarted.acquire(identity(workspace))).lane.id).toBe(next.lane.id);
    expect(await fs.readFile(path.join(tombstones, `${first.lane.id}.json`), 'utf8')).toBe(JSON.stringify({ state }));
  });

  it('reuses only a ready lane with the same parent, backend, workspace, and generation', async () => {
    const store = new DelegatedWorkerSessionStore(directory);
    const first = await store.acquire(identity(workspace));
    expect(first.reused).toBe(false);
    expect(first.lane.executorThreadId).toBe(workerLaneExecutorId(first.lane.id));

    await store.markRunning(first.lane.id);
    await store.markReady(first.lane.id);
    const second = await store.acquire(identity(workspace));

    expect(second).toMatchObject({ reused: true, lane: { id: first.lane.id, state: 'preparing' } });
    const differentGeneration = await store.acquire(identity(workspace, 1));
    expect(differentGeneration).toMatchObject({ reused: false });
    expect(differentGeneration.lane.id).not.toBe(first.lane.id);
  });

  it('does not resume a lane left non-terminal across a CLI restart', async () => {
    const firstStore = new DelegatedWorkerSessionStore(directory);
    const first = await firstStore.acquire(identity(workspace));
    await firstStore.markRunning(first.lane.id);

    const restored = new DelegatedWorkerSessionStore(directory);
    const next = await restored.acquire(identity(workspace));

    expect(next.reused).toBe(false);
    const lanes = await restored.lanesForThread('parent-thread');
    expect(lanes.find(lane => lane.id === first.lane.id)).toMatchObject({ state: 'dirty', cleanupPending: false });
  });

  it('retains a failed cleanup request across a CLI restart', async () => {
    const firstStore = new DelegatedWorkerSessionStore(directory);
    const first = await firstStore.acquire(identity(workspace));
    await firstStore.markReady(first.lane.id);
    await firstStore.markCleanupFailure(first.lane.id, 'Permission denied');

    const restored = new DelegatedWorkerSessionStore(directory);
    expect(await restored.cleanupCandidates()).toEqual([
      expect.objectContaining({ id: first.lane.id, state: 'dirty', cleanupPending: true, cleanupAttempts: 1 }),
    ]);
  });

  it('marks every older workspace generation for cleanup', async () => {
    const store = new DelegatedWorkerSessionStore(directory);
    const oldLane = await store.acquire(identity(workspace, 0));
    await store.markRunning(oldLane.lane.id);
    await store.markReady(oldLane.lane.id);
    const currentLane = await store.acquire(identity(workspace, 1));
    await store.markRunning(currentLane.lane.id);
    await store.markReady(currentLane.lane.id);
    const latestLane = await store.acquire(identity(workspace, 2));
    await store.markReady(latestLane.lane.id);

    const invalidated = await store.invalidateGeneration('parent-thread', 2);

    expect(invalidated).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: oldLane.lane.id, state: 'dirty', cleanupPending: true }),
      expect.objectContaining({ id: currentLane.lane.id, state: 'dirty', cleanupPending: true }),
    ]));
    const lanes = await store.lanesForThread('parent-thread');
    expect(lanes.find(lane => lane.id === latestLane.lane.id)).toMatchObject({ state: 'ready' });
  });

  it('preserves ambiguous shared-directory contexts instead of scheduling them for deletion', async () => {
    const store = new DelegatedWorkerSessionStore(directory);
    const first = await store.acquire(identity(workspace));
    const second = await store.acquire(identity(workspace));
    await store.markReady(first.lane.id);
    await store.markReady(second.lane.id);
    const restored = new DelegatedWorkerSessionStore(directory);
    const next = await restored.acquire(identity(workspace));
    expect(next.reused).toBe(false);
    expect(next.lane.id).not.toBe(first.lane.id);
    expect(next.lane.id).not.toBe(second.lane.id);
    expect(await restored.cleanupCandidates()).toEqual([]);
    expect(await restored.lanesForThread('parent-thread')).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.lane.id, state: 'dirty', cleanupPending: false }),
      expect.objectContaining({ id: second.lane.id, state: 'dirty', cleanupPending: false }),
    ]));
  });
});
