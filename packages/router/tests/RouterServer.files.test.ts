import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { generateKeyPairSync, sign } from 'crypto';
import { once } from 'events';
import { WebSocket } from 'ws';
import { RouterServer } from '../src/server';
import { JsonStore } from '../src/storage/JsonStore';

// Only the remote Feishu service is replaced: HTTP, WS, enrollment and storage are real.
vi.mock('../src/feishu/FeishuLongConnHandler', () => ({ FeishuLongConnHandler: vi.fn(() => ({
  setConnectionHub() {}, setOnStartStreaming() {}, setOnResolveThread() {}, setOnResolveActiveThread() {},
  start: async () => {}, stop: async () => {}, sendMessage: vi.fn(),
})) }));

describe('authenticated file registration on real WebSockets', () => {
  let root: string; let server: RouterServer; let origin: string; let sockets: WebSocket[];
  const keys = () => generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const proof = (key: string, nonce: string) => sign(null, Buffer.from(`remote-cli-device-v1\ndevice\n${nonce}`), key).toString('base64');
  async function startServer(files?: Record<string, unknown>) {
    const config: any = { getConfigPath: () => path.join(root, 'config.json'), get: (section: string, key?: string) => {
      if (section === 'files') return files;
      if (section === 'server') return key === 'port' ? 0 : key === 'host' ? '127.0.0.1' : 'test';
      if (section === 'websocket') return 30_000;
      return 'fixture';
    } };
    const store = new JsonStore(path.join(root, 'bindings.json'), 1); await store.initialize();
    server = new RouterServer(config, store);
    await (server as any).bindingManager.bindUser('owner', 'device', 'Test device');
    await server.start();
    const http = (server as any).httpServer;
    if (!http.listening) await once(http, 'listening');
    origin = `http://127.0.0.1:${http.address().port}`;
  }
  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'router-file-auth-'))); sockets = [];
    await startServer();
  });
  afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    await server?.stop(); vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });
  async function connect() {
    const ws = new WebSocket(origin.replace('http:', 'ws:') + '/ws'); sockets.push(ws);
    await once(ws, 'open');
    const messages: any[] = []; ws.on('message', data => messages.push(JSON.parse(data.toString())));
    const send = (signature?: string, id = 'device') => ws.send(JSON.stringify({ type: 'binding_request', data: { deviceId: id, capabilities: { fileTransferV1: true }, ...(signature ? { deviceSignature: signature } : {}) } }));
    const next = async (type: string) => { await vi.waitFor(() => expect(messages.some(m => m.type === type)).toBe(true)); return messages.find(m => m.type === type); };
    return { ws, messages, send, next };
  }
  it.each([undefined, {}, { enabled: true }, { publicUrl: 'https://legacy-router.test' }])('allows explicit owner enrollment with default reception and no required URL: %j', async files => {
    await server.stop(); await startServer(files);
    const pair = keys(); const nonce = 'a'.repeat(64);
    const response = await fetch(origin + '/api/bind/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: 'device', devicePublicKey: pair.publicKey, nonce, signature: proof(pair.privateKey, nonce) }) });
    expect(response.status).toBe(200);
    const data: any = await response.json();
    expect(data.deviceAuth).toBe(true);
    expect((server as any).deviceAuth.isCurrent('device', { openId: 'owner', publicKey: pair.publicKey })).toBe(false);
  });
  it('rejects file enrollment when disabled even if an obsolete public URL remains', async () => {
    await server.stop(); await startServer({ enabled: false, publicUrl: 'https://legacy-router.test' });
    const pair = keys(); const nonce = 'a'.repeat(64);
    const response = await fetch(origin + '/api/bind/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: 'device', devicePublicKey: pair.publicKey, nonce, signature: proof(pair.privateKey, nonce) }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ success: false, error: expect.stringContaining('files.enabled=false') });
    const legacy = await fetch(origin + '/api/bind/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: 'legacy-device' }) });
    expect(legacy.status).toBe(200);
    const client = await connect(); client.send();
    expect((await client.next('binding_confirm')).data.capabilities?.fileTransferV1).not.toBe(true);
    expect((server as any).connectionHub.isDeviceOnline('device')).toBe(true);
  });
  it('keeps owner-approved device authentication but withholds file capability when disabled', async () => {
    await server.stop(); await startServer({ enabled: false });
    const pair = keys();
    await (server as any).feishuLongConnHandler.onApproveDeviceKey('owner', 'device', pair.publicKey);
    const client = await connect(); client.send();
    client.send(proof(pair.privateKey, (await client.next('device_challenge')).data.nonce));
    expect((await client.next('binding_confirm')).data.capabilities?.fileTransferV1).not.toBe(true);
    expect((server as any).connectionHub.isDeviceOnline('device')).toBe(true);
    expect((server as any).connectionHub.getFileSession('device')).toBeUndefined();
  });
  it('keeps legacy registration but never grants files to self-claimed IDs', async () => {
    const client = await connect(); client.send();
    const response = await client.next('binding_confirm');
    expect(response.data.capabilities?.fileTransferV1).not.toBe(true);
    expect((server as any).connectionHub.getFileSession('device')).toBeUndefined();
  });
  it('requires proof before replacing a bound connection and rejects cross-connection replay', async () => {
    const pair = keys(); await (server as any).feishuLongConnHandler.onApproveDeviceKey('owner', 'device', pair.publicKey);
    const client = await connect(); client.send();
    const nonce = (await client.next('device_challenge')).data.nonce;
    expect((server as any).connectionHub.isDeviceOnline('device')).toBe(false);
    const signature = proof(pair.privateKey, nonce); client.send(signature);
    expect((await client.next('binding_confirm')).data.capabilities.fileTransferV1).toBe(true);
    const original = (server as any).connectionHub.getFileSession('device');
    const attacker = await connect(); attacker.send(); await attacker.next('device_challenge');
    expect((server as any).connectionHub.getFileSession('device')).toEqual(original);
    attacker.send(signature); expect((await attacker.next('error')).data.code).toBe('DEVICE_AUTH_REQUIRED');
    expect((server as any).connectionHub.getFileSession('device')).toEqual(original);
  });
  it('requires owner-approved rotation and revocation never downgrades to legacy registration', async () => {
    const old = keys(); const replacement = keys(); const handler = (server as any).feishuLongConnHandler;
    await expect(handler.onApproveDeviceKey('stranger', 'device', old.publicKey)).rejects.toThrow('ownership');
    await handler.onApproveDeviceKey('owner', 'device', old.publicKey);
    const waiting = await connect(); waiting.send(); const challenge = await waiting.next('device_challenge');
    await handler.onApproveDeviceKey('owner', 'device', replacement.publicKey);
    waiting.send(proof(old.privateKey, challenge.data.nonce)); await waiting.next('error');
    const current = await connect(); current.send(); current.send(proof(replacement.privateKey, (await current.next('device_challenge')).data.nonce));
    await current.next('binding_confirm');
    await handler.onRevokeDevice('device');
    expect((server as any).connectionHub.getFileSession('device')).toBeUndefined();
    const legacy = await connect(); legacy.send(); await legacy.next('error');
    expect(legacy.messages.some(m => m.type === 'binding_confirm')).toBe(false);
  });
  it('validates enrollment proofs without trusting a public key submitted over HTTP', async () => {
    const pair = keys(); const nonce = 'a'.repeat(64);
    const response = await fetch(origin + '/api/bind/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: 'device', devicePublicKey: pair.publicKey, nonce, signature: proof(pair.privateKey, nonce) }) });
    const data: any = await response.json(); expect(data.deviceAuth).toBe(true);
    expect((server as any).deviceAuth.isCurrent('device', { openId: 'owner', publicKey: pair.publicKey })).toBe(false);
    const code = await (server as any).bindingManager.verifyBindingCode(data.bindingCode);
    expect(code.devicePublicKey).toBe(pair.publicKey);
    const bad = await fetch(origin + '/api/bind/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: 'device', devicePublicKey: pair.publicKey, nonce, signature: 'invalid' }) });
    expect(bad.status).toBe(400);
  });
  it('discards pre-authentication result/control messages', async () => {
    const pair = keys(); await (server as any).deviceAuth.enroll('device', 'owner', pair.publicKey);
    const receive = vi.spyOn((server as any).fileTransfers, 'handleStatus');
    const client = await connect();
    client.ws.send(JSON.stringify({ type: 'file_status', fileId: 'a'.repeat(64), status: 'saved' }));
    client.send(); await client.next('device_challenge');
    expect(receive).not.toHaveBeenCalled();
  });
});
