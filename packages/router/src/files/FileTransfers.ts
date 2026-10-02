import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { Readable } from 'stream';
import { setTimeout as retryDelay } from 'timers/promises';
import type { Context } from 'koa';
import { atomicJson, displayName, FILE_ID, FILE_TOTAL_MS, fileLimit, privateDirectory, readOwnedFile, readPrivateJson, saveStream } from './FileIO';

interface Session { id: string; openId: string }
export interface FileInput { openId: string; deviceId: string; messageId: string; fileKey: string; name: string; threadId?: string }
interface FileRecord extends FileInput {
  id: string; sessionId: string; createdAt: number; expiresAt: number;
  state: string; destination?: string; size?: number; sha256?: string; detail?: string;
  cardId?: string;
}
interface LiveFile {
  record: FileRecord;
  abort: AbortController;
  admission?: (accepted: boolean) => void;
  timer?: NodeJS.Timeout;
  token?: string;
  tokenExpires?: number;
  reading?: boolean;
  offers: number;
  receipt?: Promise<void>;
  finishReceipt?: () => void;
  notifications?: Promise<void>;
  writes?: Promise<void>;
  removed?: boolean;
}
export interface FileTransferDependencies {
  session(deviceId: string): Session | undefined;
  owns(openId: string, deviceId: string): Promise<boolean>;
  send(deviceId: string, message: object): Promise<boolean>;
  download(messageId: string, fileKey: string, signal: AbortSignal): Promise<Readable>;
  notify(record: Readonly<FileRecord>): Promise<string | undefined>;
}

const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_FILES = 100;
const MAX_DEVICE_FILES = 20;
const MAX_SPOOL_BYTES = 400 * 1024 * 1024;

/** A separate HTTP data plane. WebSocket messages contain only bounded metadata. */
export class FileTransfers {
  private readonly files = new Map<string, LiveFile>();
  private loading?: Promise<void>;
  private readonly activeDevices = new Set<string>();
  private active = 0;
  private readonly queue: Array<() => void> = [];
  private readonly operations = new Set<Promise<unknown>>();
  private stopped = false;
  private readonly shutdown = new AbortController();
  readonly maxBytes: number;
  readonly enabled: boolean;

  constructor(private readonly root: string, publicUrl: string | undefined, maxBytes: number | undefined, private readonly deps: FileTransferDependencies) {
    this.maxBytes = fileLimit(maxBytes);
    this.enabled = false;
    if (publicUrl) {
      const url = new URL(publicUrl);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
        || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) throw new Error('files.publicUrl must be the HTTPS Router origin (HTTP is allowed only on loopback).');
      this.enabled = true;
    }
  }

  private directory(id: string): string { return path.join(this.root, id); }

  initialize(): Promise<void> { return this.enabled ? this.ready() : Promise.resolve(); }

  private ready(): Promise<void> {
    return this.loading ??= (async () => {
      await privateDirectory(this.root);
      for (const id of await fs.readdir(this.root)) {
        if (!FILE_ID.test(id)) continue;
        const directory = this.directory(id);
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        try {
          const record = await readPrivateJson(path.join(directory, 'metadata.json')) as FileRecord;
          if (record.id !== id || typeof record.openId !== 'string' || typeof record.deviceId !== 'string'
            || !Number.isSafeInteger(record.expiresAt) || !Number.isSafeInteger(record.createdAt)) continue;
          if (record.expiresAt <= Date.now()) { await fs.rm(directory, { recursive: true, force: true }); continue; }
          // Restart never replays a model command or resumes an unverified transfer.
          if (record.state === 'parsing') {
            record.state = 'saved'; record.detail = 'Original saved; extraction status unavailable after Router restart.';
          } else if (!['saved', 'parsed', 'partial', 'unsupported', 'failed'].includes(record.state)) {
            record.state = 'failed'; record.detail = 'Router restarted during transfer. Please send the file again.';
          }
          this.files.set(id, { record, abort: new AbortController(), offers: 0 });
        } catch { /* Unknown directories are never exposed or recursively removed. */ }
      }
    })();
  }

  private current(file: LiveFile): boolean {
    const session = this.deps.session(file.record.deviceId);
    return session?.id === file.record.sessionId && session.openId === file.record.openId;
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation);
    void operation.then(() => this.operations.delete(operation), () => this.operations.delete(operation));
    return operation;
  }

  private persist(file: LiveFile): Promise<void> {
    if (file.removed) return Promise.resolve();
    const snapshot = { ...file.record };
    file.writes = (file.writes ?? Promise.resolve()).catch(() => {}).then(() =>
      atomicJson(path.join(this.directory(file.record.id), 'metadata.json'), snapshot));
    return this.track(file.writes);
  }

  private notify(file: LiveFile): Promise<void> {
    file.notifications = this.track((file.notifications ?? Promise.resolve()).then(async () => {
      if (this.stopped || file.removed) return;
      try {
        const cardId = await this.interruptible(this.deps.notify({ ...file.record }), this.shutdown.signal, 20_000);
        if (this.stopped || file.removed) return;
        if (cardId && !file.record.cardId) { file.record.cardId = cardId; await this.persist(file); }
      } catch { /* A card failure does not change file integrity or authorization. */ }
    }));
    return file.notifications;
  }

  /** Resolves after CLI admission, not after the slow download. */
  receive(input: FileInput): Promise<void> { return this.track(this.receiveFile(input)); }

  private async receiveFile(input: FileInput): Promise<void> {
    if (this.stopped) throw new Error('Router file reception stopped.');
    if (!this.enabled) throw new Error('File reception is not configured. Set files.publicUrl to the Router HTTPS origin first.');
    const session = this.deps.session(input.deviceId);
    if (!session || session.openId !== input.openId || !await this.deps.owns(input.openId, input.deviceId)) {
      throw new Error('Files require an upgraded, authenticated CLI. Run remote-cli files enable locally, approve its /bind code, and reconnect. Text and images remain available to legacy devices.');
    }
    await this.ready();
    await this.cleanup();
    if (this.stopped) throw new Error('Router file reception stopped.');
    const id = createHash('sha256').update(JSON.stringify([input.openId, input.messageId, input.fileKey])).digest('hex');
    const duplicate = this.files.get(id);
    if (duplicate) { await this.notify(duplicate); return; }
    const owned = [...this.files.values()].filter(f => f.record.deviceId === input.deviceId);
    const reserved = [...this.files.values()].reduce((sum, f) => sum + (f.record.size ?? this.maxBytes), 0);
    if (this.files.size >= MAX_FILES || owned.length >= MAX_DEVICE_FILES || reserved + this.maxBytes > MAX_SPOOL_BYTES) {
      throw new Error('Attachment storage quota reached. Wait for expired files to be cleaned up before uploading again.');
    }
    if (this.deps.session(input.deviceId)?.id !== session.id) throw new Error('Device reconnected. Please send the file again.');
    const record: FileRecord = {
      ...input, name: displayName(input.name), id, sessionId: session.id,
      createdAt: Date.now(), expiresAt: Date.now() + RETENTION_MS, state: 'pending',
    };
    const file: LiveFile = { record, abort: new AbortController(), offers: 0 };
    this.files.set(id, file);
    try {
      await privateDirectory(this.directory(id));
      await this.persist(file);
      if (this.stopped || file.abort.signal.aborted) return;
      const admitted = new Promise<boolean>(resolve => { file.admission = resolve; });
      file.timer = setTimeout(() => { void this.fail(file, 'CLI did not acknowledge this file. Reconnect and send it again.'); }, 15_000);
      const sent = await this.deps.send(input.deviceId, {
        type: 'file_pending', fileId: id, sourceMessageId: input.messageId, name: record.name,
        openId: input.openId, threadId: input.threadId, maxBytes: this.maxBytes, timestamp: Date.now(),
      });
      if (!sent) await this.fail(file, 'Device disconnected before receiving the file.');
      if (!await admitted) return;
      file.receipt = new Promise<void>(resolve => { file.finishReceipt = resolve; });
      this.queue.push(() => {
        if (file.abort.signal.aborted) return;
        if (this.active >= 4 || this.activeDevices.has(record.deviceId)) {
          this.queue.push(start); return;
        }
        this.active++; this.activeDevices.add(record.deviceId);
        void this.track(this.transfer(file)).finally(() => {
          this.active--; this.activeDevices.delete(record.deviceId); this.drain();
        });
      });
      const start = this.queue[this.queue.length - 1];
      this.drain();
    } catch (error) {
      await this.fail(file, error instanceof Error ? error.message : 'File reception failed.');
    }
  }

  private drain(): void {
    if (this.stopped) return;
    const count = this.queue.length;
    for (let i = 0; i < count; i++) this.queue.shift()?.();
  }

  private async transfer(file: LiveFile): Promise<void> {
    const { record } = file;
    const timer = setTimeout(() => { void this.fail(file, 'File transfer timed out.'); }, FILE_TOTAL_MS);
    try {
      if (!this.current(file) || !await this.deps.owns(record.openId, record.deviceId)) throw new Error('Device or owner changed during transfer.');
      if (file.abort.signal.aborted) throw new Error('File reception cancelled.');
      record.state = 'downloading'; void this.notify(file);
      const temporary = path.join(this.directory(record.id), 'download.part');
      let saved!: { size: number; sha256: string };
      for (let attempt = 0; ; attempt++) {
        try {
          const source = await this.interruptible(this.deps.download(record.messageId, record.fileKey, file.abort.signal).then(stream => {
            if (file.abort.signal.aborted) stream.destroy();
            return stream;
          }), file.abort.signal, FILE_TOTAL_MS);
          saved = await saveStream(source, temporary, this.maxBytes, file.abort.signal);
          break;
        } catch (error: any) {
          if (attempt >= 2 || file.abort.signal.aborted || !['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EPIPE', 'EAI_AGAIN', 'RETRY'].includes(error.code)) throw error;
          await retryDelay(500 * (attempt + 1), undefined, { signal: file.abort.signal });
        }
      }
      if (!this.current(file)) throw new Error('Device disconnected during transfer.');
      await fs.rename(temporary, path.join(this.directory(record.id), 'original'));
      Object.assign(record, saved, { state: 'transferring' });
      await this.persist(file);
      await this.offer(file);
      await file.receipt;
    } catch (error) {
      await this.fail(file, file.abort.signal.aborted ? 'File transfer cancelled or timed out.' : error instanceof Error ? error.message : 'File download failed.');
    } finally { clearTimeout(timer); }
  }

  private async offer(file: LiveFile): Promise<void> {
    if (file.record.state !== 'transferring') return;
    if (!this.current(file) || file.abort.signal.aborted || file.offers >= 3) { await this.fail(file, 'File delivery was not acknowledged. Please send it again.'); return; }
    file.offers++;
    file.token ??= randomBytes(32).toString('hex');
    file.tokenExpires = Date.now() + 120_000;
    await this.deps.send(file.record.deviceId, {
      type: 'file_available', fileId: file.record.id, destination: file.record.destination,
      size: file.record.size, sha256: file.record.sha256, token: file.token,
      downloadPath: `/api/files/${file.record.id}`, expiresAt: file.tokenExpires, timestamp: Date.now(),
    });
    void this.notify(file);
    if (file.record.state !== 'transferring') return;
    clearTimeout(file.timer);
    file.timer = setTimeout(() => { void this.offer(file); }, 45_000);
  }

  handleStatus(deviceId: string, message: any): Promise<void> { return this.track(this.applyStatus(deviceId, message)); }

  private async applyStatus(deviceId: string, message: any): Promise<void> {
    if (this.stopped) return;
    if (!FILE_ID.test(message.fileId ?? '')) return;
    const file = this.files.get(message.fileId);
    if (!file || file.removed || file.record.deviceId !== deviceId || !this.current(file)) return;
    if (message.status === 'admitted' && file.admission) {
      if (typeof message.threadId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(message.threadId)
        || typeof message.destination !== 'string' || !/^[a-f0-9-]{36}$/.test(message.destination)) return;
      clearTimeout(file.timer);
      file.record.threadId = message.threadId;
      file.record.destination = message.destination;
      const resolve = file.admission; file.admission = undefined;
      try { await this.persist(file); resolve(!file.abort.signal.aborted); }
      catch { resolve(false); await this.fail(file, 'Could not persist file admission.'); }
      return;
    }
    if (message.status === 'failed' && (!file.record.destination || message.destination === file.record.destination)) { await this.fail(file, displayName(message.detail)); return; }
    if (message.destination !== file.record.destination || file.record.state === 'failed') return;
    if (['saved', 'parsing', 'parsed', 'partial', 'unsupported'].includes(message.status) && file.record.sha256 === message.sha256 && file.record.size === message.size) {
      if (['parsed', 'partial', 'unsupported'].includes(file.record.state) && ['saved', 'parsing'].includes(message.status)) return;
      clearTimeout(file.timer);
      file.finishReceipt?.();
      file.token = undefined;
      file.record.state = message.status;
      file.record.detail = displayName(message.detail);
      await this.persist(file); await this.notify(file);
    }
  }

  async serve(ctx: Context, id: string): Promise<void> {
    ctx.set('Cache-Control', 'no-store');
    const file = this.files.get(id);
    const token = ctx.get('authorization').replace(/^Bearer /, '');
    if (!FILE_ID.test(id) || !FILE_ID.test(token) || !file?.token || token.length !== file.token.length
      || !timingSafeEqual(Buffer.from(token), Buffer.from(file.token))
      || !this.current(file) || file.abort.signal.aborted || (file.tokenExpires ?? 0) < Date.now()
      || !await this.deps.owns(file.record.openId, file.record.deviceId)
      || !this.current(file) || file.abort.signal.aborted) { ctx.status = 403; return; }
    if (file.reading) { ctx.status = 429; return; }
    file.reading = true;
    let stream: Readable;
    try { stream = readOwnedFile(path.join(this.directory(id), 'original')); }
    catch { file.reading = false; ctx.status = 410; await this.fail(file, 'Router original is unavailable. Please upload it again.'); return; }
    const abort = () => stream.destroy(new Error('File access revoked.'));
    file.abort.signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, FILE_TOTAL_MS);
    const finish = () => { file.reading = false; clearTimeout(timeout); file.abort.signal.removeEventListener('abort', abort); };
    stream.once('close', finish);
    ctx.res.once('close', () => stream.destroy());
    ctx.res.setTimeout(20_000, () => stream.destroy(new Error('File download stalled.')));
    ctx.type = 'application/octet-stream';
    ctx.length = file.record.size!;
    ctx.body = stream;
  }

  resolve(openId: string, sourceOrCardId: string): { id: string; deviceId: string; threadId: string } | undefined {
    for (const { record } of this.files.values()) {
      if (record.openId === openId && (record.messageId === sourceOrCardId || record.cardId === sourceOrCardId)
        && record.threadId && record.expiresAt > Date.now()) return { id: record.id, deviceId: record.deviceId, threadId: record.threadId };
    }
    return undefined;
  }

  disconnect(deviceId: string): void {
    for (const file of this.files.values()) {
      if (file.record.deviceId === deviceId && !this.current(file)) {
        file.token = undefined;
        if (['pending', 'downloading', 'transferring'].includes(file.record.state)) void this.fail(file, 'Device disconnected. Please send the file again.');
      }
    }
  }

  private async fail(file: LiveFile, detail: string): Promise<void> {
    if (file.record.state === 'failed') return;
    clearTimeout(file.timer); file.token = undefined;
    file.abort.abort();
    file.record.state = 'failed'; file.record.detail = detail.slice(0, 300);
    file.record.expiresAt = Math.min(file.record.expiresAt, Date.now() + 15 * 60_000);
    file.record.size ??= 0;
    file.admission?.(false); file.admission = undefined;
    file.finishReceipt?.();
    try { await this.persist(file); } catch { /* Preserve the visible failure on disk errors. */ }
    if (this.current(file)) await this.deps.send(file.record.deviceId, { type: 'file_failed', fileId: file.record.id, detail: file.record.detail, timestamp: Date.now() }).catch(() => false);
    await this.notify(file);
  }

  private async cleanup(): Promise<void> {
    for (const [id, file] of this.files) {
      if (file.record.expiresAt > Date.now() || file.reading || ['pending', 'downloading', 'transferring'].includes(file.record.state)) continue;
      file.removed = true;
      await file.writes?.catch(() => {});
      await fs.rm(this.directory(id), { recursive: true, force: true }); this.files.delete(id);
    }
  }

  async destroy(): Promise<void> {
    this.stopped = true; this.shutdown.abort();
    for (const file of this.files.values()) { clearTimeout(file.timer); file.abort.abort(); file.admission?.(false); file.finishReceipt?.(); }
    this.queue.length = 0;
    while (this.operations.size) await Promise.allSettled([...this.operations]);
  }

  private interruptible<T>(operation: Promise<T>, signal: AbortSignal, milliseconds: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const abort = () => { cleanup(); reject(new Error('File operation cancelled.')); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('File operation timed out.')); }, milliseconds);
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { cleanup(); abort(); }
      operation.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
  }
}
