import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { DelegatedWorkerSessionStore } from '../../src/delegation/DelegatedWorkerSessionStore';
import { clearDelegatedWorkerContext } from '../../src/delegation/DelegatedWorkerLaneCleanup';
import { DELEGATION_BACKENDS } from '../../src/delegation/contract';
import { ClaudePersistentExecutor } from '../../src/executor/ClaudePersistentExecutor';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';

describe('Worker context reset', () => {
  let testHome: string;
  let store: DelegatedWorkerSessionStore;
  const identity = { threadId: 'parent', backend: 'codex' as const, workingDirectory: '/workspace/project', workspaceGeneration: 0 };
  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-context-reset-'));
    store = new DelegatedWorkerSessionStore(path.join(testHome, 'lanes'));
  });
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(testHome, { recursive: true, force: true }); });

  it('resets only the selected lane, persists its epoch, and rejects a card after reuse', async () => {
    const { lane } = await store.acquire(identity, { pooled: true });
    const other = await store.acquire(identity, { pooled: true });
    await store.markReady(lane.id);
    await store.markReady(other.lane.id);
    const clear = vi.fn(async () => {});
    await store.clearContext(lane.id, 0, identity, clear);
    await store.clearContext(lane.id, 0, identity, clear);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(await store.lanesForThread('parent')).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: lane.id, state: 'ready', contextGeneration: 1 }),
      expect.objectContaining({ id: other.lane.id, state: 'ready' }),
    ]));
    const reloaded = new DelegatedWorkerSessionStore(path.join(testHome, 'lanes'));
    const next = await reloaded.acquire(identity, { pooled: true, excluded: new Set([other.lane.id]) });
    expect(next.lane).toMatchObject({ id: lane.id, contextGeneration: 2 });
    await reloaded.markRunning(lane.id);
    await reloaded.clearContext(lane.id, 0, identity, clear);
    expect(clear).toHaveBeenCalledTimes(1);
    expect((await reloaded.lanesForThread('parent')).find(entry => entry.id === lane.id))
      .toMatchObject({ state: 'running', contextGeneration: 2 });
    await reloaded.markReady(lane.id);
    await expect(reloaded.clearContext(lane.id, 1, identity, clear)).rejects.toThrow('has changed');
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('rejects a historical reset queued behind acquisition without invoking cleanup', async () => {
    const { lane } = await store.acquire(identity);
    await store.markReady(lane.id);
    const clear = vi.fn(async () => {});
    const acquiring = store.acquire(identity);
    const clearing = store.clearContext(lane.id, 0, identity, clear);
    await expect(clearing).rejects.toThrow('has changed');
    expect((await acquiring).lane).toMatchObject({ id: lane.id, state: 'preparing', contextGeneration: 1 });
    expect(clear).not.toHaveBeenCalled();
    await expect(store.clearContext(lane.id, 1, identity, clear)).rejects.toThrow('active');
    expect(clear).not.toHaveBeenCalled();
  });

  it('rejects active, quarantined, wrong-owner, wrong-workspace and invalid references', async () => {
    const { lane } = await store.acquire(identity);
    const clear = vi.fn(async () => {});
    await expect(store.clearContext(lane.id, 0, identity, clear)).rejects.toThrow('active');
    await store.markRunning(lane.id);
    await expect(store.clearContext(lane.id, 0, identity, clear)).rejects.toThrow('active');
    await store.markDirty(lane.id, 'Unconfirmed exit');
    await expect(store.clearContext(lane.id, 0, identity, clear)).rejects.toThrow('unconfirmed');
    await store.markReady(lane.id);
    for (const change of [{ threadId: 'another' }, { workingDirectory: '/workspace/other' }, { workspaceGeneration: 1 }]) {
      await expect(store.clearContext(lane.id, 0, { ...identity, ...change }, clear)).rejects.toThrow('expired');
    }
    await expect(store.clearContext('../outside', 0, identity, clear)).rejects.toThrow('Invalid');
    await expect(store.clearContext(lane.id, -1, identity, clear)).rejects.toThrow('Invalid');
    await store.markDirty(lane.id, 'Deletion requested', true);
    await expect(store.clearContext(lane.id, 0, identity, clear)).rejects.toThrow('unconfirmed');
    expect(clear).not.toHaveBeenCalled();
  });

  it('serializes reset with acquisition and safely retries interrupted resets after restart', async () => {
    const { lane } = await store.acquire(identity);
    await store.markReady(lane.id);
    await expect(store.clearContext(lane.id, 0, identity, async () => { throw new Error('disk unavailable'); })).rejects.toThrow('disk');
    expect((await store.lanesForThread('parent'))[0]).toMatchObject({ state: 'dirty', contextResetPending: true });
    const reloaded = new DelegatedWorkerSessionStore(path.join(testHome, 'lanes'));
    let finish!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const resetting = reloaded.clearContext(lane.id, 0, identity, async () => {
      entered(); await new Promise<void>(resolve => { finish = resolve; });
    });
    await started;
    let acquired = false;
    const acquire = reloaded.acquire(identity).then(result => { acquired = true; return result; });
    await Promise.resolve(); expect(acquired).toBe(false);
    finish(); await resetting;
    expect((await acquire).lane).toMatchObject({ id: lane.id, contextGeneration: 2, contextResetPending: false });
  });

  it.each(['preparing', 'running', 'ready'] as const)(
    'does not revive a superseded shared lane or schedule its %s replacement for cleanup', async state => {
      const { lane } = await store.acquire(identity);
      await store.markReady(lane.id);
      await expect(store.clearContext(lane.id, 0, identity, async () => { throw new Error('Synthetic reset failure'); }))
        .rejects.toThrow('Synthetic');
      const reloaded = new DelegatedWorkerSessionStore(path.join(testHome, 'lanes'));
      const replacement = (await reloaded.acquire(identity)).lane;
      if (state !== 'preparing') await reloaded.markRunning(replacement.id);
      if (state === 'ready') await reloaded.markReady(replacement.id);
      const directory = path.join(testHome, '.remote-cli', 'codex-sessions');
      await fs.mkdir(directory, { recursive: true });
      const oldPointer = path.join(directory, `${lane.executorThreadId}.json`);
      const newPointer = path.join(directory, `${replacement.executorThreadId}.json`);
      await fs.writeFile(oldPointer, 'old pointer');
      await fs.writeFile(newPointer, 'new pointer');
      const clear = vi.fn(async value => clearDelegatedWorkerContext(value, testHome));
      await reloaded.clearContext(lane.id, 0, identity, clear);
      await reloaded.clearContext(lane.id, 0, identity, clear);
      expect(clear).toHaveBeenCalledTimes(1);
      await expect(fs.stat(oldPointer)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readFile(newPointer, 'utf8')).toBe('new pointer');
      expect(await reloaded.lanesForThread('parent')).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: lane.id, state: 'dirty', contextResetPending: false, lastClearedGeneration: 0 }),
        expect.objectContaining({ id: replacement.id, state }),
      ]));
      await reloaded.markReady(replacement.id);
      const restarted = new DelegatedWorkerSessionStore(path.join(testHome, 'lanes'));
      expect(await restarted.cleanupCandidates()).toEqual([]);
      expect((await restarted.acquire(identity)).lane.id).toBe(replacement.id);
      expect(await restarted.cleanupCandidates()).toEqual([]);
    });

  it.each([false, true])('preserves retry safety when persisted pooling mode is %s', async pooled => {
    const { lane } = await store.acquire(identity, { pooled });
    await store.markReady(lane.id);
    await expect(store.clearContext(lane.id, 0, identity, async () => { throw new Error('Synthetic reset failure'); }))
      .rejects.toThrow('Synthetic');
    if (!pooled) {
      // Old CLI versions did not persist the lane's scheduling mode.
      const file = path.join(testHome, 'lanes', `${lane.id}.json`);
      const saved = JSON.parse(await fs.readFile(file, 'utf8'));
      delete saved.pooled;
      await fs.writeFile(file, JSON.stringify(saved));
    }
    const reloaded = new DelegatedWorkerSessionStore(path.join(testHome, 'lanes'));
    const replacement = (await reloaded.acquire(identity, { pooled })).lane;
    await reloaded.markReady(replacement.id);
    await reloaded.clearContext(lane.id, 0, identity, async () => {});
    const lanes = await reloaded.lanesForThread('parent');
    expect(lanes.find(value => value.id === lane.id)?.state).toBe(pooled ? 'ready' : 'dirty');
    expect(lanes.find(value => value.id === replacement.id)?.state).toBe('ready');
    expect(await reloaded.cleanupCandidates()).toEqual([]);
  });

  it.each(DELEGATION_BACKENDS)('disconnects %s without deleting settings, transcripts or workspace files', async backend => {
    const { lane } = await store.acquire({ ...identity, backend });
    const root = path.join(testHome, '.remote-cli');
    const pointer = path.join(root, `${backend}-sessions`, `${lane.executorThreadId}.json`);
    const retained = [path.join(root, 'agy-homes', lane.executorThreadId, 'auth.json'),
      path.join(root, 'claude-sandbox', `${lane.executorThreadId}.json`),
      path.join(root, 'codex-sandbox', `${lane.executorThreadId}.json`),
      path.join(root, 'pi-sessions', 'store', 'transcript.jsonl'),
      path.join(testHome, 'workspace', 'result.txt'),
      path.join(root, `${backend}-sessions`, 'other-worker.json')];
    for (const file of [pointer, ...retained]) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify({ sessionFile: retained[3], value: 'preserve' }));
    }
    const handoff = path.join(root, 'dsh-sessions', `${lane.executorThreadId}.handoff.json`);
    if (backend === 'dsh') await fs.writeFile(handoff, 'seed');
    vi.stubEnv('HOME', testHome); vi.spyOn(os, 'homedir').mockReturnValue(testHome);
    await clearDelegatedWorkerContext(lane);
    await clearDelegatedWorkerContext(lane, testHome);
    await expect(fs.stat(pointer)).rejects.toMatchObject({ code: 'ENOENT' });
    if (backend === 'dsh') await expect(fs.stat(handoff)).rejects.toMatchObject({ code: 'ENOENT' });
    for (const file of retained) expect(await fs.readFile(file, 'utf8')).toContain('preserve');
  });

  it('refuses non-lane IDs and never recursively removes a directory in place of a pointer', async () => {
    const { lane } = await store.acquire(identity);
    await expect(clearDelegatedWorkerContext({ ...lane, executorThreadId: 'main-thread' }, testHome)).rejects.toThrow('Invalid');
    const pointer = path.join(testHome, '.remote-cli', 'codex-sessions', `${lane.executorThreadId}.json`);
    await fs.mkdir(pointer, { recursive: true });
    await expect(clearDelegatedWorkerContext(lane, testHome)).rejects.toThrow('Expected a file');
    expect((await fs.stat(pointer)).isDirectory()).toBe(true);
  });

  it('starts a fresh Claude executor after clearing while leaving the parent conversation intact', async () => {
    vi.stubEnv('HOME', testHome); vi.spyOn(os, 'homedir').mockReturnValue(testHome);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { lane } = await store.acquire({ ...identity, backend: 'claude', workingDirectory: testHome });
    const directory = path.join(testHome, '.remote-cli', 'claude-sessions');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, `${lane.executorThreadId}.json`), JSON.stringify({ id: 'old-worker-session' }));
    await fs.writeFile(path.join(directory, 'parent.json'), JSON.stringify({ id: 'parent-session' }));
    const guard = new DirectoryGuard([testHome]);
    const create = (id: string) => new ClaudePersistentExecutor(guard, testHome, id, undefined, undefined, undefined, false);
    const old = create(lane.executorThreadId);
    expect(old.getSessionId()).toBe('old-worker-session');
    await old.destroy();
    await clearDelegatedWorkerContext(lane);
    const fresh = create(lane.executorThreadId);
    const parent = create('parent');
    expect(fresh.getSessionId()).toBeNull();
    expect(parent.getSessionId()).toBe('parent-session');
    await fresh.destroy(); await parent.destroy();
  });
});
