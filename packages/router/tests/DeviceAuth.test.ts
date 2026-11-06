import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { generateKeyPairSync, sign } from 'crypto';
import { DeviceAuth } from '../src/files/DeviceAuth';

describe('approved device authentication', () => {
  let root: string; let auth: DeviceAuth;
  const keys = () => generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const proof = (key: string, device: string, nonce: string) => sign(null, Buffer.from(`remote-cli-device-v1\n${device}\n${nonce}`), key).toString('base64');
  beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'remote-device-auth-'))); auth = new DeviceAuth(path.join(root, 'auth.json')); });
  afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

  it('requires owner enrollment and a fresh connection-bound challenge', async () => {
    const key = keys(); const connection = {};
    expect(await auth.get('device')).toBeUndefined();
    await auth.enroll('device', 'owner', key.publicKey);
    const nonce = auth.challenge(connection, 'device');
    expect(await auth.verify({}, 'device', proof(key.privateKey, 'device', nonce))).toBeUndefined();
    expect(await auth.verify(connection, 'device', proof(key.privateKey, 'device', nonce))).toMatchObject({ openId: 'owner' });
    expect(await auth.verify(connection, 'device', proof(key.privateKey, 'device', nonce))).toBeUndefined();
    expect((await new DeviceAuth(path.join(root, 'auth.json')).get('device'))?.publicKey).toBe(key.publicKey);
  });
  it('rejects spoofed IDs, signatures, expired challenges and replay after key rotation', async () => {
    const key = keys(); await auth.enroll('device', 'owner', key.publicKey);
    const conn = {}; let nonce = auth.challenge(conn, 'device');
    expect(await auth.verify(conn, 'other', proof(key.privateKey, 'device', nonce))).toBeUndefined();
    nonce = auth.challenge(conn, 'device');
    expect(await auth.verify(conn, 'device', proof(keys().privateKey, 'device', nonce))).toBeUndefined();
    nonce = auth.challenge(conn, 'device');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16_000);
    expect(await auth.verify(conn, 'device', proof(key.privateKey, 'device', nonce))).toBeUndefined();
    vi.restoreAllMocks(); nonce = auth.challenge(conn, 'device');
    await auth.enroll('device', 'owner', keys().publicKey);
    expect(await auth.verify(conn, 'device', proof(key.privateKey, 'device', nonce))).toBeUndefined();
  });
  it('keeps revocation tombstones so an old CLI cannot downgrade authentication', async () => {
    const key = keys(); await auth.enroll('device', 'owner', key.publicKey);
    await auth.revoke('device'); await auth.revoke('missing');
    const conn = {}; const nonce = auth.challenge(conn, 'device');
    expect(await auth.get('device')).toMatchObject({ revoked: true });
    expect(await auth.verify(conn, 'device', proof(key.privateKey, 'device', nonce))).toBeUndefined();
  });
  it.each([null, {}, '', 'bad key', 'a'.repeat(500)])('rejects malformed public keys (%s)', key => {
    expect(DeviceAuth.validKey(key)).toBe(false);
    expect(DeviceAuth.verifyProof(String(key), 'device', 'bad', 'bad')).toBe(false);
  });
  it('fails closed on a corrupted or symlinked authentication store', async () => {
    await fs.writeFile(path.join(root, 'auth.json'), '{"device":{}}');
    await expect(auth.get('device')).rejects.toThrow('Invalid');
    await fs.symlink(path.join(root, 'auth.json'), path.join(root, 'link.json'));
    await expect(new DeviceAuth(path.join(root, 'link.json')).get('device')).rejects.toThrow('Unsafe');
  });
  it('serializes concurrent approvals without dropping earlier keys', async () => {
    await Promise.all(['a', 'b', 'c'].map(id => auth.enroll(id, 'owner', keys().publicKey)));
    const restored = new DeviceAuth(path.join(root, 'auth.json'));
    for (const id of ['a', 'b', 'c']) expect(await restored.get(id)).toBeDefined();
    expect((await fs.stat(path.join(root, 'auth.json'))).mode & 0o777).toBe(process.platform === 'win32' ? 0o666 : 0o600);
  });
  // Directory fsync is unavailable on Windows; file durability is covered separately.
  it.skipIf(process.platform === 'win32')('blocks authentication after post-replacement durability uncertainty until reload', async () => {
    const previous = keys(); const replacement = keys();
    await auth.enroll('device', 'owner', previous.publicKey);
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (target: any, flags: any, mode?: any) => {
      if (target === root && flags === 'r') throw new Error('synthetic directory sync failure');
      return open(target, flags, mode);
    });
    await expect(auth.enroll('device', 'owner', replacement.publicKey)).rejects.toThrow('uncertain');
    await expect(auth.get('device')).rejects.toThrow('uncertain');
    expect(auth.isCurrent('device', { openId: 'owner', publicKey: previous.publicKey })).toBe(false);
    const restored = new DeviceAuth(path.join(root, 'auth.json'));
    expect((await restored.get('device'))?.publicKey).toBe(replacement.publicKey);
  });

  it('preserves the previous key after a failed file sync and permits retry', async () => {
    const previous = keys(); const replacement = keys();
    await auth.enroll('device', 'owner', previous.publicKey);
    const open = fs.open.bind(fs);
    const opening = vi.spyOn(fs, 'open').mockImplementation(async (target: any, flags: any, mode?: any) => {
      const handle = await open(target, flags, mode);
      if (flags === 'wx') vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('synthetic file sync failure'));
      return handle;
    });
    await expect(auth.enroll('device', 'owner', replacement.publicKey)).rejects.toThrow('synthetic file sync failure');
    expect(auth.isCurrent('device', { openId: 'owner', publicKey: previous.publicKey })).toBe(true);
    expect((await new DeviceAuth(path.join(root, 'auth.json')).get('device'))?.publicKey).toBe(previous.publicKey);
    expect(await fs.readdir(root)).toEqual(['auth.json']);
    opening.mockRestore();
    await auth.enroll('device', 'owner', replacement.publicKey);
    expect((await auth.get('device'))?.publicKey).toBe(replacement.publicKey);
  });

  it('syncs key files without opening a directory handle on Windows', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const open = fs.open.bind(fs);
    const syncs: ReturnType<typeof vi.spyOn>[] = [];
    const opening = vi.spyOn(fs, 'open').mockImplementation(async (target: any, flags: any, mode?: any) => {
      const handle = await open(target, flags, mode);
      if (flags === 'wx') syncs.push(vi.spyOn(handle, 'sync'));
      return handle;
    });
    const key = keys();
    await auth.enroll('device', 'owner', key.publicKey);
    expect(syncs).toHaveLength(1);
    expect(syncs[0]).toHaveBeenCalledOnce();
    expect(opening.mock.calls.some(([target, flags]) => target === root && flags === 'r')).toBe(false);
    expect((await new DeviceAuth(path.join(root, 'auth.json')).get('device'))?.publicKey).toBe(key.publicKey);
  });
});
