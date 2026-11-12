import { cardThreadStorage } from './helpers/cardThreadStorage';
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

describe('Schedule card protocol integration', () => {
  let directory: string;
  let server: RouterServer;
  let wss: EventEmitter;
  let feishu: any;
  let owners: Map<string, string>;
  let bindingLookup: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'router-scheduled-result-')));
    vi.spyOn(os, 'homedir').mockReturnValue(directory);
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
    server = new RouterServer(config as unknown as ConfigManager, {
      ...cardThreadStorage(), getDeviceThreadSelection: vi.fn(() => ({ status: 'none' })), flush: vi.fn().mockResolvedValue(undefined),
    } as unknown as JsonStore);
    bindingLookup = vi.spyOn((server as any).bindingManager, 'getDeviceBinding').mockImplementation(
      async (deviceId: string) => owners.has(deviceId) ? { openId: owners.get(deviceId) } : null,
    );
    await server.start();
    feishu = vi.mocked(FeishuLongConnHandler).mock.instances[0];
    feishu.sendStreamingStart.mockResolvedValue('schedule-card');
    feishu.finalizeStreamingMessage.mockResolvedValue(true);
    owners.set('device-1', 'owner');
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

  const capabilities = { queueStarted: true, taskRecovery: true, scheduleResultsV1: true, scheduleCardsV1: true };
  const menu = () => ({ snapshotId: 'snapshot', threadId: 'original-thread', threadName: 'Original thread', expiresAt: Date.now() + 60_000,
    entries: [{ value: 'choice', id: 'schedule', state: 'active', backend: 'claude', prompt: 'Synthetic task', rule: '* * * * * (UTC)', canCancel: true }] });
  const buttons = (elements: any[]) => elements.flatMap(element => element.columns?.flatMap((column: any) => column.elements.filter((node: any) => node.tag === 'button')) ?? []);
  async function present(socket: TestSocket, value = menu()) {
    const onStart = feishu.setOnStartStreaming.mock.calls[0][0];
    await onStart('command', 'owner', 'card', 'device-1', 'original-thread', undefined, undefined, 'Original thread');
    feishu.finalizeStreamingMessage.mockImplementation(async (...args: any[]) => { await args[11]?.onDelivered?.(['card']); return true; });
    await receive(socket, { type: 'response', messageId: 'command', openId: 'owner', threadId: 'original-thread', success: true,
      output: 'Schedule created. Use /schedule list.', scheduleMenu: value });
    return feishu.finalizeStreamingMessage.mock.calls.at(-1)[1];
  }

  const toolCapabilities = { ...capabilities, scheduleToolCardsV1: true };
  async function prepareForeground(socket: TestSocket) {
    await register(socket, toolCapabilities);
    await feishu.setOnStartStreaming.mock.calls[0][0]('foreground', 'owner', 'answer-card', 'device-1', 'original-thread', undefined, undefined, 'Original thread');
    feishu.createOutputCard.mockResolvedValue('management-card');
  }
  function toolCard(overrides = {}) { return { type: 'schedule_tool_card', messageId: 'tool-management', parentMessageId: 'foreground',
    openId: 'owner', threadId: 'original-thread', menu: menu(), timestamp: 1, ...overrides }; }

  it('delivers a separate original-thread management card without replacing or acknowledging the foreground answer', async () => {
    const socket = connect(); await prepareForeground(socket);
    const message = toolCard(); await receive(socket, message); await receive(socket, message);
    expect(feishu.createOutputCard).toHaveBeenCalledOnce();
    expect(feishu.finalizeStreamingMessage).not.toHaveBeenCalled();
    expect(replies(socket).filter(reply => reply.type === 'task_result_ack')).toHaveLength(0);
    expect(replies(socket).filter(reply => reply.type === 'schedule_tool_card_ack')).toHaveLength(2);
    expect(replies(socket).at(-1).success).toBe(true);
    expect(await (server as any).resolveCardThread('management-card', 'owner')).toEqual({ deviceId: 'device-1', threadId: 'original-thread' });
    const elements = JSON.parse(feishu.createOutputCard.mock.calls[0][1]).body.elements;
    await feishu.scheduleCards.click('owner', 'management-card', buttons(elements)[0].behaviors[0].value);
    expect(replies(socket).at(-1)).toMatchObject({ type: 'schedule_action', operation: 'refresh', threadId: 'original-thread' });
    await receive(socket, { type: 'response', messageId: 'foreground', threadId: 'original-thread', openId: 'owner', success: true, output: 'Assistant answer preserved' });
    expect(feishu.finalizeStreamingMessage).toHaveBeenCalled();
  });

  it('rejects foreign routing and reused delivery IDs with changed content', async () => {
    const socket = connect(); await prepareForeground(socket);
    await receive(socket, toolCard({ openId: 'foreign' })); expect(feishu.createOutputCard).not.toHaveBeenCalled();
    const message = toolCard(); await receive(socket, message);
    await receive(socket, { ...message, menu: { ...message.menu, threadName: 'changed' } });
    expect(replies(socket).at(-1)).toMatchObject({ type: 'schedule_tool_card_ack', success: false });
    expect(feishu.createOutputCard).toHaveBeenCalledOnce();
  });

  it('keeps native operation and card failure separate and gates old peers', async () => {
    const socket = connect(); await register(socket, capabilities);
    await receive(socket, toolCard()); expect(feishu.createOutputCard).not.toHaveBeenCalled();
    const capable = connect(); await prepareForeground(capable);
    feishu.createOutputCard.mockRejectedValue(new Error('synthetic delivery failure'));
    await receive(capable, toolCard());
    expect(replies(capable).at(-1)).toMatchObject({ type: 'schedule_tool_card_ack', success: false });
    expect(replies(capable).filter(reply => reply.type === 'command' || reply.type === 'task_result_ack')).toHaveLength(0);
  });

  it('recycles completed delivery receipts at capacity while preserving pending deliveries', async () => {
    const socket = connect(); await prepareForeground(socket);
    const receipts = (server as any).scheduleToolDeliveries;
    for (let index = 0; index < 500; index++) receipts.set(`old-${index}`, { digest: 'old', done: Promise.resolve(true), settled: false });
    await receive(socket, toolCard());
    expect(replies(socket).at(-1).success).toBe(false);
    expect(feishu.createOutputCard).not.toHaveBeenCalled();
    receipts.get('old-0').settled = true;
    await receive(socket, toolCard());
    expect(replies(socket).at(-1).success).toBe(true);
    expect(feishu.createOutputCard).toHaveBeenCalledOnce();
    expect(receipts.size).toBe(500);
    expect(receipts.has('old-0')).toBe(false);
    expect(receipts.has('old-1')).toBe(true);
  });

  it('retains the captured foreground identity if its response finishes during card delivery, but fences ownership changes', async () => {
    const socket = connect(); await prepareForeground(socket);
    let release!: () => void;
    feishu.createOutputCard.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return 'management-card'; });
    const pending = receive(socket, toolCard());
    await vi.waitFor(() => expect(feishu.createOutputCard).toHaveBeenCalledOnce());
    await receive(socket, { type: 'response', messageId: 'foreground', threadId: 'original-thread', openId: 'owner', success: true, output: 'Done' });
    release(); await pending; expect(replies(socket).at(-1).success).toBe(true);
    await feishu.setOnStartStreaming.mock.calls[0][0]('second', 'owner', 'second-answer', 'device-1', 'original-thread');
    feishu.createOutputCard.mockImplementationOnce(async () => { owners.set('device-1', 'foreign'); return 'retired-card'; });
    await receive(socket, toolCard({ messageId: 'second-management', parentMessageId: 'second' }));
    expect(replies(socket).at(-1).success).toBe(false);
    expect(await (server as any).resolveCardThread('retired-card', 'owner')).toBeUndefined();
  });

  it.each([{}, { scheduleCardsV1: true }, { scheduleResultsV1: true, scheduleCardsV1: true }, capabilities])('negotiates only the complete capability set %j', async offered => {
    const socket = connect(); await register(socket, offered);
    expect(replies(socket).find(reply => reply.type === 'binding_confirm').data.capabilities?.scheduleCardsV1).toBe(offered === capabilities ? true : undefined);
    const elements = await present(socket);
    expect(buttons(elements).length > 0).toBe(offered === capabilities);
  });

  it('binds delivered controls and replies to the original device/thread with no normal command or selection', async () => {
    const socket = connect(); await register(socket, capabilities);
    const elements = await present(socket);
    const refresh = buttons(elements).find(button => button.text.content === 'Refresh status').behaviors[0].value;
    await feishu.scheduleCards.click('owner', 'card', refresh);
    const request = replies(socket).find(reply => reply.type === 'schedule_action');
    expect(request).toMatchObject({ operation: 'refresh', openId: 'owner', threadId: 'original-thread', snapshotId: 'snapshot' });
    expect(replies(socket).filter(reply => reply.type === 'command')).toHaveLength(0);
    await receive(socket, { ...request, type: 'schedule_action_result', success: true, menu: menu() });
    expect(JSON.stringify(feishu.updateScheduleCard.mock.calls.at(-1)[1])).toContain('Status refreshed');
    const route = await (server as any).resolveCardThread('card', 'owner');
    expect(route?.threadId).toBe('original-thread');
  });

  it('rejects cross-owner/card callbacks and discards controls from a replaced connection', async () => {
    const socket = connect(); await register(socket, capabilities);
    const elements = await present(socket);
    const payload = buttons(elements)[0].behaviors[0].value;
    await expect(feishu.scheduleCards.click('foreign', 'card', payload)).rejects.toThrow('another user');
    await expect(feishu.scheduleCards.click('owner', 'other-card', payload)).rejects.toThrow('expired');
    const replacement = connect(); await register(replacement, capabilities);
    await expect(feishu.scheduleCards.click('owner', 'card', payload)).rejects.toThrow('expired');
    await receive(socket, { type: 'schedule_action_result', messageId: 'forged', success: true });
    expect(replies(replacement).filter(reply => reply.type === 'schedule_action')).toHaveLength(0);
  });

  it('invalidates controls when ownership changes during asynchronous callback admission', async () => {
    const socket = connect(); await register(socket, capabilities);
    const elements = await present(socket);
    const payload = buttons(elements)[0].behaviors[0].value;
    let release!: () => void;
    bindingLookup.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return { openId: 'owner' } as any; });
    const click = feishu.scheduleCards.click('owner', 'card', payload);
    socket.emit('close', 1006, Buffer.from(''));
    release();
    await expect(click).rejects.toThrow('unavailable');
    expect(replies(socket).filter(reply => reply.type === 'schedule_action')).toHaveLength(0);
  });

  it('degrades malformed or foreign-thread snapshots to the existing text response', async () => {
    const socket = connect(); await register(socket, capabilities);
    const elements = await present(socket, { ...menu(), threadId: 'foreign-thread' });
    expect(buttons(elements)).toHaveLength(0);
  });
});
