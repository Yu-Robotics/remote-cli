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
import { createDelegationProgressElements, createRedactedThinkingElement, createToolResultElement, createToolUseElement } from '../src/utils/ToolFormatter';

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
const delegationBodyContent = (body: any) => body.columns[0].elements.map((element: any) => element.content ?? '').join('\n');

vi.mock('../src/utils/ToolFormatter', async (importActual) => ({
  createToolUseElement: vi.fn(() => []),
  createToolResultElement: vi.fn(() => []),
  createToolCallElement: vi.fn((await importActual<typeof import('../src/utils/ToolFormatter')>()).createToolCallElement),
  DELEGATION_PROGRESS_ELEMENT_COUNT: 4,
  createDelegationProgressElements: vi.fn((await importActual<typeof import('../src/utils/ToolFormatter')>()).createDelegationProgressElements),
  createDividerElement: vi.fn((await importActual<typeof import('../src/utils/ToolFormatter')>()).createDividerElement),
  createMarkdownElement: vi.fn((await importActual<typeof import('../src/utils/ToolFormatter')>()).createMarkdownElement),
  createRedactedThinkingElement: vi.fn(() => []),
  createPlanModeElement: vi.fn(() => []),
  createImageElement: vi.fn((await importActual<typeof import('../src/utils/ToolFormatter')>()).createImageElement),
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
      getConfigPath: () => '/virtual-router-tests/config.json',
      get: vi.fn((section, key) => {
        // These card/routing unit tests must not initialize real attachment storage.
        if (section === 'files') return { enabled: false };
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
      updateStreamingMessage: vi.fn().mockResolvedValue(true),
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

  describe('paired tool-call progress', () => {
    const envelope = { type: 'stream', messageId: 'tool-task', openId: 'owner', threadId: 'thread-1' };
    async function connect() {
      const formatter = await vi.importActual<typeof import('../src/utils/ToolFormatter')>('../src/utils/ToolFormatter');
      vi.mocked(createToolUseElement).mockImplementation(formatter.createToolUseElement);
      vi.mocked(createToolResultElement).mockImplementation(formatter.createToolResultElement);
      await server.start();
      mockFeishuHandler.setOnStartStreaming.mock.calls[0][0]('tool-task', 'owner', 'tool-card', 'device-1', 'thread-1');
      const onConnection = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
      const ws = { on: vi.fn(), send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN };
      onConnection(ws, { socket: { remoteAddress: '127.0.0.1' } });
      const receive = ws.on.mock.calls.find(call => call[0] === 'message')[1];
      const send = (message: any) => receive(Buffer.from(JSON.stringify(message)));
      await send({ type: 'binding_request', data: { deviceId: 'device-1', capabilities: { delegationProgress: true, activityProgress: true } } });
      return { send, stream: (server as any).streamingMessages.get('tool-task') };
    }
    const use = (id: string | undefined, name = 'Read', input: any = { file_path: '/project/example.ts' }) => ({ ...envelope, streamType: 'tool_use', toolUse: { id, name, input } });
    const result = (id: string | undefined, content = 'Example output', is_error = false) => ({ ...envelope, streamType: 'tool_result', toolResult: { tool_use_id: id, content, is_error } });

    it('updates the original tool row while retaining surrounding assistant text', async () => {
      const { send, stream } = await connect();
      await send({ ...envelope, streamType: 'text', chunk: 'Before tool' });
      await send(use('read-1'));
      const index = stream.toolCalls.get('read-1').elementIndex;
      expect(stream.elements[index].header.title.content).toContain('TOOL USE');
      await send({ ...envelope, streamType: 'text', chunk: 'After tool' });
      await send(result('read-1'));
      expect(stream.elements).toHaveLength(3);
      expect(stream.elements[0].content).toBe('Before tool');
      expect(stream.elements[2].content).toBe('After tool');
      expect(stream.elements[index].header.title.content).toContain('SUCCESS');
      expect(stream.elements[index].expanded).toBe(false);
      expect(JSON.stringify(stream.elements[index])).toContain('/project/example.ts');
      expect(JSON.stringify(stream.elements[index])).toContain('Example output');
      expect(stream.elements.filter((element: any) => element.tag === 'collapsible_panel')).toHaveLength(1);
    });

    it('pairs out-of-order results without moving a later worker section or a second tool', async () => {
      const { send, stream } = await connect();
      await send(use('read-1'));
      await send({ ...envelope, streamType: 'delegation_progress', delegationProgress: {
        taskId: 'worker-1', backend: 'agy', phase: 'started', startedAt: Date.now(), objective: 'Independent review',
      } });
      const worker = stream.delegationProgress.get('worker-1');
      const workerIndex = worker.elementIndex;
      await send(use('bash-1', 'Bash', { command: 'npm test' }));
      const length = stream.elements.length;
      await send(result('bash-1', 'Test failed', true));
      await send(result('read-1'));
      await send({ ...envelope, streamType: 'delegation_progress', delegationProgress: {
        taskId: 'worker-1', backend: 'agy', phase: 'succeeded', summary: 'Review completed',
      } });
      expect(stream.elements).toHaveLength(length);
      expect(worker.elementIndex).toBe(workerIndex);
      expect(JSON.stringify(stream.elements[workerIndex + 1])).toContain('Review completed');
      expect(stream.elements[stream.toolCalls.get('read-1').elementIndex].header.title.content).toContain('SUCCESS');
      expect(stream.elements[stream.toolCalls.get('bash-1').elementIndex].header.title.content).toContain('ERROR');
      expect(stream.toolCalls.size).toBe(2);
    });

    it.each([undefined, '', 'unknown', 'bad\nidentifier', 'x'.repeat(201)])('does not guess a pairing for unusable ID %s', async id => {
      const { send, stream } = await connect();
      await send(use(id));
      await send(result(id));
      expect(stream.elements).toHaveLength(2);
      expect(stream.elements[0].header.title.content).toContain('TOOL USE');
      expect(stream.elements[1].header.title.content).toContain('SUCCESS');
      expect(stream.toolCalls.size).toBe(0);
    });

    it('preserves orphan results and pairs a later identity only by the exact ID', async () => {
      const { send, stream } = await connect();
      await send(result('orphan-1', 'Late result', true));
      await send(use('unrelated-1'));
      await send(use('orphan-1', 'Bash', { command: 'npm test' }));
      expect(stream.elements).toHaveLength(2);
      expect(stream.elements[0].header.title.content).toContain('Bash');
      expect(stream.elements[0].header.title.content).toContain('ERROR');
      expect(JSON.stringify(stream.elements[0])).toContain('Late result');
      expect(stream.elements[1].header.title.content).toContain('TOOL USE');
    });

    it('keeps repeated updates in place and a new start after completion independent', async () => {
      const { send, stream } = await connect();
      await send(use('reused-1', 'Bash', { description: 'Waiting for arguments' }));
      await send(use('reused-1', 'Bash', { command: 'npm test' }));
      await send(result('reused-1', 'First result'));
      await send(result('reused-1', 'Updated result'));
      expect(stream.elements).toHaveLength(1);
      expect(JSON.stringify(stream.elements[0])).toContain('Updated result');
      expect(JSON.stringify(stream.elements[0])).not.toContain('First result');
      await send(use('reused-1', 'Bash', { command: 'npm run build' }));
      await send(result('reused-1', 'Second call'));
      expect(stream.elements).toHaveLength(2);
      expect(JSON.stringify(stream.elements[0])).toContain('npm test');
      expect(JSON.stringify(stream.elements[0])).toContain('Updated result');
      expect(JSON.stringify(stream.elements[1])).toContain('npm run build');
      expect(JSON.stringify(stream.elements[1])).toContain('Second call');
    });

    it('scopes the same tool ID to its request and retains only rendered previews', async () => {
      const { send, stream } = await connect();
      mockFeishuHandler.setOnStartStreaming.mock.calls[0][0]('other-task', 'owner', 'other-card', 'device-1', 'thread-1');
      await send(use('shared-1', 'Bash', { command: 'x'.repeat(10_000) }));
      await send({ ...result('shared-1', 'Other request'), messageId: 'other-task' });
      expect(stream.elements[0].header.title.content).toContain('TOOL USE');
      expect(JSON.stringify(stream.toolCalls.get('shared-1'))).not.toContain('x'.repeat(10_000));
      expect(JSON.stringify(stream.toolCalls.get('shared-1')).length).toBeLessThan(2000);
      const other = (server as any).streamingMessages.get('other-task');
      expect(JSON.stringify(other.elements[0])).toContain('Other request');
      await send(result('shared-1', 'y'.repeat(10_000)));
      expect(JSON.stringify(stream.toolCalls.get('shared-1'))).not.toContain('y'.repeat(10_000));
    });

    it('does not manufacture a missing result or accept late results after completion', async () => {
      const { send, stream } = await connect();
      await send(use('pending-1'));
      await send({ ...envelope, type: 'response', success: true });
      const elements = mockFeishuHandler.finalizeStreamingMessage.mock.lastCall[1];
      expect(elements[0].header.title.content).toContain('TOOL USE');
      expect(JSON.stringify(elements)).not.toContain('SUCCESS');
      const updates = mockFeishuHandler.updateStreamingMessage.mock.calls.length;
      await send(result('pending-1', 'Late output'));
      expect(mockFeishuHandler.updateStreamingMessage).toHaveBeenCalledTimes(updates);
      expect(JSON.stringify(stream.elements)).not.toContain('Late output');
    });
  });

  describe('public activity progress', () => {
    const envelope = { type: 'stream', streamType: 'activity', messageId: 'activity-task', openId: 'owner', threadId: 'thread-1' };
    const activity = { source: 'plan', text: 'Checking deadline propagation' };
    async function connect(capabilities: Record<string, boolean> = {}) {
      await server.start();
      mockFeishuHandler.setOnStartStreaming.mock.calls[0][0]('activity-task', 'owner', 'activity-card', 'device-1', 'thread-1');
      const onConnection = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
      const ws = { on: vi.fn(), send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN };
      onConnection(ws, { socket: { remoteAddress: '127.0.0.1' } });
      const receive = ws.on.mock.calls.find(call => call[0] === 'message')[1];
      const send = (message: any) => receive(Buffer.from(JSON.stringify(message)));
      await send({ type: 'binding_request', data: { deviceId: 'device-1', capabilities } });
      return { send, capabilities: JSON.parse(ws.send.mock.calls[0][0]).data.capabilities,
        stream: (server as any).streamingMessages.get('activity-task') };
    }

    it('negotiates main support independently and keeps activity out of transcript/final-output fallback', async () => {
      const { send, stream, capabilities } = await connect({ activityProgress: true });
      expect(capabilities).toEqual({ activityProgress: true });
      const createdAt = stream.createdAt;
      await send({ ...envelope, activity });
      expect(stream.activity).toEqual(activity);
      expect(stream.elements).toEqual([]);
      expect(stream.currentTextContent).toBe('');
      expect(stream.createdAt).toBe(createdAt);
      expect(mockFeishuHandler.updateStreamingMessage.mock.calls.at(-1)[5]).toEqual(activity);
      await send({ ...envelope, type: 'response', success: true, output: 'Nonstreamed final result' });
      expect(JSON.stringify(mockFeishuHandler.finalizeStreamingMessage.mock.calls.at(-1)[1])).toContain('Nonstreamed final result');
      expect(JSON.stringify(mockFeishuHandler.finalizeStreamingMessage.mock.calls.at(-1)[1])).not.toContain(activity.text);
      const count = mockFeishuHandler.updateStreamingMessage.mock.calls.length;
      await send({ ...envelope, activity: { ...activity, text: 'Late' } });
      expect(mockFeishuHandler.updateStreamingMessage).toHaveBeenCalledTimes(count);
    });

    it('ignores unnegotiated main and worker activity without changing legacy latestText', async () => {
      const { send, stream, capabilities } = await connect({ delegationProgress: true, delegationProgressText: true });
      expect(capabilities.activityProgress).toBeUndefined();
      await send({ ...envelope, activity });
      expect(stream.activity).toBeUndefined();
      await send({ ...envelope, streamType: 'delegation_progress', delegationProgress: {
        taskId: 'worker', backend: 'codex', phase: 'text', latestText: 'Legacy latest text', activity,
      } });
      expect(stream.delegationProgress.get('worker').activity).toBeUndefined();
      expect(stream.delegationProgress.get('worker').latestText).toBe('Legacy latest text');
    });

    it('rejects malformed, wrong-owner, wrong-thread, wrong-device, replaced-connection and finalizing events', async () => {
      const { send, stream } = await connect({ activityProgress: true, delegationProgress: true });
      for (const value of [null, [], 'text', { source: 'thinking', text: 'private' }, { source: 'tool', text: [] }, { source: 'plan', text: '\u0000' }]) {
        await send({ ...envelope, activity: value });
      }
      for (const patch of [{ openId: 'other' }, { threadId: 'other' }, { threadId: undefined }, { messageId: 'unknown' }]) {
        await send({ ...envelope, ...patch, activity });
        await send({ ...envelope, ...patch, streamType: 'delegation_progress', delegationProgress: { taskId: 'worker', backend: 'codex', phase: 'text', activity } });
      }
      stream.deviceId = 'other-device';
      await send({ ...envelope, activity });
      stream.deviceId = 'device-1';
      mockConnectionHub.isCurrentConnection.mockReturnValueOnce(false);
      await send({ ...envelope, activity });
      stream.finalizing = true;
      await send({ ...envelope, activity });
      expect(stream.activity).toBeUndefined();
      expect(stream.delegationProgress.size).toBe(0);
      expect(mockFeishuHandler.updateStreamingMessage).not.toHaveBeenCalled();
    });

    it('coalesces pending activity/text patches and waits before finalization without allowing late updates', async () => {
      const { send, stream } = await connect({ activityProgress: true });
      let release!: () => void;
      mockFeishuHandler.updateStreamingMessage.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
      const first = send({ ...envelope, activity });
      await Promise.resolve();
      await send({ ...envelope, activity: { source: 'tool', text: 'Verifying the result' } });
      await send({ ...envelope, streamType: 'text', chunk: 'Public response' });
      expect(stream.updatePending).toBe(true);
      const final = send({ ...envelope, type: 'response', success: false, error: 'Task failed' });
      expect(stream.finalizing).toBe(true);
      await send({ ...envelope, activity: { ...activity, text: 'Too late' } });
      expect(mockFeishuHandler.finalizeStreamingMessage).not.toHaveBeenCalled();
      release();
      await Promise.all([first, final]);
      expect(mockFeishuHandler.finalizeStreamingMessage.mock.calls.at(-1)[10]).toBe(false);
      expect(JSON.stringify(mockFeishuHandler.finalizeStreamingMessage.mock.calls.at(-1)[1])).toContain('Public response');
      expect(stream.activity.text).toBe('Verifying the result');
    });

    it('accepts activity-only Worker text updates, preserves lifecycle activity, and protects input/results', async () => {
      const { send, stream } = await connect({ activityProgress: true, delegationProgress: true });
      const progress = (phase: string, fields: any = {}) => send({ ...envelope, streamType: 'delegation_progress',
        delegationProgress: { taskId: 'worker', backend: 'codex', phase, ...fields } });
      await progress('started', { activity });
      const worker = stream.delegationProgress.get('worker');
      const index = worker.elementIndex;
      const length = stream.elements.length;
      await progress('tool_use', { toolUse: { id: 'read', name: 'Read' }, activity: { source: 'tool', text: 'Reading the handler' } });
      const toolTime = worker.lastToolActivityAt;
      const streamTime = stream.createdAt;
      await vi.advanceTimersByTimeAsync(100);
      await progress('text', { activity: { source: 'public_text', text: 'Comparing paths' }, latestText: 'Not negotiated' });
      expect(worker.phase).toBe('tool_use');
      expect(worker.activity.text).toBe('Comparing paths');
      expect(worker.latestText).toBeUndefined();
      expect(worker.lastToolActivityAt).toBe(toolTime);
      expect(stream.createdAt).toBe(streamTime);
      await progress('waiting_input', { summary: 'Choose a path' });
      await progress('text', { activity });
      expect(worker.phase).toBe('waiting_input');
      expect(worker.inputRequest).toBe('Choose a path');
      await progress('text', { activity, waitingForInput: 'false' });
      await progress('text', { activity, waitingForInput: true });
      expect(worker.phase).toBe('waiting_input');
      await progress('text', { activity: { source: 'public_text', text: 'Resumed after your choice' }, waitingForInput: false });
      expect(worker.phase).toBe('text');
      expect(worker.inputRequest).toBeUndefined();
      expect(worker.activity.text).toBe('Resumed after your choice');
      await progress('succeeded', { summary: 'Final worker result' });
      const snapshot = JSON.stringify(stream.elements);
      await progress('text', { activity });
      expect(JSON.stringify(stream.elements)).toBe(snapshot);
      expect(snapshot).toContain('Final worker result');
      expect(snapshot).not.toContain('Comparing paths');
      expect(snapshot).not.toContain('Resumed after your choice');
      expect(worker.elementIndex).toBe(index);
      expect(stream.elements).toHaveLength(length);
    });

    it('preserves legacy post-input text progress without requiring a new input-state field', async () => {
      const { send, stream } = await connect({ delegationProgress: true, delegationProgressText: true });
      const progress = (phase: string, extra: any = {}) => send({ ...envelope, streamType: 'delegation_progress',
        delegationProgress: { taskId: 'legacy-worker', backend: 'codex', phase, ...extra } });
      await progress('waiting_input', { summary: 'Choose a path' });
      await progress('text', { latestText: 'Legacy worker resumed' });
      const worker = stream.delegationProgress.get('legacy-worker');
      expect(worker.phase).toBe('text');
      expect(worker.inputRequest).toBeUndefined();
      expect(worker.latestText).toBe('Legacy worker resumed');
    });

    it('does not accept Worker activity with main support alone', async () => {
      const { send, stream } = await connect({ activityProgress: true });
      await send({ ...envelope, streamType: 'delegation_progress', delegationProgress: { taskId: 'worker', backend: 'codex', phase: 'text', activity } });
      expect(stream.delegationProgress.size).toBe(0);
    });
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
      const ws = { on: vi.fn(), send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN };
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

    it.each([true, false])('passes optional terminal execution metadata to the recovered card (offline=%s)', async offline => {
      const { send } = await connect();
      const metadata = { backend: 'claude', model: 'provider/model-a', modelSource: 'reported', reasoningEffort: 'high', effortSource: 'configured' };
      if (offline) {
        await send({ ...resume, taskResume: { ...resume.taskResume, state: 'completed', executionMetadata: metadata } });
      } else {
        await send(resume);
        await send({ type: 'response', messageId: resume.messageId, openId: 'user-1', success: true, executionMetadata: metadata });
      }
      expect(mockFeishuHandler.finalizeStreamingMessage.mock.calls.at(-1)[9]).toEqual(metadata);
    });

    it('ignores malformed optional execution metadata without losing a legacy result', async () => {
      const { send } = await connect();
      await send(resume);
      await send({ type: 'response', messageId: resume.messageId, openId: 'user-1', success: true, executionMetadata: 'invalid' });
      expect(mockFeishuHandler.finalizeStreamingMessage.mock.calls.at(-1)[9]).toBeUndefined();
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
      expect(mockFeishuHandler.setOnResolveThread.mock.calls[0][0]('old-card'))
        .toMatchObject({ threadId: 'thread-1', deviceId: 'device-1' });
      // No replacement card: the surviving card is adopted and later finalized.
      expect(mockFeishuHandler.sendStreamingStart).not.toHaveBeenCalled();
      await send({ type: 'response', messageId: resume.messageId, openId: 'user-1', success: true });
      expect(mockFeishuHandler.finalizeStreamingMessage.mock.calls[0][0]).toBe('old-card');
    });

    it('creates a recovery card when the surviving session has no card and retries failed delivery', async () => {
      const { send, replies } = await connect();
      mockFeishuHandler.setOnStartStreaming.mock.calls[0][0](resume.messageId, 'user-1', null, 'device-1');
      const completed = { ...resume, taskResume: { ...resume.taskResume, state: 'completed' } };
      mockFeishuHandler.sendStreamingStart.mockResolvedValueOnce(null);
      await send(completed);
      expect(replies().at(-1).success).toBe(false);
      expect(mockFeishuHandler.finalizeStreamingMessage).not.toHaveBeenCalled();
      mockFeishuHandler.finalizeStreamingMessage.mockResolvedValueOnce(false);
      await send(completed);
      expect(replies().at(-1).success).toBe(false);
      await send(completed);
      expect(replies().at(-1).success).toBe(true);
      expect(mockFeishuHandler.sendStreamingStart).toHaveBeenCalledTimes(2);
      expect(mockFeishuHandler.finalizeStreamingMessage).toHaveBeenCalledTimes(2);
      expect(mockFeishuHandler.finalizeStreamingMessage.mock.calls[1][0]).toBe('execution-card');
    });

    it('creates a fresh recovery card when the surviving card is already finalizing', async () => {
      const { send, replies } = await connect();
      mockFeishuHandler.setOnStartStreaming.mock.calls[0][0](resume.messageId, 'user-1', 'old-card', 'device-1');
      let finish!: (success: boolean) => void;
      mockFeishuHandler.finalizeStreamingMessage.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
      const stoppingCard = (server as any).finalizeStreamingMessage(resume.messageId, false, undefined, 'Connection lost');
      await Promise.resolve();
      await send(resume);
      expect(replies().at(-1).success).toBe(true);
      expect(mockFeishuHandler.sendStreamingStart).toHaveBeenCalledOnce();
      finish(true);
      await stoppingCard;
      await send({ type: 'response', messageId: resume.messageId, openId: 'user-1', success: true });
      expect(mockFeishuHandler.finalizeStreamingMessage.mock.calls.at(-1)[0]).toBe('execution-card');
    });

    it('isolates interrupted Markdown from the recovery notice and resumed text when adopting a card', async () => {
      const { send } = await connect();
      mockFeishuHandler.setOnStartStreaming.mock.calls[0][0](resume.messageId, 'user-1', 'old-card', 'device-1', 'thread-1');
      await send({ type: 'stream', messageId: resume.messageId, openId: 'user-1', chunk: '```ts\nconst before = 1;' });
      await send(resume);
      await send(resume);
      await send({ type: 'stream', messageId: resume.messageId, openId: 'user-1', chunk: 'tail\n```\n</raw>' });
      await send({ type: 'stream', messageId: resume.messageId, openId: 'user-1', streamType: 'tool_use',
        toolUse: { id: 'boundary', name: 'Read', input: { file_path: '/workspace/file' } } });
      await send({ type: 'stream', messageId: resume.messageId, openId: 'user-1', chunk: '**New segment**' });
      await send({ type: 'response', messageId: resume.messageId, openId: 'user-1', success: true });
      const elements = mockFeishuHandler.finalizeStreamingMessage.mock.calls[0][1];
      expect(elements[0].content).toBe('```ts\nconst before = 1;');
      expect(elements[1].content).toContain('Connection restored');
      expect(elements.filter(element => element.content?.includes('Connection restored'))).toHaveLength(1);
      expect(elements[2].content).toBe('<raw>tail\n```\n&lt;/raw&gt;</raw>');
      expect(elements.at(-1).content).toBe('**New segment**');
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

    it.each(['rejected request', 'failed update'])('retries a %s when adopting a card without acknowledging success early', async failure => {
      const { send, replies } = await connect();
      mockFeishuHandler.setOnStartStreaming.mock.calls[0][0](resume.messageId, 'user-1', 'old-card', 'device-1', 'thread-1');
      await send({ type: 'stream', messageId: resume.messageId, openId: 'user-1', chunk: 'kept output' });
      mockFeishuHandler.updateStreamingMessage.mockClear();
      if (failure === 'rejected request') {
        mockFeishuHandler.updateStreamingMessage.mockRejectedValueOnce(new Error('Card API rejected the update'));
      } else {
        mockFeishuHandler.updateStreamingMessage.mockResolvedValueOnce(false);
      }

      await send(resume);
      expect(replies().at(-1)).toMatchObject({ type: 'task_resume_ack', success: false });
      await send(resume);
      expect(replies().at(-1)).toMatchObject({ type: 'task_resume_ack', success: true });
      expect(mockFeishuHandler.updateStreamingMessage).toHaveBeenCalledTimes(2);
      expect(mockFeishuHandler.sendStreamingStart).not.toHaveBeenCalled();
      const [cardId, elements] = mockFeishuHandler.updateStreamingMessage.mock.calls[1];
      expect(cardId).toBe('old-card');
      expect(JSON.stringify(elements)).toContain('kept output');
      expect(elements.filter(element => element.content?.includes('Connection restored'))).toHaveLength(1);
      await send(resume);
      expect(mockFeishuHandler.updateStreamingMessage).toHaveBeenCalledTimes(2);
      await send({ type: 'response', messageId: resume.messageId, openId: 'user-1', success: true });
      expect(mockFeishuHandler.finalizeStreamingMessage.mock.calls[0][0]).toBe('old-card');
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
      expect(elements.slice(1, -2)).toHaveLength(5);
      for (const element of elements.slice(1, -2)) {
        expect(element.content).toMatch(/^<raw>(&lt;&amp;)+<\/raw>$/);
        expect(element.content.length).toBeLessThan(6000);
      }
      expect(elements.at(-2).tag).toBe('collapsible_panel');
      expect(elements.at(-1).content).toBe('**Next complete segment**');
    });
  });

  describe('early streaming headers', () => {
    const context = {
      type: 'stream_context', messageId: 'early-1', openId: 'user-1',
      threadId: 'thread-1', threadName: 'thread-9', cwd: '/workspace/project',
    };

    async function connect(capabilities = { streamingContext: true }) {
      await server.start();
      const onConnection = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
      const ws = { on: vi.fn(), send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN };
      onConnection(ws, { socket: { remoteAddress: '1' } });
      const onMessage = ws.on.mock.calls.find(call => call[0] === 'message')[1];
      const send = (message: any) => onMessage(Buffer.from(JSON.stringify(message)));
      await send({ type: 'binding_request', data: { deviceId: 'device-1', capabilities } });
      const start = mockFeishuHandler.setOnStartStreaming.mock.calls[0][0];
      start('early-1', 'user-1', 'early-card', 'device-1');
      return { send, start, ws };
    }

    it('resolves the header before text arrives and preserves it on text and tool updates', async () => {
      const { send, ws } = await connect();
      expect(JSON.parse(ws.send.mock.calls[0][0]).data.capabilities).toEqual({ streamingContext: true });
      await send(context);
      expect(mockFeishuHandler.updateStreamingMessage).toHaveBeenLastCalledWith(
        'early-card', expect.any(Array), 'user-1', 'thread-9', '/workspace/project',
      );
      expect(mockFeishuHandler.setOnResolveThread.mock.calls[0][0]('early-card')).toMatchObject({ threadId: 'thread-1' });
      await send(context);
      expect(mockFeishuHandler.updateStreamingMessage).toHaveBeenCalledTimes(1);
      // A header-only patch must not throttle the first short text token.
      await send({ type: 'stream', messageId: 'early-1', openId: 'user-1', chunk: 'Hi' });
      expect(mockFeishuHandler.updateStreamingMessage).toHaveBeenCalledTimes(2);
      await send({ type: 'stream', messageId: 'early-1', openId: 'user-1', streamType: 'tool_use', toolUse: { name: 'Read', id: 'read-1', input: {} } });
      for (const args of mockFeishuHandler.updateStreamingMessage.mock.calls) {
        expect(args.slice(3)).toEqual(['thread-9', '/workspace/project']);
      }
      await send({ type: 'response', messageId: 'early-1', openId: 'user-1', threadId: 'thread-1', success: true });
      expect(mockFeishuHandler.finalizeStreamingMessage.mock.calls.at(-1).slice(4, 6)).toEqual(['/workspace/project', 'thread-9']);
      expect(JSON.stringify(mockFeishuHandler.finalizeStreamingMessage.mock.calls)).not.toContain('Processing...');
    });

    it('rejects unnegotiated metadata from old peers', async () => {
      const { send, ws } = await connect({ streamingContext: false });
      expect(JSON.parse(ws.send.mock.calls[0][0]).data.capabilities).toBeUndefined();
      await send(context);
      expect(mockFeishuHandler.updateStreamingMessage).not.toHaveBeenCalled();
    });

    it('keeps thread metadata isolated and rejects malformed or mismatched context', async () => {
      const { send, start } = await connect();
      start('other-1', 'user-1', 'other-card', 'device-1', 'thread-2', false, undefined, 'thread-2');
      start('foreign-1', 'user-1', 'foreign-card', 'device-2');
      for (const invalid of [
        { ...context, openId: 'other-user' }, { ...context, messageId: 'foreign-1' },
        { ...context, messageId: 'other-1' }, { ...context, messageId: 'unknown' },
        { ...context, threadName: 'x'.repeat(101) }, { ...context, threadName: ' ' },
        { ...context, cwd: 'x'.repeat(4097) }, { ...context, cwd: null },
      ]) await send(invalid);
      expect(mockFeishuHandler.updateStreamingMessage).not.toHaveBeenCalled();
      await send(context);
      await send({ type: 'stream', messageId: 'other-1', openId: 'user-1', chunk: 'Other reply' });
      expect(mockFeishuHandler.updateStreamingMessage).toHaveBeenLastCalledWith(
        'other-card', expect.any(Array), 'user-1', 'thread-2', undefined,
      );
    });

    it('waits for an in-flight header patch before finalization and ignores late metadata', async () => {
      const { send } = await connect();
      let release!: (value: boolean) => void;
      mockFeishuHandler.updateStreamingMessage.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
      const patch = send(context);
      await Promise.resolve();
      const finish = send({ type: 'response', messageId: 'early-1', openId: 'user-1', threadId: 'thread-1', success: true, output: 'Done' });
      await Promise.resolve();
      expect(mockFeishuHandler.finalizeStreamingMessage).not.toHaveBeenCalled();
      await send({ ...context, threadName: 'Too late' });
      release(true);
      await Promise.all([patch, finish]);
      expect(mockFeishuHandler.finalizeStreamingMessage.mock.calls.at(-1)[5]).toBe('thread-9');
      await send(context);
      expect(mockFeishuHandler.updateStreamingMessage).toHaveBeenCalledTimes(1);
    });

    it('uses the final created or renamed thread instead of retaining the earlier caller header', async () => {
      const { send, start } = await connect();
      start('early-1', 'user-1', 'early-card', 'device-1', undefined, true);
      await send(context);
      await send({ type: 'response', messageId: 'early-1', openId: 'user-1', threadId: 'new-thread', success: true,
        threads: [{ id: 'new-thread', name: 'thread-10', status: 'idle' }] });
      expect(mockFeishuHandler.finalizeStreamingMessage.mock.calls.at(-1)[5]).toBe('thread-10');
      expect(mockFeishuHandler.setOnResolveThread.mock.calls[0][0]('early-card')).toMatchObject({ threadId: 'new-thread' });
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
      const ws = { on: vi.fn(), send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN };
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
        'thread-2', started.threads, 'thread-1', undefined, undefined,
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
        'other-card', expect.any(Array), 'user-1', undefined, undefined,
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
        .toContainEqual(expect.objectContaining({ tag: 'img', img_key: 'queued-image' }));
    });

    it.each(['img_v3_uploaded', null])('keeps nested local image Markdown safe when upload returns %s', async imageKey => {
      const send = await connect();
      await send(started);
      mockFeishuHandler.uploadImage.mockResolvedValue(imageKey);
      const common = { messageId: 'queued-1', openId: 'user-1' };
      for (const chunk of ['> - Here is the diagram:\n>     ![Diagram](', '/home/user/workspace/remote-cli/', 'dist/artifacts/orchestration-comparison.png)']) {
        await send({ ...common, type: 'stream', chunk });
        await vi.advanceTimersByTimeAsync(1000);
      }
      await send({ ...common, type: 'stream', streamType: 'image', image: { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' } });
      await send({ ...common, type: 'response', success: true });

      const elements = mockFeishuHandler.finalizeStreamingMessage.mock.calls[0][1];
      for (const [, patch] of mockFeishuHandler.updateStreamingMessage.mock.calls) {
        expect(JSON.stringify(patch)).not.toContain('![Diagram]');
      }
      expect(JSON.stringify(elements)).not.toContain('![Diagram]');
      expect(JSON.stringify(elements)).toContain('Here is the diagram:');
      if (imageKey) expect(elements).toContainEqual(expect.objectContaining({ tag: 'img', img_key: imageKey }));
      else expect(JSON.stringify(elements)).toContain('Generated image could not be uploaded to Feishu.');
    });

    it('renders a final-only local image reference safely for a CLI without image events', async () => {
      const send = await connect();
      mockFeishuHandler.setOnStartStreaming.mock.calls[0][0](
        'queued-1', 'user-1', 'legacy-card', 'device-1', 'thread-1',
      );
      await send({ type: 'response', messageId: 'queued-1', openId: 'user-1', success: true,
        output: '![Diagram](/workspace/chart.png)' });
      const elements = mockFeishuHandler.finalizeStreamingMessage.mock.calls[0][1];
      expect(JSON.stringify(elements)).toContain('<raw>Diagram</raw>');
      expect(JSON.stringify(elements)).not.toContain('![Diagram]');
      expect(mockFeishuHandler.uploadImage).not.toHaveBeenCalled();
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
        expect.objectContaining({ tag: 'collapsible_panel', elements: [{ tag: 'markdown', content: 'Tool result' }] }),
        { tag: 'markdown', content: 'Before image' },
        expect.objectContaining({ tag: 'img', img_key: 'image-key' }),
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
        'receipt-card', expect.any(Array), 'user-1', 'thread-2', '/workspace/project',
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
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });
    
    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    await onMessage(Buffer.from(JSON.stringify({ type: MessageType.BINDING_REQUEST, data: { deviceId: 'd1' } })));
    mockWs.send.mockClear();
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

  it('renders supported worker progress as stable visible content and folded diagnostics', async () => {
    await server.start();
    const onStartStreaming = mockFeishuHandler.setOnStartStreaming.mock.calls[0][0];
    onStartStreaming('m1', 'u1', 'f1', 'd1');

    const onConnection = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });
    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    await onMessage(Buffer.from(JSON.stringify({
      type: 'binding_request', data: { deviceId: 'd1', capabilities: { delegationProgress: true } },
    })));

    const sendProgress = async (delegationProgress: any) => onMessage(Buffer.from(JSON.stringify({
      type: 'stream', streamType: 'delegation_progress', messageId: 'm1', openId: 'u1', delegationProgress,
    })));
    await sendProgress({ taskId: 'worker-1', backend: 'claude', phase: 'started', objective: 'Review the README', startedAt: Date.now() });
    await sendProgress({ taskId: 'worker-1', backend: 'claude', phase: 'tool_use', toolUse: { id: 'read-1', name: 'Read', input: {} } });
    await sendProgress({ taskId: 'worker-1', backend: 'claude', phase: 'tool_result', toolResult: { tool_use_id: 'read-1', content: 'done', is_error: false } });
    await sendProgress({ taskId: 'worker-1', backend: 'claude', phase: 'waiting_input', summary: 'Approve the command?' });
    await sendProgress({ taskId: 'worker-1', backend: 'claude', phase: 'timed_out' });

    expect(createDelegationProgressElements).toHaveBeenCalledTimes(6);
    const elements = mockFeishuHandler.updateStreamingMessage.mock.calls.at(-1)[1];
    const panels = elements.filter((element: any) => element.tag === 'collapsible_panel');
    expect(panels).toHaveLength(1);
    expect(panels[0]).toMatchObject({ expanded: false });
    expect(JSON.stringify(elements.find((element: any) => element.element_id === 'dw_1_header'))).toContain('Timed out');
    expect(panels[0].header.title.content).toContain('Activity details');
    expect(panels[0].elements[0].content).not.toContain('Read running');
    expect(panels[0].elements[0].content).toContain('Read completed');
    expect(panels[0].elements[0].content).not.toContain('Approve the command?');
    expect(panels[0].elements[0].content).not.toContain('**Result:**');
  });

  it.each([false, true])('negotiates worker context controls without exposing them to legacy peers: %s', async supported => {
    await server.start();
    mockFeishuHandler.setOnStartStreaming.mock.calls[0][0]('m1', 'u1', 'f1', 'd1', 'thread-1');
    const onConnection = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
    const ws = { on: vi.fn(), send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN };
    onConnection(ws, { socket: { remoteAddress: '1' } });
    const message = ws.on.mock.calls.find(call => call[0] === 'message')[1];
    const send = (value: object) => message(Buffer.from(JSON.stringify(value)));
    await send({ type: 'binding_request', data: { deviceId: 'd1', capabilities: { delegationProgress: true, workerContextReset: supported } } });
    const confirmation = ws.send.mock.calls.map(([content]) => JSON.parse(content)).find(value => value.type === 'binding_confirm');
    expect(confirmation.data.capabilities.workerContextReset).toBe(supported || undefined);
    const workerContext = { laneId: '00000000-0000-0000-0000-000000000001', generation: 0 };
    const progress = (phase: string, context: any = workerContext, taskId = 'worker') => send({ type: 'stream', streamType: 'delegation_progress',
      messageId: 'm1', openId: 'u1', delegationProgress: { taskId, backend: 'claude', phase, workerContext: context } });
    await progress('started');
    let state = (server as any).streamingMessages.get('m1').delegationProgress.get('worker');
    expect(state.contextActionId).toBeUndefined();
    await progress('failed');
    expect(Boolean(state.contextActionId)).toBe(supported);
    await progress('failed', { laneId: '../invalid', generation: -1 }, 'invalid-worker');
    state = (server as any).streamingMessages.get('m1').delegationProgress.get('invalid-worker');
    expect(state.contextActionId).toBeUndefined();
    const resolve = vi.spyOn((server as any).workerContextCards, 'resolve').mockResolvedValue(undefined);
    await send({ type: 'worker_context_reset_result', messageId: 'reset', success: true });
    expect(resolve).toHaveBeenCalledTimes(supported ? 1 : 0);
    mockConnectionHub.isCurrentConnection.mockReturnValue(false);
    await send({ type: 'worker_context_reset_result', messageId: 'reset', success: true });
    expect(resolve).toHaveBeenCalledTimes(supported ? 1 : 0);
  });

  it('renders terminal worker Markdown received over the existing wire protocol', async () => {
    await server.start();
    mockFeishuHandler.setOnStartStreaming.mock.calls[0][0]('m1', 'u1', 'f1', 'd1');
    const onConnection = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });
    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    await onMessage(Buffer.from(JSON.stringify({
      type: 'binding_request', data: { deviceId: 'd1', capabilities: { delegationProgress: true } },
    })));
    await onMessage(Buffer.from(JSON.stringify({
      type: 'stream', streamType: 'delegation_progress', messageId: 'm1', openId: 'u1',
      delegationProgress: {
        taskId: 'rich-result', backend: 'claude', phase: 'succeeded',
        summary: '## Review\n\n**Passed**\n\n- Tests pass\n\n<at id=all></at>',
      },
    })));
    const body = mockFeishuHandler.updateStreamingMessage.mock.calls.at(-1)[1]
      .find((element: any) => element.element_id === 'dw_1_body');
    expect(body.tag).toBe('column_set');
    expect(body.columns[0]).toMatchObject({ width: 'weighted', weight: 1 });
    expect(body.columns[0].elements[0]).toEqual({
      tag: 'markdown', content: "<font color='grey'>Result excerpt</font>", text_size: 'notation',
    });
    expect(body.columns[0].elements[1].content).toContain('## Review\n\n**Passed**\n\n- Tests pass');
    expect(body.columns[0].elements[1].content).toContain('&lt;at id\\=all&gt;');
    expect(delegationBodyContent(body)).not.toContain('<at');
  });

  it('negotiates bounded worker text and refreshes an active panel without extending stream liveness', async () => {
    await server.start();
    const onStartStreaming = mockFeishuHandler.setOnStartStreaming.mock.calls[0][0];
    onStartStreaming('m1', 'u1', 'f1', 'd1');

    const onConnection = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });
    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    await onMessage(Buffer.from(JSON.stringify({
      type: 'binding_request', data: { deviceId: 'd1', capabilities: { delegationProgress: true, delegationProgressText: true } },
    })));
    expect(JSON.parse(mockWs.send.mock.calls[0][0]).data.capabilities).toEqual({
      delegationProgress: true,
      delegationProgressText: true,
    });

    const sendProgress = async (delegationProgress: any) => onMessage(Buffer.from(JSON.stringify({
      type: 'stream', streamType: 'delegation_progress', messageId: 'm1', openId: 'u1', delegationProgress,
    })));
    await sendProgress({ taskId: 'worker-1', backend: 'codex', phase: 'started', objective: 'Do not render this prominently', startedAt: Date.now() });
    await sendProgress({ taskId: 'worker-1', backend: 'codex', phase: 'text', latestText: 'Reviewing <unsafe> worker output.' });
    await sendProgress({ taskId: 'worker-1', backend: 'codex', phase: 'tool_use', toolUse: { id: 'read-1', name: 'Read', input: {} } });
    await sendProgress({ taskId: 'worker-1', backend: 'codex', phase: 'text', latestText: '## Review\n\n**Checking**\n\n<unsafe>' });

    const stream = (server as any).streamingMessages.get('m1');
    expect(stream.delegationProgress.get('worker-1').phase).toBe('tool_use');
    const createdAt = stream.createdAt;
    const patchesBeforeHeartbeat = mockFeishuHandler.updateStreamingMessage.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockFeishuHandler.updateStreamingMessage.mock.calls.length).toBeGreaterThan(patchesBeforeHeartbeat);
    expect(stream.createdAt).toBe(createdAt);

    const body = mockFeishuHandler.updateStreamingMessage.mock.calls.at(-1)[1]
      .find((element: any) => element.element_id === 'dw_1_body');
    expect(body.columns[0].elements[0].content).toContain('Latest update');
    expect(body.columns[0].elements[1].content).toContain('&lt;unsafe&gt;');
    expect(body.columns[0].elements[1].content).toContain('## Review\n\n**Checking**');
    expect(delegationBodyContent(body)).not.toContain('Do not render this prominently');

    await sendProgress({ taskId: 'worker-1', backend: 'codex', phase: 'succeeded', summary: 'Finished' });
    const patchesAfterTerminal = mockFeishuHandler.updateStreamingMessage.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockFeishuHandler.updateStreamingMessage).toHaveBeenCalledTimes(patchesAfterTerminal);
  });

  it('keeps two interleaved worker sections and coordinator text stable across heartbeat and terminal updates', async () => {
    await server.start();
    mockFeishuHandler.setOnStartStreaming.mock.calls[0][0]('m1', 'u1', 'f1', 'd1');
    const stream = (server as any).streamingMessages.get('m1');
    const send = (taskId: string, phase: string, fields: any = {}) => (server as any).handleDelegationProgress(
      'm1', 'u1', { taskId, backend: 'claude', phase, ...fields }, true);
    await send('first', 'started');
    stream.currentTextContent = 'Coordinator text between workers.';
    await send('second', 'started');
    const indices = [...stream.delegationProgress.values()].map((worker: any) => worker.elementIndex);
    const length = stream.elements.length;
    await send('first', 'tool_use', { toolUse: { id: 'read', name: 'Read', input: { secret: 'private' } } });
    const worker = stream.delegationProgress.get('first');
    const lastToolActivityAt = worker.lastToolActivityAt;
    await vi.advanceTimersByTimeAsync(1000);
    await send('first', 'text', { latestText: '**First latest**' });
    await send('second', 'text', { latestText: '**Second latest**' });
    expect(worker.lastActivityAt).toBeGreaterThan(lastToolActivityAt);
    const lastActivityAt = worker.lastActivityAt;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(worker.lastActivityAt).toBe(lastActivityAt);
    expect(worker.lastToolActivityAt).toBe(lastToolActivityAt);
    await send('first', 'failed', { error: '**Worker failed**' });
    await send('second', 'succeeded', { summary: '**Second result**' });
    const finalBody = (ordinal: number) => stream.elements.find((element: any) => element.element_id === `dw_${ordinal}_body`);
    expect(delegationBodyContent(finalBody(1))).toContain('**Worker failed**');
    expect(delegationBodyContent(finalBody(1))).toContain('**First latest**');
    expect(delegationBodyContent(finalBody(1))).toContain('not a final result');
    expect(delegationBodyContent(finalBody(2))).toContain('**Second result**');
    expect(delegationBodyContent(finalBody(2))).not.toContain('Second latest');
    expect(JSON.stringify(stream.elements)).toContain('Coordinator text between workers');
    expect(JSON.stringify(stream.elements)).not.toContain('private');
    expect(stream.elements).toHaveLength(length);
    expect([...stream.delegationProgress.values()].map((item: any) => item.elementIndex)).toEqual(indices);
    const finalJson = JSON.stringify(stream.elements);
    await vi.advanceTimersByTimeAsync(30_000);
    await send('first', 'text', { latestText: 'Late text must not replace the terminal result' });
    expect(JSON.stringify(stream.elements)).toBe(finalJson);
  });

  it('isolates worker execution notes through live updates, heartbeats and terminal replacement', async () => {
    await server.start();
    mockFeishuHandler.setOnStartStreaming.mock.calls[0][0]('m1', 'u1', 'f1', 'd1');
    const stream = (server as any).streamingMessages.get('m1');
    const metadata = (backend: string, model: string, source = 'reported') => ({ backend, model, modelSource: source, reasoningEffort: 'high', effortSource: 'reported' });
    const send = (taskId: string, backend: string, phase: string, executionMetadata?: any) => (server as any).handleDelegationProgress(
      'm1', 'u1', { taskId, backend, phase, executionMetadata }, true);
    await send('first', 'codex', 'started', metadata('codex', 'selected-model', 'configured'));
    await send('second', 'agy', 'started', metadata('agy', 'agy-model'));
    const length = stream.elements.length;
    const note = (ordinal: number) => stream.elements.find((element: any) => element.element_id === `dw_${ordinal}_meta`).content;
    expect(note(1)).toContain('selected-model (configured)');
    expect(note(2)).toContain('agy-model');
    await send('first', 'codex', 'tool_use', metadata('codex', 'native-model'));
    await send('first', 'codex', 'text', metadata('agy', 'other-backend-model'));
    await send('first', 'codex', 'text', { ...metadata('codex', 'malformed-model'), modelSource: 'invalid' });
    await send('first', 'codex', 'tool_result');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(note(1)).toContain('native-model');
    expect(note(1).match(/Model:/g)).toHaveLength(1);
    expect(note(1)).not.toContain('agy-model');
    await send('first', 'codex', 'succeeded', metadata('codex', 'final-model'));
    await send('first', 'codex', 'text', metadata('codex', 'late-model'));
    expect(note(1)).toContain('final-model');
    expect(note(2)).toContain('agy-model');
    expect(JSON.stringify(stream.elements)).not.toMatch(/other-backend-model|malformed-model|late-model/);
    expect(stream.elements).toHaveLength(length);
  });

  it('coalesces tool outcomes and keeps tool issues visible after their log entries are evicted', async () => {
    await server.start();
    mockFeishuHandler.setOnStartStreaming.mock.calls[0][0]('m1', 'u1', 'f1', 'd1');
    const send = (phase: string, fields: any = {}) => (server as any).handleDelegationProgress(
      'm1', 'u1', { taskId: 'worker', backend: 'agy', phase, ...fields }, true);
    await send('started');
    for (let index = 0; index < 8; index++) {
      await send('tool_use', { toolUse: { id: `tool-${index}`, name: 'Bash' } });
      await send('tool_result', { toolResult: { tool_use_id: `tool-${index}`, is_error: index === 0, content: 'Private tool output' } });
    }
    const stream = (server as any).streamingMessages.get('m1');
    const worker = stream.delegationProgress.get('worker');
    expect(worker.events).toHaveLength(5);
    expect(worker.events.every((event: any) => event.label.startsWith('Bash completed'))).toBe(true);
    expect(worker.hiddenEventCount).toBe(4);
    expect(worker.toolErrorCount).toBe(1);
    expect(worker.activeToolCount).toBe(0);
    expect(stream.elements.find((element: any) => element.element_id === 'dw_1_meta').content).toContain('1 tool issue');
    expect(stream.elements.find((element: any) => element.element_id === 'dw_1_meta').content).toContain('earlier details omitted');
    expect(JSON.stringify(stream.elements)).not.toContain('Private tool output');
  });

  it('ignores delegated worker progress from a client that did not advertise support', async () => {
    await server.start();
    const onStartStreaming = mockFeishuHandler.setOnStartStreaming.mock.calls[0][0];
    onStartStreaming('m1', 'u1', 'f1', 'd1');

    const onConnection = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });
    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    await onMessage(Buffer.from(JSON.stringify({ type: MessageType.BINDING_REQUEST, data: { deviceId: 'd1' } })));
    mockWs.send.mockClear();
    await onMessage(Buffer.from(JSON.stringify({ type: 'binding_request', data: { deviceId: 'd1' } })));
    await onMessage(Buffer.from(JSON.stringify({
      type: 'stream', streamType: 'delegation_progress', messageId: 'm1', openId: 'u1',
      delegationProgress: { taskId: 'worker-1', backend: 'claude', phase: 'started' },
    })));

    expect(createDelegationProgressElements).not.toHaveBeenCalled();
    expect(mockFeishuHandler.updateStreamingMessage).not.toHaveBeenCalled();
  });

  it('should handle text chunk streaming with throttled updates', async () => {
    await server.start();
    const onStartStreaming = mockFeishuHandler.setOnStartStreaming.mock.calls[0][0];
    onStartStreaming('m1', 'u1', 'f1', 'd1');

    const onConnection = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });
    
    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    await onMessage(Buffer.from(JSON.stringify({ type: MessageType.BINDING_REQUEST, data: { deviceId: 'd1' } })));
    mockWs.send.mockClear();
    
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
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });
    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    await onMessage(Buffer.from(JSON.stringify({ type: MessageType.BINDING_REQUEST, data: { deviceId: 'd1' } })));
    mockWs.send.mockClear();
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
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });
    
    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    await onMessage(Buffer.from(JSON.stringify({ type: MessageType.BINDING_REQUEST, data: { deviceId: 'd1' } })));
    mockWs.send.mockClear();
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
      undefined,
      undefined,
      false
    );
  });

  it('should handle finalize streaming message without feishuMessageId', async () => {
    await server.start();
    const onStartStreaming = mockFeishuHandler.setOnStartStreaming.mock.calls[0][0];
    onStartStreaming('m1', 'u1', null, 'd1'); // No feishuMessageId

    const onConnection = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });
    
    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    await onMessage(Buffer.from(JSON.stringify({ type: MessageType.BINDING_REQUEST, data: { deviceId: 'd1' } })));
    mockWs.send.mockClear();
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
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });
    
    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    await onMessage(Buffer.from(JSON.stringify({ type: MessageType.BINDING_REQUEST, data: { deviceId: 'd1' } })));
    mockWs.send.mockClear();
    
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
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN };
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
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });
    
    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    await onMessage(Buffer.from(JSON.stringify({ type: MessageType.BINDING_REQUEST, data: { deviceId: 'd1' } })));
    mockWs.send.mockClear();
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
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });
    
    // First register streaming session via callback
    const onStartStreaming = mockFeishuHandler.setOnStartStreaming.mock.calls[0][0];
    onStartStreaming('m1', 'u1', 'f1', 'd1');

    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    await onMessage(Buffer.from(JSON.stringify({ type: MessageType.BINDING_REQUEST, data: { deviceId: 'd1' } })));
    mockWs.send.mockClear();
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

  it('keeps streaming after a Bash event without command arguments', async () => {
    const formatter = await vi.importActual<typeof import('../src/utils/ToolFormatter')>('../src/utils/ToolFormatter');
    vi.mocked(createToolUseElement)
      .mockImplementationOnce(formatter.createToolUseElement)
      .mockImplementationOnce(formatter.createToolUseElement);
    vi.mocked(createToolResultElement).mockImplementationOnce(formatter.createToolResultElement);
    await server.start();
    const onConnection = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });
    
    const onStartStreaming = mockFeishuHandler.setOnStartStreaming.mock.calls[0][0];
    onStartStreaming('m1', 'u1', 'f1', 'd1');

    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    await onMessage(Buffer.from(JSON.stringify({ type: MessageType.BINDING_REQUEST, data: { deviceId: 'd1' } })));
    mockWs.send.mockClear();
    await onMessage(Buffer.from(JSON.stringify({
      type: 'stream',
      streamType: 'tool_use',
      messageId: 'm1',
      openId: 'u1',
      toolUse: { name: 'Bash', id: 'partial-tool', input: { description: 'Waiting for command arguments' } }
    })));

    expect(mockFeishuHandler.updateStreamingMessage).toHaveBeenCalled();
    const partialElements = mockFeishuHandler.updateStreamingMessage.mock.lastCall[1];
    expect(JSON.stringify(partialElements)).toContain('Waiting for command arguments');

    await onMessage(Buffer.from(JSON.stringify({
      type: 'stream', streamType: 'tool_use', messageId: 'm1', openId: 'u1',
      toolUse: { name: 'Bash', id: 'complete-tool', input: { command: 'echo recovered' } },
    })));
    await onMessage(Buffer.from(JSON.stringify({
      type: 'stream', streamType: 'tool_result', messageId: 'm1', openId: 'u1',
      toolResult: { tool_use_id: 'complete-tool', content: 'recovered', is_error: false },
    })));
    await onMessage(Buffer.from(JSON.stringify({ type: 'response', messageId: 'm1', openId: 'u1', success: true })));

    const elements = mockFeishuHandler.finalizeStreamingMessage.mock.lastCall[1];
    const rendered = JSON.stringify(elements);
    expect(rendered).toContain('Waiting for command arguments');
    expect(rendered).toContain('echo recovered');
    expect(rendered).toContain('SUCCESS');
    expect(console.error).not.toHaveBeenCalledWith('Error processing message:', expect.anything());
  });

  it('should handle WebSocket stream tool_result', async () => {
    await server.start();
    const onConnection = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });
    
    const onStartStreaming = mockFeishuHandler.setOnStartStreaming.mock.calls[0][0];
    onStartStreaming('m1', 'u1', 'f1', 'd1');

    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    await onMessage(Buffer.from(JSON.stringify({ type: MessageType.BINDING_REQUEST, data: { deviceId: 'd1' } })));
    mockWs.send.mockClear();
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
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });
    
    const onStartStreaming = mockFeishuHandler.setOnStartStreaming.mock.calls[0][0];
    onStartStreaming('m1', 'u1', 'f1', 'd1');

    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    await onMessage(Buffer.from(JSON.stringify({ type: MessageType.BINDING_REQUEST, data: { deviceId: 'd1' } })));
    mockWs.send.mockClear();
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
      'f1', [{ tag: 'markdown', content: 'Visible answer' }, notice], 'u1', undefined, undefined,
    );
    expect(JSON.stringify(mockFeishuHandler.updateStreamingMessage.mock.calls)).not.toContain('ENCRYPTED_REASONING');
  });

  it('should handle WebSocket stream plan_mode', async () => {
    await server.start();
    const onConnection = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });
    
    const onStartStreaming = mockFeishuHandler.setOnStartStreaming.mock.calls[0][0];
    onStartStreaming('m1', 'u1', 'f1', 'd1');

    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    await onMessage(Buffer.from(JSON.stringify({ type: MessageType.BINDING_REQUEST, data: { deviceId: 'd1' } })));
    mockWs.send.mockClear();
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
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });

    const onStartStreaming = mockFeishuHandler.setOnStartStreaming.mock.calls[0][0];
    onStartStreaming('m1', 'u1', 'f1', 'd1');

    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    await onMessage(Buffer.from(JSON.stringify({ type: MessageType.BINDING_REQUEST, data: { deviceId: 'd1' } })));
    mockWs.send.mockClear();
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
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });
    
    const onStartStreaming = mockFeishuHandler.setOnStartStreaming.mock.calls[0][0];
    onStartStreaming('m1', 'u1', 'f1', 'd1');

    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    await onMessage(Buffer.from(JSON.stringify({ type: MessageType.BINDING_REQUEST, data: { deviceId: 'd1' } })));
    mockWs.send.mockClear();
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
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });
    
    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    await onMessage(Buffer.from(JSON.stringify({ type: MessageType.BINDING_REQUEST, data: { deviceId: 'd1' } })));
    mockWs.send.mockClear();
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
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN };
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
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN };
    onConnection(mockWs, { socket: { remoteAddress: '1' } });
    
    const onMessage = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    await onMessage(Buffer.from(JSON.stringify({ type: MessageType.BINDING_REQUEST, data: { deviceId: 'd1' } })));
    mockWs.send.mockClear();
    
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
