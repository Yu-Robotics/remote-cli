import fs, { type FileHandle } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LinuxHistoryAnchor } from '../../src/delegation/LinuxHistoryAnchor';
import { historyDirectory, historyIdentity } from '../../src/delegation/NativeHistoryFiles';

// These are descriptor/procfs integration checks, not mocked platform validation.
describe.skipIf(process.platform !== 'linux')('Linux native history directory anchors', () => {
  let root: string;
  let file: string;
  let handles: FileHandle[];
  let originalOpen: typeof fs.open;
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'history-anchor-')));
    file = path.join(root, 'history.jsonl'); await fs.writeFile(file, 'synthetic history');
    handles = [];
    originalOpen = fs.open;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => { const handle = await originalOpen(...args); handles.push(handle); return handle; });
  });
  afterEach(async () => {
    try { expect(handles.every(handle => handle.fd === -1)).toBe(true); }
    finally {
      await Promise.allSettled(handles.filter(handle => handle.fd !== -1).map(handle => handle.close()));
      vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true });
    }
  });
  it('uses only descriptor paths and single names for mutations, and closes all handles', async () => {
    const entry = await historyIdentity(file, 'file'); const unlink = vi.spyOn(fs, 'unlink');
    const anchor = await LinuxHistoryAnchor.open(await historyDirectory(root), [entry]);
    try { await anchor.remove(entry); expect(await anchor.exists(file)).toBe(false); }
    finally { await anchor.close(); }
    expect(unlink).toHaveBeenCalledWith(expect.stringMatching(/^\/proc\/self\/fd\/\d+\/history\.jsonl$/));
  });
  it('closes an opened handle when its fstat identity mismatches the receipt', async () => {
    const scope = await historyDirectory(root);
    await expect(LinuxHistoryAnchor.open({ ...scope, ino: String(BigInt(scope.ino) + 1n) }, [])).rejects.toThrow('identity');
    expect(handles).toHaveLength(1);
  });
  it('fails closed when procfs is unavailable after opening the scope', async () => {
    const scope = await historyDirectory(root); const entry = await historyIdentity(file, 'file');
    const stat = fs.stat; vi.spyOn(fs, 'stat').mockImplementation((...args: any[]) => {
      if (String(args[0]).startsWith('/proc/self/fd/')) return Promise.reject(Object.assign(new Error('synthetic procfs unavailable'), { code: 'ENOENT' }));
      return (stat as any)(...args);
    });
    await expect(LinuxHistoryAnchor.open(scope, [entry])).rejects.toThrow('procfs');
    expect(await fs.readFile(file, 'utf8')).toBe('synthetic history');
  });
  it('does not confuse disappearing procfs with a missing prepared leaf', async () => {
    const entry = await historyIdentity(file, 'file'); const anchor = await LinuxHistoryAnchor.open(await historyDirectory(root), [entry]);
    try {
      const stat = fs.stat; vi.spyOn(fs, 'stat').mockImplementation((...args: any[]) => {
        if (String(args[0]).startsWith('/proc/self/fd/')) return Promise.reject(Object.assign(new Error('synthetic procfs vanished'), { code: 'ENOENT' }));
        return (stat as any)(...args);
      });
      await expect(anchor.exists(file)).rejects.toThrow('procfs');
      await expect(anchor.remove(entry)).rejects.toThrow('procfs');
      expect(await fs.readFile(file, 'utf8')).toBe('synthetic history');
    } finally { await anchor.close(); }
  });
  it('never opens a substituted nested symlink and closes previously opened ancestors', async () => {
    const directory = path.join(root, 'child'); await fs.mkdir(directory);
    const foreign = path.join(root, 'foreign'); await fs.mkdir(foreign); await fs.writeFile(path.join(foreign, 'keep'), 'sentinel');
    const entry = await historyIdentity(directory, 'directory'); const scope = await historyDirectory(root);
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('/child')) { await fs.rename(directory, directory + '-saved'); await fs.symlink(foreign, directory, 'dir'); }
      const handle = await originalOpen(...args); handles.push(handle); return handle;
    });
    await expect(LinuxHistoryAnchor.open(scope, [entry])).rejects.toThrow();
    expect(await fs.readFile(path.join(foreign, 'keep'), 'utf8')).toBe('sentinel');
    expect(handles).toHaveLength(1);
  });
  it('rejects a manifest lacking a parent and closes the scope', async () => {
    const parent = path.join(root, 'parent'); await fs.mkdir(parent); const nested = path.join(parent, 'leaf'); await fs.writeFile(nested, 'keep');
    await expect(LinuxHistoryAnchor.open(await historyDirectory(root), [await historyIdentity(nested, 'file')])).rejects.toThrow('ancestor');
  });
});

it.each(['darwin', 'win32'] as const)('refuses %s without attempting a descriptor open', async platform => {
  const open = vi.spyOn(fs, 'open'); const mocked = vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
  try {
    await expect(LinuxHistoryAnchor.open({ path: path.resolve(os.tmpdir()), dev: '1', ino: '1' }, [])).rejects.toThrow('Linux');
    expect(open).not.toHaveBeenCalled();
  } finally { mocked.mockRestore(); open.mockRestore(); }
});
