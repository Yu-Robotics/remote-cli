import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { PrivateOutputRoot } from '../../src/output/PrivateOutputRoot';
import { durableJson } from '../../src/output/Durable';

let root: string;
const link = (target: string, name: string) => fs.symlink(target, name, process.platform === 'win32' ? 'junction' : 'dir');
beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'output-root-'))); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

it('canonicalizes a trusted ancestor once and creates missing private descendants', async () => {
  const real = path.join(root, 'real'), alias = path.join(root, 'alias'); await fs.mkdir(real); await link(real, alias);
  const storage = new PrivateOutputRoot(path.join(alias, 'new', 'store'));
  expect(() => storage.path).toThrow('not initialized');
  await storage.initialize(); await storage.initialize();
  expect(storage.path).toBe(path.join(real, 'new', 'store'));
  if (process.platform !== 'win32') expect((await fs.stat(storage.path)).mode & 0o077).toBe(0);
});

it('rejects a linked private leaf without changing the foreign directory permissions', async () => {
  const target = path.join(root, 'foreign'), leaf = path.join(root, 'leaf'); await fs.mkdir(target, { mode: 0o755 }); await link(target, leaf);
  const mode = (await fs.stat(target)).mode;
  await expect(new PrivateOutputRoot(leaf).initialize()).rejects.toThrow('Unsafe');
  expect((await fs.stat(target)).mode).toBe(mode);
  expect(await fs.readdir(target)).toEqual([]);
});

it.each(['root', 'ancestor', 'alias'])('refuses %s replacement instead of reanchoring or deleting foreign files', async kind => {
  const parent = path.join(root, 'parent'), alias = path.join(root, 'alias'); await fs.mkdir(parent); await link(parent, alias);
  const storage = new PrivateOutputRoot(path.join(alias, 'store')); await storage.initialize();
  const original = storage.path;
  const moved = kind === 'root' ? original : kind === 'ancestor' ? parent : alias;
  await fs.rename(moved, `${moved}-retained`);
  await fs.mkdir(moved);
  const sentinel = path.join(moved, 'sentinel'); await fs.writeFile(sentinel, 'foreign');
  expect(() => storage.path).toThrow('identity changed');
  await expect(Promise.resolve().then(() => storage.initialize())).rejects.toThrow('identity changed');
  await expect(durableJson(path.join(original, 'receipt.json'), {}, storage.check)).rejects.toThrow();
  expect(await fs.readFile(sentinel, 'utf8')).toBe('foreign');
});

it('rejects alias redirection during initialization before creating private data', async () => {
  const first = path.join(root, 'first'), second = path.join(root, 'second'), alias = path.join(root, 'alias');
  await fs.mkdir(first); await fs.mkdir(second); await link(first, alias);
  const realpath = fs.realpath.bind(fs);
  vi.spyOn(fs, 'realpath').mockImplementation(async input => {
    const result = await realpath(input);
    if (input === alias) { await fs.unlink(alias); await link(second, alias); }
    return result;
  });
  await expect(new PrivateOutputRoot(path.join(alias, 'store')).initialize()).rejects.toThrow('identity changed');
  expect(await fs.readdir(first)).toEqual([]); expect(await fs.readdir(second)).toEqual([]);
});

it('checks root identity again at the durable rename boundary and leaves foreign files untouched', async () => {
  const directory = path.join(root, 'store'), storage = new PrivateOutputRoot(directory); await storage.initialize();
  const open = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (args[1] === 'wx') {
      const close = handle.close.bind(handle);
      vi.spyOn(handle, 'close').mockImplementationOnce(async () => {
        await close(); await fs.rename(directory, `${directory}-retained`); await fs.mkdir(directory);
        await fs.writeFile(path.join(directory, 'receipt.json'), 'foreign');
      });
    }
    return handle;
  });
  await expect(durableJson(path.join(directory, 'receipt.json'), { phase: 'new' }, storage.check)).rejects.toThrow('identity changed');
  expect(await fs.readFile(path.join(directory, 'receipt.json'), 'utf8')).toBe('foreign');
});

it('rejects a non-directory ancestor and unsafe private permissions', async () => {
  const file = path.join(root, 'file'); await fs.writeFile(file, 'not a directory');
  await expect(new PrivateOutputRoot(path.join(file, 'store')).initialize()).rejects.toThrow();
  const storage = new PrivateOutputRoot(path.join(root, 'store')); await storage.initialize();
  if (process.platform !== 'win32') {
    await fs.chmod(storage.path, 0o755); expect(() => storage.path).toThrow('permissions');
  }
});
