import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { generateKeyPairSync, sign } from 'crypto';
import { once } from 'events';
import { WebSocket } from 'ws';
import { RouterServer } from '../src/server';
import { JsonStore } from '../src/storage/JsonStore';
import { FeishuLongConnHandler } from '../src/feishu/FeishuLongConnHandler';

interface TestKeys { publicKey: string; privateKey: string }

describe('fresh device binding with first key enrollment', () => {
  let root: string;
  let server: RouterServer | undefined;
  let origin: string;
  let sockets: WebSocket[];

  const keys = (): TestKeys => generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const proof = (key: TestKeys, deviceId: string, nonce: string) => sign(null,
    Buffer.from(`remote-cli-device-v1\n${deviceId}\n${nonce}`), key.privateKey).toString('base64');

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'router-first-enrollment-')));
    sockets = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(FeishuLongConnHandler.prototype, 'start').mockResolvedValue(undefined);
    vi.spyOn(FeishuLongConnHandler.prototype, 'stop').mockResolvedValue(undefined);
    await startServer();
  });

  afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    await server?.stop();
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function startServer(): Promise<void> {
    const config: any = {
      getConfigPath: () => path.join(root, 'config.json'),
      get: (section: string, key?: string) => {
        if (section === 'server') return key === 'port' ? 0 : key === 'host' ? '127.0.0.1' : 'test';
        if (section === 'websocket') return 30_000;
        if (section === 'tips') return { enabled: false };
        return 'fixture';
      },
    };
    const store = new JsonStore(path.join(root, 'bindings.json'), 0);
    await store.initialize();
    server = new RouterServer(config, store);
    (server as any).feishuLongConnHandler.replyToMessage = vi.fn().mockResolvedValue(undefined);
    await server.start();
    const http = (server as any).httpServer;
    if (!http.listening) await once(http, 'listening');
    origin = `http://127.0.0.1:${http.address().port}`;
  }

  async function restartServer(): Promise<void> {
    for (const socket of sockets) socket.terminate();
    sockets = [];
    await server?.stop();
    server = undefined;
    await startServer();
  }

  async function requestCode(deviceId: string, key: TestKeys): Promise<string> {
    const nonce = 'a'.repeat(64);
    const response = await fetch(`${origin}/api/bind/request`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, devicePublicKey: key.publicKey, nonce, signature: proof(key, deviceId, nonce) }),
    });
    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(body.deviceAuth).toBe(true);
    return body.bindingCode;
  }

  async function redeem(openId: string, code: string): Promise<void> {
    await (server as any).feishuLongConnHandler.handleBindCommand(openId, 'synthetic-message', code);
  }

  function replies(): string[] {
    return (server as any).feishuLongConnHandler.replyToMessage.mock.calls.map((call: any[]) => call[1]);
  }

  async function connect(deviceId: string) {
    const ws = new WebSocket(`${origin.replace('http:', 'ws:')}/ws`);
    sockets.push(ws);
    const messages: any[] = [];
    ws.on('message', data => messages.push(JSON.parse(data.toString())));
    await once(ws, 'open');
    const send = (signature?: string) => ws.send(JSON.stringify({
      type: 'binding_request', data: {
        deviceId, protocolVersion: 1,
        capabilities: { fileTransferV1: true, outputFilesV1: true },
        ...(signature ? { deviceSignature: signature } : {}),
      },
    }));
    const next = async (type: string) => {
      try {
        await vi.waitFor(() => expect(messages.some(message => message.type === type)).toBe(true));
      } catch (error) {
        throw new Error(`Missing ${type}; received ${JSON.stringify(messages)}`, { cause: error });
      }
      return messages.find(message => message.type === type);
    };
    return { ws, messages, send, next };
  }

  async function expectAuthenticated(deviceId: string, key: TestKeys): Promise<void> {
    const client = await connect(deviceId);
    client.send();
    const challenge = await client.next('device_challenge');
    client.send(proof(key, deviceId, challenge.data.nonce));
    const confirmation = await client.next('binding_confirm');
    expect(confirmation.data.capabilities.fileTransferV1).toBe(true);
    expect(confirmation.data.capabilities.outputFilesV1).toBe(true);
  }

  it('binds and enrolls a fresh device through real HTTP and signed WebSocket negotiation', async () => {
    const key = keys();
    const code = await requestCode('fresh-device', key);
    await redeem('owner', code);

    expect(replies().at(-1)).toContain('Device key approved. Start the upgraded CLI.');
    expect(replies().at(-1)).toContain('first device and will be set as active');
    expect((server as any).deviceAuth.isCurrent('fresh-device', { openId: 'owner', publicKey: key.publicKey })).toBe(true);
    await expect((server as any).bindingManager.getDeviceBinding('fresh-device')).resolves.toMatchObject({ openId: 'owner' });
    const binding = await (server as any).bindingManager.getDeviceBinding('fresh-device');
    expect(binding.devices[0].requiresDeviceAuth).toBeUndefined();
    await expectAuthenticated('fresh-device', key);
  });

  it('retains the code and auth-required marker across failure and restart until same-owner retry', async () => {
    const key = keys();
    const code = await requestCode('fresh-device', key);
    vi.spyOn((server as any).deviceAuth, 'enroll').mockRejectedValueOnce(new Error('synthetic key write failure'));
    await redeem('owner', code);

    expect(replies().at(-1)).toContain('Binding failed');
    await expect((server as any).bindingManager.verifyBindingCode(code)).resolves.not.toBeNull();
    let binding = await (server as any).bindingManager.getDeviceBinding('fresh-device');
    expect(binding.devices[0].requiresDeviceAuth).toBe(true);
    const refused = await connect('fresh-device');
    refused.send();
    expect((await refused.next('error')).data.code).toBe('DEVICE_AUTH_REQUIRED');
    expect(refused.messages.some(message => message.type === 'binding_confirm')).toBe(false);

    await restartServer();
    const afterRestart = await connect('fresh-device');
    afterRestart.send();
    expect((await afterRestart.next('error')).data.code).toBe('DEVICE_AUTH_REQUIRED');
    expect(afterRestart.messages.some(message => message.type === 'binding_confirm')).toBe(false);

    await redeem('owner', code);
    expect(replies().at(-1)).toContain('Device key approved. Start the upgraded CLI.');
    await expect((server as any).bindingManager.verifyBindingCode(code)).resolves.toBeNull();
    binding = await (server as any).bindingManager.getDeviceBinding('fresh-device');
    expect(binding.devices[0].requiresDeviceAuth).toBeUndefined();
    await expectAuthenticated('fresh-device', key);
  });

  it('disconnects an existing legacy socket and rejects registration during the key write', async () => {
    const legacy = await connect('fresh-device');
    legacy.send();
    await legacy.next('binding_confirm');
    expect((server as any).connectionHub.isDeviceOnline('fresh-device')).toBe(true);

    const key = keys();
    const code = await requestCode('fresh-device', key);
    const auth = (server as any).deviceAuth;
    const enroll = auth.enroll.bind(auth);
    let release!: () => void;
    let started!: () => void;
    const approvalStarted = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(auth, 'enroll').mockImplementationOnce(async (...args: any[]) => {
      started();
      await gate;
      return enroll(...args);
    });
    const redeeming = redeem('owner', code);
    await approvalStarted;

    expect((server as any).connectionHub.isDeviceOnline('fresh-device')).toBe(false);
    const racing = await connect('fresh-device');
    racing.send();
    expect((await racing.next('error')).data.code).toBe('DEVICE_AUTH_REQUIRED');
    expect(racing.messages.some(message => message.type === 'binding_confirm')).toBe(false);

    release();
    await redeeming;
    await expectAuthenticated('fresh-device', key);
  });

  it('does not register a socket closed during the final authentication lookup', async () => {
    const client = await connect('closing-device');
    const peer: WebSocket = [...(server as any).wss.clients][0] as WebSocket;
    const registered = vi.spyOn((server as any).connectionHub, 'registerConnection');
    const auth = (server as any).deviceAuth;
    const lookup = auth.get.bind(auth);
    let release!: () => void;
    let started!: () => void;
    const lookupStarted = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    vi.spyOn(auth, 'get').mockImplementation(async (deviceId: string) => {
      const record = await lookup(deviceId);
      if (++calls === 2) { started(); await gate; }
      return record;
    });
    client.send();
    await lookupStarted;
    const closed = once(peer, 'close');
    client.ws.close();
    await closed;
    release();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(registered).not.toHaveBeenCalled();
  });

  it('does not let a pre-approval authentication lookup complete as credentialless', async () => {
    const key = keys();
    const client = await connect('fresh-device');
    const auth = (server as any).deviceAuth;
    const lookup = auth.get.bind(auth);
    let release!: () => void;
    let started!: () => void;
    const lookupStarted = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(auth, 'get').mockImplementationOnce(async (deviceId: string) => {
      const beforeApproval = await lookup(deviceId);
      started();
      await gate;
      return beforeApproval;
    });
    client.send();
    await lookupStarted;

    const code = await requestCode('fresh-device', key);
    await redeem('owner', code);
    release();
    expect((await client.next('error')).data.code).toBe('DEVICE_AUTH_REQUIRED');
    expect(client.messages.some(message => message.type === 'binding_confirm')).toBe(false);
    await expectAuthenticated('fresh-device', key);
  });
});
