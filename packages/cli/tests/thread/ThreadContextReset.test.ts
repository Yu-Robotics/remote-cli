import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { ThreadContextReset } from '../../src/thread/ThreadContextReset';

describe('ThreadContextReset', () => {
  let directory: string;
  let resets: ThreadContextReset;
  beforeEach(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'thread-reset-intent-')));
    resets = new ThreadContextReset(directory);
  });
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }); });

  it('persists blocking intent independently of thread metadata and survives a restart', async () => {
    await resets.begin('thread-a');
    await resets.begin('thread-a');
    const loaded = new ThreadContextReset(directory);
    expect(() => loaded.assertReady('thread-a')).toThrow('Retry /clear or /new');
    expect(() => loaded.assertReady('thread-b')).not.toThrow();
    await loaded.complete('thread-a');
    expect(new ThreadContextReset(directory).isPending('thread-a')).toBe(false);
  });

  it('keeps admission blocked if clearing the durable marker fails', async () => {
    await resets.begin('thread-a');
    const fail = vi.spyOn(fs, 'rm').mockRejectedValueOnce(new Error('Synthetic unlink failure'));
    await expect(resets.complete('thread-a')).rejects.toThrow('Synthetic');
    expect(() => resets.assertReady('thread-a')).toThrow('incomplete');
    expect(() => new ThreadContextReset(directory).assertReady('thread-a')).toThrow('incomplete');
    fail.mockRestore();
    await resets.complete('thread-a');
    expect(() => resets.assertReady('thread-a')).not.toThrow();
  });

  it('treats any existing intent entry as pending, without relying on a valid payload', async () => {
    await resets.begin('thread-a');
    const [name] = await fs.readdir(directory);
    await fs.writeFile(path.join(directory, name), 'interrupted payload');
    expect(() => new ThreadContextReset(directory).assertReady('thread-a')).toThrow('incomplete');
    await fs.rm(path.join(directory, name));
    await fs.mkdir(path.join(directory, name));
    expect(() => new ThreadContextReset(directory).assertReady('thread-a')).toThrow('incomplete');
  });

  it('refuses admission when local reset storage cannot be inspected', async () => {
    const file = path.join(directory, 'unexpected-file');
    await fs.writeFile(file, 'preserved');
    const unavailable = new ThreadContextReset(file);
    expect(() => unavailable.assertReady('thread-a')).toThrow('Cannot verify');
    await expect(unavailable.begin('thread-a')).rejects.toThrow();
    expect(() => unavailable.assertReady('thread-a')).toThrow('incomplete');
    expect(await fs.readFile(file, 'utf8')).toBe('preserved');
  });
  it('keeps generation independent of stale thread metadata and publishes only atomic replacements', async () => {
    await resets.begin('thread-a');
    expect(await resets.advanceGeneration('thread-a', 4)).toBe(5);
    await resets.complete('thread-a');
    const loaded = new ThreadContextReset(directory);
    expect(loaded.generation('thread-a', 0)).toBe(5);
    expect(loaded.generation('thread-b', 0)).toBe(0);
    await loaded.begin('thread-a');
    const failure = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('Synthetic atomic replace failure'));
    await expect(loaded.advanceGeneration('thread-a')).rejects.toThrow('Synthetic');
    expect(new ThreadContextReset(directory).generation('thread-a')).toBe(5);
    expect(new ThreadContextReset(directory).isPending('thread-a')).toBe(true);
    failure.mockRestore();
    const [first, second] = await Promise.all([loaded.advanceGeneration('thread-a'), loaded.advanceGeneration('thread-a')]);
    expect([first, second]).toEqual([6, 6]);
  });

  it('fails closed after a corrupt authoritative generation record instead of resuming old lanes', async () => {
    await resets.begin('thread-a');
    await resets.advanceGeneration('thread-a');
    await resets.complete('thread-a');
    const generation = (await fs.readdir(directory)).find(file => file.endsWith('.generation'))!;
    await fs.writeFile(path.join(directory, generation), '{');
    expect(() => new ThreadContextReset(directory).generation('thread-a')).toThrow('Cannot verify');
  });

});
