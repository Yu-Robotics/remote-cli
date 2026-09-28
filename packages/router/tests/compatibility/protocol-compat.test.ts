/**
 * Exercise RouterServer's actual WebSocket handlers without opening sockets.
 * Wire-contract failures require reviewing CLAUDE.md's protocol versioning rules.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { Server } from 'http';
import Koa from 'koa';
import { WebSocket, WebSocketServer } from 'ws';
import { RouterServer } from '../../src/server';
import type { ConfigManager } from '../../src/config/ConfigManager';
import type { JsonStore } from '../../src/storage/JsonStore';
import { FeishuLongConnHandler } from '../../src/feishu/FeishuLongConnHandler';
import { MIN_SUPPORTED_CLI_VERSION, PROTOCOL_VERSION, ROUTER_VERSION } from '../../src/types';

vi.mock('ws');
vi.mock('../../src/feishu/FeishuLongConnHandler');

describe('Router wire compatibility', () => {
  let server: RouterServer;
  let wss: EventEmitter;
  let socket: EventEmitter & { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; readyState: number };
  let receive: (message: object) => Promise<void>;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(Koa.prototype, 'listen').mockReturnValue({
      close: (callback: () => void) => callback(),
    } as unknown as Server);
    wss = Object.assign(new EventEmitter(), { close: vi.fn() });
    vi.mocked(WebSocketServer).mockImplementation(() => wss as unknown as WebSocketServer);
    const config = { get: (_section: string, key: string) => key === 'heartbeatInterval' ? 30000 : 'test' };
    server = new RouterServer(config as unknown as ConfigManager, {} as JsonStore);
    await server.start();

    socket = Object.assign(new EventEmitter(), { send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN });
    wss.emit('connection', socket, { socket: { remoteAddress: '127.0.0.1' } });
    const onMessage = socket.listeners('message')[0];
    receive = async (message) => { await onMessage(Buffer.from(JSON.stringify(message))); };
  });

  afterEach(async () => {
    await server.stop();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    { label: 'legacy CLI without optional metadata', metadata: {}, supportsQueueStarted: false },
    {
      label: 'current CLI with additive metadata',
      metadata: { protocolVersion: PROTOCOL_VERSION, capabilities: { queueStarted: true, futureFeature: true }, futureField: 'ignored' },
      supportsQueueStarted: true,
    },
  ])('registers and confirms a $label', async ({ metadata, supportsQueueStarted }) => {
    await receive({
      type: 'binding_request', messageId: 'registration', timestamp: 1000,
      data: { deviceId: 'device-1', ...metadata },
    });
    expect(JSON.parse(socket.send.mock.calls[0][0])).toEqual({
      type: 'binding_confirm', messageId: 'registration', timestamp: expect.any(Number),
      data: { success: true, routerVersion: ROUTER_VERSION, minCliVersion: MIN_SUPPORTED_CLI_VERSION },
    });
    const feishu = vi.mocked(FeishuLongConnHandler).mock.instances[0];
    const hub = vi.mocked(feishu.setConnectionHub).mock.calls[0][0];
    expect(hub.isDeviceOnline('device-1')).toBe(true);
    expect(hub.supportsQueueStarted('device-1')).toBe(supportsQueueStarted);
    expect(socket.close).not.toHaveBeenCalled();
  });

  it('negotiates additive approval cards and routes a button response to the original request', async () => {
    await receive({ type: 'binding_request', messageId: 'registration', data: {
      deviceId: 'device-1', protocolVersion: PROTOCOL_VERSION, capabilities: { approvalCards: true, taskRecovery: true },
    } });
    expect(JSON.parse(socket.send.mock.calls[0][0]).data.capabilities).toEqual({ approvalCards: true, taskRecovery: true });
    const feishu = vi.mocked(FeishuLongConnHandler).mock.instances[0];
    vi.spyOn((server as any).bindingManager, 'getDeviceBinding').mockResolvedValue({ openId: 'owner' });
    vi.mocked(feishu.sendTaskNotificationCard).mockResolvedValue('approval-card');
    const message = { type: 'approval_request', messageId: 'approval-1', taskMessageId: 'task', openId: 'owner',
      threadId: 'thread-2', threadName: 'thread-2', cwd: '/project', timestamp: 1,
      approval: { requestId: 'approval-1', kind: 'command', description: 'install', canRemember: false } };
    await receive(message);
    expect(feishu.sendTaskNotificationCard).toHaveBeenCalledWith('owner', expect.any(Array), expect.objectContaining({ template: 'blue' }));
    await feishu.onApprovalAction!('owner', 'approval-1', 'approval-card', 'approve');
    expect(socket.send.mock.calls.map(call => JSON.parse(call[0]))).toContainEqual(expect.objectContaining({
      type: 'approval_response', messageId: 'approval-1', taskMessageId: 'task', threadId: 'thread-2', action: 'approve',
    }));
    await receive({ type: 'approval_resolved', messageId: 'approval-1', openId: 'owner', threadId: 'thread-2', status: 'approved' });
    expect(JSON.stringify(vi.mocked(feishu.updateApprovalCard).mock.calls.at(-1))).toContain('Approved');
  });

  it('serves a legacy CLI alongside a current CLI without requiring new capabilities', async () => {
    await receive({ type: 'binding_request', messageId: 'legacy-registration', data: { deviceId: 'legacy-device' } });
    const currentSocket = Object.assign(new EventEmitter(), { send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN });
    wss.emit('connection', currentSocket, { socket: { remoteAddress: '127.0.0.2' } });
    const onCurrentMessage = currentSocket.listeners('message')[0];
    const receiveCurrent = async (message: object) => { await onCurrentMessage(Buffer.from(JSON.stringify(message))); };
    await receiveCurrent({ type: 'binding_request', messageId: 'current-registration', data: {
      deviceId: 'current-device', protocolVersion: 1,
      capabilities: { queueStarted: true, taskRecovery: true, approvalCards: true },
    } });

    const feishu = vi.mocked(FeishuLongConnHandler).mock.instances[0];
    const hub = vi.mocked(feishu.setConnectionHub).mock.calls[0][0];
    const startStreaming = vi.mocked(feishu.setOnStartStreaming).mock.calls[0][0];
    const legacyCommand = { type: 'command', messageId: 'legacy-task', openId: 'legacy-user', content: 'Inspect the project', timestamp: 1000 };
    const currentCommand = { type: 'command', messageId: 'current-task', openId: 'current-user', threadId: 'thread-2', content: 'Delegate a review', timestamp: 1000 };
    startStreaming('legacy-task', 'legacy-user', 'legacy-card', 'legacy-device');
    startStreaming('current-task', 'current-user', 'current-card', 'current-device', 'thread-2');
    expect(await hub.sendToDevice('legacy-device', legacyCommand)).toBe(true);
    expect(await hub.sendToDevice('current-device', currentCommand)).toBe(true);
    expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toEqual(legacyCommand);
    expect(JSON.parse(currentSocket.send.mock.calls.at(-1)![0])).toEqual(currentCommand);

    await receive({ type: 'stream', messageId: 'legacy-task', openId: 'legacy-user', chunk: 'Legacy progress' });
    await receiveCurrent({ type: 'stream', messageId: 'current-task', openId: 'current-user', streamType: 'tool_use',
      toolUse: { id: 'delegated-task', name: 'Task', input: { description: 'Review the project', subagent_type: 'codex' } } });
    await receiveCurrent({ type: 'stream', messageId: 'current-task', openId: 'current-user', streamType: 'tool_result',
      toolResult: { tool_use_id: 'delegated-task', content: 'Delegated review complete' } });
    await receive({ type: 'response', messageId: 'legacy-task', data: { openId: 'legacy-user', success: true, output: 'Legacy progress' } });
    await receiveCurrent({ type: 'response', messageId: 'current-task', openId: 'current-user', threadId: 'thread-2', success: true });

    const finalCards = vi.mocked(feishu.finalizeStreamingMessage).mock.calls;
    expect(finalCards).toHaveLength(2);
    expect(finalCards[0][0]).toBe('legacy-card');
    expect(JSON.stringify(finalCards[0][1])).toContain('Legacy progress');
    expect(finalCards[0][3]).toBe('legacy-user');
    expect(finalCards[1][0]).toBe('current-card');
    expect(JSON.stringify(finalCards[1][1])).toContain('Delegated review complete');
    expect(finalCards[1][3]).toBe('current-user');
    expect(socket.send.mock.calls.map(([value]) => JSON.parse(value).type)).toEqual(['binding_confirm', 'command']);
    expect(currentSocket.send.mock.calls.map(([value]) => JSON.parse(value).type)).toEqual(['binding_confirm', 'command', 'task_result_ack']);
    expect(hub.supportsQueueStarted('legacy-device')).toBe(false);
    expect(hub.supportsQueueStarted('current-device')).toBe(true);
    expect(socket.close).not.toHaveBeenCalled();
    expect(currentSocket.close).not.toHaveBeenCalled();
  });

  it('rejects an unsupported CLI before registering it and explains how to recover', async () => {
    await receive({
      type: 'binding_request', messageId: 'registration', timestamp: 1000,
      data: { deviceId: 'device-1', protocolVersion: MIN_SUPPORTED_CLI_VERSION - 1 },
    });
    expect(JSON.parse(socket.send.mock.calls[0][0])).toEqual({
      type: 'error', messageId: 'registration', timestamp: expect.any(Number),
      data: {
        code: 'PROTOCOL_VERSION_INCOMPATIBLE',
        message: expect.stringContaining('Please upgrade remote-cli'),
        minimumVersion: MIN_SUPPORTED_CLI_VERSION,
        currentRouterVersion: PROTOCOL_VERSION,
      },
    });
    const feishu = vi.mocked(FeishuLongConnHandler).mock.instances[0];
    const hub = vi.mocked(feishu.setConnectionHub).mock.calls[0][0];
    expect(hub.isDeviceOnline('device-1')).toBe(false);
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it('responds to a CLI heartbeat that has no message id', async () => {
    await receive({ type: 'heartbeat', timestamp: 1000 });
    expect(JSON.parse(socket.send.mock.calls[0][0])).toEqual({
      type: 'heartbeat', timestamp: expect.any(Number), data: {},
    });
  });
});
