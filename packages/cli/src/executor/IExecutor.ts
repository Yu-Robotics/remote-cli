import { ToolUseInfo, ToolResultInfo } from '../types';

/**
 * Execution options common to all executors
 */
export interface ExecuteOptions {
  /** Stream output callback */
  onStream?: (chunk: string) => void;
  /** Tool use callback */
  onToolUse?: (toolUse: ToolUseInfo) => void;
  /** Tool result callback */
  onToolResult?: (toolResult: ToolResultInfo) => void;
  /** Redacted thinking callback (when AI reasoning is filtered by safety systems) */
  onRedactedThinking?: () => void;
  /** Plan mode callback (when Claude completes its plan) */
  onPlanMode?: (planContent: string) => void;
  /** Execution timeout (milliseconds) */
  timeout?: number;
}

/**
 * Execution result common to all executors
 */
export interface ExecuteResult {
  /** Whether execution was successful */
  success: boolean;
  /** Output content (if not streamed) */
  output?: string;
  /** Error message */
  error?: string;
  /** Session abbreviation for tracking */
  sessionAbbr?: string;
}

/**
 * Executor type configuration
 */
export type ExecutorType = 'claude-persistent' | 'claude-spawn' | 'gemini' | 'auto';

/**
 * Configuration for creating an executor
 */
export interface ExecutorConfig {
  /** Type of executor to create */
  type: ExecutorType;
  /** Initial working directory */
  initialWorkingDirectory?: string;
  /** Gemini-specific configuration */
  gemini?: {
    /** Gemini model to use */
    model?: string;
    /** Auto-approve tool permissions */
    autoApprove?: boolean;
    /** Override Gemini CLI command */
    command?: string;
    /** Pin Gemini CLI version */
    version?: string;
  };
  /** Claude-specific configuration */
  claude?: {
    /** Whether to use persistent mode */
    persistent?: boolean;
  };
}

/**
 * Common interface for all AI executors
 */
export interface IExecutor {
  /**
   * Get current working directory
   */
  getCurrentWorkingDirectory(): string;

  /**
   * Set working directory
   * @param targetPath Target path
   * @throws If path is not safe
   */
  setWorkingDirectory(targetPath: string): Promise<void>;

  /**
   * Execute a command/prompt
   * @param prompt Command prompt
   * @param options Execution options
   * @returns Execution result
   */
  execute(prompt: string, options?: ExecuteOptions): Promise<ExecuteResult>;

  /**
   * Reset execution context/conversation history
   */
  resetContext(): void;

  /**
   * Abort current command execution
   * @returns Whether an execution was actually aborted
   */
  abort(): Promise<boolean>;

  /**
   * Destroy the executor and clean up resources
   */
  destroy(): void;

  /**
   * Optional: Check if executor is waiting for interactive input
   */
  isWaitingInput?(): boolean;

  /**
   * Optional: Send input to executor when waiting for interactive input
   */
  sendInput?(input: string): boolean;

  /**
   * Optional: Compact conversation history when context is full
   */
  compactWhenFull?(onStream?: (chunk: string) => void): Promise<ExecuteResult>;
}
