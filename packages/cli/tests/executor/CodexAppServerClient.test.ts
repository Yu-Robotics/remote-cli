import { EventEmitter } from 'events';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'child_process';
import { CodexAppServerClient } from '../../src/executor/CodexAppServerClient';

vi.mock('child_process', async (importActual) => {
  const actual = await importActual<typeof import('child_process')>();
  return { ...actual, spawn: vi.fn() };
});

const mockSpawn = vi.mocked(spawn);

function fakeProcess(userAgent = 'test') {
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
        queueMicrotask(() => process.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result: { userAgent } })}\n`)));
      }
      return true;
    }),
    end: vi.fn(),
  });
  process.kill = vi.fn();
  return process;
}

function fakeVersionProcess(output = 'codex-cli 0.159.2\n') {
  const process: any = new EventEmitter();
  process.stdout = new EventEmitter();
  process.stderr = new EventEmitter();
  process.kill = vi.fn();
  queueMicrotask(() => {
    process.stdout.emit('data', Buffer.from(output));
    process.emit('close', 0, null);
  });
  return process;
}

describe('CodexAppServerClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts app-server and completes the required initialization handshake', async () => {
    const process = fakeProcess();
    mockSpawn.mockReturnValue(process);
    const cwd = globalThis.process.cwd();
    const client = new CodexAppServerClient({ command: '/opt/codex', cwd });

    await client.start();

    expect(mockSpawn).toHaveBeenCalledWith('/opt/codex', ['app-server', '--stdio'], expect.objectContaining({ cwd }));
    const messages = process.stdin.writes.map((line: string) => JSON.parse(line));
    expect(messages[0]).toMatchObject({
      method: 'initialize',
      params: { clientInfo: { name: 'remote_cli' }, capabilities: { experimentalApi: true } },
    });
    expect(messages[1]).toEqual({ method: 'initialized' });
    await client.stop();
  });

  it('reports a missing working directory before attempting to start Codex', async () => {
    const missing = path.join(process.cwd(), '.remote-cli-test-missing-working-directory');
    const client = new CodexAppServerClient({ command: '/opt/codex', cwd: missing });

    await expect(client.start()).rejects.toThrow('Working directory no longer exists');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('still reports a genuinely missing Codex executable as not installed', async () => {
    // The directory exists, so the guard passes and the spawn ENOENT must keep
    // its own meaning: the two causes must not collapse into one message.
    const client = new CodexAppServerClient({ command: '/opt/codex', cwd: process.cwd() });
    mockSpawn.mockImplementation(() => {
      const process: any = new EventEmitter();
      process.stdout = new EventEmitter();
      process.stderr = new EventEmitter();
      // A real spawn that fails keeps a usable stdin; the failure arrives as a
      // process 'error' event carrying the ENOENT code.
      process.stdin = Object.assign(new EventEmitter(), {
        writable: true,
        destroyed: false,
        write: vi.fn(() => {
          setTimeout(() => process.emit('error', Object.assign(new Error('spawn /opt/codex ENOENT'), { code: 'ENOENT' })), 0);
          return true;
        }),
        end: vi.fn(),
      });
      process.kill = vi.fn();
      return process;
    });

    await expect(client.start()).rejects.toThrow('Codex CLI (codex) is not installed or not found on PATH');
  });

  it('records the version reported by the running app-server', async () => {
    const process = fakeProcess('remote_cli/0.159.2 (Linux; aarch64)');
    mockSpawn.mockReturnValue(process);
    const client = new CodexAppServerClient();

    await client.start();

    expect(client.getServerVersion()).toBe('0.159.2');
    await client.stop();
  });

  it('reads the version that a fresh Codex command would run', async () => {
    const process = fakeVersionProcess();
    mockSpawn.mockReturnValue(process);
    const cwd = globalThis.process.cwd();
    const client = new CodexAppServerClient({ command: '/opt/codex', cwd });

    await expect(client.getCommandVersion()).resolves.toBe('0.159.2');
    expect(mockSpawn).toHaveBeenCalledWith('/opt/codex', ['--version'], expect.objectContaining({ cwd }));
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
