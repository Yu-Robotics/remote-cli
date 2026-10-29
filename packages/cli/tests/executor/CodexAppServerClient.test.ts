import { EventEmitter } from 'events';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'child_process';
import { CodexAppServerClient } from '../../src/executor/CodexAppServerClient';
import { CodexAppServerExecutor } from '../../src/executor/CodexAppServerExecutor';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { ThreadExecutorPool } from '../../src/thread/ThreadExecutorPool';
import { ThreadManager } from '../../src/thread/ThreadManager';

vi.mock('child_process', async (importActual) => {
  const actual = await importActual<typeof import('child_process')>();
  return { ...actual, spawn: vi.fn() };
});

const mockSpawn = vi.mocked(spawn);

function fakeProcess(userAgent = 'test', closesOnKill = true) {
  const process: any = new EventEmitter();
  process.exitCode = null;
  process.signalCode = null;
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
  process.kill = vi.fn((signal = 'SIGTERM') => {
    if (closesOnKill) {
      process.signalCode = signal;
      process.emit('exit', null, signal);
      process.emit('close', null, signal);
    }
    return true;
  });
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
  afterEach(() => { vi.useRealTimers(); });

  it.each([false, true])('isolates only worker launches and does not certify fake PIDs: %s', async delegationWorker => {
    const child = fakeProcess();
    mockSpawn.mockReturnValue(child);
    const client = new CodexAppServerClient({ delegationWorker });
    try {
      await client.start();
      expect(mockSpawn.mock.calls[0][2]?.detached).toBe(delegationWorker && process.platform !== 'win32' ? true : undefined);
    } finally { await client.stop(); }
    await client.waitForExit();
    await expect(client.waitForManagedProcessGroupExit()).rejects.toThrow();
  });

  it('retains a timed-out child until close, blocking shutdown retries and replacement startup', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const child = fakeProcess('test', false);
    mockSpawn.mockReturnValue(child);
    const client = new CodexAppServerClient({ killEscalationMs: 10 });
    await client.start();

    const stopping = expect(client.stop()).rejects.toThrow('exit could not be confirmed');
    await vi.advanceTimersByTimeAsync(1_010);
    await stopping;
    await expect(client.waitForExit()).rejects.toThrow('exit could not be confirmed');
    await expect(client.stop()).rejects.toThrow('exit could not be confirmed');
    await expect(client.start()).rejects.toThrow('exit could not be confirmed');
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    // Exit codes and exit events do not confirm that inherited stdio has closed.
    child.exitCode = 0;
    child.emit('exit', 0, null);
    await expect(client.waitForExit()).rejects.toThrow('exit could not be confirmed');
    child.emit('close', 0, null);
    await expect(client.waitForExit()).resolves.toBeUndefined();
    mockSpawn.mockReturnValue(fakeProcess());
    await client.start();
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    await client.stop();
  });

  it('joins an ongoing stop and waits for close even after the child exits', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const child = fakeProcess('test', false);
    mockSpawn.mockReturnValue(child);
    const client = new CodexAppServerClient({ killEscalationMs: 10 });
    await client.start();
    let closed = false;
    const stopping = client.stop().then(() => { closed = true; });
    const retry = client.stop();
    const waiting = client.waitForExit();
    child.exitCode = 0;
    child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(10);
    expect(closed).toBe(false);
    mockSpawn.mockReturnValue(fakeProcess());
    let restarted = false;
    const starting = client.start().then(() => { restarted = true; });
    await Promise.resolve();
    expect(restarted).toBe(false);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    child.emit('close', 0, null);
    await Promise.all([stopping, retry, waiting, starting]);
    expect(closed).toBe(true);
    expect(restarted).toBe(true);
    const finalStop = client.stop();
    await vi.advanceTimersByTimeAsync(10);
    await finalStop;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains child ownership when signaling fails, until a later close is observed', async () => {
    const child = fakeProcess('test', false);
    child.kill.mockImplementation(() => { throw new Error('Synthetic signal failure'); });
    mockSpawn.mockReturnValue(child);
    const client = new CodexAppServerClient();
    await client.start();
    await expect(client.stop()).rejects.toThrow('could not be stopped');
    await expect(client.waitForExit()).rejects.toThrow('exit could not be confirmed');
    await expect(client.start()).rejects.toThrow('exit could not be confirmed');
    child.emit('close', null, 'SIGKILL');
    await expect(client.waitForExit()).resolves.toBeUndefined();
  });

  it('keeps whole-thread reset retries blocked after the real Codex executor has already been destroyed', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-reset-exit-'));
    vi.stubEnv('HOME', home);
    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(home);
    const child = fakeProcess('test', false);
    mockSpawn.mockReturnValue(child);
    const client = new CodexAppServerClient({ cwd: home, killEscalationMs: 10 });
    try {
      const manager = await ThreadManager.initialize(home);
      const threadId = manager.getDefaultThread().id;
      const guard = new DirectoryGuard([home]);
      const executor = new CodexAppServerExecutor(guard, { threadId,
        initialWorkingDirectory: home, clientFactory: () => client });
      const reset = vi.spyOn(executor, 'resetContext');
      const factory = vi.fn(() => executor);
      const pool = new ThreadExecutorPool(manager, guard, { type: 'codex' }, factory, 2_000);
      pool.getExecutor(threadId);
      const pointer = path.join(home, '.remote-cli', 'codex-sessions', `${threadId}.json`);
      await fs.writeFile(pointer, 'old binding');
      await manager.contextResets.begin(threadId);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await client.start();

      const first = expect(pool.clearThreadContext(threadId)).rejects.toThrow('exit could not be confirmed');
      await vi.advanceTimersByTimeAsync(1_010);
      await first;
      // destroy() is now a no-op, so the retry must still check the client's child.
      await expect(pool.clearThreadContext(threadId)).rejects.toThrow('exit could not be confirmed');
      expect(manager.contextResets.isPending(threadId)).toBe(true);
      expect(await fs.readFile(pointer, 'utf8')).toBe('old binding');
      expect(reset).not.toHaveBeenCalled();
      expect(() => pool.getExecutor(threadId)).toThrow('incomplete');
      await expect(client.start()).rejects.toThrow('exit could not be confirmed');
      expect(factory).toHaveBeenCalledOnce();
      expect(mockSpawn).toHaveBeenCalledOnce();

      child.emit('close', 0, null);
      await pool.clearThreadContext(threadId);
      expect(reset).toHaveBeenCalledOnce();
      await expect(fs.stat(pointer)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(manager.contextResets.isPending(threadId)).toBe(true);
      await manager.contextResets.complete(threadId);
    } finally {
      child.emit('close', 0, null);
      vi.useRealTimers();
      homedir.mockRestore();
      vi.unstubAllEnvs();
      await fs.rm(home, { recursive: true, force: true });
    }
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

  it('retains failed exit confirmation across repeated stop and start attempts until actual close', async () => {
    const child = fakeProcess();
    child.exitCode = null; child.signalCode = null;
    child.kill.mockImplementation(() => { throw new Error('Synthetic signal denied'); });
    mockSpawn.mockReturnValue(child);
    const client = new CodexAppServerClient();
    await client.start();
    await expect(client.stop()).rejects.toThrow('could not be stopped');
    await expect(client.stop()).rejects.toThrow('exit could not be confirmed');
    await expect(client.waitForExit()).rejects.toThrow('exit could not be confirmed');
    await expect(client.start()).rejects.toThrow('exit could not be confirmed');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    child.emit('exit', 0, null);
    await expect(client.waitForExit()).rejects.toThrow('exit could not be confirmed');
    child.emit('close', 0, null);
    await expect(client.waitForExit()).resolves.toBeUndefined();
    await expect(client.stop()).resolves.toBeUndefined();
    mockSpawn.mockReturnValue(fakeProcess());
    await client.start(); await client.stop();
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('does not spawn a replacement while a previous stop is still awaiting exit', async () => {
    const child = fakeProcess(); child.exitCode = null; child.signalCode = null;
    mockSpawn.mockReturnValue(child);
    const client = new CodexAppServerClient();
    await client.start();
    const stopping = client.stop();
    mockSpawn.mockReturnValue(fakeProcess());
    const starting = client.start();
    await Promise.resolve();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    child.emit('exit', 0, null);
    await Promise.resolve();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    child.emit('close', 0, null);
    await stopping; await starting;
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    await client.stop();
  });

  it('applies launch isolation only to opted-in maintenance clients and leaves ordinary clients unchanged', async () => {
    const child = fakeProcess(); mockSpawn.mockReturnValue(child);
    const env = { PATH: '/usr/bin', CODEX_HOME: '/temporary-fixture' };
    const isolated = new CodexAppServerClient({ launchArgs: ['-c', 'analytics.enabled=false'], env });
    await isolated.start();
    expect(mockSpawn).toHaveBeenLastCalledWith('codex', ['app-server', '--stdio', '-c', 'analytics.enabled=false'], expect.objectContaining({ env }));
    await isolated.stop();
    mockSpawn.mockReturnValue(fakeProcess()); const ordinary = new CodexAppServerClient(); await ordinary.start();
    expect(mockSpawn).toHaveBeenLastCalledWith('codex', ['app-server', '--stdio'], expect.objectContaining({ env: { ...process.env } }));
    await ordinary.stop();
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
