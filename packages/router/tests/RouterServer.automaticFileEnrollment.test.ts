import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { once } from 'events';
import { RouterServer } from '../src/server';
import { JsonStore } from '../src/storage/JsonStore';
import { FeishuLongConnHandler } from '../src/feishu/FeishuLongConnHandler';
import { WebSocketClient } from '../../cli/src/client/WebSocketClient';
import { AutomaticFileEnrollment } from '../../cli/src/files/AutomaticFileEnrollment';
import { ensureIdentity, loadIdentity } from '../../cli/src/files/DeviceIdentity';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('automatic file enrollment over the existing connection', () => {
  let root: string;
  let server: RouterServer;
  let url: string;
  let client: WebSocketClient | undefined;
  let create: ReturnType<typeof vi.spyOn>;
  let messages: any[];
  let listeners: Array<() => void>;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'auto-enrollment-wire-')));
    messages = []; listeners = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(FeishuLongConnHandler.prototype, 'start').mockResolvedValue(undefined);
    vi.spyOn(FeishuLongConnHandler.prototype, 'stop').mockResolvedValue(undefined);
    create = vi.spyOn(FeishuLongConnHandler.prototype, 'createOutputCard').mockResolvedValue('approval-card');
  });
  afterEach(async () => {
    client?.disconnect();
    await server?.stop();
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function start(enabled = true, bound = true) {
    const config: any = { getConfigPath: () => path.join(root, 'router', 'config.json'),
      get: (section: string, key?: string) => {
        if (section === 'server') return key === 'port' ? 0 : key === 'host' ? '127.0.0.1' : 'fixture';
        if (section === 'websocket') return 30_000;
        if (section === 'files') return { enabled };
        if (section === 'tips') return { enabled: false };
        return 'fixture';
      } };
    const store = new JsonStore(path.join(root, 'bindings.json'), 0); await store.initialize();
    server = new RouterServer(config, store);
    if (bound) await (server as any).bindingManager.bindUser('owner', 'device', 'Synthetic device');
    await server.start();
    const http = (server as any).httpServer;
    if (!http.listening) await once(http, 'listening');
    url = `ws://127.0.0.1:${http.address().port}/ws`;
  }

  function waitFor(predicate: (message: any) => boolean): Promise<any> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const value = messages.find(predicate);
        if (value) { clearTimeout(timer); listeners = listeners.filter(item => item !== check); resolve(value); }
      };
      const timer = setTimeout(() => { listeners = listeners.filter(item => item !== check); reject(new Error('Expected protocol phase was not reached.')); }, 10_000);
      listeners.push(check); check();
    });
  }

  async function connect(autoEnroll = true) {
    client = new WebSocketClient(url, 'device', {
      identityLoader: () => loadIdentity(root, url, 'device'),
      automaticFileEnrollment: new AutomaticFileEnrollment(root, url, 'device', autoEnroll),
      reconnectInterval: 20,
    });
    client.onMessage(message => { messages.push(message); for (const notify of [...listeners]) notify(); });
    await client.connect();
    return waitFor(message => message.type === 'binding_confirm');
  }

  function pauseAdmission() {
    const service = (server as any).automaticFileEnrollment;
    const original = service.request.bind(service);
    const entered = deferred<any[]>();
    const gate = deferred<void>();
    const completed = deferred<string>();
    vi.spyOn(service, 'request').mockImplementationOnce(async (...args: any[]) => {
      entered.resolve(args); await gate.promise;
      const result = await original(...args); completed.resolve(result); return result;
    });
    return { entered, gate, completed };
  }

  it.each(['owner', 'replacement-owner'])('never retargets a registered connection request after rebinding to %s', async replacement => {
    await start(); await connect(false);
    const bindings = (server as any).bindingManager;
    const epoch = bindings.getCardThreadEpoch('owner', 'device');
    const key = await ensureIdentity(root, url, 'device');
    const paused = pauseAdmission();
    client!.send({ type: 'automatic_file_enrollment', data: AutomaticFileEnrollment.proof(key, 'device') });
    try {
      const args = await paused.entered.promise;
      expect(args[2]).toEqual({ openId: 'owner', epoch });
      expect(Object.isFrozen(args[2])).toBe(true);
      expect(args[3]()).toBe(true);
      await bindings.unbindDevice('owner', 'device');
      await bindings.bindUser(replacement, 'device', 'Synthetic replacement device');
    } finally { paused.gate.resolve(); await paused.completed.promise; }
    expect(await paused.completed.promise).toBe('unbound');
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects admission from a disconnected socket even after a replacement connection is registered', async () => {
    await start(); await connect(false);
    const key = await ensureIdentity(root, url, 'device');
    const paused = pauseAdmission();
    client!.send({ type: 'automatic_file_enrollment', data: AutomaticFileEnrollment.proof(key, 'device') });
    try {
      const args = await paused.entered.promise;
      const socket = (server as any).connectionHub.connections.get('device');
      const closed = once(socket, 'close'); client!.disconnect(); await closed;
      messages = []; await connect(false);
      expect(args[3]()).toBe(false);
    } finally { paused.gate.resolve(); await paused.completed.promise; }
    expect(await paused.completed.promise).toBe('unbound');
    expect(create).not.toHaveBeenCalled();
  });

  it('finishes a same-owner pending notification after a valid admission loses its socket', async () => {
    await start(); await connect(false);
    const key = await ensureIdentity(root, url, 'device');
    const auth = (server as any).deviceAuth;
    const get = auth.get.bind(auth);
    const entered = deferred<void>(); const gate = deferred<void>(); const completed = deferred<string>();
    vi.spyOn(auth, 'get').mockImplementationOnce(async (...args: any[]) => {
      const snapshot = await get(...args); entered.resolve(); await gate.promise; return snapshot;
    });
    const service = (server as any).automaticFileEnrollment;
    const request = service.request.bind(service);
    vi.spyOn(service, 'request').mockImplementationOnce(async (...args: any[]) => {
      const result = await request(...args); completed.resolve(result); return result;
    });
    client!.send({ type: 'automatic_file_enrollment', data: AutomaticFileEnrollment.proof(key, 'device') });
    try {
      await entered.promise;
      const socket = (server as any).connectionHub.connections.get('device');
      const closed = once(socket, 'close'); client!.disconnect(); await closed;
    } finally { gate.resolve(); await completed.promise; }
    expect(await completed.promise).toBe('known');
    expect(create).toHaveBeenCalledWith('owner', expect.any(String), expect.any(String));
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('requests once, leaves text dispatch working, approves the exact owner/card, and reconnects signed without another prompt', async () => {
    await start();
    expect((await connect()).data.capabilities.automaticFileEnrollmentV1).toBe(true);
    await waitFor(message => message.type === 'automatic_file_enrollment_status');
    expect(create).toHaveBeenCalledTimes(1);
    const saved = (await loadIdentity(root, url, 'device'))!;
    expect(saved).toBeDefined();
    const handler = (server as any).feishuLongConnHandler as FeishuLongConnHandler;
    const value = JSON.parse(create.mock.calls[0][1]).body.elements.at(-1).behaviors[0].value;
    const callback = (owner: string, card = 'approval-card') => handler.handleCardAction({ operator: { open_id: owner },
      context: { open_message_id: card }, action: { value } });
    await callback('intruder'); await callback('owner', 'wrong-card');
    expect(await (server as any).deviceAuth.get('device')).toBeUndefined();
    // No model task is started by enrollment; ordinary messages continue on the same connection.
    await (server as any).connectionHub.sendToDevice('device', { type: 'command', messageId: 'text-phase', content: 'Synthetic text task' });
    await waitFor(message => message.messageId === 'text-phase');
    expect((await callback('owner'))?.toast.content).toContain('approved');
    const authenticated = await waitFor(message => message.type === 'binding_confirm' && message.data.capabilities?.fileTransferV1);
    expect(authenticated.data.capabilities.automaticFileEnrollmentV1).toBeUndefined();
    expect(authenticated.data.capabilities.outputFilesV1).toBe(true);
    expect((await (server as any).deviceAuth.get('device')).publicKey).toBe(saved.publicKey);
    expect(create).toHaveBeenCalledTimes(1);
    client!.disconnect(); messages = [];
    expect((await connect()).data.capabilities.fileTransferV1).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])('never prompts an already manually approved device with auto enrollment %s', async autoEnroll => {
    await start();
    const saved = await ensureIdentity(root, url, 'device');
    await (server as any).deviceAuth.enroll('device', 'owner', saved.publicKey);
    const confirmation = await connect(autoEnroll);
    expect(confirmation.data.capabilities.fileTransferV1).toBe(true);
    expect(confirmation.data.capabilities.automaticFileEnrollmentV1).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
  });

  it.each(['disabled', 'opt-out', 'unbound'])('keeps legacy text operation without approval prompts when %s', async mode => {
    await start(mode !== 'disabled', mode !== 'unbound');
    const confirmation = await connect(mode !== 'opt-out');
    if (mode !== 'opt-out') expect(confirmation.data.capabilities?.automaticFileEnrollmentV1).toBeUndefined();
    // A server round trip establishes that preceding capability handling has completed.
    client!.send({ type: 'heartbeat', messageId: 'barrier', timestamp: Date.now() });
    await waitFor(message => message.type === 'heartbeat' && message.messageId === 'barrier');
    expect(create).not.toHaveBeenCalled();
    expect(await loadIdentity(root, url, 'device')).toBeUndefined();
  });
});
