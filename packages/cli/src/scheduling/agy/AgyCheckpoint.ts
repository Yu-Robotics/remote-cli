import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import type { NativeScheduleInput } from '../types';
import type { AcpSessionSetup, AcpTransport } from '../../executor/acp/AcpClient';

export interface AgyCheckpointData {
  version: 1; sessionId: string; configuration: string; id: string;
  state: 'prepared' | 'clean' | 'consumed';
  /** Definition digests, not execution output. Missing entries never authorize CREATE. */
  jobs: Record<string, string>;
}
const permits = new WeakSet<object>();
export interface AgyResumePermit { readonly sessionId: string; readonly checkpointId: string }
export function definitionDigest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

export function scheduleDigest(input: NativeScheduleInput): string {
  return definitionDigest([input.id, input.threadId, input.backend, input.cwd, input.prompt, input.rule,
    input.command ?? null, input.model ?? null, input.effort ?? null]);
}

/** Local trusted checkpoint journal, never a model/public protocol option. Clean
 * is written only after the caller joins its exact owned group before cutoff.
 * Consumption is durable BEFORE session/load; unknown outcomes cannot be retried. */
export class AgyCheckpoint {
  constructor(private readonly file: string, readonly configuration: string) {}
  read(): AgyCheckpointData | undefined {
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('Invalid AGY checkpoint file.');
      const fd = fs.openSync(this.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      let value: AgyCheckpointData;
      try {
        const opened = fs.fstatSync(fd);
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > 65536) throw new Error('AGY checkpoint changed while opening.');
        const bytes = Buffer.alloc(65537);
        const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
        if (size > 65536) throw new Error('AGY checkpoint exceeds its size limit.');
        value = JSON.parse(bytes.subarray(0, size).toString('utf8')) as AgyCheckpointData;
      } finally { fs.closeSync(fd); }
      if (!value || value.version !== 1 || value.configuration !== this.configuration || typeof value.sessionId !== 'string' || !/^[\w-]{1,128}$/.test(value.sessionId)
        || typeof value.id !== 'string' || !/^[\w-]{1,128}$/.test(value.id) || !['prepared', 'clean', 'consumed'].includes(value.state)
        || !value.jobs || typeof value.jobs !== 'object' || Array.isArray(value.jobs) || Object.keys(value.jobs).length > 100
        || Object.entries(value.jobs).some(([id, digest]) => !/^[\w-]{1,128}$/.test(id) || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest))) throw new Error('AGY checkpoint identity is incompatible.');
      return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  }
  private write(value: AgyCheckpointData): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.renameSync(temp, this.file); }
    finally { fs.rmSync(temp, { force: true }); }
    // POSIX directory durability; Windows does not support directory fsync.
    if (process.platform !== 'win32') {
      const directory = fs.openSync(path.dirname(this.file), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
  }
  private locked<T>(run: () => T): T {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const lock = this.file + '.lock';
    // Exclusive directory creation works on all supported hosts. A crash leaves
    // a fence, never an automatically stolen lock or replay permission.
    try { fs.mkdirSync(lock, { mode: 0o700 }); }
    catch { throw new Error('AGY checkpoint transition is already owned or unconfirmed.'); }
    try { return run(); } finally { fs.rmdirSync(lock); }
  }
  prepare(sessionId: string, jobs: Record<string, string>): AgyCheckpointData {
    return this.locked(() => {
      const value: AgyCheckpointData = { version: 1, sessionId, configuration: this.configuration, id: randomUUID(), state: 'prepared', jobs };
      this.write(value); return value;
    });
  }
  confirm(value: AgyCheckpointData): void {
    this.locked(() => {
      const current = this.read();
      if (current?.id !== value.id || current.state !== 'prepared' || definitionDigest(current) !== definitionDigest(value)) throw new Error('AGY checkpoint changed before retirement.');
      this.write({ ...value, state: 'clean' });
    });
  }
  consume(sessionId: string): AgyResumePermit {
    return this.locked(() => {
      const value = this.read();
      if (value?.state !== 'clean' || value.sessionId !== sessionId) throw new Error('AGY clean original-session checkpoint is unavailable.');
      this.write({ ...value, state: 'consumed' });
      const permit = Object.freeze({ sessionId, checkpointId: value.id }); permits.add(permit); return permit;
    });
  }
}

/** A one-use local proof restores process-local admission, not a native wire
 * capability. Any native reconfiguration/cancel/close revokes it again. */
export async function loadCheckpointSession(client: AcpTransport, permit: AgyResumePermit, cwd: string,
  servers: Parameters<AcpTransport['loadSession']>[2], setup?: AcpSessionSetup): Promise<AcpTransport> {
  if (!permits.delete(permit)) throw new Error('AGY resume permit is invalid or already consumed.');
  if (!client.loadSessionWithSetup || !client.sessionLifecycle) throw new Error('AGY ACP checkpoint session setup is unavailable.');
  let prepared = false;
  let lifecycle: object | undefined;
  const loaded = await client.loadSessionWithSetup(permit.sessionId, cwd, servers, async (session, configure) => {
    if (session?.sessionId !== permit.sessionId) throw new Error('AGY loaded a different native conversation.');
    const epoch = client.sessionLifecycle!();
    if (!epoch) throw new Error('AGY checkpoint session setup was invalidated.');
    await setup?.(session, configure);
    if (client.sessionLifecycle!() !== epoch) throw new Error('AGY checkpoint session setup was invalidated.');
    lifecycle = epoch;
    prepared = true;
  });
  if (loaded.sessionId !== permit.sessionId) throw new Error('AGY loaded a different native conversation.');
  const unchanged = () => lifecycle !== undefined && client.sessionLifecycle!() === lifecycle;
  if (!prepared || !unchanged()) throw new Error('AGY checkpoint session setup was not confirmed.');
  let live = true;
  const token = Object.freeze({});
  void client.waitForExit?.().then(() => { live = false; });
  return new Proxy(client, { get(target, key) {
    if (key === 'sessionAdmission') return (id: string) => live && unchanged() && id === permit.sessionId ? token : undefined;
    const value = Reflect.get(target, key);
    if (typeof value !== 'function') return value;
    return (...args: unknown[]) => {
      if (['loadSession', 'newSession', 'loadSessionWithSetup', 'newSessionWithSetup', 'setConfigOption', 'sendCancel', 'destroy', 'deleteSession'].includes(String(key))) live = false;
      return value.apply(target, args);
    };
  } });
}
