import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MessageHandler } from '../../src/client/MessageHandler';
import { ThreadManager } from '../../src/thread/ThreadManager';
import { isDelegationEnabled } from '../../src/thread/DelegationSettings';
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
      abort: vi.fn(async () => true), destroy: vi.fn(async () => undefined), waitForExit: vi.fn(async () => undefined), deleteThreadData: vi.fn(async () => undefined),
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

  it('makes default-on tools available on new and restored threads without automatically launching workers', async () => {
    const newThread = await threads.createThread('new-thread', home);
    const fresh = { ...main, execute: vi.fn(async () => ({ success: true })), configureDelegation: vi.fn() };
    otherExecutors.set(newThread.id, fresh);
    // Reload an existing thread whose stored metadata has never contained this preference.
    await handler.destroy();
    threads = await ThreadManager.initialize(home);
    const guard = new DirectoryGuard([home]);
    const config: any = { get: () => ({ type: 'codex' }), getAll: () => ({}), has: () => true, getConfigDir: () => home };
    pool = new ThreadExecutorPool(threads, guard, { type: 'codex' }, (_guard, _config, _cwd, id) => otherExecutors.get(id!) ?? main);
    handler = new MessageHandler(socket, pool, threads, guard, config);
    (handler as any).delegation = new DelegationManager(guard, () => worker, new BackendRegistry(async () => 'test 1.0'));
    main.execute.mockImplementationOnce(async () => {
      const discovery = await call('remote_cli_list_backends');
      expect(discovery.backends.some((backend: any) => backend.backend === 'dsh' && backend.worker)).toBe(true);
      return { success: true };
    });

    await handler.handleMessage(message('restored-default', 'Continue my saved conversation'));
    await handler.handleMessage({ ...message('new-default', 'Ordinary new-thread work'), threadId: newThread.id });

    for (const executor of [main, fresh]) {
      expect(executor.configureDelegation).toHaveBeenCalledWith(expect.objectContaining({ url: expect.any(String), token: expect.any(String) }));
      expect(executor.execute).toHaveBeenCalledWith(expect.stringContaining('Remote CLI delegation is enabled'), expect.anything());
    }
    expect(responseFor('restored-default')?.success).toBe(true);
    expect(responseFor('new-default')?.success).toBe(true);
    expect(worker.execute).not.toHaveBeenCalled();
    const saved = await ThreadManager.initialize(home);
    for (const thread of [saved.getDefaultThread(), saved.getThread(newThread.id)!]) {
      expect(thread.delegation).toBeUndefined();
      expect(thread.delegationBackends).toEqual(['codex']);
      expect(isDelegationEnabled(thread)).toBe(true);
    }
  });

  it('allows opting out before the first turn without reconfiguring unused native sessions', async () => {
    main.configureDelegation.mockRejectedValue(new Error('Unused native sessions must not be reconfigured'));
    await handler.handleMessage(message('disable', '/delegation off'));
    await handler.handleMessage(message('ordinary', 'Continue normally'));
    expect(responseFor('disable')?.success).toBe(true);
    expect(responseFor('ordinary')?.success).toBe(true);
    expect(main.execute).toHaveBeenCalledWith('Continue normally', expect.anything());
    expect(main.configureDelegation).not.toHaveBeenCalled();
    expect(worker.execute).not.toHaveBeenCalled();
    expect(threads.getDefaultThread().delegationBackends).toBeUndefined();
    expect((await ThreadManager.initialize(home)).getDefaultThread().delegation).toBe(false);
  });

  it('keeps explicitly disabled requests independent of delegation setup', async () => {
    await threads.updateThread(threads.getDefaultThread().id, { delegation: false });
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

  it('reports each thread delegation setting without initializing delegation', async () => {
    const delegatedThread = await threads.createThread('delegated', home);
    await threads.updateThread(delegatedThread.id, { delegation: true });
    const disabledThread = await threads.createThread('disabled', home);
    await threads.updateThread(disabledThread.id, { delegation: false });
    const delegated = { ...main, execute: vi.fn(), configureDelegation: vi.fn() };
    otherExecutors.set(delegatedThread.id, delegated);
    const discover = vi.spyOn(BackendRegistry.prototype, 'list');
    const begin = vi.spyOn(DelegationManager.prototype, 'begin');

    await handler.handleMessage(message('default-status', '/status'));
    await handler.handleMessage({ ...message('delegated-status', '/status'), threadId: delegatedThread.id });
    await handler.handleMessage({ ...message('disabled-status', '/status'), threadId: disabledThread.id });

    expect(responseFor('default-status')).toMatchObject({ success: true });
    expect(responseFor('default-status').output).toContain('Thread: default');
    expect(responseFor('default-status').output).toContain('Delegation: on (current thread)');
    expect(responseFor('delegated-status')).toMatchObject({ success: true });
    expect(responseFor('delegated-status').output).toContain('Thread: delegated');
    expect(responseFor('delegated-status').output).toContain('Delegation: on (current thread)');
    expect(responseFor('disabled-status').output).toContain('Delegation: off (current thread)');
    expect(discover).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
    expect(main.configureDelegation).not.toHaveBeenCalled();
    expect(delegated.configureDelegation).not.toHaveBeenCalled();
    expect(main.execute).not.toHaveBeenCalled();
    expect(delegated.execute).not.toHaveBeenCalled();
    expect(worker.execute).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(home, '.remote-cli', 'delegation'))).toBe(false);
    const saved = await ThreadManager.initialize(home);
    expect(saved.getDefaultThread().delegation).toBeUndefined();
    expect(saved.getThread(delegatedThread.id)?.delegation).toBe(true);
    expect(saved.getThread(disabledThread.id)?.delegation).toBe(false);
  });

  it('resets persisted worker lanes without changing the preference or direct conversation', async () => {
    const thread = threads.getDefaultThread();
    const delegated = (handler as any).delegation as DelegationManager;
    const acquired = await delegated.laneStore.acquire({
      threadId: thread.id,
      backend: 'codex',
      workingDirectory: home,
      workspaceGeneration: thread.delegationWorkspaceGeneration ?? 0,
    });
    await delegated.laneStore.markRunning(acquired.lane.id);
    await delegated.laneStore.markReady(acquired.lane.id);
    const pointer = path.join(home, '.remote-cli', 'codex-sessions', `${acquired.lane.executorThreadId}.json`);
    await fs.promises.mkdir(path.dirname(pointer), { recursive: true });
    await fs.promises.writeFile(pointer, '{"id":"worker"}');

    await handler.handleMessage(message('reset', '/delegation reset codex'));

    expect(responseFor('reset')).toMatchObject({ success: true, output: expect.stringContaining('1 lane removed') });
    await expect(delegated.laneStore.lanesForThread(thread.id, 'codex')).resolves.toEqual([]);
    expect(fs.existsSync(pointer)).toBe(false);
    expect(threads.getDefaultThread().delegation).toBeUndefined();
    expect(isDelegationEnabled(threads.getDefaultThread())).toBe(true);
    expect(main.configureDelegation).not.toHaveBeenCalled();
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
    await threads.updateThread(ordinaryThread.id, { delegation: false });
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

  it('rejects a same-backend tool call and still lets the coordinator obtain a different backend result', async () => {
    await handler.handleMessage(message('enable', '/delegation on'));
    expect(responseFor('enable').output).toContain('🤝 **Cross-backend delegation**');
    expect(responseFor('enable').output).toContain('**Backend availability**');
    expect(responseFor('enable').output).toContain('Same-backend delegation is disabled');
    main.execute.mockImplementationOnce(async () => {
      const discovery = await call('remote_cli_list_backends');
      expect(discovery.backends.find((item: any) => item.backend === 'codex')).toMatchObject({ worker: false });
      await expect(call('remote_cli_delegate', { backend: 'codex', objective: 'Inspect' }))
        .rejects.toThrow('Same-backend delegation is disabled');
      expect(worker.execute).not.toHaveBeenCalled();
      const task = await call('remote_cli_delegate', { backend: 'claude', objective: 'Inspect' });
      const result = await call('remote_cli_result', { taskId: task.taskId });
      expect(result).toMatchObject({ state: 'succeeded', output: 'child answer' });
      return { success: true, output: 'Verified cross-backend result' };
    });
    await handler.handleMessage(message('parent', 'Inspect this'));
    expect(responseFor('parent')).toMatchObject({ success: true });
    expect(worker.execute).toHaveBeenCalledOnce();
    expect(main.execute).toHaveBeenCalledOnce();
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

  it('sends child tool progress as nested updates when the Router advertises support', async () => {
    await handler.handleMessage({ type: 'binding_confirm', data: { success: true, capabilities: { delegationProgress: true } } } as any);
    await handler.handleMessage(message('enable', '/delegation on'));
    worker.execute.mockImplementationOnce(async (_prompt: string, options: ExecuteOptions) => {
      options.onToolUse?.({ id: 'inspect-1', name: 'Read', input: { file_path: 'README.md' } });
      options.onToolResult?.({ tool_use_id: 'inspect-1', content: 'complete', is_error: false });
      return { success: true, output: 'Nested review complete' };
    });
    main.execute.mockImplementationOnce(async () => {
      const task = await call('remote_cli_delegate', { backend: 'claude', objective: 'Review the README' });
      await call('remote_cli_result', { taskId: task.taskId });
      return { success: true, output: 'Coordinator conclusion' };
    });

    await handler.handleMessage(message('parent', 'Review this'));

    const progress = socket.send.mock.calls.map(([value]: any[]) => value)
      .filter((value: any) => value.messageId === 'parent' && value.streamType === 'delegation_progress');
    expect(progress.map((value: any) => value.delegationProgress.phase)).toEqual([
      'started', 'tool_use', 'tool_result', 'succeeded',
    ]);
    expect(progress.at(-1)?.delegationProgress).toMatchObject({
      backend: 'claude', summary: 'Nested review complete',
    });
    expect(socket.send.mock.calls.map(([value]: any[]) => value)
      .some((value: any) => value.messageId === 'parent' && value.streamType === 'tool_use')).toBe(false);
  });

  it('enables delegated worker text only after the Router confirms the additive capability', async () => {
    const manager = (handler as any).delegation as DelegationManager;
    const originalBegin = manager.begin.bind(manager);
    const parents: any[] = [];
    vi.spyOn(manager, 'begin').mockImplementation((parent: any) => {
      parents.push(parent);
      return originalBegin(parent);
    });

    await handler.handleMessage({ type: 'binding_confirm', data: { success: true, capabilities: { delegationProgress: true } } } as any);
    await handler.handleMessage(message('enable', '/delegation on'));
    await handler.handleMessage(message('baseline', 'Use a worker'));
    expect(parents.at(-1)?.onProgress).toEqual(expect.any(Function));
    expect(parents.at(-1)?.onTextProgress).toBeUndefined();

    await handler.handleMessage({ type: 'binding_confirm', data: { success: true, capabilities: {
      delegationProgress: true,
      delegationProgressText: true,
    } } } as any);
    await handler.handleMessage(message('latest', 'Use a worker again'));
    const textProgress = parents.at(-1)?.onTextProgress;
    expect(textProgress).toEqual(expect.any(Function));
    expect(textProgress({ taskId: 'worker-1', backend: 'claude', phase: 'text', latestText: 'Worker update' })).toBe(true);
    expect(socket.send.mock.calls.map(([value]: any[]) => value)).toContainEqual(expect.objectContaining({
      messageId: 'latest',
      streamType: 'delegation_progress',
      delegationProgress: expect.objectContaining({ phase: 'text', latestText: 'Worker update' }),
    }));
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

  it('cancels default-enabled children before acknowledging abort and permits the next task', async () => {
    expect(threads.getDefaultThread().delegation).toBeUndefined();
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

  it('waits for a verbose worker and resumes the coordinator with its conclusion before draining the queue', async () => {
    await handler.handleMessage(message('enable', '/delegation on'));
    fs.writeFileSync(path.join(home, 'stale.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cZYsAAAAASUVORK5CYII=', 'base64'));
    let finish!: (result: ExecuteResult) => void;
    let staleOptions!: ExecuteOptions;
    worker.execute.mockImplementationOnce((_prompt: string, options: ExecuteOptions) => new Promise(resolve => {
      options.onToolResult?.({ tool_use_id: 'research', content: 'Large evidence'.repeat(30000) });
      options.onStream?.('Research progress'.repeat(30000));
      finish = resolve;
    }));
    worker.abort.mockImplementation(async () => { finish({ success: false }); return true; });
    main.execute.mockImplementationOnce(async (_prompt: string, options: ExecuteOptions) => {
      staleOptions = options;
      options.onStream?.('Starting the review.');
      await call('remote_cli_delegate', { backend: 'claude', objective: 'Inspect' });
      options.onStream?.('Still waiting for the worker.');
      options.onPlanMode?.('A stale waiting plan');
      options.onImage?.({ type: 'image', data: 'c3RhbGU=', mimeType: 'image/png' });
      return { success: true, output: 'Still waiting for the worker.\n![stale image](./stale.png)' };
    }).mockImplementationOnce(async (prompt: string, options: ExecuteOptions) => {
      expect(prompt).toContain('Verified child result');
      expect(prompt).toContain('succeeded');
      expect(prompt).toContain('"truncated":true');
      expect(prompt).not.toContain('Unique original request');
      expect(options.attachments).toBeUndefined();
      staleOptions.onStream?.('Late stale waiting text');
      options.onStream?.('The review is complete.');
      return { success: true, output: 'The review is complete.' };
    });
    const attachments = [{ type: 'image' as const, data: 'aW1hZ2U=', mimeType: 'image/png' }];
    const active = handler.handleMessage({ ...message('parent', 'Unique original request'), attachments });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await vi.waitFor(async () => expect(await main.execute.mock.results[0].value).toMatchObject({ success: true }));
    expect(responseFor('parent')).toBeUndefined();
    expect(pool.isThreadBusy(threads.getDefaultThread().id)).toBe(true);
    expect(worker.abort).not.toHaveBeenCalled();
    await handler.handleMessage(message('next', 'Continue'));
    const confirmation = responseFor('next').queueConfirmation;
    await handler.handleMessage(message('confirm', `/queue confirm ${confirmation.id}`));
    expect(main.execute).toHaveBeenCalledTimes(1);
    finish({ success: true, output: `Review context\n${'x'.repeat(40 * 1024)}\nVerified child result` });
    await active;
    await vi.waitFor(() => expect(responseFor('next')?.success).toBe(true));
    expect(main.execute).toHaveBeenCalledTimes(3);
    expect(main.execute.mock.calls[0][1].attachments).toEqual(attachments);
    expect(worker.execute).toHaveBeenCalledOnce();
    expect(worker.destroy).toHaveBeenCalledOnce();
    expect(responseFor('parent').success).toBe(true);
    const output = socket.send.mock.calls.map(([value]: any[]) => value).filter((value: any) => value.messageId === 'parent');
    expect(JSON.stringify(output)).toContain('Starting the review.');
    expect(output).toContainEqual(expect.objectContaining({
      streamType: 'text', chunk: '\n🧩 Delegated results received. Preparing the reply...\n',
    }));
    expect(JSON.stringify(output)).toContain('The review is complete.');
    expect(JSON.stringify(output)).not.toMatch(/Still waiting|stale waiting|c3RhbGU=/);
    expect(output.some((value: any) => value.streamType === 'image')).toBe(false);
  });

  it('compacts a rejected result continuation without repeating the original work or attachments', async () => {
    await handler.handleMessage(message('enable', '/delegation on'));
    main.compactWhenFull = vi.fn(async () => {
      await expect(call('remote_cli_list_backends')).rejects.toThrow('No active delegation turn');
      return { success: true };
    });
    main.execute.mockImplementationOnce(async () => {
      await call('remote_cli_delegate', { backend: 'claude', objective: 'Inspect once' });
      return { success: true };
    }).mockResolvedValueOnce({ success: false, error: 'Prompt too long' })
      .mockImplementationOnce(async (prompt: string, options: ExecuteOptions) => {
        expect(prompt).toContain('child answer');
        expect(prompt).not.toContain('Original task marker');
        expect(options.attachments).toBeUndefined();
        options.onStream?.('The recovered summary.');
        return { success: true };
      });
    await handler.handleMessage({ ...message('parent', 'Original task marker'),
      attachments: [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }] });
    expect(main.execute).toHaveBeenCalledTimes(3);
    expect(main.execute.mock.calls[1][0]).toBe(main.execute.mock.calls[2][0]);
    expect(main.compactWhenFull).toHaveBeenCalledOnce();
    expect(worker.execute).toHaveBeenCalledOnce();
    expect(responseFor('parent')).toMatchObject({ success: true });
    const text = socket.send.mock.calls.map(([value]: any[]) => value)
      .filter((value: any) => value.messageId === 'parent' && value.streamType === 'text');
    expect(JSON.stringify(text)).toContain('The recovered summary.');
    expect(JSON.stringify(text)).not.toContain('Completed delegated results:');
  });

  it.each(['unavailable compaction', 'failed compaction', 'failed retry', 'exception'])
    ('displays retained worker results when continuation recovery ends with %s', async failure => {
      await handler.handleMessage(message('enable', '/delegation on'));
      if (failure !== 'unavailable compaction') {
        main.compactWhenFull = vi.fn(async () => ({ success: failure !== 'failed compaction', error: 'Compaction failed' }));
      }
      worker.execute.mockResolvedValueOnce({ success: true, output: 'Saved work\n```example\ncode\n```' });
      main.execute.mockImplementationOnce(async () => {
        await call('remote_cli_delegate', { backend: 'claude', objective: 'Inspect' });
        return { success: true };
      }).mockImplementation(async () => {
        if (failure === 'exception') throw new Error('Connection lost');
        return { success: false, error: 'Prompt too long' };
      });
      await handler.handleMessage(message('parent', 'Work'));
      expect(main.execute).toHaveBeenCalledTimes(failure === 'failed retry' ? 3 : 2);
      expect(worker.execute).toHaveBeenCalledOnce();
      expect(responseFor('parent')).toMatchObject({ success: false });
      const text = socket.send.mock.calls.map(([value]: any[]) => value)
        .filter((value: any) => value.messageId === 'parent' && value.streamType === 'text');
      expect(JSON.stringify(text)).toContain('Completed delegated results:');
      expect(JSON.stringify(text)).toContain('Saved work');
      expect(JSON.stringify(text)).toContain('````text');
    });

  it('retains explicitly fetched worker results when the coordinator fails before completing its reply', async () => {
    await handler.handleMessage(message('enable', '/delegation on'));
    main.execute.mockImplementationOnce(async () => {
      const child = await call('remote_cli_delegate', { backend: 'claude', objective: 'Inspect' });
      await call('remote_cli_result', { taskId: child.taskId });
      return { success: false, error: 'Connection lost' };
    });
    await handler.handleMessage(message('parent', 'Work'));
    expect(main.execute).toHaveBeenCalledOnce();
    expect(worker.execute).toHaveBeenCalledOnce();
    expect(responseFor('parent')).toMatchObject({ success: false, error: 'Connection lost' });
    const text = socket.send.mock.calls.map(([value]: any[]) => value)
      .filter((value: any) => value.messageId === 'parent' && value.streamType === 'text');
    expect(JSON.stringify(text)).toContain('Completed delegated results:');
    expect(JSON.stringify(text)).toContain('child answer');
  });

  it('acknowledges only the supplied batch when a continuation starts another worker', async () => {
    await handler.handleMessage(message('enable', '/delegation on'));
    worker.execute.mockResolvedValueOnce({ success: true, output: 'First worker result' })
      .mockResolvedValueOnce({ success: true, output: 'Second worker result' });
    main.execute.mockImplementationOnce(async () => {
      await call('remote_cli_delegate', { backend: 'claude', objective: 'First inspection' });
      return { success: true };
    }).mockImplementationOnce(async (prompt: string, options: ExecuteOptions) => {
      expect(prompt).toContain('First worker result');
      await call('remote_cli_delegate', { backend: 'claude', objective: 'Second inspection' });
      options.onStream?.('Premature second result summary');
      return { success: true };
    }).mockImplementationOnce(async (prompt: string, options: ExecuteOptions) => {
      expect(prompt).toContain('Second worker result');
      expect(prompt).not.toContain('First worker result');
      options.onStream?.('Both inspections completed.');
      return { success: true };
    });
    await handler.handleMessage(message('parent', 'Work'));
    expect(worker.execute).toHaveBeenCalledTimes(2);
    expect(main.execute).toHaveBeenCalledTimes(3);
    expect(responseFor('parent')).toMatchObject({ success: true });
    const text = socket.send.mock.calls.map(([value]: any[]) => value)
      .filter((value: any) => value.messageId === 'parent' && value.streamType === 'text');
    expect(JSON.stringify(text)).toContain('Both inspections completed.');
    expect(JSON.stringify(text)).not.toContain('Premature second result summary');
  });

  it('does not retry a continuation that launched another worker before failing', async () => {
    await handler.handleMessage(message('enable', '/delegation on'));
    main.compactWhenFull = vi.fn(async () => ({ success: true }));
    main.execute.mockImplementationOnce(async () => {
      await call('remote_cli_delegate', { backend: 'claude', objective: 'First inspection' });
      return { success: true };
    }).mockImplementationOnce(async () => {
      const child = await call('remote_cli_delegate', { backend: 'claude', objective: 'Second inspection' });
      await call('remote_cli_result', { taskId: child.taskId });
      return { success: false, error: 'Prompt too long' };
    });
    await handler.handleMessage(message('parent', 'Work'));
    expect(main.execute).toHaveBeenCalledTimes(2);
    expect(worker.execute).toHaveBeenCalledTimes(2);
    expect(main.compactWhenFull).not.toHaveBeenCalled();
    expect(responseFor('parent')).toMatchObject({ success: false, error: 'Prompt too long' });
  });

  it('does not resume or display failure results when aborted during continuation compaction', async () => {
    await handler.handleMessage(message('enable', '/delegation on'));
    let finishCompact!: (result: ExecuteResult) => void;
    main.compactWhenFull = vi.fn(() => new Promise(resolve => { finishCompact = resolve; }));
    main.abort.mockImplementation(async () => { finishCompact({ success: true }); return true; });
    main.execute.mockImplementationOnce(async () => {
      await call('remote_cli_delegate', { backend: 'claude', objective: 'Inspect' });
      return { success: true };
    }).mockResolvedValueOnce({ success: false, error: 'Prompt too long' });
    const active = handler.handleMessage(message('parent', 'Work'));
    await vi.waitFor(() => expect(finishCompact).toBeTypeOf('function'));
    await handler.handleMessage(message('abort', '/abort'));
    await active;
    expect(main.execute).toHaveBeenCalledTimes(2);
    expect(responseFor('parent')).toMatchObject({ success: false, error: expect.stringMatching(/cancel/i) });
    const text = socket.send.mock.calls.map(([value]: any[]) => value)
      .filter((value: any) => value.messageId === 'parent' && value.streamType === 'text');
    expect(JSON.stringify(text)).not.toContain('Completed delegated results:');
  });

  it('suppresses stale prose after child completion until its final result is retrieved', async () => {
    await handler.handleMessage(message('enable', '/delegation on'));
    main.execute.mockImplementationOnce(async (_prompt: string, options: ExecuteOptions) => {
      const task = await call('remote_cli_delegate', { backend: 'claude', objective: 'Inspect' });
      await vi.waitFor(() => expect(socket.send.mock.calls.some(([value]: any[]) => value.chunk?.includes('Completed</text_tag>'))).toBe(true));
      options.onStream?.('The worker is still running.');
      const result = await call('remote_cli_result', { taskId: task.taskId });
      options.onStream?.(`Final answer: ${result.output}`);
      return { success: true };
    });
    await handler.handleMessage(message('parent', 'Work'));
    expect(main.execute).toHaveBeenCalledOnce();
    const output = JSON.stringify(socket.send.mock.calls);
    expect(output).not.toContain('The worker is still running.');
    expect(output).toContain('Final answer: child answer');
  });

  it.each(['abort', 'shutdown'])('does not resume an early-returned coordinator after %s during host waiting', async action => {
    await handler.handleMessage(message('enable', '/delegation on'));
    let finish!: (result: ExecuteResult) => void;
    worker.execute.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    worker.abort.mockImplementation(async () => { finish({ success: false, error: 'Aborted' }); return true; });
    main.execute.mockImplementationOnce(async () => {
      await call('remote_cli_delegate', { backend: 'claude', objective: 'Wait' });
      return { success: true };
    });
    const active = handler.handleMessage(message('parent', 'Work'));
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await vi.waitFor(async () => expect(await main.execute.mock.results[0].value).toMatchObject({ success: true }));
    if (action === 'abort') await handler.handleMessage(message('abort', '/abort'));
    else await handler.destroy();
    await active;
    expect(main.execute).toHaveBeenCalledOnce();
    expect(responseFor('parent')).toMatchObject({ success: false, error: expect.stringMatching(/cancel/i) });
    if (action === 'abort') expect(responseFor('abort').success).toBe(true);
    expect(worker.destroy).toHaveBeenCalledOnce();
  });

  it('cancels unfinished children on coordinator failure without replaying the user request', async () => {
    await handler.handleMessage(message('enable', '/delegation on'));
    let finish!: (result: ExecuteResult) => void;
    worker.execute.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    worker.abort.mockImplementation(async () => { finish({ success: false }); return true; });
    main.compactWhenFull = vi.fn(async () => ({ success: true }));
    main.execute.mockImplementationOnce(async () => {
      await call('remote_cli_delegate', { backend: 'claude', objective: 'Inspect' });
      return { success: false, error: 'Prompt too long' };
    });
    await handler.handleMessage(message('parent', 'Work'));
    expect(main.execute).toHaveBeenCalledOnce();
    expect(main.compactWhenFull).not.toHaveBeenCalled();
    expect(worker.abort).toHaveBeenCalledOnce();
    expect(worker.destroy).toHaveBeenCalledOnce();
    expect(responseFor('parent')).toMatchObject({ success: false, error: 'Prompt too long' });
  });

  it.each(['failed', 'timed_out'])('hands a %s child result back to an early-returned coordinator without retrying the child', async state => {
    await handler.handleMessage(message('enable', '/delegation on'));
    if (state === 'failed') worker.execute.mockResolvedValue({ success: false, error: 'Quota exhausted' });
    else {
      const guard = new DirectoryGuard([home]);
      (handler as any).delegation = new DelegationManager(guard, () => worker, new BackendRegistry(async () => 'test 1.0'), undefined, 20);
      worker.execute.mockImplementationOnce(() => new Promise(() => undefined));
    }
    main.execute.mockImplementationOnce(async () => {
      await call('remote_cli_delegate', { backend: 'claude', objective: 'Inspect' });
      return { success: true };
    }).mockImplementationOnce(async (prompt: string, options: ExecuteOptions) => {
      expect(prompt).toContain(state);
      expect(prompt).toContain(state === 'failed' ? 'Quota exhausted' : 'without tool activity');
      const notices = socket.send.mock.calls.map(([value]: any[]) => value)
        .filter((value: any) => value.messageId === 'parent' && value.streamType === 'text')
        .map((value: any) => value.chunk).join('');
      expect(notices).toContain('Claude Code · Delegated task');
      if (state === 'failed') expect(notices).toContain('**Reason:** <raw>Quota exhausted</raw>');
      else expect(notices).toContain('**Reason:** <raw>Delegated task stopped after');
      options.onStream?.('The worker could not finish the request.');
      return { success: true };
    });
    await handler.handleMessage(message('parent', 'Work'));
    expect(main.execute).toHaveBeenCalledTimes(2);
    expect(worker.execute).toHaveBeenCalledOnce();
    expect(responseFor('parent')).toMatchObject({ success: true });
  });

  it('relays genuine coordinator questions emitted before the waiting flag is set while a child is active', async () => {
    await handler.handleMessage(message('enable', '/delegation on'));
    let waiting = false;
    let finishChild!: (result: ExecuteResult) => void;
    worker.execute.mockImplementationOnce(() => new Promise(resolve => { finishChild = resolve; }));
    worker.abort.mockImplementation(async () => { finishChild({ success: false }); return true; });
    main.isWaitingInput = () => waiting;
    main.execute.mockImplementationOnce(async (_prompt: string, options: ExecuteOptions) => {
      const task = await call('remote_cli_delegate', { backend: 'claude', objective: 'Inspect' });
      await new Promise<void>(resolve => {
        main.sendInput = vi.fn(() => { waiting = false; resolve(); return true; });
        options.onStream?.('Choose output language: A or B');
        waiting = true;
      });
      finishChild({ success: true, output: 'Complete' });
      await call('remote_cli_result', { taskId: task.taskId });
      options.onStream?.('Final answer');
      return { success: true };
    });
    const active = handler.handleMessage(message('parent', 'Work'));
    await vi.waitFor(() => expect(JSON.stringify(socket.send.mock.calls)).toContain('Choose output language'));
    await handler.handleMessage(message('input', 'A'));
    await active;
    expect(main.sendInput).toHaveBeenCalledWith('A');
    expect(main.execute).toHaveBeenCalledOnce();
    expect(responseFor('parent')).toMatchObject({ success: true });
  });

  it('rejects unsupported coordinators without changing the selected backend or ordinary execution', async () => {
    delete main.configureDelegation;
    await handler.handleMessage(message('enable', '/delegation on'));
    expect(responseFor('enable')).toMatchObject({ success: false, error: expect.stringContaining('does not support delegation') });
    expect(threads.getDefaultThread().delegation).toBeUndefined();
    await handler.handleMessage(message('ordinary', 'Ordinary work'));
    expect(main.execute).toHaveBeenLastCalledWith('Ordinary work', expect.anything());
    expect(worker.execute).not.toHaveBeenCalled();
    await handler.handleMessage(message('disable', '/delegation off'));
    expect(responseFor('disable')?.success).toBe(true);
    expect(threads.getDefaultThread().delegation).toBe(false);
  });
});
