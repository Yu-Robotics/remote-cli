import { ToolUseInfo, ToolResultInfo } from '../types';

export interface ExecuteOptions {
  onStream?: (chunk: string) => void;
  onToolUse?: (toolUse: ToolUseInfo) => void;
  onToolResult?: (toolResult: ToolResultInfo) => void;
  onRedactedThinking?: () => void;
  onPlanMode?: (planContent: string) => void;
  timeout?: number;
}

export interface ExecuteResult {
  success: boolean;
  output?: string;
  error?: string;
  sessionAbbr?: string;
}

/**
 * Shared executor interface for all AI CLI backends (Claude, Gemini, etc.)
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
  isProcessRunning?(): boolean;
  getSessionId?(): string | null;
}
