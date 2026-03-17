/**
 * Thread: an isolated Claude conversation session with its own
 * working directory and Claude session ID.
 */
export interface Thread {
  /** UUID v4 — stable internal identifier */
  id: string;
  /** User-facing name: alphanumeric + hyphens, 1-30 chars */
  name: string;
  /** Claude CLI session ID, null if no conversation has started yet */
  sessionId: string | null;
  /** Working directory for this thread */
  workingDirectory: string;
  /** Creation timestamp (ms) */
  createdAt: number;
  /** Last time this thread was actively used (ms) */
  lastActiveAt: number;
}

/** Root structure persisted to threads.json */
export interface ThreadStore {
  activeThreadId: string | null;
  threads: Record<string, Thread>;
}

/** Compact summary sent to the Router for card button rendering */
export interface ThreadSummary {
  id: string;
  name: string;
  isActive: boolean;
}

/** Maximum threads per user */
export const MAX_THREADS = 10;

/** Default thread name used during migration from single-session mode */
export const DEFAULT_THREAD_NAME = 'default';

/** Regex for valid thread names */
export const THREAD_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,28}[a-zA-Z0-9]$|^[a-zA-Z0-9]$/;
