import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { DshAcpClient, dshErrorMessage } from '../../src/executor/dsh/DshAcpClient';
import type { AcpEventCallbacks } from '../../src/executor/acp/AcpClient';

vi.mock('child_process', async original => ({ ...await original<typeof import('child_process')>(), spawn: vi.fn() }));

function processFixture() {
  const frames: any[] = [];
  const child: any = new EventEmitter();
  const replies: Record<string, unknown> = {
    initialize: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} }, promptCapabilities: { image: false } } },
    'session/new': { sessionId: 'dsh-session' },
    'session/resume': { configOptions: [] },
    'session/prompt': { stopReason: 'end_turn' },
    'session/close': {},
    'session/set_config_option': { configOptions: [] },
  };
  child.stdout = new Readable({ read() {} }); child.stderr = new Readable({ read() {} });
  child.push = (frame: object) => child.stdout.push(JSON.stringify(frame) + '\n');
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    const frame = JSON.parse(String(chunk)); frames.push(frame); done();
    if (frame.method && frame.id !== undefined && frame.method in replies) {
      queueMicrotask(() => child.push({ jsonrpc: '2.0', id: frame.id, result: replies[frame.method] }));
    }
  } });
  child.kill = vi.fn(() => {
    child.killed = true;
    queueMicrotask(() => { child.stdout.push(null); child.stderr.push(null); child.emit('close', 0, null); });
    return true;
  });
  return { child, frames, replies };
}

describe('DshAcpClient', () => {
  let fixture: ReturnType<typeof processFixture>;
  let clients: DshAcpClient[];
  const create = (callbacks: AcpEventCallbacks = {}, timeout = 1000) => {
    const client = new DshAcpClient('custom-dsh', process.cwd(), callbacks, timeout);
    clients.push(client); return client;
  };
  beforeEach(() => {
    clients = []; fixture = processFixture();
    vi.mocked(spawn).mockReturnValue(fixture.child);
  });
  afterEach(async () => {
    for (const client of clients) { client.destroy(); await client.waitForExit(); }
    vi.restoreAllMocks(); vi.unstubAllEnvs();
  });

  it('uses a private per-process overlay for both upload paths without modifying the parent environment', async () => {
    vi.stubEnv('DSH_TELEMETRY_DISABLED', '');
    const client = create();
    const [command, args, options] = vi.mocked(spawn).mock.calls[0] as any[];
    expect(command).toBe('custom-dsh');
    expect(args.slice(0, 3)).toEqual(['--profile', 'acp', '--patch']);
    const patch = args[3];
    expect(fs.readFileSync(patch, 'utf8')).toContain('session-log-deepseek\n  config:\n    enabled: false');
    expect(fs.readFileSync(patch, 'utf8')).toContain('session-telemetry-otel\n  config:\n    mode: DISABLED');
    if (process.platform !== 'win32') expect(fs.statSync(patch).mode & 0o777).toBe(0o600);
    expect(options.env.DSH_TELEMETRY_DISABLED).toBe('1');
    expect(process.env.DSH_TELEMETRY_DISABLED).toBe('');
    expect(options.env.HOME).toBe(process.env.HOME);
    expect(options.detached).toBe(process.platform !== 'win32' ? true : undefined);
    client.destroy(); await client.waitForExit();
    expect(fs.existsSync(path.dirname(patch))).toBe(false);
    clients = [];
  });

  it('uses resume and close rather than unsupported load/delete methods, preserving stdio MCP declarations', async () => {
    const client = create(); await client.initialize();
    const servers = [{ name: 'remote-cli-delegation', command: process.execPath, args: ['bridge.js'], env: [{ name: 'TOKEN', value: 'test-only' }] }];
    await client.newSession(process.cwd(), servers);
    await client.loadSession('persisted', process.cwd(), servers);
    await client.setConfigOption('persisted', 'reasoning_effort', '');
    await client.deleteSession('persisted');
    expect(fixture.frames.find(f => f.method === 'session/resume').params).toEqual({ sessionId: 'persisted', cwd: process.cwd(), mcpServers: servers });
    expect(fixture.frames.some(f => ['session/load', 'session/delete'].includes(f.method))).toBe(false);
  });

  it('refuses unsupported mixed image input before submitting any prompt', async () => {
    const client = create(); await client.initialize();
    await expect(client.prompt('s', [{ type: 'text', text: 'inspect' }, { type: 'image', data: 'AA==', mimeType: 'image/png' }])).rejects.toThrow('No part');
    expect(fixture.frames.some(f => f.method === 'session/prompt')).toBe(false);
  });

  it('forwards image blocks only when the connection advertises them', async () => {
    (fixture.replies.initialize as any).agentCapabilities.promptCapabilities.image = true;
    const client = create(); await client.initialize();
    const blocks = [{ type: 'image', data: 'AA==', mimeType: 'image/png' }];
    expect(await client.prompt('s', blocks)).toEqual({ stopReason: 'end_turn' });
    expect(fixture.frames.find(f => f.method === 'session/prompt').params.prompt).toEqual(blocks);
  });

  it.each(['approve', 'deny', 'throw', 'absent', 'invalid'])('returns a standard nested permission outcome: %s', async mode => {
    const options = [{ optionId: 'allow-once', kind: 'allow_once' }, { optionId: 'reject-once', kind: 'reject_once' }];
    const onPermissionRequest = mode === 'absent' ? undefined : vi.fn(async () => {
      if (mode === 'throw') throw new Error('permission UI failed');
      return mode === 'approve' ? 0 : mode === 'deny' ? 1 : 900;
    });
    create({ onPermissionRequest });
    fixture.child.push({ jsonrpc: '2.0', id: 78, method: 'session/request_permission', params: { toolCall: { title: 'Bash' }, options } });
    await vi.waitFor(() => expect(fixture.frames.some(f => f.id === 78)).toBe(true));
    expect(fixture.frames.find(f => f.id === 78).result).toEqual({ outcome: mode === 'approve'
      ? { outcome: 'selected', optionId: 'allow-once' } : { outcome: 'cancelled' } });
  });

  it('keeps thought/text/usage events separate and preserves DSH tool names', async () => {
    const callbacks = { onTextChunk: vi.fn(), onThoughtChunk: vi.fn(), onToolCall: vi.fn(), onToolResult: vi.fn(), onUsage: vi.fn() };
    create(callbacks);
    for (const update of [
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'private reasoning' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi!' } },
      { sessionUpdate: 'tool_call', toolCallId: 't', title: 'shell', kind: 'other', status: 'in_progress' },
      { sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'in_progress' },
      { sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'completed' },
      { sessionUpdate: 'usage_update', used: 20, size: 100 },
    ]) fixture.child.push({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update } });
    await vi.waitFor(() => expect(callbacks.onUsage).toHaveBeenCalled());
    expect(callbacks.onTextChunk).toHaveBeenCalledTimes(1);
    expect(callbacks.onTextChunk).toHaveBeenCalledWith({ type: 'text', text: 'Hi!' });
    expect(callbacks.onThoughtChunk).toHaveBeenCalledTimes(1);
    expect(callbacks.onThoughtChunk).toHaveBeenCalledWith({ type: 'text', text: 'private reasoning' });
    expect(callbacks.onToolCall).toHaveBeenCalledWith(expect.objectContaining({ title: 'shell', kind: undefined }));
    expect(callbacks.onToolCall).toHaveBeenCalledTimes(1);
    expect(callbacks.onToolResult).toHaveBeenCalledTimes(1);
  });

  it('rejects incompatible ACP versions and stops that process', async () => {
    fixture.replies.initialize = { protocolVersion: 2 };
    const client = create();
    await expect(client.initialize()).rejects.toThrow('compatible');
    expect(fixture.child.kill).toHaveBeenCalled();
  });

  it('bounds control requests without imposing a short model-turn timeout', async () => {
    delete fixture.replies.initialize;
    const client = create({}, 10);
    await expect(client.initialize()).rejects.toThrow('timed out');
    await client.waitForExit();
    await expect(client.newSession(process.cwd())).rejects.toThrow('exited');
  });

  it('cancels using a notification and rejects pending prompts on destruction', async () => {
    delete fixture.replies['session/prompt'];
    const client = create(); await client.initialize();
    const pending = client.prompt('s', [{ type: 'text', text: 'work' }]);
    const rejected = expect(pending).rejects.toThrow('destroyed');
    client.sendCancel('s'); client.destroy(); await rejected;
    expect(fixture.frames.find(f => f.method === 'session/cancel')).toEqual({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's' } });
  });

  it('does not print provider stderr and redacts credential-bearing protocol errors', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    create(); fixture.child.stderr.push('Authorization: Bearer test-secret');
    await new Promise(resolve => setImmediate(resolve));
    expect(error).not.toHaveBeenCalled();
    const message = dshErrorMessage(new Error('Authorization: Bearer test-secret api_key=sk-test-secret https://private.invalid/token'));
    expect(message).not.toContain('test-secret'); expect(message).not.toContain('private.invalid');
  });

  it('cleans up the overlay if spawning fails synchronously', () => {
    vi.mocked(spawn).mockImplementation(() => { throw new Error('spawn failed'); });
    expect(() => create()).toThrow('spawn failed');
    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(fs.existsSync(path.dirname(args[3]))).toBe(false);
  });

  it('fails closed before spawning if the privacy overlay cannot be written', () => {
    const directory = vi.spyOn(fs, 'mkdtempSync');
    vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(() => create()).toThrow('disk full');
    expect(spawn).not.toHaveBeenCalled();
    expect(fs.existsSync(directory.mock.results[0].value)).toBe(false);
  });

  it('contains overlay cleanup errors without an unhandled rejection', async () => {
    const client = create();
    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    const directory = path.dirname(args[3]);
    const remove = vi.spyOn(fs, 'rmSync').mockImplementationOnce(() => { throw new Error('cleanup denied'); });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      client.destroy(); await client.waitForExit();
      expect(warning).toHaveBeenCalledWith('[DSH] Temporary privacy overlay cleanup failed.');
    } finally { remove.mockRestore(); fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
