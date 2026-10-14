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
  readBoundedHead,
  safeSessionLabel,
  scanSessionCatalogs,
  type SessionCatalog,
  type SessionCatalogCandidate,
  type SessionCatalogOptions,
  type SessionCatalogStore,
} from '../SessionCatalog';

/** Safe, bounded metadata for one native Pi session. Never contains transcript content. */
export type PiSessionCandidate = SessionCatalogCandidate;
export type PiSessionCatalog = SessionCatalog;
export type PiCatalogOptions = SessionCatalogOptions;

export { safeSessionLabel };

/** Pi's documented per-project directory encoding under the agent directory. */
export function piProjectDirectoryName(cwd: string): string {
  return `--${path.resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

/** A bounded JSON read for native settings; never follows a symlink and never throws. */
function readJsonFile(file: string): Record<string, unknown> | undefined {
  let fd: number | undefined;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size === 0
      || before.size > SESSION_CATALOG_MAX_SETTINGS_BYTES) return undefined;
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(fd);
    if (stat.ino !== before.ino || stat.dev !== before.dev) return undefined;
    const value: unknown = JSON.parse(fs.readFileSync(fd, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export interface PiSessionDirectoryResolution {
  directory?: string;
  /** Which locally approved configuration produced the directory; never a path. */
  source: 'env-override' | 'project-setting' | 'global-setting' | 'default';
  /** True when an explicit override exists but cannot be used as a safe local path. */
  unresolved: boolean;
  notes: string[];
}

/**
 * Effective Pi session directory, matching Pi's own precedence and path
 * normalization: --session-dir (the launched argv we control, intentionally
 * excluded here), then `PI_CODING_AGENT_SESSION_DIR`, then the native
 * `sessionDir` setting. Pi reads `sessionDir` before project trust is resolved
 * because its session lookup depends on it, so project `.pi/settings.json`
 * overrides the agent-directory file here as well. Unreadable or unsafe files
 * fall through instead of guessing a namespace.
 */
export function resolvePiSessionDirectory(workingDirectory: string, options: PiCatalogOptions = {}): PiSessionDirectoryResolution {
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;
  const notes: string[] = [];
  const override = env.PI_CODING_AGENT_SESSION_DIR;
  if (override) {
    const exact = expandHomePath(override, home);
    if (exact) return { directory: exact, source: 'env-override', unresolved: false, notes };
    notes.push('A relative Pi session directory override was ignored.');
    // Pi would resolve a relative override against its own process cwd, so the
    // real namespace is unknown to us; never fall back to the default store.
    return { source: 'env-override', unresolved: true, notes };
  }
  const agentOverride = env.PI_CODING_AGENT_DIR ? expandHomePath(env.PI_CODING_AGENT_DIR, home) : undefined;
  if (env.PI_CODING_AGENT_DIR && !agentOverride) notes.push('A relative Pi agent directory override was ignored.');
  const agent = agentOverride ?? path.join(home, '.pi', 'agent');
  const configured = (settings: Record<string, unknown> | undefined): string | undefined => {
    const value = settings?.sessionDir;
    if (value === undefined) return undefined;
    if (typeof value !== 'string') { notes.push('A non-string Pi sessionDir setting was ignored.'); return undefined; }
    const expanded = expandHomePath(value, home);
    if (!expanded) { notes.push('A relative Pi sessionDir setting was ignored.'); return undefined; }
    return expanded;
  };
  const project = configured(readJsonFile(path.join(workingDirectory, '.pi', 'settings.json')));
  if (project) return { directory: project, source: 'project-setting', unresolved: false, notes };
  if (env.PI_CODING_AGENT_DIR && !agentOverride) {
    return { source: 'default', unresolved: true, notes };
  }
  const global = configured(readJsonFile(path.join(agent, 'settings.json')));
  if (global) return { directory: global, source: 'global-setting', unresolved: false, notes };
  return { directory: path.join(agent, 'sessions', piProjectDirectoryName(workingDirectory)), source: 'default', unresolved: false, notes };
}

/** Session files referenced by synthetic worker/metadata pointers stay excluded after reuse. */
function syntheticFiles(remoteDirectory: string): Set<string> {
  const excluded = new Set<string>();
  const pointers = path.join(remoteDirectory, 'pi-sessions');
  let names: string[] = [];
  try { names = fs.readdirSync(pointers); } catch { return excluded; }
  for (const name of names) {
    if (!name.endsWith('.json') || !SYNTHETIC_SESSION.test(name)) continue;
    try {
      const pointer = JSON.parse(fs.readFileSync(path.join(pointers, name), 'utf8')) as { sessionFile?: unknown };
      const resolved = typeof pointer.sessionFile === 'string' ? canonicalPath(pointer.sessionFile) : undefined;
      if (resolved) excluded.add(resolved);
    } catch { /* malformed pointers do not grant visibility */ }
  }
  return excluded;
}

/**
 * Local-only locator for a listed Pi session. It never leaves the CLI: chat
 * messages carry only the native ID, and the file is re-resolved before use.
 */
export interface PiSessionLocator {
  id: string;
  file: string;
  /** Changes when the file is replaced, appended or touched after listing. */
  revision: string;
}

function candidate(file: string, root: string, cwd: string, source: PiSessionCandidate['source'],
  excluded: Set<string>, locators?: Map<string, PiSessionLocator>): PiSessionCandidate | undefined {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) return undefined;
  const real = canonicalPath(file);
  if (!real || !isInside(root, real) || excluded.has(real)) return undefined;
  const text = readBoundedHead(real);
  if (text === undefined) return undefined;
  const complete = stat.size <= Buffer.byteLength(text);
  const lines = text.split('\n');
  if (!complete) lines.pop();
  let header: { type?: unknown; id?: unknown; cwd?: unknown };
  try { header = JSON.parse(lines[0]); } catch { return undefined; }
  if (header.type !== 'session' || typeof header.id !== 'string' || !header.id || header.id.length > SESSION_CATALOG_MAX_ID
    || /[\u0000-\u001f\u007f\s`]/.test(header.id) || SYNTHETIC_SESSION.test(header.id) || typeof header.cwd !== 'string') return undefined;
  // Pi documents `cwd` as absolute (`resolvePath` output), and its own discovery
  // compares resolved paths. Reject relative/normalization tricks instead of
  // silently passing them to realpath.
  if (!path.isAbsolute(header.cwd) || canonicalPath(header.cwd) !== cwd) return undefined;
  if (!Number.isFinite(stat.mtimeMs) || stat.mtimeMs - Date.now() > SESSION_CATALOG_MAX_MODIFIED_SKEW_MS) return undefined;
  let name: string | undefined;
  let messages = 0;
  for (const line of lines.slice(1)) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as { type?: unknown; name?: unknown; message?: { role?: unknown } };
      if (entry.type === 'message' && (entry.message?.role === 'user' || entry.message?.role === 'assistant')) messages++;
      // Pi writes the latest session name; keep the last valid one in append order.
      if (entry.type === 'session_info' && typeof entry.name === 'string') name = safeSessionLabel(entry.name);
    } catch { return undefined; }
  }
  if (name && SYNTHETIC_SESSION.test(name)) return undefined;
  locators?.set(`${source}\u0000${header.id}`, { id: header.id, file: real, revision: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}` });
  return { id: header.id, name, source,
    modifiedAt: stat.mtimeMs, messageCount: messages, countComplete: complete };
}

/**
 * Read-only discovery of Pi sessions whose header workspace equals the thread workspace.
 * It never starts Pi, migrates files, follows symlinks, or returns transcript text.
 */
export function listPiSessions(workingDirectory: string, options: PiCatalogOptions = {},
  locators?: Map<string, PiSessionLocator>): PiSessionCatalog {
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;
  const remoteDirectory = options.remoteCliDirectory ?? path.join(home, '.remote-cli');
  const notes: string[] = [];
  const cwd = canonicalPath(workingDirectory);
  if (!cwd) return { candidates: [], complete: false, notes: ['The thread working directory is unavailable.'] };

  const roots: Array<{ directory: string; source: PiSessionCandidate['source'] }> = [];
  const resolved = resolvePiSessionDirectory(cwd, { home, env });
  notes.push(...resolved.notes);
  const nativeDefault = path.join(home, '.pi', 'agent', 'sessions', piProjectDirectoryName(cwd));
  // A configured directory is a different namespace than the cwd-derived
  // default; Pi does not cwd-encode an explicit sessionDir. An unresolvable
  // override means the native namespace is unknown, not the default.
  if (resolved.source === 'project-setting' || resolved.source === 'global-setting') {
    notes.push('Pi session storage is set by a local native sessionDir setting.');
  }
  if (!resolved.unresolved) roots.push({ directory: resolved.directory ?? nativeDefault, source: 'native-local' });
  roots.push({ directory: path.join(remoteDirectory, 'pi-sessions', 'store'), source: 'remote-cli' });

  const excluded = syntheticFiles(remoteDirectory);
  // Coverage gaps are reported per store through the shared scanner so the Pi,
  // Codex and Claude catalogs cannot drift apart on bounds or wording.
  const scan = scanSessionCatalogs(roots, (file, root, store) => candidate(file, root, cwd, store.source, excluded, locators),
    { onGap: (reason, store) => notes.push(reason === 'truncated'
      ? `Some Pi session storage could not be fully scanned (${store.source}).`
      : `Pi session storage could not be read safely (${store.source}).`) });
  if (resolved.unresolved) { notes.push('The native Pi session namespace could not be resolved.'); }
  if (scan.duplicates) notes.push(`${scan.duplicates} duplicated session ID(s) were hidden.`);
  if (!scan.complete && !notes.some(note => note.includes('could not'))) notes.push('Some session storage could not be fully scanned.');
  return { candidates: scan.candidates, complete: scan.complete && !resolved.unresolved, notes };
}

/**
 * Re-resolve a listed session by native ID with the same read-only rules as
 * the catalog. Hidden duplicates and filtered sessions are never resolvable.
 */
export function resolvePiSessionLocator(workingDirectory: string, id: string,
  options: PiCatalogOptions = {}): PiSessionLocator | undefined {
  const locators = new Map<string, PiSessionLocator>();
  const listed = listPiSessions(workingDirectory, options, locators).candidates.find(item => item.id === id);
  return listed ? locators.get(`${listed.source}\u0000${listed.id}`) : undefined;
}

/**
 * Return another remote-cli thread whose Pi pointer references the file, so one
 * native session is never driven by two remote threads at once.
 */
export function piSessionHolder(file: string, threadId: string, options: PiCatalogOptions = {}): string | undefined {
  const home = options.home ?? os.homedir();
  const directory = path.join(options.remoteCliDirectory ?? path.join(home, '.remote-cli'), 'pi-sessions');
  const target = canonicalPath(file) ?? file;
  let names: string[];
  try { names = fs.readdirSync(directory); } catch { return undefined; }
  for (const name of names) {
    if (!name.endsWith('.json') || name === `${threadId}.json`) continue;
    try {
      const pointer = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')) as { sessionFile?: unknown };
      if (typeof pointer.sessionFile === 'string' && (canonicalPath(pointer.sessionFile) ?? pointer.sessionFile) === target) {
        return name.slice(0, -'.json'.length);
      }
    } catch { /* unreadable pointers do not hold a session */ }
  }
  return undefined;
}
