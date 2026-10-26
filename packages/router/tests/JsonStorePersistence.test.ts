import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { JsonStore } from '../src/storage/JsonStore';

const originalHomedir = os.homedir.bind(os);
vi.spyOn(os, 'homedir').mockImplementation(() => process.env.HOME || originalHomedir());

describe('JsonStore serialized atomic persistence', () => {
  let directory: string;
  let storePath: string;
  let store: JsonStore;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-cli-json-store-'));
    directory = await fs.realpath(directory);
    storePath = path.join(directory, 'bindings.json');
    store = new JsonStore(storePath, 0);
    await store.initialize();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await store.flush().catch(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('keeps a clear newer than an already admitted pending snapshot', async () => {
    store = new JsonStore(storePath, 60_000);
    await store.initialize();
    const pending = store.setDeviceToUserMap('device-a', 'user-a');
    const clearing = store.clear();
    await store.flush();
    await Promise.all([pending, clearing]);

    expect(store.getUserByDeviceId('device-a')).toBeNull();
    const persisted = JSON.parse(await fs.readFile(storePath, 'utf8'));
    expect(persisted.deviceToUserMap).toEqual({});
    expect(persisted.userBindings).toEqual({});
  });

  it('serializes snapshots so an older write cannot resurrect an unbound device', async () => {
    const rename = fs.rename.bind(fs);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let firstStarted!: () => void;
    const started = new Promise<void>(resolve => { firstStarted = resolve; });
    let calls = 0;
    vi.spyOn(fs, 'rename').mockImplementation(async (oldPath, newPath) => {
      calls++;
      if (calls === 1) {
        firstStarted();
        await firstGate;
      }
      return rename(oldPath, newPath);
    });

    const bind = store.setDeviceToUserMap('device-a', 'user-a');
    await started;
    const unbind = store.removeDeviceToUserMap('device-a');
    const flushed = store.flush();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(calls).toBe(1);
    releaseFirst();
    await Promise.all([bind, unbind, flushed]);

    const reloaded = new JsonStore(storePath, 0);
    await reloaded.initialize();
    expect(reloaded.getUserByDeviceId('device-a')).toBeNull();
    await reloaded.flush();
  });

  it('rejects only the failed snapshot and cleans its temporary file', async () => {
    const original = await fs.readFile(storePath, 'utf8');
    const rename = fs.rename.bind(fs);
    let calls = 0;
    vi.spyOn(fs, 'rename').mockImplementation(async (oldPath, newPath) => {
      if (++calls === 1) throw new Error('synthetic rename failure');
      return rename(oldPath, newPath);
    });

    await expect(store.setDeviceToUserMap('device-a', 'user-a')).rejects.toThrow('synthetic rename failure');
    await expect(store.removeDeviceToUserMap('device-a')).resolves.toBeUndefined();
    expect((await fs.readdir(directory)).filter(name => name.includes('.tmp'))).toEqual([]);
    expect(await fs.readFile(storePath, 'utf8')).toBe(original);

    await store.setDeviceToUserMap('device-b', 'user-b');
    await store.flush();
    expect(JSON.parse(await fs.readFile(storePath, 'utf8')).deviceToUserMap['device-b']).toBe('user-b');
  });

  it('flush fences writes accepted while an earlier flush is draining', async () => {
    const rename = fs.rename.bind(fs);
    let releaseFirst!: () => void;
    const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let firstStarted!: () => void;
    const started = new Promise<void>(resolve => { firstStarted = resolve; });
    let calls = 0;
    vi.spyOn(fs, 'rename').mockImplementation(async (oldPath, newPath) => {
      if (++calls === 1) {
        firstStarted();
        await gate;
      }
      return rename(oldPath, newPath);
    });

    const first = store.setDeviceToUserMap('device-a', 'user-a');
    await started;
    const flushing = store.flush();
    const second = store.setDeviceToUserMap('device-b', 'user-b');
    let flushFinished = false;
    void flushing.then(() => { flushFinished = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(flushFinished).toBe(false);
    releaseFirst();
    await Promise.all([first, second, flushing]);
    const persisted = JSON.parse(await fs.readFile(storePath, 'utf8'));
    expect(persisted.deviceToUserMap).toMatchObject({ 'device-a': 'user-a', 'device-b': 'user-b' });
  });

  it('persists and reopens with the Windows directory-sync fallback', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const open = vi.spyOn(fs, 'open');
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      await store.setDeviceToUserMap('device-windows', 'user-windows');
      expect(open.mock.calls.some(([file, flags]) => file === directory && flags === 'r')).toBe(false);

      const reloaded = new JsonStore(storePath, 0);
      await reloaded.initialize();
      expect(reloaded.getUserByDeviceId('device-windows')).toBe('user-windows');
      await reloaded.flush();
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  // This fault targets a POSIX directory operation that Windows intentionally omits.
  it.skipIf(process.platform === 'win32')('fails closed after a post-rename durability error until reconciliation', async () => {
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
      if (file === directory && flags === 'r') throw new Error('synthetic directory sync failure');
      return open(file, flags, mode);
    });

    await expect(store.setDeviceToUserMap('device-a', 'user-a')).rejects.toThrow(/uncertain|reconcil/i);
    expect(() => store.getUserByDeviceId('device-a')).toThrow(/uncertain|reconcil/i);
    const blocked = store.setDeviceToUserMap('device-b', 'user-b');
    const flushing = store.flush();
    await expect(flushing).rejects.toThrow(/uncertain|reconcil/i);
    expect((store as any).pendingSaves).toHaveLength(0);
    await expect(blocked).rejects.toThrow(/uncertain|reconcil/i);

    const reloaded = new JsonStore(storePath, 0);
    await reloaded.initialize();
    expect(reloaded.getUserByDeviceId('device-a')).toBe('user-a');
    await reloaded.flush();
  });

  it('flush rejects a failed write after draining all accepted callers', async () => {
    const rename = fs.rename.bind(fs);
    let releaseFirst!: () => void;
    const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let firstStarted!: () => void;
    const started = new Promise<void>(resolve => { firstStarted = resolve; });
    let calls = 0;
    vi.spyOn(fs, 'rename').mockImplementation(async (oldPath, newPath) => {
      if (++calls === 1) {
        firstStarted();
        await gate;
        throw new Error('synthetic flush write failure');
      }
      return rename(oldPath, newPath);
    });

    const first = store.setDeviceToUserMap('device-a', 'user-a');
    await started;
    const flushing = store.flush();
    const second = store.setDeviceToUserMap('device-b', 'user-b');
    releaseFirst();
    const results = await Promise.allSettled([first, second, flushing]);
    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('fulfilled');
    expect(results[2].status).toBe('rejected');
    expect(store.getUserByDeviceId('device-a')).toBeNull();
    expect(store.getUserByDeviceId('device-b')).toBe('user-b');
    const persisted = JSON.parse(await fs.readFile(storePath, 'utf8'));
    expect(persisted.deviceToUserMap).toEqual({ 'device-b': 'user-b' });
  });
});
