import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import * as childProcess from 'child_process';
import { gitText, runGit } from '../../src/delegation/GitCheckpoint';
import { gitFixture, nestedGitFixture, repositoryState } from './gitFixture';

const { cleanupHooks } = vi.hoisted(() => ({ cleanupHooks: [] as Array<() => Promise<void>> }));

vi.mock('vitest', async importOriginal => {
  const actual = await importOriginal<typeof import('vitest')>();
  return {
    ...actual,
    // Register the real hook and capture it to verify cleanup ownership directly.
    afterAll: (hook: () => Promise<void>) => {
      cleanupHooks.push(hook);
      actual.afterAll(hook);
    },
  };
});

vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const ownedDirectories: string[] = [];
const actualMkdtemp = fs.mkdtemp.bind(fs);

async function ownedFixture() {
  const fixture = await gitFixture();
  ownedDirectories.push(fixture.directory);
  return fixture;
}

function trackScratchDirectories() {
  return vi.spyOn(fs, 'mkdtemp').mockImplementation(async prefix => {
    const directory = await actualMkdtemp(prefix);
    ownedDirectories.push(directory);
    return directory;
  });
}

function gitCalls() {
  return vi.mocked(childProcess.spawn).mock.calls.filter(([command]) => command === 'git');
}

// Include Git metadata and empty directories, not only Git's tracked-file view.
async function treeBytes(root: string): Promise<Record<string, Buffer | null>> {
  const contents: Record<string, Buffer | null> = {};
  const visit = async (directory: string) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const relative = path.relative(root, file);
      if (entry.isDirectory()) {
        contents[relative] = null;
        await visit(file);
      } else {
        contents[relative] = await fs.readFile(file);
      }
    }
  };
  await visit(root);
  return contents;
}

describe('pristine real-Git fixture templates', { timeout: 30_000 }, () => {
  beforeEach(() => { vi.mocked(childProcess.spawn).mockClear(); });
  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      for (const cleanup of cleanupHooks) await cleanup();
    } finally {
      for (const directory of ownedDirectories.splice(0).reverse()) {
        await fs.rm(directory, { recursive: true, force: true });
      }
    }
  });

  it('bootstraps lazily once and performs no Git launches for subsequent copies', async () => {
    expect(cleanupHooks).toHaveLength(1);
    expect(gitCalls()).toHaveLength(0);
    const scratch = trackScratchDirectories();
    const first = await ownedFixture();
    const second = await ownedFixture();
    const third = await ownedFixture();
    expect(gitCalls()).toHaveLength(6);
    expect(gitCalls().filter(([, args]) => args?.includes('init'))).toHaveLength(1);
    expect(gitCalls().filter(([, args]) => args?.includes('commit'))).toHaveLength(1);
    expect(scratch).toHaveBeenCalledTimes(4);
    expect(new Set([first.directory, second.directory, third.directory]).size).toBe(3);
    expect(first.root).toBe(path.join(first.directory, 'repository'));
    expect(second.head).toBe(first.head);
    expect(third.head).toBe(first.head);
    expect(await fs.readFile(path.join(first.root, '.gitignore'), 'utf8')).toBe('node_modules/\n.env\n');
    expect(await fs.readFile(path.join(first.root, 'source.txt'), 'utf8')).toBe('first\nsecond\nthird\n');
    expect(await fs.readFile(path.join(first.root, 'nested/local.txt'), 'utf8')).toBe('nested\n');
    expect(await gitText(first.root, ['ls-files'])).toBe('.gitignore\nnested/local.txt\nsource.txt');
    expect(await gitText(first.root, ['rev-parse', 'HEAD'])).toBe(first.head);
    expect(await gitText(first.root, ['symbolic-ref', '--short', 'HEAD'])).toBe('main');
    expect(await gitText(first.root, ['config', '--local', 'user.email'])).toBe('test@example.com');
    expect(await gitText(first.root, ['status', '--porcelain'])).toBe('');
  });

  it('shares simultaneous first setup while giving every caller its own writable copy', async () => {
    const scratch = trackScratchDirectories();
    const fixtures = await Promise.all(Array.from({ length: 4 }, () => ownedFixture()));
    expect(gitCalls()).toHaveLength(6);
    expect(scratch).toHaveBeenCalledTimes(5);
    expect(new Set(fixtures.map(fixture => fixture.directory)).size).toBe(4);
    expect(new Set(fixtures.map(fixture => fixture.head)).size).toBe(1);
    const baseline = await treeBytes(fixtures[0].root);
    for (const fixture of fixtures) expect(await treeBytes(fixture.root)).toEqual(baseline);
    await Promise.all(fixtures.map((fixture, index) =>
      fs.writeFile(path.join(fixture.root, 'source.txt'), `Synthetic caller ${index}\n`)));
    for (const [index, fixture] of fixtures.entries()) {
      expect(await fs.readFile(path.join(fixture.root, 'source.txt'), 'utf8')).toBe(`Synthetic caller ${index}\n`);
    }
    const next = await ownedFixture();
    expect(await treeBytes(next.root)).toEqual(baseline);
    expect(gitCalls()).toHaveLength(6);
  });

  it('keeps files, index, config, HEAD, objects, worktrees and ignored data independent', async () => {
    const changed = await ownedFixture();
    const untouched = await ownedFixture();
    const baseline = await treeBytes(untouched.root);
    for (const [relative, contents] of Object.entries(baseline)) {
      if (contents === null) continue;
      const [left, right] = await Promise.all([changed, untouched].map(fixture =>
        fs.lstat(path.join(fixture.root, relative))));
      expect(left.nlink).toBe(1);
      expect(right.nlink).toBe(1);
      expect([left.dev, left.ino]).not.toEqual([right.dev, right.ino]);
    }
    await fs.writeFile(path.join(changed.root, 'source.txt'), 'Synthetic staged update\n');
    await runGit(changed.root, ['add', 'source.txt']);
    await runGit(changed.root, ['checkout', '-b', 'fixture-only']);
    await runGit(changed.root, ['commit', '-m', 'Synthetic fixture update']);
    expect(await gitText(changed.root, ['rev-parse', 'HEAD'])).not.toBe(changed.head);
    const linked = path.join(changed.directory, 'linked');
    await runGit(changed.root, ['worktree', 'add', '--detach', linked, 'HEAD']);
    await runGit(changed.root, ['config', 'user.name', 'Changed Fixture User']);
    await runGit(changed.root, ['config', 'core.worktree', changed.root]);
    await fs.writeFile(path.join(changed.root, '.git', 'index'), Buffer.alloc(0));
    await fs.unlink(path.join(changed.root, 'nested', 'local.txt'));
    await fs.writeFile(path.join(changed.root, '.env'), 'SYNTHETIC_IGNORED=fixture\n');
    await fs.mkdir(path.join(changed.root, 'node_modules'));
    await fs.writeFile(path.join(changed.root, 'node_modules', 'synthetic.txt'), 'Synthetic ignored data\n');
    await fs.symlink(path.join(changed.root, 'source.txt'), path.join(changed.root, 'absolute-alias'));
    expect(await treeBytes(untouched.root)).toEqual(baseline);
    const next = await ownedFixture();
    expect(await treeBytes(next.root)).toEqual(baseline);
    for (const fixture of [untouched, next]) {
      expect(await gitText(fixture.root, ['rev-parse', '--show-toplevel'])).toBe(fixture.root);
      expect(await gitText(fixture.root, ['worktree', 'list', '--porcelain'])).toBe(
        `worktree ${fixture.root}\nHEAD ${fixture.head}\nbranch refs/heads/main`);
      expect(await gitText(fixture.root, ['config', '--local', 'user.name'])).toBe('Test User');
      expect(await gitText(fixture.root, ['status', '--porcelain'])).toBe('');
    }
  });

  it.each([
    { name: 'initialized embedded', submodule: false, unborn: false },
    { name: 'unborn embedded', submodule: false, unborn: true },
    { name: 'initialized submodule', submodule: true, unborn: false },
  ])('preserves $name nested repository semantics', async ({ submodule, unborn }) => {
    const fixture = await ownedFixture();
    const baseline = await treeBytes(fixture.root);
    const parent = await repositoryState(fixture.root);
    const child = await nestedGitFixture(fixture, 'vendor/component', submodule, unborn);
    expect(child).toBe(path.join(fixture.root, 'vendor/component'));
    expect(await fs.readFile(path.join(child, 'local.txt'), 'utf8')).toBe('first\nsecond\nthird\n');
    expect(await fs.readFile(path.join(child, '.gitignore'), 'utf8')).toBe('.env\nignored/\n');
    expect(await gitText(child, ['symbolic-ref', '--short', 'HEAD'])).toBe('main');
    expect((await fs.lstat(path.join(child, '.git'))).isDirectory()).toBe(!submodule);
    if (unborn) {
      await expect(runGit(child, ['rev-parse', '--verify', 'HEAD'])).rejects.toThrow();
      await expect(fs.lstat(path.join(child, '.git', 'index'))).rejects.toMatchObject({ code: 'ENOENT' });
    } else {
      expect(await gitText(child, ['ls-files'])).toBe('.gitignore\nlocal.txt');
      expect(await gitText(child, ['log', '-1', '--format=%s'])).toBe('Synthetic nested repository');
    }
    if (submodule) {
      expect(await gitText(fixture.root, ['ls-files', '--stage', 'vendor/component'])).toMatch(/^160000 /);
      expect((await repositoryState(fixture.root)).head).not.toBe(parent.head);
    } else {
      expect(await repositoryState(fixture.root)).toEqual(parent);
    }
    const next = await ownedFixture();
    expect(await treeBytes(next.root)).toEqual(baseline);
    expect(await fs.readdir(next.directory)).toEqual(['repository']);
  });

  it('cleans a failed shared bootstrap and permits a subsequent shared retry', async () => {
    const scratch = trackScratchDirectories();
    const failure = new Error('Synthetic template setup failure');
    const write = vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(failure);
    expect(await Promise.allSettled([gitFixture(), gitFixture()])).toEqual([
      { status: 'rejected', reason: failure }, { status: 'rejected', reason: failure },
    ]);
    expect(scratch).toHaveBeenCalledTimes(1);
    await expect(fs.lstat(await scratch.mock.results[0].value)).rejects.toMatchObject({ code: 'ENOENT' });
    write.mockRestore();
    vi.mocked(childProcess.spawn).mockClear();
    const fixtures = await Promise.all([ownedFixture(), ownedFixture()]);
    expect(gitCalls()).toHaveLength(6);
    expect(fixtures[0].directory).not.toBe(fixtures[1].directory);
    expect(await treeBytes(fixtures[0].root)).toEqual(await treeBytes(fixtures[1].root));
  });

  it.each(['template', 'copy'])('cleans owned scratch after %s realpath failure', async stage => {
    const scratch = trackScratchDirectories();
    if (stage === 'copy') await ownedFixture();
    const failure = new Error('Synthetic realpath failure');
    const realpath = vi.spyOn(fs, 'realpath').mockRejectedValueOnce(failure);
    await expect(gitFixture()).rejects.toBe(failure);
    await expect(fs.lstat(await scratch.mock.results.at(-1)!.value)).rejects.toMatchObject({ code: 'ENOENT' });
    realpath.mockRestore();
    const recovered = await ownedFixture();
    expect(await gitText(recovered.root, ['rev-parse', 'HEAD'])).toBe(recovered.head);
  });

  it('removes a partial failed copy while retaining its template and existing callers', async () => {
    const scratch = trackScratchDirectories();
    const first = await ownedFixture();
    const baseline = await treeBytes(first.root);
    const failure = new Error('Synthetic partial copy failure');
    const copy = vi.spyOn(fs, 'cp').mockImplementationOnce(async (_source, destination) => {
      await fs.mkdir(String(destination), { recursive: true });
      await fs.writeFile(path.join(String(destination), 'partial.txt'), 'Synthetic incomplete copy\n');
      throw failure;
    });
    await expect(gitFixture()).rejects.toBe(failure);
    await expect(fs.lstat(await scratch.mock.results.at(-1)!.value)).rejects.toMatchObject({ code: 'ENOENT' });
    copy.mockRestore();
    vi.mocked(childProcess.spawn).mockClear();
    const next = await ownedFixture();
    expect(gitCalls()).toHaveLength(0);
    expect(await treeBytes(first.root)).toEqual(baseline);
    expect(await treeBytes(next.root)).toEqual(baseline);
  });

  it('canonicalizes temporary-directory aliases for Git on platforms such as macOS', async () => {
    const directory = await fs.realpath(await actualMkdtemp(path.join(os.tmpdir(), 'delegated-git-alias-test-')));
    ownedDirectories.push(directory);
    const target = path.join(directory, 'target');
    const alias = path.join(directory, 'alias');
    await fs.mkdir(target);
    await fs.symlink(target, alias, 'junction');
    vi.spyOn(os, 'tmpdir').mockReturnValue(alias);
    const fixture = await ownedFixture();
    expect(path.dirname(fixture.directory)).toBe(target);
    expect(await fs.realpath(fixture.directory)).toBe(fixture.directory);
    expect(await gitText(fixture.root, ['rev-parse', '--show-toplevel'])).toBe(fixture.root);
  });

  it('cleans only its private template, preserving callers and similarly named directories', async () => {
    const unrelated = await actualMkdtemp(path.join(os.tmpdir(), 'delegated-git-template-'));
    ownedDirectories.push(unrelated);
    await fs.writeFile(path.join(unrelated, 'keep.txt'), 'Synthetic unrelated directory\n');
    const scratch = trackScratchDirectories();
    const fixture = await ownedFixture();
    const template = await fs.realpath(await scratch.mock.results[0].value);
    expect(template).not.toBe(fixture.directory);
    const remove = vi.spyOn(fs, 'rm');
    await cleanupHooks[0]();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(template, { recursive: true, force: true });
    await expect(fs.lstat(template)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await gitText(fixture.root, ['rev-parse', 'HEAD'])).toBe(fixture.head);
    expect(await fs.readFile(path.join(unrelated, 'keep.txt'), 'utf8')).toBe('Synthetic unrelated directory\n');
    await cleanupHooks[0]();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
