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
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-device-auth-')); auth = new DeviceAuth(path.join(root, 'auth.json')); });
  afterEach(async () => { vi.useRealTimers(); await fs.rm(root, { recursive: true, force: true }); });

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
    expect((await fs.stat(path.join(root, 'auth.json'))).mode & 0o777).toBe(0o600);
  });
});
