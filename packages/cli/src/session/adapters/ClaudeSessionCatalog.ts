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
  safeSessionLabel,
  scanSessionCatalogs,
  type SessionCatalog,
  type SessionCatalogOptions,
  type SessionCatalogStore,
} from '../SessionCatalog';

/**
 * Claude Code stores one JSONL transcript per session under
 * `<config-dir>/projects/<encoded-cwd>/<session-id>.jsonl`. A transcript record
 * is large and `cwd` first appears after ~2.5 KiB in the observed release, so a
 * bounded head read is used instead of the shared 64 KiB header budget. The cap
 * stays a hard resource bound; an oversized head becomes a coverage gap.
 */
const CLAUDE_HEAD_MAX_BYTES = 256 * 1024;
/** Reject a transcript that cannot show its recorded workspace inside the head. */
const CLAUDE_CWD_MARKER = '"cwd"';
const CLAUDE_MAX_RECORD_BYTES = 64 * 1024;

/** Project directory name: leading separator dropped, separators replaced with `-`. */
export function claudeProjectDirectoryName(cwd: string): string {
  return `-${path.resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}`;
}

interface ClaudeHead {
  sessionId: string;
  cwd: string;
  modifiedAt: number;
  sidechain: boolean;
  summary?: string;
}

/** Read a bounded head of a private single-link regular file; never follows a symlink. */
function readHead(file: string, maxBytes: number): { text: string; truncated: boolean } | undefined {
  let fd: number | undefined;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size === 0) return undefined;
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(fd);
    if (stat.ino !== before.ino || stat.dev !== before.dev) return undefined;
    const size = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(size);
    const length = fs.readSync(fd, buffer, 0, size, 0);
    return { text: buffer.subarray(0, length).toString('utf8'), truncated: stat.size > maxBytes };
  } catch { return undefined; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

/**
 * Parse the bounded head of one transcript. Only whole newline-terminated records
 * are considered, so a partially read trailing record can never be misread.
 */
function headOf(file: string, expectedDirectory: string): ClaudeHead | undefined {
  const head = readHead(file, CLAUDE_HEAD_MAX_BYTES);
  if (!head) return undefined;
  const lines = head.text.split('\n');
  if (head.truncated) lines.pop();
  const sessionIdFromName = path.basename(file, '.jsonl');
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let sidechain = false;
  let lastPrompt: string | undefined;
  for (const line of lines) {
    if (!line || line.length > CLAUDE_MAX_RECORD_BYTES) continue;
    let record: { type?: unknown; sessionId?: unknown; cwd?: unknown; isSidechain?: unknown; lastPrompt?: unknown };
    try { record = JSON.parse(line) as typeof record; } catch { continue; }
    if (typeof record.sessionId === 'string' && record.sessionId) {
      // Later records can belong to another session; a transcript must stay single-session.
      if (!sessionId) sessionId = record.sessionId;
      else if (record.sessionId !== sessionId) return undefined;
    }
    if (typeof record.cwd === 'string' && record.cwd) cwd ??= record.cwd;
    if (record.isSidechain === true) sidechain = true;
    if (record.type === 'last-prompt' && typeof record.lastPrompt === 'string') lastPrompt = record.lastPrompt;
  }
  if (!sessionId || sessionId !== sessionIdFromName || sessionId.length > SESSION_CATALOG_MAX_ID
    || /[\u0000-\u001f\u007f\s`]/.test(sessionId) || SYNTHETIC_SESSION.test(sessionId)) return undefined;
  if (!cwd || !path.isAbsolute(cwd)) return undefined;
  // The containing directory must itself encode this recorded workspace.
  if (path.basename(expectedDirectory) !== claudeProjectDirectoryName(cwd)) return undefined;
  let modifiedAt: number;
  try { modifiedAt = fs.lstatSync(file).mtimeMs; } catch { return undefined; }
  if (!Number.isFinite(modifiedAt) || modifiedAt - Date.now() > SESSION_CATALOG_MAX_MODIFIED_SKEW_MS) return undefined;
  return { sessionId, cwd, modifiedAt, sidechain, summary: lastPrompt ? safeSessionLabel(lastPrompt) : undefined };
}

/**
 * Read-only discovery of Claude Code sessions whose recorded workspace equals the
 * thread workspace. It never starts Claude Code, reads further than the bounded
 * head, migrates files, or writes anything. Counts stay unavailable.
 */
export function listClaudeSessions(workingDirectory: string, options: SessionCatalogOptions = {}): SessionCatalog {
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;
  const remoteDirectory = options.remoteCliDirectory ?? path.join(home, '.remote-cli');
  const notes: string[] = [];
  const threadCwd = canonicalPath(workingDirectory);
  if (!threadCwd) return { candidates: [], complete: false, notes: ['The thread working directory is unavailable.'] };

  const configured = env.CLAUDE_CONFIG_DIR ? expandHomePath(env.CLAUDE_CONFIG_DIR, home) : undefined;
  if (env.CLAUDE_CONFIG_DIR && !configured) notes.push('A relative Claude config directory override was ignored.');
  const configDirectory = configured ?? path.join(home, '.claude');
  const projectDirectory = path.join(configDirectory, 'projects', claudeProjectDirectoryName(threadCwd));

  if (env.CLAUDE_CONFIG_DIR && !configured) {
    return { candidates: [], complete: false,
      notes: [...notes, 'The native Claude config directory could not be resolved.'] };
  }
  const stores: SessionCatalogStore[] = [{ directory: projectDirectory, source: 'native-local' }];
  const scan = scanSessionCatalogs(stores, (file, root, store) => {
    let head: ClaudeHead | undefined;
    try { head = headOf(file, root); } catch { head = undefined; }
    if (!head || head.sidechain || canonicalPath(head.cwd) !== threadCwd) return undefined;
    return { id: head.sessionId, name: head.summary, source: store.source,
      modifiedAt: head.modifiedAt, messageCount: 0, countComplete: false };
  }, { onGap: reason => notes.push(reason === 'truncated'
    ? 'Some Claude session storage could not be fully scanned.'
    : 'The Claude project store could not be read safely.') });
  if (scan.duplicates) notes.push(`${scan.duplicates} duplicated session ID(s) were hidden.`);
  if (scan.candidates.length) notes.push('Claude message counts are not available without reading native transcripts.');
  if (scan.complete && !scan.candidates.length) notes.push('No Claude Code sessions were found for this workspace.');
  return { candidates: scan.candidates, complete: scan.complete, notes };
}
