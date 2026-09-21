import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'child_process';
import { buildPiRpcArgs, consumeJsonl, formatPiModelRef, parsePiModelRef } from '../../src/executor/pi/PiTypes';
import { PiClient } from '../../src/executor/pi/PiClient';

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
});
