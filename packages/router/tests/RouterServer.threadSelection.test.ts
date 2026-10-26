import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { createServer as createHttpServer, type Server as HttpServer } from 'http';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { WebSocket } from 'ws';
import { RouterServer } from '../src/server';
import { FeishuLongConnHandler } from '../src/feishu/FeishuLongConnHandler';
import { JsonStore } from '../src/storage/JsonStore';
import { MessageType } from '../src/types';

class SyntheticSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  readonly sent: any[] = [];

  send(data: string): void { this.sent.push(JSON.parse(data)); }
  close(): void { this.readyState = WebSocket.CLOSED; this.emit('close'); }
  terminate(): void { this.readyState = WebSocket.CLOSED; this.emit('close'); }
  async receive(message: object): Promise<void> {
    const listener = this.listeners('message')[0] as (data: Buffer) => Promise<void>;
    await listener(Buffer.from(JSON.stringify(message)));
  }
}

describe('Router durable selected-thread integration', () => {
  let home: string;
  let previousHome: string | undefined;
  let storePath: string;
  let sequence: number;
  const stores: JsonStore[] = [];
  const servers: RouterServer[] = [];
  const sockets: SyntheticSocket[] = [];
  const httpServers: HttpServer[] = [];

  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(process.cwd(), '.router-selection-integration-')));
    previousHome = process.env.HOME;
    process.env.HOME = home;
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    storePath = path.join(home, 'bindings.json');
    sequence = 0;
  });

  afterEach(async () => {
    for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.close();
    for (const server of servers) (server as any).wss?.close();
    for (const server of httpServers) server.close();
    for (const store of stores) await store.flush().catch(() => undefined);
    vi.restoreAllMocks();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await fs.rm(home, { recursive: true, force: true });
  });

  async function createRouter() {
    const store = new JsonStore(storePath, 0);
    stores.push(store);
    await store.initialize();
    const config = {
      getConfigPath: () => path.join(home, 'router.json'),
      get: (section: string, key?: string) => section === 'files' ? { enabled: false }
        : section === 'tips' ? { enabled: false }
        : section === 'websocket' && key === 'heartbeatInterval' ? 1000
        : section === 'feishu' ? 'synthetic' : undefined,
    } as any;
    const server = new RouterServer(config, store);
    servers.push(server);
    const feishu = (server as any).feishuLongConnHandler;
    feishu.onUserActivity = async () => undefined;
    vi.spyOn(feishu, 'setOnStartStreaming');
    vi.spyOn(feishu, 'sendStreamingStart').mockImplementation(async () => `card-${++sequence}`);
    vi.spyOn(feishu, 'sendMessage').mockResolvedValue(true);
    vi.spyOn(feishu, 'finalizeStreamingMessage').mockResolvedValue(true);
    vi.spyOn(feishu as any, 'replyToMessage').mockResolvedValue(undefined);
    return { server, store, feishu, bindings: (server as any).bindingManager };
  }

  async function startLegacy(server: RouterServer, deviceId = 'device-a'): Promise<SyntheticSocket> {
    const http = createHttpServer();
    httpServers.push(http);
    (server as any).setupWebSocket(http);
    const socket = new SyntheticSocket();
    sockets.push(socket);
    (server as any).wss.emit('connection', socket, { socket: { remoteAddress: 'synthetic' } });
    await socket.receive({ type: MessageType.BINDING_REQUEST, data: { deviceId } });
    return socket;
  }

  async function select(context: any, cardId: string, deviceId: string, threadId: string, openId = 'user-a') {
    (context.server as any).cardThreadMap.set(cardId, { threadId, deviceId, openId, epoch: 0, expiresAt: Date.now() + 60_000 });
    await context.feishu.onCardSwitchThread(openId, cardId, threadId, threadId);
  }

  async function text(context: any, content: string, parentId?: string, openId = 'user-a') {
    await context.feishu.handleMessageEvent({
      sender: { sender_id: { open_id: openId } },
      message: { message_type: 'text', message_id: `incoming-${++sequence}`, content: JSON.stringify({ text: content }), parent_id: parentId },
    });
  }

  function commands(socket: SyntheticSocket): any[] {
    return socket.sent.filter(message => message.type === MessageType.COMMAND);
  }

  it('routes through a restored selection after fresh storage and legacy registration', async () => {
    const first = await createRouter();
    await first.bindings.bindUser('user-a', 'device-a', 'A');
    await select(first, 'source-card', 'device-a', 'thread-a');
    await first.store.flush();

    const restored = await createRouter();
    const socket = await startLegacy(restored.server);
    expect(socket.sent[0].data.capabilities).toBeUndefined();
    await text(restored, 'continue');
    expect(commands(socket)).toHaveLength(1);
    expect(commands(socket)[0]).toMatchObject({ threadId: 'thread-a', content: 'continue' });
    await text(restored, '/clear');
    expect(commands(socket)[1]).toMatchObject({ threadId: 'thread-a', content: '/clear' });

    socket.close();
    const reconnected = await startLegacy(restored.server);
    await text(restored, 'after-reconnect');
    expect(commands(reconnected)[0]).toMatchObject({ threadId: 'thread-a', content: 'after-reconnect' });
    expect(commands(reconnected)[0].content).not.toBe('/clear');
  });

  it('isolates users and restores each device on A-B-A switches', async () => {
    const context = await createRouter();
    await context.bindings.bindUser('user-a', 'device-a', 'A');
    await context.bindings.bindUser('user-a', 'device-b', 'B');
    await select(context, 'card-a', 'device-a', 'thread-a');
    await context.bindings.switchActiveDevice('user-a', 'device-b');
    await select(context, 'card-b', 'device-b', 'thread-b');
    const socketB = await startLegacy(context.server, 'device-b');

    await text(context, 'on-b');
    const socketA = await startLegacy(context.server, 'device-a');
    await context.bindings.switchActiveDevice('user-a', 'device-a');
    context.feishu.onDeviceSwitchIntent('user-a', 'device-a');
    context.feishu.onDeviceSwitch('user-a', 'device-b', 'device-a');
    await text(context, 'back-on-a');
    expect(commands(socketB).map(command => command.threadId)).toEqual(['thread-b']);
    expect(commands(socketA).map(command => command.threadId)).toEqual(['thread-a']);
    expect((await context.bindings.getThreadSelection('user-a', 'device-b')).threadId).toBe('thread-b');
    await context.bindings.bindUser('user-b', 'device-c', 'C');
    await select(context, 'card-c', 'device-c', 'thread-c', 'user-b');
    expect((await context.bindings.getThreadSelection('user-b', 'device-c')).threadId).toBe('thread-c');
  });

  it('keeps known replies independent and rejects unknown parents without sending', async () => {
    const context = await createRouter();
    await context.bindings.bindUser('user-a', 'device-a', 'A');
    await select(context, 'select-card', 'device-a', 'selected-thread');
    const socket = await startLegacy(context.server);
    const start = (context.feishu as any).onStartStreaming;
    start('other-command', 'user-a', 'other-card', 'device-a', 'other-thread');

    await text(context, 'reply-only', 'other-card');
    await text(context, 'top-level');
    expect(commands(socket).map(command => command.threadId)).toEqual(['other-thread', 'selected-thread']);
    expect((await context.bindings.getThreadSelection('user-a', 'device-a')).threadId).toBe('selected-thread');

    await text(context, 'must-not-send', 'expired-card');
    expect(commands(socket)).toHaveLength(2);
    expect(context.feishu.replyToMessage).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('expired'));
  });

  it('resets only on exact current missing-thread confirmation and never replays', async () => {
    const context = await createRouter();
    await context.bindings.bindUser('user-a', 'device-a', 'A');
    await select(context, 'select-card', 'device-a', 'selected-thread');
    const socket = await startLegacy(context.server);
    const start = (context.feishu as any).onStartStreaming;
    start('missing-command', 'user-a', 'missing-card', 'device-a', 'selected-thread');
    await socket.receive({ type: MessageType.RESPONSE, messageId: 'missing-command', openId: 'user-a',
      success: false, error: 'Thread not found: selected-thread' });

    expect((await context.bindings.getThreadSelection('user-a', 'device-a')).status).toBe('none');
    expect(context.feishu.sendMessage).toHaveBeenCalledWith('user-a', expect.stringContaining('Future messages will use default'));
    expect(commands(socket)).toHaveLength(0);
    await text(context, 'after-delete');
    expect(commands(socket)).toHaveLength(1);
    expect(commands(socket)[0].threadId).toBeUndefined();
  });

  it('ignores stale catalogs and missing lists before a current complete deletion', async () => {
    const context = await createRouter();
    await context.bindings.bindUser('user-a', 'device-a', 'A');
    await select(context, 'select-card', 'device-a', 'selected-thread');
    const socket = await startLegacy(context.server);
    const start = (context.feishu as any).onStartStreaming;
    start('stale-command', 'user-a', 'stale-card', 'device-a', 'selected-thread');
    (context.server as any).selections.beginIntent('user-a', 'device-a');
    await socket.receive({ type: MessageType.RESPONSE, messageId: 'stale-command', openId: 'user-a', success: true,
      threads: [{ id: 'default-id', name: 'default', status: 'idle' }] });
    expect((await context.bindings.getThreadSelection('user-a', 'device-a')).threadId).toBe('selected-thread');

    start('no-list-command', 'user-a', 'no-list-card', 'device-a', 'selected-thread');
    await socket.receive({ type: MessageType.RESPONSE, messageId: 'no-list-command', openId: 'user-a', success: true });
    expect((await context.bindings.getThreadSelection('user-a', 'device-a')).threadId).toBe('selected-thread');

    start('incomplete-command', 'user-a', 'incomplete-card', 'device-a', 'selected-thread');
    await socket.receive({ type: MessageType.RESPONSE, messageId: 'incomplete-command', openId: 'user-a', success: true, threads: [] });
    expect(context.bindings.getThreadSelection('user-a', 'device-a')).toEqual({ status: 'valid', threadId: 'selected-thread' });
    expect(context.feishu.sendMessage).not.toHaveBeenCalled();

    start('deleted-command', 'user-a', 'deleted-card', 'device-a', 'selected-thread');
    const current = (context.server as any).selections.capture('user-a', 'device-a');
    (context.server as any).streamingMessages.get('deleted-command').selectionFence = current;
    await socket.receive({ type: MessageType.RESPONSE, messageId: 'deleted-command', openId: 'user-a', success: true,
      threads: [{ id: 'default-id', name: 'default', status: 'idle' }] });
    expect((await context.bindings.getThreadSelection('user-a', 'device-a')).status).toBe('none');
    expect(context.feishu.sendMessage).toHaveBeenCalledWith('user-a', expect.stringContaining('Future messages will use default'));
  });

  it('rejects a command superseded during delayed card creation before dispatch', async () => {
    const context = await createRouter();
    await context.bindings.bindUser('user-a', 'device-a', 'A');
    await select(context, 'select-card', 'device-a', 'selected-thread');
    const socket = await startLegacy(context.server);
    let release!: (card: string) => void;
    context.feishu.sendStreamingStart.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
    const pending = text(context, 'slow-card');
    await vi.waitFor(() => expect(context.feishu.sendStreamingStart).toHaveBeenCalledOnce());
    (context.server as any).selections.beginIntent('user-a', 'device-a');
    release('slow-card');
    await pending;
    expect(commands(socket)).toHaveLength(0);
    expect((context.server as any).streamingMessages.size).toBe(0);
    expect(context.feishu.replyToMessage).toHaveBeenCalled();
    expect((await context.bindings.getThreadSelection('user-a', 'device-a')).threadId).toBe('selected-thread');
  });

  it('keeps auth usable but blocks default routing for a corrupt optional preference', async () => {
    const first = await createRouter();
    await first.bindings.bindUser('user-a', 'device-a', 'A');
    await first.store.flush();
    const raw = JSON.parse(await fs.readFile(storePath, 'utf8'));
    raw.userBindings['user-a'].devices[0].selectedThreadId = { invalid: true };
    await fs.writeFile(storePath, JSON.stringify(raw), { mode: 0o600 });

    const restored = await createRouter();
    expect((await restored.bindings.getDeviceBinding('device-a'))?.openId).toBe('user-a');
    const socket = await startLegacy(restored.server);
    await text(restored, 'must-not-default');
    expect(commands(socket)).toHaveLength(0);
    expect(restored.feishu.replyToMessage).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('Select a thread again'));
    expect(JSON.parse(await fs.readFile(storePath, 'utf8')).userBindings['user-a'].devices[0].selectedThreadId).toEqual({ invalid: true });

    await text(restored, '/thread list');
    const statusRequest = socket.sent.find(message => message.type === 'status');
    expect(statusRequest).toBeDefined();
    expect(commands(socket)).toHaveLength(0);
    await socket.receive({ type: 'status', messageId: statusRequest.messageId,
      status: { threads: [{ id: 'default-id', name: 'default', status: 'idle' },
        { id: 'recovered-thread', name: 'Recovered', status: 'idle' }] } });
    const refreshedCard = restored.feishu.finalizeStreamingMessage.mock.calls.at(-1)[0];
    const recovered = await restored.feishu.handleCardAction({ operator: { open_id: 'user-a' },
      context: { open_message_id: refreshedCard },
      action: { value: { action: 'switch_thread', threadId: 'recovered-thread', threadName: 'Recovered' } } });
    expect(recovered.toast.type).toBe('success');
    await text(restored, 'after-recovery');
    expect(commands(socket)).toHaveLength(1);
    expect(commands(socket)[0].threadId).toBe('recovered-thread');
  });

  it('refreshes thread controls for a healthy selection through the legacy inventory protocol', async () => {
    const context = await createRouter();
    await context.bindings.bindUser('user-a', 'device-a', 'A');
    await select(context, 'previous-selection', 'device-a', 'removed-thread');
    const socket = await startLegacy(context.server);
    await text(context, '/thread list');
    const request = socket.sent.find(message => message.type === 'status');
    expect(request).toBeDefined();
    expect(commands(socket)).toHaveLength(0);
    await socket.receive({ type: 'status', messageId: request.messageId,
      status: { threads: [{ id: 'default-id', name: 'default', status: 'idle' }] } });
    expect(context.feishu.finalizeStreamingMessage).toHaveBeenCalledOnce();
    expect(context.bindings.getThreadSelection('user-a', 'device-a')).toEqual({ status: 'none' });
    expect(context.feishu.sendMessage).toHaveBeenCalledWith('user-a', expect.stringContaining('Future messages will use default'));
    await text(context, 'future-work');
    expect(commands(socket)).toHaveLength(1);
    expect(commands(socket)[0].threadId).toBeUndefined();
  });

  it('ignores inventory replies from another device without consuming the original request', async () => {
    const context = await createRouter();
    await context.bindings.bindUser('user-a', 'device-a', 'A');
    await context.bindings.bindUser('user-b', 'device-b', 'B');
    const socketA = await startLegacy(context.server);
    const socketB = await startLegacy(context.server, 'device-b');
    await context.feishu.onRecoverThreads('user-a', 'device-a', 'recovery-source');
    const request = socketA.sent.find(message => message.type === 'status');
    const response = { type: 'status', messageId: request.messageId,
      status: { threads: [{ id: 'default-id', name: 'default', status: 'idle' }] } };
    await socketB.receive(response);
    expect(context.feishu.finalizeStreamingMessage).not.toHaveBeenCalled();
    await socketA.receive(response);
    expect(context.feishu.finalizeStreamingMessage).toHaveBeenCalledOnce();
  });

  it('does not let a late New Thread response override a later explicit selection', async () => {
    const context = await createRouter();
    await context.bindings.bindUser('user-a', 'device-a', 'A');
    const socket = await startLegacy(context.server);
    const intent = (context.server as any).selections.beginIntent('user-a', 'device-a');
    const start = (context.feishu as any).onStartStreaming;
    start('late-new-command', 'user-a', 'late-new-card', 'device-a', undefined, true, undefined, undefined, intent);
    await select(context, 'explicit-card', 'device-a', 'explicit-selection');
    await socket.receive({ type: MessageType.RESPONSE, messageId: 'late-new-command', openId: 'user-a', success: true,
      threadId: 'created-thread', threads: [{ id: 'created-thread', name: 'Created', status: 'idle' },
        { id: 'explicit-selection', name: 'Explicit', status: 'idle' }] });
    expect((await context.bindings.getThreadSelection('user-a', 'device-a')).threadId).toBe('explicit-selection');
  });

  it('rejects stale foreign-device card controls without changing the current selection', async () => {
    const context = await createRouter();
    await context.bindings.bindUser('user-a', 'device-a', 'A');
    await context.bindings.bindUser('user-a', 'device-b', 'B');
    await select(context, 'old-a-card', 'device-a', 'thread-a');
    await context.bindings.switchActiveDevice('user-a', 'device-b');
    await select(context, 'current-b-card', 'device-b', 'thread-b');
    context.feishu.onDeviceSwitchIntent('user-a', 'device-b');
    context.feishu.onDeviceSwitch('user-a', 'device-a', 'device-b');

    const result = await context.feishu.handleCardAction({ operator: { open_id: 'user-a' },
      context: { open_message_id: 'old-a-card' }, action: { value: { action: 'switch_thread', threadId: 'thread-a' } } });
    expect(result.toast.type).toBe('error');
    expect((await context.bindings.getThreadSelection('user-a', 'device-b')).threadId).toBe('thread-b');
  });

  it('fences New Thread completion while a device switch waits for storage', async () => {
    const context = await createRouter();
    await context.bindings.bindUser('user-a', 'device-a', 'A');
    await context.bindings.bindUser('user-a', 'device-b', 'B');
    const pending = (context.server as any).selections.beginIntent('user-a', 'device-a');
    let release!: (value: boolean) => void;
    const switching = vi.spyOn((context.feishu as any).bindingManager, 'switchActiveDevice')
      .mockImplementationOnce(() => new Promise<boolean>(resolve => { release = resolve; }));
    const switchingMessage = context.feishu.handleDeviceSwitch('user-a', 'switch-message', 'device-b');
    await vi.waitFor(() => expect(switching).toHaveBeenCalledOnce());
    expect(await (context.server as any).selections.completeNew(pending, 'created-thread')).toBe('stale');
    release(true);
    await switchingMessage;
  });

  it('expires old card controls after the same user unbinds and rebinds the device', async () => {
    const context = await createRouter();
    await context.bindings.bindUser('user-a', 'device-a', 'A');
    await select(context, 'source-card', 'device-a', 'old-thread');
    const lateFence = (context.server as any).selections.capture('user-a', 'device-a');
    await context.feishu.onRevokeDevice('device-a');
    await context.bindings.unbindDevice('user-a', 'device-a');
    await context.bindings.bindUser('user-a', 'device-a', 'A');

    const result = await context.feishu.handleCardAction({ operator: { open_id: 'user-a' },
      context: { open_message_id: 'source-card' }, action: { value: { action: 'switch_thread', threadId: 'old-thread' } } });
    expect(result.toast.type).toBe('error');
    expect((await context.bindings.getThreadSelection('user-a', 'device-a')).status).toBe('none');

    const start = (context.feishu as any).onStartStreaming;
    start('late-card-command', 'user-a', 'late-card', 'device-a', 'old-thread', false, undefined, undefined, lateFence);
    expect(await (context.server as any).resolveCardThread('late-card', 'user-a')).toBeUndefined();
  });

  it('reserves click order before asynchronous provenance validation', async () => {
    const context = await createRouter();
    await context.bindings.bindUser('user-a', 'device-a', 'A');
    for (const cardId of ['first-card', 'second-card']) {
      (context.server as any).cardThreadMap.set(cardId, { threadId: 'source', deviceId: 'device-a', openId: 'user-a', epoch: 0, expiresAt: Date.now() + 60_000 });
    }
    let release!: () => void;
    const original = (context.server as any).requireCurrentCardDevice.bind(context.server);
    const validation = vi.spyOn(context.server as any, 'requireCurrentCardDevice')
      .mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(original('first-card', 'user-a')); }));
    const first = context.feishu.onCardSwitchThread('user-a', 'first-card', 'first-selection', 'First');
    await vi.waitFor(() => expect(validation).toHaveBeenCalledOnce());
    await context.feishu.onCardSwitchThread('user-a', 'second-card', 'second-selection', 'Second');
    release();
    await expect(first).rejects.toThrow('superseded');
    expect((await context.bindings.getThreadSelection('user-a', 'device-a')).threadId).toBe('second-selection');
  });

  it('fences text dispatch when a device is unbound and rebound during card creation', async () => {
    const context = await createRouter();
    await context.bindings.bindUser('user-a', 'device-a', 'A');
    await select(context, 'select-card', 'device-a', 'selected-thread');
    const socket = await startLegacy(context.server);
    let release!: (card: string) => void;
    context.feishu.sendStreamingStart.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
    const pending = text(context, 'must-not-revive');
    await vi.waitFor(() => expect(context.feishu.sendStreamingStart).toHaveBeenCalledOnce());
    await context.feishu.onRevokeDevice('device-a');
    await context.bindings.unbindDevice('user-a', 'device-a');
    await context.bindings.bindUser('user-a', 'device-a', 'A');
    release('late-card');
    await pending;
    expect(commands(socket)).toHaveLength(0);
  });

  it.each([
    { success: true, selectionChanged: false },
    { success: false, selectionChanged: false },
    { success: true, selectionChanged: true },
    { success: false, selectionChanged: true },
  ])('registers delivered continuation controls for success=$success after selectionChanged=$selectionChanged', async ({ success, selectionChanged }) => {
    const context = await createRouter();
    await context.bindings.bindUser('user-a', 'device-a', 'A');
    await context.bindings.bindUser('user-a', 'device-b', 'B');
    const socket = await startLegacy(context.server);
    const feishu = context.feishu;
    feishu.client = { im: { message: {
      create: vi.fn().mockImplementation(async () => ({ data: { message_id: `continuation-${sequence++}` } })),
      patch: vi.fn().mockResolvedValue({}),
      reply: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    } } };
    feishu.finalizeStreamingMessage.mockImplementation(FeishuLongConnHandler.prototype.finalizeStreamingMessage);
    const start = feishu.onStartStreaming;
    start('chunked-command', 'user-a', 'root-card', 'device-a', 'default-id');
    const stream = (context.server as any).streamingMessages.get('chunked-command');
    stream.elements = Array.from({ length: 350 }, (_, index) => ({ tag: 'markdown', content: `Body ${index}` }));
    stream.threads = [{ id: 'default-id', name: 'default', status: 'idle' },
      { id: 'other-thread', name: 'Other', status: 'idle' }];
    if (selectionChanged) await select(context, 'later-selection-card', 'device-a', 'selected-elsewhere');
    await (context.server as any).finalizeStreamingMessage('chunked-command', success, 'done', success ? undefined : 'synthetic failure');

    expect(feishu.client.im.message.create).toHaveBeenCalledTimes(2);
    const tailCard = (await feishu.client.im.message.create.mock.results.at(-1).value).data.message_id;
    const tailContent = JSON.parse(feishu.client.im.message.create.mock.calls.at(-1)[0].data.content);
    expect(JSON.stringify(tailContent)).toContain('switch_thread');
    expect(JSON.stringify(tailContent)).toContain('new_thread');

    const switched = await feishu.handleCardAction({ operator: { open_id: 'user-a' },
      context: { open_message_id: tailCard }, action: { value: { action: 'switch_thread', threadId: 'other-thread', threadName: 'Other' } } });
    expect(switched.toast.type).toBe('success');
    expect((await context.bindings.getThreadSelection('user-a', 'device-a')).threadId).toBe('other-thread');

    await feishu.handleCardAction({ operator: { open_id: 'user-a' },
      context: { open_message_id: tailCard }, action: { value: { action: 'new_thread' } } });
    expect(commands(socket).some(command => command.content === '/thread new')).toBe(true);
    await text(context, 'reply-on-continuation', tailCard);
    expect(commands(socket).at(-1).threadId).toBe('default-id');

    await context.bindings.switchActiveDevice('user-a', 'device-b');
    context.feishu.onDeviceSwitchIntent('user-a', 'device-b');
    context.feishu.onDeviceSwitch('user-a', 'device-a', 'device-b');
    const foreign = await feishu.handleCardAction({ operator: { open_id: 'user-a' },
      context: { open_message_id: tailCard }, action: { value: { action: 'switch_thread', threadId: 'other-thread' } } });
    expect(foreign.toast.type).toBe('error');

    await context.feishu.onRevokeDevice('device-a');
    await context.bindings.unbindDevice('user-a', 'device-a');
    await context.bindings.bindUser('user-a', 'device-a', 'A');
    await context.bindings.switchActiveDevice('user-a', 'device-a');
    const rebound = await feishu.handleCardAction({ operator: { open_id: 'user-a' },
      context: { open_message_id: tailCard }, action: { value: { action: 'switch_thread', threadId: 'other-thread' } } });
    expect(rebound.toast.type).toBe('error');
    await text(context, 'must-not-route', tailCard);
    expect(context.feishu.replyToMessage).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('expired'));
  });

  it('adopts New Thread selection only for a valid catalog', async () => {
    const context = await createRouter();
    await context.bindings.bindUser('user-a', 'device-a', 'A');
    const socket = await startLegacy(context.server);
    const intent = (context.server as any).selections.beginIntent('user-a', 'device-a');
    (context.feishu as any).onStartStreaming('valid-new-command', 'user-a', 'valid-new-card', 'device-a', undefined, true, undefined, undefined, intent);
    await socket.receive({ type: MessageType.RESPONSE, messageId: 'valid-new-command', openId: 'user-a', success: true,
      threadId: 'created-thread', threads: [{ id: 'default-id', name: 'default', status: 'idle' },
        { id: 'created-thread', name: 'Created', status: 'idle' }] });
    expect((await context.bindings.getThreadSelection('user-a', 'device-a')).threadId).toBe('created-thread');
  });

  it.each([
    ['missing default', [{ id: 'created-thread', name: 'Created', status: 'idle' }]],
    ['duplicate IDs', [{ id: 'created-thread', name: 'default', status: 'idle' }, { id: 'created-thread', name: 'Other', status: 'idle' }]],
    ['bad status', [{ id: 'default-id', name: 'default', status: 'idle' }, { id: 'created-thread', name: 'Created', status: 'unknown' }]],
    ['oversized', Array.from({ length: 101 }, (_, index) => ({ id: index ? `thread-${index}` : 'default-id', name: index ? `Thread ${index}` : 'default', status: 'idle' }))],
  ])('rejects New Thread selection for %s catalogs without clearing the previous selection', async (_label, threads) => {
    const context = await createRouter();
    await context.bindings.bindUser('user-a', 'device-a', 'A');
    await select(context, 'select-card', 'device-a', 'old-selection');
    const socket = await startLegacy(context.server);
    const intent = (context.server as any).selections.beginIntent('user-a', 'device-a');
    (context.feishu as any).onStartStreaming('invalid-new-command', 'user-a', 'invalid-new-card', 'device-a', undefined, true, undefined, undefined, intent);
    if (_label === 'oversized') (threads as any[]).push({ id: 'created-thread', name: 'Created', status: 'idle' });
    await socket.receive({ type: MessageType.RESPONSE, messageId: 'invalid-new-command', openId: 'user-a', success: true,
      threadId: 'created-thread', threads });
    expect((await context.bindings.getThreadSelection('user-a', 'device-a')).threadId).toBe('old-selection');
    expect(context.feishu.sendMessage).toHaveBeenCalledWith('user-a', expect.stringContaining('selection could not be confirmed'));
    expect(commands(socket)).toHaveLength(0);
  });

  it('does not publish selection success after a durable uncertainty', async () => {
    const context = await createRouter();
    await context.bindings.bindUser('user-a', 'device-a', 'A');
    await select(context, 'select-card', 'device-a', 'old-selection');
    (context.store as any).uncertainty = new Error('Synthetic replacement uncertainty');
    const result = await context.feishu.handleCardAction({ operator: { open_id: 'user-a' },
      context: { open_message_id: 'select-card' }, action: { value: { action: 'switch_thread', threadId: 'new-selection' } } });
    expect(result.toast.type).toBe('error');
    const raw = JSON.parse(await fs.readFile(storePath, 'utf8'));
    expect(raw.userBindings['user-a'].devices[0].selectedThreadId).toBe('old-selection');
  });

  it('keeps New Thread creation successful when only selection persistence fails', async () => {
    const context = await createRouter();
    await context.bindings.bindUser('user-a', 'device-a', 'A');
    await select(context, 'select-card', 'device-a', 'old-selection');
    const socket = await startLegacy(context.server);
    const intent = (context.server as any).selections.beginIntent('user-a', 'device-a');
    const start = (context.feishu as any).onStartStreaming;
    start('new-command', 'user-a', 'new-card', 'device-a', undefined, true, undefined, undefined, intent);
    vi.spyOn(context.store, 'setDeviceThreadSelection').mockRejectedValueOnce(new Error('Synthetic write failure'));
    await socket.receive({ type: MessageType.RESPONSE, messageId: 'new-command', openId: 'user-a', success: true,
      threadId: 'created-thread', threads: [{ id: 'default-id', name: 'default', status: 'idle' },
        { id: 'created-thread', name: 'Created', status: 'idle' }, { id: 'old-selection', name: 'Existing', status: 'idle' }] });

    expect(context.feishu.finalizeStreamingMessage).toHaveBeenCalled();
    expect(context.feishu.sendMessage).toHaveBeenCalledWith('user-a', expect.stringContaining('Thread created'));
    expect((await context.bindings.getThreadSelection('user-a', 'device-a')).threadId).toBe('old-selection');
    expect(commands(socket)).toHaveLength(0);
  });
});
