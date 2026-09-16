import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

vi.mock('child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('child_process')>();
  return { ...original, spawn: vi.fn() };
});

import { spawn } from 'child_process';
import { AcpClient, type AcpEventCallbacks } from '../../src/executor/acp/AcpClient';

function fakeProcess() {
  const lines: string[] = [];
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const process = new EventEmitter() as any;
  process.stdin = stdin;
  process.stdout = stdout;
  process.stderr = stderr;
  process.killed = false;
  process.kill = vi.fn(() => { process.killed = true; });
  process.push = (message: object) => stdout.push(`${JSON.stringify(message)}\n`);
  return { process, lines };
}

function request(lines: string[], method: string) {
  const line = lines.find((entry) => entry.includes(`"method":"${method}"`));
  return line ? JSON.parse(line) : undefined;
}

describe('AcpClient', () => {
  let fake: ReturnType<typeof fakeProcess>;
  let callbacks: AcpEventCallbacks;
  let client: AcpClient;

  beforeEach(() => {
    fake = fakeProcess();
    vi.mocked(spawn).mockReturnValue(fake.process);
    callbacks = {
      onTextChunk: vi.fn(),
      onThoughtChunk: vi.fn(),
      onToolCall: vi.fn(),
      onToolResult: vi.fn(),
      onConfigOptions: vi.fn(),
      onPermissionRequest: vi.fn().mockResolvedValue(0),
    };
    client = new AcpClient('opencode', ['acp'], '/tmp', callbacks);
  });

  afterEach(() => {
    client.destroy();
    vi.clearAllMocks();
  });

  it('initializes ACP protocol version 1', async () => {
    const pending = client.initialize();
    const sent = request(fake.lines, 'initialize');
    expect(sent.params).toEqual({ protocolVersion: 1, clientCapabilities: {} });
    fake.process.push({ jsonrpc: '2.0', id: sent.id, result: { protocolVersion: 1 } });
    await expect(pending).resolves.toMatchObject({ protocolVersion: 1 });
  });

  it('creates and loads sessions with the working directory', async () => {
    const creating = client.newSession('/repo');
    const createdRequest = request(fake.lines, 'session/new');
    fake.process.push({ jsonrpc: '2.0', id: createdRequest.id, result: { sessionId: 'ses-1', configOptions: [] } });
    await expect(creating).resolves.toMatchObject({ sessionId: 'ses-1' });

    const loading = client.loadSession('ses-1', '/repo');
    const loadedRequest = request(fake.lines, 'session/load');
    expect(loadedRequest.params).toMatchObject({ sessionId: 'ses-1', cwd: '/repo', mcpServers: [] });
    fake.process.push({ jsonrpc: '2.0', id: loadedRequest.id, result: { configOptions: [] } });
    await expect(loading).resolves.toBeDefined();
  });

  it('sends native image content in prompts', async () => {
    const pending = client.prompt('ses-1', [
      { type: 'text', text: 'inspect' },
      { type: 'image', data: 'abc', mimeType: 'image/png' },
    ]);
    const sent = request(fake.lines, 'session/prompt');
    expect(sent.params.prompt[1]).toEqual({ type: 'image', data: 'abc', mimeType: 'image/png' });
    fake.process.push({ jsonrpc: '2.0', id: sent.id, result: { stopReason: 'end_turn' } });
    await expect(pending).resolves.toEqual({ stopReason: 'end_turn' });
  });

  it('routes text, thought, tool, and config update notifications', async () => {
    const updates = [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } },
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'reasoning' } },
      { sessionUpdate: 'tool_call', toolCallId: 'tool-1', kind: 'execute', title: 'pwd' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', content: [{ type: 'text', text: '/tmp' }] },
      { sessionUpdate: 'config_options_update', configOptions: [{ id: 'model', name: 'Model', type: 'select' }] },
    ];
    for (const update of updates) {
      fake.process.push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'ses-1', update } });
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(callbacks.onTextChunk).toHaveBeenCalledWith({ type: 'text', text: 'answer' });
    expect(callbacks.onThoughtChunk).toHaveBeenCalledWith({ type: 'text', text: 'reasoning' });
    expect(callbacks.onToolCall).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: 'tool-1' }));
    expect(callbacks.onToolResult).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
    expect(callbacks.onConfigOptions).toHaveBeenCalled();
  });

  it('answers permission requests with the selected option', async () => {
    fake.process.push({
      jsonrpc: '2.0', id: 42, method: 'session/request_permission',
      params: {
        sessionId: 'ses-1', toolCall: { title: 'Run pwd' },
        options: [{ kind: 'allow_once', optionId: 'allow', name: 'Allow' }],
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const reply = fake.lines.map((line) => JSON.parse(line)).find((message) => message.id === 42);
    expect(reply.result).toEqual({ outcome: 'selected', optionId: 'allow' });
  });

  it('returns structured ACP errors to callers', async () => {
    const pending = client.setConfigOption('ses-1', 'model', 'missing');
    const sent = request(fake.lines, 'session/set_config_option');
    fake.process.push({ jsonrpc: '2.0', id: sent.id, error: { code: -32602, message: 'invalid model' } });
    await expect(pending).rejects.toThrow('ACP error -32602: invalid model');
  });
});

