import { randomBytes, randomUUID } from 'crypto';
import { execFile } from 'child_process';
import * as childProcess from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { setTimeout as realDelay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureCheckpoint, checkpointRevision, gitText, importGitTree, runGit } from '../../src/delegation/GitCheckpoint';
import { DelegatedWorkspaceManager, type DelegatedWorkspace } from '../../src/delegation/DelegatedWorkspaceManager';
import { DelegatedWorkerSessionStore } from '../../src/delegation/DelegatedWorkerSessionStore';
import { gitFixture, nestedGitFixture, repositoryState } from './gitFixture';

vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

// These integration cases run real Git captures, nested imports, merges and byte audits.
describe('local nested repository checkpoints and delivery', { timeout: 30_000 }, () => {
  let fixture: Awaited<ReturnType<typeof gitFixture>>;
  let manager: DelegatedWorkspaceManager;
  let lanes: DelegatedWorkerSessionStore;
  const owner = { threadId: 'fixture-owner', workspaceGeneration: 0 };
  beforeEach(async () => {
    fixture = await gitFixture();
    manager = new DelegatedWorkspaceManager(path.join(fixture.directory, 'workspaces'));
    lanes = new DelegatedWorkerSessionStore(path.join(fixture.directory, 'lanes'));
  });
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(fixture.directory, { recursive: true, force: true }); });
  const prepare = async () => {
    const source = (await manager.discover(fixture.root))!;
    const { lane } = await lanes.acquire({ ...owner, backend: 'agy', workingDirectory: fixture.root });
    return { lane, workspace: await manager.prepare(lane, source, await manager.baseline(source), randomUUID()) };
  };
  const inspect = (workspace: DelegatedWorkspace) => manager.integrate({ ...owner, cwd: fixture.root }, workspace.taskId, 'inspect', undefined) as Promise<any>;
  const apply = async (workspace: DelegatedWorkspace) => manager.integrate({ ...owner, cwd: fixture.root }, workspace.taskId, 'apply', (await inspect(workspace)).revision) as Promise<any>;

  it('captures an ordinary tracked file replaced by a directory', async () => {
    await fs.unlink(path.join(fixture.root, 'source.txt'));
    await fs.mkdir(path.join(fixture.root, 'source.txt'));
    await fs.writeFile(path.join(fixture.root, 'source.txt', 'child.txt'), 'replacement\n');
    const before = await repositoryState(fixture.root);
    const snapshot = await captureCheckpoint(fixture.root);
    expect(await gitText(fixture.root, ['show', `${snapshot.tree}:source.txt/child.txt`])).toBe('replacement');
    expect(await repositoryState(fixture.root)).toEqual(before);
  });

  it('captures an ordinary tracked directory replaced by a file', async () => {
    await fs.rm(path.join(fixture.root, 'nested'), { recursive: true });
    await fs.writeFile(path.join(fixture.root, 'nested'), 'replacement\n');
    const before = await repositoryState(fixture.root);
    const snapshot = await captureCheckpoint(fixture.root);
    expect(await gitText(fixture.root, ['show', `${snapshot.tree}:nested`])).toBe('replacement');
    expect(await repositoryState(fixture.root)).toEqual(before);
  });

  it('uses literal paths for nested repositories containing spaces and pathspec characters', async () => {
    const name = 'vendor/component [fixture]';
    await nestedGitFixture(fixture, name);
    const snapshot = await captureCheckpoint(fixture.root);
    expect(snapshot.repositories?.[0].path).toBe(name);
    expect(await gitText(fixture.root, ['show', `${snapshot.tree}:${name}/local.txt`])).toContain('first');
  });

  it.each([false, true])('captures dirty embedded/submodule files with private flat trees (submodule=%s)', async submodule => {
    const child = await nestedGitFixture(fixture, 'vendor/component', submodule);
    await fs.writeFile(path.join(child, 'local.txt'), 'staged\n');
    await runGit(child, ['add', 'local.txt']);
    await fs.writeFile(path.join(child, 'local.txt'), 'working after staging\n');
    await fs.writeFile(path.join(child, 'new.bin'), Buffer.from([0, 255, 4]));
    await fs.writeFile(path.join(child, '.env'), 'SYNTHETIC_IGNORED=value\n');
    const before = await repositoryState(fixture.root), nestedBefore = await repositoryState(child);
    const { workspace } = await prepare();
    expect(await fs.readFile(path.join(workspace.cwd, 'vendor/component/local.txt'), 'utf8')).toBe('working after staging\n');
    expect(await fs.readFile(path.join(workspace.cwd, 'vendor/component/new.bin'))).toEqual(Buffer.from([0, 255, 4]));
    await expect(fs.lstat(path.join(workspace.cwd, 'vendor/component/.git'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(path.join(workspace.cwd, 'vendor/component/.env'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await repositoryState(fixture.root)).toEqual(before);
    expect(await repositoryState(child)).toEqual(nestedBefore);
    expect(workspace.input.repositories).toHaveLength(1);
    expect(workspace.input.revision).toBe(checkpointRevision(before.head, workspace.input.tree, before.index, workspace.input.repositories));
    expect((await manager.collect(workspace, true)).changedFiles).toEqual([]);
    expect(await manager.reclaim(workspace.taskId)).toBe(true);
  });

  it.each([false, true])('integrates edits and new binary files without changing any HEAD/index (submodule=%s)', async submodule => {
    const child = await nestedGitFixture(fixture, 'module', submodule);
    await fs.writeFile(path.join(child, 'local.txt'), 'first\nstaged\nthird\n');
    await runGit(child, ['add', 'local.txt']);
    const before = await repositoryState(fixture.root), nestedBefore = await repositoryState(child);
    const { workspace, lane } = await prepare();
    await fs.writeFile(path.join(workspace.cwd, 'module/local.txt'), 'worker\nstaged\nthird\n');
    await fs.writeFile(path.join(workspace.cwd, 'module/new.bin'), Buffer.from([1, 0, 254]));
    expect((await manager.collect(workspace, true)).changedFiles).toEqual(['module/local.txt', 'module/new.bin']);
    expect(await apply(workspace)).toMatchObject({ applied: true, disposition: 'applied' });
    expect(await fs.readFile(path.join(child, 'local.txt'), 'utf8')).toBe('worker\nstaged\nthird\n');
    expect(await fs.readFile(path.join(child, 'new.bin'))).toEqual(Buffer.from([1, 0, 254]));
    expect(await repositoryState(fixture.root)).toEqual(before);
    expect(await repositoryState(child)).toEqual(nestedBefore);
    const next = await manager.prepare(lane, workspace.source, await manager.baseline(workspace.source), randomUUID());
    expect(next.cwd).toBe(workspace.cwd);
    expect(await fs.readFile(path.join(next.cwd, 'module/local.txt'), 'utf8')).toContain('worker');
    expect((await manager.collect(next, true)).disposition).toBe('applied');
    expect(await manager.reclaim(next.taskId)).toBe(true);
  }, 30_000);

  it('recursively includes nested repositories and supports their uncommitted input', async () => {
    const child = await nestedGitFixture(fixture);
    const grandchild = await nestedGitFixture({ ...fixture, root: child }, 'inner');
    await fs.writeFile(path.join(grandchild, 'local.txt'), 'deep working input\n');
    const snapshot = await captureCheckpoint(fixture.root);
    expect(snapshot.repositories?.map(repository => repository.path)).toEqual(['module', 'module/inner']);
    expect(await gitText(fixture.root, ['show', `${snapshot.tree}:module/inner/local.txt`])).toBe('deep working input');
  });

  it('captures an unborn embedded repository without requiring an artificial commit', async () => {
    const child = await nestedGitFixture(fixture, 'unborn', false, true);
    const parentBefore = await repositoryState(fixture.root);
    const { workspace } = await prepare();
    expect(await fs.readFile(path.join(workspace.cwd, 'unborn/local.txt'), 'utf8')).toContain('first');
    expect(workspace.input.repositories?.[0].path).toBe('unborn');
    await fs.writeFile(path.join(workspace.cwd, 'unborn/local.txt'), 'worker edit in unborn repository\n');
    await manager.collect(workspace, true);
    expect(await apply(workspace)).toMatchObject({ applied: true });
    expect(await fs.readFile(path.join(child, 'local.txt'), 'utf8')).toBe('worker edit in unborn repository\n');
    await expect(runGit(child, ['rev-parse', '--verify', 'HEAD'])).rejects.toThrow();
    await expect(fs.lstat(path.join(child, '.git/index'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await repositoryState(fixture.root)).toEqual(parentBefore);
  });

  it('captures through a root alias without mistaking nested repository ownership', async () => {
    await nestedGitFixture(fixture, 'vendor/component');
    const alias = path.join(fixture.directory, 'repository-alias');
    await fs.symlink(fixture.root, alias, 'junction');
    const snapshot = await captureCheckpoint(alias);
    expect(snapshot.repositories?.map(repository => repository.path)).toEqual(['vendor/component']);
    expect(await gitText(fixture.root, ['show', `${snapshot.tree}:vendor/component/local.txt`])).toContain('first');
  });

  it('integrates grandchild submodule files without changing nested HEADs or indexes', async () => {
    const child = await nestedGitFixture(fixture, 'module', true);
    const grandchild = await nestedGitFixture({ ...fixture, root: child }, 'inner', true);
    const before = await Promise.all([fixture.root, child, grandchild].map(repositoryState));
    const { workspace } = await prepare();
    await fs.writeFile(path.join(workspace.cwd, 'module/inner/local.txt'), 'deep worker edit\n');
    await manager.collect(workspace, true);
    expect(await apply(workspace)).toMatchObject({ applied: true });
    expect(await fs.readFile(path.join(grandchild, 'local.txt'), 'utf8')).toBe('deep worker edit\n');
    expect(await Promise.all([fixture.root, child, grandchild].map(repositoryState))).toEqual(before);
  });

  it('streams nested objects larger than the Git command output buffer', async () => {
    const child = await nestedGitFixture(fixture);
    const file = await fs.open(path.join(child, 'large.bin'), 'w');
    const size = 40 * 1024 * 1024;
    try { await file.truncate(size); } finally { await file.close(); }
    const snapshot = await captureCheckpoint(fixture.root);
    expect(await gitText(fixture.root, ['cat-file', '-s', `${snapshot.tree}:module/large.bin`])).toBe(String(size));
  }, 30_000);

  it('reuses completed transfers only within a capture and preserves warm index entries', async () => {
    await nestedGitFixture(fixture);
    const spawning = vi.mocked(childProcess.spawn);
    spawning.mockClear();
    await captureCheckpoint(fixture.root);
    const commands = () => spawning.mock.calls.map(call => call[1] as string[]);
    expect(commands().filter(args => args.includes('pack-objects'))).toHaveLength(1);
    expect(commands().some(args => args.includes('read-tree') && args.includes('--empty'))).toBe(false);
    expect(commands().some(args => args.includes('--index-info'))).toBe(false);
    await captureCheckpoint(fixture.root);
    expect(commands().filter(args => args.includes('pack-objects'))).toHaveLength(2);
  });

  it.each(['root', 'nested'])('preserves the %s index timestamp so racy-clean entries cannot hide same-size edits', async location => {
    const child = location === 'root' ? fixture.root : await nestedGitFixture(fixture);
    await runGit(child, ['config', 'core.checkstat', 'minimal']);
    await runGit(child, ['config', 'core.trustctime', 'false']);
    const name = location === 'root' ? 'source.txt' : 'local.txt';
    const file = path.join(child, name);
    const when = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    await fs.utimes(file, when, when);
    await runGit(child, ['add', name]);
    await fs.utimes(path.join(child, '.git/index'), when, when);
    await fs.writeFile(file, 'dirty\nsecond\nthird\n');
    await fs.utimes(file, when, when);
    const before = await repositoryState(child);
    const snapshot = await captureCheckpoint(fixture.root);
    expect(await gitText(fixture.root, ['show', `${snapshot.tree}:${location === 'root' ? name : `module/${name}`}`])).toBe('dirty\nsecond\nthird');
    expect(await repositoryState(child)).toEqual(before);
  });

  it('rejects nested worktrees of the outer repository without duplicating its input', async () => {
    await runGit(fixture.root, ['worktree', 'add', '--detach', path.join(fixture.root, 'inner'), fixture.head]);
    const before = await repositoryState(fixture.root);
    await expect(captureCheckpoint(fixture.root)).rejects.toThrow('shares an ancestor repository');
    expect(await repositoryState(fixture.root)).toEqual(before);
  });

  it('captures initialized submodules in a linked root but still rejects nested worktrees sharing its common directory', async () => {
    const linked = path.join(fixture.directory, 'linked-root');
    await runGit(fixture.root, ['worktree', 'add', '-b', 'linked-fixture', linked, fixture.head]);
    const child = await nestedGitFixture({ ...fixture, root: linked }, 'module', true);
    await fs.writeFile(path.join(child, 'local.txt'), 'linked submodule input\n');
    const before = await Promise.all([linked, child].map(repositoryState));
    const snapshot = await captureCheckpoint(linked);
    expect(snapshot.repositories?.map(repository => repository.path)).toEqual(['module']);
    expect(await gitText(linked, ['show', `${snapshot.tree}:module/local.txt`])).toBe('linked submodule input');
    expect(await Promise.all([linked, child].map(repositoryState))).toEqual(before);
    await runGit(linked, ['worktree', 'add', '--detach', path.join(linked, 'inner'), fixture.head]);
    await expect(captureCheckpoint(linked)).rejects.toThrow('shares an ancestor repository');
  });

  it('rejects unrelated external gitfiles without writing their object stores', async () => {
    const external = await nestedGitFixture({ ...fixture, root: fixture.directory }, 'external');
    const child = path.join(fixture.root, 'module');
    await fs.mkdir(child);
    await fs.writeFile(path.join(child, '.git'), `gitdir: ${path.join(external, '.git')}\n`);
    await fs.writeFile(path.join(child, 'new.txt'), 'must not enter the external object store\n');
    const before = await repositoryState(external);
    const objects = await gitText(external, ['count-objects', '-v']);
    await expect(captureCheckpoint(fixture.root)).rejects.toThrow('outside the permitted repository boundary');
    expect(await repositoryState(external)).toEqual(before);
    expect(await gitText(external, ['count-objects', '-v'])).toBe(objects);
  });

  it('does not execute configured nested clean filters during automatic discovery', async () => {
    const child = await nestedGitFixture(fixture);
    await runGit(child, ['config', 'filter.fixture.clean',
      `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync('filter.marker','ran');process.stdin.pipe(process.stdout)"`]);
    await fs.writeFile(path.join(child, '.gitattributes'), '*.txt filter=fixture\n');
    await fs.writeFile(path.join(child, 'local.txt'), 'dirty nested input\n');
    const before = await repositoryState(child);
    await expect(captureCheckpoint(fixture.root)).rejects.toThrow('filters or partial-clone');
    await expect(fs.lstat(path.join(child, 'filter.marker'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await repositoryState(child)).toEqual(before);
  });

  it('rejects partial-clone nested repositories before any automatic hydration', async () => {
    const child = await nestedGitFixture(fixture);
    await runGit(child, ['config', 'remote.fixture.promisor', 'true']);
    await expect(captureCheckpoint(fixture.root)).rejects.toThrow('filters or partial-clone');
  });

  it('detects nested edits between the two snapshot passes', async () => {
    const child = await nestedGitFixture(fixture);
    const original = fs.readFile.bind(fs);
    const index = path.join(child, '.git', 'index');
    let reads = 0;
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args: any[]) => {
      const result = await (original as any)(...args);
      if (String(args[0]) === index && ++reads === 2) await fs.writeFile(path.join(child, 'local.txt'), 'changed during capture\n');
      return result;
    });
    await expect(captureCheckpoint(fixture.root)).rejects.toThrow('Workspace changed');
  });

  it('rejects nested conflict stages from the combined index query without modifying the source', async () => {
    const child = await nestedGitFixture(fixture);
    const blob = await gitText(child, ['hash-object', '-w', '--stdin'], 'synthetic conflict\n');
    await runGit(child, ['update-index', '--index-info'],
      `0 ${'0'.repeat(40)}\tlocal.txt\n100644 ${blob} 1\tlocal.txt\n100644 ${blob} 2\tlocal.txt\n100644 ${blob} 3\tlocal.txt\n`);
    const before = await repositoryState(child);
    await expect(captureCheckpoint(fixture.root)).rejects.toThrow('index conflicts');
    expect(await repositoryState(child)).toEqual(before);
  });

  it.each(['empty', 'missing'])('distinguishes a nested %s index without changing either source repository', async state => {
    const child = await nestedGitFixture(fixture);
    const before = await repositoryState(child);
    const outer = await repositoryState(fixture.root);
    const index = path.join(child, '.git', 'index');
    if (state === 'empty') {
      await fs.writeFile(index, Buffer.alloc(0));
      await expect(captureCheckpoint(fixture.root)).rejects.toThrow('empty or corrupt');
      expect(await fs.readFile(index)).toEqual(Buffer.alloc(0));
    } else {
      await fs.unlink(index);
      const snapshot = await captureCheckpoint(fixture.root);
      expect(await gitText(fixture.root, ['show', `${snapshot.tree}:module/local.txt`])).toBe('first\nsecond\nthird');
      await expect(fs.lstat(index)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(await gitText(child, ['rev-parse', 'HEAD'])).toBe(before.head);
    expect(await repositoryState(fixture.root)).toEqual(outer);
  });

  it.each([
    ['assume-unchanged', 'modified'], ['assume-unchanged', 'deleted'],
    ['skip-worktree', 'modified'], ['skip-worktree', 'deleted'],
  ])('rejects nested %s entries with %s files without rewriting their index', async (flag, state) => {
    const child = await nestedGitFixture(fixture);
    await runGit(child, ['update-index', `--${flag}`, 'local.txt']);
    const before = await repositoryState(child);
    if (state === 'deleted') await fs.unlink(path.join(child, 'local.txt'));
    else await fs.writeFile(path.join(child, 'local.txt'), 'deep working input\n');
    await expect(captureCheckpoint(fixture.root)).rejects.toThrow('assume-unchanged or skip-worktree');
    expect(await repositoryState(child)).toEqual(before);
    if (state === 'deleted') await expect(fs.lstat(path.join(child, 'local.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    else expect(await fs.readFile(path.join(child, 'local.txt'), 'utf8')).toBe('deep working input\n');
  });

  it('applies working changes in a converted gitlink directory whose local Git metadata was removed', async () => {
    const child = await nestedGitFixture(fixture, 'module', true);
    await fs.unlink(path.join(child, '.git'));
    const { workspace } = await prepare();
    expect(await fs.readFile(path.join(workspace.cwd, 'module/local.txt'), 'utf8')).toContain('first');
    expect(workspace.input.repositories).toBeUndefined();
  });

  it.each([false, true])('discovers an embedded repository exposed by replacing a gitlink (unborn=%s)', async unborn => {
    const child = await nestedGitFixture(fixture, 'module', true);
    await fs.unlink(path.join(child, '.git'));
    const inner = await nestedGitFixture({ ...fixture, root: child }, 'inner', false, unborn);
    await fs.writeFile(path.join(inner, 'local.txt'), 'dirty inner input\n');
    const before = await repositoryState(fixture.root);
    const snapshot = await captureCheckpoint(fixture.root);
    expect(snapshot.repositories?.map(repository => repository.path)).toEqual(['module/inner']);
    expect(await gitText(fixture.root, ['show', `${snapshot.tree}:module/inner/local.txt`])).toBe('dirty inner input');
    expect(await gitText(fixture.root, ['ls-tree', '-r', snapshot.tree])).not.toContain('160000 commit');
    expect(await repositoryState(fixture.root)).toEqual(before);
  });

  it('reports nested untracked credentials with the complete relative path', async () => {
    const child = await nestedGitFixture(fixture, 'vendor/component');
    await fs.writeFile(path.join(child, 'credentials.json'), '{}');
    await expect(captureCheckpoint(fixture.root)).rejects.toThrow('vendor/component/credentials.json');
  });

  it.skipIf(process.platform === 'win32')('reports FIFO entries and their relative path without reading them', async () => {
    await fs.unlink(path.join(fixture.root, 'source.txt'));
    await promisify(execFile)('mkfifo', [path.join(fixture.root, 'source.txt')]);
    await expect(captureCheckpoint(fixture.root)).rejects.toThrow('"source.txt": FIFO');
  });

  it('includes nested HEAD and staging changes in the delivery revision even when working bytes stay identical', async () => {
    const child = await nestedGitFixture(fixture);
    const first = await captureCheckpoint(fixture.root);
    await runGit(child, ['commit', '--allow-empty', '-m', 'Synthetic empty nested commit']);
    const second = await captureCheckpoint(fixture.root);
    expect(second.tree).toBe(first.tree);
    expect(second.revision).not.toBe(first.revision);
    await fs.writeFile(path.join(child, 'local.txt'), 'staged input\n');
    await runGit(child, ['add', 'local.txt']);
    await fs.writeFile(path.join(child, 'local.txt'), 'first\nsecond\nthird\n');
    const third = await captureCheckpoint(fixture.root);
    expect(third.tree).toBe(second.tree);
    expect(third.revision).not.toBe(second.revision);
  });

  it('isolates merge conflicts inside nested files without touching delivery', async () => {
    const child = await nestedGitFixture(fixture);
    const { workspace } = await prepare();
    await fs.writeFile(path.join(workspace.cwd, 'module/local.txt'), 'worker conflict\n');
    await manager.collect(workspace, true);
    await fs.writeFile(path.join(child, 'local.txt'), 'delivery conflict\n');
    expect(await apply(workspace)).toMatchObject({ applied: false, conflicts: ['module/local.txt'] });
    expect(await fs.readFile(path.join(child, 'local.txt'), 'utf8')).toBe('delivery conflict\n');
  });

  it('requires another inspection after a nested-only commit', async () => {
    const child = await nestedGitFixture(fixture);
    const { workspace } = await prepare();
    await fs.writeFile(path.join(workspace.cwd, 'module/local.txt'), 'worker edit\n');
    await manager.collect(workspace, true);
    const reviewed = await inspect(workspace);
    await runGit(child, ['commit', '--allow-empty', '-m', 'Synthetic new nested revision']);
    await expect(manager.integrate({ ...owner, cwd: fixture.root }, workspace.taskId, 'apply', reviewed.revision))
      .rejects.toThrow('inspect the artifact again');
    expect(await fs.readFile(path.join(child, 'local.txt'), 'utf8')).toContain('first');
  });

  it('requires manual integration if a new repository now owns the edited directory', async () => {
    const { workspace } = await prepare();
    await fs.writeFile(path.join(workspace.cwd, 'nested/local.txt'), 'worker edit\n');
    await manager.collect(workspace, true);
    await nestedGitFixture(fixture, 'nested');
    await expect(apply(workspace)).rejects.toThrow('nested repository boundary');
  });

  it('rejects a replaced source repository identity before applying any files', async () => {
    const child = await nestedGitFixture(fixture);
    const { workspace } = await prepare();
    await fs.writeFile(path.join(workspace.cwd, 'module/local.txt'), 'worker edit\n');
    await manager.collect(workspace, true);
    await fs.rename(child, path.join(fixture.directory, 'preserved-original'));
    await nestedGitFixture(fixture);
    await expect(apply(workspace)).rejects.toThrow('Nested repository identity changed');
    expect(await fs.readFile(path.join(child, 'local.txt'), 'utf8')).toContain('first');
  });

  it('refuses to replace a live nested repository with a worker file', async () => {
    const child = await nestedGitFixture(fixture);
    const { workspace } = await prepare();
    await fs.rm(path.join(workspace.cwd, 'module'), { recursive: true });
    await fs.writeFile(path.join(workspace.cwd, 'module'), 'replacement\n');
    await manager.collect(workspace, true);
    await expect(apply(workspace)).rejects.toThrow('nested repository boundary');
    expect(await repositoryState(child)).toHaveProperty('head');
  });

  it('keeps uninitialized gitlinks empty and safely reclaims/recreates a no-change checkout', async () => {
    await runGit(fixture.root, ['update-index', '--add', '--cacheinfo', `160000,${fixture.head},module`]);
    await fs.mkdir(path.join(fixture.root, 'module'));
    const { workspace, lane } = await prepare();
    expect(await fs.readdir(path.join(workspace.cwd, 'module'))).toEqual([]);
    expect((await manager.collect(workspace, true)).disposition).toBe('applied');
    expect(await manager.reclaim(workspace.taskId)).toBe(true);
    const next = await manager.prepare(lane, workspace.source, await manager.baseline(workspace.source), randomUUID());
    expect(await fs.readdir(path.join(next.cwd, 'module'))).toEqual([]);
  });

  it('preserves files for manual recovery when a worker fills an uninitialized gitlink', async () => {
    await runGit(fixture.root, ['update-index', '--add', '--cacheinfo', `160000,${fixture.head},module`]);
    await fs.mkdir(path.join(fixture.root, 'module'));
    const { workspace } = await prepare();
    await fs.writeFile(path.join(workspace.cwd, 'module/new.txt'), 'worker file\n');
    await expect(manager.collect(workspace, true)).rejects.toThrow('uninitialized submodule');
    expect(await fs.readFile(path.join(workspace.cwd, 'module/new.txt'), 'utf8')).toContain('worker');
    expect((await manager.describe(workspace.taskId))?.successful).toBe(false);
    expect(await manager.reclaim(workspace.taskId)).toBe(false);
  });

  it('preserves worker-created nested Git history instead of silently discarding it', async () => {
    const { workspace } = await prepare();
    await nestedGitFixture({ ...fixture, root: workspace.cwd }, 'created');
    await expect(manager.collect(workspace, true)).rejects.toThrow('Worker created nested Git metadata');
    expect(await gitText(path.join(workspace.cwd, 'created'), ['log', '-1', '--format=%s'])).toBe('Synthetic nested repository');
    expect((await manager.describe(workspace.taskId))?.successful).toBe(false);
  });

  it('requires explicit retention for new nested metadata even when working bytes are unchanged', async () => {
    const { workspace } = await prepare();
    const child = path.join(workspace.cwd, 'nested');
    await runGit(child, ['init', '-b', 'main']);
    await expect(manager.collect(workspace, true)).rejects.toThrow('Worker created nested Git metadata');
    expect(await manager.describe(workspace.taskId)).toMatchObject({ successful: false, disposition: 'pending', changedFiles: [] });
    const reviewed = await inspect(workspace);
    await expect(manager.integrate({ ...owner, cwd: fixture.root }, workspace.taskId, 'apply', reviewed.revision))
      .rejects.toThrow('manual recovery');
    expect(await manager.integrate({ ...owner, cwd: fixture.root }, workspace.taskId, 'retain', reviewed.revision))
      .toMatchObject({ disposition: 'retained' });
    expect(await manager.inspectCloseout({ ...owner, cwd: fixture.root }, workspace.taskId)).toMatchObject({ disposition: 'retained' });
    expect(await manager.reclaim(workspace.taskId)).toBe(false);
    expect((await fs.stat(path.join(child, '.git'))).isDirectory()).toBe(true);
  });

  it('rejects invalid transfers and reports missing local tree objects', async () => {
    await expect(importGitTree(fixture.root, fixture.root, 'invalid')).rejects.toThrow('Invalid nested');
    await expect(importGitTree(fixture.root, fixture.root, '0'.repeat(40))).rejects.toThrow('pack-objects');
  });

  it('does not leave partial packs when a late source blob is corrupt', async () => {
    const child = await nestedGitFixture(fixture);
    for (let index = 0; index < 8; index++) {
      await fs.writeFile(path.join(child, `payload-${index}.bin`), randomBytes(512 * 1024));
    }
    await runGit(child, ['add', '.']);
    const tree = await gitText(child, ['write-tree']);
    const oid = await gitText(child, ['rev-parse', `${tree}:payload-7.bin`]);
    const blob = path.join(child, '.git/objects', oid.slice(0, 2), oid.slice(2));
    const bytes = await fs.readFile(blob);
    await fs.chmod(blob, 0o600);
    await fs.writeFile(blob, bytes.subarray(0, bytes.length / 2));
    await expect(importGitTree(child, fixture.root, tree)).rejects.toThrow('Git');
    const objects = path.join(fixture.root, '.git/objects');
    expect(await fs.readdir(path.join(objects, 'pack'))).toEqual([]);
    expect((await fs.readdir(objects)).filter(name => name.startsWith('tmp_objdir-'))).toEqual([]);
    expect(await gitText(fixture.root, ['count-objects', '-v'])).toMatch(/^garbage: 0$/m);
  });

  it('publishes complete packs and optional reverse indexes, including repeated imports', async () => {
    const child = await nestedGitFixture(fixture);
    await runGit(fixture.root, ['config', 'pack.writeReverseIndex', 'true']);
    const tree = await gitText(child, ['rev-parse', 'HEAD^{tree}']);
    const before = await repositoryState(fixture.root);
    await importGitTree(child, fixture.root, tree);
    await importGitTree(child, fixture.root, tree);
    expect(await gitText(fixture.root, ['show', `${tree}:local.txt`])).toContain('first');
    const files = await fs.readdir(path.join(fixture.root, '.git/objects/pack'));
    expect(files.some(file => file.endsWith('.pack'))).toBe(true);
    expect(files.some(file => file.endsWith('.idx'))).toBe(true);
    expect(files.every(file => /^pack-[a-f0-9]+\.(pack|idx|rev)$/.test(file))).toBe(true);
    expect(await repositoryState(fixture.root)).toEqual(before);
    await runGit(fixture.root, ['fsck', '--no-reflogs', '--no-dangling']);
  });

  it('cleans a timed-out partial transfer after both processes exit without removing another quarantine', async () => {
    const child = await nestedGitFixture(fixture);
    await fs.writeFile(path.join(child, 'payload.bin'), randomBytes(256 * 1024));
    await runGit(child, ['add', '.']);
    const tree = await gitText(child, ['write-tree']);
    const pack = await runGit(child, ['pack-objects', '--stdout', '--revs'], `${tree}\n`);
    const partial = path.join(fixture.directory, 'partial.pack');
    await fs.writeFile(partial, pack.subarray(0, pack.length - 20));
    const objects = path.join(fixture.root, '.git/objects');
    const unrelated = 'tmp_objdir-incoming-other-operation';
    await fs.mkdir(path.join(objects, unrelated));
    await fs.writeFile(path.join(objects, unrelated, 'marker'), 'keep\n');
    const actual = await vi.importActual<typeof import('child_process')>('child_process');
    const spawning = vi.mocked(childProcess.spawn);
    const launched: string[] = [];
    const closed: string[] = [];
    const children: childProcess.ChildProcess[] = [];
    const childCloses: Promise<void>[] = [];
    let quarantine: string | undefined;
    let transfer: Promise<void> | undefined;
    spawning.mockImplementation((command, args, options) => {
      const producer = args?.includes('pack-objects');
      const receiver = args?.includes('index-pack');
      const spawned = producer
        ? actual.spawn(process.execPath, ['-e',
          "require('fs').createReadStream(process.argv[1]).pipe(process.stdout, {end:false});setInterval(()=>{},1000)", partial], options)
        : actual.spawn(command, args, options);
      children.push(spawned);
      childCloses.push(new Promise(resolve => spawned.once('close', () => resolve())));
      if (producer || receiver) {
        spawned.once('spawn', () => launched.push(producer ? 'producer' : 'receiver'));
        spawned.on('close', () => closed.push(producer ? 'producer' : 'receiver'));
      }
      if (receiver) {
        quarantine = options?.env?.GIT_OBJECT_DIRECTORY;
        // Preflight Git has finished. Fake only the transfer deadline and its kill escalation.
        // Real child streams and the readiness poll continue on the native event loop.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      }
      return spawned;
    });
    try {
      transfer = importGitTree(child, fixture.root, tree);
      const rejected = expect(transfer).rejects.toThrow('Nested Git object transfer timed out');
      void rejected.catch(() => undefined);
      let settled = false;
      void transfer.then(() => { settled = true; }, () => { settled = true; });
      let partialPack: { file: string; size: number } | undefined;
      const readinessDeadline = Date.now() + 5_000;
      while (!partialPack && !settled && Date.now() < readinessDeadline) {
        if (launched.length === 2 && quarantine) {
          for (const name of await fs.readdir(path.join(quarantine, 'pack'))) {
            if (!name.startsWith('tmp_pack_')) continue;
            const file = path.join(quarantine, 'pack', name);
            const { size } = await fs.stat(file);
            if (size > 0) { partialPack = { file, size }; break; }
          }
        }
        if (!partialPack) await realDelay(10);
      }
      expect(launched.sort()).toEqual(['producer', 'receiver']);
      expect(quarantine).toBeDefined();
      expect(path.dirname(quarantine!)).toBe(objects);
      expect(path.basename(quarantine!)).toMatch(/^tmp_objdir-incoming-/);
      expect(path.basename(quarantine!)).not.toBe(unrelated);
      expect(partialPack).toBeDefined();
      expect(partialPack!.size).toBeGreaterThan(0);
      expect(partialPack!.size).toBeLessThan(pack.length);
      expect((await fs.readFile(partialPack!.file)).subarray(0, 4).toString()).toBe('PACK');
      expect(closed).toEqual([]);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(14_999);
      expect(settled).toBe(false);
      expect(closed).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(500);
      await Promise.all(childCloses);
      await rejected;
      expect(closed.sort()).toEqual(['producer', 'receiver']);
      expect(await fs.readdir(path.join(objects, 'pack'))).toEqual([]);
      expect((await fs.readdir(objects)).filter(name => name.startsWith('tmp_objdir-'))).toEqual([unrelated]);
      expect(await fs.readFile(path.join(objects, unrelated, 'marker'), 'utf8')).toBe('keep\n');
    } finally {
      try {
        // Reap only children launched by this operation, even if readiness/assertions fail.
        for (const spawned of children) {
          if (spawned.exitCode === null && spawned.signalCode === null) spawned.kill('SIGKILL');
        }
        if (vi.isFakeTimers() && vi.getTimerCount()) await vi.advanceTimersByTimeAsync(15_500);
        await Promise.all(childCloses);
        await transfer?.catch(() => undefined);
      } finally {
        vi.useRealTimers();
        spawning.mockImplementation(actual.spawn);
      }
    }
  });

  it('rejects a blocked pack directory and removes only its own quarantine', async () => {
    const child = await nestedGitFixture(fixture);
    const tree = await gitText(child, ['rev-parse', 'HEAD^{tree}']);
    await fs.rm(path.join(fixture.root, '.git/objects/pack'), { recursive: true });
    await fs.writeFile(path.join(fixture.root, '.git/objects/pack'), 'synthetic blocked destination\n');
    await expect(importGitTree(child, fixture.root, tree)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await fs.readFile(path.join(fixture.root, '.git/objects/pack'), 'utf8')).toBe('synthetic blocked destination\n');
    expect((await fs.readdir(path.join(fixture.root, '.git/objects'))).filter(name => name.startsWith('tmp_objdir-'))).toEqual([]);
  });
});
