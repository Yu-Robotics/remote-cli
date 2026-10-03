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
  /** Optional backend override. Unset means use the global executor backend. */
  backend?: BackendKey;
  /** Cross-backend tool delegation preference. Unset defaults to true; false opts out. */
  delegation?: boolean;
  /** Backends that may retain managed tools and require opt-out cleanup on resume. */
  delegationBackends?: BackendKey[];
  /**
   * Advances whenever this thread successfully changes working directory.
   * Delegated worker lanes use it to prevent a return to an old path from
   * reviving a conversation that belonged to an earlier workspace visit.
   */
  delegationWorkspaceGeneration?: number;
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
  /** Per-backend reasoning effort overrides. Currently used by Codex, AGY, OpenCode, and Kimi Code. */
  efforts?: Partial<Record<BackendKey, string>>;
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
  backend?: BackendKey;
  /** Last path component of the thread's current working directory. */
  workspaceName?: string;
}
