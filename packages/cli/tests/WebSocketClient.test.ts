import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocketClient } from '../src/client/WebSocketClient';
import WebSocket from 'ws';
import { generateKeyPairSync, verify } from 'crypto';
import os from 'os';

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
    it.each([false, true])('recovers ordinary tasks and consumes receipts without schedule subscribers (capability %s)', async scheduleCapability => {
      const connected = client.connect();
      mockWs.on.mock.calls.find((call: any) => call[0] === 'open')[1](); await connected;
      const receive = mockWs.on.mock.calls.find((call: any) => call[0] === 'message')[1];
      const confirmation = { type: 'binding_confirm', data: { success: true,
        capabilities: { taskRecovery: true, ...(scheduleCapability ? { scheduleResultsV1: true } : {}) } } };
      receive(JSON.stringify(confirmation));
      client.trackTask({ messageId: 'ordinary-task', openId: 'owner', threadId: 'thread', threadName: 'Thread',
        backend: 'codex', cwd: os.tmpdir(), preview: 'Ordinary request' });
      expect(client.send({ type: 'stream', streamType: 'text', messageId: 'ordinary-task', chunk: 'Before disconnect' })).toBe(true);
      const close = mockWs.on.mock.calls.find((call: any) => call[0] === 'close')[1];
      close(1006, Buffer.from('Connection lost'));
      const previous = mockWs;
      mockWs = { ...previous, on: vi.fn(), send: vi.fn(), close: vi.fn() };
      const reconnected = client.connect();
      mockWs.on.mock.calls.find((call: any) => call[0] === 'open')[1](); await reconnected;
      const nextReceive = mockWs.on.mock.calls.find((call: any) => call[0] === 'message')[1];
      nextReceive(JSON.stringify(confirmation));
      const frames = () => mockWs.send.mock.calls.map((call: any[]) => JSON.parse(call[0]));
      const resumed = frames().find((frame: any) => frame.type === 'task_resume');
      expect(resumed).toMatchObject({ messageId: 'ordinary-task', taskResume: { backend: 'codex', state: 'running' } });
      nextReceive(JSON.stringify({ type: 'task_resume_ack', messageId: resumed.messageId,
        recoveryId: resumed.taskResume.recoveryId, state: 'running', success: true }));
      expect(client.canSendTaskOutput('ordinary-task')).toBe(true);
      expect(client.send({ type: 'response', messageId: 'ordinary-task', success: true, output: 'Ordinary result' })).toBe(true);
      expect(client.hasPendingTaskResults()).toBe(true);
      // Stale socket receipts cannot consume a current task's pending result.
      receive(JSON.stringify({ type: 'task_result_ack', messageId: 'ordinary-task' }));
      expect(client.hasPendingTaskResults()).toBe(true);
      nextReceive(JSON.stringify({ type: 'task_result_ack', messageId: 'ordinary-task' }));
      expect(client.hasPendingTaskResults()).toBe(false);
      expect(frames().filter((frame: any) => frame.type === 'response')).toHaveLength(1);
      expect(frames().some((frame: any) => frame.queueStarted?.source === 'schedule')).toBe(false);
    });

    it('exposes result receipts after recovery consumes them without redispatching raw frames', async () => {
      const connected = client.connect();
      mockWs.on.mock.calls.find((call: any) => call[0] === 'open')[1](); await connected;
      const message = mockWs.on.mock.calls.find((call: any) => call[0] === 'message')[1];
      const order: string[] = [];
      vi.spyOn((client as any).taskRecovery, 'acknowledge').mockImplementation(() => { order.push('recovery'); });
      const raw = vi.fn(); client.onMessage(raw);
      const remove = client.onTaskResultAck(id => { order.push(id); });
      message(Buffer.from(JSON.stringify({ type: 'task_resume_ack', messageId: 'resume' })));
      message(Buffer.from(JSON.stringify({ type: 'task_result_ack', messageId: 'result' })));
      expect(order).toEqual(['recovery', 'recovery', 'result']);
      remove(); remove();
      message(Buffer.from(JSON.stringify({ type: 'task_result_ack', messageId: 'removed' })));
      expect(order.at(-1)).toBe('recovery'); expect(raw).not.toHaveBeenCalled();
    });

    it('isolates receipt subscribers, ignores malformed IDs and supports independent removal', async () => {
      const connected = client.connect(); mockWs.on.mock.calls.find((call: any) => call[0] === 'open')[1](); await connected;
      const message = mockWs.on.mock.calls.find((call: any) => call[0] === 'message')[1];
      client.onTaskResultAck(() => { throw new Error('Synthetic subscriber failure'); });
      const handler = vi.fn(); const remove = client.onTaskResultAck(handler); client.onTaskResultAck(handler); remove();
      for (const messageId of [undefined, null, '', 42]) message(Buffer.from(JSON.stringify({ type: 'task_result_ack', messageId })));
      expect(handler).not.toHaveBeenCalled();
      message(Buffer.from(JSON.stringify({ type: 'task_result_ack', messageId: 'result' })));
      expect(handler).toHaveBeenCalledOnce(); expect(handler).toHaveBeenCalledWith('result');
    });

    it('notifies shutdown once and allows close subscriptions to be removed independently', async () => {
      const connected = client.connect(); mockWs.on.mock.calls.find((call: any) => call[0] === 'open')[1](); await connected;
      const closed = mockWs.on.mock.calls.find((call: any) => call[0] === 'close')[1];
      const handler = vi.fn(); const removed = client.onClose(handler); removed(); removed();
      client.onClose(handler);
      client.disconnect(); closed(1000, Buffer.from('')); client.disconnect();
      expect(handler).toHaveBeenCalledOnce(); expect(handler).toHaveBeenCalledWith(1000, 'Client disconnected');
    });

    it('ignores old Router confirmations and does not send a prepared request after disconnect', async () => {
      let release!: (value: any) => void;
      const prepared = new Promise<any>(resolve => { release = resolve; });
      const prepare = vi.fn(() => prepared);
      client = new WebSocketClient(serverUrl, deviceId, { automaticFileEnrollment: { prepare } as any });
      const connected = client.connect();
      mockWs.on.mock.calls.find((c: any) => c[0] === 'open')[1](); await connected;
      const message = mockWs.on.mock.calls.find((c: any) => c[0] === 'message')[1];
      message(Buffer.from(JSON.stringify({ type: 'binding_confirm', data: { success: true } })));
      expect(prepare).not.toHaveBeenCalled();
      message(Buffer.from(JSON.stringify({ type: 'binding_confirm', data: { success: true,
        capabilities: { automaticFileEnrollmentV1: true } } })));
      expect(prepare).toHaveBeenCalledOnce();
      client.disconnect();
      const identity = generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
      release(identity); await prepared; await Promise.resolve();
      expect(mockWs.send.mock.calls.some((call: any[]) => JSON.parse(call[0]).type === 'automatic_file_enrollment')).toBe(false);
      mockWs.on.mockClear();
      const reconnected = client.connect();
      mockWs.on.mock.calls.find((c: any) => c[0] === 'open')[1](); await reconnected;
      const nextMessage = mockWs.on.mock.calls.find((c: any) => c[0] === 'message')[1];
      const confirmation = Buffer.from(JSON.stringify({ type: 'binding_confirm', data: { success: true,
        capabilities: { automaticFileEnrollmentV1: true } } }));
      nextMessage(confirmation); nextMessage(confirmation);
      await prepared; await Promise.resolve();
      expect(prepare).toHaveBeenCalledTimes(2);
      expect(mockWs.send.mock.calls.filter((call: any[]) => JSON.parse(call[0]).type === 'automatic_file_enrollment')).toHaveLength(1);
    });

    it.each([false, true])('advertises delayed recovery only with native support and enrollment integration (%s)', async integrated => {
      client = new WebSocketClient(serverUrl, deviceId, integrated ? { automaticFileEnrollment: { prepare: vi.fn() } as any } : {});
      const connect = client.connect(); mockWs.on.mock.calls.find((c: any) => c[0] === 'open')[1](); await connect;
      await vi.waitFor(() => expect(mockWs.send).toHaveBeenCalled());
      const registration = mockWs.send.mock.calls.map((call: any[]) => JSON.parse(call[0])).find((m: any) => m.type === 'binding_request');
      // The helper is optional: registration truthfully reflects the native module on this runner.
      const native = await import('../src/native/NativeBindings');
      let supported = false;
      try { supported = typeof native.nativeBindings().readChunk === 'function' && typeof native.nativeBindings().openOutputChild === 'function'; } catch { /* Unsupported runner. */ }
      expect(registration.data.capabilities.pendingOutputFilesV1).toBe(supported && integrated ? true : undefined);
    });

    it('keeps ordinary message handling independent of automatic preparation failure', async () => {
      const prepare = vi.fn().mockRejectedValue(new Error('private-sentinel'));
      client = new WebSocketClient(serverUrl, deviceId, { automaticFileEnrollment: { prepare } as any });
      const received = vi.fn(); client.onMessage(received);
      const connected = client.connect(); mockWs.on.mock.calls.find((c: any) => c[0] === 'open')[1](); await connected;
      const message = mockWs.on.mock.calls.find((c: any) => c[0] === 'message')[1];
      message(Buffer.from(JSON.stringify({ type: 'binding_confirm', data: { success: true, capabilities: { automaticFileEnrollmentV1: true } } })));
      message(Buffer.from(JSON.stringify({ type: 'command', content: 'Synthetic task' })));
      await Promise.resolve();
      expect(received).toHaveBeenCalledWith({ type: 'command', content: 'Synthetic task' });
      expect(mockWs.close).not.toHaveBeenCalled();
    });

    it('logs actual close codes and per-socket epochs without close text or identities', async () => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      vi.useFakeTimers();
      try {
        const connect = client.connect();
        mockWs.on.mock.calls.find((c: any) => c[0] === 'open')[1]();
        await connect;
        const closed = mockWs.on.mock.calls.find((c: any) => c[0] === 'close')[1];
        closed(1009, Buffer.from('private-close-sentinel'));
        expect(info).toHaveBeenCalledWith('[TaskDiagnostics]', expect.objectContaining({ event: 'socket_close', connectionEpoch: 1, code: 1009, reasonBytes: 22 }));
        mockWs.on.mockClear();
        client.disconnect();
        const again = client.connect();
        mockWs.on.mock.calls.find((c: any) => c[0] === 'open')[1]();
        await again;
        expect(info).toHaveBeenCalledWith('[TaskDiagnostics]', expect.objectContaining({ event: 'socket_open', connectionEpoch: 2 }));
        expect(JSON.stringify(info.mock.calls)).not.toMatch(/private-close-sentinel|test-device-id|localhost/);
      } finally { client.disconnect(); vi.useRealTimers(); info.mockRestore(); }
    });

    it('signs fresh Router challenges without exposing the private key', async () => {
      const identity = generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
      client = new WebSocketClient(serverUrl, deviceId, { identityLoader: async () => identity });
      const connected = client.connect(); mockWs.on.mock.calls.find((c: any) => c[0] === 'open')[1](); await connected;
      await vi.waitFor(() => expect(mockWs.send).toHaveBeenCalled());
      expect(JSON.parse(mockWs.send.mock.calls[0][0]).data.capabilities.fileTransferV1).toBe(true);
      expect(JSON.parse(mockWs.send.mock.calls[0][0]).data.capabilities.activityProgress).toBe(true);
      expect(JSON.parse(mockWs.send.mock.calls[0][0]).data.capabilities.settingsCards).toBe(true);
      expect(JSON.parse(mockWs.send.mock.calls[0][0]).data.capabilities.delegationCards).toBe(true);
      expect(JSON.parse(mockWs.send.mock.calls[0][0]).data.capabilities.bankedResetReminder).toBe(true);
      const nonce = 'a'.repeat(64);
      mockWs.on.mock.calls.find((c: any) => c[0] === 'message')[1](Buffer.from(JSON.stringify({ type: 'device_challenge', data: { nonce } })));
      const proof = JSON.parse(mockWs.send.mock.calls.at(-1)[0]);
      expect(verify(null, Buffer.from(`remote-cli-device-v1\n${deviceId}\n${nonce}`), identity.publicKey, Buffer.from(proof.data.deviceSignature, 'base64'))).toBe(true);
      expect(JSON.stringify(mockWs.send.mock.calls)).not.toContain('PRIVATE');
    });
    it('fails closed when credentials cannot be loaded', async () => {
      client = new WebSocketClient(serverUrl, deviceId, { identityLoader: async () => { throw new Error('Unsafe identity'); } });
      const error = vi.fn(); client.onError(error);
      const connected = client.connect(); mockWs.on.mock.calls.find((c: any) => c[0] === 'open')[1](); await connected;
      await vi.waitFor(() => expect(error).toHaveBeenCalled());
      expect(mockWs.send).not.toHaveBeenCalled(); expect(mockWs.close).toHaveBeenCalled();
    });
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
    it('relays Router versions without telling newer clients to upgrade', async () => {
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const received = vi.fn();
        client.onMessage(received);
        const connected = client.connect();
        mockWs.on.mock.calls.find(([event]: string[]) => event === 'open')[1]();
        await connected;
        const message = { type: 'binding_confirm', data: { success: true, routerVersion: '0.0.1' } };
        mockWs.on.mock.calls.find(([event]: string[]) => event === 'message')[1](JSON.stringify(message));

        expect(received).toHaveBeenCalledWith(message);
        expect(warning).not.toHaveBeenCalled();
      } finally {
        warning.mockRestore();
      }
    });

    it('pauses reconnects after protocol rejection and explains that a restart is required', async () => {
      vi.useFakeTimers();
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const received = vi.fn();
        client.onMessage(received);
        const connected = client.connect();
        mockWs.on.mock.calls.find(([event]: string[]) => event === 'open')[1]();
        await connected;
        const message = { type: 'error', data: { code: 'PROTOCOL_VERSION_INCOMPATIBLE', message: 'Unsupported protocol' } };
        mockWs.on.mock.calls.find(([event]: string[]) => event === 'message')[1](JSON.stringify(message));
        mockWs.on.mock.calls.find(([event]: string[]) => event === 'close')[1](1000, Buffer.from('unsupported'));
        await vi.advanceTimersByTimeAsync(5000);

        expect(received).toHaveBeenCalledWith(message);
        expect(WebSocket).toHaveBeenCalledOnce();
        expect(error).toHaveBeenCalledWith(expect.stringContaining('this process restarts with a compatible CLI version'));
      } finally {
        error.mockRestore();
        vi.useRealTimers();
      }
    });

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
      expect(client.canSendTaskOutput('task')).toBe(false);
      expect(client.send({ type: 'stream', messageId: 'task', chunk: 'discarded' })).toBe(false);
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
      expect(client.canSendTaskOutput('task')).toBe(false);
      callback(next, 'message')(Buffer.from(JSON.stringify({ type: 'task_resume_ack', messageId: 'task',
        recoveryId: recovery.taskResume.recoveryId, state: 'running', success: true })));
      expect(client.canSendTaskOutput('task')).toBe(true);
      expect(client.send({ type: 'stream', messageId: 'task', chunk: 'new output' })).toBe(true);
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
      expect(client.send(testMessage)).toBe(true);

      expect(mockWs.send).toHaveBeenCalledWith(JSON.stringify(testMessage));
    });

    it('should throw error when sending message if not connected', () => {
      const testMessage = { type: 'result', data: 'test' };

      expect(() => client.send(testMessage)).toThrow('Not connected');
    });

    it('rejects image backlog without disconnecting or blocking ordinary text', async () => {
      const connection = client.connect();
      mockWs.on.mock.calls.find((call: any) => call[0] === 'open')[1]();
      await connection;
      mockWs.send.mockClear();
      (mockWs as any).bufferedAmount = 9 * 1024 * 1024;
      try {
        expect(client.send({ type: 'stream', messageId: 'image', streamType: 'image', image: { data: 'synthetic' } })).toBe(false);
        expect(mockWs.send).not.toHaveBeenCalled();
        expect(client.isConnected()).toBe(true);
        expect(client.send({ type: 'stream', messageId: 'text', streamType: 'text', chunk: 'Continuing' })).toBe(true);
      } finally { delete (mockWs as any).bufferedAmount; }
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

      // Shutdown notifies close subscribers once, then removes every subscription.
      expect(closeHandler).toHaveBeenCalledOnce(); closeHandler.mockClear();
      mockWs.on.mock.calls.find((call: any) => call[0] === 'close')[1](1000, Buffer.from(''));
      mockWs.on.mock.calls.find((call: any) => call[0] === 'message')[1](Buffer.from('{"type":"command"}'));
      mockWs.on.mock.calls.find((call: any) => call[0] === 'error')[1](new Error('Late socket error'));
      expect(messageHandler).not.toHaveBeenCalled();
      expect(errorHandler).not.toHaveBeenCalled();
      expect(closeHandler).not.toHaveBeenCalled();
    });
  });
});
