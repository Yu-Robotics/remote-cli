import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { RouterServer } from '../src/server';
import { JsonStore } from '../src/storage/JsonStore';
import { BindingManager } from '../src/binding/BindingManager';
import { TipService } from '../src/tips/TipService';
import type { TipServiceOptions } from '../src/tips/TipTypes';

vi.mock('../src/tips/TipService', () => ({ TipService: vi.fn(() => ({
  command: vi.fn().mockResolvedValue(undefined), action: vi.fn().mockResolvedValue('Saved'),
  activity: vi.fn().mockResolvedValue(undefined), start: vi.fn(), stop: vi.fn().mockResolvedValue(undefined),
})) }));
vi.mock('../src/feishu/FeishuLongConnHandler', () => ({ FeishuLongConnHandler: vi.fn(() => ({
  setConnectionHub() {}, setOnStartStreaming() {}, setOnCaptureSelection() {}, setOnValidateSelection() {}, setOnResolveThread() {}, setOnResolveActiveThread() {},
  sendTipCard: vi.fn().mockResolvedValue('card'), updateTipCard: vi.fn().mockResolvedValue(undefined),
})) }));

describe('Router Tips integration', () => {
  let root: string; let store: JsonStore; let server: any; let options: TipServiceOptions;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'router-tips-'));
    store = new JsonStore(path.join(root, 'bindings.json'), 0); await store.initialize();
  });
  afterEach(async () => { await store.flush(); await fs.rm(root, { recursive: true, force: true }); vi.clearAllMocks(); });
  function setup(tips?: object) {
    const config: any = { getConfigPath: () => path.join(root, 'config.json'), get: (key: string) => key === 'tips' ? tips : undefined };
    server = new RouterServer(config, store);
    options = vi.mocked(TipService).mock.calls.at(-1)![0];
  }

  it('enumerates users once across multiple devices and returns a detached bound snapshot', async () => {
    const binding = new BindingManager(store);
    await binding.bindUser('owner', 'device-one', 'First');
    await binding.bindUser('owner', 'device-two', 'Second');
    await binding.bindUser('other', 'device-three', 'Third');
    const users = await binding.listBoundUserIds();
    expect(users.sort()).toEqual(['other', 'owner']); users.push('mutated');
    expect(store.listBoundUserIds()).not.toContain('mutated');
    await store.setUserBinding('empty', { openId: 'empty', devices: [], boundAt: 0 } as any);
    expect(store.listBoundUserIds()).not.toContain('empty');
    setup();
    expect((await options.users()).sort()).toEqual(['other', 'owner']);
    expect(await options.isBound('owner')).toBe(true);
    expect(await options.isBound('missing')).toBe(false);
  });

  it('requires an online bound device and blocks observed work on any user device', async () => {
    setup();
    await server.bindingManager.bindUser('owner', 'device', 'Test device');
    vi.spyOn(server.connectionHub, 'isDeviceOnline').mockReturnValue(false);
    expect(await options.canDeliver('owner')).toBe(false);
    server.connectionHub.isDeviceOnline.mockReturnValue(true);
    expect(await options.canDeliver('owner')).toBe(true);
    server.streamingMessages.set('task', { openId: 'owner', deviceId: 'another-device' });
    expect(await options.canDeliver('owner')).toBe(false);
    server.streamingMessages.clear(); server.streamingMessages.set('task', { openId: 'other' });
    expect(await options.canDeliver('owner')).toBe(true);
    expect(await options.canDeliver('missing')).toBe(false);
  });

  it('globally disables automatic delivery without disabling manual controller callbacks', async () => {
    setup({ enabled: false, timezone: 'UTC' });
    expect(options.timezone).toBe('UTC');
    expect(await options.canDeliver('owner')).toBe(false);
    await server.feishuLongConnHandler.onTipsCommand('owner', '/tips');
    expect(server.tips.command).toHaveBeenCalledWith('owner', '/tips');
    await server.feishuLongConnHandler.onTipsAction('owner', 'card', { action: 'tips' });
    expect(server.tips.action).toHaveBeenCalledWith('owner', 'card', { action: 'tips' });
    await server.feishuLongConnHandler.onUserActivity('owner');
    expect(server.tips.activity).toHaveBeenCalledWith('owner');
    expect(options.directory).toBe(path.join(root, 'tips'));
  });

  it('uses the dedicated passive transport with the durable delivery identity', async () => {
    setup();
    expect(await options.create('owner', [], {}, 'intent')).toBe('card');
    expect(server.feishuLongConnHandler.sendTipCard).toHaveBeenCalledWith('owner', [], {}, 'intent');
    await options.update('card', [], {});
    expect(server.feishuLongConnHandler.updateTipCard).toHaveBeenCalledWith('card', [], {});
  });
});
