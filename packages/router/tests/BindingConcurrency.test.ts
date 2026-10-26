import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { BindingManager } from '../src/binding/BindingManager';
import { JsonStore } from '../src/storage/JsonStore';

const originalHomedir = os.homedir.bind(os);
vi.spyOn(os, 'homedir').mockImplementation(() => process.env.HOME || originalHomedir());

describe('BindingManager serialized ownership mutations', () => {
  let directory: string;
  let store: JsonStore;
  let manager: BindingManager;

  beforeEach(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'remote-cli-binding-')));
    store = new JsonStore(path.join(directory, 'bindings.json'), 0);
    await store.initialize();
    manager = new BindingManager(store);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await store.flush();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('allows only one cross-user enrollment to redeem a code concurrently', async () => {
    const issued = await manager.generateBindingCode('device-a', 'Device', 'public-key');
    let releaseApproval!: () => void;
    const approvalGate = new Promise<void>(resolve => { releaseApproval = resolve; });
    let approvalStarted!: () => void;
    const started = new Promise<void>(resolve => { approvalStarted = resolve; });
    const approve = vi.fn(async () => { approvalStarted(); await approvalGate; });

    const first = manager.redeemBindingCode('user-a', issued.code, 'Device', approve);
    await started;
    const second = manager.redeemBindingCode('user-b', issued.code, 'Device', approve);
    releaseApproval();
    const results = await Promise.allSettled([first, second]);

    const redeemed = results.filter(result => result.status === 'fulfilled').map(result => result.value);
    expect(redeemed.filter(Boolean)).toHaveLength(1);
    expect(redeemed.filter(value => value === null)).toHaveLength(1);
    expect(approve).toHaveBeenCalledTimes(1);
    expect(store.getUserByDeviceId('device-a')).toBe('user-a');
    expect(store.getUserBinding('user-b')).toBeNull();
    expect(store.getBindingCode(issued.code)).toBeNull();
  });

  it('serializes direct binding and unbinding with an in-flight enrollment', async () => {
    const issued = await manager.generateBindingCode('device-a', 'Device', 'public-key');
    let releaseApproval!: () => void;
    const gate = new Promise<void>(resolve => { releaseApproval = resolve; });
    let approvalStarted!: () => void;
    const started = new Promise<void>(resolve => { approvalStarted = resolve; });
    const events: string[] = [];
    const approve = vi.fn(async () => { events.push('approve:start'); approvalStarted(); await gate; events.push('approve:end'); });
    const enrolling = manager.redeemBindingCode('user-a', issued.code, 'Device', approve);
    await started;
    const competing = manager.bindUser('user-b', 'device-a', 'Other');
    const unbinding = manager.unbindUser('user-a', async deviceId => { events.push(`revoke:${deviceId}`); });
    releaseApproval();

    await enrolling;
    await expect(competing).rejects.toThrow(/already bound|invalid or expired/);
    await unbinding;
    expect(events).toEqual(['approve:start', 'approve:end', 'revoke:device-a']);
    expect(store.getUserBinding('user-a')).toBeNull();
    expect(store.getUserBinding('user-b')).toBeNull();
    expect(store.getUserByDeviceId('device-a')).toBeNull();
  });

  it('does not change binding or key ownership for expired codes', async () => {
    const code = 'EXPIRED-CODE';
    await store.setBindingCode(code, { code, deviceId: 'device-a', devicePublicKey: 'public-key',
      createdAt: Date.now() - 1000, expiresAt: Date.now() - 1 });
    const approve = vi.fn();
    await expect(manager.redeemBindingCode('user-a', code, 'Device', approve)).resolves.toBeNull();
    expect(approve).not.toHaveBeenCalled();
    expect(store.getUserBinding('user-a')).toBeNull();
    expect(store.getUserByDeviceId('device-a')).toBeNull();
  });

  it('rejects ambiguous historical ownership instead of silently repairing it', async () => {
    const now = Date.now();
    const binding = (openId: string) => ({ openId, activeDeviceId: 'device-a', createdAt: now, updatedAt: now,
      devices: [{ deviceId: 'device-a', deviceName: 'Device', boundAt: now, lastActiveAt: now, isActive: true }] });
    await store.setUserBinding('user-a', binding('user-a'));
    await store.setUserBinding('user-b', binding('user-b'));
    await store.setDeviceToUserMap('device-a', 'user-a');

    await expect(manager.bindUser('user-a', 'device-a', 'Renamed')).rejects.toThrow(/ambiguous/i);
    await expect(manager.unbindUser('user-b')).rejects.toThrow(/ambiguous/i);
    expect(store.getUserBinding('user-a')?.devices[0].deviceName).toBe('Device');
    expect(store.getUserBinding('user-b')).not.toBeNull();
    expect(store.getUserByDeviceId('device-a')).toBe('user-a');
  });

  it('does not publish or later resurrect a binding whose replacement failed', async () => {
    const rename = fs.rename.bind(fs);
    let calls = 0;
    vi.spyOn(fs, 'rename').mockImplementation(async (oldPath, newPath) => {
      if (++calls === 1) throw new Error('synthetic pre-replacement failure');
      return rename(oldPath, newPath);
    });

    await expect(manager.bindUser('user-a', 'device-a', 'Rejected')).rejects.toThrow('pre-replacement');
    expect(store.getUserBinding('user-a')).toBeNull();
    await expect(manager.getDeviceBinding('device-a')).resolves.toBeNull();
    const afterFailure = JSON.parse(await fs.readFile(path.join(directory, 'bindings.json'), 'utf8'));
    expect(afterFailure.userBindings['user-a']).toBeUndefined();
    expect(afterFailure.deviceToUserMap['device-a']).toBeUndefined();

    await manager.bindUser('user-b', 'device-b', 'Accepted');
    const reloaded = new JsonStore(path.join(directory, 'bindings.json'), 0);
    await reloaded.initialize();
    expect(reloaded.getUserBinding('user-a')).toBeNull();
    expect(reloaded.getUserByDeviceId('device-a')).toBeNull();
    expect(reloaded.getUserBinding('user-b')).not.toBeNull();
    await reloaded.flush();
  });
});
