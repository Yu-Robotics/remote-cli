import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { LinuxHistoryAnchor } from '../../src/delegation/LinuxHistoryAnchor';
import { captureAgyDeletionTarget, deleteOwnedAgySession, validAgyDeletionPreparation,
  validAgyDeletionTarget, type AgyDeletionPreparation, type AgyDeletionTarget } from '../../src/delegation/AgySessionDeletion';

const capabilities = vi.hoisted(() => ({ sqlite: true }));
vi.mock('module', async importOriginal => {
  const actual = await importOriginal<typeof import('module')>();
  return { ...actual, createRequire: (filename: string) => {
    const require = actual.createRequire(filename);
    return (name: string) => {
      if (name === 'node:sqlite' && !capabilities.sqlite) throw new Error('Synthetic missing builtin');
      return require(name);
    };
  } };
});

const ID = 'a1111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const LANE = 'delegate-lane-33333333-3333-4333-8333-333333333333';
const builtin = 'node:sqlite';
const sqlite = (() => { try { return createRequire(import.meta.url)(builtin); } catch { return undefined; } })();
// Observed from AGY 1.5.0 session/list in an isolated, credential-free HOME.
// The audited package version is evidence, not the adapter's capability gate.
const NATIVE_INDEX_SCHEMA = `CREATE TABLE conversation_summaries (
  conversation_id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', preview TEXT NOT NULL DEFAULT '',
  step_count INTEGER NOT NULL DEFAULT 0, last_modified_time DATETIME NOT NULL, workspace_uris TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', project_id TEXT NOT NULL DEFAULT '',
  agent_name TEXT NOT NULL DEFAULT '', parent_conversation_id TEXT NOT NULL DEFAULT '', nesting_depth INTEGER NOT NULL DEFAULT 0,
  battle_id TEXT NOT NULL DEFAULT '', winning_conversation_id TEXT NOT NULL DEFAULT '', not_fully_idle NUMERIC NOT NULL DEFAULT false,
  killed NUMERIC NOT NULL DEFAULT false, last_user_input_time DATETIME NOT NULL, last_user_input_step_index INTEGER NOT NULL DEFAULT -1,
  app_data_dir TEXT NOT NULL DEFAULT '', raw_summary BLOB, group_id TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_conversation_summaries_last_user_input_time ON conversation_summaries(last_user_input_time);
CREATE INDEX idx_conversation_summaries_last_modified_time ON conversation_summaries(last_modified_time);`;
const INSERT_INDEX = `INSERT INTO conversation_summaries
  (conversation_id, parent_conversation_id, app_data_dir, last_modified_time, workspace_uris, last_user_input_time)
  VALUES (?, ?, ?, '2026-01-01T00:00:00Z', '[]', '2026-01-01T00:00:00Z')`;

describe('AGY exact owned history cleanup', () => {
  let home: string;
  let scope: string;
  let target: AgyDeletionTarget;
  let prepared: AgyDeletionPreparation | undefined;
  const persistPrepared = async (value: AgyDeletionPreparation) => { prepared = JSON.parse(JSON.stringify(value)); };
  const remove = (overrides: Record<string, unknown> = {}) => deleteOwnedAgySession(target, {
    confirmedProcessGroupExit: true, persistPrepared, prepared, ...overrides,
  });
  const db = () => path.join(scope, 'conversations', `${ID}.db`);

  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agy-deletion-test-')));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    scope = path.join(home, '.remote-cli', 'agy-homes', LANE, '.gemini', 'antigravity-cli');
    for (const name of ['conversations', 'annotations', 'presence', 'brain', 'cache']) await fs.mkdir(path.join(scope, name), { recursive: true });
    const pointers = path.join(home, '.remote-cli', 'agy-sessions');
    await fs.mkdir(pointers, { recursive: true });
    await fs.writeFile(path.join(pointers, `${LANE}.json`), JSON.stringify({ id: ID }));
    await fs.writeFile(db(), 'SQLite format 3\0synthetic conversation');
    await fs.writeFile(db() + '-wal', 'synthetic wal');
    await fs.writeFile(path.join(scope, 'annotations', `${ID}.pbtxt`), 'synthetic annotation');
    await fs.writeFile(path.join(scope, 'presence', `${ID}.lock`), 'synthetic presence');
    await fs.mkdir(path.join(scope, 'brain', ID, '.system_generated', 'logs'), { recursive: true });
    await fs.writeFile(path.join(scope, 'brain', ID, 'deliverable.md'), 'required output');
    await fs.writeFile(path.join(scope, 'brain', ID, '.system_generated', 'logs', 'transcript.jsonl'), 'not a resumable database');
    await fs.mkdir(path.join(home, 'worktree'));
    await fs.writeFile(path.join(home, 'worktree', 'result.txt'), 'required code artifact');
    target = await captureAgyDeletionTarget({ sessionId: ID, executorThreadId: LANE, home, cwd: home, command: 'agy' });
    prepared = undefined;
    capabilities.sqlite = true;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(home, { recursive: true, force: true });
  });

  async function index(ids = [ID]) {
    const database = new sqlite!.DatabaseSync(path.join(scope, 'conversation_summaries.db'));
    try {
      database.exec(NATIVE_INDEX_SCHEMA);
      // Native AGY records the app-data directory relative to its Gemini root.
      for (const id of ids) database.prepare(INSERT_INDEX).run(id, '', 'antigravity-cli');
    } finally { database.close(); }
  }

  it('removes both transcript variants and chunks without deleting neighboring deliverables', async () => {
    const logs = path.join(scope, 'brain', ID, '.system_generated', 'logs');
    for (const kind of ['transcript', 'transcript_full']) {
      await fs.mkdir(path.join(logs, 'chunks', kind), { recursive: true });
      await fs.writeFile(path.join(logs, `${kind}.jsonl`), 'synthetic transcript');
      await fs.writeFile(path.join(logs, 'chunks', kind, '00000000.jsonl'), 'synthetic chunk');
    }
    await fs.writeFile(path.join(logs, 'required-output.txt'), 'keep');
    expect((await remove()).state).toBe('deleted');
    for (const kind of ['transcript', 'transcript_full']) {
      await expect(fs.stat(path.join(logs, `${kind}.jsonl`))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readdir(path.join(logs, 'chunks', kind))).toEqual([]);
    }
    expect(await fs.readFile(path.join(logs, 'required-output.txt'), 'utf8')).toBe('keep');
  });

  it.skipIf(!sqlite)('cleans multiple explicitly owned roots from a reused lane and its shared index', async () => {
    await fs.writeFile(path.join(scope, 'conversations', `${OTHER}.db`), 'SQLite format 3\0second synthetic conversation');
    await fs.writeFile(target.pointer, JSON.stringify({ id: OTHER }));
    const second = await captureAgyDeletionTarget({ sessionId: OTHER, executorThreadId: LANE, home, cwd: home, command: 'agy' });
    await index([ID, OTHER]);
    const ownedTargets = [target, second];
    expect((await remove({ detachedPointer: true, ownedTargets })).state).toBe('deleted');
    expect((await deleteOwnedAgySession(second, { confirmedProcessGroupExit: true, ownedTargets,
      persistPrepared: async () => {} })).state).toBe('deleted');
    expect(await fs.readdir(path.join(scope, 'conversations'))).toEqual([]);
    expect(await fs.readFile(path.join(scope, 'brain', ID, 'deliverable.md'), 'utf8')).toBe('required output');
  });

  it('deletes exact history files while preserving brain, worktree, cache and the durable pointer', async () => {
    await fs.writeFile(path.join(scope, 'cache', 'retained.json'), 'cache');
    expect((await remove()).state).toBe('deleted');
    await expect(fs.lstat(db())).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(db() + '-wal')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(scope, 'brain', ID, 'deliverable.md'), 'utf8')).toBe('required output');
    await expect(fs.stat(path.join(scope, 'brain', ID, '.system_generated', 'logs', 'transcript.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(home, 'worktree', 'result.txt'), 'utf8')).toBe('required code artifact');
    expect(await fs.readFile(path.join(scope, 'cache', 'retained.json'), 'utf8')).toBe('cache');
    expect(JSON.parse(await fs.readFile(target.pointer, 'utf8')).id).toBe(ID);
    expect(validAgyDeletionPreparation(target, prepared)).toBe(true);
    expect((await remove()).state).toBe('deleted');
  });

  it.skipIf(!sqlite)('inspects real SQLite metadata and removes only an exclusive index', async () => {
    await index();
    expect((await remove()).state).toBe('deleted');
    await expect(fs.lstat(path.join(scope, 'conversation_summaries.db'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(!sqlite)('holds even an index-only foreign history before changing any files', async () => {
    await index([ID, OTHER]);
    expect((await remove()).state).toBe('held');
    expect(prepared).toBeUndefined();
    expect(await fs.readFile(db(), 'utf8')).toContain('synthetic conversation');
  });

  it.skipIf(!sqlite)('reports unavailable SQLite inspection explicitly without any deletion', async () => {
    await index();
    capabilities.sqlite = false;
    expect((await remove()).state).toBe('unsupported');
    expect(prepared).toBeUndefined();
    expect(await fs.readFile(db(), 'utf8')).toContain('synthetic conversation');
  });

  it.skipIf(!sqlite)('inspects committed WAL metadata instead of trusting only the main index file', async () => {
    await index();
    const file = path.join(scope, 'conversation_summaries.db');
    const database = new sqlite!.DatabaseSync(file);
    let snapshot: Array<[string, Buffer]>;
    try {
      database.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
      database.prepare(INSERT_INDEX).run(OTHER, '', scope);
      snapshot = await Promise.all(['', '-wal', '-shm'].map(async suffix => [suffix, await fs.readFile(file + suffix)] as [string, Buffer]));
    } finally { database.close(); }
    for (const [suffix, data] of snapshot!) await fs.writeFile(file + suffix, data);
    const original = await fs.readFile(file + '-wal');
    expect((await remove()).state).toBe('held');
    expect(await fs.readFile(file + '-wal')).toEqual(original);
    expect(prepared).toBeUndefined();
  });

  it.skipIf(!sqlite)('holds new index objects and parent references instead of widening the format contract', async () => {
    await index();
    const database = new sqlite!.DatabaseSync(path.join(scope, 'conversation_summaries.db'));
    database.prepare('UPDATE conversation_summaries SET parent_conversation_id = ?').run(OTHER);
    database.close();
    expect((await remove()).state).toBe('held');
    const next = new sqlite!.DatabaseSync(path.join(scope, 'conversation_summaries.db'));
    next.exec("UPDATE conversation_summaries SET parent_conversation_id = ''; CREATE TABLE unknown_history (id TEXT)");
    next.close();
    expect((await remove()).state).toBe('held');
  });

  it.skipIf(!sqlite)('rejects unknown index schema without modifying the original database', async () => {
    const database = new sqlite!.DatabaseSync(path.join(scope, 'conversation_summaries.db'));
    database.exec('CREATE TABLE conversation_summaries (conversation_id TEXT)');
    database.close();
    const before = await fs.readFile(path.join(scope, 'conversation_summaries.db'));
    expect((await remove()).state).toBe('held');
    expect(await fs.readFile(path.join(scope, 'conversation_summaries.db'))).toEqual(before);
  });

  it('requires exit proof and durable preparation', async () => {
    expect((await remove({ confirmedProcessGroupExit: false })).state).toBe('waiting-exit');
    expect(prepared).toBeUndefined();
    expect((await remove({ persistPrepared: undefined })).state).toBe('held');
    expect((await remove({ persistPrepared: async () => { throw new Error('synthetic persistence failure'); } })).state).toBe('held');
    expect(await fs.readFile(db(), 'utf8')).toContain('synthetic conversation');
  });

  it('allows unrelated valid foreground pointers but holds an exact foreground reference', async () => {
    const foreground = path.join(target.pointerRoot.path, `${OTHER}.json`);
    await fs.writeFile(foreground, JSON.stringify({ id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }));
    await fs.writeFile(path.join(target.pointerRoot.path, 'foreign-worker.json'), JSON.stringify({ id: ID }));
    expect((await remove()).state).toBe('held');
    await fs.unlink(path.join(target.pointerRoot.path, 'foreign-worker.json'));
    await fs.writeFile(foreground, JSON.stringify({ id: ID, adopted: true }));
    expect((await remove()).state).toBe('held');
    await fs.writeFile(foreground, JSON.stringify({ id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }));
    expect((await remove()).state).toBe('deleted');
  });

  it('rejects malformed pointer inventory and native IDs', async () => {
    expect(validAgyDeletionTarget({ ...target, sessionId: '../outside' })).toBe(false);
    await fs.writeFile(path.join(target.pointerRoot.path, 'ambiguous.json'), '{}');
    expect((await remove()).state).toBe('held');
    await expect(captureAgyDeletionTarget({ sessionId: '../outside', executorThreadId: LANE, home, cwd: home, command: 'agy' })).rejects.toThrow();
  });

  it('holds another native database even when it has no summary entry', async () => {
    await fs.writeFile(path.join(scope, 'conversations', `${OTHER}.db`), 'foreign');
    expect((await remove()).state).toBe('held');
    expect(await fs.readFile(db(), 'utf8')).toContain('synthetic conversation');
  });

  it('requires explicit historic detachment and leaves a newer pointer intact', async () => {
    await fs.writeFile(target.pointer, JSON.stringify({ id: OTHER }));
    expect((await remove()).state).toBe('held');
    expect((await remove({ detachedPointer: true })).state).toBe('deleted');
    expect(JSON.parse(await fs.readFile(target.pointer, 'utf8')).id).toBe(OTHER);
  });

  it('does not detach an adopted pointer with the same case-insensitive native identity', async () => {
    await fs.writeFile(target.pointer, JSON.stringify({ id: ID.toUpperCase(), adopted: true }));
    expect((await remove({ detachedPointer: true })).state).toBe('held');
    expect(await fs.readFile(db(), 'utf8')).toContain('synthetic conversation');
  });

  it('rejects a reference introduced while preparation was being persisted', async () => {
    expect((await remove({ persistPrepared: async (value: AgyDeletionPreparation) => {
      await persistPrepared(value);
      await fs.writeFile(path.join(target.pointerRoot.path, `${OTHER}.json`), JSON.stringify({ id: ID }));
    } })).state).toBe('held');
    expect(await fs.readFile(db(), 'utf8')).toContain('synthetic conversation');
  });

  it('retries an interrupted manifest without replacing its receipts', async () => {
    const original = LinuxHistoryAnchor.prototype.remove;
    let count = 0;
    const fault = vi.spyOn(LinuxHistoryAnchor.prototype, 'remove').mockImplementation(async function (entry) {
      if (++count === 2) throw new Error('synthetic unlink failure');
      return original.call(this, entry);
    });
    expect((await remove()).state).toBe('uncertain');
    const immutable = JSON.stringify(prepared);
    fault.mockRestore();
    expect((await remove({ persistPrepared: async () => { throw new Error('must not prepare twice'); } })).state).toBe('deleted');
    expect(JSON.stringify(prepared)).toBe(immutable);
  });

  it('does not accept a substituted file or broaden a prepared manifest', async () => {
    expect((await remove({ persistPrepared: async (value: AgyDeletionPreparation) => {
      await persistPrepared(value);
      await fs.rename(db(), db() + '.retained');
      await fs.writeFile(db(), 'SQLite format 3\0replacement');
    } })).state).toBe('held');
    expect(await fs.readFile(db(), 'utf8')).toContain('replacement');
    expect(validAgyDeletionPreparation(target, { ...prepared, files: [...prepared!.files, { ...prepared!.files[0], path: path.join(scope, 'brain') }] })).toBe(false);
  });

  it('rejects a database replaced after its native creation receipt', async () => {
    await fs.rename(db(), path.join(home, 'retained-original.db'));
    await fs.writeFile(db(), 'SQLite format 3\0foreign replacement');
    expect((await remove()).state).toBe('held');
    expect(prepared).toBeUndefined();
    expect(await fs.readFile(db(), 'utf8')).toContain('foreign replacement');
  });

  it('holds missing history without a durable preparation', async () => {
    await fs.unlink(db());
    expect((await remove()).state).toBe('held');
  });

  it('rejects shared caches, redirected roots and hard-linked native files', async () => {
    const shared = path.join(home, 'shared-cache');
    await fs.mkdir(shared);
    await fs.rmdir(path.join(scope, 'cache'));
    await fs.symlink(shared, path.join(scope, 'cache'), 'dir');
    expect((await remove()).state).toBe('held');
    await fs.unlink(path.join(scope, 'cache'));
    await fs.mkdir(path.join(scope, 'cache'));
    await fs.link(db(), path.join(home, 'shared-history'));
    expect((await remove()).state).toBe('held');
    await fs.unlink(path.join(home, 'shared-history'));
    await fs.rename(path.join(scope, 'conversations'), path.join(home, 'moved-history'));
    await fs.symlink(path.join(home, 'moved-history'), path.join(scope, 'conversations'), 'dir');
    expect((await remove()).state).toBe('held');
  });

  it('cannot reinterpret missing procfs descriptors as successful deletion', async () => {
    const original = fs.stat.bind(fs);
    vi.spyOn(fs, 'stat').mockImplementation((async (file: any, options: any) => {
      if (String(file).startsWith('/proc/self/fd/')) throw Object.assign(new Error('synthetic unavailable procfs'), { code: 'ENOENT' });
      return original(file, options);
    }) as typeof fs.stat);
    expect((await remove()).state).toBe('held');
    expect(await fs.readFile(db(), 'utf8')).toContain('synthetic conversation');
  });

  it('requires the recorded home and explicitly rejects unsupported platforms', async () => {
    vi.mocked(os.homedir).mockReturnValue(path.join(home, 'different-home'));
    expect((await remove()).state).toBe('held');
    vi.mocked(os.homedir).mockReturnValue(home);
    vi.spyOn(process, 'platform', 'get').mockReturnValue('freebsd');
    expect((await remove()).state).toBe('unsupported');
  });
});
