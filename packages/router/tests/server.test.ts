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
import { MessageType, MIN_SUPPORTED_CLI_VERSION, PROTOCOL_VERSION, ROUTER_VERSION } from '../src/types';
import { createRedactedThinkingElement, createToolResultElement } from '../src/utils/ToolFormatter';

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
  createImageElement: vi.fn((imageKey) => ({ tag: 'img', img_key: imageKey })),
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
      sendStreamingStart: vi.fn().mockResolvedValue('execution-card'),
      markQueueCardStarted: vi.fn().mockResolvedValue(undefined),
      updateStreamingMessage: vi.fn().mockResolvedValue(undefined),
      uploadImage: vi.fn().mockResolvedValue('img_generated_123'),
      finalizeStreamingMessage: vi.fn().mockResolvedValue(undefined),
      sendCommandFromCardAction: vi.fn().mockResolvedValue(undefined),
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

  describe('task recovery', () => {
    const resume = {
      type: 'task_resume', messageId: 'recovered-1', openId: 'user-1', threadId: 'thread-1',
      taskResume: { recoveryId: 'recovery-1', threadName: 'thread-2', backend: 'claude',
        cwd: '/workspace/project', preview: 'Review this change', state: 'running' },
    };
    async function connect() {
      await server.start();
      const onConnection = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
      const ws = { on: vi.fn(), send: vi.fn(), close: vi.fn() };
      onConnection(ws, { socket: { remoteAddress: '1' } });
      const onMessage = ws.on.mock.calls.find(call => call[0] === 'message')[1];
      const send = (message: any) => onMessage(Buffer.from(JSON.stringify(message)));
      await send({ type: 'binding_request', data: { deviceId: 'device-1', capabilities: { taskRecovery: true } } });
      expect(JSON.parse(ws.send.mock.calls[0][0]).data.capabilities).toEqual({ taskRecovery: true });
      const close = ws.on.mock.calls.find(call => call[0] === 'close')[1];
      const replies = () => ws.send.mock.calls.map(([message]) => JSON.parse(message));
      return { send, close, replies };
    }

    it('creates one recovery card, preserves reply routing, and renders only later output', async () => {
      const { send, replies } = await connect();
      await send({ type: 'stream', messageId: resume.messageId, openId: 'user-1', chunk: 'lost text' });
      await send(resume);
      await send(resume);
      expect(mockFeishuHandler.sendStreamingStart).toHaveBeenCalledOnce();
      expect(mockFeishuHandler.sendStreamingStart.mock.calls[0][1]).toContain('was not retained');
      expect(replies().at(-1)).toMatchObject({ type: 'task_resume_ack', success: true, recoveryId: 'recovery-1' });
      const resolveThread = mockFeishuHandler.setOnResolveThread.mock.calls[0][0];
      expect(resolveThread('execution-card')).toMatchObject({ threadId: 'thread-1', deviceId: 'device-1' });
      await send({ type: 'stream', messageId: resume.messageId, openId: 'user-1', chunk: 'tail\n```\n</raw>' });
      const result = { type: 'response', messageId: resume.messageId, openId: 'user-1', success: true };
      await send(result);
      expect(mockFeishuHandler.finalizeStreamingMessage).toHaveBeenCalledOnce();
      const elements = mockFeishuHandler.finalizeStreamingMessage.mock.calls[0][1];
      expect(elements.at(-1).content).toBe('<raw>tail\n```\n&lt;/raw&gt;</raw>');
      expect(JSON.stringify(elements)).not.toContain('lost text');
      expect(replies().at(-1).type).toBe('task_result_ack');
      // Lost result acknowledgements must not create another terminal card.
      await send(result);
      await send({ ...resume, taskResume: { ...resume.taskResume, state: 'completed' } });
      expect(mockFeishuHandler.finalizeStreamingMessage).toHaveBeenCalledOnce();
      expect(mockFeishuHandler.sendStreamingStart).toHaveBeenCalledOnce();
    });

    it('waits for card creation, deduplicates retries, and can finish during recovery', async () => {
      const { send, replies } = await connect();
      let ready!: (card: string) => void;
      mockFeishuHandler.sendStreamingStart.mockReturnValueOnce(new Promise(resolve => { ready = resolve; }));
      const first = send(resume);
      const retry = send({ ...resume, taskResume: { ...resume.taskResume, state: 'completed' } });
      expect(replies().filter(message => message.type === 'task_resume_ack')).toHaveLength(0);
      ready('recovery-card');
      await Promise.all([first, retry]);
      expect(mockFeishuHandler.sendStreamingStart).toHaveBeenCalledOnce();
      expect(mockFeishuHandler.finalizeStreamingMessage).toHaveBeenCalledOnce();
      expect(replies().filter(message => message.type === 'task_resume_ack')).toHaveLength(2);
    });

    it.each(['completed', 'failed'])('reports a task that %s offline', async state => {
      const { send, replies } = await connect();
      await send({ ...resume, taskResume: { ...resume.taskResume, state, error: state === 'failed' ? 'Backend failed' : undefined } });
      expect(mockFeishuHandler.sendStreamingStart.mock.calls[0][1]).toContain('Task status recovered');
      const elements = mockFeishuHandler.finalizeStreamingMessage.mock.calls[0][1];
      if (state === 'failed') expect(elements.at(-1).content).toContain('Backend failed');
      expect(replies().at(-1)).toMatchObject({ type: 'task_resume_ack', success: true });
    });

    it('retries a failed card API call without accepting early output', async () => {
      const { send, replies } = await connect();
      mockFeishuHandler.sendStreamingStart.mockRejectedValueOnce(new Error('API unavailable'));
      await send(resume);
      expect(replies().at(-1).success).toBe(false);
      await send(resume);
      expect(replies().at(-1).success).toBe(true);
      expect(mockFeishuHandler.sendStreamingStart).toHaveBeenCalledTimes(2);
    });

    it('does not mistake a queue confirmation for task completion', async () => {
      const { send, replies } = await connect();
      await send({ type: 'response', messageId: resume.messageId, openId: 'user-1', success: false,
        queueConfirmation: { token: 'confirm-queue', threadId: 'thread-1' } });
      expect(replies().some(message => message.type === 'task_result_ack')).toBe(false);
      await send(resume);
      expect(mockFeishuHandler.sendStreamingStart).toHaveBeenCalledOnce();
      await send({ type: 'response', messageId: resume.messageId, openId: 'user-1', success: true });
      expect(mockFeishuHandler.finalizeStreamingMessage).toHaveBeenCalledOnce();
    });

    it('retains a terminal card for retry when Feishu rejects finalization', async () => {
      const { send, replies } = await connect();
      const failed = { ...resume, taskResume: { ...resume.taskResume, state: 'failed', error: 'Backend failed' } };
      mockFeishuHandler.finalizeStreamingMessage.mockResolvedValueOnce(false);
      await send(failed);
      expect(replies().at(-1).success).toBe(false);
      await send(failed);
      expect(replies().at(-1).success).toBe(true);
      expect(mockFeishuHandler.sendStreamingStart).toHaveBeenCalledOnce();
      const elements = mockFeishuHandler.finalizeStreamingMessage.mock.calls[1][1];
      expect(elements.filter(element => element.content.includes('Backend failed'))).toHaveLength(1);
    });

    it('does not resurrect a card if its connection is replaced during creation', async () => {
      const { send, close, replies } = await connect();
      let ready!: (card: string) => void;
      mockFeishuHandler.sendStreamingStart.mockReturnValueOnce(new Promise(resolve => { ready = resolve; }));
      const pending = send(resume);
      mockConnectionHub.isCurrentConnection.mockReturnValue(false);
      mockConnectionHub.unregisterConnection.mockReturnValue(false);
      close();
      ready('obsolete-card');
      await pending;
      expect(replies().filter(message => message.type === 'task_resume_ack')).toHaveLength(0);
      expect(mockFeishuHandler.setOnResolveThread.mock.calls[0][0]('obsolete-card')).toBeUndefined();
    });

    it('keeps the current recovery card when an obsolete socket closes', async () => {
      const { send, close } = await connect();
      await send(resume);
      mockConnectionHub.unregisterConnection.mockReturnValue(false);
      close();
      await send({ type: 'response', messageId: resume.messageId, openId: 'user-1', success: true });
      expect(mockFeishuHandler.finalizeStreamingMessage).toHaveBeenCalledOnce();
    });

    it('adopts a surviving old card even if its thread had not yet been resolved', async () => {
      const { send, replies } = await connect();
      mockFeishuHandler.setOnStartStreaming.mock.calls[0][0](resume.messageId, 'user-1', 'old-card', 'device-1');
      await send(resume);
      expect(replies().at(-1).success).toBe(true);
      // No replacement card: the surviving card is adopted and later finalized.
      expect(mockFeishuHandler.sendStreamingStart).not.toHaveBeenCalled();
      await send({ type: 'response', messageId: resume.messageId, openId: 'user-1', success: true });
      expect(mockFeishuHandler.finalizeStreamingMessage.mock.calls[0][0]).toBe('old-card');
    });

    it('adopts a surviving streaming card and continues it with a gap separator', async () => {
      const { send, replies } = await connect();
      mockFeishuHandler.setOnStartStreaming.mock.calls[0][0](resume.messageId, 'user-1', 'old-card', 'device-1', 'thread-1');
      await send({ type: 'stream', messageId: resume.messageId, openId: 'user-1', chunk: 'kept output' });
      await send(resume);
      expect(mockFeishuHandler.sendStreamingStart).not.toHaveBeenCalled();
      expect(replies().at(-1)).toMatchObject({ type: 'task_resume_ack', success: true, recoveryId: 'recovery-1' });
      const patched = mockFeishuHandler.updateStreamingMessage.mock.calls.at(-1)[1];
      expect(JSON.stringify(patched)).toContain('kept output');
      expect(JSON.stringify(patched)).toContain('Connection restored');
      // Output after recovery continues in the same adopted card.
      await send({ type: 'stream', messageId: resume.messageId, openId: 'user-1', chunk: 'tail' });
      await send({ type: 'response', messageId: resume.messageId, openId: 'user-1', success: true });
      expect(mockFeishuHandler.finalizeStreamingMessage.mock.calls[0][0]).toBe('old-card');
      const elements = mockFeishuHandler.finalizeStreamingMessage.mock.calls[0][1];
      expect(JSON.stringify(elements)).toContain('kept output');
      expect(JSON.stringify(elements)).toContain('tail');
    });

    it('finalizes in-flight streaming cards on graceful stop', async () => {
      const { send } = await connect();
      await send(resume);
      await send({ type: 'stream', messageId: resume.messageId, openId: 'user-1', chunk: 'partial' });
      mockFeishuHandler.finalizeStreamingMessage.mockClear();
      await server.stop();
      expect(mockFeishuHandler.finalizeStreamingMessage).toHaveBeenCalledOnce();
      const [cardId, elements] = mockFeishuHandler.finalizeStreamingMessage.mock.calls[0];
      expect(cardId).toBe('execution-card');
      expect(JSON.stringify(elements)).toContain('partial');
      expect(JSON.stringify(elements)).toContain('restarting');
    });

    it('keeps long resumed fragments independently renderable after card splitting', async () => {
      const { send } = await connect();
      await send(resume);
      await send({ type: 'stream', messageId: resume.messageId, openId: 'user-1', chunk: '<&'.repeat(2500) });
      await send({ type: 'stream', messageId: resume.messageId, openId: 'user-1', streamType: 'tool_use',
        toolUse: { id: 'tool-1', name: 'Read', input: { file_path: '/workspace/file' } } });
      await send({ type: 'stream', messageId: resume.messageId, openId: 'user-1', chunk: '**Next complete segment**' });
      await send({ type: 'response', messageId: resume.messageId, openId: 'user-1', success: true });
      const elements = mockFeishuHandler.finalizeStreamingMessage.mock.calls[0][1];
      expect(elements.slice(1, -1)).toHaveLength(5);
      for (const element of elements.slice(1, -1)) {
        expect(element.content).toMatch(/^<raw>(&lt;&amp;)+<\/raw>$/);
        expect(element.content.length).toBeLessThan(6000);
      }
      expect(elements.at(-1).content).toBe('**Next complete segment**');
    });
  });

  describe('queued execution cards', () => {
    const started = {
      type: 'queue_started', messageId: 'queued-1', openId: 'user-1', threadId: 'thread-1',
      queueStarted: {
        threadName: 'thread-2', backend: 'kimi', cwd: '/workspace/project',
        preview: 'Review the implementation', remainingCount: 2,
      },
      threads: [{ id: 'thread-1', name: 'thread-2', backend: 'kimi', status: 'running' }],
    };

    async function connect() {
      await server.start();
      const onConnection = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
      const ws = { on: vi.fn(), send: vi.fn(), close: vi.fn() };
      onConnection(ws, { socket: { remoteAddress: '1' } });
      const onMessage = ws.on.mock.calls.find(call => call[0] === 'message')[1];
      const send = (message: any) => onMessage(Buffer.from(JSON.stringify(message)));
      await send({ type: 'binding_request', data: { deviceId: 'device-1', capabilities: { queueStarted: true } } });
      expect(mockConnectionHub.registerConnection).toHaveBeenCalledWith('device-1', ws, { queueStarted: true });
      return send;
    }

    it('creates a card only on start, preserves reply routing, and ignores duplicate starts', async () => {
      const send = await connect();
      const onStart = mockFeishuHandler.setOnStartStreaming.mock.calls[0][0];
      onStart('queued-1', 'user-1', null, 'device-1', 'thread-1', false, 'receipt-card');
      expect(mockFeishuHandler.sendStreamingStart).not.toHaveBeenCalled();

      await send(started);
      await send(started);

      expect(mockFeishuHandler.sendStreamingStart).toHaveBeenCalledOnce();
      const intro = mockFeishuHandler.sendStreamingStart.mock.calls[0][1];
      expect(intro).toContain('Review the implementation');
      expect(intro).toContain('/workspace/project');
      expect(intro).toContain('Remaining in queue:** 2');
      expect(mockFeishuHandler.markQueueCardStarted).toHaveBeenCalledWith('receipt-card');
      const resolveThread = mockFeishuHandler.setOnResolveThread.mock.calls[0][0];
      expect(resolveThread('execution-card')).toMatchObject({ threadId: 'thread-1', deviceId: 'device-1' });
      expect(mockFeishuHandler.setOnResolveActiveThread.mock.calls[0][0]('user-1')).toBeUndefined();
      await send({ type: 'response', messageId: 'queued-1', openId: 'user-1', success: true });
      await send(started);
      expect(mockFeishuHandler.sendStreamingStart).toHaveBeenCalledOnce();
      expect(mockFeishuHandler.finalizeStreamingMessage).toHaveBeenCalledWith(
        'execution-card', expect.any(Array), undefined, 'user-1', '/workspace/project',
        'thread-2', started.threads, 'thread-1', undefined,
      );
    });

    it('holds early output and completion until card creation finishes without blocking another thread', async () => {
      const send = await connect();
      let release!: (cardId: string) => void;
      mockFeishuHandler.sendStreamingStart.mockReturnValue(new Promise(resolve => { release = resolve; }));
      const onStart = mockFeishuHandler.setOnStartStreaming.mock.calls[0][0];
      onStart('other-task', 'user-1', 'other-card', 'device-1', 'thread-other');
      const starting = send(started);
      const text = send({ type: 'stream', messageId: 'queued-1', openId: 'user-1', chunk: 'First output' });
      const finished = send({ type: 'response', messageId: 'queued-1', openId: 'user-1', success: true });
      await send({ type: 'stream', messageId: 'other-task', openId: 'user-1', chunk: 'Independent output' });
      expect(mockFeishuHandler.updateStreamingMessage).toHaveBeenCalledWith(
        'other-card', expect.any(Array), 'user-1', undefined,
      );
      expect(mockFeishuHandler.finalizeStreamingMessage).not.toHaveBeenCalled();
      release('execution-card');
      await Promise.all([starting, text, finished]);
      const elements = mockFeishuHandler.finalizeStreamingMessage.mock.calls[0][1];
      expect(JSON.stringify(elements)).toContain('First output');
      expect(JSON.stringify(elements)).toContain('Queued task started');
    });

    it('finishes an image upload before rendering the queued task result', async () => {
      const send = await connect();
      await send(started);
      let uploaded!: (key: string) => void;
      mockFeishuHandler.uploadImage.mockReturnValue(new Promise(resolve => { uploaded = resolve; }));
      const image = send({
        type: 'stream', streamType: 'image', messageId: 'queued-1', openId: 'user-1',
        image: { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
      });
      const finished = send({ type: 'response', messageId: 'queued-1', openId: 'user-1', success: true });
      await Promise.resolve();
      expect(mockFeishuHandler.finalizeStreamingMessage).not.toHaveBeenCalled();
      uploaded('queued-image');
      await Promise.all([image, finished]);
      expect(mockFeishuHandler.finalizeStreamingMessage.mock.calls[0][1])
        .toContainEqual({ tag: 'img', img_key: 'queued-image' });
    });

    it('preserves text, tool, and image order while queued text patches are pending', async () => {
      const send = await connect();
      await send(started);
      mockFeishuHandler.updateStreamingMessage.mockImplementation(() => new Promise(resolve => setTimeout(resolve, 100)));
      mockFeishuHandler.uploadImage.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve('image-key'), 200)));
      vi.mocked(createToolResultElement).mockReturnValueOnce([{ tag: 'markdown', content: 'Tool result' }]);
      const common = { messageId: 'queued-1', openId: 'user-1' };
      const messages = [
        send({ ...common, type: 'stream', chunk: 'Before tool' }),
        send({ ...common, type: 'stream', streamType: 'tool_result', toolResult: { tool_use_id: 'tool-1', content: 'Done' } }),
        send({ ...common, type: 'stream', chunk: 'Before image' }),
        send({ ...common, type: 'stream', streamType: 'image', image: { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' } }),
        send({ ...common, type: 'stream', chunk: 'After image' }),
        send({ ...common, type: 'response', success: true }),
      ];
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.all(messages);

      expect(mockFeishuHandler.finalizeStreamingMessage).toHaveBeenCalledOnce();
      const elements = mockFeishuHandler.finalizeStreamingMessage.mock.calls[0][1];
      expect(elements.slice(1)).toEqual([
        { tag: 'markdown', content: 'Before tool' },
        { tag: 'markdown', content: 'Tool result' },
        { tag: 'markdown', content: 'Before image' },
        { tag: 'img', img_key: 'image-key' },
        { tag: 'markdown', content: 'After image' },
      ]);
    });

    it('announces tasks even when they fail before producing any stream', async () => {
      const send = await connect();
      let release!: (cardId: string) => void;
      mockFeishuHandler.sendStreamingStart.mockReturnValue(new Promise(resolve => { release = resolve; }));
      const starting = send(started);
      const finished = send({ type: 'response', messageId: 'queued-1', openId: 'user-1', success: false, error: 'Capacity error' });
      await Promise.resolve();
      expect(mockFeishuHandler.finalizeStreamingMessage).not.toHaveBeenCalled();
      release('execution-card');
      await Promise.all([starting, finished]);
      expect(JSON.stringify(mockFeishuHandler.finalizeStreamingMessage.mock.calls[0])).toContain('Capacity error');
    });

    it('falls back to the receipt if the new card cannot be created', async () => {
      const send = await connect();
      mockFeishuHandler.setOnStartStreaming.mock.calls[0][0](
        'queued-1', 'user-1', null, 'device-1', 'thread-1', false, 'receipt-card',
      );
      mockFeishuHandler.sendStreamingStart.mockResolvedValue(null);
      await send(started);
      await send({ type: 'stream', messageId: 'queued-1', openId: 'user-1', chunk: 'Visible output' });
      expect(mockFeishuHandler.updateStreamingMessage).toHaveBeenCalledWith(
        'receipt-card', expect.any(Array), 'user-1', 'thread-2',
      );
      expect(mockFeishuHandler.markQueueCardStarted).not.toHaveBeenCalled();
    });

    it('sends a text result if card creation fails and no receipt is available', async () => {
      const send = await connect();
      mockFeishuHandler.sendStreamingStart.mockRejectedValue(new Error('Card API failed'));
      await send(started);
      await send({ type: 'stream', messageId: 'queued-1', openId: 'user-1', chunk: 'Recovered text' });
      await send({ type: 'response', messageId: 'queued-1', openId: 'user-1', success: false, error: 'Task failed' });
      expect(mockFeishuHandler.sendMessage).toHaveBeenCalledWith('user-1', expect.stringContaining('Recovered text'));
      expect(mockFeishuHandler.sendMessage).toHaveBeenCalledWith('user-1', expect.stringContaining('Task failed'));
    });

    it('reconstructs a missing streaming session and survives a failed receipt update', async () => {
      const send = await connect();
      await send(started);
      expect(mockFeishuHandler.sendStreamingStart).toHaveBeenCalledOnce();
      mockFeishuHandler.setOnStartStreaming.mock.calls[0][0](
        'queued-2', 'user-1', 'waiting-card', 'device-1', 'thread-1', false, 'receipt-card',
      );
      mockFeishuHandler.markQueueCardStarted.mockRejectedValue(new Error('Card expired'));
      await send({ ...started, messageId: 'queued-2' });
      await send({ type: 'stream', messageId: 'queued-2', openId: 'user-1', chunk: 'Still visible' });
      expect(JSON.stringify(mockFeishuHandler.updateStreamingMessage.mock.calls)).toContain('Still visible');
    });

    it('ignores malformed events and events that conflict with the registered session', async () => {
      const send = await connect();
      await send({ ...started, queueStarted: { ...started.queueStarted, remainingCount: -1 } });
      mockFeishuHandler.setOnStartStreaming.mock.calls[0][0](
        'queued-1', 'different-user', 'old-card', 'other-device', 'thread-1',
      );
      await send(started);
      expect(mockFeishuHandler.sendStreamingStart).not.toHaveBeenCalled();
    });
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

  it.each([true, false])('preserves reply routing after completion and changes selection only for a new thread (%s)', async (pendingNewThread) => {
    await server.start();
    const onStartStreaming = mockFeishuHandler.setOnStartStreaming.mock.calls[0][0];
    const resolveThread = mockFeishuHandler.setOnResolveThread.mock.calls[0][0];
    const resolveActiveThread = mockFeishuHandler.setOnResolveActiveThread.mock.calls[0][0];
    await mockFeishuHandler.onCardSwitchThread('u1', 'selected-thread', 'Selected Thread');
    onStartStreaming('m1', 'u1', 'f1', 'd1', undefined, pendingNewThread);

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
    expect(resolveThread('f1')).toMatchObject({ threadId: 'new-thread-1', deviceId: 'd1' });
    expect(resolveActiveThread('u1')).toEqual(pendingNewThread
      ? { threadId: 'new-thread-1', threadName: 'New Thread' }
      : { threadId: 'selected-thread', threadName: 'Selected Thread' });
    expect(resolveThread('unknown-card')).toBeUndefined();
    vi.setSystemTime(Date.now() + 7 * 24 * 60 * 60 * 1000 + 1);
    expect(resolveThread('f1')).toBeUndefined();
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

  it.each([false, true])('coalesces text while a patch is pending (queued: %s)', async (queued) => {
    await server.start();
    const onStartStreaming = mockFeishuHandler.setOnStartStreaming.mock.calls[0][0];
    onStartStreaming('m1', 'u1', 'f1', 'd1');

    let resolveFirstUpdate: (() => void) | undefined;
    mockFeishuHandler.updateStreamingMessage
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolveFirstUpdate = resolve; }))
      .mockResolvedValue(undefined);

    const onConnection = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn() };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });
    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    if (queued) {
      await onMessage(Buffer.from(JSON.stringify({ type: 'binding_request', data: { deviceId: 'd1' } })));
      await onMessage(Buffer.from(JSON.stringify({
        type: 'queue_started', messageId: 'm1', openId: 'u1', threadId: 'thread-1',
        queueStarted: { threadName: 'thread-2', backend: 'codex', cwd: '/workspace', preview: 'Task', remainingCount: 0 },
      })));
    }

    const firstUpdate = onMessage(Buffer.from(JSON.stringify({
      type: 'stream', streamType: 'text', messageId: 'm1', openId: 'u1', chunk: 'a'
    })));
    expect(mockFeishuHandler.updateStreamingMessage).toHaveBeenCalledTimes(1);

    const deltaUpdates = Array.from({ length: 30 }, () => onMessage(Buffer.from(JSON.stringify({
      type: 'stream', streamType: 'text', messageId: 'm1', openId: 'u1', chunk: '0123456789'
    }))));
    await vi.advanceTimersByTimeAsync(0);

    expect(mockFeishuHandler.updateStreamingMessage).toHaveBeenCalledTimes(1);
    resolveFirstUpdate?.();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([firstUpdate, ...deltaUpdates]);
    await onMessage(Buffer.from(JSON.stringify({ type: 'response', messageId: 'm1', openId: 'u1', success: true })));

    expect(mockFeishuHandler.updateStreamingMessage).toHaveBeenCalledTimes(2);
    const expectedText = 'a' + '0123456789'.repeat(30);
    expect(mockFeishuHandler.updateStreamingMessage.mock.calls[1][1])
      .toContainEqual(expect.objectContaining({ content: expectedText }));
    expect(mockFeishuHandler.finalizeStreamingMessage.mock.calls[0][1])
      .toContainEqual(expect.objectContaining({ content: expectedText }));
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
    
    expect(ctx.body).toEqual({
      success: true,
      version: ROUTER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      minSupportedCliVersion: MIN_SUPPORTED_CLI_VERSION,
    });
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

  it('renders a redaction notice after preceding text without exposing encrypted content', async () => {
    await server.start();
    const onConnection = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn() };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });
    
    const onStartStreaming = mockFeishuHandler.setOnStartStreaming.mock.calls[0][0];
    onStartStreaming('m1', 'u1', 'f1', 'd1');

    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    const notice = { tag: 'markdown', content: 'Some reasoning was filtered' };
    vi.mocked(createRedactedThinkingElement).mockReturnValueOnce([notice]);
    await onMessage(Buffer.from(JSON.stringify({
      type: 'stream', streamType: 'text', messageId: 'm1', openId: 'u1', chunk: 'Visible answer',
    })));
    await onMessage(Buffer.from(JSON.stringify({
      type: 'stream',
      streamType: 'redacted_thinking',
      messageId: 'm1',
      openId: 'u1',
      chunk: 'ENCRYPTED_REASONING'
    })));

    expect(mockFeishuHandler.updateStreamingMessage).toHaveBeenLastCalledWith(
      'f1', [{ tag: 'markdown', content: 'Visible answer' }, notice], 'u1', undefined,
    );
    expect(JSON.stringify(mockFeishuHandler.updateStreamingMessage.mock.calls)).not.toContain('ENCRYPTED_REASONING');
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

  it('should upload and render WebSocket stream images', async () => {
    await server.start();
    const onConnection = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn() };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });

    const onStartStreaming = mockFeishuHandler.setOnStartStreaming.mock.calls[0][0];
    onStartStreaming('m1', 'u1', 'f1', 'd1');

    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    await onMessage(Buffer.from(JSON.stringify({
      type: 'stream',
      streamType: 'image',
      messageId: 'm1',
      openId: 'u1',
      image: { type: 'image', data: Buffer.from('image-data').toString('base64'), mimeType: 'image/png' },
    })));

    expect(mockFeishuHandler.uploadImage).toHaveBeenCalledWith(Buffer.from('image-data').toString('base64'), 'image/png');
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
    
    expect(mockConnectionHub.unregisterConnection).toHaveBeenCalledWith('d1', mockWs);
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

    // Send 10 more chars - should update after 10 new characters
    await onMessage(Buffer.from(JSON.stringify({
      type: 'stream', streamType: 'text', messageId: 'm1', openId: 'u1', chunk: '1234567890'
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
