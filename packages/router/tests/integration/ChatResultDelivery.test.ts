import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import { createServer } from 'http';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { Client } from '@larksuiteoapi/node-sdk';
import { RouterServer } from '../../src/server';
import { JsonStore } from '../../src/storage/JsonStore';
import { MessageType } from '../../src/types';

vi.mock('@larksuiteoapi/node-sdk');

const openId = 'chat-owner';
const deviceId = 'chat-device';
const threadId = 'chat-thread';

class DeviceSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly sent: any[] = [];
  send(frame: string) { this.sent.push(JSON.parse(frame)); }
  close() { this.readyState = WebSocket.CLOSED; this.emit('close'); }
  async receive(frame: object) {
    await this.listeners('message')[0](Buffer.from(JSON.stringify(frame)));
  }
  frames(type: string) { return this.sent.filter(frame => frame.type === type); }
}

function deliveryFixture() {
  let home: string;
  let server: RouterServer;
  let nextId = 0;
  const create = vi.fn(async (_request: { data: { msg_type: string; receive_id: string; content: string } }): Promise<{ code: number; data: { message_id?: string } }> =>
    ({ code: 0, data: { message_id: `card-${++nextId}` } }));
  const patch = vi.fn(async (_request: { path: { message_id: string }; data: { content: string } }) => ({ code: 0 }));

  async function start() {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'router-chat-delivery-')));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.mocked(Client).mockImplementation(() => ({ im: { message: { create, patch, reply: vi.fn() } } }) as any);
    const store = new JsonStore(path.join(home, 'bindings.json'), 0);
    await store.initialize();
    const config = {
      getConfigPath: () => path.join(home, 'router.json'),
      get: (section: string) => section === 'files' || section === 'tips' ? { enabled: false }
        : section === 'websocket' ? 30_000 : undefined,
    };
    server = new RouterServer(config as any, store);
    await server['bindingManager'].bindUser(openId, deviceId, 'Chat device');
    server['setupWebSocket'](createServer());
  }

  afterAll(async () => {
    try { await server?.stop(); }
    finally {
      vi.restoreAllMocks();
      if (home) await fs.rm(home, { recursive: true, force: true });
    }
  });

  async function connect() {
    const socket = new DeviceSocket();
    server['wss']!.emit('connection', socket, { socket: { remoteAddress: '127.0.0.1' } });
    await socket.receive({ type: MessageType.BINDING_REQUEST, data: { deviceId, capabilities: { taskRecovery: true } } });
    expect(socket.sent).toContainEqual(expect.objectContaining({
      type: MessageType.BINDING_CONFIRM, data: expect.objectContaining({ capabilities: { taskRecovery: true } }),
    }));
    return socket;
  }
  async function submit(text: string, parentId?: string) {
    await server['feishuLongConnHandler']['handleMessageEvent']({
      sender: { sender_id: { open_id: openId } },
      message: { message_id: `incoming-${++nextId}`, message_type: 'text', parent_id: parentId, content: JSON.stringify({ text }) },
    });
  }
  async function chat(socket: DeviceSocket, text: string, parentId?: string) {
    const before = socket.frames(MessageType.COMMAND).length;
    await submit(text, parentId);
    const commands = socket.frames(MessageType.COMMAND).slice(before);
    expect(commands).toEqual([expect.objectContaining({ messageId: expect.any(String), openId, content: text })]);
    return commands[0];
  }
  const selectThread = (id: string) => server['selections'].select(openId, deviceId, id);
  const changeOwner = async (previous: string, next: string) => {
    await server['bindingManager'].unbindDevice(previous, deviceId);
    await server['bindingManager'].bindUser(next, deviceId, 'Rebound device');
  };
  return { create, patch, submit, chat, connect, start, selectThread, changeOwner, get server() { return server; } };
}

describe.each([
  { label: 'result', success: true, detail: 'The requested check passed.' },
  { label: 'error', success: false, detail: 'The requested check timed out.' },
])('ordinary chat $label after initial card creation fails', ({ success, detail }) => {
  const { create, chat, connect, start } = deliveryFixture();
  it('delivers the stream and terminal detail by text to the original Feishu user', async () => {
    await start();
    const socket = await connect();
    create.mockRejectedValueOnce(new Error('Card creation unavailable'));
    const { messageId } = await chat(socket, 'Run the check');
    expect(create.mock.calls.map(([request]) => request.data)).toEqual([
      expect.objectContaining({ msg_type: 'interactive', receive_id: openId }),
    ]);
    await socket.receive({ type: 'stream', messageId, openId, threadId, chunk: 'Checking the project.' });
    await socket.receive({ type: MessageType.RESPONSE, messageId, openId, threadId, success,
      ...(success ? { output: detail } : { error: detail }) });
    const texts = create.mock.calls.map(([request]) => request.data).filter(data => data.msg_type === 'text')
      .map(data => ({ recipient: data.receive_id, text: JSON.parse(data.content).text }));
    expect(texts).toEqual([{ recipient: openId, text: expect.stringContaining(detail) }]);
    expect(texts[0].text).toContain('Checking the project.');
    expect(socket.frames('task_result_ack')).toMatchObject([{ messageId }]);
  });
});

describe('ordinary chat when both card and text delivery are unavailable', () => {
  const { create, patch, chat, connect, start, selectThread } = deliveryFixture();
  it('retries only delivery, suppresses duplicate output, and routes the next chat to the original thread', async () => {
    await start();
    const socket = await connect();
    await selectThread(threadId);
    create.mockRejectedValueOnce(new Error('Card unavailable')).mockRejectedValueOnce(new Error('Text unavailable'));
    const { messageId } = await chat(socket, 'Check availability');
    expect(create.mock.calls[0][0].data).toMatchObject({ msg_type: 'interactive', receive_id: openId });
    await socket.receive({ type: 'stream', messageId, openId, threadId, chunk: 'Ready' });
    const result = { type: MessageType.RESPONSE, messageId, openId, threadId, success: true, output: 'Ready' };
    await socket.receive(result);
    expect(socket.frames('task_result_ack')).toEqual([]);
    await socket.receive({ ...result, threadId: 'unrelated-thread' });
    expect(socket.frames('task_result_ack')).toEqual([]);
    expect(create).toHaveBeenCalledTimes(2);
    await socket.receive(result);
    expect(create.mock.calls[2][0].data).toMatchObject({ receive_id: openId, msg_type: 'text' });
    expect(JSON.parse(create.mock.calls[2][0].data.content).text.match(/Ready/g)).toHaveLength(1);
    expect(socket.frames('task_result_ack')).toMatchObject([{ messageId }]);
    await socket.receive(result);
    expect(create).toHaveBeenCalledTimes(3);
    expect(socket.frames('task_result_ack')).toMatchObject([{ messageId }, { messageId }]);
    expect(socket.frames(MessageType.COMMAND)).toHaveLength(1);
    const next = await chat(socket, 'Check again');
    expect(next.threadId).toBe(threadId);
    expect(next.messageId).not.toBe(messageId);
    await socket.receive({ ...result, messageId: next.messageId, output: 'Next check completed' });
    expect(patch.mock.calls.at(-1)![0].data.content).toContain('Next check completed');
    expect(socket.frames('task_result_ack').at(-1)).toMatchObject({ messageId: next.messageId });
  });
});

describe('cardless chat after a device changes owners', () => {
  const { create, chat, connect, start, changeOwner } = deliveryFixture();
  it('withholds the original result from either recipient after rebinding', async () => {
    await start();
    const socket = await connect();
    create.mockRejectedValueOnce(new Error('Card unavailable'));
    const { messageId } = await chat(socket, 'Original request');
    await changeOwner(openId, 'replacement-owner');
    for (const recipient of [openId, 'replacement-owner']) {
      await socket.receive({ type: MessageType.RESPONSE, messageId, openId: recipient, threadId, success: true, output: 'Original result' });
    }
    await changeOwner('replacement-owner', openId);
    await socket.receive({ type: MessageType.RESPONSE, messageId, openId, threadId, success: true, output: 'Stale result' });
    expect(socket.frames('task_result_ack')).toEqual([]);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe.each([
  { label: 'SDK rejection', code: 230001, id: 'unconfirmed-text' },
  { label: 'missing message ID', code: 0, id: undefined },
])('cardless chat after $label', ({ code, id }) => {
  const { create, chat, connect, start, selectThread, changeOwner, submit } = deliveryFixture();
  let acknowledgments: object[];
  let socket: DeviceSocket, messageId: string;
  beforeAll(async () => {
    await start();
    socket = await connect();
    await selectThread(threadId);
    create.mockRejectedValueOnce(new Error('Card unavailable'));
    messageId = (await chat(socket, 'Check the project')).messageId;
    create.mockResolvedValueOnce({ code, data: { message_id: id } });
    await socket.receive({ type: MessageType.RESPONSE, messageId, openId, threadId, success: true, output: 'Ready' });
    expect(create.mock.calls.at(-1)![0].data).toMatchObject({ msg_type: 'text', receive_id: openId });
    acknowledgments = socket.frames('task_result_ack');
  });
  it('requires a delivery receipt before acknowledging the result', async () => {
    expect(acknowledgments).toEqual([]);
    await selectThread('other-thread');
    create.mockResolvedValueOnce({ code: 0, data: { message_id: 'received-text' } });
    await socket.receive({ type: MessageType.RESPONSE, messageId, openId, threadId, success: true, output: 'Ready' });
    expect(socket.frames('task_result_ack')).toMatchObject([{ messageId }]);
    expect(socket.frames(MessageType.COMMAND)).toHaveLength(1);
    expect((await chat(socket, 'Continue here', 'received-text')).threadId).toBe(threadId);
    expect((await chat(socket, 'Fresh chat')).threadId).toBe('other-thread');
    await changeOwner(openId, 'replacement-owner');
    await changeOwner('replacement-owner', openId);
    await submit('Old reply', 'received-text');
    expect(socket.frames(MessageType.COMMAND)).toHaveLength(3);
  });
});

describe('confirmed fallback text awaiting a durable reply route', () => {
  const f = deliveryFixture();
  it('retries route registration without duplicating the text or command', async () => {
    await f.start();
    const socket = await f.connect();
    await f.selectThread(threadId);
    f.create.mockRejectedValueOnce(new Error('No initial card'));
    const { messageId } = await f.chat(socket, 'Check once');
    f.create.mockResolvedValueOnce({ code: 0, data: { message_id: 'delivered-once' } });
    vi.spyOn(f.server['store'], 'setCardThread').mockRejectedValueOnce(new Error('Transient storage failure'));
    const result = { type: MessageType.RESPONSE, messageId, openId, threadId, success: true, output: 'Ready' };
    await socket.receive(result);
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(socket.frames('task_result_ack')).toEqual([]);
    await socket.receive(result);
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(socket.frames(MessageType.COMMAND)).toHaveLength(1);
    expect(socket.frames('task_result_ack')).toMatchObject([{ messageId }]);
    expect(f.server['store'].getCardThread('delivered-once')).toMatchObject({ deviceId, openId, threadId });
  });
});

describe.each(['closing socket', 'changed selection', 'changed binding'])('ordinary dispatch after %s', reason => {
  const f = deliveryFixture();
  it('retires the unsent processing card and rejects replies to its expired route', async () => {
    await f.start();
    const socket = await f.connect();
    await f.selectThread(threadId);
    const server = f.server;
    const register = server['feishuLongConnHandler']['onStartStreaming']!;
    server['feishuLongConnHandler'].setOnStartStreaming(async (...args) => {
      await register(...args);
      if (reason === 'closing socket') socket.readyState = WebSocket.CLOSING;
      if (reason === 'changed selection') await f.selectThread('another-thread');
      if (reason === 'changed binding') await f.changeOwner(openId, 'replacement-owner');
    });
    f.create.mockResolvedValueOnce({ code: 0, data: { message_id: 'unsent-card' } });
    await f.submit('Private original command');
    expect(socket.frames(MessageType.COMMAND)).toHaveLength(0);
    expect(server['streamingMessages'].size).toBe(0);
    expect(f.patch.mock.calls).toHaveLength(1);
    const [patch] = f.patch.mock.calls[0];
    expect(patch.path.message_id).toBe('unsent-card');
    expect(patch.data.content).toContain('Command was not sent');
    expect(patch.data.content).not.toContain('Private original command');
    expect(server['store'].getCardThread('unsent-card')).toBeUndefined();
    server['feishuLongConnHandler'].setOnStartStreaming(register);
    if (reason === 'changed binding') await f.changeOwner('replacement-owner', openId);
    const next = reason === 'closing socket' ? await f.connect() : socket;
    await f.submit('Stale reply', 'unsent-card');
    expect(next.frames(MessageType.COMMAND)).toHaveLength(0);
    expect((await f.chat(next, 'Retry once')).threadId).toBe(reason === 'changed selection' ? 'another-thread' :
      reason === 'changed binding' ? undefined : threadId);
  });
});

describe('terminal recovery when binding changes during card creation', () => {
  const { create, patch, connect, start, changeOwner } = deliveryFixture();
  it('returns an unsuccessful recovery receipt when the result cannot be finalized', async () => {
    await start();
    const socket = await connect();
    create.mockImplementationOnce(async () => {
      await changeOwner(openId, 'replacement-owner');
      return { code: 0, data: { message_id: 'stale-card' } };
    });
    await socket.receive({ type: 'task_resume', messageId: 'recover-task', openId, threadId,
      taskResume: { recoveryId: 'attempt-1', threadName: 'Project', backend: 'claude', cwd: 'project',
        preview: 'Check the project', state: 'failed', error: 'Project validation failed' } });
    expect(patch).not.toHaveBeenCalled();
    expect(socket.frames('task_resume_ack')).toMatchObject([{ messageId: 'recover-task', success: false }]);
    expect(socket.frames('task_result_ack')).toEqual([]);
  });
});

describe('ordinary chat recovery after final card rejection', () => {
  const { create, patch, chat, connect, start } = deliveryFixture();
  it('delivers the failure after reconnect and accepts a reply without replaying the original command', async () => {
    await start();
    const first = await connect();
    const { messageId } = await chat(first, 'Check the project');
    const error = 'Project validation failed.';
    patch.mockRejectedValueOnce(new Error('Final patch unavailable'));
    const response = { type: MessageType.RESPONSE, messageId, openId, threadId, success: false, error };
    await first.receive(response);
    expect(patch).toHaveBeenCalledOnce();
    expect(patch.mock.calls[0][0].data.content).toContain(error);
    expect(first.frames('task_result_ack')).toEqual([]);
    first.close();

    const replacement = await connect();
    create.mockResolvedValueOnce({ code: 0, data: { message_id: 'recovered-card' } });
    const recoveryId = 'retry-1';
    let acceptPatch!: (result: { code: number }) => void;
    patch.mockReturnValueOnce(new Promise(resolve => { acceptPatch = resolve; }));
    const recovering = replacement.receive({ type: 'task_resume', messageId, openId, threadId,
      taskResume: { recoveryId, threadName: 'Project', backend: 'claude', cwd: 'project',
        preview: 'Check the project', state: 'failed', error } });
    try {
      await vi.waitFor(() => expect(patch.mock.calls.at(-1)![0]).toMatchObject({
        path: { message_id: 'recovered-card' }, data: { content: expect.stringContaining(error) },
      }));
      expect(create.mock.calls.at(-1)![0].data).toMatchObject({ receive_id: openId, msg_type: 'interactive' });
      expect(replacement.frames('task_resume_ack')).toEqual([]);
    } finally {
      acceptPatch({ code: 0 });
      await recovering;
    }
    expect(replacement.frames('task_resume_ack')).toMatchObject([{ messageId, recoveryId, state: 'failed', success: true }]);
    const patchCount = patch.mock.calls.length;
    await replacement.receive(response);
    expect(replacement.frames('task_result_ack')).toMatchObject([{ messageId }]);
    expect(patch).toHaveBeenCalledTimes(patchCount);
    expect(first.frames(MessageType.COMMAND)).toHaveLength(1);
    expect(replacement.frames(MessageType.COMMAND)).toEqual([]);

    create.mockResolvedValueOnce({ code: 0, data: { message_id: 'follow-up-card' } });
    const next = await chat(replacement, 'What can I try next?', 'recovered-card');
    expect(next.threadId).toBe(threadId);
    expect(next.messageId).not.toBe(messageId);
    const output = 'Check the project configuration.';
    await replacement.receive({ type: MessageType.RESPONSE, messageId: next.messageId, openId, threadId, success: true, output });
    expect(patch.mock.calls.at(-1)![0]).toMatchObject({
      path: { message_id: 'follow-up-card' }, data: { content: expect.stringContaining(output) },
    });
    expect(replacement.frames('task_result_ack').map(frame => frame.messageId)).toEqual([messageId, next.messageId]);
  });
});
