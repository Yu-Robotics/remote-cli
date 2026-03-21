/**
 * Unit tests for AcpClient.
 *
 * Uses a mock child process (EventEmitter + writable stdin stub) so tests
 * run without spawning a real Gemini CLI subprocess.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { Writable, Readable } from 'stream';
import { AcpEventCallbacks } from '../../src/executor/acp/AcpClient';

// ─── Mock child_process.spawn ─────────────────────────────────────────────────

vi.mock('child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('child_process')>();
  return { ...orig, spawn: vi.fn() };
});

import { spawn } from 'child_process';
import { AcpClient } from '../../src/executor/acp/AcpClient';

// ─── Mock child process factory ───────────────────────────────────────────────

function makeFakeProcess() {
  const stdinLines: string[] = [];
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      stdinLines.push(chunk.toString());
      cb();
    },
  });
  (stdin as any).end = vi.fn((cb?: () => void) => { cb?.(); });

  const stdout = new Readable({ read() {} });

  const proc = new EventEmitter() as any;
  proc.stdin = stdin;
  proc.stdout = stdout;
  proc.killed = false;
  proc.kill = vi.fn((sig?: string) => {
    proc.killed = true;
    setImmediate(() => proc.emit('close', sig === 'SIGKILL' ? 137 : 0, sig ?? null));
  });

  /** Push a JSON-RPC line as if it came from Gemini CLI stdout */
  proc.pushLine = (obj: object) => {
    stdout.push(JSON.stringify(obj) + '\n');
  };

  return { proc, stdinLines };
}

// ─── Test setup ───────────────────────────────────────────────────────────────

let fakeProc: ReturnType<typeof makeFakeProcess>;
let callbacks: AcpEventCallbacks;
let client: AcpClient;

beforeEach(() => {
  fakeProc = makeFakeProcess();
  (spawn as ReturnType<typeof vi.fn>).mockReturnValue(fakeProc.proc);

  callbacks = {
    onTextChunk: vi.fn(),
    onThoughtChunk: vi.fn(),
    onToolCall: vi.fn(),
    onToolResult: vi.fn(),
    onPlan: vi.fn(),
  };

  client = new AcpClient('gemini', ['--acp'], '/tmp', callbacks);
});

afterEach(() => {
  client?.destroy();
  vi.clearAllMocks();
});

// ─── Helper: reply to the latest pending request ──────────────────────────────

function replyTo(id: number, result: unknown) {
  fakeProc.proc.pushLine({ jsonrpc: '2.0', id, result });
}

function sentRequest(method: string) {
  const line = fakeProc.stdinLines.find(l => l.includes(`"${method}"`));
  return line ? JSON.parse(line) : null;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AcpClient - JSON-RPC lifecycle', () => {
  it('sends initialize request and resolves on response', async () => {
    const p = client.initialize();
    const req = sentRequest('initialize');
    expect(req).not.toBeNull();
    expect(req.method).toBe('initialize');
    replyTo(req.id, { protocolVersion: 1 });
    await expect(p).resolves.toBeUndefined();
  });

  it('sends session/new and returns sessionId', async () => {
    const p = client.newSession('/tmp');
    const req = sentRequest('session/new');
    expect(req.params).toMatchObject({ cwd: '/tmp' });
    replyTo(req.id, { sessionId: 'sess-abc-123' });
    await expect(p).resolves.toBe('sess-abc-123');
  });

  it('sends session/set_mode', async () => {
    const p = client.setSessionMode('sess-1', 'yolo');
    const req = sentRequest('session/set_mode');
    expect(req.params).toMatchObject({ sessionId: 'sess-1', modeId: 'yolo' });
    replyTo(req.id, {});
    await expect(p).resolves.toBeUndefined();
  });

  it('sends session/prompt with correct payload', async () => {
    const p = client.prompt('sess-1', 'hello world');
    const req = sentRequest('session/prompt');
    expect(req.params).toMatchObject({
      sessionId: 'sess-1',
      prompt: [{ type: 'text', text: 'hello world' }],
    });
    replyTo(req.id, { stopReason: 'end_turn' });
    const result = await p;
    expect(result.stopReason).toBe('end_turn');
  });

  it('rejects when server returns JSON-RPC error', async () => {
    const p = client.initialize();
    const req = sentRequest('initialize');
    fakeProc.proc.pushLine({ jsonrpc: '2.0', id: req.id, error: { code: -32600, message: 'Invalid request' } });
    await expect(p).rejects.toThrow('ACP error -32600: Invalid request');
  });

  it('rejects all pending requests on child process close', async () => {
    const p = client.initialize();
    // Give readline a tick to register before close
    await new Promise(r => setImmediate(r));
    fakeProc.proc.emit('close', 1, null);
    await expect(p).rejects.toThrow('Gemini CLI exited');
  });
});

describe('AcpClient - session/update notifications', () => {
  it('routes agent_message_chunk to onTextChunk', async () => {
    fakeProc.proc.pushLine({
      jsonrpc: '2.0', method: 'session/update',
      params: {
        sessionId: 'sess-1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello from Gemini' } },
      },
    });
    await new Promise(r => setImmediate(r));
    expect(callbacks.onTextChunk).toHaveBeenCalledWith('Hello from Gemini');
  });

  it('routes agent_thought_chunk to onThoughtChunk', async () => {
    fakeProc.proc.pushLine({
      jsonrpc: '2.0', method: 'session/update',
      params: {
        sessionId: 'sess-1',
        update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking...' } },
      },
    });
    await new Promise(r => setImmediate(r));
    expect(callbacks.onThoughtChunk).toHaveBeenCalledWith('Thinking...');
  });

  it('routes tool_call to onToolCall', async () => {
    fakeProc.proc.pushLine({
      jsonrpc: '2.0', method: 'session/update',
      params: {
        sessionId: 'sess-1',
        update: { sessionUpdate: 'tool_call', toolCallId: 'tc-001', title: 'Read file', kind: 'read' },
      },
    });
    await new Promise(r => setImmediate(r));
    expect(callbacks.onToolCall).toHaveBeenCalledWith('tc-001', 'Read file', 'read');
  });

  it('routes tool_call_update with status=completed to onToolResult', async () => {
    fakeProc.proc.pushLine({
      jsonrpc: '2.0', method: 'session/update',
      params: {
        sessionId: 'sess-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-001',
          status: 'completed',
          content: [{ type: 'text', text: 'file contents here' }],
        },
      },
    });
    await new Promise(r => setImmediate(r));
    expect(callbacks.onToolResult).toHaveBeenCalledWith('tc-001', 'completed', 'file contents here');
  });

  it('does NOT call onToolResult for non-completed tool_call_update', async () => {
    fakeProc.proc.pushLine({
      jsonrpc: '2.0', method: 'session/update',
      params: {
        sessionId: 'sess-1',
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-001', status: 'running' },
      },
    });
    await new Promise(r => setImmediate(r));
    expect(callbacks.onToolResult).not.toHaveBeenCalled();
  });

  it('routes plan to onPlan as formatted text', async () => {
    fakeProc.proc.pushLine({
      jsonrpc: '2.0', method: 'session/update',
      params: {
        sessionId: 'sess-1',
        update: {
          sessionUpdate: 'plan',
          entries: [
            { content: 'Read the file', status: 'completed', priority: 'high' },
            { content: 'Edit the function', status: 'in_progress', priority: 'high' },
          ],
        },
      },
    });
    await new Promise(r => setImmediate(r));
    expect(callbacks.onPlan).toHaveBeenCalledWith(
      '[completed] (high) Read the file\n[in_progress] (high) Edit the function'
    );
  });

  it('ignores non-text content blocks in agent_message_chunk (no crash, no callback)', async () => {
    fakeProc.proc.pushLine({
      jsonrpc: '2.0', method: 'session/update',
      params: {
        sessionId: 'sess-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'image', data: 'base64...', mimeType: 'image/png' },
        },
      },
    });
    await new Promise(r => setImmediate(r));
    expect(callbacks.onTextChunk).not.toHaveBeenCalled();
  });

  it('ignores unknown sessionUpdate types without throwing', async () => {
    expect(() =>
      fakeProc.proc.pushLine({
        jsonrpc: '2.0', method: 'session/update',
        params: { sessionId: 'sess-1', update: { sessionUpdate: 'future_type', someField: 42 } },
      })
    ).not.toThrow();
  });
});

describe('AcpClient - permission handling', () => {
  it('auto-approves with allow_once by default', async () => {
    fakeProc.proc.pushLine({
      jsonrpc: '2.0', id: 99, method: 'session/request_permission',
      params: {
        sessionId: 'sess-1',
        toolCall: { toolCallId: 'tc-1', title: 'Execute bash' },
        options: [
          { optionId: 'opt-allow', kind: 'allow_once', name: 'Allow once' },
          { optionId: 'opt-deny', kind: 'reject_once', name: 'Deny' },
        ],
      },
    });
    await new Promise(r => setImmediate(r));

    const responseLine = fakeProc.stdinLines.find(l => l.includes('"opt-allow"'));
    expect(responseLine).toBeDefined();
    const response = JSON.parse(responseLine!);
    expect(response.result.outcome).toMatchObject({ outcome: 'selected', optionId: 'opt-allow' });
  });

  it('sends cancelled outcome when reject option is chosen', async () => {
    const rejectClient = new AcpClient('g', ['--acp'], '/tmp', {
      ...callbacks,
      onPermissionRequest: async () => 1, // index 1 = reject_once
    });

    fakeProc.proc.pushLine({
      jsonrpc: '2.0', id: 100, method: 'session/request_permission',
      params: {
        sessionId: 'sess-1',
        toolCall: { toolCallId: 'tc-2', title: 'Delete file' },
        options: [
          { optionId: 'opt-allow', kind: 'allow_once', name: 'Allow' },
          { optionId: 'opt-deny', kind: 'reject_once', name: 'Deny' },
        ],
      },
    });
    await new Promise(r => setImmediate(r));

    const cancelLine = fakeProc.stdinLines.find(l => l.includes('"cancelled"'));
    expect(cancelLine).toBeDefined();
    expect(JSON.parse(cancelLine!).result.outcome).toMatchObject({ outcome: 'cancelled' });

    rejectClient.destroy();
  });
});

describe('AcpClient - JSON-RPC validation', () => {
  it('ignores plain non-JSON stdout lines gracefully', async () => {
    expect(() => fakeProc.proc.stdout.push('not json at all\n')).not.toThrow();
    await new Promise(r => setImmediate(r));
    // No callbacks fired, no crash
    expect(callbacks.onTextChunk).not.toHaveBeenCalled();
  });

  it('ignores messages missing jsonrpc:2.0 field', async () => {
    expect(() =>
      fakeProc.proc.stdout.push('{"id":1,"result":{"protocolVersion":1}}\n')
    ).not.toThrow();
    await new Promise(r => setImmediate(r));
  });
});

describe('AcpClient - sendCancel', () => {
  it('sends a session/cancel notification (no id field)', () => {
    client.sendCancel('sess-xyz');
    const line = fakeProc.stdinLines.find(l => l.includes('"session/cancel"'));
    expect(line).toBeDefined();
    const msg = JSON.parse(line!);
    expect(msg.params).toMatchObject({ sessionId: 'sess-xyz' });
    expect(msg.id).toBeUndefined();
  });
});

describe('AcpClient - graceful shutdown', () => {
  it('closes stdin before sending SIGTERM', () => {
    client.destroy();
    expect((fakeProc.proc.stdin.end as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    expect(fakeProc.proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('rejects in-flight requests on destroy', async () => {
    const p = client.initialize();
    client.destroy();
    await expect(p).rejects.toThrow('AcpClient destroyed');
  });

  it('is idempotent — second destroy is a no-op', () => {
    client.destroy();
    client.destroy();
    expect(fakeProc.proc.kill).toHaveBeenCalledTimes(1);
  });
});
