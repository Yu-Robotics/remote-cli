import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'child_process';
import { buildPiRpcArgs, consumeJsonl, formatPiModelRef, parsePiModelRef } from '../../src/executor/pi/PiTypes';
import { PiClient } from '../../src/executor/pi/PiClient';
import { PiExecutor } from '../../src/executor/PiExecutor';
import { DelegationManager } from '../../src/delegation/DelegationManager';
import { BackendRegistry } from '../../src/delegation/BackendRegistry';
import { DelegationStore } from '../../src/delegation/DelegationStore';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

describe('Pi RPC helpers', () => {
  it('builds RPC args with session, model, and thinking', () => {
    expect(buildPiRpcArgs({
      command: '/opt/pi',
      approveProject: true,
      sessionDir: '/tmp/pi-store',
      sessionId: 'thread-1',
      sessionName: 'remote-cli-thread-1',
      provider: 'google',
      model: 'gemini-flash',
      thinking: 'high',
    })).toEqual({
      command: '/opt/pi',
      args: [
        '--mode', 'rpc',
        '--approve',
        '--session-dir', '/tmp/pi-store',
        '--session-id', 'thread-1',
        '--name', 'remote-cli-thread-1',
        '--provider', 'google',
        '--model', 'gemini-flash',
        '--thinking', 'high',
      ],
    });
  });

  it('prefers a concrete session file and omits provider when the model already includes one', () => {
    expect(buildPiRpcArgs({
      approveProject: false,
      sessionFile: '/tmp/session.jsonl',
      sessionDir: '/tmp/pi-store',
      sessionId: 'ignored',
      provider: 'google',
      model: 'anthropic/claude-sonnet-4',
    })).toEqual({
      command: 'pi',
      args: [
        '--mode', 'rpc',
        '--no-approve',
        '--session', '/tmp/session.jsonl',
        '--model', 'anthropic/claude-sonnet-4',
      ],
    });
  });

  it('splits JSONL on LF only and keeps Unicode line separators inside the record', () => {
    const record = `{"text":"hello\u2028world"}`;
    const { lines, rest } = consumeJsonl(`${record}\n{"ok":true}\npartial`);
    expect(lines).toEqual([record, '{"ok":true}']);
    expect(rest).toBe('partial');
    expect(JSON.parse(lines[0]).text).toContain('\u2028');
  });

  it('parses and formats provider/model refs', () => {
    expect(parsePiModelRef('anthropic/claude-sonnet-4')).toEqual({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4',
    });
    expect(parsePiModelRef('gemini-flash')).toEqual({ modelId: 'gemini-flash' });
    expect(formatPiModelRef({ id: 'claude-sonnet-4', provider: 'anthropic' })).toBe('anthropic/claude-sonnet-4');
  });
});

describe('PiClient process lifecycle', () => {
  afterEach(() => {
    vi.mocked(spawn).mockReset();
    vi.unstubAllEnvs();
  });

  it.each([false, true])('preserves ordinary environment inheritance and strips managed worker credentials: %s', async delegationWorker => {
    vi.stubEnv('REMOTE_CLI_DELEGATION_URL', 'http://127.0.0.1:12345/');
    vi.stubEnv('REMOTE_CLI_DELEGATION_TOKEN', 'parent-test-token');
    const proc = Object.assign(new EventEmitter(), {
      stdin: { end: vi.fn(), write: vi.fn(), destroyed: false, writable: true, on: vi.fn() },
      stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null as number | null, signalCode: null,
      kill: vi.fn(() => { setImmediate(() => { proc.exitCode = 0; proc.emit('exit', 0, null); proc.emit('close', 0, null); }); return true; }),
    });
    vi.mocked(spawn).mockReturnValue(proc as any);
    const client = new PiClient({ command: 'pi', delegationWorker });
    try {
      await client.start();
      const launch = vi.mocked(spawn).mock.calls.at(-1)!;
      expect(launch[1]).not.toContain('--extension');
      expect(launch[2]?.env?.REMOTE_CLI_DELEGATION_TOKEN).toBe(delegationWorker ? undefined : 'parent-test-token');
      expect(launch[2]?.env?.REMOTE_CLI_DELEGATION_URL).toBe(delegationWorker ? undefined : 'http://127.0.0.1:12345/');
    } finally { await client.stop(); }
  });

  it('does not resolve stop until the child process exits', async () => {
    const proc = new EventEmitter() as EventEmitter & {
      stdin: { end: () => void; write: () => boolean; destroyed: boolean; writable: boolean; on: () => void };
      stdout: EventEmitter;
      stderr: EventEmitter;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      kill: ReturnType<typeof vi.fn>;
    };
    proc.stdin = { end: vi.fn(), write: vi.fn(), destroyed: false, writable: true, on: vi.fn() };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.exitCode = null;
    proc.signalCode = null;
    proc.kill = vi.fn(() => {
      setTimeout(() => {
        proc.exitCode = 0;
        proc.emit('exit', 0, null);
        proc.emit('close', 0, null);
      }, 30);
    });
    vi.mocked(spawn).mockReturnValue(proc as any);

    const client = new PiClient({ command: 'pi', killEscalationMs: 200 });
    await client.start();
    const started = Date.now();
    await client.stop();
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    expect(proc.kill).toHaveBeenCalled();
    expect(client.isRunning()).toBe(false);
  });

  it('rejects an unconfirmed stop when the process never exits', async () => {
    const proc = Object.assign(new EventEmitter(), {
      stdin: { end: vi.fn(), write: vi.fn(), destroyed: false, writable: true, on: vi.fn() },
      stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null,
      kill: vi.fn(() => true),
    });
    vi.mocked(spawn).mockReturnValue(proc as any);
    const client = new PiClient({ command: 'pi', killEscalationMs: 10 });
    await client.start();
    const firstStop = client.stop();
    const secondStop = client.stop();
    await expect(firstStop).rejects.toThrow('exit could not be confirmed');
    await expect(secondStop).rejects.toThrow('exit could not be confirmed');
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('keeps an unconfirmed exit failed across later stop calls until exit is observed', async () => {
    const proc = Object.assign(new EventEmitter(), {
      stdin: { end: vi.fn(), write: vi.fn(), destroyed: false, writable: true, on: vi.fn() },
      stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null as number | null, signalCode: null,
      kill: vi.fn(() => true),
    });
    vi.mocked(spawn).mockReturnValue(proc as any);
    const client = new PiClient({ command: 'pi', killEscalationMs: 10 });
    await client.start();
    await expect(client.stop()).rejects.toThrow('exit could not be confirmed');
    await expect(client.stop()).rejects.toThrow('exit could not be confirmed');
    await expect(client.start()).rejects.toThrow('exit could not be confirmed');
    expect(spawn).toHaveBeenCalledTimes(1);
    proc.exitCode = 0;
    proc.emit('exit', 0, null);
    await expect(client.stop()).resolves.toBeUndefined();
    await expect(client.start()).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('keeps a session reset blocked until the previous Pi process actually exits', async () => {
    const project = fs.mkdtempSync(path.join(os.homedir(), '.pi-reset-stop-'));
    const processes: Array<ReturnType<typeof createProcess>> = [];
    function createProcess() {
      const proc = Object.assign(new EventEmitter(), {
        stdin: {
          end: vi.fn(), destroyed: false, writable: true, on: vi.fn(),
          write: vi.fn((line: string) => {
            const command = JSON.parse(line);
            queueMicrotask(() => proc.stdout.emit('data', Buffer.from(JSON.stringify({
              type: 'response', id: command.id, command: command.type, success: true,
              data: command.type === 'get_state' ? { sessionId: 'pi-session' } : { models: [] },
            }) + '\n')));
            return true;
          }),
        },
        stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null as number | null, signalCode: null,
        kill: vi.fn(() => true),
      });
      processes.push(proc);
      return proc;
    }
    vi.mocked(spawn).mockImplementation(() => createProcess() as any);
    const executor = new PiExecutor(new DirectoryGuard([project]), {
      initialWorkingDirectory: project, sessionBaseDir: path.join(project, 'sessions'), threadId: 'ordinary',
      clientFactory: launch => new PiClient({ ...launch, killEscalationMs: 10 }),
    });
    try {
      await executor.listModels();
      const previous = processes[0];
      executor.resetContext();
      await expect(executor.listModels()).rejects.toThrow('exit could not be confirmed');
      expect(spawn).toHaveBeenCalledTimes(1);
      executor.resetContext();
      await expect(executor.execute('Continue')).resolves.toMatchObject({
        success: false, error: expect.stringContaining('exit could not be confirmed'),
      });
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(previous.exitCode).toBeNull();
      previous.exitCode = 0;
      previous.emit('exit', 0, null);
      await expect(executor.listModels()).resolves.toEqual([]);
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally {
      for (const proc of processes) { proc.exitCode = 0; proc.emit('exit', 0, null); }
      await executor.destroy();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('keeps a delegated Pi workspace blocked after abort and repeated cleanup fail', async () => {
    const project = fs.mkdtempSync(path.join(os.homedir(), '.delegated-pi-stop-'));
    const guard = new DirectoryGuard([project]);
    const proc = Object.assign(new EventEmitter(), {
      stdin: {
        end: vi.fn(), destroyed: false, writable: true, on: vi.fn(),
        write: vi.fn((line: string) => {
          const command = JSON.parse(line);
          if (command.type === 'abort') throw new Error('Abort RPC failed');
          if (command.type !== 'prompt') {
            queueMicrotask(() => proc.stdout.emit('data', Buffer.from(JSON.stringify({
              type: 'response', id: command.id, command: command.type, success: true,
              data: command.type === 'get_state' ? { sessionId: 'pi-worker' } : undefined,
            }) + '\n')));
          }
          return true;
        }),
      },
      stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null as number | null, signalCode: null,
      kill: vi.fn(() => true),
    });
    vi.mocked(spawn).mockReturnValue(proc as any);
    const factory = vi.fn((_guard, _config, cwd, threadId) => new PiExecutor(guard, {
      initialWorkingDirectory: cwd, threadId, sessionBaseDir: path.join(project, 'sessions'),
      clientFactory: launch => new PiClient({ ...launch, killEscalationMs: 10 }),
    }));
    const manager = new DelegationManager(guard, factory as any, new BackendRegistry(async () => '1.0'),
      new DelegationStore(path.join(project, 'records')), 1000, 2000);
    try {
      const scope = manager.begin({
        thread: { id: 'owner', name: 'default', workingDirectory: project, sessionId: null,
          createdAt: 0, lastActiveAt: 0 },
        cwd: project, messageId: 'message-1', backend: 'claude', config: { type: 'auto' },
        onToolUse: vi.fn(), onToolResult: vi.fn(), onNotice: vi.fn(), onApproval: vi.fn(() => true),
        onApprovalResolved: vi.fn(),
      });
      const started = await scope.invoke('remote_cli_delegate', { backend: 'pi', objective: 'Wait' }, 'start') as { taskId: string };
      await vi.waitFor(() => expect(proc.stdin.write).toHaveBeenCalledWith(expect.stringContaining('"type":"prompt"')));
      const result = await scope.invoke('remote_cli_cancel', { taskId: started.taskId }, 'cancel');
      expect(result).toMatchObject({ state: 'interrupted' });
      expect(manager.blocksWorkspace(project, 'other')).toBe(true);
      expect(proc.exitCode).toBeNull();
    } finally {
      await manager.destroy();
      proc.exitCode = 0;
      proc.emit('exit', 0, null);
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('does not treat a failed kill signal as a confirmed process exit', async () => {
    const proc = Object.assign(new EventEmitter(), {
      stdin: { end: vi.fn(), write: vi.fn(), destroyed: false, writable: true, on: vi.fn() },
      stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null,
      kill: vi.fn(() => { throw new Error('Signal failed'); }),
    });
    vi.mocked(spawn).mockReturnValue(proc as any);
    const client = new PiClient({ command: 'pi', killEscalationMs: 10 });
    await client.start();
    await expect(client.stop()).rejects.toThrow('exit could not be confirmed');
  });
});
