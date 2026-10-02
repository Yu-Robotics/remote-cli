import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Readable, PassThrough } from 'stream';
import { createHash } from 'crypto';
import { atomicJson, displayName, FILE_MAX_BYTES, fileLimit, privateDirectory, readOwnedFile, readPrivateJson, saveStream } from '../src/files/FileIO';

describe('bounded attachment IO', () => {
  let root: string;
  beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'remote-file-io-'))); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const chunks = (extra = false) => Readable.from((function* () {
    const chunk = Buffer.alloc(64 * 1024, 42);
    for (let i = 0; i < FILE_MAX_BYTES / chunk.length; i++) yield chunk;
    if (extra) yield Buffer.from('x');
  })());

  it('reads complete bounded metadata across short reads and rejects oversized or symlinked manifests', async () => {
    const filename = path.join(root, 'metadata.json'); await atomicJson(filename, { name: 'complete metadata' });
    const open = fs.open.bind(fs);
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args: any[]) => {
      const handle = await (open as any)(...args); const read = handle.read.bind(handle);
      handle.read = (buffer: Buffer, offset: number, length: number, position: number) => read(buffer, offset, Math.min(length, 3), position);
      return handle;
    });
    try { expect(await readPrivateJson(filename)).toEqual({ name: 'complete metadata' }); }
    finally { spy.mockRestore(); }
    await fs.writeFile(filename, 'x'.repeat(64 * 1024 + 1)); await expect(readPrivateJson(filename)).rejects.toThrow('Unsafe');
    await fs.symlink(filename, path.join(root, 'link.json')); await expect(readPrivateJson(path.join(root, 'link.json'))).rejects.toThrow();
  });

  it('accepts exactly 20 MiB with streaming SHA-256 and restrictive permissions', async () => {
    const filename = path.join(root, 'original');
    const result = await saveStream(chunks(), filename, FILE_MAX_BYTES, new AbortController().signal);
    expect(result.size).toBe(FILE_MAX_BYTES);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await fs.stat(filename)).mode & 0o777).toBe(0o600);
    const hash = createHash('sha256');
    for await (const chunk of readOwnedFile(filename)) hash.update(chunk);
    expect(result.sha256).toBe(hash.digest('hex'));
  });
  it('rejects 20 MiB plus one byte and removes only its partial file', async () => {
    const filename = path.join(root, 'original');
    await expect(saveStream(chunks(true), filename, FILE_MAX_BYTES, new AbortController().signal)).rejects.toThrow('20 MiB');
    await expect(fs.stat(filename)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('handles empty files and rejects integrity mismatch', async () => {
    const filename = path.join(root, 'empty');
    const emptyHash = createHash('sha256').digest('hex');
    expect(await saveStream(Readable.from([]), filename, FILE_MAX_BYTES, new AbortController().signal, { size: 0, sha256: emptyHash })).toEqual({ size: 0, sha256: emptyHash });
    await expect(saveStream(Readable.from([Buffer.from('x')]), path.join(root, 'bad'), FILE_MAX_BYTES, new AbortController().signal, { size: 2, sha256: emptyHash })).rejects.toThrow('integrity');
    await expect(fs.stat(path.join(root, 'bad'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('aborts a stalled stream without waiting for data and cleans up the partial', async () => {
    const abort = new AbortController();
    const pending = saveStream(new PassThrough(), path.join(root, 'part'), FILE_MAX_BYTES, abort.signal);
    const checked = expect(pending).rejects.toThrow();
    abort.abort();
    await checked;
    await expect(fs.stat(path.join(root, 'part'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('does not overwrite or delete existing files and refuses symlink reads', async () => {
    const original = path.join(root, 'kept');
    await fs.writeFile(original, 'keep');
    await expect(saveStream(Readable.from(['bad']), original, FILE_MAX_BYTES, new AbortController().signal)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await fs.readFile(original, 'utf8')).toBe('keep');
    const link = path.join(root, 'link');
    await fs.symlink(original, link);
    expect(() => readOwnedFile(link)).toThrow();
    await expect(saveStream(Readable.from(['bad']), link, FILE_MAX_BYTES, new AbortController().signal)).rejects.toThrow();
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
  });
  it('refuses symlinked directories and saves atomic private metadata', async () => {
    const own = path.join(root, 'owned');
    await privateDirectory(own);
    await fs.symlink(own, path.join(root, 'linked'));
    await expect(privateDirectory(path.join(root, 'linked'))).rejects.toThrow('Unsafe');
    await atomicJson(path.join(own, 'metadata.json'), { size: 42 });
    await atomicJson(path.join(own, 'metadata.json'), { size: 43 });
    expect(JSON.parse(await fs.readFile(path.join(own, 'metadata.json'), 'utf8'))).toEqual({ size: 43 });
    expect(await fs.readdir(own)).toEqual(['metadata.json']);
  });
  it.each([0, -1, NaN, Infinity, FILE_MAX_BYTES + 1, 1.5])('refuses invalid configured limits (%s)', limit => {
    expect(() => fileLimit(limit)).toThrow();
  });
  it('allows downward limits and sanitizes display names without using them as paths', () => {
    expect(fileLimit()).toBe(FILE_MAX_BYTES);
    expect(fileLimit(1024)).toBe(1024);
    expect(displayName('name\u0000\n\u202efile.txt')).toBe('namefile.txt');
    expect(displayName({})).toBe('attachment');
    expect(displayName('x'.repeat(500))).toHaveLength(200);
  });
});
