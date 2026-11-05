import { supportsNativeCleanup } from '../native/NativeBindings';
import fs from 'fs/promises';
import path from 'path';
import { constants } from 'fs';
import { randomUUID, createHash } from 'crypto';
import { historyDirectory, historyIdentity, stableHistoryHash, validHistoryDirectory, validHistoryEntry,
  verifyHistoryDirectory, type HistoryEntry } from './NativeHistoryFiles';
import { openHistoryAnchor } from './HistoryAnchor';
import type { NativeDirectoryIdentity, NativeDeletionResult } from './NativeSessionDeletion';

/** Audited DSH 0.2.1-rc.2/rc.5 and deepseek-ai/deepseek-harness@fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159.
 * ACP exposes close/list/resume, not permanent deletion. The explicit plugin root
 * overrides are a storage capability contract, not an installed-version gate.
 */
export interface DshHistoryScope {
  version: 1;
  backend: 'dsh';
  nativeVersion: 'dsh-owned-jsonl-v1';
  executorThreadId: string;
  cwd: string;
  home: NativeDirectoryIdentity;
  scope: NativeDirectoryIdentity;
  history: NativeDirectoryIdentity;
}
export interface DshDeletionTarget extends DshHistoryScope {
  provenance: 'created';
  sessionId: string;
  pointerRoot: NativeDirectoryIdentity;
  pointer: string;
  pointerHash: string;
}
export interface DshDeletionPreparation {
  version: 1;
  nativeVersion: 'dsh-owned-jsonl-v1';
  targetHash: string;
  sessionIds: string[];
  files: HistoryEntry[];
}
/** The caller must first prove durable parent retirement, exclusive ownership and
 * exit of every writer. No deletion is authorized by a pointer or scope alone.
 */
export interface DshDeletionRecovery {
  /** Explicit creation receipts for every retired root sharing this private history scope. */
  ownedTargets?: DshDeletionTarget[];
  detachedPointer?: boolean;
  prepared?: DshDeletionPreparation;
  persistPrepared?: (value: DshDeletionPreparation) => Promise<void>;
}
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const LANE = /^delegate-lane-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const canonical = (s: unknown): s is string => typeof s === 'string' && path.isAbsolute(s)
  && path.normalize(s) === s && !s.includes('\0');
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const safeId = (value: unknown): value is string => typeof value === 'string' && ID.test(value) && !/[^A-Za-z0-9_-]/.test(value);
const inside = (root: string, file: string) => file.startsWith(root + path.sep);
export function validDshHistoryScope(value: any): value is DshHistoryScope {
  return !!value && value.version === 1 && value.backend === 'dsh' && value.nativeVersion === 'dsh-owned-jsonl-v1'
    && safeId(value.executorThreadId) && LANE.test(value.executorThreadId)
    && canonical(value.cwd) && [value.home, value.scope, value.history].every(validHistoryDirectory)
    && path.dirname(value.scope.path) === path.join(value.home.path, '.remote-cli', 'dsh-histories')
    && path.basename(value.scope.path).length === 36 && /^[0-9a-f-]{36}$/.test(path.basename(value.scope.path))
    && value.history.path === path.join(value.scope.path, 'history');
}
export function validDshDeletionTarget(value: any): value is DshDeletionTarget {
  if (!validDshHistoryScope(value)) return false;
  const target = value as DshDeletionTarget;
  return target.provenance === 'created' && safeId(target.sessionId)
    && validHistoryDirectory(target.pointerRoot) && target.pointerRoot.path === path.join(target.home.path, '.remote-cli', 'dsh-sessions')
    && target.pointer === path.join(target.pointerRoot.path, `${target.executorThreadId}.json`)
    && typeof target.pointerHash === 'string' && target.pointerHash.length === 64 && /^[a-f0-9]{64}$/.test(target.pointerHash);
}
function scopeRecord(value: DshHistoryScope): DshHistoryScope {
  return { version: 1, backend: 'dsh', nativeVersion: 'dsh-owned-jsonl-v1', executorThreadId: value.executorThreadId,
    cwd: value.cwd, home: value.home, scope: value.scope, history: value.history };
}
async function readStable(file: string, limit = 65536): Promise<Buffer> {
  const before = await historyIdentity(file, 'file');
  if (BigInt(before.size) > BigInt(limit)) throw new Error('DSH metadata limit exceeded');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat({ bigint: true });
    if (String(stat.dev) !== before.dev || String(stat.ino) !== before.ino) throw new Error('DSH metadata changed');
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > limit || stableHistoryHash(before) !== stableHistoryHash(await historyIdentity(file, 'file'))) throw new Error('DSH metadata changed');
    return buffer.subarray(0, size);
  } finally { await handle.close(); }
}
async function verifyScope(value: DshHistoryScope): Promise<void> {
  if (!validDshHistoryScope(value)) throw new Error('Invalid DSH history scope');
  for (const dir of [value.home, value.scope, value.history]) await verifyHistoryDirectory(dir);
  const marker = JSON.parse((await readStable(path.join(value.scope.path, 'owner.json'))).toString());
  if (stableHistoryHash(marker) !== stableHistoryHash(scopeRecord(value))) throw new Error('DSH scope ownership changed');
}
/** Allocate once before a managed native session is created; persist this scope
 * before launching. Reuse the same scope until that native context is retired.
 * Never attach this scope to an adopted or pre-existing native session.
 */
export async function createDshHistoryScope(home: string, executorThreadId: string, cwd: string): Promise<DshHistoryScope> {
  if (!canonical(home) || !canonical(cwd) || !safeId(executorThreadId) || !LANE.test(executorThreadId)) throw new Error('Invalid DSH scope allocation');
  const homeIdentity = await historyDirectory(home);
  let parent = home;
  for (const part of ['.remote-cli', 'dsh-histories']) {
    parent = path.join(parent, part);
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    await historyDirectory(parent);
  }
  const root = path.join(parent, randomUUID());
  await fs.mkdir(root, { mode: 0o700 });
  for (const part of ['history', 'retained']) await fs.mkdir(path.join(root, part), { mode: 0o700 });
  for (const part of ['sessions', 'query']) await fs.mkdir(path.join(root, 'history', part), { mode: 0o700 });
  const scope: DshHistoryScope = { version: 1, backend: 'dsh', nativeVersion: 'dsh-owned-jsonl-v1', executorThreadId, cwd,
    home: homeIdentity, scope: await historyDirectory(root), history: await historyDirectory(path.join(root, 'history')) };
  await fs.writeFile(path.join(root, 'owner.json'), JSON.stringify(scope), { flag: 'wx', mode: 0o600 });
  return scope;
}
/** Append to the privacy overlay. HOME, DSH_HOME, auth, profiles and tool HOME are
 * untouched. Retained storage/attachments are NEVER part of the deletion manifest.
 * The global file-upload index is not resumable history and is not erased.
 */
export async function dshHistoryPatch(scope: DshHistoryScope): Promise<string> {
  await verifyScope(scope);
  const rows = [
    { id: 'session-persistence-jsonl', config: { root: path.join(scope.history.path, 'sessions'), compression: 'none' } },
    { id: 'session-query-sqlite', config: { path: path.join(scope.history.path, 'query', 'index.sqlite') } },
    { id: 'storage-json', config: { root: path.join(scope.scope.path, 'retained', 'storage') } },
    { id: 'attachment-local', config: { dshHome: path.join(scope.scope.path, 'retained') } },
  ];
  // JSON scalars are valid YAML scalars, including quoted Windows paths.
  return rows.map(row => `- id: ${row.id}\n  config:\n${Object.entries(row.config)
    .map(([key, value]) => `    ${key}: ${JSON.stringify(value)}`).join('\n')}\n`).join('');
}
/** Call only after newSession, pointer persistence and native scope confirmation. */
export async function captureDshDeletionTarget(scope: DshHistoryScope, sessionId: string): Promise<DshDeletionTarget> {
  await verifyScope(scope);
  if (!safeId(sessionId)) throw new Error('Invalid DSH session identity');
  const pointerRoot = await historyDirectory(path.join(scope.home.path, '.remote-cli', 'dsh-sessions'));
  const pointer = path.join(pointerRoot.path, `${scope.executorThreadId}.json`);
  const bytes = await readStable(pointer);
  const value = JSON.parse(bytes.toString());
  if (value.id !== sessionId || value.cwd !== scope.cwd) throw new Error('DSH creation pointer mismatch');
  return { ...scopeRecord(scope), provenance: 'created', sessionId, pointerRoot, pointer, pointerHash: hash(bytes) };
}
async function verifyTarget(target: DshDeletionTarget, detached: boolean, ids: string[], ownedTargets: DshDeletionTarget[] = [target]): Promise<void> {
  if (!validDshDeletionTarget(target)) throw new Error('Invalid DSH target');
  await verifyScope(target);
  await verifyHistoryDirectory(target.pointerRoot);
  const before = await fs.stat(target.pointerRoot.path, { bigint: true });
  let own = false, count = 0;
  for await (const entry of await fs.opendir(target.pointerRoot.path)) {
    if (++count > 4096) throw new Error('DSH pointer inventory limit');
    // DshExecutor's handoff files are not continuation pointers.
    if (!entry.name.endsWith('.json') || entry.name.endsWith('.handoff.json')) continue;
    const file = path.join(target.pointerRoot.path, entry.name);
    const bytes = await readStable(file);
    const value = JSON.parse(bytes.toString());
    // DSH SessionId is an opaque branded string, not a UUID or filename. Its
    // persistence backend encodes it without normalization. A foreign valid
    // string must not block this scope merely because it is not our safe ID form.
    if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id.length) throw new Error('Ambiguous DSH pointer');
    if (file === target.pointer) {
      own = true;
      if (value.id === target.sessionId) {
        if (hash(bytes) !== target.pointerHash) throw new Error('DSH target pointer changed');
      } else if (!detached || ids.includes(value.id) && !ownedTargets.some(owned => owned.sessionId === value.id
        && owned.pointer === file && owned.pointerHash === hash(bytes) && value.adopted !== true)) throw new Error('DSH target pointer changed');
    } else if (ids.includes(value.id)) throw new Error('DSH native identity is shared');
  }
  const after = await fs.stat(target.pointerRoot.path, { bigint: true });
  if ((!own && !detached) || before.ino !== after.ino || before.dev !== after.dev || before.mtimeNs !== after.mtimeNs) throw new Error('DSH pointer inventory changed');
  await verifyHistoryDirectory(target.pointerRoot);
}
async function collect(file: string, files: HistoryEntry[], depth = 0): Promise<void> {
  if (files.length >= 1024 || depth > 16) throw new Error('DSH history inventory limit');
  const stat = await fs.lstat(file);
  const entry = await historyIdentity(file, stat.isDirectory() ? 'directory' : 'file');
  files.push(entry);
  if (entry.kind === 'directory') {
    for (const name of await fs.readdir(file)) await collect(path.join(file, name), files, depth + 1);
    const after = await historyIdentity(file, 'directory');
    if (stableHistoryHash(entry) !== stableHistoryHash(after)) throw new Error('DSH directory changed');
  }
}
export function validDshDeletionPreparation(target: DshDeletionTarget, value: any): value is DshDeletionPreparation {
  return validDshDeletionTarget(target) && !!value && value.version === 1 && value.nativeVersion === target.nativeVersion
    && value.targetHash === stableHistoryHash(target) && Array.isArray(value.sessionIds) && value.sessionIds.length > 0
    && value.sessionIds.length <= 1024 && value.sessionIds.includes(target.sessionId) && value.sessionIds.every(safeId)
    && new Set(value.sessionIds).size === value.sessionIds.length && Array.isArray(value.files) && value.files.length <= 1024
    && value.files.length > 0 && new Set(value.files.map((f: HistoryEntry) => f.path)).size === value.files.length
    && value.files.every((f: HistoryEntry) => validHistoryEntry(f) && inside(target.history.path, f.path)
      && ['sessions', 'query'].includes(path.relative(target.history.path, f.path).split(path.sep)[0]));
}
async function prepare(target: DshDeletionTarget, ownedTargets: DshDeletionTarget[]): Promise<DshDeletionPreparation> {
  const roots = new Set(ownedTargets.map(value => value.sessionId));
  const files: HistoryEntry[] = [];
  for (const name of await fs.readdir(target.history.path)) {
    if (!['sessions', 'query'].includes(name)) throw new Error('Unknown DSH history layout');
    await collect(path.join(target.history.path, name), files);
  }
  const parents = new Map<string, string | undefined>();
  const transcriptDirectories = new Set<string>();
  const lockDirectories = new Set<string>();
  for (const file of files.filter(f => f.kind === 'file')) {
    const rel = path.relative(target.history.path, file.path).split(path.sep);
    if (/[\r\n]/.test(path.basename(file.path))) throw new Error('Unknown DSH history filename');
    if (rel[0] === 'query') {
      if (rel.length !== 2 || !/^index\.sqlite(?:-wal|-shm|-journal)?$/.test(rel[1])) throw new Error('Unknown DSH search layout');
      continue;
    }
    if (rel.length !== 4) throw new Error('Unknown DSH session layout');
    // DSH's POSIX kernel-lock inode survives handle.close(). It is NOT exit
    // evidence; the caller must already hold managed process-group exit proof.
    if (path.basename(file.path) === 'session.lock' && file.size === '0') {
      lockDirectories.add(path.dirname(file.path));
      continue;
    }
    if (!/^session(?:\.v[1-9][0-9]*)?\.jsonl$/.test(path.basename(file.path))) throw new Error('Unknown DSH session artifact');
    const handle = await fs.open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let header: any;
    try {
      const stat = await handle.stat({ bigint: true });
      if (String(stat.ino) !== file.ino || String(stat.dev) !== file.dev) throw new Error('DSH transcript changed');
      const buffer = Buffer.alloc(65536);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const first = buffer.subarray(0, bytesRead).toString().split('\n')[0];
      if (Buffer.byteLength(first) >= buffer.length) throw new Error('DSH header limit');
      header = JSON.parse(first);
    } finally { await handle.close(); }
    if (!header || header.type !== 'session' || !Number.isSafeInteger(header.version) || header.version < 1
      || !safeId(header.id) || path.basename(path.dirname(file.path)) !== header.id
      || typeof header.isSeeded !== 'boolean' || !Number.isSafeInteger(header.createdAt)
      || header.createdAt < 0 || !Number.isSafeInteger(header.delegationDepth) || header.delegationDepth < 0
      || (roots.has(header.id) ? header.isSeeded || header.cwd !== target.cwd || header.parentSession !== undefined || header.origin !== undefined
        : header.origin !== 'subagent' || !safeId(header.parentSession))) throw new Error('DSH session ownership is ambiguous');
    if (parents.has(header.id) && parents.get(header.id) !== header.parentSession) throw new Error('DSH conflicting session generations');
    parents.set(header.id, header.parentSession);
    transcriptDirectories.add(path.dirname(file.path));
  }
  if ([...lockDirectories].some(dir => !transcriptDirectories.has(dir))) throw new Error('DSH lock has no confirmed history');
  if (!parents.has(target.sessionId)) throw new Error('DSH root transcript is missing');
  for (const id of parents.keys()) {
    let current: string | undefined = id;
    const seen = new Set<string>();
    while (!roots.has(current!)) {
      if (!current || seen.has(current) || !parents.has(current)) throw new Error('DSH foreign or cyclic history');
      seen.add(current); current = parents.get(current);
    }
  }
  return { version: 1, nativeVersion: target.nativeVersion, targetHash: stableHistoryHash(target), sessionIds: [...parents.keys()].sort(), files };
}
export async function deleteOwnedDshSession(target: DshDeletionTarget, recovery: DshDeletionRecovery): Promise<NativeDeletionResult> {
  let deleting = false;
  try {
    if (!supportsNativeCleanup()) return { state: 'unsupported', reason: 'DSH anchored deletion requires Linux writer proof' };
    const ownedTargets = recovery.ownedTargets ?? [target];
    if (!ownedTargets.length || ownedTargets.length > 64 || !ownedTargets.some(value => stableHistoryHash(value) === stableHistoryHash(target))
      || ownedTargets.some(value => !validDshDeletionTarget(value) || stableHistoryHash(scopeRecord(value)) !== stableHistoryHash(scopeRecord(target)))) {
      throw new Error('DSH root ownership scope changed');
    }
    await verifyTarget(target, recovery.detachedPointer === true, recovery.prepared?.sessionIds ?? ownedTargets.map(value => value.sessionId), ownedTargets);
    let prepared = recovery.prepared;
    if (prepared && !validDshDeletionPreparation(target, prepared)) throw new Error('DSH preparation changed');
    if (!prepared) {
      if (!recovery.persistPrepared) throw new Error('Durable DSH preparation is required');
      prepared = await prepare(target, ownedTargets);
      await verifyTarget(target, recovery.detachedPointer === true, prepared.sessionIds, ownedTargets);
      await recovery.persistPrepared(prepared);
    }
    if (!validDshDeletionPreparation(target, prepared)) throw new Error('DSH preparation changed');
    await verifyTarget(target, recovery.detachedPointer === true, prepared.sessionIds, ownedTargets);
    const anchor = await openHistoryAnchor(target.history, prepared.files);
    try {
      deleting = true;
      for (const entry of [...prepared.files].sort((a, b) => b.path.length - a.path.length)) await anchor.remove(entry);
      await verifyTarget(target, recovery.detachedPointer === true, prepared.sessionIds, ownedTargets);
      if ((await fs.readdir(target.history.path)).length) throw new Error('DSH history remains');
      return { state: 'deleted', reason: 'Owned DSH resumable history and private search index were removed; retained artifacts were preserved' };
    } finally { await anchor.close(); }
  } catch {
    return { state: deleting ? 'uncertain' : 'held', reason: 'DSH scope, pointer, layout or immutable preparation could not be verified' };
  }
}
