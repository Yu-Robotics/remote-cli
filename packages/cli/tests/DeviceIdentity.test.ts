import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { verify } from 'crypto';
import { ensureIdentity, fileOrigin, loadIdentity, signDeviceProof } from '../src/files/DeviceIdentity';
import * as durability from '../src/output/Durable';

describe('device identities', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'remote-file-identity-')));
    vi.spyOn(os, 'homedir').mockReturnValue(root);
  });
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

  it('publishes one complete key when independent initial creators race', async () => {
    const link = fs.link.bind(fs);
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const candidates: string[] = [];
    vi.spyOn(fs, 'link').mockImplementation(async (from, to) => {
      candidates.push(JSON.parse(await fs.readFile(from, 'utf8')).publicKey);
      if (++arrived === 2) release();
      await gate;
      return link(from, to);
    });
    const [first, second] = await Promise.all([
      ensureIdentity(root, 'https://router.test', 'device'),
      ensureIdentity(root, 'https://router.test', 'device'),
    ]);
    expect(new Set(candidates).size).toBe(2);
    expect(first).toEqual(second);
    expect(await loadIdentity(root, 'https://router.test', 'device')).toEqual(first);
    expect(await fs.readdir(path.join(root, 'device-identities'))).toHaveLength(1);
  });

  it('syncs file bytes before publication and directories before returning', async () => {
    const events: string[] = [];
    const open = fs.open.bind(fs), link = fs.link.bind(fs), syncDirectory = durability.syncDirectory;
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (args[1] === 'wx') {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, 'sync').mockImplementation(async () => { await sync(); events.push('file-synced'); });
      }
      return handle;
    });
    vi.spyOn(fs, 'link').mockImplementation(async (from, to) => {
      expect(events).toEqual(['file-synced']); await link(from, to); events.push('published');
    });
    vi.spyOn(durability, 'syncDirectory').mockImplementation(async directory => {
      await syncDirectory(directory); events.push('directory-synced');
    });
    await ensureIdentity(root, 'https://router.test', 'device');
    expect(events).toEqual(['file-synced', 'published', 'directory-synced', 'directory-synced']);
  });

  it('does not publish unsynced bytes, and removes only its failed temporary file', async () => {
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (args[1] === 'wx') vi.spyOn(handle, 'sync').mockRejectedValue(new Error('Synthetic sync failure'));
      return handle;
    });
    const publish = vi.spyOn(fs, 'link');
    await expect(ensureIdentity(root, 'https://router.test', 'device')).rejects.toThrow('sync failure');
    expect(publish).not.toHaveBeenCalled();
    expect(await fs.readdir(path.join(root, 'device-identities'))).toEqual([]);
  });

  it('keeps a published key on directory-sync failure and reuses it on retry', async () => {
    const sync = vi.spyOn(durability, 'syncDirectory').mockRejectedValueOnce(new Error('Synthetic directory sync failure'));
    await expect(ensureIdentity(root, 'https://router.test', 'device')).rejects.toThrow('directory sync failure');
    const saved = await loadIdentity(root, 'https://router.test', 'device');
    expect(saved).toBeDefined();
    expect(await ensureIdentity(root, 'https://router.test', 'device')).toEqual(saved);
    expect(sync).toHaveBeenCalledTimes(3);
    expect(await fs.readdir(path.join(root, 'device-identities'))).toHaveLength(1);
  });

  it('fails closed when atomic no-replacement publication is unsupported', async () => {
    vi.spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('Unsupported link'), { code: 'ENOTSUP' }));
    const replace = vi.spyOn(fs, 'rename');
    await expect(ensureIdentity(root, 'https://router.test', 'device')).rejects.toThrow('Unsupported link');
    expect(replace).not.toHaveBeenCalled();
    expect(await fs.readdir(path.join(root, 'device-identities'))).toEqual([]);
  });

  it.each(['https://router.test', 'wss://router.test/ws', 'http://127.0.0.1:1234', 'ws://localhost:3000/ws', 'http://[::1]:123'])('accepts a safe origin: %s', url => {
    expect(fileOrigin(url)).toMatch(/^https?:\/\//);
  });
  it('derives the HTTPS origin from the existing WSS address and preserves its port', () => {
    expect(fileOrigin('wss://router.test:8443/ws')).toBe('https://router.test:8443');
    expect(fileOrigin('wss://router.test/ws')).toBe('https://router.test');
    expect(fileOrigin('ws://127.0.0.1:3000/ws')).toBe('http://127.0.0.1:3000');
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
    if (process.platform !== 'win32') {
      expect((await fs.stat(path.join(dir, name))).mode & 0o777).toBe(0o600);
      expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    }
    expect((await ensureIdentity(root, 'https://router.test', 'device-1', true)).publicKey).not.toBe(key.publicKey);
  });
  it('refuses a symlinked credential or a public credential file', async () => {
    await ensureIdentity(root, 'https://router.test', 'device');
    const dir = path.join(root, 'device-identities');
    const [name] = await fs.readdir(dir);
    const filename = path.join(dir, name);
    if (process.platform !== 'win32') {
      await fs.chmod(filename, 0o644);
      await expect(loadIdentity(root, 'https://router.test', 'device')).rejects.toThrow('private');
    }
    await fs.rename(filename, `${filename}.real`);
    await fs.symlink(`${filename}.real`, filename, 'file');
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
