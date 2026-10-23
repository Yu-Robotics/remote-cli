import { execFileSync } from 'child_process';
import { constants } from 'fs';
import * as fs from 'fs/promises';
import { mkdtemp, mkdir, realpath, rm, writeFile, symlink } from 'fs/promises';
import os, { tmpdir } from 'os';
import path from 'path';
import { setImmediate as nextTick } from 'timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DirectoryGuard } from '../src/security/DirectoryGuard';
import { extractLocalImagePaths, readLocalImagePath, readLocalImages } from '../src/utils/LocalImageDetector';
import { MAX_IMAGE_BYTES } from '../src/utils/ImageValidation';

vi.mock('fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('fs/promises')>(),
}));

const temporaryDirectories: string[] = [];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6SAAAAABJRU5ErkJggg==', 'base64');

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await nextTick();
  expect(predicate()).toBe(true);
}

async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'remote-cli-image-test-')));
  temporaryDirectories.push(directory);
  vi.spyOn(os, 'homedir').mockReturnValue(directory);
  const workspace = path.join(directory, 'workspace');
  await mkdir(workspace);
  return { directory, workspace, guard: new DirectoryGuard([workspace]) };
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('LocalImageDetector', () => {
  it.each([undefined, null, 0, false, {}, [], [{ type: 'text', text: 'chart.png' }]])(
    'ignores non-string input without inspecting files (%j)', async content => {
      expect(extractLocalImagePaths(content)).toEqual([]);
      let policyCalls = 0;
      expect(await readLocalImages(content, '/workspace', () => { policyCalls++; return true; })).toEqual([]);
      expect(policyCalls).toBe(0);
    },
  );

  it('extracts Markdown and plain local image paths without duplicates', () => {
    expect(extractLocalImagePaths(
      '![chart](./chart.png) and /workspace/chart.png. Also chart.png',
    )).toEqual(['./chart.png', '/workspace/chart.png', 'chart.png']);
  });

  it('extracts standard Markdown image destinations with titles and angle brackets', () => {
    expect(extractLocalImagePaths(
      '![chart](./chart.png "Chart") ![plot](<charts/my plot.png>)',
    )).toEqual(['./chart.png', 'charts/my plot.png']);
  });

  it('extracts full and collapsed reference-style Markdown images', () => {
    expect(extractLocalImagePaths([
      '![chart][chart-ref]',
      '![plot][]',
      '![plot]',
      '',
      '[chart-ref]: ./chart.png',
      '[plot]: <./plot.png> "Plot"',
    ].join('\n'))).toEqual(['./chart.png', './plot.png']);
  });

  it('reads allowed images as base64 blocks', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'remote-cli-image-test-'));
    temporaryDirectories.push(directory);
    const imagePath = path.join(directory, 'chart.png');
    await mkdir(directory, { recursive: true });
    await writeFile(imagePath, png);

    const images = await readLocalImages(`![chart](${imagePath})`, directory, () => true);

    expect(images).toEqual([{
      path: imagePath,
      data: png.toString('base64'),
      mimeType: 'image/png',
    }]);
  });

  it('does not read paths rejected by the directory policy', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'remote-cli-image-test-'));
    temporaryDirectories.push(directory);
    await writeFile(path.join(directory, 'chart.png'), png);

    await expect(readLocalImages('chart.png', directory, () => false)).resolves.toEqual([]);
  });

  it('skips images larger than 2 MiB', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'remote-cli-image-test-'));
    temporaryDirectories.push(directory);
    await writeFile(path.join(directory, 'large.png'), Buffer.alloc(2 * 1024 * 1024 + 1));

    await expect(readLocalImages('large.png', directory, () => true)).resolves.toEqual([]);
  });

  it('preserves Markdown spaces, titles, references, and escaped punctuation', async () => {
    const { workspace, guard } = await fixture();
    for (const name of ['my chart.png', 'chart(1).png', 'ref.png']) await writeFile(path.join(workspace, name), png);
    const images = await readLocalImages([
      '![chart](<./my chart.png> "Chart title")',
      '![chart](./chart\\(1\\).png)',
      '![reference][ref]',
      '[ref]: ./ref.png "Reference"',
    ].join('\n'), workspace, guard);
    expect(images.map(image => path.basename(image.path))).toEqual(['my chart.png', 'chart(1).png', 'ref.png']);
  });

  it('excludes remote URLs, data URLs, and HTML attributes', () => {
    expect(extractLocalImagePaths([
      '![remote](https://example.com/chart.png) ![remote](//example.com/chart.png)',
      'ftp://example.com/chart.png file:///workspace/chart.png',
      '![embedded](data:image/png;base64,AAAA) <img src="./hidden.png">',
    ].join('\n'))).toEqual([]);
  });

  it('counts invalid and duplicate candidates toward the 32-attempt budget', () => {
    expect(extractLocalImagePaths(`${'![remote](https://example.com/chart.png) '.repeat(32)}![late](late.png)`)).toEqual([]);
    expect(extractLocalImagePaths(`${'same.png '.repeat(32)}late.png`)).toEqual(['same.png']);
    expect(extractLocalImagePaths(Array.from({ length: 40 }, (_, i) => `![${i}](chart${i}.png)`).join(' ')))
      .toHaveLength(32);
    expect(extractLocalImagePaths(`${'![missing][unknown] '.repeat(32)}late.png`)).toEqual([]);
  });

  it('bounds missing-file read attempts before filesystem work', async () => {
    const { workspace } = await fixture();
    const policy = vi.fn(() => true);
    expect(await readLocalImages(Array.from({ length: 80 }, (_, i) => `missing${i}.png`).join(' '), workspace, policy)).toEqual([]);
    expect(policy).toHaveBeenCalledTimes(32);
  });

  it('reads one literal saved path, including spaces and extensionless files, using bytes for MIME', async () => {
    const { workspace, guard } = await fixture();
    await writeFile(path.join(workspace, 'native saved image'), png);
    await writeFile(path.join(workspace, 'mislabeled.jpg'), png);
    expect(await readLocalImagePath('native saved image', workspace, guard)).toEqual({
      path: path.join(workspace, 'native saved image'), data: png.toString('base64'), mimeType: 'image/png',
    });
    expect((await readLocalImages('mislabeled.jpg', workspace, guard))[0].mimeType).toBe('image/png');
    expect(await readLocalImagePath('![chart](mislabeled.jpg)', workspace, guard)).toBeNull();
    expect(await readLocalImagePath('https://example.com/image.png', workspace, guard)).toBeNull();
    expect(await readLocalImagePath('', workspace, guard)).toBeNull();
    expect(await readLocalImagePath(null as unknown as string, workspace, guard)).toBeNull();
  });

  it('requires lexical permission as well as canonical containment', async () => {
    const { directory, workspace, guard } = await fixture();
    await writeFile(path.join(workspace, 'inside.png'), png);
    await symlink(path.join(workspace, 'inside.png'), path.join(directory, 'outside-link.png'));
    const openSpy = vi.spyOn(fs, 'open');
    expect(await readLocalImagePath('../outside-link.png', workspace, guard)).toBeNull();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('rejects file and ancestor symlinks escaping allowed roots, including prefix siblings', async () => {
    const { directory, workspace, guard } = await fixture();
    const sibling = path.join(directory, 'workspace-other');
    await mkdir(sibling);
    await writeFile(path.join(sibling, 'outside.png'), png);
    await symlink(path.join(sibling, 'outside.png'), path.join(workspace, 'escape.png'));
    await symlink(sibling, path.join(workspace, 'escape-directory'), 'dir');
    const openSpy = vi.spyOn(fs, 'open');
    expect(await readLocalImagePath('escape.png', workspace, guard)).toBeNull();
    expect(await readLocalImagePath('escape-directory/outside.png', workspace, guard)).toBeNull();
    expect(await readLocalImages('escape.png', workspace, (candidate, cwd) => guard.isSafePath(candidate, cwd))).toEqual([]);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('resolves configured root aliases and permits symlinks remaining inside them', async () => {
    const { directory, workspace } = await fixture();
    const alias = path.join(directory, 'allowed-alias');
    await symlink(workspace, alias, 'dir');
    await writeFile(path.join(workspace, 'inside.png'), png);
    await symlink('inside.png', path.join(workspace, 'linked.png'));
    const guard = new DirectoryGuard([path.join(directory, 'missing-root'), alias]);
    expect((await readLocalImagePath('linked.png', alias, guard))?.data).toBe(png.toString('base64'));
    expect((await readLocalImagePath('~/allowed-alias/inside.png', alias, guard))?.data).toBe(png.toString('base64'));
    expect(guard.getAllowedDirectories()).toEqual([path.join(directory, 'missing-root'), alias]);
  });

  it('rejects directories, empty files, unknown bytes, and oversized files without unbounded reads', async () => {
    const { workspace, guard } = await fixture();
    await mkdir(path.join(workspace, 'directory.png'));
    await writeFile(path.join(workspace, 'empty.png'), Buffer.alloc(0));
    await writeFile(path.join(workspace, 'text.png'), 'synthetic text, not an image');
    await writeFile(path.join(workspace, 'large.png'), Buffer.alloc(MAX_IMAGE_BYTES + 1));
    expect(await readLocalImages('directory.png empty.png text.png large.png missing.png', workspace, guard)).toEqual([]);
    const exact = Buffer.alloc(MAX_IMAGE_BYTES);
    png.copy(exact);
    await writeFile(path.join(workspace, 'exact.png'), exact);
    expect((await readLocalImagePath('exact.png', workspace, guard))?.data).toBe(exact.toString('base64'));
  });

  it.skipIf(process.platform === 'win32')('rejects a FIFO without opening or blocking on it', async () => {
    const { workspace, guard } = await fixture();
    execFileSync('mkfifo', [path.join(workspace, 'pipe.png')]);
    const openSpy = vi.spyOn(fs, 'open');
    expect(await readLocalImagePath('pipe.png', workspace, guard)).toBeNull();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('opens with no-follow/nonblocking flags and rejects replacement between lstat and open', async () => {
    const { workspace, guard } = await fixture();
    const file = path.join(workspace, 'chart.png');
    await writeFile(file, png);
    const originalOpen = fs.open;
    const close = vi.fn();
    const read = vi.fn();
    vi.spyOn(fs, 'open').mockImplementationOnce(async (filePath, flags, mode) => {
      expect(flags).toBe(constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      await fs.rename(file, `${file}.old`);
      await writeFile(file, png);
      const handle = await originalOpen(filePath, flags, mode);
      const originalRead = handle.read.bind(handle);
      vi.spyOn(handle, 'read').mockImplementation(async (...args: Parameters<typeof originalRead>) => {
        read();
        return originalRead(...args);
      });
      const originalClose = handle.close.bind(handle);
      vi.spyOn(handle, 'close').mockImplementation(async () => { close(); await originalClose(); });
      return handle;
    });
    expect(await readLocalImagePath('chart.png', workspace, guard)).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('bounds reads to max+1 if a regular file grows after fstat', async () => {
    const { workspace, guard } = await fixture();
    const file = path.join(workspace, 'growing.png');
    await writeFile(file, png);
    const originalOpen = fs.open;
    let bytesRead = 0;
    const closed = vi.fn();
    vi.spyOn(fs, 'open').mockImplementationOnce(async (filePath, flags, mode) => {
      const handle = await originalOpen(filePath, flags, mode);
      const originalRead = handle.read.bind(handle);
      let first = true;
      vi.spyOn(handle, 'read').mockImplementation(async (...args: Parameters<typeof originalRead>) => {
        if (first) { first = false; await fs.appendFile(file, Buffer.alloc(MAX_IMAGE_BYTES + 100)); }
        const result = await originalRead(...args);
        bytesRead += result.bytesRead;
        return result;
      });
      const originalClose = handle.close.bind(handle);
      vi.spyOn(handle, 'close').mockImplementation(async () => { await originalClose(); closed(); });
      return handle;
    });
    expect(await readLocalImagePath('growing.png', workspace, guard)).toBeNull();
    expect(bytesRead).toBe(MAX_IMAGE_BYTES + 1);
    expect(closed).toHaveBeenCalledOnce();
  });

  it('closes the handle after a read failure', async () => {
    const { workspace, guard } = await fixture();
    await writeFile(path.join(workspace, 'chart.png'), png);
    const originalOpen = fs.open;
    const closed = vi.fn();
    vi.spyOn(fs, 'open').mockImplementationOnce(async (filePath, flags, mode) => {
      const handle = await originalOpen(filePath, flags, mode);
      vi.spyOn(handle, 'read').mockRejectedValue(new Error('Synthetic read failure'));
      const originalClose = handle.close.bind(handle);
      vi.spyOn(handle, 'close').mockImplementation(async () => { await originalClose(); closed(); });
      return handle;
    });
    expect(await readLocalImagePath('chart.png', workspace, guard)).toBeNull();
    expect(closed).toHaveBeenCalledOnce();
  });

  it.each(['replacement', 'metadata change', 'policy revocation'])(
    'rejects a file after a concurrent %s during reading', async change => {
      const { workspace, guard } = await fixture();
      const file = path.join(workspace, 'chart.png');
      await writeFile(file, png);
      const originalOpen = fs.open;
      const closed = vi.fn();
      vi.spyOn(fs, 'open').mockImplementationOnce(async (filePath, flags, mode) => {
        const handle = await originalOpen(filePath, flags, mode);
        const originalRead = handle.read.bind(handle);
        vi.spyOn(handle, 'read').mockImplementation(async (...args: Parameters<typeof originalRead>) => {
          const result = await originalRead(...args);
          if (result.bytesRead === 0) {
            if (change === 'replacement') {
              await fs.rename(file, `${file}.old`);
              await writeFile(file, png);
            } else if (change === 'metadata change') {
              await fs.utimes(file, new Date(0), new Date(0));
            } else guard.removeAllowedDirectory(workspace);
          }
          return result;
        });
        const originalClose = handle.close.bind(handle);
        vi.spyOn(handle, 'close').mockImplementation(async () => { await originalClose(); closed(); });
        return handle;
      });
      expect(await readLocalImagePath('chart.png', workspace, guard)).toBeNull();
      expect(closed).toHaveBeenCalledOnce();
    },
  );

  it('closes an open that finishes after its logical deadline without reading it', async () => {
    const { workspace, guard } = await fixture();
    await writeFile(path.join(workspace, 'chart.png'), png);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const originalOpen = fs.open;
    let release: (() => void) | undefined;
    let closed = false;
    const read = vi.fn();
    vi.spyOn(fs, 'open').mockImplementationOnce(async (filePath, flags, mode) => {
      const handle = await originalOpen(filePath, flags, mode);
      vi.spyOn(handle, 'read').mockImplementation(read);
      const originalClose = handle.close.bind(handle);
      vi.spyOn(handle, 'close').mockImplementation(async () => { await originalClose(); closed = true; });
      await new Promise<void>(resolve => { release = resolve; });
      return handle;
    });
    const pending = readLocalImagePath('chart.png', workspace, guard);
    try {
      await waitFor(() => !!release);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await pending).toBeNull();
    } finally {
      release?.();
      await waitFor(() => closed);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects a symlink retargeted outside the allowed root during the read', async () => {
    const { directory, workspace, guard } = await fixture();
    await writeFile(path.join(workspace, 'inside.png'), png);
    await writeFile(path.join(directory, 'outside.png'), png);
    const link = path.join(workspace, 'linked.png');
    await symlink('inside.png', link);
    const originalOpen = fs.open;
    vi.spyOn(fs, 'open').mockImplementationOnce(async (filePath, flags, mode) => {
      const handle = await originalOpen(filePath, flags, mode);
      const originalRead = handle.read.bind(handle);
      vi.spyOn(handle, 'read').mockImplementation(async (...args: Parameters<typeof originalRead>) => {
        const result = await originalRead(...args);
        if (result.bytesRead === 0) {
          await fs.unlink(link);
          await symlink(path.join(directory, 'outside.png'), link);
        }
        return result;
      });
      return handle;
    });
    expect(await readLocalImagePath('linked.png', workspace, guard)).toBeNull();
  });

  it('fences timed-out reads and retains all four permits until underlying cleanup settles', async () => {
    const { workspace, guard } = await fixture();
    await writeFile(path.join(workspace, 'chart.png'), png);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const originalOpen = fs.open;
    const releases: Array<() => void> = [];
    const closeReleases: Array<() => void> = [];
    let releaseCloses = false;
    let closed = 0;
    const openSpy = vi.spyOn(fs, 'open').mockImplementation(async (filePath, flags, mode) => {
      const handle = await originalOpen(filePath, flags, mode);
      const originalRead = handle.read.bind(handle);
      vi.spyOn(handle, 'read').mockImplementationOnce(async (...args: Parameters<typeof originalRead>) => {
        await new Promise<void>(resolve => releases.push(resolve));
        return originalRead(...args);
      });
      const originalClose = handle.close.bind(handle);
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        if (!releaseCloses) await new Promise<void>(resolve => closeReleases.push(resolve));
        await originalClose();
        closed++;
      });
      return handle;
    });
    const pending = Array.from({ length: 4 }, () => readLocalImagePath('chart.png', workspace, guard));
    try {
      await waitFor(() => releases.length === 4);
      expect(releases).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await Promise.all(pending)).toEqual([null, null, null, null]);
      expect(await readLocalImagePath('chart.png', workspace, guard)).toBeNull();
      expect(openSpy).toHaveBeenCalledTimes(4);
      for (const release of releases) release();
      await waitFor(() => closeReleases.length === 4);
      expect(await readLocalImagePath('chart.png', workspace, guard)).toBeNull();
      expect(openSpy).toHaveBeenCalledTimes(4);
    } finally {
      for (const release of releases) release();
      releaseCloses = true;
      for (const release of closeReleases) release();
      await waitFor(() => closed === 4);
      openSpy.mockRestore();
    }
    expect(closed).toBe(4);
    expect((await readLocalImagePath('chart.png', workspace, guard))?.data).toBe(png.toString('base64'));
    expect(vi.getTimerCount()).toBe(0);
  });
});
