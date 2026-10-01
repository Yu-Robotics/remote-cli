import { ToolUseInfo, ToolResultInfo, Attachment, ImageBlock, TaskNotificationInfo, ApprovalRequestInfo, ApprovalAction, ApprovalStatus } from '../types';
import type { DelegationConnection } from '../delegation/contract';

export interface ExecuteOptions {
  onStream?: (chunk: string) => void;
  onToolUse?: (toolUse: ToolUseInfo) => void;
  onToolResult?: (toolResult: ToolResultInfo) => void;
  onRedactedThinking?: () => void;
  onPlanMode?: (planContent: string) => void;
  onImage?: (image: ImageBlock) => void;
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

export interface ExecutorModelInfo {
  id: string;
  displayName: string;
  description?: string;
  isDefault?: boolean;
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  inputModalities?: string[];
}

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
  /** Native executor activity, checked before destructive session changes. */
  isBusy?(): boolean;
  resetContext(): void;
  abort(): Promise<boolean>;
  destroy(): Promise<void> | void;
  /** Optional process-exit confirmation used before releasing a delegated workspace. */
  waitForExit?(): Promise<void>;
  /**
   * Reports and clears a backend-confirmed missing-session failure that happened
   * before the current objective was dispatched. Delegation may safely retry it
   * once with a fresh isolated lane; generic errors are never replayed.
   */
  consumeSessionResumeFailure?(): boolean;

  // Optional — MessageHandler uses 'method' in executor checks for these
  /** Enable tools for future turns without changing the native conversation. */
  configureDelegation?(connection?: DelegationConnection): Promise<void>;
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
  /** Set a reasoning effort override, or use "auto" to restore the backend default. */
  setEffort?(effort: string): Promise<ExecuteResult>;
  isProcessRunning?(): boolean;
  getSessionId?(): string | null;
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
}
