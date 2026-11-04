import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { stableHistoryHash, verifyHistoryDirectory, validHistoryDirectory } from './NativeHistoryFiles';
import type { NativeDirectoryIdentity } from './NativeSessionDeletion';
import { deleteOwnedZCodeSession, validZCodeDeletionTarget, validZCodeDeletionPreparation, type ZCodeDeletionTarget,
  type ZCodeDeletionPreparation, type ZCodeArtifactReceipt, type ZCodeDeletionRecovery,
  type ZCodeDeletionFactory } from './ZCodeSessionDeletion';
import { ZCodeClient } from '../executor/zcode/ZCodeClient';
import { resolveZCodeLaunch, type ZCodeLaunchSpec } from '../executor/zcode/ZCodeCommand';
import type { ZCodeStorageSelection } from '../executor/zcode/ZCodeStorageSelection';

// Format contract: zai-org/ZCode@a9fe401eede6e6e5e01be9048679c206fe6f02d9,
// session-store/repositories/sessions.ts and session-data-files/index.ts.
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const LANE = /^delegate-lane-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const OWNED_TYPES = new Set(['selection_side_chat', 'workflow_child', 'subagent_child', 'nested_workflow_child']);
const INDEPENDENT_TYPES = new Set(['interactive', 'fork', 'workflow_parent', null]);
const FILE_KINDS = ['artifacts', 'exec', 'agents', 'sessions'];
const LIMIT = 4096;
const MAX_BYTES = 256 * 1024 * 1024;
type Identity = NativeDirectoryIdentity;
interface Marker { version: 1; lane: string; namespace: Identity; storage: Identity; roots: Record<string, string> }
export interface ZCodeOwnedNamespace {
  home: Identity; namespace: Identity; storage: Identity; pointerRoot: Identity; pointer: string;
  lane: string; database: string;
}
export interface ZCodeOwnedTarget extends ZCodeDeletionTarget {
  ownership: { contract: 'zcode-exclusive-storage-v1' | 'zcode-shared-storage-v1'; namespace: Identity; database: Identity;
    databaseParent?: Identity;
    pointerRoot: Identity; pointer: string; initialRow: 'reserved' | 'persisted';
    launch?: { command: string; args: string[] } };
}
interface SharedMarker { version: 2; lane: string; namespace: Identity;
  roots: Record<string, { hash: string; target: ZCodeOwnedTarget; phase: 'reserved' | 'prompted' | 'confirmed' }> }
const shared = (target: ZCodeOwnedTarget) => target.ownership.contract === 'zcode-shared-storage-v1';
interface Database { prepare(sql: string): { all(...values: unknown[]): Record<string, any>[] }; close(): void }
interface Inventory { sessions: Record<string, any>[]; links: Record<string, any>[] }
interface ExportManifest { version: 1; targetHash: string; sessionIds: string[];
  files: { name: string; size: number; hash: string }[] }
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const absent = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';
function identity(file: string, directory = true): Identity {
  const stat = fs.lstatSync(file, { bigint: true });
  if (fs.realpathSync(file) !== file || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)
    || !stat.ino || process.getuid && stat.uid !== BigInt(process.getuid())) throw new Error('ZCode storage identity is unavailable');
  return { path: file, dev: String(stat.dev), ino: String(stat.ino) };
}
function sameIdentity(expected: Identity, directory = true): void {
  if (stableHistoryHash(identity(expected.path, directory)) !== stableHistoryHash(expected)) throw new Error('ZCode storage identity changed');
}
function mkdir(directory: string): Identity {
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory) throw new Error('Invalid ZCode directory');
  let current = path.parse(directory).root;
  for (const component of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      if (!fs.lstatSync(current).isDirectory()) throw new Error('Redirected ZCode directory');
    } catch (error) {
      if (!absent(error)) throw error;
      fs.mkdirSync(current, { mode: 0o700 });
      syncDirectory(path.dirname(current));
    }
  }
  return identity(directory);
}
function json(file: string): any {
  identity(file, false);
  if (fs.statSync(file).size > MAX_BYTES) throw new Error('ZCode metadata exceeds the supported bound');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function durable(file: string, bytes: Buffer | string): void {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function syncDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function saveMarker(marker: Marker | SharedMarker): void {
  const file = path.join(marker.namespace.path, 'ownership.json');
  const temporary = file + '.' + randomUUID();
  durable(temporary, JSON.stringify(marker));
  fs.renameSync(temporary, file); syncDirectory(marker.namespace.path);
}
function readSharedMarker(ns: Identity, lane: string): SharedMarker {
  sameIdentity(ns);
  const marker = json(path.join(ns.path, 'ownership.json')) as SharedMarker;
  if (marker.version !== 2 || marker.lane !== lane || stableHistoryHash(marker.namespace) !== stableHistoryHash(ns)
    || !marker.roots || Array.isArray(marker.roots) || Object.keys(marker.roots).length > LIMIT) throw new Error('ZCode shared ownership marker changed');
  return marker;
}
function readMarker(ns: Identity, lane: string): Marker {
  sameIdentity(ns);
  const marker = json(path.join(ns.path, 'ownership.json')) as Marker;
  if (marker.version !== 1 || marker.lane !== lane || stableHistoryHash(marker.namespace) !== stableHistoryHash(ns)
    || !marker.roots || Array.isArray(marker.roots) || Object.keys(marker.roots).length > LIMIT) throw new Error('ZCode ownership marker changed');
  sameIdentity(marker.storage);
  if (marker.storage.path !== path.join(ns.path, 'storage')) throw new Error('ZCode storage escaped its namespace');
  return marker;
}

/** Called before native creation. Existing ordinary/adopted pointers are never migrated. */
export function provisionZCodeOwnedHistory(home: string, lane: string, pointer: string): ZCodeOwnedNamespace | undefined {
  if (!LANE.test(lane)) throw new Error('ZCode ownership requires a managed lane');
  const homeIdentity = identity(home);
  const pointerRoot = identity(path.dirname(pointer));
  if (path.basename(pointer) !== lane + '.json') throw new Error('Unexpected ZCode pointer');
  const nsPath = path.join(home, '.remote-cli', 'zcode-owned', lane);
  let saved: any;
  try { saved = json(pointer); } catch (e) { if (!absent(e)) throw e; }
  let ns: Identity;
  let marker: Marker;
  if (fs.existsSync(nsPath)) {
    ns = identity(nsPath); marker = readMarker(ns, lane);
    if (saved && (saved.adopted === true || !marker.roots[saved.id])) return undefined;
  } else {
    if (saved) return undefined;
    ns = mkdir(nsPath);
    marker = { version: 1, lane, namespace: ns, storage: mkdir(path.join(nsPath, 'storage')), roots: {} };
    saveMarker(marker);
  }
  return { home: homeIdentity, namespace: ns, storage: marker.storage, pointerRoot, pointer, lane,
    database: path.join(marker.storage.path, 'sessions.sqlite') };
}

/**
 * Storage is not a history-only setting: it also selects agents, plugins and
 * memory; the SQLite database contains local permission preferences. Never
 * manufacture these overrides to obtain deletion ownership. A caller that
 * already explicitly selected this namespace can retain its existing settings.
 */
function explicitlyConfigured(launch: ZCodeLaunchSpec, storage: string, database: string): boolean {
  const aliases = [launch.env.ZCODE_SESSION_DB_PATH, launch.env.ZCODE_SESSION_DB].filter(value => value !== undefined);
  return launch.env.ZCODE_STORAGE_DIR === storage && aliases.length > 0 && aliases.every(value => value === database);
}

/** Do not read, copy, or reinterpret native user/project configuration files. */
export function configuredZCodeOwnedHistory(launch: ZCodeLaunchSpec, home: string, lane: string, pointer: string): ZCodeOwnedNamespace | undefined {
  if (!LANE.test(lane)) throw new Error('ZCode ownership requires a managed lane');
  const namespace = path.join(home, '.remote-cli', 'zcode-owned', lane);
  const storage = path.join(namespace, 'storage');
  if (explicitlyConfigured(launch, storage, path.join(storage, 'sessions.sqlite'))) {
    return provisionZCodeOwnedHistory(home, lane, pointer);
  }
  // An old private pointer must not be resumed against a different database or
  // silently replaced after "session not found". Keep its receipt/history intact.
  if (fs.existsSync(namespace) && fs.existsSync(pointer)) {
    const marker = readMarker(identity(namespace), lane);
    const saved = json(pointer);
    if (typeof saved?.id === 'string' && Object.hasOwn(marker.roots, saved.id)) {
      throw new Error('ZCode context uses previously isolated storage. Restore its explicit storage configuration or clear this worker context before continuing; history was retained.');
    }
  }
  return undefined;
}

/** Validate an explicit choice; this function must not change effective settings. */
export function ownedZCodeLaunch(launch: ZCodeLaunchSpec, ns: ZCodeOwnedNamespace): ZCodeLaunchSpec {
  readMarker(ns.namespace, ns.lane);
  if (!explicitlyConfigured(launch, ns.storage.path, ns.database)) {
    throw new Error('ZCode history isolation would change native configuration; automatic cleanup is unavailable');
  }
  return { ...launch, args: [...launch.args], env: { ...launch.env } };
}

function withDatabase<T>(file: string, callback: (db: Database) => T): T {
  const before = identity(file, false);
  // Read-only SQLite does not bootstrap ZCode, migrate schemas, or load providers/plugins.
  // Older Node runtimes without node:sqlite leave ownership unconfirmed.
  const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (file: string, options: { readOnly: boolean }) => Database };
  const db = new DatabaseSync(file, { readOnly: true });
  try { db.prepare('BEGIN').all(); const result = callback(db); sameIdentity(before, false); return result; } finally { db.close(); }
}
function rows(db: Database, sql: string, ...params: unknown[]): Record<string, any>[] {
  const result = db.prepare(sql + ' LIMIT 4097').all(...params);
  if (result.length > LIMIT) throw new Error('ZCode inventory exceeds the supported bound');
  return result;
}

/** Record a native reservation without redirecting storage or copying configuration. */
export function captureZCodeSharedHistory(home: string, lane: string, pointer: string, selected: ZCodeStorageSelection,
  sessionId: string, cwd: string, command: string, launch: Pick<ZCodeLaunchSpec, 'command' | 'args'>): ZCodeOwnedTarget {
  if (!LANE.test(lane) || !/^sess_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(sessionId)
    || path.resolve(cwd) !== cwd || path.basename(pointer) !== lane + '.json') throw new Error('Unsupported ZCode creation metadata');
  const namespace = mkdir(path.join(home, '.remote-cli', 'zcode-shared', lane));
  const marker = fs.existsSync(path.join(namespace.path, 'ownership.json')) ? readSharedMarker(namespace, lane)
    : { version: 2 as const, lane, namespace, roots: {} } as SharedMarker;
  if (marker.roots[sessionId]) throw new Error('ZCode new-session reply reused an existing identity');
  // The audited create operation reserves an ID before writing any session row.
  // Existing IDs are never adopted as newly created, even with matching cwd.
  if (withDatabase(selected.database, db => rows(db, 'SELECT id FROM session WHERE id = ?', sessionId)).length) {
    throw new Error('ZCode creation returned a pre-existing persisted session');
  }
  const target: ZCodeOwnedTarget = { version: 1, backend: 'zcode', nativeVersion: 'zcode-session-data-v4', provenance: 'created',
    sessionId, executorThreadId: lane, cwd, command, home: identity(home), nativeHome: identity(selected.storage),
    pointerHash: stableHistoryHash({ id: sessionId, cwd }), ownership: { contract: 'zcode-shared-storage-v1', namespace,
      database: identity(selected.database, false), databaseParent: identity(path.dirname(selected.database)),
      pointerRoot: identity(path.dirname(pointer)), pointer, initialRow: 'reserved', launch: { command: launch.command, args: [...launch.args] } } };
  if (!validZCodeOwnedTarget(target)) throw new Error('Invalid ZCode shared receipt');
  marker.roots[sessionId] = { hash: stableHistoryHash(target), target, phase: 'reserved' }; saveMarker(marker);
  return target;
}

/** Durable prompt fence also covers resume after process recreation. No receipt/hash migration. */
export function observeZCodeSharedPrompt(home: string, lane: string, sessionId: string, selected: ZCodeStorageSelection, confirmed: boolean): void {
  const ns = identity(path.join(home, '.remote-cli', 'zcode-shared', lane));
  const marker = readSharedMarker(ns, lane); const entry = marker.roots[sessionId];
  if (!entry || !validZCodeOwnedTarget(entry.target) || !shared(entry.target) || entry.hash !== stableHistoryHash(entry.target)
    || entry.target.nativeHome.path !== selected.storage || entry.target.ownership.database.path !== selected.database) throw new Error('ZCode resumed storage is not owned');
  owned(entry.target);
  if (stableHistoryHash(json(entry.target.ownership.pointer)) !== entry.target.pointerHash) throw new Error('ZCode resumed pointer is not owned');
  if (confirmed) {
    const found = withDatabase(selected.database, db => rows(db, 'SELECT id, parent_id, directory, time_deleted FROM session WHERE id = ?', sessionId));
    if (found.length !== 1 || found[0].parent_id !== null || found[0].directory !== entry.target.cwd || found[0].time_deleted !== null) {
      throw new Error('ZCode prompted session was not confirmed in its original database');
    }
  }
  entry.phase = confirmed ? 'confirmed' : 'prompted'; saveMarker(marker);
}

/** Must finish, including the store observer, before the first model prompt. */
export function captureZCodeOwnedHistory(ns: ZCodeOwnedNamespace, sessionId: string, cwd: string, command: string,
  beforePointerSave = false, launch?: Pick<ZCodeLaunchSpec, 'command' | 'args'>): ZCodeOwnedTarget {
  if (!ID.test(sessionId) || path.resolve(cwd) !== cwd) throw new Error('Invalid ZCode creation metadata');
  sameIdentity(ns.home); sameIdentity(ns.pointerRoot);
  const marker = readMarker(ns.namespace, ns.lane);
  // The executor can observe the native create reply before ACP saves its pointer.
  // This records the expected binding without changing or adopting an old pointer.
  const pointer = beforePointerSave ? { id: sessionId, cwd } : json(ns.pointer);
  if (pointer.id !== sessionId || pointer.cwd !== cwd || pointer.adopted === true) throw new Error('ZCode pointer is not newly owned');
  const session = withDatabase(ns.database, db => rows(db, 'SELECT id, parent_id, directory, time_deleted FROM session WHERE id = ?', sessionId));
  // Native session/create reserves an ID; events.ts persists its row on the first
  // activity. The creation reply and exclusive database bind this reservation.
  if (session.length > 1 || session.length === 1 && (session[0].parent_id !== null || session[0].directory !== cwd || session[0].time_deleted != null)) throw new Error('ZCode creation was not confirmed');
  const target: ZCodeOwnedTarget = { version: 1, backend: 'zcode', nativeVersion: 'zcode-session-data-v4', provenance: 'created',
    sessionId, executorThreadId: ns.lane, cwd, command, home: ns.home, nativeHome: ns.storage,
    pointerHash: stableHistoryHash(pointer), ownership: { contract: 'zcode-exclusive-storage-v1', namespace: ns.namespace,
      database: identity(ns.database, false), pointerRoot: ns.pointerRoot, pointer: ns.pointer,
      initialRow: session.length ? 'persisted' : 'reserved',
      ...(launch ? { launch: { command: launch.command, args: [...launch.args] } } : {}) } };
  const hash = stableHistoryHash(target);
  if (marker.roots[sessionId] && marker.roots[sessionId] !== hash) throw new Error('ZCode creation receipt changed');
  marker.roots[sessionId] = hash; saveMarker(marker);
  return target;
}

/** Pure persisted-shape check for the shared store; never rewrites old receipts. */
export function validZCodeOwnedTarget(value: unknown): value is ZCodeOwnedTarget {
  if (!validZCodeDeletionTarget(value)) return false;
  const o = (value as ZCodeOwnedTarget).ownership;
  return !!o && ['zcode-exclusive-storage-v1', 'zcode-shared-storage-v1'].includes(o.contract) && ['reserved', 'persisted'].includes(o.initialRow)
    && validHistoryDirectory(o.namespace) && validHistoryDirectory(o.database) && validHistoryDirectory(o.pointerRoot)
    && o.namespace.path === path.join(value.home.path, '.remote-cli', o.contract === 'zcode-shared-storage-v1' ? 'zcode-shared' : 'zcode-owned', value.executorThreadId)
    && (o.contract === 'zcode-shared-storage-v1' ? validHistoryDirectory(o.databaseParent)
      && o.databaseParent!.path === path.dirname(o.database.path) && !!o.launch
      : o.database.path === path.join(value.nativeHome.path, 'sessions.sqlite'))
    && o.pointer === path.join(o.pointerRoot.path, value.executorThreadId + '.json')
    && (!o.launch || typeof o.launch.command === 'string' && !!o.launch.command && !o.launch.command.includes('\0')
      && Array.isArray(o.launch.args) && o.launch.args.length <= 64 && o.launch.args.every(arg => typeof arg === 'string' && !arg.includes('\0')));
}
function owned(target: ZCodeDeletionTarget): asserts target is ZCodeOwnedTarget {
  if (!validZCodeOwnedTarget(target)) throw new Error('Missing ZCode exclusive ownership');
  const o = target.ownership;
  sameIdentity(target.home); sameIdentity(target.nativeHome); sameIdentity(o.database, false); sameIdentity(o.pointerRoot);
  if (shared(target)) {
    sameIdentity(o.databaseParent!);
    const entry = readSharedMarker(o.namespace, target.executorThreadId).roots[target.sessionId];
    if (!entry || entry.hash !== stableHistoryHash(target) || stableHistoryHash(entry.target) !== entry.hash
      || !['reserved', 'prompted', 'confirmed'].includes(entry.phase)) throw new Error('ZCode shared receipt is not owned');
    return;
  }
  const marker = readMarker(o.namespace, target.executorThreadId);
  if (stableHistoryHash(marker.storage) !== stableHistoryHash(target.nativeHome)
    || marker.roots[target.sessionId] !== stableHistoryHash(target)) throw new Error('ZCode creation receipt is not owned');
}

function checkPointers(target: ZCodeOwnedTarget, ids: readonly string[], detached: boolean): void {
  const files = fs.readdirSync(target.ownership.pointerRoot.path).filter(x => x.endsWith('.json'));
  if (files.length > LIMIT) throw new Error('ZCode pointer inventory exceeds the supported bound');
  let matched = false;
  for (const name of files) {
    const file = path.join(target.ownership.pointerRoot.path, name);
    const pointer = json(file);
    // An unrelated valid native ID, including non-UUID IDs, is not a conflict.
    if (!pointer || typeof pointer.id !== 'string' || !ID.test(pointer.id)) throw new Error('Invalid ZCode pointer inventory');
    if (!ids.includes(pointer.id)) continue;
    if (file !== target.ownership.pointer || pointer.id !== target.sessionId || pointer.adopted === true
      || stableHistoryHash(pointer) !== target.pointerHash) throw new Error('ZCode history is referenced by another pointer');
    matched = true;
  }
  if (!matched && !detached) throw new Error('ZCode pointer detached without authorization');
}

function inventory(target: ZCodeOwnedTarget, expected: readonly string[] = []): Inventory {
  if (shared(target)) return withDatabase(target.ownership.database.path, db => {
    const seen = new Set([target.sessionId, ...expected]); const sessions: Record<string, any>[] = []; const links: Record<string, any>[] = [];
    for (const id of seen) {
      if (seen.size > LIMIT) throw new Error('ZCode owned closure exceeds the supported bound');
      sessions.push(...rows(db, 'SELECT id, parent_id, directory, task_type, time_deleted FROM session WHERE id = ?', id));
      const children = rows(db, 'SELECT id, task_type FROM session WHERE parent_id = ?', id);
      if (children.some(child => !OWNED_TYPES.has(child.task_type) && !INDEPENDENT_TYPES.has(child.task_type))) throw new Error('Unknown ZCode descendant ownership format');
      const edges = rows(db, 'SELECT parent_session_id, child_session_id FROM session_task_link WHERE parent_session_id = ? OR child_session_id = ?', id, id);
      links.push(...edges);
      for (const child of children) if (OWNED_TYPES.has(child.task_type)) seen.add(child.id);
      for (const edge of edges) if (edge.parent_session_id === id) seen.add(edge.child_session_id);
      if (links.length > LIMIT * 4) throw new Error('ZCode link inventory exceeds the supported bound');
    }
    return { sessions, links };
  });
  return withDatabase(target.ownership.database.path, db => ({
    sessions: rows(db, 'SELECT id, parent_id, directory, task_type, time_deleted FROM session'),
    links: rows(db, 'SELECT parent_session_id, child_session_id FROM session_task_link'),
  }));
}

function inspectSharedTree(target: ZCodeOwnedTarget, prepared: ZCodeDeletionPreparation | undefined, detached: boolean): string[] {
  const { sessions, links } = inventory(target, prepared?.sessionIds);
  const byId = new Map(sessions.map(row => [row.id, row]));
  if (byId.size !== sessions.length || sessions.some(row => !ID.test(row.id) || row.time_deleted !== null
    || row.parent_id !== null && !ID.test(row.parent_id) || row.task_type === 'fork'
    || !OWNED_TYPES.has(row.task_type) && !INDEPENDENT_TYPES.has(row.task_type))) throw new Error('Unsupported ZCode owned session metadata');
  for (const link of links) if (!byId.has(link.parent_session_id) || !byId.has(link.child_session_id)) throw new Error('ZCode tree has a foreign or dangling task reference');
  let ids: string[];
  const root = byId.get(target.sessionId);
  if (root) {
    if (root.parent_id !== null || root.directory !== target.cwd || links.some(link => link.child_session_id === target.sessionId)) throw new Error('ZCode root identity changed');
    ids = [...byId.keys()].sort();
    for (const row of sessions) if (row.parent_id !== null && !byId.has(row.parent_id)) throw new Error('ZCode descendant has a foreign parent');
    // No other independently recorded root may be consumed by this cascade.
    for (const kind of ['zcode-shared', 'zcode-owned']) {
      const base = path.join(target.home.path, '.remote-cli', kind);
      if (!fs.existsSync(base)) continue;
      identity(base);
      const lanes = fs.readdirSync(base);
      if (lanes.length > LIMIT) throw new Error('ZCode receipt inventory exceeds the supported bound');
      for (const lane of lanes) {
        if (!LANE.test(lane)) throw new Error('Unexpected ZCode receipt namespace');
        const ns = identity(path.join(base, lane));
        // A failed capture can create the directory before its marker. It does
        // not establish any ownership and cannot authorize deletion itself.
        if (!fs.existsSync(path.join(ns.path, 'ownership.json'))) continue;
        if (kind === 'zcode-shared') {
          const marker = readSharedMarker(ns, lane);
          for (const id of ids) {
            const entry = marker.roots[id];
            if (!entry) continue;
            if (!validZCodeOwnedTarget(entry.target) || entry.hash !== stableHistoryHash(entry.target)) throw new Error('Invalid ZCode receipt inventory');
            if (entry.target.ownership.database.path === target.ownership.database.path
              && (lane !== target.executorThreadId || id !== target.sessionId)) throw new Error('ZCode cascade includes an independent root');
          }
        } else {
          const marker = readMarker(ns, lane);
          if (path.join(marker.storage.path, 'sessions.sqlite') === target.ownership.database.path && ids.some(id => marker.roots[id])) {
            throw new Error('ZCode cascade includes an exclusive root');
          }
        }
      }
    }
    if (prepared && JSON.stringify(ids) !== JSON.stringify(prepared.sessionIds)) throw new Error('ZCode cascade changed');
  } else {
    const phase = readSharedMarker(target.ownership.namespace, target.executorThreadId).roots[target.sessionId].phase;
    if (sessions.length || links.length || !prepared && phase !== 'reserved') throw new Error('ZCode prompted or partial history has no confirmed root');
    ids = prepared?.sessionIds ?? [target.sessionId];
    withDatabase(target.ownership.database.path, db => {
      for (const table of ['dwf_run', 'workflow_run']) {
        if (rows(db, `SELECT id FROM ${table} WHERE parent_session_id IN (${ids.map(() => '?').join(',')})`, ...ids).length) throw new Error('ZCode absent root has orphan outputs');
      }
      for (const table of ['part', 'input_history']) {
        if (rows(db, `SELECT id FROM ${table} WHERE session_id IN (${ids.map(() => '?').join(',')})`, ...ids).length) throw new Error('ZCode absent root has orphan activity');
      }
    });
  }
  checkPointers(target, ids, detached);
  // Foreign artifact references are checked by native purge. Do not read other
  // sessions' part/transcript text in our shared-store preflight.
  return ids;
}

export async function inspectZCodeOwnedTree(target: ZCodeDeletionTarget, prepared?: ZCodeDeletionPreparation, detached = false): Promise<string[]> {
  owned(target);
  if (prepared && !validZCodeDeletionPreparation(target, prepared)) throw new Error('ZCode preparation changed');
  if (shared(target)) return inspectSharedTree(target, prepared, detached);
  const { sessions, links } = inventory(target);
  const byId = new Map(sessions.map(row => [row.id, row]));
  if (byId.size !== sessions.length || sessions.some(row => !ID.test(row.id) || row.parent_id !== null && !ID.test(row.parent_id))) throw new Error('Unsupported ZCode session metadata');
  for (const link of links) if (!byId.has(link.parent_session_id) || !byId.has(link.child_session_id)) throw new Error('Incomplete ZCode task link');
  const walk = (root: string): Set<string> => {
    const seen = new Set<string>([root]);
    for (const id of seen) {
      const children = sessions.filter(row => row.parent_id === id && OWNED_TYPES.has(row.task_type)).map(row => row.id);
      children.push(...links.filter(row => row.parent_session_id === id).map(row => row.child_session_id));
      for (const child of children) { if (child === root) throw new Error('Cyclic ZCode ownership'); seen.add(child); }
    }
    return seen;
  };
  const marker = readMarker(target.ownership.namespace, target.executorThreadId);
  const covered = new Set<string>();
  for (const root of Object.keys(marker.roots).filter(id => byId.has(id))) {
    const record = byId.get(root)!;
    if (record.parent_id !== null || record.time_deleted != null) throw new Error('ZCode root changed');
    for (const id of walk(root)) { if (covered.has(id)) throw new Error('ZCode tree is shared between owned roots'); covered.add(id); }
  }
  if (sessions.some(row => !covered.has(row.id))) throw new Error('ZCode namespace contains foreign or orphan sessions');
  let ids: string[];
  if (byId.has(target.sessionId)) {
    if (byId.get(target.sessionId)!.directory !== target.cwd) throw new Error('ZCode workspace changed');
    ids = [...walk(target.sessionId)].sort();
    if (prepared && JSON.stringify(ids) !== JSON.stringify(prepared.sessionIds)) throw new Error('ZCode cascade changed');
  } else {
    if (!prepared && target.ownership.initialRow !== 'reserved' || prepared?.sessionIds.some(id => byId.has(id))) throw new Error('ZCode missing root has no complete preparation');
    ids = prepared?.sessionIds ?? [target.sessionId];
    withDatabase(target.ownership.database.path, db => {
      for (const table of ['dwf_run', 'workflow_run']) {
        if (rows(db, `SELECT id FROM ${table} WHERE parent_session_id IN (${ids.map(() => '?').join(',')})`, ...ids).length) throw new Error('ZCode missing root has orphan workflow outputs');
      }
    });
  }
  checkPointers(target, ids, detached);
  // Native purge also checks artifact references. Preflight them before exporting.
  withDatabase(target.ownership.database.path, db => {
    for (const row of rows(db, "SELECT session_id, data FROM part WHERE data LIKE '%zcode-artifact://%'")) {
      if (ids.includes(row.session_id)) continue;
      for (const match of String(row.data).matchAll(/zcode-artifact:\/\/([^/"\\\s]+)\//g)) {
        if (ids.includes(decodeURIComponent(match[1]))) throw new Error('ZCode artifacts have a foreign reference');
      }
    }
  });
  return ids;
}

function databaseOutputs(target: ZCodeOwnedTarget, ids: readonly string[]): Buffer {
  return withDatabase(target.ownership.database.path, db => {
    const marks = ids.map(() => '?').join(',');
    const result: Record<string, unknown> = {};
    // Preserve deliverables, not the session/message/entry/input-history transcript.
    for (const table of ['dwf_run', 'workflow_run']) {
      const columns = table === 'dwf_run' ? 'id, parent_session_id, script_text, result_json, failure_json' : 'id, parent_session_id, script_path';
      const runs = rows(db, `SELECT ${columns} FROM ${table} WHERE parent_session_id IN (${marks}) ORDER BY id`, ...ids);
      result[table] = runs;
      const runIds = runs.map(row => row.id);
      const runMarks = runIds.map(() => '?').join(',');
      const child = table === 'dwf_run' ? 'dwf_node' : 'workflow_activity';
      result[child] = runIds.length ? rows(db, `SELECT id, run_id, result_json, error_json FROM ${child} WHERE run_id IN (${runMarks}) ORDER BY id`, ...runIds) : [];
      const events = table === 'dwf_run' ? 'dwf_event' : 'workflow_event';
      result[events] = runIds.length ? rows(db, `SELECT run_id, sequence, type, payload_json FROM ${events} WHERE run_id IN (${runMarks}) AND (type LIKE '%artifact%' OR type = 'report') ORDER BY run_id, sequence`, ...runIds) : [];
    }
    result.attachments = rows(db, `SELECT id, session_id, attachments FROM input_history WHERE session_id IN (${marks}) AND attachments IS NOT NULL ORDER BY id`, ...ids);
    result.parts = rows(db, `SELECT id, session_id, json_extract(data, '$.type') AS type, data FROM part WHERE session_id IN (${marks}) AND json_extract(data, '$.type') IN ('file', 'image', 'tool') ORDER BY id`, ...ids)
      .map(row => {
        const data = JSON.parse(row.data);
        if (row.type !== 'tool') return row;
        return { id: row.id, session_id: row.session_id, type: row.type,
          output: data.state?.output, attachments: data.state?.attachments, metadata: data.state?.metadata };
      });
    const bytes = Buffer.from(JSON.stringify(result));
    if (bytes.length > MAX_BYTES) throw new Error('ZCode database outputs exceed the export bound');
    return bytes;
  });
}

/** Read only single components through live directory descriptors on Linux. */
function readFiles(root: string, anchors: readonly Identity[] = []): Map<string, Buffer> {
  if (process.platform !== 'linux') throw new Error('ZCode export anchoring requires Linux');
  const result = new Map<string, Buffer>();
  const handles: number[] = [];
  let total = 0, directories = 0;
  let entered = false;
  try {
    let parent = fs.openSync(path.parse(root).root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    handles.push(parent);
    let current = path.parse(root).root;
    for (const component of root.slice(current.length).split(path.sep).filter(Boolean)) {
      parent = fs.openSync(`/proc/self/fd/${parent}/${component}`, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      handles.push(parent);
      current = path.join(current, component);
      const expected = anchors.find(value => value.path === current);
      if (expected) {
        const stat = fs.fstatSync(parent, { bigint: true });
        if (String(stat.ino) !== expected.ino || String(stat.dev) !== expected.dev) throw new Error('ZCode export ancestor changed');
      }
    }
    const visit = (fd: number, prefix: string, depth: number): void => {
      if (depth > 64 || ++directories > LIMIT) throw new Error('ZCode export nesting exceeds the supported bound');
      for (const name of fs.readdirSync(`/proc/self/fd/${fd}`).sort()) {
        if (name === '.' || name === '..' || name.includes(path.sep)) throw new Error('Invalid export entry');
        const anchored = `/proc/self/fd/${fd}/${name}`;
        const stat = fs.lstatSync(anchored, { bigint: true });
        if (stat.isDirectory()) {
          const child = fs.openSync(anchored, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
          try { const actual = fs.fstatSync(child, { bigint: true }); if (actual.ino !== stat.ino || actual.dev !== stat.dev) throw new Error('ZCode export directory changed'); visit(child, prefix + name + '/', depth + 1); }
          finally { fs.closeSync(child); }
        } else {
          if (!stat.isFile() || stat.nlink !== 1n || total + Number(stat.size) > MAX_BYTES || result.size >= LIMIT) throw new Error('Unsupported ZCode artifact file');
          const file = fs.openSync(anchored, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          try {
            const before = fs.fstatSync(file, { bigint: true });
            if (before.ino !== stat.ino || before.dev !== stat.dev) throw new Error('ZCode artifact changed');
            const bytes = fs.readFileSync(file); const after = fs.fstatSync(file, { bigint: true });
            if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || after.nlink !== 1n) throw new Error('ZCode artifact changed while reading');
            result.set(prefix + name, bytes); total += bytes.length;
          } finally { fs.closeSync(file); }
        }
      }
    };
    entered = true; visit(parent, '', 0);
  } catch (e) { if (entered || !absent(e)) throw e; /* Absent per-session directories contain no outputs. */ }
  finally { for (const fd of handles.reverse()) fs.closeSync(fd); }
  return result;
}
function nativeFiles(target: ZCodeOwnedTarget, ids: readonly string[]): Map<string, Buffer> {
  const files = new Map<string, Buffer>(); let total = 0;
  for (const kind of FILE_KINDS) for (const id of ids) {
    if (!ID.test(id)) throw new Error('Invalid ZCode export session');
    const cli = path.basename(target.nativeHome.path) === 'cli' ? target.nativeHome.path : path.join(target.nativeHome.path, 'cli');
    for (const [name, bytes] of readFiles(path.join(cli, kind, id), [target.home, target.ownership.namespace, target.nativeHome])) {
      total += bytes.length;
      if (files.size >= LIMIT || total > MAX_BYTES) throw new Error('ZCode exports exceed the supported bound');
      files.set(`${kind}/${id}/${name}`, bytes);
    }
  }
  return files;
}
function exportPath(target: ZCodeOwnedTarget): string {
  return path.join(target.home.path, '.remote-cli', 'zcode-exports', target.executorThreadId, stableHistoryHash(target));
}
export async function preserveZCodeArtifacts(target: ZCodeDeletionTarget, ids: readonly string[]): Promise<ZCodeArtifactReceipt> {
  owned(target);
  const root = exportPath(target);
  if (root === target.cwd || root.startsWith(target.cwd + path.sep)) throw new Error('ZCode exports must be outside the disposable workspace');
  if (fs.existsSync(root)) {
    const receipt = { root: identity(root), manifestHash: digest(fs.readFileSync(path.join(root, 'manifest.json'))) };
    await verifyZCodeArtifacts(receipt, target, ids); return receipt;
  }
  const files = nativeFiles(target, ids); files.set('database-outputs.json', databaseOutputs(target, ids));
  const parent = mkdir(path.dirname(root)); const staging = root + '.' + randomUUID(); mkdir(staging);
  const manifest: ExportManifest = { version: 1, targetHash: stableHistoryHash(target), sessionIds: [...ids], files: [] };
  for (const [name, bytes] of files) {
    mkdir(path.dirname(path.join(staging, name))); durable(path.join(staging, name), bytes);
    syncDirectory(path.dirname(path.join(staging, name)));
    manifest.files.push({ name, size: bytes.length, hash: digest(bytes) });
  }
  const bytes = JSON.stringify(manifest); durable(path.join(staging, 'manifest.json'), bytes); syncDirectory(staging);
  // Persist every intermediate directory entry before publishing the manifest.
  const syncTree = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) syncTree(path.join(directory, entry.name));
    syncDirectory(directory);
  };
  syncTree(staging);
  sameIdentity(parent); fs.renameSync(staging, root); syncDirectory(parent.path);
  const receipt = { root: identity(root), manifestHash: digest(bytes) };
  await verifyZCodeArtifacts(receipt, target, ids); return receipt;
}
export async function verifyZCodeArtifacts(receipt: ZCodeArtifactReceipt, target: ZCodeDeletionTarget, ids: readonly string[]): Promise<void> {
  owned(target);
  await verifyHistoryDirectory(receipt.root);
  if (receipt.root.path !== exportPath(target)) throw new Error('ZCode export root changed');
  const files = readFiles(receipt.root.path, [target.home, receipt.root]); const bytes = files.get('manifest.json');
  if (!bytes || digest(bytes) !== receipt.manifestHash) throw new Error('ZCode export manifest changed');
  const manifest = JSON.parse(bytes.toString()) as ExportManifest;
  if (manifest.version !== 1 || manifest.targetHash !== stableHistoryHash(target) || JSON.stringify(manifest.sessionIds) !== JSON.stringify(ids)
    || !Array.isArray(manifest.files) || files.size !== manifest.files.length + 1) throw new Error('ZCode export receipt changed');
  const expected = new Map<string, string>();
  for (const entry of manifest.files) {
    const data = files.get(entry.name);
    if (!data || expected.has(entry.name) || data.length !== entry.size || digest(data) !== entry.hash) throw new Error('ZCode exported bytes changed');
    expected.set(entry.name, entry.hash);
  }
  for (const [name, bytes] of nativeFiles(target, ids)) if (expected.get(name) !== digest(bytes)) throw new Error('ZCode outputs changed after export');
  // Native purge deletes database rows atomically after files. Missing rows on retry
  // use the immutable export, while surviving rows must still match it exactly.
  if (inventory(target).sessions.some(row => ids.includes(row.id))) {
    if (expected.get('database-outputs.json') !== digest(databaseOutputs(target, ids))) throw new Error('ZCode database outputs changed after export');
  }
}

export type ZCodeOwnedRecovery = Pick<ZCodeDeletionRecovery, 'prepared' | 'persistPrepared' | 'persistMaintenanceState'> & { detachedPointer?: boolean };
/** Shared dispatcher must call this wrapper, after generation/ownership/writer checks. */
export async function deleteOwnedZCodeHistory(target: ZCodeOwnedTarget, recovery: ZCodeOwnedRecovery, factory?: ZCodeDeletionFactory) {
  let prepared = recovery.prepared;
  const result = await deleteOwnedZCodeSession(target, { ...recovery,
    persistPrepared: recovery.persistPrepared ? async value => { await recovery.persistPrepared!(value); prepared = value; } : undefined,
    inspectOwnedTree: (value, prepared) => inspectZCodeOwnedTree(value, prepared, recovery.detachedPointer),
    preserveArtifacts: preserveZCodeArtifacts, verifyArtifacts: verifyZCodeArtifacts,
  }, factory ?? (value => {
    owned(value);
    const launch = resolveZCodeLaunch(value.command);
    // Storage RPCs need no disposable task cwd or project-local model initialization.
    return new ZCodeClient({ cwd: value.nativeHome.path, command: value.command, maintenance: true, delegationWorker: true,
      launch: { ...launch, ...value.ownership.launch, env: { ...launch.env, ZCODE_STORAGE_DIR: value.nativeHome.path,
        ZCODE_SESSION_DB_PATH: value.ownership.database.path, ZCODE_SESSION_DB: value.ownership.database.path } } }, {});
  }));
  if (result.state !== 'deleted') return result;
  try {
    owned(target);
    if (!prepared || inventory(target, prepared.sessionIds).sessions.some(row => prepared!.sessionIds.includes(row.id))) throw new Error('ZCode purge left resumable history');
    if (shared(target)) {
      await inspectZCodeOwnedTree(target, prepared, recovery.detachedPointer);
      if (nativeFiles(target, prepared.sessionIds).size) throw new Error('ZCode purge left native session files');
    }
    await verifyZCodeArtifacts(prepared.artifacts, target, prepared.sessionIds);
    return result;
  } catch {
    return { state: 'uncertain' as const, reason: 'ZCode purge acknowledgement could not be verified; preparation and exports are retained' };
  }
}
