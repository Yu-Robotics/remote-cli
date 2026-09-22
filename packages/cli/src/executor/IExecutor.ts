import { ToolUseInfo, ToolResultInfo, Attachment, ImageBlock } from '../types';

export interface ExecuteOptions {
  onStream?: (chunk: string) => void;
  onToolUse?: (toolUse: ToolUseInfo) => void;
  onToolResult?: (toolResult: ToolResultInfo) => void;
  onRedactedThinking?: () => void;
  onPlanMode?: (planContent: string) => void;
  onImage?: (image: ImageBlock) => void;
  timeout?: number;
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
  resetContext(): void;
  abort(): Promise<boolean>;
  destroy(): Promise<void> | void;

  // Optional — MessageHandler uses 'method' in executor checks for these
  isWaitingInput?(): boolean;
  sendInput?(input: string): boolean;
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

  /**
   * Delete all persistent state (session files, history) associated with a thread.
   * Called by ThreadExecutorPool.destroyThread before removing the executor.
   * Each backend cleans up its own storage format and location.
   */
  deleteThreadData?(threadId: string): Promise<void>;
}
