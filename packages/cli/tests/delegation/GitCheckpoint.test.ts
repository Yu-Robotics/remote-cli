import { unlinkSync, mkdirSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import * as childProcess from 'child_process';
import { isMainThread } from 'worker_threads';
import { captureCheckpoint, checkpointRevision, createCheckpointCommit, gitLinkTarget, gitText, runGit } from '../../src/delegation/GitCheckpoint';
import { gitFixture, nestedGitFixture } from './gitFixture';
import { supportsFileSymlinks } from './symlinkFixture';

vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const CHECKPOINT_PHASE_MS = 30_000;

// A phase deadline does not cancel admitted filesystem/Git work. Keep ownership
// until every admitted promise settles, including siblings of a rejected write.
function checkpointPhases() {
  const pending = new Set<Promise<unknown>>();
  let closing = false;
  const admit = <T>(action: () => Promise<T>): Promise<T> => {
    const call = Promise.resolve().then(() => {
      if (closing) throw new Error('Checkpoint fixture is draining; no new work may start');
      return action();
    });
    pending.add(call);
    void call.then(() => pending.delete(call), () => pending.delete(call));
    return call;
  };
  return {
    async run<T>(name: string, action: () => Promise<T>): Promise<T> {
      const call = admit(action);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([call, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            closing = true;
            reject(new Error(`Checkpoint phase exceeded 30 seconds: ${name}`));
          }, CHECKPOINT_PHASE_MS);
        })]);
      } finally { clearTimeout(timer); }
    },
    async batch(actions: Array<() => Promise<void>>): Promise<void> {
      const results = await Promise.allSettled(actions.map(admit));
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    },
    async drain(): Promise<void> {
      closing = true;
      await Promise.allSettled([...pending]);
    },
  };
}

describe('private Git checkpoints', () => {
  let fixture: Awaited<ReturnType<typeof gitFixture>>;
  let phases: ReturnType<typeof checkpointPhases>;
  beforeEach(async () => { phases = checkpointPhases(); fixture = await gitFixture(); });
  const cleanupFixture = async () => {
    await phases.drain();
    vi.restoreAllMocks();
    await fs.rm(fixture.directory, { recursive: true, force: true });
  };
  // Drain retains the fixture and mocks after a phase deadline; removal has a
  // separate teardown watchdog and never races an admitted writer.
  afterEach(cleanupFixture, 2 * CHECKPOINT_PHASE_MS);

  it.each(['resolve', 'reject'] as const)('owns timed-out write batches that later %s until fixture removal', async completion => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const write = vi.spyOn(fs, 'writeFile');
    const lateAction = vi.fn(async () => undefined);
    let settled = false, writeFinished = false, mockSurvived = false;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const running = (async () => {
      await phases.run('held write batch', () => phases.batch([
        async () => { throw new Error('Synthetic early write failure'); },
        async () => {
          entered(); await gate;
          mockSurvived = fs.writeFile === write;
          await fs.writeFile(path.join(fixture.root, 'late-result'), 'synthetic completed write');
          writeFinished = true;
          if (completion === 'reject') throw new Error('Synthetic late write failure');
        },
      ]));
      await phases.run('must not capture after timeout', lateAction);
    })();
    const outcome = running.then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
    let cleanup: Promise<void> | undefined;
    try {
      await started;
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(CHECKPOINT_PHASE_MS + 1);
      expect((await outcome).message).toBe('Checkpoint phase exceeded 30 seconds: held write batch');
      vi.useRealTimers();
      let removed = false;
      cleanup = cleanupFixture().then(() => { removed = true; });
      void cleanup.catch(() => undefined);
      expect(fs.writeFile).toBe(write);
      expect(removed).toBe(false);
      expect(await fs.stat(fixture.directory)).toBeDefined();
      await expect(phases.run('late admission', lateAction)).rejects.toThrow('Checkpoint fixture is draining');
      release(); await cleanup;
      expect(writeFinished).toBe(true);
      expect(mockSurvived).toBe(true);
      expect(fs.writeFile).not.toBe(write);
      expect(lateAction).not.toHaveBeenCalled();
      await expect(fs.stat(fixture.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      vi.useRealTimers(); release();
      await Promise.allSettled([running, ...(cleanup ? [cleanup] : [])]);
      await phases.drain();
    }
  });

  it.each(['win32', 'linux', 'darwin'] as const)('preserves alias components using the %s Git link representation', platform => {
    const native = ['alias', '..', 'nested', 'file.txt'].join(path.win32.sep);
    expect(gitLinkTarget(native, platform)).toBe(platform === 'win32' ? 'alias/../nested/file.txt' : native);
    expect(gitLinkTarget('alias/../nested/file.txt', platform)).toBe('alias/../nested/file.txt');
  });

  it('bounds Git subprocesses while preserving both capture passes and source state', async () => {
    expect(isMainThread).toBe(true);
    const index = await fs.readFile(path.join(fixture.root, '.git', 'index'));
    vi.mocked(childProcess.spawn).mockClear();
    const snapshot = await captureCheckpoint(fixture.root);
    const calls = vi.mocked(childProcess.spawn).mock.calls.filter(([command]) => command === 'git');
    expect(calls.length).toBeLessThanOrEqual(18);
    expect(calls.filter(([, args]) => args?.includes('add'))).toHaveLength(2);
    expect(calls.filter(([, args]) => args?.includes('--stage') && args.includes('-v'))).toHaveLength(2);
    expect(calls.filter(([, args]) => args?.includes('--git-path') && args.includes('index'))).toHaveLength(2);
    expect(calls.filter(([, args]) => args?.includes('ls-tree'))).toHaveLength(1);
    expect(snapshot.tree).toBe(await gitText(fixture.root, ['rev-parse', 'HEAD^{tree}']));
    expect(await gitText(fixture.root, ['rev-parse', 'HEAD'])).toBe(fixture.head);
    expect(await fs.readFile(path.join(fixture.root, '.git', 'index'))).toEqual(index);
  });

  it('still detects working-file changes between capture passes', async () => {
    const original = fs.rm.bind(fs);
    let changed = false;
    vi.spyOn(fs, 'rm').mockImplementation(async (file, options) => {
      await original(file, options);
      if (!changed && path.basename(String(file)).startsWith('remote-cli-checkpoint-')) {
        changed = true;
        await fs.writeFile(path.join(fixture.root, 'source.txt'), 'different working content after the first pass\n');
      }
    });
    await expect(captureCheckpoint(fixture.root)).rejects.toThrow('Workspace changed');
    expect(changed).toBe(true);
    expect(await gitText(fixture.root, ['rev-parse', 'HEAD'])).toBe(fixture.head);
  });

  it('shares a pending ancestor validation across siblings before staging any files', async () => {
    const parent = path.join(fixture.root, 'nested');
    await fs.writeFile(path.join(parent, 'second.txt'), 'synthetic sibling\n');
    const lstat = fs.lstat.bind(fs);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const checking = new Promise<void>(resolve => { entered = resolve; });
    let parentChecks = 0;
    let childChecks = 0;
    vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
      if (args[0] === parent) {
        parentChecks++;
        entered();
        await gate;
        throw new Error('Synthetic ancestor validation failure');
      }
      if (typeof args[0] === 'string' && args[0].startsWith(`${parent}${path.sep}`)) childChecks++;
      return lstat(...args);
    });
    vi.mocked(childProcess.spawn).mockClear();
    const capture = captureCheckpoint(fixture.root);
    const failure = expect(capture).rejects.toThrow('Synthetic ancestor validation failure');
    try {
      await checking;
      expect(parentChecks).toBe(1);
      expect(childChecks).toBe(0);
      expect(vi.mocked(childProcess.spawn).mock.calls.some(([, args]) => args?.includes('add'))).toBe(false);
    } finally { release(); }
    await failure;
    expect(parentChecks).toBe(1);
    expect(childChecks).toBe(0);
  });

  it.each(['empty', 'missing'])('distinguishes a malformed %s index from legitimate bootstrap', async state => {
    const index = path.join(fixture.root, '.git', 'index');
    if (state === 'empty') {
      await fs.writeFile(index, Buffer.alloc(0));
      await expect(captureCheckpoint(fixture.root)).rejects.toThrow('empty or corrupt');
      expect(await fs.readFile(index)).toEqual(Buffer.alloc(0));
    } else {
      await fs.unlink(index);
      const snapshot = await captureCheckpoint(fixture.root);
      expect(snapshot.tree).toBe(await gitText(fixture.root, ['rev-parse', 'HEAD^{tree}']));
      await expect(fs.lstat(index)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(await gitText(fixture.root, ['rev-parse', 'HEAD'])).toBe(fixture.head);
  });

  it('accepts a valid zero-entry index without rewriting it', async () => {
    await runGit(fixture.root, ['read-tree', '--empty']);
    const index = path.join(fixture.root, '.git', 'index');
    const original = await fs.readFile(index);
    expect(original.length).toBeGreaterThan(0);
    const snapshot = await captureCheckpoint(fixture.root);
    expect(snapshot.tree).toBe(await gitText(fixture.root, ['rev-parse', 'HEAD^{tree}']));
    expect(await fs.readFile(index)).toEqual(original);
  });

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

  it.skipIf(!supportsFileSymlinks)('supports relative repository links but refuses links into shared external files', async () => {
    await runGit(fixture.root, ['config', 'core.symlinks', 'true']);
    await fs.symlink('source.txt', path.join(fixture.root, 'local-link'), 'file');
    await expect(captureCheckpoint(fixture.root)).resolves.toHaveProperty('tree');
    await fs.symlink(fixture.root, path.join(fixture.root, 'external-link'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(captureCheckpoint(fixture.root)).rejects.toThrow(/symbolic[- ]link/);
  });

  const replacements = (['file', 'dir'] as const).flatMap(kind =>
    [false, true].flatMap(staged => [false, true].map(ignored => ({ kind, staged, ignored }))));
  it.skipIf(!supportsFileSymlinks).each(replacements)('captures an internal link replacing indexed children: %j', async ({ kind, staged, ignored }, context) => {
    await runGit(fixture.root, ['config', 'core.symlinks', 'true']);
    const link = path.join(fixture.root, 'nested');
    const target = kind === 'file' ? 'source.txt' : 'target';
    if (kind === 'dir') {
      await fs.mkdir(path.join(fixture.root, 'target'));
      await fs.writeFile(path.join(fixture.root, 'target', 'local.txt'), 'synthetic target content\n');
      await fs.writeFile(path.join(fixture.root, 'target', 'ignored.txt'), 'synthetic ignored content\n');
    }
    await fs.appendFile(path.join(fixture.root, '.gitignore'), `${ignored ? 'nested\n' : ''}target/ignored.txt\nunrelated-ignored/\n`);
    await fs.mkdir(path.join(fixture.root, 'unrelated-ignored'));
    await fs.writeFile(path.join(fixture.root, 'unrelated-ignored', 'file.txt'), 'excluded\n');
    await fs.rm(link, { recursive: true });
    try { await fs.symlink(target, link, kind); }
    catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { context.skip(); return; }
      throw error;
    }
    if (staged) await runGit(fixture.root, ['add', '--force', '--', 'nested']);
    const index = await fs.readFile(path.join(fixture.root, '.git', 'index'));
    const lstat = fs.lstat.bind(fs);
    vi.spyOn(fs, 'lstat').mockImplementation((...args: any[]) => {
      if (String(args[0]).startsWith(`${link}${path.sep}`)) throw new Error('Attempted to inspect a shadowed child');
      return (lstat as any)(...args);
    });
    const snapshot = await captureCheckpoint(fixture.root);
    expect(await gitText(fixture.root, ['ls-tree', snapshot.tree, '--', 'nested'])).toMatch(/^120000 blob /);
    expect(await gitText(fixture.root, ['show', `${snapshot.tree}:nested`])).toBe(target);
    const paths = await gitText(fixture.root, ['ls-tree', '-r', '--name-only', snapshot.tree]);
    expect(paths).not.toContain('nested/');
    expect(paths).not.toContain('target/ignored.txt');
    expect(paths).not.toContain('unrelated-ignored');
    expect(await fs.readFile(path.join(fixture.root, '.git', 'index'))).toEqual(index);
    expect(await gitText(fixture.root, ['rev-parse', 'HEAD'])).toBe(fixture.head);
    expect(await fs.readlink(link)).toBe(target);
    expect(await fs.readFile(path.join(fixture.root, 'source.txt'), 'utf8')).toBe('first\nsecond\nthird\n');
    if (kind === 'dir') expect(await fs.readFile(path.join(fixture.root, 'target', 'ignored.txt'), 'utf8')).toBe('synthetic ignored content\n');
  });

  it.skipIf(!supportsFileSymlinks)('keeps staged and unstaged link replacement trees identical', async () => {
    await runGit(fixture.root, ['config', 'core.symlinks', 'true']);
    await fs.rm(path.join(fixture.root, 'nested'), { recursive: true });
    await fs.symlink('source.txt', path.join(fixture.root, 'nested'), 'file');
    const before = await fs.readFile(path.join(fixture.root, '.git', 'index'));
    const unstaged = await captureCheckpoint(fixture.root);
    expect(await fs.readFile(path.join(fixture.root, '.git', 'index'))).toEqual(before);
    await runGit(fixture.root, ['add', '--', 'nested']);
    const stagedIndex = await fs.readFile(path.join(fixture.root, '.git', 'index'));
    const staged = await captureCheckpoint(fixture.root);
    expect(staged.tree).toBe(unstaged.tree);
    expect(await fs.readFile(path.join(fixture.root, '.git', 'index'))).toEqual(stagedIndex);
  });

  it.skipIf(!supportsFileSymlinks)('captures a link to an internal nested repository without discovering Git metadata through the link', async context => {
    await runGit(fixture.root, ['config', 'core.symlinks', 'true']);
    const child = await nestedGitFixture(fixture, 'target');
    await fs.rm(path.join(fixture.root, 'nested'), { recursive: true });
    try { await fs.symlink('target', path.join(fixture.root, 'nested'), 'dir'); }
    catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { context.skip(); return; }
      throw error;
    }
    const index = await fs.readFile(path.join(fixture.root, '.git', 'index'));
    const childIndex = await fs.readFile(path.join(child, '.git', 'index'));
    const lstat = fs.lstat.bind(fs);
    vi.spyOn(fs, 'lstat').mockImplementation((...args: any[]) => {
      if (String(args[0]).startsWith(`${path.join(fixture.root, 'nested')}${path.sep}`)) throw new Error('Attempted nested discovery through a link');
      return (lstat as any)(...args);
    });
    const snapshot = await captureCheckpoint(fixture.root);
    expect(snapshot.repositories?.map(repository => repository.path)).toEqual(['target']);
    expect(await gitText(fixture.root, ['show', `${snapshot.tree}:nested`])).toBe('target');
    expect(await fs.readFile(path.join(fixture.root, '.git', 'index'))).toEqual(index);
    expect(await fs.readFile(path.join(child, '.git', 'index'))).toEqual(childIndex);
  });

  it.skipIf(!supportsFileSymlinks).each(['assume-unchanged', 'skip-worktree', 'conflict'])('rejects shadowed %s index entries before removing them', async flag => {
    await runGit(fixture.root, ['config', 'core.symlinks', 'true']);
    if (flag === 'conflict') {
      const blob = await gitText(fixture.root, ['hash-object', '-w', '--stdin'], 'synthetic conflict\n');
      await runGit(fixture.root, ['update-index', '--index-info'],
        `0 ${'0'.repeat(40)}\tnested/local.txt\n100644 ${blob} 1\tnested/local.txt\n100644 ${blob} 2\tnested/local.txt\n`);
    } else await runGit(fixture.root, ['update-index', `--${flag}`, 'nested/local.txt']);
    await fs.rm(path.join(fixture.root, 'nested'), { recursive: true });
    await fs.symlink('source.txt', path.join(fixture.root, 'nested'), 'file');
    const index = await fs.readFile(path.join(fixture.root, '.git', 'index'));
    vi.mocked(childProcess.spawn).mockClear();
    await expect(captureCheckpoint(fixture.root)).rejects.toThrow(flag === 'conflict' ? 'index conflicts' : 'assume-unchanged or skip-worktree');
    expect(vi.mocked(childProcess.spawn).mock.calls.some(([, args]) => args?.includes('--force-remove'))).toBe(false);
    expect(await fs.readFile(path.join(fixture.root, '.git', 'index'))).toEqual(index);
    expect(await fs.readlink(path.join(fixture.root, 'nested'))).toBe('source.txt');
  });

  it.skipIf(!supportsFileSymlinks).each(['relative-external', 'absolute-internal', 'escaping-chain'])('still rejects a shadowing %s link without scanning its children', async kind => {
    await runGit(fixture.root, ['config', 'core.symlinks', 'true']);
    const outside = path.join(fixture.directory, 'outside.txt');
    await fs.writeFile(outside, 'synthetic external bytes\n');
    const link = path.join(fixture.root, 'nested');
    await fs.rm(link, { recursive: true });
    let target = path.relative(fixture.root, outside);
    if (kind === 'absolute-internal') target = path.join(fixture.root, 'source.txt');
    if (kind === 'escaping-chain') {
      await fs.symlink(path.relative(fixture.root, outside), path.join(fixture.root, 'ignored-alias'), 'file');
      await fs.appendFile(path.join(fixture.root, '.gitignore'), 'ignored-alias\n');
      target = 'ignored-alias';
    }
    await fs.symlink(target, link, 'file');
    const index = await fs.readFile(path.join(fixture.root, '.git', 'index'));
    const lstat = fs.lstat.bind(fs);
    vi.spyOn(fs, 'lstat').mockImplementation((...args: any[]) => {
      if (String(args[0]).startsWith(`${link}${path.sep}`)) throw new Error('Attempted to inspect external children');
      return (lstat as any)(...args);
    });
    await expect(captureCheckpoint(fixture.root)).rejects.toThrow(/symbolic[- ]link/);
    expect(await fs.readFile(path.join(fixture.root, '.git', 'index'))).toEqual(index);
    expect(await fs.readlink(link)).toBe(target);
    expect(await fs.readFile(outside, 'utf8')).toBe('synthetic external bytes\n');
  });

  it.skipIf(!supportsFileSymlinks).each([false, true])('checks native alias-parent semantics (automatic=%s)', async (automatic, context) => {
    await runGit(fixture.root, ['config', 'core.symlinks', 'true']);
    const outside = path.join(fixture.directory, 'outside');
    await fs.mkdir(path.join(outside, 'child'), { recursive: true });
    await fs.writeFile(path.join(outside, 'external.txt'), 'synthetic outside bytes\n');
    await fs.writeFile(path.join(fixture.root, 'external.txt'), 'synthetic inside bytes\n');
    await fs.appendFile(path.join(fixture.root, '.gitignore'), 'ignored-alias\n');
    try { await fs.symlink(path.relative(fixture.root, path.join(outside, 'child')), path.join(fixture.root, 'ignored-alias'), 'dir'); }
    catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { context.skip(); return; }
      throw error;
    }
    await fs.rm(path.join(fixture.root, 'nested'), { recursive: true });
    await fs.symlink('ignored-alias/../external.txt', path.join(fixture.root, 'nested'), 'file');
    const linkText = await fs.readlink(path.join(fixture.root, 'nested'));
    const index = await fs.readFile(path.join(fixture.root, '.git', 'index'));
    const canonical = await fs.realpath(path.join(fixture.root, 'nested'));
    const relative = path.relative(fixture.root, canonical);
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      if (automatic) {
        const snapshot = await captureCheckpoint(fixture.root, { discoverExternal: true });
        expect(snapshot.sharedLinks).toEqual([{ path: 'nested', linkText, target: canonical, kind: 'file' }]);
        expect(await runGit(fixture.root, ['show', `${snapshot.tree}:nested`])).toEqual(Buffer.from(linkText));
      } else await expect(captureCheckpoint(fixture.root)).rejects.toThrow('chain escapes');
    } else {
      // Some native filesystems normalize parent components before following
      // an alias; an actually contained target remains permitted there.
      const snapshot = await captureCheckpoint(fixture.root, { discoverExternal: automatic });
      expect(await runGit(fixture.root, ['show', `${snapshot.tree}:nested`])).toEqual(Buffer.from(gitLinkTarget(linkText)));
      expect(await gitText(fixture.root, ['ls-tree', snapshot.tree, '--', 'nested'])).toMatch(/^120000 blob /);
    }
    expect(await fs.readFile(path.join(fixture.root, '.git', 'index'))).toEqual(index);
    expect(await gitText(fixture.root, ['rev-parse', 'HEAD'])).toBe(fixture.head);
    expect(await fs.readlink(path.join(fixture.root, 'nested'))).toBe(linkText);
    expect(await fs.readFile(path.join(outside, 'external.txt'), 'utf8')).toBe('synthetic outside bytes\n');
  });

  it.skipIf(!supportsFileSymlinks).each(['untracked', 'tracked-directory'])('preserves native link semantics after Git separator conversion for %s links', async kind => {
    await runGit(fixture.root, ['config', 'core.symlinks', 'true']);
    await fs.mkdir(path.join(fixture.root, 'ignored-alias'));
    await fs.appendFile(path.join(fixture.root, '.gitignore'), 'ignored-alias\n');
    const name = kind === 'tracked-directory' ? 'nested' : 'native-link';
    if (kind === 'tracked-directory') await fs.rm(path.join(fixture.root, name), { recursive: true });
    // Model native Node text and Git for Windows parsing without removing the
    // alias/.. components. Native canonical containment is tested above.
    const nativeText = ['ignored-alias', '..', 'source.txt'].join(path.win32.sep);
    const gitTextTarget = nativeText.split(path.win32.sep).join(path.posix.sep);
    expect(gitTextTarget).toBe('ignored-alias/../source.txt');
    await fs.symlink(nativeText, path.join(fixture.root, name), 'file');
    expect(await fs.readlink(path.join(fixture.root, name))).toBe(nativeText);
    const index = await fs.readFile(path.join(fixture.root, '.git', 'index'));
    const { spawn } = await vi.importActual<typeof import('child_process')>('child_process');
    let conversions = 0;
    const nativeAdd = [
      "const { execFileSync } = require('child_process');",
      'const [args, name, target] = JSON.parse(process.argv[1]);',
      "execFileSync('git', args);",
      "const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { input: target, encoding: 'utf8' }).trim();",
      "execFileSync('git', ['update-index', '-z', '--index-info'], { input: `120000 ${blob}\\t${name}\\0` });",
    ].join('\n');
    vi.mocked(childProcess.spawn).mockImplementation(((command: any, args: any, options: any) => {
      if (command === 'git' && args.includes('add')) {
        // Convert only the private index, just as the native Git parser does.
        expect(options.env.GIT_INDEX_FILE).not.toBe(path.join(fixture.root, '.git', 'index'));
        expect(options.env.GIT_INDEX_FILE).toBeTruthy();
        conversions++;
        return spawn(process.execPath, ['-e', nativeAdd, JSON.stringify([args, name, gitTextTarget])], options);
      }
      return (spawn as any)(command, args, options);
    }) as typeof childProcess.spawn);
    const snapshot = await captureCheckpoint(fixture.root);
    expect(conversions).toBe(2);
    expect(await runGit(fixture.root, ['show', `${snapshot.tree}:${name}`])).toEqual(Buffer.from(gitLinkTarget(nativeText)));
    expect(await gitText(fixture.root, ['ls-tree', snapshot.tree, '--', name])).toMatch(/^120000 blob /);
    expect(await fs.readlink(path.join(fixture.root, name))).toBe(nativeText);
    expect(await fs.readFile(path.join(fixture.root, '.git', 'index'))).toEqual(index);
    expect(await gitText(fixture.root, ['rev-parse', 'HEAD'])).toBe(fixture.head);
  });

  it('preserves safe Git symlink entries materialized as regular files with core.symlinks=false', async () => {
    await runGit(fixture.root, ['config', 'core.symlinks', 'false']);
    await fs.writeFile(path.join(fixture.root, 'materialized-link'), 'source.txt');
    const blob = await gitText(fixture.root, ['hash-object', '-w', '--stdin'], 'source.txt');
    await runGit(fixture.root, ['update-index', '--add', '--cacheinfo', `120000,${blob},materialized-link`]);
    const index = await fs.readFile(path.join(fixture.root, '.git', 'index'));
    const snapshot = await captureCheckpoint(fixture.root);
    expect(await gitText(fixture.root, ['ls-tree', snapshot.tree, '--', 'materialized-link'])).toMatch(/^120000 blob /);
    expect(await gitText(fixture.root, ['show', `${snapshot.tree}:materialized-link`])).toBe('source.txt');
    expect(await fs.readFile(path.join(fixture.root, '.git', 'index'))).toEqual(index);
    expect((await fs.lstat(path.join(fixture.root, 'materialized-link'))).isFile()).toBe(true);
  });

  it.skipIf(!supportsFileSymlinks).each(['scanning', 'staging', 'opaque insertion'])('rejects link replacement during %s instead of capturing a different entry', async phase => {
    await runGit(fixture.root, ['config', 'core.symlinks', 'true']);
    const link = path.join(fixture.root, 'nested');
    await fs.rm(link, { recursive: true });
    await fs.symlink('source.txt', link, 'file');
    const index = await fs.readFile(path.join(fixture.root, '.git', 'index'));
    let changed = false;
    if (phase === 'scanning') {
      const readlink = fs.readlink.bind(fs);
      vi.spyOn(fs, 'readlink').mockImplementation(async (...args: any[]) => {
        const target = await (readlink as any)(...args);
        if (!changed && args[0] === link) {
          changed = true;
          await fs.unlink(link); await fs.symlink('.gitignore', link, 'file');
        }
        return target;
      });
    } else {
      const { spawn } = await vi.importActual<typeof import('child_process')>('child_process');
      let adding = false;
      let added = false;
      vi.mocked(childProcess.spawn).mockImplementation(((command: any, args: any, options: any) => {
        if (command === 'git') {
          if (args.includes('add')) added = true;
          if (added && (phase === 'staging' || args.includes('hash-object'))) adding = true;
        }
        return (spawn as any)(command, args, options);
      }) as typeof childProcess.spawn);
      const lstat = fs.lstat.bind(fs);
      vi.spyOn(fs, 'lstat').mockImplementation(async (...args: any[]) => {
        if (adding && !changed && args[0] === link) {
          changed = true;
          await fs.unlink(link); await fs.symlink('.gitignore', link, 'file');
        }
        return (lstat as any)(...args);
      });
    }
    await expect(captureCheckpoint(fixture.root)).rejects.toThrow('symbolic link changed');
    expect(changed).toBe(true);
    expect(await fs.readFile(path.join(fixture.root, '.git', 'index'))).toEqual(index);
    expect(await gitText(fixture.root, ['rev-parse', 'HEAD'])).toBe(fixture.head);
  });

  it.skipIf(!supportsFileSymlinks)('rejects link replacement between capture passes even when link text is identical', async () => {
    await runGit(fixture.root, ['config', 'core.symlinks', 'true']);
    const link = path.join(fixture.root, 'nested');
    await fs.rm(link, { recursive: true }); await fs.symlink('source.txt', link, 'file');
    const index = await fs.readFile(path.join(fixture.root, '.git', 'index'));
    const rm = fs.rm.bind(fs);
    let changed = false;
    vi.spyOn(fs, 'rm').mockImplementation(async (file, options) => {
      await rm(file, options);
      if (!changed && path.basename(String(file)).startsWith('remote-cli-checkpoint-')) {
        changed = true;
        await fs.rename(link, path.join(fixture.directory, 'previous-link'));
        await fs.symlink('source.txt', link, 'file');
      }
    });
    await expect(captureCheckpoint(fixture.root)).rejects.toThrow('Workspace changed');
    expect(changed).toBe(true);
    expect(await fs.readFile(path.join(fixture.root, '.git', 'index'))).toEqual(index);
  });

  it('validates link targets from the captured tree even when inventory did not contain a link', async () => {
    const index = await fs.readFile(path.join(fixture.root, '.git', 'index'));
    const blob = await gitText(fixture.root, ['hash-object', '-w', '--stdin'], '../external-target');
    const unsafe = await gitText(fixture.root, ['mktree'], `120000 blob ${blob}\tlate-link\n`);
    const { spawn } = await vi.importActual<typeof import('child_process')>('child_process');
    vi.mocked(childProcess.spawn).mockImplementation(((command: any, args: any, options: any) => {
      if (command === 'git' && args.includes('write-tree')) {
        const commandIndex = args.indexOf('write-tree');
        args = [...args.slice(0, commandIndex), 'rev-parse', unsafe];
      }
      return (spawn as any)(command, args, options);
    }) as typeof childProcess.spawn);
    await expect(captureCheckpoint(fixture.root)).rejects.toThrow('must remain relative and inside');
    expect(await fs.readFile(path.join(fixture.root, '.git', 'index'))).toEqual(index);
  });

  it.skipIf(!supportsFileSymlinks).each([{ phase: 'untracked', automatic: false }, { phase: 'add', automatic: false },
    { phase: 'untracked', automatic: true }, { phase: 'add', automatic: true }])('never copies a shared payload during a link-to-directory race %j', async ({ phase, automatic }) => {
    await runGit(fixture.root, ['config', 'core.symlinks', 'true']);
    const target = path.join(fixture.directory, 'shared.txt');
    await fs.writeFile(target, 'synthetic shared target\n');
    const link = path.join(fixture.root, 'shared-link');
    await fs.symlink(path.relative(fixture.root, target), link, 'file');
    const payload = Buffer.from(`Synthetic excluded payload ${randomUUID()}\n`);
    const oid = await gitText(fixture.root, ['hash-object', '--stdin'], payload);
    await expect(runGit(fixture.root, ['cat-file', '-e', oid])).rejects.toThrow();
    const index = await fs.readFile(path.join(fixture.root, '.git', 'index'));
    const { spawn } = await vi.importActual<typeof import('child_process')>('child_process');
    let swapped = false;
    const scanOutput: Buffer[] = [];
    const calls: string[][] = [];
    vi.mocked(childProcess.spawn).mockImplementation(((command: any, args: any, options: any) => {
      const untracked = args.includes('ls-files') && args.includes('--others');
      const add = args.includes('add');
      if (command === 'git' && (untracked || add)) {
        calls.push([...args]);
        if (!swapped && (phase === 'untracked' ? untracked : add)) {
          // No await: this swap occurs after application validation and directly
          // before the native Git child can inspect the synthetic payload.
          swapped = true;
          unlinkSync(link); mkdirSync(link); writeFileSync(path.join(link, 'payload.txt'), payload);
        }
      }
      const child = (spawn as any)(command, args, options);
      if (command === 'git' && untracked) child.stdout.on('data', (chunk: Buffer) => scanOutput.push(chunk));
      return child;
    }) as typeof childProcess.spawn);
    await expect(captureCheckpoint(fixture.root, automatic ? { discoverExternal: true } : {
      sharedSymlinks: [{ root: fixture.root, path: 'shared-link', target }],
    })).rejects.toThrow(/symbolic[- ]link|symbolic link/i);
    expect(swapped).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    // hash-object above did not use -w: any object here would prove an
    // unintended native Git read/stage of the excluded payload.
    await expect(runGit(fixture.root, ['cat-file', '-e', oid])).rejects.toThrow();
    expect(calls.every(args => args.includes(':(top,exclude,literal)shared-link'))).toBe(true);
    expect(Buffer.concat(scanOutput).toString('utf8')).not.toContain('shared-link/payload.txt');
    expect(await fs.readFile(path.join(fixture.root, '.git', 'index'))).toEqual(index);
    expect(await gitText(fixture.root, ['rev-parse', 'HEAD'])).toBe(fixture.head);
    expect(await fs.readFile(target, 'utf8')).toBe('synthetic shared target\n');
  });

  it.skipIf(!supportsFileSymlinks)('excludes only the exact shared path while preserving its logical link and adjacent ordinary paths', async () => {
    await runGit(fixture.root, ['config', 'core.symlinks', 'true']);
    const target = path.join(fixture.directory, 'shared.txt'); await fs.writeFile(target, 'synthetic shared bytes\n');
    const name = 'nested/shared leaf';
    const text = path.relative(path.join(fixture.root, 'nested'), target);
    await fs.symlink(text, path.join(fixture.root, name), 'file');
    await fs.mkdir(path.join(fixture.root, 'nested', 'shared leaf-sibling'));
    await fs.writeFile(path.join(fixture.root, 'nested', 'shared leaf-sibling', 'ordinary.txt'), 'ordinary adjacent bytes\n');
    const index = await fs.readFile(path.join(fixture.root, '.git', 'index'));
    const checkpoint = await captureCheckpoint(fixture.root, { sharedSymlinks: [{ root: fixture.root, path: name, target }] });
    expect(await gitText(fixture.root, ['ls-tree', checkpoint.tree, '--', name])).toMatch(/^120000 blob /);
    expect(await gitText(fixture.root, ['show', `${checkpoint.tree}:${name}`])).toBe(text);
    expect(await gitText(fixture.root, ['show', `${checkpoint.tree}:nested/shared leaf-sibling/ordinary.txt`])).toBe('ordinary adjacent bytes');
    expect(await fs.readFile(path.join(fixture.root, '.git', 'index'))).toEqual(index);
    expect(await fs.readlink(path.join(fixture.root, name))).toBe(text);
  });

  it.skipIf(!supportsFileSymlinks)('does not apply outer shared exclusions to ordinary paths in an unrelated nested repository', async () => {
    await runGit(fixture.root, ['config', 'core.symlinks', 'true']);
    const nested = await nestedGitFixture(fixture, 'module');
    await fs.writeFile(path.join(nested, 'shared-link'), 'ordinary nested bytes\n');
    const target = path.join(fixture.directory, 'shared.txt'); await fs.writeFile(target, 'synthetic shared bytes\n');
    const text = path.relative(fixture.root, target);
    await fs.symlink(text, path.join(fixture.root, 'shared-link'), 'file');
    const checkpoint = await captureCheckpoint(fixture.root, {
      sharedSymlinks: [{ root: fixture.root, path: 'shared-link', target }],
    });
    expect(await gitText(fixture.root, ['show', `${checkpoint.tree}:shared-link`])).toBe(text);
    expect(await gitText(fixture.root, ['show', `${checkpoint.tree}:module/shared-link`])).toBe('ordinary nested bytes');
  });

  it.skipIf(!supportsFileSymlinks)('rejects a shared grant inside a nested repository before any recursive Git inventory', async () => {
    const nested = await nestedGitFixture(fixture, 'module');
    await runGit(nested, ['config', 'core.symlinks', 'true']);
    const target = path.join(fixture.directory, 'shared.txt'); await fs.writeFile(target, 'synthetic target\n');
    await fs.symlink(path.relative(nested, target), path.join(nested, 'shared-link'), 'file');
    vi.mocked(childProcess.spawn).mockClear();
    await expect(captureCheckpoint(fixture.root, {
      sharedSymlinks: [{ root: fixture.root, path: 'module/shared-link', target }],
    })).rejects.toThrow('inside nested repositories');
    expect(vi.mocked(childProcess.spawn).mock.calls.some(([command, args]) => command === 'git' && args?.includes('ls-files'))).toBe(false);
  });

  it.skipIf(!supportsFileSymlinks)('keeps an outer shared binding separate from a same-name internal nested link', async () => {
    await runGit(fixture.root, ['config', 'core.symlinks', 'true']);
    const nested = await nestedGitFixture(fixture, 'module');
    await runGit(nested, ['config', 'core.symlinks', 'true']);
    await fs.writeFile(path.join(nested, 'local.txt'), 'synthetic nested target\n');
    await fs.symlink('local.txt', path.join(nested, 'shared-link'), 'file');
    const target = path.join(fixture.directory, 'shared.txt');
    await fs.writeFile(target, 'synthetic shared target\n');
    const text = path.relative(fixture.root, target);
    await fs.symlink(text, path.join(fixture.root, 'shared-link'), 'file');
    const checkpoint = await captureCheckpoint(fixture.root, { sharedSymlinks: [{ root: fixture.root, path: 'shared-link', target }] });
    expect(await gitText(fixture.root, ['show', `${checkpoint.tree}:shared-link`])).toBe(text);
    expect(await gitText(fixture.root, ['show', `${checkpoint.tree}:module/shared-link`])).toBe('local.txt');
    expect(await fs.readFile(target, 'utf8')).toBe('synthetic shared target\n');
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

  // Six independent operations retain 30-second deadlines. The outer watchdog
  // covers their sum; a single slow capture still fails after 30 seconds.
  it('captures more than 10,000 tracked and untracked files without dropping input', async () => {
    const count = 10_001;
    const contents = Buffer.from('fixture\n');
    const relativeFile = (number: number) => `${number < 5000 ? 'committed' : 'untracked'}/${number}.txt`;
    const writeFiles = async (start: number, end: number) => {
      for (let offset = start; offset < end; offset += 128) {
        await phases.batch(Array.from({ length: Math.min(128, end - offset) }, (_, index) => {
          const relative = relativeFile(offset + index);
          return () => fs.writeFile(path.join(fixture.root, ...relative.split('/')), contents);
        }));
      }
    };
    await phases.run('create 5,000 tracked input files', async () => {
      await fs.mkdir(path.join(fixture.root, 'committed'));
      await writeFiles(0, 5000);
    });
    const { index, head } = await phases.run('commit tracked input and record source identity', async () => {
      await runGit(fixture.root, ['add', 'committed']);
      await runGit(fixture.root, ['commit', '-m', 'Add synthetic tracked files']);
      return { index: await fs.readFile(path.join(fixture.root, '.git', 'index')),
        head: await gitText(fixture.root, ['rev-parse', 'HEAD']) };
    });
    await phases.run('create 5,001 untracked input files', async () => {
      await fs.mkdir(path.join(fixture.root, 'untracked'));
      await writeFiles(5000, count);
    });
    const snapshot = await phases.run('capture all 10,001 tracked and untracked files', () => captureCheckpoint(fixture.root));
    await phases.run('verify every captured path and all tracked and untracked bytes', async () => {
      const entries = (await runGit(fixture.root, ['ls-tree', '-r', '-z', snapshot.tree]))
        .toString('utf8').split('\0').filter(Boolean);
      const files = entries.map(entry => entry.slice(entry.indexOf('\t') + 1));
      expect(files).toHaveLength(count + 3);
      expect(files).toContain('committed/4999.txt');
      expect(files).toContain('untracked/10000.txt');
      // One blob backs identical fixture bytes. Compare every path and object ID,
      // then read that blob, rather than starting 10,001 cat-file subprocesses.
      const blob = await gitText(fixture.root, ['hash-object', '--stdin'], contents);
      const expected = Array.from({ length: count }, (_, number) => `100644 blob ${blob}\t${relativeFile(number)}`).sort();
      expect(entries.filter(entry => /\t(?:committed|untracked)\//.test(entry)).sort()).toEqual(expected);
      expect(await runGit(fixture.root, ['cat-file', 'blob', blob])).toEqual(contents);
    });
    await phases.run('verify unchanged source HEAD and index', async () => {
      expect(await fs.readFile(path.join(fixture.root, '.git', 'index'))).toEqual(index);
      expect(await gitText(fixture.root, ['rev-parse', 'HEAD'])).toBe(head);
    });
  }, 6 * CHECKPOINT_PHASE_MS + 5_000);

  it('preserves an uninitialized gitlink without requiring its objects or fetching a remote', async () => {
    await runGit(fixture.root, ['update-index', '--add', '--cacheinfo', `160000,${fixture.head},module`]);
    await fs.mkdir(path.join(fixture.root, 'module'));
    const checkpoint = await captureCheckpoint(fixture.root);
    expect(await gitText(fixture.root, ['ls-tree', checkpoint.tree, '--', 'module'])).toContain('160000 commit');
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
