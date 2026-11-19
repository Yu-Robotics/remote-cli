import { constants, promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import {
  Thread,
  ThreadStore,
  DEFAULT_THREAD_NAME,
  MAX_THREADS,
  THREAD_NAME_REGEX,
} from './types';
import type { BackendKey } from '../types/config';
import { assertAgySelectionResettable, detachAgySelection } from '../executor/agy/AgySessionSelection';
import { ThreadContextReset } from './ThreadContextReset';
import { auxiliaryFiles, collectDetachedDeletion, inspectAgyDeletion, observeDetachedDeletion, threadUuid, type DetachedDeletion } from './DetachedAgyDeletion';
import { replaceAtomicFile } from '../delegation/AtomicFile';
import { syncDirectory } from '../delegation/OwnershipRuntime';

interface Catalog extends ThreadStore { deferredAgyDeletions?: Record<string, DetachedDeletion> }

/**
 * Manages thread lifecycle: create, list, update, delete.
 * Persists thread metadata to ~/.remote-cli/threads.json.
 * Session files are managed by each executor backend (ClaudePersistentExecutor,
 * AgyExecutor) and cleaned up via IExecutor.deleteThreadData().
 */
export class ThreadManager {
  readonly contextResets: ThreadContextReset;
  private store: Catalog;
  private storePath: string;
  private sessionsDir: string;
  private persistQueue: Promise<void> = Promise.resolve();

  private constructor(storePath: string, sessionsDir: string, store: Catalog) {
    this.storePath = storePath;
    this.sessionsDir = sessionsDir;
    this.store = store;
    this.contextResets = new ThreadContextReset(path.join(path.dirname(storePath), 'thread-context-resets'));
  }

  /**
   * Initialize ThreadManager. Creates the default thread if no threads exist.
   * Migrates from single-session mode if a legacy .claude-session file exists.
   *
   * @param configDir Base config directory (defaults to ~/.remote-cli)
   */
  static async initialize(configDir?: string, options: { retryDeferredDeletion?: boolean } = {}): Promise<ThreadManager> {
    const baseDir = configDir
      ? path.join(configDir, '.remote-cli')
      : path.join(process.env.HOME || require('os').homedir(), '.remote-cli');

    const storePath = path.join(baseDir, 'threads.json');
    const sessionsDir = path.join(baseDir, 'claude-sessions');

    await fs.mkdir(baseDir, { recursive: true });
    await fs.mkdir(sessionsDir, { recursive: true });

    let store: Catalog = { threads: {} };

    try {
      const raw = await fs.readFile(storePath, 'utf-8');
      store = JSON.parse(raw) as Catalog;
      if (!store?.threads || typeof store.threads !== 'object' || Array.isArray(store.threads)
        || (store.deferredAgyDeletions !== undefined && (!store.deferredAgyDeletions
          || typeof store.deferredAgyDeletions !== 'object' || Array.isArray(store.deferredAgyDeletions)))) {
        throw new Error('Invalid thread catalog; retained thread identities cannot be verified.');
      }
      for (const [id, record] of Object.entries(store.deferredAgyDeletions ?? {})) {
        if (!threadUuid.test(id) || record?.threadId !== id || record.version !== 1 || store.threads[id]) {
          throw new Error('Conflicting or invalid retained thread identity.');
        }
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error('The thread catalog (threads.json) could not be parsed. Restore an intact copy from backup and restart the CLI.');
      }
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const manager = new ThreadManager(storePath, sessionsDir, store);

    // Ensure default thread always exists
    if (!Object.values(store.threads).some(thread => thread.name === DEFAULT_THREAD_NAME)) {
      const sessionId = await manager.readLegacySessionId(baseDir);
      const defaultThread: Thread = {
        id: manager.newId(store),
        name: DEFAULT_THREAD_NAME,
        sessionId,
        workingDirectory: process.cwd(),
        delegationWorkspaceGeneration: 0,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      };
      await manager.commit(next => { next.threads[defaultThread.id] = defaultThread; });
    }

    if (options.retryDeferredDeletion) await manager.retryDeferredDeletion();
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
  async createThread(name: string, workingDirectory: string, backend?: BackendKey): Promise<Thread> {
    if (!name || !THREAD_NAME_REGEX.test(name)) {
      throw new Error(`Invalid thread name: "${name}". Use alphanumeric characters and hyphens only (no leading/trailing hyphens).`);
    }

    return this.commit(store => {
      if (Object.values(store.threads).some(t => t.name === name)) throw new Error(`Thread "${name}" already exists.`);
      if (Object.keys(store.threads).length >= MAX_THREADS) throw new Error(`Maximum ${MAX_THREADS} threads allowed. Delete an existing thread first.`);
      const thread: Thread = {
        id: this.newId(store),
        name,
        sessionId: null,
        workingDirectory,
        delegationWorkspaceGeneration: 0,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        ...(backend ? { backend } : {}),
      };

      store.threads[thread.id] = thread;
      return thread;
    });
  }

  private newId(store: Catalog): string {
    let id = randomUUID();
    while (store.threads[id] || store.deferredAgyDeletions?.[id]) id = randomUUID();
    return id;
  }

  /**
   * Get a thread by ID.
   */
  getThread(id: string): Thread | undefined {
    const thread = this.store.threads[id];
    if (!thread) return undefined;
    const generation = this.contextResets.generation(id, thread.delegationWorkspaceGeneration);
    return generation === (thread.delegationWorkspaceGeneration ?? 0) ? thread : { ...thread, delegationWorkspaceGeneration: generation };
  }

  /**
   * Get a thread by name.
   */
  getThreadByName(name: string): Thread | undefined {
    const thread = Object.values(this.store.threads).find(t => t.name === name);
    return thread && this.getThread(thread.id);
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
    updates: Partial<Pick<Thread, 'sessionId' | 'workingDirectory' | 'lastActiveAt' | 'model' | 'models' | 'efforts' | 'speeds' | 'backend' | 'delegation' | 'delegationBackends' | 'delegationWorkspaceGeneration'>>
  ): Promise<Thread> {
    return this.commit(store => {
      const thread = store.threads[id];
      if (!thread) throw new Error(`Thread not found: ${id}`);
      return store.threads[id] = { ...thread, ...updates };
    });
  }

  /** Clear explicit backend overrides so all threads follow the global backend. */
  async clearBackendOverrides(): Promise<void> {
    await this.commit(store => {
      for (const thread of Object.values(store.threads)) {
        if (thread.backend === undefined) continue;
        const { backend, ...rest } = thread;
        store.threads[thread.id] = rest;
      }
    });
  }

  private async agyRoot(): Promise<string> {
    const root = path.join(await fs.realpath(os.homedir()), '.remote-cli');
    try { return await fs.realpath(root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return root; throw error; }
  }

  async assertThreadDeletionAllowed(id: string, options: { allowCurrentAgySession?: boolean } = {}): Promise<void> {
    const root = await this.agyRoot();
    await this.inspectDeletion(root, id, options.allowCurrentAgySession);
    await auxiliaryFiles(await fs.realpath(path.dirname(this.storePath)), root, id);
  }

  private async inspectDeletion(root: string, id: string, allowCurrent = false): Promise<string[]> {
    const thread = this.store.threads[id];
    if (!thread) throw new Error(`Thread not found: ${id}`);
    if (thread.id !== id) throw new Error('Invalid thread catalog identity.');
    if (thread.name === DEFAULT_THREAD_NAME) throw new Error('Cannot delete the default thread.');
    this.contextResets.assertReady(id);
    return inspectAgyDeletion(root, id, allowCurrent);
  }

  async deleteThread(id: string): Promise<void> {
    await this.commit(async store => {
      const dataDir = await fs.realpath(path.dirname(this.storePath));
      const root = await this.agyRoot();
      const archived = await this.inspectDeletion(root, id);
      const auxiliary = await auxiliaryFiles(dataDir, root, id);
      const pointer = path.join(root, 'agy-sessions', id + '.json');
      if (archived.length) {
        const canonicalHome = await fs.realpath(os.homedir());
        const record: DetachedDeletion = root === path.join(canonicalHome, '.remote-cli')
          ? await observeDetachedDeletion(root, id, archived, Object.values(store.threads))
          : { version: 1, threadId: id };
        if (auxiliary.length) record.auxiliary = Object.fromEntries(auxiliary.map(e => [e.key, e.identity]));
        store.deferredAgyDeletions = { ...store.deferredAgyDeletions, [id]: record };
      } else {
        await fs.rm(pointer, { force: true });
        await fs.rm(path.join(root, 'agy-homes', id), { recursive: true, force: true });
        await fs.rm(pointer + '.native-schedules', { force: true });
        await fs.rm(pointer + '.checkpoint', { force: true });
        for (const entry of auxiliary) await fs.unlink(entry.file);
      }
      delete store.threads[id];
    });
    const record = this.store.deferredAgyDeletions?.[id];
    if (record?.auxiliary) await this.finishAuxiliary(id, record);
  }

  private async finishAuxiliary(id: string, record: DetachedDeletion): Promise<boolean> {
    if (!record.auxiliary) return true;
    try {
      const entries = await auxiliaryFiles(await fs.realpath(path.dirname(this.storePath)), await this.agyRoot(), id);
      if (entries.some(e => record.auxiliary?.[e.key] !== e.identity)) return false;
      for (const entry of entries) { await fs.unlink(entry.file); syncDirectory(path.dirname(entry.file)); }
      return true;
    } catch { return false; }
  }

  private async retryDeferredDeletion(): Promise<void> {
    for (const [id, record] of Object.entries(this.store.deferredAgyDeletions ?? {})) {
      if (record.completed || !await this.finishAuxiliary(id, record) || !record.proof) continue;
      try { this.contextResets.assertReady(id); }
      catch { continue; }
      if (await collectDetachedDeletion(await this.agyRoot(), id, record, Object.values(this.store.threads))) {
        await this.commit(store => {
          store.deferredAgyDeletions = { ...store.deferredAgyDeletions,
            [id]: { version: 1, threadId: id, completed: true } };
        });
      }
    }
  }

  /**
   * List metadata without letting one broken reset overlay hide sibling threads.
   * Execution must still resolve its target through getThread(), which fails closed.
   */  listThreads(): Array<Thread & { contextError?: string }> {
    return Object.values(this.store.threads).map(thread => {
      try { return this.getThread(thread.id)!; }
      catch (error) {
        return { ...thread, contextError: error instanceof Error ? error.message : 'Thread recovery state is unavailable' };
      }
    }).sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Get the Claude session file path for a thread.
   * ClaudePersistentExecutor stores sessions as ~/.remote-cli/claude-sessions/<threadId>.json
   * (used by ClaudePersistentExecutor.deleteThreadData and tests)
   */
  getSessionFilePath(threadId: string): string {
    return path.join(this.sessionsDir, `${threadId}.json`);
  }

  /** Forget every backend binding without deleting transcripts or thread settings. */
  async clearBackendSessionPointers(threadId: string): Promise<void> {
    if (!this.store.threads[threadId]) throw new Error(`Thread not found: ${threadId}`);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)) {
      throw new Error('Invalid thread ID for session cleanup');
    }
    const roots = new Set([path.dirname(this.storePath), path.join(os.homedir(), '.remote-cli')]);
    const namespaces = ['claude', 'codex', 'agy', 'opencode', 'kimi', 'zcode', 'pi', 'dsh'];
    const pointers: string[] = [];
    const agyPointers = new Set<string>();
    for (const root of roots) {
      for (const backend of namespaces) {
        const pointer = path.join(root, `${backend}-sessions`, `${threadId}.json`);
        if (backend === 'agy') { assertAgySelectionResettable(pointer); agyPointers.add(pointer); }
        try {
          const stat = await fs.lstat(pointer);
          if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Session binding is not a file: ${pointer}`);
          await fs.access(path.dirname(pointer), constants.W_OK | constants.X_OK);
          pointers.push(pointer);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      const handoff = path.join(root, 'dsh-sessions', `${threadId}.handoff.json`);
      try {
        const stat = await fs.lstat(handoff);
        if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`DSH handoff is not a file: ${handoff}`);
        await fs.access(path.dirname(handoff), constants.W_OK | constants.X_OK);
        pointers.push(handoff);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    // Validate every location before deleting any binding; predictable failures
    // such as an invalid pointer or unwritable directory leave all sessions intact.
    // Archive inactive ACP selections before any other binding is removed. The
    // active executor may already have archived its own pointer during reset.
    const detached = new Set<string>();
    for (const pointer of agyPointers) if (detachAgySelection(pointer)) detached.add(pointer);
    for (const pointer of pointers) if (!detached.has(pointer)) await fs.rm(pointer, { force: true });
  }

  /** Publish the catalog and its UUID reservations in one atomic replacement. */
  private commit<T>(update: (next: Catalog) => T | Promise<T>): Promise<T> {
    const result = this.persistQueue.then(async () => {
      const next = { ...this.store, threads: { ...this.store.threads } };
      const value = await update(next);
      const temporary = this.storePath + '.' + randomUUID() + '.tmp';
      const file = await fs.open(temporary, 'wx', 0o600);
      try {
        try { await file.writeFile(JSON.stringify(next, null, 2)); await file.sync(); }
        finally { await file.close(); }
        await replaceAtomicFile(temporary, this.storePath);
        this.store = next;
        syncDirectory(path.dirname(this.storePath));
      } finally { await fs.rm(temporary, { force: true }); }
      return value;
    });
    this.persistQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}
