import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Koa from 'koa';
import Router from '@koa/router';
import { WebSocketServer } from 'ws';
import { RouterServer } from '../src/server';
import { ConfigManager } from '../src/config/ConfigManager';
import { JsonStore } from '../src/storage/JsonStore';
import { FeishuLongConnHandler } from '../src/feishu/FeishuLongConnHandler';
import { ConnectionHub } from '../src/websocket/ConnectionHub';
import { BindingManager } from '../src/binding/BindingManager';
import { MessageType } from '../src/types';

// Mock dependencies (same pattern as server.test.ts)
vi.mock('koa');
vi.mock('koa-bodyparser', () => ({
  default: vi.fn(() => (ctx: any, next: any) => next())
}));
vi.mock('@koa/router');
vi.mock('ws');
vi.mock('http');
vi.mock('../src/config/ConfigManager');
vi.mock('../src/storage/JsonStore');
vi.mock('../src/feishu/FeishuLongConnHandler');
vi.mock('../src/websocket/ConnectionHub');
vi.mock('../src/binding/BindingManager');
// ToolFormatter is intentionally NOT mocked — we want the real card elements

/**
 * Tests for the router's handling of `task_notification` WS messages
 * (Claude Code 2.x background task completion events).
 *
 * Expected behavior: the router sends a standalone Feishu card (there may be
 * no active streaming card) and registers the new card in cardThreadMap so
 * the user can reply to it to continue the originating thread.
 */
describe('RouterServer - task_notification', () => {
  let config: any;
  let store: any;
  let server: RouterServer;
  let mockFeishuHandler: any;
  let mockConnectionHub: any;
  let mockWss: any;
  let resolveThreadCallback: ((feishuMessageId: string) => { threadId: string; deviceId: string } | undefined) | undefined;

  const connectAndBind = async (deviceId: string) => {
    await server.start();
    const onConnection = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn() };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });

    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    await onMessage(Buffer.from(JSON.stringify({
      type: MessageType.BINDING_REQUEST,
      messageId: 'bind-1',
      data: { deviceId, protocolVersion: 1 },
    })));

    return onMessage;
  };

  const sendTaskNotification = (onMessage: (data: Buffer) => Promise<void>, overrides: Record<string, unknown> = {}) => {
    return onMessage(Buffer.from(JSON.stringify({
      type: 'task_notification',
      messageId: 'tn-1',
      openId: 'user-1',
      threadId: 'thread-1',
      taskNotification: {
        taskId: 'b4a2f1c9',
        status: 'completed',
        summary: 'Build finished successfully',
        outputFile: '/tmp/claude-outputs/b4a2f1c9.log',
      },
      timestamp: Date.now(),
      ...overrides,
    })));
  };

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    config = {
      get: vi.fn((section: string, key: string) => {
        if (section === 'server' && key === 'port') return 3000;
        if (section === 'server' && key === 'host') return 'localhost';
        if (section === 'websocket' && key === 'heartbeatInterval') return 30000;
        return 'test-value';
      })
    };

    store = { initialize: vi.fn().mockResolvedValue(undefined) };

    const mockHttpServer = {
      listen: vi.fn().mockReturnThis(),
      close: vi.fn().mockImplementation((cb) => cb && cb()),
      on: vi.fn(),
    };
    const mockKoa = {
      use: vi.fn().mockReturnThis(),
      listen: vi.fn().mockReturnValue(mockHttpServer),
      callback: vi.fn(),
    };
    (Koa as unknown as any).mockImplementation(() => mockKoa);
    (Router as unknown as any).mockImplementation(() => ({
      get: vi.fn().mockReturnThis(),
      post: vi.fn().mockReturnThis(),
      routes: vi.fn(() => (ctx: any, next: any) => next()),
      allowedMethods: vi.fn(() => (ctx: any, next: any) => next()),
    }));

    mockFeishuHandler = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      setConnectionHub: vi.fn(),
      setOnStartStreaming: vi.fn(),
      setOnResolveThread: vi.fn((cb: any) => { resolveThreadCallback = cb; }),
      setOnResolveActiveThread: vi.fn(),
      handleCardAction: vi.fn().mockResolvedValue({ success: true }),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      updateStreamingMessage: vi.fn().mockResolvedValue(undefined),
      finalizeStreamingMessage: vi.fn().mockResolvedValue(undefined),
      sendCommandFromCardAction: vi.fn().mockResolvedValue(undefined),
      sendTaskNotificationCard: vi.fn().mockResolvedValue('feishu-task-card-1'),
    };
    (FeishuLongConnHandler as unknown as any).mockImplementation(() => mockFeishuHandler);

    mockConnectionHub = {
      registerConnection: vi.fn(),
      unregisterConnection: vi.fn(),
      updateLastActive: vi.fn(),
      getConnectionStats: vi.fn().mockReturnValue({ totalConnections: 0, deviceIds: [] }),
      cleanupStaleConnections: vi.fn(),
      closeAllConnections: vi.fn(),
    };
    (ConnectionHub as unknown as any).mockImplementation(() => mockConnectionHub);
    (BindingManager as unknown as any).mockImplementation(() => ({
      generateBindingCode: vi.fn().mockResolvedValue({ code: '123456', expiresAt: Date.now() + 60000 }),
    }));

    mockWss = { on: vi.fn(), close: vi.fn() };
    (WebSocketServer as unknown as any).mockImplementation(() => mockWss);

    vi.spyOn(global, 'setInterval');
    resolveThreadCallback = undefined;
    server = new RouterServer(config, store);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should send a standalone card and register it in cardThreadMap', async () => {
    const onMessage = await connectAndBind('device-1');

    await sendTaskNotification(onMessage);

    // Card sent with real elements from ToolFormatter
    expect(mockFeishuHandler.sendTaskNotificationCard).toHaveBeenCalledTimes(1);
    const [openId, elements] = mockFeishuHandler.sendTaskNotificationCard.mock.calls[0];
    expect(openId).toBe('user-1');
    const cardJson = JSON.stringify(elements);
    expect(cardJson).toContain('TASK COMPLETED');
    expect(cardJson).toContain('Build finished successfully');

    // The new card is registered for reply-to-continue-thread routing
    expect(resolveThreadCallback).toBeDefined();
    const resolved = resolveThreadCallback!('feishu-task-card-1');
    expect(resolved).toMatchObject({ threadId: 'thread-1', deviceId: 'device-1' });
  });

  it('should not touch streamingMessages (no interaction with active command cards)', async () => {
    const onMessage = await connectAndBind('device-1');

    await sendTaskNotification(onMessage);

    // Streaming APIs must not be involved at all
    expect(mockFeishuHandler.updateStreamingMessage).not.toHaveBeenCalled();
    expect(mockFeishuHandler.finalizeStreamingMessage).not.toHaveBeenCalled();
  });

  it('should send card but skip cardThreadMap when threadId is absent (legacy default thread)', async () => {
    const onMessage = await connectAndBind('device-1');

    await sendTaskNotification(onMessage, { threadId: undefined });

    expect(mockFeishuHandler.sendTaskNotificationCard).toHaveBeenCalledTimes(1);
    expect(resolveThreadCallback!('feishu-task-card-1')).toBeUndefined();
  });

  it('should skip cardThreadMap registration when card sending fails', async () => {
    mockFeishuHandler.sendTaskNotificationCard.mockResolvedValue(null);
    const onMessage = await connectAndBind('device-1');

    await sendTaskNotification(onMessage);

    expect(mockFeishuHandler.sendTaskNotificationCard).toHaveBeenCalledTimes(1);
    expect(resolveThreadCallback!('feishu-task-card-1')).toBeUndefined();
  });

  it('should ignore messages with missing taskNotification payload', async () => {
    const onMessage = await connectAndBind('device-1');

    await sendTaskNotification(onMessage, { taskNotification: undefined });

    expect(mockFeishuHandler.sendTaskNotificationCard).not.toHaveBeenCalled();
  });

  it('should ignore messages with missing openId', async () => {
    const onMessage = await connectAndBind('device-1');

    await sendTaskNotification(onMessage, { openId: undefined });

    expect(mockFeishuHandler.sendTaskNotificationCard).not.toHaveBeenCalled();
  });

  it('should include the thread name in the card when provided', async () => {
    const onMessage = await connectAndBind('device-1');

    await sendTaskNotification(onMessage, { threadName: 'refactor-login' });

    expect(mockFeishuHandler.sendTaskNotificationCard).toHaveBeenCalledTimes(1);
    const [, elements] = mockFeishuHandler.sendTaskNotificationCard.mock.calls[0];
    expect(JSON.stringify(elements)).toContain('refactor-login');
  });

  it('should silently drop payloads missing taskId without throwing', async () => {
    const onMessage = await connectAndBind('device-1');

    await sendTaskNotification(onMessage, {
      taskNotification: { status: 'completed', summary: 'no id here', outputFile: '/tmp/x' },
    });

    expect(mockFeishuHandler.sendTaskNotificationCard).not.toHaveBeenCalled();
  });

  it('should silently drop payloads with a non-string summary without throwing', async () => {
    const onMessage = await connectAndBind('device-1');

    await sendTaskNotification(onMessage, {
      taskNotification: { taskId: 'b4a2f1c9', status: 'completed', summary: 42 },
    });

    expect(mockFeishuHandler.sendTaskNotificationCard).not.toHaveBeenCalled();
  });

  it('should still send the card for unknown future statuses (forward compatibility)', async () => {
    const onMessage = await connectAndBind('device-1');

    await sendTaskNotification(onMessage, {
      taskNotification: { taskId: 'b4a2f1c9', status: 'exploded', summary: 'weird new status', outputFile: '/tmp/x' },
    });

    expect(mockFeishuHandler.sendTaskNotificationCard).toHaveBeenCalledTimes(1);
    const [, elements] = mockFeishuHandler.sendTaskNotificationCard.mock.calls[0];
    expect(JSON.stringify(elements)).toContain('TASK ENDED');
  });
});
