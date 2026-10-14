import fs from 'fs';
import os from 'os';
import path from 'path';
import type { BackendKey } from '../types/config';

/**
 * Local-only session inspection. This module never starts a backend, never reads
 * transcript content, and never writes anything: it reads the local pointer files
 * remote-cli itself wrote, so a user can reopen the same native session in a
 * terminal. Native locators deliberately stay on this machine; nothing here is
 * meant to be rendered in Feishu.
 */

/** Pointer namespaces written by each executor, keyed by stable backend key. */
export const SESSION_POINTER_NAMESPACES: Record<BackendKey, string> = {
  claude: 'claude-sessions',
  codex: 'codex-sessions',
  agy: 'agy-sessions',
  opencode: 'opencode-sessions',
  kimi: 'kimi-sessions',
  zcode: 'zcode-sessions',
  pi: 'pi-sessions',
  dsh: 'dsh-sessions',
};

/** Reopen helpers verified against the locally installed release's own help output. */
interface ReopenRule {
  /** Build the exact command. `id` is the native session identity; `file` an exact session file. */
  command: (nativeId: string, sessionFile?: string) => string;
  /** Where the verification came from, or why guidance is withheld. */
  verified: string;
}

const REOPEN_RULES: Partial<Record<BackendKey, ReopenRule>> = {
  claude: { command: id => `claude --resume ${id}`, verified: 'verified against the installed Claude Code --help' },
  codex: { command: id => `codex resume ${id}`, verified: 'verified against the installed Codex CLI resume help' },
  opencode: { command: id => `opencode --session ${id}`, verified: 'verified against the installed OpenCode --session flag' },
  pi: { command: (id, sessionFile) => `pi --session ${sessionFile ?? id}`, verified: 'verified against the installed Pi --session flag' },
};

export interface LocalSessionInfoOptions {
  /** Remote thread identity, from `threads.json`. */
  threadId: string;
  threadName: string;
  workingDirectory: string;
  backend: BackendKey;
  /** Account home; defaults to the current user's. */
  home?: string;
  /** Optional remote-cli state root override (defaults to `<home>/.remote-cli`). */
  remoteCliDirectory?: string;
}

export interface LocalSessionInfo {
  backend: BackendKey;
  threadName: string;
  workingDirectory: string;
  /** Where the pointer record lives, relative to the remote-cli state root. */
  pointerLabel: string;
  record: 'missing' | 'unreadable' | 'present';
  /** Exact native identity, local-only. */
  nativeId?: string;
  sessionFile?: string;
  savedAt?: string;
  /** Exact reopen guidance, only when the installed release's flags are verified. */
  reopen?: { command: string; verified: string };
  notes: string[];
}

function pointerFile(directory: string, threadId: string): string {
  return path.join(directory, `${threadId}.json`);
}

/** Bounded, symlink-free read of one pointer record. */
function readPointer(file: string): { record: 'unreadable' | 'invalid' } | { record: 'ok'; value: Record<string, unknown> } {
  let fd: number | undefined;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size === 0 || before.size > 64 * 1024) {
      return { record: 'unreadable' };
    }
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(fd);
    if (stat.ino !== before.ino || stat.dev !== before.dev) return { record: 'unreadable' };
    const value: unknown = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { record: 'invalid' };
    return { record: 'ok', value: value as Record<string, unknown> };
  } catch (error) {
    return { record: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'invalid' : 'unreadable' };
  }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

/**
 * Read one thread/backend pointer. Returns `missing` when no native session was
 * ever recorded, so callers never suggest a selector that would create an empty
 * conversation. Never executes a backend.
 */
export function readLocalSessionInfo(options: LocalSessionInfoOptions): LocalSessionInfo {
  const home = options.home ?? os.homedir();
  const root = options.remoteCliDirectory ?? path.join(home, '.remote-cli');
  const namespace = SESSION_POINTER_NAMESPACES[options.backend];
  const directory = path.join(root, namespace);
  const file = pointerFile(directory, options.threadId);
  const info: LocalSessionInfo = {
    backend: options.backend,
    threadName: options.threadName,
    workingDirectory: options.workingDirectory,
    pointerLabel: `${namespace}/${options.threadId}.json`,
    record: 'missing',
    notes: [],
  };
  const exists = fs.existsSync(file);
  const read = readPointer(file);
  if (!exists) {
    info.notes.push('No persisted session pointer exists for this thread. Do not run a native picker expecting history; no empty session was created.');
    return info;
  }
  if (read.record !== 'ok') {
    info.record = 'unreadable';
    info.notes.push('The local session pointer exists but could not be read safely; inspect it on this computer before reopening anything.');
    return info;
  }
  const id = read.value.id;
  const sessionFile = read.value.sessionFile;
  const cwd = read.value.cwd;
  if (typeof id !== 'string' || !id) {
    info.record = 'unreadable';
    info.notes.push('The local session pointer has no usable native session identity.');
    return info;
  }
  info.record = 'present';
  info.nativeId = id;
  if (typeof sessionFile === 'string' && sessionFile) info.sessionFile = sessionFile;
  if (typeof read.value.savedAt === 'string') info.savedAt = read.value.savedAt;
  if (typeof cwd === 'string' && cwd && cwd !== options.workingDirectory) {
    info.notes.push('The pointer records a different working directory than the thread; reopen it in the recorded project, not in the current one.');
  }
  const rule = REOPEN_RULES[options.backend];
  if (rule) {
    info.reopen = { command: rule.command(id, info.sessionFile), verified: rule.verified };
  } else {
    info.notes.push(`Reopen guidance for ${options.backend} is not verified on this release, so no command is suggested.`);
  }
  return info;
}

/** Local-only rendering. Never send this text to a chat service. */
export function formatLocalSessionInfo(info: LocalSessionInfo): string {
  const lines = [
    `Thread: ${info.threadName} (${info.backend})`,
    `Workspace: ${info.workingDirectory}`,
    `Local pointer: ${info.pointerLabel} (${info.record})`,
  ];
  if (info.nativeId) lines.push(`Native session: ${info.nativeId}`);
  if (info.sessionFile) lines.push(`Session file: ${info.sessionFile}`);
  if (info.savedAt) lines.push(`Recorded at: ${info.savedAt}`);
  if (info.reopen) {
    lines.push('', 'Reopen on this computer (no model task is started by remote-cli):', `  ${info.reopen.command}`);
    lines.push(`  (${info.reopen.verified})`);
  } else if (info.record === 'present') {
    lines.push('', 'No reopen command is suggested for this backend on this release.');
  }
  if (info.notes.length) lines.push('', ...info.notes.map(note => `Note: ${note}`));
  lines.push('', 'remote-cli does not verify that the native release preserves history on reopen, and it does not hold an ownership lease over a plain terminal process. Close the remote runtime before working locally, then reacquire explicitly.');
  return lines.join('\n');
}
