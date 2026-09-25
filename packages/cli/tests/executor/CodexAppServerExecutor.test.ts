import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexAppServerExecutor, CodexAppServerTransport } from '../../src/executor/CodexAppServerExecutor';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';

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
  cwd: string | null = null;

  async start(): Promise<void> { this.running = true; }
  async stop(): Promise<void> { this.running = false; }
  isRunning(): boolean { return this.running; }
  setWorkingDirectory(cwd: string): void { this.cwd = cwd; }
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
    if (method === 'thread/resume') return { thread: { id: params.threadId } };
    if (method === 'turn/start') return { turn: { id: this.nextTurnId, status: 'inProgress' } };
    if (method === 'model/list') return { data: this.models, nextCursor: null };
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
    tempHome = await fs.mkdtemp(path.join(process.cwd(), '.codex-app-executor-test-'));
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
    const next = executor.execute('continue');
    await vi.waitFor(() => expect(transport.requests.some(request => request.method === 'turn/start')).toBe(true));
    const resume = transport.requests.find(request => request.method === 'thread/resume')!.params;
    const turn = transport.requests.find(request => request.method === 'turn/start')!.params;
    expect(resume).toMatchObject({ threadId: 'codex-thread-1', sandbox: 'workspace-write', cwd: changed });
    expect(turn.sandboxPolicy.networkAccess).toBe(false);
    expect(turn.sandboxPolicy.writableRoots).toContain(changed);
    expect(turn.sandboxPolicy.writableRoots).not.toContain(projectDir);
    expect(turn.sandboxPolicy.writableRoots).not.toContain(extra);
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });
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
    const resultPromise = executor.execute('hello', { onStream: (chunk) => chunks.push(chunk) });
    await vi.waitFor(() => expect(transport.requests.some((request) => request.method === 'turn/start')).toBe(true));

    transport.emit({ method: 'item/agentMessage/delta', params: { threadId: 'codex-thread-1', turnId: 'turn-1', itemId: 'a', delta: 'hello back' } });
    transport.emit({ method: 'item/completed', params: { threadId: 'codex-thread-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'a', text: 'hello back' } } });
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });

    await expect(resultPromise).resolves.toMatchObject({ success: true, output: 'hello back' });
    expect(chunks).toEqual(['hello back']);
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
    const running = executor.execute('generate an image', { onImage });
    await vi.waitFor(() => expect(transport.requests.some((request) => request.method === 'turn/start')).toBe(true));

    transport.emit({ method: 'item/completed', params: {
      threadId: 'codex-thread-1',
      turnId: 'turn-1',
      item: { type: 'imageGeneration', id: 'image-1', status: 'completed', result: 'aGVsbG8=', mimeType: 'image/png' },
    } });
    transport.emit({ method: 'turn/completed', params: { threadId: 'codex-thread-1', turn: { id: 'turn-1', status: 'completed' } } });

    await running;
    expect(onImage).toHaveBeenCalledWith({ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' });
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
