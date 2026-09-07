/**
 * Thread state model for true parallel execution.
 * Each thread has its own independent executor process.
 */

import type { BackendKey } from '../types/config';

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
  /**
   * @deprecated Legacy model field — honored for the Claude backend only.
   * Model names are backend-specific (Claude's "opus" is rejected by agy),
   * so per-backend selections live in `models`.
   */
  model?: string;
  /**
   * Per-backend model selections via /model, keyed by backend.
   * Takes precedence over the legacy `model` field.
   */
  models?: Partial<Record<BackendKey, string>>;
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
