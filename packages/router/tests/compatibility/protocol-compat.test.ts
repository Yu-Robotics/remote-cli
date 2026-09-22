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
  let socket: EventEmitter & { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; readyState: number };
  let receive: (message: object) => Promise<void>;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(Koa.prototype, 'listen').mockReturnValue({
      close: (callback: () => void) => callback(),
    } as unknown as Server);
    const wss = Object.assign(new EventEmitter(), { close: vi.fn() });
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
