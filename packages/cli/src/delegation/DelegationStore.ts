import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';

export interface DelegatedTaskRecord {
  id: string;
  threadId: string;
  parentMessageId: string;
  backend: string;
  objective: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';
  /** Admission time; older records have only startedAt. */
  acceptedAt?: number;
  /** Actual execution start, absent when a task never started. */
  startedAt?: number;
  /** Last callback from a worker tool; text streaming does not update this value. */
  lastActivityAt?: number;
  lastActivityKind?: 'tool_use' | 'tool_result';
  finishedAt?: number;
  output?: string;
  error?: string;
  truncated?: boolean;
}

export function isTerminalTaskState(state: DelegatedTaskRecord['state']): state is Exclude<DelegatedTaskRecord['state'], 'queued' | 'running'> {
  return ['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(state);
}

function recordTime(record: DelegatedTaskRecord): number {
  return record.acceptedAt ?? record.startedAt ?? 0;
}

/** Small atomic records; backend transcripts remain owned by their native CLIs. */
export class DelegationStore {
  private initialized?: Promise<void>;
  private writes = new Map<string, Promise<void>>();
  private pruning: Promise<void> = Promise.resolve();
  constructor(private readonly directory = path.join(os.homedir(), '.remote-cli', 'delegation')) {}

  initialize(): Promise<void> {
    return this.initialized ??= this.reconcile();
  }

  private async reconcile(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const files = (await fs.readdir(this.directory)).filter(name => /^[a-f0-9-]+\.json$/.test(name));
    const retained: Array<{ name: string; time: number }> = [];
    for (const name of files) {
      try {
        const file = path.join(this.directory, name);
        const stat = await fs.stat(file);
        if (stat.size > 128 * 1024) { await fs.unlink(file); continue; }
        const record: DelegatedTaskRecord = JSON.parse(await fs.readFile(file, 'utf8'));
        if (Date.now() - recordTime(record) > 7 * 86400_000) { await fs.unlink(file); continue; }
        if (!isTerminalTaskState(record.state)) {
          await this.write({ ...record, state: 'interrupted', finishedAt: Date.now(),
            error: 'The CLI stopped before confirming completion. Work was not automatically repeated.' });
        }
        retained.push({ name, time: recordTime(record) });
      } catch { /* A corrupt record cannot resurrect work. */ }
    }
    retained.sort((a, b) => b.time - a.time);
    await Promise.all(retained.slice(200).map(file => fs.unlink(path.join(this.directory, file.name)).catch(() => undefined)));
  }

  write(record: DelegatedTaskRecord): Promise<void> {
    const snapshot = JSON.stringify(record);
    if (!/^[a-f0-9-]+$/.test(record.id) || Buffer.byteLength(snapshot) > 128 * 1024) {
      return Promise.reject(new Error('Invalid or oversized delegation record'));
    }
    const pending = (this.writes.get(record.id) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const file = path.join(this.directory, `${record.id}.json`);
      const temporary = `${file}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temporary, snapshot, { mode: 0o600 }); await fs.rename(temporary, file); }
      finally { await fs.unlink(temporary).catch(() => undefined); }
    });
    this.writes.set(record.id, pending);
    void pending.finally(() => { if (this.writes.get(record.id) === pending) this.writes.delete(record.id); }).catch(() => undefined);
    return pending;
  }

  prune(): Promise<void> {
    this.pruning = this.pruning.catch(() => undefined).then(async () => {
      const terminal: Array<{ file: string; time: number }> = [];
      for (const name of await fs.readdir(this.directory)) {
        if (!/^[a-f0-9-]+\.json$/.test(name)) continue;
        const file = path.join(this.directory, name);
        try {
          const record = JSON.parse(await fs.readFile(file, 'utf8')) as DelegatedTaskRecord;
          if (isTerminalTaskState(record.state)) terminal.push({ file, time: recordTime(record) });
        } catch { /* Ignore an in-flight replacement or unrelated corrupt record. */ }
      }
      terminal.sort((a, b) => b.time - a.time);
      await Promise.all(terminal.filter((record, index) => index >= 200 || Date.now() - record.time > 7 * 86400_000)
        .map(record => fs.unlink(record.file).catch(() => undefined)));
    });
    return this.pruning;
  }

  async deleteThread(threadId: string): Promise<void> {
    try { await fs.access(this.directory); } catch { return; }
    await Promise.allSettled(this.writes.values());
    for (const name of await fs.readdir(this.directory)) {
      if (!/^[a-f0-9-]+\.json$/.test(name)) continue;
      const file = path.join(this.directory, name);
      try { if (JSON.parse(await fs.readFile(file, 'utf8')).threadId === threadId) await fs.unlink(file); }
      catch { /* Ignore unrelated or corrupt records. */ }
    }
  }
}
