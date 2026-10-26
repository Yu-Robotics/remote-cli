import { EventEmitter } from 'events';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { Server } from 'http';
import Koa from 'koa';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { RouterServer } from '../src/server';
import type { ConfigManager } from '../src/config/ConfigManager';
import type { JsonStore } from '../src/storage/JsonStore';
import { FeishuLongConnHandler } from '../src/feishu/FeishuLongConnHandler';

vi.mock('ws');
vi.mock('../src/feishu/FeishuLongConnHandler');

type TestSocket = EventEmitter & {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  readyState: number;
};

const taskResume = {
  type: 'task_resume', messageId: 'recover-task', openId: 'owner', threadId: 'thread-1',
  taskResume: {
    recoveryId: 'recovery-1', threadName: 'Thread 1', backend: 'claude',
    cwd: '', preview: 'Review the project', state: 'running',
  },
};

describe('Router recipient ownership', () => {
  let directory: string;
  let server: RouterServer;
  let wss: EventEmitter;
  let feishu: any;
  let owners: Map<string, string>;
  let bindingLookup: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'router-recipient-ownership-')));
    taskResume.taskResume.cwd = path.join(directory, 'project');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(Koa.prototype, 'listen').mockReturnValue({
      close: (callback: () => void) => callback(),
    } as unknown as Server);
    wss = Object.assign(new EventEmitter(), { close: vi.fn() });
    vi.mocked(WebSocketServer).mockImplementation(() => wss as unknown as WebSocketServer);
    const config = {
      getConfigPath: () => path.join(directory, 'config.json'),
      get: (section: string, key: string) => section === 'files' ? { enabled: false } : key === 'heartbeatInterval' ? 30000 : 'test',
    };
    owners = new Map();
    server = new RouterServer(config as unknown as ConfigManager, { flush: vi.fn().mockResolvedValue(undefined) } as unknown as JsonStore);
    bindingLookup = vi.spyOn((server as any).bindingManager, 'getDeviceBinding').mockImplementation(
      async (deviceId: string) => owners.has(deviceId) ? { openId: owners.get(deviceId) } : null,
    );
    await server.start();
    feishu = vi.mocked(FeishuLongConnHandler).mock.instances[0];
  });

  afterEach(async () => {
    try { await server.stop(); }
    finally {
      vi.restoreAllMocks();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  function connect(): TestSocket {
    const socket = Object.assign(new EventEmitter(), {
      send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN,
    }) as TestSocket;
    wss.emit('connection', socket, { socket: { remoteAddress: '127.0.0.1' } });
    return socket;
  }

  async function receive(socket: TestSocket, message: object): Promise<void> {
    await socket.listeners('message')[0](Buffer.from(JSON.stringify(message)));
  }

  async function register(socket: TestSocket, capabilities?: Record<string, boolean>): Promise<void> {
    await receive(socket, { type: 'binding_request', data: { deviceId: 'device-1', ...(capabilities ? { capabilities } : {}) } });
  }

  function replies(socket: TestSocket): any[] {
    return socket.send.mock.calls.map(call => JSON.parse(call[0]));
  }

  it('delivers top-level and nested unknown-task responses for a bound legacy CLI', async () => {
    owners.set('device-1', 'owner');
    const socket = connect();
    await register(socket);

    await receive(socket, { type: 'response', messageId: 'plain-1', openId: 'owner', success: true, output: 'Top level' });
    await receive(socket, { type: 'response', messageId: 'plain-2', data: { openId: 'owner', success: true, output: 'Nested' } });

    expect(feishu.sendMessage.mock.calls).toEqual([
      ['owner', 'Top level'],
      ['owner', 'Nested'],
    ]);
  });

  it.each([
    { label: 'foreign recipient', boundOwner: 'owner', recipient: 'other-user' },
    { label: 'unbound device', boundOwner: undefined, recipient: 'owner' },
  ])('rejects a $label response before delivery, receipt, or image state', async ({ boundOwner, recipient }) => {
    if (boundOwner) owners.set('device-1', boundOwner);
    const socket = connect();
    await register(socket, { taskRecovery: true });
    socket.send.mockClear();

    await receive(socket, { type: 'response', messageId: 'unknown-task', openId: recipient, success: true, output: 'Do not deliver' });

    expect(feishu.sendMessage).not.toHaveBeenCalled();
    expect(replies(socket).filter(message => message.type === 'task_result_ack')).toEqual([]);
    expect((server as any).completedTasks.size).toBe(0);
    expect((server as any).streamingMessages.size).toBe(0);
    expect((server as any).imageReplies.size).toBe(0);
  });

  it('does not acknowledge an existing completion receipt to a foreign recipient', async () => {
    owners.set('device-1', 'owner');
    const socket = connect();
    await register(socket, { taskRecovery: true });
    (server as any).completedTasks.set('completed-task', { deviceId: 'device-1', completedAt: Date.now() });
    socket.send.mockClear();

    await receive(socket, { type: 'response', messageId: 'completed-task', openId: 'other-user', success: true });

    expect(replies(socket).filter(message => message.type === 'task_result_ack')).toEqual([]);
    expect(feishu.sendMessage).not.toHaveBeenCalled();
    expect((server as any).completedTasks.get('completed-task')).toMatchObject({ deviceId: 'device-1' });
  });

  it('delivers independent bound legacy notifications and task cards', async () => {
    owners.set('device-1', 'owner');
    const socket = connect();
    await register(socket);
    feishu.sendTaskNotificationCard.mockResolvedValue('background-card');

    await receive(socket, { type: 'notification', openId: 'owner', title: '🔒 Authorization Required', message: 'Approve?' });
    await receive(socket, {
      type: 'task_notification', messageId: 'background-1', openId: 'owner', threadId: 'thread-1',
      taskNotification: { taskId: 'native-1', status: 'completed', summary: 'Done', outputFile: path.join(directory, 'output.txt') },
    });

    expect(feishu.sendMessage).toHaveBeenCalledWith('owner', '**🔒 Authorization Required**\n\nApprove?');
    expect(feishu.sendTaskNotificationCard).toHaveBeenCalledWith('owner', expect.any(Array));
    expect((server as any).cardThreadMap.get('background-card')).toMatchObject({ deviceId: 'device-1', threadId: 'thread-1' });
  });

  it.each([
    { label: 'foreign recipient', boundOwner: 'owner', recipient: 'other-user' },
    { label: 'unbound device', boundOwner: undefined, recipient: 'owner' },
  ])('rejects $label standalone notifications and task cards', async ({ boundOwner, recipient }) => {
    if (boundOwner) owners.set('device-1', boundOwner);
    const socket = connect();
    await register(socket);

    await receive(socket, { type: 'notification', openId: recipient, title: '🔒 Authorization Required', message: 'Approve?' });
    await receive(socket, {
      type: 'task_notification', messageId: 'background-1', openId: recipient, threadId: 'thread-1',
      taskNotification: { taskId: 'native-1', status: 'completed', summary: 'Done', outputFile: path.join(directory, 'output.txt') },
    });

    expect(feishu.sendMessage).not.toHaveBeenCalled();
    expect(feishu.sendTaskNotificationCard).not.toHaveBeenCalled();
    expect((server as any).cardThreadMap.size).toBe(0);
  });

  it.each([
    { label: 'foreign recipient', boundOwner: 'owner', recipient: 'other-user' },
    { label: 'unbound device', boundOwner: undefined, recipient: 'owner' },
  ])('does not create a recovery card or success acknowledgement for a $label', async ({ boundOwner, recipient }) => {
    if (boundOwner) owners.set('device-1', boundOwner);
    const socket = connect();
    await register(socket, { taskRecovery: true });
    socket.send.mockClear();

    await receive(socket, { ...taskResume, openId: recipient });

    expect(feishu.sendStreamingStart).not.toHaveBeenCalled();
    expect(replies(socket).filter(message => message.type === 'task_resume_ack')).toEqual([]);
    expect((server as any).streamingMessages.size).toBe(0);
    expect((server as any).imageReplies.size).toBe(0);
    expect((server as any).completedTasks.size).toBe(0);
  });

  it('recovers and acknowledges a bound task with the existing response shapes', async () => {
    owners.set('device-1', 'owner');
    const socket = connect();
    await register(socket, { taskRecovery: true });
    feishu.sendStreamingStart.mockResolvedValue('recovery-card');
    socket.send.mockClear();

    await receive(socket, taskResume);
    expect(replies(socket).at(-1)).toMatchObject({ type: 'task_resume_ack', success: true, recoveryId: 'recovery-1' });
    expect((server as any).streamingMessages.get('recover-task')).toMatchObject({ openId: 'owner', deviceId: 'device-1' });

    await receive(socket, { type: 'response', messageId: 'recover-task', data: { openId: 'owner', success: true, output: 'Recovered' } });
    expect(replies(socket).at(-1)).toMatchObject({ type: 'task_result_ack', messageId: 'recover-task' });
    expect(feishu.finalizeStreamingMessage).toHaveBeenCalled();
  });

  it('rejects a foreign queue start before marking or staging the task', async () => {
    owners.set('device-1', 'owner');
    const socket = connect();
    await register(socket, { queueStarted: true });

    await receive(socket, {
      type: 'queue_started', messageId: 'queued-foreign', openId: 'other-user', threadId: 'thread-1',
      queueStarted: { threadName: 'Thread 1', backend: 'claude', cwd: directory, preview: 'Task', remainingCount: 0 },
    });

    expect(feishu.sendStreamingStart).not.toHaveBeenCalled();
    expect((server as any).startedQueueMessages.size).toBe(0);
    expect((server as any).streamingMessages.size).toBe(0);
    expect((server as any).imageReplies.size).toBe(0);
  });

  it('rejects output that borrows an existing session identity', async () => {
    owners.set('device-1', 'owner');
    const socket = connect();
    await register(socket, { taskRecovery: true });
    const startStreaming = feishu.setOnStartStreaming.mock.calls[0][0];
    startStreaming('shared-task', 'victim', 'victim-card', 'device-1', 'thread-1');
    const stream = (server as any).streamingMessages.get('shared-task');
    const before = JSON.stringify(stream);
    socket.send.mockClear();

    await receive(socket, { type: 'stream', messageId: 'shared-task', openId: 'owner', chunk: 'Injected' });
    await receive(socket, { type: 'response', messageId: 'shared-task', openId: 'owner', success: true });

    expect(JSON.stringify(stream)).toBe(before);
    expect(feishu.updateStreamingMessage).not.toHaveBeenCalled();
    expect(feishu.finalizeStreamingMessage).not.toHaveBeenCalled();
    expect(replies(socket).filter(message => message.type === 'task_result_ack')).toEqual([]);
  });

  it('does not attach accepted output to a replacement stream during ownership lookup', async () => {
    owners.set('device-1', 'owner');
    const socket = connect();
    await register(socket);
    const startStreaming = feishu.setOnStartStreaming.mock.calls[0][0];
    startStreaming('shared-task', 'owner', 'original-card', 'device-1', 'thread-1');
    let resolveLookup!: (value: { openId: string }) => void;
    bindingLookup.mockImplementationOnce(() => new Promise(resolve => { resolveLookup = resolve; }));

    const pending = receive(socket, { type: 'stream', messageId: 'shared-task', openId: 'owner', chunk: 'Old output' });
    startStreaming('shared-task', 'owner', 'replacement-card', 'device-1', 'thread-2');
    const replacement = (server as any).streamingMessages.get('shared-task');
    const before = JSON.stringify(replacement);
    resolveLookup({ openId: 'owner' });
    await pending;

    expect((server as any).streamingMessages.get('shared-task')).toBe(replacement);
    expect(JSON.stringify(replacement)).toBe(before);
    expect(feishu.updateStreamingMessage).not.toHaveBeenCalled();
  });

  it('rechecks the current socket after an awaited ownership lookup', async () => {
    owners.set('device-1', 'owner');
    const oldSocket = connect();
    await register(oldSocket, { taskRecovery: true });
    oldSocket.send.mockClear();
    let resolveLookup!: (value: { openId: string }) => void;
    bindingLookup.mockImplementationOnce(() => new Promise(resolve => { resolveLookup = resolve; }));

    const pending = receive(oldSocket, { type: 'response', messageId: 'stale-task', openId: 'owner', success: true, output: 'Stale' });
    expect(bindingLookup).toHaveBeenCalledWith('device-1');
    const replacement = connect();
    await register(replacement, { taskRecovery: true });
    resolveLookup({ openId: 'owner' });
    await pending;

    expect(feishu.sendMessage).not.toHaveBeenCalled();
    expect(replies(oldSocket).filter(message => message.type === 'task_result_ack')).toEqual([]);
  });

  it('rejects an ownership change discovered by the authoritative lookup', async () => {
    owners.set('device-1', 'original-owner');
    const socket = connect();
    await register(socket, { taskRecovery: true });
    socket.send.mockClear();
    bindingLookup.mockResolvedValueOnce({ openId: 'new-owner' });

    await receive(socket, { type: 'response', messageId: 'changed-owner', openId: 'original-owner', success: true, output: 'Stale owner' });

    expect(feishu.sendMessage).not.toHaveBeenCalled();
    expect(replies(socket).filter(message => message.type === 'task_result_ack')).toEqual([]);
    expect((server as any).completedTasks.size).toBe(0);
  });

  it('rechecks owner and socket after a delayed finalization before dispatch', async () => {
    owners.set('device-1', 'owner');
    const socket = connect();
    await register(socket, { taskRecovery: true });
    const startStreaming = feishu.setOnStartStreaming.mock.calls[0][0];
    startStreaming('delayed-final', 'owner', 'delayed-card', 'device-1', 'thread-1');
    const stream = (server as any).streamingMessages.get('delayed-final');
    let releaseUpdate!: () => void;
    stream.updateInFlight = new Promise<void>(resolve => { releaseUpdate = resolve; });
    socket.send.mockClear();

    const pending = receive(socket, { type: 'response', messageId: 'delayed-final', openId: 'owner', success: true });
    await vi.waitFor(() => expect(stream.finalizing).toBe(true));
    owners.delete('device-1');
    await feishu.onRevokeDevice('device-1');
    releaseUpdate();
    await pending;

    expect(feishu.finalizeStreamingMessage).not.toHaveBeenCalled();
    expect(feishu.sendMessage).not.toHaveBeenCalled();
    expect(replies(socket).filter(message => message.type === 'task_result_ack')).toEqual([]);
  });
});
