import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import {
  Thread,
  ThreadStore,
  ThreadSummary,
  MAX_THREADS,
  DEFAULT_THREAD_NAME,
  THREAD_NAME_REGEX,
} from './types';

const THREADS_FILE = 'threads.json';
const SESSIONS_DIR = 'claude-sessions';

/**
 * Manages multiple Claude conversation threads.
 *
 * Each thread has its own Claude session ID and working directory.
 * State is persisted to:
 *   {configDir}/threads.json          — thread metadata
 *   {configDir}/claude-sessions/{id}.json — individual session files
 *
 * Replaces the single .claude-session file per working directory with
 * a thread-ID-keyed file, allowing multiple threads to share the same cwd.
 */
export class ThreadManager {
  private store: ThreadStore;
  private readonly storeFilePath: string;
  private readonly sessionDir: string;

  constructor(configDir?: string) {
    const baseDir = configDir ?? path.join(os.homedir(), '.remote-cli');
    this.storeFilePath = path.join(baseDir, THREADS_FILE);
    this.sessionDir = path.join(baseDir, SESSIONS_DIR);
    fs.mkdirSync(this.sessionDir, { recursive: true });
    this.store = this.loadStore();
  }

  // ─── Persistence ─────────────────────────────────────────────────────────

  private loadStore(): ThreadStore {
    if (!fs.existsSync(this.storeFilePath)) {
      return { activeThreadId: null, threads: {} };
    }
    try {
      return JSON.parse(fs.readFileSync(this.storeFilePath, 'utf8')) as ThreadStore;
    } catch {
      return { activeThreadId: null, threads: {} };
    }
  }

  private saveStore(): void {
    fs.writeFileSync(this.storeFilePath, JSON.stringify(this.store, null, 2), 'utf8');
  }

  // ─── Session files ────────────────────────────────────────────────────────

  sessionFilePath(threadId: string): string {
    return path.join(this.sessionDir, `${threadId}.json`);
  }

  loadSessionId(threadId: string): string | null {
    const file = this.sessionFilePath(threadId);
    if (!fs.existsSync(file)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { id: string };
      return data.id ?? null;
    } catch {
      return null;
    }
  }

  saveSessionId(threadId: string, sessionId: string): void {
    fs.writeFileSync(
      this.sessionFilePath(threadId),
      JSON.stringify({ id: sessionId, savedAt: new Date().toISOString() }),
      'utf8'
    );
  }

  deleteSessionFile(threadId: string): void {
    const file = this.sessionFilePath(threadId);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }

  // ─── Name validation ──────────────────────────────────────────────────────

  private validateName(name: string): void {
    if (!name || !THREAD_NAME_REGEX.test(name)) {
      throw new Error(
        `Invalid thread name "${name}". Use alphanumeric characters and hyphens (1-30 chars, no leading/trailing hyphens).`
      );
    }
  }

  private generateAutoName(): string {
    const existing = new Set(Object.values(this.store.threads).map(t => t.name));
    let i = 1;
    while (existing.has(`thread-${i}`)) i++;
    return `thread-${i}`;
  }

  // ─── Thread CRUD ──────────────────────────────────────────────────────────

  /**
   * Create a new thread and auto-activate it if it's the first one.
   * @throws if MAX_THREADS is reached, name is invalid, or name is duplicate.
   */
  createThread(name?: string, workingDirectory?: string): Thread {
    const threadCount = Object.keys(this.store.threads).length;
    if (threadCount >= MAX_THREADS) {
      throw new Error(`Maximum number of threads (${MAX_THREADS}) reached. Delete a thread first.`);
    }

    const resolvedName = name ?? this.generateAutoName();
    this.validateName(resolvedName);

    // Duplicate check (case-insensitive)
    const nameLower = resolvedName.toLowerCase();
    const duplicate = Object.values(this.store.threads).find(
      t => t.name.toLowerCase() === nameLower
    );
    if (duplicate) {
      throw new Error(`Thread name "${resolvedName}" already exists.`);
    }

    const now = Date.now();
    const thread: Thread = {
      id: randomUUID(),
      name: resolvedName,
      sessionId: null,
      workingDirectory: workingDirectory ?? process.cwd(),
      createdAt: now,
      lastActiveAt: now,
    };

    this.store.threads[thread.id] = thread;

    // Auto-activate first thread
    if (threadCount === 0) {
      this.store.activeThreadId = thread.id;
    }

    this.saveStore();
    return { ...thread };
  }

  getThread(id: string): Thread | undefined {
    const t = this.store.threads[id];
    return t ? { ...t } : undefined;
  }

  getThreadByName(name: string): Thread | undefined {
    const lower = name.toLowerCase();
    const found = Object.values(this.store.threads).find(
      t => t.name.toLowerCase() === lower
    );
    return found ? { ...found } : undefined;
  }

  /** Returns all threads sorted by lastActiveAt descending. */
  listThreads(): Thread[] {
    return Object.values(this.store.threads)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .map(t => ({ ...t }));
  }

  /**
   * Delete a thread by ID.
   * @throws if it is the last remaining thread.
   */
  deleteThread(id: string): void {
    const thread = this.store.threads[id];
    if (!thread) return;

    const threadCount = Object.keys(this.store.threads).length;
    if (threadCount === 1) {
      throw new Error('Cannot delete the last thread. Create a new one first.');
    }

    const wasActive = this.store.activeThreadId === id;

    // Clean up session file
    this.deleteSessionFile(id);
    delete this.store.threads[id];

    // Promote another thread if the deleted one was active
    if (wasActive) {
      const remaining = Object.values(this.store.threads).sort(
        (a, b) => b.lastActiveAt - a.lastActiveAt
      );
      this.store.activeThreadId = remaining[0]?.id ?? null;
    }

    this.saveStore();
  }

  // ─── Active thread ────────────────────────────────────────────────────────

  getActiveThread(): Thread | undefined {
    if (!this.store.activeThreadId) return undefined;
    const t = this.store.threads[this.store.activeThreadId];
    return t ? { ...t } : undefined;
  }

  /**
   * Switch the active thread and update its lastActiveAt.
   * @throws if thread is not found.
   */
  switchThread(id: string): Thread {
    if (!this.store.threads[id]) {
      throw new Error(`Thread "${id}" not found.`);
    }
    this.store.activeThreadId = id;
    this.store.threads[id].lastActiveAt = Date.now();
    this.saveStore();
    return { ...this.store.threads[id] };
  }

  updateSessionId(threadId: string, sessionId: string): void {
    if (!this.store.threads[threadId]) return;
    this.store.threads[threadId].sessionId = sessionId;
    this.saveStore();
  }

  updateWorkingDirectory(threadId: string, cwd: string): void {
    if (!this.store.threads[threadId]) return;
    this.store.threads[threadId].workingDirectory = cwd;
    this.saveStore();
  }

  touchActiveThread(): void {
    if (this.store.activeThreadId && this.store.threads[this.store.activeThreadId]) {
      this.store.threads[this.store.activeThreadId].lastActiveAt = Date.now();
      this.saveStore();
    }
  }

  // ─── Router summaries ─────────────────────────────────────────────────────

  /** Returns the compact summary list sent to the Router for card button rendering. */
  getThreadSummaries(): ThreadSummary[] {
    return this.listThreads().map(t => ({
      id: t.id,
      name: t.name,
      isActive: t.id === this.store.activeThreadId,
    }));
  }

  // ─── Migration ────────────────────────────────────────────────────────────

  /**
   * One-time migration: create a "default" thread from the existing
   * single-session configuration. Idempotent — does nothing if threads
   * already exist or if "default" thread already exists.
   */
  migrateFromSingleSession(
    lastWorkingDirectory: string | undefined,
    existingSessionId: string | null
  ): Thread {
    // Idempotent: if already migrated, return the existing default thread
    const existing = this.getThreadByName(DEFAULT_THREAD_NAME);
    if (existing) return existing;

    const cwd = lastWorkingDirectory ?? process.cwd();
    const thread = this.createThread(DEFAULT_THREAD_NAME, cwd);

    if (existingSessionId) {
      this.saveSessionId(thread.id, existingSessionId);
      this.updateSessionId(thread.id, existingSessionId);
    }

    return this.getThread(thread.id)!;
  }
}
