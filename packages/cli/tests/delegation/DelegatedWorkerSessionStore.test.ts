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
