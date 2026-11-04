import { createHash, randomUUID } from 'crypto';
import fs from 'fs/promises';
import { constants } from 'fs';
import os from 'os';
import path from 'path';
import { CodexAppServerClient, type CodexAppServerClientOptions } from '../executor/CodexAppServerClient';
import { replaceAtomicFile } from './AtomicFile';
import { syncDirectory } from './OwnershipRuntime';
import { validOwnedHistoryTarget, stableHistoryHash, validHistoryPreparation,
  type OwnedHistoryTarget, type HistoryEntry } from './NativeHistoryFiles';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LANE = /^delegate-lane-[0-9a-f-]{36}$/i;
export interface NativeDirectoryIdentity { path: string; dev: string; ino: string }
/** Captured from a newly created managed session, before its first model turn. */
export interface CodexDeletionTarget {
  version: 1;
  backend: 'codex';
  sessionId: string;
  executorThreadId: string;
  home: NativeDirectoryIdentity;
  nativeHome: NativeDirectoryIdentity;
  pointerHash: string;
  cwd: string;
  command: string;
}
export type NativeSessionDeletionTarget = CodexDeletionTarget | OwnedHistoryTarget;
export type NativeDeletionState = 'pending' | 'waiting-exit' | 'held' | 'unsupported' | 'uncertain' | 'deleted';
export interface NativeDeletionResult { state: NativeDeletionState; reason: string }
export interface NativeDeletionRequest {
  version: 1; threadId: string; throughGeneration: number; home: NativeDirectoryIdentity;
}
const safeGeneration = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const validDirectory = (value: any): value is NativeDirectoryIdentity => value && typeof value.path === 'string'
  && path.isAbsolute(value.path) && typeof value.dev === 'string' && typeof value.ino === 'string' && /^\d+$/.test(value.dev) && /^\d+$/.test(value.ino) && value.ino !== '0';
export function validNativeTarget(value: any): value is NativeSessionDeletionTarget {
  if (value?.backend !== 'codex') return validOwnedHistoryTarget(value);
  return value?.version === 1 && value.backend === 'codex' && typeof value.sessionId === 'string' && UUID.test(value.sessionId)
    && typeof value.executorThreadId === 'string' && LANE.test(value.executorThreadId)
    && UUID.test(value.executorThreadId.slice('delegate-lane-'.length))
    && validDirectory(value.home) && validDirectory(value.nativeHome)
    && typeof value.pointerHash === 'string' && /^[a-f0-9]{64}$/.test(value.pointerHash)
    && typeof value.cwd === 'string' && path.isAbsolute(value.cwd)
    && typeof value.command === 'string' && value.command.length > 0 && value.command.length < 4096 && !value.command.includes('\0');
}
export async function nativeDirectoryIdentity(directory: string): Promise<NativeDirectoryIdentity> {
  const canonical = await fs.realpath(directory);
  const stat = await fs.lstat(canonical, { bigint: true });
  if (!stat.isDirectory() || stat.ino === 0n) throw new Error('Native session root identity is unavailable');
  return { path: canonical, dev: String(stat.dev), ino: String(stat.ino) };
}
async function verifyDirectory(expected: NativeDirectoryIdentity): Promise<void> {
  if (!validDirectory(expected)) throw new Error('Invalid native session root');
  const actual = await nativeDirectoryIdentity(expected.path);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Native session root identity changed');
}
/** Reject redirected ancestors, symlinks, hard links and oversized/non-private metadata. */
async function readMetadata(file: string, root: string): Promise<Buffer> {
  const parent = path.dirname(file);
  if (await fs.realpath(parent) !== parent || !parent.startsWith(root + path.sep)) throw new Error('Session metadata path changed');
  const before = await fs.lstat(file, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.size > 65536n
    || process.getuid && before.uid !== BigInt(process.getuid())) throw new Error('Invalid session metadata file');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (before.dev !== opened.dev || before.ino !== opened.ino) throw new Error('Session metadata identity changed');
    const buffer = Buffer.alloc(65537);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    const after = await fs.lstat(file, { bigint: true });
    if (!after.isFile() || after.nlink !== 1n || bytes.length > 65536 || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error('Session metadata changed during read');
    }
    return bytes;
  } finally { await handle.close(); }
}
function pointerFile(target: CodexDeletionTarget): string {
  return path.join(target.home.path, '.remote-cli', 'codex-sessions', `${target.executorThreadId}.json`);
}
export async function captureCodexDeletionTarget(input: {
  sessionId: string; executorThreadId: string; home: string; nativeHome: string; cwd: string; command: string;
}): Promise<CodexDeletionTarget> {
  const home = await nativeDirectoryIdentity(input.home);
  const nativeHome = await nativeDirectoryIdentity(input.nativeHome);
  const target = { version: 1 as const, backend: 'codex' as const, ...input, home, nativeHome, pointerHash: '' };
  const bytes = await readMetadata(pointerFile(target), home.path);
  if (JSON.parse(bytes.toString()).id !== input.sessionId) throw new Error('Native session pointer identity changed');
  target.pointerHash = createHash('sha256').update(bytes).digest('hex');
  if (!validNativeTarget(target)) throw new Error('Invalid owned native session identity');
  return target;
}
export async function verifyNativeTarget(target: NativeSessionDeletionTarget, detachedPointer = false): Promise<void> {
  if (target.backend !== 'codex') throw new Error('Not a Codex deletion target');
  if (!validNativeTarget(target)) throw new Error('Invalid owned native session identity');
  await verifyDirectory(target.home);
  await verifyDirectory(target.nativeHome);
  const currentHome = await fs.realpath(process.env.HOME || os.homedir());
  const configuredRoot = process.env.CODEX_HOME || path.join(currentHome, '.codex');
  if (currentHome !== target.home.path || !path.isAbsolute(configuredRoot)
    || await fs.realpath(configuredRoot) !== target.nativeHome.path) throw new Error('Native session home changed');
  let bytes: Buffer;
  try { bytes = await readMetadata(pointerFile(target), target.home.path); }
  catch (error) {
    if (detachedPointer && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const id: unknown = JSON.parse(bytes.toString()).id;
  if (detachedPointer && typeof id === 'string' && UUID.test(id) && id !== target.sessionId) return;
  if (createHash('sha256').update(bytes).digest('hex') !== target.pointerHash || id !== target.sessionId) {
    throw new Error('Native session pointer changed');
  }
}

// Explicit source filters include native subagents; omitted filters only list interactive threads.
const SOURCE_KINDS = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview',
  'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const MAX_POINTERS = 4096;
const isObject = (value: any): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const nativeId = (value: unknown): string => {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Invalid native thread identity');
  return value.toLowerCase();
};

/** Every JSON binding is relevant, including direct/foreground and adopted sessions. */
async function verifyExclusivePointer(target: CodexDeletionTarget, detachedPointer = false): Promise<void> {
  const directory = path.dirname(pointerFile(target));
  if (await fs.realpath(directory) !== directory) throw new Error('Native pointer inventory is redirected');
  const before = await fs.lstat(directory, { bigint: true });
  const entries = await fs.opendir(directory);
  let count = 0;
  let found = false;
  for await (const entry of entries) {
    if (++count > MAX_POINTERS) throw new Error('Native pointer inventory exceeds the bounded scan');
    if (!entry.name.toLowerCase().endsWith('.json')) continue;
    const file = path.join(directory, entry.name);
    const value = JSON.parse((await readMetadata(file, target.home.path)).toString());
    if (!isObject(value)) throw new Error('Ambiguous native pointer metadata');
    const id = nativeId(value.id);
    if (file === pointerFile(target)) found = true;
    else if (id === nativeId(target.sessionId)) throw new Error('Another native pointer references this session');
  }
  const after = await fs.lstat(directory, { bigint: true });
  if ((!found && !detachedPointer) || !after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino
    || before.mtimeNs !== after.mtimeNs || await fs.realpath(directory) !== directory) {
    throw new Error('Native pointer inventory changed');
  }
}

interface NativeThreadMetadata {
  id: string; sessionId: string; parent?: string; cwd: string; status: string; ephemeral: boolean;
}
/** Validate relationship-bearing fields without reading or retaining transcript turns. */
function threadMetadata(value: any): NativeThreadMetadata {
  if (!isObject(value) || typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd)
    || typeof value.ephemeral !== 'boolean' || !Array.isArray(value.turns) || value.turns.length
    || typeof value.cliVersion !== 'string' || typeof value.modelProvider !== 'string'
    || typeof value.preview !== 'string' || !(value.projectId === null || typeof value.projectId === 'string')
    || !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.updatedAt)
    || !isObject(value.status) || !['notLoaded', 'idle', 'systemError', 'active'].includes(value.status.type)) {
    throw new Error('Incomplete native thread metadata');
  }
  if (value.status.type === 'active' && (!Array.isArray(value.status.activeFlags)
    || value.status.activeFlags.some((flag: unknown) => !['waitingOnApproval', 'waitingOnUserInput'].includes(flag as string)))) {
    throw new Error('Invalid native thread status');
  }
  let parent = value.parentThreadId == null ? undefined : nativeId(value.parentThreadId);
  const source = value.source;
  if (typeof source === 'string') {
    if (!['cli', 'vscode', 'exec', 'appServer', 'unknown'].includes(source)) throw new Error('Invalid native source');
  } else if (isObject(source) && Object.keys(source).length === 1) {
    if (typeof source.custom === 'string') { /* Custom sources carry no additional relationship field. */ }
    else if (typeof source.subAgent === 'string') {
      if (!['review', 'compact', 'memory_consolidation'].includes(source.subAgent)) throw new Error('Invalid subagent source');
    } else if (isObject(source.subAgent) && Object.keys(source.subAgent).length === 1) {
      const subAgent = source.subAgent;
      if (typeof subAgent.other === 'string') { /* The session tree identity still applies. */ }
      else if (isObject(subAgent.thread_spawn) && Number.isSafeInteger(subAgent.thread_spawn.depth)
        && subAgent.thread_spawn.depth >= 0 && subAgent.thread_spawn.depth <= 2147483647) {
        const sourceParent = nativeId(subAgent.thread_spawn.parent_thread_id);
        if (parent !== undefined && parent !== sourceParent) throw new Error('Conflicting native parent identities');
        parent = sourceParent;
      } else throw new Error('Invalid spawned thread source');
    } else throw new Error('Invalid native source');
  } else throw new Error('Missing native source');
  return { id: nativeId(value.id), sessionId: nativeId(value.sessionId), parent,
    cwd: value.cwd, status: value.status.type, ephemeral: value.ephemeral };
}

async function listNativeMetadata(client: NativeDeletionTransport): Promise<Map<string, NativeThreadMetadata>> {
  const threads = new Map<string, NativeThreadMetadata>();
  let pages = 0;
  for (const archived of [false, true]) {
    let cursor: string | null = null;
    const cursors = new Set<string>();
    do {
      if (++pages > MAX_PAGES) throw new Error('Native metadata inventory exceeds the bounded scan');
      const page = await client.request('thread/list', { archived, cursor, limit: PAGE_SIZE,
        sourceKinds: SOURCE_KINDS, modelProviders: [], sortKey: 'created_at', sortDirection: 'asc' });
      if (!isObject(page) || !Array.isArray(page.data) || page.data.length > PAGE_SIZE) throw new Error('Incomplete native metadata page');
      for (const value of page.data) {
        const thread = threadMetadata(value);
        if (threads.has(thread.id)) throw new Error('Native metadata inventory changed during pagination');
        threads.set(thread.id, thread);
      }
      // nextCursor is optional/nullable in the installed schema. Empty strings,
      // repeated cursors and nonterminal empty pages are not completion evidence.
      cursor = page.nextCursor ?? null;
      if (cursor !== null) {
        if (typeof cursor !== 'string' || !cursor || cursor.length > 4096 || !page.data.length || cursors.has(cursor)) {
          throw new Error('Invalid native metadata cursor');
        }
        cursors.add(cursor);
      }
    } while (cursor !== null);
  }
  return threads;
}

function verifyNoDescendants(threads: Map<string, NativeThreadMetadata>, root: string): void {
  const visited = new Set<string>();
  for (const thread of threads.values()) {
    if (thread.id !== root && (thread.sessionId === root || thread.parent === root)) throw new Error('Native descendants are not authorized');
    const chain = new Set<string>();
    let current: NativeThreadMetadata | undefined = thread;
    while (current && !visited.has(current.id)) {
      if (chain.has(current.id)) throw new Error('Cyclic native thread relationship');
      chain.add(current.id);
      current = current.parent ? threads.get(current.parent) : undefined;
    }
    for (const id of chain) visited.add(id);
  }
}

export interface NativeDeletionPreparation {
  version: 1;
  /** Adapter protocol/layout contract; old package strings remain immutable legacy receipt markers. */
  nativeVersion: 'codex-thread-delete-v1' | '0.166.0' | OwnedHistoryTarget['nativeVersion'];
  targetHash: string;
  /** Exact immutable pre-delete manifest for file-backed adapters. */
  files?: HistoryEntry[];
}
/** Recovery never replaces the caller's parent-reset authorization and current exit proof. */
export interface NativeDeletionRecovery {
  /** Only for a recorded identity detached by managed reset or native fallback. */
  detachedPointer?: boolean;
  /** Load only the durable receipt saved for this exact authorized target. */
  prepared?: NativeDeletionPreparation;
  /** Must durably persist before resolving. Failure prevents thread/delete. */
  persistPrepared?: (preparation: NativeDeletionPreparation) => Promise<void>;
  /** Kimi maintenance itself owns a writer; interrupted maintenance stays fenced. */
  persistMaintenanceState?: (unconfirmed: boolean) => Promise<void>;
}
export function deletionPreparation(target: NativeSessionDeletionTarget): NativeDeletionPreparation {
  if (target.backend !== 'codex') return { version: 1, nativeVersion: target.nativeVersion, targetHash: stableHistoryHash(target) };
  // Explicit field order makes this stable across JSON persistence and object reconstruction.
  const directory = (value: NativeDirectoryIdentity) => [value.path, value.dev, value.ino];
  const identity = [target.version, target.backend, target.sessionId, target.executorThreadId,
    directory(target.home), directory(target.nativeHome), target.pointerHash, target.cwd, target.command];
  return { version: 1, nativeVersion: 'codex-thread-delete-v1', targetHash: createHash('sha256').update(JSON.stringify(identity)).digest('hex') };
}
export function validDeletionPreparation(target: NativeSessionDeletionTarget, prepared: NativeDeletionPreparation): boolean {
  if (target.backend === 'pi' || target.backend === 'claude') return validHistoryPreparation(target, prepared);
  const expected = deletionPreparation(target);
  // Previously persisted Codex receipts remain valid and immutable across CLI versions.
  if (target.backend === 'codex' && prepared?.nativeVersion === '0.166.0') expected.nativeVersion = '0.166.0';
  return JSON.stringify(prepared) === JSON.stringify(expected);
}

export interface NativeDeletionTransport {
  start(): Promise<void>;
  getServerVersion(): string | null;
  request(method: string, params: unknown): Promise<any>;
  stop(): Promise<void>;
}
export type NativeDeletionClientFactory = (options: CodexAppServerClientOptions) => NativeDeletionTransport;
/** No archive, resume, new session, model turn, or direct database writes. */
export async function deleteOwnedCodexSession(target: NativeSessionDeletionTarget,
  factory: NativeDeletionClientFactory = options => new CodexAppServerClient(options),
  recovery: NativeDeletionRecovery = {}): Promise<NativeDeletionResult> {
  let client: NativeDeletionTransport | undefined;
  let deleting = false;
  let result: NativeDeletionResult;
  try {
    if (target.backend !== 'codex') throw new Error('Not a Codex deletion target');
    await verifyNativeTarget(target, recovery.detachedPointer);
    await verifyExclusivePointer(target, recovery.detachedPointer);
    client = factory({ command: target.command, cwd: target.nativeHome.path,
      env: { ...process.env, HOME: target.home.path, CODEX_HOME: target.nativeHome.path },
      launchArgs: ['-c', 'mcp_servers={}'] });
    await client.start();
    // Protocol responses establish support; the reported CLI version is diagnostic only.
    const threads = await listNativeMetadata(client);
    const rootId = nativeId(target.sessionId);
    verifyNoDescendants(threads, rootId);
    const root = threads.get(rootId);
    if (recovery.prepared !== undefined && !validDeletionPreparation(target, recovery.prepared)) {
      throw new Error('Native deletion preparation identity changed');
    }
    const preparation = recovery.prepared ?? deletionPreparation(target);
    if (root) {
      if (root.sessionId !== rootId || root.parent || root.cwd !== target.cwd || root.ephemeral || root.status !== 'notLoaded') {
        throw new Error('Native root identity or inactivity is unconfirmed');
      }
      const response = await client.request('thread/read', { threadId: target.sessionId, includeTurns: false });
      const current = threadMetadata(response?.thread);
      if (JSON.stringify(current) !== JSON.stringify(root)) throw new Error('Native root metadata changed');
    } else if (!recovery.prepared) {
      throw new Error('Missing native root has no exact durable deletion preparation');
    }
    await verifyNativeTarget(target, recovery.detachedPointer);
    await verifyExclusivePointer(target, recovery.detachedPointer);
    if (root && !recovery.prepared && recovery.persistPrepared) {
      await recovery.persistPrepared(preparation);
      await verifyNativeTarget(target, recovery.detachedPointer);
      await verifyExclusivePointer(target, recovery.detachedPointer);
    }
    // Only an exact prepared attempt may retry an absent root. Accept only the
    // target-specific missing-rollout response; generic errors and unprepared
    // absence never prove completion.
    deleting = true;
    let acknowledgement: unknown;
    try { acknowledgement = await client.request('thread/delete', { threadId: target.sessionId }); }
    catch (error) {
      if (!root && (error as { code?: number }).code === -32600
        && error instanceof Error && error.message === `no rollout found for thread id ${target.sessionId}`) {
        acknowledgement = {};
      } else throw error;
    }
    if (!acknowledgement || typeof acknowledgement !== 'object' || Array.isArray(acknowledgement)
      || Object.keys(acknowledgement).length) throw new Error('Invalid native deletion acknowledgement');
    result = { state: 'deleted', reason: 'Native permanent deletion acknowledged' };
  } catch (error) {
    result = (error as { code?: number }).code === -32601
      ? { state: 'unsupported', reason: 'Native permanent deletion protocol is unavailable' }
      : { state: deleting ? 'uncertain' : 'held', reason: deleting
        ? 'Native deletion outcome is uncertain; the exact target is retained for retry'
        : 'Native identity, pointer, root, inactivity or descendant verification failed' };
  } finally {
    if (client) {
      try { await client.stop(); }
      catch { result = { state: 'uncertain', reason: 'Native maintenance transport exit is unconfirmed' }; }
    }
  }
  return result!;
}

/** Reset fences outlive ThreadContextReset.complete(); lane receipts are retained separately. */
export class NativeSessionDeletionQueue {
  constructor(readonly directory: string) {}
  private async prepare(): Promise<string> {
    const parent = await fs.realpath(path.dirname(this.directory));
    if (path.join(parent, path.basename(this.directory)) !== this.directory) throw new Error('Deletion queue root changed');
    const created = await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (await fs.realpath(this.directory) !== this.directory) throw new Error('Deletion queue is redirected');
    if (created) syncDirectory(parent);
    return parent;
  }
  async enqueue(threadId: string, throughGeneration: number): Promise<void> {
    if (!threadId || threadId.length > 200 || !safeGeneration(throughGeneration)) throw new Error('Invalid native deletion reset fence');
    const root = await this.prepare();
    const record: NativeDeletionRequest = { version: 1, threadId, throughGeneration,
      home: await nativeDirectoryIdentity(process.env.HOME || os.homedir()) };
    const key = createHash('sha256').update(JSON.stringify([threadId, throughGeneration])).digest('hex');
    const file = path.join(this.directory, `${key}.json`);
    try {
      const existing = JSON.parse((await readMetadata(file, root)).toString());
      if (JSON.stringify(existing) !== JSON.stringify(record)) throw new Error('Deletion reset fence identity changed');
      return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
      await replaceAtomicFile(temporary, file);
      syncDirectory(this.directory);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  async requests(): Promise<NativeDeletionRequest[]> {
    const root = await this.prepare();
    const records: NativeDeletionRequest[] = [];
    for (const name of await fs.readdir(this.directory)) {
      if (!name.endsWith('.json')) continue;
      if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error('Malformed native deletion inventory');
      const value = JSON.parse((await readMetadata(path.join(this.directory, name), root)).toString());
      if (value?.version !== 1 || typeof value.threadId !== 'string' || !value.threadId || value.threadId.length > 200
        || !safeGeneration(value.throughGeneration) || !validDirectory(value.home)) throw new Error('Malformed native deletion request');
      if (name !== createHash('sha256').update(JSON.stringify([value.threadId, value.throughGeneration])).digest('hex') + '.json') throw new Error('Deletion request identity changed');
      await verifyDirectory(value.home);
      if (await fs.realpath(process.env.HOME || os.homedir()) !== value.home.path) throw new Error('Deletion request home changed');
      records.push(value);
    }
    return records;
  }
}
