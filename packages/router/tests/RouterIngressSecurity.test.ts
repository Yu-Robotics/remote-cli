import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { request } from 'http';
import { once, EventEmitter } from 'events';
import { generateKeyPairSync, sign } from 'crypto';
import { WebSocket } from 'ws';
import { RouterServer } from '../src/server';
import { JsonStore } from '../src/storage/JsonStore';
import { DEFAULT_CONFIG } from '../src/types/config';
import { INGRESS_LIMITS } from '../src/security/IngressAdmission';

vi.mock('../src/feishu/FeishuLongConnHandler', () => ({
  FeishuLongConnHandler: class { constructor() { return new Proxy({}, {
    get(target: any, key) { return target[key] ??= vi.fn(async () => undefined); },
    set(target: any, key, value) { target[key] = value; return true; },
  }); } },
}));

describe('Router public ingress security with real HTTP and WebSocket transports', () => {
  let root: string;
  let server: any;
  let store: JsonStore;
  let base: string;
  let sockets: WebSocket[];
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'router-ingress-')));
    sockets = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    store = new JsonStore(path.join(root, 'bindings.json'), 0);
    await store.initialize();
    const values = { ...DEFAULT_CONFIG, server: { ...DEFAULT_CONFIG.server, port: 0, host: '127.0.0.1' },
      files: { enabled: false }, tips: { enabled: false }, websocket: { heartbeatInterval: 60_000 } };
    const config = { getConfigPath: () => path.join(root, 'config.json'),
      get: (section: keyof typeof values, key?: string) => key ? (values[section] as any)?.[key] : values[section] };
    server = new RouterServer(config as any, store);
    await server.start();
    if (!server.httpServer.listening) await once(server.httpServer, 'listening');
    base = `http://127.0.0.1:${server.httpServer.address().port}`;
  });
  afterEach(async () => {
    vi.useRealTimers();
    for (const socket of sockets) if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    await server.stop();
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });
  const http = (url: string, body?: unknown, headers: Record<string, string> = {}) => new Promise<any>((resolve, reject) => {
    const req = request(`${base}${url}`, { method: body === undefined ? 'GET' : 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', ...headers } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let data: any; try { data = JSON.parse(text); } catch { data = text; }
        resolve({ status: res.statusCode, headers: res.headers, body: data });
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  async function connect() {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws'); sockets.push(ws);
    await once(ws, 'open'); return ws;
  }
  const next = async (ws: WebSocket) => JSON.parse(String((await once(ws, 'message'))[0]));
  async function register(ws: WebSocket, id: string, signature?: string) {
    const message = next(ws);
    ws.send(JSON.stringify({ type: 'binding_request', data: { deviceId: id, ...(signature ? { deviceSignature: signature } : {}) } }));
    return message;
  }
  function synthetic(peer = '192.0.2.1') {
    const socket: any = new EventEmitter();
    socket.readyState = WebSocket.OPEN;
    socket.send = vi.fn();
    socket.terminate = vi.fn(() => { socket.readyState = WebSocket.CLOSED; socket.emit('close'); });
    socket.close = socket.terminate;
    server.wss.emit('connection', socket, { socket: { remoteAddress: peer }, headers: { 'x-forwarded-for': '198.51.100.1' } });
    return socket;
  }

  it('redacts public health while preserving internal stats and rejects HTTP callbacks without dispatch', async () => {
    const ws = await connect(); await register(ws, 'synthetic-device');
    expect((await http('/health')).body).toEqual({ status: 'ok', timestamp: expect.any(Number), connections: 1 });
    expect(server.connectionHub.getConnectionStats().deviceIds).toEqual(['synthetic-device']);
    const callback = server.feishuLongConnHandler.handleCardAction;
    expect((await http('/api/feishu/card-callback', { event: { action: {} } })).status).toBe(404);
    expect(callback).not.toHaveBeenCalled();
  });
  it('rejects target floods and oversized HTTP bodies before persistence', async () => {
    const write = vi.spyOn(server.bindingManager, 'generateBindingCode');
    for (let i = 0; i < 3; i++) expect((await http('/api/bind/request', { deviceId: 'target' })).status).toBe(200);
    const refused = await http('/api/bind/request', { deviceId: 'target' });
    expect(refused.status).toBe(429); expect(refused.headers['retry-after']).toBe('300');
    expect(write).toHaveBeenCalledTimes(3);
    expect((await http('/api/bind/request', { deviceId: 'other', deviceName: 'x'.repeat(17_000) })).status).toBe(413);
    expect(write).toHaveBeenCalledTimes(3);
  });
  it('returns 429 for a persisted target cap even when this process has no target rate history', async () => {
    for (let i = 0; i < 3; i++) await store.setBindingCode(`existing-${i}`, {
      code: `existing-${i}`, deviceId: 'persisted-target', createdAt: Date.now(), expiresAt: Date.now() + 300_000,
    });
    const rename = vi.spyOn(fs, 'rename');
    const response = await http('/api/bind/request', { deviceId: 'persisted-target' });
    expect(response.status).toBe(429); expect(response.headers['retry-after']).toBe('300');
    expect(rename).not.toHaveBeenCalled(); expect(store.getStats().bindingCodes).toBe(3);
  });
  it('uses the socket peer rather than forwarded headers for pre-parser binding rate limits', async () => {
    const write = vi.spyOn(server.bindingManager, 'generateBindingCode');
    for (let i = 0; i < 128; i++) expect((await http('/api/bind/request', {}, { 'X-Forwarded-For': `192.0.2.${i}` })).status).toBe(400);
    const denied = await http('/api/bind/request', { deviceId: 'not-persisted' }, { 'X-Forwarded-For': '198.51.100.1' });
    expect(denied.status).toBe(429); expect(denied.headers['retry-after']).toBe('300');
    expect(write).not.toHaveBeenCalled();
  });
  it('bounds preauth size before JSON parsing and actual fragmented assembly using ws maxPayload', async () => {
    const ws = await connect();
    const closed = once(ws, 'close');
    ws.send('x'.repeat(INGRESS_LIMITS.preauthBytes + 1));
    await closed;
    expect(server.pendingSockets.size).toBe(0);
    // Register first so this exercises ws assembly, independently of preauth JSON limits.
    const registered = await connect(); await register(registered, 'fragmented');
    const result = once(registered, 'close');
    const chunk = Buffer.alloc(1024 * 1024, 32);
    for (let i = 0; i < 17; i++) registered.send(chunk, { fin: i === 16, binary: false });
    expect((await result)[0]).toBe(1009);
  });
  it('bounds cumulative preauth fragmentation before JSON parsing', async () => {
    const ws = await connect();
    const closed = once(ws, 'close');
    for (let i = 0; i < 3; i++) ws.send(' '.repeat(8192), { fin: false });
    await closed;
    expect(server.pendingSockets.size).toBe(0);
  });
  it('bounds tiny fragmented wire frames before any complete JSON message exists', async () => {
    const ws = await connect();
    const closed = once(ws, 'close');
    for (let i = 0; i < 17; i++) ws.send(' ', { fin: false });
    await closed;
    expect(server.pendingSockets.size).toBe(0);
  });
  it('preserves a 25 legacy plus 25 enrolled registration and reconnect burst behind one NAT', async () => {
    const key = generateKeyPairSync('ed25519', { publicKeyEncoding: { format: 'pem', type: 'spki' }, privateKeyEncoding: { format: 'pem', type: 'pkcs8' } });
    vi.spyOn(server.deviceAuth, 'get').mockImplementation(async (id: string) => id.startsWith('enrolled-') ? { openId: 'owner', publicKey: key.publicKey } : undefined);
    // Use real challenge and signature verification against synthetic approved records.
    server.deviceAuth.records = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`enrolled-${i}`, { openId: 'owner', publicKey: key.publicKey }]));
    vi.spyOn(server.bindingManager, 'getDeviceBinding').mockResolvedValue({ openId: 'owner' });
    for (let burst = 0; burst < 2; burst++) {
      const peers = await Promise.all(Array.from({ length: 50 }, () => connect()));
      await Promise.all(peers.map(async (ws, i) => {
        const id = i < 25 ? `legacy-${i}` : `enrolled-${i - 25}`;
        let response = await register(ws, id);
        if (i >= 25) {
          expect(response.type).toBe('device_challenge');
          const signature = sign(null, Buffer.from(`remote-cli-device-v1\n${id}\n${response.data.nonce}`), key.privateKey).toString('base64');
          response = await register(ws, id, signature);
        }
        expect(response.type).toBe('binding_confirm');
      }));
      expect(server.pendingSockets.size).toBe(0);
    }
    expect(server.connectionHub.getConnectionStats().totalConnections).toBe(50);
    // Registered peers retain the larger message budget (catalogs, recovery and images).
    const ws = sockets[sockets.length - 1];
    const response = next(ws);
    ws.send(JSON.stringify({ type: 'heartbeat', padding: 'x'.repeat(3 * 1024 * 1024) }));
    expect((await response).type).toBe('heartbeat');
  });
  it('enforces a fixed deadline despite heartbeats and releases pending state on stop', async () => {
    vi.useFakeTimers();
    const ws = synthetic();
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(5000);
      ws.emit('message', Buffer.from('{"type":"heartbeat"}'));
    }
    expect(ws.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(ws.terminate).toHaveBeenCalledOnce(); expect(server.pendingSockets.size).toBe(0);
    const pending = synthetic();
    vi.useRealTimers(); await server.stop();
    expect(pending.terminate).toHaveBeenCalledOnce(); expect(server.pendingSockets.size).toBe(0);
  });
  it('bounds nonloopback NAT pending sockets and releases close/error resources idempotently', () => {
    const peers = Array.from({ length: 64 }, () => synthetic());
    expect(synthetic().terminate).toHaveBeenCalledOnce();
    expect(server.pendingSockets.size).toBe(64);
    peers[0].emit('error', new Error('Synthetic transport error'));
    peers[0].emit('close'); peers[1].terminate();
    expect(server.pendingSockets.size).toBe(62);
    const replacement = synthetic();
    expect(replacement.terminate).not.toHaveBeenCalled();
  });
  it.each([
    { registered: true, state: WebSocket.CLOSING, terminate: false },
    { registered: true, state: WebSocket.CLOSED, terminate: false },
    { registered: true, state: WebSocket.OPEN, terminate: true },
    { registered: false, state: WebSocket.CLOSING, terminate: true },
    { registered: false, state: WebSocket.OPEN, terminate: true },
  ])('cleans up an error without aborting a registered close handshake: %j', async scenario => {
    vi.useFakeTimers();
    const ws = synthetic();
    if (scenario.registered) {
      await ws.listeners('message')[0](Buffer.from('{"type":"binding_request","data":{"deviceId":"closing-device"}}'));
      expect(server.connectionHub.isDeviceOnline('closing-device')).toBe(true);
    }
    // The receiver starts close(1009) before emitting its payload error. Its
    // close frame may still be buffered; the Router must let ws finish sending it.
    ws.readyState = scenario.state;
    if (scenario.state === WebSocket.CLOSED) ws.emit('close');
    ws.emit('error', new Error('Synthetic receiver payload error'));
    expect(ws.terminate).toHaveBeenCalledTimes(scenario.terminate ? 1 : 0);
    expect(server.pendingSockets.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    if (scenario.registered && scenario.state === WebSocket.CLOSING) {
      expect(server.connectionHub.isCurrentConnection('closing-device', ws)).toBe(true);
      // The transport owns its bounded close handshake; the eventual close event
      // still removes the current connection and performs Router cleanup.
      ws.readyState = WebSocket.CLOSED;
      ws.emit('close');
      expect(server.connectionHub.getConnectionStats().totalConnections).toBe(0);
    }
  });
  it.each(['close', 'error', 'deadline', 'stop'])('does not register after an authentication lookup loses its admission: %s', async mode => {
    let release!: (value: undefined) => void;
    vi.spyOn(server.deviceAuth, 'get').mockReturnValue(new Promise(resolve => { release = resolve; }));
    const registerHub = vi.spyOn(server.connectionHub, 'registerConnection');
    vi.useFakeTimers();
    const ws = synthetic();
    const execution = ws.listeners('message')[0](Buffer.from('{"type":"binding_request","data":{"deviceId":"late"}}'));
    if (mode === 'close') ws.terminate();
    if (mode === 'error') ws.emit('error', new Error('Synthetic transport error'));
    if (mode === 'deadline') await vi.advanceTimersByTimeAsync(30_000);
    if (mode === 'stop') { vi.useRealTimers(); await server.stop(); }
    release(undefined);
    await execution;
    expect(registerHub).not.toHaveBeenCalled();
    expect(server.pendingSockets.size).toBe(0);
  });
  it('does not admit a competing registration while the first authentication lookup is pending', async () => {
    let release!: (value: undefined) => void;
    const lookup = vi.spyOn(server.deviceAuth, 'get').mockReturnValue(new Promise(resolve => { release = resolve; }));
    const hub = vi.spyOn(server.connectionHub, 'registerConnection');
    const ws = synthetic();
    const execution = ws.listeners('message')[0](Buffer.from('{"type":"binding_request","data":{"deviceId":"first"}}'));
    await ws.listeners('message')[0](Buffer.from('{"type":"binding_request","data":{"deviceId":"second"}}'));
    expect(lookup).toHaveBeenCalledTimes(1);
    release(undefined); await execution;
    expect(hub).toHaveBeenCalledTimes(1);
    expect(hub).toHaveBeenCalledWith('first', ws);
    expect(server.pendingSockets.size).toBe(0);
  });
  it.each(['register', 'close', 'error'])('detaches the public wire observer after %s', async outcome => {
    const peer = Object.assign(new EventEmitter(), { remoteAddress: '192.0.2.10' });
    const ws: any = new EventEmitter(); ws.readyState = WebSocket.OPEN;
    ws.send = vi.fn(); ws.terminate = vi.fn(() => { ws.readyState = WebSocket.CLOSED; ws.emit('close'); });
    ws.close = ws.terminate;
    server.wss.emit('connection', ws, { socket: peer });
    expect(peer.listenerCount('data')).toBe(1);
    if (outcome === 'register') {
      await ws.listeners('message')[0](Buffer.from('{"type":"binding_request","data":{"deviceId":"wire-cleanup"}}'));
    } else if (outcome === 'close') ws.terminate();
    else ws.emit('error', new Error('Synthetic transport error'));
    expect(peer.listenerCount('data')).toBe(0); expect(server.pendingSockets.size).toBe(0);
  });
  it('counts unregistered control frames and messages before parsing', () => {
    const ws = synthetic();
    for (let i = 0; i < 17; i++) ws.emit(i % 2 ? 'ping' : 'pong', Buffer.alloc(0));
    expect(ws.terminate).toHaveBeenCalled(); expect(server.pendingSockets.size).toBe(0);
  });
});
