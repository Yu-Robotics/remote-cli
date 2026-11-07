import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { generateKeyPairSync, sign } from 'crypto';
import { RouterServer } from '../src/server';
import { JsonStore } from '../src/storage/JsonStore';
import type { ConfigManager } from '../src/config/ConfigManager';
import type { BindingManager } from '../src/binding/BindingManager';
import type { ThreadSelectionManager } from '../src/binding/ThreadSelectionManager';
import type { FeishuLongConnHandler } from '../src/feishu/FeishuLongConnHandler';
import type { AutomaticFileEnrollment } from '../src/files/AutomaticFileEnrollment';
import { DeviceAuth } from '../src/files/DeviceAuth';

interface RouterInternals {
  bindingManager: BindingManager;
  feishuLongConnHandler: FeishuLongConnHandler;
  automaticFileEnrollment: AutomaticFileEnrollment;
  deviceAuth: DeviceAuth;
  selections: ThreadSelectionManager;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const owner = 'synthetic-owner', device = 'synthetic-device', card = 'synthetic-approval-card';
const keys = () => generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const signature = (key: ReturnType<typeof keys>, nonce: string) => sign(null,
  Buffer.from(`remote-cli-device-v1\n${device}\n${nonce}`), key.privateKey).toString('base64');

// Construct the real Router/Feishu managers and callbacks without opening any listener or SDK connection.
describe('Router ownership and key enrollment concurrency', () => {
  let root: string;
  let store: JsonStore;
  let server: RouterServer;
  let router: RouterInternals;
  let manual: BindingManager;
  let create: ReturnType<typeof vi.spyOn>;
  let pending: Promise<unknown>[];
  let releases: Array<() => void>;

  function track<T>(operation: Promise<T>): Promise<T> {
    pending.push(operation);
    void operation.catch(() => {});
    return operation;
  }

  async function request(key = keys()) {
    const nonce = 'a'.repeat(64);
    expect(await router.automaticFileEnrollment.request(device, {
      publicKey: key.publicKey, nonce, signature: signature(key, nonce),
    })).toBe('known');
    const content = JSON.parse(create.mock.calls[0][1]);
    return { key, payload: content.body.elements.at(-1).behaviors[0].value };
  }

  function pauseInvalidation(afterInvalidation = true) {
    const entered = deferred(), release = deferred();
    releases.push(release.resolve);
    const invalidate = router.selections.invalidateDevice.bind(router.selections);
    vi.spyOn(router.selections, 'invalidateDevice').mockImplementationOnce(async (openId, deviceId) => {
      if (afterInvalidation) await invalidate(openId, deviceId);
      entered.resolve(); await release.promise;
      if (!afterInvalidation) await invalidate(openId, deviceId);
    });
    return { entered: entered.promise, release: release.resolve };
  }

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'router-enrollment-concurrency-')));
    vi.spyOn(os, 'homedir').mockReturnValue(root);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    pending = []; releases = [];
    store = new JsonStore(path.join(root, 'bindings.json'), 0);
    await store.initialize();
    const config = {
      getConfigPath: () => path.join(root, 'config.json'),
      get: (section: string) => section === 'files' ? { enabled: true }
        : section === 'tips' ? { enabled: false } : section === 'websocket' ? 30_000 : 'synthetic',
    } as unknown as ConfigManager;
    server = new RouterServer(config, store);
    router = server as unknown as RouterInternals;
    manual = router.feishuLongConnHandler.getBindingManager();
    expect(manual).not.toBe(router.bindingManager);
    create = vi.spyOn(router.feishuLongConnHandler, 'createOutputCard').mockResolvedValue(card);
    await manual.bindUser(owner, device, 'Synthetic device');
  });

  afterEach(async () => {
    releases.forEach(release => release());
    await Promise.allSettled(pending);
    await server.stop();
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each(['user', 'device'] as const)('revokes an in-flight automatic approval before %s unbind completes', async target => {
    const { key, payload } = await request();
    const gate = pauseInvalidation();
    const approving = track(router.automaticFileEnrollment.click(owner, card, payload));
    await gate.entered;
    const revoke = vi.fn(router.feishuLongConnHandler.onRevokeDevice!);
    router.feishuLongConnHandler.onRevokeDevice = revoke;
    const beforeUnbind = (deviceId: string) => router.feishuLongConnHandler.onRevokeDevice!(deviceId);
    const unbinding = target === 'user' ? track(manual.unbindUser(owner, beforeUnbind))
      : track(manual.unbindDevice(owner, device, beforeUnbind));
    // Let queued promise callbacks run while approval is paused after its epoch/auth checks.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(revoke).not.toHaveBeenCalled();
    expect(await manual.getDeviceBinding(device)).toMatchObject({ openId: owner });
    gate.release();
    await Promise.all([approving, unbinding]);
    expect(revoke).toHaveBeenCalledOnce();
    expect(await manual.getDeviceBinding(device)).toBeNull();
    expect(await router.deviceAuth.get(device)).toMatchObject({ publicKey: key.publicKey, revoked: true });

    await manual.bindUser(owner, device, 'Synthetic ordinary rebind');
    const restored = new DeviceAuth(path.join(root, 'device-auth.json'));
    expect(await restored.get(device)).toMatchObject({ revoked: true });
    const connection = {};
    const nonce = restored.challenge(connection, device);
    expect(await restored.verify(connection, device, signature(key, nonce))).toBeUndefined();
    await expect(router.automaticFileEnrollment.click(owner, card, payload)).rejects.toThrow('ownership changed');
    const newNonce = 'b'.repeat(64);
    expect(await router.automaticFileEnrollment.request(device, {
      publicKey: key.publicKey, nonce: newNonce, signature: signature(key, newNonce),
    })).toBe('already-enrolled');
    expect(create).toHaveBeenCalledOnce();
  });

  it('finishes automatic approval before the queued manual key replacement, preserving the newer key', async () => {
    const { key: automaticKey, payload } = await request();
    const manualKey = keys();
    const code = await manual.generateBindingCode(device, 'Synthetic device', manualKey.publicKey);
    const enroll = vi.spyOn(router.deviceAuth, 'enroll');
    const gate = pauseInvalidation();
    const approving = track(router.automaticFileEnrollment.click(owner, card, payload));
    await gate.entered;
    const bindingWrite = vi.spyOn(store, 'setUserBinding');
    const replacing = track(manual.redeemBindingCode(owner, code.code, 'Synthetic device',
      router.feishuLongConnHandler.onApproveDeviceKey));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(bindingWrite).not.toHaveBeenCalled();
    expect(enroll).not.toHaveBeenCalled();
    gate.release();
    await Promise.all([approving, replacing]);
    expect(enroll.mock.calls.map(call => call[2])).toEqual([automaticKey.publicKey, manualKey.publicKey]);
    expect(await router.deviceAuth.get(device)).toMatchObject({ openId: owner, publicKey: manualKey.publicKey });
    const connection = {};
    const nonce = router.deviceAuth.challenge(connection, device);
    expect(await router.deviceAuth.verify(connection, device, signature(manualKey, nonce)))
      .toMatchObject({ publicKey: manualKey.publicKey });
    await expect(router.automaticFileEnrollment.click(owner, card, payload)).rejects.toThrow('ownership changed');
    expect(await manual.verifyBindingCode(code.code)).toBeNull();
  });

  it('rejects automatic approval queued behind manual enrollment even before manual invalidation starts', async () => {
    const { payload } = await request();
    const manualKey = keys();
    const code = await manual.generateBindingCode(device, 'Synthetic device', manualKey.publicKey);
    const gate = pauseInvalidation(false);
    const replacing = track(manual.redeemBindingCode(owner, code.code, 'Synthetic device',
      router.feishuLongConnHandler.onApproveDeviceKey));
    await gate.entered;
    const approving = track(router.automaticFileEnrollment.click(owner, card, payload));
    gate.release();
    await replacing;
    await expect(approving).rejects.toThrow('ownership changed');
    expect(await router.deviceAuth.get(device)).toMatchObject({ publicKey: manualKey.publicKey });
  });

  it('allows a queued manual retry after automatic key persistence fails', async () => {
    const { payload } = await request();
    const manualKey = keys();
    const code = await manual.generateBindingCode(device, 'Synthetic device', manualKey.publicKey);
    vi.spyOn(router.deviceAuth, 'enroll').mockRejectedValueOnce(new Error('Synthetic key persistence failure'));
    const gate = pauseInvalidation();
    const approving = track(router.automaticFileEnrollment.click(owner, card, payload));
    await gate.entered;
    const replacing = track(manual.redeemBindingCode(owner, code.code, 'Synthetic device',
      router.feishuLongConnHandler.onApproveDeviceKey));
    gate.release();
    await expect(approving).rejects.toThrow('Synthetic key persistence failure');
    await expect(replacing).resolves.toMatchObject({ alreadyBound: true });
    expect(await router.deviceAuth.get(device)).toMatchObject({ publicKey: manualKey.publicKey });
    expect(await manual.verifyBindingCode(code.code)).toBeNull();
  });
});
