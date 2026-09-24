import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocketClient } from '../src/client/WebSocketClient';
import WebSocket from 'ws';

// Mock WebSocket
vi.mock('ws');

describe('WebSocketClient', () => {
  let client: WebSocketClient;
  let mockWs: any;
  const serverUrl = 'ws://localhost:3000';
  const deviceId = 'test-device-id';

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock WebSocket instance
    mockWs = {
      on: vi.fn(),
      send: vi.fn(),
      close: vi.fn(),
      readyState: WebSocket.OPEN,
      ping: vi.fn(),
      terminate: vi.fn()
    };

    // Mock WebSocket constructor
    (WebSocket as any).mockImplementation(() => mockWs);
    (WebSocket as any).CONNECTING = 0;
    (WebSocket as any).OPEN = 1;
    (WebSocket as any).CLOSING = 2;
    (WebSocket as any).CLOSED = 3;

    client = new WebSocketClient(serverUrl, deviceId);
  });

  afterEach(() => {
    client.disconnect();
  });

  describe('connection management', () => {
    it('should create WebSocket connection on connect', async () => {
      const connectPromise = client.connect();

      // Simulate connection opened
      const openHandler = mockWs.on.mock.calls.find((call: any) => call[0] === 'open')?.[1];
      openHandler();

      await connectPromise;

      expect(WebSocket).toHaveBeenCalledWith(serverUrl, { handshakeTimeout: 15000 });
      expect(client.isConnected()).toBe(true);
    });

    it('should handle connection errors', async () => {
      const connectPromise = client.connect();

      const errorHandler = mockWs.on.mock.calls.find((call: any) => call[0] === 'error')?.[1];
      const testError = new Error('Connection failed');
      errorHandler(testError);

      await expect(connectPromise).rejects.toThrow('Connection failed');
      expect(client.isConnected()).toBe(false);
    });

    it('should handle connection close', async () => {
      const connectPromise = client.connect();
      const openHandler = mockWs.on.mock.calls.find((call: any) => call[0] === 'open')?.[1];
      openHandler();
      await connectPromise;

      const closeHandler = mockWs.on.mock.calls.find((call: any) => call[0] === 'close')?.[1];
      closeHandler(1000, Buffer.from(''));

      expect(client.isConnected()).toBe(false);
    });

    it('should disconnect cleanly', async () => {
      const connectPromise = client.connect();
      const openHandler = mockWs.on.mock.calls.find((call: any) => call[0] === 'open')?.[1];
      openHandler();
      await connectPromise;

      client.disconnect();

      expect(mockWs.close).toHaveBeenCalled();
      expect(client.isConnected()).toBe(false);
    });
  });

  describe('auto reconnection', () => {
    it('registers again before recovering a task and ignores callbacks from the old socket', async () => {
      vi.useFakeTimers();
      const callback = (ws: any, event: string) => ws.on.mock.calls.find(([name]: string[]) => name === event)[1];
      const connect = client.connect();
      callback(mockWs, 'open')();
      await connect;
      callback(mockWs, 'message')(Buffer.from(JSON.stringify({ type: 'binding_confirm',
        data: { success: true, capabilities: { taskRecovery: true } } })));
      client.trackTask({ messageId: 'task', openId: 'user', threadId: 'thread', threadName: 'default',
        backend: 'claude', cwd: '/workspace', preview: 'Keep working' });
      callback(mockWs, 'close')(1006, Buffer.from('restart'));
      client.send({ type: 'stream', messageId: 'task', chunk: 'discarded' });
      const next = { ...mockWs, on: vi.fn(), send: vi.fn() };
      vi.mocked(WebSocket).mockImplementation(() => next);
      vi.advanceTimersByTime(5000);
      callback(next, 'open')();
      expect(next.send).toHaveBeenCalledTimes(1);
      expect(JSON.parse(next.send.mock.calls[0][0]).type).toBe('binding_request');
      callback(next, 'message')(Buffer.from(JSON.stringify({ type: 'binding_confirm',
        data: { success: true, capabilities: { taskRecovery: true } } })));
      const recovery = JSON.parse(next.send.mock.calls[1][0]);
      expect(recovery.type).toBe('task_resume');
      callback(mockWs, 'close')(1006, Buffer.from('delayed close'));
      expect(client.isConnected()).toBe(true);
      callback(next, 'message')(Buffer.from(JSON.stringify({ type: 'task_resume_ack', messageId: 'task',
        recoveryId: recovery.taskResume.recoveryId, state: 'running', success: true })));
      client.send({ type: 'stream', messageId: 'task', chunk: 'new output' });
      expect(JSON.parse(next.send.mock.calls.at(-1)[0]).chunk).toBe('new output');
      expect(JSON.stringify(next.send.mock.calls)).not.toContain('discarded');
      client.disconnect();
      vi.useRealTimers();
    });
    it('should attempt reconnection after disconnect', async () => {
      vi.useFakeTimers();

      const connectPromise = client.connect();
      const openHandler = mockWs.on.mock.calls.find((call: any) => call[0] === 'open')?.[1];
      openHandler();
      await connectPromise;

      // Simulate disconnect
      const closeHandler = mockWs.on.mock.calls.find((call: any) => call[0] === 'close')?.[1];
      closeHandler(1000, Buffer.from(''));

      // Wait for reconnect interval (default 5000ms)
      await vi.advanceTimersByTimeAsync(5000);

      expect(WebSocket).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it('should not reconnect if manually disconnected', async () => {
      vi.useFakeTimers();

      const connectPromise = client.connect();
      const openHandler = mockWs.on.mock.calls.find((call: any) => call[0] === 'open')?.[1];
      openHandler();
      await connectPromise;

      client.disconnect();

      await vi.advanceTimersByTimeAsync(10000);

      expect(WebSocket).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it('should respect custom reconnect interval', async () => {
      vi.useFakeTimers();

      const customClient = new WebSocketClient(serverUrl, deviceId, { reconnectInterval: 1000 });
      const connectPromise = customClient.connect();

      const openHandler = mockWs.on.mock.calls.find((call: any) => call[0] === 'open')?.[1];
      openHandler();
      await connectPromise;

      const closeHandler = mockWs.on.mock.calls.find((call: any) => call[0] === 'close')?.[1];
      closeHandler(1000, Buffer.from(''));

      await vi.advanceTimersByTimeAsync(1000);

      expect(WebSocket).toHaveBeenCalledTimes(2);

      customClient.disconnect();
      vi.useRealTimers();
    });
  });

  describe('heartbeat mechanism', () => {
    it('terminates an unresponsive socket so that reconnection can start', async () => {
      vi.useFakeTimers();
      const connect = client.connect();
      mockWs.on.mock.calls.find(([event]) => event === 'open')[1]();
      await connect;
      vi.advanceTimersByTime(30000);
      expect(mockWs.terminate).not.toHaveBeenCalled();
      const onMessage = mockWs.on.mock.calls.find(([event]) => event === 'message')[1];
      onMessage(Buffer.from(JSON.stringify({ type: 'heartbeat' })));
      vi.advanceTimersByTime(30000);
      expect(mockWs.terminate).not.toHaveBeenCalled();
      vi.advanceTimersByTime(15000);
      expect(mockWs.terminate).toHaveBeenCalledOnce();
      client.disconnect();
      vi.useRealTimers();
    });

    it('should respect custom heartbeat interval', async () => {
      vi.useFakeTimers();

      const customClient = new WebSocketClient(serverUrl, deviceId, { heartbeatInterval: 5000 });
      const connectPromise = customClient.connect();

      const openHandler = mockWs.on.mock.calls.find((call: any) => call[0] === 'open')?.[1];
      openHandler();
      await connectPromise;

      mockWs.send.mockClear();

      await vi.advanceTimersByTimeAsync(5000);

      expect(mockWs.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"heartbeat"')
      );

      customClient.disconnect();
      vi.useRealTimers();
    });

    it('should stop heartbeat on disconnect', async () => {
      vi.useFakeTimers();

      const connectPromise = client.connect();
      const openHandler = mockWs.on.mock.calls.find((call: any) => call[0] === 'open')?.[1];
      openHandler();
      await connectPromise;

      client.disconnect();
      mockWs.send.mockClear();

      await vi.advanceTimersByTimeAsync(60000);

      expect(mockWs.send).not.toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe('message handling', () => {
    it('should handle incoming messages', async () => {
      const messageHandler = vi.fn();
      client.onMessage(messageHandler);

      const connectPromise = client.connect();
      const openHandler = mockWs.on.mock.calls.find((call: any) => call[0] === 'open')?.[1];
      openHandler();
      await connectPromise;

      const messageCallback = mockWs.on.mock.calls.find((call: any) => call[0] === 'message')?.[1];
      const testMessage = { type: 'command', data: 'test' };
      messageCallback(JSON.stringify(testMessage));

      expect(messageHandler).toHaveBeenCalledWith(testMessage);
    });

    it('should handle malformed messages gracefully', async () => {
      const messageHandler = vi.fn();
      client.onMessage(messageHandler);

      const connectPromise = client.connect();
      const openHandler = mockWs.on.mock.calls.find((call: any) => call[0] === 'open')?.[1];
      openHandler();
      await connectPromise;

      const messageCallback = mockWs.on.mock.calls.find((call: any) => call[0] === 'message')?.[1];
      messageCallback('invalid json');

      expect(messageHandler).not.toHaveBeenCalled();
    });

    it('should send messages when connected', async () => {
      const connectPromise = client.connect();
      const openHandler = mockWs.on.mock.calls.find((call: any) => call[0] === 'open')?.[1];
      openHandler();
      await connectPromise;

      mockWs.send.mockClear();

      const testMessage = { type: 'result', data: 'test' };
      client.send(testMessage);

      expect(mockWs.send).toHaveBeenCalledWith(JSON.stringify(testMessage));
    });

    it('should throw error when sending message if not connected', () => {
      const testMessage = { type: 'result', data: 'test' };

      expect(() => client.send(testMessage)).toThrow('Not connected');
    });
  });

  describe('connection state', () => {
    it('should return correct connection state', async () => {
      expect(client.isConnected()).toBe(false);

      const connectPromise = client.connect();
      expect(client.isConnected()).toBe(false);

      const openHandler = mockWs.on.mock.calls.find((call: any) => call[0] === 'open')?.[1];
      openHandler();
      await connectPromise;

      expect(client.isConnected()).toBe(true);

      client.disconnect();
      expect(client.isConnected()).toBe(false);
    });

    it('should provide connection status details', async () => {
      const status = client.getStatus();
      expect(status).toHaveProperty('connected');
      expect(status).toHaveProperty('serverUrl');
      expect(status).toHaveProperty('deviceId');
      expect(status.connected).toBe(false);
      expect(status.serverUrl).toBe(serverUrl);
      expect(status.deviceId).toBe(deviceId);
    });
  });

  describe('error handling', () => {
    it('should emit error events', async () => {
      const errorHandler = vi.fn();
      client.onError(errorHandler);

      const connectPromise = client.connect();

      const wsErrorHandler = mockWs.on.mock.calls.find((call: any) => call[0] === 'error')?.[1];
      const testError = new Error('WebSocket error');
      wsErrorHandler(testError);

      await connectPromise.catch(() => {});

      expect(errorHandler).toHaveBeenCalledWith(testError);
    });

    it('should emit close events', async () => {
      const closeHandler = vi.fn();
      client.onClose(closeHandler);

      const connectPromise = client.connect();
      const openHandler = mockWs.on.mock.calls.find((call: any) => call[0] === 'open')?.[1];
      openHandler();
      await connectPromise;

      const wsCloseHandler = mockWs.on.mock.calls.find((call: any) => call[0] === 'close')?.[1];
      wsCloseHandler(1000, Buffer.from('Normal closure'));

      expect(closeHandler).toHaveBeenCalledWith(1000, 'Normal closure');
    });

    it('should emit connect events', async () => {
      const connectHandler = vi.fn();
      client.onConnect(connectHandler);

      const connectPromise = client.connect();

      const openHandler = mockWs.on.mock.calls.find((call: any) => call[0] === 'open')?.[1];
      openHandler();

      await connectPromise;

      expect(connectHandler).toHaveBeenCalled();
    });
  });

  describe('message lifecycle', () => {

    it('should handle rapid message sending', async () => {
      const connectPromise = client.connect();
      const openHandler = mockWs.on.mock.calls.find((call: any) => call[0] === 'open')?.[1];
      openHandler();
      await connectPromise;

      mockWs.send.mockClear();

      // Send multiple messages rapidly
      for (let i = 0; i < 10; i++) {
        client.send({ type: 'test', data: i });
      }

      expect(mockWs.send).toHaveBeenCalledTimes(10);
    });
  });

  describe('cleanup', () => {
    it('should clean up resources on disconnect', async () => {
      const connectPromise = client.connect();
      const openHandler = mockWs.on.mock.calls.find((call: any) => call[0] === 'open')?.[1];
      openHandler();
      await connectPromise;

      client.disconnect();

      expect(mockWs.close).toHaveBeenCalled();
    });

    it('should remove all event listeners on disconnect', async () => {
      const messageHandler = vi.fn();
      const errorHandler = vi.fn();
      const closeHandler = vi.fn();

      client.onMessage(messageHandler);
      client.onError(errorHandler);
      client.onClose(closeHandler);

      const connectPromise = client.connect();
      const openHandler = mockWs.on.mock.calls.find((call: any) => call[0] === 'open')?.[1];
      openHandler();
      await connectPromise;

      client.disconnect();

      // Handlers should not be called after disconnect
      expect(messageHandler).not.toHaveBeenCalled();
      expect(errorHandler).not.toHaveBeenCalled();
      expect(closeHandler).not.toHaveBeenCalled();
    });
  });
});
