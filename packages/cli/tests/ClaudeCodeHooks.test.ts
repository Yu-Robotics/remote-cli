import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ClaudeCodeHooks,
  HookEventType,
  AuthorizationContext,
  TaskContext,
  TaskResult,
  ToolExecutionContext,
  ToolExecutionResult,
  ProgressUpdate,
  ConfirmationRequest,
  UserInputRequest,
} from '../src/hooks/ClaudeCodeHooks';

describe('ClaudeCodeHooks', () => {
  let hooks: ClaudeCodeHooks;

  beforeEach(() => {
    hooks = new ClaudeCodeHooks();
    // Mock console.log to reduce noise
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    hooks.removeAllHandlers();
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create instance with high max listeners', () => {
      expect(hooks.getMaxListeners()).toBe(100);
    });
  });

  describe('authorization', () => {
    const createAuthContext = (overrides: Partial<AuthorizationContext> = {}): AuthorizationContext => ({
      actionType: 'file_access',
      description: 'Test operation',
      details: {
        filePath: '/test/file.txt',
      },
      riskLevel: 'low',
      timestamp: Date.now(),
      ...overrides,
    });

    describe('requestAuthorization', () => {
      it('should deny by default when no handler is registered', async () => {
        const context = createAuthContext();
        const decision = await hooks.requestAuthorization(context);

        expect(decision.granted).toBe(false);
        expect(decision.reason).toBe('No authorization handler registered');
      });

      it('should call registered handler', async () => {
        const handler = vi.fn().mockResolvedValue({ granted: true });
        hooks.onAuthorizationRequired(handler);

        const context = createAuthContext();
        const decision = await hooks.requestAuthorization(context);

        expect(handler).toHaveBeenCalledWith(context);
        expect(decision.granted).toBe(true);
      });

      it('should emit AUTHORIZATION_GRANTED when granted', async () => {
        const emitSpy = vi.fn();
        hooks.on(HookEventType.AUTHORIZATION_GRANTED, emitSpy);
        hooks.onAuthorizationRequired(() => ({ granted: true }));

        const context = createAuthContext();
        await hooks.requestAuthorization(context);

        expect(emitSpy).toHaveBeenCalled();
      });

      it('should emit AUTHORIZATION_DENIED when denied', async () => {
        const emitSpy = vi.fn();
        hooks.on(HookEventType.AUTHORIZATION_DENIED, emitSpy);
        hooks.onAuthorizationRequired(() => ({ granted: false, reason: 'Test reason' }));

        const context = createAuthContext();
        await hooks.requestAuthorization(context);

        expect(emitSpy).toHaveBeenCalled();
      });

      it('should handle handler errors gracefully', async () => {
        hooks.onAuthorizationRequired(() => {
          throw new Error('Handler error');
        });

        const context = createAuthContext();
        const decision = await hooks.requestAuthorization(context);

        expect(decision.granted).toBe(false);
        expect(decision.reason).toContain('Handler error');
      });

      it('should cache granted decisions with remember flag', async () => {
        const handler = vi.fn().mockResolvedValue({
          granted: true,
          remember: true,
          rememberDuration: 60000,
        });
        hooks.onAuthorizationRequired(handler);

        const context = createAuthContext();

        // First call
        await hooks.requestAuthorization(context);
        expect(handler).toHaveBeenCalledTimes(1);

        // Second call should use cache
        await hooks.requestAuthorization(context);
        expect(handler).toHaveBeenCalledTimes(1); // Not called again
      });

      it('should not cache denied decisions', async () => {
        const handler = vi.fn().mockResolvedValue({
          granted: false,
          remember: true,
        });
        hooks.onAuthorizationRequired(handler);

        const context = createAuthContext();

        await hooks.requestAuthorization(context);
        await hooks.requestAuthorization(context);

        expect(handler).toHaveBeenCalledTimes(2);
      });
    });

    describe('clearAuthorizationCache', () => {
      it('should clear cached decisions', async () => {
        const handler = vi.fn().mockResolvedValue({
          granted: true,
          remember: true,
          rememberDuration: 60000,
        });
        hooks.onAuthorizationRequired(handler);

        const context = createAuthContext();
        await hooks.requestAuthorization(context);

        hooks.clearAuthorizationCache();

        await hooks.requestAuthorization(context);
        expect(handler).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('task lifecycle', () => {
    const createTaskContext = (overrides: Partial<TaskContext> = {}): TaskContext => ({
      taskId: 'task-123',
      description: 'Test task',
      workingDirectory: '/test/dir',
      sessionId: 'session-456',
      startTime: Date.now(),
      ...overrides,
    });

    const createTaskResult = (overrides: Partial<TaskResult> = {}): TaskResult => ({
      success: true,
      output: 'Task output',
      endTime: Date.now(),
      ...overrides,
    });

    describe('onTaskStarted', () => {
      it('should register task started handler', async () => {
        const handler = vi.fn();
        hooks.onTaskStarted(handler);

        const context = createTaskContext();
        await hooks.notifyTaskStarted(context);

        expect(handler).toHaveBeenCalledWith(context);
      });
    });

    describe('onTaskCompleted', () => {
      it('should register task completed handler', async () => {
        const handler = vi.fn();
        hooks.onTaskCompleted(handler);

        const context = createTaskContext();
        const result = createTaskResult();
        await hooks.notifyTaskCompleted(context, result);

        expect(handler).toHaveBeenCalledWith(context, result);
      });
    });

    describe('onTaskFailed', () => {
      it('should register task failed handler', async () => {
        const handler = vi.fn();
        hooks.onTaskFailed(handler);

        const context = createTaskContext();
        const error = new Error('Task failed');
        await hooks.notifyTaskFailed(context, error);

        expect(handler).toHaveBeenCalledWith(context, error);
      });
    });

    describe('onTaskAborted', () => {
      it('should register task aborted handler', async () => {
        const handler = vi.fn();
        hooks.onTaskAborted(handler);

        const context = createTaskContext();
        await hooks.notifyTaskAborted(context, 'User cancelled');

        expect(handler).toHaveBeenCalledWith(context, 'User cancelled');
      });
    });
  });

  describe('tool execution', () => {
    const createToolContext = (overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext => ({
      toolName: 'test_tool',
      params: { arg1: 'value1' },
      timestamp: Date.now(),
      taskId: 'task-123',
      ...overrides,
    });

    const createToolResult = (overrides: Partial<ToolExecutionResult> = {}): ToolExecutionResult => ({
      success: true,
      result: { data: 'result' },
      duration: 100,
      ...overrides,
    });

    describe('checkToolExecution', () => {
      it('should return true when no handlers registered', async () => {
        const context = createToolContext();
        const result = await hooks.checkToolExecution(context);
        expect(result).toBe(true);
      });

      it('should return true when handler returns true', async () => {
        hooks.onToolBeforeExecution(() => true);

        const context = createToolContext();
        const result = await hooks.checkToolExecution(context);
        expect(result).toBe(true);
      });

      it('should return false when handler returns false', async () => {
        hooks.onToolBeforeExecution(() => false);

        const context = createToolContext();
        const result = await hooks.checkToolExecution(context);
        expect(result).toBe(false);
      });

      it('should return false if any handler returns false', async () => {
        hooks.onToolBeforeExecution(() => true);
        hooks.onToolBeforeExecution(() => false);
        hooks.onToolBeforeExecution(() => true);

        const context = createToolContext();
        const result = await hooks.checkToolExecution(context);
        expect(result).toBe(false);
      });

      it('should continue checking if handler throws', async () => {
        hooks.onToolBeforeExecution(() => {
          throw new Error('Handler error');
        });
        hooks.onToolBeforeExecution(() => true);

        const context = createToolContext();
        const result = await hooks.checkToolExecution(context);
        expect(result).toBe(true);
      });
    });

    describe('notifyToolExecuted', () => {
      it('should emit tool after execution event', async () => {
        const handler = vi.fn();
        hooks.onToolAfterExecution(handler);

        const context = createToolContext();
        const result = createToolResult();
        await hooks.notifyToolExecuted(context, result);

        expect(handler).toHaveBeenCalledWith(context, result);
      });
    });
  });

  describe('progress updates', () => {
    describe('updateProgress', () => {
      it('should emit progress update event', async () => {
        const handler = vi.fn();
        hooks.onProgress(handler);

        const update: ProgressUpdate = {
          progress: 50,
          message: 'Halfway done',
          step: 5,
          totalSteps: 10,
        };
        await hooks.updateProgress(update);

        expect(handler).toHaveBeenCalledWith(update);
      });
    });
  });

  describe('confirmation', () => {
    describe('requestConfirmation', () => {
      it('should return false when no handler registered', async () => {
        const request: ConfirmationRequest = {
          prompt: 'Continue?',
          description: 'This will do something',
        };
        const result = await hooks.requestConfirmation(request);
        expect(result).toBe(false);
      });

      it('should call registered handler', async () => {
        const handler = vi.fn().mockResolvedValue(true);
        hooks.onConfirmationRequired(handler);

        const request: ConfirmationRequest = {
          prompt: 'Continue?',
        };
        const result = await hooks.requestConfirmation(request);

        expect(handler).toHaveBeenCalledWith(request);
        expect(result).toBe(true);
      });

      it('should return false on handler error', async () => {
        hooks.onConfirmationRequired(() => {
          throw new Error('Handler error');
        });

        const request: ConfirmationRequest = {
          prompt: 'Continue?',
        };
        const result = await hooks.requestConfirmation(request);
        expect(result).toBe(false);
      });
    });
  });

  describe('user input', () => {
    describe('requestUserInput', () => {
      it('should return null when no handler registered', async () => {
        const request: UserInputRequest = {
          prompt: 'Enter value:',
          type: 'text',
        };
        const result = await hooks.requestUserInput(request);
        expect(result).toBe(null);
      });

      it('should call registered handler', async () => {
        const handler = vi.fn().mockResolvedValue('user input');
        hooks.onUserInputRequired(handler);

        const request: UserInputRequest = {
          prompt: 'Enter value:',
          type: 'text',
        };
        const result = await hooks.requestUserInput(request);

        expect(handler).toHaveBeenCalledWith(request);
        expect(result).toBe('user input');
      });

      it('should return null on handler error', async () => {
        hooks.onUserInputRequired(() => {
          throw new Error('Handler error');
        });

        const request: UserInputRequest = {
          prompt: 'Enter value:',
          type: 'text',
        };
        const result = await hooks.requestUserInput(request);
        expect(result).toBe(null);
      });
    });
  });

  describe('removeAllHandlers', () => {
    it('should remove all registered handlers', async () => {
      const authHandler = vi.fn().mockResolvedValue({ granted: true, remember: true });
      const confirmHandler = vi.fn().mockResolvedValue(true);
      const inputHandler = vi.fn().mockResolvedValue('input');
      const taskHandler = vi.fn();

      hooks.onAuthorizationRequired(authHandler);
      hooks.onConfirmationRequired(confirmHandler);
      hooks.onUserInputRequired(inputHandler);
      hooks.onTaskStarted(taskHandler);

      // Populate cache
      await hooks.requestAuthorization({
        actionType: 'file_access',
        description: 'Test',
        details: {},
        riskLevel: 'low',
        timestamp: Date.now(),
      });

      hooks.removeAllHandlers();

      // Handlers should no longer be called
      const authResult = await hooks.requestAuthorization({
        actionType: 'file_access',
        description: 'Test',
        details: {},
        riskLevel: 'low',
        timestamp: Date.now(),
      });
      expect(authResult.granted).toBe(false);
      expect(authResult.reason).toBe('No authorization handler registered');

      const confirmResult = await hooks.requestConfirmation({ prompt: 'Test' });
      expect(confirmResult).toBe(false);

      const inputResult = await hooks.requestUserInput({ prompt: 'Test', type: 'text' });
      expect(inputResult).toBe(null);
    });
  });

  describe('HookEventType enum', () => {
    it('should have all expected event types', () => {
      expect(HookEventType.AUTHORIZATION_REQUIRED).toBe('authorization:required');
      expect(HookEventType.AUTHORIZATION_GRANTED).toBe('authorization:granted');
      expect(HookEventType.AUTHORIZATION_DENIED).toBe('authorization:denied');
      expect(HookEventType.TASK_STARTED).toBe('task:started');
      expect(HookEventType.TASK_COMPLETED).toBe('task:completed');
      expect(HookEventType.TASK_FAILED).toBe('task:failed');
      expect(HookEventType.TASK_ABORTED).toBe('task:aborted');
      expect(HookEventType.TOOL_BEFORE_EXECUTION).toBe('tool:beforeExecution');
      expect(HookEventType.TOOL_AFTER_EXECUTION).toBe('tool:afterExecution');
      expect(HookEventType.PROGRESS_UPDATE).toBe('progress:update');
      expect(HookEventType.USER_INPUT_REQUIRED).toBe('user:inputRequired');
      expect(HookEventType.CONFIRMATION_REQUIRED).toBe('user:confirmationRequired');
    });
  });
});
