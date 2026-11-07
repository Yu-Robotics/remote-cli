import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createHash, randomUUID } from 'crypto';
import { execFile, spawn, type ChildProcess } from 'child_process';
import { once } from 'events';
import { promisify } from 'util';
import { LegacyWorkspaceCleanup, completedLegacyDiscard } from '../../src/delegation/LegacyWorkspaceCleanup';
import { ManagedProcessGroups } from '../../src/executor/ManagedProcessGroups';
import { DelegatedWorkspaceManager } from '../../src/delegation/DelegatedWorkspaceManager';
import { DelegationOwnership } from '../../src/delegation/DelegationOwnership';
import { gitFixture } from './gitFixture';
import { runGit, gitText } from '../../src/delegation/GitCheckpoint';

const exists = (file: string) => fs.lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });

// Native leases and synthetic metadata. Policy-1 disposal requires Linux mount/process proof.
describe.skipIf(process.platform !== 'linux')('targeted terminal failed-worker disposal', { timeout: 30_000 }, () => {
  let fixture: Awaited<ReturnType<typeof gitFixture>>;
  let root: string, workspaceRoot: string, workerRoot: string;
  let lane: string, task: string, directory: string, workspaceFile: string, workerFile: string;
  let daemon: DelegationOwnership;
  let children: ChildProcess[];
  let pending: Set<Promise<unknown>>;
  let draining: boolean;
  const phase = <T>(action: () => Promise<T>) => {
    if (draining) throw new Error('Fixture is draining');
    const operation = action(); pending.add(operation);
    void operation.then(() => pending.delete(operation), () => pending.delete(operation));
    return operation;
  };
  const change = async (file: string, values: object) => fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), ...values }));
  const cleanup = (options: ConstructorParameters<typeof LegacyWorkspaceCleanup>[1] = {}) =>
    new LegacyWorkspaceCleanup(root, { mountPoints: async () => [], ...options });
  const discard = (options: ConstructorParameters<typeof LegacyWorkspaceCleanup>[1] = {}) => phase(() => cleanup(options).discardFailedWorker(lane, task));
  beforeEach(async () => {
    pending = new Set(); children = []; draining = false;
    fixture = await gitFixture();
    vi.spyOn(os, 'homedir').mockReturnValue(fixture.directory);
    vi.stubEnv('HOME', fixture.directory); vi.stubEnv('USERPROFILE', fixture.directory);
    root = path.join(fixture.directory, '.remote-cli');
    workspaceRoot = path.join(root, 'delegation-workspaces'); workerRoot = path.join(root, 'delegation-workers');
    for (const location of [workerRoot, path.join(workspaceRoot, 'lanes'), path.join(workspaceRoot, 'artifacts'), path.join(root, 'delegation')]) await fs.mkdir(location, { recursive: true });
    lane = randomUUID(); task = randomUUID();
    directory = path.join(workspaceRoot, 'trees', createHash('sha256').update(fixture.root).digest('hex'), lane);
    await fs.mkdir(path.dirname(directory), { recursive: true });
    await runGit(fixture.root, ['worktree', 'add', '--detach', directory, fixture.head]);
    const stat = await fs.lstat(directory);
    workspaceFile = path.join(workspaceRoot, 'lanes', `${lane}.json`); workerFile = path.join(workerRoot, `${lane}.json`);
    await fs.writeFile(workspaceFile, JSON.stringify({ laneId: lane, taskId: task, threadId: 'synthetic-parent', workspaceGeneration: 2,
      source: { root: fixture.root, cwd: fixture.root, commonDirectory: path.join(fixture.root, '.git'), relativeCwd: '' },
      directory, cwd: directory, taskRef: `refs/remote-cli/tasks/${task}`, input: { commit: fixture.head, head: fixture.head, tree: await gitText(fixture.root, ['rev-parse', 'HEAD^{tree}']) },
      disposalPolicy: 1, checkoutState: 'present', checkoutIdentity: { dev: stat.dev, ino: stat.ino }, blocked: true,
      cleanup: { reason: 'capture-failed', attempts: 1, retryable: false, updatedAt: 3 } }));
    await fs.writeFile(workerFile, JSON.stringify({ id: lane, executorThreadId: `delegate-lane-${lane}`, threadId: 'synthetic-parent',
      workingDirectory: fixture.root, workspaceGeneration: 2, state: 'dirty', backend: 'codex', contextGeneration: 7,
      nativeGroupExitGeneration: 7, shutdownConfirmedGeneration: 7, cleanupPending: false }));
    await fs.writeFile(path.join(root, 'delegation', `${task}.json`), JSON.stringify({ id: task, threadId: 'synthetic-parent', state: 'cancelled', startedAt: 1, finishedAt: 2 }));
    daemon = new DelegationOwnership(workerRoot); await daemon.acquire();
  });
  afterEach(async () => {
    draining = true;
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
    while (pending.size) await Promise.allSettled([...pending]);
    await daemon.release(); vi.restoreAllMocks(); vi.unstubAllEnvs();
    await fs.rm(fixture.directory, { recursive: true, force: true });
  }, 60_000);

  it('recovers exact legacy failure online, preserves external dependencies and native pointers, and is idempotent', async () => {
    const external = path.join(fixture.directory, 'external'); await fs.mkdir(external);
    await fs.writeFile(path.join(external, 'sentinel'), 'external remains');
    await fs.symlink(external, path.join(directory, 'node_modules'), 'dir');
    const pointer = path.join(root, 'codex-sessions', `delegate-lane-${lane}.json`);
    await fs.mkdir(path.dirname(pointer)); await fs.writeFile(pointer, 'synthetic native pointer');
    const before = await fs.readFile(workspaceFile), head = await gitText(fixture.root, ['rev-parse', 'HEAD']);
    expect(await discard()).toEqual({ removed: true });
    expect(await completedLegacyDiscard(workspaceRoot, lane, task)).toBeDefined();
    expect((await new DelegatedWorkspaceManager(workspaceRoot).enumerateArtifacts({ unresolvedOnly: true })).items).toEqual([]);
    expect(await exists(directory)).toBe(false);
    expect(await gitText(fixture.root, ['worktree', 'list', '--porcelain'])).not.toContain(directory);
    expect(await fs.readFile(workspaceFile)).toEqual(before);
    expect(await fs.readFile(path.join(external, 'sentinel'), 'utf8')).toBe('external remains');
    expect(await fs.readFile(pointer, 'utf8')).toBe('synthetic native pointer');
    expect(await gitText(fixture.root, ['rev-parse', 'HEAD'])).toBe(head);
    await fs.unlink(path.join(root, 'delegation', `${task}.json`));
    expect(await discard()).toEqual({ removed: true });
  });

  it.each([{ state: 'running' }, { state: 'preparing' }, { nativeGroupExitGeneration: 6 }, { shutdownConfirmedGeneration: 6 },
    { cleanupPending: true }, { nativeHistoryExitUnconfirmed: true }, { nativeMaintenanceExitUnconfirmed: true },
    { threadId: 'foreign-parent' }, { contextGeneration: 8 }])('holds unsafe lane evidence %j', async values => {
    await change(workerFile, values); await expect(discard()).rejects.toThrow();
    expect(await exists(directory)).toBe(true); expect(await completedLegacyDiscard(workspaceRoot, lane, task)).toBeUndefined();
  });

  it.each(['foreign-directory', 'foreign-source', 'replacement', 'mount', 'unconfirmed-task', 'pending-artifact', 'recovery-artifact', 'malformed-artifact'])('preserves %s', async condition => {
    if (condition === 'foreign-directory') await change(workspaceFile, { directory: fixture.root });
    if (condition === 'foreign-source') await change(workspaceFile, { source: { root: fixture.directory, cwd: fixture.directory, commonDirectory: path.join(fixture.root, '.git'), relativeCwd: '' } });
    if (condition === 'replacement') { await fs.rename(directory, `${directory}-original`); await fs.mkdir(directory); }
    if (condition === 'unconfirmed-task') await change(path.join(root, 'delegation', `${task}.json`), { state: 'running' });
    if (condition.endsWith('artifact')) await fs.writeFile(path.join(workspaceRoot, 'artifacts', `${task}.json`), condition === 'malformed-artifact' ? '{invalid' : JSON.stringify({ taskId: task, laneId: lane, threadId: 'synthetic-parent', disposition: 'pending',
      disposalPolicy: 1, source: { root: fixture.root, cwd: fixture.root }, closeout: { taskId: task, recoverable: true }, ...(condition === 'recovery-artifact' ? { recovery: { beforeRef: 'preserve', targetRef: 'preserve' } } : {}) }));
    await expect(discard(condition === 'mount' ? { mountPoints: async () => [directory] } : {})).rejects.toThrow();
    expect(await exists(directory)).toBe(true); expect(await fs.readFile(path.join(fixture.root, 'source.txt'), 'utf8')).toContain('first');
  });

  it('preserves potential credentials without reading or deleting them', async () => {
    const credential = path.join(directory, '.env');
    await fs.writeFile(credential, 'synthetic credential sentinel');
    const open = vi.spyOn(fs, 'open');
    await expect(discard()).rejects.toThrow('Potential credentials');
    expect(open.mock.calls.some(([file]) => file === credential)).toBe(false);
    expect(await fs.readFile(credential, 'utf8')).toBe('synthetic credential sentinel');
    expect(await exists(directory)).toBe(true);
  });

  it.each([false, true])('allows only unchanged tracked environment templates (changed=%s)', async changed => {
    const template = '.env.example';
    await fs.writeFile(path.join(fixture.root, template), 'PUBLIC_EXAMPLE=value');
    await runGit(fixture.root, ['add', template]); await runGit(fixture.root, ['commit', '-m', 'Synthetic public template']);
    const head = await gitText(fixture.root, ['rev-parse', 'HEAD']);
    await runGit(directory, ['reset', '--hard', head]);
    const input = { commit: head, head, tree: await gitText(fixture.root, ['rev-parse', 'HEAD^{tree}']) };
    await change(workspaceFile, { input });
    if (changed) await fs.writeFile(path.join(directory, template), 'synthetic private copy');
    if (changed) { await expect(discard()).rejects.toThrow('Potential credentials'); expect(await exists(directory)).toBe(true); }
    else expect(await discard()).toEqual({ removed: true });
    expect(await fs.readFile(path.join(fixture.root, template), 'utf8')).toBe('PUBLIC_EXAMPLE=value');
  });

  it('does not hold a failed checkout for an already removed template directory', async () => {
    const relative = path.join('templates', '.env.example');
    await fs.mkdir(path.dirname(path.join(fixture.root, relative)));
    await fs.writeFile(path.join(fixture.root, relative), 'PUBLIC_EXAMPLE=value');
    await runGit(fixture.root, ['add', relative]); await runGit(fixture.root, ['commit', '-m', 'Synthetic nested template']);
    const head = await gitText(fixture.root, ['rev-parse', 'HEAD']);
    await runGit(directory, ['reset', '--hard', head]);
    await change(workspaceFile, { input: { commit: head, head, tree: await gitText(fixture.root, ['rev-parse', 'HEAD^{tree}']) } });
    await fs.rm(path.join(directory, 'templates'), { recursive: true });
    expect(await discard()).toEqual({ removed: true });
    expect(await fs.readFile(path.join(fixture.root, relative), 'utf8')).toBe('PUBLIC_EXAMPLE=value');
  });

  it.each(['artifacts', 'delegation'])('rejects a redirected %s metadata directory before reading its records', async bucket => {
    const original = bucket === 'artifacts' ? path.join(workspaceRoot, bucket) : path.join(root, bucket);
    const foreign = path.join(fixture.directory, `foreign-${bucket}`);
    await fs.rename(original, foreign); await fs.symlink(foreign, original, 'dir');
    const open = vi.spyOn(fs, 'open');
    await expect(discard()).rejects.toThrow('Noncanonical');
    expect(open.mock.calls.some(([file]) => file === path.join(original, `${task}.json`))).toBe(false);
    expect(await exists(directory)).toBe(true); expect(await exists(foreign)).toBe(true);
  });

  it('serializes with the daemon real repository gate without stopping it', async () => {
    let entered!: () => void, release!: () => void;
    const entering = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const holding = daemon.withRepository(path.join(fixture.root, '.git'), async () => { entered(); await gate; });
    await entering; let finished = false;
    const removing = discard().then(value => { finished = true; return value; });
    try { await new Promise(resolve => setTimeout(resolve, 75)); expect(finished).toBe(false); expect(await exists(directory)).toBe(true); }
    finally { release(); await holding; }
    await removing;
  });

  it('resumes after physical removal before the completion receipt', async () => {
    const remove = vi.fn(async (source: string, target: string) => { await runGit(source, ['worktree', 'remove', '--force', target]); throw new Error('Synthetic crash after removal'); });
    await expect(discard({ remove })).rejects.toThrow('Synthetic crash');
    expect(await completedLegacyDiscard(workspaceRoot, lane, task)).toBeUndefined();
    await fs.unlink(path.join(root, 'delegation', `${task}.json`));
    expect(await discard({ remove })).toEqual({ removed: true }); expect(remove).toHaveBeenCalledOnce();
  });

  it('settles only the exact leftover Git registration after an interrupted directory removal', async () => {
    await expect(discard({ remove: async (_source, target) => {
      await fs.rm(target, { recursive: true, force: true }); throw new Error('Synthetic partial removal');
    } })).rejects.toThrow('Synthetic partial removal');
    expect(await exists(directory)).toBe(false);
    expect(await gitText(fixture.root, ['worktree', 'list', '--porcelain'])).toContain(directory);
    expect(await discard()).toEqual({ removed: true });
    expect(await gitText(fixture.root, ['worktree', 'list', '--porcelain'])).not.toContain(directory);
  });

  it('leaves an unrelated live worker and its checkout untouched', async () => {
    const other = path.join(fixture.directory, 'unrelated-worker');
    await runGit(fixture.root, ['worktree', 'add', '--detach', other, fixture.head]);
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)'], { cwd: other, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child); await once(child.stdout!, 'data');
    expect(await discard()).toEqual({ removed: true });
    expect(child.exitCode).toBeNull(); expect(await exists(other)).toBe(true);
    expect(await gitText(fixture.root, ['worktree', 'list', '--porcelain'])).toContain(other);
  });

  it('holds a rebound task after interrupted removal', async () => {
    await expect(discard({ remove: async () => { throw new Error('Synthetic removal failure'); } })).rejects.toThrow();
    await change(workspaceFile, { taskId: randomUUID() });
    await expect(discard()).rejects.toThrow('rebound'); expect(await exists(directory)).toBe(true);
  });

  it('preserves unrecoverable artifact evidence only after actual checkout deletion', async () => {
    const artifact = path.join(workspaceRoot, 'artifacts', `${task}.json`);
    const saved = JSON.parse(await fs.readFile(workspaceFile, 'utf8'));
    const value = JSON.stringify({ taskId: task, laneId: lane, threadId: 'synthetic-parent', workspaceGeneration: 2, disposition: 'pending', disposalPolicy: 1,
      source: saved.source, input: saved.input, output: fixture.head, tree: saved.input.tree,
      closeout: { taskId: task, output: fixture.head, tree: saved.input.tree, recoverable: false } });
    await fs.writeFile(artifact, value); await discard(); expect(await exists(artifact)).toBe(false);
    expect(await fs.readFile(path.join(workerRoot, 'failed-disposal-intents', `${lane}.artifact.json`), 'utf8')).toBe(value);
    expect(await completedLegacyDiscard(workspaceRoot, lane, task)).toBeDefined();
  });

  it('retries a newly recorded failure after diagnostic task expiry', async () => {
    await change(workspaceFile, { exitConfirmation: { taskId: task, contextGeneration: 7, confirmedAt: 2 }, failedCollection: { taskId: task, state: 'failed' } });
    await fs.unlink(path.join(root, 'delegation', `${task}.json`));
    expect(await discard()).toEqual({ removed: true });
  });

  it('runs the supported command end-to-end while an existing daemon owner stays held', async () => {
    const module = path.resolve(__dirname, '../../src/commands/delegationStorage.ts');
    const code = `const {Command}=require('commander'); const {registerDelegationStorage}=require(${JSON.stringify(module)}); const program=new Command(); registerDelegationStorage(program); program.parseAsync(process.argv.slice(1), {from:'user'}).catch(()=>{process.exitCode=1});`;
    const result = await phase(() => promisify(execFile)(process.execPath,
      ['--import', require.resolve('tsx'), '-e', code, 'delegation', 'storage', 'discard-failed', '--lane', lane, '--task', task],
      { timeout: 30_000, env: { PATH: process.env.PATH, HOME: fixture.directory, USERPROFILE: fixture.directory } }));
    expect(JSON.parse(result.stdout)).toEqual({ removed: true });
    await daemon.acquire();
    expect(await completedLegacyDiscard(workspaceRoot, lane, task)).toBeDefined();
  });

  it.each(['inode', 'generation', 'intent', 'registration', 'mount'])('rejects %s replacement after durable intent', async replacement => {
    await expect(discard({ remove: async () => { throw new Error('Synthetic interruption'); } })).rejects.toThrow('Synthetic interruption');
    if (replacement === 'inode') { await fs.rename(directory, `${directory}-old`); await fs.mkdir(directory); }
    if (replacement === 'generation') await change(workerFile, { contextGeneration: 8, nativeGroupExitGeneration: 8, shutdownConfirmedGeneration: 8 });
    if (replacement === 'intent') await change(path.join(workerRoot, 'failed-disposal-intents', `${lane}.json`), { proof: 'changed' });
    if (replacement === 'registration') {
      const gitdir = (await fs.readFile(path.join(directory, '.git'), 'utf8')).trim().slice(8);
      await fs.writeFile(path.join(gitdir, 'gitdir'), path.join(fixture.root, '.git'));
    }
    await expect(discard(replacement === 'mount' ? { mountPoints: async () => [directory] } : {})).rejects.toThrow();
    expect(await exists(directory)).toBe(true);
  });

  it('retries after artifact preservation but before the final compatible receipt', async () => {
    const artifact = path.join(workspaceRoot, 'artifacts', `${task}.json`);
    const saved = JSON.parse(await fs.readFile(workspaceFile, 'utf8'));
    const value = JSON.stringify({ taskId: task, laneId: lane, threadId: 'synthetic-parent', workspaceGeneration: 2, disposition: 'pending', disposalPolicy: 1,
      source: saved.source, input: saved.input, output: fixture.head, tree: saved.input.tree,
      closeout: { taskId: task, output: fixture.head, tree: saved.input.tree, recoverable: false } });
    await fs.writeFile(artifact, value);
    const rename = fs.rename.bind(fs); let writes = 0;
    vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (destination === path.join(workerRoot, 'legacy-discarded', `${lane}.json`) && ++writes === 2) throw new Error('Synthetic receipt failure');
      return rename(source, destination);
    });
    await expect(discard()).rejects.toThrow('Synthetic receipt failure');
    expect(await exists(artifact)).toBe(false); expect(await completedLegacyDiscard(workspaceRoot, lane, task)).toBeUndefined();
    expect(await discard()).toEqual({ removed: true });
    expect(await fs.readFile(path.join(workerRoot, 'failed-disposal-intents', `${lane}.artifact.json`), 'utf8')).toBe(value);
  });

  it('requires real managed-group exit before disposing a live worker', async () => {
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)'], { cwd: directory, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const groups = new ManagedProcessGroups(); groups.track(child);
    children.push(child); await once(child.stdout!, 'data');
    await change(workerFile, { state: 'running', nativeGroupExitGeneration: undefined, shutdownConfirmedGeneration: undefined });
    await expect(new LegacyWorkspaceCleanup(root).discardFailedWorker(lane, task)).rejects.toThrow('unconfirmed');
    expect(child.exitCode).toBeNull(); expect(await exists(directory)).toBe(true);
    const closed = once(child, 'close'); child.kill(); await closed; await groups.waitForExit();
    await change(workerFile, { state: 'dirty', nativeGroupExitGeneration: 7, shutdownConfirmedGeneration: 7 });
    await expect(phase(() => new LegacyWorkspaceCleanup(root).discardFailedWorker(lane, task))).resolves.toEqual({ removed: true });
  });
});
