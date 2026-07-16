/**
 * Thread state model for true parallel execution.
 * Each thread has its own independent executor process.
 */

export const MAX_THREADS = 10;
export const DEFAULT_THREAD_NAME = 'default';
export const THREAD_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,28}[a-zA-Z0-9]$|^[a-zA-Z0-9]$/;

export interface Thread {
  id: string;
  name: string;
  sessionId: string | null;
  workingDirectory: string;
  createdAt: number;
  lastActiveAt: number;
}

export interface ThreadStore {
  threads: Record<string, Thread>;
}

/**
 * Lightweight thread summary for wire protocol and card display.
 * Status is runtime-only (not persisted) — computed from ThreadExecutorPool.
 */
export interface ThreadSummary {
  id: string;
  name: string;
  status: 'idle' | 'running' | 'error';
}
