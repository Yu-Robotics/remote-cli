import { supportsNativeCleanup } from '../native/NativeBindings';
import fs from 'fs/promises';
import { constants } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { openHistoryAnchor } from './HistoryAnchor';
import type { NativeDirectoryIdentity, NativeDeletionPreparation, NativeDeletionRecovery, NativeDeletionResult } from './NativeSessionDeletion';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
interface OwnedHistoryBase {
  version: 1;
  provenance: 'created';
  sessionId: string;
  executorThreadId: string;
  home: NativeDirectoryIdentity;
  nativeHome: NativeDirectoryIdentity;
  scope: NativeDirectoryIdentity;
  pointerRoot: NativeDirectoryIdentity;
  pointer: string;
  pointerHash: string;
  /** A newly created Pi fork can be observed after the active pointer moved again. */
  pointerSessionId?: string;
  cwd: string;
  command: string;
  /** Present only when the native writer had already materialized the file. */
  createdFile?: HistoryEntry;
  projectOverride?: string;
  /** Claude system/init matched the reserved ID and cwd. */
  confirmed?: boolean;
}
// The old package-version strings are immutable legacy receipt markers, never
// requirements on the installed executable. Do not normalize persisted targets:
// their complete serialized identity is covered by existing preparation hashes.
const HISTORY_CONTRACTS = {
  kimi: ['kimi-acp-delete-v1', '2.3.3'],
  pi: ['pi-jsonl-v3', '1.5.0'],
  claude: ['claude-history-v1', '2.1.308'],
} as const;
export type KimiHistoryTarget = OwnedHistoryBase & { backend: 'kimi'; nativeVersion: typeof HISTORY_CONTRACTS.kimi[number]; transcript?: never };
/**
 * Pi session-manager.ts at earendil-works/pi@676af1d777ef6f04b6bc8daf4cf3b9b1799cff4d.
 * Compatibility uses the v3 JSONL header, not the installed package version.
 */
export type PiHistoryTarget = OwnedHistoryBase & { backend: 'pi'; nativeVersion: typeof HISTORY_CONTRACTS.pi[number]; transcript: string };
export type ClaudeHistoryTarget = OwnedHistoryBase & { backend: 'claude'; nativeVersion: typeof HISTORY_CONTRACTS.claude[number]; transcript: string };
export type OwnedHistoryTarget = KimiHistoryTarget | PiHistoryTarget | ClaudeHistoryTarget;
export interface HistoryEntry extends NativeDirectoryIdentity {
  kind: 'file' | 'directory';
  size: string;
  mtime: string;
}
const absolute = (value: unknown): value is string => typeof value === 'string' && path.isAbsolute(value)
  && !value.includes('\0') && path.normalize(value) === value;
export const validHistoryDirectory = (value: any): value is NativeDirectoryIdentity => !!value && absolute(value.path)
  && typeof value.dev === 'string' && /^\d+$/.test(value.dev) && typeof value.ino === 'string' && /^[1-9]\d*$/.test(value.ino);
export function validOwnedHistoryTarget(value: any): value is OwnedHistoryTarget {
  return !!value && value.version === 1 && value.provenance === 'created'
    && ['kimi', 'pi', 'claude'].includes(value.backend)
    && (HISTORY_CONTRACTS as Record<string, readonly string[]>)[value.backend].includes(value.nativeVersion)
    && typeof value.sessionId === 'string' && UUID.test(value.sessionId)
    && typeof value.executorThreadId === 'string' && value.executorThreadId.startsWith('delegate-lane-')
    && UUID.test(value.executorThreadId.slice(14))
    && [value.home, value.nativeHome, value.scope, value.pointerRoot].every(validHistoryDirectory)
    && (value.backend === 'claude' || value.scope.path === value.nativeHome.path)
    && absolute(value.pointer) && path.dirname(value.pointer) === value.pointerRoot.path
    && path.basename(value.pointer) === `${value.executorThreadId}.json`
    && typeof value.pointerHash === 'string' && HASH.test(value.pointerHash) && absolute(value.cwd)
    && (value.pointerSessionId === undefined || value.backend === 'pi' && typeof value.pointerSessionId === 'string' && UUID.test(value.pointerSessionId))
    && typeof value.command === 'string' && value.command.length > 0 && value.command.length < 4096 && !value.command.includes('\0')
    && (value.projectOverride === undefined || value.backend === 'claude' && typeof value.projectOverride === 'string' && validClaudeProjectOverride(value.projectOverride))
    && (value.confirmed === undefined || value.backend === 'claude' && typeof value.confirmed === 'boolean')
    && (value.createdFile === undefined || validHistoryEntry(value.createdFile) && value.createdFile.kind === 'file'
      && value.createdFile.path === value.transcript)
    && (value.backend === 'kimi' ? value.transcript === undefined : absolute(value.transcript)
      && path.dirname(value.transcript) === value.scope.path
      && (value.backend === 'claude' ? path.basename(value.transcript) === `${value.sessionId}.jsonl`
        : /^\d{4}-\d\d-\d\dT[\d-]+Z_/.test(path.basename(value.transcript))
          && path.basename(value.transcript).endsWith(`_${value.sessionId}.jsonl`)));
}
export function validHistoryEntry(value: any): value is HistoryEntry {
  return !!value && ['file', 'directory'].includes(value.kind)
    && typeof value.size === 'string' && /^\d+$/.test(value.size)
    && typeof value.mtime === 'string' && /^\d+$/.test(value.mtime) && validHistoryDirectory(value);
}
export function stableHistoryHash(value: unknown): string {
  const canonical = (item: any): any => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])])) : item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function validClaudeProjectOverride(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(value) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(value);
}
/** CLI 2.1.308 qH/Hue, also SDK 0.2.141 M0/SH. Do not use catalog/worktree search. */
export function claudeProjectName(cwd: string): string {
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (encoded.length <= 200) return encoded;
  let hash = 0;
  for (let index = 0; index < cwd.length; index++) hash = ((hash << 5) - hash + cwd.charCodeAt(index)) | 0;
  return `${encoded.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}
export async function historyIdentity(file: string, kind: HistoryEntry['kind']): Promise<HistoryEntry> {
  if (!absolute(file) || await fs.realpath(file) !== file) throw new Error('Native path is redirected');
  const stat = await fs.lstat(file, { bigint: true });
  if (kind === 'file' ? !stat.isFile() || stat.nlink !== 1n : !stat.isDirectory()) throw new Error('Native path type or links changed');
  if (!stat.ino || process.getuid && stat.uid !== BigInt(process.getuid())) throw new Error('Native path ownership is unavailable');
  return { path: file, dev: String(stat.dev), ino: String(stat.ino), kind, size: String(stat.size), mtime: String(stat.mtimeNs) };
}
export async function historyDirectory(directory: string): Promise<NativeDirectoryIdentity> {
  const value = await historyIdentity(directory, 'directory');
  return { path: value.path, dev: value.dev, ino: value.ino };
}
export async function verifyHistoryDirectory(value: NativeDirectoryIdentity): Promise<void> {
  if (JSON.stringify(await historyDirectory(value.path)) !== JSON.stringify({ path: value.path, dev: value.dev, ino: value.ino })) {
    throw new Error('Native root identity changed');
  }
}
async function maybeEntry(file: string, kind: HistoryEntry['kind']): Promise<HistoryEntry | undefined> {
  // realpath also reports ENOENT for dangling links; only a missing lstat is absence.
  try { await fs.lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  return historyIdentity(file, kind);
}
/** Bounded metadata reads, never a full transcript read. */
async function prefix(file: string): Promise<string> {
  const before = await historyIdentity(file, 'file');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat({ bigint: true });
    if (String(stat.dev) !== before.dev || String(stat.ino) !== before.ino) throw new Error('Native file changed');
    const bytes = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return bytes.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}
async function pointerBytes(file: string): Promise<string> {
  const before = await historyIdentity(file, 'file');
  if (BigInt(before.size) > 65536n) throw new Error('Native pointer metadata is too large');
  const bytes = await prefix(file);
  const after = await historyIdentity(file, 'file');
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Native pointer changed during observation');
  return bytes;
}
export async function captureHistoryTarget(input: {
  backend: OwnedHistoryTarget['backend']; sessionId: string; executorThreadId: string; home: string;
  nativeHome: string; scope: string; pointer: string; cwd: string; command: string;
  transcript?: string; projectOverride?: string;
  pointerSessionId?: string;
}): Promise<OwnedHistoryTarget> {
  const target = { ...input, version: 1, provenance: 'created',
    nativeVersion: HISTORY_CONTRACTS[input.backend][0],
    home: await historyDirectory(input.home), nativeHome: await historyDirectory(input.nativeHome),
    scope: await historyDirectory(input.scope), pointerRoot: await historyDirectory(path.dirname(input.pointer)), pointerHash: '' } as OwnedHistoryTarget;
  const pointer = await pointerBytes(target.pointer);
  if (JSON.parse(pointer).id !== (target.pointerSessionId ?? target.sessionId) || JSON.parse(pointer).adopted) throw new Error('Native pointer is not newly owned');
  target.pointerHash = createHash('sha256').update(pointer).digest('hex');
  if (target.transcript) target.createdFile = await maybeEntry(target.transcript, 'file');
  if (!validOwnedHistoryTarget(target)) throw new Error('Invalid native creation receipt');
  if (target.createdFile) await verifyTranscript(target);
  return target;
}
async function referencesTranscript(pointer: any, target: OwnedHistoryTarget): Promise<boolean> {
  if (!target.transcript || pointer.sessionFile === undefined) return false;
  if (typeof pointer.sessionFile !== 'string' || pointer.sessionFile.includes('\0')) throw new Error('Invalid native file reference');
  const cwd = absolute(pointer.cwd) ? pointer.cwd : target.cwd;
  // Preserve symlink/.. resolution for realpath; lexical normalization alone is insufficient.
  const reference = path.isAbsolute(pointer.sessionFile) ? pointer.sessionFile : cwd + path.sep + pointer.sessionFile;
  if (path.resolve(reference) === target.transcript) return true;
  try { return await fs.realpath(reference) === target.transcript; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Resolve directory aliases even after a prepared transcript unlink.
    try { return path.join(await fs.realpath(path.dirname(reference)), path.basename(reference)) === target.transcript; }
    catch (missing) { if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return false; throw missing; }
  }
}
export async function verifyHistoryTarget(target: OwnedHistoryTarget, detached = false): Promise<void> {
  if (!validOwnedHistoryTarget(target)) throw new Error('Invalid native creation receipt');
  for (const root of [target.home, target.nativeHome, target.scope, target.pointerRoot]) await verifyHistoryDirectory(root);
  if (target.backend === 'claude' && target.scope.path !== path.join(target.nativeHome.path, 'projects',
    target.projectOverride ?? claudeProjectName(target.cwd))) throw new Error('Claude project identity changed');
  let found = false;
  const entries = await fs.readdir(target.pointerRoot.path);
  if (entries.length > 4096) throw new Error('Native pointer inventory is too large');
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(target.pointerRoot.path, name);
    const bytes = await pointerBytes(file);
    const pointer = JSON.parse(bytes);
    if (!pointer || typeof pointer.id !== 'string') throw new Error('Ambiguous native pointer');
    const referencesFile = await referencesTranscript(pointer, target);
    if (file !== target.pointer && (pointer.id === target.sessionId || referencesFile)) {
      throw new Error('Another pointer references native history');
    }
    if (file === target.pointer) {
      found = true;
      if (detached && pointer.id !== target.sessionId && UUID.test(pointer.id)) {
        if (referencesFile) throw new Error('Replacement pointer still references native history');
        continue;
      }
      if (pointer.adopted || pointer.id !== (target.pointerSessionId ?? target.sessionId)
        || createHash('sha256').update(bytes).digest('hex') !== target.pointerHash) throw new Error('Native pointer identity changed');
    }
  }
  if (!found && !detached) throw new Error('Native pointer is missing');
  if (target.backend === 'pi') {
    const files = await fs.readdir(target.scope.path);
    if (files.length > 4096) throw new Error('Pi native inventory is too large');
    for (const name of files) {
      const file = path.join(target.scope.path, name);
      if (!name.endsWith('.jsonl') || file === target.transcript) continue;
      const header = JSON.parse((await prefix(file)).split('\n')[0]);
      if (header.id === target.sessionId) throw new Error('Duplicate Pi native identity');
    }
  }
}
/** Pi 1.5.0 writes only the session header before append-only entries; return no turns. */
export async function piHistoryHeaders(root: string): Promise<Array<{ id: string; cwd: string; file: string }>> {
  const names = await fs.readdir(root);
  if (names.length > 4096) throw new Error('Pi native inventory is too large');
  const headers = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(root, name);
    const header = JSON.parse((await prefix(file)).split('\n')[0]);
    if (header.type !== 'session' || header.version !== 3 || typeof header.id !== 'string' || !UUID.test(header.id)
      || !absolute(header.cwd)) throw new Error('Invalid Pi native header');
    headers.push({ id: header.id, cwd: header.cwd, file });
  }
  return headers;
}
async function verifyTranscript(target: OwnedHistoryTarget): Promise<void> {
  const bytes = await prefix(target.transcript!);
  if (target.backend === 'claude' && target.confirmed && bytes.length === 0) return;
  const lines = bytes.split('\n');
  if (!bytes.endsWith('\n')) lines.pop();
  if (target.backend === 'pi') {
    const header = JSON.parse(lines[0]);
    if (header.type !== 'session' || header.version !== 3 || header.id !== target.sessionId || header.cwd !== target.cwd
      || typeof header.timestamp !== 'string') throw new Error('Pi session header changed');
  } else {
    const records = lines.filter(Boolean).map(line => JSON.parse(line));
    // Package versions are diagnostic metadata. The supported layout is JSONL
    // with native message records carrying this exact session and cwd identity.
    if (records.some(record => !record || typeof record !== 'object' || Array.isArray(record))
      || !records.some(record => ['user', 'assistant'].includes(record.type)
        && record.sessionId === target.sessionId && record.cwd === target.cwd
        && record.message && typeof record.message === 'object' && !Array.isArray(record.message)
        && (typeof record.message.content === 'string' || Array.isArray(record.message.content)))
      || records.some(record => record.sessionId && record.sessionId !== target.sessionId)) throw new Error('Claude transcript identity is unconfirmed');
  }
}
export function historyEntryInScope(target: OwnedHistoryTarget, entry: HistoryEntry): boolean {
  if (entry.path === target.transcript) return entry.kind === 'file';
  const directory = path.join(target.scope.path, target.sessionId);
  return target.backend === 'claude' && (entry.path === directory || entry.path.startsWith(directory + path.sep));
}
export function validHistoryPreparation(target: OwnedHistoryTarget, value: NativeDeletionPreparation): boolean {
  return value.version === 1 && value.nativeVersion === target.nativeVersion && value.targetHash === stableHistoryHash(target)
    && Array.isArray(value.files) && value.files.length <= 256
    && value.files.some(entry => entry?.path === target.transcript && entry.kind === 'file')
    && value.files.every(entry => validHistoryEntry(entry) && historyEntryInScope(target, entry))
    && new Set(value.files.map(entry => entry.path)).size === value.files.length;
}
async function collect(file: string, entries: HistoryEntry[]): Promise<void> {
  const stat = await fs.lstat(file);
  const entry = await historyIdentity(file, stat.isDirectory() ? 'directory' : 'file');
  entries.push(entry);
  if (entries.length > 256) throw new Error('Native deletion manifest exceeds its limit');
  if (entry.kind === 'directory') for (const name of await fs.readdir(file)) await collect(path.join(file, name), entries);
}
/** Exact-file deletion only. The lane store supplies authorization and writer-exit proof. */
export async function deleteOwnedHistoryFiles(target: OwnedHistoryTarget, recovery: NativeDeletionRecovery): Promise<NativeDeletionResult> {
  let deleting = false;
  try {
    if (!supportsNativeCleanup() || target.backend === 'kimi') return { state: 'unsupported', reason: 'Native writer exit or file layout is unsupported' };
    await verifyHistoryTarget(target, recovery.detachedPointer);
    if (target.backend === 'claude' && !target.confirmed) throw new Error('Claude native initialization was not confirmed');
    let prepared = recovery.prepared;
    if (prepared && !validHistoryPreparation(target, prepared)) throw new Error('Native preparation changed');
    if (!prepared) {
      if (!recovery.persistPrepared) throw new Error('Durable native preparation is required');
      await verifyTranscript(target);
      const files: HistoryEntry[] = [];
      await collect(target.transcript!, files);
      if (target.createdFile && (target.createdFile.dev !== files[0].dev || target.createdFile.ino !== files[0].ino)) throw new Error('Native transcript replaced');
      if (target.backend === 'claude') {
        const sibling = path.join(target.scope.path, target.sessionId);
        if (await maybeEntry(sibling, 'directory')) await collect(sibling, files);
      }
      prepared = { version: 1, nativeVersion: target.nativeVersion, targetHash: stableHistoryHash(target), files };
      await recovery.persistPrepared(prepared);
    }
    await verifyHistoryTarget(target, recovery.detachedPointer);
    const anchor = await openHistoryAnchor(target.scope, prepared.files!);
    try {
      deleting = true;
      for (const entry of [...prepared.files!].sort((a, b) => b.path.length - a.path.length)) await anchor.remove(entry);
      // A moved scope must not turn successful descriptor operations into pathname success.
      await verifyHistoryTarget(target, recovery.detachedPointer);
      if (await anchor.exists(target.transcript!) || target.backend === 'claude'
        && await anchor.exists(path.join(target.scope.path, target.sessionId))) throw new Error('Native history remains');
      return { state: 'deleted', reason: 'Exact owned native history was permanently removed' };
    } finally { await anchor.close(); }
  } catch {
    return { state: deleting ? 'uncertain' : 'held', reason: 'Native history identity or durable deletion could not be confirmed' };
  }
}
