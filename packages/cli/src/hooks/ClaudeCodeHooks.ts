import { EventEmitter } from 'events';

/**
 * Hook event types
 */
export enum HookEventType {
  // Authorization hooks
  AUTHORIZATION_REQUIRED = 'authorization:required',
  AUTHORIZATION_GRANTED = 'authorization:granted',
  AUTHORIZATION_DENIED = 'authorization:denied',

  // Task lifecycle hooks
  TASK_STARTED = 'task:started',
  TASK_COMPLETED = 'task:completed',
  TASK_FAILED = 'task:failed',
  TASK_ABORTED = 'task:aborted',

  // Background task notification (Claude Code 2.x system:task_notification)
  TASK_NOTIFICATION = 'task:notification',

  // Execution hooks
  TOOL_BEFORE_EXECUTION = 'tool:beforeExecution',
  TOOL_AFTER_EXECUTION = 'tool:afterExecution',
  PROGRESS_UPDATE = 'progress:update',

  // User interaction hooks
  USER_INPUT_REQUIRED = 'user:inputRequired',
  CONFIRMATION_REQUIRED = 'user:confirmationRequired',
}

/**
 * Authorization context
 */
export interface AuthorizationContext {
  /** Type of action requiring authorization */
  actionType: 'file_access' | 'command_execution' | 'network_request' | 'sensitive_operation';
  /** Description of what is being requested */
  description: string;
  /** Detailed information about the operation */
  details: {
    /** File path (for file_access) */
    filePath?: string;
    /** Command to execute (for command_execution) */
    command?: string;
    /** Working directory */
    cwd?: string;
    /** Additional metadata */
    [key: string]: unknown;
  };
  /** Risk level of the operation */
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  /** Timestamp when authorization was requested */
  timestamp: number;
}

/**
 * Authorization decision
 */
export interface AuthorizationDecision {
  /** Whether the operation is granted */
  granted: boolean;
  /** Optional reason for denial */
  reason?: string;
  /** Whether to remember this decision for future similar operations */
  remember?: boolean;
  /** Duration to remember (in milliseconds), 0 = session only */
  rememberDuration?: number;
}

/**
 * Task context
 */
export interface TaskContext {
  /** Unique task ID */
  taskId: string;
  /** Task description/prompt */
  description: string;
  /** Working directory */
  workingDirectory: string;
  /** Session ID */
  sessionId?: string;
  /** Start timestamp */
  startTime: number;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Task result
 */
export interface TaskResult {
  /** Whether the task succeeded */
  success: boolean;
  /** Task output */
  output?: string;
  /** Error message if failed */
  error?: string;
  /** Execution duration in milliseconds */
  duration?: number;
  /** End timestamp */
  endTime: number;
}

/**
 * Background task notification (Claude Code 2.x)
 *
 * Emitted when a background task (e.g. a background Bash command) reaches a
 * terminal state. This event is process-level: it is not associated with any
 * in-flight command, so it travels over the hooks bus rather than per-command
 * callbacks.
 */
export interface TaskNotificationContext {
  /** Background task ID */
  taskId: string;
  /** Terminal status of the task */
  status: 'completed' | 'failed' | 'stopped';
  /** Short result summary produced by Claude Code */
  summary: string;
  /** Path to the file containing the task's full output (on the local machine) */
  outputFile: string;
  /** Thread whose Claude session ran the task (undefined = legacy default thread) */
  threadId?: string;
  /** Claude session ID */
  sessionId?: string;
}

/**
 * Tool execution context
 */
export interface ToolExecutionContext {
  /** Tool name */
  toolName: string;
  /** Tool parameters */
  params: Record<string, unknown>;
  /** Execution timestamp */
  timestamp: number;
  /** Task ID associated with this execution */
  taskId?: string;
}

/**
 * Tool execution result
 */
export interface ToolExecutionResult {
  /** Whether execution succeeded */
  success: boolean;
  /** Execution result */
  result?: unknown;
  /** Error if failed */
  error?: string;
  /** Execution duration in milliseconds */
  duration: number;
}

/**
 * Progress update
 */
export interface ProgressUpdate {
  /** Current progress (0-100) */
  progress: number;
  /** Progress message */
  message: string;
  /** Current step number */
  step?: number;
  /** Total steps */
  totalSteps?: number;
  /** Additional data */
  data?: Record<string, unknown>;
}

/**
 * Confirmation request
 */
export interface ConfirmationRequest {
  /** What needs confirmation */
  prompt: string;
  /** Detailed description */
  description?: string;
  /** Default option */
  defaultValue?: boolean;
  /** Timeout in milliseconds (0 = no timeout) */
  timeout?: number;
}

/**
 * User input request
 */
export interface UserInputRequest {
  /** Prompt message */
  prompt: string;
  /** Input type */
  type: 'text' | 'password' | 'number' | 'choice';
  /** Choices (for type='choice') */
  choices?: string[];
  /** Default value */
  defaultValue?: string;
  /** Validation pattern */
  validation?: RegExp;
  /** Timeout in milliseconds (0 = no timeout) */
  timeout?: number;
}

/**
 * Hook handler types
 */
export type AuthorizationHandler = (
  context: AuthorizationContext
) => Promise<AuthorizationDecision> | AuthorizationDecision;

export type TaskStartedHandler = (context: TaskContext) => Promise<void> | void;
export type TaskCompletedHandler = (context: TaskContext, result: TaskResult) => Promise<void> | void;
export type TaskFailedHandler = (context: TaskContext, error: Error) => Promise<void> | void;
export type TaskAbortedHandler = (context: TaskContext, reason: string) => Promise<void> | void;
export type TaskNotificationHandler = (context: TaskNotificationContext) => Promise<void> | void;

export type ToolBeforeExecutionHandler = (
  context: ToolExecutionContext
) => Promise<boolean | void> | boolean | void;
export type ToolAfterExecutionHandler = (
  context: ToolExecutionContext,
  result: ToolExecutionResult
) => Promise<void> | void;

export type ProgressHandler = (update: ProgressUpdate) => Promise<void> | void;

export type ConfirmationHandler = (
  request: ConfirmationRequest
) => Promise<boolean> | boolean;
export type UserInputHandler = (
  request: UserInputRequest
) => Promise<string> | string;

/**
 * Claude Code Hooks Manager
 *
 * Provides a centralized hook system for customizing Claude Code behavior
 * and receiving notifications at key decision points.
 */
export class ClaudeCodeHooks extends EventEmitter {
  private authorizationHandler?: AuthorizationHandler;
  private confirmationHandler?: ConfirmationHandler;
  private userInputHandler?: UserInputHandler;

  // Stored authorization decisions for caching
  private authorizationCache = new Map<string, { decision: AuthorizationDecision; expiresAt: number }>();

  constructor() {
    super();
    // Increase max listeners to support multiple adapter instances in tests
    this.setMaxListeners(100);

    // Debug: Log all emitted events
    const originalEmit = this.emit.bind(this);
    this.emit = function(event: string | symbol, ...args: any[]) {
      const timestamp = new Date().toISOString();
      const eventName = String(event);

      // Don't log full context objects to keep logs readable
      if (args.length > 0) {
        const summary = args.map(arg => {
          if (typeof arg === 'object' && arg !== null) {
            if ('taskId' in arg) return `{taskId: ${arg.taskId}}`;
            if ('toolName' in arg) return `{toolName: ${arg.toolName}}`;
            if ('actionType' in arg) return `{actionType: ${arg.actionType}}`;
            return '{object}';
          }
          return arg;
        });
        console.log(`[ClaudeCodeHooks ${timestamp}] Event emitted: ${eventName}`, summary);
      } else {
        console.log(`[ClaudeCodeHooks ${timestamp}] Event emitted: ${eventName}`);
      }

      return originalEmit(event, ...args);
    } as any;
  }

  /**
   * Register authorization handler
   * Called when an operation requires user authorization
   */
  onAuthorizationRequired(handler: AuthorizationHandler): void {
    this.authorizationHandler = handler;
  }

  /**
   * Register task started handler
   */
  onTaskStarted(handler: TaskStartedHandler): void {
    this.on(HookEventType.TASK_STARTED, handler);
  }

  /**
   * Register task completed handler
   */
  onTaskCompleted(handler: TaskCompletedHandler): void {
    this.on(HookEventType.TASK_COMPLETED, handler);
  }

  /**
   * Register task failed handler
   */
  onTaskFailed(handler: TaskFailedHandler): void {
    this.on(HookEventType.TASK_FAILED, handler);
  }

  /**
   * Register task aborted handler
   */
  onTaskAborted(handler: TaskAbortedHandler): void {
    this.on(HookEventType.TASK_ABORTED, handler);
  }

  /**
   * Register background task notification handler (Claude Code 2.x)
   */
  onTaskNotification(handler: TaskNotificationHandler): void {
    this.on(HookEventType.TASK_NOTIFICATION, handler);
  }

  /**
   * Register tool before execution handler
   * Return false to prevent execution
   */
  onToolBeforeExecution(handler: ToolBeforeExecutionHandler): void {
    this.on(HookEventType.TOOL_BEFORE_EXECUTION, handler);
  }

  /**
   * Register tool after execution handler
   */
  onToolAfterExecution(handler: ToolAfterExecutionHandler): void {
    this.on(HookEventType.TOOL_AFTER_EXECUTION, handler);
  }

  /**
   * Register progress handler
   */
  onProgress(handler: ProgressHandler): void {
    this.on(HookEventType.PROGRESS_UPDATE, handler);
  }

  /**
   * Register confirmation handler
   */
  onConfirmationRequired(handler: ConfirmationHandler): void {
    this.confirmationHandler = handler;
  }

  /**
   * Register user input handler
   */
  onUserInputRequired(handler: UserInputHandler): void {
    this.userInputHandler = handler;
  }

  /**
   * Request authorization for an operation
   */
  async requestAuthorization(context: AuthorizationContext): Promise<AuthorizationDecision> {
    // Debug: Log authorization request
    const timestamp = new Date().toISOString();
    console.log(`[ClaudeCodeHooks ${timestamp}] Authorization requested:`, {
      actionType: context.actionType,
      description: context.description,
      riskLevel: context.riskLevel,
      details: context.details,
    });

    // Check cache first
    const cacheKey = this.getAuthorizationCacheKey(context);
    const cached = this.authorizationCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      console.log(`[ClaudeCodeHooks ${timestamp}] Using cached authorization decision: granted=${cached.decision.granted}`);
      this.emit(HookEventType.AUTHORIZATION_GRANTED, context, cached.decision);
      return cached.decision;
    }

    // No handler registered, default to deny for safety
    if (!this.authorizationHandler) {
      console.log(`[ClaudeCodeHooks ${timestamp}] No authorization handler registered, denying by default`);
      const denyDecision: AuthorizationDecision = {
        granted: false,
        reason: 'No authorization handler registered',
      };
      this.emit(HookEventType.AUTHORIZATION_DENIED, context, denyDecision);
      return denyDecision;
    }

    try {
      console.log(`[ClaudeCodeHooks ${timestamp}] Calling authorization handler...`);
      const decision = await this.authorizationHandler(context);
      console.log(`[ClaudeCodeHooks ${timestamp}] Authorization handler returned: granted=${decision.granted}, reason=${decision.reason || 'none'}`);

      // Emit event
      if (decision.granted) {
        this.emit(HookEventType.AUTHORIZATION_GRANTED, context, decision);
      } else {
        this.emit(HookEventType.AUTHORIZATION_DENIED, context, decision);
      }

      // Cache decision if requested
      if (decision.remember && decision.granted) {
        const duration = decision.rememberDuration || 0;
        this.authorizationCache.set(cacheKey, {
          decision,
          expiresAt: duration > 0 ? Date.now() + duration : Number.MAX_SAFE_INTEGER,
        });
        console.log(`[ClaudeCodeHooks ${timestamp}] Cached authorization decision for key: ${cacheKey}`);
      }

      return decision;
    } catch (error) {
      // Handler threw error, deny for safety
      console.error(`[ClaudeCodeHooks ${timestamp}] Authorization handler threw error:`, error);
      const denyDecision: AuthorizationDecision = {
        granted: false,
        reason: `Authorization handler error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
      this.emit(HookEventType.AUTHORIZATION_DENIED, context, denyDecision);
      return denyDecision;
    }
  }

  /**
   * Notify task started
   */
  async notifyTaskStarted(context: TaskContext): Promise<void> {
    this.emit(HookEventType.TASK_STARTED, context);
  }

  /**
   * Notify task completed
   */
  async notifyTaskCompleted(context: TaskContext, result: TaskResult): Promise<void> {
    this.emit(HookEventType.TASK_COMPLETED, context, result);
  }

  /**
   * Notify task failed
   */
  async notifyTaskFailed(context: TaskContext, error: Error): Promise<void> {
    this.emit(HookEventType.TASK_FAILED, context, error);
  }

  /**
   * Notify task aborted
   */
  async notifyTaskAborted(context: TaskContext, reason: string): Promise<void> {
    this.emit(HookEventType.TASK_ABORTED, context, reason);
  }

  /**
   * Notify background task notification (Claude Code 2.x)
   */
  async notifyTaskNotification(context: TaskNotificationContext): Promise<void> {
    this.emit(HookEventType.TASK_NOTIFICATION, context);
  }

  /**
   * Check if tool execution is allowed
   * Returns false to prevent execution
   */
  async checkToolExecution(context: ToolExecutionContext): Promise<boolean> {
    const timestamp = new Date().toISOString();
    console.log(`[ClaudeCodeHooks ${timestamp}] Checking tool execution:`, {
      toolName: context.toolName,
      params: context.params,
      taskId: context.taskId,
    });

    const handlers = this.listeners(HookEventType.TOOL_BEFORE_EXECUTION) as ToolBeforeExecutionHandler[];
    console.log(`[ClaudeCodeHooks ${timestamp}] Found ${handlers.length} tool before execution handlers`);

    for (const handler of handlers) {
      try {
        const result = await handler(context);
        console.log(`[ClaudeCodeHooks ${timestamp}] Handler returned:`, result);
        // If any handler returns false, prevent execution
        if (result === false) {
          console.log(`[ClaudeCodeHooks ${timestamp}] Tool execution blocked by handler`);
          return false;
        }
      } catch (error) {
        // Handler error, log but continue
        console.error('[ClaudeCodeHooks] Tool before execution handler error:', error);
      }
    }

    console.log(`[ClaudeCodeHooks ${timestamp}] Tool execution allowed`);
    return true;
  }

  /**
   * Notify tool after execution
   */
  async notifyToolExecuted(context: ToolExecutionContext, result: ToolExecutionResult): Promise<void> {
    this.emit(HookEventType.TOOL_AFTER_EXECUTION, context, result);
  }

  /**
   * Update progress
   */
  async updateProgress(update: ProgressUpdate): Promise<void> {
    this.emit(HookEventType.PROGRESS_UPDATE, update);
  }

  /**
   * Request user confirmation
   */
  async requestConfirmation(request: ConfirmationRequest): Promise<boolean> {
    const timestamp = new Date().toISOString();
    console.log(`[ClaudeCodeHooks ${timestamp}] Confirmation requested:`, {
      prompt: request.prompt,
      description: request.description,
      defaultValue: request.defaultValue,
      timeout: request.timeout,
    });

    if (!this.confirmationHandler) {
      // Default to false if no handler
      console.log(`[ClaudeCodeHooks ${timestamp}] No confirmation handler registered, returning false`);
      return false;
    }

    try {
      console.log(`[ClaudeCodeHooks ${timestamp}] Calling confirmation handler...`);
      const result = await this.confirmationHandler(request);
      console.log(`[ClaudeCodeHooks ${timestamp}] Confirmation handler returned: ${result}`);
      return result;
    } catch (error) {
      console.error('[ClaudeCodeHooks] Confirmation handler error:', error);
      return false;
    }
  }

  /**
   * Request user input
   */
  async requestUserInput(request: UserInputRequest): Promise<string | null> {
    const timestamp = new Date().toISOString();
    console.log(`[ClaudeCodeHooks ${timestamp}] User input requested:`, {
      prompt: request.prompt,
      type: request.type,
      timeout: request.timeout,
    });

    if (!this.userInputHandler) {
      // Default to null if no handler
      console.log(`[ClaudeCodeHooks ${timestamp}] No user input handler registered, returning null`);
      return null;
    }

    try {
      console.log(`[ClaudeCodeHooks ${timestamp}] Calling user input handler...`);
      const result = await this.userInputHandler(request);
      console.log(`[ClaudeCodeHooks ${timestamp}] User input handler returned: ${result ? '<input received>' : 'null'}`);
      return result;
    } catch (error) {
      console.error('[ClaudeCodeHooks] User input handler error:', error);
      return null;
    }
  }

  /**
   * Clear authorization cache
   */
  clearAuthorizationCache(): void {
    this.authorizationCache.clear();
  }

  /**
   * Remove all handlers
   */
  removeAllHandlers(): void {
    this.authorizationHandler = undefined;
    this.confirmationHandler = undefined;
    this.userInputHandler = undefined;
    this.authorizationCache.clear();
    this.removeAllListeners();
  }

  /**
   * Generate cache key for authorization
   */
  private getAuthorizationCacheKey(context: AuthorizationContext): string {
    // Create a key based on action type and relevant details
    const parts: string[] = [context.actionType];

    if (context.details.filePath) {
      parts.push(context.details.filePath);
    }
    if (context.details.command) {
      // Normalize command by removing arguments for broader matching
      parts.push(context.details.command.split(' ')[0]);
    }

    return parts.join(':');
  }
}

// Export singleton instance
export const claudeCodeHooks = new ClaudeCodeHooks();
