import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ThreadManager } from '../../src/thread/ThreadManager';
import { MAX_THREADS, DEFAULT_THREAD_NAME } from '../../src/thread/types';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'thread-manager-test-'));
}

describe('ThreadManager', () => {
  let tmpDir: string;
  let manager: ThreadManager;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    manager = new ThreadManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── construction & storage ──────────────────────────────────────────────

  it('should create the sessions directory on construction', () => {
    const sessionsDir = path.join(tmpDir, 'claude-sessions');
    expect(fs.existsSync(sessionsDir)).toBe(true);
  });

  it('should start with no threads', () => {
    expect(manager.listThreads()).toHaveLength(0);
    expect(manager.getActiveThread()).toBeUndefined();
  });

  it('should persist threads.json on every mutation', () => {
    manager.createThread('my-thread', '/tmp');
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, 'threads.json'), 'utf8'));
    expect(raw.threads).toBeDefined();
    expect(Object.keys(raw.threads)).toHaveLength(1);
  });

  it('should reload state from disk on new instance', () => {
    manager.createThread('persisted', '/tmp');
    const manager2 = new ThreadManager(tmpDir);
    expect(manager2.listThreads()).toHaveLength(1);
    expect(manager2.listThreads()[0].name).toBe('persisted');
  });

  // ─── createThread ────────────────────────────────────────────────────────

  it('should create a thread with auto-generated name when none provided', () => {
    const t = manager.createThread(undefined, '/tmp');
    expect(t.name).toMatch(/^thread-1$/);
  });

  it('should create a thread with a given name', () => {
    const t = manager.createThread('my-feature', '/tmp');
    expect(t.name).toBe('my-feature');
    expect(t.workingDirectory).toBe('/tmp');
    expect(t.sessionId).toBeNull();
    expect(t.id).toBeTruthy();
    expect(t.createdAt).toBeGreaterThan(0);
    expect(t.lastActiveAt).toBeGreaterThan(0);
  });

  it('should auto-activate the first thread created', () => {
    const t = manager.createThread('first', '/tmp');
    expect(manager.getActiveThread()?.id).toBe(t.id);
  });

  it('should NOT auto-activate subsequent threads', () => {
    const first = manager.createThread('first', '/tmp');
    manager.createThread('second', '/tmp');
    expect(manager.getActiveThread()?.id).toBe(first.id);
  });

  it('should throw when MAX_THREADS is reached', () => {
    for (let i = 0; i < MAX_THREADS; i++) {
      manager.createThread(`thread-${i}`, '/tmp');
    }
    expect(() => manager.createThread('overflow', '/tmp')).toThrow(/maximum/i);
  });

  it('should throw on duplicate name (case-insensitive)', () => {
    manager.createThread('mythread', '/tmp');
    expect(() => manager.createThread('MyThread', '/tmp')).toThrow(/already exists/i);
  });

  it('should throw on invalid name (special chars)', () => {
    expect(() => manager.createThread('bad name!', '/tmp')).toThrow(/invalid/i);
  });

  it('should throw on name too long (>30 chars)', () => {
    expect(() => manager.createThread('a'.repeat(31), '/tmp')).toThrow(/invalid/i);
  });

  it('should throw on empty name', () => {
    expect(() => manager.createThread('', '/tmp')).toThrow(/invalid/i);
  });

  it('should accept single-char name', () => {
    expect(() => manager.createThread('a', '/tmp')).not.toThrow();
  });

  it('should generate incremental auto-names (thread-1, thread-2, ...)', () => {
    const t1 = manager.createThread(undefined, '/tmp');
    const t2 = manager.createThread(undefined, '/tmp');
    expect(t1.name).toBe('thread-1');
    expect(t2.name).toBe('thread-2');
  });

  // ─── listThreads ─────────────────────────────────────────────────────────

  it('should list threads sorted by lastActiveAt descending', async () => {
    const t1 = manager.createThread('alpha', '/tmp');
    await new Promise(r => setTimeout(r, 5));
    const t2 = manager.createThread('beta', '/tmp');
    // switch to beta so its lastActiveAt updates
    manager.switchThread(t2.id);

    const list = manager.listThreads();
    expect(list[0].id).toBe(t2.id);
    expect(list[1].id).toBe(t1.id);
  });

  // ─── getThread / getThreadByName ─────────────────────────────────────────

  it('should get thread by ID', () => {
    const t = manager.createThread('lookup', '/tmp');
    expect(manager.getThread(t.id)?.name).toBe('lookup');
  });

  it('should return undefined for unknown ID', () => {
    expect(manager.getThread('nonexistent')).toBeUndefined();
  });

  it('should get thread by name (case-insensitive)', () => {
    manager.createThread('MyThread', '/tmp');
    expect(manager.getThreadByName('mythread')?.name).toBe('MyThread');
    expect(manager.getThreadByName('MYTHREAD')?.name).toBe('MyThread');
  });

  // ─── deleteThread ────────────────────────────────────────────────────────

  it('should delete a non-active thread', () => {
    manager.createThread('active', '/tmp');
    const t2 = manager.createThread('doomed', '/tmp');
    manager.deleteThread(t2.id);
    expect(manager.getThread(t2.id)).toBeUndefined();
    expect(manager.listThreads()).toHaveLength(1);
  });

  it('should throw when trying to delete the last remaining thread', () => {
    const t = manager.createThread('only', '/tmp');
    expect(() => manager.deleteThread(t.id)).toThrow(/last/i);
  });

  it('should delete the session file when deleting a thread', () => {
    const t = manager.createThread('with-session', '/tmp');
    manager.saveSessionId(t.id, 'sess-abc');
    const sessionFile = manager.sessionFilePath(t.id);
    expect(fs.existsSync(sessionFile)).toBe(true);

    manager.createThread('second', '/tmp'); // ensure not last
    manager.deleteThread(t.id);
    expect(fs.existsSync(sessionFile)).toBe(false);
  });

  it('should promote another thread as active when active thread is deleted', () => {
    const active = manager.createThread('active', '/tmp');
    const other = manager.createThread('other', '/tmp');
    // explicitly activate 'active'
    manager.switchThread(active.id);
    manager.deleteThread(active.id);
    // the remaining thread should now be active
    expect(manager.getActiveThread()?.id).toBe(other.id);
  });

  // ─── switchThread ────────────────────────────────────────────────────────

  it('should switch the active thread and update lastActiveAt', async () => {
    const t1 = manager.createThread('t1', '/tmp');
    await new Promise(r => setTimeout(r, 5));
    const t2 = manager.createThread('t2', '/tmp');

    const before = manager.getThread(t2.id)!.lastActiveAt;
    await new Promise(r => setTimeout(r, 5));
    manager.switchThread(t2.id);

    expect(manager.getActiveThread()?.id).toBe(t2.id);
    expect(manager.getThread(t2.id)!.lastActiveAt).toBeGreaterThan(before);
  });

  it('should throw when switching to unknown thread ID', () => {
    manager.createThread('t1', '/tmp');
    expect(() => manager.switchThread('nonexistent')).toThrow(/not found/i);
  });

  // ─── updateSessionId / updateWorkingDirectory ─────────────────────────────

  it('should update sessionId for a thread', () => {
    const t = manager.createThread('t', '/tmp');
    manager.updateSessionId(t.id, 'new-session-id');
    expect(manager.getThread(t.id)?.sessionId).toBe('new-session-id');
  });

  it('should update workingDirectory for a thread', () => {
    const t = manager.createThread('t', '/tmp');
    manager.updateWorkingDirectory(t.id, '/new/path');
    expect(manager.getThread(t.id)?.workingDirectory).toBe('/new/path');
  });

  // ─── session file management ──────────────────────────────────────────────

  it('sessionFilePath should return a path under claude-sessions/', () => {
    const t = manager.createThread('t', '/tmp');
    expect(manager.sessionFilePath(t.id)).toBe(
      path.join(tmpDir, 'claude-sessions', `${t.id}.json`)
    );
  });

  it('should save and load session ID via session file', () => {
    const t = manager.createThread('t', '/tmp');
    manager.saveSessionId(t.id, 'sess-xyz');
    expect(manager.loadSessionId(t.id)).toBe('sess-xyz');
  });

  it('should return null for loadSessionId when file does not exist', () => {
    const t = manager.createThread('t', '/tmp');
    expect(manager.loadSessionId(t.id)).toBeNull();
  });

  it('should delete session file with deleteSessionFile()', () => {
    const t = manager.createThread('t', '/tmp');
    manager.saveSessionId(t.id, 'sess-xyz');
    manager.deleteSessionFile(t.id);
    expect(fs.existsSync(manager.sessionFilePath(t.id))).toBe(false);
  });

  // ─── getThreadSummaries ───────────────────────────────────────────────────

  it('should return summaries with isActive correctly set', () => {
    const t1 = manager.createThread('alpha', '/tmp');
    const t2 = manager.createThread('beta', '/tmp');
    manager.switchThread(t1.id);

    const summaries = manager.getThreadSummaries();
    expect(summaries).toHaveLength(2);
    const active = summaries.find(s => s.isActive);
    expect(active?.name).toBe('alpha');
    expect(summaries.find(s => s.name === 'beta')?.isActive).toBe(false);
  });

  // ─── migrateFromSingleSession ─────────────────────────────────────────────

  it('should create a default thread from lastWorkingDirectory', () => {
    const t = manager.migrateFromSingleSession('/some/project', null);
    expect(t.name).toBe(DEFAULT_THREAD_NAME);
    expect(t.workingDirectory).toBe('/some/project');
    expect(t.sessionId).toBeNull();
    expect(manager.getActiveThread()?.id).toBe(t.id);
  });

  it('should create a default thread with process.cwd() when no directory provided', () => {
    const t = manager.migrateFromSingleSession(undefined, null);
    expect(t.workingDirectory).toBe(process.cwd());
  });

  it('should not duplicate if called twice (idempotent)', () => {
    manager.migrateFromSingleSession('/some/project', null);
    manager.migrateFromSingleSession('/some/project', null);
    expect(manager.listThreads()).toHaveLength(1);
  });
});
