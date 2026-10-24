import { createHash } from 'crypto';
import { lstatSync, promises as fs } from 'fs';
import os from 'os';
import path from 'path';

/** A thread stays unavailable until every direct and delegated continuation is detached. */
export class ThreadContextReset {
  private readonly pending = new Set<string>();

  constructor(private readonly directory = path.join(os.homedir(), '.remote-cli', 'thread-context-resets')) {}

  isPending(threadId: string): boolean {
    if (this.pending.has(threadId)) return true;
    try { lstatSync(this.file(threadId)); return true; }
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
    try { await fs.writeFile(this.file(threadId), '', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }

  async complete(threadId: string): Promise<void> {
    await fs.rm(this.file(threadId), { force: true });
    this.pending.delete(threadId);
  }

  private file(threadId: string): string {
    if (!threadId || threadId.length > 200) throw new Error('Invalid thread context reset identity');
    return path.join(this.directory, `${createHash('sha256').update(threadId).digest('hex')}.pending`);
  }
}
