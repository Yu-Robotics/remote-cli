import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DelegatedWorkspaceManager, type DelegatedWorkspace } from '../../src/delegation/DelegatedWorkspaceManager';
import { DelegatedWorkerSessionStore } from '../../src/delegation/DelegatedWorkerSessionStore';
import { createCheckpointCommit, GitCommandError, gitText, runGit } from '../../src/delegation/GitCheckpoint';
import * as gitCommands from '../../src/delegation/GitCheckpoint';
import { gitFixture } from './gitFixture';

describe('historical worker delivery recognition', () => {
  let fixture: Awaited<ReturnType<typeof gitFixture>>;
  let manager: DelegatedWorkspaceManager;
  let lanes: DelegatedWorkerSessionStore;
  let workspace: DelegatedWorkspace;
  const owner = () => ({ threadId: 'fixture-owner', cwd: fixture.root, workspaceGeneration: 0 });
  const lanePath = () => path.join(fixture.directory, 'workspaces', 'lanes', `${workspace.laneId}.json`);
  const artifactPath = () => path.join(fixture.directory, 'workspaces', 'artifacts', `${workspace.taskId}.json`);
  const read = async (file: string) => JSON.parse(await fs.readFile(file, 'utf8'));
  const edit = async (file: string, changes: object) => fs.writeFile(file, JSON.stringify({ ...await read(file), ...changes }));
  const pending = async (successful = true) => {
    await fs.writeFile(path.join(workspace.cwd, 'source.txt'), 'worker outcome\n');
    const artifact = await manager.collect(workspace, successful);
    await lanes.markReady(workspace.laneId);
    return artifact;
  };
  const publish = (commit: string) => runGit(fixture.root, ['merge', '--ff-only', commit]);
  const reconcile = async (reclaim = false) => manager.reconcileHistoricalDelivery(owner(),
    await lanes.lanesForThread('fixture-owner'), reclaim);
  const inspect = () => manager.integrate(owner(), workspace.taskId, 'inspect', undefined) as Promise<any>;

  beforeEach(async () => {
    fixture = await gitFixture();
    manager = new DelegatedWorkspaceManager(path.join(fixture.directory, 'workspaces'));
    lanes = new DelegatedWorkerSessionStore(path.join(fixture.directory, 'lanes'));
    const { lane } = await lanes.acquire({ ...owner(), backend: 'agy', workingDirectory: fixture.root });
    const source = (await manager.discover(fixture.root))!;
    workspace = await manager.prepare(lane, source, await manager.baseline(source), randomUUID());
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(fixture.directory, { recursive: true, force: true }); });

  it('recognizes output equal to HEAD without changing delivery files, index, or checkout', async () => {
    const artifact = await pending();
    await publish(artifact.outputCommit);
    const index = await fs.readFile(path.join(fixture.root, '.git', 'index'));
    expect(await reconcile()).toMatchObject([{ disposition: 'applied', deliveredAtHead: artifact.outputCommit }]);
    expect(await gitText(fixture.root, ['rev-parse', 'HEAD'])).toBe(artifact.outputCommit);
    expect(await fs.readFile(path.join(fixture.root, '.git', 'index'))).toEqual(index);
    expect(await fs.readFile(path.join(fixture.root, 'source.txt'), 'utf8')).toBe('worker outcome\n');
    expect((await fs.stat(workspace.directory)).isDirectory()).toBe(true);
    expect(await read(artifactPath())).toMatchObject({ deliveredAtHead: artifact.outputCommit, disposition: 'applied' });
    expect((await read(artifactPath())).integratedTree).toBeUndefined();
    expect((await read(lanePath())).pendingTaskId).toBeUndefined();
    expect((await manager.unavailableLanes()).has(workspace.laneId)).toBe(false);
  });

  it('recognizes merge ancestry even after a revert and preserves the receipt across restart', async () => {
    const artifact = await pending();
    await runGit(fixture.root, ['merge', '--no-ff', '--no-edit', artifact.outputCommit]);
    const merge = await gitText(fixture.root, ['rev-parse', 'HEAD']);
    await runGit(fixture.root, ['revert', '-m', '1', '--no-edit', merge]);
    await fs.writeFile(path.join(fixture.root, 'sibling.txt'), 'main owner decision\n');
    await runGit(fixture.root, ['add', 'sibling.txt']);
    await runGit(fixture.root, ['commit', '-m', 'Independent delivery change']);
    const head = await gitText(fixture.root, ['rev-parse', 'HEAD']);
    expect(await fs.readFile(path.join(fixture.root, 'source.txt'), 'utf8')).toBe('first\nsecond\nthird\n');
    expect(await reconcile(true)).toMatchObject([{ disposition: 'applied', deliveredAtHead: head }]);
    await expect(fs.lstat(workspace.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    manager = new DelegatedWorkspaceManager(path.join(fixture.directory, 'workspaces'));
    expect(await manager.describe(workspace.taskId)).toMatchObject({ disposition: 'applied', deliveredAtHead: head });
    expect(await reconcile(true)).toEqual([]);
    expect(await gitText(fixture.root, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await fs.readFile(path.join(fixture.root, 'sibling.txt'), 'utf8')).toBe('main owner decision\n');
  });

  it.each(['baseline', 'copied-tree', 'cherry-pick', 'native-worker-head'])(
    'does not substitute %s for the captured output commit', async evidence => {
      let nativeHead: string | undefined;
      if (evidence === 'native-worker-head') {
        await fs.writeFile(path.join(workspace.cwd, 'source.txt'), 'committed worker step\n');
        await runGit(workspace.cwd, ['add', 'source.txt']);
        await runGit(workspace.cwd, ['commit', '-m', 'Native worker step']);
        nativeHead = await gitText(workspace.cwd, ['rev-parse', 'HEAD']);
      }
      const artifact = await pending();
      if (evidence === 'baseline') await publish(artifact.baseCommit);
      else if (evidence === 'native-worker-head') await publish(nativeHead!);
      else if (evidence === 'cherry-pick') await runGit(fixture.root, ['cherry-pick', artifact.outputCommit]);
      else {
        await fs.writeFile(path.join(fixture.root, 'source.txt'), 'worker outcome\n');
        await runGit(fixture.root, ['add', 'source.txt']);
        await runGit(fixture.root, ['commit', '-m', 'Copy without worker ancestry']);
        expect(await gitText(fixture.root, ['rev-parse', 'HEAD^{tree}']))
          .toBe(await gitText(fixture.root, ['rev-parse', `${artifact.outputCommit}^{tree}`]));
      }
      expect(await reconcile(true)).toEqual([]);
      expect(await manager.describe(workspace.taskId)).toMatchObject({ disposition: 'pending' });
      expect((await read(lanePath())).pendingTaskId).toBe(workspace.taskId);
      expect((await fs.stat(workspace.directory)).isDirectory()).toBe(true);
      expect(console.warn).not.toHaveBeenCalled();
    });

  it('recognizes historical delivery during inspection and automatically tries safe reclamation', async () => {
    const artifact = await pending();
    await publish(artifact.outputCommit);
    expect(await inspect()).toMatchObject({ disposition: 'applied', deliveredAtHead: artifact.outputCommit,
      integration: expect.stringContaining('Historically delivered') });
    await expect(fs.lstat(workspace.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('honors an explicit retain decision even when historical delivery could be recognized', async () => {
    const artifact = await pending();
    await publish(artifact.outputCommit);
    const current = await manager.baseline(workspace.source);
    expect(await manager.integrate(owner(), workspace.taskId, 'retain', current.revision)).toMatchObject({ disposition: 'retained' });
    expect(await reconcile(true)).toEqual([]);
    expect((await read(artifactPath())).deliveredAtHead).toBeUndefined();
    expect((await fs.stat(workspace.directory)).isDirectory()).toBe(true);
  });

  it.each(['.env', 'unknown.txt', 'locked'])(
    'confirms handoff but preserves a checkout containing %s', async extra => {
      const artifact = await pending();
      await publish(artifact.outputCommit);
      if (extra === 'locked') await runGit(fixture.root, ['worktree', 'lock', workspace.directory]);
      else await fs.writeFile(path.join(workspace.directory, extra), 'unrecorded fixture\n');
      expect(await reconcile(true)).toMatchObject([{ disposition: 'applied' }]);
      expect((await fs.stat(workspace.directory)).isDirectory()).toBe(true);
      expect((await read(lanePath())).checkoutState).toBe('present');
      if (extra !== 'locked') expect(await fs.readFile(path.join(workspace.directory, extra), 'utf8')).toBe('unrecorded fixture\n');
    });

  it.each(['failed', 'retained', 'blocked', 'recovery', 'running', 'foreign-thread', 'foreign-generation'])(
    'does not recognize or reclaim %s state', async condition => {
      const artifact = await pending(condition !== 'failed');
      if (condition === 'retained') await manager.integrate(owner(), workspace.taskId, 'retain', (await inspect()).revision);
      if (condition === 'blocked') await manager.preserveLane(workspace.laneId);
      if (condition === 'recovery') await edit(artifactPath(), { recovery: { beforeRef: 'refs/fixture/before', targetRef: 'refs/fixture/target' } });
      if (condition === 'running') await lanes.markRunning(workspace.laneId);
      await publish(artifact.outputCommit);
      const caller = { ...owner(), ...(condition === 'foreign-thread' ? { threadId: 'other-owner' } : {}),
        ...(condition === 'foreign-generation' ? { workspaceGeneration: 1 } : {}) };
      expect(await manager.reconcileHistoricalDelivery(caller, await lanes.lanesForThread('fixture-owner'), true)).toEqual([]);
      expect(await manager.describe(workspace.taskId)).toMatchObject({ disposition: condition === 'retained' ? 'retained' : 'pending' });
      expect((await fs.stat(workspace.directory)).isDirectory()).toBe(true);
    });

  it.each(['output-ref', 'task-ref', 'history-ref'])(
    'preserves an artifact with a corrupted %s', async corruption => {
      const artifact = await pending();
      await publish(artifact.outputCommit);
      const ref = corruption === 'output-ref' ? `refs/remote-cli/artifacts/${workspace.taskId}`
        : corruption === 'task-ref' ? workspace.taskRef : `refs/remote-cli/worker-history/${workspace.taskId}`;
      await runGit(fixture.root, ['update-ref', '-d', ref]);
      expect(await reconcile(true)).toEqual([]);
      expect((await read(artifactPath())).disposition).toBe('pending');
      expect((await read(lanePath())).pendingTaskId).toBe(workspace.taskId);
      expect((await fs.stat(workspace.directory)).isDirectory()).toBe(true);
    });

  it('does not accept ancestry synthesized by replacement objects', async () => {
    const artifact = await pending();
    const replacement = await createCheckpointCommit(fixture.root,
      await gitText(fixture.root, ['rev-parse', 'HEAD^{tree}']), artifact.outputCommit, 'Synthetic replacement fixture');
    await runGit(fixture.root, ['replace', fixture.head, replacement]);
    await runGit(fixture.root, ['merge-base', '--is-ancestor', artifact.outputCommit, fixture.head]);
    expect(await reconcile(true)).toEqual([]);
    expect((await read(artifactPath())).disposition).toBe('pending');
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each([new GitCommandError('merge-base', 128, 'Fixture ancestry unavailable'),
    new GitCommandError('merge-base', null, 'Fixture child interrupted'), new Error('Fixture ancestry timed out')])(
    'keeps inspection and admission usable when ancestry fails with %s', async failure => {
    const artifact = await pending();
    await publish(artifact.outputCommit);
    const original = gitCommands.runGit;
    vi.spyOn(gitCommands, 'runGit').mockImplementation(async (cwd, args, ...rest) => {
      if (args.includes('merge-base')) throw failure;
      return original(cwd, args, ...rest);
    });
    expect(await inspect()).toMatchObject({ disposition: 'pending' });
    expect(await reconcile(true)).toEqual([]);
    expect((await read(lanePath())).pendingTaskId).toBe(workspace.taskId);
    expect(console.warn).toHaveBeenCalled();
    });

  it('defers recognition if delivery HEAD changes while checking ancestry', async () => {
    const artifact = await pending();
    await publish(artifact.outputCommit);
    const original = gitCommands.runGit;
    vi.spyOn(gitCommands, 'runGit').mockImplementation(async (cwd, args, ...rest) => {
      const result = await original(cwd, args, ...rest);
      if (args.includes('merge-base')) await original(fixture.root, ['update-ref', 'refs/heads/main', fixture.head]);
      return result;
    });
    expect(await reconcile(true)).toEqual([]);
    expect((await read(artifactPath())).disposition).toBe('pending');
    expect((await fs.stat(workspace.directory)).isDirectory()).toBe(true);
  });

  it('does not reapply reverted files when the historical receipt is durable but marker clearing fails', async () => {
    const artifact = await pending();
    await publish(artifact.outputCommit);
    await runGit(fixture.root, ['revert', '--no-edit', artifact.outputCommit]);
    const current = await manager.baseline(workspace.source);
    const index = await fs.readFile(path.join(fixture.root, '.git', 'index'));
    const originalWrite = (manager as any).write.bind(manager);
    vi.spyOn(manager as any, 'write').mockImplementation(async (...args: any[]) => {
      if (args[0] === 'lanes' && args[2].pendingTaskId === undefined) throw new Error('Fixture marker write interrupted');
      return originalWrite(...args);
    });
    expect(await manager.integrate(owner(), workspace.taskId, 'apply', current.revision)).toMatchObject({
      disposition: 'applied', deliveredAtHead: current.head,
    });
    expect(await fs.readFile(path.join(fixture.root, 'source.txt'), 'utf8')).toBe('first\nsecond\nthird\n');
    expect(await gitText(fixture.root, ['rev-parse', 'HEAD'])).toBe(current.head);
    expect(await fs.readFile(path.join(fixture.root, '.git', 'index'))).toEqual(index);
    expect((await read(lanePath())).pendingTaskId).toBe(workspace.taskId);
    expect((await fs.stat(workspace.directory)).isDirectory()).toBe(true);
  });

  it('repairs a crash between the historical receipt and marker clear without rechecking ancestry', async () => {
    const artifact = await pending();
    await publish(artifact.outputCommit);
    const originalWrite = (manager as any).write.bind(manager);
    const write = vi.spyOn(manager as any, 'write').mockImplementation(async (...args: any[]) => {
      if (args[0] === 'lanes' && args[2].pendingTaskId === undefined) throw new Error('Fixture marker write interrupted');
      return originalWrite(...args);
    });
    expect(await reconcile()).toEqual([]);
    expect(await read(artifactPath())).toMatchObject({ disposition: 'applied', deliveredAtHead: artifact.outputCommit });
    expect((await read(lanePath())).pendingTaskId).toBe(workspace.taskId);
    write.mockRestore();
    await runGit(fixture.root, ['update-ref', 'refs/heads/main', fixture.head]);
    manager = new DelegatedWorkspaceManager(path.join(fixture.directory, 'workspaces'));
    const original = gitCommands.runGit;
    vi.spyOn(gitCommands, 'runGit').mockImplementation(async (cwd, args, ...rest) => {
      if (args.includes('merge-base')) throw new Error('Durable receipt must not be rechecked');
      return original(cwd, args, ...rest);
    });
    expect(await reconcile(true)).toMatchObject([{ disposition: 'applied', deliveredAtHead: artifact.outputCommit }]);
    expect((await read(lanePath())).pendingTaskId).toBeUndefined();
    await expect(fs.lstat(workspace.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
