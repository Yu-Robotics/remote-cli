import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Koa from 'koa';
import { expect, it, vi } from 'vitest';
import { RouterServer } from '../../../router/src/server';
import { FeishuLongConnHandler } from '../../../router/src/feishu/FeishuLongConnHandler';
import { JsonStore } from '../../../router/src/storage/JsonStore';
import { DEFAULT_CONFIG } from '../../../router/src/types/config';
import type { ConfigManager as RouterConfig } from '../../../router/src/config/ConfigManager';
import { MessageHandler } from '../../src/client/MessageHandler';
import { WebSocketClient } from '../../src/client/WebSocketClient';
import { ConfigManager } from '../../src/config/ConfigManager';
import type { ExecuteOptions } from '../../src/executor/IExecutor';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { ThreadExecutorPool } from '../../src/thread/ThreadExecutorPool';
import { ThreadManager } from '../../src/thread/ThreadManager';

vi.mock('../../../router/src/feishu/FeishuLongConnHandler');

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

it('recovers a foreground failure completed offline and delivers the next reply once to its owner and thread', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'task-reconnect-')));
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  vi.spyOn(os, 'homedir').mockReturnValue(root);
  const finishPrompt = gate();
  const registerAgain = gate();
  let router: RouterServer | undefined;
  let ws: WebSocketClient | undefined;
  let handler: MessageHandler | undefined;
  try {
    const openId = 'fixture-owner';
    const deviceId = 'fixture-device';
    const store = new JsonStore(path.join(root, 'bindings.json'), 0);
    await store.initialize();
    await store.setUserBinding(openId, { openId, createdAt: 1, updatedAt: 1, activeDeviceId: deviceId,
      devices: [{ deviceId, deviceName: 'Fixture', boundAt: 1, lastActiveAt: 1, isActive: true }] });
    const values = { ...DEFAULT_CONFIG, server: { ...DEFAULT_CONFIG.server, host: '127.0.0.1', port: 0 },
      files: { enabled: false }, tips: { enabled: false } };
    const listen = vi.spyOn(Koa.prototype, 'listen');
    router = new RouterServer({ getConfigPath: () => path.join(root, 'router.json'),
      get(section: keyof typeof values, key?: string) { return key ? Reflect.get(values[section], key) : values[section]; },
    } as RouterConfig, store);
    const feishu = vi.mocked(vi.mocked(FeishuLongConnHandler).mock.instances[0]);
    feishu.sendStreamingStart.mockImplementation(async (_owner, _intro, _name, _cwd, id) => 'recovered-' + id);
    feishu.finalizeStreamingMessage.mockResolvedValue(true);
    const hub = feishu.setConnectionHub.mock.calls[0][0];
    const sockets = vi.spyOn(hub, 'registerConnection');
    const startCard = feishu.setOnStartStreaming.mock.calls[0][0];
    const resolveReply = feishu.setOnResolveThread.mock.calls[0][0];
    await router.start();
    const http: Server = listen.mock.results[0].value;
    if (!http.listening) await once(http, 'listening');
    const url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}/ws`;
    const config = await ConfigManager.initialize();
    await config.set('deviceId', deviceId);
    await config.set('serverUrl', url);
    const manager = await ThreadManager.initialize(root);
    const thread = await manager.createThread('original', root, 'codex');
    await manager.updateThread(thread.id, { delegation: false });
    const execute = vi.fn(async (prompt: string, options?: ExecuteOptions) => {
      if (prompt.includes('First question')) {
        await finishPrompt.promise;
        return { success: false, error: 'Fixture interruption' };
      }
      options?.onStream?.('Second answer');
      return { success: true, output: 'Second answer' };
    });
    const guard = new DirectoryGuard([root]);
    const pool = new ThreadExecutorPool(manager, guard, { type: 'codex' }, () => ({
      execute, getCurrentWorkingDirectory: () => root, setWorkingDirectory: vi.fn(),
      resetContext: vi.fn(), destroy: vi.fn(), abort: vi.fn(),
    }));
    const identity = vi.fn(async () => { await registerAgain.promise; return undefined; });
    identity.mockResolvedValueOnce(undefined);
    ws = new WebSocketClient(url, deviceId, { reconnectInterval: 10, identityLoader: identity });
    handler = new MessageHandler(ws, pool, manager, guard, config);
    const receipts: string[] = [];
    ws.onTaskResultAck(id => receipts.push(id));
    ws.onMessage(message => { void handler!.handleMessage(message); });
    const closed = gate();
    ws.onClose(closed.release);
    const wait = { timeout: 3000, interval: 10 };
    await ws.connect();
    await vi.waitFor(() => expect(sockets).toHaveBeenCalledTimes(1), wait);
    async function command(id: string, content: string, destination: { deviceId: string; threadId: string }) {
      await startCard(id, openId, 'card-' + id, destination.deviceId, destination.threadId);
      expect(await hub.sendToDevice(destination.deviceId, { type: 'command', messageId: id, openId,
        threadId: destination.threadId, content, timestamp: Date.now() })).toBe(true);
    }
    await command('first', 'First question', { deviceId, threadId: thread.id });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce(), wait);
    sockets.mock.calls[0][1].terminate();
    await closed.promise;
    finishPrompt.release();
    await vi.waitFor(() => expect(ws!.hasPendingTaskResults()).toBe(true), wait);
    registerAgain.release();
    await vi.waitFor(() => expect(ws!.hasPendingTaskResults()).toBe(false), wait);
    expect(sockets).toHaveBeenCalledTimes(2);
    expect(feishu.sendStreamingStart).toHaveBeenCalledOnce();
    const destination = await resolveReply('recovered-first', openId);
    expect(destination).toMatchObject({ deviceId, threadId: thread.id });
    expect(await resolveReply('recovered-first', 'other-owner')).toBeFalsy();
    await command('second', 'Second question', destination!);
    await vi.waitFor(() => expect(receipts).toEqual(['second']), wait);
    expect(execute.mock.calls.map(([prompt]) => prompt)).toEqual([
      expect.stringContaining('First question'), expect.stringContaining('Second question'),
    ]);
    const finals = feishu.finalizeStreamingMessage.mock.calls;
    expect(finals.map(([card, , , owner, , , , id, , , success]) => [card, owner, id, success])).toEqual([
      ['recovered-first', openId, thread.id, false], ['card-second', openId, thread.id, true],
    ]);
    expect(JSON.stringify(finals[0][1]).match(/Fixture interruption/g)).toHaveLength(1);
    expect(JSON.stringify(finals[1][1]).match(/Second answer/g)).toHaveLength(1);
    expect(feishu.sendMessage.mock.calls.filter(([, text]) => /Fixture interruption|Second answer/.test(text))).toEqual([]);
    expect(ws.hasPendingTaskResults()).toBe(false);
  } finally {
    finishPrompt.release();
    registerAgain.release();
    ws?.disconnect();
    try { await handler?.destroy(); } finally {
      try { await router?.stop(); } finally {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
      }
    }
  }
});
