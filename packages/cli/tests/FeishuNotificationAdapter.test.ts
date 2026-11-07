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

    it.each([
      ['low', true, { filePath: '/test/file.txt' }],
      ['medium', false, { command: 'npm test' }],
      ['high', false, {}], ['critical', false, {}],
    ] as const)('reports %s risk and preserves its authorization policy', async (riskLevel, granted, details) => {
      const decision = await claudeCodeHooks.requestAuthorization({
        actionType: 'file_access',
        description: 'Review file',
        details,
        riskLevel,
        timestamp: Date.now(),
      });
      expect(mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'notification',
          title: expect.stringContaining('Authorization'),
          openId: 'user-123',
          message: expect.stringContaining(riskLevel.toUpperCase()),
        })
      );
      const notice = mockWsClient.send.mock.calls.find((call: any[]) => call[0].title?.includes('Authorization Required'))[0];
      expect(notice.message).toContain('Review file');
      for (const detail of Object.values(details)) expect(notice.message).toContain(detail);
      expect(decision.granted).toBe(granted);
      if (granted) expect(decision.remember).toBe(true);
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

    it.each([0, 25, 50, 75, 100])('sends the progress value and message at the %s%% milestone', progress => {
      claudeCodeHooks.emit(HookEventType.PROGRESS_UPDATE, {
        progress, message: 'Current task progress',
      });
      expect(mockWsClient.send).toHaveBeenCalledTimes(1);
      expect(mockWsClient.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'notification', openId: 'user-123', message: expect.stringContaining(`${progress}%`),
      }));
      expect(mockWsClient.send.mock.calls[0][0].message).toContain('Current task progress');
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


  describe('retired background terminal presentation', () => {
    const task = { taskId: 'native-task-sentinel', status: 'completed' as const, summary: 'Background summary sentinel', outputFile: '', threadId: 'thread' };
    it.each([undefined, [], ['task_notification']])('cannot emit through native hooks with legacy settings %j', enabledNotifications => {
      const configured = new FeishuNotificationAdapter(mockWsClient, { enabledNotifications });
      configured.setCurrentOpenId('owner'); configured.register(); configured.enableNotification('task_notification');
      const internal = vi.fn(); claudeCodeHooks.onTaskNotification(internal);
      try {
        for (const status of ['completed', 'failed', 'stopped']) claudeCodeHooks.emit(HookEventType.TASK_NOTIFICATION, { ...task, status });
        expect(mockWsClient.send).not.toHaveBeenCalled(); expect(internal).toHaveBeenCalledTimes(3);
        expect(configured.getEnabledNotifications()).not.toContain('task_notification');
        expect(JSON.stringify(vi.mocked(console.log).mock.calls.filter(([line]) => String(line).startsWith('[FeishuAdapter]')))).not.toContain(task.taskId);
      } finally { configured.unregister(); claudeCodeHooks.removeListener(HookEventType.TASK_NOTIFICATION, internal); }
    });
    it.each(['owner', undefined])('keeps the deprecated direct method silent for recipient %j even after explicit enable', recipient => {
      adapter.setCurrentOpenId('another-owner'); adapter.enableNotification('task_notification');
      adapter.setThreadNameResolver(() => 'Another thread'); adapter.sendTaskNotification(task, recipient);
      expect(mockWsClient.send).not.toHaveBeenCalled();
      expect(JSON.stringify(vi.mocked(console.log).mock.calls.filter(([line]) => String(line).startsWith('[FeishuAdapter]')))).not.toContain(task.taskId);
    });
    it('keeps background hooks internal after unregister and allows actionable input notifications', async () => {
      adapter.register(); adapter.setCurrentOpenId('owner'); adapter.unregister();
      claudeCodeHooks.emit(HookEventType.TASK_NOTIFICATION, task);
      expect(mockWsClient.send).not.toHaveBeenCalled();
      adapter.register();
      await claudeCodeHooks.requestUserInput({ prompt: 'Choose an option', type: 'text' });
      expect(mockWsClient.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'notification', title: '⌨️ Waiting for Input', openId: 'owner' }));
    });
  });
});
