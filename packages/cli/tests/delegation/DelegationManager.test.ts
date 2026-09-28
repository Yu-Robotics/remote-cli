import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DelegationManager, type DelegationParent } from '../../src/delegation/DelegationManager';
import { BackendRegistry } from '../../src/delegation/BackendRegistry';
import { DelegationStore } from '../../src/delegation/DelegationStore';
import { DELEGATION_BACKENDS } from '../../src/delegation/contract';
import { workerConfiguration } from '../../src/delegation/WorkerPolicy';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import type { ExecuteResult, IExecutor } from '../../src/executor/IExecutor';

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

  it.each(DELEGATION_BACKENDS.flatMap(main => DELEGATION_BACKENDS.map(child => [main, child] as const)))
  ('returns a %s coordinator\'s %s child result without reusing the primary session', async (main, child) => {
    parent.backend = main;
    const scope = manager.begin(parent);
    const started: any = await scope.invoke('remote_cli_delegate', { backend: child, objective: 'Review the patch' }, 'start');
    const result: any = await scope.invoke('remote_cli_result', { taskId: started.taskId }, 'result');
    expect(result).toMatchObject({ state: 'succeeded', output: 'review complete', backend: child });
    expect(factory.mock.calls[0][3]).toMatch(/^delegate-/);
    expect(factory.mock.calls[0][3]).not.toBe(parent.thread.id);
    expect(factory.mock.calls[0][4]).toBe(parent.thread.models![child]);
    expect(worker.deleteThreadData).toHaveBeenCalledWith(factory.mock.calls[0][3]);
    expect(parent.onToolUse).toHaveBeenCalledTimes(1);
    expect(parent.onToolResult).toHaveBeenCalledTimes(1);
    const record = JSON.parse(fs.readFileSync(path.join(home, '.remote-cli', 'delegation', `${started.taskId}.json`), 'utf8'));
    expect(record).toMatchObject({ threadId: 'owner', parentMessageId: 'message-1', state: 'succeeded' });
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

  it('does not leak results or cancellation across parent requests', async () => {
    const first = manager.begin(parent);
    const task: any = await first.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Inspect' }, 'start');
    const other = manager.begin({ ...parent, thread: { ...parent.thread, id: 'other' }, messageId: 'other-message' });
    await expect(other.invoke('remote_cli_result', { taskId: task.taskId }, 'read')).rejects.toThrow('does not belong');
    await expect(other.invoke('remote_cli_cancel', { taskId: task.taskId }, 'cancel')).rejects.toThrow('does not belong');
  });

  it('routes approvals to the child executor and does not offer persistent child grants', async () => {
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

  it('bounds final output and still releases the workspace after a failed task', async () => {
    vi.mocked(worker.execute).mockResolvedValueOnce({ success: false, output: '\u{1f680}'.repeat(100000), error: 'Failed' });
    const scope = manager.begin(parent);
    const task: any = await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Inspect' }, 'first');
    const result: any = await scope.invoke('remote_cli_result', { taskId: task.taskId }, 'read');
    expect(result).toMatchObject({ state: 'failed', truncated: true });
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(32 * 1024);
    expect(result.output).not.toContain('\ufffd');
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
  });

  it('preserves saved per-thread restrictions despite using a new worker session', () => {
    const directory = path.join(home, '.remote-cli', 'codex-sandbox'); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ mode: 'read-only', networkAccess: false }));
    const config = workerConfiguration(parent.config, guard, 'owner', 'codex', 'codex', 'inherit');
    expect(config.codex?.sandbox).toMatchObject({ mode: 'read-only', networkAccess: false });
    expect(() => workerConfiguration(parent.config, guard, 'owner', 'codex', 'pi', 'inherit')).toThrow('sandbox');
    expect(() => workerConfiguration(parent.config, guard, 'owner', 'codex', 'claude', 'inherit')).toThrow('same backend');
  });

  it.each(['pi', 'agy', 'opencode', 'kimi', 'zcode'] as const)('rejects read-only %s instead of advertising instruction-only isolation', backend => {
    expect(() => workerConfiguration(parent.config, guard, 'owner', 'pi', backend, 'read_only')).toThrow('cannot enforce');
    expect(() => workerConfiguration({ type: 'codex', codex: { sandbox: { mode: 'workspace-write' } } },
      guard, 'owner', 'codex', backend, 'inherit')).toThrow('cannot enforce');
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
    const task: any = await scope.invoke('remote_cli_delegate', { backend: 'claude', objective: 'Wait' }, 'start');
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

  it('stops a noisy worker once its captured output reaches the limit', async () => {
    vi.mocked(worker.execute).mockImplementation(async (_, options) => {
      options.onStream?.('x'.repeat(257 * 1024));
      return { success: true, output: 'late success' };
    });
    const scope = manager.begin(parent);
    const task: any = await scope.invoke('remote_cli_delegate', { backend: 'pi', objective: 'Work' }, 'start');
    await expect(scope.invoke('remote_cli_result', { taskId: task.taskId }, 'result')).resolves.toMatchObject({ state: 'failed', error: expect.stringContaining('capture limit') });
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
});
