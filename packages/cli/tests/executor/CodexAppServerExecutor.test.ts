import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexAppServerExecutor, CodexAppServerTransport } from '../../src/executor/CodexAppServerExecutor';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { ThreadManager } from '../../src/thread/ThreadManager';
import { ThreadExecutorPool } from '../../src/thread/ThreadExecutorPool';
import { MessageHandler } from '../../src/client/MessageHandler';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class FakeTransport implements CodexAppServerTransport {
  running = false;
  requests: Array<{ method: string; params: any }> = [];
  responses: Array<{ id: number | string; result: any }> = [];
  errors: Array<{ id: number | string; message: string }> = [];
  handler: ((message: any) => void) | null = null;
  nextThreadId = 'codex-thread-1';
  nextTurnId = 'turn-1';
  models = [
    { id: 'gpt-a', displayName: 'GPT A', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] },
    { id: 'gpt-b', displayName: 'GPT B', isDefault: false, defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] },
  ];
  rateLimitsResponse: any = { rateLimits: {} };
  cwd: string | null = null;
  serverVersion: string | null = null;
  commandVersion: string | null = null;
  resumeError: Error | null = null;

  async start(): Promise<void> { this.running = true; }
  async stop(): Promise<void> { this.running = false; }
  isRunning(): boolean { return this.running; }
  setWorkingDirectory(cwd: string): void { this.cwd = cwd; }
  getServerVersion(): string | null { return this.serverVersion; }
  async getCommandVersion(): Promise<string | null> { return this.commandVersion; }
  onMessage(handler: (message: any) => void): () => void {
    this.handler = handler;
    return () => { this.handler = null; };
  }
  emit(message: any): void { this.handler?.(message); }
  respond(id: number | string, result: any): void { this.responses.push({ id, result }); }
  respondError(id: number | string, message: string): void { this.errors.push({ id, message }); }
  async request(method: string, params?: any): Promise<any> {
    this.running = true;
    this.requests.push({ method, params });
    if (method === 'thread/start') return { thread: { id: this.nextThreadId } };
    if (method === 'thread/resume') {
      if (this.resumeError) throw this.resumeError;
      return { thread: { id: params.threadId } };
    }
    if (method === 'turn/start') return { turn: { id: this.nextTurnId, status: 'inProgress' } };
    if (method === 'model/list') return { data: this.models, nextCursor: null };
    if (method === 'config/read') return { config: {} };
    if (method === 'account/rateLimits/read') return this.rateLimitsResponse;
    return {};
  }
}

describe('CodexAppServerExecutor', () => {
  let tempHome: string;
  let projectDir: string;
  let transport: FakeTransport;
  let executor: CodexAppServerExecutor;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tempHome = await fs.realpath(await fs.mkdtemp(path.join(process.cwd(), '.codex-app-executor-test-')));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    projectDir = path.join(tempHome, 'project');
    await fs.mkdir(projectDir);
    vi.spyOn(os, 'homedir').mockReturnValue(tempHome);
    vi.spyOn(os, 'tmpdir').mockReturnValue(tempHome);
    transport = new FakeTransport();
    executor = new CodexAppServerExecutor(new DirectoryGuard([projectDir]), {
      threadId: 'remote-thread',
      initialWorkingDirectory: projectDir,
      clientFactory: () => transport,
      inactivityTimeoutMs: 60_000,
      compactTimeoutMs: 60_000,
    });
  });

  afterEach(async () => {
    await executor.destroy();
    vi.restoreAllMocks();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it('keeps text and tool callbacks isolated between independent Codex executors', async () => {
    const otherTransport = new FakeTransport();
    otherTransport.nextThreadId = 'codex-worker';
    const other = new CodexAppServerExecutor(new DirectoryGuard([projectDir]), {
      threadId: 'delegate-test', initialWorkingDirectory: projectDir, delegationWorker: true,
      clientFactory: () => otherTransport,
    });
    const parentStream = vi.fn();
    const childStream = vi.fn();
    const parentTools = vi.fn();
    const childTools = vi.fn();
    try {
      const parentRun = executor.execute('Parent task', { onStream: parentStream, onToolResult: parentTools });
      const childRun = other.execute('Independent task', { onStream: childStream, onToolResult: childTools });
      await vi.waitFor(() => {
        expect(transport.requests.some(request => request.method === 'turn/start')).toBe(true);
        expect(otherTransport.requests.some(request => request.method === 'turn/start')).toBe(true);
      });
      const text = (threadId: string, delta: string) => ({ method: 'item/agentMessage/delta',
        params: { threadId, turnId: 'turn-1', delta } });
      const tool = (threadId: string, output: string) => ({ method: 'item/completed', params: {
        threadId, turnId: 'turn-1', item: { type: 'commandExecution', id: 'shared-tool-id',
          command: 'inspect', status: 'completed', exitCode: 0, aggregatedOutput: output },
      } });
      for (const target of [transport, otherTransport]) {
        target.emit(text('codex-thread-1', 'Parent answer'));
        target.emit(text('codex-worker', 'Worker answer'));
        target.emit(tool('codex-thread-1', 'Parent evidence'));
        target.emit(tool('codex-worker', 'Worker evidence'));
      }
      expect(parentStream.mock.calls).toEqual([['Parent answer']]);
      expect(childStream.mock.calls).toEqual([['Worker answer']]);
      expect(parentTools.mock.calls.map(([result]) => result.content)).toEqual(['Parent evidence']);
      expect(childTools.mock.calls.map(([result]) => result.content)).toEqual(['Worker evidence']);
      for (const target of [transport, otherTransport]) {
        target.emit({ method: 'turn/completed', params: { threadId: target.nextThreadId,
          turn: { id: 'turn-1', status: 'completed' } } });
      }
      await expect(parentRun).resolves.toMatchObject({ success: true, output: 'Parent answer' });
      await expect(childRun).resolves.toMatchObject({ success: true, output: 'Worker answer' });
    } finally { await other.destroy(); }
  });

  it('uses native settings reports without an extra model request or confusing turn effort with the thread default', async () => {
    expect(executor.getExecutionMetadata()).toMatchObject({ modelSource: 'default', effortSource: 'default' });
    expect(transport.requests).toHaveLength(0);
    const request = transport.request.bind(transport);
    vi.spyOn(transport, 'request').mockImplementation(async (method, params) => {
      const result = await request(method, params);
      return method === 'thread/start' ? { ...result, model: 'gpt-a', reasoningEffort: 'medium' } : result;
    });
    const running = executor.execute('metadata', {});
    await vi.waitFor(() => expect(transport.requests.some(item => item.method === 'turn/start')).toBe(true));
    transport.emit({ method: 'turn/completed', params: { threadId: transport.nextThreadId, turn: { id: 'turn-1', status: 'completed' } } });
    await running;
    expect(executor.getExecutionMetadata()).toMatchObject({ model: 'gpt-a', modelSource: 'reported', reasoningEffort: 'medium', effortSource: 'reported' });
    await executor.setEffort('high');
    expect(executor.getExecutionMetadata()).toMatchObject({ reasoningEffort: 'high', effortSource: 'configured' });
    await executor.setModel('gpt-b');
    expect(executor.getExecutionMetadata()).toMatchObject({ model: 'gpt-b', modelSource: 'configured' });
    executor.clearModel();
    expect(executor.getExecutionMetadata()).toMatchObject({ modelSource: 'default' });
  });

  it.each(['reset', 'restart'])('does not reuse native settings after a %s without a fresh report', async action => {
    const request = transport.request.bind(transport);
    let reportSettings = true;
    vi.spyOn(transport, 'request').mockImplementation(async (method, params) => {
      const result = await request(method, params);
      return method === 'thread/start' && reportSettings
        ? { ...result, model: 'previous-model', reasoningEffort: 'high' } : result;
    });
    const complete = async (pending: ReturnType<typeof executor.execute>, count: number) => {
      await vi.waitFor(() => expect(transport.requests.filter(item => item.method === 'turn/start')).toHaveLength(count));
      transport.emit({ method: 'turn/completed', params: { threadId: transport.nextThreadId, turn: { id: 'turn-1', status: 'completed' } } });
      await pending;
    };
    await complete(executor.execute('first', {}), 1);
    expect(executor.getExecutionMetadata()).toMatchObject({ modelSource: 'reported', effortSource: 'reported' });
    reportSettings = false;
    if (action === 'reset') executor.resetContext();
    else await transport.stop();
    await complete(executor.execute('second', {}), 2);
    expect(executor.getExecutionMetadata()).toMatchObject({ model: undefined, modelSource: 'default', reasoningEffort: undefined, effortSource: 'default' });
    expect(transport.requests.filter(item => item.method === 'model/list')).toHaveLength(0);
  });

  it('allows an execution to disable the executor inactivity timeout', async () => {
    await executor.destroy();
    executor = new CodexAppServerExecutor(new DirectoryGuard([projectDir]), {
      threadId: 'remote-thread',
      initialWorkingDirectory: projectDir,
      clientFactory: () => transport,
      inactivityTimeoutMs: 100,
      compactTimeoutMs: 60_000,
    });

    const pending = executor.execute('long delegated task', { inactivityTimeout: 0 });
    await vi.waitFor(() => expect(transport.requests.some(request => request.method === 'turn/start')).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(transport.isRunning()).toBe(true);
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await expect(pending).resolves.toMatchObject({ success: true });
  });

  it('preserves all backend bindings when a directory change reaches an internally busy executor', async () => {
    await executor.destroy();
    const manager = await ThreadManager.initialize(tempHome);
    const threadId = manager.getDefaultThread().id;
    await manager.updateThread(threadId, { workingDirectory: projectDir });
    const guard = new DirectoryGuard([tempHome]);
    executor = new CodexAppServerExecutor(guard, {
      threadId, initialWorkingDirectory: projectDir, clientFactory: () => transport,
    });
    const pool = new ThreadExecutorPool(manager, guard, { type: 'codex' }, () => executor);
    pool.getExecutor(threadId);
    const other = path.join(tempHome, 'other');
    await fs.mkdir(other);
    const pointers: string[] = [];
    for (const backend of ['claude', 'agy', 'opencode', 'kimi', 'zcode', 'pi']) {
      const file = path.join(tempHome, '.remote-cli', `${backend}-sessions`, `${threadId}.json`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify({ id: `old-${backend}`, cwd: projectDir }));
      pointers.push(file);
    }
    const running = executor.execute('work');
    await vi.waitFor(() => expect(transport.requests.some(request => request.method === 'turn/start')).toBe(true));
    pointers.push(path.join(tempHome, '.remote-cli', 'codex-sessions', `${threadId}.json`));
    const before = await Promise.all(pointers.map(file => fs.readFile(file, 'utf8')));

    expect(pool.isThreadBusy(threadId)).toBe(true);
    await expect(pool.setWorkingDirectory(threadId, other)).rejects.toThrow('busy');
    expect(await Promise.all(pointers.map(file => fs.readFile(file, 'utf8')))).toEqual(before);
    expect(manager.getThread(threadId)?.workingDirectory).toBe(projectDir);
    expect(executor.getCurrentWorkingDirectory()).toBe(projectDir);

    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await expect(running).resolves.toMatchObject({ success: true });
  });

  it('reports a deleted working directory before starting a Codex turn', async () => {
    await fs.rm(projectDir, { recursive: true, force: true });

    const result = await executor.execute('inspect');

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('Working directory no longer exists') });
    expect(transport.requests).toEqual([]);
  });

  it('answers card approvals by opaque request ID, preserves directory scope, and expires outstanding cards', async () => {
    await executor.configureSandbox('on');
    const onApprovalRequest = vi.fn((_request: any) => true);
    const onApprovalResolved = vi.fn();
    const onStream = vi.fn();
    const running = executor.execute('work', { onApprovalRequest, onApprovalResolved, onStream });
    await vi.waitFor(() => expect(transport.requests.some(request => request.method === 'turn/start')).toBe(true));
    transport.emit({ id: 100, method: 'item/commandExecution/requestApproval', params: { command: 'make install' } });
    transport.emit({ id: 101, method: 'item/permissions/requestApproval', params: { permissions: { fileSystem: { write: [tempHome] } } } });
    const command = onApprovalRequest.mock.calls[0][0] as any;
    const directory = onApprovalRequest.mock.calls[1][0] as any;
    expect(command).toMatchObject({ kind: 'command', canRemember: false, description: 'make install' });
    expect(directory).toMatchObject({ kind: 'permissions', canRemember: true, writableRoots: [tempHome] });
    expect(onStream).not.toHaveBeenCalled();
    expect(executor.respondToApproval('stale-id', 'approve')).toBe(false);
    expect(executor.respondToApproval(command.requestId, 'remember')).toBe(false);
    expect(executor.respondToApproval(directory.requestId, 'remember')).toBe(true);
    expect(transport.responses).toContainEqual({ id: 101, result: { permissions: { fileSystem: { write: [tempHome] } }, scope: 'session' } });
    expect(onApprovalResolved).toHaveBeenCalledWith(directory.requestId, 'remembered');
    expect(executor.getSandboxStatus()).toContain(tempHome);
    expect(executor.respondToApproval(directory.requestId, 'approve')).toBe(false);
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await running;
    expect(onApprovalResolved).toHaveBeenCalledWith(command.requestId, 'expired');
    expect(executor.respondToApproval(command.requestId, 'approve')).toBe(false);
    expect(transport.responses.some(response => response.id === 100)).toBe(false);
  });

  it('adds and removes delegation on the same resumed conversation while preserving sandbox settings', async () => {
    await executor.configureSandbox('on');
    const runTurn = async () => {
      const before = transport.requests.filter(request => request.method === 'turn/start').length;
      const result = executor.execute('work', {});
      await vi.waitFor(() => expect(transport.requests.filter(request => request.method === 'turn/start').length).toBe(before + 1));
      transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
      await result;
    };
    await runTurn();
    expect(transport.requests.find(request => request.method === 'thread/start')!.params.config)
      .not.toHaveProperty('mcp_servers.remote_cli_delegation');
    await executor.configureDelegation({ url: 'http://127.0.0.1:12345/', token: 'private-test-token' });
    await runTurn();
    const resumed = transport.requests.filter(request => request.method === 'thread/resume').at(-1)!.params;
    expect(resumed.threadId).toBe('codex-thread-1');
    expect(resumed.sandbox).toBe('workspace-write');
    expect(resumed.config['mcp_servers.remote_cli_delegation']).toMatchObject({ enabled: true, required: true, tool_timeout_sec: 35,
      default_tools_approval_mode: 'approve',
      enabled_tools: ['remote_cli_list_backends', 'remote_cli_delegate', 'remote_cli_result', 'remote_cli_cancel', 'remote_cli_integrate'] });
    expect(resumed.approvalPolicy).toBe('on-request');
    expect(resumed.config['sandbox_workspace_write.exclude_slash_tmp']).toBe(true);
    await executor.configureDelegation(undefined);
    await runTurn();
    expect(transport.requests.filter(request => request.method === 'thread/resume').at(-1)!.params.config['mcp_servers.remote_cli_delegation'].enabled).toBe(false);
    const stopped = vi.spyOn(transport, 'stop');
    const resumedCount = transport.requests.filter(request => request.method === 'thread/resume').length;
    await executor.configureDelegation(undefined);
    await runTurn();
    expect(stopped).not.toHaveBeenCalled();
    expect(transport.requests.filter(request => request.method === 'thread/resume')).toHaveLength(resumedCount);
  });

  it('retains a failed transport reply for retry without approving a later request', async () => {
    await executor.configureSandbox('on');
    const onApprovalRequest = vi.fn((_request: any) => true);
    const onApprovalResolved = vi.fn();
    const running = executor.execute('work', { onApprovalRequest, onApprovalResolved });
    await vi.waitFor(() => expect(transport.requests.some(request => request.method === 'turn/start')).toBe(true));
    transport.emit({ id: 120, method: 'item/commandExecution/requestApproval', params: { command: 'first' } });
    transport.emit({ id: 121, method: 'item/commandExecution/requestApproval', params: { command: 'second' } });
    const first = onApprovalRequest.mock.calls[0][0];
    const second = onApprovalRequest.mock.calls[1][0];
    vi.spyOn(transport, 'respond').mockImplementationOnce(() => { throw new Error('Process unavailable'); });
    expect(executor.respondToApproval(first.requestId, 'approve')).toBe(false);
    expect(onApprovalResolved).not.toHaveBeenCalled();
    expect(executor.respondToApproval(first.requestId, 'approve')).toBe(true);
    expect(transport.responses).toEqual([{ id: 120, result: { decision: 'accept' } }]);
    expect(executor.respondToApproval(second.requestId, 'deny')).toBe(true);
    expect(transport.responses.at(-1)).toEqual({ id: 121, result: { decision: 'decline' } });
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await running;
  });

  it('keeps text approval fallback and invalidates cards resolved by text or native cancellation', async () => {
    await executor.configureSandbox('on');
    const onApprovalRequest = vi.fn((_request: any) => false);
    const onApprovalResolved = vi.fn();
    const onStream = vi.fn();
    const running = executor.execute('work', { onApprovalRequest, onApprovalResolved, onStream });
    await vi.waitFor(() => expect(transport.requests.some(request => request.method === 'turn/start')).toBe(true));
    transport.emit({ id: 110, method: 'item/fileChange/requestApproval', params: { grantRoot: tempHome } });
    const first = onApprovalRequest.mock.calls[0][0] as any;
    expect(onStream).toHaveBeenCalledWith(expect.stringContaining('Reply yes'));
    expect(executor.sendInput('no')).toBe(true);
    expect(onApprovalResolved).toHaveBeenCalledWith(first.requestId, 'denied');
    transport.emit({ id: 111, method: 'item/permissions/requestApproval', params: { permissions: { network: { enabled: true } } } });
    const second = onApprovalRequest.mock.calls[1][0] as any;
    expect(second.canRemember).toBe(false);
    transport.emit({ method: 'serverRequest/resolved', params: { requestId: 111 } });
    expect(onApprovalResolved).toHaveBeenCalledWith(second.requestId, 'expired');
    expect(executor.respondToApproval(second.requestId, 'approve')).toBe(false);
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await running;
  });

  it('applies sandbox settings to new turns, directory changes, and restored sessions without leaking grants', async () => {
    expect(await executor.configureSandbox('on')).toMatchObject({ success: true });
    const extra = path.join(tempHome, 'other project');
    expect(await executor.configureSandbox(`allow ${extra}`)).toMatchObject({ success: true });
    const first = executor.execute('work');
    await vi.waitFor(() => expect(transport.requests.some(request => request.method === 'turn/start')).toBe(true));
    const threadParams = transport.requests.find(request => request.method === 'thread/start')!.params;
    const turnParams = transport.requests.find(request => request.method === 'turn/start')!.params;
    expect(threadParams).toMatchObject({ sandbox: 'workspace-write', approvalPolicy: 'on-request' });
    expect(threadParams.config['sandbox_workspace_write.writable_roots']).toEqual(turnParams.sandboxPolicy.writableRoots);
    expect(turnParams.sandboxPolicy).toMatchObject({ type: 'workspaceWrite', networkAccess: true });
    expect(turnParams.sandboxPolicy.writableRoots).toContain(extra);
    expect(turnParams.sandboxPolicy.writableRoots).not.toContain(tempHome);
    expect(await executor.configureSandbox('off')).toMatchObject({ success: false });
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await first;
    expect(await executor.configureSandbox('remove ' + extra)).toMatchObject({ success: true });
    expect(await executor.configureSandbox('network off')).toMatchObject({ success: true });
    await executor.destroy();

    transport = new FakeTransport();
    executor = new CodexAppServerExecutor(new DirectoryGuard([tempHome]), {
      threadId: 'remote-thread', initialWorkingDirectory: projectDir, clientFactory: () => transport,
    });
    const changed = path.join(tempHome, 'new-project');
    await fs.mkdir(changed);
    await executor.setWorkingDirectory(changed);
    transport.nextThreadId = 'codex-thread-2';
    const next = executor.execute('continue');
    await vi.waitFor(() => expect(transport.requests.some(request => request.method === 'turn/start')).toBe(true));
    const started = transport.requests.find(request => request.method === 'thread/start')!.params;
    const turn = transport.requests.find(request => request.method === 'turn/start')!.params;
    expect(started).toMatchObject({ sandbox: 'workspace-write', cwd: changed });
    expect(transport.requests.some(request => request.method === 'thread/resume')).toBe(false);
    expect(turn.threadId).toBe('codex-thread-2');
    expect(turn.sandboxPolicy.networkAccess).toBe(false);
    expect(turn.sandboxPolicy.writableRoots).toContain(changed);
    expect(turn.sandboxPolicy.writableRoots).not.toContain(projectDir);
    expect(turn.sandboxPolicy.writableRoots).not.toContain(extra);
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-2', turn: { id: 'turn-1', status: 'completed' } } });
    await next;
    executor.resetContext();
    expect(executor.getSandboxStatus()).toContain('workspace-write');
    expect(await executor.configureSandbox('default')).toMatchObject({ success: true });
    expect(executor.getSandboxStatus()).toContain('not configured');
  });

  it('asks before escaping the sandbox even with autoApprove enabled and clears resolved requests', async () => {
    await executor.configureSandbox('on');
    const chunks: string[] = [];
    const turn = executor.execute('work', { onStream: chunk => chunks.push(chunk) });
    await vi.waitFor(() => expect(transport.requests.some(request => request.method === 'turn/start')).toBe(true));
    transport.emit({ id: 7, method: 'item/commandExecution/requestApproval', params: {
      threadId: 'codex-thread-1', turnId: 'turn-1', command: 'write outside workspace',
    } });
    expect(transport.responses).toEqual([]);
    expect(executor.isWaitingInput()).toBe(true);
    expect(chunks.join('')).toContain('outside the sandbox');
    transport.emit({ method: 'serverRequest/resolved', params: { threadId: 'codex-thread-1', requestId: 7 } });
    expect(executor.sendInput('yes')).toBe(false);
    transport.emit({ id: 8, method: 'item/permissions/requestApproval', params: {
      threadId: 'codex-thread-1', turnId: 'turn-1', permissions: { network: { enabled: true } },
    } });
    expect(executor.sendInput('no')).toBe(true);
    expect(transport.responses.at(-1)).toEqual({ id: 8, result: { permissions: {}, scope: 'turn' } });
    transport.emit({ id: 9, method: 'item/permissions/requestApproval', params: {
      threadId: 'codex-thread-1', turnId: 'turn-1', permissions: { network: { enabled: true } },
    } });
    expect(executor.sendInput('remember')).toBe(false);
    expect(executor.sendInput('always')).toBe(true);
    expect(transport.responses.at(-1)?.result).toEqual({ permissions: { network: { enabled: true } }, scope: 'session' });
    transport.emit({ id: 10, method: 'item/permissions/requestApproval', params: {
      threadId: 'codex-thread-1', turnId: 'turn-1', permissions: { network: { enabled: true } },
    } });
    await executor.abort();
    expect(transport.responses.at(-1)).toEqual({ id: 10, result: { permissions: {}, scope: 'turn' } });
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'interrupted' } } });
    await turn;
  });

  it.each(['write', 'entries', 'fileChange'])('remembers an explicitly approved %s directory across backend recreation', async (format) => {
    await executor.configureSandbox('on');
    const extra = path.join(tempHome, 'shared');
    const permissions = { fileSystem: format === 'write'
      ? { write: [extra] } : { entries: [{ access: 'write', path: { type: 'path', path: extra } }] } };
    const turn = executor.execute('work');
    await vi.waitFor(() => expect(transport.requests.some(request => request.method === 'turn/start')).toBe(true));
    transport.emit({ id: 11, method: format === 'fileChange' ? 'item/fileChange/requestApproval' : 'item/permissions/requestApproval', params: {
      threadId: 'codex-thread-1', turnId: 'turn-1', permissions, grantRoot: format === 'fileChange' ? extra : undefined,
    } });
    expect(executor.sendInput('remember')).toBe(true);
    expect(transport.responses.at(-1)?.result).toEqual(format === 'fileChange' ? { decision: 'acceptForSession' } : { permissions, scope: 'session' });
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await turn;
    await executor.destroy();
    executor = new CodexAppServerExecutor(new DirectoryGuard([projectDir]), {
      threadId: 'remote-thread', initialWorkingDirectory: projectDir, clientFactory: () => new FakeTransport(),
    });
    expect(executor.getSandboxStatus()).toContain(extra);
    await executor.deleteThreadData('remote-thread');
    await expect(fs.stat(path.join(tempHome, '.remote-cli', 'codex-sandbox', 'remote-thread.json'))).rejects.toThrow();
  });

  it('rejects invalid policy changes and applies explicit read-only/full-access settings', async () => {
    expect(await executor.configureSandbox('on unexpected')).toMatchObject({ success: false });
    expect(await executor.configureSandbox('remove /missing-grant')).toMatchObject({ success: false });
    expect(await executor.configureSandbox('read-only')).toMatchObject({ success: true });
    expect(executor.getSandboxStatus()).toContain('Writable directories:\n- None');
    const promise = executor.execute('inspect');
    await vi.waitFor(() => expect(transport.requests.some(request => request.method === 'turn/start')).toBe(true));
    expect(transport.requests.find(request => request.method === 'turn/start')!.params.sandboxPolicy)
      .toEqual({ type: 'readOnly', networkAccess: true });
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await promise;
    expect(await executor.configureSandbox('off')).toMatchObject({ success: true });
    expect(executor.getSandboxStatus()).toContain('danger-full-access');
  });

  it('keeps the executor usable when a directory grant becomes invalid between turns', async () => {
    const extra = path.join(tempHome, 'authorized');
    await executor.configureSandbox('on');
    await executor.configureSandbox(`allow ${extra}`);
    const first = executor.execute('first');
    await vi.waitFor(() => expect(transport.requests.some(request => request.method === 'turn/start')).toBe(true));
    expect(transport.requests.find(request => request.method === 'turn/start')!.params.approvalsReviewer).toBe('user');
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await first;
    await fs.rmdir(extra);
    await fs.symlink(projectDir, extra);
    await expect(executor.execute('second')).resolves.toMatchObject({ success: false, error: expect.stringContaining('symbolic-link target') });
    expect(transport.requests.filter(request => request.method === 'turn/start')).toHaveLength(1);
    expect(await executor.configureSandbox('default')).toMatchObject({ success: true });
  });

  it('starts a thread, streams one copy of agent text, and persists the thread id', async () => {
    const chunks: string[] = [];
    const visible: string[] = [];
    const resultPromise = executor.execute('hello', {
      onStream: (chunk) => chunks.push(chunk),
      onDisplayText: (chunk) => visible.push(chunk),
    });
    await vi.waitFor(() => expect(transport.requests.some((request) => request.method === 'turn/start')).toBe(true));

    transport.emit({ method: 'item/agentMessage/delta', params: { threadId: 'codex-thread-1', turnId: 'turn-1', itemId: 'a', delta: 'hello back' } });
    transport.emit({ method: 'item/reasoning/summaryTextDelta', params: { threadId: 'codex-thread-1', turnId: 'turn-1', delta: 'Reasoning summary' } });
    transport.emit({ method: 'item/completed', params: { threadId: 'codex-thread-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'a', text: 'hello back' } } });
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });

    await expect(resultPromise).resolves.toMatchObject({ success: true, output: 'hello back' });
    expect(chunks).toEqual(['hello back', 'Reasoning summary']);
    expect(visible).toEqual(['hello back']);
    const session = JSON.parse(await fs.readFile(path.join(tempHome, '.remote-cli', 'codex-sessions', 'remote-thread.json'), 'utf8'));
    expect(session.id).toBe('codex-thread-1');
  });

  it('resumes an existing exec-mode thread id', async () => {
    const sessionDir = path.join(tempHome, '.remote-cli', 'codex-sessions');
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(path.join(sessionDir, 'existing.json'), JSON.stringify({ id: 'legacy-id' }));
    const existing = new CodexAppServerExecutor(new DirectoryGuard([projectDir]), {
      threadId: 'existing', initialWorkingDirectory: projectDir, clientFactory: () => transport,
    });
    const promise = existing.execute('continue', {});
    await vi.waitFor(() => expect(transport.requests.some((request) => request.method === 'turn/start')).toBe(true));
    expect(transport.requests.find((request) => request.method === 'thread/resume')?.params.threadId).toBe('legacy-id');
    transport.emit({ method: 'turn/completed', params: { threadId: 'legacy-id', turn: { id: 'turn-1', status: 'completed' } } });
    await promise;
    await existing.destroy();
  });

  it('reports a missing persisted delegated worker session before dispatching its objective', async () => {
    const sessionDir = path.join(tempHome, '.remote-cli', 'codex-sessions');
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(path.join(sessionDir, 'delegate-lane-11111111-1111-4111-8111-111111111111.json'), JSON.stringify({ id: 'missing-thread' }));
    transport.resumeError = new Error('No rollout found for thread missing-thread');
    const worker = new CodexAppServerExecutor(new DirectoryGuard([projectDir]), {
      threadId: 'delegate-lane-11111111-1111-4111-8111-111111111111',
      initialWorkingDirectory: projectDir,
      delegationWorker: true,
      clientFactory: () => transport,
    });
    try {
      await expect(worker.execute('inspect', {})).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining('Stored Codex thread could not be resumed'),
      });
      expect(transport.requests.some(request => request.method === 'turn/start')).toBe(false);
      expect(worker.consumeSessionResumeFailure()).toBe(true);
      expect(worker.consumeSessionResumeFailure()).toBe(false);
    } finally {
      await worker.destroy();
    }
  });

  it('notifies the original request when its background command exits during a later turn', async () => {
    const notify = vi.fn();
    const first = executor.execute('start a background command', { onTaskNotification: notify });
    await vi.waitFor(() => expect(transport.requests.some((entry) => entry.method === 'turn/start')).toBe(true));
    const command = { type: 'commandExecution', id: 'exec-1', command: 'npm test', status: 'inProgress', processId: '42' };
    transport.emit({ method: 'item/started', params: { threadId: 'codex-thread-1', turnId: 'turn-1', item: command } });
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await first;

    transport.nextTurnId = 'turn-2';
    const nextNotify = vi.fn();
    const nextToolResult = vi.fn();
    const nextStream = vi.fn();
    const second = executor.execute('next task', { onTaskNotification: nextNotify, onToolResult: nextToolResult, onStream: nextStream });
    await vi.waitFor(() => expect(transport.requests.filter((entry) => entry.method === 'turn/start')).toHaveLength(2));
    const completion = { method: 'item/completed', params: { threadId: 'codex-thread-1', turnId: 'turn-1', item: {
      ...command, status: 'completed', exitCode: 0, aggregatedOutput: 'All tests passed',
    } } };
    transport.emit({ ...completion, params: { ...completion.params, threadId: 'unrelated-thread' } });
    expect(notify).not.toHaveBeenCalled();
    transport.emit(completion);
    transport.emit(completion);
    transport.emit({ method: 'item/agentMessage/delta', params: { threadId: 'codex-thread-1', turnId: 'turn-1', delta: 'late reply' } });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({ taskId: 'exec-1', status: 'completed', summary: expect.stringContaining('All tests passed'), outputFile: '' });
    expect(nextNotify).not.toHaveBeenCalled();
    expect(nextToolResult).not.toHaveBeenCalled();
    expect(nextStream).not.toHaveBeenCalled();
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-2', status: 'completed' } } });
    await expect(second).resolves.toMatchObject({ success: true, output: '' });
  });

  it.each(['reset', 'destroy', 'disconnect'])('stops watching old tasks after %s', async (action) => {
    const notify = vi.fn();
    const result = executor.execute('start task', { onTaskNotification: notify });
    await vi.waitFor(() => expect(transport.requests.some((entry) => entry.method === 'turn/start')).toBe(true));
    const command = { type: 'commandExecution', id: 'old-task', command: 'npm test', status: 'inProgress' };
    transport.emit({ method: 'item/started', params: { threadId: 'codex-thread-1', turnId: 'turn-1', item: command } });
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await result;
    if (action === 'reset') executor.resetContext();
    else if (action === 'destroy') await executor.destroy();
    else transport.emit({ method: 'client/disconnected', params: { error: 'closed' } });
    transport.emit({ method: 'item/completed', params: { threadId: 'codex-thread-1', turnId: 'turn-1', item: { ...command, status: 'completed', exitCode: 0 } } });
    expect(notify).not.toHaveBeenCalled();
  });

  it('lists and validates models without changing the current turn', async () => {
    await expect(executor.listModels()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'gpt-a', isDefault: true }),
    ]));
    await expect(executor.setModel('missing')).resolves.toMatchObject({ success: false });
    await expect(executor.setModel('gpt-b')).resolves.toMatchObject({ success: true });

    const promise = executor.execute('use it', {});
    await vi.waitFor(() => expect(transport.requests.some((request) => request.method === 'turn/start')).toBe(true));
    expect(transport.requests.findLast((request) => request.method === 'turn/start')?.params.model).toBe('gpt-b');
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await promise;
  });

  it('marks isCurrent on the matching model in listModels', async () => {
    let models = await executor.listModels();
    expect(models.find((m) => m.id === 'gpt-a')?.isCurrent).toBeUndefined();

    await executor.setModel('gpt-b');
    models = await executor.listModels();
    expect(models.find((m) => m.id === 'gpt-b')?.isCurrent).toBe(true);
    expect(models.find((m) => m.id === 'gpt-a')?.isCurrent).toBe(false);
  });

  it('returns effort choices with current and default from native models in listEfforts', async () => {
    const effortInfo = await executor.listEfforts();
    expect(effortInfo.supportsReset).toBe(true);
    expect(effortInfo.choices).toEqual([
      { value: 'low', displayName: 'low' },
      { value: 'medium', displayName: 'medium' },
      { value: 'high', displayName: 'high' },
    ]);
    expect(effortInfo.default).toBe('medium');

    await executor.setModel('gpt-b');
    const bEffortInfo = await executor.listEfforts();
    expect(bEffortInfo.choices).toEqual([
      { value: 'medium', displayName: 'medium' },
      { value: 'high', displayName: 'high' },
    ]);
    expect(bEffortInfo.default).toBe('high');

    await executor.setEffort('high');
    const setEffortInfo = await executor.listEfforts();
    expect(setEffortInfo.current).toBe('high');
  });

  it('uses the reported model and effort rather than a differing configured request', async () => {
    (executor as any).model = 'gpt-a';
    (executor as any).effort = 'high';
    (executor as any).reportedModel = 'gpt-b';
    (executor as any).reportedEffort = 'medium';
    const listed = await executor.listModels();
    expect(listed.find(model => model.id === 'gpt-b')?.isCurrent).toBe(true);
    expect(listed.find(model => model.id === 'gpt-a')?.isCurrent).toBe(false);
    expect(await executor.listEfforts()).toMatchObject({ current: 'medium', default: 'high',
      choices: [{ value: 'medium', displayName: 'medium' }, { value: 'high', displayName: 'high' }] });
    await expect(executor.setEffort('low')).resolves.toMatchObject({ success: false });
    (executor as any).reportedModel = 'missing-native-model';
    expect(await executor.listEfforts()).toMatchObject({ choices: [], supportsReset: false });
  });

  it('does not guess that the first catalog model is the default effort target', async () => {
    vi.spyOn(executor, 'listModels').mockResolvedValue([{ id: 'first-model', displayName: 'First',
      supportedReasoningEfforts: ['high'] }]);
    expect(await executor.listEfforts()).toMatchObject({ choices: [], supportsReset: false });
    await expect(executor.setEffort('high')).resolves.toMatchObject({ success: false });
  });

  it('rejects a model switch incompatible with the saved effort without silently clearing it', async () => {
    await executor.setModel('gpt-a');
    await executor.setEffort('low');
    await expect(executor.setModel('gpt-b')).resolves.toMatchObject({ success: false, error: expect.stringContaining('Reset /effort auto') });
    expect(executor.getExecutionMetadata()).toMatchObject({ model: 'gpt-a', reasoningEffort: 'low' });
    await executor.setEffort('auto');
    await expect(executor.setModel('gpt-b')).resolves.toMatchObject({ success: true });
  });

  it('reads and formats Codex account rate limits without starting a thread', async () => {
    const request = vi.spyOn(transport, 'request');
    transport.rateLimitsResponse = {
      rateLimits: {},
      rateLimitsByLimitId: {
        codex: {
          limitName: 'Codex',
          primary: { usedPercent: 28, windowDurationMins: 300, resetsAt: 1_900_000_000 },
          secondary: { usedPercent: 61, windowDurationMins: 10_080 },
          credits: { hasCredits: true, unlimited: false, balance: '12.50' },
        },
      },
    };

    await expect(executor.getAccountUsage()).resolves.toEqual(expect.stringContaining('5-hour window: 72% remaining'));
    const output = await executor.getAccountUsage();
    expect(output).toContain('7-day window: 39% remaining');
    expect(output).toContain('Credits: 12.50');
    expect(transport.requests).toContainEqual({
      method: 'account/rateLimits/read',
      params: { excludeResetCreditDetails: true },
    });
    expect(request).toHaveBeenCalledWith('account/rateLimits/read', { excludeResetCreditDetails: true }, 10_000);
    expect(transport.requests.some((request) => request.method === 'thread/start')).toBe(false);
  });

  it('hides Codex account usage when the app-server method is unavailable', async () => {
    vi.spyOn(transport, 'request').mockRejectedValueOnce(new Error('Method not found'));
    await expect(executor.getAccountUsage()).resolves.toBeNull();
  });

  it('clears a selected model so the backend default is used', async () => {
    await executor.setModel('gpt-b');
    executor.clearModel();

    const promise = executor.execute('use default', {});
    await vi.waitFor(() => expect(transport.requests.some((request) => request.method === 'turn/start')).toBe(true));
    expect(transport.requests.findLast((request) => request.method === 'turn/start')?.params.model).toBeUndefined();
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await promise;
  });

  it('validates reasoning effort and applies it to future turns', async () => {
    await expect(executor.setEffort('unsupported')).resolves.toMatchObject({ success: false });
    await expect(executor.setEffort('high')).resolves.toMatchObject({ success: true });

    const promise = executor.execute('think hard', {});
    await vi.waitFor(() => expect(transport.requests.some((request) => request.method === 'turn/start')).toBe(true));
    expect(transport.requests.findLast((request) => request.method === 'turn/start')?.params.effort).toBe('high');
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await promise;
  });

  it('restores the active model default on an existing app-server thread', async () => {
    const first = executor.execute('start', {});
    await vi.waitFor(() => expect(transport.requests.some((request) => request.method === 'turn/start')).toBe(true));
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await first;

    await executor.setEffort('high');
    await expect(executor.setEffort('auto')).resolves.toMatchObject({ success: true });
    expect(transport.requests.findLast((request) => request.method === 'thread/settings/update')).toEqual({
      method: 'thread/settings/update',
      params: { threadId: 'codex-thread-1', effort: 'medium' },
    });

    const second = executor.execute('use default', {});
    await vi.waitFor(() => expect(transport.requests.filter((request) => request.method === 'turn/start')).toHaveLength(2));
    expect(transport.requests.findLast((request) => request.method === 'turn/start')?.params.effort).toBeUndefined();
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await second;
  });

  it('paginates model metadata and ignores malformed catalog entries', async () => {
    vi.spyOn(transport, 'request').mockImplementation(async (method: string, params?: any) => {
      transport.running = true;
      transport.requests.push({ method, params });
      if (method !== 'model/list') return {};
      if (params.cursor === null) {
        return {
          data: [
            { id: 'gpt-a', displayName: null, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'high' }, {}], inputModalities: ['text'] },
            { displayName: 'missing id' },
          ],
          nextCursor: 'page-2',
        };
      }
      return { data: [{ id: 'gpt-b' }], nextCursor: 123 };
    });

    await expect(executor.listModels()).resolves.toEqual([
      expect.objectContaining({ id: 'gpt-a', displayName: 'gpt-a', defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['high'], inputModalities: ['text'] }),
      expect.objectContaining({ id: 'gpt-b', displayName: 'gpt-b' }),
    ]);
    expect(transport.requests.filter((request) => request.method === 'model/list')).toHaveLength(2);
  });

  it('discovers opaque native service tiers without creating a conversation or inferring deprecated speed aliases', async () => {
    Object.assign(transport.models[0], { serviceTiers: [{ id: 'native-priority', name: 'Native Fast', description: 'Native description' }], defaultServiceTier: null });
    Object.assign(transport.models[1], { additionalSpeedTiers: ['fast'] });
    const models = await executor.listModels();
    expect(models[0]).toMatchObject({ serviceTiers: [{ id: 'native-priority', name: 'Native Fast', description: 'Native description' }], defaultServiceTier: null });
    expect(await executor.listSpeeds(models)).toMatchObject({ choices: [
      { value: 'default', displayName: 'Standard' }, { value: 'native-priority', displayName: 'Native Fast', description: 'Native description' }], default: null });
    expect(models[1].serviceTiers).toBeUndefined();
    expect(transport.requests.every(request => request.method === 'model/list' || request.method === 'config/read')).toBe(true);
  });

  it('keeps legacy models without native tiers free of speed controls and parameters', async () => {
    expect(await executor.listSpeeds()).toBeUndefined();
    expect(await executor.setSpeed('fast')).toMatchObject({ success: false });
    const turn = executor.execute('ordinary', {});
    await vi.waitFor(() => expect(transport.requests.some(request => request.method === 'turn/start')).toBe(true));
    for (const request of transport.requests) expect(request.params).not.toHaveProperty('serviceTier');
    expect(transport.requests.some(request => request.method === 'thread/settings/update' || request.method === 'config/read')).toBe(false);
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await turn;
  });

  it('uses reported, explicit, and configured models before the catalog default without creating metadata conversations', async () => {
    Object.assign(transport.models[0], { serviceTiers: [{ id: 'priority', name: 'Fast A' }] });
    Object.assign(transport.models[1], { serviceTiers: [{ id: 'tier-b', name: 'Speed B' }] });
    let nativeModel: string | undefined = 'gpt-b';
    const original = transport.request.bind(transport);
    const request = vi.spyOn(transport, 'request').mockImplementation(async (method, params) => {
      if (method === 'config/read') return { config: { model: nativeModel } };
      const result = await original(method, params);
      return method === 'thread/start' ? { ...result, model: 'gpt-b' } : result;
    });
    expect((await executor.listSpeeds())?.choices.map(choice => choice.value)).toEqual(['default', 'tier-b']);
    nativeModel = 'unknown-configured-model';
    expect(await executor.listSpeeds()).toBeUndefined();
    nativeModel = undefined;
    expect((await executor.listSpeeds())?.choices.map(choice => choice.value)).toEqual(['default', 'priority']);
    expect(transport.requests.some(item => item.method === 'thread/start' || item.method === 'turn/start')).toBe(false);
    expect((await executor.setModel('gpt-a')).success).toBe(true);
    const configCalls = request.mock.calls.filter(([method]) => method === 'config/read').length;
    expect((await executor.listSpeeds())?.choices[1].value).toBe('priority');
    expect(request.mock.calls.filter(([method]) => method === 'config/read')).toHaveLength(configCalls);
    const turn = executor.execute('reported model', {});
    await vi.waitFor(() => expect(transport.requests.some(item => item.method === 'turn/start')).toBe(true));
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await turn;
    expect((await executor.listSpeeds())?.choices[1].value).toBe('tier-b');
  });

  it.each(['selection', 'execution'] as const)('revalidates the restored model before speed %s can affect a turn', async mode => {
    Object.assign(transport.models[0], { serviceTiers: [{ id: 'priority', name: 'Fast A' }] });
    Object.assign(transport.models[1], { serviceTiers: [] });
    await executor.destroy();
    await fs.writeFile(path.join(tempHome, '.remote-cli', 'codex-sessions', 'remote-thread.json'), JSON.stringify({ id: 'codex-thread-1' }));
    const original = transport.request.bind(transport);
    vi.spyOn(transport, 'request').mockImplementation(async (method, params) => {
      if (method === 'config/read') return { config: { model: 'gpt-a' } };
      const result = await original(method, params);
      return method === 'thread/resume' ? { ...result, model: 'gpt-b' } : result;
    });
    executor = new CodexAppServerExecutor(new DirectoryGuard([projectDir]), {
      threadId: 'remote-thread', initialWorkingDirectory: projectDir, clientFactory: () => transport,
      ...(mode === 'execution' ? { speed: 'priority' } : {}),
    });
    const result = mode === 'selection' ? await executor.setSpeed('priority')
      : await executor.execute('Do not start an incompatible turn', { timeout: 100 });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('model reported by Codex') });
    expect(transport.requests.some(request => request.method === 'turn/start' || request.method === 'thread/settings/update')).toBe(false);
    expect((await executor.setSpeed(undefined)).success).toBe(true);
  });

  it.each([
    { tier: 'fast', fastMode: false, model: 'gpt-a', expected: null },
    { tier: 'priority', fastMode: false, model: 'gpt-a', expected: null },
    { tier: 'fast', fastMode: true, model: 'gpt-a', expected: 'priority' },
    { tier: 'priority', fastMode: undefined, model: 'gpt-a', expected: 'priority' },
    { tier: 'priority', fastMode: true, model: 'gpt-b', expected: null },
    { tier: 'priority', fastMode: true, model: 'unknown-model', expected: null },
    { tier: 'flex', fastMode: false, model: 'gpt-b', expected: 'flex' },
    { tier: 'default', fastMode: false, model: 'gpt-a', expected: 'default' },
  ])('follows the effective native speed policy ($tier, flag=$fastMode, model=$model)', async ({ tier, fastMode, model, expected }) => {
    await executor.destroy();
    Object.assign(transport.models[0], { serviceTiers: [{ id: 'priority', name: 'Fast' }] });
    Object.assign(transport.models[1], { serviceTiers: [] });
    const original = transport.request.bind(transport);
    vi.spyOn(transport, 'request').mockImplementation(async (method, params) => method === 'config/read'
      ? { config: { model, service_tier: tier, features: fastMode === undefined ? {} : { fast_mode: fastMode } } } : original(method, params));
    executor = new CodexAppServerExecutor(new DirectoryGuard([projectDir]), { threadId: 'remote-thread', initialWorkingDirectory: projectDir,
      speed: null, clientFactory: () => transport });
    const turn = executor.execute('follow effective policy', {});
    await vi.waitFor(() => expect(transport.requests.some(item => item.method === 'turn/start')).toBe(true));
    expect(transport.requests.find(item => item.method === 'thread/start')?.params.serviceTier).toBe(expected);
    expect(transport.requests.find(item => item.method === 'turn/start')?.params.serviceTier).toBe(expected);
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await turn;
    if (tier === 'fast' && fastMode === false && model === 'gpt-a') {
      expect((await executor.setSpeed('priority')).success).toBe(true);
      expect(transport.requests.findLast(item => item.method === 'thread/settings/update')?.params.serviceTier).toBe('priority');
    }
  });

  it('recovers a vanished saved tier without loading it and clears sticky speed on the same conversation after process recreation', async () => {
    Object.assign(transport.models[0], { serviceTiers: [{ id: 'priority', name: 'Fast' }] });
    await executor.setSpeed('priority');
    const seed = executor.execute('seed', {});
    await vi.waitFor(() => expect(transport.requests.some(item => item.method === 'turn/start')).toBe(true));
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await seed;
    await executor.destroy();
    transport = new FakeTransport(); Object.assign(transport.models[0], { serviceTiers: [] });
    const original = transport.request.bind(transport);
    vi.spyOn(transport, 'request').mockImplementation(async (method, params) => method === 'config/read'
      ? { config: { model: 'gpt-a', service_tier: 'priority', features: { fast_mode: true } } } : original(method, params));
    executor = new CodexAppServerExecutor(new DirectoryGuard([projectDir]), { threadId: 'remote-thread', initialWorkingDirectory: projectDir,
      speed: 'priority', clientFactory: () => transport });
    expect(await executor.execute('blocked obsolete speed', {})).toMatchObject({ success: false });
    expect(await executor.listSpeeds()).toMatchObject({ choices: [], current: 'priority' });
    const stop = vi.spyOn(transport, 'stop');
    expect((await executor.setSpeed(undefined)).success).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
    expect(transport.requests.some(item => item.method === 'thread/resume' || item.method === 'thread/start' || item.method === 'turn/start')).toBe(false);
    expect(executor.getSessionId()).toBe('codex-thread-1');
    const resumed = executor.execute('recover the same conversation', {});
    await vi.waitFor(() => expect(transport.requests.some(item => item.method === 'turn/start')).toBe(true));
    expect(transport.requests.find(item => item.method === 'thread/resume')?.params).toMatchObject({ threadId: 'codex-thread-1', serviceTier: null });
    expect(transport.requests.find(item => item.method === 'turn/start')?.params.serviceTier).toBeNull();
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await resumed;
  });

  it('omits unsupported speed keys for fresh legacy workers, but refuses an uncertain legacy conversation until cleared', async () => {
    const seed = executor.execute('legacy seed', {});
    await vi.waitFor(() => expect(transport.requests.some(item => item.method === 'turn/start')).toBe(true));
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await seed; await executor.destroy();
    transport = new FakeTransport();
    executor = new CodexAppServerExecutor(new DirectoryGuard([projectDir]), { threadId: 'remote-thread', initialWorkingDirectory: projectDir,
      speed: 'priority', clientFactory: () => transport });
    expect((await executor.listSpeeds())?.choices).toEqual([]);
    expect((await executor.setSpeed(undefined)).success).toBe(true);
    expect(await executor.execute('uncertain old binding', {})).toMatchObject({ success: false, error: expect.stringContaining('Upgrade Codex or use /clear') });
    expect(transport.requests.some(item => item.method === 'thread/resume')).toBe(false);
    await executor.resetContext();
    const fresh = executor.execute('fresh after clear', {});
    await vi.waitFor(() => expect(transport.requests.some(item => item.method === 'turn/start')).toBe(true));
    for (const item of transport.requests) expect(item.params).not.toHaveProperty('serviceTier');
    expect(transport.requests.some(item => item.method === 'config/read')).toBe(false);
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await fresh;
    await executor.destroy(); transport = new FakeTransport();
    executor = new CodexAppServerExecutor(new DirectoryGuard([projectDir]), { threadId: 'fresh-worker', delegationWorker: true,
      initialWorkingDirectory: projectDir, speed: null, clientFactory: () => transport });
    const worker = executor.execute('fresh worker', {});
    await vi.waitFor(() => expect(transport.requests.some(item => item.method === 'turn/start')).toBe(true));
    for (const item of transport.requests) expect(item.params).not.toHaveProperty('serviceTier');
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await worker;
  });

  it('does not turn malformed native Fast policy into paid speed or require a working config query to save recovery', async () => {
    await executor.destroy();
    Object.assign(transport.models[0], { serviceTiers: [{ id: 'priority', name: 'Fast' }] });
    const original = transport.request.bind(transport);
    vi.spyOn(transport, 'request').mockImplementation(async (method, params) => method === 'config/read'
      ? { config: { service_tier: 'priority', features: { fast_mode: 'false' } } } : original(method, params));
    executor = new CodexAppServerExecutor(new DirectoryGuard([projectDir]), { threadId: 'remote-thread', initialWorkingDirectory: projectDir,
      speed: 'priority', clientFactory: () => transport });
    expect(await executor.listSpeeds()).toMatchObject({ choices: [], current: 'priority' });
    expect((await executor.setSpeed(undefined)).success).toBe(true);
    expect((await executor.execute('invalid native policy', {})).success).toBe(false);
    expect(transport.requests.some(item => item.method === 'thread/start' || item.method === 'turn/start')).toBe(false);
  });

  it('retains the saved tier when the owned idle server cannot confirm its stop during recovery', async () => {
    Object.assign(transport.models[0], { serviceTiers: [{ id: 'priority', name: 'Fast' }] });
    expect((await executor.setSpeed('priority')).success).toBe(true);
    vi.spyOn(transport, 'stop').mockRejectedValueOnce(new Error('Synthetic unconfirmed exit'));
    expect((await executor.setSpeed(undefined)).success).toBe(false);
    expect((await executor.listSpeeds())?.current).toBe('priority');
    expect(transport.requests.some(item => item.method === 'thread/start' || item.method === 'thread/resume')).toBe(false);
  });

  it('applies explicit speed on thread and turn requests and refuses incompatible model changes', async () => {
    Object.assign(transport.models[0], { serviceTiers: [{ id: 'priority', name: 'Fast' }] });
    expect(await executor.setSpeed('priority')).toMatchObject({ success: true });
    expect(transport.requests.some(request => request.method === 'thread/start')).toBe(false);
    expect(await executor.setModel('gpt-b')).toMatchObject({ success: false, error: expect.stringContaining('saved speed') });
    expect(() => executor.clearModel()).toThrow('Follow native config');
    const turn = executor.execute('fast', {});
    await vi.waitFor(() => expect(transport.requests.some(request => request.method === 'turn/start')).toBe(true));
    expect(transport.requests.find(request => request.method === 'thread/start')?.params.serviceTier).toBe('priority');
    expect(transport.requests.find(request => request.method === 'turn/start')?.params.serviceTier).toBe('priority');
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await turn;
  });

  it.each([null, 'priority'])('restores native config (%s), rather than retaining sticky Fast, and supports explicit Standard', async nativeTier => {
    Object.assign(transport.models[0], { serviceTiers: [{ id: 'priority', name: 'Fast' }] });
    await executor.setSpeed('priority');
    const turn = executor.execute('seed', {});
    await vi.waitFor(() => expect(transport.requests.some(request => request.method === 'turn/start')).toBe(true));
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await turn;
    const original = transport.request.bind(transport);
    vi.spyOn(transport, 'request').mockImplementation(async (method, params) => method === 'config/read'
      ? { config: { service_tier: nativeTier } } : original(method, params));
    expect(await executor.setSpeed(undefined)).toMatchObject({ success: true });
    const resumed = executor.execute('resume after Follow', {});
    await vi.waitFor(() => expect(transport.requests.some(request => request.method === 'thread/resume')).toBe(true));
    expect(transport.requests.findLast(request => request.method === 'thread/resume')?.params).toMatchObject({ threadId: 'codex-thread-1', serviceTier: nativeTier });
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await resumed;
    expect((await executor.listSpeeds())?.current).toBeUndefined();
    expect(await executor.setSpeed('default')).toMatchObject({ success: true });
    expect(transport.requests.findLast(request => request.method === 'thread/settings/update')?.params.serviceTier).toBe('default');
  });

  it('rejects invalid speed metadata and choices, and does not mutate while busy', async () => {
    Object.assign(transport.models[0], { serviceTiers: [{ id: 'bad\nvalue', name: 'Fast' }] });
    expect(await executor.listSpeeds()).toBeUndefined();
    Object.assign(transport.models[0], { serviceTiers: [{ id: 'priority', name: 'Fast' }] });
    expect((await executor.setSpeed('fast')).success).toBe(false);
    const turn = executor.execute('busy', {});
    await vi.waitFor(() => expect(transport.requests.some(request => request.method === 'turn/start')).toBe(true));
    expect((await executor.setSpeed('priority')).success).toBe(false);
    expect(transport.requests.some(request => request.method === 'thread/settings/update')).toBe(false);
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await turn;
  });

  it('applies a persisted Follow marker on resume without replaying an earlier sticky Fast tier', async () => {
    const turn = executor.execute('seed', {});
    await vi.waitFor(() => expect(transport.requests.some(request => request.method === 'turn/start')).toBe(true));
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await turn;
    await executor.destroy();
    transport = new FakeTransport();
    Object.assign(transport.models[0], { serviceTiers: [] });
    const original = transport.request.bind(transport);
    vi.spyOn(transport, 'request').mockImplementation(async (method, params) => method === 'config/read' ? { config: {} } : original(method, params));
    executor = new CodexAppServerExecutor(new DirectoryGuard([projectDir]), { threadId: 'remote-thread', initialWorkingDirectory: projectDir,
      speed: null, clientFactory: () => transport });
    const next = executor.execute('resumed', {});
    await vi.waitFor(() => expect(transport.requests.some(request => request.method === 'turn/start')).toBe(true));
    expect(transport.requests.find(request => request.method === 'thread/resume')?.params.serviceTier).toBeNull();
    expect(transport.requests.find(request => request.method === 'turn/start')?.params.serviceTier).toBeNull();
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await next;
  });

  it('does not publish a late speed acknowledgement after reset', async () => {
    Object.assign(transport.models[0], { serviceTiers: [{ id: 'priority', name: 'Fast' }] });
    const turn = executor.execute('seed', {});
    await vi.waitFor(() => expect(transport.requests.some(request => request.method === 'turn/start')).toBe(true));
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await turn;
    const original = transport.request.bind(transport);
    let release!: (value: any) => void;
    vi.spyOn(transport, 'request').mockImplementation(async (method, params) => method === 'thread/settings/update'
      ? new Promise(resolve => { release = resolve; }) : original(method, params));
    const setting = executor.setSpeed('priority');
    await vi.waitFor(() => expect(release).toBeDefined());
    await executor.resetContext(); release({});
    expect((await setting).success).toBe(false);
    expect((await executor.listSpeeds())?.current).toBeUndefined();
  });

  it('refreshes an idle app-server after a Codex CLI upgrade while preserving its session', async () => {
    const first = executor.execute('first', {});
    await vi.waitFor(() => expect(transport.requests.some((request) => request.method === 'turn/start')).toBe(true));
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await first;

    transport.serverVersion = '0.154.0';
    transport.commandVersion = '0.159.2';
    const stop = vi.spyOn(transport, 'stop');

    await executor.listModels();
    expect(stop).toHaveBeenCalledTimes(1);

    const second = executor.execute('second', {});
    await vi.waitFor(() => expect(transport.requests.some((request) => request.method === 'thread/resume')).toBe(true));
    expect(transport.requests.findLast((request) => request.method === 'thread/resume')?.params).toMatchObject({ threadId: 'codex-thread-1' });
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await second;
  });

  it('does not restart an app-server that becomes busy while checking its command version', async () => {
    transport.running = true;
    transport.serverVersion = '0.154.0';
    let releaseVersion: ((version: string | null) => void) | undefined;
    vi.spyOn(transport, 'getCommandVersion').mockImplementation(() => new Promise((resolve) => {
      releaseVersion = resolve;
    }));
    const stop = vi.spyOn(transport, 'stop');

    const listing = executor.listModels();
    await vi.waitFor(() => expect(releaseVersion).toBeDefined());
    const running = executor.execute('running', {});
    await vi.waitFor(() => expect(transport.requests.some((request) => request.method === 'turn/start')).toBe(true));

    releaseVersion!('0.159.2');
    await listing;
    expect(stop).not.toHaveBeenCalled();

    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await running;
  });

  it('clears only the conversation pointer and preserves model and cwd', async () => {
    const first = executor.execute('first', {});
    await vi.waitFor(() => expect(transport.requests.some((request) => request.method === 'turn/start')).toBe(true));
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await first;
    await executor.setModel('gpt-b');

    executor.resetContext();
    expect(executor.getSessionId()).toBeNull();
    expect(executor.getCurrentWorkingDirectory()).toBe(projectDir);
    transport.nextThreadId = 'codex-thread-2';
    const second = executor.execute('fresh', {});
    await vi.waitFor(() => expect(transport.requests.filter((request) => request.method === 'thread/start')).toHaveLength(2));
    expect(transport.requests.findLast((request) => request.method === 'turn/start')?.params.model).toBe('gpt-b');
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-2', turn: { id: 'turn-1', status: 'completed' } } });
    await second;
  });

  it('updates the transport cwd and rejects overlapping operations', async () => {
    const child = path.join(projectDir, 'child');
    await fs.mkdir(child);
    await executor.setWorkingDirectory(child);
    expect(transport.cwd).toBe(child);
    await expect(executor.compactWhenFull()).resolves.toMatchObject({ success: true });

    const running = executor.execute('busy', {});
    await vi.waitFor(() => expect(transport.requests.some((request) => request.method === 'turn/start')).toBe(true));
    await expect(executor.execute('overlap', {})).resolves.toMatchObject({ success: false });
    await expect(executor.compactWhenFull()).resolves.toMatchObject({ success: false });
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await running;
  });

  it('settles an active command when the conversation is cleared', async () => {
    const running = executor.execute('busy', {});
    await vi.waitFor(() => expect(transport.requests.some((request) => request.method === 'turn/start')).toBe(true));
    executor.resetContext();
    await expect(running).resolves.toMatchObject({ success: false, error: 'Conversation cleared by user' });
    expect(executor.getSessionId()).toBeNull();
    expect(transport.running).toBe(false);
  });

  it('waits for native compaction completion', async () => {
    const first = executor.execute('first', {});
    await vi.waitFor(() => expect(transport.requests.some((request) => request.method === 'turn/start')).toBe(true));
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await first;

    const compact = executor.compactWhenFull();
    await vi.waitFor(() => expect(transport.requests.some((request) => request.method === 'thread/compact/start')).toBe(true));
    let settled = false;
    void compact.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    transport.emit({ method: 'item/completed', params: { threadId: 'codex-thread-1', turnId: 'compact-turn', item: { type: 'contextCompaction', id: 'compact' } } });
    await expect(compact).resolves.toMatchObject({ success: true });
  });

  it('keeps an uncertain turn/start timeout fenced until transport exit is confirmed', async () => {
    const start = deferred<any>();
    const exit = deferred<void>();
    const request = transport.request.bind(transport);
    let delayed = true;
    vi.spyOn(transport, 'request').mockImplementation((method, params) => {
      if (method === 'turn/start' && delayed) {
        delayed = false;
        transport.running = true;
        transport.requests.push({ method, params });
        return start.promise;
      }
      return request(method, params);
    });
    const stop = vi.spyOn(transport, 'stop').mockImplementation(async () => {
      await exit.promise;
      transport.running = false;
    });
    const onStream = vi.fn();
    const running = executor.execute('possibly accepted prompt', { timeout: 10, onStream });
    let settled = false;
    void running.then(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(transport.requests.some(item => item.method === 'turn/start')).toBe(true));
      await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
      expect(settled).toBe(false);
      expect(executor.isBusy()).toBe(true);
      await expect(executor.execute('must not race stopping', {})).resolves.toMatchObject({
        success: false, error: expect.stringContaining('already running'),
      });
      expect(transport.requests.filter(item => item.method === 'turn/start')).toHaveLength(1);

      start.resolve({ turn: { id: 'accepted-turn' } });
      transport.emit({ method: 'item/agentMessage/delta', params: {
        threadId: 'codex-thread-1', turnId: 'accepted-turn', delta: 'late uncertain output',
      } });
      await Promise.resolve();
      expect(onStream).not.toHaveBeenCalled();
      expect(transport.requests.filter(item => item.method === 'turn/start')).toHaveLength(1);

      exit.resolve();
      await expect(running).resolves.toMatchObject({ success: false, error: expect.stringContaining('timed out') });
      await vi.waitFor(() => expect(executor.isBusy()).toBe(false));
      expect(transport.running).toBe(false);
      expect(executor.getSessionId()).toBe('codex-thread-1');

      const fresh = executor.execute('explicit fresh request', {});
      await vi.waitFor(() => expect(transport.requests.filter(item => item.method === 'turn/start')).toHaveLength(2));
      transport.emit({ method: 'turn/completed', params: {
        threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' },
      } });
      await expect(fresh).resolves.toMatchObject({ success: true });
    } finally {
      start.resolve({ turn: { id: 'accepted-turn' } });
      exit.resolve();
      transport.running = false;
    }
  });

  it.each([
    ['rejection', new Error('turn/start rejected')],
    ['malformed success', { turn: { id: '' } }],
  ])('stops the transport after turn/start %s before releasing ownership', async (_kind, outcome) => {
    const start = deferred<any>();
    const request = transport.request.bind(transport);
    vi.spyOn(transport, 'request').mockImplementation((method, params) => {
      if (method === 'turn/start') {
        transport.running = true;
        transport.requests.push({ method, params });
        return start.promise;
      }
      return request(method, params);
    });
    const running = executor.execute('uncertain request', {});
    await vi.waitFor(() => expect(transport.requests.some(item => item.method === 'turn/start')).toBe(true));
    if (outcome instanceof Error) start.reject(outcome);
    else start.resolve(outcome);
    await expect(running).resolves.toMatchObject({ success: false });
    await vi.waitFor(() => expect(executor.isBusy()).toBe(false));
    expect(transport.running).toBe(false);
    expect(executor.getSessionId()).toBe('codex-thread-1');
  });

  it('does not become idle or accept another turn when transport stop fails', async () => {
    const start = deferred<any>();
    const request = transport.request.bind(transport);
    vi.spyOn(transport, 'request').mockImplementation((method, params) => {
      if (method === 'turn/start') {
        transport.running = true;
        transport.requests.push({ method, params });
        return start.promise;
      }
      return request(method, params);
    });
    const stop = vi.spyOn(transport, 'stop').mockRejectedValue(new Error('Synthetic exit unconfirmed'));
    const running = executor.execute('uncertain request', {});
    try {
      await vi.waitFor(() => expect(transport.requests.some(item => item.method === 'turn/start')).toBe(true));
      start.reject(new Error('turn/start timed out'));
      await expect(running).resolves.toMatchObject({ success: false, error: 'turn/start timed out' });
      expect(stop).toHaveBeenCalledOnce();
      await Promise.resolve();
      expect(executor.isBusy()).toBe(true);
      await expect(executor.execute('still blocked', {})).resolves.toMatchObject({
        success: false, error: expect.stringContaining('already running'),
      });
      expect(transport.requests.filter(item => item.method === 'turn/start')).toHaveLength(1);
    } finally {
      stop.mockImplementation(async () => { transport.running = false; });
    }
  });

  it.each(['pending start', 'interrupt failure'])('does not confirm the first abort after a failed stop during %s', async kind => {
    const start = deferred<any>();
    const request = transport.request.bind(transport);
    const stop = transport.stop.bind(transport);
    vi.spyOn(transport, 'request').mockImplementation((method, params) => {
      if (method === 'turn/start' && kind === 'pending start') {
        transport.running = true;
        transport.requests.push({ method, params });
        return start.promise;
      }
      if (method === 'turn/interrupt') return Promise.reject(new Error('Synthetic interrupt failure'));
      return request(method, params);
    });
    vi.spyOn(transport, 'stop').mockRejectedValueOnce(new Error('Synthetic stop failure')).mockImplementation(stop);
    const running = executor.execute('request to abort', {});
    try {
      await vi.waitFor(() => expect(transport.requests.some(item => item.method === 'turn/start')).toBe(true));
      if (kind === 'interrupt failure') {
        await vi.waitFor(() => expect((executor as any).activeTurn?.turnId).toBeTruthy());
      }
      await expect(executor.abort()).resolves.toBe(false);
      await expect(running).resolves.toMatchObject({ success: false });
      expect(executor.hasUncertainShutdown()).toBe(true);
      expect(executor.isBusy()).toBe(true);
      await expect(executor.execute('must stay blocked', {})).resolves.toMatchObject({ success: false });
      expect(transport.requests.filter(item => item.method === 'turn/start')).toHaveLength(1);
    } finally {
      start.resolve({ turn: { id: 'late-aborted-turn' } });
      await running;
    }
  });

  it('retries an uncertain transport stop through abort without replaying late work', async () => {
    const start = deferred<any>();
    const request = transport.request.bind(transport);
    const onStream = vi.fn();
    vi.spyOn(transport, 'request').mockImplementation((method, params) => {
      if (method === 'turn/start') {
        transport.running = true;
        transport.requests.push({ method, params });
        return start.promise;
      }
      return request(method, params);
    });
    vi.spyOn(transport, 'stop')
      .mockRejectedValueOnce(new Error('Initial stop failed'))
      .mockRejectedValueOnce(new Error('Retry stop failed'))
      .mockImplementation(async () => { transport.running = false; });
    const running = executor.execute('uncertain request', { onStream });
    await vi.waitFor(() => expect(transport.requests.some(item => item.method === 'turn/start')).toBe(true));
    start.reject(new Error('turn/start timed out'));
    await expect(running).resolves.toMatchObject({ success: false });
    expect(executor.isBusy()).toBe(true);

    await expect(executor.abort()).resolves.toBe(false);
    expect(executor.isBusy()).toBe(true);
    await expect(executor.execute('must stay blocked', {})).resolves.toMatchObject({ success: false });
    expect(transport.requests.filter(item => item.method === 'turn/start')).toHaveLength(1);

    await expect(executor.abort()).resolves.toBe(true);
    expect(executor.isBusy()).toBe(false);
    expect(transport.running).toBe(false);
    transport.emit({ method: 'item/agentMessage/delta', params: { threadId: 'codex-thread-1', turnId: 'turn-1', delta: 'late uncertain output' } });
    expect(onStream).not.toHaveBeenCalled();
    expect(transport.requests.filter(item => item.method === 'turn/start')).toHaveLength(1);
  });

  it('keeps queued work admitted when native exit is unconfirmed after foreground completion', async () => {
    await executor.destroy();
    const manager = await ThreadManager.initialize(tempHome);
    const threadId = manager.getDefaultThread().id;
    await manager.updateThread(threadId, { workingDirectory: projectDir });
    const guard = new DirectoryGuard([tempHome]);
    executor = new CodexAppServerExecutor(guard, {
      threadId, initialWorkingDirectory: projectDir, clientFactory: () => transport,
    });
    const pool = new ThreadExecutorPool(manager, guard, { type: 'codex' }, () => executor);
    pool.getExecutor(threadId);
    const start = deferred<any>();
    const request = transport.request.bind(transport);
    vi.spyOn(transport, 'request').mockImplementation((method, params) => {
      if (method === 'turn/start') {
        transport.running = true;
        transport.requests.push({ method, params });
        return start.promise;
      }
      return request(method, params);
    });
    const stop = vi.spyOn(transport, 'stop').mockRejectedValue(new Error('Synthetic exit unconfirmed'));
    pool.setThreadBusy(threadId, true);
    const running = executor.execute('uncertain request', {});
    const executeCommand = vi.fn().mockResolvedValue(undefined);
    try {
      await vi.waitFor(() => expect(transport.requests.some(item => item.method === 'turn/start')).toBe(true));
      start.reject(new Error('turn/start timed out'));
      await expect(running).resolves.toMatchObject({ success: false });
      pool.setThreadBusy(threadId, false);

      const command = { messageId: 'queued-command', content: 'retain me', openId: 'owner', timestamp: Date.now() };
      const queue = [command];
      const admission = {
        settingsAdmission: { isBlocked: () => false },
        threadPool: pool,
        pausedQueues: new Set<string>(),
        abortOperations: new Map(),
        threadQueues: new Map([[threadId, queue]]),
        threadManager: manager,
        messageOpenIds: new Map(),
        notificationAdapter: { setCurrentOpenId: vi.fn() },
        wsClient: { send: vi.fn() },
        currentOpenId: undefined,
        beginThreadOperation: vi.fn(() => { pool.setThreadBusy(threadId, true); return Symbol('queued'); }),
        finishThreadOperation: vi.fn(() => { pool.setThreadBusy(threadId, false); return false; }),
        trackTask: vi.fn(),
        expandCommandShortcuts: (content: string) => content,
        executeCommand,
      };
      await (MessageHandler.prototype as any).startNextQueuedCommand.call(admission, threadId);

      expect(pool.isThreadBusy(threadId)).toBe(true);
      expect(queue).toEqual([command]);
      expect(executeCommand).not.toHaveBeenCalled();
      expect(transport.requests.filter(item => item.method === 'turn/start')).toHaveLength(1);
    } finally {
      pool.setThreadBusy(threadId, false);
      stop.mockImplementation(async () => { transport.running = false; });
    }
  });

  it('interrupts the active turn and preserves the session id', async () => {
    const running = executor.execute('long task', {});
    await vi.waitFor(() => expect(transport.requests.some((request) => request.method === 'turn/start')).toBe(true));
    await expect(executor.abort()).resolves.toBe(true);
    expect(transport.requests.find((request) => request.method === 'turn/interrupt')?.params).toEqual({
      threadId: 'codex-thread-1', turnId: 'turn-1',
    });
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'interrupted' } } });
    await expect(running).resolves.toMatchObject({ success: false, error: 'Aborted by user' });
    expect(executor.getSessionId()).toBe('codex-thread-1');
  });

  it.each([
    [[{ type: 'read', path: '/project/src/config.ts', name: 'config.ts' }], 'Read config.ts'],
    [[{ type: 'search', path: '/project', query: 'synthetic-private-query' }], 'Search files'],
    [[{ type: 'listFiles', path: '/project' }], 'List directory'],
    [[{ type: 'unknown', command: 'npm test' }], 'Run npm command'],
    [[{ type: 'unknown', command: 'git status --short' }], 'Run Git command'],
    [undefined, 'Run shell command'],
  ])('forwards structured command labels and keeps one call through delayed completion (%j)', async (commandActions, description) => {
    const onToolUse = vi.fn();
    const onToolResult = vi.fn();
    const onActivity = vi.fn();
    const running = executor.execute('inspect', { onToolUse, onToolResult, onActivity });
    await vi.waitFor(() => expect(transport.requests.some(request => request.method === 'turn/start')).toBe(true));
    const item = { type: 'commandExecution', id: 'cmd-label', command: 'synthetic-private-command', commandActions };
    const emitItem = (method: string, value: any) => transport.emit({ method,
      params: { threadId: 'codex-thread-1', turnId: 'turn-1', item: value } });
    emitItem('item/started', item);
    expect(onToolUse).toHaveBeenCalledWith({ id: 'cmd-label', name: 'Bash', input: { command: item.command },
      ...(description ? { description } : {}) });
    expect(onActivity).toHaveBeenCalledWith({ source: 'tool', text: description ?? 'Running command' });
    transport.emit({ method: 'item/reasoning/summaryTextDelta', params: {
      threadId: 'codex-thread-1', turnId: 'turn-1', itemId: 'reasoning-1', summaryIndex: 0, delta: 'Execution-wide progress',
    } });
    await Promise.resolve();
    emitItem('item/completed', { ...item, status: 'completed', exitCode: 0, aggregatedOutput: 'ok' });
    emitItem('item/completed', { ...item, status: 'failed', exitCode: 1, aggregatedOutput: 'Failed' });
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await running;
    expect(onToolUse).toHaveBeenCalledOnce();
    expect(onToolUse.mock.calls[0][0].description).toBe(description);
    expect(onToolResult.mock.calls.map(([result]) => result)).toEqual([
      { tool_use_id: 'cmd-label', content: 'ok', is_error: false },
      { tool_use_id: 'cmd-label', content: 'Failed', is_error: true },
    ]);
  });

  it('describes completion-only command items without requiring an item-start event', async () => {
    const onToolUse = vi.fn();
    const running = executor.execute('inspect', { onToolUse });
    await vi.waitFor(() => expect(transport.requests.some(request => request.method === 'turn/start')).toBe(true));
    transport.emit({ method: 'item/completed', params: { threadId: 'codex-thread-1', turnId: 'turn-1', item: {
      type: 'commandExecution', id: 'completed-label', command: 'synthetic-private-command',
      commandActions: [{ type: 'read', name: 'config.ts' }], status: 'completed', exitCode: 0,
    } } });
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await running;
    expect(onToolUse).toHaveBeenCalledWith({ id: 'completed-label', name: 'Bash',
      input: { command: 'synthetic-private-command' }, description: 'Read config.ts' });
  });

  it('enriches the pending call when native actions arrive later, without another row after a result', async () => {
    const onToolUse = vi.fn(), onToolResult = vi.fn();
    const running = executor.execute('inspect', { onToolUse, onToolResult });
    await vi.waitFor(() => expect(transport.requests.some(request => request.method === 'turn/start')).toBe(true));
    const emit = (method: string, item: any) => transport.emit({ method,
      params: { threadId: 'codex-thread-1', turnId: 'turn-1', item } });
    const item = { type: 'commandExecution', id: 'late-label', command: 'custom-program' };
    emit('item/started', item);
    expect(onToolUse.mock.calls[0][0].description).toBe('Run shell command');
    emit('item/completed', { ...item, commandActions: [{ type: 'read', name: 'config.ts' }],
      status: 'completed', exitCode: 0, aggregatedOutput: 'ok' });
    expect(onToolUse.mock.calls.map(([tool]) => tool.description)).toEqual(['Run shell command', 'Read config.ts']);
    expect(onToolUse.mock.calls.map(([tool]) => tool.id)).toEqual(['late-label', 'late-label']);
    emit('item/completed', { ...item, commandActions: [{ type: 'search' }], status: 'failed', exitCode: 1 });
    expect(onToolUse).toHaveBeenCalledTimes(2);
    expect(onToolResult).toHaveBeenCalledTimes(2);
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await running;
  });

  it.each([undefined, 'Inspect configuration'])('preserves native labels through sparse updates (title=%s)', async title => {
    const onToolUse = vi.fn();
    const running = executor.execute('inspect', { onToolUse });
    await vi.waitFor(() => expect(transport.requests.some(request => request.method === 'turn/start')).toBe(true));
    const emit = (method: string, item: any) => transport.emit({ method,
      params: { threadId: 'codex-thread-1', turnId: 'turn-1', item } });
    const item = { type: 'commandExecution', id: 'native-title', command: 'git show HEAD:config.ts',
      commandActions: [{ type: 'read', name: 'config.ts' }], title };
    emit('item/started', item);
    emit('item/started', { type: 'commandExecution', id: item.id, command: item.command });
    emit('item/completed', { type: 'commandExecution', id: item.id, command: item.command, status: 'completed', exitCode: 0 });
    expect(onToolUse).toHaveBeenCalledOnce();
    expect(onToolUse.mock.calls[0][0]).toMatchObject({ description: title ?? 'Read config.ts' });
    expect(onToolUse.mock.calls[0][0].title).toBe(title);
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await running;
  });

  it('maps tools and context-window errors without unsafe retry signals after side effects', async () => {
    const toolUse = vi.fn();
    const toolResult = vi.fn();
    const running = executor.execute('run it', { onToolUse: toolUse, onToolResult: toolResult });
    await vi.waitFor(() => expect(transport.requests.some((request) => request.method === 'turn/start')).toBe(true));
    transport.emit({ method: 'item/started', params: { threadId: 'codex-thread-1', turnId: 'turn-1', item: { type: 'commandExecution', id: 'cmd', command: 'npm test' } } });
    transport.emit({ method: 'item/completed', params: { threadId: 'codex-thread-1', turnId: 'turn-1', item: { type: 'commandExecution', id: 'cmd', command: 'npm test', status: 'completed', exitCode: 0, aggregatedOutput: 'ok' } } });
    transport.emit({ method: 'error', params: { threadId: 'codex-thread-1', error: { message: 'too large', codexErrorInfo: 'ContextWindowExceeded' } } });
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'failed' } } });
    const result = await running;
    expect(toolUse).toHaveBeenCalledOnce();
    expect(toolResult).toHaveBeenCalledWith(expect.objectContaining({ content: 'ok', is_error: false }));
    expect(result.error).not.toContain('Prompt too long');
  });

  it('preserves delayed native web results on the original invocation and keeps completion-only actions', async () => {
    const onToolUse = vi.fn(), onToolResult = vi.fn();
    const running = executor.execute('look up docs', { onToolUse, onToolResult });
    await vi.waitFor(() => expect(transport.requests.some(request => request.method === 'turn/start')).toBe(true));
    const emit = (method: string, item: any) => transport.emit({ method,
      params: { threadId: 'codex-thread-1', turnId: 'turn-1', item } });
    const search = { type: 'webSearch', id: 'web-native', query: 'docs', action: { type: 'search', queries: ['docs', 'examples'] } };
    emit('item/started', search);
    emit('item/started', { type: 'commandExecution', id: 'other', command: 'echo example' });
    expect(onToolResult).not.toHaveBeenCalled();
    await Promise.resolve();
    emit('item/completed', { ...search, results: [{ type: 'search_result', domain: 'example.com', ref_id: 'opaque-ref',
      title: 'Documentation', url: 'https://example.com/docs', snippet: 'Example excerpt', thumbnail_url: null }] });
    emit('item/completed', { ...search, results: [{ title: 'Updated source', url: 'https://example.com/updated' }] });
    emit('item/completed', { type: 'webSearch', id: 'web-open', action: { type: 'openPage', url: 'https://example.com/docs' }, results: [] });
    emit('item/completed', { type: 'webSearch', id: 'web-find', action: { type: 'findInPage', url: 'https://example.com/docs', pattern: 'needle' } });
    emit('item/completed', { type: 'webSearch', id: 'web-failed', status: 'failed', error: { message: 'Search failed' } });
    expect(onToolUse.mock.calls.filter(([tool]) => tool.id === 'web-native')).toHaveLength(1);
    expect(onToolUse.mock.calls[0][0]).toEqual({ id: 'web-native', name: 'WebSearch',
      input: { query: 'docs', action: 'search', queries: ['docs', 'examples'] }, description: 'Search the web' });
    expect(onToolUse).toHaveBeenCalledWith(expect.objectContaining({ id: 'web-open', description: 'Open web page',
      input: { query: 'https://example.com/docs', url: 'https://example.com/docs', action: 'openPage' } }));
    expect(onToolUse).toHaveBeenCalledWith(expect.objectContaining({ id: 'web-find', description: 'Find text on web page',
      input: { query: 'https://example.com/docs', url: 'https://example.com/docs', pattern: 'needle', action: 'findInPage' } }));
    expect(onToolResult.mock.calls[0][0]).toEqual({ tool_use_id: 'web-native', is_error: false,
      content: '1. Documentation\nSource: https://example.com/docs\nExcerpt: Example excerpt',
      webSearch: { results: [{ title: 'Documentation', url: 'https://example.com/docs', snippet: 'Example excerpt' }], omittedResults: 0 } });
    expect(onToolResult.mock.calls[1][0]).toMatchObject({ tool_use_id: 'web-native', content: expect.stringContaining('Updated source') });
    expect(onToolResult.mock.calls[2][0].webSearch).toEqual({ results: [], omittedResults: 0 });
    expect(onToolResult.mock.calls[3][0].webSearch).toBeUndefined();
    expect(onToolResult.mock.calls[3][0].content).toContain('not provided');
    expect(onToolResult.mock.calls[4][0]).toEqual({ tool_use_id: 'web-failed', is_error: true, content: 'Search failed' });
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await running;
  });

  it('maps app-server plans, reasoning, file, web, MCP, and dynamic tool events', async () => {
    const onStream = vi.fn();
    const onPlanMode = vi.fn();
    const onToolUse = vi.fn();
    const onToolResult = vi.fn();
    const running = executor.execute('use tools', { onStream, onPlanMode, onToolUse, onToolResult });
    await vi.waitFor(() => expect(transport.requests.some((request) => request.method === 'turn/start')).toBe(true));

    transport.emit({ method: 'item/reasoning/summaryTextDelta', params: { threadId: 'codex-thread-1', delta: 'thinking' } });
    transport.emit({ method: 'turn/plan/updated', params: { threadId: 'codex-thread-1', plan: [
      { status: 'completed', step: 'done' }, { status: 'inProgress', step: 'working' }, { status: 'pending', step: 'later' },
    ] } });
    const items = [
      { type: 'fileChange', id: 'file', changes: [{ kind: 'update', path: 'a.ts' }], status: 'completed' },
      { type: 'webSearch', id: 'web', query: 'query' },
      { type: 'mcpToolCall', id: 'mcp', tool: 'lookup', arguments: { q: 1 }, status: 'failed', error: { message: 'bad' } },
      { type: 'dynamicToolCall', id: 'dynamic', tool: 'custom', arguments: {}, status: 'completed', success: true, contentItems: [{ type: 'inputText', text: 'ok' }] },
    ];
    for (const item of items) {
      transport.emit({ method: 'item/started', params: { threadId: 'codex-thread-1', item } });
      transport.emit({ method: 'item/completed', params: { threadId: 'codex-thread-1', item } });
    }
    transport.emit({ method: 'item/completed', params: { threadId: 'codex-thread-1', item: { type: 'plan', id: 'plan', text: 'final plan' } } });
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });

    await expect(running).resolves.toMatchObject({ success: true });
    expect(onStream).toHaveBeenCalledWith('thinking');
    expect(onPlanMode).toHaveBeenCalledTimes(2);
    expect(onToolUse).toHaveBeenCalledTimes(4);
    expect(onToolResult).toHaveBeenCalledTimes(4);
  });

  it('keeps file boundaries when native file-change diffs contain only hunks', async () => {
    const onToolResult = vi.fn();
    const running = executor.execute('edit files', { onToolResult });
    await vi.waitFor(() => expect(transport.requests.some((entry) => entry.method === 'turn/start')).toBe(true));
    transport.emit({ method: 'item/completed', params: { threadId: 'codex-thread-1', item: {
      type: 'fileChange', id: 'edit-many', status: 'completed', changes: [
        { path: 'a.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old\n+new' },
        { path: 'b.ts', kind: { type: 'add' }, diff: '@@ -0,0 +1 @@\n+created' },
        { path: 'c.ts', kind: 'delete', diff: '@@ -1 +0,0 @@\n-removed' },
        { path: 'd.ts', kind: 'update', diff: '--- a/d.ts\n+++ b/d.ts\n@@ -1 +1 @@\n-before\n+after' },
      ],
    } } });
    const result = onToolResult.mock.calls[0][0];
    expect(result.diff).toContain('--- a/a.ts\n+++ b/a.ts\n@@');
    expect(result.diff).toContain('--- /dev/null\n+++ b/b.ts\n@@');
    expect(result.diff).toContain('--- a/c.ts\n+++ /dev/null\n@@');
    expect(result.diff.match(/\+\+\+ b\/d.ts/g)).toHaveLength(1);
    expect(result.content).toBe('update: a.ts\nadd: b.ts\ndelete: c.ts\nupdate: d.ts');
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await running;
  });

  it('forwards completed imageGeneration items as image callbacks', async () => {
    const onImage = vi.fn();
    const data = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64');
    const running = executor.execute('generate an image', { onImage });
    await vi.waitFor(() => expect(transport.requests.some((request) => request.method === 'turn/start')).toBe(true));

    transport.emit({ method: 'item/completed', params: {
      threadId: 'codex-thread-1',
      turnId: 'turn-1',
      item: { type: 'imageGeneration', id: 'image-1', status: 'completed', result: data, mimeType: 'image/png' },
    } });
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });

    await running;
    expect(onImage).toHaveBeenCalledWith({ type: 'image', data, mimeType: 'image/png' });
  });

  it('extracts tool images before safe diagnostics and preserves callback ownership', async () => {
    const events: string[] = [];
    const onImage = vi.fn(() => { events.push('image'); });
    const onImageFile = vi.fn();
    const onToolResult = vi.fn(() => { events.push('result'); });
    const onStream = vi.fn();
    const data = Buffer.from([255, 216, 255, 224]).toString('base64');
    const running = executor.execute('generate tool images', { onImage, onImageFile, onToolResult, onStream });
    await vi.waitFor(() => expect(transport.requests.some(request => request.method === 'turn/start')).toBe(true));
    const emit = (item: any, method = 'item/completed', threadId = 'codex-thread-1', turnId = 'turn-1') =>
      transport.emit({ method, params: { threadId, turnId, item } });
    const mcp = { type: 'mcpToolCall', id: 'mcp-image', status: 'completed', tool: 'draw',
      result: { content: [{ type: 'image', data, mimeType: 'image/png' }, { type: 'text', text: 'created' }] } };
    emit(mcp, 'item/started');
    expect(onImage).not.toHaveBeenCalled();
    emit(mcp, 'item/completed', 'wrong-thread');
    emit(mcp, 'item/completed', 'codex-thread-1', 'old-turn');
    expect(onImage).not.toHaveBeenCalled();
    emit(mcp);
    expect(events).toEqual(['image', 'result']);
    expect(onImage).toHaveBeenCalledWith({ type: 'image', data, mimeType: 'image/jpeg' });
    expect(onToolResult.mock.calls[0][0]).toMatchObject({ is_error: false, content: expect.stringContaining('created') });
    expect(onToolResult.mock.calls[0][0].content).not.toContain(data);
    emit(mcp);
    emit({ type: 'dynamicToolCall', id: 'dynamic-image', status: 'completed', success: true,
      contentItems: [{ type: 'inputImage', imageUrl: `data:image/jpeg;base64,${data}` }, { type: 'inputAudio', audioUrl: 'private-audio' }] });
    expect(onImage).toHaveBeenCalledTimes(2);
    expect(onToolResult.mock.calls.at(-1)![0].content).not.toContain('private-audio');
    emit({ type: 'imageGeneration', id: 'file-image', status: 'completed', result: '', savedPath: '/workspace/generated.png' });
    expect(onImageFile).toHaveBeenCalledWith('/workspace/generated.png');
    emit({ type: 'imageView', id: 'view', status: 'completed', savedPath: '/workspace/ignored.png' });
    emit({ ...mcp, id: 'failed', status: 'failed' });
    expect(onImage).toHaveBeenCalledTimes(2);
    expect(onImageFile).toHaveBeenCalledTimes(1);
    emit({ type: 'imageGeneration', id: 'bad', status: 'completed', result: 'invalid' });
    emit({ type: 'imageGeneration', id: 'bad-again', status: 'completed', result: 'invalid' });
    expect(onStream).toHaveBeenCalledTimes(1);
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    expect((await running).output).toContain('could not be attached');
    emit({ ...mcp, id: 'late' });
    expect(onImage).toHaveBeenCalledTimes(2);

    const nextImage = vi.fn();
    transport.nextTurnId = 'turn-2';
    const next = executor.execute('another reply', { onImage: nextImage });
    await vi.waitFor(() => expect(transport.requests.filter(request => request.method === 'turn/start')).toHaveLength(2));
    emit(mcp, 'item/completed', 'codex-thread-1', 'turn-2');
    expect(nextImage).toHaveBeenCalledTimes(1);
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-2', status: 'completed' } } });
    await next;
  });

  it('exposes a safe retry signal for structured context errors before side effects', async () => {
    const running = executor.execute('large prompt', {});
    await vi.waitFor(() => expect(transport.requests.some((request) => request.method === 'turn/start')).toBe(true));
    transport.emit({
      method: 'turn/completed',
      params: {
        threadId: 'codex-thread-1',
        turn: {
          id: 'turn-1',
          status: 'failed',
          error: { message: 'too large', codexErrorInfo: { type: 'ContextWindowExceeded' } },
        },
      },
    });
    await expect(running).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('Prompt too long'),
    });
  });

  it('sends images as localImage inputs and removes temporary files after the turn', async () => {
    const running = executor.execute('inspect', {
      attachments: [{ type: 'image', mimeType: 'image/png', data: Buffer.from('image').toString('base64') }],
    });
    await vi.waitFor(() => expect(transport.requests.some((request) => request.method === 'turn/start')).toBe(true));
    const imagePath = transport.requests.find((request) => request.method === 'turn/start')?.params.input[1].path;
    await expect(fs.access(imagePath)).resolves.toBeUndefined();
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await running;
    await vi.waitFor(async () => await expect(fs.access(imagePath)).rejects.toThrow());
  });

  it('routes approval replies through the existing waiting-input interface', async () => {
    const guarded = new CodexAppServerExecutor(new DirectoryGuard([projectDir]), {
      threadId: 'guarded', initialWorkingDirectory: projectDir, autoApprove: false, clientFactory: () => transport,
    });
    const running = guarded.execute('run command', {});
    await vi.waitFor(() => expect(transport.requests.some((request) => request.method === 'turn/start')).toBe(true));
    transport.emit({ id: 42, method: 'item/commandExecution/requestApproval', params: { threadId: 'codex-thread-1', turnId: 'turn-1', command: 'ls' } });
    expect(guarded.isWaitingInput()).toBe(true);
    expect(guarded.sendInput('yes')).toBe(true);
    expect(transport.responses).toContainEqual({ id: 42, result: { decision: 'accept' } });
    transport.emit({ id: 44, method: 'item/commandExecution/requestApproval', params: { threadId: 'codex-thread-1', command: 'pwd' } });
    expect(guarded.sendInput('unknown')).toBe(false);
    expect(guarded.sendInput('always')).toBe(true);
    transport.emit({ id: 45, method: 'item/fileChange/requestApproval', params: { threadId: 'codex-thread-1', reason: 'edit' } });
    expect(guarded.sendInput('no')).toBe(true);
    transport.emit({ id: 46, method: 'item/fileChange/requestApproval', params: { threadId: 'codex-thread-1', grantRoot: projectDir } });
    expect(guarded.sendInput('cancel')).toBe(true);
    expect(transport.responses).toEqual(expect.arrayContaining([
      { id: 44, result: { decision: 'acceptForSession' } },
      { id: 45, result: { decision: 'decline' } },
      { id: 46, result: { decision: 'cancel' } },
    ]));
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await running;
    await guarded.destroy();
  });

  it('auto-approves matching requests and rejects foreign or unsupported requests', async () => {
    const running = executor.execute('run command', {});
    await vi.waitFor(() => expect(transport.requests.some((request) => request.method === 'turn/start')).toBe(true));
    transport.emit({ id: 50, method: 'item/fileChange/requestApproval', params: { threadId: 'codex-thread-1' } });
    transport.emit({ id: 51, method: 'item/commandExecution/requestApproval', params: { threadId: 'another-thread' } });
    transport.emit({ id: 52, method: 'future/request', params: { threadId: 'codex-thread-1' } });
    expect(transport.responses).toContainEqual({ id: 50, result: { decision: 'accept' } });
    expect(transport.errors.map((entry) => entry.id)).toEqual([51, 52]);
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await running;
  });

  it('cancels pending tool input with the app-server response shape on abort', async () => {
    const running = executor.execute('ask me', {});
    await vi.waitFor(() => expect(transport.requests.some((request) => request.method === 'turn/start')).toBe(true));
    transport.emit({
      id: 43,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'codex-thread-1',
        turnId: 'turn-1',
        questions: [{ id: 'choice', question: 'Continue?' }],
      },
    });
    await expect(executor.abort()).resolves.toBe(true);
    expect(transport.responses).toContainEqual({ id: 43, result: { answers: {} } });
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'interrupted' } } });
    await running;
  });
});
