import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { ThreadManager } from '../../src/thread/ThreadManager';
import { DEFAULT_THREAD_NAME, MAX_THREADS } from '../../src/thread/types';

// Mock os.homedir() so tests don't write to real home directory
vi.spyOn(os, 'homedir').mockImplementation(() => process.env.HOME || os.homedir());

describe('ThreadManager', () => {
  let tmpDir: string;
  let manager: ThreadManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'thread-manager-test-'));
    process.env.HOME = tmpDir;
    manager = await ThreadManager.initialize(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    delete process.env.HOME;
  });

  describe('initialization', () => {
    it('creates a default thread on first init', async () => {
      const threads = manager.listThreads();
      expect(threads).toHaveLength(1);
      expect(threads[0].name).toBe(DEFAULT_THREAD_NAME);
    });

    it('persists threads to disk and loads on re-initialize', async () => {
      await manager.createThread('feature-x', tmpDir);
      const manager2 = await ThreadManager.initialize(tmpDir);
      const threads = manager2.listThreads();
      expect(threads).toHaveLength(2);
      expect(threads.some(t => t.name === 'feature-x')).toBe(true);
    });

    it('returns same threads on repeat initialize', async () => {
      const manager2 = await ThreadManager.initialize(tmpDir);
      const threads2 = manager2.listThreads();
      expect(threads2).toHaveLength(1);
      expect(threads2[0].name).toBe(DEFAULT_THREAD_NAME);
    });
  });

  describe('createThread', () => {
    it('creates a thread with given name and workingDirectory', async () => {
      const thread = await manager.createThread('my-feature', tmpDir);
      expect(thread.name).toBe('my-feature');
      expect(thread.workingDirectory).toBe(tmpDir);
      expect(thread.id).toBeTruthy();
      expect(thread.sessionId).toBeNull();
    });

    it('creates thread with unique UUIDs', async () => {
      const t1 = await manager.createThread('t1', tmpDir);
      const t2 = await manager.createThread('t2', tmpDir);
      expect(t1.id).not.toBe(t2.id);
    });

    it('throws when name already exists', async () => {
      await manager.createThread('dup', tmpDir);
      await expect(manager.createThread('dup', tmpDir)).rejects.toThrow(/already exists/);
    });

    it('throws when MAX_THREADS reached', async () => {
      for (let i = 1; i < MAX_THREADS; i++) {
        await manager.createThread(`thread-${i}`, tmpDir);
      }
      await expect(manager.createThread('overflow', tmpDir)).rejects.toThrow(/Maximum.*threads/);
    });

    it('validates name format — rejects invalid names', async () => {
      await expect(manager.createThread('', tmpDir)).rejects.toThrow();
      await expect(manager.createThread('has space', tmpDir)).rejects.toThrow();
      await expect(manager.createThread('-starts-dash', tmpDir)).rejects.toThrow();
      await expect(manager.createThread('ends-dash-', tmpDir)).rejects.toThrow();
    });

    it('accepts valid name formats', async () => {
      await expect(manager.createThread('a', tmpDir)).resolves.toBeDefined();
      await expect(manager.createThread('my-feature-1', tmpDir)).resolves.toBeDefined();
      await expect(manager.createThread('ABC123', tmpDir)).resolves.toBeDefined();
    });
  });

  describe('getThread', () => {
    it('returns thread by id', async () => {
      const created = await manager.createThread('find-me', tmpDir);
      const found = manager.getThread(created.id);
      expect(found).toBeDefined();
      expect(found!.name).toBe('find-me');
    });

    it('returns undefined for unknown id', () => {
      expect(manager.getThread('nonexistent-id')).toBeUndefined();
    });
  });

  describe('getThreadByName', () => {
    it('returns thread by name', async () => {
      const created = await manager.createThread('named', tmpDir);
      const found = manager.getThreadByName('named');
      expect(found?.id).toBe(created.id);
    });

    it('returns undefined for unknown name', () => {
      expect(manager.getThreadByName('ghost')).toBeUndefined();
    });
  });

  describe('deleteThread', () => {
    it('deletes a non-default thread', async () => {
      const t = await manager.createThread('deletable', tmpDir);
      await manager.deleteThread(t.id);
      expect(manager.getThread(t.id)).toBeUndefined();
    });

    it('throws when deleting the default thread', async () => {
      const defaultThread = manager.getThreadByName(DEFAULT_THREAD_NAME)!;
      await expect(manager.deleteThread(defaultThread.id)).rejects.toThrow(/default/i);
    });

    it('throws when deleting unknown thread', async () => {
      await expect(manager.deleteThread('no-such-id')).rejects.toThrow(/not found/i);
    });

    it('persists deletion to disk', async () => {
      const t = await manager.createThread('will-delete', tmpDir);
      await manager.deleteThread(t.id);
      const manager2 = await ThreadManager.initialize(tmpDir);
      expect(manager2.getThread(t.id)).toBeUndefined();
    });
  });

  describe('updateThread', () => {
    it('updates sessionId', async () => {
      const t = await manager.createThread('session-update', tmpDir);
      await manager.updateThread(t.id, { sessionId: 'abc123' });
      const updated = manager.getThread(t.id)!;
      expect(updated.sessionId).toBe('abc123');
    });

    it('updates workingDirectory', async () => {
      const t = await manager.createThread('wd-update', tmpDir);
      const newDir = path.join(tmpDir, 'subdir');
      await fs.mkdir(newDir);
      await manager.updateThread(t.id, { workingDirectory: newDir });
      const updated = manager.getThread(t.id)!;
      expect(updated.workingDirectory).toBe(newDir);
    });

    it('updates lastActiveAt', async () => {
      const t = await manager.createThread('ts-update', tmpDir);
      const before = t.lastActiveAt;
      await new Promise(r => setTimeout(r, 10));
      await manager.updateThread(t.id, { lastActiveAt: Date.now() });
      const updated = manager.getThread(t.id)!;
      expect(updated.lastActiveAt).toBeGreaterThan(before);
    });

    it('throws for unknown thread id', async () => {
      await expect(manager.updateThread('ghost', { sessionId: 'x' })).rejects.toThrow(/not found/i);
    });
  });

  describe('listThreads', () => {
    it('returns all threads sorted by createdAt', async () => {
      await manager.createThread('b', tmpDir);
      await manager.createThread('c', tmpDir);
      const threads = manager.listThreads();
      // default was created first
      expect(threads[0].name).toBe(DEFAULT_THREAD_NAME);
      expect(threads.length).toBe(3);
    });
  });

  describe('getDefaultThread', () => {
    it('always returns the default thread', () => {
      const def = manager.getDefaultThread();
      expect(def.name).toBe(DEFAULT_THREAD_NAME);
    });
  });

  describe('session file management', () => {
    it('returns session file path for a thread', async () => {
      const t = await manager.createThread('sess', tmpDir);
      const filePath = manager.getSessionFilePath(t.id);
      expect(filePath).toContain(t.id);
      expect(filePath).toMatch(/\.jsonl?$/);
    });

    it('clears session file on deleteThread', async () => {
      const t = await manager.createThread('sess-del', tmpDir);
      const sessionPath = manager.getSessionFilePath(t.id);
      await fs.writeFile(sessionPath, 'some session data');
      await manager.deleteThread(t.id);
      const exists = await fs.access(sessionPath).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });
  });

  describe('migration from single session', () => {
    it('migrates existing .claude-session to default thread if no threads file exists', async () => {
      // Simulate pre-thread setup: session file exists but no threads.json
      const legacySessionFile = path.join(tmpDir, '.remote-cli', 'claude-session');
      await fs.mkdir(path.join(tmpDir, '.remote-cli'), { recursive: true });
      await fs.writeFile(legacySessionFile, 'legacy-session-id-123');

      // Remove threads.json so initialize sees a clean state
      const threadsFile = path.join(tmpDir, '.remote-cli', 'threads.json');
      await fs.rm(threadsFile, { force: true });

      const freshManager = await ThreadManager.initialize(tmpDir);
      const defaultThread = freshManager.getDefaultThread();
      expect(defaultThread.sessionId).toBe('legacy-session-id-123');
    });
  });
});
