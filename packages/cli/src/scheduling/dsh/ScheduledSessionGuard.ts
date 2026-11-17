import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { syncDirectory } from '../../delegation/OwnershipRuntime';

/** A refusal marker, never positive recovery evidence. Keep it across cancel, purge and context reset. */
export class ScheduledSessionGuard {
  constructor(private readonly directory: string, private readonly threadId: string, private readonly catalog?: string) {}
  private filename(sessionId: string): string {
    return path.join(this.directory, `scheduled-${createHash('sha256').update(sessionId).digest('hex')}.fence`);
  }
  mark(sessionId: string): void {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const filename = this.filename(sessionId);
    let fd: number;
    try { fd = fs.openSync(filename, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Any existing marker, even a torn one, is already a permanent refusal.
      const stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe scheduled session marker');
      fd = fs.openSync(filename, 'r');
    }
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    syncDirectory(this.directory);
  }
  assertResume(sessionId: string): void {
    try { fs.lstatSync(this.filename(sessionId)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!this.hasLegacyObligation(sessionId)) return;
      throw new Error('The saved DSH scheduled session may contain queued native reminders after host loss. Native history is retained; automatic resume is blocked.');
    }
    throw new Error('The saved DSH scheduled session may contain queued native reminders after host loss. Native history is retained; automatic resume is blocked.');
  }
  private hasLegacyObligation(sessionId: string): boolean {
    if (!this.catalog) return false;
    let value: any;
    try {
      const stat = fs.lstatSync(this.catalog);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw new Error('Invalid schedule catalog');
      value = JSON.parse(fs.readFileSync(this.catalog, 'utf8'));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    if (![1, 2, 3, 4, 5, 6].includes(value.version) || !Array.isArray(value.records)
      || value.cleanup !== undefined && !Array.isArray(value.cleanup)) throw new Error('Invalid schedule catalog');
    return [...value.records, ...(value.cleanup ?? [])].some(row => {
      if (row?.backend !== 'dsh' || row.threadId !== this.threadId || row.creationRefused === true) return false;
      // Missing attribution is uncertainty, not permission to resume the selected session.
      try {
        const id = row.attribution?.sessionId ?? JSON.parse(row.recovery?.identity).sessionId;
        return !id || id === sessionId;
      } catch { return true; }
    });
  }
}
