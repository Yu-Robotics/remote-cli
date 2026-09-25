import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as net from 'net';
import { ClaudePersistentExecutor } from '../../src/executor/ClaudePersistentExecutor';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';

describe('ClaudePersistentExecutor approval channel', () => {
  let executor: ClaudePersistentExecutor;
  let socketPath: string;

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
    executor = new ClaudePersistentExecutor(
      new DirectoryGuard([process.cwd()]),
      process.cwd(),
      `approval-test-${Date.now()}`,
      undefined,
      { mode: 'workspace-write' },
    );
    socketPath = await (executor as any).ensureApprovalServer();
  });

  afterEach(async () => {
    await executor.destroy();
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

  it('fails closed when no approval card can be shown', async () => {
    (executor as any).currentApprovalRequestCallback = () => false;
    await expect(requestApproval({ id: 'req-3', tool_name: 'Bash', input: { command: 'rm -rf /' } }))
      .resolves.toMatchObject({ id: 'req-3', behavior: 'deny' });
    expect((executor as any).pendingApprovals.size).toBe(0);
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
