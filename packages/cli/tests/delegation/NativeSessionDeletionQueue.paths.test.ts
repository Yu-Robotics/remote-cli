import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { NativeSessionDeletionQueue } from '../../src/delegation/NativeSessionDeletion';

// Model Windows path syntax without changing the host platform or touching a
// Windows-looking path on disk. Native runner coverage is still required.
vi.mock('path', async importOriginal => {
  const original = await importOriginal<typeof import('path')>();
  return { ...original, default: original.win32 };
});

describe('native deletion queue Windows canonical paths', () => {
  const canonicalParent = String.raw`C:\Users\FixtureUser\Temp\fixture\.remote-cli`;
  const directory = path.join(canonicalParent, 'native-session-deletions');
  beforeEach(() => {
    vi.spyOn(fs, 'realpath').mockImplementation(async file => String(file));
    vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    vi.spyOn(fs, 'readdir').mockResolvedValue([]);
  });
  afterEach(() => vi.restoreAllMocks());

  it('accepts an empty queue rooted in the native canonical spelling', async () => {
    await expect(new NativeSessionDeletionQueue(directory).requests()).resolves.toEqual([]);
    expect(fs.readdir).toHaveBeenCalledWith(directory);
  });

  it.each([
    ['drive case', String.raw`c:\Users\FixtureUser\Temp\fixture\.remote-cli`],
    ['component case', String.raw`C:\users\fixtureuser\Temp\fixture\.remote-cli`],
    ['DOS short name', String.raw`C:\Users\FIXTUR~1\Temp\fixture\.remote-cli`],
    ['foreign parent', String.raw`C:\Other\fixture\.remote-cli`],
  ])('rejects %s expansion before creating or inspecting the queue', async (_kind, parent) => {
    vi.mocked(fs.realpath).mockResolvedValue(canonicalParent);
    const queue = new NativeSessionDeletionQueue(path.join(parent, 'native-session-deletions'));
    await expect(queue.requests()).rejects.toThrow('Deletion queue root changed');
    expect(fs.realpath).toHaveBeenCalledWith(parent);
    expect(fs.mkdir).not.toHaveBeenCalled();
    expect(fs.readdir).not.toHaveBeenCalled();
  });

  it('rejects a redirected queue even when its parent spelling is canonical', async () => {
    vi.mocked(fs.realpath).mockResolvedValueOnce(canonicalParent).mockResolvedValueOnce(String.raw`C:\Other\queue`);
    await expect(new NativeSessionDeletionQueue(directory).requests()).rejects.toThrow('Deletion queue is redirected');
    expect(fs.readdir).not.toHaveBeenCalled();
  });
});
