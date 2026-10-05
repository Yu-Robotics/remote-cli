import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DelegatedWorkspaceManager, type DelegatedWorkspace } from '../../src/delegation/DelegatedWorkspaceManager';
import { DelegatedWorkerSessionStore } from '../../src/delegation/DelegatedWorkerSessionStore';
import { CHECKPOINT_LIMITS, gitText, runGit } from '../../src/delegation/GitCheckpoint';
import * as gitCommands from '../../src/delegation/GitCheckpoint';
import { gitFixture } from './gitFixture';

describe('verified worker checkout reclamation and recreation', () => {
  let fixture: Awaited<ReturnType<typeof gitFixture>>;
  let manager: DelegatedWorkspaceManager;
  let lanes: DelegatedWorkerSessionStore;
  let lane: Awaited<ReturnType<DelegatedWorkerSessionStore['acquire']>>['lane'];
  let workspace: DelegatedWorkspace;
  const exists = async (file: string) => fs.lstat(file).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  const recordPath = () => path.join(fixture.directory, 'workspaces', 'lanes', `${lane.id}.json`);
  const artifactPath = () => path.join(fixture.directory, 'workspaces', 'artifacts', `${workspace.taskId}.json`);
  const record = async () => JSON.parse(await fs.readFile(recordPath(), 'utf8'));
  const edit = async (file: string, changes: object) => {
    await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), ...changes }));
  };
  const complete = async (successful = true) => manager.collect(workspace, successful);
  const recreate = async () => manager.prepare(lane, workspace.source, await manager.baseline(workspace.source), randomUUID());
  const inspect = () => manager.integrate({ threadId: lane.threadId, cwd: fixture.root, workspaceGeneration: 0 },
    workspace.taskId, 'inspect', undefined) as Promise<any>;
  const apply = async () => manager.integrate({ threadId: lane.threadId, cwd: fixture.root, workspaceGeneration: 0 },
    workspace.taskId, 'apply', (await inspect()).revision) as Promise<any>;
  const intent = async () => {
    const artifact = await manager.describe(workspace.taskId);
    await edit(recordPath(), { checkoutState: 'reclaiming', reclamation: {
      taskId: workspace.taskId, output: artifact!.outputCommit,
      tree: await gitText(fixture.root, ['rev-parse', `${artifact!.outputCommit}^{tree}`]),
    } });
  };

  beforeEach(async () => {
    fixture = await gitFixture();
    manager = new DelegatedWorkspaceManager(path.join(fixture.directory, 'workspaces'));
    lanes = new DelegatedWorkerSessionStore(path.join(fixture.directory, 'lanes'));
    ({ lane } = await lanes.acquire({ threadId: 'fixture-owner', backend: 'agy',
      workingDirectory: fixture.root, workspaceGeneration: 0 }));
    const source = (await manager.discover(fixture.root))!;
    workspace = await manager.prepare(lane, source, await manager.baseline(source), randomUUID());
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(fixture.directory, { recursive: true, force: true });
  });

  it('removes only a verified no-change checkout while preserving every artifact and history ref', async () => {
    const artifact = await complete();
    const refs = await gitText(fixture.root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remote-cli']);
    expect(await manager.reclaim(workspace.taskId)).toBe(true);
    expect(await exists(workspace.directory)).toBe(false);
    expect(await gitText(fixture.root, ['worktree', 'list', '--porcelain'])).not.toContain(workspace.directory);
    expect(await record()).toMatchObject({ checkoutState: 'reclaimed', taskId: workspace.taskId });
    expect(await manager.describe(workspace.taskId)).toEqual(artifact);
    expect(await gitText(fixture.root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remote-cli'])).toBe(refs);
    expect(await manager.reclaim(workspace.taskId)).toBe(false);
  });

  it('automatically reclaims applied output and recreates at the same path on a fresh delivery baseline', async () => {
    await fs.writeFile(path.join(workspace.cwd, 'source.txt'), 'delivered worker result\n');
    await complete();
    expect(await manager.reclaim(workspace.taskId)).toBe(false);
    const index = await fs.readFile(path.join(fixture.root, '.git', 'index'));
    expect(await apply()).toMatchObject({ applied: true, disposition: 'applied' });
    expect(await exists(workspace.directory)).toBe(false);
    expect(await fs.readFile(path.join(fixture.root, '.git', 'index'))).toEqual(index);
    await fs.writeFile(path.join(fixture.root, 'sibling.txt'), 'integrated sibling\n');
    manager = new DelegatedWorkspaceManager(path.join(fixture.directory, 'workspaces'));
    const next = await recreate();
    expect(next.cwd).toBe(workspace.cwd);
    expect(next.laneId).toBe(workspace.laneId);
    expect(next.input.commit).not.toBe(workspace.input.commit);
    expect(await fs.readFile(path.join(next.cwd, 'sibling.txt'), 'utf8')).toBe('integrated sibling\n');
    expect(await fs.readFile(path.join(next.cwd, 'source.txt'), 'utf8')).toBe('delivered worker result\n');
    expect(await manager.describe(workspace.taskId)).toMatchObject({ disposition: 'applied', changedFiles: ['source.txt'] });
    expect(await manager.reclaim(workspace.taskId)).toBe(false);
    expect(await exists(next.directory)).toBe(true);
  });

  it.each(['.env', 'node_modules/local.txt', 'unknown.txt', 'empty-extra-directory', 'stray-symlink'])(
    'preserves an unaccounted %s instead of trusting Git removal protection', async name => {
      await complete();
      const file = path.join(workspace.directory, name);
      if (name === 'empty-extra-directory') await fs.mkdir(file);
      else if (name === 'stray-symlink') await fs.symlink('source.txt', file);
      else { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'private fixture\n'); }
      expect(await manager.reclaim(workspace.taskId)).toBe(false);
      expect(await exists(file)).toBe(true);
      expect((await record()).checkoutState).toBe('present');
    });

  it.each(['--assume-unchanged', '--skip-worktree'])('detects hidden tracked changes with %s', async flag => {
    await complete();
    await runGit(workspace.directory, ['update-index', flag, 'source.txt']);
    const file = path.join(workspace.directory, 'source.txt');
    await fs.writeFile(file, 'hidden unsaved worker bytes\n');
    expect(await gitText(workspace.directory, ['status', '--porcelain'])).toBe('');
    expect(await manager.reclaim(workspace.taskId)).toBe(false);
    await expect(recreate()).rejects.toThrow('hidden index state');
    expect(await fs.readFile(file, 'utf8')).toBe('hidden unsaved worker bytes\n');
  });

  it('hashes tracked symlinks and executable modes without following link targets', async () => {
    await fs.symlink('source.txt', path.join(workspace.directory, 'link'));
    await fs.chmod(path.join(workspace.directory, 'source.txt'), 0o755);
    await complete();
    expect(await apply()).toMatchObject({ applied: true });
    expect(await exists(workspace.directory)).toBe(false);
    expect(await fs.readlink(path.join(fixture.root, 'link'))).toBe('source.txt');
  });

  it('retains normal line-ending transformations without blocking ordinary checkout reuse', async () => {
    await complete();
    expect(await manager.reclaim(workspace.taskId)).toBe(true);
    await fs.writeFile(path.join(fixture.root, '.gitattributes'), 'source.txt text eol=crlf\n');
    workspace = await recreate();
    expect(await fs.readFile(path.join(workspace.cwd, 'source.txt'), 'utf8')).toContain('\r\n');
    await complete();
    expect(await gitText(workspace.cwd, ['status', '--porcelain'])).toBe('');
    expect(await manager.reclaim(workspace.taskId)).toBe(false);
    expect((await recreate()).cwd).toBe(workspace.cwd);
  });

  it.each(['failed', 'retained', 'blocked', 'recovery'])('does not reclaim a %s receipt', async condition => {
    await complete(condition !== 'failed');
    if (condition === 'retained') await edit(artifactPath(), { disposition: 'retained' });
    if (condition === 'blocked') await manager.preserveLane(lane.id);
    if (condition === 'recovery') await edit(artifactPath(), { recovery: { beforeRef: 'refs/fixture/before', targetRef: 'refs/fixture/target' } });
    expect(await manager.reclaim(workspace.taskId)).toBe(false);
    expect(await exists(workspace.directory)).toBe(true);
  });

  it('preserves a pending artifact and an unresolved delivery application', async () => {
    await fs.writeFile(path.join(workspace.directory, 'pending.txt'), 'not delivered\n');
    await complete();
    expect(await manager.reclaim(workspace.taskId)).toBe(false);
    expect(await exists(workspace.directory)).toBe(true);
    await expect(recreate()).rejects.toThrow('unresolved artifacts');
  });

  it('keeps a locked checkout and preserves task success when removal fails', async () => {
    await complete();
    await runGit(fixture.root, ['worktree', 'lock', workspace.directory]);
    expect(await manager.reclaim(workspace.taskId)).toBe(false);
    expect(await exists(workspace.directory)).toBe(true);
    await runGit(fixture.root, ['worktree', 'unlock', workspace.directory]);
    const original = gitCommands.runGit;
    vi.spyOn(gitCommands, 'runGit').mockImplementation(async (cwd, args, ...rest) => {
      if (args[0] === 'worktree' && args[1] === 'remove' && args[2] === workspace.directory) throw new Error('Fixture removal failure');
      return original(cwd, args, ...rest);
    });
    expect(await manager.reclaim(workspace.taskId)).toBe(false);
    expect(await record()).toMatchObject({ checkoutState: 'reclaiming' });
    expect(await manager.describe(workspace.taskId)).toMatchObject({ successful: true, disposition: 'applied' });
    expect((await recreate()).cwd).toBe(workspace.cwd);
  });

  it.each(['intact', 'removed'])('resolves an interrupted intent only when the %s checkout is verified', async condition => {
    await complete();
    await intent();
    if (condition === 'removed') await runGit(fixture.root, ['worktree', 'remove', workspace.directory]);
    manager = new DelegatedWorkspaceManager(path.join(fixture.directory, 'workspaces'));
    expect((await recreate()).cwd).toBe(workspace.cwd);
    expect(await record()).toMatchObject({ checkoutState: 'present' });
  });

  it('refuses a missing legacy checkout without an intent and a removed path still registered in Git', async () => {
    await complete();
    await edit(recordPath(), { checkoutState: undefined });
    await runGit(fixture.root, ['worktree', 'remove', workspace.directory]);
    await expect(recreate()).rejects.toThrow('reclamation receipt');
    const next = await manager.prepare({ ...lane, id: randomUUID() }, workspace.source,
      await manager.baseline(workspace.source), randomUUID());
    workspace = next;
    lane = { ...lane, id: next.laneId };
    await complete();
    await intent();
    await fs.rm(workspace.directory, { recursive: true });
    await expect(recreate()).rejects.toThrow('partially registered');
    expect(await gitText(fixture.root, ['worktree', 'list', '--porcelain'])).toContain(workspace.directory);
  });

  it('never overwrites an occupied reclaimed path, including a foreign symlink', async () => {
    await complete();
    expect(await manager.reclaim(workspace.taskId)).toBe(true);
    await fs.symlink(fixture.root, workspace.directory);
    await expect(recreate()).rejects.toThrow('occupied');
    expect(await fs.readlink(workspace.directory)).toBe(fixture.root);
  });

  it.each(['task', 'output', 'history', 'receipt', 'lifecycle'])('rejects a corrupted %s identity before deletion', async corruption => {
    await complete();
    if (corruption === 'task') await edit(recordPath(), { taskRef: 'refs/heads/main' });
    if (corruption === 'output') await runGit(fixture.root, ['update-ref', workspace.taskRef, fixture.head]);
    if (corruption === 'history') await runGit(fixture.root, ['update-ref', '-d', `refs/remote-cli/worker-history/${workspace.taskId}`]);
    if (corruption === 'receipt') { await intent(); await edit(recordPath(), { reclamation: { taskId: workspace.taskId, output: fixture.head, tree: fixture.head } }); }
    if (corruption === 'lifecycle') await edit(recordPath(), { checkoutState: 'unknown' });
    expect(await manager.reclaim(workspace.taskId)).toBe(false);
    expect(await exists(workspace.directory)).toBe(true);
  });

  it('fails closed when the verification bounds are exceeded', async () => {
    await complete();
    const original = CHECKPOINT_LIMITS.bytes;
    Object.assign(CHECKPOINT_LIMITS, { bytes: 1 });
    try { expect(await manager.reclaim(workspace.taskId)).toBe(false); }
    finally { Object.assign(CHECKPOINT_LIMITS, { bytes: original }); }
    expect(await exists(workspace.directory)).toBe(true);
  });

  it('serializes prepare behind a removal and shares the guard across manager instances', async () => {
    await complete();
    const original = gitCommands.runGit;
    let release!: () => void;
    let removing!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { removing = resolve; });
    vi.spyOn(gitCommands, 'runGit').mockImplementation(async (cwd, args, ...rest) => {
      if (args[0] === 'worktree' && args[1] === 'remove' && args[2] === workspace.directory) {
        removing(); await gate;
      }
      return original(cwd, args, ...rest);
    });
    const reclaiming = manager.reclaim(workspace.taskId);
    await entered;
    const other = new DelegatedWorkspaceManager(path.join(fixture.directory, 'workspaces'));
    let prepared = false;
    const preparing = other.prepare(lane, workspace.source, await manager.baseline(workspace.source), randomUUID())
      .then(value => { prepared = true; return value; });
    await Promise.resolve();
    expect(prepared).toBe(false);
    release();
    expect(await reclaiming).toBe(true);
    expect((await preparing).cwd).toBe(workspace.cwd);
    expect(await exists(workspace.directory)).toBe(true);
  });
});
