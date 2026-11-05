import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NativeHistoryAnchor } from '../../src/delegation/HistoryAnchor';
import { readNativeHistoryTree } from '../../src/delegation/NativeHistoryRead';
import { nativeBindings } from '../../src/native/NativeBindings';
import type { HistoryEntry } from '../../src/delegation/NativeHistoryFiles';

describe('native handle-relative history operations', () => {
  let home: string;
  beforeEach(async () => { home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-anchor-'))); });
  afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });
  async function entry(file: string): Promise<HistoryEntry> {
    const s = await fs.lstat(file, { bigint: true });
    return { path: file, dev: String(s.dev), ino: String(s.ino), kind: s.isDirectory() ? 'directory' : 'file', size: String(s.size), mtime: String(s.mtimeNs) };
  }
  it('agrees with Node filesystem identity and permanently removes only manifested entries', async () => {
    const file = path.join(home, 'history.jsonl'), keep = path.join(home, 'result.txt');
    await fs.writeFile(file, 'history'); await fs.writeFile(keep, 'result');
    const target = await entry(file), scope = await entry(home);
    const anchor = await NativeHistoryAnchor.open(scope, [target]);
    try { await anchor.remove(target); expect(await anchor.exists(file)).toBe(false); await anchor.remove(target); }
    finally { await anchor.close(); }
    expect(await fs.readFile(keep, 'utf8')).toBe('result');
  });
  it('removes nested history and resumes after a partial deletion', async () => {
    const directory = path.join(home, 'nested'), file = path.join(directory, 'history');
    await fs.mkdir(directory); await fs.writeFile(file, 'data');
    const scope = await entry(home), dir = await entry(directory), target = await entry(file);
    const first = await NativeHistoryAnchor.open(scope, [dir, target]);
    try { await first.remove(target); } finally { await first.close(); }
    const retry = await NativeHistoryAnchor.open(scope, [dir, target]);
    try { await retry.remove(target); await retry.remove(dir); expect(await retry.exists(directory)).toBe(false); }
    finally { await retry.close(); }
  });
  it('does not follow a replaced ancestor into an unrelated directory', async () => {
    const scope = path.join(home, 'scope'), moved = path.join(home, 'moved'), outside = path.join(home, 'outside');
    await fs.mkdir(scope); await fs.mkdir(outside);
    const file = path.join(scope, 'history'); await fs.writeFile(file, 'owned'); await fs.writeFile(path.join(outside, 'history'), 'foreign');
    const target = await entry(file), anchor = await NativeHistoryAnchor.open(await entry(scope), [target]);
    try {
      await fs.rename(scope, moved);
      await fs.symlink(outside, scope, process.platform === 'win32' ? 'junction' : 'dir');
      await anchor.remove(target);
      expect(await fs.readFile(path.join(outside, 'history'), 'utf8')).toBe('foreign');
      await expect(fs.lstat(path.join(moved, 'history'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await anchor.close(); }
  });
  it('refuses changed files and hard-linked histories', async () => {
    const file = path.join(home, 'history'); await fs.writeFile(file, 'old');
    const target = await entry(file), anchor = await NativeHistoryAnchor.open(await entry(home), [target]);
    try { await fs.writeFile(file, 'changed'); await expect(anchor.remove(target)).rejects.toThrow('changed'); }
    finally { await anchor.close(); }
    await fs.link(file, path.join(home, 'link'));
    await expect(NativeHistoryAnchor.open(await entry(home), [await entry(file)])).rejects.toThrow();
  });
  it('reads nested native deliverables without changing their bytes', async () => {
    const dir = path.join(home, 'artifacts'); await fs.mkdir(dir);
    const bytes = Buffer.from([0, 1, 255, 17]); await fs.writeFile(path.join(dir, 'result.bin'), bytes);
    const result = readNativeHistoryTree(home, [await entry(home)], 1024, 10);
    expect(result.get('artifacts/result.bin')).toEqual(bytes);
    const root = await entry(home);
    expect(() => readNativeHistoryTree(home, [root], 1, 10)).toThrow();
  });
  it('rejects path traversal, symlink entries and closed handles', async () => {
    const native = nativeBindings(), handle = native.openRoot(home);
    try {
      expect(() => native.openEntry(handle, '..')).toThrow();
      const dir = path.join(home, 'directory'); await fs.mkdir(dir);
      await fs.symlink(dir, path.join(home, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
      expect(() => native.openEntry(handle, 'alias')).toThrow();
    } finally { native.close(handle); }
    expect(() => native.entries(handle)).toThrow(); native.close(handle);
  });
});
