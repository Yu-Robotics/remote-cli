import path from 'path';
import type { SnapshotContext, VerifiedOutputExport } from './OutputSnapshots';
import { OutputReference, validReference } from './Protocol';

interface WorkerOrigin {
  owner: string; messageId: string; threadId: string; taskId: string; generation: number;
  cwd: string; file: string; version: string;
}
export interface Publication { version: 1; visible: boolean; worker?: WorkerOrigin }
export interface SnapshotRecord {
  reference: OutputReference; identity: string; snapshotIdentity: string; publication?: Publication;
}
const bounded = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const absolute = (value: unknown): value is string => bounded(value, 4096) && path.isAbsolute(value) && path.resolve(value) === value;

/** A wire reference is an explicit projection, never a serialized private receipt. */
export function publicReference(value: OutputReference): OutputReference {
  return { id: value.id, messageId: value.messageId, threadId: value.threadId, taskId: value.taskId,
    generation: value.generation, name: value.name, source: value.source, size: value.size, sha256: value.sha256,
    expiresAt: value.expiresAt, ...(value.discoveryIncomplete === undefined ? {} : { discoveryIncomplete: value.discoveryIncomplete }) };
}
export function validSnapshotRecord(value: any): value is SnapshotRecord {
  if (!value || !validReference(value.reference) || !bounded(value.identity, 256) || !bounded(value.snapshotIdentity, 256)) return false;
  // Old receipts may already have live cards; absence is not inferred to mean hidden.
  if (!Object.prototype.hasOwnProperty.call(value, 'publication')) return true;
  const publication = value.publication;
  if (!publication || publication.version !== 1 || typeof publication.visible !== 'boolean') return false;
  if (publication.worker === undefined) return publication.visible && value.reference.source !== 'worker';
  const worker = publication.worker;
  return !!worker && typeof worker.owner === 'string' && worker.owner.length <= 200 && (!!worker.owner || !publication.visible)
    && ['worker', 'export'].includes(value.reference.source)
    && bounded(worker.messageId, 200) && bounded(worker.taskId, 200) && bounded(worker.threadId, 200)
    && Number.isSafeInteger(worker.generation) && worker.generation >= 0
    && absolute(worker.cwd) && absolute(worker.file) && bounded(worker.version, 256)
    && worker.taskId === value.reference.taskId && worker.threadId === value.reference.threadId
    && worker.generation === value.reference.generation
    && (publication.visible || worker.messageId === value.reference.messageId);
}
export const visibleRecord = (record: SnapshotRecord): boolean => record.publication?.visible !== false;

export function publicationFor(context: SnapshotContext, cwd: string, file: string, version: string): Publication {
  if (context.source !== 'worker') return { version: 1, visible: true };
  if ((context.owner !== undefined && (typeof context.owner !== 'string' || context.owner.length > 200))
    || !absolute(cwd) || !absolute(file)) throw new Error('Invalid worker output origin.');
  return { version: 1, visible: false, worker: { owner: context.owner ?? '', messageId: context.messageId,
    threadId: context.threadId, taskId: context.taskId, generation: context.generation, cwd, file, version } };
}

export function duplicateWorker(record: SnapshotRecord, publication: Publication): boolean {
  const old = record.publication?.worker, next = publication.worker;
  return !!old && !!next && old.owner === next.owner && old.messageId === next.messageId && old.threadId === next.threadId
    && old.generation === next.generation && old.taskId === next.taskId && old.file === next.file && old.version === next.version;
}

/** Paths select only receipts in an authorized task scope; they never authorize a new read. */
export function selectedWorker(records: Iterable<SnapshotRecord>, filename: string, context: SnapshotContext,
  exported?: VerifiedOutputExport): SnapshotRecord | undefined {
  const matches = [...records].filter(record => {
    const worker = record.publication?.worker;
    if (!worker || !worker.owner || worker.owner !== context.owner || worker.threadId !== context.threadId
      || record.reference.expiresAt <= Date.now()) return false;
    if (!exported) return worker.generation === context.generation && worker.messageId === context.messageId && worker.file === filename;
    return exported.file === filename && exported.taskId === worker.taskId && exported.bytes === record.reference.size
      && exported.sha256 === record.reference.sha256 && typeof exported.path === 'string' && !path.isAbsolute(exported.path)
      && path.resolve(worker.cwd, exported.path) === worker.file
      && path.relative(worker.cwd, worker.file) !== '' && !path.isAbsolute(path.relative(worker.cwd, worker.file))
      && path.relative(worker.cwd, worker.file).split(path.sep).every(part => part !== '..');
  });
  if (matches.length > 1) throw new Error('Worker output selection is ambiguous.');
  return matches[0];
}
