import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import childProcess from 'child_process';
import { MessageHandler } from '../../src/client/MessageHandler';
import { ThreadManager } from '../../src/thread/ThreadManager';
import { ThreadExecutorPool } from '../../src/thread/ThreadExecutorPool';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { DELEGATION_LIMITS, DelegationManager } from '../../src/delegation/DelegationManager';
import { DelegatedWorkspaceManager } from '../../src/delegation/DelegatedWorkspaceManager';
import { BackendRegistry } from '../../src/delegation/BackendRegistry';
import type { DelegationConnection } from '../../src/delegation/contract';
import type { ExecuteOptions, ExecuteResult } from '../../src/executor/IExecutor';
import { gitText, runGit } from '../../src/delegation/GitCheckpoint';
import { gitFixture } from '../delegation/gitFixture';
import * as closeout from '../../src/delegation/ArtifactCloseoutContinuation';

vi.mock('../../src/delegation/OwnershipRuntime', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/delegation/OwnershipRuntime')>();
  const { syntheticOwnershipRuntime } = await import('../delegation/syntheticOwnershipRuntime');
  return syntheticOwnershipRuntime(actual);
});

describe('code-enforced delegated artifact closeout', { timeout: 30_000 }, () => {
  let fixture: Awaited<ReturnType<typeof gitFixture>>;
  let handler: MessageHandler;
  let threads: ThreadManager;
  let pool: ThreadExecutorPool;
  let main: any;
  let socket: any;
  let connection: DelegationConnection | undefined;
  let workerWork: (cwd: string) => Promise<ExecuteResult>;
  let workerExecutions: number;
  let callCounter: number;
  let taskId: string;

  const message = (id: string, content: string) => ({ type: 'command' as const, messageId: id, content, openId: 'fixture-owner', timestamp: Date.now() });
  const response = () => socket.send.mock.calls.map(([value]: any[]) => value).reverse()
    .find((value: any) => value.type === 'response' && value.messageId === 'parent');
  const artifactPath = (id = taskId) => path.join(fixture.directory, '.remote-cli', 'delegation-workspaces', 'artifacts', `${id}.json`);
  const artifact = async (id = taskId) => JSON.parse(await fs.readFile(artifactPath(id), 'utf8'));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const reply = await fetch(connection!.url, { method: 'POST', headers: { authorization: `Bearer ${connection!.token}` },
      body: JSON.stringify({ name, args, callId: `closeout-${++callCounter}` }) });
    const result = await reply.json() as any;
    if (!reply.ok) throw new Error(result.error);
    return result;
  };
  const delegate = async (readResult = true) => {
    const task = await call('remote_cli_delegate', { backend: 'claude', objective: 'Produce the requested fixture change' });
    taskId = task.taskId;
    if (readResult) await call('remote_cli_result', { taskId, waitSeconds: 25 });
    return task.taskId;
  };
  const retain = async (id = taskId) => {
    const view = await call('remote_cli_integrate', { taskId: id, action: 'inspect' });
    return call('remote_cli_integrate', { taskId: id, action: 'retain', expectedRevision: view.revision });
  };
  const run = () => handler.handleMessage(message('parent', 'Original task'));
  const holdWait = (after = 1) => {
    let entered!: (delay: number) => void;
    const waiting = new Promise<number>(resolve => { entered = resolve; });
    const actual = closeout.waitForArtifactCloseout;
    let calls = 0;
    const spy = vi.spyOn(closeout, 'waitForArtifactCloseout').mockImplementation((delay, signal) => {
      if (++calls < after) return actual(0, signal);
      entered(delay);
      return actual(30000, signal);
    });
    return { waiting, spy };
  };
  const enterWait = <T>(waiting: Promise<T>, active: Promise<void>) => Promise.race([
    waiting, active.then(() => { throw new Error('Request ended before the closeout wait'); }),
  ]);

  beforeEach(async () => {
    fixture = await gitFixture();
    vi.spyOn(os, 'homedir').mockReturnValue(fixture.directory);
    vi.stubEnv('HOME', fixture.directory);
    vi.stubEnv('USERPROFILE', fixture.directory);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    threads = await ThreadManager.initialize(fixture.directory);
    await threads.updateThread(threads.getDefaultThread().id, { workingDirectory: fixture.root });
    connection = undefined; callCounter = 0; workerExecutions = 0; taskId = '';
    workerWork = async cwd => {
      await fs.writeFile(path.join(cwd, 'source.txt'), 'worker change\n');
      return { success: true, output: 'Fixture worker result' };
    };
    main = { execute: vi.fn(async () => ({ success: true, output: 'Claimed complete' })),
      configureDelegation: vi.fn(async value => { connection = value; }),
      abort: vi.fn(async () => true), destroy: vi.fn(async () => undefined), resetContext: vi.fn(),
      setWorkingDirectory: vi.fn(), getCurrentWorkingDirectory: () => fixture.root };
    const guard = new DirectoryGuard([fixture.directory]);
    const config: any = { get: vi.fn(key => key === 'executor' ? { type: 'codex' } : undefined),
      getAll: () => ({}), has: () => true, getConfigDir: () => fixture.directory };
    pool = new ThreadExecutorPool(threads, guard, { type: 'codex' }, () => main);
    socket = { send: vi.fn(), trackTask: vi.fn(), hasPendingTaskResults: () => false, isConnected: () => true };
    handler = new MessageHandler(socket, pool, threads, guard, config);
    (handler as any).delegation = new DelegationManager(guard, (_guard, _config, cwd) => ({
      execute: vi.fn(async () => { workerExecutions++; return workerWork(cwd); }),
      abort: vi.fn(async () => true), destroy: vi.fn(async () => undefined), waitForExit: vi.fn(async () => undefined), waitForManagedProcessGroupExit: vi.fn(async () => undefined),
      resetContext: vi.fn(), setWorkingDirectory: vi.fn(), getCurrentWorkingDirectory: () => cwd,
    }), new BackendRegistry(async () => 'fixture 1.0'), undefined, undefined, undefined, undefined,
      new DelegatedWorkspaceManager(undefined, true));
    main.execute.mockImplementationOnce(async () => { await delegate(); return { success: true }; });
  });
  afterEach(async () => {
    await handler?.destroy(); vi.restoreAllMocks(); vi.unstubAllEnvs();
    await fs.rm(fixture.directory, { recursive: true, force: true });
  });

  it('continues beyond two rounds and resolves without replaying completed work', async () => {
    vi.spyOn(closeout, 'waitForArtifactCloseout').mockResolvedValue(undefined);
    main.execute.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: true })
      .mockImplementationOnce(async (prompt: string, options: ExecuteOptions) => {
        expect(prompt).toContain('closeout round 3');
        expect(prompt).not.toContain('Original task');
        expect(options.attachments).toBeUndefined();
        expect(response()).toBeUndefined();
        expect(pool.isThreadBusy(threads.getDefaultThread().id)).toBe(true);
        await retain(); return { success: true };
      });
    await run();
    expect(main.execute).toHaveBeenCalledTimes(4);
    expect(workerExecutions).toBe(1);
    expect(response()).toMatchObject({ success: true });
    expect(await artifact()).toMatchObject({ disposition: 'retained' });
    expect(await fs.readFile(path.join(fixture.root, 'source.txt'), 'utf8')).toBe('first\nsecond\nthird\n');
    expect(await gitText(fixture.root, ['rev-parse', 'HEAD'])).toBe(fixture.head);
    expect(pool.isThreadBusy(threads.getDefaultThread().id)).toBe(false);
  });

  it.each(['apply', 'retain'])('finishes after a durable %s without replaying the request or attachments', async action => {
    main.execute.mockImplementationOnce(async (prompt: string, options: ExecuteOptions) => {
      expect(prompt).toContain(taskId);
      expect(prompt).not.toContain('Original task');
      expect(options.attachments).toBeUndefined();
      expect(response()).toBeUndefined();
      expect(pool.isThreadBusy(threads.getDefaultThread().id)).toBe(true);
      const view = await call('remote_cli_integrate', { taskId, action: 'inspect' });
      await call('remote_cli_integrate', { taskId, action, expectedRevision: view.revision });
      return { success: true };
    });
    await handler.handleMessage({ ...message('parent', 'Original task'), attachments: [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }] });
    expect(main.execute).toHaveBeenCalledTimes(2);
    expect(workerExecutions).toBe(1);
    expect(response(), response()?.error).toMatchObject({ success: true });
    expect(await artifact()).toMatchObject({ disposition: action === 'apply' ? 'applied' : 'retained' });
    expect(await fs.readFile(path.join(fixture.root, 'source.txt'), 'utf8')).toBe(action === 'apply' ? 'worker change\n' : 'first\nsecond\nthird\n');
  });

  it('does not require a model decision for a verified no-change artifact', async () => {
    const nativeProbe = vi.spyOn(childProcess, 'execFileSync').mockImplementation(() => {
      throw Object.assign(new Error('Synthetic native boot provider timeout'), { code: 'ETIMEDOUT' });
    });
    workerWork = async () => ({ success: true, output: 'Review only' });
    await run();
    expect(workerExecutions).toBe(1);
    expect(nativeProbe).not.toHaveBeenCalled();
    expect(main.execute).toHaveBeenCalledOnce();
    expect(response()).toMatchObject({ success: true });
    expect(await artifact()).toMatchObject({ disposition: 'applied' });
  });

  it('recognizes output ancestry before requesting any extra model turn', async () => {
    main.execute.mockReset().mockImplementationOnce(async () => {
      await delegate();
      await runGit(fixture.root, ['merge', '--ff-only', (await artifact()).output]);
      return { success: true };
    });
    await run();
    expect(main.execute).toHaveBeenCalledOnce();
    expect(response()).toMatchObject({ success: true });
    expect(await artifact()).toMatchObject({ disposition: 'applied', deliveredAtHead: await gitText(fixture.root, ['rev-parse', 'HEAD']) });
  });

  it('rereads durable disposition rather than the cached pending result', async () => {
    main.execute.mockReset().mockImplementationOnce(async () => {
      await delegate();
      const manager = new DelegatedWorkspaceManager();
      const owner = { threadId: threads.getDefaultThread().id, cwd: fixture.root, workspaceGeneration: 0 };
      const view = await manager.integrate(owner, taskId, 'inspect', undefined) as { revision: string };
      await manager.integrate(owner, taskId, 'retain', view.revision);
      return { success: true };
    });
    await run();
    expect(main.execute).toHaveBeenCalledOnce();
    expect(response()).toMatchObject({ success: true });
  });

  it.each(['missing', 'corrupt', 'foreign', 'changed-ref', 'blocked'])('keeps a %s receipt unresolved despite a cached applied result', async fault => {
    workerWork = async () => ({ success: true, output: 'No changes' });
    main.execute.mockReset().mockImplementationOnce(async () => {
      await delegate();
      const saved = await artifact();
      if (fault === 'missing') await fs.rm(artifactPath());
      if (fault === 'corrupt') await fs.writeFile(artifactPath(), '{');
      if (fault === 'foreign') await fs.writeFile(artifactPath(), JSON.stringify({ ...saved, threadId: 'another-owner' }));
      if (fault === 'changed-ref') await runGit(fixture.root, ['update-ref', `refs/remote-cli/artifacts/${taskId}`, fixture.head]);
      if (fault === 'blocked') {
        const laneFile = path.join(fixture.directory, '.remote-cli', 'delegation-workspaces', 'lanes', `${saved.laneId}.json`);
        const lane = JSON.parse(await fs.readFile(laneFile, 'utf8'));
        await fs.writeFile(laneFile, JSON.stringify({ ...lane, blocked: true }));
      }
      return { success: true };
    }).mockResolvedValue({ success: true });
    const hold = holdWait();
    const active = run();
    await enterWait(hold.waiting, active);
    expect(main.execute.mock.calls[1][0]).toContain('unavailable');
    expect(response()).toBeUndefined();
    expect(workerExecutions).toBe(1);
    await handler.handleMessage(message('abort', '/abort'));
    await active;
    expect(main.execute).toHaveBeenCalledTimes(2);
    expect(response()).toMatchObject({ success: false });
  });

  it('settles an unavailable failed-worker obligation after actual disposal without perpetual model rounds', async () => {
    vi.spyOn(DelegatedWorkspaceManager.prototype, 'collect').mockRejectedValue(new Error('Fixture storage failure'));
    const hold = holdWait();
    const active = run();
    if (process.platform !== 'linux') {
      await enterWait(hold.waiting, active);
      expect(main.execute.mock.calls[1][0]).toContain('unavailable');
      expect(response()).toBeUndefined();
      await handler.handleMessage(message('abort', '/abort'));
    }
    await active;
    expect(workerExecutions).toBe(1);
    if (process.platform === 'linux') {
      expect(main.execute).toHaveBeenCalledOnce();
      expect(response()).toMatchObject({ success: true });
      const record = JSON.parse(await fs.readFile(path.join(fixture.directory, '.remote-cli', 'delegation', `${taskId}.json`), 'utf8'));
      expect(record.state).toBe('failed'); expect(record.error).toContain('Failed worker contents were discarded');
      expect(await fs.readFile(path.join(fixture.root, 'source.txt'), 'utf8')).toBe('first\nsecond\nthird\n');
      await handler.handleMessage(message('after-failure', 'Another ordinary request'));
      expect(main.execute).toHaveBeenCalledTimes(2); expect(workerExecutions).toBe(1);
      expect(socket.send.mock.calls.map(([value]: any[]) => value).find((value: any) => value.type === 'response' && value.messageId === 'after-failure'))
        .toMatchObject({ success: true });
    } else {
      expect(main.execute).toHaveBeenCalledTimes(2);
      expect(response()).toMatchObject({ success: false });
    }
  });

  it('retains verified failed worker edits without an extra model round or automatic application', async () => {
    workerWork = async cwd => {
      await fs.writeFile(path.join(cwd, 'source.txt'), 'partial failed work\n');
      return { success: false, error: 'Fixture failure' };
    };
    await run();
    expect(main.execute).toHaveBeenCalledOnce();
    expect(response()).toMatchObject({ success: true });
    expect(await artifact()).toMatchObject({ successful: false, disposition: 'retained' });
    expect(await fs.readFile(path.join(fixture.root, 'source.txt'), 'utf8')).toBe('first\nsecond\nthird\n');
  });

  it('keeps the request launch budget across closeout rounds and new workers', async () => {
    vi.spyOn(closeout, 'waitForArtifactCloseout').mockResolvedValue(undefined);
    const ids: string[] = [];
    main.execute.mockReset().mockImplementation(async (prompt: string) => {
      if (workerExecutions) {
        expect(prompt).toContain('Fixture worker result');
        expect(prompt).toContain('artifact closeout');
      }
      if (ids.length < DELEGATION_LIMITS.launches) ids.push(await delegate(false));
      else {
        await expect(delegate(false)).rejects.toThrow('Delegated task limit reached');
        for (const id of ids) await retain(id);
      }
      return { success: true };
    });
    await run();
    expect(main.execute).toHaveBeenCalledTimes(DELEGATION_LIMITS.launches + 1);
    expect(workerExecutions).toBe(DELEGATION_LIMITS.launches);
    expect(response()).toMatchObject({ success: true });
    expect(main.configureDelegation).toHaveBeenCalledOnce();
    for (const id of ids) expect(await artifact(id)).toMatchObject({ disposition: 'retained' });
  }, (DELEGATION_LIMITS.launches + 1) * 30000);

  it('preserves compact retry semantics without consuming another closeout round', async () => {
    main.compactWhenFull = vi.fn(async () => ({ success: true }));
    main.execute.mockResolvedValueOnce({ success: false, error: 'Prompt too long' })
      .mockImplementationOnce(async () => ({ success: true }))
      .mockImplementationOnce(async () => { await retain(); return { success: true }; });
    await run();
    expect(main.execute).toHaveBeenCalledTimes(4);
    expect(main.compactWhenFull).toHaveBeenCalledOnce();
    expect(main.execute.mock.calls[1][0]).toBe(main.execute.mock.calls[2][0]);
    expect(main.execute.mock.calls[3][0]).toContain('closeout round 2');
    expect(response()).toMatchObject({ success: true });
    expect(workerExecutions).toBe(1);
  });

  it('preserves model recovery within the same closeout prompt and admission scope', async () => {
    const threadId = threads.getDefaultThread().id;
    await threads.updateThread(threadId, { models: { codex: 'synthetic-unavailable-model' } });
    main.clearModel = vi.fn(async () => undefined);
    main.execute.mockResolvedValueOnce({ success: false, error: 'Unknown Codex model' })
      .mockImplementationOnce(async () => { await retain(); return { success: true }; });
    await run();
    expect(main.execute).toHaveBeenCalledTimes(3);
    expect(main.execute.mock.calls[1][0]).toBe(main.execute.mock.calls[2][0]);
    expect(main.execute.mock.calls[2][1].attachments).toBeUndefined();
    expect(main.clearModel).toHaveBeenCalledOnce();
    expect(threads.getThread(threadId)?.models?.codex).toBeUndefined();
    expect(workerExecutions).toBe(1);
    expect(response()).toMatchObject({ success: true });
  });

  it.each(['abort', 'shutdown', 'clear'])('cancels repeated unchanged closeout during backoff on %s', async action => {
    const hold = holdWait(3);
    const active = run();
    expect(await enterWait(hold.waiting, active)).toBe(4000);
    expect(hold.spy.mock.calls.map(([delay]) => delay)).toEqual([1000, 2000, 4000]);
    expect(main.execute).toHaveBeenCalledTimes(4);
    expect(response()).toBeUndefined();
    const threadId = threads.getDefaultThread().id;
    expect(pool.isThreadBusy(threadId)).toBe(true);
    expect((handler as any).activeThreadOperations.get(threadId).messageId).toBe('parent');
    expect(await artifact()).toMatchObject({ disposition: 'pending' });
    expect(JSON.stringify(socket.send.mock.calls)).toContain('Continuing in 4s; use /abort to stop.');
    if (action === 'abort') {
      await handler.handleMessage(message('queued', 'Synthetic queued request'));
      const confirmation = socket.send.mock.calls.map(([value]: any[]) => value)
        .find((value: any) => value.messageId === 'queued' && value.queueConfirmation)?.queueConfirmation;
      expect(confirmation).toBeDefined();
      await handler.handleMessage(message('confirm', `/queue confirm ${confirmation.id}`));
      expect((handler as any).threadQueues.get(threadId)).toHaveLength(1);
      expect(main.execute).toHaveBeenCalledTimes(4);
      expect(response()).toBeUndefined();
    }
    // The bridge is retired while waiting; it must not admit work between turns.
    await expect(call('remote_cli_delegate', { backend: 'claude', objective: 'Must not run' })).rejects.toThrow();
    if (action === 'shutdown') await handler.destroy();
    else await handler.handleMessage(message('cancel', action === 'clear' ? '/clear' : '/abort'));
    await active;
    expect(hold.spy.mock.calls[2][1]?.aborted).toBe(true);
    expect(main.execute).toHaveBeenCalledTimes(4);
    expect(workerExecutions).toBe(1);
    expect(response()).toMatchObject({ success: false });
    expect(await artifact()).toMatchObject({ disposition: 'pending' });
    expect(await gitText(fixture.root, ['rev-parse', 'HEAD'])).toBe(fixture.head);
    expect((handler as any).activeThreadOperations.size).toBe(0);
    expect((handler as any).coordinatorPreparations.size).toBe(0);
    expect((handler as any).pausedQueues.size).toBe(0);
    expect((handler as any).threadQueues.size).toBe(0);
  });

  it('rechecks a disposition resolved during backoff without an extra model turn', async () => {
    vi.spyOn(closeout, 'waitForArtifactCloseout').mockImplementationOnce(async () => {
      expect(response()).toBeUndefined();
      const manager = new DelegatedWorkspaceManager();
      const owner = { threadId: threads.getDefaultThread().id, cwd: fixture.root, workspaceGeneration: 0 };
      const view = await manager.integrate(owner, taskId, 'inspect', undefined) as { revision: string };
      await manager.integrate(owner, taskId, 'retain', view.revision);
    });
    await run();
    expect(main.execute).toHaveBeenCalledTimes(2);
    expect(workerExecutions).toBe(1);
    expect(response()).toMatchObject({ success: true });
    expect(await artifact()).toMatchObject({ disposition: 'retained' });
  });

  it('does not add closeout turns after coordinator failure', async () => {
    main.execute.mockResolvedValueOnce({ success: false, error: 'Fixture coordinator failure' });
    await run();
    expect(main.execute).toHaveBeenCalledTimes(2);
    expect(response()).toMatchObject({ success: false, error: 'Fixture coordinator failure' });
    expect(await artifact()).toMatchObject({ disposition: 'pending' });
  });

  it.each(['abort', 'shutdown'])('stops closeout on %s and keeps pending artifacts', async action => {
    let finish!: (value: ExecuteResult) => void;
    main.execute.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    main.abort.mockImplementation(async () => { finish({ success: true }); return true; });
    main.destroy.mockImplementation(async () => { finish({ success: true }); });
    const active = run();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'), { timeout: 10_000 });
    if (action === 'abort') await handler.handleMessage(message('abort', '/abort'));
    else await handler.destroy();
    await active;
    expect(main.execute).toHaveBeenCalledTimes(2);
    expect(response()).not.toMatchObject({ success: true });
    expect(await artifact()).toMatchObject({ disposition: 'pending' });
  });
});
