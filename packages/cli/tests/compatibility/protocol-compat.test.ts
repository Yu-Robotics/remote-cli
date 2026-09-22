/**
 * Exercise the real CLI transport. Wire-contract failures require reviewing
 * CLAUDE.md's protocol versioning rules before changing expectations.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { WebSocketClient } from '../../src/client/WebSocketClient';
import { CLI_VERSION, PROTOCOL_VERSION } from '../../src/types';

vi.mock('ws');

describe('CLI wire compatibility', () => {
  let client: WebSocketClient;
  let socket: EventEmitter & { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; readyState: number };

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    socket = Object.assign(new EventEmitter(), { send: vi.fn(), close: vi.fn(), readyState: WebSocket.OPEN });
    vi.mocked(WebSocket).mockImplementation(() => socket as unknown as WebSocket);
    client = new WebSocketClient('ws://localhost:3000', 'device-1');
    const connecting = client.connect();
    socket.emit('open');
    await connecting;
  });

  afterEach(() => {
    client.disconnect();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('registers the device with its protocol version and queue-start capability', () => {
    expect(JSON.parse(socket.send.mock.calls[0][0])).toEqual({
      type: 'binding_request',
      messageId: expect.any(String),
      timestamp: expect.any(Number),
      data: { deviceId: 'device-1', protocolVersion: PROTOCOL_VERSION, capabilities: { queueStarted: true } },
    });
  });

  it('sends the heartbeat wire format without a message id', async () => {
    await vi.advanceTimersByTimeAsync(15000);
    expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toEqual({
      type: 'heartbeat', timestamp: expect.any(Number),
    });
  });

  it.each([
    { success: true },
    { success: true, routerVersion: CLI_VERSION, minCliVersion: PROTOCOL_VERSION, futureField: 'ignored' },
  ])('accepts a binding confirmation with optional version metadata: %j', (data) => {
    const onMessage = vi.fn();
    client.onMessage(onMessage);
    const confirmation = { type: 'binding_confirm', messageId: 'registration', timestamp: 1000, data };
    socket.emit('message', Buffer.from(JSON.stringify(confirmation)));
    expect(onMessage).toHaveBeenCalledWith(confirmation);
    expect(client.isConnected()).toBe(true);
  });

  it('surfaces protocol rejection and stops reconnecting after the router closes the connection', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'error',
      data: { code: 'PROTOCOL_VERSION_INCOMPATIBLE', message: 'Please upgrade remote-cli.' },
    })));
    socket.emit('close', 1000, Buffer.from(''));
    await vi.advanceTimersByTimeAsync(15000);

    expect(error).toHaveBeenCalledWith(expect.stringContaining('Please upgrade remote-cli.'));
    expect(client.isConnected()).toBe(false);
    expect(WebSocket).toHaveBeenCalledTimes(1);
  });
});
