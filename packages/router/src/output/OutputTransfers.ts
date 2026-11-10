import fs from 'fs/promises';
import path from 'path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { Transform, Writable } from 'stream';
import { pipeline } from 'stream/promises';
import type { Context } from 'koa';
import { readOwnedFile } from '../files/FileIO';
import { PrivateOutputRoot } from './PrivateOutputRoot';
import { durableJson, syncDirectory } from './Durable';
import { OPAQUE_ID, OUTPUT_LIMITS, OutputReference, validReference } from './Protocol';
import type { InlineFileRow, InlineIdentity } from './InlineFileCards';
import { outputFileTransferCard } from './OutputFileCards';

export class OutputApiRejection extends Error { constructor() { super('File delivery was rejected.'); } }
interface Source { generation?: number; messageId: string; deviceId: string; openId: string; threadId?: string; epoch: string; expiresAt: number; notices?: Record<string, CardIntent> }
interface CardIntent { uuid: string; content: string; firstAt: number; id?: string; state: 'intent' | 'known' | 'uncertain' | 'unavailable' }
interface Reference extends Source { reference: OutputReference; card?: CardIntent }
export type JobState = 'queued' | 'waiting-device' | 'receiving' | 'staged-verified' | 'upload-intent' | 'file-key-saved' | 'send-intent' | 'delivered' | 'send-uncertain' | 'failed' | 'expired' | 'revoked';
export interface OutputJob {
  id: string; refId: string; openId: string; deviceId: string; epoch: string; state: JobState; revision: number;
  createdAt: number; updatedAt: number; received: number; card?: CardIntent; displayPending?: boolean;
  display?: { revision: number; failures: number; after: number };
  spoolBytes?: number; fileKey?: string; send?: { uuid: string; content: string; firstAt: number }; messageId?: string;
}
interface State { version: 1; sources: Source[]; references: Reference[]; jobs: OutputJob[] }
interface Grant { token: string; sessionId: string; expiresAt: number; job: OutputJob; abort: AbortController; receiving: boolean; revision: number; disconnected?: boolean }
export interface OutputDependencies {
  session(deviceId: string): { id: string; openId: string } | undefined;
  owns(openId: string, deviceId: string, epoch: string): Promise<boolean>;
  send(deviceId: string, message: object): unknown;
  create(openId: string, content: string, uuid: string): Promise<string>;
  patch(cardId: string, content: string): Promise<void>;
  upload(filename: string, name: string): Promise<string>;
  inline?(messageId: string): Promise<void>;
  parentAllowed?(identity: InlineIdentity, cardId: string): Promise<boolean>;
  sendFile(openId: string, content: string, uuid: string): Promise<string>;
}
const terminal = new Set<JobState>(['delivered', 'send-uncertain', 'expired', 'revoked']);
const ACTIVE_LEASE = 5 * 60_000;
const states = new Set(['queued', 'waiting-device', 'receiving', 'staged-verified', 'upload-intent', 'file-key-saved', 'send-intent', 'delivered', 'send-uncertain', 'failed', 'expired', 'revoked']);
function label(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 200; }
function validCard(value: any): boolean {
  return value === undefined || (!!value && ['intent', 'known', 'uncertain', 'unavailable'].includes(value.state)
    && typeof value.uuid === 'string' && value.uuid.length > 0 && value.uuid.length <= 50
    && typeof value.content === 'string' && value.content.length <= 16_384 && Number.isSafeInteger(value.firstAt)
    && (value.id === undefined || (typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 512))
    && (value.state !== 'known' || !!value.id));
}
function validSource(value: any): boolean {
  return !!value && ['messageId', 'deviceId', 'openId', 'epoch'].every(key => label(value[key]))
    && (value.generation === undefined || Number.isSafeInteger(value.generation) && value.generation >= 0)
    && (value.threadId === undefined || label(value.threadId)) && Number.isSafeInteger(value.expiresAt)
    && (value.notices === undefined || (typeof value.notices === 'object' && value.notices !== null
      && Object.keys(value.notices).length <= 16 && Object.entries(value.notices).every(([key, intent]) => OPAQUE_ID.test(key) && validCard(intent))));
}
function validState(data: State): boolean {
  return data.sources.every(validSource) && new Set(data.sources.map(s => s.messageId)).size === data.sources.length
    && data.references.every(r => validSource(r) && validReference(r.reference) && validCard(r.card)
      && (r.generation === undefined || r.generation === r.reference.generation)
      && r.messageId === r.reference.messageId && (!r.threadId || r.threadId === r.reference.threadId))
    && new Set(data.references.map(r => r.reference.id)).size === data.references.length
    && new Set(data.jobs.map(j => j.id)).size === data.jobs.length
    && data.jobs.every(j => {
      const ref = data.references.find(r => r.reference.id === j.refId);
      return OPAQUE_ID.test(j.id) && OPAQUE_ID.test(j.refId) && label(j.openId) && label(j.deviceId) && label(j.epoch)
        && states.has(j.state) && Number.isSafeInteger(j.createdAt) && Number.isSafeInteger(j.updatedAt)
        && Number.isSafeInteger(j.revision) && j.revision >= 0 && Number.isSafeInteger(j.received) && j.received >= 0
        && validCard(j.card) && (j.spoolBytes === undefined || (Number.isSafeInteger(j.spoolBytes) && j.spoolBytes >= 0 && j.spoolBytes <= OUTPUT_LIMITS.file))
        && (j.fileKey === undefined || (typeof j.fileKey === 'string' && j.fileKey.length > 0 && j.fileKey.length <= 512))
        && (!ref ? terminal.has(j.state) || j.state === 'failed' : ref.openId === j.openId && ref.deviceId === j.deviceId && ref.epoch === j.epoch);
    });
}

async function bounded<T>(operation: Promise<T>, ms = 15_000): Promise<T> {
  let timer: NodeJS.Timeout;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('External outcome unknown.')), ms); timer.unref(); })]); }
  finally { clearTimeout(timer!); }
}

/** Durable file delivery business state is independent of card presentation. */
export class OutputTransfers {
  private state: State = { version: 1, sources: [], references: [], jobs: [] };
  private serial: Promise<unknown> = Promise.resolve();
  private running = new Map<string, Promise<void>>();
  private presentations = new Map<string, Promise<void>>();
  private grants = new Map<string, Grant>();
  private entryWork = new Map<string, Promise<void>>();
  private entryDirty = new Set<string>();
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private ticking = false;
  private currentTick?: Promise<void>;
  private healthy = true;
  private ready = false;
  private loading?: Promise<void>;
  private noticeWork = new Set<Promise<void>>();
  private cleanedAt = 0;
  private storage: PrivateOutputRoot;
  private get root(): string { return this.storage.path; }
  constructor(root: string, private deps: OutputDependencies) { this.storage = new PrivateOutputRoot(root); }
  private persist(): Promise<void> { return durableJson(path.join(this.root, 'state.json'), this.state, this.storage.check); }
  private lock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(async () => {
      if (!this.healthy) throw new Error('Output receipt storage is unavailable.');
      this.storage.check();
      try { return await operation(); } catch (error) { throw error; }
    });
    this.serial = result.catch(() => {}); return result;
  }
  private async save(): Promise<void> {
    try { await this.persist(); } catch { this.healthy = false; throw new Error('Output receipt storage is unavailable.'); }
  }
  initialize(): Promise<void> {
    return this.loading ??= (async () => {
      await this.storage.initialize();
      try {
        const filename = path.join(this.root, 'state.json'), stat = await fs.lstat(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error('Invalid output receipts.');
        const data = JSON.parse(await fs.readFile(filename, 'utf8')) as State;
        if (data.version !== 1 || !Array.isArray(data.sources) || !Array.isArray(data.references) || !Array.isArray(data.jobs)
          || data.sources.length > 1024 || data.references.length > 100 || data.jobs.length > 1000
          || data.references.some(r => !validReference(r.reference))
          || !validState(data)) throw new Error('Invalid output receipts.');
        this.state = data;
      } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      for (const ref of this.state.references) if (ref.card?.state === 'intent') ref.card.state = 'uncertain';
      for (const job of this.state.jobs) {
        if (job.card?.state === 'intent') job.card.state = 'uncertain';
        if (job.state === 'send-intent') job.state = 'send-uncertain';
        if (job.state === 'upload-intent') job.state = 'failed';
        if (job.state === 'receiving') {
          const ref = this.state.references.find(r => r.reference.id === job.refId);
          job.state = ref && await this.hasSpool(job, ref) ? 'staged-verified' : 'queued';
          job.spoolBytes = job.state === 'staged-verified' ? ref!.reference.size : 0;
        }
        if (job.card?.id) job.displayPending = true;
      }
      await this.cleanup(); await this.save(); this.ready = true;
      this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 2000); this.timer.unref();
    })();
  }
  /** In-memory only: disabled file capability must not initialize byte storage. */
  identityStatus(identity: InlineIdentity): 'match' | 'conflict' | 'unknown' {
    if (!this.ready || !this.healthy || this.stopped) return 'unknown';
    const records = [...this.state.sources.filter(source => source.messageId === identity.messageId),
      ...this.state.references.filter(ref => ref.messageId === identity.messageId).map(ref => this.identity(ref))];
    if (!records.length) return 'unknown';
    if (new Set(records.flatMap(record => record.generation === undefined ? [] : [record.generation])).size > 1) return 'conflict';
    return records.every(record => record.openId === identity.openId && record.deviceId === identity.deviceId
      && record.epoch === identity.epoch && (record.threadId === undefined || record.threadId === identity.threadId)
      && (record.generation === undefined || identity.generation === undefined || record.generation === identity.generation)) ? 'match' : 'conflict';
  }
  private identity(ref: Reference): InlineIdentity {
    return { messageId: ref.messageId, openId: ref.openId, deviceId: ref.deviceId, epoch: ref.epoch,
      threadId: ref.reference.threadId, generation: ref.reference.generation };
  }
  async admitSource(source: Omit<Source, 'expiresAt'>): Promise<void> {
    await this.initialize();
    await this.lock(async () => {
      if (this.stopped) return;
      const refs = this.state.references.filter(ref => ref.messageId === source.messageId);
      if (refs.some(ref => ref.openId !== source.openId || ref.deviceId !== source.deviceId || ref.epoch !== source.epoch
        || source.threadId !== undefined && ref.reference.threadId !== source.threadId
        || source.generation !== undefined && ref.reference.generation !== source.generation)) throw new Error('Output source conflict.');
      const prior = this.state.sources.find(s => s.messageId === source.messageId);
      if (prior) {
        if (prior.openId !== source.openId || prior.deviceId !== source.deviceId || prior.epoch !== source.epoch
          || (prior.threadId && source.threadId && prior.threadId !== source.threadId)
          || (prior.generation !== undefined && source.generation !== undefined && prior.generation !== source.generation)) throw new Error('Output source conflict.');
        let changed = false;
        if (!prior.threadId && source.threadId) { prior.threadId = source.threadId; changed = true; }
        if (prior.generation === undefined && source.generation !== undefined) { prior.generation = source.generation; changed = true; }
        if (changed) await this.save();
        if (prior.expiresAt <= Date.now()) { prior.expiresAt = Date.now() + OUTPUT_LIMITS.ttl; await this.save(); }
        return;
      }
      this.state.sources = this.state.sources.filter(s => s.expiresAt > Date.now());
      if (this.state.sources.length >= 1024) throw new Error('Output source limit reached.');
      this.state.sources.push({ ...source, expiresAt: Date.now() + OUTPUT_LIMITS.ttl }); await this.save();
    });
  }
  /** Carry an unverified source only across the first-key approval of its exact parent. */
  async migrateApprovalSource(owner: InlineIdentity, epoch: string): Promise<boolean> {
    await this.initialize();
    return this.lock(async () => {
      if (this.stopped || this.state.references.some(r => r.messageId === owner.messageId)
        || !await this.deps.owns(owner.openId, owner.deviceId, epoch)) return false;
      const prior = this.state.sources.find(s => s.messageId === owner.messageId);
      if (prior && (prior.openId !== owner.openId || prior.deviceId !== owner.deviceId || prior.epoch !== owner.epoch
        || prior.threadId !== undefined && prior.threadId !== owner.threadId
        || prior.generation !== undefined && prior.generation !== owner.generation || prior.expiresAt <= Date.now())) return false;
      if (prior) { prior.epoch = epoch; prior.threadId = owner.threadId; prior.generation = owner.generation; }
      else {
        if (this.state.sources.length >= 1024) return false;
        this.state.sources.push({ ...owner, epoch, expiresAt: Date.now() + OUTPUT_LIMITS.ttl });
      }
      await this.save(); return true;
    });
  }
  async offer(deviceId: string, value: unknown): Promise<void> {
    const expectedSession = this.deps.session(deviceId)?.id;
    await this.initialize();
    if (!validReference(value) || value.expiresAt <= Date.now() || value.expiresAt > Date.now() + OUTPUT_LIMITS.ttl + 5000) return;
    const reference = { ...(value.discoveryIncomplete ? { discoveryIncomplete: true } : {}), id: value.id, messageId: value.messageId, threadId: value.threadId, taskId: value.taskId,
      generation: value.generation, name: value.name, source: value.source, size: value.size, sha256: value.sha256, expiresAt: value.expiresAt };
    let accepted: Reference | undefined;
    await this.lock(async () => {
      const session = this.deps.session(deviceId);
      const prior = this.state.references.find(r => r.reference.id === reference.id);
      const source = prior ?? this.state.sources.find(s => s.messageId === reference.messageId && s.deviceId === deviceId && s.expiresAt > Date.now());
      if (this.stopped || !expectedSession || session?.id !== expectedSession || !source || session?.openId !== source.openId || (source.threadId && source.threadId !== reference.threadId)
        || !await this.deps.owns(source.openId, deviceId, source.epoch)) return;
      const generation = source.generation ?? this.state.references.find(r => r.deviceId === deviceId && r.messageId === reference.messageId)?.reference.generation;
      if (generation !== undefined && generation !== reference.generation) return;
      if (prior) {
        if (prior.deviceId !== deviceId || JSON.stringify(prior.reference) !== JSON.stringify(reference)) return;
        accepted = prior;
      } else {
        if (this.state.references.length >= OUTPUT_LIMITS.references) return;
        source.generation ??= reference.generation; source.threadId ??= reference.threadId;
        const { notices: _notices, ...binding } = source;
        accepted = { ...binding, reference }; this.state.references.push(accepted); await this.save();
      }
      this.deps.send(deviceId, { type: 'output_registered', id: reference.id });
    });
    if (accepted) this.entry(accepted);
  }
  async discovery(_deviceId: string, _value: unknown): Promise<void> {
    // Legacy count-only notices are intentionally quiet. Never create a card.
  }
  private entry(ref: Reference): void {
    // New references require the original assistant body. Never create a fallback entry.
    if (ref.card || !this.deps.inline || this.stopped) return;
    this.entryDirty.add(ref.messageId);
    if (this.entryWork.has(ref.messageId)) return;
    const work = (async () => {
      do {
        this.entryDirty.delete(ref.messageId);
        try { await this.deps.inline!(ref.messageId); } catch { /* Hold unavailable bodies without fallback cards. */ }
      } while (!this.stopped && this.entryDirty.has(ref.messageId));
    })().finally(() => {
      this.entryWork.delete(ref.messageId);
      if (this.entryDirty.delete(ref.messageId) && !this.stopped) this.entry(ref);
    });
    this.entryWork.set(ref.messageId, work);
  }
  async click(openId: string, cardId: string, action: any): Promise<string> {
    await this.initialize();
    let result = 'This file is unavailable.';
    await this.lock(async () => {
      if (this.stopped || !OPAQUE_ID.test(action?.id)) return;
      const ref = this.state.references.find(r => r.reference.id === action.id);
      if (!ref || ref.openId !== openId || !await this.deps.owns(openId, ref.deviceId, ref.epoch)) return;
      if (!ref.card && this.identityStatus(this.identity(ref)) !== 'match') return;
      let job = this.state.jobs.find(j => j.refId === ref.reference.id && j.openId === openId && j.epoch === ref.epoch);
      const parent = !ref.card && !!this.deps.parentAllowed && await this.deps.parentAllowed(this.identity(ref), cardId);
      if (action.op === 'get') {
        if (!parent && (ref.card?.state !== 'known' || ref.card.id !== cardId)) return;
        if (job) { result = this.status(job); return; }
        if (ref.reference.expiresAt <= Date.now()) { result = 'This file has expired.'; return; }
        if (this.state.jobs.length >= 1000 || this.state.jobs.filter(j => j.openId === openId && !terminal.has(j.state) && j.state !== 'failed').length >= 20) { result = 'File queue is full.'; return; }
        job = { id: randomBytes(32).toString('hex'), refId: ref.reference.id, openId, deviceId: ref.deviceId, epoch: ref.epoch,
          state: 'queued', revision: 0, received: 0, createdAt: Date.now(), updatedAt: Date.now() };
        this.state.jobs.push(job); await this.save(); result = 'File retrieval accepted.';
      } else if (action.op === 'retry' && job && (parent || job.card?.state === 'known' && job.card.id === cardId) && action.rev === job.revision
        && job.state === 'failed' && !this.running.has(job.id) && ref.reference.expiresAt > Date.now()) {
        job.state = job.fileKey ? 'file-key-saved' : await this.hasSpool(job, ref) ? 'staged-verified' : 'queued';
        job.revision++; job.updatedAt = Date.now(); job.displayPending = true; await this.save(); result = 'Retry accepted.';
      }
    });
    void this.tick().catch(() => {}); return result;
  }
  inlineRows(identity: InlineIdentity): InlineFileRow[] {
    if (!this.ready || !this.healthy || this.stopped || this.identityStatus(identity) === 'conflict') return [];
    return this.state.references.filter(ref => !ref.card && ref.messageId === identity.messageId && ref.openId === identity.openId
      && ref.deviceId === identity.deviceId && ref.epoch === identity.epoch && ref.reference.threadId === identity.threadId
      && (identity.generation === undefined || ref.reference.generation === identity.generation)).map(ref => {
      const job = this.state.jobs.find(j => j.refId === ref.reference.id && j.epoch === ref.epoch);
      const expired = ref.reference.expiresAt <= Date.now();
      const op = expired ? undefined : !job ? 'get' as const : job.state === 'failed' ? 'retry' as const
        : ['delivered', 'send-uncertain', 'revoked', 'expired'].includes(job.state) ? undefined : 'get' as const;
      return { ...this.identity(ref), id: ref.reference.id, name: ref.reference.name, size: ref.reference.size, expiresAt: ref.reference.expiresAt, generation: ref.reference.generation,
        status: expired ? 'Expired' : job ? this.status(job) : 'Ready', op, revision: job?.revision };
    });
  }
  private status(job: OutputJob): string {
    if (job.state === 'delivered') return 'File already delivered.';
    if (job.state === 'send-uncertain') return 'File send outcome is unknown. It will not be sent again automatically.';
    const labels: Record<string, string> = {
      queued: 'File retrieval queued.', 'waiting-device': 'Waiting for the original device to reconnect.',
      receiving: 'Receiving the snapshot.', 'staged-verified': 'Snapshot received and verified.',
      'upload-intent': 'Uploading to Feishu.', 'file-key-saved': 'Upload complete; preparing the file message.',
      'send-intent': 'Sending the file message.', failed: 'Retrieval failed. Retry is available here.',
      expired: 'This file has expired.', revoked: 'Device ownership changed; retrieval is unavailable.',
    };
    return labels[job.state];
  }
  private content(job: OutputJob, ref: Reference): string {
    return outputFileTransferCard(job, ref.reference, Date.now());
  }
  private async present(job: OutputJob, ref: Reference): Promise<void> {
    if (!ref.card && !job.card) {
      try { await this.deps.inline?.(ref.messageId); job.displayPending = false; }
      catch { /* Presentation loss cannot change delivery receipts or create fallback cards. */ }
      return;
    }
    if (this.presentations.has(job.id)) return this.presentations.get(job.id);
    if (this.presentations.size >= 4) return;
    if (job.card?.id && job.display) {
      if (Date.now() < job.display.after || (job.display.revision === job.revision && job.display.failures >= 3)) return;
    }
    const work = (async () => {
      let create = false, content = '';
      await this.lock(async () => {
        content = this.content(job, ref);
        if (!job.card) {
          job.card = { uuid: randomUUID(), firstAt: Date.now(), content, state: 'intent' }; create = true; await this.save();
        }
      });
      if (this.stopped || !await this.deps.owns(job.openId, job.deviceId, job.epoch)) return;
      if (create) {
        let id: string | undefined, rejected = false;
        try { id = await bounded(this.deps.create(job.openId, job.card!.content, job.card!.uuid), 8000); }
        catch (error) { rejected = error instanceof OutputApiRejection; }
        await this.lock(async () => { job.card!.id = id; job.card!.state = id ? 'known' : rejected ? 'unavailable' : 'uncertain'; job.displayPending = !!id; await this.save(); });
      } else if (job.card?.id && job.displayPending) {
        const revision = job.revision;
        await this.lock(async () => {
          const failures = job.display?.revision === revision ? job.display.failures : 0;
          // Persist a bounded presentation attempt before the external PATCH too.
          job.display = { revision, failures: failures + 1, after: Date.now() + Math.min(60_000, 2000 * 2 ** failures) };
          await this.save();
        });
        try {
          await bounded(this.deps.patch(job.card.id, content), 8000);
          await this.lock(async () => {
            if (revision === job.revision) { job.displayPending = false; job.display!.failures = 0; await this.save(); }
          });
        } catch { /* Presentation failure never retries the file send. */ }
      }
    })().catch(() => {}).finally(() => this.presentations.delete(job.id));
    this.presentations.set(job.id, work); return work;
  }
  private spool(job: OutputJob): string { return path.join(this.root, `${job.id}.bin`); }
  private async hasSpool(job: OutputJob, ref: Reference): Promise<boolean> {
    try {
      const stream = readOwnedFile(this.spool(job));
      const hash = createHash('sha256'); let size = 0;
      try { for await (const chunk of stream) { size += chunk.length; if (size > ref.reference.size) return false; hash.update(chunk); } }
      finally { stream.destroy(); }
      return size === ref.reference.size && hash.digest('hex') === ref.reference.sha256;
    } catch { return false; }
  }
  private async change(job: OutputJob, state: JobState): Promise<void> {
    await this.lock(async () => { job.state = state; job.revision++; job.updatedAt = Date.now(); job.displayPending = true; await this.save(); });
  }
  tick(): Promise<void> {
    if (this.currentTick) return this.currentTick;
    const work = this.tickNow().finally(() => { this.currentTick = undefined; });
    this.currentTick = work; return work;
  }
  private async tickNow(): Promise<void> {
    if (this.stopped || !this.healthy || this.ticking) return;
    this.ticking = true;
    try {
    if (Date.now() - this.cleanedAt > 60_000) {
      await this.lock(async () => { await this.cleanup(); await this.save(); this.cleanedAt = Date.now(); });
    }
    for (const ref of this.state.references) if (ref.reference.expiresAt > Date.now()) this.entry(ref);
    const activeDevices = new Set([...this.running.keys()].map(id => this.state.jobs.find(j => j.id === id)!.deviceId));
    for (const job of this.state.jobs) {
      const ref = this.state.references.find(r => r.reference.id === job.refId);
      if (!ref) continue;
      if (job.displayPending || !job.card) void this.present(job, ref);
      if (terminal.has(job.state) || job.state === 'failed' || this.running.has(job.id)) continue;
      if (ref.reference.expiresAt <= Date.now()) { await this.change(job, 'expired'); continue; }
      if (!await this.deps.owns(job.openId, job.deviceId, job.epoch)) { await this.change(job, 'revoked'); continue; }
      if (!['staged-verified', 'file-key-saved'].includes(job.state) && !this.deps.session(job.deviceId)) {
        if (job.state !== 'waiting-device') await this.change(job, 'waiting-device'); continue;
      }
      if (this.stopped) return;
      if (this.running.size >= 4 || activeDevices.has(job.deviceId)) continue;
      const operation = this.run(job, ref).catch(async () => {
        if (!this.stopped && !['delivered', 'send-uncertain', 'send-intent'].includes(job.state)) await this.change(job, 'failed').catch(() => {});
      }).finally(() => { this.running.delete(job.id); void this.present(job, ref); });
      this.running.set(job.id, operation); activeDevices.add(job.deviceId);
    }
      } finally { this.ticking = false; }
  }
  private async run(job: OutputJob, ref: Reference): Promise<void> {
    if (this.stopped) return;
    await this.present(job, ref);
    if (this.stopped) return;
    if (!['staged-verified', 'file-key-saved'].includes(job.state)) {
      const session = this.deps.session(job.deviceId);
      if (!session || session.openId !== job.openId) { await this.change(job, 'waiting-device'); return; }
      await this.lock(async () => {
        let diskBytes = 0;
        for (const name of await fs.readdir(this.root)) if (/^[a-f0-9]{64}\.(bin|tmp)$/.test(name)) {
          const stat = await fs.lstat(path.join(this.root, name));
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe output spool.');
          diskBytes += stat.size;
        }
        const recordedBytes = this.state.jobs.reduce((total, item) => total + (item.spoolBytes ?? 0), 0);
        const reservations = this.state.jobs.reduce((total, item) => total + (item.state === 'receiving'
          ? this.state.references.find(r => r.reference.id === item.refId)?.reference.size ?? 0 : 0), 0);
        const used = Math.max(diskBytes, recordedBytes) + reservations;
        if (used + ref.reference.size > OUTPUT_LIMITS.routerBytes) throw new Error('Output spool quota reached.');
        job.state = 'receiving'; job.received = 0; job.revision++; job.updatedAt = Date.now(); job.displayPending = true; await this.save();
      });
      const transferId = randomBytes(32).toString('hex');
      const grant: Grant = { token: randomBytes(32).toString('hex'), sessionId: session.id, expiresAt: Math.min(Date.now() + OUTPUT_LIMITS.transfer, ref.reference.expiresAt + ACTIVE_LEASE),
        job, abort: new AbortController(), receiving: false, revision: job.revision };
      this.grants.set(transferId, grant);
      try {
        this.deps.send(job.deviceId, { type: 'output_grant', id: job.refId, transferId, token: grant.token, expiresAt: grant.expiresAt });
        await new Promise<void>((resolve, reject) => {
          const poll = setInterval(() => {
            if (job.state === 'staged-verified') { clearInterval(poll); resolve(); }
            else if (grant.abort.signal.aborted || grant.expiresAt <= Date.now() || this.stopped) { clearInterval(poll); reject(new Error('Output transfer interrupted.')); }
          }, 50); poll.unref();
        });
      } catch (error) {
        if (grant.disconnected && !this.stopped) { await this.change(job, 'waiting-device'); return; }
        throw error;
      } finally { grant.abort.abort(); this.grants.delete(transferId); }
    }
    if (this.stopped || !await this.deps.owns(job.openId, job.deviceId, job.epoch)) { await this.change(job, 'revoked'); return; }
    if (!job.fileKey) {
      if (!await this.hasSpool(job, ref)) throw new Error('Output spool integrity failed.');
      await this.change(job, 'upload-intent');
      const key = await bounded(this.deps.upload(this.spool(job), ref.reference.name), OUTPUT_LIMITS.transfer);
      if (typeof key !== 'string' || !key || key.length > 512) throw new Error('Invalid file upload receipt.');
      await this.lock(async () => { job.fileKey = key; job.state = 'file-key-saved'; job.revision++; await this.save(); });
    }
    if (this.stopped || !await this.deps.owns(job.openId, job.deviceId, job.epoch)) { await this.change(job, 'revoked'); return; }
    await this.lock(async () => {
      job.send = { uuid: randomUUID(), content: JSON.stringify({ file_key: job.fileKey }), firstAt: Date.now() };
      job.state = 'send-intent'; job.revision++; await this.save();
    });
    let messageId: string | undefined, rejected = false;
    try { messageId = await bounded(this.deps.sendFile(job.openId, job.send!.content, job.send!.uuid)); }
    catch (error) { rejected = error instanceof OutputApiRejection; }
    await this.lock(async () => {
      if (typeof messageId === 'string' && messageId && messageId.length <= 512) { job.messageId = messageId; job.state = 'delivered'; }
      else job.state = rejected ? 'failed' : 'send-uncertain';
      job.revision++; job.updatedAt = Date.now(); job.displayPending = true; await this.save();
    });
    await fs.rm(this.spool(job), { force: true });
    await this.lock(async () => { job.spoolBytes = 0; await this.save(); });
  }
  async receive(ctx: Context, transferId: string): Promise<void> {
    const grant = this.grants.get(transferId), token = ctx.get('authorization').replace(/^Bearer /, '');
    if (!grant || !/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(grant.token))
      || grant.receiving || grant.expiresAt <= Date.now() || this.stopped) { ctx.status = 403; return; }
    const job = grant.job, ref = this.state.references.find(r => r.reference.id === job.refId)!;
    const current = () => this.deps.session(job.deviceId)?.id === grant.sessionId && !grant.abort.signal.aborted
      && this.grants.get(transferId) === grant && grant.revision === job.revision && job.state === 'receiving'
      && grant.expiresAt > Date.now();
    if (!current() || !await this.deps.owns(job.openId, job.deviceId, job.epoch)) { ctx.status = 403; return; }
    grant.receiving = true;
    const temporary = path.join(this.root, `${transferId}.tmp`);
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    let idle: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => grant.abort.abort(), Math.max(1, grant.expiresAt - Date.now())); timer.unref();
    let bytes = 0, lastProgress = 0; const hash = createHash('sha256');
    const meter = new Transform({ transform: (chunk: Buffer, _encoding, done) => {
      bytes += chunk.length;
      if (!current() || bytes > ref.reference.size) { done(new Error('Output transfer rejected.')); return; }
      hash.update(chunk); clearTimeout(idle); idle = setTimeout(() => grant.abort.abort(), OUTPUT_LIMITS.idle); idle.unref();
      job.received = bytes;
      if (Date.now() - lastProgress > 2000) { lastProgress = Date.now(); job.displayPending = true; void this.present(job, ref); }
      done(null, chunk);
    } });
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await pipeline(ctx.req, meter, new Writable({ write(chunk, _encoding, done) { handle!.writeFile(chunk).then(() => done(), done); } }), { signal: grant.abort.signal });
      if (bytes !== ref.reference.size || hash.digest('hex') !== ref.reference.sha256 || !current()
        || !await this.deps.owns(job.openId, job.deviceId, job.epoch)) throw new Error('Output integrity failed.');
      await handle.sync(); await handle.close(); handle = undefined;
      await fs.rename(temporary, this.spool(job)); await syncDirectory(this.root);
      if (!current()) throw new Error('Output connection changed.');
      await this.lock(async () => {
        if (!current()) throw new Error('Output transfer superseded.');
        job.spoolBytes = bytes; job.state = 'staged-verified'; job.revision++; job.updatedAt = Date.now(); job.displayPending = true; await this.save();
      }); ctx.status = 204;
    } catch { grant.abort.abort(); ctx.status = 400; }
    finally { clearTimeout(timer); clearTimeout(idle); await handle?.close(); this.storage.check(); await fs.rm(temporary, { force: true }); }
  }
  failed(deviceId: string, transferId: string): void {
    const grant = this.grants.get(transferId); if (grant?.job.deviceId === deviceId) grant.abort.abort();
  }
  disconnect(deviceId: string): void { for (const grant of this.grants.values()) if (grant.job.deviceId === deviceId) { grant.disconnected = true; grant.abort.abort(); } }
  private async cleanup(): Promise<void> {
    const now = Date.now();
    this.state.sources = this.state.sources.filter(s => s.expiresAt > now);
    this.state.jobs = this.state.jobs.filter(j => j.createdAt + 7 * OUTPUT_LIMITS.ttl > now);
    this.state.references = this.state.references.filter(r => r.reference.expiresAt > now
      || this.state.jobs.some(j => j.refId === r.reference.id && !terminal.has(j.state) && j.state !== 'failed'));
    for (const name of await fs.readdir(this.root)) {
      if (/^[a-f0-9]{64}\.tmp$/.test(name) && !this.grants.has(name.slice(0, 64))) await fs.rm(path.join(this.root, name), { force: true });
      if (/^[a-f0-9]{64}\.bin$/.test(name)) {
        const job = this.state.jobs.find(j => j.id === name.slice(0, 64));
        if (!job || (!this.running.has(job.id) && (terminal.has(job.state) || !this.state.references.some(r => r.reference.id === job.refId)))) {
          await fs.rm(path.join(this.root, name), { force: true }); if (job) job.spoolBytes = 0;
        }
      }
    }
  }
  async destroy(): Promise<void> {
    this.stopped = true; clearInterval(this.timer); for (const grant of this.grants.values()) grant.abort.abort();
    await this.currentTick;
    await Promise.allSettled([...this.running.values(), ...this.presentations.values(), ...this.entryWork.values(), ...this.noticeWork]); await this.serial;
  }
}
