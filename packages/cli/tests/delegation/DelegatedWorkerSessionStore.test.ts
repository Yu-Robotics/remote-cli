import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    directory = path.join(home, 'lanes');
    workspace = path.join(home, 'workspace');
    await fs.mkdir(workspace);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
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

  it('preserves legacy dirty records without interpreting missing shutdown fields as reusable context', async () => {
    const store = new DelegatedWorkerSessionStore(directory);
    const { lane } = await store.acquire(identity(workspace));
    await store.markDirty(lane.id, 'Unknown legacy exit');
    const snapshot = await fs.readFile(path.join(directory, `${lane.id}.json`), 'utf8');
    const restarted = new DelegatedWorkerSessionStore(directory);
    const next = await restarted.acquire(identity(workspace));
    expect(next.reused).toBe(false);
    expect(next.lane.id).not.toBe(lane.id);
    expect(await fs.readFile(path.join(directory, `${lane.id}.json`), 'utf8')).toBe(snapshot);
    expect((await restarted.lanesForThread('parent-thread')).find(entry => entry.id === lane.id)?.shutdownConfirmedGeneration).toBeUndefined();
  });

  it('never copies a stale lane ID or native pointer into a fresh generation', async () => {
    const store = new DelegatedWorkerSessionStore(directory);
    const first = await store.acquire(identity(workspace));
    await store.markReady(first.lane.id);
    const next = await store.acquire({ ...first.lane, workspaceGeneration: 1 });
    expect(next.lane.id).not.toBe(first.lane.id);
    expect(next.lane.executorThreadId).not.toBe(first.lane.executorThreadId);
    expect((await store.lanesForThread(first.lane.threadId))).toHaveLength(2);
  });

  it.each(['json', 'backend', 'missing-field', 'read-error'])(
    'allocates fresh lanes without reusing or clearing incomplete %s history', async failure => {
      const original = new DelegatedWorkerSessionStore(directory);
      const healthy = await original.acquire(identity(workspace));
      await original.markReady(healthy.lane.id);
      const historical = await original.acquire({ ...identity(workspace), threadId: 'historical-thread' });
      await original.markReady(historical.lane.id);
      const file = path.join(directory, `${historical.lane.id}.json`);
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
      if (failure === 'backend') parsed.backend = 'future-backend';
      if (failure === 'missing-field') delete parsed.workspaceGeneration;
      await fs.writeFile(file, failure === 'json' ? '{' : JSON.stringify(parsed));
      const before = await fs.readFile(file);
      const healthyFile = path.join(directory, `${healthy.lane.id}.json`);
      const healthyBefore = await fs.readFile(healthyFile);
      const readFile = fs.readFile.bind(fs);
      if (failure === 'read-error') vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
        if (args[0] === file) throw Object.assign(new Error('Synthetic inaccessible record'), { code: 'EACCES' });
        return readFile(...args);
      });
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const store = new DelegatedWorkerSessionStore(directory);
      const acquired = await store.acquire(identity(workspace));
      expect(acquired.reused).toBe(false);
      expect(acquired.lane.id).not.toBe(healthy.lane.id);
      expect(acquired.lane.id).not.toBe(historical.lane.id);
      expect(await store.getInventoryStatus()).toEqual({ complete: false, quarantinedRecords: 1 });
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('inventory is incomplete'));
      // A Git launch reconciles this listing before acquisition. Old ready lanes
      // must not leak into that caller's optional reclamation pass.
      expect(await store.lanesForThread('historical-thread')).toEqual([]);
      expect(await store.lanesForThread('parent-thread')).toEqual([acquired.lane]);
      await store.markRunning(acquired.lane.id);
      await store.markShutdownConfirmed(acquired.lane.id, 0);
      await store.markReady(acquired.lane.id);
      expect((await store.acquire(identity(workspace))).reused).toBe(false);
      const clear = vi.fn();
      await expect(store.cleanupCandidates()).rejects.toThrow('inventory is incomplete');
      await expect(store.markForReset('parent-thread')).rejects.toThrow('inventory is incomplete');
      await expect(store.invalidateGeneration('parent-thread', 1)).rejects.toThrow('inventory is incomplete');
      await expect(store.assertThreadContextResettable('parent-thread')).rejects.toThrow('inventory is incomplete');
      await expect(store.clearContext(healthy.lane.id, 0, healthy.lane, clear)).rejects.toThrow('inventory is incomplete');
      await expect(store.remove(healthy.lane.id)).rejects.toThrow('inventory is incomplete');
      await expect(store.remove(historical.lane.id)).rejects.toThrow('preserved');
      expect(clear).not.toHaveBeenCalled();
      expect(await readFile(file)).toEqual(before);
      expect(await readFile(healthyFile)).toEqual(healthyBefore);
      // Exact cleanup of a newly allocated, known lane remains possible.
      await store.remove(acquired.lane.id);
      await expect(fs.stat(path.join(directory, `${acquired.lane.id}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
    });

  it('does not admit a fresh lane when its own record cannot persist', async () => {
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'unknown.json'), '{');
    const store = new DelegatedWorkerSessionStore(directory);
    const rename = vi.spyOn(fs, 'rename').mockRejectedValue(Object.assign(new Error('Synthetic write failure'), { code: 'EIO' }));
    await expect(store.acquire(identity(workspace))).rejects.toMatchObject({ code: 'EIO' });
    expect(await store.lanesForThread('parent-thread')).toEqual([]);
    rename.mockRestore();
    expect((await store.acquire(identity(workspace))).reused).toBe(false);
  });

  it('quarantines a newly unavailable discard check without reusing or reclaiming that lane', async () => {
    const store = new DelegatedWorkerSessionStore(directory);
    const first = await store.acquire(identity(workspace));
    await store.markReady(first.lane.id);
    const file = path.join(directory, `${first.lane.id}.json`);
    const before = await fs.readFile(file);
    const tombstones = path.join(directory, 'legacy-discarded');
    await fs.writeFile(tombstones, 'synthetic invalid tombstone directory');
    const next = await store.acquire(identity(workspace));
    expect(next.reused).toBe(false);
    expect(await store.getInventoryStatus()).toEqual({ complete: false, quarantinedRecords: 1 });
    expect(await store.lanesForThread('parent-thread')).toEqual([next.lane]);
    await expect(store.remove(first.lane.id)).rejects.toThrow('preserved');
    await expect(store.markReady(first.lane.id)).rejects.toThrow('quarantined');
    await expect(store.markDirty(first.lane.id, 'Must not overwrite history')).rejects.toThrow('quarantined');
    expect(await fs.readFile(file)).toEqual(before);
  });

  it('retains known lane identity when exact removal fails so cleanup can retry', async () => {
    const store = new DelegatedWorkerSessionStore(directory);
    const { lane } = await store.acquire(identity(workspace));
    const file = path.join(directory, `${lane.id}.json`);
    const remove = vi.spyOn(fs, 'rm').mockRejectedValue(Object.assign(new Error('Synthetic removal failure'), { code: 'EACCES' }));
    await expect(store.remove(lane.id)).rejects.toMatchObject({ code: 'EACCES' });
    expect(await store.lanesForThread('parent-thread')).toEqual([lane]);
    remove.mockRestore();
    await store.remove(lane.id);
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
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
