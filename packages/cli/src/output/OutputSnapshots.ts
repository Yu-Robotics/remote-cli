import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createHash, randomBytes } from 'crypto';
import { setImmediate as yieldIO } from 'timers/promises';
import { nativeBindings, type NativeHandle, type NativeStat } from '../native/NativeBindings';
import { displayName, fileLimit, readPrivateJson } from '../files/FileIO';
import { PrivateOutputRoot } from './PrivateOutputRoot';
import { durableJson, syncDirectory } from './Durable';
import { OPAQUE_ID, OUTPUT_LIMITS, OutputReference, validReference } from './Protocol';

export interface VerifiedOutputExport { file: string; path: string; sha256: string; bytes: number; taskId: string }
export interface SnapshotContext { omitted?: boolean; exports?: VerifiedOutputExport[]; messageId: string; threadId: string; taskId: string; generation: number; cwd: string; source: OutputReference['source'] }
export interface OutputPolicy { allowedRoots?: string[]; maxBytes?: number }
interface Record { reference: OutputReference; identity: string; snapshotIdentity: string }
function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}
function same(a: NativeStat, b: NativeStat): boolean { return a.dev === b.dev && a.ino === b.ino && a.kind === b.kind; }

/** No-follow, handle-relative traversal on POSIX and Windows; no absolute-path read fallback. */
export function openOutputFile(filename: string): { identity: string; size: number; chunks(): AsyncGenerator<Buffer>; close(): void } {
  const native = nativeBindings();
  if (!native.readChunk) throw new Error('Output file handle support unavailable.');
  const handles: NativeHandle[] = [], stats: NativeStat[] = [];
  const volume = path.parse(filename).root;
  const components = filename.slice(volume.length).split(path.sep).filter(Boolean);
  const close = () => { for (const handle of handles.splice(0).reverse()) native.close(handle); };
  try {
    let current = native.openRoot(volume); handles.push(current); stats.push(native.stat(current));
    for (let i = 0; i < components.length; i++) {
      current = native.openOutputChild(current, components[i], i < components.length - 1);
      handles.push(current); stats.push(native.stat(current));
    }
    const before = stats[stats.length - 1];
    const size = Number(before.size);
    if (before.kind !== 'file' || before.nlink !== '1' || !Number.isSafeInteger(size) || size <= 0 || size > OUTPUT_LIMITS.file) throw new Error('Output file is unavailable or exceeds the limit.');
    return { identity: `${before.dev}:${before.ino}`, size, close,
      async *chunks() {
        for (let offset = 0; offset < size;) {
          const bytes = native.readChunk(current, offset, Math.min(65536, size - offset));
          if (!bytes.length) throw new Error('Output changed during snapshot.');
          offset += bytes.length; yield bytes; await yieldIO();
        }
        const after = native.stat(current);
        if (!same(before, after) || before.size !== after.size || before.mtime !== after.mtime || after.nlink !== '1') throw new Error('Output changed during snapshot.');
        // Rewalk through new anchored handles to reject replacement of any scope before advertising.
        const checked: NativeHandle[] = [];
        try {
          let next = native.openRoot(volume); checked.push(next);
          if (!same(stats[0], native.stat(next))) throw new Error('Output root changed.');
          for (let i = 0; i < components.length; i++) {
            next = native.openOutputChild(next, components[i], i < components.length - 1); checked.push(next);
            if (!same(stats[i + 1], native.stat(next))) throw new Error('Output scope changed.');
          }
        } finally { for (const handle of checked.reverse()) native.close(handle); }
      } };
  } catch (error) { close(); throw error; }
}

/** Snapshots have independent 20 MiB receipts; legacy WorkspaceExport limits are unchanged. */
export class OutputSnapshots {
  private records = new Map<string, Record>();
  private tail: Promise<unknown> = Promise.resolve();
  private pins = new Set<string>();
  private stopped = false;
  private cleanupTimer?: NodeJS.Timeout;
  private storage: PrivateOutputRoot;
  get root(): string { return this.storage.path; }
  constructor(root: string, private policy: OutputPolicy = {}) {
    this.storage = new PrivateOutputRoot(root);
    fileLimit(policy.maxBytes);
    if (policy.allowedRoots !== undefined && (!Array.isArray(policy.allowedRoots) || policy.allowedRoots.length > 16
      || policy.allowedRoots.some(root => typeof root !== 'string' || !path.isAbsolute(root) || root.length > 4096))) throw new Error('Invalid output root policy.');
  }
  async initialize(): Promise<void> {
    await this.storage.initialize();
    for (const name of await fs.readdir(this.root)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      try {
        const record = await readPrivateJson(path.join(this.root, name)) as Record;
        if (!validReference(record.reference) || `${record.reference.id}.json` !== name || typeof record.identity !== 'string' || typeof record.snapshotIdentity !== 'string') continue;
        this.records.set(record.reference.id, record);
      } catch { /* Invalid records never authorize reads. */ }
    }
    await this.cleanup();
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = setInterval(() => {
      const work = this.tail.then(() => this.cleanup()); this.tail = work.catch(() => {});
    }, 60_000); this.cleanupTimer.unref();
  }
  references(): OutputReference[] { return [...this.records.values()].map(r => r.reference).filter(r => r.expiresAt > Date.now()); }
  snapshot(candidate: string, context: SnapshotContext): Promise<OutputReference> {
    const operation = this.tail.then(() => this.capture(candidate, context));
    this.tail = operation.catch(() => {}); return operation;
  }
  private async capture(candidate: string, context: SnapshotContext): Promise<OutputReference> {
    if (this.stopped) throw new Error('Output capture stopped.');
    await this.cleanup();
    const cwd = await fs.realpath(context.cwd);
    const filename = path.resolve(cwd, candidate);
    const exported = context.exports?.find(entry => entry.file === filename);
    const home = await fs.realpath(os.homedir());
    const grantedRoots: string[] = [];
    for (const root of this.policy.allowedRoots ?? []) {
      const canonical = await fs.realpath(root);
      if (canonical !== home && canonical !== path.parse(canonical).root) grantedRoots.push(canonical);
    }
    const grant = grantedRoots.filter(root => inside(root, filename)).sort((a, b) => b.length - a.length)[0];
    const policyPath = exported?.path ?? path.relative(grant ?? cwd, filename);
    if (/^(?:[/\\]{2})/.test(candidate) || policyPath.split(/[/\\]/).some(part => part.startsWith('.') && part !== '..')
      || /(?:^|[/\\])(?:id_rsa|id_ed25519|credentials|credentials\.json|auth\.json|sessions?|transcripts?)(?:[/\\]|$)/i.test(policyPath)
      || (process.platform === 'win32' && filename.slice(2).includes(':'))) throw new Error('Output export policy denied this file.');
    const privateRoot = path.join(await fs.realpath(os.homedir()), '.remote-cli');
    const managedTree = path.join(privateRoot, 'delegation-workspaces', 'trees');
    if (!exported && inside(privateRoot, filename)
      && !(context.source === 'worker' && inside(managedTree, cwd) && inside(cwd, filename))) throw new Error('Application state cannot be exported.');
    const roots = [cwd, ...grantedRoots];
    const sensitive = new Set(['.git', '.ssh', '.aws', '.kube', '.codex', '.claude', '.zcode', '.kimi-code', '.gemini']);
    if (!exported && filename.split(path.sep).some(part => sensitive.has(part.toLowerCase()))) throw new Error('Credential and native session roots cannot be exported.');
    let authorized = !!exported;
    if (exported && (!OPAQUE_ID.test(exported.sha256) || !Number.isSafeInteger(exported.bytes) || exported.bytes <= 0 || exported.bytes > OUTPUT_LIMITS.file)) throw new Error('Invalid verified export receipt.');
    for (const root of roots) {
      const canonical = await fs.realpath(root);
      if (canonical === path.parse(canonical).root || canonical === await fs.realpath(os.homedir())) continue;
      if (inside(canonical, filename)) authorized = true;
    }
    if (!authorized) throw new Error('Output is outside the authorized workspace.');
    let opened: ReturnType<typeof openOutputFile>;
    try { opened = openOutputFile(filename); }
    catch (error: any) {
      // A real POSIX colon filename wins. Only a missing exact file permits a numeric code-location suffix.
      if (!exported && process.platform !== 'win32' && error.code === 'ENOENT' && /:\d+(?::\d+)?$/.test(candidate)) {
        return this.capture(candidate.replace(/:\d+(?::\d+)?$/, ''), context);
      }
      throw error;
    }
    let temporary: string | undefined;
    try {
      if (exported && exported.bytes !== opened.size) throw new Error('Verified export changed.');
      if (opened.size > fileLimit(this.policy.maxBytes)) throw new Error('Output exceeds the configured limit.');
      const duplicate = [...this.records.values()].find(r => r.reference.messageId === context.messageId && r.identity === opened.identity);
      if (duplicate) return duplicate.reference;
      const total = [...this.records.values()].reduce((n, r) => n + r.reference.size, 0);
      if (this.records.size >= OUTPUT_LIMITS.references || total + opened.size > OUTPUT_LIMITS.cliBytes) throw new Error('Output snapshot quota reached.');
      const id = randomBytes(32).toString('hex'); temporary = path.join(this.root, `${id}.tmp`);
      const handle = await fs.open(temporary, 'wx', 0o600), hash = createHash('sha256');
      let size = 0;
      try {
        for await (const chunk of opened.chunks()) { size += chunk.length; hash.update(chunk); await handle.writeFile(chunk); }
        if (size !== opened.size) throw new Error('Output changed during snapshot.');
        await handle.sync();
      } finally { await handle.close(); }
      const digest = hash.digest('hex');
      if (exported && digest !== exported.sha256) throw new Error('Verified export changed.');
      const reference: OutputReference = { ...(context.omitted ? { discoveryIncomplete: true } : {}), id, messageId: context.messageId, threadId: context.threadId, taskId: exported?.taskId ?? context.taskId,
        generation: context.generation, name: displayName(path.basename(exported?.path ?? filename)), source: exported ? 'export' : context.source,
        size, sha256: digest, expiresAt: Date.now() + OUTPUT_LIMITS.ttl };
      if (!validReference(reference)) throw new Error('Invalid output reference.');
      await fs.rename(temporary, this.filename(id)); temporary = undefined; await syncDirectory(this.root);
      const stored = openOutputFile(this.filename(id));
      const snapshotIdentity = stored.identity; stored.close();
      const record = { reference, identity: opened.identity, snapshotIdentity };
      await durableJson(path.join(this.root, `${id}.json`), record, this.storage.check); this.records.set(id, record);
      return reference;
    } finally { opened.close(); if (temporary) { this.storage.check(); await fs.rm(temporary, { force: true }); } }
  }
  filename(id: string): string { if (!OPAQUE_ID.test(id)) throw new Error('Invalid output ID.'); return path.join(this.root, `${id}.bin`); }
  async read(id: string, use: (source: AsyncIterable<Buffer>, reference: OutputReference) => Promise<void>): Promise<void> {
    const record = this.records.get(id);
    if (!record || record.reference.expiresAt <= Date.now() || this.stopped || this.pins.has(id)) throw new Error('Output expired or busy.');
    this.pins.add(id);
    let opened: ReturnType<typeof openOutputFile> | undefined;
    try {
      opened = openOutputFile(this.filename(id));
      if (opened.size !== record.reference.size || opened.identity !== record.snapshotIdentity) throw new Error('Snapshot identity changed.');
      const hash = createHash('sha256');
      for await (const chunk of opened.chunks()) hash.update(chunk);
      if (hash.digest('hex') !== record.reference.sha256) throw new Error('Snapshot bytes changed.');
      this.storage.check();
      await use(opened.chunks(), record.reference);
    } finally { opened?.close(); this.pins.delete(id); }
  }
  async cleanup(): Promise<void> {
    for (const [id, record] of this.records) if (record.reference.expiresAt <= Date.now() && !this.pins.has(id)) {
      await fs.rm(this.filename(id), { force: true }); await fs.rm(path.join(this.root, `${id}.json`), { force: true }); this.records.delete(id);
    }
    // Only this store's opaque, unreferenced artifacts can be reclaimed after a crash.
    for (const name of await fs.readdir(this.root)) if (/^[a-f0-9]{64}\.(tmp|bin)$/.test(name) && !this.records.has(name.slice(0, 64))) {
      await fs.rm(path.join(this.root, name), { force: true });
    }
  }
  async destroy(): Promise<void> { this.stopped = true; clearInterval(this.cleanupTimer); await this.tail; }
}
