import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Koa from 'koa';
import Router from '@koa/router';
import { WebSocketServer, WebSocket } from 'ws';
import { RouterServer } from '../src/server';
import { ConfigManager } from '../src/config/ConfigManager';
import { JsonStore } from '../src/storage/JsonStore';
import { FeishuLongConnHandler } from '../src/feishu/FeishuLongConnHandler';
import { ConnectionHub } from '../src/websocket/ConnectionHub';
import { BindingManager } from '../src/binding/BindingManager';
import { MessageType } from '../src/types';
import { IMAGE_LIMITS } from '../src/utils/ImageLifecycle';

// Mock dependencies (same pattern as RouterServer.taskNotification.test.ts)
vi.mock('koa');
vi.mock('koa-bodyparser', () => ({
  default: vi.fn(() => (ctx: any, next: any) => next()),
}));
vi.mock('@koa/router');
vi.mock('ws');
vi.mock('http');
vi.mock('../src/config/ConfigManager');
vi.mock('../src/storage/JsonStore');
vi.mock('../src/feishu/FeishuLongConnHandler');
vi.mock('../src/websocket/ConnectionHub');
vi.mock('../src/binding/BindingManager');

/** One opaque synthetic pixel per logical image; distinct bytes per image. */
function pngBytes(tag: number): string {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, tag, tag, tag, tag]).toString('base64');
}

describe('RouterServer - generated image lifecycle', () => {
  let config: any;
  let store: any;
  let server: RouterServer;
  let mockFeishuHandler: any;
  let mockWss: any;
  let sockets: any[];

  const connectAndBind = async (deviceId: string) => {
    if (!mockWss.on.mock.calls.some(call => call[0] === 'connection')) await server.start();
    const onConnection = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN };
    sockets.push(mockWs);
    onConnection(mockWs, { socket: { remoteAddress: '127.0.0.1' } });
    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    await onMessage(Buffer.from(JSON.stringify({
      type: MessageType.BINDING_REQUEST,
      messageId: 'bind-1',
      data: {
        deviceId,
        protocolVersion: 1,
        capabilities: { queueStarted: true, taskRecovery: true },
      },
    })));
    return onMessage;
  };

  // Streaming sessions are established through the setOnStartStreaming callback
  // the server registers on the Feishu handler (mirrors command dispatch).
  const startSession = (messageId: string, threadName = 'default') => {
    const callback = mockFeishuHandler.setOnStartStreaming.mock.calls[0][0];
    callback(messageId, 'user-1', 'card-1', 'device-1', undefined, false, undefined, threadName);
  };

  const sendQueueStarted = (onMessage: (data: Buffer) => Promise<void>, messageId: string) =>
    onMessage(Buffer.from(JSON.stringify({
      type: 'queue_started', messageId, openId: 'user-1', threadId: 'thread-1',
      queueStarted: { threadName: 'default', backend: 'codex', cwd: '/repo', preview: 'do it', remainingCount: 0 },
    })));

  const sendTaskResume = (onMessage: (data: Buffer) => Promise<void>, messageId: string) =>
    onMessage(Buffer.from(JSON.stringify({
      type: 'task_resume', messageId, openId: 'user-1', threadId: 'thread-1',
      taskResume: { recoveryId: 'rec-1', threadName: 'default', backend: 'codex', cwd: '/repo', preview: 'do it', state: 'running' },
    })));

  const sendStream = (onMessage: (data: Buffer) => Promise<void>, messageId: string, payload: Record<string, unknown>) =>
    onMessage(Buffer.from(JSON.stringify({ type: 'stream', messageId, openId: 'user-1', timestamp: Date.now(), ...payload })));

  const sendText = (onMessage: (data: Buffer) => Promise<void>, messageId: string, chunk: string) =>
    sendStream(onMessage, messageId, { streamType: 'text', chunk });

  const sendImage = (onMessage: (data: Buffer) => Promise<void>, messageId: string, data: string, mimeType = 'image/png') =>
    sendStream(onMessage, messageId, { streamType: 'image', image: { type: 'image', data, mimeType } });

  const sendResponse = (onMessage: (data: Buffer) => Promise<void>, messageId: string) =>
    onMessage(Buffer.from(JSON.stringify({
      type: MessageType.RESPONSE, messageId, openId: 'user-1', success: true, output: 'done', timestamp: Date.now(),
    })));

  // Card patches carry the full cumulative element list, so count only the
  // latest patch (the final card state).
  const lastPatchElements = (): any[] => {
    const calls = mockFeishuHandler.updateStreamingMessage.mock.calls;
    const last = calls[calls.length - 1];
    return last ? (last[1] as any[]) : [];
  };

  const imageElements = (): any[] =>
    lastPatchElements().filter((element: any) => element?.tag === 'img');

  const failureHints = (): string[] =>
    lastPatchElements()
      .filter((element: any) => element?.tag === 'markdown' && /could not be uploaded/i.test(element.content ?? ''))
      .map((element: any) => element.content);

  beforeEach(() => {
    vi.useRealTimers();
    sockets = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    config = {
      getConfigPath: () => '/virtual-router-images/config.json',
      get: vi.fn((section: string, key: string) => {
        if (section === 'files') return { enabled: false };
        if (section === 'server' && key === 'port') return 3000;
        if (section === 'server' && key === 'host') return 'localhost';
        if (section === 'websocket' && key === 'heartbeatInterval') return 30000;
        return 'test-value';
      }),
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

    let uploadDelay = 0;
    mockFeishuHandler = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      setConnectionHub: vi.fn(),
      setOnStartStreaming: vi.fn(),
      setOnResolveThread: vi.fn(),
      setOnResolveActiveThread: vi.fn(),
      handleCardAction: vi.fn().mockResolvedValue({ success: true }),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendStreamingStart: vi.fn().mockResolvedValue('card-1'),
      updateStreamingMessage: vi.fn().mockResolvedValue(undefined),
      finalizeStreamingMessage: vi.fn().mockResolvedValue(undefined),
      uploadImage: vi.fn().mockImplementation(async () => {
        if (uploadDelay > 0) await new Promise(resolve => setTimeout(resolve, uploadDelay));
        return 'image-key-1';
      }),
      setUploadDelay: (ms: number) => { uploadDelay = ms; },
    };
    (FeishuLongConnHandler as unknown as any).mockImplementation(() => mockFeishuHandler);

    const connections = new Map<string, unknown>();
    const mockConnectionHub = {
      registerConnection: vi.fn((id, ws) => connections.set(id, ws)),
      unregisterConnection: vi.fn((id, ws) => connections.get(id) === ws && connections.delete(id)),
      isCurrentConnection: vi.fn((id, ws) => connections.get(id) === ws),
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

    server = new RouterServer(config, store);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('delivers an accepted image that arrives before the terminal response', async () => {
    const onMessage = await connectAndBind('device-1');
    startSession('m1');
    await sendText(onMessage, 'm1', 'working on it');
    await sendImage(onMessage, 'm1', pngBytes(1));
    await sendResponse(onMessage, 'm1');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(imageElements().length).toBe(1);
    expect(failureHints().length).toBe(0);
    expect(mockFeishuHandler.finalizeStreamingMessage).toHaveBeenCalled();
  });

  it('drains an in-flight upload across the response instead of discarding it', async () => {
    mockFeishuHandler.setUploadDelay(120);
    const onMessage = await connectAndBind('device-1');
    startSession('m1');
    // Fire both without awaiting either: the response must drain the accepted
    // upload before the terminal patch instead of discarding it.
    const imagePromise = sendImage(onMessage, 'm1', pngBytes(2));
    const responsePromise = sendResponse(onMessage, 'm1');
    await imagePromise;
    await responsePromise;
    expect(imageElements().length).toBe(1);
    const finalizeOrder = mockFeishuHandler.finalizeStreamingMessage.mock.invocationCallOrder[0] ?? Infinity;
    const lastImagePatch = mockFeishuHandler.updateStreamingMessage.mock.invocationCallOrder.at(-1) ?? 0;
    expect(lastImagePatch).toBeLessThan(finalizeOrder);
  }, 10_000);

  it('fences a late image after the drain deadline while keeping the text result', async () => {
    vi.useFakeTimers();
    try {
      const onMessage = await connectAndBind('device-1');
      startSession('m1');
      await sendText(onMessage, 'm1', 'answer text');
      await sendResponse(onMessage, 'm1');
      await vi.advanceTimersByTimeAsync(31_000);
      await sendImage(onMessage, 'm1', pngBytes(3));
      await vi.advanceTimersByTimeAsync(10);
      expect(imageElements().length).toBe(0);
      expect(failureHints().length).toBe(0); // silently fenced, not user-facing noise
      expect(mockFeishuHandler.finalizeStreamingMessage).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fences a slow upload at the upload timeout and reports an omission', async () => {
    vi.useFakeTimers();
    try {
      mockFeishuHandler.uploadImage.mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 60_000));
        return 'image-key-1';
      });
      const onMessage = await connectAndBind('device-1');
      startSession('m1');
      // Never await the image/response before advancing fake timers: the
      // upload timeout only settles via the timer queue.
      const imagePromise = sendImage(onMessage, 'm1', pngBytes(4));
      const responsePromise = sendResponse(onMessage, 'm1');
      await vi.advanceTimersByTimeAsync(16_000); // 15s upload timeout fires
      await imagePromise;
      await responsePromise;
      expect(imageElements().length).toBe(0);
      expect(failureHints().length).toBeGreaterThan(0);
      expect(mockFeishuHandler.finalizeStreamingMessage).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces duplicate bytes within one reply but delivers distinct images', async () => {
    const onMessage = await connectAndBind('device-1');
    startSession('m1');
    await sendImage(onMessage, 'm1', pngBytes(5));
    await sendImage(onMessage, 'm1', pngBytes(5)); // duplicate
    await sendImage(onMessage, 'm1', pngBytes(6)); // distinct
    await sendResponse(onMessage, 'm1');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(mockFeishuHandler.uploadImage).toHaveBeenCalledTimes(2);
    expect(imageElements().length).toBe(2);
  });

  it('enforces the per-reply delivered-image cap and reports the omission', async () => {
    const onMessage = await connectAndBind('device-1');
    startSession('m1');
    for (let index = 0; index < 10; index++) await sendImage(onMessage, 'm1', pngBytes(10 + index));
    await sendResponse(onMessage, 'm1');
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(mockFeishuHandler.uploadImage).toHaveBeenCalledTimes(8);
    expect(imageElements().length).toBe(8);
    expect(failureHints().length).toBeGreaterThan(0);
  });

  it('rejects an oversized payload before enqueueing and hints without private paths', async () => {
    const onMessage = await connectAndBind('device-1');
    startSession('m1');
    const oversized = Buffer.alloc(3 * 1024 * 1024, 7).toString('base64');
    await sendImage(onMessage, 'm1', oversized);
    await sendResponse(onMessage, 'm1');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(mockFeishuHandler.uploadImage).not.toHaveBeenCalled();
    expect(failureHints().length).toBe(1);
    expect(JSON.stringify(mockFeishuHandler.updateStreamingMessage.mock.calls)).not.toContain('/repo');
  });

  it('keeps image ordering FIFO across uploads', async () => {
    mockFeishuHandler.setUploadDelay(15);
    const onMessage = await connectAndBind('device-1');
    startSession('m1');
    const first = sendImage(onMessage, 'm1', pngBytes(21));
    const second = sendImage(onMessage, 'm1', pngBytes(22));
    await Promise.all([first, second]);
    await sendResponse(onMessage, 'm1');
    const payloads = mockFeishuHandler.uploadImage.mock.calls.map(call => call[0]);
    expect(payloads[0]).toBe(pngBytes(21));
    expect(payloads[1]).toBe(pngBytes(22));
  }, 10_000);

  it('does not serialize independent streams or stall text updates', async () => {
    mockFeishuHandler.setUploadDelay(100);
    const onMessage = await connectAndBind('device-1');
    startSession('m1', 'thread-a');
    startSession('m2', 'thread-b');
    const imagePromise = sendImage(onMessage, 'm1', pngBytes(31));
    // m2 text is handled while m1's upload is still draining.
    await sendText(onMessage, 'm2', 'independent text');
    expect(mockFeishuHandler.updateStreamingMessage.mock.calls
      .some(call => call[1].some((e: any) => e?.content === 'independent text'))).toBe(true);
    await imagePromise;
    await sendResponse(onMessage, 'm1');
  }, 10_000);

  it('fences accepted work when the stream is replaced before the upload settles', async () => {
    mockFeishuHandler.uploadImage.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 150));
      return 'image-key-1';
    });
    const onMessage = await connectAndBind('device-1');
    startSession('m1');
    // Replace the stream state (same messageId) while the terminal response
    // is still draining the accepted upload.
    const imagePromise = sendImage(onMessage, 'm1', pngBytes(41));
    const responsePromise = sendResponse(onMessage, 'm1');
    startSession('m1');
    await imagePromise;
    await responsePromise;
    expect(imageElements().length).toBe(0);
  }, 10_000);

  it('drains an in-flight upload for a queued stream before finalization', async () => {
    mockFeishuHandler.setUploadDelay(120);
    const onMessage = await connectAndBind('device-1');
    await sendQueueStarted(onMessage, 'm1');
    await sendText(onMessage, 'm1', 'queued output');
    const imagePromise = sendImage(onMessage, 'm1', pngBytes(51));
    const responsePromise = sendResponse(onMessage, 'm1');
    await imagePromise;
    await responsePromise;
    expect(imageElements().length).toBe(1);
    const finalizeOrder = mockFeishuHandler.finalizeStreamingMessage.mock.invocationCallOrder[0] ?? Infinity;
    const lastImagePatch = mockFeishuHandler.updateStreamingMessage.mock.invocationCallOrder.at(-1) ?? 0;
    expect(lastImagePatch).toBeLessThan(finalizeOrder);
  }, 10_000);

  it('drains an in-flight upload for a recovered stream before finalization', async () => {
    mockFeishuHandler.setUploadDelay(120);
    const onMessage = await connectAndBind('device-1');
    await sendTaskResume(onMessage, 'm1');
    await sendText(onMessage, 'm1', 'recovered output');
    const imagePromise = sendImage(onMessage, 'm1', pngBytes(61));
    const responsePromise = sendResponse(onMessage, 'm1');
    await imagePromise;
    await responsePromise;
    expect(imageElements().length).toBe(1);
    const finalizeOrder = mockFeishuHandler.finalizeStreamingMessage.mock.invocationCallOrder[0] ?? Infinity;
    const lastImagePatch = mockFeishuHandler.updateStreamingMessage.mock.invocationCallOrder.at(-1) ?? 0;
    expect(lastImagePatch).toBeLessThan(finalizeOrder);
  }, 10_000);
  it.each(['queued', 'recovered'])('closes %s image intake at response ingress while card creation is pending', async kind => {
    vi.useFakeTimers();
    const onMessage = await connectAndBind('device-1');
    let create!: (card: string) => void;
    let upload!: (key: string) => void;
    mockFeishuHandler.sendStreamingStart.mockReturnValue(new Promise(resolve => { create = resolve; }));
    mockFeishuHandler.uploadImage.mockReturnValue(new Promise(resolve => { upload = resolve; }));
    const creating = kind === 'queued' ? sendQueueStarted(onMessage, 'pending') : sendTaskResume(onMessage, 'pending');
    const image = sendImage(onMessage, 'pending', pngBytes(71));
    const receivedAt = Date.now();
    const response = sendResponse(onMessage, 'pending');
    const route = (server as any).imageReplies.get('pending');
    expect(route.reply.closed).toBe(true);
    expect(route.reply.deadline).toBe(receivedAt + IMAGE_LIMITS.drainMs);
    await sendImage(onMessage, 'pending', pngBytes(72));
    expect(route.reply.attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockFeishuHandler.uploadImage).not.toHaveBeenCalled();
    create('pending-card');
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFeishuHandler.uploadImage).toHaveBeenCalledOnce();
    expect(mockFeishuHandler.finalizeStreamingMessage).not.toHaveBeenCalled();
    upload('accepted-before-close');
    await Promise.all([creating, image, response]);
    expect(mockFeishuHandler.finalizeStreamingMessage.mock.calls.at(-1)[1])
      .toContainEqual(expect.objectContaining({ tag: 'img', img_key: 'accepted-before-close' }));
    expect((server as any).imageReplies.size).toBe(0);
    expect((server as any).queueMessageOperations.size).toBe(0);
  });

  it.each(['queued', 'recovered'])('expires %s image payloads promptly without jumping ahead of card creation', async kind => {
    vi.useFakeTimers();
    const onMessage = await connectAndBind('device-1');
    let create!: (card: string) => void;
    mockFeishuHandler.sendStreamingStart.mockReturnValue(new Promise(resolve => { create = resolve; }));
    const creating = kind === 'queued' ? sendQueueStarted(onMessage, 'pending') : sendTaskResume(onMessage, 'pending');
    const image = sendImage(onMessage, 'pending', pngBytes(73));
    const response = sendResponse(onMessage, 'pending');
    const deadline = (server as any).imageReplies.get('pending').reply.deadline;
    await vi.advanceTimersByTimeAsync(31_000);
    await image;
    expect((server as any).images.retainedBytes).toBe(0);
    expect((server as any).images.waiting.size).toBe(0);
    expect(mockFeishuHandler.finalizeStreamingMessage).not.toHaveBeenCalled();
    create('pending-card');
    await Promise.all([creating, response]);
    expect(Date.now()).toBeGreaterThan(deadline);
    expect(mockFeishuHandler.uploadImage).not.toHaveBeenCalled();
    expect(mockFeishuHandler.finalizeStreamingMessage).toHaveBeenCalledOnce();
    expect(JSON.stringify(mockFeishuHandler.finalizeStreamingMessage.mock.calls.at(-1)[1]))
      .toContain('Generated image could not be uploaded to Feishu.');
    expect((server as any).imageReplies.size).toBe(0);
    expect((server as any).queueMessageOperations.size).toBe(0);
  });

  it('does not start a third stream upload when two timed-out SDK uploads remain unsettled', async () => {
    vi.useFakeTimers();
    const onMessage = await connectAndBind('device-1');
    const resolve: Array<(key: string) => void> = [];
    mockFeishuHandler.uploadImage.mockImplementation(() => new Promise(done => resolve.push(done)));
    startSession('first'); startSession('second'); startSession('third');
    const first = sendImage(onMessage, 'first', pngBytes(74));
    const second = sendImage(onMessage, 'second', pngBytes(75));
    await vi.advanceTimersByTimeAsync(15_000);
    await Promise.all([first, second]);
    const retained = (server as any).images.retainedBytes;
    expect(retained).toBeGreaterThan(0);
    const third = sendImage(onMessage, 'third', pngBytes(76));
    await vi.advanceTimersByTimeAsync(15_000);
    await third;
    expect(mockFeishuHandler.uploadImage).toHaveBeenCalledTimes(2);
    expect((server as any).images.retainedBytes).toBe(retained);
    expect((server as any).images.waiting.size).toBe(0);
    resolve.forEach(done => done('late-result'));
    await vi.advanceTimersByTimeAsync(0);
    expect(imageElements()).toHaveLength(0);
    expect((server as any).images.retainedBytes).toBe(0);
  });

  it.each(['disconnect', 'rebind', 'owner'])('fences an actual late upload after %s, including a surviving stream object', async kind => {
    const onMessage = await connectAndBind('device-1');
    startSession('owned');
    const stream = (server as any).streamingMessages.get('owned');
    let upload!: (key: string) => void;
    mockFeishuHandler.uploadImage.mockReturnValueOnce(new Promise(done => { upload = done; }));
    const old = sendImage(onMessage, 'owned', pngBytes(77));
    if (kind === 'disconnect') sockets[0].on.mock.calls.find(call => call[0] === 'close')[1]();
    if (kind === 'rebind') {
      await connectAndBind('device-1');
      expect((server as any).streamingMessages.get('owned')).toBe(stream);
    }
    if (kind === 'owner') stream.openId = 'different-owner';
    expect((server as any).images.retainedBytes).toBeGreaterThan(0);
    upload('must-not-publish');
    await old;
    await vi.waitFor(() => expect((server as any).images.retainedBytes).toBe(0));
    expect(mockFeishuHandler.updateStreamingMessage.mock.calls.flatMap(call => call[1]))
      .not.toContainEqual(expect.objectContaining({ tag: 'img', img_key: 'must-not-publish' }));
    expect((server as any).images.retainedBytes).toBe(0);
  });

  it('preserves reply admission and deduplication budgets when rebind keeps the same card', async () => {
    let onMessage = await connectAndBind('device-1');
    startSession('budget');
    const stream = (server as any).streamingMessages.get('budget');
    for (let index = 0; index < 4; index++) await sendImage(onMessage, 'budget', pngBytes(80 + index));
    onMessage = await connectAndBind('device-1');
    expect((server as any).streamingMessages.get('budget')).toBe(stream);
    await sendImage(onMessage, 'budget', pngBytes(80));
    for (let index = 4; index < 9; index++) await sendImage(onMessage, 'budget', pngBytes(80 + index));
    expect(mockFeishuHandler.uploadImage).toHaveBeenCalledTimes(8);
    expect(stream.elements.filter(element => element.tag === 'img')).toHaveLength(8);
    expect((server as any).imageReplies.get('budget').reply.attempts).toBe(10);
    await sendResponse(onMessage, 'budget');
  });

});
