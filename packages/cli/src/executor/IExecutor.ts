import { ToolUseInfo, ToolResultInfo, Attachment, ImageBlock, TaskNotificationInfo, ApprovalRequestInfo, ApprovalAction, ApprovalStatus, ExecutionMetadata, ActivityProgressInfo } from '../types';
import type { DelegationConnection } from '../delegation/contract';

export interface ExecuteOptions {
  onStream?: (chunk: string) => void;
  /** Assistant response text only; excludes reasoning, tool output, and status messages. */
  onDisplayText?: (chunk: string) => void;
  /** Bounded public activity snapshot; excludes raw thinking, tool output and final Codex prose. */
  onActivity?: (activity: ActivityProgressInfo) => void;
  onToolUse?: (toolUse: ToolUseInfo) => void;
  onToolResult?: (toolResult: ToolResultInfo) => void;
  onRedactedThinking?: () => void;
  onPlanMode?: (planContent: string) => void;
  onImage?: (image: ImageBlock) => void;
  /** Explicit native image artifact only; recipients must validate and bound local reads. */
  onImageFile?: (path: string) => void;
  /** May fire after execute resolves; recipients must remain bound to the originating request. */
  onTaskNotification?: (notification: TaskNotificationInfo) => void;
  /** Return true when an interactive card replaces the text approval prompt. */
  onApprovalRequest?: (request: ApprovalRequestInfo) => boolean;
  onApprovalResolved?: (requestId: string, status: ApprovalStatus) => void;
  /** Optional hard execution limit in milliseconds. Set to 0 to disable a backend default. */
  timeout?: number;
  /** Optional backend-native inactivity limit in milliseconds. Set to 0 to disable it. */
  inactivityTimeout?: number;
  /** Optional attachments (e.g. images) */
  attachments?: Attachment[];
}

export interface ExecuteResult {
  success: boolean;
  output?: string;
  error?: string;
  sessionAbbr?: string;
}

export type ExecutorGoalStatus = 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete';

/** Authoritative native goal state; usage is never estimated by the adapter. */
export interface ExecutorGoal {
  threadId: string;
  objective: string;
  status: ExecutorGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

/** An omitted objective resumes an existing, unfinished native goal only. */
export interface ExecutorGoalRunRequest {
  objective?: string;
  tokenBudget?: number;
}

export interface ExecutorModelInfo {
  id: string;
  displayName: string;
  description?: string;
  isDefault?: boolean;
  /** Native current selection, distinct from a catalog default. */
  isCurrent?: boolean;
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  inputModalities?: string[];
  serviceTiers?: Array<{ id: string; name: string; description?: string }>;
  defaultServiceTier?: string | null;
}

/** Native model-specific speed choices; absence means the backend has no control. */
export interface ExecutorSpeedInfo {
  choices: Array<{ value: string; displayName: string; description?: string }>;
  current?: string;
  default?: string | null;
}

/** Session/model-specific effort options. An unknown default must remain absent. */
export interface ExecutorEffortInfo {
  choices: Array<{ value: string; displayName: string; description?: string }>;
  current?: string;
  default?: string;
  supportsReset: boolean;
  unavailableReason?: string;
}

export type ExecutorExecutionMetadata = Omit<ExecutionMetadata, 'backend'>;

export interface ExecutorContextUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  contextTokens?: number | null;
  contextWindow?: number;
  contextPercent?: number | null;
}

/**
 * Shared executor interface for all AI CLI backends (Claude, AGY, etc.)
 * Uses structural typing — existing Claude executors satisfy this without modification.
 */
export interface IExecutor {
  // Required — all executors must implement
  execute(prompt: string, options: ExecuteOptions): Promise<ExecuteResult>;
  getCurrentWorkingDirectory(): string;
  setWorkingDirectory(targetPath: string): Promise<void>;
  /** Native activity, checked before destructive session changes. */
  isBusy?(): boolean;
  /** A failed transport stop requires an explicit successful abort retry before admission. */
  hasUncertainShutdown?(): boolean;
  resetContext(): void;
  abort(): Promise<boolean>;
  destroy(): Promise<void> | void;
  /** Transport-exit confirmation; insufficient by itself for disposable worker cleanup. */
  waitForExit?(): Promise<void>;
  /** Stronger managed-worker disposal gate: confirms no live members in owned process groups.
   * Rejects when unavailable; does not cover descendants escaping their group with setsid/setpgid.
   * Call after destroy() and waitForExit(); transport-exit consumers must keep using waitForExit(). */
  waitForManagedProcessGroupExit?(): Promise<void>;
  /**
   * Reports and clears a backend-confirmed missing-session failure that happened
   * before the current objective was dispatched. Delegation may safely retry it
   * once with a fresh isolated lane; generic errors are never replayed.
   */
  consumeSessionResumeFailure?(): boolean;

  // Optional — MessageHandler uses 'method' in executor checks for these
  /** Enable tools for future turns without changing the native conversation. */
  configureDelegation?(connection?: DelegationConnection): Promise<void>;
  getGoal?(): Promise<ExecutorGoal | null>;
  executeGoal?(request: ExecutorGoalRunRequest, options: ExecuteOptions): Promise<ExecuteResult>;
  pauseGoal?(): Promise<ExecuteResult>;
  clearGoal?(): Promise<ExecuteResult>;
  isGoalRunning?(): boolean;
  isWaitingInput?(): boolean;
  sendInput?(input: string): boolean;
  respondToApproval?(requestId: string, action: ApprovalAction): boolean;
  compact?(onStream?: (chunk: string) => void): Promise<ExecuteResult>;
  compactWhenFull?(onStream?: (chunk: string) => void): Promise<ExecuteResult>;
  /** Switch the active model for this executor. */
  setModel?(model: string, onStream?: (chunk: string) => void): Promise<ExecuteResult>;
  /** Clear a model override so the backend default is used. */
  clearModel?(): Promise<void> | void;
  /** List models available to the authenticated backend account. */
  listModels?(): Promise<ExecutorModelInfo[]>;
  listSpeeds?(models?: ExecutorModelInfo[]): Promise<ExecutorSpeedInfo | undefined>;
  /** Undefined follows native configuration; "default" explicitly selects Standard. */
  setSpeed?(speed: string | undefined): Promise<ExecuteResult>;
  /** Read effort choices for the executor's current model, never a global superset. */
  listEfforts?(): Promise<ExecutorEffortInfo>;
  /** Set a reasoning effort override, or use "auto" to restore the backend default. */
  setEffort?(effort: string): Promise<ExecuteResult>;
  isProcessRunning?(): boolean;
  getSessionId?(): string | null;
  /** Cached settings only: never starts a process, queries an API, or changes a session. */
  getExecutionMetadata?(): ExecutorExecutionMetadata;
  /** Return backend-provided token and context-window statistics when available. */
  getContextUsage?(): Promise<ExecutorContextUsage | null> | ExecutorContextUsage | null;
  /** Return backend-provided account plan usage as display-ready text when available. */
  getAccountUsage?(): Promise<string | null> | string | null;

  /**
   * Delete all persistent state (session files, history) associated with a thread.
   * Called by ThreadExecutorPool.destroyThread before removing the executor.
   * Each backend cleans up its own storage format and location.
   */
  deleteThreadData?(threadId: string): Promise<void>;

  /** Release a known temporary metadata session while its transport is alive.
   * Local pointers are removed separately, only after confirmed process exit.
   */
  releaseMetadataSession?(): Promise<void>;
  /**
   * Strict native session adoption. Implementations must verify the loaded native
   * identity without sending a prompt, never fall back to a fresh session, and
   * restore the previous conversation unchanged when verification fails.
   */
  adoptNativeSession?(target: NativeSessionTarget): Promise<NativeSessionResult>;
  /** Drop the association without deleting native history; the next turn starts fresh. */
  detachNativeSession?(): Promise<NativeSessionResult>;
}

/** Adapter-validated native selection; the locator never comes from a chat message. */
export interface NativeSessionTarget {
  sessionId: string;
  sessionFile: string;
}

export type NativeSessionResult = { success: true } | {
  success: false;
  error: string;
  /** Keep the native file reserved when process cleanup could not be confirmed. */
  recoveryRequired?: boolean;
};
