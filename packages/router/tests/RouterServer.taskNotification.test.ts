import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { cardThreadStorage } from './helpers/cardThreadStorage';
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

/** Legacy background terminal frames are accepted without any presentation or reply route. */
describe('RouterServer - task_notification', () => {
  let directory: string;
  let config: any;
  let store: any;
  let server: RouterServer;
  let mockFeishuHandler: any;
  let mockConnectionHub: any;
  let mockWss: any;
  let resolveThreadCallback: ((feishuMessageId: string, openId: string) => Promise<{ threadId: string; deviceId: string } | undefined>) | undefined;

  const connectAndBind = async (deviceId: string) => {
    await server.start();
    const onConnection = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN };
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
        outputFile: path.join(directory, 'background.log'),
      },
      timestamp: Date.now(),
      ...overrides,
    })));
  };

  beforeEach(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'retired-background-card-')));
    vi.spyOn(os, 'homedir').mockReturnValue(directory);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    config = {
      getConfigPath: () => path.join(directory, 'config.json'),
      get: vi.fn((section: string, key: string) => {
        if (section === 'files') return { enabled: false };
        if (section === 'server' && key === 'port') return 3000;
        if (section === 'server' && key === 'host') return 'localhost';
        if (section === 'websocket' && key === 'heartbeatInterval') return 30000;
        return 'test-value';
      })
    };

    store = { ...cardThreadStorage(), initialize: vi.fn().mockResolvedValue(undefined), flush: vi.fn().mockResolvedValue(undefined) };

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
      setOnCaptureSelection: vi.fn(),
      setOnValidateSelection: vi.fn(),
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
      unregisterConnection: vi.fn().mockReturnValue(true),
      isCurrentConnection: vi.fn().mockReturnValue(true),
      updateLastActive: vi.fn(),
      getConnectionStats: vi.fn().mockReturnValue({ totalConnections: 0, deviceIds: [] }),
      cleanupStaleConnections: vi.fn(),
      closeAllConnections: vi.fn(),
    };
    (ConnectionHub as unknown as any).mockImplementation(() => mockConnectionHub);
    (BindingManager as unknown as any).mockImplementation(() => ({
      getCardThreadEpoch: store.getCardThreadEpoch,
      invalidateDeviceCards: store.invalidateDeviceCards,
      getDeviceBinding: vi.fn(async (deviceId: string) => deviceId === 'device-1' ? { openId: 'user-1' } : null),
      generateBindingCode: vi.fn().mockResolvedValue({ code: '123456', expiresAt: Date.now() + 60000 }),
    }));

    mockWss = { on: vi.fn(), close: vi.fn((cb: any) => cb?.()) };
    (WebSocketServer as unknown as any).mockImplementation(() => mockWss);

    vi.spyOn(global, 'setInterval');
    resolveThreadCallback = undefined;
    server = new RouterServer(config, store);
  });

  afterEach(async () => {
    await server.stop(); vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true });
  });

  it.each(['completed', 'failed', 'stopped', 'unknown-future-status'])('quietly drops legacy terminal frames with status %s', async status => {
    const onMessage = await connectAndBind('device-1');
    vi.mocked(console.log).mockClear();
    await sendTaskNotification(onMessage, { taskNotification: { taskId: 'private-task-sentinel', status, summary: 'Background result', outputFile: path.join(directory, 'result.log') } });
    expect(mockFeishuHandler.sendTaskNotificationCard).not.toHaveBeenCalled();
    expect(mockFeishuHandler.sendMessage).not.toHaveBeenCalled();
    expect(mockFeishuHandler.updateStreamingMessage).not.toHaveBeenCalled();
    expect(mockFeishuHandler.finalizeStreamingMessage).not.toHaveBeenCalled();
    expect(store.cards.size).toBe(0); expect(store.setCardThread).not.toHaveBeenCalled();
    expect(await resolveThreadCallback!('feishu-task-card-1', 'user-1')).toBeUndefined();
    expect(JSON.stringify([vi.mocked(console.log).mock.calls, vi.mocked(console.error).mock.calls])).not.toMatch(/user-1|private-task-sentinel/);
  });
  it.each([undefined, null, {}, [], 'malformed', { status: 'completed' }, { taskId: 'task', summary: 42 }])('silently drops malformed background payload %j', async taskNotification => {
    const onMessage = await connectAndBind('device-1');
    await sendTaskNotification(onMessage, { taskNotification });
    expect(mockFeishuHandler.sendTaskNotificationCard).not.toHaveBeenCalled(); expect(mockFeishuHandler.sendMessage).not.toHaveBeenCalled();
    expect(store.cards.size).toBe(0);
  });
  it.each([{ openId: undefined }, { threadId: undefined }, { threadName: 'Readable thread' }, { data: { taskNotification: { taskId: 'legacy-task', status: 'completed', summary: 'Legacy payload' } }, taskNotification: undefined }])('drops old optional routing variants without fallback %j', async overrides => {
    const onMessage = await connectAndBind('device-1'); await sendTaskNotification(onMessage, overrides);
    expect(mockFeishuHandler.sendTaskNotificationCard).not.toHaveBeenCalled(); expect(mockFeishuHandler.sendMessage).not.toHaveBeenCalled(); expect(store.cards.size).toBe(0);
  });
  it('drops valid owner background events after a main response while keeping authorization and input messages actionable', async () => {
    const onMessage = await connectAndBind('device-1');
    await onMessage(Buffer.from(JSON.stringify({ type: 'response', messageId: 'main', openId: 'user-1', success: true, output: 'Main response' })));
    expect(mockFeishuHandler.sendMessage).toHaveBeenCalledWith('user-1', 'Main response'); mockFeishuHandler.sendMessage.mockClear();
    await sendTaskNotification(onMessage);
    expect(mockFeishuHandler.sendMessage).not.toHaveBeenCalled(); expect(mockFeishuHandler.sendTaskNotificationCard).not.toHaveBeenCalled(); expect(store.cards.size).toBe(0);
    for (const title of ['🔒 Authorization Required', '⌨️ Waiting for Input']) {
      await onMessage(Buffer.from(JSON.stringify({ type: 'notification', openId: 'user-1', title, message: 'Action required' })));
      expect(mockFeishuHandler.sendMessage).toHaveBeenCalledWith('user-1', `**${title}**\n\nAction required`);
    }
  });
});
