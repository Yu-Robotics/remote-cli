import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'child_process';
import { CodexAppServerClient } from '../../src/executor/CodexAppServerClient';

vi.mock('child_process', async (importActual) => {
  const actual = await importActual<typeof import('child_process')>();
  return { ...actual, spawn: vi.fn() };
});

const mockSpawn = vi.mocked(spawn);

function fakeProcess() {
  const process: any = new EventEmitter();
  process.stdout = new EventEmitter();
  process.stderr = new EventEmitter();
  process.stdin = Object.assign(new EventEmitter(), {
    writable: true,
    destroyed: false,
    writes: [] as string[],
    write: vi.fn((data: string) => {
      process.stdin.writes.push(data);
      const message = JSON.parse(data);
      if (message.method === 'initialize') {
        queueMicrotask(() => process.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result: { userAgent: 'test' } })}\n`)));
      }
      return true;
    }),
    end: vi.fn(),
  });
  process.kill = vi.fn();
  return process;
}

describe('CodexAppServerClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts app-server and completes the required initialization handshake', async () => {
    const process = fakeProcess();
    mockSpawn.mockReturnValue(process);
    const client = new CodexAppServerClient({ command: '/opt/codex', cwd: '/workspace' });

    await client.start();

    expect(mockSpawn).toHaveBeenCalledWith('/opt/codex', ['app-server', '--stdio'], expect.objectContaining({ cwd: '/workspace' }));
    const messages = process.stdin.writes.map((line: string) => JSON.parse(line));
    expect(messages[0]).toMatchObject({ method: 'initialize', params: { clientInfo: { name: 'remote_cli' }, capabilities: null } });
    expect(messages[1]).toEqual({ method: 'initialized' });
    await client.stop();
  });

  it('correlates responses and forwards fragmented notifications', async () => {
    const process = fakeProcess();
    mockSpawn.mockReturnValue(process);
    const client = new CodexAppServerClient();
    const messages: any[] = [];
    client.onMessage((message) => messages.push(message));
    await client.start();

    const request = client.request('model/list', { limit: 10 });
    await vi.waitFor(() => expect(process.stdin.writes).toHaveLength(3));
    const id = JSON.parse(process.stdin.writes[2]).id;
    process.stdout.emit('data', Buffer.from(`{"method":"warn`));
    process.stdout.emit('data', Buffer.from(`ing","params":{"message":"ok"}}\n${JSON.stringify({ id, result: { data: [] } })}\n`));

    await expect(request).resolves.toEqual({ data: [] });
    expect(messages).toContainEqual({ method: 'warning', params: { message: 'ok' } });
    await client.stop();
  });

  it('rejects requests with structured app-server errors', async () => {
    const process = fakeProcess();
    mockSpawn.mockReturnValue(process);
    const client = new CodexAppServerClient();
    await client.start();
    const request = client.request('thread/resume', { threadId: 'missing' });
    await vi.waitFor(() => expect(process.stdin.writes).toHaveLength(3));
    const id = JSON.parse(process.stdin.writes[2]).id;
    process.stdout.emit('data', Buffer.from(`${JSON.stringify({ id, error: { code: -32000, message: 'not found' } })}\n`));
    await expect(request).rejects.toThrow('not found');
    await client.stop();
  });

  it('rejects every pending request when the process exits', async () => {
    const process = fakeProcess();
    mockSpawn.mockReturnValue(process);
    const client = new CodexAppServerClient();
    await client.start();
    const request = client.request('model/list', {});
    await vi.waitFor(() => expect(process.stdin.writes).toHaveLength(3));
    process.emit('close', 1, null);
    await expect(request).rejects.toThrow('exited unexpectedly');
  });
});
