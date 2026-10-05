import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { captureCheckpoint, checkpointRevision, createCheckpointCommit, gitText, runGit } from '../../src/delegation/GitCheckpoint';
import { gitFixture } from './gitFixture';

describe('private Git checkpoints', () => {
  let fixture: Awaited<ReturnType<typeof gitFixture>>;
  beforeEach(async () => { fixture = await gitFixture(); });
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(fixture.directory, { recursive: true, force: true }); });

  it('captures staged, unstaged, deleted, binary and untracked files without changing the parent index or branch', async () => {
    const { root, head } = fixture;
    await fs.writeFile(path.join(root, 'source.txt'), 'staged\n');
    await runGit(root, ['add', 'source.txt']);
    await fs.writeFile(path.join(root, 'source.txt'), 'unstaged after staging\n');
    await fs.rm(path.join(root, 'nested', 'local.txt'));
    await fs.writeFile(path.join(root, 'new.bin'), Buffer.from([0, 1, 2, 255]));
    await fs.writeFile(path.join(root, '.env'), 'SYNTHETIC_IGNORED=fixture\n');
    const index = await fs.readFile(path.join(root, '.git', 'index'));
    const snapshot = await captureCheckpoint(root);
    expect(await fs.readFile(path.join(root, '.git', 'index'))).toEqual(index);
    expect(await gitText(root, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await gitText(root, ['symbolic-ref', '--short', 'HEAD'])).toBe('main');
    expect(await gitText(root, ['show', `${snapshot.tree}:source.txt`])).toBe('unstaged after staging');
    expect(await runGit(root, ['show', `${snapshot.tree}:new.bin`])).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(await gitText(root, ['ls-tree', '-r', '--name-only', snapshot.tree])).not.toContain('.env');
    expect(await gitText(root, ['ls-tree', '-r', '--name-only', snapshot.tree])).not.toContain('nested/local.txt');
    expect(snapshot.revision).toBe(checkpointRevision(head, snapshot.tree, index));
  });

  it('rejects untracked credential files instead of copying them into worker checkouts', async () => {
    await fs.writeFile(path.join(fixture.root, 'credentials.json'), '{}');
    await expect(captureCheckpoint(fixture.root)).rejects.toThrow('Untracked credential');
    await fs.rm(path.join(fixture.root, 'credentials.json'));
    await fs.writeFile(path.join(fixture.root, '.env.example'), 'SYNTHETIC=value\n');
    await expect(captureCheckpoint(fixture.root)).resolves.toHaveProperty('tree');
  });

  it.each([
    ['assume-unchanged', 'modified'], ['assume-unchanged', 'deleted'],
    ['skip-worktree', 'modified'], ['skip-worktree', 'deleted'],
  ])('rejects %s entries with %s files without changing the source index', async (flag, state) => {
    const file = path.join(fixture.root, 'source.txt');
    await runGit(fixture.root, ['update-index', `--${flag}`, 'source.txt']);
    if (state === 'deleted') await fs.rm(file);
    else await fs.writeFile(file, 'local changes hidden from Git add\n');
    const index = await fs.readFile(path.join(fixture.root, '.git', 'index'));
    await expect(captureCheckpoint(fixture.root)).rejects.toThrow('assume-unchanged or skip-worktree');
    expect(await fs.readFile(path.join(fixture.root, '.git', 'index'))).toEqual(index);
    expect(await gitText(fixture.root, ['rev-parse', 'HEAD'])).toBe(fixture.head);
    if (state === 'deleted') await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    else expect(await fs.readFile(file, 'utf8')).toBe('local changes hidden from Git add\n');
  });

  it('preserves explicitly staged new files even when they match an ignore rule', async () => {
    await fs.writeFile(path.join(fixture.root, '.env'), 'SYNTHETIC_STAGED=fixture\n');
    await runGit(fixture.root, ['add', '--force', '.env']);
    const index = await fs.readFile(path.join(fixture.root, '.git', 'index'));
    const snapshot = await captureCheckpoint(fixture.root);
    expect(await gitText(fixture.root, ['show', `${snapshot.tree}:.env`])).toBe('SYNTHETIC_STAGED=fixture');
    expect(await fs.readFile(path.join(fixture.root, '.git', 'index'))).toEqual(index);
  });

  it('supports relative repository links but refuses links into shared external files', async () => {
    await fs.symlink('source.txt', path.join(fixture.root, 'local-link'));
    await expect(captureCheckpoint(fixture.root)).resolves.toHaveProperty('tree');
    await fs.symlink(fixture.root, path.join(fixture.root, 'external-link'));
    await expect(captureCheckpoint(fixture.root)).rejects.toThrow('symbolic links');
  });

  it.each(['committed', 'untracked'])('captures a %s file larger than the former 128 MiB limit', async kind => {
    const file = path.join(fixture.root, 'large.dat');
    const size = 129 * 1024 * 1024;
    await fs.writeFile(file, 'synthetic large file\n');
    await fs.truncate(file, size);
    if (kind === 'committed') {
      await runGit(fixture.root, ['add', 'large.dat']);
      await runGit(fixture.root, ['commit', '-m', 'Add synthetic large file']);
    }
    const head = await gitText(fixture.root, ['rev-parse', 'HEAD']);
    const index = await fs.readFile(path.join(fixture.root, '.git', 'index'));
    const snapshot = await captureCheckpoint(fixture.root);
    expect(await gitText(fixture.root, ['cat-file', '-s', `${snapshot.tree}:large.dat`])).toBe(String(size));
    expect(await fs.readFile(path.join(fixture.root, '.git', 'index'))).toEqual(index);
    expect(await gitText(fixture.root, ['rev-parse', 'HEAD'])).toBe(head);
    if (kind === 'committed') expect(snapshot.tree).toBe(await gitText(fixture.root, ['rev-parse', 'HEAD^{tree}']));
  }, 30_000);

  it('captures more than 10,000 tracked and untracked files without dropping input', async () => {
    const count = 10_001;
    for (const directory of ['committed', 'untracked']) await fs.mkdir(path.join(fixture.root, directory));
    for (let offset = 0; offset < count; offset += 128) {
      await Promise.all(Array.from({ length: Math.min(128, count - offset) }, (_, index) => {
        const number = offset + index;
        return fs.writeFile(path.join(fixture.root, number < 5000 ? 'committed' : 'untracked', `${number}.txt`), 'fixture\n');
      }));
    }
    await runGit(fixture.root, ['add', 'committed']);
    await runGit(fixture.root, ['commit', '-m', 'Add synthetic tracked files']);
    const index = await fs.readFile(path.join(fixture.root, '.git', 'index'));
    const head = await gitText(fixture.root, ['rev-parse', 'HEAD']);
    const snapshot = await captureCheckpoint(fixture.root);
    const files = (await runGit(fixture.root, ['ls-tree', '-r', '--name-only', '-z', snapshot.tree]))
      .toString('utf8').split('\0').filter(Boolean);
    expect(files).toHaveLength(count + 3);
    expect(files).toContain('committed/4999.txt');
    expect(files).toContain('untracked/10000.txt');
    expect(await fs.readFile(path.join(fixture.root, '.git', 'index'))).toEqual(index);
    expect(await gitText(fixture.root, ['rev-parse', 'HEAD'])).toBe(head);
  }, 30_000);

  it('rejects submodule and special-file entries', async () => {
    await runGit(fixture.root, ['update-index', '--add', '--cacheinfo', `160000,${fixture.head},module`]);
    await fs.mkdir(path.join(fixture.root, 'module'));
    await expect(captureCheckpoint(fixture.root)).rejects.toThrow('Submodules');
  });

  it('detects a changing input rather than claiming a stable snapshot', async () => {
    const original = fs.readFile.bind(fs);
    let reads = 0;
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args: any[]) => {
      const result = await (original as any)(...args);
      if (String(args[0]).endsWith(`${path.sep}.git${path.sep}index`) && ++reads === 2) return Buffer.concat([result, Buffer.from('changed')]);
      return result;
    });
    await expect(captureCheckpoint(fixture.root)).rejects.toThrow('Workspace changed');
  });

  it('preserves the captured tree when a Git clean filter expands a small file', async () => {
    await fs.writeFile(path.join(fixture.root, '.gitattributes'), 'source.txt filter=expand\n');
    await runGit(fixture.root, ['config', 'filter.expand.clean', "printf '%1024s' fixture"]);
    // Change the size so Git cannot skip the filter using the original index's stat cache.
    await fs.writeFile(path.join(fixture.root, 'source.txt'), 'new filter input\n');
    const snapshot = await captureCheckpoint(fixture.root);
    expect(await gitText(fixture.root, ['cat-file', '-s', `${snapshot.tree}:source.txt`])).toBe('1024');
  });

  it.skipIf(process.platform !== 'linux')('rejects raw non-UTF8 filenames instead of silently replacing their bytes', async () => {
    const file = Buffer.concat([Buffer.from(path.join(fixture.root, 'invalid-')), Buffer.from([0xff])]);
    await fs.writeFile(file, 'synthetic bytes\n');
    await expect(captureCheckpoint(fixture.root)).rejects.toThrow('valid UTF-8');
    expect(await gitText(fixture.root, ['rev-parse', 'HEAD'])).toBe(fixture.head);
  });

  it('rejects unresolved index conflicts and invalid object IDs', async () => {
    const blob = await gitText(fixture.root, ['hash-object', '-w', '--stdin'], 'conflict\n');
    await runGit(fixture.root, ['update-index', '--index-info'], `0 ${'0'.repeat(40)}\tsource.txt\n100644 ${blob} 1\tsource.txt\n100644 ${blob} 2\tsource.txt\n100644 ${blob} 3\tsource.txt\n`);
    await expect(captureCheckpoint(fixture.root)).rejects.toThrow('index conflicts');
    await expect(createCheckpointCommit(fixture.root, 'not-an-oid', fixture.head, 'Invalid')).rejects.toThrow('Invalid checkpoint');
  });

  it('does not honor inherited Git repository redirection', async () => {
    vi.stubEnv('GIT_DIR', path.join(fixture.directory, 'missing'));
    expect(await gitText(fixture.root, ['rev-parse', 'HEAD'])).toBe(fixture.head);
    vi.unstubAllEnvs();
    await expect(runGit(fixture.root, ['show', 'missing-reference'])).rejects.toThrow('Git show failed');
  });
});
