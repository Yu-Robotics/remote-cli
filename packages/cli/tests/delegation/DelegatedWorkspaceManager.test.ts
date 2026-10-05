import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DelegatedWorkspaceManager, type DelegatedWorkspace, type DelegatedWorkspaceSource } from '../../src/delegation/DelegatedWorkspaceManager';
import { DelegatedWorkerSessionStore } from '../../src/delegation/DelegatedWorkerSessionStore';
import { gitText, runGit } from '../../src/delegation/GitCheckpoint';
import * as gitCommands from '../../src/delegation/GitCheckpoint';
import { gitFixture } from './gitFixture';

// Real-Git cases execute multiple bounded commands and need headroom on slower hosts.
describe('owned worktrees and explicit artifact integration', { timeout: 30_000 }, () => {
  let fixture: Awaited<ReturnType<typeof gitFixture>>;
  let manager: DelegatedWorkspaceManager;
  let lanes: DelegatedWorkerSessionStore;
  let source: DelegatedWorkspaceSource;
  const owner = { threadId: 'fixture-owner', workspaceGeneration: 0 };
  beforeEach(async () => {
    fixture = await gitFixture();
    manager = new DelegatedWorkspaceManager(path.join(fixture.directory, 'workspaces'));
    lanes = new DelegatedWorkerSessionStore(path.join(fixture.directory, 'lanes'));
    source = (await manager.discover(fixture.root))!;
  }, 30_000);
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(fixture.directory, { recursive: true, force: true }); }, 30_000);

  const prepare = async (selected = source) => {
    const { lane } = await lanes.acquire({ threadId: owner.threadId, workspaceGeneration: 0,
      backend: 'agy', workingDirectory: selected.cwd });
    return { lane, workspace: await manager.prepare(lane, selected, await manager.baseline(selected), randomUUID()) };
  };
  const inspect = (workspace: DelegatedWorkspace) => manager.integrate({ ...owner, cwd: workspace.source.cwd }, workspace.taskId, 'inspect', undefined) as Promise<any>;
  const apply = async (workspace: DelegatedWorkspace) => manager.integrate({ ...owner, cwd: workspace.source.cwd },
    workspace.taskId, 'apply', (await inspect(workspace)).revision) as Promise<any>;

  it('isolates dirty input, collects durable output and applies without staging or committing', async () => {
    await fs.writeFile(path.join(source.root, 'source.txt'), 'first\nstaged input\nthird\n');
    await runGit(source.root, ['add', 'source.txt']);
    await fs.writeFile(path.join(source.root, 'notes.txt'), 'uncommitted review input\n');
    const index = await fs.readFile(path.join(source.root, '.git', 'index'));
    const { workspace } = await prepare();
    expect(workspace.cwd).not.toBe(source.cwd);
    expect(await fs.readFile(path.join(workspace.cwd, 'notes.txt'), 'utf8')).toContain('review input');
    await fs.writeFile(path.join(workspace.cwd, 'source.txt'), 'worker change\nstaged input\nthird\n');
    await fs.writeFile(path.join(workspace.cwd, 'new.bin'), Buffer.from([0, 255, 8]));
    const artifact = await manager.collect(workspace, true);
    expect(artifact.disposition).toBe('pending');
    expect(artifact.changedFiles).toEqual(['new.bin', 'source.txt']);
    expect(await fs.readFile(path.join(source.cwd, 'source.txt'), 'utf8')).toContain('first');
    expect((await manager.unavailableLanes()).has(workspace.laneId)).toBe(true);
    expect(await apply(workspace)).toMatchObject({ disposition: 'applied', applied: true });
    expect(await fs.readFile(path.join(source.cwd, 'source.txt'), 'utf8')).toContain('worker change');
    expect(await fs.readFile(path.join(source.cwd, 'new.bin'))).toEqual(Buffer.from([0, 255, 8]));
    expect(await fs.readFile(path.join(source.root, '.git', 'index'))).toEqual(index);
    expect(await gitText(source.root, ['rev-parse', 'HEAD'])).toBe(fixture.head);
    expect((await manager.unavailableLanes()).has(workspace.laneId)).toBe(false);
    const restarted = new DelegatedWorkspaceManager(path.join(fixture.directory, 'workspaces'));
    expect(await restarted.describe(workspace.taskId)).toMatchObject({ disposition: 'applied' });
  });

  it('reuses the directory and starts a private task checkout on the updated delivery baseline', async () => {
    const { lane, workspace } = await prepare();
    await fs.writeFile(path.join(workspace.cwd, 'source.txt'), 'integrated worker change\n');
    await manager.collect(workspace, true);
    await expect(manager.prepare(lane, source, await manager.baseline(source), randomUUID())).rejects.toThrow('unresolved artifacts');
    await apply(workspace);
    await fs.writeFile(path.join(source.cwd, 'sibling.txt'), 'merged sibling result\n');
    const second = await manager.prepare(lane, source, await manager.baseline(source), randomUUID());
    expect(second.cwd).toBe(workspace.cwd);
    expect(second.taskRef).not.toBe(workspace.taskRef);
    expect(await fs.readFile(path.join(second.cwd, 'sibling.txt'), 'utf8')).toContain('sibling result');
    expect(await fs.readFile(path.join(second.cwd, 'source.txt'), 'utf8')).toContain('integrated worker change');
    expect(await gitText(second.cwd, ['branch', '--show-current'])).toBe('');
    expect(await gitText(source.root, ['for-each-ref', '--format=%(refname)', 'refs/heads'])).toBe('refs/heads/main');
  }, 30_000);

  it('rejects hidden delivery edits at baseline and integration without applying a stale patch', async () => {
    const { workspace } = await prepare();
    await fs.writeFile(path.join(workspace.cwd, 'source.txt'), 'worker output\n');
    await manager.collect(workspace, true);
    const checked = await inspect(workspace);
    await runGit(source.root, ['update-index', '--assume-unchanged', 'source.txt']);
    await fs.writeFile(path.join(source.root, 'source.txt'), 'hidden delivery edits\n');
    const index = await fs.readFile(path.join(source.root, '.git', 'index'));
    await expect(manager.baseline(source)).rejects.toThrow('assume-unchanged or skip-worktree');
    await expect(manager.integrate({ ...owner, cwd: source.cwd }, workspace.taskId, 'apply', checked.revision))
      .rejects.toThrow('assume-unchanged or skip-worktree');
    expect(await fs.readFile(path.join(source.root, 'source.txt'), 'utf8')).toBe('hidden delivery edits\n');
    expect(await fs.readFile(path.join(source.root, '.git', 'index'))).toEqual(index);
    expect(await manager.describe(workspace.taskId)).toMatchObject({ disposition: 'pending' });
    expect(await gitText(source.root, ['rev-parse', 'HEAD'])).toBe(fixture.head);
  });

  it('merges independent committed worker outputs but leaves conflicting changes in a recovery worktree', async () => {
    const baseline = await manager.baseline(source);
    const first = await prepare();
    const { lane } = await lanes.acquire({ threadId: owner.threadId, backend: 'dsh', workingDirectory: source.cwd, workspaceGeneration: 0 });
    const second = await manager.prepare(lane, source, baseline, randomUUID());
    await fs.writeFile(path.join(first.workspace.cwd, 'source.txt'), 'worker one\n');
    await fs.writeFile(path.join(second.cwd, 'source.txt'), 'worker two\n');
    await runGit(first.workspace.cwd, ['add', '.']);
    await runGit(first.workspace.cwd, ['commit', '-m', 'Worker fixture change']);
    await manager.collect(first.workspace, true);
    await manager.collect(second, true);
    await apply(first.workspace);
    const before = await fs.readFile(path.join(source.cwd, 'source.txt'));
    const conflicts = await apply(second);
    expect(conflicts).toMatchObject({ applied: false, conflicts: ['source.txt'], disposition: 'pending' });
    expect(await fs.readFile(path.join(source.cwd, 'source.txt'))).toEqual(before);
    expect(await fs.readFile(path.join(conflicts.recoveryDirectory, 'source.txt'), 'utf8')).toContain('<<<<<<<');
    expect(await gitText(source.root, ['ls-files', '-u'])).toBe('');
  }, 30_000);

  it('retains intentionally unmerged artifacts, never deletes unknown dirty or ignored files on reuse', async () => {
    const { lane, workspace } = await prepare();
    await fs.writeFile(path.join(workspace.cwd, 'pending.txt'), 'retained output\n');
    await manager.collect(workspace, false);
    await expect(apply(workspace)).rejects.toThrow('manual recovery');
    const revision = (await inspect(workspace)).revision;
    expect(await manager.integrate({ ...owner, cwd: source.cwd }, workspace.taskId, 'retain', revision)).toMatchObject({ disposition: 'retained' });
    expect(await gitText(source.root, ['show', `${(await manager.describe(workspace.taskId))!.outputCommit}:pending.txt`])).toBe('retained output');
    await fs.writeFile(path.join(workspace.cwd, 'unknown.txt'), 'do not delete\n');
    await expect(manager.prepare(lane, source, await manager.baseline(source), randomUUID())).rejects.toThrow('unaccounted changes');
    expect(await fs.readFile(path.join(workspace.cwd, 'unknown.txt'), 'utf8')).toBe('do not delete\n');
    await fs.rm(path.join(workspace.cwd, 'unknown.txt'));
    await fs.writeFile(path.join(workspace.cwd, '.env'), 'IGNORED_WORKER=fixture\n');
    await fs.writeFile(path.join(source.cwd, '.env'), 'TRACKED_PARENT=fixture\n');
    await runGit(source.root, ['add', '--force', '.env']);
    await expect(manager.prepare(lane, source, await manager.baseline(source), randomUUID())).rejects.toThrow('Git checkout failed');
    expect(await fs.readFile(path.join(workspace.cwd, '.env'), 'utf8')).toContain('IGNORED_WORKER');
  });

  it('uses revision guards, ownership and selected-directory scope before applying', async () => {
    const selected = (await manager.discover(path.join(source.root, 'nested')))!;
    const { workspace } = await prepare(selected);
    expect(workspace.cwd).toBe(path.join(workspace.directory, 'nested'));
    await fs.writeFile(path.join(workspace.directory, 'source.txt'), 'outside selected scope\n');
    await manager.collect(workspace, true);
    const checked = await inspect(workspace);
    await fs.writeFile(path.join(selected.cwd, 'local.txt'), 'delivery changed\n');
    await expect(manager.integrate({ ...owner, cwd: selected.cwd }, workspace.taskId, 'apply', checked.revision)).rejects.toThrow('changed');
    await expect(apply(workspace)).rejects.toThrow('outside the selected');
    await expect(manager.integrate({ ...owner, threadId: 'foreign', cwd: selected.cwd }, workspace.taskId, 'inspect', undefined)).rejects.toThrow('foreign');
    await expect(manager.integrate({ ...owner, workspaceGeneration: 1, cwd: selected.cwd }, workspace.taskId, 'inspect', undefined)).rejects.toThrow('foreign');
    await expect(manager.integrate({ ...owner, cwd: selected.cwd }, '../invalid', 'inspect', undefined)).rejects.toThrow('Invalid');
  });

  it('does not initialize non-Git directories, silently fall back for broken Git, or resume foreign worktrees', async () => {
    const plain = path.join(fixture.directory, 'plain');
    await fs.mkdir(plain);
    expect(await manager.discover(plain)).toBeUndefined();
    await expect(fs.stat(path.join(plain, '.git'))).rejects.toHaveProperty('code', 'ENOENT');
    await fs.writeFile(path.join(plain, '.git'), 'gitdir: missing\n');
    await expect(manager.discover(plain)).rejects.toThrow('Git rev-parse failed');
    const { workspace } = await prepare();
    const fake = { ...workspace, directory: fixture.root, cwd: fixture.root };
    await expect(manager.collect(fake, true)).rejects.toThrow('identity changed');
    await manager.preserveLane(workspace.laneId);
    expect((await manager.unavailableLanes()).has(workspace.laneId)).toBe(true);
  });

  it('preserves before/target recovery snapshots after a possibly partial file application', async () => {
    const { workspace } = await prepare();
    await fs.writeFile(path.join(workspace.cwd, 'source.txt'), 'desired integration\n');
    await manager.collect(workspace, true);
    const originalRun = gitCommands.runGit;
    vi.spyOn(gitCommands, 'runGit').mockImplementation(async (cwd, args, input, env) => {
      if (args[0] === 'apply' && !args.includes('--check')) {
        await fs.writeFile(path.join(source.cwd, 'source.txt'), 'partial mutation\n');
        throw new Error('Synthetic late file application failure');
      }
      return originalRun(cwd, args, input, env);
    });
    const index = await fs.readFile(path.join(source.root, '.git', 'index'));
    const failed = await apply(workspace);
    expect(failed).toMatchObject({ applied: false, deliveryMayHaveChanged: true, disposition: 'pending' });
    expect(await gitText(source.root, ['show', `${failed.recovery.beforeRef}:source.txt`])).toBe('first\nsecond\nthird');
    expect(await gitText(source.root, ['show', `${failed.recovery.targetRef}:source.txt`])).toBe('desired integration');
    expect(await fs.readFile(path.join(source.root, '.git', 'index'))).toEqual(index);
    expect(await inspect(workspace)).toHaveProperty('recovery', failed.recovery);
    await expect(apply(workspace)).rejects.toThrow('may be incomplete');
  });

  it('checks both rename endpoints rather than hiding a deletion outside the selected subdirectory', async () => {
    const selected = (await manager.discover(path.join(source.root, 'nested')))!;
    const { workspace } = await prepare(selected);
    await fs.rename(path.join(workspace.directory, 'source.txt'), path.join(workspace.cwd, 'moved.txt'));
    const captured = await manager.collect(workspace, true);
    expect(captured.changedFiles).toContain('source.txt');
    await expect(apply(workspace)).rejects.toThrow('outside the selected');
    expect(await fs.readFile(path.join(source.root, 'source.txt'), 'utf8')).toContain('first');
    await expect(fs.stat(path.join(selected.cwd, 'moved.txt'))).rejects.toHaveProperty('code', 'ENOENT');
  });

  it('preserves partial integration setup without masking its original failure', async () => {
    const { workspace } = await prepare();
    await fs.writeFile(path.join(workspace.cwd, 'source.txt'), 'desired integration\n');
    await manager.collect(workspace, true);
    const originalRun = gitCommands.runGit;
    let partialDirectory = '';
    vi.spyOn(gitCommands, 'runGit').mockImplementation(async (cwd, args, input, env) => {
      if (args[0] === 'worktree' && args[1] === 'add') {
        partialDirectory = args[3];
        await fs.writeFile(path.join(partialDirectory, 'partial-checkout.txt'), 'recoverable input\n');
        throw new Error('Synthetic worktree setup failure');
      }
      return originalRun(cwd, args, input, env);
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(apply(workspace)).rejects.toThrow('Synthetic worktree setup failure');
    expect(warning).toHaveBeenCalledWith('[Delegation] Partial integration directory retained for manual cleanup');
    expect(await fs.readFile(path.join(partialDirectory, 'partial-checkout.txt'), 'utf8')).toBe('recoverable input\n');
    expect((await inspect(workspace)).disposition).toBe('pending');
    expect(await fs.readFile(path.join(source.cwd, 'source.txt'), 'utf8')).toContain('first');
  });

  it('fails closed on corrupted task or artifact references without updating the delivery branch', async () => {
    const { workspace } = await prepare();
    await expect(manager.collect({ ...workspace, taskRef: 'refs/heads/main' }, true)).rejects.toThrow('task reference');
    await manager.collect(workspace, true);
    await runGit(source.root, ['update-ref', `refs/remote-cli/artifacts/${workspace.taskId}`, fixture.head]);
    await expect(inspect(workspace)).rejects.toThrow('reference changed');
    expect(await gitText(source.root, ['rev-parse', 'HEAD'])).toBe(fixture.head);
  });
});
