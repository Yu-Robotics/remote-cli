import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  SESSION_CATALOG_MAX_ID,
  SESSION_CATALOG_MAX_MODIFIED_SKEW_MS,
  SESSION_CATALOG_MAX_SETTINGS_BYTES,
  SYNTHETIC_SESSION,
  canonicalPath,
  expandHomePath,
  isInside,
  safeSessionLabel,
  scanSessionCatalogs,
  type SessionCatalog,
  type SessionCatalogCandidate,
  type SessionCatalogOptions,
  type SessionCatalogStore,
} from '../SessionCatalog';

/**
 * Codex rollout headers carry the full base instructions, so a bounded first-line
 * read needs more than the shared 64 KiB header budget. The cap stays a hard
 * resource bound, and oversized headers become an explicit coverage gap.
 */
const CODEX_HEADER_MAX_BYTES = 1024 * 1024;
/** Native date-partitioned rollout layout: sessions/<year>/<month>/<day>/rollout-*.jsonl */
const CODEX_SESSION_DEPTH = 3;

interface CodexHeader {
  id: string;
  cwd: string;
  modifiedAt: number;
  subagent: boolean;
}

/** Read the first LF-terminated line with a hard byte cap; never follows a symlink. */
function readFirstLine(file: string, maxBytes: number): { line: string; complete: boolean } | undefined {
  let fd: number | undefined;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) return undefined;
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(fd);
    if (stat.ino !== before.ino || stat.dev !== before.dev) return undefined;
    const chunks: Buffer[] = [];
    let read = 0;
    const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes));
    while (read < maxBytes) {
      const length = fs.readSync(fd, buffer, 0, Math.min(buffer.length, maxBytes - read), null);
      if (length <= 0) break;
      const slice = buffer.subarray(0, length);
      const newline = slice.indexOf(0x0a);
      if (newline !== -1) {
        chunks.push(slice.subarray(0, newline));
        return { line: Buffer.concat(chunks).toString('utf8'), complete: true };
      }
      chunks.push(Buffer.from(slice));
      read += length;
    }
    return { line: Buffer.concat(chunks).toString('utf8'), complete: false };
  } catch { return undefined; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function headerOf(file: string, threadCwd: string): CodexHeader | undefined {
  const first = readFirstLine(file, CODEX_HEADER_MAX_BYTES);
  if (!first || !first.complete) return undefined;
  let record: { type?: unknown; payload?: Record<string, unknown> };
  try { record = JSON.parse(first.line) as typeof record; } catch { return undefined; }
  if (record.type !== 'session_meta' || !record.payload || typeof record.payload !== 'object') return undefined;
  const payload = record.payload;
  const id = payload.id;
  const cwd = payload.cwd;
  if (typeof id !== 'string' || !id || id.length > SESSION_CATALOG_MAX_ID
    || /[\u0000-\u001f\u007f\s`]/.test(id) || SYNTHETIC_SESSION.test(id)) return undefined;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || canonicalPath(cwd) !== threadCwd) return undefined;
  // Sub-agents and forks belong to another thread's private work, never to the
  // user's local history. Structured `source` plus explicit parent/agent fields
  // identify them independently of any friendly name.
  const subagent = (typeof payload.source === 'object' && payload.source !== null)
    || typeof payload.parent_thread_id === 'string' || typeof payload.agent_path === 'string';
  let modifiedAt: number;
  try { modifiedAt = fs.lstatSync(file).mtimeMs; } catch { return undefined; }
  if (!Number.isFinite(modifiedAt) || modifiedAt - Date.now() > SESSION_CATALOG_MAX_MODIFIED_SKEW_MS) return undefined;
  return { id, cwd, modifiedAt, subagent };
}

/** Bounded read of the native index used only for display names. */
function nativeNames(home: string): Map<string, string> {
  const names = new Map<string, string>();
  const file = path.join(home, 'session_index.jsonl');
  let fd: number | undefined;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size === 0
      || stat.size > SESSION_CATALOG_MAX_SETTINGS_BYTES) return names;
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    for (const line of fs.readFileSync(fd, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
        if (typeof entry.id !== 'string' || typeof entry.thread_name !== 'string') continue;
        const label = safeSessionLabel(entry.thread_name);
        if (label && label.length <= SESSION_CATALOG_MAX_ID) names.set(entry.id, label);
      } catch { /* one malformed line never hides the rest of the index */ }
    }
  } catch { /* a missing or unreadable index only removes display names */ }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return names;
}

/**
 * Native rollout IDs belonging to synthetic delegated workers or temporary
 * metadata executors. Worker-native IDs differ from their executor IDs, so the
 * pointer filename decides the class and the native ID is what gets excluded.
 */
function syntheticRolloutIds(remoteDirectory: string): Set<string> {
  const excluded = new Set<string>();
  const directory = path.join(remoteDirectory, 'codex-sessions');
  let names: string[] = [];
  try { names = fs.readdirSync(directory); } catch { return excluded; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const executorId = name.slice(0, -'.json'.length);
    try {
      const pointer = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')) as { id?: unknown };
      if (typeof pointer.id !== 'string' || !pointer.id) continue;
      // A synthetic pointer always excludes; a foreground pointer also protects
      // the user's own history from the sub-agent heuristic.
      if (SYNTHETIC_SESSION.test(executorId)) excluded.add(pointer.id);
    } catch { /* malformed pointers never grant visibility */ }
  }
  return excluded;
}

/**
 * Read-only discovery of Codex sessions whose recorded workspace equals the
 * thread workspace. It never starts `codex app-server`, reads transcript bodies,
 * migrates files, or writes anything. Counts are left unavailable rather than
 * inferred from a partial record.
 */
export function listCodexSessions(workingDirectory: string, options: SessionCatalogOptions = {}): SessionCatalog {
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;
  const remoteDirectory = options.remoteCliDirectory ?? path.join(home, '.remote-cli');
  const notes: string[] = [];
  const threadCwd = canonicalPath(workingDirectory);
  if (!threadCwd) return { candidates: [], complete: false, notes: ['The thread working directory is unavailable.'] };

  const nativeHome = env.CODEX_HOME ? expandHomePath(env.CODEX_HOME, home) : path.join(home, '.codex');
  if (env.CODEX_HOME && !nativeHome) notes.push('A relative Codex home override was ignored.');
  if (!nativeHome) {
    return { candidates: [], complete: false,
      notes: [...notes, 'The native Codex home could not be resolved.'] };
  }

  const excluded = syntheticRolloutIds(remoteDirectory);
  const names = nativeNames(nativeHome);
  const stores: SessionCatalogStore[] = [
    { directory: path.join(nativeHome, 'sessions'), source: 'native-local', maxDepth: CODEX_SESSION_DEPTH },
    { directory: path.join(nativeHome, 'archived_sessions'), source: 'native-local' },
  ];
  const scan = scanSessionCatalogs(stores, (file, root, store) => {
    let header: CodexHeader | undefined;
    try { header = headerOf(file, threadCwd); } catch { header = undefined; }
    if (!header || header.subagent || excluded.has(header.id)) return undefined;
    const real = canonicalPath(file);
    if (!real || !isInside(root, real)) return undefined;
    return { id: header.id, name: names.get(header.id), source: store.source,
      modifiedAt: header.modifiedAt, messageCount: 0, countComplete: false };
  }, { onGap: (reason, store) => notes.push(reason === 'truncated'
    ? `Some Codex session storage could not be fully scanned (${store.directory.endsWith('archived_sessions') ? 'archived' : 'active'}).`
    : 'The Codex session storage could not be read safely.') });

  if (!fs.existsSync(nativeHome)) notes.push('No local Codex installation directory was found.');
  if (scan.duplicates) notes.push(`${scan.duplicates} duplicated session ID(s) were hidden.`);
  if (scan.candidates.length === 0 && scan.complete) notes.push('No Codex sessions were found for this workspace.');
  if (scan.candidates.length > 0) notes.push('Codex message counts are not available without reading native transcripts.');
  if (!scan.complete && !notes.some(note => note.includes('could not be'))) notes.push('Some Codex session storage could not be fully scanned.');
  return { candidates: scan.candidates, complete: scan.complete, notes };
}
