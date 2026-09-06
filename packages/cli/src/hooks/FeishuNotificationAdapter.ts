import {
  claudeCodeHooks,
  HookEventType,
  TaskContext,
  TaskResult,
  AuthorizationContext,
  AuthorizationDecision,
  ToolExecutionContext,
  ToolExecutionResult,
  ProgressUpdate,
  UserInputRequest,
  TaskNotificationContext,
} from './ClaudeCodeHooks';
import { WebSocketClient } from '../client/WebSocketClient';
import { v4 as uuidv4 } from 'uuid';

/**
 * Feishu Notification Adapter
 *
 * Registers hook handlers to send notifications to Feishu via WebSocket.
 * This allows users to be notified when:
 * - Tasks start/complete/fail/abort
 * - Authorization is required
 * - Progress updates occur
 * - Tools are executed
 */
export class FeishuNotificationAdapter {
  private wsClient: WebSocketClient;
  private currentOpenId?: string;
  private enabledNotifications: Set<string>;
  /** Resolves a thread ID to its display name (wired by MessageHandler) */
  private threadNameResolver?: (threadId: string) => string | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private registeredHandlers: Array<{ event: string; handler: (...args: any[]) => any }> = [];

  /**
   * Create a new Feishu notification adapter
   * @param wsClient WebSocket client for sending notifications
   * @param options Configuration options
   */
  constructor(
    wsClient: WebSocketClient,
    options: {
      enabledNotifications?: string[];
    } = {}
  ) {
    this.wsClient = wsClient;
    this.enabledNotifications = new Set(options.enabledNotifications || [
      'task_started',
      'task_completed',
      'task_failed',
      'task_aborted',
      'authorization_required',
      'task_notification',
    ]);
  }

  /**
   * Set the current OpenID for message routing
   */
  setCurrentOpenId(openId: string | undefined): void {
    this.currentOpenId = openId;
  }

  /**
   * Set a resolver that maps thread IDs to display names.
   * Used to enrich background task notifications with the thread name.
   */
  setThreadNameResolver(resolver: (threadId: string) => string | undefined): void {
    this.threadNameResolver = resolver;
  }

  /**
   * Register all hook handlers
   */
  register(): void {
    this.registerTaskHandlers();
    this.registerAuthorizationHandler();
    this.registerToolExecutionHandlers();
    this.registerProgressHandler();
    this.registerUserInputHandler();
    this.registerTaskNotificationHandler();
  }

  /**
   * Unregister all hook handlers
   */
  unregister(): void {
    // Remove only our registered handlers
    for (const { event, handler } of this.registeredHandlers) {
      claudeCodeHooks.removeListener(event, handler);
    }
    this.registeredHandlers = [];
  }

  /**
   * Register a handler and store its reference for cleanup
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private registerHandler(event: string, handler: (...args: any[]) => any): void {
    claudeCodeHooks.on(event, handler);
    this.registeredHandlers.push({ event, handler });
  }

  /**
   * Register task lifecycle handlers
   */
  private registerTaskHandlers(): void {
    // Task started
    const taskStartedHandler = (context: TaskContext) => {
      if (!this.enabledNotifications.has('task_started')) return;

      this.sendNotification('⏳ Task Started', `Task ID: ${context.taskId}\nWorking Directory: ${context.workingDirectory}`);
    };
    claudeCodeHooks.onTaskStarted(taskStartedHandler);
    this.registeredHandlers.push({ event: HookEventType.TASK_STARTED, handler: taskStartedHandler });

    // Task completed
    const taskCompletedHandler = (context: TaskContext, result: TaskResult) => {
      if (!this.enabledNotifications.has('task_completed')) return;

      const duration = result.duration ? ` (${Math.round(result.duration / 1000)}s)` : '';
      this.sendNotification(
        '✅ Task Completed',
        `Task completed successfully${duration}\nSession: ${context.sessionId || 'N/A'}`
      );
    };
    claudeCodeHooks.onTaskCompleted(taskCompletedHandler);
    this.registeredHandlers.push({ event: HookEventType.TASK_COMPLETED, handler: taskCompletedHandler });

    // Task failed
    const taskFailedHandler = (context: TaskContext, error: Error) => {
      if (!this.enabledNotifications.has('task_failed')) return;

      this.sendNotification(
        '❌ Task Failed',
        `Error: ${error.message}\nSession: ${context.sessionId || 'N/A'}`
      );
    };
    claudeCodeHooks.onTaskFailed(taskFailedHandler);
    this.registeredHandlers.push({ event: HookEventType.TASK_FAILED, handler: taskFailedHandler });

    // Task aborted
    const taskAbortedHandler = (context: TaskContext, reason: string) => {
      if (!this.enabledNotifications.has('task_aborted')) return;

      this.sendNotification(
        '🛑 Task Aborted',
        `Reason: ${reason}\nSession: ${context.sessionId || 'N/A'}`
      );
    };
    claudeCodeHooks.onTaskAborted(taskAbortedHandler);
    this.registeredHandlers.push({ event: HookEventType.TASK_ABORTED, handler: taskAbortedHandler });
  }

  /**
   * Register authorization handler
   */
  private registerAuthorizationHandler(): void {
    const authHandler = async (context: AuthorizationContext): Promise<AuthorizationDecision> => {
      if (!this.enabledNotifications.has('authorization_required')) {
        // Default deny if no handler registered
        return { granted: false, reason: 'Authorization notifications disabled' };
      }

      // Send notification about authorization requirement
      const riskEmoji = this.getRiskLevelEmoji(context.riskLevel);
      const message = `${riskEmoji} Authorization Required

**Action:** ${context.actionType}
**Description:** ${context.description}
**Risk Level:** ${context.riskLevel.toUpperCase()}

${context.details.filePath ? `**Path:** ${context.details.filePath}` : ''}
${context.details.command ? `**Command:** ${context.details.command}` : ''}

Please respond with /authorize grant or /authorize deny`;

      this.sendNotification('🔒 Authorization Required', message);

      // For now, auto-grant low-risk operations after notification
      // In the future, this could wait for user response
      if (context.riskLevel === 'low') {
        return {
          granted: true,
          remember: true,
          rememberDuration: 5 * 60 * 1000, // Remember for 5 minutes
        };
      }

      // For medium+ risk, require manual authorization
      // TODO: Implement wait-for-response mechanism
      return {
        granted: false,
        reason: 'Medium/high risk operations require manual authorization. Use /authorize grant <task-id>',
      };
    };
    claudeCodeHooks.onAuthorizationRequired(authHandler);
    this.registeredHandlers.push({ event: HookEventType.AUTHORIZATION_REQUIRED, handler: authHandler as (...args: unknown[]) => unknown });

    // Listen for authorization decisions
    const authGrantedHandler = (context: AuthorizationContext, decision: AuthorizationDecision) => {
      this.sendNotification('✅ Authorization Granted', `${context.description} has been approved.`);
    };
    claudeCodeHooks.on(HookEventType.AUTHORIZATION_GRANTED, authGrantedHandler);
    this.registeredHandlers.push({ event: HookEventType.AUTHORIZATION_GRANTED, handler: authGrantedHandler });

    const authDeniedHandler = (context: AuthorizationContext, decision: AuthorizationDecision) => {
      const reason = decision.reason ? `\nReason: ${decision.reason}` : '';
      this.sendNotification('❌ Authorization Denied', `${context.description} was denied.${reason}`);
    };
    claudeCodeHooks.on(HookEventType.AUTHORIZATION_DENIED, authDeniedHandler);
    this.registeredHandlers.push({ event: HookEventType.AUTHORIZATION_DENIED, handler: authDeniedHandler });
  }

  /**
   * Register tool execution handlers
   */
  private registerToolExecutionHandlers(): void {
    // Tool before execution - can prevent execution
    const toolBeforeHandler = async (context: ToolExecutionContext): Promise<boolean> => {
      console.log(`[FeishuAdapter] Tool ${context.toolName} is about to execute`, context.params);
      // Return true to allow execution, false to block
      return true;
    };
    claudeCodeHooks.onToolBeforeExecution(toolBeforeHandler);
    this.registeredHandlers.push({ event: HookEventType.TOOL_BEFORE_EXECUTION, handler: toolBeforeHandler as (...args: unknown[]) => unknown });

    // Tool after execution - log results
    const toolAfterHandler = (context: ToolExecutionContext, result: ToolExecutionResult) => {
      const status = result.success ? '✅' : '❌';
      const duration = result.duration ? ` (${result.duration}ms)` : '';
      console.log(`[FeishuAdapter] Tool ${context.toolName} completed ${status}${duration}`);
    };
    claudeCodeHooks.onToolAfterExecution(toolAfterHandler);
    this.registeredHandlers.push({ event: HookEventType.TOOL_AFTER_EXECUTION, handler: toolAfterHandler });
  }

  /**
   * Register progress handler
   */
  private registerProgressHandler(): void {
    const progressHandler = async (update: ProgressUpdate): Promise<void> => {
      // Only send progress notifications for significant milestones
      if (update.progress === 0 || update.progress === 100 || update.progress % 25 === 0) {
        const progressBar = this.renderProgressBar(update.progress);
        this.sendNotification('📊 Progress Update', `${progressBar} ${update.progress}%\n${update.message}`);
      }
    };
    claudeCodeHooks.onProgress(progressHandler);
    this.registeredHandlers.push({ event: HookEventType.PROGRESS_UPDATE, handler: progressHandler as (...args: unknown[]) => unknown });
  }

  /**
   * Register background task notification handler (Claude Code 2.x)
   *
   * Unlike the task lifecycle handlers above, these events fire when a
   * background task finishes — often while no command is running — so they
   * are sent as a structured `task_notification` message. The router renders
   * them as a standalone Feishu card (no active streaming card may exist).
   */
  private registerTaskNotificationHandler(): void {
    const handler = (context: TaskNotificationContext) => {
      if (!this.enabledNotifications.has('task_notification')) return;

      if (!this.currentOpenId) {
        console.log(`[FeishuAdapter] No OpenID set, skipping task notification: ${context.taskId}`);
        return;
      }

      try {
        this.wsClient.send({
          type: 'task_notification',
          messageId: uuidv4(),
          openId: this.currentOpenId,
          threadId: context.threadId,
          threadName: context.threadId ? this.threadNameResolver?.(context.threadId) : undefined,
          taskNotification: {
            taskId: context.taskId,
            status: context.status,
            summary: context.summary,
            outputFile: context.outputFile,
          },
          timestamp: Date.now(),
        });
        console.log(`[FeishuAdapter] Sent task notification: ${context.taskId} (${context.status})`);
      } catch (error) {
        console.error('[FeishuAdapter] Failed to send task notification:', error);
      }
    };
    claudeCodeHooks.onTaskNotification(handler);
    this.registeredHandlers.push({ event: HookEventType.TASK_NOTIFICATION, handler });
  }

  /**
   * Register user input handler
   * When Claude requests user input, send notification via Feishu
   */
  private registerUserInputHandler(): void {
    claudeCodeHooks.onUserInputRequired(async (request: UserInputRequest) => {
      const message = `💬 Input Required

**Prompt:** ${request.prompt}

Please reply with your response to continue.`;

      this.sendNotification('⌨️ Waiting for Input', message);

      // Return null - the actual input will be provided through MessageHandler
      // when user sends a message while executor is waiting for input
      return '';
    });
  }

  /**
   * Send notification via WebSocket
   */
  private sendNotification(title: string, message: string): void {
    if (!this.currentOpenId) {
      console.log(`[FeishuAdapter] No OpenID set, skipping notification: ${title}`);
      return;
    }

    try {
      this.wsClient.send({
        type: 'notification',
        title,
        message,
        openId: this.currentOpenId,
        timestamp: Date.now(),
      });
      console.log(`[FeishuAdapter] Sent notification: ${title}`);
    } catch (error) {
      console.error('[FeishuAdapter] Failed to send notification:', error);
    }
  }

  /**
   * Get emoji for risk level
   */
  private getRiskLevelEmoji(riskLevel: string): string {
    switch (riskLevel) {
      case 'low':
        return '🟢';
      case 'medium':
        return '🟡';
      case 'high':
        return '🟠';
      case 'critical':
        return '🔴';
      default:
        return '⚪';
    }
  }

  /**
   * Render a simple progress bar
   */
  private renderProgressBar(progress: number): string {
    const filled = Math.round(progress / 10);
    const empty = 10 - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
  }

  /**
   * Enable specific notification types
   */
  enableNotification(type: string): void {
    this.enabledNotifications.add(type);
  }

  /**
   * Disable specific notification types
   */
  disableNotification(type: string): void {
    this.enabledNotifications.delete(type);
  }

  /**
   * Get list of enabled notifications
   */
  getEnabledNotifications(): string[] {
    return Array.from(this.enabledNotifications);
  }
}
