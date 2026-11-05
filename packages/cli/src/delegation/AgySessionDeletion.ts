import { supportsNativeCleanup } from '../native/NativeBindings';
import fs from 'fs/promises';
import { constants } from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { openHistoryAnchor } from './HistoryAnchor';
import { historyDirectory, historyIdentity, stableHistoryHash, validHistoryDirectory,
  validHistoryEntry, verifyHistoryDirectory, type HistoryEntry } from './NativeHistoryFiles';
import type { NativeDirectoryIdentity, NativeDeletionResult } from './NativeSessionDeletion';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const CONTRACT = 'agy-owned-sqlite-v1';
const LIMIT = 4096;
const SUFFIXES = ['', '-wal', '-shm', '-journal'];

/** Creation observation, never an imported/resumed pointer alone. */
export interface AgyDeletionTarget {
  version: 1;
  backend: 'agy';
  provenance: 'created';
  nativeVersion: typeof CONTRACT;
  sessionId: string;
  executorThreadId: string;
  home: NativeDirectoryIdentity;
  nativeHome: NativeDirectoryIdentity;
  scope: NativeDirectoryIdentity;
  pointerRoot: NativeDirectoryIdentity;
  pointer: string;
  pointerHash: string;
  createdFile: HistoryEntry;
  cwd: string;
  command: string;
}

export interface AgyDeletionPreparation {
  version: 1;
  nativeVersion: typeof CONTRACT;
  targetHash: string;
  files: HistoryEntry[];
}

export interface AgyDeletionRecovery {
  /** Caller must independently authorize the parent's retired generation. */
  confirmedProcessGroupExit: boolean;
  /** Exact retired creation receipts sharing this native namespace. */
  ownedTargets?: AgyDeletionTarget[];
  detachedPointer?: boolean;
  prepared?: AgyDeletionPreparation;
  persistPrepared?: (preparation: AgyDeletionPreparation) => Promise<void>;
}

const absolute = (value: unknown): value is string => typeof value === 'string'
  && path.isAbsolute(value) && path.normalize(value) === value && !value.includes('\0');
const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');

export function validAgyDeletionTarget(value: any): value is AgyDeletionTarget {
  return !!value && value.version === 1 && value.backend === 'agy' && value.provenance === 'created'
    && value.nativeVersion === CONTRACT && typeof value.sessionId === 'string' && UUID.test(value.sessionId)
    && typeof value.executorThreadId === 'string' && value.executorThreadId.startsWith('delegate-lane-')
    && UUID.test(value.executorThreadId.slice(14))
    && [value.home, value.nativeHome, value.scope, value.pointerRoot].every(validHistoryDirectory)
    && value.nativeHome.path === path.join(value.home.path, '.remote-cli', 'agy-homes', value.executorThreadId)
    && value.scope.path === path.join(value.nativeHome.path, '.gemini', 'antigravity-cli')
    && value.pointerRoot.path === path.join(value.home.path, '.remote-cli', 'agy-sessions')
    && value.pointer === path.join(value.pointerRoot.path, `${value.executorThreadId}.json`)
    && typeof value.pointerHash === 'string' && /^[a-f0-9]{64}$/.test(value.pointerHash)
    && validHistoryEntry(value.createdFile) && value.createdFile.kind === 'file'
    && value.createdFile.path === path.join(value.scope.path, 'conversations', `${value.sessionId}.db`)
    && absolute(value.cwd) && typeof value.command === 'string' && value.command.length > 0
    && value.command.length < 4096 && !value.command.includes('\0');
}

/** Read a bounded regular file through a checked descriptor, rejecting swaps and links. */
async function bytes(file: string, limit: number): Promise<Buffer> {
  const before = await historyIdentity(file, 'file');
  if (BigInt(before.size) > BigInt(limit)) throw new Error('AGY metadata exceeds the inspection limit');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat({ bigint: true });
    if (String(stat.dev) !== before.dev || String(stat.ino) !== before.ino) throw new Error('AGY metadata changed');
    const buffer = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < buffer.length) {
      const read = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!read.bytesRead) throw new Error('AGY metadata was truncated');
      offset += read.bytesRead;
    }
    if (stableHistoryHash(await historyIdentity(file, 'file')) !== stableHistoryHash(before)) throw new Error('AGY metadata changed');
    return buffer;
  } finally { await handle.close(); }
}

export async function captureAgyDeletionTarget(input: {
  sessionId: string; executorThreadId: string; home: string; cwd: string; command: string;
}): Promise<AgyDeletionTarget> {
  // Validate before constructing or inspecting paths from a native event.
  if (!UUID.test(input.sessionId) || !input.executorThreadId.startsWith('delegate-lane-')
    || !UUID.test(input.executorThreadId.slice(14)) || !absolute(input.home)) throw new Error('Invalid AGY creation identity');
  const nativeHome = path.join(input.home, '.remote-cli', 'agy-homes', input.executorThreadId);
  const pointerRoot = path.join(input.home, '.remote-cli', 'agy-sessions');
  const pointer = path.join(pointerRoot, `${input.executorThreadId}.json`);
  const target: AgyDeletionTarget = { version: 1, backend: 'agy', provenance: 'created', nativeVersion: CONTRACT,
    sessionId: input.sessionId, executorThreadId: input.executorThreadId, cwd: input.cwd, command: input.command,
    home: await historyDirectory(input.home), nativeHome: await historyDirectory(nativeHome),
    scope: await historyDirectory(path.join(nativeHome, '.gemini', 'antigravity-cli')),
    createdFile: await historyIdentity(path.join(nativeHome, '.gemini', 'antigravity-cli', 'conversations', `${input.sessionId}.db`), 'file'),
    pointerRoot: await historyDirectory(pointerRoot), pointer, pointerHash: hash((await bytes(pointer, 65536)).toString('utf8')) };
  // A legacy shared cache prevents deletion, but not ownership observation or
  // ordinary execution. Preserve the receipt so cleanup can report that boundary.
  await verifyAgyDeletionTarget(target, false, false);
  return target;
}

export async function verifyAgyDeletionTarget(target: AgyDeletionTarget, detached = false, requirePrivateCache = true): Promise<void> {
  if (!validAgyDeletionTarget(target) || os.homedir() !== target.home.path) throw new Error('AGY native home changed');
  for (const root of [target.home, target.nativeHome, target.scope, target.pointerRoot]) await verifyHistoryDirectory(root);
  // Future workers have a private cache; legacy shared-cache lanes need manual review.
  if (requirePrivateCache) await historyDirectory(path.join(target.scope.path, 'cache'));
  const names = await fs.readdir(target.pointerRoot.path);
  if (names.length > LIMIT) throw new Error('AGY pointer inventory exceeds the inspection limit');
  let found = false;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(target.pointerRoot.path, name);
    const text = (await bytes(file, 65536)).toString('utf8');
    const pointer = JSON.parse(text);
    if (!pointer || typeof pointer.id !== 'string' || !pointer.id || pointer.id.length > 256) throw new Error('Ambiguous AGY pointer');
    if (file !== target.pointer) {
      if (pointer.id.toLowerCase() === target.sessionId) throw new Error('AGY history has another reference');
      continue;
    }
    found = true;
    if (detached && pointer.id.toLowerCase() !== target.sessionId) continue;
    if (pointer.adopted || pointer.id !== target.sessionId || hash(text) !== target.pointerHash) throw new Error('AGY pointer changed');
  }
  if (!found && !detached) throw new Error('AGY pointer is missing');
}

function allowedFiles(target: AgyDeletionTarget): string[] {
  const root = target.scope.path;
  return [
    ...SUFFIXES.map(suffix => path.join(root, 'conversations', `${target.sessionId}.db${suffix}`)),
    ...SUFFIXES.map(suffix => path.join(root, `conversation_summaries.db${suffix}`)),
    path.join(root, 'annotations', `${target.sessionId}.pbtxt`),
    path.join(root, 'presence', `${target.sessionId}.lock`),
  ];
}

function historyDirectories(target: AgyDeletionTarget): string[] {
  const brain = path.join(target.scope.path, 'brain');
  const session = path.join(brain, target.sessionId);
  const generated = path.join(session, '.system_generated');
  const logs = path.join(generated, 'logs');
  return ['conversations', 'annotations', 'presence'].map(name => path.join(target.scope.path, name))
    .concat([brain, session, generated, logs, path.join(logs, 'chunks'),
      path.join(logs, 'chunks', 'transcript'), path.join(logs, 'chunks', 'transcript_full')]);
}
function isHistoryFile(target: AgyDeletionTarget, file: string): boolean {
  if (allowedFiles(target).includes(file)) return true;
  const logs = path.join(target.scope.path, 'brain', target.sessionId, '.system_generated', 'logs');
  const relative = path.relative(logs, file).split(path.sep).join('/');
  return /^(?:transcript(?:_full)?\.jsonl|chunks\/transcript(?:_full)?\/[0-9]{1,16}\.jsonl)$/.test(relative);
}

export function validAgyDeletionPreparation(target: AgyDeletionTarget, value: any): value is AgyDeletionPreparation {
  if (!validAgyDeletionTarget(target) || !value || value.version !== 1 || value.nativeVersion !== CONTRACT
    || value.targetHash !== stableHistoryHash(target) || !Array.isArray(value.files) || value.files.length > 256) return false;
  const allowed = allowedFiles(target);
  const directories = historyDirectories(target);
  const seen = new Set<string>();
  for (const entry of value.files) {
    if (!validHistoryEntry(entry) || seen.has(entry.path)
      || !(entry.kind === 'file' ? isHistoryFile(target, entry.path) : directories.includes(entry.path))) return false;
    seen.add(entry.path);
  }
  return seen.has(allowed[0]) && seen.has(path.join(target.scope.path, 'conversations'))
    && value.files.every((entry: HistoryEntry) => entry.kind === 'directory'
      || path.dirname(entry.path) === target.scope.path || seen.has(path.dirname(entry.path)));
}

async function maybe(file: string, kind: HistoryEntry['kind']): Promise<HistoryEntry | undefined> {
  try { await fs.lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  return historyIdentity(file, kind);
}

async function inventory(target: AgyDeletionTarget, ownedTargets: AgyDeletionTarget[] = [target]): Promise<HistoryEntry[]> {
  const root = target.scope.path;
  const entries: HistoryEntry[] = [];
  for (const directoryPath of historyDirectories(target)) {
    const directory = await maybe(directoryPath, 'directory');
    if (!directory) continue;
    entries.push(directory);
    const names = await fs.readdir(directory.path);
    if (names.length > LIMIT) throw new Error('AGY history inventory exceeds the inspection limit');
    if (['conversations', 'annotations', 'presence'].some(name => directory.path === path.join(root, name))) {
      const allowed = ownedTargets.flatMap(allowedFiles);
      if (names.some(file => !allowed.includes(path.join(directory.path, file)))) throw new Error('AGY namespace has other histories');
    }
    for (const name of names) {
      const file = path.join(directory.path, name);
      if (!allowedFiles(target).includes(file) && isHistoryFile(target, file)) {
        const entry = await maybe(file, 'file');
        if (entry) entries.push(entry);
      }
    }
  }
  for (const file of allowedFiles(target)) {
    const entry = await maybe(file, 'file');
    if (entry) entries.push(entry);
  }
  return entries;
}

/** Only metadata is queried. The original database (including WAL/SHM) is never opened by SQLite. */
async function verifyExclusiveIndex(target: AgyDeletionTarget, files: HistoryEntry[], ownedTargets: AgyDeletionTarget[]): Promise<boolean> {
  const index = path.join(target.scope.path, 'conversation_summaries.db');
  if (!files.some(file => file.path === index)) {
    if (files.some(file => file.path.startsWith(index))) throw new Error('AGY index has orphaned sidecars');
    return true;
  }
  // Node 18 remains supported by the CLI; this optional capability is explicit when unavailable.
  const builtin = 'node:sqlite';
  let sqlite: any;
  try { sqlite = createRequire(path.join(target.home.path, 'native-maintenance.cjs'))(builtin); } catch { return false; }
  if (typeof sqlite.DatabaseSync !== 'function') return false;
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-cli-agy-index-'));
  let database: any;
  try {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const source = index + suffix;
      if (!files.some(file => file.path === source)) continue;
      // Private bounded snapshot, so SQLite cannot mutate the original SHM or follow native links.
      await fs.writeFile(path.join(scratch, `index.db${suffix}`), await bytes(source, 32 * 1024 * 1024), { mode: 0o600 });
    }
    database = new sqlite.DatabaseSync(path.join(scratch, 'index.db'), { readOnly: true, allowExtension: false });
    database.exec('PRAGMA trusted_schema=OFF');
    const objects = database.prepare("SELECT type, name FROM sqlite_schema WHERE type IN ('table', 'view', 'trigger')").all();
    if (objects.length !== 1 || objects[0].type !== 'table' || objects[0].name !== 'conversation_summaries') {
      throw new Error('Unsupported AGY summary index objects');
    }
    const columns = database.prepare('PRAGMA table_info(conversation_summaries)').all();
    for (const name of ['conversation_id', 'parent_conversation_id', 'app_data_dir']) {
      if (!columns.some((column: any) => column.name === name && String(column.type).toLowerCase() === 'text')) {
        throw new Error('Unsupported AGY summary index schema');
      }
    }
    const rows = database.prepare('SELECT conversation_id, parent_conversation_id, app_data_dir FROM conversation_summaries LIMIT 65').all();
    if (rows.length > 64 || rows.some((row: any) => !ownedTargets.some(owned => owned.sessionId === row.conversation_id)
      || row.parent_conversation_id !== '' || !['', target.scope.path, 'antigravity-cli'].includes(row.app_data_dir))) {
      throw new Error('AGY index contains unowned history');
    }
    return true;
  } finally {
    try { database?.close(); } finally { await fs.rm(scratch, { recursive: true, force: true }); }
  }
}

/** No native DeleteConversation call: it can dispose worktrees and brain deliverables. */
export async function deleteOwnedAgySession(target: AgyDeletionTarget, recovery: AgyDeletionRecovery): Promise<NativeDeletionResult> {
  if (!supportsNativeCleanup()) return { state: 'unsupported', reason: 'AGY history deletion requires native anchored files and exit proof' };
  if (!recovery.confirmedProcessGroupExit) return { state: 'waiting-exit', reason: 'AGY writer process-group exit is unconfirmed' };
  let deleting = false;
  try {
    const ownedTargets = recovery.ownedTargets ?? [target];
    if (!ownedTargets.length || ownedTargets.length > 64
      || !ownedTargets.some(value => stableHistoryHash(value) === stableHistoryHash(target))
      || ownedTargets.some(value => !validAgyDeletionTarget(value) || value.executorThreadId !== target.executorThreadId
        || stableHistoryHash(value.scope) !== stableHistoryHash(target.scope) || stableHistoryHash(value.home) !== stableHistoryHash(target.home))) {
      throw new Error('AGY root ownership changed');
    }
    for (const owned of ownedTargets) await verifyAgyDeletionTarget(owned, recovery.detachedPointer || owned !== target);
    let prepared = recovery.prepared;
    if (prepared && !validAgyDeletionPreparation(target, prepared)) throw new Error('AGY preparation changed');
    if (!prepared) {
      if (!recovery.persistPrepared) throw new Error('Durable AGY preparation is required');
      const files = await inventory(target, ownedTargets);
      const transcript = path.join(target.scope.path, 'conversations', `${target.sessionId}.db`);
      const currentFile = files.find(file => file.path === transcript);
      if (!currentFile || currentFile.dev !== target.createdFile.dev || currentFile.ino !== target.createdFile.ino) {
        throw new Error('AGY conversation was replaced after creation');
      }
      // Inspect only the SQLite magic, never conversation contents.
      const handle = await fs.open(transcript, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const prefix = Buffer.alloc(16);
        if ((await handle.read(prefix, 0, 16, 0)).bytesRead !== 16 || prefix.toString() !== 'SQLite format 3\0') {
          throw new Error('Unsupported AGY conversation format');
        }
      } finally { await handle.close(); }
      if (!await verifyExclusiveIndex(target, files, ownedTargets)) return { state: 'unsupported', reason: 'AGY index inspection requires the optional node:sqlite capability' };
      prepared = { version: 1, nativeVersion: CONTRACT, targetHash: stableHistoryHash(target), files };
      if (!validAgyDeletionPreparation(target, prepared)) throw new Error('Invalid AGY manifest');
      await recovery.persistPrepared(prepared);
    }
    await verifyAgyDeletionTarget(target, recovery.detachedPointer);
    const current = await inventory(target, ownedTargets);
    // Directory mtime changes after removing a leaf are expected on a retry.
    if (current.some(entry => !prepared!.files.some(saved => saved.path === entry.path && saved.dev === entry.dev && saved.ino === entry.ino
      && (entry.kind === 'directory' || stableHistoryHash(saved) === stableHistoryHash(entry))))) throw new Error('AGY history changed after preparation');
    const anchor = await openHistoryAnchor(target.scope, prepared.files);
    try {
      deleting = true;
      // Keep directories, brain deliverables, caches, worktrees and remote-cli artifacts.
      for (const entry of prepared.files.filter(entry => entry.kind === 'file')) await anchor.remove(entry);
      await verifyAgyDeletionTarget(target, recovery.detachedPointer);
      for (const file of prepared.files.filter(entry => entry.kind === 'file')) {
        if (await anchor.exists(file.path)) throw new Error('AGY history remains');
      }
      if ((await inventory(target, ownedTargets)).some(entry => entry.kind === 'file')) throw new Error('AGY history reappeared');
      return { state: 'deleted', reason: 'Owned AGY conversation and exclusive summary index permanently removed; brain outputs preserved' };
    } finally { await anchor.close(); }
  } catch {
    return { state: deleting ? 'uncertain' : 'held', reason: 'AGY ownership, exclusive index or durable deletion could not be confirmed' };
  }
}
