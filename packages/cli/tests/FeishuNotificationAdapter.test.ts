import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FeishuNotificationAdapter } from '../src/hooks/FeishuNotificationAdapter';
import { claudeCodeHooks, HookEventType } from '../src/hooks/ClaudeCodeHooks';
import { WebSocketClient } from '../src/client/WebSocketClient';

// Mock WebSocketClient
vi.mock('../src/client/WebSocketClient', () => {
  return {
    WebSocketClient: vi.fn().mockImplementation(() => ({
      send: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      isConnected: vi.fn().mockReturnValue(true),
    })),
  };
});

describe('FeishuNotificationAdapter', () => {
  let adapter: FeishuNotificationAdapter;
  let mockWsClient: any;

  beforeEach(() => {
    // Create fresh mock
    mockWsClient = {
      send: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      isConnected: vi.fn().mockReturnValue(true),
    };

    adapter = new FeishuNotificationAdapter(mockWsClient as WebSocketClient);

    // Mock console to reduce noise
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    adapter.unregister();
    claudeCodeHooks.removeAllHandlers();
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create adapter with default enabled notifications', () => {
      const defaultAdapter = new FeishuNotificationAdapter(mockWsClient);
      const enabled = defaultAdapter.getEnabledNotifications();

      expect(enabled).toContain('task_started');
      expect(enabled).toContain('task_completed');
      expect(enabled).toContain('task_failed');
      expect(enabled).toContain('task_aborted');
      expect(enabled).toContain('authorization_required');
    });

    it('should create adapter with custom enabled notifications', () => {
      const customAdapter = new FeishuNotificationAdapter(mockWsClient, {
        enabledNotifications: ['task_started', 'task_completed'],
      });
      const enabled = customAdapter.getEnabledNotifications();

      expect(enabled).toContain('task_started');
      expect(enabled).toContain('task_completed');
      expect(enabled).not.toContain('task_failed');
    });
  });

  describe('setCurrentOpenId', () => {
    it('should set the current open ID', () => {
      adapter.setCurrentOpenId('user-123');
      // Verify indirectly by checking notifications work
      adapter.register();
      claudeCodeHooks.emit(HookEventType.TASK_STARTED, {
        taskId: 'task-1',
        workingDirectory: '/test',
        description: 'Test',
        startTime: Date.now(),
      });

      expect(mockWsClient.send).toHaveBeenCalled();
    });

    it('should skip notifications when openId is not set', () => {
      adapter.register();
      claudeCodeHooks.emit(HookEventType.TASK_STARTED, {
        taskId: 'task-1',
        workingDirectory: '/test',
        description: 'Test',
        startTime: Date.now(),
      });

      expect(mockWsClient.send).not.toHaveBeenCalled();
    });
  });

  describe('register', () => {
    it('should register all hook handlers', () => {
      adapter.register();
      adapter.setCurrentOpenId('user-123');

      // Emit a task started event
      claudeCodeHooks.emit(HookEventType.TASK_STARTED, {
        taskId: 'task-1',
        workingDirectory: '/test',
        description: 'Test',
        startTime: Date.now(),
      });

      expect(mockWsClient.send).toHaveBeenCalled();
    });
  });

  describe('unregister', () => {
    it('should unregister all hook handlers', () => {
      adapter.register();
      adapter.setCurrentOpenId('user-123');
      adapter.unregister();

      // Emit a task started event - should not trigger notification
      mockWsClient.send.mockClear();
      claudeCodeHooks.emit(HookEventType.TASK_STARTED, {
        taskId: 'task-1',
        workingDirectory: '/test',
        description: 'Test',
        startTime: Date.now(),
      });

      expect(mockWsClient.send).not.toHaveBeenCalled();
    });
  });

  describe('task notifications', () => {
    beforeEach(() => {
      adapter.register();
      adapter.setCurrentOpenId('user-123');
    });

    it('should send notification on task started', () => {
      claudeCodeHooks.emit(HookEventType.TASK_STARTED, {
        taskId: 'task-1',
        workingDirectory: '/test/dir',
        description: 'Test task',
        startTime: Date.now(),
      });

      expect(mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'notification',
          title: expect.stringContaining('Task Started'),
          openId: 'user-123',
        })
      );
    });

    it('should send notification on task completed', () => {
      claudeCodeHooks.emit(HookEventType.TASK_COMPLETED,
        {
          taskId: 'task-1',
          workingDirectory: '/test/dir',
          description: 'Test task',
          sessionId: 'session-1',
          startTime: Date.now(),
        },
        {
          success: true,
          output: 'Done',
          duration: 5000,
          endTime: Date.now(),
        }
      );

      expect(mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'notification',
          title: expect.stringContaining('Task Completed'),
        })
      );
    });

    it('should send notification on task failed', () => {
      claudeCodeHooks.emit(HookEventType.TASK_FAILED,
        {
          taskId: 'task-1',
          workingDirectory: '/test/dir',
          description: 'Test task',
          sessionId: 'session-1',
          startTime: Date.now(),
        },
        new Error('Task error')
      );

      expect(mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'notification',
          title: expect.stringContaining('Task Failed'),
        })
      );
    });

    it('should send notification on task aborted', () => {
      claudeCodeHooks.emit(HookEventType.TASK_ABORTED,
        {
          taskId: 'task-1',
          workingDirectory: '/test/dir',
          description: 'Test task',
          sessionId: 'session-1',
          startTime: Date.now(),
        },
        'User cancelled'
      );

      expect(mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'notification',
          title: expect.stringContaining('Task Aborted'),
        })
      );
    });

    it('should not send notification when disabled', () => {
      adapter.disableNotification('task_started');
      mockWsClient.send.mockClear();

      claudeCodeHooks.emit(HookEventType.TASK_STARTED, {
        taskId: 'task-1',
        workingDirectory: '/test/dir',
        description: 'Test task',
        startTime: Date.now(),
      });

      expect(mockWsClient.send).not.toHaveBeenCalled();
    });
  });

  describe('authorization notifications', () => {
    beforeEach(() => {
      adapter.register();
      adapter.setCurrentOpenId('user-123');
    });

    it('should send notification for authorization required', async () => {
      const decision = await claudeCodeHooks.requestAuthorization({
        actionType: 'file_access',
        description: 'Read file',
        details: { filePath: '/test/file.txt' },
        riskLevel: 'low',
        timestamp: Date.now(),
      });

      // Check that notification was sent
      expect(mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'notification',
          title: expect.stringContaining('Authorization'),
        })
      );

      // Low risk should be auto-granted
      expect(decision.granted).toBe(true);
    });

    it('should deny medium risk operations', async () => {
      const decision = await claudeCodeHooks.requestAuthorization({
        actionType: 'command_execution',
        description: 'Run command',
        details: { command: 'rm -rf /' },
        riskLevel: 'medium',
        timestamp: Date.now(),
      });

      expect(decision.granted).toBe(false);
    });

    it('should handle authorization granted event', () => {
      claudeCodeHooks.emit(HookEventType.AUTHORIZATION_GRANTED,
        {
          actionType: 'file_access',
          description: 'Read file',
          details: {},
          riskLevel: 'low',
          timestamp: Date.now(),
        },
        { granted: true }
      );

      expect(mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining('Authorization Granted'),
        })
      );
    });

    it('should handle authorization denied event', () => {
      claudeCodeHooks.emit(HookEventType.AUTHORIZATION_DENIED,
        {
          actionType: 'command_execution',
          description: 'Run command',
          details: {},
          riskLevel: 'high',
          timestamp: Date.now(),
        },
        { granted: false, reason: 'Too risky' }
      );

      expect(mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining('Authorization Denied'),
        })
      );
    });
  });

  describe('progress notifications', () => {
    beforeEach(() => {
      adapter.register();
      adapter.setCurrentOpenId('user-123');
    });

    it('should send notification for 0% progress', () => {
      claudeCodeHooks.emit(HookEventType.PROGRESS_UPDATE, {
        progress: 0,
        message: 'Starting...',
      });

      expect(mockWsClient.send).toHaveBeenCalled();
    });

    it('should send notification for 25% progress', () => {
      claudeCodeHooks.emit(HookEventType.PROGRESS_UPDATE, {
        progress: 25,
        message: '25% done',
      });

      expect(mockWsClient.send).toHaveBeenCalled();
    });

    it('should send notification for 50% progress', () => {
      claudeCodeHooks.emit(HookEventType.PROGRESS_UPDATE, {
        progress: 50,
        message: 'Halfway',
      });

      expect(mockWsClient.send).toHaveBeenCalled();
    });

    it('should send notification for 100% progress', () => {
      claudeCodeHooks.emit(HookEventType.PROGRESS_UPDATE, {
        progress: 100,
        message: 'Complete',
      });

      expect(mockWsClient.send).toHaveBeenCalled();
    });

    it('should not send notification for non-milestone progress', () => {
      mockWsClient.send.mockClear();
      claudeCodeHooks.emit(HookEventType.PROGRESS_UPDATE, {
        progress: 33,
        message: '33% done',
      });

      expect(mockWsClient.send).not.toHaveBeenCalled();
    });
  });

  describe('tool execution handlers', () => {
    beforeEach(() => {
      adapter.register();
      adapter.setCurrentOpenId('user-123');
    });

    it('should allow tool execution by default', async () => {
      const allowed = await claudeCodeHooks.checkToolExecution({
        toolName: 'test_tool',
        params: { arg: 'value' },
        timestamp: Date.now(),
      });

      expect(allowed).toBe(true);
    });

    it('should log tool after execution', () => {
      claudeCodeHooks.emit(HookEventType.TOOL_AFTER_EXECUTION,
        {
          toolName: 'test_tool',
          params: {},
          timestamp: Date.now(),
        },
        {
          success: true,
          duration: 100,
        }
      );

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('test_tool')
      );
    });
  });

  describe('notification management', () => {
    it('should enable notification', () => {
      adapter.enableNotification('custom_notification');
      expect(adapter.getEnabledNotifications()).toContain('custom_notification');
    });

    it('should disable notification', () => {
      adapter.disableNotification('task_started');
      expect(adapter.getEnabledNotifications()).not.toContain('task_started');
    });

    it('should return list of enabled notifications', () => {
      const enabled = adapter.getEnabledNotifications();
      expect(Array.isArray(enabled)).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should handle send errors gracefully', () => {
      mockWsClient.send.mockImplementation(() => {
        throw new Error('Send failed');
      });

      adapter.register();
      adapter.setCurrentOpenId('user-123');

      // Should not throw
      expect(() => {
        claudeCodeHooks.emit(HookEventType.TASK_STARTED, {
          taskId: 'task-1',
          workingDirectory: '/test',
          description: 'Test',
          startTime: Date.now(),
        });
      }).not.toThrow();
    });
  });

  describe('risk level emoji', () => {
    beforeEach(() => {
      adapter.register();
      adapter.setCurrentOpenId('user-123');
    });

    it('should use green emoji for low risk', async () => {
      await claudeCodeHooks.requestAuthorization({
        actionType: 'file_access',
        description: 'Read file',
        details: {},
        riskLevel: 'low',
        timestamp: Date.now(),
      });

      const call = mockWsClient.send.mock.calls.find(
        (c: any[]) => c[0].title?.includes('Authorization Required')
      );
      expect(call?.[0].message).toContain('🟢');
    });

    it('should use yellow emoji for medium risk', async () => {
      await claudeCodeHooks.requestAuthorization({
        actionType: 'command_execution',
        description: 'Run command',
        details: {},
        riskLevel: 'medium',
        timestamp: Date.now(),
      });

      const call = mockWsClient.send.mock.calls.find(
        (c: any[]) => c[0].title?.includes('Authorization Required')
      );
      expect(call?.[0].message).toContain('🟡');
    });

    it('should use orange emoji for high risk', async () => {
      await claudeCodeHooks.requestAuthorization({
        actionType: 'sensitive_operation',
        description: 'Delete file',
        details: {},
        riskLevel: 'high',
        timestamp: Date.now(),
      });

      const call = mockWsClient.send.mock.calls.find(
        (c: any[]) => c[0].title?.includes('Authorization Required')
      );
      expect(call?.[0].message).toContain('🟠');
    });

    it('should use red emoji for critical risk', async () => {
      await claudeCodeHooks.requestAuthorization({
        actionType: 'sensitive_operation',
        description: 'Drop database',
        details: {},
        riskLevel: 'critical',
        timestamp: Date.now(),
      });

      const call = mockWsClient.send.mock.calls.find(
        (c: any[]) => c[0].title?.includes('Authorization Required')
      );
      expect(call?.[0].message).toContain('🔴');
    });
  });
});
