import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { generateKeyPairSync, sign } from 'crypto';
import { AutomaticFileEnrollment } from '../src/files/AutomaticFileEnrollment';
import { DeviceAuth } from '../src/files/DeviceAuth';
import { BindingManager } from '../src/binding/BindingManager';
import { JsonStore } from '../src/storage/JsonStore';
import * as durable from '../src/output/Durable';

describe('durable automatic file approval', () => {
  let root: string;
  let filename: string;
  let bindings: BindingManager;
  let auth: DeviceAuth;
  let service: AutomaticFileEnrollment;
  let create: ReturnType<typeof vi.fn>;
  let approve: ReturnType<typeof vi.fn>;
  const keys = () => generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const proof = (key = keys(), deviceId = 'device') => ({ publicKey: key.publicKey, nonce: 'a'.repeat(64),
    signature: sign(null, Buffer.from(`remote-cli-device-v1\n${deviceId}\n${'a'.repeat(64)}`), key.privateKey).toString('base64') });
  const restart = () => service = new AutomaticFileEnrollment(filename, { bindings, auth, create, approve });
  const record = async () => JSON.parse(await fs.readFile(filename, 'utf8'))[0];
  const action = () => JSON.parse(create.mock.calls[0][1]).body.elements.at(-1).behaviors[0].value;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'auto-files-router-')));
    filename = path.join(root, 'requests', 'requests.json');
    const store = new JsonStore(path.join(root, 'bindings.json'), 0); await store.initialize();
    bindings = new BindingManager(store); await bindings.bindUser('owner', 'device', 'Synthetic device');
    auth = new DeviceAuth(path.join(root, 'auth.json'));
    create = vi.fn(async () => 'approval-card');
    approve = vi.fn(async (owner, deviceId, key) => auth.enroll(deviceId, owner, key));
    restart();
  });
  afterEach(async () => {
    await service.destroy(); await bindings.close(); vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('coalesces concurrent requests, persists before notifying, survives restart and approves only the emitted card', async () => {
    const request = proof();
    create.mockImplementationOnce(async () => { expect((await record()).state).toBe('intent'); return 'approval-card'; });
    expect(await Promise.all([service.request('device', request), service.request('device', request)])).toEqual(['known', 'known']);
    expect(create).toHaveBeenCalledTimes(1);
    expect(JSON.parse(create.mock.calls[0][1]).body.elements.at(-1).type).toBe('primary');
    expect(create.mock.calls[0][0]).toBe('owner');
    await service.destroy(); restart();
    expect(await service.request('device', request)).toBe('known');
    expect(await service.click('intruder', 'approval-card', action())).toContain('unavailable');
    expect(await service.click('owner', 'wrong-card', action())).toContain('unavailable');
    expect(await auth.get('device')).toBeUndefined();
    expect(await service.click('owner', 'approval-card', action())).toContain('approved');
    expect((await auth.get('device'))?.publicKey).toBe(request.publicKey);
    expect(await service.click('owner', 'approval-card', action())).toContain('approved');
    expect(approve).toHaveBeenCalledTimes(1);
    expect(await service.request('device', request)).toBe('already-enrolled');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('never prompts or rotates an existing approved/revoked key (%s)', async revoked => {
    const key = keys(); await auth.enroll('device', 'owner', key.publicKey);
    if (revoked) await auth.revoke('device');
    expect(await service.request('device', proof())).toBe('already-enrolled');
    expect(create).not.toHaveBeenCalled();
    expect((await auth.get('device'))?.publicKey).toBe(key.publicKey);
  });

  it('reissues an explicit card once, invalidates its predecessor, and preserves automatic dedupe after expiry', async () => {
    const proofValue = proof(); await service.request('device', proofValue);
    const original = action(); create.mockResolvedValue('explicit-card');
    const epoch = bindings.getCardThreadEpoch('owner', 'device');
    expect(service.canRecover('device', 'owner', epoch)).toBe(true);
    await Promise.all([service.requestExplicit('device', 'owner', epoch), service.requestExplicit('device', 'owner', epoch)]);
    expect(create).toHaveBeenCalledTimes(2);
    const renewed = JSON.parse(create.mock.calls[1][1]).body.elements.at(-1).behaviors[0].value;
    expect(renewed.id).not.toBe(original.id);
    expect(await service.click('owner', 'approval-card', original)).toContain('unavailable');
    await service.destroy(); restart();
    expect(await service.request('device', proofValue)).toBe('known');
    expect(create).toHaveBeenCalledTimes(2);
    vi.spyOn(Date, 'now').mockReturnValue((await record()).expires);
    expect(await service.request('device', proofValue)).toBe('expired');
    expect(create).toHaveBeenCalledTimes(2);
    await service.requestExplicit('device', 'owner', epoch);
    expect(create).toHaveBeenCalledTimes(3);
    expect(await service.click('owner', 'explicit-card', renewed)).toContain('unavailable');
  });
  it.each(['owner', 'epoch', 'revoked', 'conflict', 'uncertain', 'absent'])('holds unsafe explicit recovery: %s', async mode => {
    const request = proof(); if (mode !== 'absent') await service.request('device', request);
    const epoch = bindings.getCardThreadEpoch('owner', 'device');
    if (mode === 'revoked' || mode === 'conflict') {
      await auth.enroll('device', 'owner', mode === 'conflict' ? keys().publicKey : request.publicKey);
      if (mode === 'revoked') await auth.revoke('device');
    }
    if (mode === 'uncertain') {
      const saved = await record(); saved.state = 'uncertain'; await durable.durableJson(filename, [saved]);
      await service.destroy(); restart();
    }
    const count = create.mock.calls.length;
    await service.requestExplicit('device', mode === 'owner' ? 'intruder' : 'owner', mode === 'epoch' ? 'stale' : epoch);
    expect(create).toHaveBeenCalledTimes(count); expect(approve).not.toHaveBeenCalled();
  });
  it('persists a conflicting CLI proof and never enrolls the stale key through an old card or explicit click', async () => {
    await service.request('device', proof()); const old = action();
    expect(await service.request('device', proof())).toBe('conflict');
    const epoch = bindings.getCardThreadEpoch('owner', 'device');
    await service.destroy(); restart();
    await service.requestExplicit('device', 'owner', epoch);
    expect(service.canRecover('device', 'owner', epoch)).toBe(false);
    expect(await service.click('owner', 'approval-card', old)).toContain('unavailable');
    expect(create).toHaveBeenCalledOnce(); expect(approve).not.toHaveBeenCalled();
  });
  it('never blindly retries an uncertain explicit send, including after restart', async () => {
    const request = proof(); await service.request('device', request);
    const epoch = bindings.getCardThreadEpoch('owner', 'device');
    create.mockRejectedValue(new Error('Synthetic lost receipt'));
    expect(await service.requestExplicit('device', 'owner', epoch)).toContain('unconfirmed');
    await service.destroy(); restart();
    expect(await service.requestExplicit('device', 'owner', epoch)).toContain('unconfirmed');
    expect(await service.request('device', request)).toBe('uncertain'); expect(create).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed proof, unbound devices, conflicting keys and unknown actions', async () => {
    expect(await service.request('device', {})).toBe('invalid');
    expect(await service.request('device', { ...proof(), signature: 'bad' })).toBe('invalid');
    expect(await service.request('unknown', proof(keys(), 'unknown'))).toBe('unbound');
    await service.request('device', proof());
    expect(await service.request('device', proof())).toBe('conflict');
    expect(await service.click('owner', 'approval-card', null)).toContain('unavailable');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each(['unbind', 'reassign', 'same-owner-rebind', 'invalidate'])('invalidates approval after %s', async change => {
    await service.request('device', proof());
    if (change === 'invalidate') await bindings.invalidateDeviceCards('device');
    else {
      await bindings.unbindDevice('owner', 'device');
      if (change !== 'unbind') await bindings.bindUser(change === 'reassign' ? 'other' : 'owner', 'device', 'New binding');
    }
    await expect(service.click('owner', 'approval-card', action())).rejects.toThrow();
    expect(approve).not.toHaveBeenCalled();
  });

  it('holds expired requests without sending replacement cards', async () => {
    const request = proof(); await service.request('device', request);
    vi.spyOn(Date, 'now').mockReturnValue((await record()).expires);
    expect(await service.request('device', request)).toBe('expired');
    expect(await service.click('owner', 'approval-card', action())).toContain('expired');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each(['lost-ack', 'missing-receipt', 'intent-crash'])('never recreates or approves a card with unknown outcome: %s', async mode => {
    const request = proof();
    if (mode === 'lost-ack') create.mockRejectedValueOnce(new Error('synthetic unknown outcome'));
    if (mode === 'missing-receipt') create.mockResolvedValueOnce('');
    await service.request('device', request);
    if (mode === 'intent-crash') { const value = await record(); value.state = 'intent'; delete value.cardId; await durable.durableJson(filename, [value]); }
    await service.destroy(); restart();
    expect(await service.request('device', request)).toBe('uncertain');
    expect(await service.click('owner', 'approval-card', action())).toContain('unavailable');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('does not notify after a manual approval commits during automatic admission', async () => {
    const request = proof();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const admission = new Promise<void>(resolve => { entered = resolve; });
    const original = auth.get.bind(auth);
    vi.spyOn(auth, 'get').mockImplementationOnce(async deviceId => {
      const snapshot = await original(deviceId);
      entered(); await gate; return snapshot;
    });
    const pending = service.request('device', request);
    await admission;
    try { await auth.enroll('device', 'owner', request.publicKey); }
    finally { release(); }
    expect(await pending).toBe('already-enrolled');
    expect(create).not.toHaveBeenCalled();
  });

  it('does not send an admitted request to a replacement owner', async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const admission = new Promise<void>(resolve => { entered = resolve; });
    const original = auth.get.bind(auth);
    vi.spyOn(auth, 'get').mockImplementationOnce(async deviceId => {
      const snapshot = await original(deviceId);
      entered(); await gate; return snapshot;
    });
    const pending = service.request('device', proof());
    await admission;
    try {
      await bindings.unbindDevice('owner', 'device');
      await bindings.bindUser('replacement-owner', 'device', 'Synthetic replacement device');
    } finally { release(); }
    expect(await pending).toBe('unbound');
    expect(create).not.toHaveBeenCalled();
  });

  it('does not notify after the same owner unbinds and rebinds during authentication lookup', async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const admission = new Promise<void>(resolve => { entered = resolve; });
    const original = auth.get.bind(auth);
    vi.spyOn(auth, 'get').mockImplementationOnce(async deviceId => {
      const snapshot = await original(deviceId); entered(); await gate; return snapshot;
    });
    const pending = service.request('device', proof());
    try {
      await admission;
      await bindings.unbindDevice('owner', 'device');
      await bindings.bindUser('owner', 'device', 'Synthetic rebound device');
    } finally { release(); }
    expect(await pending).toBe('unbound');
    expect(create).not.toHaveBeenCalled();
  });

  it.each(['owner', 'replacement-owner'])('pins queued authority instead of retargeting it to %s', async replacement => {
    await bindings.bindUser('blocker-owner', 'blocker', 'Synthetic blocker');
    let finish!: (id: string) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    create.mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve; entered(); }));
    const blocker = service.request('blocker', proof(keys(), 'blocker'));
    let queued: Promise<string> | undefined;
    try {
      await started;
      const authority = { openId: 'owner', epoch: bindings.getCardThreadEpoch('owner', 'device') };
      queued = service.request('device', proof(), authority);
      await bindings.unbindDevice('owner', 'device');
      await bindings.bindUser(replacement, 'device', 'Synthetic replacement');
      // Mutating caller-owned metadata after admission must not change the pinned scope.
      authority.openId = replacement; authority.epoch = bindings.getCardThreadEpoch(replacement, 'device');
    } finally { finish?.('blocker-card'); await blocker; }
    expect(await queued).toBe('unbound');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale connection before admission without inspecting or persisting an enrollment request', async () => {
    const read = vi.spyOn(auth, 'get');
    expect(await service.request('device', proof(), { openId: 'owner', epoch: bindings.getCardThreadEpoch('owner', 'device') }, () => false)).toBe('unbound');
    expect(read).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
    await expect(fs.stat(filename)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rechecks committed manual enrollment after the automatic intent reaches disk', async () => {
    const request = proof();
    const code = await bindings.generateBindingCode('device', 'Synthetic device', request.publicKey);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const saved = new Promise<void>(resolve => { entered = resolve; });
    const write = durable.durableJson;
    vi.spyOn(durable, 'durableJson').mockImplementationOnce(async (...args) => {
      await write(...args); entered(); await gate;
    });
    const pending = service.request('device', request);
    try {
      await saved;
      expect((await record()).state).toBe('intent');
      await bindings.redeemBindingCode('owner', code.code, 'Synthetic device', approve);
    } finally { release(); }
    expect(await pending).toBe('already-enrolled');
    expect(create).not.toHaveBeenCalled();
    await service.destroy(); restart();
    expect(await service.request('device', request)).toBe('already-enrolled');
  });

  it('serializes final admission with manual approval but releases the binding queue before awaiting Feishu', async () => {
    const request = proof();
    const code = await bindings.generateBindingCode('device', 'Synthetic device', request.publicKey);
    let release!: () => void;
    let entered!: () => void;
    let finish!: (id: string) => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const checked = new Promise<void>(resolve => { entered = resolve; });
    const original = auth.get.bind(auth);
    let reads = 0;
    vi.spyOn(auth, 'get').mockImplementation(async deviceId => {
      const snapshot = await original(deviceId);
      if (++reads === 2) { entered(); await gate; }
      return snapshot;
    });
    create.mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve; }));
    const pending = service.request('device', request);
    let manual: Promise<unknown> | undefined;
    try {
      await checked;
      let committed = false;
      manual = bindings.redeemBindingCode('owner', code.code, 'Synthetic device', approve).then(value => { committed = true; return value; });
      await Promise.resolve(); expect(committed).toBe(false);
      release();
      await manual;
      expect(create).toHaveBeenCalledTimes(1);
      expect((await original('device'))?.publicKey).toBe(request.publicKey);
    } finally { release(); await manual; finish?.('approval-card'); await pending; }
  });

  it('allows an already admitted same-owner notification to complete after its connection drops', async () => {
    const authority = { openId: 'owner', epoch: bindings.getCardThreadEpoch('owner', 'device') };
    let current = true;
    const pending = service.request('device', proof(), authority, () => current);
    current = false;
    expect(await pending).toBe('known');
    expect(create).toHaveBeenCalledWith('owner', expect.any(String), expect.any(String));
  });

  it('never notifies before durable intent and fails closed after a storage failure', async () => {
    vi.spyOn(durable, 'durableJson').mockRejectedValueOnce(new Error('synthetic disk error'));
    await expect(service.request('device', proof())).rejects.toThrow('saved');
    expect(create).not.toHaveBeenCalled();
    await expect(service.request('device', proof())).rejects.toThrow('unavailable');
  });

  it('recovers an enrolled key after approval acknowledgement persistence failed without another notification', async () => {
    const request = proof(); await service.request('device', request);
    const disk = vi.spyOn(durable, 'durableJson').mockRejectedValueOnce(new Error('synthetic disk error'));
    await expect(service.click('owner', 'approval-card', action())).rejects.toThrow('saved');
    await service.destroy(); disk.mockRestore(); restart();
    expect(await service.request('device', request)).toBe('already-enrolled');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('refuses an independently replaced or revoked key during approval', async () => {
    await service.request('device', proof());
    await auth.enroll('device', 'owner', keys().publicKey);
    await expect(service.click('owner', 'approval-card', action())).rejects.toThrow('key changed');
    expect(approve).not.toHaveBeenCalled();
  });

  it('bounds requests per owner and globally and drains admitted card work before shutdown', async () => {
    const request = proof();
    for (let i = 0; i < 8; i++) {
      const device = `device-${i}`; await bindings.bindUser('owner', device, 'Synthetic device');
      await service.request(device, proof(keys(), device));
    }
    expect(await service.request('device', request)).toBe('limited');
    let finish!: (id: string) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    await bindings.bindUser('other', 'other-device', 'Synthetic device');
    create.mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve; entered(); }));
    const admitted = service.request('other-device', proof(keys(), 'other-device'));
    let stopped: Promise<void> | undefined;
    try {
      await started;
      stopped = service.destroy(); let drained = false; void stopped.then(() => { drained = true; });
      await Promise.resolve(); expect(drained).toBe(false);
    } finally { finish?.('late-card'); await admitted; await stopped; }
    await expect(service.request('device', request)).rejects.toThrow('unavailable');
  });

  it('rejects invalid persisted state instead of replacing it', async () => {
    await fs.mkdir(path.dirname(filename)); await fs.writeFile(filename, '[{"id":"invalid"}]');
    await expect(service.request('device', proof())).rejects.toThrow('Invalid');
    expect(create).not.toHaveBeenCalled();
  });

  it('caps the total durable inventory without pruning approval evidence or bypassing limits after restart', async () => {
    for (let i = 0; i < 64; i++) {
      const device = `bounded-device-${i}`;
      await bindings.bindUser(`bounded-owner-${i}`, device, 'Synthetic device');
      expect(await service.request(device, proof(keys(), device))).toBe('known');
    }
    await service.destroy(); restart();
    expect(await service.request('device', proof())).toBe('limited');
    expect(create).toHaveBeenCalledTimes(64);
  });

  it('bounds admitted work while a notification is pending and drains late completion safely', async () => {
    let finish!: (id: string) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    create.mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve; entered(); }));
    const request = proof();
    const first = service.request('device', request);
    const queued: Array<Promise<string>> = [];
    try {
      await started;
      for (let i = 0; i < 63; i++) queued.push(service.request('device', request));
      await expect(service.request('device', request)).rejects.toThrow('unavailable');
    } finally {
      finish?.('approval-card'); await Promise.allSettled([first, ...queued]);
    }
    expect(create).toHaveBeenCalledTimes(1);
  });
});
