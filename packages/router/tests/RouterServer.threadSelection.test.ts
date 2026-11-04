import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { generateKeyPairSync } from 'crypto';
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
    for (const server of servers) {
      for (const pending of (server as any).threadInventoryRequests.values()) clearTimeout(pending.timer);
      (server as any).threadInventoryRequests.clear();
    }
    for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.close();
    for (const server of servers) (server as any).wss?.close();
    for (const server of httpServers) server.close();
    for (const store of stores) await store.flush().catch(() => undefined);
    stores.length = servers.length = sockets.length = httpServers.length = 0;
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
    await register(context, cardId, threadId, deviceId, openId);
    await (context.server as any).selections.select(openId, deviceId, threadId, threadId);
  }

  async function register(context: any, cardId: string, threadId = 'default-id', deviceId = 'device-a', openId = 'user-a',
    expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000) {
    await (context.server as any).registerCardThread(cardId, { threadId, deviceId, openId,
      epoch: context.store.getCardThreadEpoch(openId, deviceId), expiresAt });
  }

  async function answerSelection(context: any, socket: SyntheticSocket, threads: any[]) {
    let request: any;
    await vi.waitFor(() => {
      request = socket.sent.find(message => message.type === 'status'
        && (context.server as any).threadInventoryRequests.get(message.messageId)?.selection);
      expect(request).toBeDefined();
    });
    await socket.receive({ type: 'status', messageId: request.messageId, status: { threads } });
  }

  async function click(context: any, socket: SyntheticSocket, cardId: string, threadId: string,
    threads = [{ id: 'default-id', name: 'default', status: 'idle' }, { id: threadId, name: 'Verified name', status: 'idle' }]) {
    const pending = context.feishu.handleCardAction({ operator: { open_id: 'user-a' },
      context: { open_message_id: cardId }, action: { value: { action: 'switch_thread', threadId, threadName: 'Untrusted label' } } });
    await answerSelection(context, socket, threads);
    return pending;
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

  it.each(['provenance', 'selection'] as const)(
    'keeps a card switch valid when unrelated routing metadata is saved during %s validation', async stage => {
      const context = await createRouter();
      await context.bindings.bindUser('user-a', 'device-a', 'A');
      await register(context, 'original-card');
      const socket = await startLegacy(context.server);
      let release!: () => void;
      let entered!: () => void;
      const blocked = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      const method = stage === 'provenance' ? 'getDeviceBinding' : 'selectThread';
      const original = context.bindings[method].bind(context.bindings);
      vi.spyOn(context.bindings, method).mockImplementationOnce(async (...args: unknown[]) => {
        entered();
        await blocked;
        return original(...args);
      });
      const pending = click(context, socket, 'original-card', 'target');
      try {
        await started;
        await register(context, 'unrelated-card', 'another-thread');
      } finally {
        release();
      }
      expect((await pending).toast.type).toBe('success');
      expect(context.store.getDeviceThreadSelection('user-a', 'device-a')).toMatchObject({ threadId: 'target' });
      await text(context, 'continue-after-concurrent-card');
      expect(commands(socket).at(-1)).toMatchObject({ threadId: 'target' });
    },
  );

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
    await context.feishu.onDeviceSwitch?.('user-a', 'device-b', 'device-a');
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
    await start('other-command', 'user-a', 'other-card', 'device-a', 'other-thread');

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
    await start('missing-command', 'user-a', 'missing-card', 'device-a', 'selected-thread');
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
    await start('stale-command', 'user-a', 'stale-card', 'device-a', 'selected-thread');
    (context.server as any).selections.beginIntent('user-a', 'device-a');
    await socket.receive({ type: MessageType.RESPONSE, messageId: 'stale-command', openId: 'user-a', success: true,
      threads: [{ id: 'default-id', name: 'default', status: 'idle' }] });
    expect((await context.bindings.getThreadSelection('user-a', 'device-a')).threadId).toBe('selected-thread');

    await start('no-list-command', 'user-a', 'no-list-card', 'device-a', 'selected-thread');
    await socket.receive({ type: MessageType.RESPONSE, messageId: 'no-list-command', openId: 'user-a', success: true });
    expect((await context.bindings.getThreadSelection('user-a', 'device-a')).threadId).toBe('selected-thread');

    await start('incomplete-command', 'user-a', 'incomplete-card', 'device-a', 'selected-thread');
    await socket.receive({ type: MessageType.RESPONSE, messageId: 'incomplete-command', openId: 'user-a', success: true, threads: [] });
    expect(context.bindings.getThreadSelection('user-a', 'device-a')).toEqual({ status: 'valid', threadId: 'selected-thread' });
    expect(context.feishu.sendMessage).not.toHaveBeenCalled();

    await start('deleted-command', 'user-a', 'deleted-card', 'device-a', 'selected-thread');
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
    const recovered = await click(restored, socket, refreshedCard, 'recovered-thread');
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
    await start('late-new-command', 'user-a', 'late-new-card', 'device-a', undefined, true, undefined, undefined, intent);
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
    await context.feishu.onDeviceSwitch?.('user-a', 'device-a', 'device-b');

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
    await start('late-card-command', 'user-a', 'late-card', 'device-a', 'old-thread', false, undefined, undefined, lateFence);
    expect(await (context.server as any).resolveCardThread('late-card', 'user-a')).toBeUndefined();
  });

  it('reserves click order before asynchronous provenance validation', async () => {
    const context = await createRouter();
    await context.bindings.bindUser('user-a', 'device-a', 'A');
    for (const cardId of ['first-card', 'second-card']) {
      await register(context, cardId, 'source');
    }
    const socket = await startLegacy(context.server);
    let release!: () => void;
    const original = (context.server as any).requireCurrentCardDevice.bind(context.server);
    const validation = vi.spyOn(context.server as any, 'requireCurrentCardDevice')
      .mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(original('first-card', 'user-a')); }));
    const first = context.feishu.onCardSwitchThread('user-a', 'first-card', 'first-selection', 'First');
    await vi.waitFor(() => expect(validation).toHaveBeenCalledOnce());
    const second = context.feishu.onCardSwitchThread('user-a', 'second-card', 'second-selection', 'Second');
    await answerSelection(context, socket, [{ id: 'default-id', name: 'default', status: 'idle' },
      { id: 'second-selection', name: 'Second', status: 'idle' }]);
    await second;
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
    await start('chunked-command', 'user-a', 'root-card', 'device-a', 'default-id');
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
    const reloaded = await createRouter();
    expect(await (reloaded.server as any).resolveCardThread(tailCard, 'user-a')).toEqual({ threadId: 'default-id', deviceId: 'device-a' });

    const switched = await click(context, socket, tailCard, 'other-thread');
    expect(switched.toast.type).toBe('success');
    expect((await context.bindings.getThreadSelection('user-a', 'device-a')).threadId).toBe('other-thread');

    await feishu.handleCardAction({ operator: { open_id: 'user-a' },
      context: { open_message_id: tailCard }, action: { value: { action: 'new_thread' } } });
    expect(commands(socket).some(command => command.content === '/thread new')).toBe(true);
    await text(context, 'reply-on-continuation', tailCard);
    expect(commands(socket).at(-1).threadId).toBe('default-id');

    await context.bindings.switchActiveDevice('user-a', 'device-b');
    context.feishu.onDeviceSwitchIntent('user-a', 'device-b');
    await context.feishu.onDeviceSwitch?.('user-a', 'device-a', 'device-b');
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
    await (context.feishu as any).onStartStreaming('valid-new-command', 'user-a', 'valid-new-card', 'device-a', undefined, true, undefined, undefined, intent);
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
    await (context.feishu as any).onStartStreaming('invalid-new-command', 'user-a', 'invalid-new-card', 'device-a', undefined, true, undefined, undefined, intent);
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
    await start('new-command', 'user-a', 'new-card', 'device-a', undefined, true, undefined, undefined, intent);
    vi.spyOn(context.store, 'setDeviceThreadSelection').mockRejectedValueOnce(new Error('Synthetic write failure'));
    await socket.receive({ type: MessageType.RESPONSE, messageId: 'new-command', openId: 'user-a', success: true,
      threadId: 'created-thread', threads: [{ id: 'default-id', name: 'default', status: 'idle' },
        { id: 'created-thread', name: 'Created', status: 'idle' }, { id: 'old-selection', name: 'Existing', status: 'idle' }] });

    expect(context.feishu.finalizeStreamingMessage).toHaveBeenCalled();
    expect(context.feishu.sendMessage).toHaveBeenCalledWith('user-a', expect.stringContaining('Thread created'));
    expect((await context.bindings.getThreadSelection('user-a', 'device-a')).threadId).toBe('old-selection');
    expect(commands(socket)).toHaveLength(0);
  });
  it('switches a persisted old card after Router recreation using only the current authenticated catalog', async () => {
    const first = await createRouter();
    await first.bindings.bindUser('user-a', 'device-a', 'A');
    const socket = await startLegacy(first.server);
    await text(first, '/thread list');
    const request = socket.sent.find(message => message.type === 'status');
    await socket.receive({ type: 'status', messageId: request.messageId, status: { threads: [
      { id: 'default-id', name: 'default', status: 'idle' }, { id: 'target', name: 'Original', status: 'idle' },
    ] } });
    const cardId = first.feishu.finalizeStreamingMessage.mock.calls.at(-1)[0];
    const original = first.store.getCardThread(cardId);
    expect(original).toBeDefined();
    socket.close();
    await first.store.flush();

    const restored = await createRouter();
    const currentSocket = await startLegacy(restored.server);
    const result = await click(restored, currentSocket, cardId, 'target');
    expect(result.toast).toEqual({ type: 'success', content: 'Switched to: Verified name' });
    expect(restored.store.getCardThread(cardId)).toEqual(original);
    await text(restored, 'after-old-card-switch');
    await text(restored, 'reply-to-original', cardId);
    expect(commands(currentSocket).map(command => command.threadId)).toEqual(['target', 'default-id']);
  });

  it('rejects missing targets, malformed inventories, unknown cards, wrong users and offline devices after recreation', async () => {
    const first = await createRouter();
    await first.bindings.bindUser('user-a', 'device-a', 'A');
    await select(first, 'old-card', 'device-a', 'target');
    const restored = await createRouter();
    await expect(restored.feishu.onCardSwitchThread('user-a', 'old-card', 'target', 'Target')).rejects.toThrow('Could not verify');
    const socket = await startLegacy(restored.server);
    await expect(restored.feishu.onCardSwitchThread('user-b', 'old-card', 'target', 'Target')).rejects.toThrow('expired');
    await expect(restored.feishu.onCardSwitchThread('user-a', 'lost-pre-upgrade-card', 'target', 'Target')).rejects.toThrow('expired');
    expect(socket.sent.filter(message => message.type === 'status')).toHaveLength(0);
    const malformed = await click(restored, socket, 'old-card', 'target', []);
    expect(malformed.toast.type).toBe('error');
    expect(restored.store.getDeviceThreadSelection('user-a', 'device-a')).toMatchObject({ threadId: 'target' });
    const missing = await click(restored, socket, 'old-card', 'target', [{ id: 'default-id', name: 'default', status: 'idle' }]);
    expect(missing.toast.content).toContain('no longer exists');
    expect(restored.store.getDeviceThreadSelection('user-a', 'device-a')).toEqual({ status: 'none' });
    expect(commands(socket)).toHaveLength(0);
  });

  it.each(['switch', 'unbind', 'unbind-all', 'revoke', 'enroll'])('keeps %s invalidation across Router recreation', async action => {
    const first = await createRouter();
    await first.bindings.bindUser('user-a', 'device-a', 'A');
    await first.bindings.bindUser('user-a', 'device-b', 'B');
    await register(first, 'old-card');
    const lateFence = (first.server as any).selections.capture('user-a', 'device-a');
    if (action === 'switch') {
      await first.bindings.switchActiveDevice('user-a', 'device-b');
      await first.bindings.switchActiveDevice('user-a', 'device-a');
    } else if (action === 'revoke') await first.feishu.onRevokeDevice('device-a');
    else if (action === 'enroll') {
      const { publicKey } = generateKeyPairSync('ed25519');
      await first.feishu.onApproveDeviceKey('user-a', 'device-a', publicKey.export({ type: 'spki', format: 'pem' }).toString());
    } else {
      if (action === 'unbind') await first.bindings.unbindDevice('user-a', 'device-a');
      else await first.bindings.unbindUser('user-a');
      await first.bindings.bindUser('user-a', 'device-a', 'A');
      await first.bindings.switchActiveDevice('user-a', 'device-a');
    }
    await first.feishu.onStartStreaming('late-command', 'user-a', 'late-card', 'device-a', 'target', false,
      undefined, undefined, lateFence);
    const restored = await createRouter();
    for (const cardId of ['old-card', 'late-card']) {
      await expect(restored.feishu.onCardSwitchThread('user-a', cardId, 'target', 'Target')).rejects.toThrow('expired');
      expect(await (restored.server as any).resolveCardThread(cardId, 'user-a')).toBeUndefined();
    }
  });

  it('does not register a notification that completes after unbind and rebind', async () => {
    const first = await createRouter();
    await first.bindings.bindUser('user-a', 'device-a', 'A');
    let release!: (id: string) => void;
    const create = vi.spyOn(first.feishu, 'sendTaskNotificationCard').mockImplementationOnce(() =>
      new Promise<string>(resolve => { release = resolve; }));
    const pending = (first.server as any).handleTaskNotification('user-a',
      { taskId: 'synthetic-task', status: 'completed', summary: 'Done' }, 'target', 'device-a');
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    await first.bindings.unbindDevice('user-a', 'device-a');
    await first.bindings.bindUser('user-a', 'device-a', 'A');
    release('late-notification');
    await pending;
    const restored = await createRouter();
    expect(await (restored.server as any).resolveCardThread('late-notification', 'user-a')).toBeUndefined();
  });

  it('rejects a pending switch when ownership changes before its catalog arrives', async () => {
    const context = await createRouter();
    await context.bindings.bindUser('user-a', 'device-a', 'A');
    await register(context, 'old-card');
    const socket = await startLegacy(context.server);
    const pending = context.feishu.handleCardAction({ operator: { open_id: 'user-a' }, context: { open_message_id: 'old-card' },
      action: { value: { action: 'switch_thread', threadId: 'target' } } });
    await vi.waitFor(() => expect(socket.sent.some(message => message.type === 'status')).toBe(true));
    await context.bindings.unbindDevice('user-a', 'device-a');
    await context.bindings.bindUser('user-a', 'device-a', 'A');
    await answerSelection(context, socket, [{ id: 'default-id', name: 'default', status: 'idle' },
      { id: 'target', name: 'Target', status: 'idle' }]);
    expect((await pending).toast.type).toBe('error');
    const restored = await createRouter();
    expect(restored.store.getDeviceThreadSelection('user-a', 'device-a')).toEqual({ status: 'none' });
  });

  it.each(['expired', 'malformed', 'missing'])('rejects %s stored associations after Router recreation', async kind => {
    const first = await createRouter();
    await first.bindings.bindUser('user-a', 'device-a', 'A');
    await register(first, 'old-card');
    const raw = JSON.parse(await fs.readFile(storePath, 'utf8'));
    if (kind === 'expired') raw.cardThreads.cards['old-card'].expiresAt = Date.now() - 1;
    else if (kind === 'malformed') raw.cardThreads.cards['old-card'].epoch = 0;
    else delete raw.cardThreads;
    await fs.writeFile(storePath, JSON.stringify(raw));
    const restored = await createRouter();
    const socket = await startLegacy(restored.server);
    await expect(restored.feishu.onCardSwitchThread('user-a', 'old-card', 'target', 'Target')).rejects.toThrow('expired');
    await text(restored, 'ordinary-work');
    expect(commands(socket)).toHaveLength(1);
    expect(commands(socket)[0].threadId).toBeUndefined();
    expect(socket.sent.some(message => message.type === 'status')).toBe(false);
  });

  it('requires the active device even for a valid persisted card from another bound device', async () => {
    const first = await createRouter();
    await first.bindings.bindUser('user-a', 'device-a', 'A');
    await first.bindings.bindUser('user-a', 'device-b', 'B');
    await register(first, 'inactive-card', 'target', 'device-b');
    const restored = await createRouter();
    expect(await (restored.server as any).resolveCardThread('inactive-card', 'user-a')).toMatchObject({ deviceId: 'device-b' });
    await expect(restored.feishu.onCardSwitchThread('user-a', 'inactive-card', 'target', 'Target')).rejects.toThrow('different device');
    expect(restored.store.getDeviceThreadSelection('user-a', 'device-a')).toEqual({ status: 'none' });
  });

  it('persists stream removal before a delayed delivered-card callback can revive it', async () => {
    const first = await createRouter();
    await first.bindings.bindUser('user-a', 'device-a', 'A');
    await first.feishu.onStartStreaming('pending-task', 'user-a', 'root-card', 'device-a', 'default-id');
    const stream = (first.server as any).streamingMessages.get('pending-task');
    await (first.server as any).cleanupStreamingSessionsForDevice('device-a');
    await (first.server as any).registerDeliveredThreadCards('pending-task', stream, ['root-card', 'late-continuation']);
    const restored = await createRouter();
    expect(await (restored.server as any).resolveCardThread('root-card', 'user-a')).toBeUndefined();
    expect(await (restored.server as any).resolveCardThread('late-continuation', 'user-a')).toBeUndefined();
  });

  it.each(['disconnect', 'timeout'])('removes every active continuation route on %s and preserves completed cards', async reason => {
    const first = await createRouter();
    await first.bindings.bindUser('user-a', 'device-a', 'A');
    await register(first, 'completed-card');
    await first.feishu.onStartStreaming('pending-task', 'user-a', 'root-card', 'device-a', 'default-id');
    const server = first.server as any;
    const stream = server.streamingMessages.get('pending-task');
    await server.registerDeliveredThreadCards('pending-task', stream, ['root-card', 'tail-card']);
    expect(first.store.getCardThread('tail-card')).toBeDefined();
    if (reason === 'disconnect') await server.cleanupStreamingSessionsForDevice('device-a');
    else {
      stream.createdAt = Date.now() - server.STREAMING_SESSION_TIMEOUT_MS - 1;
      await server.cleanupStaleStreamingSessions();
    }
    await server.registerDeliveredThreadCards('pending-task', stream, ['late-card']);
    const restored = await createRouter();
    for (const id of ['root-card', 'tail-card', 'late-card']) {
      expect(restored.store.getCardThread(id)).toBeUndefined();
    }
    expect(restored.store.getCardThread('completed-card')).toBeDefined();
  });

  it('revokes the entire continuation batch when disconnect interrupts its first write', async () => {
    const first = await createRouter();
    await first.bindings.bindUser('user-a', 'device-a', 'A');
    await first.feishu.onStartStreaming('pending-task', 'user-a', 'root-card', 'device-a', 'default-id');
    const server = first.server as any;
    const stream = server.streamingMessages.get('pending-task');
    const write = (first.store as any).writeSnapshot.bind(first.store);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(first.store as any, 'writeSnapshot').mockImplementationOnce(async (snapshot: unknown) => {
      entered();
      await gate;
      return write(snapshot);
    });
    const registration = server.registerDeliveredThreadCards('pending-task', stream, ['root-card', 'tail-card']);
    await started;
    const cleanup = server.cleanupStreamingSessionsForDevice('device-a');
    release();
    await Promise.all([registration, cleanup]);
    const restored = await createRouter();
    expect(restored.store.getCardThread('root-card')).toBeUndefined();
    expect(restored.store.getCardThread('tail-card')).toBeUndefined();
  });

  it('keeps a later click authoritative when the earlier catalog arrives last', async () => {
    const context = await createRouter();
    await context.bindings.bindUser('user-a', 'device-a', 'A');
    await register(context, 'old-card');
    const socket = await startLegacy(context.server);
    const first = context.feishu.onCardSwitchThread('user-a', 'old-card', 'first', 'First');
    const rejected = expect(first).rejects.toThrow('superseded');
    await vi.waitFor(() => expect((context.server as any).threadInventoryRequests.size).toBe(1));
    const second = context.feishu.onCardSwitchThread('user-a', 'old-card', 'second', 'Second');
    await vi.waitFor(() => expect((context.server as any).threadInventoryRequests.size).toBe(2));
    const requests = socket.sent.filter(message => message.type === 'status');
    const threads = [{ id: 'default-id', name: 'default', status: 'idle' },
      { id: 'first', name: 'First', status: 'idle' }, { id: 'second', name: 'Second', status: 'idle' }];
    await socket.receive({ type: 'status', messageId: requests[1].messageId, status: { threads } });
    await second;
    await socket.receive({ type: 'status', messageId: requests[0].messageId, status: { threads } });
    await rejected;
    const restored = await createRouter();
    expect(restored.store.getDeviceThreadSelection('user-a', 'device-a')).toMatchObject({ threadId: 'second' });
  });

  it.each(['timeout', 'disconnect', 'replacement', 'stop'] as const)(
    'keeps in-flight inventory validation fenced until %s and drains late work', async action => {
      const context = await createRouter();
      await context.bindings.bindUser('user-a', 'device-a', 'A');
      await register(context, 'source-card');
      const socket = await startLegacy(context.server);
      const result = context.feishu.onCardSwitchThread('user-a', 'source-card', 'target')
        .then((name: string) => name, (error: Error) => error);
      await vi.waitFor(() => expect((context.server as any).threadInventoryRequests.size).toBe(1));
      const request = socket.sent.find(message => message.type === 'status');
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      const original = (context.server as any).requireCurrentCardDevice.bind(context.server);
      const validation = vi.spyOn(context.server as any, 'requireCurrentCardDevice').mockImplementationOnce(async (...args: unknown[]) => {
        entered();
        await gate;
        return original(...args);
      });
      const response = { type: 'status', messageId: request.messageId, status: { threads: [
        { id: 'default-id', name: 'default', status: 'idle' }, { id: 'target', name: 'Target', status: 'idle' },
      ] } };
      const responding = socket.receive(response);
      try {
        await started;
        expect((context.server as any).threadInventoryRequests.has(request.messageId)).toBe(true);
        await socket.receive(response);
        expect(validation).toHaveBeenCalledTimes(1);
        if (action === 'disconnect') socket.close();
        if (action === 'replacement') await startLegacy(context.server);
        if (action === 'stop') await context.server.stop();
        // The real two-second callback deadline covers asynchronous validation too.
        await expect(result).resolves.toBeInstanceOf(Error);
        expect((context.server as any).threadInventoryRequests.size).toBe(0);
      } finally {
        release();
        await Promise.allSettled([responding, result]);
      }
      expect(context.store.getDeviceThreadSelection('user-a', 'device-a')).toEqual({ status: 'none' });
    },
  );

  it('bounds recovery inventories as well as card selections', async () => {
    const context = await createRouter();
    await context.bindings.bindUser('user-a', 'device-a', 'A');
    const socket = await startLegacy(context.server);
    for (let i = 0; i < 101; i++) await context.feishu.onRecoverThreads('user-a', 'device-a');
    expect((context.server as any).threadInventoryRequests.size).toBe(100);
    expect(socket.sent.filter(message => message.type === 'status')).toHaveLength(100);
    expect(context.feishu.sendMessage).toHaveBeenCalledWith('user-a', expect.stringContaining('busy'));
    socket.close();
    expect((context.server as any).threadInventoryRequests.size).toBe(0);
  });

  it('does not let a delayed switch notification invalidate cards from a later A-B-A switch', async () => {
    const context = await createRouter();
    await context.bindings.bindUser('user-a', 'device-a', 'A');
    await context.bindings.bindUser('user-a', 'device-b', 'B');
    await register(context, 'original-card');
    await context.bindings.switchActiveDevice('user-a', 'device-b');
    await context.bindings.switchActiveDevice('user-a', 'device-a');
    await register(context, 'fresh-card');
    await context.feishu.onDeviceSwitch?.('user-a', 'device-a', 'device-b');
    expect(context.store.getCardThread('original-card')).toBeUndefined();
    expect(context.store.getCardThread('fresh-card')).toBeDefined();
    const restored = await createRouter();
    expect(await (restored.server as any).resolveCardThread('fresh-card', 'user-a')).toMatchObject({ deviceId: 'device-a' });
  });

  it.each(['timeout', 'disconnect', 'replacement', 'stop', 'notice-failure'] as const)(
    'acknowledges an admitted selection as pending during snapshot I/O on %s', async action => {
      const context = await createRouter();
      await context.bindings.bindUser('user-a', 'device-a', 'A');
      await register(context, 'source-card');
      const socket = await startLegacy(context.server);
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      const original = (context.store as any).writeSnapshot.bind(context.store);
      vi.spyOn(context.store as any, 'writeSnapshot').mockImplementationOnce(async snapshot => {
        entered();
        await gate;
        return original(snapshot);
      });
      const result = context.feishu.onCardSwitchThread('user-a', 'source-card', 'target')
        .then((value: unknown) => value, (error: Error) => error);
      const responding = answerSelection(context, socket, [
        { id: 'default-id', name: 'default', status: 'idle' }, { id: 'target', name: 'Target', status: 'idle' },
      ]);
      let stopping: Promise<void> | undefined;
      try {
        await started;
        if (action === 'disconnect') socket.close();
        if (action === 'replacement') await startLegacy(context.server);
        if (action === 'stop') stopping = context.server.stop();
        if (action === 'notice-failure') {
          context.feishu.sendMessage.mockRejectedValueOnce(new Error('Synthetic delivery failure'));
          socket.close();
        }
        await expect(result).resolves.toEqual({ notice: expect.stringContaining('still being saved') });
        expect(context.store.getDeviceThreadSelection('user-a', 'device-a')).toEqual({ status: 'none' });
        expect((context.server as any).threadInventoryRequests.size).toBe(1);
      } finally {
        release();
        await Promise.allSettled([responding, result, stopping]);
      }
      expect(context.store.getDeviceThreadSelection('user-a', 'device-a')).toMatchObject({ threadId: 'target' });
      expect(context.feishu.sendMessage).toHaveBeenCalledWith('user-a', expect.stringContaining('was saved'));
      expect((context.server as any).threadInventoryRequests.size).toBe(0);
      const restored = await createRouter();
      expect(restored.store.getDeviceThreadSelection('user-a', 'device-a')).toMatchObject({ threadId: 'target' });
    },
  );

  it.each(['timeout', 'disconnect'] as const)('cancels a selection queued behind another snapshot before admission on %s', async action => {
    const context = await createRouter();
    await context.bindings.bindUser('user-a', 'device-a', 'A');
    await register(context, 'source-card');
    const socket = await startLegacy(context.server);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const original = (context.store as any).writeSnapshot.bind(context.store);
    const writes = vi.spyOn(context.store as any, 'writeSnapshot').mockImplementationOnce(async snapshot => {
      entered();
      await gate;
      return original(snapshot);
    });
    const unrelated = register(context, 'unrelated-card');
    await started;
    const selecting = vi.spyOn(context.store, 'setDeviceThreadSelection');
    const result = context.feishu.onCardSwitchThread('user-a', 'source-card', 'target')
      .then((value: unknown) => value, (error: Error) => error);
    const responding = answerSelection(context, socket, [
      { id: 'default-id', name: 'default', status: 'idle' }, { id: 'target', name: 'Target', status: 'idle' },
    ]);
    try {
      await vi.waitFor(() => expect(selecting).toHaveBeenCalled());
      if (action === 'disconnect') socket.close();
      await expect(result).resolves.toBeInstanceOf(Error);
    } finally {
      release();
      await Promise.allSettled([unrelated, responding, result]);
    }
    expect(writes).toHaveBeenCalledTimes(1);
    expect(context.store.getDeviceThreadSelection('user-a', 'device-a')).toEqual({ status: 'none' });
    const restored = await createRouter();
    expect(restored.store.getDeviceThreadSelection('user-a', 'device-a')).toEqual({ status: 'none' });
  });

  it.each([false, true])('reports a snapshot failure without claiming a saved selection (pending acknowledgement: %s)', async pending => {
    const context = await createRouter();
    await context.bindings.bindUser('user-a', 'device-a', 'A');
    await register(context, 'source-card');
    const socket = await startLegacy(context.server);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(context.store as any, 'writeSnapshot').mockImplementationOnce(async () => {
      entered();
      await gate;
      throw new Error('Synthetic snapshot failure');
    });
    const result = context.feishu.onCardSwitchThread('user-a', 'source-card', 'target')
      .then((value: unknown) => value, (error: Error) => error);
    const responding = answerSelection(context, socket, [
      { id: 'default-id', name: 'default', status: 'idle' }, { id: 'target', name: 'Target', status: 'idle' },
    ]);
    try {
      await started;
      if (pending) {
        socket.close();
        await expect(result).resolves.toMatchObject({ notice: expect.stringContaining('still being saved') });
      }
    } finally {
      release();
      await responding;
    }
    if (pending) expect(context.feishu.sendMessage).toHaveBeenCalledWith('user-a', expect.stringContaining('could not be confirmed durably'));
    else await expect(result).resolves.toMatchObject({ message: 'Synthetic snapshot failure' });
    expect(context.feishu.sendMessage).not.toHaveBeenCalledWith('user-a', expect.stringContaining('was saved'));
    expect(context.store.getDeviceThreadSelection('user-a', 'device-a')).toEqual({ status: 'none' });
    expect((context.server as any).threadInventoryRequests.size).toBe(0);
  });

  it('reports a completed save honestly when a later intent supersedes it during snapshot I/O', async () => {
    const context = await createRouter();
    await context.bindings.bindUser('user-a', 'device-a', 'A');
    await register(context, 'source-card');
    const socket = await startLegacy(context.server);
    const original = (context.store as any).writeSnapshot.bind(context.store);
    vi.spyOn(context.store as any, 'writeSnapshot').mockImplementationOnce(async snapshot => {
      (context.server as any).selections.reserveIntent('user-a');
      return original(snapshot);
    });
    const outcome = await click(context, socket, 'source-card', 'target');
    expect(outcome.toast).toMatchObject({ type: 'info', content: expect.stringContaining('was saved') });
    expect(context.store.getDeviceThreadSelection('user-a', 'device-a')).toMatchObject({ threadId: 'target' });
  });

  // Directory fsync is a POSIX durability step; Windows intentionally does not use it.
  it.skipIf(process.platform === 'win32')('holds routing after rename when directory fsync fails following a pending acknowledgement', async () => {
    const context = await createRouter();
    await context.bindings.bindUser('user-a', 'device-a', 'A');
    await register(context, 'source-card');
    const socket = await startLegacy(context.server);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const open = fs.open.bind(fs);
    const opened = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === home && args[1] === 'r') vi.spyOn(handle, 'sync').mockImplementationOnce(async () => {
        entered();
        await gate;
        throw new Error('Synthetic directory sync failure');
      });
      return handle;
    });
    const result = context.feishu.onCardSwitchThread('user-a', 'source-card', 'target')
      .then((value: unknown) => value, (error: Error) => error);
    const responding = answerSelection(context, socket, [
      { id: 'default-id', name: 'default', status: 'idle' }, { id: 'target', name: 'Target', status: 'idle' },
    ]);
    try {
      await started;
      expect(JSON.parse(await fs.readFile(storePath, 'utf8')).userBindings['user-a'].devices[0].selectedThreadId).toBe('target');
      expect(context.store.getDeviceThreadSelection('user-a', 'device-a')).toEqual({ status: 'none' });
      socket.close();
      await expect(result).resolves.toMatchObject({ notice: expect.stringContaining('still being saved') });
    } finally {
      release();
      await Promise.allSettled([responding, result]);
      opened.mockRestore();
    }
    expect(context.feishu.sendMessage).toHaveBeenCalledWith('user-a', expect.stringContaining('could not be confirmed durably'));
    expect(() => context.store.getDeviceThreadSelection('user-a', 'device-a')).toThrow('uncertain');
    await expect(context.store.flush()).rejects.toThrow('uncertain');
    const restored = await createRouter();
    expect(restored.store.getDeviceThreadSelection('user-a', 'device-a')).toMatchObject({ threadId: 'target' });
  });

});
