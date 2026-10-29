import { createHash, randomUUID } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LegacyWorkspaceCleanup, hasLegacyDiscardTombstone, completedLegacyDiscard, type CleanupOwnership } from '../../src/delegation/LegacyWorkspaceCleanup';
import { gitText, runGit } from '../../src/delegation/GitCheckpoint';
import { gitFixture } from './gitFixture';

const flags = { discardContents: true, confirmWorkersStopped: true };
const exists = async (file: string) => fs.lstat(file).then(() => true, error => {
  if (error.code === 'ENOENT') return false; throw error;
});

describe('explicit offline legacy worktree discard', { timeout: 30_000 }, () => {
  let fixture: Awaited<ReturnType<typeof gitFixture>>;
  let root: string;
  let workerRoot: string;
  let workspaceRoot: string;
  let manifest: string;
  let cleanup: LegacyWorkspaceCleanup;
  let owner: CleanupOwnership;
  let offline = vi.fn(async () => undefined);
  let ownership = vi.fn(async (_root: string) => owner);
  let lane: { id: string; taskId: string; directory: string; record: string; worker: string; artifact: string };

  const createLane = async () => {
    const id = randomUUID(); const taskId = randomUUID();
    const directory = path.join(workspaceRoot, 'trees', createHash('sha256').update(fixture.root).digest('hex'), id);
    await fs.mkdir(path.dirname(directory), { recursive: true });
    await runGit(fixture.root, ['worktree', 'add', '--detach', directory, fixture.head]);
    await runGit(fixture.root, ['update-ref', `refs/remote-cli/artifacts/${taskId}`, fixture.head]);
    const record = path.join(workspaceRoot, 'lanes', `${id}.json`);
    const worker = path.join(workerRoot, `${id}.json`);
    const artifact = path.join(workspaceRoot, 'artifacts', `${taskId}.json`);
    await fs.writeFile(record, JSON.stringify({ laneId: id, threadId: 'synthetic-thread', workspaceGeneration: 3,
      source: { root: fixture.root, cwd: fixture.root, relativeCwd: '', commonDirectory: path.join(fixture.root, '.git') },
      directory, cwd: directory, taskId, taskRef: `refs/remote-cli/tasks/${taskId}`, pendingTaskId: taskId, blocked: true }));
    await fs.writeFile(worker, JSON.stringify({ id, executorThreadId: `delegate-lane-${id}`, threadId: 'synthetic-thread',
      workingDirectory: fixture.root, workspaceGeneration: 3, state: 'dirty', backend: 'codex' }));
    await fs.writeFile(artifact, JSON.stringify({ taskId, threadId: 'synthetic-thread', workspaceGeneration: 3, disposition: 'pending' }));
    return { id, taskId, directory, record, worker, artifact };
  };

  const createScratch = async (conflict = false) => {
    const id = randomUUID();
    const directory = path.join(workspaceRoot, `integration-${id}`);
    const source = JSON.parse(await fs.readFile(lane.record, 'utf8')).source;
    let commit = fixture.head;
    if (conflict) {
      await fs.writeFile(path.join(lane.directory, 'source.txt'), 'synthetic worker change\n');
      await runGit(lane.directory, ['add', 'source.txt']);
      await runGit(lane.directory, ['commit', '-m', 'Synthetic worker change']);
      const workerHead = await gitText(lane.directory, ['rev-parse', 'HEAD']);
      await fs.writeFile(path.join(fixture.root, 'source.txt'), 'synthetic parent change\n');
      await runGit(fixture.root, ['add', 'source.txt']);
      await runGit(fixture.root, ['commit', '-m', 'Synthetic parent change']);
      commit = await gitText(fixture.root, ['rev-parse', 'HEAD']);
      await runGit(fixture.root, ['worktree', 'add', '--detach', directory, commit]);
      await expect(runGit(directory, ['merge', '--no-commit', '--no-ff', workerHead])).rejects.toThrow();
      expect(await gitText(directory, ['diff', '--name-only', '--diff-filter=U'])).toBe('source.txt');
    } else await runGit(fixture.root, ['worktree', 'add', '--detach', directory, commit]);
    await fs.mkdir(path.join(workspaceRoot, 'scratch'), { recursive: true });
    const receipt = path.join(workspaceRoot, 'scratch', `${id}.json`);
    await fs.writeFile(receipt, JSON.stringify({ id, taskId: lane.taskId, laneId: lane.id, directory, source,
      state: conflict ? 'conflict' : 'present', updatedAt: 1, ...(conflict ? { holdReason: 'integration-conflict' } : {}) }));
    await fs.writeFile(lane.artifact, JSON.stringify({ ...JSON.parse(await fs.readFile(lane.artifact, 'utf8')), laneId: lane.id, source }));
    return { id, directory, receipt };
  };

  beforeEach(async () => {
    fixture = await gitFixture();
    root = path.join(fixture.directory, 'home', '.remote-cli');
    workerRoot = path.join(root, 'delegation-workers'); workspaceRoot = path.join(root, 'delegation-workspaces');
    for (const directory of [workerRoot, path.join(workspaceRoot, 'lanes'), path.join(workspaceRoot, 'artifacts')]) await fs.mkdir(directory, { recursive: true });
    manifest = path.join(fixture.directory, 'discard-plan.json');
    owner = { acquire: vi.fn(async () => undefined), release: vi.fn(async () => undefined),
      withRepository: vi.fn(async (_common, callback) => callback()) };
    offline = vi.fn(async () => undefined); ownership = vi.fn(async (_root: string) => owner);
    cleanup = new LegacyWorkspaceCleanup(root, { ownership, mountPoints: async () => [], assertOffline: offline });
    lane = await createLane();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(fixture.directory, { recursive: true, force: true });
  });

  it('scans without writes or ownership acquisition and surfaces historical artifact generations', async () => {
    const writes = vi.spyOn(fs, 'writeFile'); const mkdir = vi.spyOn(fs, 'mkdir'); const rename = vi.spyOn(fs, 'rename');
    const result = await cleanup.scan();
    expect(result.incomplete).toBe(false); expect(result.items).toHaveLength(1);
    expect(result.artifacts).toEqual([{ taskId: lane.taskId, threadId: 'synthetic-thread', workspaceGeneration: 3, disposition: 'pending' }]);
    expect(writes).not.toHaveBeenCalled(); expect(mkdir).not.toHaveBeenCalled(); expect(rename).not.toHaveBeenCalled();
    expect(ownership).not.toHaveBeenCalled(); expect(offline).not.toHaveBeenCalled();
    const absent = path.join(fixture.directory, 'absent');
    expect((await new LegacyWorkspaceCleanup(absent).scan()).items).toEqual([]);
    expect(await exists(absent)).toBe(false);
  });

  it('discards planned tracked, untracked and ignored contents while preserving parent, artifacts, refs and native state', async () => {
    await fs.writeFile(path.join(lane.directory, 'source.txt'), 'unsubmitted change');
    await fs.writeFile(path.join(lane.directory, 'untracked.txt'), 'discard explicitly');
    await fs.mkdir(path.join(lane.directory, 'node_modules'));
    await fs.writeFile(path.join(lane.directory, 'node_modules', 'ignored.bin'), 'ignored bytes');
    const nativeDirectory = path.join(root, 'codex-sessions'); await fs.mkdir(nativeDirectory);
    const native = path.join(nativeDirectory, `delegate-lane-${lane.id}.json`); await fs.writeFile(native, '{"id":"synthetic-native"}');
    const preserved = await Promise.all([lane.record, lane.worker, lane.artifact, native, path.join(fixture.root, 'source.txt')].map(file => fs.readFile(file)));
    const refs = await gitText(fixture.root, ['show-ref']);
    await cleanup.plan(manifest);
    expect(await cleanup.discard(manifest, flags)).toEqual({ removed: 1, errors: [] });
    expect(await exists(lane.directory)).toBe(false);
    expect(await gitText(fixture.root, ['show-ref'])).toBe(refs);
    expect(await Promise.all([lane.record, lane.worker, lane.artifact, native, path.join(fixture.root, 'source.txt')].map(file => fs.readFile(file)))).toEqual(preserved);
    expect(await hasLegacyDiscardTombstone(workerRoot, lane.id)).toBe(true);
    const marker = JSON.parse(await fs.readFile(path.join(workerRoot, 'legacy-discarded', `${lane.id}.json`), 'utf8'));
    expect(marker.state).toBe('removed');
    expect(ownership).toHaveBeenCalledWith(workerRoot);
    expect(owner.withRepository).toHaveBeenCalledWith(path.join(fixture.root, '.git'), expect.any(Function));
    expect(owner.release).toHaveBeenCalledTimes(1);
    expect(await cleanup.discard(manifest, flags)).toEqual({ removed: 1, errors: [] });
  });

  it.each(['record', 'worker', 'artifact', 'contents'])('rejects changed %s after planning', async kind => {
    await cleanup.plan(manifest);
    const file = kind === 'contents' ? path.join(lane.directory, 'source.txt') : lane[kind as 'record' | 'worker' | 'artifact'];
    if (kind === 'contents') await fs.appendFile(file, 'changed');
    else await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), revision: 'changed' }));
    const result = await cleanup.discard(manifest, flags);
    expect(result.removed).toBe(0); expect(result.errors[0]).toContain('changed');
    expect(await exists(lane.directory)).toBe(true);
  });

  it('requires both explicit flags and rejects live or uncertain ownership', async () => {
    await cleanup.plan(manifest);
    for (const flag of [false, true]) await expect(cleanup.discard(manifest, { discardContents: flag, confirmWorkersStopped: !flag })).rejects.toThrow('Require');
    expect(ownership).not.toHaveBeenCalled();
    vi.mocked(owner.acquire).mockRejectedValue(new Error('Owner lock exists; manual quiescent recovery required'));
    await expect(cleanup.discard(manifest, flags)).rejects.toThrow('Owner lock');
    expect(owner.release).not.toHaveBeenCalled();
    expect(await exists(lane.directory)).toBe(true);
  });

  it('retries a partial batch only after exact revalidation, without replaying completed removals', async () => {
    const second = await createLane(); let fail = true;
    const remove = vi.fn(async (source: string, directory: string) => {
      if (directory === second.directory && fail) { fail = false; throw new Error('Synthetic pre-mutation Git failure'); }
      await runGit(source, ['worktree', 'remove', '--force', directory]);
    });
    cleanup = new LegacyWorkspaceCleanup(root, { ownership, mountPoints: async () => [], assertOffline: offline, remove });
    await cleanup.plan(manifest);
    expect((await cleanup.discard(manifest, flags)).removed).toBe(1);
    expect(await cleanup.discard(manifest, flags)).toEqual({ removed: 2, errors: [] });
    expect(remove.mock.calls.filter(([, directory]) => directory === lane.directory)).toHaveLength(1);
    expect(remove.mock.calls.filter(([, directory]) => directory === second.directory)).toHaveLength(2);
  });

  it('reconciles an error after actual removal without another destructive command', async () => {
    const remove = vi.fn(async (source: string, directory: string) => {
      await runGit(source, ['worktree', 'remove', '--force', directory]); throw new Error('Synthetic lost acknowledgement');
    });
    cleanup = new LegacyWorkspaceCleanup(root, { ownership, mountPoints: async () => [], assertOffline: offline, remove });
    await cleanup.plan(manifest);
    expect((await cleanup.discard(manifest, flags)).errors).toHaveLength(1);
    expect(await cleanup.discard(manifest, flags)).toEqual({ removed: 1, errors: [] });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('replays an interrupted older unbound plan without treating it as task retirement', async () => {
    const remove = vi.fn(async (source: string, directory: string) => {
      await runGit(source, ['worktree', 'remove', '--force', directory]); throw new Error('Synthetic lost acknowledgement');
    });
    cleanup = new LegacyWorkspaceCleanup(root, { ownership, mountPoints: async () => [], assertOffline: offline, remove });
    await cleanup.plan(manifest);
    const plan = JSON.parse(await fs.readFile(manifest, 'utf8'));
    delete plan.items[0].taskId; delete plan.items[0].workspaceFingerprint;
    await fs.writeFile(manifest, JSON.stringify(plan));
    expect((await cleanup.discard(manifest, flags)).errors).toHaveLength(1);
    // Older intent records did not carry the source and registration fields.
    const file = path.join(workerRoot, 'legacy-discarded', `${lane.id}.json`);
    const marker = JSON.parse(await fs.readFile(file, 'utf8'));
    delete marker.sourceRoot; delete marker.commonDirectory; delete marker.registration;
    await fs.writeFile(file, JSON.stringify(marker));
    expect(await cleanup.discard(manifest, flags)).toEqual({ removed: 1, errors: [] });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(await completedLegacyDiscard(workspaceRoot, lane.id, lane.taskId)).toBeUndefined();
  });

  it('requires exact original receipt bytes and absent checkout and registration for retirement evidence', async () => {
    await fs.unlink(lane.artifact);
    await cleanup.plan(manifest);
    expect(await cleanup.discard(manifest, flags)).toEqual({ removed: 1, errors: [] });
    const file = path.join(workerRoot, 'legacy-discarded', `${lane.id}.json`);
    const bytes = await fs.readFile(file, 'utf8');
    const marker = JSON.parse(bytes);
    const verified = () => completedLegacyDiscard(workspaceRoot, lane.id, lane.taskId);
    expect(await verified()).toEqual({ fingerprint: marker.fingerprint, planHash: marker.planHash });
    expect((await cleanup.scan()).discardedCheckouts).toEqual([{ taskId: lane.taskId, laneId: lane.id,
      directory: lane.directory, fingerprint: marker.fingerprint, planHash: marker.planHash }]);
    const receipt = await fs.readFile(lane.record);
    await fs.appendFile(lane.record, '\n');
    expect(await verified()).toBeUndefined();
    await fs.writeFile(lane.record, receipt);
    for (const directory of [lane.directory, marker.registration]) {
      await fs.mkdir(directory, { recursive: true });
      expect(await verified()).toBeUndefined();
      await fs.rmdir(directory);
    }
    await fs.writeFile(file, '{malformed');
    expect(await verified()).toBeUndefined();
    await fs.writeFile(file, bytes);
    expect(await verified()).toBeDefined();
    expect(await completedLegacyDiscard(workspaceRoot, 'invalid', lane.taskId)).toBeUndefined();
  });

  it('refuses retry after a failed removal changed checkout bytes', async () => {
    const remove = vi.fn(async () => { await fs.writeFile(path.join(lane.directory, 'source.txt'), 'partial mutation'); throw new Error('Synthetic partial removal'); });
    cleanup = new LegacyWorkspaceCleanup(root, { ownership, mountPoints: async () => [], assertOffline: offline, remove });
    await cleanup.plan(manifest); await cleanup.discard(manifest, flags);
    expect((await cleanup.discard(manifest, flags)).errors[0]).toContain('changed');
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('excludes mounts before traversal and never treats unavailable mount information as safe', async () => {
    cleanup = new LegacyWorkspaceCleanup(root, { mountPoints: async () => [path.join(lane.directory, 'mounted')] });
    expect((await cleanup.scan()).items).toEqual([]);
    cleanup = new LegacyWorkspaceCleanup(root, { mountPoints: async () => { throw new Error('Mount verification unavailable'); } });
    expect((await cleanup.scan()).incomplete).toBe(true);
    await expect(cleanup.plan(manifest)).rejects.toThrow('Incomplete');
  });

  it('rejects unknown directories, nested repositories and orphan receipts', async () => {
    await fs.mkdir(path.join(lane.directory, 'nested-repository'));
    await fs.mkdir(path.join(lane.directory, 'nested-repository', '.git'));
    expect((await cleanup.scan()).excluded[0].reason).toContain('Nested Git');
    await fs.rm(path.join(lane.directory, 'nested-repository'), { recursive: true });
    await fs.unlink(lane.record);
    expect((await cleanup.scan()).items).toEqual([]);
    await fs.mkdir(path.join(path.dirname(lane.directory), 'unknown'));
    expect((await cleanup.scan()).excluded.some(item => item.reason.includes('Unknown lane'))).toBe(true);
  });

  it('leaves excluded orphans untouched while discarding only independently verified targets', async () => {
    const orphan = await createLane(); await fs.unlink(orphan.record);
    const scan = await cleanup.plan(manifest);
    expect(scan.incomplete).toBe(false); expect(scan.items.map(item => item.laneId)).toEqual([lane.id]);
    expect(scan.excluded).toHaveLength(1);
    expect(await cleanup.discard(manifest, flags)).toEqual({ removed: 1, errors: [] });
    expect(await exists(orphan.directory)).toBe(true);
  });

  it('fingerprints content links without walking them and preserves their outside target on discard', async ({ skip }) => {
    const target = path.join(fixture.directory, 'outside'); await fs.writeFile(target, 'must survive');
    try { await fs.symlink(target, path.join(lane.directory, 'link')); }
    catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code!)) { skip(); return; } throw error; }
    expect((await cleanup.scan()).items).toHaveLength(1);
    await cleanup.plan(manifest);
    expect(await cleanup.discard(manifest, flags)).toEqual({ removed: 1, errors: [] });
    expect(await fs.readFile(target, 'utf8')).toBe('must survive');
  });

  it('excludes symbolic-link Git registrations', async ({ skip }) => {
    const gitfile = path.join(lane.directory, '.git'); const saved = path.join(fixture.directory, 'git-registration');
    await fs.rename(gitfile, saved);
    try { await fs.symlink(saved, gitfile); }
    catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code!)) { skip(); return; } throw error; }
    expect((await cleanup.scan()).items).toEqual([]);
    expect(await fs.readFile(saved, 'utf8')).toContain('gitdir:');
  });

  it('rejects bounded incomplete scans and unsafe or overwritten manifest destinations', async () => {
    for (const limits of [{ entries: 1, bytes: 100000, seconds: 120 }, { entries: 10000, bytes: 1, seconds: 120 }]) {
      expect((await cleanup.scan(limits)).incomplete).toBe(true);
      await expect(cleanup.plan(manifest, limits)).rejects.toThrow('Incomplete');
    }
    await expect(cleanup.plan(path.join(lane.directory, 'plan.json'))).rejects.toThrow('outside');
    await cleanup.plan(manifest);
    await expect(cleanup.plan(manifest)).rejects.toThrow('EEXIST');
    await expect(cleanup.scan({ entries: 0, bytes: 1, seconds: 1 })).rejects.toThrow('Invalid inventory');
  });

  it('rejects a foreign target and altered progress without destructive calls', async () => {
    await cleanup.plan(manifest);
    const original = await fs.readFile(manifest, 'utf8'); const plan = JSON.parse(original);
    plan.items[0].directory = fixture.root; await fs.writeFile(manifest, JSON.stringify(plan));
    expect((await cleanup.discard(manifest, flags)).errors[0]).toContain('Foreign');
    await fs.writeFile(manifest, original);
    await fs.writeFile(`${manifest}.progress.json`, JSON.stringify({ version: 1, planHash: 'changed', items: {} }));
    await expect(cleanup.discard(manifest, flags)).rejects.toThrow('progress');
  });

  it('uses configured daemon state only as a veto, with no configuration initialization', async () => {
    cleanup = new LegacyWorkspaceCleanup(root, { ownership, mountPoints: async () => [] });
    await cleanup.plan(manifest);
    const config = path.join(root, 'config.json');
    await fs.writeFile(config, JSON.stringify({ service: { running: true } }));
    await expect(cleanup.discard(manifest, flags)).rejects.toThrow('running');
    await fs.writeFile(config, JSON.stringify({ service: { running: false, pid: 12345 } }));
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    await expect(cleanup.discard(manifest, flags)).rejects.toThrow('PID still exists');
    expect(kill).toHaveBeenCalledWith(12345, 0);
    kill.mockImplementation(() => { throw Object.assign(new Error('synthetic missing PID'), { code: 'ESRCH' }); });
    expect(await cleanup.discard(manifest, flags)).toEqual({ removed: 1, errors: [] });
    expect(await fs.readFile(config, 'utf8')).toContain('12345');
  });

  it('handles tombstone absence and invalid lane names conservatively', async () => {
    expect(await hasLegacyDiscardTombstone(workerRoot, lane.id)).toBe(false);
    await expect(hasLegacyDiscardTombstone(workerRoot, '..')).rejects.toThrow('Invalid');
  });

  it('inventories and explicitly discards registered conflict scratch without invalidating its lane or native session', async () => {
    const scratch = await createScratch(true);
    await fs.mkdir(path.join(scratch.directory, 'node_modules'));
    await fs.writeFile(path.join(scratch.directory, 'node_modules', 'ignored.bin'), 'synthetic ignored bytes');
    await fs.writeFile(path.join(scratch.directory, 'uncaptured.txt'), 'explicitly discarded scratch edits');
    await runGit(fixture.root, ['worktree', 'lock', lane.directory]);
    // The scratch belongs to a historical task; the lane can already be reused.
    const currentTask = randomUUID();
    await fs.writeFile(lane.record, JSON.stringify({ ...JSON.parse(await fs.readFile(lane.record, 'utf8')),
      taskId: currentTask, taskRef: `refs/remote-cli/tasks/${currentTask}` }));
    const native = path.join(root, 'codex-sessions', `delegate-lane-${lane.id}.json`);
    await fs.mkdir(path.dirname(native)); await fs.writeFile(native, '{"id":"synthetic-native"}');
    const preservedFiles = [scratch.receipt, lane.record, lane.worker, lane.artifact, native, path.join(fixture.root, 'source.txt')];
    const preserved = await Promise.all(preservedFiles.map(file => fs.readFile(file)));
    const refs = await gitText(fixture.root, ['show-ref']);
    const writes = vi.spyOn(fs, 'writeFile'); const mkdir = vi.spyOn(fs, 'mkdir');
    const scan = await cleanup.scan();
    expect(scan.incomplete).toBe(false);
    expect(scan.items).toHaveLength(1);
    expect(scan.items[0]).toMatchObject({ kind: 'scratch', scratchId: scratch.id, laneId: lane.id, directory: scratch.directory });
    expect(writes).not.toHaveBeenCalled(); expect(mkdir).not.toHaveBeenCalled();
    writes.mockRestore(); mkdir.mockRestore();
    await cleanup.plan(manifest);
    expect(await cleanup.discard(manifest, flags)).toEqual({ removed: 1, errors: [] });
    expect(await exists(scratch.directory)).toBe(false);
    expect(await exists(lane.directory)).toBe(true);
    expect(await hasLegacyDiscardTombstone(workerRoot, lane.id)).toBe(false);
    const marker = JSON.parse(await fs.readFile(path.join(workerRoot, 'legacy-discarded-scratch', `${scratch.id}.json`), 'utf8'));
    expect(marker).toMatchObject({ kind: 'scratch', scratchId: scratch.id, laneId: lane.id, state: 'removed' });
    expect(await Promise.all(preservedFiles.map(file => fs.readFile(file)))).toEqual(preserved);
    expect(await gitText(fixture.root, ['show-ref'])).toBe(refs);
    expect(await cleanup.discard(manifest, flags)).toEqual({ removed: 1, errors: [] });
  });

  it('lists unknown, orphaned, mismatched, and unregistered scratch instead of deleting by name', async () => {
    const valid = await createScratch();
    await runGit(fixture.root, ['worktree', 'lock', lane.directory]);
    const unknown = path.join(workspaceRoot, 'integration-unknown');
    const noReceipt = path.join(workspaceRoot, `integration-${randomUUID()}`);
    await fs.mkdir(unknown); await fs.mkdir(noReceipt);
    const mismatched = await createScratch();
    const record = JSON.parse(await fs.readFile(mismatched.receipt, 'utf8'));
    await fs.writeFile(mismatched.receipt, JSON.stringify({ ...record, laneId: randomUUID() }));
    const unregistered = await createScratch();
    await runGit(fixture.root, ['worktree', 'remove', unregistered.directory]);
    await fs.mkdir(unregistered.directory); await fs.writeFile(path.join(unregistered.directory, 'keep.txt'), 'synthetic unregistered contents');
    const absentId = randomUUID();
    const absentReceipt = path.join(workspaceRoot, 'scratch', `${absentId}.json`);
    await fs.writeFile(absentReceipt, JSON.stringify({ ...record, id: absentId, directory: path.join(workspaceRoot, `integration-${absentId}`) }));
    const unknownReceipt = path.join(workspaceRoot, 'scratch', 'unknown.json');
    await fs.writeFile(unknownReceipt, '{}');
    const inventory = await cleanup.plan(manifest);
    expect(inventory.incomplete).toBe(false);
    expect(inventory.items.map(item => item.directory)).toEqual([valid.directory]);
    for (const directory of [unknown, noReceipt, mismatched.directory, unregistered.directory, absentReceipt, unknownReceipt]) {
      expect(inventory.excluded.find(item => item.directory === directory)?.reason).toBeTruthy();
    }
    expect(inventory.excluded.find(item => item.directory === absentReceipt)?.reason).toContain('absent');
    expect(await cleanup.discard(manifest, flags)).toEqual({ removed: 1, errors: [] });
    for (const directory of [unknown, noReceipt, mismatched.directory, unregistered.directory, absentReceipt, unknownReceipt]) {
      expect(await exists(directory)).toBe(true);
    }
  });

  it.each(['receipt', 'index', 'contents'])('refuses scratch %s changes after its frozen plan', async kind => {
    const scratch = await createScratch(true);
    await runGit(fixture.root, ['worktree', 'lock', lane.directory]);
    await cleanup.plan(manifest);
    if (kind === 'receipt') await fs.appendFile(scratch.receipt, ' ');
    else if (kind === 'index') await runGit(scratch.directory, ['read-tree', 'HEAD']);
    else await fs.appendFile(path.join(scratch.directory, 'source.txt'), 'synthetic later edit');
    const result = await cleanup.discard(manifest, flags);
    expect(result.removed).toBe(0); expect(result.errors[0]).toContain('changed');
    expect(await exists(scratch.directory)).toBe(true);
    expect(await hasLegacyDiscardTombstone(workerRoot, lane.id)).toBe(false);
  });

  it.each(['locked', 'reclaimed receipt', 'mounted descendant'])('retains scratch with a %s safety conflict', async conflict => {
    const scratch = await createScratch();
    await runGit(fixture.root, ['worktree', 'lock', lane.directory]);
    if (conflict === 'locked') await runGit(fixture.root, ['worktree', 'lock', scratch.directory]);
    else if (conflict === 'reclaimed receipt') {
      await fs.writeFile(scratch.receipt, JSON.stringify({ ...JSON.parse(await fs.readFile(scratch.receipt, 'utf8')), state: 'reclaimed' }));
    } else cleanup = new LegacyWorkspaceCleanup(root, { ownership, assertOffline: offline,
      mountPoints: async () => [path.join(scratch.directory, 'synthetic-mount')] });
    const scan = await cleanup.scan();
    expect(scan.items).toEqual([]);
    expect(scan.excluded.length).toBeGreaterThan(0);
    expect(await exists(scratch.directory)).toBe(true);
    expect(await hasLegacyDiscardTombstone(workerRoot, lane.id)).toBe(false);
  });

  it('replays interrupted scratch removal using its own intent without replaying Git removal', async () => {
    const scratch = await createScratch(true);
    await runGit(fixture.root, ['worktree', 'lock', lane.directory]);
    const remove = vi.fn(async (source: string, directory: string) => {
      await runGit(source, ['worktree', 'remove', '--force', directory]);
      throw new Error('Synthetic scratch acknowledgement loss');
    });
    cleanup = new LegacyWorkspaceCleanup(root, { ownership, mountPoints: async () => [], assertOffline: offline, remove });
    await cleanup.plan(manifest);
    expect((await cleanup.discard(manifest, flags)).errors).toHaveLength(1);
    const progress = JSON.parse(await fs.readFile(`${manifest}.progress.json`, 'utf8'));
    expect(progress.items).toEqual({ [`scratch:${scratch.id}`]: 'removing' });
    expect(await cleanup.discard(manifest, flags)).toEqual({ removed: 1, errors: [] });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(await hasLegacyDiscardTombstone(workerRoot, lane.id)).toBe(false);
    expect(await exists(scratch.receipt)).toBe(true);
  });

  it('recovers a scratch intent written before its journal and refuses a different frozen plan', async () => {
    const scratch = await createScratch();
    await runGit(fixture.root, ['worktree', 'lock', lane.directory]);
    const remove = vi.fn(async (source: string, directory: string) => runGit(source, ['worktree', 'remove', '--force', directory]).then(() => undefined));
    cleanup = new LegacyWorkspaceCleanup(root, { ownership, mountPoints: async () => [], assertOffline: offline, remove });
    await cleanup.plan(manifest);
    const originalRename = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === `${manifest}.progress.json`) throw new Error('Synthetic journal write interruption');
      return originalRename(from, to);
    });
    expect((await cleanup.discard(manifest, flags)).errors).toHaveLength(1);
    expect(remove).not.toHaveBeenCalled();
    rename.mockRestore();
    const originalPlan = await fs.readFile(manifest);
    await fs.appendFile(manifest, ' ');
    expect((await cleanup.discard(manifest, flags)).errors[0]).toContain('intent changed');
    expect(remove).not.toHaveBeenCalled();
    await fs.writeFile(manifest, originalPlan);
    expect(await cleanup.discard(manifest, flags)).toEqual({ removed: 1, errors: [] });
    expect(remove).toHaveBeenCalledTimes(1);
    await fs.unlink(`${manifest}.progress.json`);
    expect(await cleanup.discard(manifest, flags)).toEqual({ removed: 1, errors: [] });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(await exists(scratch.receipt)).toBe(true);
  });

  it('refuses a scratch plan whose originating lane identity was changed', async () => {
    const scratch = await createScratch();
    await runGit(fixture.root, ['worktree', 'lock', lane.directory]);
    await cleanup.plan(manifest);
    const plan = JSON.parse(await fs.readFile(manifest, 'utf8'));
    plan.items[0].laneId = randomUUID();
    await fs.writeFile(manifest, JSON.stringify(plan));
    expect((await cleanup.discard(manifest, flags)).errors[0]).toContain('changed');
    expect(await exists(scratch.directory)).toBe(true);
  });

  it('does not confuse two scratch intents with each other or with their originating lane', async () => {
    const first = await createScratch(); const second = await createScratch();
    await cleanup.plan(manifest);
    expect(await cleanup.discard(manifest, flags)).toEqual({ removed: 3, errors: [] });
    const progress = JSON.parse(await fs.readFile(`${manifest}.progress.json`, 'utf8'));
    expect(progress.items).toEqual({ [lane.id]: 'removed', [`scratch:${first.id}`]: 'removed', [`scratch:${second.id}`]: 'removed' });
    expect(await cleanup.discard(manifest, flags)).toEqual({ removed: 3, errors: [] });
  });

  it('retains deliberate lane-discard semantics when a ready label lacks strict reclamation proof', async () => {
    const record = JSON.parse(await fs.readFile(lane.worker, 'utf8'));
    await fs.writeFile(lane.worker, JSON.stringify({ ...record, state: 'ready' }));
    await fs.writeFile(path.join(lane.directory, 'uncaptured.txt'), 'synthetic uncaptured state');
    const original = await fs.readFile(lane.worker);
    await cleanup.plan(manifest);
    expect(await cleanup.discard(manifest, flags)).toEqual({ removed: 1, errors: [] });
    expect(await hasLegacyDiscardTombstone(workerRoot, lane.id)).toBe(true);
    expect(await fs.readFile(lane.worker)).toEqual(original);
  });
});
