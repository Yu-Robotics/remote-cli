import { createHash } from 'crypto';
import fs from 'fs/promises';
import { constants } from 'fs';
import path from 'path';
import { ownedSpawn } from './OwnershipRuntime';
import { ManagedProcessGroups } from '../executor/ManagedProcessGroups';
import { nativeDirectoryIdentity, type NativeDirectoryIdentity, type NativeDeletionResult } from './NativeSessionDeletion';

const SESSION = /^ses_[a-zA-Z0-9]{1,100}$/;
const LANE = /^delegate-lane-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Recorded only after native newSession, before its first prompt. Never infer ownership from a saved pointer. */
export interface OpenCodeDeletionTarget {
  version: 1;
  backend: 'opencode';
  sessionId: string;
  executorThreadId: string;
  home: NativeDirectoryIdentity;
  database: NativeDirectoryIdentity;
  pointer: string;
  pointerHash: string;
  cwd: string;
  command: string;
  projectId: string;
  createdAt: number;
}
export interface OpenCodeDeletionPreparation {
  version: 1;
  nativeVersion: 'opencode-session-delete-v1';
  targetHash: string;
}
export interface OpenCodeDeletionRecovery {
  detachedPointer?: boolean;
  prepared?: OpenCodeDeletionPreparation;
  persistPrepared?: (value: OpenCodeDeletionPreparation) => Promise<void>;
  persistMaintenanceState?: (unconfirmed: boolean) => Promise<void>;
}
export interface OpenCodeDeletionTransport {
  run(args: string[]): Promise<string>;
  waitForExit(): Promise<void>;
}
export type OpenCodeDeletionFactory = (command: string, cwd: string, environment?: NodeJS.ProcessEnv) => OpenCodeDeletionTransport;

/** Native commands only; no shell, server listener, prompts, credentials or transcript queries. */
export class OpenCodeDeletionClient implements OpenCodeDeletionTransport {
  private readonly groups = new ManagedProcessGroups();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly environment: NodeJS.ProcessEnv;
  constructor(private readonly command: string, private readonly cwd: string, environment: NodeJS.ProcessEnv = process.env) {
    this.environment = { ...environment };
  }
  run(args: string[]): Promise<string> {
    const result = new Promise<string>((resolve, reject) => {
      const child = ownedSpawn(this.command, ['--pure', ...args], {
        cwd: this.cwd, env: { ...this.environment }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.groups.track(child);
      let output = '';
      let failed = false;
      const fail = () => {
        failed = true;
        child.kill('SIGKILL');
        // Descendants can retain inherited pipes after their leader exits.
        // Closing our read ends allows close to settle; group verification still
        // owns termination of any remaining managed descendants.
        child.stdout?.destroy(); child.stderr?.destroy();
      };
      const timer = setTimeout(fail, 15_000);
      child.stdout?.on('data', (chunk: Buffer) => {
        if (Buffer.byteLength(output) + chunk.length > 65_536) fail();
        else output += chunk.toString();
      });
      child.stderr?.on('data', () => {});
      child.once('error', () => { failed = true; });
      child.once('close', code => {
        clearTimeout(timer);
        if (failed || code !== 0) reject(new Error('OpenCode maintenance command failed'));
        else resolve(output.trim());
      });
    });
    this.pending.add(result);
    void result.then(() => this.pending.delete(result), () => this.pending.delete(result));
    return result;
  }
  async waitForExit(): Promise<void> {
    await Promise.allSettled([...this.pending]);
    await this.groups.waitForExit();
  }
}
const defaultFactory: OpenCodeDeletionFactory = (command, cwd, environment) => new OpenCodeDeletionClient(command, cwd, environment);

async function fileIdentity(file: string): Promise<NativeDirectoryIdentity> {
  if (await fs.realpath(file) !== file) throw new Error('Redirected OpenCode file');
  const stat = await fs.lstat(file, { bigint: true });
  if (!stat.isFile() || stat.nlink !== 1n || stat.ino === 0n
    || process.getuid && stat.uid !== BigInt(process.getuid())) throw new Error('Unsafe OpenCode file');
  return { path: file, dev: String(stat.dev), ino: String(stat.ino) };
}
async function readPointer(file: string, root: string): Promise<Buffer> {
  if (!file.startsWith(root + path.sep) || await fs.realpath(path.dirname(file)) !== path.dirname(file)) {
    throw new Error('Redirected OpenCode pointer');
  }
  const before = await fs.lstat(file, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.size > 65_536n
    || process.getuid && before.uid !== BigInt(process.getuid())) throw new Error('Unsafe OpenCode pointer');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    const bytes = Buffer.alloc(65_537);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await fs.lstat(file, { bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || before.dev !== after.dev || before.ino !== after.ino
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.size !== after.size
      || after.nlink !== 1n || length > 65_536) throw new Error('OpenCode pointer changed');
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}
export function validOpenCodeDeletionTarget(value: any): value is OpenCodeDeletionTarget {
  const identity = (item: any) => item && typeof item.path === 'string' && path.isAbsolute(item.path)
    && typeof item.dev === 'string' && /^\d+$/.test(item.dev) && typeof item.ino === 'string' && /^[1-9]\d*$/.test(item.ino);
  return value?.version === 1 && value.backend === 'opencode' && SESSION.test(value.sessionId)
    && typeof value.sessionId === 'string' && typeof value.executorThreadId === 'string' && LANE.test(value.executorThreadId)
    && identity(value.home) && identity(value.database) && typeof value.pointer === 'string'
    && value.pointer === path.join(value.home.path, '.remote-cli', 'opencode-sessions', `${value.executorThreadId}.json`)
    && typeof value.pointerHash === 'string' && /^[a-f0-9]{64}$/.test(value.pointerHash)
    && typeof value.cwd === 'string' && path.isAbsolute(value.cwd) && typeof value.command === 'string'
    && value.command.length > 0 && value.command.length < 4096 && !value.command.includes('\0')
    && typeof value.projectId === 'string' && value.projectId.length > 0 && value.projectId.length <= 256
    && Number.isSafeInteger(value.createdAt) && value.createdAt >= 0;
}

/** Exact metadata/counts only. No broad session listing or message/event payload reads. */
function metadataQuery(id: string): string {
  if (!SESSION.test(id)) throw new Error('Invalid OpenCode session identity');
  const count = (table: string, field = 'session_id') => `(SELECT count(*) FROM ${table} WHERE ${field}='${id}')`;
  return `SELECT ${count('session', 'id')} AS roots, `
    + `(SELECT project_id FROM session WHERE id='${id}') AS projectId, `
    + `(SELECT directory FROM session WHERE id='${id}') AS cwd, `
    + `(SELECT time_created FROM session WHERE id='${id}') AS createdAt, `
    + `(SELECT parent_id FROM session WHERE id='${id}') AS parentId, `
    + `${count('session', 'parent_id')} AS children, ${count('event', 'aggregate_id')} AS events, `
    + `${count('event_sequence', 'aggregate_id')} AS sequences, ${count('message')} AS messages, `
    + `${count('part')} AS parts, ${count('todo')} AS todos, ${count('session_message')} AS projections, `
    + `${count('session_input')} AS inputs, ${count('session_context_epoch')} AS epochs`;
}
async function inspect(client: OpenCodeDeletionTransport, id: string): Promise<Record<string, any>> {
  const rows = JSON.parse(await client.run(['db', metadataQuery(id), '--format', 'json']));
  if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || typeof rows[0] !== 'object') throw new Error('Invalid OpenCode metadata');
  const row = rows[0];
  for (const field of ['roots', 'children', 'events', 'sequences', 'messages', 'parts', 'todos', 'projections', 'inputs', 'epochs']) {
    if (!Number.isSafeInteger(row[field]) || row[field] < 0) throw new Error('Incomplete OpenCode metadata');
  }
  return row;
}
function absent(row: Record<string, any>): boolean {
  return ['roots', 'children', 'events', 'sequences', 'messages', 'parts', 'todos', 'projections', 'inputs', 'epochs']
    .every(key => row[key] === 0);
}
function rootMatches(target: OpenCodeDeletionTarget, row: Record<string, any>): boolean {
  return row.roots === 1 && row.projectId === target.projectId && row.cwd === target.cwd
    && row.createdAt === target.createdAt && row.parentId === null && row.children === 0;
}
export function openCodeDeletionPreparation(target: OpenCodeDeletionTarget): OpenCodeDeletionPreparation {
  return { version: 1, nativeVersion: 'opencode-session-delete-v1', targetHash: hash(target) };
}
async function verify(target: OpenCodeDeletionTarget, client: OpenCodeDeletionTransport, detached = false): Promise<void> {
  if (!validOpenCodeDeletionTarget(target)
    || JSON.stringify(await nativeDirectoryIdentity(target.home.path)) !== JSON.stringify(target.home)
    || JSON.stringify(await fileIdentity(target.database.path)) !== JSON.stringify(target.database)
    || await client.run(['db', 'path']) !== target.database.path) throw new Error('OpenCode storage changed');
  const directory = path.dirname(target.pointer);
  const before = await fs.lstat(directory, { bigint: true });
  let found = false;
  let count = 0;
  const entries = await fs.opendir(directory);
  for await (const entry of entries) {
    if (++count > 4096) throw new Error('OpenCode pointer inventory exceeds limit');
    if (!entry.name.toLowerCase().endsWith('.json')) continue;
    const file = path.join(directory, entry.name);
    const bytes = await readPointer(file, target.home.path);
    const value = JSON.parse(bytes.toString());
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.id !== 'string'
      || !value.id || value.id.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(value.id)) throw new Error('Ambiguous OpenCode pointer');
    if (file === target.pointer) {
      found = true;
      if (!(detached && value.id !== target.sessionId && SESSION.test(value.id))
        && (hash(bytes.toString()) !== target.pointerHash || value.id !== target.sessionId)) throw new Error('OpenCode pointer changed');
    } else if (value.id === target.sessionId) throw new Error('OpenCode session has another binding');
  }
  const after = await fs.lstat(directory, { bigint: true });
  if ((!found && !detached) || before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs) {
    throw new Error('OpenCode pointer inventory changed');
  }
}

export async function captureOpenCodeDeletionTarget(input: {
  sessionId: string; executorThreadId: string; home: string; cwd: string; command: string;
}, factory: OpenCodeDeletionFactory = defaultFactory): Promise<OpenCodeDeletionTarget> {
  if (!SESSION.test(input.sessionId) || !LANE.test(input.executorThreadId)) throw new Error('Invalid OpenCode creation identity');
  const client = factory(input.command, input.cwd);
  try {
    const home = await nativeDirectoryIdentity(input.home);
    const database = await fileIdentity(await client.run(['db', 'path']));
    const pointer = path.join(home.path, '.remote-cli', 'opencode-sessions', `${input.executorThreadId}.json`);
    const bytes = await readPointer(pointer, home.path);
    if (JSON.parse(bytes.toString()).id !== input.sessionId) throw new Error('OpenCode creation pointer changed');
    const row = await inspect(client, input.sessionId);
    const target: OpenCodeDeletionTarget = { ...input, home, database, pointer, pointerHash: hash(bytes.toString()),
      projectId: row.projectId, createdAt: row.createdAt, version: 1, backend: 'opencode' };
    if (!validOpenCodeDeletionTarget(target) || !rootMatches(target, row)) throw new Error('OpenCode creation metadata changed');
    await verify(target, client);
    return target;
  } finally { await client.waitForExit(); }
}

/** Caller must supply durable parent-reset authorization and current worker-group exit proof. */
export async function deleteOwnedOpenCodeSession(target: OpenCodeDeletionTarget, recovery: OpenCodeDeletionRecovery,
  factory: OpenCodeDeletionFactory = defaultFactory): Promise<NativeDeletionResult> {
  if (process.platform !== 'linux') return { state: 'unsupported', reason: 'OpenCode managed writer proof is unavailable' };
  let client: OpenCodeDeletionTransport | undefined;
  let deleting = false;
  let fenced = false;
  let result: NativeDeletionResult = { state: 'held', reason: 'OpenCode ownership or metadata verification failed' };
  try {
    if (!validOpenCodeDeletionTarget(target) || !recovery.persistPrepared || !recovery.persistMaintenanceState) throw new Error('Missing OpenCode authorization receipt');
    if (JSON.stringify(await nativeDirectoryIdentity(target.home.path)) !== JSON.stringify(target.home)) throw new Error('OpenCode maintenance home changed');
    const preparation = openCodeDeletionPreparation(target);
    if (recovery.prepared && JSON.stringify(recovery.prepared) !== JSON.stringify(preparation)) throw new Error('OpenCode preparation changed');
    await recovery.persistMaintenanceState(true);
    fenced = true;
    // Task checkouts may already be reclaimed when the parent resets. Retain
    // their cwd only as session metadata; launch maintenance from durable home.
    client = factory(target.command, target.home.path, { ...process.env, HOME: target.home.path,
      USERPROFILE: target.home.path, OPENCODE_DB: target.database.path });
    await verify(target, client, recovery.detachedPointer);
    const row = await inspect(client, target.sessionId);
    if (row.roots === 0) {
      // The native CLI cannot remove orphaned events once the session row is gone.
      result = recovery.prepared && absent(row)
        ? { state: 'deleted', reason: 'Prepared OpenCode deletion verified absent including durable events' }
        : { state: 'held', reason: 'OpenCode missing root has unconfirmed deletion or residual history' };
    } else {
      if (!rootMatches(target, row)) throw new Error('OpenCode root or descendants changed');
      await recovery.persistPrepared(preparation);
      await verify(target, client, recovery.detachedPointer);
      if (!rootMatches(target, await inspect(client, target.sessionId))) throw new Error('OpenCode root changed');
      deleting = true;
      await client.run(['session', 'delete', target.sessionId]);
      result = absent(await inspect(client, target.sessionId))
        ? { state: 'deleted', reason: 'OpenCode permanent deletion verified including durable events' }
        : { state: 'uncertain', reason: 'OpenCode deletion left residual history; exact receipt retained' };
    }
  } catch {
    if (deleting) result = { state: 'uncertain', reason: 'OpenCode deletion outcome is uncertain; exact receipt retained' };
  } finally {
    if (fenced) {
      try { await client?.waitForExit(); await recovery.persistMaintenanceState!(false); }
      catch { result = { state: 'uncertain', reason: 'OpenCode maintenance writer exit is unconfirmed' }; }
    }
  }
  return result;
}
