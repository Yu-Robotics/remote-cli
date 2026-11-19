import { createHash } from 'crypto';
import { constants, promises as fs, type BigIntStats } from 'fs';
import path from 'path';
import { bootIdentity } from '../delegation/OwnershipRuntime';
import { exclusiveLocalVolume } from './AgyDeletionVolume';

export const threadUuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const sessionId = /^[a-zA-Z0-9_-]{1,128}$/;
const limit = 8192;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function uncertain(): never { throw new Error('AGY storage ownership is ambiguous; thread data was retained.'); }
async function stat(file: string) {
  try { return await fs.lstat(file, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
async function directory(file: string) {
  const entry = await stat(file);
  if (entry && (!entry.isDirectory() || await fs.realpath(file) !== file)) uncertain();
  return entry;
}
async function json(file: string) {
  const entry = await stat(file);
  if (!entry?.isFile() || entry.nlink !== 1n || entry.size > 1024n * 1024n || await fs.realpath(file) !== file) uncertain();
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== entry.dev || opened.ino !== entry.ino) uncertain();
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}

async function archivedSessions(archive: string): Promise<string[]> {
  const names = await fs.readdir(archive);
  if (!names.length || names.length > limit) uncertain();
  const sessions = new Set<string>();
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) uncertain();
    const record = await json(path.join(archive, name));
    const id = record?.session?.id;
    if (record?.retirement !== 'unconfirmed' || record.session?.transport !== 'acp'
      || typeof id !== 'string' || !sessionId.test(id) || name !== hash(id) + '.json'
      || (record.session.adopted !== undefined && record.session.adopted !== false)
      || (record.session.retired !== undefined && typeof record.session.retired !== 'boolean')
      || (record.legacyCheckpoint !== undefined && typeof record.legacyCheckpoint !== 'string')
      || sessions.has(id.toLowerCase())) uncertain();
    sessions.add(id.toLowerCase());
  }
  return [...sessions].sort();
}

/** Validate independent ownership first, including sidecars left by interrupted writes. */
export async function inspectAgyDeletion(root: string, id: string, allowCurrent = false): Promise<string[]> {
  if (!threadUuid.test(id)) throw new Error('Invalid thread ID for data cleanup');
  const sessions = path.join(root, 'agy-sessions');
  const homes = path.join(root, 'agy-homes');
  const home = path.join(homes, id);
  await directory(root);
  await directory(homes);
  await directory(home);
  if (!await directory(sessions)) return [];
  const pointer = path.join(sessions, id + '.json');
  if (await stat(pointer + '.allocation-unconfirmed')) throw new Error('AGY allocation ownership is unconfirmed; thread state was retained.');
  if (await stat(pointer + '.checkpoint.lock')) throw new Error('AGY checkpoint transition is unconfirmed; thread state was retained.');
  const archive = pointer + '.detached-acp';
  const detached = await directory(archive);
  const current = await stat(pointer) ? await json(pointer) : undefined;
  if (current !== undefined && (typeof current?.id !== 'string' || !sessionId.test(current.id))) uncertain();
  if (current?.transport === 'acp' && !allowCurrent) throw new Error('AGY ACP host retirement is unconfirmed; session data was retained.');
  if (await stat(pointer + '.native-schedules')) {
    const owner = await json(pointer + '.native-schedules');
    if (!current || owner?.sessionId !== current.id || typeof owner.hostId !== 'string' || !owner.hostId
      || owner.retired !== true || detached) {
      throw new Error('AGY native host retirement is unconfirmed; thread data and schedule ownership were retained.');
    }
  }
  if (!detached) return [];
  if (current && current.transport !== 'acp') uncertain();
  for (const name of await fs.readdir(sessions)) {
    if (name.startsWith(id + '.') && name !== path.basename(archive) && name !== path.basename(pointer)) uncertain();
  }
  if (await stat(home) && (await fs.readdir(home)).some(name =>
    name.startsWith('.remote-cli-agy-hooks') && name !== '.remote-cli-agy-hooks.gate')) uncertain();
  return archivedSessions(archive);
}

interface BootProof {
  host: string;
  boot: string;
  sessions: string[];
  entries: Record<string, string>;
  anchors: string;
}
export interface DetachedDeletion {
  version: 1;
  threadId: string;
  proof?: BootProof;
  checksum?: string;
  auxiliary?: Record<string, string>;
  completed?: true;
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

/** Check pointers and the native storage layout, including incoming aliases from other lanes. */
type ThreadReference = { workingDirectory: string; sessionId: string | null };
async function checkReferences(root: string, id: string, ids: string[], threads: ThreadReference[]) {
  const target = path.join(root, 'agy-homes', id);
  for (const { workingDirectory: workspace, sessionId } of threads) {
    if (sessionId && ids.includes(sessionId.toLowerCase())) uncertain();
    if (inside(target, path.resolve(workspace))) uncertain();
    try { if (inside(target, await fs.realpath(workspace))) uncertain(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const sessions = path.join(root, 'agy-sessions');
  if (!await directory(sessions)) uncertain();
  for (const name of await fs.readdir(sessions)) {
    if (name === id + '.json.detached-acp') continue;
    const file = path.join(sessions, name);
    if (name.startsWith(id + '.')) uncertain();
    if (name.endsWith('.json')) {
      const pointer = await json(file);
      if (typeof pointer?.id !== 'string' || ids.includes(pointer.id.toLowerCase())) uncertain();
    } else if (name.endsWith('.json.detached-acp')) {
      if (!await directory(file) || (await archivedSessions(file)).some(value => ids.includes(value))) uncertain();
    } else if (name.endsWith('.native-schedules')) {
      const owner = await json(file);
      if (typeof owner?.sessionId !== 'string' || ids.includes(owner.sessionId.toLowerCase())) uncertain();
    }
  }
  const homes = path.dirname(target);
  if (!await directory(homes)) uncertain();
  const siblings = (await fs.readdir(homes)).filter(name => name !== id).map(name => path.join(homes, name));
  for (const home of [path.dirname(root), ...siblings]) {
    const scope = path.join(home, '.gemini', 'antigravity-cli');
    for (const dir of [home, path.join(home, '.gemini'), scope, path.join(scope, 'brain'), path.join(scope, 'conversations')]) {
      if (!await directory(dir)) continue;
      if (['brain', 'conversations'].includes(path.basename(dir))) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        if (entries.some(entry => entry.isSymbolicLink() || ids.includes(entry.name.toLowerCase().replace(/\.db(?:-.*)?$/, '')))) uncertain();
      }
    }
  }
}

type Entry = { file: string; key: string; identity: string; directory: boolean };
function identity(info: BigIntStats): string {
  const parts = [info.mode, info.dev, info.ino, info.birthtimeNs];
  if (!info.ino || info.birthtimeNs <= 0n) uncertain();
  if (!info.isDirectory()) parts.push(info.nlink, info.size, info.mtimeNs, info.ctimeNs);
  return hash(parts.join('/'));
}

/** Exact auxiliary files only. Recompute locations from the UUID on every retry. */
export async function auxiliaryFiles(config: string, root: string, id: string) {
  const files = [path.join(config, 'codex-sandbox', id + '.json')];
  for (const directory of new Set([config, root])) {
    files.push(path.join(directory, 'dsh-sessions', id + '.json'), path.join(directory, 'dsh-sessions', id + '.handoff.json'));
  }
  const present = [];
  for (const file of files) {
    if (!await directory(path.dirname(file))) continue;
    const info = await stat(file);
    if (!info) continue;
    if (!info.isFile() || info.nlink !== 1n) uncertain();
    present.push({ file, key: hash(file), identity: hash([info.dev, info.ino, info.size, info.ctimeNs, info.birthtimeNs].join('/')) });
  }
  return present;
}
async function anchors(root: string): Promise<Map<string, string>> {
  const roots = new Map<string, string>();
  for (const name of [root, path.join(root, 'agy-homes'), path.join(root, 'agy-sessions')]) {
    const dir = await directory(name);
    if (!dir) uncertain();
    roots.set(name, identity(dir));
  }
  return roots;
}
async function inventory(root: string, id: string, ids: string[], initial: boolean): Promise<Entry[]> {
  const result: Entry[] = [];
  if (!await exclusiveLocalVolume(root)) uncertain();
  const home = path.join(root, 'agy-homes', id);
  const archive = path.join(root, 'agy-sessions', id + '.json.detached-acp');
  const databases = new Set<string>();
  const conversations = path.join(home, '.gemini', 'antigravity-cli', 'conversations');
  const shared = new Set([
    ...['oauth_creds.json', 'google_accounts.json', 'settings.json', 'installation_id', 'trustedFolders.json', 'GEMINI.md', 'skills', 'config'].map(n => path.join('.gemini', n)),
    ...['antigravity-oauth-token', 'settings.json', 'installation_id', 'bin', 'builtin', 'cache', 'updater'].map(n => path.join('.gemini', 'antigravity-cli', n)),
  ]);
  async function walk(file: string, depth: number) {
    if (result.length >= limit || depth > 64 || await fs.realpath(path.dirname(file)) !== path.dirname(file)) uncertain();
    const info = await stat(file);
    if (!info) { if (depth || initial) uncertain(); return; }
    if (!depth && !info.isDirectory()) uncertain();
    const relative = path.relative(home, file);
    if (info.isSymbolicLink()) {
      if (!shared.has(relative) || await fs.readlink(file) !== path.join(path.dirname(root), relative)
        || inside(root, await fs.realpath(file))) uncertain();
    } else if (!info.isDirectory() && (!info.isFile() || info.nlink !== 1n)) uncertain();
    if (path.dirname(file) === conversations) {
      const match = /^([a-zA-Z0-9_-]+)\.db(?:-(?:wal|shm|journal))?$/.exec(path.basename(file));
      if (!match || !info.isFile() || !ids.includes(match[1].toLowerCase())) uncertain();
      if (file.endsWith('.db')) databases.add(match[1].toLowerCase());
    }
    if (path.dirname(file) === path.join(path.dirname(conversations), 'brain') && !ids.includes(path.basename(file).toLowerCase())) uncertain();
    if (path.dirname(file) === home && path.basename(file).startsWith('.remote-cli-agy-hooks')
      && path.basename(file) !== '.remote-cli-agy-hooks.gate') uncertain();
    result.push({ file, key: hash(file), identity: identity(info), directory: info.isDirectory() });
    if (info.isDirectory()) {
      for (const name of await fs.readdir(file)) await walk(path.join(file, name), depth + 1);
    }
  }
  await walk(archive, 0);
  await walk(home, 0);
  if (initial && databases.size !== ids.length) uncertain();
  return result;
}

export async function observeDetachedDeletion(root: string, id: string, sessions: string[], threads: ThreadReference[]): Promise<DetachedDeletion> {
  const record: DetachedDeletion = { version: 1, threadId: id };
  try {
    const entries = await inventory(root, id, sessions, true);
    await checkReferences(root, id, sessions, threads);
    const { host, boot } = bootIdentity();
    const roots = await anchors(root);
    record.proof = { host, boot, sessions, anchors: hash([...roots.values()].join('/')), entries: Object.fromEntries(entries.map(e => [e.key, e.identity])) };
    record.checksum = hash(JSON.stringify([id, record.proof]));
  } catch { /* Logical deletion remains available when this history cannot be erased automatically. */ }
  return record;
}

/** Reconstruct every path from current UUID-owned roots. Missing entries permit replay after partial cleanup. */
export async function collectDetachedDeletion(root: string, id: string, record: DetachedDeletion, threads: ThreadReference[]): Promise<boolean> {
  const proof = record?.proof;
  if (!threadUuid.test(id) || record.version !== 1 || record.threadId !== id || record.completed || !proof
    || !Array.isArray(proof.sessions) || !proof.sessions.length || proof.sessions.some(s => typeof s !== 'string' || !sessionId.test(s))
    || !proof.entries || typeof proof.boot !== 'string' || !proof.boot || record.checksum !== hash(JSON.stringify([id, proof]))) return false;
  try {
    const current = bootIdentity();
    if (process.platform !== 'linux' || current.host !== proof.host || current.boot === proof.boot) return false;
    const directories = await anchors(root);
    if (hash([...directories.values()].join('/')) !== proof.anchors) return false;
    await checkReferences(root, id, proof.sessions, threads);
    const entries = await inventory(root, id, proof.sessions, false);
    if (entries.some(e => proof.entries[e.key] !== e.identity)) return false;
    for (const entry of entries) if (entry.directory) directories.set(entry.file, entry.identity);
    // Children precede parents, with rmdir (never recursive rm) refusing newly added contents.
    for (const entry of entries.reverse()) {
      const parent = path.dirname(entry.file);
      const handle = await fs.open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const directoryId = directories.get(parent);
        const descriptor = `/proc/self/fd/${handle.fd}`;
        if (identity(await handle.stat({ bigint: true })) !== directoryId
          || identity(await fs.stat(descriptor, { bigint: true })) !== directoryId) uncertain();
        const leaf = path.join(descriptor, path.basename(entry.file));
        const fresh = await stat(leaf);
        if (!fresh || identity(fresh) !== entry.identity) uncertain();
        if (entry.directory) await fs.rmdir(leaf);
        else await fs.unlink(leaf);
        await handle.sync();
      } finally { await handle.close(); }
    }
    return true;
  } catch { return false; }
}
