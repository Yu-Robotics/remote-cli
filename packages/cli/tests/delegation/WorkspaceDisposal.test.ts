import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertDisposableTree, exportWorkspaceFiles, verifyWorkspaceExports, WORKSPACE_EXPORT_LIMITS } from '../../src/delegation/WorkspaceDisposal';

describe('workspace disposal boundaries and bounded exports', () => {
  let directory: string;
  let checkout: string;
  let exports: string;
  beforeEach(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-disposal-')));
    checkout = path.join(directory, 'checkout');
    exports = path.join(directory, 'exports');
    await fs.mkdir(checkout); await fs.mkdir(exports);
    await fs.writeFile(path.join(checkout, '.git'), 'synthetic registration');
    await fs.writeFile(path.join(checkout, 'report.txt'), 'fixture report');
  });
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }); });

  it('keeps immutable verified output outside the disposable checkout', async () => {
    const manifest = await exportWorkspaceFiles(checkout, exports, ['report.txt']);
    expect(await exportWorkspaceFiles(checkout, exports, ['report.txt'])).toEqual(manifest);
    await verifyWorkspaceExports(exports, manifest, checkout);
    await fs.rm(checkout, { recursive: true });
    await verifyWorkspaceExports(exports, manifest);
    await fs.writeFile(path.join(exports, manifest[0].sha256), 'corrupt export');
    await expect(verifyWorkspaceExports(exports, manifest)).rejects.toThrow('export-storage-changed');
  });

  it.each(['../outside', '.git', 'directory/../report.txt', 'C:\\fixture.txt', 'directory//report.txt', ''])('rejects unsafe export %j', async name => {
    await expect(exportWorkspaceFiles(checkout, exports, [name])).rejects.toThrow('invalid-export-path');
  });

  it('rejects oversized and duplicate exports without silently truncating', async () => {
    await expect(exportWorkspaceFiles(checkout, exports, ['report.txt', 'report.txt'])).rejects.toThrow('invalid-export-manifest');
    await fs.truncate(path.join(checkout, 'report.txt'), WORKSPACE_EXPORT_LIMITS.fileBytes + 1);
    await expect(exportWorkspaceFiles(checkout, exports, ['report.txt'])).rejects.toThrow('export-unavailable-or-oversized');
    expect(await fs.readdir(exports)).toEqual([]);
  });

  it('rejects both a mounted root and a same-device bind mount below it', async () => {
    await fs.mkdir(path.join(checkout, 'cache'));
    await expect(assertDisposableTree(checkout, [checkout])).rejects.toThrow('mounted-checkout');
    await expect(assertDisposableTree(checkout, [path.join(checkout, 'cache')])).rejects.toThrow('mounted-checkout');
    await expect(assertDisposableTree(checkout, [path.join(directory, 'sibling')])).resolves.toBeUndefined();
  });

  it('rejects nested Git metadata even in a disposable cache', async () => {
    await fs.mkdir(path.join(checkout, 'node_modules', 'fixture', '.git'), { recursive: true });
    await expect(assertDisposableTree(checkout, [])).rejects.toThrow('nested-repository');
  });

  it.each(['.git', '.GIT'])('rejects nested metadata alias %s', async name => {
    await fs.mkdir(path.join(checkout, 'cache', name), { recursive: true });
    await expect(assertDisposableTree(checkout, [])).rejects.toThrow('nested-repository');
  });

  it('preserves a bare repository inside ignored cache data', async () => {
    const bare = path.join(checkout, 'cache', 'repository.git');
    await fs.mkdir(path.join(bare, 'objects'), { recursive: true });
    await fs.mkdir(path.join(bare, 'refs'));
    await fs.writeFile(path.join(bare, 'HEAD'), 'ref: refs/heads/main');
    await expect(assertDisposableTree(checkout, [])).rejects.toThrow('nested-repository');
    expect(await fs.readFile(path.join(bare, 'HEAD'), 'utf8')).toBe('ref: refs/heads/main');
  });

  it('never follows an untracked symlink or directory junction into unrelated files', async context => {
    const unrelated = path.join(directory, 'unrelated');
    await fs.mkdir(unrelated);
    await fs.writeFile(path.join(unrelated, 'keep.txt'), 'keep');
    try { await fs.symlink(unrelated, path.join(checkout, 'link'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { context.skip(); return; } throw error; }
    await expect(assertDisposableTree(checkout, [])).resolves.toBeUndefined();
    await expect(exportWorkspaceFiles(checkout, exports, [path.join('link', 'keep.txt')])).rejects.toThrow('unsafe-export-path');
    expect(await fs.readFile(path.join(unrelated, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('checks a device boundary without traversing it', async () => {
    const nested = path.join(checkout, 'mounted');
    await fs.mkdir(nested);
    const original = fs.lstat.bind(fs);
    vi.spyOn(fs, 'lstat').mockImplementation(async (file, ...args) => {
      const stat = await original(file, ...args as []);
      if (file === nested) Object.defineProperty(stat, 'dev', { value: Number(stat.dev) + 1 });
      return stat;
    });
    await expect(assertDisposableTree(checkout, [])).rejects.toThrow('unsafe-checkout-boundary');
  });
});
