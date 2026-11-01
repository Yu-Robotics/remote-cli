import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { replaceAtomicFile } from '../../src/delegation/AtomicFile';

describe('atomic record replacement on Windows', () => {
  let directory: string;
  let target: string;
  let temporary: string;
  beforeEach(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'delegation-atomic-')));
    target = path.join(directory, 'record');
    temporary = path.join(directory, 'next');
    await fs.writeFile(target, 'original');
    await fs.writeFile(temporary, 'replacement');
  });
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }); });

  it('keeps the previous bytes through sharing violations and then atomically replaces them', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const rename = fs.rename.bind(fs);
    let failures = 2;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (failures-- > 0) {
        expect(await fs.readFile(target, 'utf8')).toBe('original');
        expect(await fs.readFile(temporary, 'utf8')).toBe('replacement');
        throw Object.assign(new Error('Synthetic sharing violation'), { code: 'EPERM' });
      }
      return rename(from, to);
    });
    const unlink = vi.spyOn(fs, 'unlink');
    await replaceAtomicFile(temporary, target);
    expect(await fs.readFile(target, 'utf8')).toBe('replacement');
    expect(unlink).not.toHaveBeenCalled();
    expect(fs.rename).toHaveBeenCalledTimes(3);
  });

  it.each(['EPERM', 'EACCES', 'EBUSY'])('bounds retries for persistent %s and preserves both files', async code => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const failure = Object.assign(new Error('Synthetic persistent denial'), { code });
    vi.spyOn(fs, 'rename').mockRejectedValue(failure);
    await expect(replaceAtomicFile(temporary, target)).rejects.toBe(failure);
    expect(fs.rename).toHaveBeenCalledTimes(6);
    expect(await fs.readFile(target, 'utf8')).toBe('original');
    expect(await fs.readFile(temporary, 'utf8')).toBe('replacement');
  });

  it.each(['linux', 'darwin', 'win32'])('does not retry structural errors on %s', async platform => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    const failure = Object.assign(new Error('Synthetic structural failure'), { code: platform === 'win32' ? 'ENOENT' : 'EPERM' });
    vi.spyOn(fs, 'rename').mockRejectedValue(failure);
    await expect(replaceAtomicFile(temporary, target)).rejects.toBe(failure);
    expect(fs.rename).toHaveBeenCalledOnce();
    expect(await fs.readFile(target, 'utf8')).toBe('original');
  });
});
