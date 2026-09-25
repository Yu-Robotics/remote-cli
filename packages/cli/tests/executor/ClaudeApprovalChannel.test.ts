import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ClaudePersistentExecutor } from '../../src/executor/ClaudePersistentExecutor';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';

describe('ClaudePersistentExecutor approval channel', () => {
  let executor: ClaudePersistentExecutor;
  let socketPath: string;
  let home: string;

  async function requestApproval(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      let buffer = '';
      socket.on('connect', () => socket.write(JSON.stringify(payload) + '\n'));
      socket.on('data', (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        try {
          resolve(JSON.parse(buffer.slice(0, newline)));
        } catch (error) {
          reject(error);
        }
        socket.end();
      });
      socket.on('error', reject);
    });
  }

  beforeEach(async () => {
    // Keep Unix socket paths below the macOS length limit and isolate stored data.
    home = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'claude-approval-')));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    executor = new ClaudePersistentExecutor(
      new DirectoryGuard([home]),
      home,
      'approval-test',
      undefined,
      { mode: 'workspace-write' },
    );
    socketPath = await (executor as any).ensureApprovalServer();
    Object.assign(executor, { isProcessing: true, approvalTurnActive: true,
      currentCommandResolve: vi.fn(), currentCommandReject: vi.fn() });
  });

  afterEach(async () => {
    await executor.destroy();
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('keeps native approval requests interactive even after the file hook allows an ordinary edit', async () => {
    const approval = vi.fn(() => true);
    Object.assign(executor, { filePolicyToken: 'active-token', filePolicyRoots: [fs.realpathSync(home)],
      claudeProcess: {}, currentApprovalRequestCallback: approval });
    const file = path.join(fs.realpathSync(home), 'new.txt');
    try {
      const policy = { type: 'file_policy', token: 'active-token', tool_name: 'Write', input: { file_path: file } };
      expect(await requestApproval({ ...policy, token: 'stale-token' })).toMatchObject({ decision: 'deny' });
      expect(await requestApproval(policy)).toMatchObject({ decision: 'allow' });
      expect(approval).not.toHaveBeenCalled();
      // Native ask rules run after the hook and must still reach the user.
      const response = requestApproval({ id: 'native-ask', tool_name: 'Write', input: { file_path: file } });
      await vi.waitFor(() => expect(approval).toHaveBeenCalledOnce());
      expect(executor.respondToApproval('native-ask', 'deny')).toBe(true);
      expect(await response).toMatchObject({ behavior: 'deny' });
      (executor as any).approvalTurnActive = false;
      expect(await requestApproval(policy)).toMatchObject({ decision: 'deny' });
    } finally {
      (executor as any).claudeProcess = null;
    }
  });

  it('forwards a Bash permission prompt as an approval card and allows on approve', async () => {
    const onApprovalRequest = vi.fn(() => true);
    const onApprovalResolved = vi.fn();
    (executor as any).currentApprovalRequestCallback = onApprovalRequest;
    (executor as any).currentApprovalResolvedCallback = onApprovalResolved;

    const pending = requestApproval({ id: 'req-1', tool_name: 'Bash',
      input: { command: 'touch /tmp/x', description: 'make file' }, tool_use_id: 'tool-1' });
    await vi.waitFor(() => expect(onApprovalRequest).toHaveBeenCalledOnce());
    const request = onApprovalRequest.mock.calls[0][0];
    expect(request).toMatchObject({ requestId: 'req-1', kind: 'command', canRemember: false });
    expect(request.description).toContain('touch /tmp/x');

    expect(executor.respondToApproval('req-1', 'approve')).toBe(true);
    await expect(pending).resolves.toMatchObject({ id: 'req-1', behavior: 'allow',
      updatedInput: { command: 'touch /tmp/x', description: 'make file' } });
    expect(onApprovalResolved).toHaveBeenCalledWith('req-1', 'approved');
  });

  it('maps file tools to the file kind and denies with a message', async () => {
    const onApprovalRequest = vi.fn(() => true);
    (executor as any).currentApprovalRequestCallback = onApprovalRequest;

    const pending = requestApproval({ id: 'req-2', tool_name: 'Write', input: { file_path: '/etc/hosts' } });
    await vi.waitFor(() => expect(onApprovalRequest).toHaveBeenCalledOnce());
    expect(onApprovalRequest.mock.calls[0][0]).toMatchObject({ kind: 'file' });
    expect(onApprovalRequest.mock.calls[0][0].description).toContain('/etc/hosts');

    expect(executor.respondToApproval('req-2', 'deny')).toBe(true);
    await expect(pending).resolves.toMatchObject({ id: 'req-2', behavior: 'deny', message: 'Denied by user' });
  });

  it('fails closed and resolves the request when neither cards nor text can be delivered', async () => {
    const resolved = vi.fn();
    (executor as any).currentApprovalRequestCallback = () => false;
    (executor as any).currentApprovalResolvedCallback = resolved;
    await expect(requestApproval({ id: 'req-3', tool_name: 'Bash', input: { command: 'rm -rf /' } }))
      .resolves.toMatchObject({ id: 'req-3', behavior: 'deny' });
    expect((executor as any).pendingApprovals.size).toBe(0);
    expect(resolved).toHaveBeenCalledWith('req-3', 'denied');
  });

  it.each([false, true])('accepts text replies with card support=%s and keeps invalid replies pending', async cardSupported => {
    const stream = vi.fn();
    const resolved = vi.fn();
    Object.assign(executor, { currentApprovalRequestCallback: () => cardSupported,
      currentStreamCallback: stream, currentApprovalResolvedCallback: resolved });
    const pending = requestApproval({ id: 'text-request', tool_name: 'Write', input: { file_path: '/other/file' } });
    await vi.waitFor(() => expect(executor.isWaitingInput()).toBe(true));
    if (!cardSupported) expect(stream).toHaveBeenCalledWith(expect.stringContaining('Reply yes or no'));
    expect(executor.sendInput('some unrelated message')).toBe(false);
    expect(executor.respondToApproval('text-request', 'remember')).toBe(false);
    expect(executor.respondToApproval('text-request', 'invalid' as any)).toBe(false);
    expect(executor.isWaitingInput()).toBe(true);
    expect(executor.sendInput('YES')).toBe(true);
    await expect(pending).resolves.toMatchObject({ behavior: 'allow' });
    expect(resolved).toHaveBeenCalledWith('text-request', 'approved');
    expect(executor.isWaitingInput()).toBe(false);
    expect(executor.respondToApproval('text-request', 'approve')).toBe(false);
  });

  it('requires a request ID when multiple approvals are pending', async () => {
    Object.assign(executor, { currentApprovalRequestCallback: () => false, currentStreamCallback: vi.fn() });
    const first = requestApproval({ id: 'first', tool_name: 'Write', input: { file_path: '/one' } });
    const second = requestApproval({ id: 'second', tool_name: 'Write', input: { file_path: '/two' } });
    await vi.waitFor(() => expect((executor as any).pendingApprovals.size).toBe(2));
    expect(executor.sendInput('yes')).toBe(false);
    expect(executor.sendInput('yes missing')).toBe(false);
    expect(executor.sendInput('no second')).toBe(true);
    await expect(second).resolves.toMatchObject({ behavior: 'deny' });
    expect(executor.sendInput('yes first')).toBe(true);
    await expect(first).resolves.toMatchObject({ behavior: 'allow', updatedInput: { file_path: '/one' } });
  });

  it.each(['completed', 'failed', 'reset'] as const)('expires approvals when the task is %s and rejects late replies', async outcome => {
    const resolved = vi.fn();
    Object.assign(executor, { currentApprovalRequestCallback: () => true, currentApprovalResolvedCallback: resolved });
    const pending = requestApproval({ id: 'old-request', tool_name: 'Bash', input: { command: 'echo test' } });
    await vi.waitFor(() => expect(executor.isWaitingInput()).toBe(true));
    if (outcome === 'reset') executor.resetContext();
    else (executor as any).completeCurrentCommand(outcome === 'completed', 'test failure');
    await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
    expect(resolved).toHaveBeenCalledTimes(1);
    expect(resolved).toHaveBeenCalledWith('old-request', 'expired');
    expect(executor.respondToApproval('old-request', 'approve')).toBe(false);
    expect(executor.isWaitingInput()).toBe(false);
    await expect(requestApproval({ id: 'late-request', tool_name: 'Bash', input: {} }))
      .resolves.toMatchObject({ behavior: 'deny', message: 'Approval request is no longer active.' });
  });

  it('keeps cleanup bound to the callback that created the request', async () => {
    const original = vi.fn();
    const replacement = vi.fn();
    Object.assign(executor, { currentApprovalRequestCallback: () => true, currentApprovalResolvedCallback: original });
    const pending = requestApproval({ id: 'bound-request', tool_name: 'Write', input: {} });
    await vi.waitFor(() => expect(executor.isWaitingInput()).toBe(true));
    (executor as any).currentApprovalResolvedCallback = replacement;
    expect(executor.respondToApproval('bound-request', 'deny')).toBe(true);
    await pending;
    expect(original).toHaveBeenCalledWith('bound-request', 'denied');
    expect(replacement).not.toHaveBeenCalled();
  });

  it('rejects delayed data from a connection opened during the previous task', async () => {
    const socket = net.createConnection(socketPath);
    try {
      await new Promise<void>(resolve => socket.on('connect', resolve));
      await new Promise<void>(resolve => setImmediate(resolve));
      (executor as any).completeCurrentCommand(true);
      const onRequest = vi.fn(() => true);
      Object.assign(executor, { isProcessing: true, approvalTurnActive: true,
        currentCommandResolve: vi.fn(), currentApprovalRequestCallback: onRequest });
      const answer = new Promise<string>(resolve => socket.once('data', data => resolve(String(data))));
      socket.write(JSON.stringify({ id: 'delayed', tool_name: 'Write', input: {} }) + '\n');
      expect(JSON.parse(await answer)).toMatchObject({ id: 'delayed', behavior: 'deny' });
      expect(onRequest).not.toHaveBeenCalled();
    } finally {
      socket.destroy();
    }
  });

  it('expires unanswered approvals and resolves the card', async () => {
    vi.useFakeTimers();
    try {
      const onApprovalResolved = vi.fn();
      (executor as any).currentApprovalRequestCallback = () => true;
      (executor as any).currentApprovalResolvedCallback = onApprovalResolved;
      const socket = net.createConnection(socketPath);
      await new Promise<void>(resolve => socket.on('connect', resolve));
      socket.write(JSON.stringify({ id: 'req-4', tool_name: 'Bash', input: { command: 'sleep 1' } }) + '\n');
      await vi.waitFor(() => expect((executor as any).pendingApprovals.size).toBe(1));
      vi.advanceTimersByTime(5 * 60 * 1000);
      expect((executor as any).pendingApprovals.size).toBe(0);
      expect(onApprovalResolved).toHaveBeenCalledWith('req-4', 'expired');
      expect(executor.respondToApproval('req-4', 'approve')).toBe(false);
      socket.end();
    } finally {
      vi.useRealTimers();
    }
  });

  it('denies every pending approval on abort', async () => {
    const onApprovalResolved = vi.fn();
    (executor as any).currentApprovalRequestCallback = () => true;
    (executor as any).currentApprovalResolvedCallback = onApprovalResolved;
    (executor as any).isProcessing = true;

    const pending = requestApproval({ id: 'req-5', tool_name: 'Bash', input: { command: 'ls' } });
    await vi.waitFor(() => expect((executor as any).pendingApprovals.size).toBe(1));
    await executor.abort();
    await expect(pending).resolves.toMatchObject({ id: 'req-5', behavior: 'deny' });
    expect(onApprovalResolved).toHaveBeenCalledWith('req-5', 'expired');
  });
});
