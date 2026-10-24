import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { DelegatedWorkerSessionStore, type DelegatedWorkerLane } from '../../src/delegation/DelegatedWorkerSessionStore';
import { clearDelegatedWorkerContext } from '../../src/delegation/DelegatedWorkerLaneCleanup';
import { ThreadContextReset } from '../../src/thread/ThreadContextReset';

describe('durable worker inventory during thread context reset', () => {
  let home: string;
  let directory: string;
  let workspace: string;
  let resets: ThreadContextReset;
  const originalHomedir = os.homedir.bind(os);
  const identity = () => ({ threadId: 'parent-thread', backend: 'codex' as const,
    workingDirectory: workspace, workspaceGeneration: 0 });
  const createStore = () => new DelegatedWorkerSessionStore(directory, resets);
  const record = (lane: DelegatedWorkerLane) => path.join(directory, `${lane.id}.json`);
  const pointer = (lane: DelegatedWorkerLane) => path.join(home, '.remote-cli', `${lane.backend}-sessions`, `${lane.executorThreadId}.json`);
  const write = async (file: string, content: string) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  };
  const seed = async (store: DelegatedWorkerSessionStore, backend: 'codex' | 'dsh' = 'codex', threadId = 'parent-thread') => {
    const { lane } = await store.acquire({ ...identity(), backend, threadId });
    await store.markReady(lane.id);
    await write(pointer(lane), 'old worker continuation');
    if (backend === 'dsh') await write(pointer(lane).replace('.json', '.handoff.json'), 'old handoff');
    return lane;
  };
  const clear = (lane: DelegatedWorkerLane) => clearDelegatedWorkerContext(lane, home);
  const finishReset = async (store: DelegatedWorkerSessionStore, cleanup = clear) => {
    await store.assertThreadContextResettable('parent-thread');
    await store.clearThreadContexts('parent-thread', cleanup);
    await resets.complete('parent-thread');
  };

  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'worker-inventory-reset-')));
    vi.stubEnv('HOME', home);
    vi.spyOn(os, 'homedir').mockImplementation(() => process.env.HOME || originalHomedir());
    directory = path.join(home, 'lanes');
    workspace = path.join(home, 'project');
    await fs.mkdir(workspace);
    resets = new ThreadContextReset(path.join(home, 'reset-markers'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true });
  });

  it.each([false, true])('retires cleared superseded shared lanes across restart, retry and a second reset (legacy: %s)', async legacy => {
    const original = createStore();
    const old = await seed(original);
    await expect(original.clearContext(old.id, 0, old, async () => { throw new Error('Synthetic interrupted reset'); }))
      .rejects.toThrow('interrupted');
    if (legacy) {
      const saved = JSON.parse(await fs.readFile(record(old), 'utf8'));
      delete saved.pooled;
      await fs.writeFile(record(old), JSON.stringify(saved));
    }
    const store = createStore();
    const replacement = await seed(store);
    const later = await seed(store, 'dsh');
    const sibling = await seed(store, 'codex', 'sibling-thread');
    const preserved = [path.join(workspace, 'result.txt'),
      path.join(home, 'artifacts', 'result.patch'), path.join(home, 'worktrees', 'worker', 'source.txt'),
      path.join(home, '.remote-cli', 'codex-sandbox', `${old.executorThreadId}.json`),
      path.join(home, '.remote-cli', 'pi-sessions', 'store', 'archive.jsonl')];
    for (const file of preserved) await write(file, 'preserved fixture');

    const unlink = fs.unlink.bind(fs);
    const failure = vi.spyOn(fs, 'unlink').mockImplementation(async file => {
      if (file === pointer(later)) throw Object.assign(new Error('Synthetic cleanup access failure'), { code: 'EACCES' });
      return unlink(file);
    });
    const cleanup = vi.fn(clear);
    await resets.begin('parent-thread');
    await expect(finishReset(store, cleanup)).rejects.toThrow('access failure');
    expect(resets.isPending('parent-thread')).toBe(true);
    expect(JSON.parse(await fs.readFile(record(old), 'utf8'))).toMatchObject({ state: 'dirty',
      contextRetired: true, contextResetPending: false, contextGeneration: 1, lastClearedGeneration: 0 });
    await expect(fs.stat(pointer(old))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(pointer(replacement))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(pointer(later), 'utf8')).toBe('old worker continuation');
    failure.mockRestore();

    // Both the inventory and the thread admission barrier must survive restart.
    resets = new ThreadContextReset(path.join(home, 'reset-markers'));
    const restarted = createStore();
    await expect(restarted.acquire(identity())).rejects.toThrow('incomplete');
    await finishReset(restarted, cleanup);
    expect(resets.isPending('parent-thread')).toBe(false);
    expect(cleanup.mock.calls.filter(([lane]) => lane.id === old.id)).toHaveLength(1);
    expect((await restarted.lanesForThread('parent-thread')).find(lane => lane.id === old.id))
      .toMatchObject({ state: 'dirty', contextRetired: true, contextResetPending: false });
    await expect(restarted.markReady(old.id)).rejects.toThrow('retired');
    await expect(restarted.markRunning(old.id)).rejects.toThrow('retired');
    const calls = cleanup.mock.calls.length;
    await restarted.clearContext(old.id, 0, old, cleanup);
    await expect(restarted.clearContext(old.id, 1, old, cleanup)).rejects.toThrow('unconfirmed');
    expect(cleanup).toHaveBeenCalledTimes(calls);

    const next = await restarted.acquire(identity());
    expect(next).toMatchObject({ reused: true, lane: { id: replacement.id } });
    await expect(fs.stat(pointer(next.lane))).rejects.toMatchObject({ code: 'ENOENT' });
    await restarted.markReady(next.lane.id);
    await write(pointer(next.lane), 'fresh worker continuation');
    await resets.begin('parent-thread');
    await finishReset(restarted, cleanup);
    expect(resets.isPending('parent-thread')).toBe(false);
    expect(cleanup.mock.calls.filter(([lane]) => lane.id === old.id)).toHaveLength(1);
    for (const lane of [old, replacement, later]) await expect(fs.stat(pointer(lane))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(pointer(later).replace('.json', '.handoff.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(pointer(sibling), 'utf8')).toBe('old worker continuation');
    expect((await restarted.lanesForThread('sibling-thread'))[0]).toMatchObject({ id: sibling.id, state: 'ready' });
    for (const file of preserved) expect(await fs.readFile(file, 'utf8')).toBe('preserved fixture');
    expect(await restarted.cleanupCandidates()).toEqual([]);
    // Retirement never overrides a later outstanding cleanup request.
    await restarted.markCleanupFailure(old.id, 'Synthetic pending cleanup');
    await expect(restarted.assertThreadContextResettable('parent-thread')).rejects.toThrow('shutdown is unconfirmed');
    expect(await restarted.cleanupCandidates()).toEqual([expect.objectContaining({ id: old.id, cleanupPending: true })]);
  });

  it.each(['enumeration', 'metadata', 'read'] as const)('blocks incomplete %s inventory and retries in the same process after access recovery', async operation => {
    const original = createStore();
    const first = await seed(original);
    const omitted = await seed(original, 'dsh');
    const sibling = await seed(original, 'codex', 'sibling-thread');
    const saved = await fs.readFile(record(omitted), 'utf8');
    const readFile = fs.readFile.bind(fs);
    const error = Object.assign(new Error('Synthetic inventory access failure'), { code: 'EACCES' });
    await resets.begin('parent-thread');
    const failure = operation === 'enumeration' ? vi.spyOn(fs, 'readdir').mockRejectedValue(error)
      : operation === 'metadata' ? vi.spyOn(fs, 'lstat').mockRejectedValue(error)
      : vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
        if (args[0] === record(omitted)) throw error;
        return readFile(...args);
      });
    const restarted = createStore();
    const cleanup = vi.fn(clear);
    await expect(restarted.initialize()).rejects.toMatchObject({ message: expect.stringContaining('inventory'), cause: { code: 'EACCES' } });
    await expect(restarted.cleanupCandidates()).rejects.toThrow('inventory');
    await expect(finishReset(restarted, cleanup)).rejects.toThrow('inventory');
    await expect(restarted.acquire(identity())).rejects.toThrow('inventory');
    expect(cleanup).not.toHaveBeenCalled();
    expect(resets.isPending('parent-thread')).toBe(true);
    expect(await readFile(pointer(first), 'utf8')).toBe('old worker continuation');
    expect(await readFile(pointer(omitted), 'utf8')).toBe('old worker continuation');
    expect(await readFile(record(omitted), 'utf8')).toBe(saved);
    failure.mockRestore();

    // Failed initialization must neither cache rejection nor publish a partial inventory.
    await expect(restarted.acquire(identity())).rejects.toThrow('incomplete');
    await finishReset(restarted, cleanup);
    expect(cleanup.mock.calls.map(([lane]) => lane.id).sort()).toEqual([first.id, omitted.id].sort());
    expect(resets.isPending('parent-thread')).toBe(false);
    const reloaded = createStore();
    expect((await reloaded.acquire(identity())).lane.id).toBe(first.id);
    for (const lane of [first, omitted]) await expect(fs.stat(pointer(lane))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(pointer(sibling), 'utf8')).toBe('old worker continuation');
  });

  it('rejects a record disappearing between metadata and read instead of omitting its surviving pointer', async () => {
    const original = createStore();
    const lane = await seed(original);
    await resets.begin('parent-thread');
    const file = record(lane);
    const held = `${file}.unavailable`;
    const readFile = fs.readFile.bind(fs);
    const failure = vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
      if (args[0] !== file) return readFile(...args);
      await fs.rename(file, held);
      try { return await readFile(...args); }
      finally { await fs.rename(held, file); }
    });
    const restarted = createStore();
    const cleanup = vi.fn(clear);
    await expect(finishReset(restarted, cleanup)).rejects.toMatchObject({ cause: { code: 'ENOENT' } });
    expect(resets.isPending('parent-thread')).toBe(true);
    expect(cleanup).not.toHaveBeenCalled();
    expect(await readFile(pointer(lane), 'utf8')).toBe('old worker continuation');
    failure.mockRestore();
    await expect(restarted.acquire(identity())).rejects.toThrow('incomplete');
    await finishReset(restarted, cleanup);
    expect((await restarted.acquire(identity())).lane.id).toBe(lane.id);
    await expect(fs.stat(pointer(lane))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['json', 'schema', 'oversized', 'wrong-id', 'unknown-name', 'directory', 'symlink', 'dangling-symlink', 'retirement'] as const)(
    'quarantines %s inventory without rewriting or deleting unknown records', async invalid => {
      const original = createStore();
      const lane = await seed(original);
      const file = record(lane);
      const saved = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(saved);
      let unknown = file;
      if (invalid === 'json') await fs.writeFile(file, '{');
      if (invalid === 'schema') await fs.writeFile(file, JSON.stringify({ ...parsed, backend: 'unknown-backend' }));
      if (invalid === 'oversized') await fs.writeFile(file, `${saved}${' '.repeat(64 * 1024)}`);
      if (invalid === 'wrong-id') {
        unknown = path.join(directory, `${randomUUID()}.json`);
        await fs.rename(file, unknown);
      }
      if (invalid === 'unknown-name') {
        unknown = path.join(directory, 'unknown-lane.json');
        await fs.rename(file, unknown);
      }
      if (invalid === 'directory') { await fs.rm(file); await fs.mkdir(file); }
      if (invalid === 'symlink' || invalid === 'dangling-symlink') {
        const target = path.join(home, 'external-record');
        if (invalid === 'symlink') await fs.writeFile(target, saved);
        await fs.rm(file);
        await fs.symlink(target, file);
      }
      if (invalid === 'retirement') {
        // A retirement claim without confirmed clearing must not bypass the guard.
        await fs.writeFile(file, JSON.stringify({ ...parsed, state: 'dirty', contextRetired: true }));
      }
      const before = await fs.lstat(unknown);
      const contents = before.isFile() ? await fs.readFile(unknown, 'utf8') : undefined;
      await resets.begin('parent-thread');
      const restarted = createStore();
      const cleanup = vi.fn(clear);
      await expect(finishReset(restarted, cleanup)).rejects.toThrow('inventory');
      await expect(restarted.cleanupCandidates()).rejects.toThrow('inventory');
      await expect(restarted.acquire(identity())).rejects.toThrow('inventory');
      expect(cleanup).not.toHaveBeenCalled();
      expect(resets.isPending('parent-thread')).toBe(true);
      expect(await fs.readFile(pointer(lane), 'utf8')).toBe('old worker continuation');
      expect((await fs.lstat(unknown)).mtimeMs).toBe(before.mtimeMs);
      if (contents !== undefined) expect(await fs.readFile(unknown, 'utf8')).toBe(contents);
      if (invalid === 'symlink') expect(await fs.readFile(path.join(home, 'external-record'), 'utf8')).toBe(saved);

      // Only an explicit repair restores inventory authority; the store never deletes it.
      await fs.rm(unknown, { recursive: true, force: true });
      await fs.writeFile(file, saved);
      await finishReset(restarted, cleanup);
      expect((await restarted.acquire(identity())).lane.id).toBe(lane.id);
      await expect(fs.stat(pointer(lane))).rejects.toMatchObject({ code: 'ENOENT' });
    });

  it('keeps interrupted resets blocked when startup quarantine persistence fails, then permits an explicit retry', async () => {
    const original = createStore();
    const lane = await seed(original);
    await expect(original.clearContext(lane.id, 0, lane, async () => { throw new Error('Synthetic interruption'); }))
      .rejects.toThrow('interruption');
    await resets.begin('parent-thread');
    const rename = fs.rename.bind(fs);
    const failure = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === record(lane)) throw Object.assign(new Error('Synthetic storage failure'), { code: 'EIO' });
      return rename(from, to);
    });
    const restarted = createStore();
    const cleanup = vi.fn(clear);
    await expect(finishReset(restarted, cleanup)).rejects.toMatchObject({ cause: { code: 'EIO' } });
    expect(cleanup).not.toHaveBeenCalled();
    expect(resets.isPending('parent-thread')).toBe(true);
    expect(await fs.readFile(pointer(lane), 'utf8')).toBe('old worker continuation');
    expect(JSON.parse(await fs.readFile(record(lane), 'utf8'))).toMatchObject({ state: 'dirty', contextResetPending: true });
    failure.mockRestore();
    await expect(restarted.acquire(identity())).rejects.toThrow('incomplete');
    await finishReset(restarted, cleanup);
    expect(resets.isPending('parent-thread')).toBe(false);
    expect((await restarted.acquire(identity())).lane.id).toBe(lane.id);
    await expect(fs.stat(pointer(lane))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not promote an unconfirmed running lane after inventory recovery', async () => {
    const original = createStore();
    const lane = await seed(original);
    await original.markRunning(lane.id);
    await resets.begin('parent-thread');
    const failure = vi.spyOn(fs, 'readdir').mockRejectedValue(Object.assign(new Error('Synthetic access failure'), { code: 'EACCES' }));
    const restarted = createStore();
    const cleanup = vi.fn(clear);
    await expect(finishReset(restarted, cleanup)).rejects.toThrow('inventory');
    failure.mockRestore();
    await expect(finishReset(restarted, cleanup)).rejects.toThrow('shutdown is unconfirmed');
    expect((await restarted.lanesForThread('parent-thread'))[0]).toMatchObject({ state: 'dirty', cleanupPending: false });
    expect(cleanup).not.toHaveBeenCalled();
    expect(resets.isPending('parent-thread')).toBe(true);
    expect(await fs.readFile(pointer(lane), 'utf8')).toBe('old worker continuation');
    await expect(restarted.acquire(identity())).rejects.toThrow('incomplete');
  });
});
