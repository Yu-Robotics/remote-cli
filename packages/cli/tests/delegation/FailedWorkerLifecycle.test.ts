import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { DelegationManager, type DelegationParent, type DelegatedTaskResult } from '../../src/delegation/DelegationManager';
import { BackendRegistry } from '../../src/delegation/BackendRegistry';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import type { ExecuteResult, IExecutor } from '../../src/executor/IExecutor';
import { gitFixture } from './gitFixture';
import { gitText } from '../../src/delegation/GitCheckpoint';
import { completedLegacyDiscard } from '../../src/delegation/LegacyWorkspaceCleanup';

// This exercises the default production locks and disposal path, with fake model execution only.
describe.skipIf(process.platform !== 'linux')('automatic failed worker closeout', { timeout: 30_000 }, () => {
  let fixture: Awaited<ReturnType<typeof gitFixture>>, manager: DelegationManager, parent: DelegationParent;
  let workers: Array<{ cwd: string; finish: (result: ExecuteResult) => void; executor: IExecutor }>;
  let pending: Set<Promise<unknown>>, draining: boolean;
  const phase = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
    if (draining) throw new Error('Fixture is draining');
    const operation = Promise.resolve().then(action); pending.add(operation);
    void operation.then(() => pending.delete(operation), () => pending.delete(operation));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => { draining = true; reject(new Error(`Fixture phase exceeded 30 seconds: ${name}`)); }, 30_000); })]); }
    finally { clearTimeout(timer); }
  };
  beforeEach(async () => {
    fixture = await gitFixture(); workers = []; pending = new Set(); draining = false;
    vi.spyOn(os, 'homedir').mockReturnValue(fixture.directory); vi.stubEnv('HOME', fixture.directory); vi.stubEnv('USERPROFILE', fixture.directory);
    manager = new DelegationManager(new DirectoryGuard([fixture.directory]), (_guard, _config, cwd) => {
      let finish!: (result: ExecuteResult) => void;
      const done = new Promise<ExecuteResult>(resolve => { finish = resolve; });
      const executor = { execute: vi.fn(() => done), destroy: vi.fn(async () => undefined), abort: vi.fn(async () => true),
        waitForExit: vi.fn(async () => undefined), waitForManagedProcessGroupExit: vi.fn(async () => undefined), resetContext: vi.fn(),
        getCurrentWorkingDirectory: () => cwd!, setWorkingDirectory: vi.fn() } as IExecutor;
      workers.push({ cwd: cwd!, finish, executor }); if (draining) finish({ success: false }); return executor;
    }, new BackendRegistry(async () => 'synthetic 1.0'));
    parent = { thread: { id: 'synthetic-parent', name: 'default', workingDirectory: fixture.root, sessionId: null, createdAt: 0, lastActiveAt: 0 },
      cwd: fixture.root, backend: 'codex', config: { type: 'auto' }, messageId: 'synthetic-message',
      onToolUse: vi.fn(), onToolResult: vi.fn(), onNotice: vi.fn(), onApproval: vi.fn(), onApprovalResolved: vi.fn() };
  });
  afterEach(async () => {
    draining = true; workers.forEach(worker => worker.finish({ success: false }));
    while (pending.size) await Promise.allSettled([...pending]);
    await manager.destroy(); vi.restoreAllMocks(); vi.unstubAllEnvs();
    await fs.rm(fixture.directory, { recursive: true, force: true });
  }, 60_000);
  it.each(['external dependency', 'missing required report', 'interrupted disposal'] as const)('disposes failed %s output and clears the next turn without native deletion', async failure => {
    const scope = manager.begin(parent);
    const task = await phase('admit worker', () => scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Synthetic failed artifact',
      ...(failure === 'missing required report' ? { exports: ['missing-report.txt'] } : {}) }, 'launch') as Promise<DelegatedTaskResult>);
    await phase('enter execution', async () => { await vi.waitFor(() => expect(workers[0]?.executor.execute).toHaveBeenCalled(), { timeout: 29_000 }); });
    const outside = path.join(fixture.directory, 'external-dependencies'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'sentinel'), 'preserved');
    if (failure !== 'missing required report') await fs.symlink(outside, path.join(workers[0].cwd, 'node_modules'), 'dir');
    const workerRoot = path.join(fixture.directory, '.remote-cli', 'delegation-workers');
    const lane = path.basename(workers[0].cwd);
    if (failure === 'interrupted disposal') {
      const rename = fs.rename.bind(fs); let receipts = 0;
      vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
        if (destination === path.join(workerRoot, 'legacy-discarded', `${lane}.json`) && ++receipts === 2) throw new Error('Synthetic completion receipt failure');
        return rename(source, destination);
      });
    }
    workers[0].finish({ success: true });
    const [result] = await phase('collect and dispose failed artifact', () => scope.collectPendingResults());
    expect(result.taskId).toBe(task.taskId); expect(result.state).toBe('failed');
    expect(result.error).toContain(failure === 'interrupted disposal' ? 'Cleanup remains held' : 'Failed worker contents were discarded');
    await expect(fs.lstat(workers[0].cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    if (failure === 'interrupted disposal') {
      expect(await completedLegacyDiscard(path.join(fixture.directory, '.remote-cli', 'delegation-workspaces'), lane, task.taskId)).toBeUndefined();
      expect((await fs.lstat(path.join(workerRoot, 'failed-disposal-intents', `${lane}.json`))).isFile()).toBe(true);
    }
    expect(await phase('check current closeout', () => scope.checkArtifactCloseout())).toEqual([]);
    expect(await completedLegacyDiscard(path.join(fixture.directory, '.remote-cli', 'delegation-workspaces'), lane, task.taskId)).toBeDefined();
    await phase('close failed scope', () => scope.close());
    expect(await phase('read next-turn obligations', () => manager.pendingArtifactContext(parent.thread, fixture.root))).toBe('');
    expect(await fs.readFile(path.join(outside, 'sentinel'), 'utf8')).toBe('preserved');
    expect(await gitText(fixture.root, ['rev-parse', 'HEAD'])).toBe(fixture.head);
    expect(await fs.readFile(path.join(fixture.root, 'source.txt'), 'utf8')).toContain('first');
    expect((await fs.readdir(path.join(workerRoot, 'legacy-discarded'))).filter(name => name.endsWith('.json'))).toEqual([`${lane}.json`]);
  }, 6 * 30_000 + 5_000);
});
