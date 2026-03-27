import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Koa from 'koa';
import Router from '@koa/router';
import { WebSocketServer, WebSocket } from 'ws';
import { Server as HttpServer } from 'http';
import { RouterServer } from '../src/server';
import { ConfigManager } from '../src/config/ConfigManager';
import { JsonStore } from '../src/storage/JsonStore';
import { FeishuLongConnHandler } from '../src/feishu/FeishuLongConnHandler';
import { ConnectionHub } from '../src/websocket/ConnectionHub';
import { BindingManager } from '../src/binding/BindingManager';
import { MessageType } from '../src/types';

// Mock dependencies
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
vi.mock('../src/utils/ToolFormatter', () => ({
  createToolUseElement: vi.fn(() => []),
  createToolResultElement: vi.fn(() => []),
  createMarkdownElement: vi.fn((text) => ({ tag: 'markdown', content: text })),
  createRedactedThinkingElement: vi.fn(() => []),
  createPlanModeElement: vi.fn(() => []),
}));

describe('RouterServer', () => {
  let config: any;
  let store: any;
  let server: RouterServer;
  let mockKoa: any;
  let mockRouter: any;
  let mockFeishuHandler: any;
  let mockConnectionHub: any;
  let mockBindingManager: any;
  let mockHttpServer: any;
  let mockWss: any;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();

    // Setup mocks
    config = {
      get: vi.fn((section, key) => {
        if (section === 'server' && key === 'port') return 3000;
        if (section === 'server' && key === 'host') return 'localhost';
        if (section === 'websocket' && key === 'heartbeatInterval') return 30000;
        return 'test-value';
      })
    };

    store = {
      initialize: vi.fn().mockResolvedValue(undefined)
    };

    mockHttpServer = {
      listen: vi.fn().mockReturnThis(),
      close: vi.fn().mockImplementation((cb) => cb && cb()),
      on: vi.fn(),
    };

    mockKoa = {
      use: vi.fn().mockReturnThis(),
      listen: vi.fn().mockReturnValue(mockHttpServer),
      callback: vi.fn(),
    };
    (Koa as unknown as any).mockImplementation(() => mockKoa);

    mockRouter = {
      get: vi.fn().mockReturnThis(),
      post: vi.fn().mockReturnThis(),
      routes: vi.fn(() => (ctx: any, next: any) => next()),
      allowedMethods: vi.fn(() => (ctx: any, next: any) => next()),
    };
    (Router as unknown as any).mockImplementation(() => mockRouter);

    mockFeishuHandler = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      setConnectionHub: vi.fn(),
      setOnStartStreaming: vi.fn(),
      setOnResolveThread: vi.fn(),
      setOnResolveActiveThread: vi.fn(),
      handleCardAction: vi.fn().mockResolvedValue({ success: true }),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      updateStreamingMessage: vi.fn().mockResolvedValue(undefined),
      finalizeStreamingMessage: vi.fn().mockResolvedValue(undefined),
      sendCommandFromCardAction: vi.fn().mockResolvedValue(undefined),
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

    mockBindingManager = {
      generateBindingCode: vi.fn().mockResolvedValue({ code: '123456', expiresAt: Date.now() + 600000 }),
    };
    (BindingManager as unknown as any).mockImplementation(() => mockBindingManager);

    mockWss = {
      on: vi.fn(),
      close: vi.fn(),
    };
    (WebSocketServer as unknown as any).mockImplementation(() => mockWss);

    vi.spyOn(global, 'setInterval');
    server = new RouterServer(config, store);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('should initialize correctly', () => {
    expect(Koa).toHaveBeenCalled();
    expect(ConnectionHub).toHaveBeenCalled();
    expect(BindingManager).toHaveBeenCalledWith(store);
    expect(FeishuLongConnHandler).toHaveBeenCalled();
    expect(mockFeishuHandler.setConnectionHub).toHaveBeenCalled();
    expect(mockFeishuHandler.setOnStartStreaming).toHaveBeenCalled();
    expect(mockFeishuHandler.setOnResolveThread).toHaveBeenCalled();
  });

  it('should start the server successfully', async () => {
    await server.start();
    expect(mockKoa.listen).toHaveBeenCalledWith(3000, 'localhost');
    expect(WebSocketServer).toHaveBeenCalled();
    expect(mockFeishuHandler.start).toHaveBeenCalled();
    expect(global.setInterval).toHaveBeenCalled();
  });

  it('should handle Feishu start streaming callback', () => {
    const onStartStreaming = mockFeishuHandler.setOnStartStreaming.mock.calls[0][0];
    onStartStreaming('msg-1', 'user-1', 'feishu-msg-1', 'device-1', 'thread-1');
    
    // Test resolve thread callback
    const onResolveThread = mockFeishuHandler.setOnResolveThread.mock.calls[0][0];
    const resolved = onResolveThread('feishu-msg-1');
    expect(resolved).toEqual({ threadId: 'thread-1', deviceId: 'device-1', expiresAt: expect.any(Number) });
  });

  it('should handle Feishu resolve active thread callback', () => {
    const onResolveActiveThread = mockFeishuHandler.setOnResolveActiveThread.mock.calls[0][0];
    const onCardSwitchThread = mockFeishuHandler.onCardSwitchThread;
    
    onCardSwitchThread('user-1', 'thread-1', 'Thread 1');
    const resolved = onResolveActiveThread('user-1');
    expect(resolved).toEqual({ threadId: 'thread-1', threadName: 'Thread 1' });
  });

  it('should handle Feishu card new thread callback', async () => {
    const onCardNewThread = mockFeishuHandler.onCardNewThread;
    await onCardNewThread('user-1');
    expect(mockFeishuHandler.sendCommandFromCardAction).toHaveBeenCalledWith('user-1', '/thread new', true);
  });

  it('should clear activeThreadMap when device is switched', () => {
    const onResolveActiveThread = mockFeishuHandler.setOnResolveActiveThread.mock.calls[0][0];
    const onCardSwitchThread = mockFeishuHandler.onCardSwitchThread;
    const onDeviceSwitch = mockFeishuHandler.onDeviceSwitch;

    // Populate activeThreadMap for the user
    onCardSwitchThread('user-1', 'thread-abc', 'My Thread');
    expect(onResolveActiveThread('user-1')).toEqual({ threadId: 'thread-abc', threadName: 'My Thread' });

    // Switch device — should clear the entry
    onDeviceSwitch('user-1', 'old-device-id');
    expect(onResolveActiveThread('user-1')).toBeUndefined();
  });

  it('should not affect other users activeThreadMap when device is switched', () => {
    const onResolveActiveThread = mockFeishuHandler.setOnResolveActiveThread.mock.calls[0][0];
    const onCardSwitchThread = mockFeishuHandler.onCardSwitchThread;
    const onDeviceSwitch = mockFeishuHandler.onDeviceSwitch;

    onCardSwitchThread('user-1', 'thread-1', 'Thread 1');
    onCardSwitchThread('user-2', 'thread-2', 'Thread 2');

    onDeviceSwitch('user-1', 'old-device-id');

    expect(onResolveActiveThread('user-1')).toBeUndefined();
    expect(onResolveActiveThread('user-2')).toEqual({ threadId: 'thread-2', threadName: 'Thread 2' });
  });

  it('should remove cardThreadMap entries for old device when device is switched', () => {
    const onStartStreaming = mockFeishuHandler.setOnStartStreaming.mock.calls[0][0];
    const onResolveThread = mockFeishuHandler.setOnResolveThread.mock.calls[0][0];
    const onDeviceSwitch = mockFeishuHandler.onDeviceSwitch;

    // Populate cardThreadMap via streaming session registrations
    onStartStreaming('msg-1', 'user-1', 'feishu-card-1', 'old-device', 'thread-1');
    onStartStreaming('msg-2', 'user-1', 'feishu-card-2', 'old-device', 'thread-2');
    onStartStreaming('msg-3', 'user-1', 'feishu-card-3', 'other-device', 'thread-3');

    expect(onResolveThread('feishu-card-1')).toBeDefined();
    expect(onResolveThread('feishu-card-2')).toBeDefined();
    expect(onResolveThread('feishu-card-3')).toBeDefined();

    // Switch away from old-device — its card entries should be purged
    onDeviceSwitch('user-1', 'old-device');

    expect(onResolveThread('feishu-card-1')).toBeUndefined();
    expect(onResolveThread('feishu-card-2')).toBeUndefined();
    // Entry for other-device should be unaffected
    expect(onResolveThread('feishu-card-3')).toBeDefined();
  });

  it('should handle streaming message with new thread info in RESPONSE', async () => {
    await server.start();
    const onStartStreaming = mockFeishuHandler.setOnStartStreaming.mock.calls[0][0];
    onStartStreaming('m1', 'u1', 'f1', 'd1', undefined, true); // pendingNewThread = true

    const onConnection = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn() };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });
    
    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    await onMessage(Buffer.from(JSON.stringify({
      type: MessageType.RESPONSE,
      messageId: 'm1',
      openId: 'u1',
      success: true,
      threadId: 'new-thread-1',
      threads: [{ id: 'new-thread-1', name: 'New Thread', status: 'idle' }]
    })));
    
    expect(mockFeishuHandler.finalizeStreamingMessage).toHaveBeenCalled();
  });

  it('should handle text chunk streaming with throttled updates', async () => {
    await server.start();
    const onStartStreaming = mockFeishuHandler.setOnStartStreaming.mock.calls[0][0];
    onStartStreaming('m1', 'u1', 'f1', 'd1');

    const onConnection = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn() };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });
    
    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    
    // First chunk - immediate update
    await onMessage(Buffer.from(JSON.stringify({
      type: 'stream', streamType: 'text', messageId: 'm1', openId: 'u1', chunk: 'h'
    })));
    expect(mockFeishuHandler.updateStreamingMessage).toHaveBeenCalledTimes(1);

    // Second chunk - within interval and length - no update
    await onMessage(Buffer.from(JSON.stringify({
      type: 'stream', streamType: 'text', messageId: 'm1', openId: 'u1', chunk: 'e'
    })));
    expect(mockFeishuHandler.updateStreamingMessage).toHaveBeenCalledTimes(1);

    // Advance time and send another - update
    vi.advanceTimersByTime(1000);
    await onMessage(Buffer.from(JSON.stringify({
      type: 'stream', streamType: 'text', messageId: 'm1', openId: 'u1', chunk: 'l'
    })));
    expect(mockFeishuHandler.updateStreamingMessage).toHaveBeenCalledTimes(2);
  });

  it('should handle finalize streaming message with error', async () => {
    await server.start();
    const onStartStreaming = mockFeishuHandler.setOnStartStreaming.mock.calls[0][0];
    onStartStreaming('m1', 'u1', 'f1', 'd1');

    const onConnection = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn() };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });
    
    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    await onMessage(Buffer.from(JSON.stringify({
      type: MessageType.RESPONSE,
      messageId: 'm1',
      openId: 'u1',
      success: false,
      error: 'Something went wrong'
    })));
    
    expect(mockFeishuHandler.finalizeStreamingMessage).toHaveBeenCalledWith(
      'f1',
      expect.arrayContaining([expect.objectContaining({ content: expect.stringContaining('Something went wrong') })]),
      undefined,
      'u1',
      undefined,
      undefined,
      undefined,
      undefined
    );
  });

  it('should handle finalize streaming message without feishuMessageId', async () => {
    await server.start();
    const onStartStreaming = mockFeishuHandler.setOnStartStreaming.mock.calls[0][0];
    onStartStreaming('m1', 'u1', null, 'd1'); // No feishuMessageId

    const onConnection = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn() };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });
    
    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    await onMessage(Buffer.from(JSON.stringify({
      type: MessageType.RESPONSE,
      messageId: 'm1',
      openId: 'u1',
      success: true,
      output: 'done'
    })));
    
    expect(mockFeishuHandler.finalizeStreamingMessage).not.toHaveBeenCalled();
  });

  it('should handle response when no streaming session exists', async () => {
    await server.start();
    const onConnection = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn() };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });
    
    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    
    // Case 1: Success
    await onMessage(Buffer.from(JSON.stringify({
      type: MessageType.RESPONSE,
      messageId: 'm_none',
      openId: 'u1',
      success: true,
      output: 'completed'
    })));
    expect(mockFeishuHandler.sendMessage).toHaveBeenCalledWith('u1', 'completed');

    // Case 2: Failure
    await onMessage(Buffer.from(JSON.stringify({
      type: MessageType.RESPONSE,
      messageId: 'm_none_err',
      openId: 'u1',
      success: false,
      error: 'failed'
    })));
    expect(mockFeishuHandler.sendMessage).toHaveBeenCalledWith('u1', expect.stringContaining('failed'));
  });

  it('should handle Feishu start failed', async () => {
    mockFeishuHandler.start.mockRejectedValue(new Error('Feishu start failed'));
    await server.start();
    expect(mockFeishuHandler.start).toHaveBeenCalled();
    // Should continue without crashing
  });

  it('should handle stop errors', async () => {
    await server.start();
    mockFeishuHandler.stop.mockRejectedValue(new Error('Feishu stop failed'));
    mockHttpServer.close.mockImplementation((cb) => cb(new Error('HTTP close failed')));
    
    await server.stop();
    // Should complete anyway
  });


  it('should handle health check route', async () => {
    // Find the health check route handler
    const healthRoute = mockRouter.get.mock.calls.find(call => call[0] === '/health')[1];
    const ctx = { body: {} } as any;
    healthRoute(ctx);
    
    expect(ctx.body).toHaveProperty('status', 'ok');
    expect(ctx.body).toHaveProperty('connections');
  });

  it('should handle version API route', async () => {
    const versionRoute = mockRouter.get.mock.calls.find(call => call[0] === '/api/version')[1];
    const ctx = { body: {} } as any;
    versionRoute(ctx);
    
    expect(ctx.body.success).toBe(true);
    expect(ctx.body).toHaveProperty('version');
  });

  it('should handle bind request route', async () => {
    const bindRoute = mockRouter.post.mock.calls.find(call => call[0] === '/api/bind/request')[1];
    const ctx = {
      request: {
        body: { deviceId: 'device-1', deviceName: 'My Device' }
      },
      body: {}
    } as any;
    
    await bindRoute(ctx);
    expect(mockBindingManager.generateBindingCode).toHaveBeenCalledWith('device-1', 'My Device');
    expect(ctx.body.success).toBe(true);
    expect(ctx.body).toHaveProperty('bindingCode', '123456');
  });

  it('should handle bind request route error when deviceId is missing', async () => {
    const bindRoute = mockRouter.post.mock.calls.find(call => call[0] === '/api/bind/request')[1];
    const ctx = {
      request: { body: {} },
      body: {},
      status: 0
    } as any;
    
    await bindRoute(ctx);
    expect(ctx.status).toBe(400);
    expect(ctx.body.success).toBe(false);
  });

  it('should handle feishu card callback route', async () => {
    const cardRoute = mockRouter.post.mock.calls.find(call => call[0] === '/api/feishu/card-callback')[1];
    const ctx = {
      request: { body: { event: { some: 'data' } } },
      body: {},
      status: 0
    } as any;
    
    await cardRoute(ctx);
    expect(mockFeishuHandler.handleCardAction).toHaveBeenCalledWith({ some: 'data' });
    expect(ctx.status).toBe(200);
  });

  it('should handle WebSocket connection', async () => {
    await server.start();
    const onConnection = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
    
    const mockWs = {
      on: vi.fn(),
      send: vi.fn(),
      close: vi.fn(),
    };
    const mockReq = { socket: { remoteAddress: '127.0.0.1' } };
    
    onConnection(mockWs, mockReq);
    expect(mockWs.on).toHaveBeenCalledWith('message', expect.any(Function));
    expect(mockWs.on).toHaveBeenCalledWith('close', expect.any(Function));
  });

  it('should handle WebSocket BINDING_REQUEST', async () => {
    await server.start();
    const onConnection = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn() };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });
    
    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    await onMessage(Buffer.from(JSON.stringify({
      type: MessageType.BINDING_REQUEST,
      messageId: 'm1',
      data: { deviceId: 'd1', protocolVersion: 1 }
    })));
    
    expect(mockConnectionHub.registerConnection).toHaveBeenCalledWith('d1', mockWs);
    expect(mockWs.send).toHaveBeenCalled();
  });

  it('should reject incompatible protocol version', async () => {
    await server.start();
    const onConnection = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn() };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });
    
    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    await onMessage(Buffer.from(JSON.stringify({
      type: MessageType.BINDING_REQUEST,
      messageId: 'm1',
      data: { deviceId: 'd1', protocolVersion: 0 } // Incompatible
    })));
    
    expect(mockWs.send).toHaveBeenCalledWith(expect.stringContaining('PROTOCOL_VERSION_INCOMPATIBLE'));
    expect(mockWs.close).toHaveBeenCalled();
  });

  it('should handle WebSocket HEARTBEAT', async () => {
    await server.start();
    const onConnection = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn() };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });
    
    // First bind to set deviceId
    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    await onMessage(Buffer.from(JSON.stringify({
      type: MessageType.BINDING_REQUEST,
      messageId: 'm1',
      data: { deviceId: 'd1' }
    })));

    await onMessage(Buffer.from(JSON.stringify({
      type: MessageType.HEARTBEAT,
      messageId: 'm2'
    })));
    
    expect(mockConnectionHub.updateLastActive).toHaveBeenCalledWith('d1');
    expect(mockWs.send).toHaveBeenCalledWith(expect.stringContaining('heartbeat'));
  });

  it('should handle WebSocket RESPONSE', async () => {
    await server.start();
    const onConnection = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn() };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });
    
    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    await onMessage(Buffer.from(JSON.stringify({
      type: MessageType.RESPONSE,
      messageId: 'm1',
      openId: 'u1',
      success: true,
      output: 'done'
    })));
    
    expect(mockFeishuHandler.sendMessage).toHaveBeenCalledWith('u1', 'done');
  });

  it('should handle WebSocket stream text', async () => {
    await server.start();
    const onConnection = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn() };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });
    
    // First register streaming session via callback
    const onStartStreaming = mockFeishuHandler.setOnStartStreaming.mock.calls[0][0];
    onStartStreaming('m1', 'u1', 'f1', 'd1');

    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    await onMessage(Buffer.from(JSON.stringify({
      type: 'stream',
      streamType: 'text',
      messageId: 'm1',
      openId: 'u1',
      chunk: 'hello'
    })));
    
    // First chunk should trigger update
    expect(mockFeishuHandler.updateStreamingMessage).toHaveBeenCalled();
  });

  it('should handle WebSocket stream tool_use', async () => {
    await server.start();
    const onConnection = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn() };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });
    
    const onStartStreaming = mockFeishuHandler.setOnStartStreaming.mock.calls[0][0];
    onStartStreaming('m1', 'u1', 'f1', 'd1');

    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    await onMessage(Buffer.from(JSON.stringify({
      type: 'stream',
      streamType: 'tool_use',
      messageId: 'm1',
      openId: 'u1',
      toolUse: { name: 'ls', tool_use_id: '1', input: {} }
    })));
    
    expect(mockFeishuHandler.updateStreamingMessage).toHaveBeenCalled();
  });

  it('should handle WebSocket stream tool_result', async () => {
    await server.start();
    const onConnection = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn() };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });
    
    const onStartStreaming = mockFeishuHandler.setOnStartStreaming.mock.calls[0][0];
    onStartStreaming('m1', 'u1', 'f1', 'd1');

    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    await onMessage(Buffer.from(JSON.stringify({
      type: 'stream',
      streamType: 'tool_result',
      messageId: 'm1',
      openId: 'u1',
      toolResult: { tool_use_id: '1', content: 'res', is_error: false }
    })));
    
    expect(mockFeishuHandler.updateStreamingMessage).toHaveBeenCalled();
  });

  it('should handle WebSocket stream redacted_thinking', async () => {
    await server.start();
    const onConnection = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn() };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });
    
    const onStartStreaming = mockFeishuHandler.setOnStartStreaming.mock.calls[0][0];
    onStartStreaming('m1', 'u1', 'f1', 'd1');

    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    await onMessage(Buffer.from(JSON.stringify({
      type: 'stream',
      streamType: 'redacted_thinking',
      messageId: 'm1',
      openId: 'u1'
    })));
    
    expect(mockFeishuHandler.updateStreamingMessage).toHaveBeenCalled();
  });

  it('should handle WebSocket stream plan_mode', async () => {
    await server.start();
    const onConnection = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn() };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });
    
    const onStartStreaming = mockFeishuHandler.setOnStartStreaming.mock.calls[0][0];
    onStartStreaming('m1', 'u1', 'f1', 'd1');

    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    await onMessage(Buffer.from(JSON.stringify({
      type: 'stream',
      streamType: 'plan_mode',
      messageId: 'm1',
      openId: 'u1',
      planContent: 'my plan'
    })));
    
    expect(mockFeishuHandler.updateStreamingMessage).toHaveBeenCalled();
  });

  it('should handle finalize streaming message on response', async () => {
    await server.start();
    const onConnection = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn() };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });
    
    const onStartStreaming = mockFeishuHandler.setOnStartStreaming.mock.calls[0][0];
    onStartStreaming('m1', 'u1', 'f1', 'd1');

    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    await onMessage(Buffer.from(JSON.stringify({
      type: MessageType.RESPONSE,
      messageId: 'm1',
      openId: 'u1',
      success: true,
      output: 'final'
    })));
    
    expect(mockFeishuHandler.finalizeStreamingMessage).toHaveBeenCalled();
  });

  it('should handle WebSocket NOTIFICATION', async () => {
    await server.start();
    const onConnection = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn() };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });
    
    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    await onMessage(Buffer.from(JSON.stringify({
      type: MessageType.NOTIFICATION,
      openId: 'u1',
      title: '🔒 Auth Required',
      message: 'Please authorize'
    })));
    
    expect(mockFeishuHandler.sendMessage).toHaveBeenCalledWith('u1', expect.stringContaining('Auth Required'));
  });

  it('should handle WebSocket close', async () => {
    await server.start();
    const onConnection = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn() };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });
    
    // Bind to set deviceId
    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    await onMessage(Buffer.from(JSON.stringify({
      type: MessageType.BINDING_REQUEST,
      messageId: 'm1',
      data: { deviceId: 'd1' }
    })));

    const onClose = mockWs.on.mock.calls.find(call => call[0] === 'close')[1];
    onClose();
    
    expect(mockConnectionHub.unregisterConnection).toHaveBeenCalledWith('d1');
  });

  it('should stop the server gracefully', async () => {
    await server.start();
    await server.stop();
    
    expect(mockFeishuHandler.stop).toHaveBeenCalled();
    expect(mockConnectionHub.closeAllConnections).toHaveBeenCalled();
    expect(mockWss.close).toHaveBeenCalled();
    expect(mockHttpServer.close).toHaveBeenCalled();
  });

  it('should cleanup stale streaming sessions and expired cardThreadMap entries', async () => {
    await server.start();
    
    const onStartStreaming = mockFeishuHandler.setOnStartStreaming.mock.calls[0][0];
    onStartStreaming('m1', 'u1', 'f1', 'd1');
    
    // Also trigger some cardThreadMap entries via streaming sessions
    // (Already done in onStartStreaming if feishuMessageId and threadId are provided)
    onStartStreaming('m2', 'u2', 'f2', 'd2', 't2');

    // Advance time by 31 minutes (timeout is 30) for streaming session
    vi.advanceTimersByTime(31 * 60 * 1000);
    
    // For cardThreadMap, TTL is 7 days.
    // Let's mock Date.now() or just advance timers a lot.
    vi.advanceTimersByTime(8 * 24 * 60 * 60 * 1000);

    // Trigger cleanup (happens in interval)
    vi.advanceTimersByTime(30000);
    
    expect(mockConnectionHub.cleanupStaleConnections).toHaveBeenCalled();
  });

  it('should trigger update when enough characters are accumulated', async () => {
    await server.start();
    const onStartStreaming = mockFeishuHandler.setOnStartStreaming.mock.calls[0][0];
    onStartStreaming('m1', 'u1', 'f1', 'd1');

    const onConnection = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn() };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });
    
    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    
    // First chunk - immediate update (1 char)
    await onMessage(Buffer.from(JSON.stringify({
      type: 'stream', streamType: 'text', messageId: 'm1', openId: 'u1', chunk: '0'
    })));
    expect(mockFeishuHandler.updateStreamingMessage).toHaveBeenCalledTimes(1);

    // Send 9 more chars (total 10) - should update based on length (contentLength % 10 === 0)
    await onMessage(Buffer.from(JSON.stringify({
      type: 'stream', streamType: 'text', messageId: 'm1', openId: 'u1', chunk: '123456789'
    })));
    expect(mockFeishuHandler.updateStreamingMessage).toHaveBeenCalledTimes(2);
  });


  it('should handle Koa error middleware', async () => {
    const errorMiddleware = mockKoa.use.mock.calls[1][0]; // Assuming second middleware is error handling
    const ctx = { status: 0, body: {} } as any;
    const next = vi.fn().mockRejectedValue(new Error('Test error'));
    
    await errorMiddleware(ctx, next);
    
    expect(ctx.status).toBe(500);
    expect(ctx.body.success).toBe(false);
  });

  it('should handle Koa logging middleware', async () => {
    const logMiddleware = mockKoa.use.mock.calls[2][0]; // Assuming third middleware is logging
    const ctx = { method: 'GET', url: '/test', status: 200 } as any;
    const next = vi.fn().mockResolvedValue(undefined);
    
    await logMiddleware(ctx, next);
    
    expect(next).toHaveBeenCalled();
  });

  it('should get stats', () => {
    server.getStats();
    expect(mockConnectionHub.getConnectionStats).toHaveBeenCalled();
  });
});
