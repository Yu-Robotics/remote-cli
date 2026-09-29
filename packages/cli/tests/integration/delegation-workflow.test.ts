import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MessageHandler } from '../../src/client/MessageHandler';
import { ThreadManager } from '../../src/thread/ThreadManager';
import { ThreadExecutorPool } from '../../src/thread/ThreadExecutorPool';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { DelegationManager } from '../../src/delegation/DelegationManager';
import { BackendRegistry } from '../../src/delegation/BackendRegistry';
import type { DelegationConnection } from '../../src/delegation/contract';
import type { ExecuteOptions, ExecuteResult } from '../../src/executor/IExecutor';

describe('delegation in the existing thread workflow', () => {
  let home: string;
  let threads: ThreadManager;
  let pool: ThreadExecutorPool;
  let handler: MessageHandler;
  let main: any;
  let worker: any;
  let socket: any;
  let otherExecutors: Map<string, any>;
  let connection: DelegationConnection | undefined;
  let callCounter = 0;

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await fetch(connection!.url, { method: 'POST',
      headers: { authorization: `Bearer ${connection!.token}` },
      body: JSON.stringify({ name, args, callId: `call-${++callCounter}` }) });
    const result = await response.json() as any;
    if (!response.ok) throw new Error(result.error);
    return result;
  };

  beforeEach(async () => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-workflow-')));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    threads = await ThreadManager.initialize(home);
    await threads.updateThread(threads.getDefaultThread().id, { workingDirectory: home });
    connection = undefined; callCounter = 0;
    main = { execute: vi.fn(async () => ({ success: true, output: 'answer' })),
      configureDelegation: vi.fn(async value => { connection = value; }),
      abort: vi.fn(async () => true), destroy: vi.fn(async () => undefined), resetContext: vi.fn(),
      setWorkingDirectory: vi.fn(async () => undefined), getCurrentWorkingDirectory: () => home };
    worker = { execute: vi.fn(async () => ({ success: true, output: 'child answer' })),
      abort: vi.fn(async () => true), destroy: vi.fn(async () => undefined), deleteThreadData: vi.fn(async () => undefined),
      resetContext: vi.fn(), setWorkingDirectory: vi.fn(), getCurrentWorkingDirectory: () => home };
    const guard = new DirectoryGuard([home]);
    const config: any = { get: vi.fn(key => key === 'executor' ? { type: 'codex' } : undefined),
      getAll: () => ({}), has: () => true, getConfigDir: () => home };
    otherExecutors = new Map();
    pool = new ThreadExecutorPool(threads, guard, { type: 'codex' }, (_guard, _config, _cwd, id) => otherExecutors.get(id!) ?? main);
    socket = { send: vi.fn(), trackTask: vi.fn(), hasPendingTaskResults: () => false, isConnected: () => true };
    handler = new MessageHandler(socket, pool, threads, guard, config);
    (handler as any).delegation = new DelegationManager(guard, () => worker, new BackendRegistry(async () => 'test 1.0'));
  });

  afterEach(async () => { await handler?.destroy(); vi.restoreAllMocks(); fs.rmSync(home, { recursive: true, force: true }); });

  const message = (id: string, content: string) => ({ type: 'command' as const, messageId: id, content, openId: 'owner', timestamp: Date.now() });
  const responseFor = (id: string) => socket.send.mock.calls.map(([value]: any[]) => value).reverse().find((value: any) => value.type === 'response' && value.messageId === id);

  it('keeps never-enabled requests and an explicit off command independent of delegation setup', async () => {
    main.configureDelegation.mockRejectedValue(new Error('Delegation setup must not run'));
    main.listModels = vi.fn(async () => []);
    main.execute.mockImplementation(async (prompt: string, options: ExecuteOptions) => {
      options.onStream?.(prompt);
      return { success: true };
    });
    await handler.handleMessage(message('first', 'Ordinary request'));
    await handler.handleMessage(message('disable', '/delegation off'));
    await handler.handleMessage(message('models', '/model'));
    await handler.handleMessage(message('second', 'Continue normally'));
    expect(main.execute.mock.calls.map(([prompt]: any[]) => prompt)).toEqual(['Ordinary request', 'Continue normally']);
    expect(main.configureDelegation).not.toHaveBeenCalled();
    expect(worker.execute).not.toHaveBeenCalled();
    expect(responseFor('first')?.success).toBe(true);
    expect(responseFor('disable')?.success).toBe(true);
    expect(responseFor('models')?.success).toBe(true);
    expect(responseFor('second')?.success).toBe(true);
    expect(threads.getDefaultThread().delegationBackends).toBeUndefined();
    expect(fs.existsSync(path.join(home, '.remote-cli', 'delegation'))).toBe(false);
  });

  it('restores owned cleanup across a CLI restart without touching an unused backend', async () => {
    await handler.handleMessage(message('enable', '/delegation on'));
    await handler.handleMessage(message('managed', 'Use this coordinator'));
    await handler.handleMessage(message('disable', '/delegation off'));
    const restored = await ThreadManager.initialize(home);
    expect(restored.getDefaultThread()).toMatchObject({ delegation: false, delegationBackends: ['codex'] });
    await handler.destroy();
    threads = restored;
    const guard = new DirectoryGuard([home]);
    const config: any = { get: () => ({ type: 'codex' }), getAll: () => ({}), has: () => true, getConfigDir: () => home };
    pool = new ThreadExecutorPool(threads, guard, { type: 'codex' }, () => main);
    handler = new MessageHandler(socket, pool, threads, guard, config);
    main.configureDelegation.mockClear();
    main.listModels = vi.fn(async () => []);
    await handler.handleMessage(message('models', '/model'));
    expect(main.listModels).toHaveBeenCalledOnce();
    expect(main.configureDelegation).toHaveBeenCalledWith(undefined);
    expect(main.configureDelegation.mock.invocationCallOrder[0]).toBeLessThan(main.listModels.mock.invocationCallOrder[0]);
    expect(responseFor('models')?.success).toBe(true);
    await handler.handleMessage(message('restored', 'Resume ordinary work'));
    expect(main.configureDelegation).toHaveBeenCalledWith(undefined);
    expect(main.execute).toHaveBeenLastCalledWith('Resume ordinary work', expect.anything());
    main.configureDelegation.mockClear();
    await pool.switchThreadBackend(threads.getDefaultThread().id, 'pi');
    await handler.handleMessage(message('unused', 'Use another backend normally'));
    expect(main.configureDelegation).not.toHaveBeenCalled();
    expect(responseFor('unused')?.success).toBe(true);
  });

  it('lets an opted-out thread execute in a workspace held by a delegated worker', async () => {
    await handler.handleMessage(message('enable', '/delegation on'));
    const ordinaryThread = await threads.createThread('ordinary', home);
    const ordinary = { ...main, execute: vi.fn(async () => ({ success: true })), configureDelegation: vi.fn() };
    otherExecutors.set(ordinaryThread.id, ordinary);
    let finish!: (result: ExecuteResult) => void;
    worker.execute.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    worker.abort.mockImplementation(async () => { finish?.({ success: false }); return true; });
    main.execute.mockImplementationOnce(async () => {
      const task = await call('remote_cli_delegate', { backend: 'claude', objective: 'Review' });
      await call('remote_cli_result', { taskId: task.taskId });
      return { success: true };
    });
    const active = handler.handleMessage(message('managed', 'Review'));
    await vi.waitFor(() => expect(worker.execute).toHaveBeenCalledOnce());
    await handler.handleMessage({ ...message('ordinary', 'Ordinary work'), threadId: ordinaryThread.id });
    expect(responseFor('ordinary')?.success).toBe(true);
    expect(ordinary.execute).toHaveBeenCalledWith('Ordinary work', expect.anything());
    expect(ordinary.configureDelegation).not.toHaveBeenCalled();
    expect(worker.abort).not.toHaveBeenCalled();
    finish({ success: true, output: 'Review complete' });
    await active;
    expect(responseFor('managed')?.success).toBe(true);
  });

  it('persists opt-in, returns child progress in the original reply, and drains the next queued message', async () => {
    await handler.handleMessage(message('enable', '/delegation on'));
    expect((await ThreadManager.initialize(home)).getDefaultThread().delegation).toBe(true);
    let finish!: (result: ExecuteResult) => void;
    worker.execute.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    worker.abort.mockImplementation(async () => { finish?.({ success: false, error: 'Aborted' }); return true; });
    main.execute.mockImplementationOnce(async () => {
      const task = await call('remote_cli_delegate', { backend: 'claude', objective: 'Review' });
      const result = await call('remote_cli_result', { taskId: task.taskId });
      expect(result.output).toBe('review complete');
      return { success: true };
    });
    const active = handler.handleMessage(message('parent', 'Review this'));
    await vi.waitFor(() => expect(worker.execute).toHaveBeenCalledOnce());
    await handler.handleMessage(message('next', 'Continue'));
    const confirmation = responseFor('next').queueConfirmation;
    await handler.handleMessage(message('confirm', `/queue confirm ${confirmation.id}`));
    expect(main.execute).toHaveBeenCalledTimes(1);
    finish({ success: true, output: 'review complete' });
    await active;
    await vi.waitFor(() => expect(responseFor('next')?.success).toBe(true));
    expect(main.execute).toHaveBeenCalledTimes(2);
    expect(worker.execute).toHaveBeenCalledTimes(1);
    expect(socket.send.mock.calls.map(([value]: any[]) => value).some((value: any) => value.messageId === 'parent' && value.streamType === 'tool_use')).toBe(true);
    await handler.handleMessage(message('disable', '/delegation off'));
    expect((await ThreadManager.initialize(home)).getDefaultThread().delegation).toBe(false);
    await handler.handleMessage(message('ordinary', 'Ordinary request'));
    expect(main.execute).toHaveBeenLastCalledWith('Ordinary request', expect.anything());
  });

  it('resends a child approval after registration and sends the decision only to the child', async () => {
    await handler.handleMessage(message('enable', '/delegation on'));
    await handler.handleMessage({ type: 'binding_confirm', data: { success: true, capabilities: { approvalCards: true } } } as any);
    let finish!: (result: ExecuteResult) => void;
    worker.execute.mockImplementationOnce((_prompt: string, options: ExecuteOptions) => new Promise(resolve => {
      finish = resolve;
      worker.respondToApproval = vi.fn((id: string) => { options.onApprovalResolved?.(id, 'approved'); finish({ success: true }); return true; });
      options.onApprovalRequest?.({ requestId: 'child-approval', kind: 'command', description: 'Write a file', canRemember: false });
    }));
    worker.abort.mockImplementation(async () => { finish?.({ success: false, error: 'Aborted' }); return true; });
    main.respondToApproval = vi.fn();
    main.execute.mockImplementationOnce(async () => {
      const task = await call('remote_cli_delegate', { backend: 'claude', objective: 'Work' });
      await call('remote_cli_result', { taskId: task.taskId });
      return { success: true };
    });
    const active = handler.handleMessage(message('parent', 'Work'));
    await vi.waitFor(() => expect(socket.send.mock.calls.some(([value]: any[]) => value.type === 'approval_request')).toBe(true));
    await handler.handleMessage({ type: 'binding_confirm', data: { success: true, capabilities: { approvalCards: true } } } as any);
    expect(socket.send.mock.calls.filter(([value]: any[]) => value.type === 'approval_request')).toHaveLength(2);
    await handler.handleMessage({ type: 'approval_response', messageId: 'child-approval', taskMessageId: 'parent',
      threadId: threads.getDefaultThread().id, openId: 'wrong-user', action: 'approve', timestamp: Date.now() } as any);
    expect(worker.respondToApproval).not.toHaveBeenCalled();
    await handler.handleMessage({ type: 'approval_response', messageId: 'child-approval', taskMessageId: 'parent',
      threadId: threads.getDefaultThread().id, openId: 'owner', action: 'remember', timestamp: Date.now() } as any);
    expect(worker.respondToApproval).not.toHaveBeenCalled();
    await handler.handleMessage({ type: 'approval_response', messageId: 'child-approval', taskMessageId: 'parent',
      threadId: threads.getDefaultThread().id, openId: 'owner', action: 'approve', timestamp: Date.now() } as any);
    await active;
    expect(worker.respondToApproval).toHaveBeenCalledWith('child-approval', 'approve');
    expect(main.respondToApproval).not.toHaveBeenCalled();
  });

  it('uses text approval for a delegated worker when an older Router advertises no card capability', async () => {
    await handler.handleMessage({ type: 'binding_confirm', data: { success: true } } as any);
    await handler.handleMessage(message('enable', '/delegation on'));
    let waiting = false;
    let cardSupported: boolean | undefined;
    worker.isWaitingInput = () => waiting;
    worker.execute.mockImplementationOnce((_prompt: string, options: ExecuteOptions) => new Promise(resolve => {
      waiting = true;
      worker.sendInput = vi.fn((input: string) => {
        if (input !== 'yes') return false;
        waiting = false;
        options.onApprovalResolved?.('legacy-approval', 'approved');
        resolve({ success: true, output: 'Approved worker result' });
        return true;
      });
      worker.abort.mockImplementation(async () => { waiting = false; resolve({ success: false }); return true; });
      cardSupported = options.onApprovalRequest?.({ requestId: 'legacy-approval', kind: 'command', description: 'Write a file', canRemember: false });
      if (!cardSupported) options.onStream?.('Approval required: Write a file. Reply yes or no.');
    }));
    main.sendInput = vi.fn();
    main.execute.mockImplementationOnce(async (_prompt: string, options: ExecuteOptions) => {
      const task = await call('remote_cli_delegate', { backend: 'claude', objective: 'Work' });
      const result = await call('remote_cli_result', { taskId: task.taskId });
      options.onStream?.(result.output);
      return { success: true, output: result.output };
    });
    const active = handler.handleMessage(message('parent', 'Work'));
    await vi.waitFor(() => expect(socket.send.mock.calls.some(([value]: any[]) =>
      value.type === 'stream' && value.messageId === 'parent' && value.chunk?.includes('Approval required:'))).toBe(true));
    expect(cardSupported).toBe(false);
    await handler.handleMessage(message('answer', 'yes'));
    await active;
    expect(worker.sendInput).toHaveBeenCalledWith('yes');
    expect(main.sendInput).not.toHaveBeenCalled();
    expect(responseFor('parent')).toMatchObject({ success: true });
    expect(socket.send.mock.calls.some(([value]: any[]) =>
      value.type === 'stream' && value.messageId === 'parent' && value.chunk === 'Approved worker result')).toBe(true);
    expect(socket.send.mock.calls.some(([value]: any[]) => value.type === 'approval_request' || value.type === 'approval_resolved')).toBe(false);
  });

  it('cancels children before acknowledging abort and permits the next ordinary task', async () => {
    await handler.handleMessage(message('enable', '/delegation on'));
    let finishWorker!: (result: ExecuteResult) => void;
    let finishMain!: (result: ExecuteResult) => void;
    worker.execute.mockImplementationOnce(() => new Promise(resolve => { finishWorker = resolve; }));
    worker.abort.mockImplementation(async () => { finishWorker({ success: false, error: 'Aborted' }); return true; });
    main.execute.mockImplementationOnce(async () => {
      await call('remote_cli_delegate', { backend: 'pi', objective: 'Wait' });
      return new Promise(resolve => { finishMain = resolve; });
    });
    main.abort.mockImplementation(async () => { finishMain({ success: false, error: 'Aborted' }); return true; });
    const active = handler.handleMessage(message('parent', 'Work'));
    await vi.waitFor(() => expect(finishMain).toBeTypeOf('function'));
    await handler.handleMessage(message('abort', '/abort'));
    await active;
    expect(worker.destroy).toHaveBeenCalledOnce();
    expect(responseFor('abort').success).toBe(true);
    await handler.handleMessage(message('later', 'Continue'));
    expect(responseFor('later').success).toBe(true);
  });

  it('returns a worker question through the parent card and routes the answer to that worker', async () => {
    await handler.handleMessage(message('enable', '/delegation on'));
    let waiting = false;
    worker.isWaitingInput = () => waiting;
    worker.execute.mockImplementationOnce((_prompt: string, options: ExecuteOptions) => new Promise(resolve => {
      worker.sendInput = vi.fn(() => { waiting = false; resolve({ success: true, output: 'Selected A' }); return true; });
      options.onStream?.('Choose A or B');
      waiting = true;
      worker.abort.mockImplementation(async () => { waiting = false; resolve({ success: false }); return true; });
    }));
    main.execute.mockImplementationOnce(async () => {
      const task = await call('remote_cli_delegate', { backend: 'pi', objective: 'Ask a question' });
      await call('remote_cli_result', { taskId: task.taskId });
      return { success: true };
    });
    const active = handler.handleMessage(message('parent', 'Choose'));
    await vi.waitFor(() => expect(socket.send.mock.calls.some(([value]: any[]) => value.messageId === 'parent' && JSON.stringify(value).includes('Choose A or B'))).toBe(true));
    await handler.handleMessage(message('input', 'A'));
    await active;
    expect(worker.sendInput).toHaveBeenCalledWith('A');
    expect(main.execute).toHaveBeenCalledOnce();
  });

  it('cleans unfinished children when the parent ends without waiting for a result', async () => {
    await handler.handleMessage(message('enable', '/delegation on'));
    worker.execute.mockImplementationOnce(() => new Promise(() => undefined));
    main.execute.mockImplementationOnce(async () => {
      await call('remote_cli_delegate', { backend: 'codex', objective: 'Inspect' });
      return { success: true };
    });
    await handler.handleMessage(message('parent', 'Work'));
    expect(worker.abort).toHaveBeenCalledOnce();
    expect(worker.destroy).toHaveBeenCalledOnce();
    expect(responseFor('parent').success).toBe(true);
    await handler.handleMessage(message('next', 'Continue'));
    expect(responseFor('next').success).toBe(true);
  });

  it('rejects unsupported coordinators without changing the selected backend or ordinary execution', async () => {
    delete main.configureDelegation;
    await handler.handleMessage(message('enable', '/delegation on'));
    expect(responseFor('enable')).toMatchObject({ success: false, error: expect.stringContaining('does not support delegation') });
    expect(threads.getDefaultThread().delegation).not.toBe(true);
    await handler.handleMessage(message('ordinary', 'Ordinary work'));
    expect(main.execute).toHaveBeenLastCalledWith('Ordinary work', expect.anything());
    expect(worker.execute).not.toHaveBeenCalled();
  });
});
