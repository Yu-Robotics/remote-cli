import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { verify } from 'crypto';
import { ensureIdentity, fileOrigin, loadIdentity, signDeviceProof } from '../src/files/DeviceIdentity';

describe('device identities', () => {
  let root: string;
  beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'remote-file-identity-'))); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it.each(['https://router.test', 'wss://router.test/ws', 'http://127.0.0.1:1234', 'ws://localhost:3000/ws', 'http://[::1]:123'])('accepts a safe origin: %s', url => {
    expect(fileOrigin(url)).toMatch(/^https?:\/\//);
  });
  it.each(['http://router.test', 'ws://10.0.0.1/ws', 'file:///tmp/file', 'https://user:password@router.test', 'https://router.test/?token=secret', 'https://router.test/#token'])('rejects unsafe origin: %s', url => {
    expect(() => fileOrigin(url)).toThrow();
  });
  it('creates private, per-origin keys and proves possession without exporting the private key', async () => {
    const key = await ensureIdentity(root, 'https://router.test', 'device-1');
    expect(await loadIdentity(root, 'wss://router.test/ws', 'device-1')).toEqual(key);
    expect(await ensureIdentity(root, 'https://router.test', 'device-1')).toEqual(key);
    expect(await loadIdentity(root, 'https://another.test', 'device-1')).toBeUndefined();
    const nonce = 'a'.repeat(64);
    expect(verify(null, Buffer.from(`remote-cli-device-v1\ndevice-1\n${nonce}`), key.publicKey, Buffer.from(signDeviceProof(key, 'device-1', nonce), 'base64'))).toBe(true);
    const dir = path.join(root, 'device-identities');
    const [name] = await fs.readdir(dir);
    expect((await fs.stat(path.join(dir, name))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    expect((await ensureIdentity(root, 'https://router.test', 'device-1', true)).publicKey).not.toBe(key.publicKey);
  });
  it('refuses a symlinked credential or a public credential file', async () => {
    await ensureIdentity(root, 'https://router.test', 'device');
    const dir = path.join(root, 'device-identities');
    const [name] = await fs.readdir(dir);
    const filename = path.join(dir, name);
    await fs.chmod(filename, 0o644);
    await expect(loadIdentity(root, 'https://router.test', 'device')).rejects.toThrow('private');
    await fs.rename(filename, `${filename}.real`);
    await fs.symlink(`${filename}.real`, filename);
    await expect(loadIdentity(root, 'https://router.test', 'device')).rejects.toThrow('private');
  });
  it('does not treat corrupt identities as permission to fall back to legacy registration', async () => {
    await ensureIdentity(root, 'https://router.test', 'device');
    const dir = path.join(root, 'device-identities');
    const [name] = await fs.readdir(dir);
    await fs.writeFile(path.join(dir, name), '{}');
    await expect(loadIdentity(root, 'https://router.test', 'device')).rejects.toThrow();
    expect(await loadIdentity(root, 'http://remote.test', 'device')).toBeUndefined();
  });
});
