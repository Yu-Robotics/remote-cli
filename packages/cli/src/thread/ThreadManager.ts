import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  Thread,
  ThreadStore,
  DEFAULT_THREAD_NAME,
  MAX_THREADS,
  THREAD_NAME_REGEX,
} from './types';

/**
 * Manages thread lifecycle: create, list, update, delete.
 * Persists thread metadata to ~/.remote-cli/threads.json.
 * Session files are managed by each executor backend (ClaudePersistentExecutor,
 * AgyExecutor) and cleaned up via IExecutor.deleteThreadData().
 */
export class ThreadManager {
  private store: ThreadStore;
  private storePath: string;
  private sessionsDir: string;
  private persistQueue: Promise<void> = Promise.resolve();

  private constructor(storePath: string, sessionsDir: string, store: ThreadStore) {
    this.storePath = storePath;
    this.sessionsDir = sessionsDir;
    this.store = store;
  }

  /**
   * Initialize ThreadManager. Creates the default thread if no threads exist.
   * Migrates from single-session mode if a legacy .claude-session file exists.
   *
   * @param configDir Base config directory (defaults to ~/.remote-cli)
   */
  static async initialize(configDir?: string): Promise<ThreadManager> {
    const baseDir = configDir
      ? path.join(configDir, '.remote-cli')
      : path.join(process.env.HOME || require('os').homedir(), '.remote-cli');

    const storePath = path.join(baseDir, 'threads.json');
    const sessionsDir = path.join(baseDir, 'claude-sessions');

    await fs.mkdir(baseDir, { recursive: true });
    await fs.mkdir(sessionsDir, { recursive: true });

    let store: ThreadStore = { threads: {} };

    try {
      const raw = await fs.readFile(storePath, 'utf-8');
      store = JSON.parse(raw) as ThreadStore;
    } catch {
      // File does not exist or is invalid — start fresh
    }

    const manager = new ThreadManager(storePath, sessionsDir, store);

    // Ensure default thread always exists
    if (!manager.getThreadByName(DEFAULT_THREAD_NAME)) {
      const sessionId = await manager.readLegacySessionId(baseDir);
      const defaultThread: Thread = {
        id: randomUUID(),
        name: DEFAULT_THREAD_NAME,
        sessionId,
        workingDirectory: process.cwd(),
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      };
      store.threads[defaultThread.id] = defaultThread;
      await manager.persist();
    }

    return manager;
  }

  /**
   * Read legacy single-session ID from ~/.remote-cli/claude-session for migration.
   */
  private async readLegacySessionId(baseDir: string): Promise<string | null> {
    try {
      const legacyPath = path.join(baseDir, 'claude-session');
      const content = await fs.readFile(legacyPath, 'utf-8');
      return content.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Create a new thread.
   * Throws if name already exists, name is invalid, or MAX_THREADS reached.
   */
  async createThread(name: string, workingDirectory: string): Promise<Thread> {
    if (!name || !THREAD_NAME_REGEX.test(name)) {
      throw new Error(`Invalid thread name: "${name}". Use alphanumeric characters and hyphens only (no leading/trailing hyphens).`);
    }

    if (this.getThreadByName(name)) {
      throw new Error(`Thread "${name}" already exists.`);
    }

    const count = Object.keys(this.store.threads).length;
    if (count >= MAX_THREADS) {
      throw new Error(`Maximum ${MAX_THREADS} threads allowed. Delete an existing thread first.`);
    }

    const thread: Thread = {
      id: randomUUID(),
      name,
      sessionId: null,
      workingDirectory,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };

    this.store.threads[thread.id] = thread;
    await this.persist();
    return thread;
  }

  /**
   * Get a thread by ID.
   */
  getThread(id: string): Thread | undefined {
    return this.store.threads[id];
  }

  /**
   * Get a thread by name.
   */
  getThreadByName(name: string): Thread | undefined {
    return Object.values(this.store.threads).find(t => t.name === name);
  }

  /**
   * Get the default thread (always exists).
   */
  getDefaultThread(): Thread {
    const def = this.getThreadByName(DEFAULT_THREAD_NAME);
    if (!def) throw new Error('Default thread missing — this should never happen');
    return def;
  }

  /**
   * Update mutable fields of a thread.
   * Throws if thread not found.
   */
  async updateThread(
    id: string,
    updates: Partial<Pick<Thread, 'sessionId' | 'workingDirectory' | 'lastActiveAt' | 'model'>>
  ): Promise<Thread> {
    const thread = this.store.threads[id];
    if (!thread) throw new Error(`Thread not found: ${id}`);

    const updated: Thread = { ...thread, ...updates };
    this.store.threads[id] = updated;
    await this.persist();
    return updated;
  }

  /**
   * Delete a thread.
   * Cannot delete the default thread.
   * Removes the thread's session file if it exists.
   */
  async deleteThread(id: string): Promise<void> {
    const thread = this.store.threads[id];
    if (!thread) throw new Error(`Thread not found: ${id}`);

    if (thread.name === DEFAULT_THREAD_NAME) {
      throw new Error('Cannot delete the default thread.');
    }

    delete this.store.threads[id];
    await this.persist();
  }

  /**
   * List all threads sorted by createdAt ascending.
   */  listThreads(): Thread[] {
    return Object.values(this.store.threads).sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Get the Claude session file path for a thread.
   * ClaudePersistentExecutor stores sessions as ~/.remote-cli/claude-sessions/<threadId>.json
   * (used by ClaudePersistentExecutor.deleteThreadData and tests)
   */
  getSessionFilePath(threadId: string): string {
    return path.join(this.sessionsDir, `${threadId}.json`);
  }

  /**
   * Persist store to disk.
   * Serialized through a promise queue to prevent concurrent writes from
   * overwriting each other when multiple operations fire simultaneously.
   * Errors are logged but swallowed in the queue so a single failure does
   * not disable persistence for subsequent operations.
   */
  private persist(): Promise<void> {
    const write = () =>
      fs.writeFile(this.storePath, JSON.stringify(this.store, null, 2), 'utf-8');
    this.persistQueue = this.persistQueue.then(write).catch((err) => {
      console.error('[ThreadManager] Persistence error:', err);
      return write();
    });
    return this.persistQueue;
  }
}
