import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DELEGATION_TEXT_PROGRESS, DelegationManager, type DelegationParent } from '../../src/delegation/DelegationManager';
import { BackendRegistry, type BackendAvailability } from '../../src/delegation/BackendRegistry';
import { DelegationStore } from '../../src/delegation/DelegationStore';
import { DelegatedWorkerSessionStore } from '../../src/delegation/DelegatedWorkerSessionStore';
import { DELEGATION_BACKENDS } from '../../src/delegation/contract';
import { workerConfiguration } from '../../src/delegation/WorkerPolicy';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import type { ExecuteOptions, ExecuteResult, IExecutor } from '../../src/executor/IExecutor';

const wait = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

describe('cross-backend delegation', () => {
  let home: string;
  let guard: DirectoryGuard;
  let manager: DelegationManager;
  let parent: DelegationParent;
  let worker: IExecutor;
  let factory: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-test-')));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    guard = new DirectoryGuard([home]);
    worker = {
      execute: vi.fn().mockResolvedValue({ success: true, output: 'review complete' }),
      abort: vi.fn().mockResolvedValue(true), destroy: vi.fn().mockResolvedValue(undefined),
      waitForExit: vi.fn().mockResolvedValue(undefined),
      deleteThreadData: vi.fn().mockResolvedValue(undefined), resetContext: vi.fn(),
      getCurrentWorkingDirectory: () => home, setWorkingDirectory: vi.fn(),
    };
    factory = vi.fn(() => worker);
    manager = new DelegationManager(guard, factory as any, new BackendRegistry(async () => 'test 1.0'));
    parent = { thread: { id: 'owner', name: 'default', workingDirectory: home, sessionId: null,
      createdAt: 0, lastActiveAt: 0, models: { codex: 'codex-model', claude: 'claude-model', pi: 'provider/model',
        agy: 'agy-model', opencode: 'opencode/model', kimi: 'kimi-model', zcode: 'zcode-model' } },
    cwd: home, messageId: 'message-1', backend: 'claude', config: { type: 'auto' },
    onToolUse: vi.fn(), onToolResult: vi.fn(), onNotice: vi.fn(), onApproval: vi.fn(() => true), onApprovalResolved: vi.fn() };
  });

  afterEach(async () => { await manager.destroy(); vi.restoreAllMocks(); fs.rmSync(home, { recursive: true, force: true }); });

  it.each(DELEGATION_BACKENDS)('rejects same-backend %s delegation before creating a worker or reserving the workspace', async backend => {
    parent.backend = backend;
    const scope = manager.begin(parent);
    const discovery = await scope.invoke('remote_cli_list_backends', {}, 'list') as { backends: BackendAvailability[] };
    expect(discovery.backends.find(item => item.backend === backend)).toMatchObject({
      installed: true, coordinator: true, worker: false, readOnly: false,
      reason: expect.stringContaining('Same-backend delegation is disabled'),
    });
    expect(discovery.backends.filter(item => item.backend !== backend).every(item => item.worker)).toBe(true);
    for (const mode of [undefined, 'inherit', 'read_only']) {
      await expect(scope.invoke('remote_cli_delegate', { backend, objective: 'Inspect', ...(mode ? { mode } : {}) }, `same-${mode}`))
        .rejects.toThrow('Same-backend delegation is disabled');
    }
    expect(factory).not.toHaveBeenCalled();
    expect(parent.onToolUse).not.toHaveBeenCalled();
    expect(scope.hasTasks()).toBe(false);
    expect(scope.getLaunchRevision()).toBe(0);
    expect(manager.blocksWorkspace(home, 'other')).toBe(false);
    expect(fs.existsSync(path.join(home, '.remote-cli', 'delegation'))).toBe(false);
    const other = DELEGATION_BACKENDS.find(item => item !== backend)!;
    const task: any = await scope.invoke('remote_cli_delegate', { backend: other, objective: 'Inspect' }, 'other');
    await expect(scope.invoke('remote_cli_result', { taskId: task.taskId }, 'result')).resolves.toMatchObject({ state: 'succeeded' });
  });

  it.each(DELEGATION_BACKENDS.flatMap(main => DELEGATION_BACKENDS.filter(child => child !== main).map(child => [main, child] as const)))
  ('returns a %s coordinator\'s %s child result without reusing the primary session', async (main, child) => {
    parent.backend = main;
    const scope = manager.begin(parent);
    const started: any = await scope.invoke('remote_cli_delegate', { backend: child, objective: 'Review the patch' }, 'start');
    const result: any = await scope.invoke('remote_cli_result', { taskId: started.taskId }, 'result');
    expect(result).toMatchObject({ state: 'succeeded', output: 'review complete', backend: child });
    expect(factory.mock.calls[0][3]).toMatch(/^delegate-lane-/);
    expect(factory.mock.calls[0][3]).not.toBe(parent.thread.id);
    expect(factory.mock.calls[0][4]).toBe(parent.thread.models![child]);
    expect(factory.mock.calls[0][6]).toEqual({ lifecycleHooks: false, delegationWorker: true });
    if (child === 'claude' || child === 'codex') {
      expect(factory.mock.calls[0][1][child].sandbox).toEqual({ mode: 'danger-full-access' });
    }
    expect(worker.deleteThreadData).not.toHaveBeenCalled();
    expect(parent.onToolUse).toHaveBeenCalledTimes(1);
    expect(parent.onToolResult).toHaveBeenCalledTimes(1);
    const record = JSON.parse(fs.readFileSync(path.join(home, '.remote-cli', 'delegation', `${started.taskId}.json`), 'utf8'));
    expect(record).toMatchObject({ threadId: 'owner', parentMessageId: 'message-1', state: 'succeeded' });
  });

  it('emits bounded nested progress instead of flat child tool cards when the parent supports it', async () => {
    const onProgress = vi.fn(() => true);
    parent.onProgress = onProgress;
    vi.mocked(worker.execute).mockImplementationOnce(async (_prompt, options) => {
      options.onToolUse?.({ id: 'read-1', name: 'Read', input: { file_path: 'README.md', payload: 'x'.repeat(100_000) } });
      options.onToolResult?.({ tool_use_id: 'read-1', content: 'x'.repeat(100_000), is_error: false });
      return { success: true, output: 'Review complete' };
    });

    const scope = manager.begin(parent);
    const task: any = await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Review the README' }, 'start');
    await expect(scope.invoke('remote_cli_result', { taskId: task.taskId }, 'result')).resolves.toMatchObject({ state: 'succeeded' });

    expect(onProgress.mock.calls.map(([progress]) => progress.phase)).toEqual([
      'started', 'tool_use', 'tool_result', 'succeeded',
    ]);
    expect(onProgress.mock.calls[1][0].toolUse).toEqual({ id: 'read-1', name: 'Read', input: {} });
    expect(onProgress.mock.calls[2][0].toolResult).toEqual({ tool_use_id: 'read-1', content: '', is_error: false });
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({
      taskId: task.taskId,
      backend: 'codex',
      phase: 'succeeded',
      summary: 'Review complete',
    }));
    expect(parent.onToolUse).not.toHaveBeenCalled();
    expect(parent.onToolResult).not.toHaveBeenCalled();
    expect(parent.onNotice).not.toHaveBeenCalled();
  });

  it('buffers worker text as display-only nested progress without treating it as task activity', async () => {
    vi.useFakeTimers();
    const onTextProgress = vi.fn(() => true);
    parent.onProgress = vi.fn(() => true);
    parent.onTextProgress = onTextProgress;
    let finish!: (result: ExecuteResult) => void;
    let options!: ExecuteOptions;
    vi.mocked(worker.execute).mockImplementation((_prompt, receivedOptions) => {
      options = receivedOptions;
      return new Promise(resolve => { finish = resolve; });
    });

    try {
      const scope = manager.begin(parent);
      const task: any = await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Review the README' }, 'start');
      await vi.waitFor(() => expect(options).toBeDefined());
      options.onStream?.('Private reasoning must not appear.');
      options.onDisplayText?.('First bounded worker update.');
      await Promise.resolve();
      expect(onTextProgress).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2_500);
      expect(onTextProgress).toHaveBeenCalledWith(expect.objectContaining({
        taskId: task.taskId,
        backend: 'codex',
        phase: 'text',
        latestText: 'First bounded worker update.',
      }));
      expect(JSON.stringify(onTextProgress.mock.calls)).not.toContain('Private reasoning');
      expect(parent.onProgress).not.toHaveBeenCalledWith(expect.objectContaining({ phase: 'text' }));

      finish({ success: true, output: 'Review complete' });
      await expect(scope.invoke('remote_cli_result', { taskId: task.taskId }, 'result')).resolves.toMatchObject({ state: 'succeeded' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not resurrect text emitted before a tool starts in the same event turn', async () => {
    vi.useFakeTimers();
    const onTextProgress = vi.fn(() => true);
    parent.onProgress = vi.fn(() => true);
    parent.onTextProgress = onTextProgress;
    let finish!: (result: ExecuteResult) => void;
    let options!: ExecuteOptions;
    vi.mocked(worker.execute).mockImplementation((_prompt, receivedOptions) => {
      options = receivedOptions;
      return new Promise(resolve => { finish = resolve; });
    });

    try {
      const scope = manager.begin(parent);
      const task: any = await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Inspect' }, 'start');
      await vi.waitFor(() => expect(options).toBeDefined());
      options.onStream?.('Old generic stream.');
      options.onDisplayText?.('Old assistant text.');
      options.onToolUse?.({ id: 'tool-1', name: 'Read', input: {} });
      await vi.advanceTimersByTimeAsync(DELEGATION_TEXT_PROGRESS.flushMs);
      expect(onTextProgress).not.toHaveBeenCalled();

      options.onToolResult?.({ tool_use_id: 'tool-1', content: '', is_error: false });
      options.onDisplayText?.('Fresh assistant text.');
      await vi.advanceTimersByTimeAsync(DELEGATION_TEXT_PROGRESS.flushMs);
      expect(onTextProgress).toHaveBeenCalledWith(expect.objectContaining({ latestText: 'Fresh assistant text.' }));

      finish({ success: true, output: 'Done' });
      await scope.invoke('remote_cli_result', { taskId: task.taskId }, 'result');
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries later display text after a transient delivery failure', async () => {
    vi.useFakeTimers();
    const onTextProgress = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    parent.onProgress = vi.fn(() => true);
    parent.onTextProgress = onTextProgress;
    let finish!: (result: ExecuteResult) => void;
    let options!: ExecuteOptions;
    vi.mocked(worker.execute).mockImplementation((_prompt, receivedOptions) => {
      options = receivedOptions;
      return new Promise(resolve => { finish = resolve; });
    });

    try {
      const scope = manager.begin(parent);
      const task: any = await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Inspect' }, 'start');
      await vi.waitFor(() => expect(options).toBeDefined());
      options.onDisplayText?.('First update.');
      await vi.advanceTimersByTimeAsync(DELEGATION_TEXT_PROGRESS.flushMs);
      options.onDisplayText?.(' Second update.');
      await vi.advanceTimersByTimeAsync(DELEGATION_TEXT_PROGRESS.flushMs);
      expect(onTextProgress).toHaveBeenCalledTimes(2);
      expect(onTextProgress).toHaveBeenLastCalledWith(expect.objectContaining({ latestText: 'First update. Second update.' }));

      finish({ success: true, output: 'Done' });
      await scope.invoke('remote_cli_result', { taskId: task.taskId }, 'result');
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the legacy Claude model when no per-backend model is saved', async () => {
    parent.backend = 'codex';
    parent.thread.model = 'legacy-claude-model';
    delete parent.thread.models?.claude;
    const scope = manager.begin(parent);
    const started: any = await scope.invoke('remote_cli_delegate', { backend: 'claude', objective: 'Review' }, 'start');
    await scope.invoke('remote_cli_result', { taskId: started.taskId }, 'result');
    expect(factory.mock.calls[0][4]).toBe('legacy-claude-model');
  });

  it('retains completed results until a coordinator execution successfully consumes them', async () => {
    let finish!: (result: ExecuteResult) => void;
    vi.mocked(worker.execute).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const scope = manager.begin(parent);
    expect(scope.hasTasks()).toBe(false);
    const task: any = await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Inspect' }, 'start');
    expect(scope.hasTasks()).toBe(true);
    await expect(scope.invoke('remote_cli_result', { taskId: task.taskId, waitSeconds: 0 }, 'poll'))
      .resolves.toMatchObject({ state: 'running' });
    expect(scope.hasPendingResults()).toBe(true);
    await vi.waitFor(() => expect(worker.execute).toHaveBeenCalled());
    finish({ success: true, output: 'Terminal result' });
    await vi.waitFor(() => expect(parent.onNotice).toHaveBeenCalledWith(expect.stringContaining('Completed')));
    expect(scope.hasPendingResults()).toBe(true);
    await expect(scope.collectPendingResults()).resolves.toEqual([
      expect.objectContaining({ taskId: task.taskId, state: 'succeeded', output: 'Terminal result' }),
    ]);
    expect(scope.hasPendingResults()).toBe(true);
    scope.beginExecution([task.taskId]);
    expect(scope.hasPendingResults()).toBe(false);
    expect(scope.getRetainedResults()).toHaveLength(1);
    scope.finishExecution(false);
    expect(scope.hasPendingResults()).toBe(true);
    scope.beginExecution();
    await scope.invoke('remote_cli_result', { taskId: task.taskId }, 'receive');
    expect(scope.hasPendingResults()).toBe(false);
    expect(scope.getRetainedResults()).toHaveLength(1);
    scope.finishExecution(true);
    expect(scope.getRetainedResults()).toEqual([]);
    await expect(scope.collectPendingResults()).resolves.toEqual([]);
  });

  it('includes an in-flight launch in the completion barrier before any worker exists', async () => {
    let discover!: (version: string) => void;
    let finish!: (result: ExecuteResult) => void;
    manager = new DelegationManager(guard, factory as any, new BackendRegistry(() => new Promise(resolve => { discover = resolve; })));
    vi.mocked(worker.execute).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const scope = manager.begin(parent);
    const launch = scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Inspect' }, 'start');
    const collected = scope.collectPendingResults();
    expect(scope.hasPendingResults()).toBe(true);
    expect(scope.getLaunchRevision()).toBe(1);
    expect(factory).not.toHaveBeenCalled();
    discover('1.0');
    await launch;
    expect(scope.hasPendingResults()).toBe(true);
    await vi.waitFor(() => expect(worker.execute).toHaveBeenCalled());
    finish({ success: true, output: 'Launched before the barrier' });
    await expect(collected).resolves.toEqual([
      expect.objectContaining({ state: 'succeeded', output: 'Launched before the barrier' }),
    ]);
  });

  it('does not acknowledge a late tool response as part of a later coordinator execution', async () => {
    let finish!: (result: ExecuteResult) => void;
    vi.mocked(worker.execute).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const scope = manager.begin(parent);
    const task: any = await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Inspect' }, 'start');
    const response = scope.invoke('remote_cli_result', { taskId: task.taskId }, 'pending-result');
    scope.finishExecution(true);
    scope.beginExecution();
    await vi.waitFor(() => expect(worker.execute).toHaveBeenCalled());
    finish({ success: true, output: 'Late worker result' });
    await response;
    scope.finishExecution(true);
    expect(scope.hasPendingResults()).toBe(true);
    expect(scope.getRetainedResults()).toEqual([
      expect.objectContaining({ taskId: task.taskId, output: 'Late worker result' }),
    ]);
  });

  it('bounds the aggregate continuation while retaining every task status and the full tool result', async () => {
    const output = `Review context\n${'"\\\n'.repeat(6000)}\nVerified conclusion`;
    vi.mocked(worker.execute).mockResolvedValue({ success: true, output });
    const scope = manager.begin(parent);
    const ids: string[] = [];
    for (let index = 0; index < 12; index++) {
      const task: any = await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Inspect' }, `start-${index}`);
      ids.push(task.taskId);
      await vi.waitFor(() => expect(parent.onNotice).toHaveBeenCalledTimes(index + 1));
    }
    const results = await scope.collectPendingResults();
    expect(results.map(result => result.taskId)).toEqual(ids);
    expect(results.every(result => result.state === 'succeeded' && result.truncated)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(results))).toBeLessThanOrEqual(64 * 1024);
    for (const result of results) {
      expect(result.output).toMatch(/^Review context\n/);
      expect(result.output).toMatch(/\nVerified conclusion$/);
    }
    await expect(scope.invoke('remote_cli_result', { taskId: ids[0] }, 'full'))
      .resolves.toMatchObject({ output, truncated: false });
  });

  it('finishes the completion barrier when task metadata pruning stalls after confirmed worker exit', async () => {
    const store = new DelegationStore();
    vi.spyOn(store, 'prune').mockImplementation(() => new Promise(() => undefined));
    manager = new DelegationManager(guard, factory as any, new BackendRegistry(async () => '1.0'), store, 1000, 20);
    const scope = manager.begin(parent);
    await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Inspect' }, 'start');
    await expect(scope.collectPendingResults()).resolves.toEqual([expect.objectContaining({ state: 'succeeded' })]);
    expect(manager.blocksWorkspace(home, 'other')).toBe(false);
  });

  it('does not launch a worker when its initial task record cannot be persisted', async () => {
    const store = new DelegationStore(path.join(home, 'failed-records'));
    vi.spyOn(store, 'write').mockRejectedValue(new Error('Disk is full'));
    manager = new DelegationManager(guard, factory as any, new BackendRegistry(async () => '1.0'), store);
    const scope = manager.begin(parent);
    await expect(scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Edit files' }, 'start'))
      .rejects.toThrow('Disk is full');
    expect(factory).not.toHaveBeenCalled();
    expect(manager.blocksWorkspace(home, 'other')).toBe(false);
  });

  it('records a terminal failure when durable worker lane storage fails', async () => {
    const store = new DelegationStore();
    const laneStore = new DelegatedWorkerSessionStore(path.join(home, '.remote-cli', 'delegation-workers'));
    vi.spyOn(laneStore, 'acquire').mockRejectedValue(new Error('Lane disk is full'));
    manager = new DelegationManager(guard, factory as any, new BackendRegistry(async () => '1.0'),
      store, 1000, 10_000, laneStore);
    const scope = manager.begin(parent);

    await expect(scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Inspect' }, 'start'))
      .rejects.toThrow('Lane disk is full');

    const files = fs.readdirSync(path.join(home, '.remote-cli', 'delegation'));
    expect(files).toHaveLength(1);
    const record = JSON.parse(fs.readFileSync(path.join(home, '.remote-cli', 'delegation', files[0]), 'utf8'));
    expect(record).toMatchObject({ state: 'failed', error: 'Lane disk is full' });
    expect(typeof record.finishedAt).toBe('number');
    expect(factory).not.toHaveBeenCalled();
    expect(manager.blocksWorkspace(home, 'other')).toBe(false);
  });

  it('releases the workspace when worker construction fails before a process is created', async () => {
    factory.mockImplementation(() => { throw new Error('Worker construction failed'); });
    const scope = manager.begin(parent);
    const task: any = await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Inspect' }, 'start');
    await expect(scope.invoke('remote_cli_result', { taskId: task.taskId }, 'result')).resolves.toMatchObject({
      state: 'failed', error: 'Worker construction failed',
    });
    expect(manager.blocksWorkspace(home, 'other')).toBe(false);
    await expect(manager.laneStore.lanesForThread(parent.thread.id, 'codex')).resolves.toEqual([]);
  });

  it('discards a reserved lane when cancellation wins before worker construction', async () => {
    const laneStore = new DelegatedWorkerSessionStore(path.join(home, '.remote-cli', 'delegation-workers'));
    const acquireLane = laneStore.acquire.bind(laneStore);
    let acquired!: () => void;
    let release!: () => void;
    const acquisitionStarted = new Promise<void>(resolve => { acquired = resolve; });
    const releaseAcquisition = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(laneStore, 'acquire').mockImplementation(async identity => {
      const lane = await acquireLane(identity);
      acquired();
      await releaseAcquisition;
      return lane;
    });
    manager = new DelegationManager(guard, factory as any, new BackendRegistry(async () => '1.0'),
      new DelegationStore(), 1000, 10_000, laneStore);
    const scope = manager.begin(parent);
    const launch = scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Inspect' }, 'start');
    await acquisitionStarted;
    const close = scope.close();
    release();
    await Promise.all([launch, close]);

    expect(factory).not.toHaveBeenCalled();
    expect(manager.blocksWorkspace(home, 'other')).toBe(false);
    await expect(laneStore.lanesForThread(parent.thread.id, 'codex')).resolves.toEqual([]);
  });

  it('deduplicates a replayed call and rejects a reused ID with changed arguments', async () => {
    const scope = manager.begin(parent);
    const args = { backend: 'codex', objective: 'Inspect' };
    const [first, replay] = await Promise.all([
      scope.invoke('remote_cli_delegate', args, 'same'), scope.invoke('remote_cli_delegate', args, 'same'),
    ]);
    expect(first).toEqual(replay);
    expect(factory).toHaveBeenCalledTimes(1);
    await expect(scope.invoke('remote_cli_delegate', { ...args, objective: 'Different' }, 'same')).rejects.toThrow('reused');
  });

  it('cancels and cleans up a running worker before releasing the parent', async () => {
    let finish!: (result: ExecuteResult) => void;
    vi.mocked(worker.execute).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    vi.mocked(worker.abort).mockImplementation(async () => { finish({ success: false, error: 'Aborted' }); return true; });
    const scope = manager.begin(parent);
    const task: any = await scope.invoke('remote_cli_delegate', { backend: 'pi', objective: 'Wait' }, 'start');
    await manager.cancelThread(parent.thread.id);
    expect(worker.abort).toHaveBeenCalledTimes(1);
    expect(worker.destroy).toHaveBeenCalledTimes(1);
    expect(parent.onToolResult).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('cancelled'), tool_use_id: task.taskId,
    }));
    await expect(scope.invoke('remote_cli_list_backends', {}, 'late')).rejects.toThrow('ended');
    const next = manager.begin(parent);
    await next.close();
  });

  it('does not launch work after the parent is cancelled during discovery', async () => {
    let finish!: (value: string) => void;
    manager = new DelegationManager(guard, factory as any, new BackendRegistry(() => new Promise(resolve => { finish = resolve; })));
    const scope = manager.begin(parent);
    const starting = scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Inspect' }, 'start');
    const failure = expect(starting).rejects.toThrow('ended');
    await scope.close();
    finish('1.0');
    await failure;
    expect(factory).not.toHaveBeenCalled();
  });

  it('reports a deleted working directory instead of a raw filesystem error and registers no scope', () => {
    fs.rmSync(home, { recursive: true, force: true });

    expect(() => manager.begin(parent)).toThrow('Working directory no longer exists');

    // No scope may survive the failure: a registered scope would reject every
    // later delegation turn on this thread until the CLI restarts.
    fs.mkdirSync(home, { recursive: true });
    const scope = manager.begin(parent);
    expect(scope.hasTasks()).toBe(false);
  });

  it('does not leak results or cancellation across parent requests', async () => {
    const first = manager.begin(parent);
    const task: any = await first.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Inspect' }, 'start');
    const other = manager.begin({ ...parent, thread: { ...parent.thread, id: 'other' }, messageId: 'other-message' });
    await expect(other.invoke('remote_cli_result', { taskId: task.taskId }, 'read')).rejects.toThrow('does not belong');
    await expect(other.invoke('remote_cli_cancel', { taskId: task.taskId }, 'cancel')).rejects.toThrow('does not belong');
  });

  it('routes approvals to the child executor and does not offer persistent child grants', async () => {
    parent.backend = 'codex';
    vi.mocked(worker.execute).mockImplementation(async (_, options) => {
      options.onApprovalRequest?.({ requestId: 'permission', kind: 'command', description: 'Write outside workspace', canRemember: true });
      options.onApprovalResolved?.('permission', 'denied');
      return { success: false, error: 'Denied' };
    });
    const scope = manager.begin(parent);
    const task: any = await scope.invoke('remote_cli_delegate', { backend: 'claude', objective: 'Inspect' }, 'start');
    await scope.invoke('remote_cli_result', { taskId: task.taskId }, 'result');
    expect(parent.onApproval).toHaveBeenCalledWith(expect.objectContaining({ canRemember: false }), worker);
    expect(parent.onApprovalResolved).toHaveBeenCalledWith('permission', 'denied');
  });

  it.each([true, false])('bounds final output without losing the conclusion or changing success=%s', async success => {
    vi.mocked(worker.execute).mockResolvedValueOnce({ success,
      output: `Review context\n${'\u{1f680}'.repeat(100000)}\nVerified conclusion`,
      error: success ? undefined : 'Failed' });
    const scope = manager.begin(parent);
    const task: any = await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Inspect' }, 'first');
    const result: any = await scope.invoke('remote_cli_result', { taskId: task.taskId }, 'read');
    expect(result).toMatchObject({ state: success ? 'succeeded' : 'failed', truncated: true });
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(32 * 1024);
    expect(result.output).toMatch(/^Review context\n/);
    expect(result.output).toContain('[Output truncated]');
    expect(result.output).toMatch(/\nVerified conclusion$/);
    expect(result.output).not.toContain('\ufffd');
    expect(parent.onToolResult).toHaveBeenCalledWith({ tool_use_id: task.taskId,
      content: JSON.stringify(result), is_error: !success });
    if (!success) expect(parent.onNotice).toHaveBeenCalledWith(expect.stringContaining('**Reason:** <raw>Failed</raw>'));
    await expect(scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Retry once' }, 'second')).resolves.toHaveProperty('taskId');
  });

  it('expires a silent worker and releases its slot', async () => {
    manager = new DelegationManager(guard, factory as any, new BackendRegistry(async () => '1.0'), new DelegationStore(), 20);
    let finish!: (result: ExecuteResult) => void;
    vi.mocked(worker.execute).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    vi.mocked(worker.abort).mockImplementation(async () => { finish({ success: false }); return true; });
    const scope = manager.begin(parent);
    const task: any = await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Wait' }, 'start');
    await expect(scope.invoke('remote_cli_result', { taskId: task.taskId }, 'result')).resolves.toMatchObject({ state: 'timed_out' });
    expect(worker.destroy).toHaveBeenCalled();
    expect(parent.onNotice).toHaveBeenCalledWith(expect.stringContaining('Timed out'));
  });

  it('does not treat text streaming as delegated-worker activity', async () => {
    manager = new DelegationManager(guard, factory as any, new BackendRegistry(async () => '1.0'), new DelegationStore(), {
      idleTimeoutMs: 100, toolIdleTimeoutMs: 400,
    });
    let finish!: (result: ExecuteResult) => void;
    let options!: ExecuteOptions;
    vi.mocked(worker.execute).mockImplementation((_prompt, receivedOptions) => {
      options = receivedOptions;
      return new Promise(resolve => { finish = resolve; });
    });
    let abortedAt = 0;
    vi.mocked(worker.abort).mockImplementation(async () => { abortedAt = Date.now(); finish({ success: false }); return true; });
    const scope = manager.begin(parent);
    const task: any = await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Wait' }, 'start');
    await vi.waitFor(() => expect(options).toBeDefined());
    expect(options).toMatchObject({ timeout: 0, inactivityTimeout: 0 });

    // Keep streaming past the idle window. If onStream ever refreshed the idle
    // timer, the task would outlive the window and this waitFor would time out.
    const startedAt = Date.now();
    const streaming = setInterval(() => options.onStream?.('Still thinking'), 40);
    try {
      await vi.waitFor(() => expect(worker.abort).toHaveBeenCalled());
    } finally {
      clearInterval(streaming);
    }
    expect(abortedAt - startedAt).toBeLessThan(300);
    await expect(scope.invoke('remote_cli_result', { taskId: task.taskId }, 'result')).resolves.toMatchObject({
      state: 'timed_out', error: expect.stringContaining('without tool activity'),
    });
    expect(worker.abort).toHaveBeenCalledOnce();
  });

  it('extends a delegated task after tool events and restores the shorter idle limit after the tool completes', async () => {
    manager = new DelegationManager(guard, factory as any, new BackendRegistry(async () => '1.0'), new DelegationStore(), {
      idleTimeoutMs: 250, toolIdleTimeoutMs: 1500,
    });
    let finish!: (result: ExecuteResult) => void;
    let options!: ExecuteOptions;
    vi.mocked(worker.execute).mockImplementation((_prompt, receivedOptions) => {
      options = receivedOptions;
      return new Promise(resolve => { finish = resolve; });
    });
    let abortedAt = 0;
    vi.mocked(worker.abort).mockImplementation(async () => { abortedAt = Date.now(); finish({ success: false }); return true; });
    const scope = manager.begin(parent);
    const task: any = await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Build' }, 'start');
    await vi.waitFor(() => expect(options).toBeDefined());

    await wait(75);
    options.onToolUse?.({ id: 'build', name: 'Bash', input: { command: 'make' } });
    // An active tool extends the window: without the extension the task would
    // expire after the ordinary idle limit, well before this checkpoint.
    await wait(350);
    expect(worker.abort).not.toHaveBeenCalled();

    // Once the tool reports its result, the shorter idle window applies again.
    // Invoke the result tool before the expiry so it waits for task.done and
    // returns after the final record write; the abort timestamp proves the
    // shorter window (a stale 1000ms window would blow past the 500ms bound).
    const resultAt = Date.now();
    options.onToolResult?.({ tool_use_id: 'build', content: 'build complete', is_error: false });
    await expect(scope.invoke('remote_cli_result', { taskId: task.taskId }, 'result')).resolves.toMatchObject({
      state: 'timed_out', error: expect.stringContaining('without tool activity'),
    });
    expect(worker.abort).toHaveBeenCalledOnce();
    expect(abortedAt - resultAt).toBeLessThan(800);
    const record = JSON.parse(fs.readFileSync(path.join(home, '.remote-cli', 'delegation', `${task.taskId}.json`), 'utf8'));
    expect(record).toMatchObject({ lastActivityKind: 'tool_result' });
  });

  it('does not impose a total duration cap while tool callbacks continue', async () => {
    manager = new DelegationManager(guard, factory as any, new BackendRegistry(async () => '1.0'), new DelegationStore(), {
      idleTimeoutMs: 250, toolIdleTimeoutMs: 400,
    });
    let finish!: (result: ExecuteResult) => void;
    let options!: ExecuteOptions;
    vi.mocked(worker.execute).mockImplementation((_prompt, receivedOptions) => {
      options = receivedOptions;
      return new Promise(resolve => { finish = resolve; });
    });
    vi.mocked(worker.abort).mockImplementation(async () => { finish({ success: false }); return true; });
    const scope = manager.begin(parent);
    const task: any = await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Keep working' }, 'start');
    await vi.waitFor(() => expect(options).toBeDefined());

    for (let index = 0; index < 7; index++) {
      await wait(50);
      options.onToolUse?.({ id: `tool-${index}`, name: 'Bash', input: { command: 'sleep' } });
      await wait(15);
      options.onToolResult?.({ tool_use_id: `tool-${index}`, content: 'done', is_error: false });
    }
    expect(worker.abort).not.toHaveBeenCalled();
    finish({ success: true, output: 'Finished after sustained tool activity' });
    await expect(scope.invoke('remote_cli_result', { taskId: task.taskId }, 'result')).resolves.toMatchObject({
      state: 'succeeded', output: 'Finished after sustained tool activity',
    });
    const record = JSON.parse(fs.readFileSync(path.join(home, '.remote-cli', 'delegation', `${task.taskId}.json`), 'utf8'));
    expect(record).toMatchObject({ lastActivityKind: 'tool_result' });
    expect(record.lastActivityAt).toEqual(expect.any(Number));
  });

  it.each(['claude', 'codex'] as const)('keeps an unrestricted coordinator\'s %s worker unsandboxed despite target settings', async backend => {
    parent.backend = backend === 'claude' ? 'codex' : 'claude';
    const settings = { command: `custom-${backend}`, ...(backend === 'codex' ? { autoApprove: false } : {}), sandbox: {
      mode: 'workspace-write' as const, networkAccess: false, writableRoots: [home],
    } };
    parent.config[backend] = settings;
    const originalConfig = JSON.stringify(parent.config);
    const directory = path.join(home, '.remote-cli', `${backend}-sandbox`);
    fs.mkdirSync(directory, { recursive: true });
    const savedPath = path.join(directory, 'owner.json');
    const saved = JSON.stringify({ mode: 'read-only', networkAccess: false });
    fs.writeFileSync(savedPath, saved);

    const scope = manager.begin(parent);
    const discovery = await scope.invoke('remote_cli_list_backends', {}, 'list') as { backends: BackendAvailability[] };
    expect(discovery.backends.find(item => item.backend === backend))
      .toMatchObject({ worker: true, readOnly: false });
    const task: any = await scope.invoke('remote_cli_delegate', { backend, objective: 'Research without modifying files' }, 'start');
    await expect(scope.invoke('remote_cli_result', { taskId: task.taskId }, 'result'))
      .resolves.toMatchObject({ state: 'succeeded' });
    expect(factory.mock.calls[0][1][backend]).toEqual({ ...settings, sandbox: { mode: 'danger-full-access' } });
    expect(JSON.stringify(parent.config)).toBe(originalConfig);
    expect(fs.readFileSync(savedPath, 'utf8')).toBe(saved);
  });

  it.each(['claude', 'codex'] as const)('honors the %s coordinator\'s saved sandbox-off override', backend => {
    parent.config[backend] = { sandbox: { mode: 'workspace-write' } };
    const directory = path.join(home, '.remote-cli', `${backend}-sandbox`);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ mode: 'danger-full-access' }));
    const target = backend === 'claude' ? 'codex' : 'claude';
    const config = workerConfiguration(parent.config, guard, 'owner', backend, target, 'inherit');
    expect(config[target]?.sandbox).toEqual({ mode: 'danger-full-access' });
  });

  it.each(['claude', 'codex'] as const)('rejects extra read-only sandboxing for an unrestricted %s worker and allows an inherit retry', async backend => {
    parent.backend = backend === 'claude' ? 'codex' : 'claude';
    const scope = manager.begin(parent);
    await expect(scope.invoke('remote_cli_delegate', { backend, objective: 'Research', mode: 'read_only' }, 'readonly'))
      .rejects.toThrow('Use inherit');
    expect(factory).not.toHaveBeenCalled();
    expect(manager.blocksWorkspace(home, 'other')).toBe(false);
    const task: any = await scope.invoke('remote_cli_delegate', { backend, objective: 'Research without modifying files', mode: 'inherit' }, 'retry');
    await expect(scope.invoke('remote_cli_result', { taskId: task.taskId }, 'result'))
      .resolves.toMatchObject({ state: 'succeeded' });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0][1][backend].sandbox).toEqual({ mode: 'danger-full-access' });
  });

  it.each((['claude', 'codex'] as const).flatMap(backend => (['configured', 'saved'] as const).map(source => [backend, source] as const)))
  ('blocks all managed workers for a %s coordinator with %s sandbox restrictions', async (backend, source) => {
    parent.backend = backend;
    const sandbox = { mode: 'workspace-write' as const, networkAccess: false, writableRoots: [home] };
    const savedPath = path.join(home, '.remote-cli', `${backend}-sandbox`, 'owner.json');
    if (source === 'configured') parent.config[backend] = { sandbox };
    else {
      fs.mkdirSync(path.dirname(savedPath), { recursive: true });
      fs.writeFileSync(savedPath, JSON.stringify(sandbox));
    }
    const originalConfig = JSON.stringify(parent.config);
    const scope = manager.begin(parent);
    const discovery = await scope.invoke('remote_cli_list_backends', {}, 'list') as { backends: BackendAvailability[] };
    for (const item of discovery.backends) {
      expect(item).toMatchObject({ worker: false, readOnly: false });
      await expect(scope.invoke('remote_cli_delegate', { backend: item.backend, objective: 'Inspect' }, item.backend))
        .rejects.toThrow(item.backend === backend ? 'Same-backend' : 'coordinator sandbox is enabled');
    }
    const target = backend === 'claude' ? 'codex' : 'claude';
    await expect(scope.invoke('remote_cli_delegate', { backend: target, objective: 'Inspect', mode: 'read_only' }, 'readonly'))
      .rejects.toThrow('coordinator sandbox is enabled');
    expect(factory).not.toHaveBeenCalled();
    expect(scope.getLaunchRevision()).toBe(0);
    expect(JSON.stringify(parent.config)).toBe(originalConfig);
    if (source === 'saved') expect(JSON.parse(fs.readFileSync(savedPath, 'utf8'))).toEqual(sandbox);
  });

  it('retains the workspace lease until a stopped worker actually exits', async () => {
    let exit!: () => void;
    worker.waitForExit = vi.fn(() => new Promise<void>(resolve => { exit = resolve; }));
    const scope = manager.begin(parent);
    const task: any = await scope.invoke('remote_cli_delegate', { backend: 'agy', objective: 'Read' }, 'start');
    await vi.waitFor(() => expect(worker.waitForExit).toHaveBeenCalled());
    expect(manager.blocksWorkspace(home, 'other')).toBe(true);
    exit();
    expect(await scope.invoke('remote_cli_result', { taskId: task.taskId }, 'result')).toMatchObject({ state: 'succeeded' });
    expect(manager.blocksWorkspace(home, 'other')).toBe(false);
  });

  it('finishes cancellation even when execute never settles after a successful shutdown', async () => {
    vi.mocked(worker.execute).mockImplementation(() => new Promise(() => undefined));
    const scope = manager.begin(parent);
    const task: any = await scope.invoke('remote_cli_delegate', { backend: 'pi', objective: 'Wait' }, 'start');
    await expect(scope.invoke('remote_cli_cancel', { taskId: task.taskId }, 'cancel')).resolves.toMatchObject({ state: 'cancelled' });
    expect(worker.destroy).toHaveBeenCalledOnce();
    expect(manager.blocksWorkspace(home, 'other')).toBe(false);
  });

  it('bounds stuck cleanup and blocks the workspace instead of allowing conflicting work', async () => {
    manager = new DelegationManager(guard, factory as any, new BackendRegistry(async () => '1.0'), new DelegationStore(), 1000, 10);
    vi.mocked(worker.execute).mockImplementation(() => new Promise(() => undefined));
    vi.mocked(worker.abort).mockImplementation(() => new Promise(() => undefined));
    vi.mocked(worker.destroy).mockImplementation(() => new Promise(() => undefined));
    const scope = manager.begin(parent);
    const task: any = await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Wait' }, 'start');
    await expect(scope.invoke('remote_cli_cancel', { taskId: task.taskId }, 'cancel')).resolves.toMatchObject({ state: 'interrupted' });
    expect(manager.blocksWorkspace(home, parent.thread.id)).toBe(true);
    expect(manager.blocksWorkspace(home, 'other')).toBe(true);
    await expect(scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Next' }, 'next')).rejects.toThrow('busy');
  });

  it('refuses overlapping workers and waits for a managed thread using the same workspace', async () => {
    vi.mocked(worker.execute).mockImplementation(() => new Promise(() => undefined));
    const scope = manager.begin(parent);
    const other = manager.begin({ ...parent, thread: { ...parent.thread, id: 'other' } });
    const task: any = await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Work' }, 'start');
    const nested = path.join(home, 'nested'); fs.mkdirSync(nested);
    expect(manager.blocksWorkspace(nested, 'other')).toBe(true);
    expect(manager.blocksWorkspace(path.dirname(home), 'other')).toBe(true);
    await expect(scope.invoke('remote_cli_delegate', { backend: 'claude', objective: 'Work' }, 'duplicate')).rejects.toThrow('current delegated');
    await expect(other.invoke('remote_cli_delegate', { backend: 'pi', objective: 'Work' }, 'conflict')).rejects.toThrow('busy');
    await scope.invoke('remote_cli_cancel', { taskId: task.taskId }, 'cancel');
    await scope.close();
    const busy = manager.begin({ ...parent, isWorkspaceBusy: () => true });
    await expect(busy.invoke('remote_cli_delegate', { backend: 'pi', objective: 'Work' }, 'busy')).rejects.toThrow('busy');
  });

  it.each(DELEGATION_BACKENDS)('returns a %s worker result after large intermediate text and tool output', async backend => {
    parent.backend = backend === 'claude' ? 'codex' : 'claude';
    vi.mocked(worker.execute).mockImplementation(async (_, options) => {
      options.onToolResult?.({ tool_use_id: 'large-read', content: 'x'.repeat(257 * 1024) });
      for (let index = 0; index < 100; index++) {
        options.onStream?.('Progress'.repeat(1024));
        options.onToolResult?.({ tool_use_id: `read-${index}`, content: 'Evidence'.repeat(1024) });
      }
      return { success: true, output: 'Verified research result' };
    });
    const scope = manager.begin(parent);
    const task: any = await scope.invoke('remote_cli_delegate', { backend, objective: 'Research' }, 'start');
    const result = { taskId: task.taskId, backend, state: 'succeeded', output: 'Verified research result', truncated: false };
    await expect(scope.invoke('remote_cli_result', { taskId: task.taskId }, 'result')).resolves.toEqual(result);
    expect(parent.onToolResult).toHaveBeenCalledTimes(1);
    expect(parent.onToolResult).toHaveBeenCalledWith({ tool_use_id: task.taskId,
      content: JSON.stringify(result), is_error: false });
    expect(worker.abort).not.toHaveBeenCalled();
    expect(worker.destroy).toHaveBeenCalledOnce();
  });

  it('caps device concurrency across independent workspaces and releases capacity on cancel', async () => {
    vi.mocked(worker.execute).mockImplementation(() => new Promise(() => undefined));
    factory.mockImplementation((_guard, _config, cwd) => ({ ...worker, getCurrentWorkingDirectory: () => cwd }));
    const scopes = Array.from({ length: 4 }, (_, index) => {
      const cwd = path.join(home, `project-${index}`); fs.mkdirSync(cwd);
      return manager.begin({ ...parent, cwd, thread: { ...parent.thread, id: `owner-${index}`, workingDirectory: cwd } });
    });
    const tasks = await Promise.all(scopes.slice(0, 3).map(scope => scope.invoke('remote_cli_delegate', { backend: 'pi', objective: 'Work' }, 'start')));
    await expect(scopes[3].invoke('remote_cli_delegate', { backend: 'pi', objective: 'Work' }, 'full')).rejects.toThrow('capacity');
    await scopes[0].invoke('remote_cli_cancel', { taskId: (tasks[0] as any).taskId }, 'cancel');
    await expect(scopes[3].invoke('remote_cli_delegate', { backend: 'pi', objective: 'Work' }, 'retry')).resolves.toHaveProperty('taskId');
  });

  it('bounds sequential delegation and reports authentication failures without automatic retries', async () => {
    vi.mocked(worker.execute).mockResolvedValue({ success: false, error: 'Authentication required' });
    const scope = manager.begin(parent);
    for (let index = 0; index < 12; index++) {
      const task: any = await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Work' }, `start-${index}`);
      await expect(scope.invoke('remote_cli_result', { taskId: task.taskId }, `result-${index}`))
        .resolves.toMatchObject({ state: 'failed', error: 'Authentication required' });
      expect(worker.execute).toHaveBeenCalledTimes(index + 1);
    }
    await expect(scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Work' }, 'overflow')).rejects.toThrow('task limit');
  });

  it('keeps task ownership and releases the worker when progress delivery fails', async () => {
    parent.onToolUse = parent.onToolResult = parent.onNotice = () => { throw new Error('Disconnected'); };
    const scope = manager.begin(parent);
    const task: any = await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Work' }, 'start');
    await expect(scope.invoke('remote_cli_result', { taskId: task.taskId }, 'result')).resolves.toMatchObject({ state: 'succeeded' });
    expect(worker.destroy).toHaveBeenCalledOnce();
    expect(manager.blocksWorkspace(home, 'other')).toBe(false);
  });


  it('continues an isolated worker lane across sequential tasks without touching the direct thread session', async () => {
    const scope = manager.begin(parent);
    const first: any = await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Inspect the first file' }, 'first');
    await expect(scope.invoke('remote_cli_result', { taskId: first.taskId }, 'first-result')).resolves.toMatchObject({ state: 'succeeded' });
    const laneId = factory.mock.calls[0][3];

    const second: any = await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Inspect the follow-up' }, 'second');
    await expect(scope.invoke('remote_cli_result', { taskId: second.taskId }, 'second-result')).resolves.toMatchObject({ state: 'succeeded' });

    expect(factory.mock.calls[1][3]).toBe(laneId);
    expect(laneId).toMatch(/^delegate-lane-/);
    expect(worker.deleteThreadData).not.toHaveBeenCalled();
    await expect(manager.laneStore.lanesForThread(parent.thread.id, 'codex')).resolves.toEqual([
      expect.objectContaining({ executorThreadId: laneId, state: 'ready', workspaceGeneration: 0 }),
    ]);
  });

  it('invalidates only worker state when the parent workspace generation changes', async () => {
    const scope = manager.begin(parent);
    const task: any = await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Inspect' }, 'start');
    await expect(scope.invoke('remote_cli_result', { taskId: task.taskId }, 'result')).resolves.toMatchObject({ state: 'succeeded' });
    const laneId = factory.mock.calls[0][3];
    const lanePointer = path.join(home, '.remote-cli', 'codex-sessions', `${laneId}.json`);
    const directPointer = path.join(home, '.remote-cli', 'codex-sessions', `${parent.thread.id}.json`);
    fs.mkdirSync(path.dirname(lanePointer), { recursive: true });
    fs.writeFileSync(lanePointer, '{"id":"worker"}');
    fs.writeFileSync(directPointer, '{"id":"direct"}');
    await scope.close();

    expect(await manager.invalidateWorkspaceGeneration(parent.thread.id, 1)).toEqual({ removed: 1, failed: 0 });
    expect(fs.existsSync(lanePointer)).toBe(false);
    expect(fs.existsSync(directPointer)).toBe(true);

    parent = { ...parent, thread: { ...parent.thread, delegationWorkspaceGeneration: 1 } };
    const next = manager.begin(parent);
    const nextTask: any = await next.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Inspect again' }, 'next');
    await expect(next.invoke('remote_cli_result', { taskId: nextTask.taskId }, 'next-result')).resolves.toMatchObject({ state: 'succeeded' });
    expect(factory.mock.calls[1][3]).not.toBe(laneId);
  });

  it('retries exactly once with a fresh lane after an executor confirms a missing native session before dispatch', async () => {
    const first = {
      ...worker,
      execute: vi.fn().mockResolvedValue({ success: false, error: 'Stored native session is missing' }),
      consumeSessionResumeFailure: vi.fn(() => true),
      destroy: vi.fn().mockResolvedValue(undefined),
      waitForExit: vi.fn().mockResolvedValue(undefined),
    } as IExecutor;
    const second = {
      ...worker,
      execute: vi.fn().mockResolvedValue({ success: true, output: 'Fresh lane completed' }),
      consumeSessionResumeFailure: vi.fn(() => false),
      destroy: vi.fn().mockResolvedValue(undefined),
      waitForExit: vi.fn().mockResolvedValue(undefined),
    } as IExecutor;
    factory.mockImplementationOnce((_guard, _config, _cwd, id) => {
      const pointer = path.join(home, '.remote-cli', 'codex-sessions', `${id}.json`);
      fs.mkdirSync(path.dirname(pointer), { recursive: true });
      fs.writeFileSync(pointer, '{"id":"stale"}');
      return first;
    }).mockImplementationOnce(() => second);

    const scope = manager.begin(parent);
    const task: any = await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Retry safely' }, 'start');
    await expect(scope.invoke('remote_cli_result', { taskId: task.taskId }, 'result')).resolves.toMatchObject({
      state: 'succeeded', output: 'Fresh lane completed',
    });

    const firstLaneId = factory.mock.calls[0][3];
    const secondLaneId = factory.mock.calls[1][3];
    expect(first.destroy).toHaveBeenCalledOnce();
    expect(secondLaneId).not.toBe(firstLaneId);
    expect(fs.existsSync(path.join(home, '.remote-cli', 'codex-sessions', `${firstLaneId}.json`))).toBe(false);
    expect(second.execute).toHaveBeenCalledOnce();
  });

  it('quarantines a lane when a worker backend cannot confirm process exit', async () => {
    const unconfirmed = { ...worker, waitForExit: undefined } as IExecutor;
    factory.mockImplementation(() => unconfirmed);
    const scope = manager.begin(parent);
    const task: any = await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Inspect' }, 'start');

    await expect(scope.invoke('remote_cli_result', { taskId: task.taskId }, 'result')).resolves.toMatchObject({ state: 'interrupted' });
    expect(manager.blocksWorkspace(home, 'other')).toBe(true);
    await expect(manager.laneStore.lanesForThread(parent.thread.id, 'codex')).resolves.toEqual([
      expect.objectContaining({ state: 'dirty' }),
    ]);
  });

  it('reports cleanup failure and keeps the lane retryable when deleting worker data', async () => {
    const acquired = await manager.laneStore.acquire({
      threadId: parent.thread.id, backend: 'codex', workingDirectory: home, workspaceGeneration: 0,
    });
    await manager.laneStore.markReady(acquired.lane.id);
    const pointer = path.join(home, '.remote-cli', 'codex-sessions', `${acquired.lane.executorThreadId}.json`);
    fs.mkdirSync(pointer, { recursive: true });

    await expect(manager.deleteWorkerLanes(parent.thread.id)).rejects.toThrow('cleanup failed for 1 of 1');
    await expect(manager.laneStore.cleanupCandidates()).resolves.toEqual([
      expect.objectContaining({ id: acquired.lane.id, cleanupPending: true, cleanupAttempts: 1 }),
    ]);
  });

  it('retries pending lane cleanup on reconciliation without reusing the native pointer', async () => {
    const acquired = await manager.laneStore.acquire({
      threadId: parent.thread.id, backend: 'codex', workingDirectory: home, workspaceGeneration: 0,
    });
    await manager.laneStore.markReady(acquired.lane.id);
    await manager.laneStore.markCleanupFailure(acquired.lane.id, 'Previous cleanup failed');
    const pointer = path.join(home, '.remote-cli', 'codex-sessions', `${acquired.lane.executorThreadId}.json`);
    fs.mkdirSync(path.dirname(pointer), { recursive: true });
    fs.writeFileSync(pointer, '{}');

    const restored = new DelegationManager(guard, factory as any, new BackendRegistry(async () => 'test 1.0'));
    await expect(restored.reconcilePendingWorkerLanes()).resolves.toEqual({ removed: 1, failed: 0 });
    expect(fs.existsSync(pointer)).toBe(false);
    await expect(restored.laneStore.lanesForThread(parent.thread.id)).resolves.toEqual([]);
  });

  it('keeps startup reconciliation available when a pending lane still cannot be removed', async () => {
    const acquired = await manager.laneStore.acquire({
      threadId: parent.thread.id, backend: 'codex', workingDirectory: home, workspaceGeneration: 0,
    });
    await manager.laneStore.markCleanupFailure(acquired.lane.id, 'Previous cleanup failed');
    const pointer = path.join(home, '.remote-cli', 'codex-sessions', `${acquired.lane.executorThreadId}.json`);
    fs.mkdirSync(pointer, { recursive: true });

    const restored = new DelegationManager(guard, factory as any, new BackendRegistry(async () => 'test 1.0'));
    await expect(restored.reconcilePendingWorkerLanes()).resolves.toEqual({ removed: 0, failed: 1 });
    await expect(restored.laneStore.cleanupCandidates()).resolves.toEqual([
      expect.objectContaining({ id: acquired.lane.id, cleanupPending: true, cleanupAttempts: 2 }),
    ]);
  });

  it('reports failed old-lane cleanup without undoing a workspace change', async () => {
    const acquired = await manager.laneStore.acquire({
      threadId: parent.thread.id, backend: 'codex', workingDirectory: home, workspaceGeneration: 0,
    });
    await manager.laneStore.markReady(acquired.lane.id);
    const pointer = path.join(home, '.remote-cli', 'codex-sessions', `${acquired.lane.executorThreadId}.json`);
    fs.mkdirSync(pointer, { recursive: true });

    await expect(manager.invalidateWorkspaceGeneration(parent.thread.id, 1)).resolves.toEqual({ removed: 0, failed: 1 });
    await expect(manager.laneStore.cleanupCandidates()).resolves.toEqual([
      expect.objectContaining({ id: acquired.lane.id, cleanupPending: true }),
    ]);
  });
});
