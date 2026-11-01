import { createHash, randomUUID } from 'crypto';
import { lstatSync, readFileSync, promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { syncDirectory } from '../delegation/OwnershipRuntime';

/** A thread stays unavailable until every direct and delegated continuation is detached. */
export class ThreadContextReset {
  private readonly pending = new Set<string>();
  private readonly advances = new Map<string, Promise<number>>();

  constructor(private readonly directory = path.join(os.homedir(), '.remote-cli', 'thread-context-resets')) {}

  isPending(threadId: string): boolean {
    if (this.pending.has(threadId)) return true;
    try {
      const dirStat = lstatSync(this.directory, { throwIfNoEntry: false });
      if (dirStat && !dirStat.isDirectory()) {
        throw new Error('Cannot verify thread context reset state. Check local CLI storage and retry /clear.');
      }
      lstatSync(this.file(threadId));
      return true;
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw new Error('Cannot verify thread context reset state. Check local CLI storage and retry /clear.');
    }
  }

  assertReady(threadId: string): void {
    if (this.isPending(threadId)) {
      throw new Error('This thread has an incomplete conversation reset. Retry /clear or /new before using its sessions.');
    }
  }

  async begin(threadId: string): Promise<void> {
    this.pending.add(threadId);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    // Existence is the complete intent record, so an interrupted write also blocks admission.
    try {
      const file = await fs.open(this.file(threadId), 'wx', 0o600);
      try { await file.sync(); } finally { await file.close(); }
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    syncDirectory(this.directory);
  }

  async complete(threadId: string): Promise<void> {
    await fs.rm(this.file(threadId), { force: true });
    syncDirectory(this.directory);
    this.pending.delete(threadId);
  }

  /** Authoritative overlay: thread metadata and worker inventory may both be stale. */
  generation(threadId: string, fallback = 0): number {
    if (!Number.isSafeInteger(fallback) || fallback < 0) throw new Error('Invalid managed conversation generation');
    try {
      const dirStat = lstatSync(this.directory, { throwIfNoEntry: false });
      if (dirStat && !dirStat.isDirectory()) {
        throw new Error('Cannot verify managed conversation generation. Check local reset storage and retry /clear.');
      }
      const filename = this.file(threadId) + '.generation';
      if (!lstatSync(filename).isFile()) throw new Error('Invalid generation file');
      const value: unknown = JSON.parse(readFileSync(filename, 'utf8'));
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid generation');
      return Math.max(value, fallback);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
      throw new Error('Cannot verify managed conversation generation. Check local reset storage and retry /clear.');
    }
  }

  /** Publish only after an atomic durable write; retries may safely skip generations. */
  advanceGeneration(threadId: string, fallback = 0): Promise<number> {
    const existing = this.advances.get(threadId);
    if (existing) return existing;
    const operation = (async () => {
      if (!this.isPending(threadId)) throw new Error('Thread context reset intent is missing');
      const next = this.generation(threadId, fallback) + 1;
      if (!Number.isSafeInteger(next)) throw new Error('Managed conversation generation exhausted');
      const filename = this.file(threadId) + '.generation';
      const temporary = `${filename}.${randomUUID()}.tmp`;
      try {
        const file = await fs.open(temporary, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify(next)); await file.sync(); } finally { await file.close(); }
        await fs.rename(temporary, filename);
        syncDirectory(this.directory);
      } finally { await fs.rm(temporary, { force: true }); }
      return next;
    })();
    this.advances.set(threadId, operation);
    void operation.finally(() => this.advances.delete(threadId)).catch(() => undefined);
    return operation;
  }

  private file(threadId: string): string {
    if (!threadId || threadId.length > 200) throw new Error('Invalid thread context reset identity');
    return path.join(this.directory, `${createHash('sha256').update(threadId).digest('hex')}.pending`);
  }
}
