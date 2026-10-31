import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DelegatedWorkspaceManager, WORKSPACE_INVENTORY_PAGE_LIMIT, type DelegatedWorkspace } from '../../src/delegation/DelegatedWorkspaceManager';
import { DelegatedWorkerSessionStore } from '../../src/delegation/DelegatedWorkerSessionStore';
import * as git from '../../src/delegation/GitCheckpoint';
import { gitFixture } from './gitFixture';

describe('versioned disposable workspace closeout', { timeout: 30_000 }, () => {
  let fixture: Awaited<ReturnType<typeof gitFixture>>;
  let manager: DelegatedWorkspaceManager;
  let workspace: DelegatedWorkspace;
  let lane: Awaited<ReturnType<DelegatedWorkerSessionStore['acquire']>>['lane'];
  const storage = () => path.join(fixture.directory, 'workspaces');
  const laneFile = () => path.join(storage(), 'lanes', `${lane.id}.json`);
  const artifactFile = () => path.join(storage(), 'artifacts', `${workspace.taskId}.json`);
  const read = async (file: string) => JSON.parse(await fs.readFile(file, 'utf8'));
  const collect = (success = true, exports?: string[]) => manager.collect(workspace, success, { exitConfirmed: true, exports });
  const owner = () => ({ threadId: lane.threadId, cwd: fixture.root, workspaceGeneration: 0 });
  const integrate = async (action: 'apply' | 'retain') => {
    const inspected = await manager.integrate(owner(), workspace.taskId, 'inspect', undefined) as { revision: string };
    return manager.integrate(owner(), workspace.taskId, action, inspected.revision);
  };
  const recreate = () => manager.baseline(workspace.source).then(input => manager.prepare(lane, workspace.source, input, randomUUID()));

  beforeEach(async () => {
    fixture = await gitFixture();
    manager = new DelegatedWorkspaceManager(storage(), true);
    const lanes = new DelegatedWorkerSessionStore(path.join(fixture.directory, 'native-lanes'));
    ({ lane } = await lanes.acquire({ threadId: 'fixture-thread', backend: 'agy', workingDirectory: fixture.root, workspaceGeneration: 0 }));
    const source = (await manager.discover(fixture.root))!;
    workspace = await manager.prepare(lane, source, await manager.baseline(source), randomUUID());
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(fixture.directory, { recursive: true, force: true }); });

  const legacyCheckout = async () => {
    delete workspace.disposalPolicy;
    delete workspace.checkoutIdentity;
    await fs.writeFile(laneFile(), JSON.stringify(workspace));
  };

  it('holds existing disposable receipts when opened on an unsupported platform', async () => {
    const extra = path.join(workspace.directory, 'node_modules', 'scratch.txt');
    await fs.mkdir(path.dirname(extra), { recursive: true });
    await fs.writeFile(extra, 'preserved across platform changes');
    await collect();
    const unsupported = new DelegatedWorkspaceManager(storage(), false);
    expect(await unsupported.reclaim(workspace.taskId)).toBe(false);
    expect(await fs.readFile(extra, 'utf8')).toBe('preserved across platform changes');
    expect((await read(laneFile())).cleanup.reason).toBe('disposal-platform-unsupported');
    expect(await manager.reclaim(workspace.taskId)).toBe(true);
  });

  it('keeps pre-upgrade ignored contents outside the disposable policy when reusing an existing checkout', async () => {
    await legacyCheckout();
    const cached = path.join(workspace.directory, 'node_modules', 'legacy-report.txt');
    await fs.mkdir(path.dirname(cached), { recursive: true });
    await fs.writeFile(cached, 'pre-upgrade output');
    workspace = await recreate();
    await collect();
    expect(await manager.reclaim(workspace.taskId)).toBe(false);
    expect(workspace.disposalPolicy).toBeUndefined();
    expect(await fs.readFile(cached, 'utf8')).toBe('pre-upgrade output');
    expect((await read(laneFile())).disposalPolicy).toBeUndefined();
  });

  it('does not rewrite or reclaim settled legacy records during automatic retry', async () => {
    await legacyCheckout();
    await collect();
    const before = await fs.readFile(laneFile());
    const artifact = await fs.readFile(artifactFile());
    expect(await manager.retryReclamation()).toMatchObject({ attempted: 0, reclaimed: 0, incomplete: false });
    expect(await fs.readFile(laneFile())).toEqual(before);
    expect(await fs.readFile(artifactFile())).toEqual(artifact);
    expect((await fs.stat(workspace.directory)).isDirectory()).toBe(true);
  });

  it('enables disposal only after a legacy checkout was strictly reclaimed and newly recreated', async () => {
    await legacyCheckout();
    workspace = await recreate();
    expect(workspace.disposalPolicy).toBeUndefined();
    await collect();
    expect(await manager.reclaim(workspace.taskId)).toBe(true);
    workspace = await recreate();
    expect(workspace.disposalPolicy).toBe(1);
  });

  it.each([true, false])('reclaims %s no-change output and all ordinary extras while preserving refs and native state', async success => {
    await fs.mkdir(path.join(workspace.directory, 'node_modules', 'fixture'), { recursive: true });
    await fs.writeFile(path.join(workspace.directory, 'node_modules', 'fixture', 'cache.bin'), 'disposable cache');
    await collect(success);
    // Extras added after capture are disposable, but captured source remains protected.
    await fs.writeFile(path.join(workspace.directory, 'scratch.txt'), 'discarded by policy');
    await fs.mkdir(path.join(workspace.directory, 'empty'));
    const refs = await git.gitText(fixture.root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remote-cli']);
    const nativeFile = path.join(fixture.directory, 'native-lanes', `${lane.id}.json`);
    const native = await fs.readFile(nativeFile);
    expect(await manager.reclaim(workspace.taskId)).toBe(true);
    await expect(fs.lstat(workspace.directory)).rejects.toHaveProperty('code', 'ENOENT');
    expect(await fs.readFile(nativeFile)).toEqual(native);
    expect(await git.gitText(fixture.root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remote-cli'])).toBe(refs);
    expect(await read(laneFile())).toMatchObject({ checkoutState: 'reclaimed', disposalPolicy: 1 });
    expect(await manager.reclaim(workspace.taskId)).toBe(false);
    const next = await recreate();
    expect(next.directory).toBe(workspace.directory);
    expect(await fs.readFile(path.join(next.directory, 'source.txt'), 'utf8')).toBe('first\nsecond\nthird\n');
  });

  it('retains failed changed output for recovery, removes checkout and recreates from a fresh baseline', async () => {
    await fs.writeFile(path.join(workspace.directory, 'source.txt'), 'failed worker change\n');
    const artifact = await collect(false);
    expect(artifact).toMatchObject({ successful: false, disposition: 'retained' });
    expect((await read(laneFile())).pendingTaskId).toBeUndefined();
    expect(await manager.reclaim(workspace.taskId)).toBe(true);
    expect(await git.gitText(fixture.root, ['show', `${artifact.outputCommit}:source.txt`])).toBe('failed worker change');
    expect(await fs.readFile(path.join(fixture.root, 'source.txt'), 'utf8')).toBe('first\nsecond\nthird\n');
    await fs.writeFile(path.join(fixture.root, 'source.txt'), 'new coordinator baseline\n');
    manager = new DelegatedWorkspaceManager(storage(), true);
    const next = await recreate();
    expect(next.directory).toBe(workspace.directory);
    expect(await fs.readFile(path.join(next.directory, 'source.txt'), 'utf8')).toBe('new coordinator baseline\n');
    expect(await manager.describe(workspace.taskId)).toMatchObject({ disposition: 'retained', successful: false });
  });

  it.each(['apply', 'retain'] as const)('holds success pending until explicit %s, then cleans without losing the artifact', async action => {
    await fs.writeFile(path.join(workspace.directory, 'source.txt'), 'reviewed output\n');
    const artifact = await collect();
    expect(artifact.disposition).toBe('pending');
    expect(await manager.reclaim(workspace.taskId)).toBe(false);
    expect((await manager.unavailableLanes()).has(lane.id)).toBe(true);
    expect(await integrate(action)).toMatchObject({ disposition: action === 'apply' ? 'applied' : 'retained' });
    await expect(fs.lstat(workspace.directory)).rejects.toHaveProperty('code', 'ENOENT');
    if (action === 'apply') expect(await manager.enumerateIntegrationScratch()).toMatchObject({ incomplete: false,
      items: [{ taskId: workspace.taskId, state: 'reclaimed' }] });
    expect(await integrate(action)).toMatchObject({ disposition: action === 'apply' ? 'applied' : 'retained' });
    expect(await git.gitText(fixture.root, ['show', `${artifact.outputCommit}:source.txt`])).toBe('reviewed output');
    expect((await recreate()).directory).toBe(workspace.directory);
  });

  it('refuses new-policy deletion without caller-confirmed exit and reports it durably', async () => {
    await manager.collect(workspace, true);
    expect(await manager.reclaim(workspace.taskId)).toBe(false);
    expect(await manager.getLaneCloseout(lane.id)).toMatchObject({ exitConfirmed: false, holdReason: 'child-exit-unconfirmed' });
    expect(await manager.retryReclamation()).toMatchObject({ attempted: 0 });
    await expect(recreate()).rejects.toThrow('unresolved artifacts');
    const refs = await git.gitText(fixture.root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remote-cli']);
    await collect();
    expect(await git.gitText(fixture.root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remote-cli'])).toBe(refs);
    expect(await manager.reclaim(workspace.taskId)).toBe(true);
  });

  it('preserves exported ignored output independently and rejects changed exports', async () => {
    await fs.mkdir(path.join(workspace.directory, 'node_modules'));
    const output = path.join('node_modules', 'report.txt');
    await fs.writeFile(path.join(workspace.directory, output), 'requested result\n');
    await collect(true, [output]);
    const exports = await manager.getArtifactExports(workspace.taskId);
    expect(exports).toHaveLength(1);
    await fs.writeFile(path.join(workspace.directory, output), 'unpublished edit\n');
    expect(await manager.reclaim(workspace.taskId)).toBe(false);
    expect(await manager.getLaneCloseout(lane.id)).toMatchObject({ holdReason: 'export-changed' });
    await fs.writeFile(path.join(workspace.directory, output), 'requested result\n');
    expect(await manager.reclaim(workspace.taskId)).toBe(true);
    expect(await fs.readFile(exports[0].file, 'utf8')).toBe('requested result\n');
    expect((await recreate()).directory).toBe(workspace.directory);
  });

  it('does not settle failed changes when a required export is missing', async () => {
    await fs.writeFile(path.join(workspace.directory, 'source.txt'), 'failure output\n');
    await expect(collect(false, ['missing.txt'])).rejects.toThrow();
    expect(await manager.describe(workspace.taskId)).toMatchObject({ disposition: 'pending', successful: false });
    expect(await manager.getLaneCloseout(lane.id)).toMatchObject({ recoverable: false, holdReason: 'capture-failed' });
    expect(await manager.reclaim(workspace.taskId)).toBe(false);
    await integrate('retain');
    await expect(manager.inspectCloseout(owner(), workspace.taskId)).rejects.toThrow('recovery-unverified');
    expect((await fs.lstat(workspace.directory)).isDirectory()).toBe(true);
  });

  it.each(['tracked-bytes', 'hidden-index', 'executable-mode'])('refuses %s changes after capture', async condition => {
    await collect();
    if (condition === 'hidden-index') await git.runGit(workspace.directory, ['update-index', '--assume-unchanged', 'source.txt']);
    if (condition === 'executable-mode' && process.platform !== 'win32') await fs.chmod(path.join(workspace.directory, 'source.txt'), 0o755);
    else await fs.writeFile(path.join(workspace.directory, 'source.txt'), 'changed after capture\n');
    expect(await manager.reclaim(workspace.taskId)).toBe(false);
    expect((await read(laneFile())).checkoutState).toBe('present');
  });

  it.each(['lfs', 'fixture-filter'])('records an actionable hold for malformed or unsupported %s materialization', async filter => {
    // Keep the saved blob deliberately non-pointer, independent of host LFS installation.
    if (filter === 'lfs') {
      for (const option of ['process', 'clean', 'smudge']) {
        await git.runGit(workspace.directory, ['config', `filter.lfs.${option}`, '']);
      }
      await git.runGit(workspace.directory, ['config', 'filter.lfs.required', 'false']);
    }
    await fs.writeFile(path.join(workspace.directory, '.gitattributes'), `source.txt filter=${filter}\n`);
    await expect(collect(false)).rejects.toThrow(filter === 'lfs' ? 'lfs-payload-unverified' : 'unsupported-filter');
    expect(await manager.describe(workspace.taskId)).toMatchObject({ successful: false, disposition: 'pending' });
    expect(await manager.getLaneCloseout(lane.id)).toMatchObject({ recoverable: false,
      holdReason: filter === 'lfs' ? 'lfs-payload-unverified' : 'unsupported-filter' });
  });

  it('refuses nested Git in ignored extras', async () => {
    await collect();
    await fs.mkdir(path.join(workspace.directory, 'node_modules', 'nested', '.git'), { recursive: true });
    expect(await manager.reclaim(workspace.taskId)).toBe(false);
    expect(await manager.getLaneCloseout(lane.id)).toMatchObject({ holdReason: 'nested-repository' });
  });

  it('retries owned removal failures within budget and honors lane exclusions', async () => {
    await collect();
    const original = git.runGit;
    const mock = vi.spyOn(git, 'runGit').mockImplementation(async (cwd, args, ...rest) => {
      if (args[0] === 'worktree' && args[1] === 'remove') throw new Error('Synthetic removal failure');
      return original(cwd, args, ...rest);
    });
    expect(await manager.reclaim(workspace.taskId)).toBe(false);
    expect(await manager.getLaneCloseout(lane.id)).toMatchObject({ checkoutState: 'reclaiming', holdReason: 'removal-failed' });
    mock.mockRestore();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 10_000);
    expect(await manager.retryReclamation({ excludedLaneIds: new Set([lane.id]) })).toMatchObject({ attempted: 0 });
    expect(await manager.retryReclamation({ limit: 1 })).toMatchObject({ attempted: 1, reclaimed: 1 });
  });

  it('settles a removed checkout whose final receipt write was interrupted', async () => {
    await collect(false);
    const artifact = await read(artifactFile());
    const record = await read(laneFile());
    await fs.writeFile(laneFile(), JSON.stringify({ ...record, checkoutState: 'reclaiming',
      reclamation: { taskId: artifact.taskId, output: artifact.output, tree: artifact.tree } }));
    await git.runGit(fixture.root, ['worktree', 'remove', workspace.directory]);
    manager = new DelegatedWorkspaceManager(storage(), true);
    expect(await manager.retryReclamation()).toMatchObject({ attempted: 1, reclaimed: 1 });
    expect((await recreate()).directory).toBe(workspace.directory);
  });

  it('stops automatic retries after three failures but permits an explicit verified retry', async () => {
    await collect();
    const original = git.runGit;
    const mock = vi.spyOn(git, 'runGit').mockImplementation(async (cwd, args, ...rest) => {
      if (args[0] === 'worktree' && args[1] === 'remove') throw new Error('Synthetic locked file');
      return original(cwd, args, ...rest);
    });
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await manager.retryReclamation()).toMatchObject({ attempted: 1, held: 1 });
      now += 60_000;
    }
    expect(await manager.retryReclamation()).toMatchObject({ attempted: 0 });
    expect(await manager.getLaneCloseout(lane.id)).toMatchObject({ cleanup: { attempts: 3, reason: 'removal-failed' } });
    mock.mockRestore();
    expect(await manager.reclaim(workspace.taskId)).toBe(true);
  });

  it.each(['exit-receipt', 'exports', 'identity', 'parent-recovery'])('retains a checkout after %s evidence changes', async condition => {
    await collect();
    if (condition === 'identity') {
      const record = await read(laneFile());
      await fs.writeFile(laneFile(), JSON.stringify({ ...record, checkoutIdentity: { ...record.checkoutIdentity, ino: -1 } }));
    } else {
      const artifact = await read(artifactFile());
      if (condition === 'exit-receipt') artifact.closeout.taskId = randomUUID();
      if (condition === 'exports') artifact.exports = [{ path: 'lost.txt', sha256: 'a'.repeat(64), bytes: 1 }];
      if (condition === 'parent-recovery') artifact.recovery = { beforeRef: 'refs/fixture/before', targetRef: 'refs/fixture/target' };
      await fs.writeFile(artifactFile(), JSON.stringify(artifact));
    }
    expect(await manager.reclaim(workspace.taskId)).toBe(false);
    expect((await fs.lstat(workspace.directory)).isDirectory()).toBe(true);
  });

  it('enumerates pending and capture failures without diagnostics or initializing missing storage', async () => {
    await fs.writeFile(path.join(workspace.directory, 'source.txt'), 'pending output\n');
    await collect();
    const second = new DelegatedWorkspaceManager(storage(), true);
    expect(await second.enumerateArtifacts({ threadId: lane.threadId, limit: 1 })).toMatchObject({ total: 1, incomplete: false,
      items: [{ taskId: workspace.taskId, disposition: 'pending', exitConfirmed: true, recoverable: true }] });
    expect(await second.enumerateArtifacts({ offset: 1 })).toMatchObject({ total: 1, items: [] });
    const file = path.join(storage(), 'artifacts', `${randomUUID()}.json`);
    await fs.writeFile(file, '{broken');
    expect((await second.enumerateArtifacts()).incomplete).toBe(true);
    expect(await second.retryReclamation()).toMatchObject({ attempted: 0, incomplete: true });
    const missing = path.join(fixture.directory, 'never-created');
    const mkdir = vi.spyOn(fs, 'mkdir');
    expect(await new DelegatedWorkspaceManager(missing).enumerateArtifacts()).toEqual({ items: [], total: 0, incomplete: false });
    expect(mkdir).not.toHaveBeenCalled();
    await expect(fs.stat(missing)).rejects.toHaveProperty('code', 'ENOENT');
  });

  it.each(['pending', 'missing', 'recovery'] as const)('keeps the current %s task discoverable when unrelated history exhausts the byte budget', async state => {
    await fs.writeFile(path.join(workspace.directory, 'source.txt'), 'known current output\n');
    await collect();
    const artifact = await read(artifactFile());
    // Each record is below the per-record limit; together they exceed 32 MiB.
    for (let index = 0; index < 280; index++) {
      const taskId = `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`;
      await fs.writeFile(path.join(storage(), 'artifacts', `${taskId}.json`), JSON.stringify({ ...artifact,
        taskId, threadId: 'unrelated-thread', syntheticPadding: 'x'.repeat(120 * 1024) }));
    }
    if (state === 'missing') await fs.unlink(artifactFile());
    if (state === 'recovery') await fs.writeFile(artifactFile(), JSON.stringify({ ...artifact,
      disposition: 'applied', recovery: { beforeRef: 'refs/synthetic/before', targetRef: 'refs/synthetic/target' } }));
    const second = new DelegatedWorkspaceManager(storage(), true);
    const inventory = await second.enumerateArtifacts({ threadId: lane.threadId, unresolvedOnly: true });
    expect(inventory).toMatchObject({ total: 1, incomplete: true, items: [{ taskId: workspace.taskId }] });
    expect(inventory.items[0].disposition).toBe(state === 'missing' ? undefined : state === 'recovery' ? 'applied' : 'pending');
    expect(await second.retryReclamation()).toMatchObject({ attempted: 0, incomplete: true });
    expect((await fs.stat(workspace.directory)).isDirectory()).toBe(true);
  });

  it('reads exact current ownership even when the global entry limit truncates artifact enumeration', async () => {
    await fs.writeFile(path.join(workspace.directory, 'source.txt'), 'known current output\n');
    await collect();
    const opendir = fs.opendir.bind(fs);
    let visited = 0;
    vi.spyOn(fs, 'opendir').mockImplementation((async (directory: string, ...args: any[]) => {
      if (directory !== path.join(storage(), 'artifacts')) return (opendir as any)(directory, ...args);
      return { async *[Symbol.asyncIterator]() {
        for (let index = 0; index < 10_002; index++) {
          visited++;
          yield { name: `synthetic-${index}.tmp` };
        }
      } };
    }) as typeof fs.opendir);
    const inventory = await manager.enumerateArtifacts({ threadId: lane.threadId, unresolvedOnly: true });
    expect(visited).toBe(10_001);
    expect(inventory).toMatchObject({ incomplete: true, total: 1, items: [{ taskId: workspace.taskId, disposition: 'pending' }] });
  });

  it('returns all known obligations when bounded lane tasks and artifact history do not overlap', async () => {
    await fs.writeFile(path.join(workspace.directory, 'source.txt'), 'pending fixture output\n');
    await collect();
    const artifact = await read(artifactFile());
    const id = (index: number) => `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`;
    // Synthetic metadata reader isolates the merged-page bound without creating
    // thousands of unrelated real worktrees or bypassing production page logic.
    const reader = manager as unknown as {
      snapshotNames(kind: string): Promise<{ names: string[]; incomplete: boolean }>;
      readSnapshot(kind: string, name: string): Promise<unknown>;
    };
    vi.spyOn(reader, 'snapshotNames').mockImplementation(async () => ({
      names: Array.from({ length: 10_000 }, (_, index) => id(index)), incomplete: false,
    }));
    vi.spyOn(reader, 'readSnapshot').mockImplementation(async (kind, name) => kind === 'lanes'
      ? { ...workspace, laneId: name, taskId: id(Number(name.slice(-12)) + 10_000) }
      : { ...artifact, taskId: name, laneId: id(Number(name.slice(-12)) % 10_000) });
    const inventory = await manager.enumerateArtifacts({ threadId: lane.threadId,
      unresolvedOnly: true, limit: WORKSPACE_INVENTORY_PAGE_LIMIT });
    expect(inventory.incomplete).toBe(false);
    expect(inventory.total).toBe(20_000);
    expect(inventory.items).toHaveLength(inventory.total);
    expect(new Set(inventory.items.map(item => item.taskId)).size).toBe(20_000);
  });
});
