import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { MessageHandler } from '../../src/client/MessageHandler';
import { ThreadManager } from '../../src/thread/ThreadManager';
import { ThreadExecutorPool } from '../../src/thread/ThreadExecutorPool';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { DelegationManager } from '../../src/delegation/DelegationManager';
import { DelegatedWorkspaceManager } from '../../src/delegation/DelegatedWorkspaceManager';
import { BackendRegistry } from '../../src/delegation/BackendRegistry';
import type { DelegationConnection } from '../../src/delegation/contract';
import type { ExecuteOptions, ExecuteResult } from '../../src/executor/IExecutor';
import { gitText, runGit } from '../../src/delegation/GitCheckpoint';
import { gitFixture } from '../delegation/gitFixture';

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

  beforeEach(async () => {
    fixture = await gitFixture();
    vi.spyOn(os, 'homedir').mockReturnValue(fixture.directory);
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
      abort: vi.fn(async () => true), destroy: vi.fn(async () => undefined), waitForExit: vi.fn(async () => undefined),
      resetContext: vi.fn(), setWorkingDirectory: vi.fn(), getCurrentWorkingDirectory: () => cwd,
    }), new BackendRegistry(async () => 'fixture 1.0'));
    main.execute.mockImplementationOnce(async () => { await delegate(); return { success: true }; });
  });
  afterEach(async () => {
    await handler?.destroy(); vi.restoreAllMocks();
    await fs.rm(fixture.directory, { recursive: true, force: true });
  });

  it('rejects prose-only completion after two rounds and preserves the pending artifact', async () => {
    await run();
    expect(main.execute).toHaveBeenCalledTimes(3);
    expect(workerExecutions).toBe(1);
    expect(response()).toMatchObject({ success: false, error: expect.stringContaining(taskId) });
    expect(response().error).toContain('pending');
    expect(await artifact()).toMatchObject({ disposition: 'pending' });
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
    workerWork = async () => ({ success: true, output: 'Review only' });
    await run();
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
    await run();
    expect(main.execute).toHaveBeenCalledTimes(3);
    expect(response()).toMatchObject({ success: false, error: expect.stringContaining('unavailable') });
  });

  it('does not mistake failed collection for an empty worker result', async () => {
    vi.spyOn(DelegatedWorkspaceManager.prototype, 'collect').mockRejectedValue(new Error('Fixture storage failure'));
    await run();
    expect(main.execute).toHaveBeenCalledTimes(3);
    expect(response()).toMatchObject({ success: false, error: expect.stringContaining('unavailable') });
    expect(workerExecutions).toBe(1);
  });

  it('requires a deliberate retain for failed worker edits, without applying them', async () => {
    workerWork = async cwd => {
      await fs.writeFile(path.join(cwd, 'source.txt'), 'partial failed work\n');
      return { success: false, error: 'Fixture failure' };
    };
    main.execute.mockImplementationOnce(async () => {
      const view = await call('remote_cli_integrate', { taskId, action: 'inspect' });
      await expect(call('remote_cli_integrate', { taskId, action: 'apply', expectedRevision: view.revision })).rejects.toThrow('manual recovery');
      await retain();
      return { success: true };
    });
    await run();
    expect(main.execute).toHaveBeenCalledTimes(2);
    expect(response()).toMatchObject({ success: true });
    expect(await artifact()).toMatchObject({ successful: false, disposition: 'retained' });
    expect(await fs.readFile(path.join(fixture.root, 'source.txt'), 'utf8')).toBe('first\nsecond\nthird\n');
  });

  it('combines results and closeout but never resets the closeout budget for new workers', async () => {
    main.execute.mockReset().mockImplementation(async (prompt: string) => {
      if (workerExecutions) {
        expect(prompt).toContain('Fixture worker result');
        expect(prompt).toContain('artifact closeout');
      }
      await delegate(false);
      return { success: true };
    });
    await run();
    expect(main.execute).toHaveBeenCalledTimes(3);
    expect(workerExecutions).toBe(3);
    expect(response()).toMatchObject({ success: false, error: expect.stringContaining('after 2 rounds') });
    expect(response().error.match(/: pending/g) ?? []).toHaveLength(3);
  });

  it('preserves compact retry semantics without consuming another closeout round', async () => {
    main.compactWhenFull = vi.fn(async () => ({ success: true }));
    main.execute.mockResolvedValueOnce({ success: false, error: 'Prompt too long' })
      .mockImplementationOnce(async () => ({ success: true }))
      .mockImplementationOnce(async () => { await retain(); return { success: true }; });
    await run();
    expect(main.execute).toHaveBeenCalledTimes(4);
    expect(main.compactWhenFull).toHaveBeenCalledOnce();
    expect(main.execute.mock.calls[1][0]).toBe(main.execute.mock.calls[2][0]);
    expect(main.execute.mock.calls[3][0]).toContain('round 2 of 2');
    expect(response()).toMatchObject({ success: true });
    expect(workerExecutions).toBe(1);
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
