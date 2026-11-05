import { NativeHistoryAnchor } from '../../src/delegation/HistoryAnchor';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { pathToFileURL } from 'url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureDshDeletionTarget, createDshHistoryScope, deleteOwnedDshSession, dshHistoryPatch,
  validDshDeletionPreparation, type DshDeletionTarget, type DshHistoryScope, type DshDeletionPreparation } from '../../src/delegation/DshSessionDeletion';
import { LinuxHistoryAnchor } from '../../src/delegation/LinuxHistoryAnchor';

const PlatformHistoryAnchor = process.platform === 'linux' ? LinuxHistoryAnchor : NativeHistoryAnchor;


describe('owned DSH history deletion', () => {
  let home: string, scope: DshHistoryScope, target: DshDeletionTarget, transcript: string, pointer: string;
  let preparation: DshDeletionPreparation | undefined;
  const persistPrepared = async (value: DshDeletionPreparation) => { preparation = JSON.parse(JSON.stringify(value)); };
  const header = (id: string, extra = {}) => ({ type: 'session', version: 4, id, createdAt: 0, cwd: home,
    isSeeded: false, delegationDepth: 0, ...extra });
  const writeSession = async (id: string, extra = {}) => {
    const file = path.join(scope.history.path, 'sessions', 'project', id, 'session.v4.jsonl');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(header(id, extra)) + '\n');
    await fs.writeFile(path.join(path.dirname(file), 'session.lock'), '');
    return file;
  };
  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-deletion-')));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    for (const key of ['HOME', 'USERPROFILE', 'DSH_HOME', 'CODEX_HOME']) vi.stubEnv(key, home);
    scope = await createDshHistoryScope(home, `delegate-lane-${randomUUID()}`, home);
    const root = path.join(home, '.remote-cli', 'dsh-sessions');
    await fs.mkdir(root);
    const id = randomUUID();
    pointer = path.join(root, `${scope.executorThreadId}.json`);
    await fs.writeFile(pointer, JSON.stringify({ id, cwd: home }));
    target = await captureDshDeletionTarget(scope, id);
    transcript = await writeSession(id);
    preparation = undefined;
  });
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(home, { recursive: true, force: true }); });

  // Optional installed-library acceptance, never a CLI/backend launch. The caller
  // explicitly supplies a program package path; every data path remains synthetic.
  it.skipIf(!process.env.DSH_TEST_PACKAGE_ROOT)('removes native JSONL histories from list and read-open, with an idempotent retry', async () => {
    const packageFile = path.join(process.env.DSH_TEST_PACKAGE_ROOT!, 'package.json');
    const version = JSON.parse(await fs.readFile(packageFile, 'utf8')).version;
    const prefix = path.join(process.env.DSH_TEST_PACKAGE_ROOT!, 'node_modules', '@deepseek-ai');
    const load = (name: string) => import(/* @vite-ignore */ pathToFileURL(path.join(prefix, name, 'lib', 'index.js')).href);
    const [{ Context }, persistence, errors] = await Promise.all([load('cordis'), load('dsh-session-persistence-jsonl'), load('dsh-session-persistence')]);
    const root = path.join(scope.history.path, 'sessions');
    await fs.rm(root, { recursive: true });
    let ctx: any;
    try {
      ctx = new Context();
      await ctx.plugin(persistence, { root, compression: 'none' });
      const writer = await ctx.sessionPersistence.create({ version: 4, id: target.sessionId, createdAt: 1, cwd: home, isSeeded: false });
      await writer.append([
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
      ]);
      await writer.flush(); await writer.close();
      expect(await ctx.sessionPersistence.list()).toHaveLength(1);
      const reader = await ctx.sessionPersistence.open(target.sessionId, 'read');
      await reader.close();
      await ctx.fiber.dispose(); ctx = undefined;
      expect(await deleteOwnedDshSession(target, { persistPrepared })).toMatchObject({ state: 'deleted' });
      expect(await deleteOwnedDshSession(target, { prepared: preparation })).toMatchObject({ state: 'deleted' });
      ctx = new Context(); await ctx.plugin(persistence, { root, compression: 'none' });
      expect(await ctx.sessionPersistence.list()).toEqual([]);
      await expect(ctx.sessionPersistence.open(target.sessionId, 'read')).rejects.toBeInstanceOf(errors.SessionPersistenceNotFoundError);
      expect(JSON.parse(await fs.readFile(packageFile, 'utf8')).version).toBe(version);
      console.info(`[DSH native storage acceptance] package ${version}; list/read-open absent; retry acknowledged; no model calls`);
    } finally { if (ctx) await ctx.fiber.dispose(); }
  });

  it('removes multiple recorded root histories from one reused scope and retries the same manifest', async () => {
    const id = randomUUID();
    await writeSession(id);
    await fs.writeFile(pointer, JSON.stringify({ id, cwd: home }));
    const second = await captureDshDeletionTarget(scope, id);
    expect((await deleteOwnedDshSession(target, { detachedPointer: true, persistPrepared })).state).toBe('held');
    const ownedTargets = [target, second];
    expect((await deleteOwnedDshSession(target, { detachedPointer: true, ownedTargets, persistPrepared })).state).toBe('deleted');
    expect(preparation?.sessionIds).toEqual(expect.arrayContaining([target.sessionId, id]));
    expect((await deleteOwnedDshSession(target, { detachedPointer: true, ownedTargets, prepared: preparation })).state).toBe('deleted');
    expect(await fs.readdir(scope.history.path)).toEqual([]);
  });

  it('keeps the reusable scope stable, then removes owned history while retaining results and unrelated pointers', async () => {
    const patch = await dshHistoryPatch(scope);
    expect(await dshHistoryPatch(scope)).toBe(patch);
    expect(patch).toContain(`root: ${JSON.stringify(path.join(scope.history.path, 'sessions'))}`);
    expect(patch).toContain('compression: "none"');
    expect(patch).not.toContain('DSH_HOME');
    const artifact = path.join(scope.scope.path, 'retained', 'result.txt');
    await fs.writeFile(artifact, 'Synthetic deliverable');
    await fs.writeFile(path.join(scope.history.path, 'query', 'index.sqlite'), 'Synthetic private search index');
    const foreign = path.join(path.dirname(pointer), 'foreground.json');
    const bytes = JSON.stringify({ id: 'another:valid/opaque%id', cwd: home });
    await fs.writeFile(foreign, bytes);
    await fs.writeFile(path.join(path.dirname(pointer), 'foreground.handoff.json'), '{"text":"Synthetic handoff"}');
    const own = await fs.readFile(pointer);
    expect(await deleteOwnedDshSession(target, { persistPrepared })).toMatchObject({ state: 'deleted' });
    expect(await fs.readdir(scope.history.path)).toEqual([]);
    expect(await fs.readFile(artifact, 'utf8')).toBe('Synthetic deliverable');
    expect(await fs.readFile(foreign, 'utf8')).toBe(bytes);
    expect(await fs.readFile(pointer)).toEqual(own);
    expect(await deleteOwnedDshSession(target, { prepared: preparation })).toMatchObject({ state: 'deleted' });
  });
  it('deletes confirmed native subagent descendants but holds any external reference to them', async () => {
    const child = randomUUID();
    await writeSession(child, { parentSession: target.sessionId, origin: 'subagent', delegationDepth: 1, isSeeded: true });
    const foreign = path.join(path.dirname(pointer), 'adopted.json');
    await fs.writeFile(foreign, JSON.stringify({ id: child }));
    expect(await deleteOwnedDshSession(target, { persistPrepared })).toMatchObject({ state: 'held' });
    expect(preparation).toBeUndefined();
    await fs.unlink(foreign);
    expect(await deleteOwnedDshSession(target, { persistPrepared })).toMatchObject({ state: 'deleted' });
    expect(preparation?.sessionIds.sort()).toEqual([child, target.sessionId].sort());
  });
  it.each(['unrelated-root', 'fork', 'cycle', 'unknown-file', 'bad-json', 'seeded-root', 'missing-root'])(
    'holds ambiguous native history: %s', async kind => {
      if (kind === 'unknown-file') await fs.writeFile(path.join(scope.history.path, 'results.zip'), 'Retain');
      else if (kind === 'bad-json') await fs.writeFile(transcript, '{');
      else if (kind === 'seeded-root') await fs.writeFile(transcript, JSON.stringify(header(target.sessionId, { isSeeded: true })));
      else if (kind === 'missing-root') await fs.unlink(transcript);
      else {
        const id = randomUUID();
        await writeSession(id, kind === 'unrelated-root' ? {} : { parentSession: kind === 'cycle' ? id : target.sessionId,
          ...(kind === 'cycle' ? { origin: 'subagent' } : {}) });
      }
      expect(await deleteOwnedDshSession(target, { persistPrepared })).toMatchObject({ state: 'held' });
      expect(preparation).toBeUndefined();
    });
  it('rejects newline history names through native filename rules or layout validation', async () => {
    if (process.platform === 'win32') {
      // Win32 rejects control characters before such a file can enter the inventory.
      await expect(fs.copyFile(transcript, transcript + '\n')).rejects.toMatchObject({ code: expect.stringMatching(/^(ENOENT|EINVAL)$/) });
      expect(await fs.readFile(transcript, 'utf8')).toContain(target.sessionId);
    } else {
      await fs.copyFile(transcript, transcript + '\n');
      expect(await deleteOwnedDshSession(target, { persistPrepared })).toMatchObject({ state: 'held' });
      expect(preparation).toBeUndefined();
    }
  });
  it.each(['same-id', 'missing-id', 'invalid-json', 'symlink', 'hardlink', 'oversized'])(
    'holds unsafe foreign pointers before preparation: %s', async kind => {
      const foreign = path.join(path.dirname(pointer), 'foreign.json');
      if (kind === 'symlink') await fs.symlink(pointer, foreign);
      else if (kind === 'hardlink') await fs.link(pointer, foreign);
      else await fs.writeFile(foreign, kind === 'same-id' ? JSON.stringify({ id: target.sessionId })
        : kind === 'missing-id' ? '{}' : kind === 'oversized' ? 'x'.repeat(65537) : '{');
      expect(await deleteOwnedDshSession(target, { persistPrepared })).toMatchObject({ state: 'held' });
      expect(preparation).toBeUndefined();
      expect(await fs.readFile(transcript, 'utf8')).toContain(target.sessionId);
    });
  it('requires explicit detachment when the worker pointer moves to a fresh context', async () => {
    await fs.writeFile(pointer, JSON.stringify({ id: randomUUID(), cwd: home }));
    expect(await deleteOwnedDshSession(target, { persistPrepared })).toMatchObject({ state: 'held' });
    expect(await deleteOwnedDshSession(target, { persistPrepared, detachedPointer: true })).toMatchObject({ state: 'deleted' });
  });
  it('does not accept an adopted target or missing durable preparation', async () => {
    expect(await deleteOwnedDshSession({ ...target, provenance: 'adopted' } as any, { persistPrepared })).toMatchObject({ state: 'held' });
    expect(await deleteOwnedDshSession(target, {})).toMatchObject({ state: 'held' });
    expect(preparation).toBeUndefined();
  });
  it('keeps an immutable manifest for partial-failure retry', async () => {
    const remove = PlatformHistoryAnchor.prototype.remove;
    let count = 0;
    vi.spyOn(PlatformHistoryAnchor.prototype, 'remove').mockImplementation(async function (entry) {
      if (++count === 2) throw new Error('Synthetic failure after one removal');
      return remove.call(this, entry);
    });
    expect(await deleteOwnedDshSession(target, { persistPrepared })).toMatchObject({ state: 'uncertain' });
    const before = JSON.stringify(preparation);
    vi.restoreAllMocks();
    expect(await deleteOwnedDshSession(target, { prepared: preparation })).toMatchObject({ state: 'deleted' });
    expect(JSON.stringify(preparation)).toBe(before);
  });
  it('rejects changed files on a prepared retry and never widens the manifest', async () => {
    await deleteOwnedDshSession(target, { persistPrepared: async value => { await persistPrepared(value); throw new Error('Synthetic durable write interruption'); } });
    expect(validDshDeletionPreparation(target, preparation)).toBe(true);
    await fs.appendFile(transcript, 'changed');
    expect(await deleteOwnedDshSession(target, { prepared: preparation })).toMatchObject({ state: 'held' });
    preparation!.files[0].path = path.join(scope.scope.path, 'retained');
    expect(validDshDeletionPreparation(target, preparation)).toBe(false);
  });
  it('rechecks foreign references after preparation persistence', async () => {
    const result = await deleteOwnedDshSession(target, { persistPrepared: async value => {
      await persistPrepared(value);
      await fs.writeFile(path.join(path.dirname(pointer), 'late.json'), JSON.stringify({ id: target.sessionId }));
    } });
    expect(result.state).toBe('held');
    expect(await fs.readFile(transcript, 'utf8')).toContain(target.sessionId);
  });
  it('anchors deletion against a parent symlink replacement and reports uncertain completion', async () => {
    const foreign = path.join(home, 'foreign-history');
    await fs.mkdir(foreign);
    await fs.writeFile(path.join(foreign, 'keep.txt'), 'Unrelated history');
    const remove = PlatformHistoryAnchor.prototype.remove;
    let moved = false;
    vi.spyOn(PlatformHistoryAnchor.prototype, 'remove').mockImplementation(async function (entry) {
      if (!moved) {
        moved = true;
        await fs.rename(scope.history.path, path.join(scope.scope.path, 'moved-history'));
        await fs.symlink(foreign, scope.history.path);
      }
      await remove.call(this, entry);
    });
    expect(await deleteOwnedDshSession(target, { persistPrepared })).toMatchObject({ state: 'uncertain' });
    expect(await fs.readFile(path.join(foreign, 'keep.txt'), 'utf8')).toBe('Unrelated history');
  });
});
