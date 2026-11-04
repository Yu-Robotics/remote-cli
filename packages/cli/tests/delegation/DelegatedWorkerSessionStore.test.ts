import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { constants, promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { deletionPreparation, type NativeSessionDeletionTarget } from '../../src/delegation/NativeSessionDeletion';
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
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    directory = path.join(home, 'lanes');
    workspace = path.join(home, 'workspace');
    await fs.mkdir(workspace);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true });
  });

  it.each([false, true])('syncs writable records before publishing exit proof (sync failure: %s)', async failSync => {
    const store = new DelegatedWorkerSessionStore(directory);
    const { lane } = await store.acquire(identity(workspace));
    const filename = path.join(directory, `${lane.id}.json`);
    const previous = await fs.readFile(filename, 'utf8');
    const open = fs.open.bind(fs);
    let syncCalls = 0;
    const closes: ReturnType<typeof vi.spyOn>[] = [];
    const openSpy = vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
      const handle = await open(file, flags, mode);
      const sync = handle.sync.bind(handle);
      closes.push(vi.spyOn(handle, 'close'));
      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        syncCalls++;
        // Model FlushFileBuffers access requirements without changing the host platform.
        const writable = typeof flags === 'string' ? /[wa+]/.test(flags)
          : Boolean(flags & (constants.O_WRONLY | constants.O_RDWR));
        if (!writable || failSync) throw Object.assign(new Error('Synthetic flush failure'), { code: 'EPERM' });
        expect(await fs.readFile(filename, 'utf8')).toBe(previous);
        expect(JSON.parse(await fs.readFile(file, 'utf8')).nativeGroupExitGeneration).toBe(0);
        await sync();
      });
      return handle;
    });
    const operation = store.markShutdownConfirmed(lane.id, 0, true);
    if (failSync) {
      await expect(operation).rejects.toMatchObject({ code: 'EPERM' });
      expect(await fs.readFile(filename, 'utf8')).toBe(previous);
      expect((await store.lanesForThread('parent-thread'))[0].nativeGroupExitGeneration).toBeUndefined();
    } else {
      await operation;
    }
    expect(syncCalls).toBe(1);
    expect(closes.length).toBeGreaterThan(0);
    for (const close of closes) expect(close).toHaveBeenCalledOnce();
    expect(await fs.readdir(directory)).toEqual([`${lane.id}.json`]);
    openSpy.mockRestore();
    if (!failSync) {
      const restarted = new DelegatedWorkerSessionStore(directory);
      expect((await restarted.lanesForThread('parent-thread'))[0].nativeGroupExitGeneration).toBe(0);
    }
  });

  it('preserves strong exit proof until native startup and never revives a deletion target', async () => {
    const store = new DelegatedWorkerSessionStore(directory);
    const { lane } = await store.acquire(identity(workspace));
    await store.markShutdownConfirmed(lane.id, 0, true);
    await store.markReady(lane.id);
    const restarted = new DelegatedWorkerSessionStore(directory);
    expect((await restarted.lanesForThread('parent-thread'))[0].nativeGroupExitGeneration).toBe(0);
    const reused = await restarted.acquire(identity(workspace));
    expect(reused.reused).toBe(true);
    expect(reused.lane.nativeGroupExitGeneration).toBe(1);
    await restarted.markRunning(lane.id);
    expect((await restarted.lanesForThread('parent-thread'))[0].nativeGroupExitGeneration).toBeUndefined();
    await expect(restarted.markShutdownConfirmed(lane.id, 0, true)).rejects.toThrow('changed');
    await restarted.requestNativeDeletion('parent-thread', 0);
    await restarted.markReady(lane.id);
    expect((await restarted.lanesForThread('parent-thread'))[0]).toMatchObject({ state: 'dirty', nativeDeleteRequested: true });
    await expect(restarted.markRunning(lane.id)).rejects.toThrow('retired');
    expect((await restarted.acquire(identity(workspace))).reused).toBe(false);
    await expect(restarted.remove(lane.id)).rejects.toThrow('retained');
  });

  it('persists prompt initialization for native reuse and forgets it on context reset', async () => {
    const store = new DelegatedWorkerSessionStore(directory);
    const { lane } = await store.acquire(identity(workspace));
    await store.markRunning(lane.id);
    await store.markPromptInitialized(lane.id, 'native-worker', 'git');
    await store.markReady(lane.id);
    const restarted = new DelegatedWorkerSessionStore(directory);
    const reused = await restarted.acquire(identity(workspace));
    expect(reused.lane.initializedPrompt).toEqual({ sessionId: 'native-worker', workspaceKind: 'git' });
    await restarted.markRunning(lane.id);
    expect((await restarted.lanesForThread('parent-thread'))[0].initializedPrompt).toBeUndefined();
    expect(reused.lane.initializedPrompt).toEqual({ sessionId: 'native-worker', workspaceKind: 'git' });
    await restarted.markPromptInitialized(lane.id, 'native-worker', 'git');
    await restarted.markReady(lane.id);
    await restarted.clearContext(lane.id, reused.lane.contextGeneration!, identity(workspace), async () => {});
    expect((await restarted.acquire(identity(workspace))).lane.initializedPrompt).toBeUndefined();
  });

  it('reserves preparation space so bounded identity history remains readable after restart', async () => {
    const store = new DelegatedWorkerSessionStore(directory);
    const { lane } = await store.acquire(identity(workspace));
    let bounded = false;
    for (let index = 0; index < 66; index++) {
      const target: NativeSessionDeletionTarget = { version: 1, backend: 'codex', sessionId: randomUUID(),
        executorThreadId: lane.executorThreadId, home: { path: home, dev: '1', ino: '1' },
        nativeHome: { path: path.join(home, '.codex'), dev: '1', ino: '2' },
        pointerHash: 'a'.repeat(64), cwd: workspace, command: `synthetic-${'x'.repeat(750)}` };
      try { await store.captureNativeSession(lane.id, 0, target); }
      catch (error) { expect(String(error)).toContain('metadata limit'); bounded = true; break; }
    }
    expect(bounded).toBe(true);
    await store.requestNativeDeletion('parent-thread', 0);
    const current = (await store.lanesForThread('parent-thread'))[0];
    const targets = [...current.nativeSessionHistory!, current.nativeSession!];
    expect(targets.length).toBeGreaterThan(1);
    for (const target of targets) await store.prepareNativeDeletion(lane.id, 0, target, deletionPreparation(target));
    expect((await fs.stat(path.join(directory, `${lane.id}.json`))).size).toBeLessThanOrEqual(64 * 1024);
    const reloaded = new DelegatedWorkerSessionStore(directory);
    expect(await reloaded.getInventoryStatus()).toEqual({ complete: true, quarantinedRecords: 0 });
    expect(Object.keys((await reloaded.lanesForThread('parent-thread'))[0].nativeDeletionPreparations!)).toHaveLength(targets.length);
  });

  it.each(['codex-thread-delete-v1', '0.166.0'] as const)(
    'reloads immutable Codex preparation marker %s and rejects replacement', async nativeVersion => {
    const store = new DelegatedWorkerSessionStore(directory);
    const { lane } = await store.acquire(identity(workspace));
    const target: NativeSessionDeletionTarget = { version: 1, backend: 'codex', sessionId: randomUUID(),
      executorThreadId: lane.executorThreadId, home: { path: home, dev: '1', ino: '1' },
      nativeHome: { path: path.join(home, '.codex'), dev: '1', ino: '2' },
      pointerHash: 'a'.repeat(64), cwd: workspace, command: 'synthetic-codex' };
    await store.captureNativeSession(lane.id, 0, target);
    await store.requestNativeDeletion('parent-thread', 0);
    const prepared = { ...deletionPreparation(target), nativeVersion };
    await store.prepareNativeDeletion(lane.id, 0, target, prepared);
    const restarted = new DelegatedWorkerSessionStore(directory);
    expect(await restarted.getInventoryStatus()).toEqual({ complete: true, quarantinedRecords: 0 });
    const replacement = { ...prepared,
      nativeVersion: nativeVersion === '0.166.0' ? 'codex-thread-delete-v1' as const : '0.166.0' as const };
    await expect(restarted.prepareNativeDeletion(lane.id, 0, target, replacement)).rejects.toThrow('cannot be replaced');
    expect((await restarted.lanesForThread('parent-thread'))[0].nativeDeletionPreparations?.[target.sessionId]).toEqual(prepared);
  });

  it('reloads an exact native non-UUID preparation and rejects an unrelated key', async () => {
    const store = new DelegatedWorkerSessionStore(directory);
    const { lane } = await store.acquire({ ...identity(workspace), backend: 'opencode' });
    const target: NativeSessionDeletionTarget = { version: 1, backend: 'opencode', sessionId: 'ses_ownedFixture123',
      executorThreadId: lane.executorThreadId, home: { path: home, dev: '1', ino: '1' },
      database: { path: path.join(home, 'sessions.sqlite'), dev: '1', ino: '2' },
      pointer: path.join(home, '.remote-cli', 'opencode-sessions', `${lane.executorThreadId}.json`),
      pointerHash: 'a'.repeat(64), cwd: workspace, command: 'synthetic-opencode', projectId: 'synthetic-project', createdAt: 1 };
    await store.captureNativeSession(lane.id, 0, target);
    await store.requestNativeDeletion('parent-thread', 0);
    const prepared = deletionPreparation(target);
    await store.prepareNativeDeletion(lane.id, 0, target, prepared);
    const restarted = new DelegatedWorkerSessionStore(directory);
    expect(await restarted.getInventoryStatus()).toEqual({ complete: true, quarantinedRecords: 0 });
    expect((await restarted.lanesForThread('parent-thread'))[0].nativeDeletionPreparations?.[target.sessionId]).toEqual(prepared);
    const file = path.join(directory, `${lane.id}.json`);
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    saved.nativeDeletionPreparations.ses_foreignFixture = prepared;
    await fs.writeFile(file, JSON.stringify(saved));
    expect(await new DelegatedWorkerSessionStore(directory).getInventoryStatus()).toEqual({ complete: false, quarantinedRecords: 1 });
  });

  it.each(['contract', 'target', 'format', 'extra-field'])(
    'quarantines a corrupted Codex preparation %s after restart', async fault => {
    const store = new DelegatedWorkerSessionStore(directory);
    const { lane } = await store.acquire(identity(workspace));
    const target: NativeSessionDeletionTarget = { version: 1, backend: 'codex', sessionId: randomUUID(),
      executorThreadId: lane.executorThreadId, home: { path: home, dev: '1', ino: '1' },
      nativeHome: { path: path.join(home, '.codex'), dev: '1', ino: '2' },
      pointerHash: 'a'.repeat(64), cwd: workspace, command: 'synthetic-codex' };
    await store.captureNativeSession(lane.id, 0, target);
    await store.requestNativeDeletion('parent-thread', 0);
    await store.prepareNativeDeletion(lane.id, 0, target, deletionPreparation(target));
    const file = path.join(directory, `${lane.id}.json`);
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    const prepared = saved.nativeDeletionPreparations[target.sessionId];
    if (fault === 'contract') prepared.nativeVersion = 'codex-thread-delete-v2';
    if (fault === 'target') prepared.targetHash = deletionPreparation({ ...target, sessionId: randomUUID() }).targetHash;
    if (fault === 'format') prepared.version = 2;
    if (fault === 'extra-field') prepared.files = [];
    const corrupt = JSON.stringify(saved);
    await fs.writeFile(file, corrupt);
    const restarted = new DelegatedWorkerSessionStore(directory);
    expect(await restarted.getInventoryStatus()).toEqual({ complete: false, quarantinedRecords: 1 });
    await expect(restarted.nativeDeletionCandidates()).rejects.toThrow();
    expect(await fs.readFile(file, 'utf8')).toBe(corrupt);
  });

  it.each([null, {}, { sessionId: '', workspaceKind: 'git' }, { sessionId: 'native', workspaceKind: 'unknown' }])(
    'quarantines malformed persisted prompt initialization: %j', async initializedPrompt => {
      const store = new DelegatedWorkerSessionStore(directory);
      const { lane } = await store.acquire(identity(workspace));
      await store.markReady(lane.id);
      const file = path.join(directory, `${lane.id}.json`);
      const saved = JSON.parse(await fs.readFile(file, 'utf8'));
      await fs.writeFile(file, JSON.stringify({ ...saved, initializedPrompt }));
      const restarted = new DelegatedWorkerSessionStore(directory);
      expect((await restarted.acquire(identity(workspace))).reused).toBe(false);
      expect(await restarted.getInventoryStatus()).toMatchObject({ complete: false });
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

  it.each(['reuse', 'reload'] as const)('preserves a noncanonical Windows alias during %s instead of relaxing discard checks', async operation => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const original = new DelegatedWorkerSessionStore(directory);
    const { lane } = await original.acquire(identity(workspace));
    await original.markReady(lane.id);
    const file = path.join(directory, `${lane.id}.json`);
    const snapshot = await fs.readFile(file);
    const realpath = fs.realpath.bind(fs);
    // Model native Windows realpath expanding a short-name alias. The inode is
    // still regular; a lexical alias alone must not satisfy canonical identity.
    const expanded = path.join(home, 'expanded-lanes');
    const aliases = vi.spyOn(fs, 'realpath').mockImplementation(async (...args) => {
      if (args[0] === directory) return expanded;
      return realpath(...args);
    });
    const store = operation === 'reuse' ? original : new DelegatedWorkerSessionStore(directory);
    if (operation === 'reuse') expect((await store.acquire(identity(workspace))).reused).toBe(false);
    else expect(await store.lanesForThread('parent-thread')).toEqual([]);
    expect(await store.getInventoryStatus()).toEqual({ complete: false, quarantinedRecords: 1 });
    await expect(store.cleanupCandidates()).rejects.toThrow('inventory is incomplete');
    await expect(store.remove(lane.id)).rejects.toThrow('preserved');
    expect(await fs.readFile(file)).toEqual(snapshot);
    aliases.mockRestore();
    // Canonical fixtures remain healthy. An already quarantined store stays
    // fenced; only a fresh, complete inventory can reuse the preserved record.
    expect((await store.getInventoryStatus()).complete).toBe(false);
    const canonical = new DelegatedWorkerSessionStore(directory);
    expect((await canonical.acquire(identity(workspace))).lane.id).toBe(lane.id);
    expect(await canonical.getInventoryStatus()).toEqual({ complete: true, quarantinedRecords: 0 });
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
