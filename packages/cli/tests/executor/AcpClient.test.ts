import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';


// These tests supply EventEmitter processes, not OS workers. Native admission and
// containment are exercised by ManagedSpawn.native.test.ts on each native runner.
vi.mock('../../src/executor/ManagedSpawn', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/executor/ManagedSpawn')>();
  const { ownedSpawn } = await import('../../src/delegation/OwnershipRuntime');
  return { ...actual, spawnManaged: (_enabled: boolean, ...args: Parameters<typeof ownedSpawn>) => ownedSpawn(...args) };
});

vi.mock('child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('child_process')>();
  return { ...original, spawn: vi.fn() };
});

import { spawn } from 'child_process';
import { AcpClient, type AcpEventCallbacks } from '../../src/executor/acp/AcpClient';
import { applyAgySessionSettings } from '../../src/executor/agy/AgySessionSettings';
import { KimiDeletionClient } from '../../src/delegation/KimiSessionDeletion';

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
    client = new AcpClient('opencode', ['acp'], process.cwd(), callbacks);
  });

  afterEach(() => {
    client.destroy();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('issues fresh admission only after initial controls finish and expires their setter', async () => {
    let saved = false;
    let initialConfigure: ((id: string, value: string) => Promise<unknown>) | undefined;
    const pending = client.newSessionWithSetup(process.cwd(), [], async (session, configure) => {
      expect(session.sessionId).toBe('synthetic-session'); saved = true; initialConfigure = configure;
      await applyAgySessionSettings(session, configure, { model: 'synthetic-model-high', effort: 'low' });
    });
    const state = (thought: string) => ({ configOptions: [
      { id: 'model', category: 'model', type: 'select', currentValue: 'synthetic-model' },
      { id: 'thought_level', category: 'thought_level', type: 'select', currentValue: thought },
    ] });
    fake.process.push({ jsonrpc: '2.0', id: request(fake.lines, 'session/new').id, result: { sessionId: 'synthetic-session', ...state('medium') } });
    await vi.waitFor(() => expect(request(fake.lines, 'session/set_config_option')).toBeDefined());
    expect(saved).toBe(true); expect(client.sessionAdmission('synthetic-session')).toBeUndefined();
    const model = JSON.parse(fake.lines.at(-1)!); expect(model.params.configId).toBe('model');
    expect(model.params.value).toBe('synthetic-model-high');
    fake.process.push({ jsonrpc: '2.0', id: model.id, result: state('high') });
    await vi.waitFor(() => expect(JSON.parse(fake.lines.at(-1)!).params.configId).toBe('thought_level'));
    expect(client.sessionAdmission('synthetic-session')).toBeUndefined();
    const thought = JSON.parse(fake.lines.at(-1)!); expect(thought.params.value).toBe('low');
    expect(request(fake.lines, 'session/prompt')).toBeUndefined();
    fake.process.push({ jsonrpc: '2.0', id: thought.id, result: state('low') }); await pending;
    expect(client.sessionAdmission('synthetic-session')).toBeDefined();
    const count = fake.lines.length;
    await expect(initialConfigure!('model', 'late')).rejects.toThrow('invalidated'); expect(fake.lines).toHaveLength(count);
  });

  it.each(['cancel', 'config', 'new', 'load', 'destroy', 'close', 'delete', 'prompt'] as const)('cannot reauthorize initial setup after concurrent %s', async action => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const setup = vi.fn(async () => { await gate; });
    const pending = client.newSessionWithSetup(process.cwd(), [], setup);
    const rejected = expect(pending).rejects.toThrow('invalidated');
    fake.process.push({ jsonrpc: '2.0', id: request(fake.lines, 'session/new').id, result: { sessionId: 'synthetic-session' } });
    await vi.waitFor(() => expect(setup).toHaveBeenCalledOnce());
    let control: Promise<unknown> | undefined;
    if (action === 'cancel') client.sendCancel('synthetic-session');
    if (action === 'config') control = client.setConfigOption('synthetic-session', 'model', 'other');
    if (action === 'new') control = client.newSession(process.cwd());
    if (action === 'load') control = client.loadSession('synthetic-session', process.cwd());
    if (action === 'destroy') client.destroy();
    if (action === 'close') fake.process.emit('close', 0, null);
    if (action === 'delete') control = client.deleteSession('synthetic-session');
    if (action === 'prompt') {
      await expect(client.prompt('synthetic-session', [])).rejects.toThrow('setup is still pending');
      expect(request(fake.lines, 'session/prompt')).toBeUndefined();
    }
    if (control) {
      fake.process.push({ jsonrpc: '2.0', id: JSON.parse(fake.lines.at(-1)!).id, result: { sessionId: 'different-session' } });
      await control;
    }
    release(); await rejected; expect(client.sessionAdmission('synthetic-session')).toBeUndefined();
  });

  it('rejects a model reply arriving after cancel without sending a later thought-level control', async () => {
    const session = { sessionId: 'synthetic-session', configOptions: [
      { id: 'model', category: 'model', type: 'select', currentValue: 'synthetic-model' },
      { id: 'thought_level', category: 'thought_level', type: 'select', currentValue: 'low' },
    ] };
    const pending = client.newSessionWithSetup(process.cwd(), [], async (allocated, configure) => {
      await applyAgySessionSettings(allocated, configure, { model: 'synthetic-model', effort: 'high' });
    });
    const rejected = expect(pending).rejects.toThrow('model selection');
    fake.process.push({ jsonrpc: '2.0', id: request(fake.lines, 'session/new').id, result: session });
    await vi.waitFor(() => expect(request(fake.lines, 'session/set_config_option')).toBeDefined());
    client.sendCancel('synthetic-session');
    fake.process.push({ jsonrpc: '2.0', id: request(fake.lines, 'session/set_config_option').id, result: session });
    await rejected;
    expect(fake.lines.map(line => JSON.parse(line)).filter(frame => frame.method === 'session/set_config_option')).toHaveLength(1);
    expect(client.sessionAdmission('synthetic-session')).toBeUndefined(); expect(request(fake.lines, 'session/prompt')).toBeUndefined();
  });

  it('rejects stale allocation replies after cancellation and never calls their setup', async () => {
    const setup = vi.fn(); const pending = client.newSessionWithSetup(process.cwd(), [], setup);
    const rejected = expect(pending).rejects.toThrow('invalidated'); client.sendCancel('synthetic-session');
    fake.process.push({ jsonrpc: '2.0', id: request(fake.lines, 'session/new').id, result: { sessionId: 'synthetic-session' } });
    await rejected; expect(setup).not.toHaveBeenCalled(); expect(client.sessionAdmission('synthetic-session')).toBeUndefined();
    const duplicate = client.newSession(process.cwd());
    fake.process.push({ jsonrpc: '2.0', id: JSON.parse(fake.lines.at(-1)!).id, result: { sessionId: 'synthetic-session' } });
    await duplicate; expect(client.sessionAdmission('synthetic-session')).toBeUndefined();
  });

  it('cannot grant fresh admission to an identity previously loaded from storage', async () => {
    const loading = client.loadSession('saved-session', process.cwd());
    fake.process.push({ jsonrpc: '2.0', id: JSON.parse(fake.lines.at(-1)!).id, result: { sessionId: 'saved-session' } });
    await loading;
    const creating = client.newSessionWithSetup(process.cwd(), [], async () => {});
    fake.process.push({ jsonrpc: '2.0', id: JSON.parse(fake.lines.at(-1)!).id, result: { sessionId: 'saved-session' } });
    await creating; expect(client.sessionAdmission('saved-session')).toBeUndefined();
  });

  it('does not publish initial admission when native configuration fails', async () => {
    const pending = client.newSessionWithSetup(process.cwd(), [], async (_session, configure) => { await configure('model', 'unknown-model'); });
    const rejected = expect(pending).rejects.toThrow();
    fake.process.push({ jsonrpc: '2.0', id: JSON.parse(fake.lines.at(-1)!).id, result: { sessionId: 'synthetic-session' } });
    await vi.waitFor(() => expect(request(fake.lines, 'session/set_config_option')).toBeDefined());
    fake.process.push({ jsonrpc: '2.0', id: JSON.parse(fake.lines.at(-1)!).id, error: { code: -32602, message: 'Synthetic unsupported selection' } });
    await rejected; expect(client.sessionAdmission('synthetic-session')).toBeUndefined();
    expect(request(fake.lines, 'session/prompt')).toBeUndefined();
  });

  it('bounds a stuck initial setup and cannot publish admission on late completion', async () => {
    vi.useFakeTimers(); let release!: () => void;
    const setup = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const pending = client.newSessionWithSetup(process.cwd(), [], setup); const rejected = expect(pending).rejects.toThrow('setup timed out');
    fake.process.push({ jsonrpc: '2.0', id: request(fake.lines, 'session/new').id, result: { sessionId: 'synthetic-session' } });
    await vi.advanceTimersByTimeAsync(0); expect(setup).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000); await rejected; release(); await Promise.resolve();
    expect(client.sessionAdmission('synthetic-session')).toBeUndefined();
  });

  it('preserves exact native missing-ID error data for deletion reconciliation', async () => {
    const pending = client.deleteSession('synthetic-session');
    const sent = request(fake.lines, 'session/delete');
    fake.process.push({ jsonrpc: '2.0', id: sent.id, error: { code: -32602,
      message: 'Unknown sessionId: synthetic-session', data: { sessionId: 'synthetic-session' } } });
    await expect(pending).rejects.toMatchObject({ code: -32602, rpcMessage: 'Unknown sessionId: synthetic-session',
      data: { sessionId: 'synthetic-session' } });
  });

  it('rejects model and session activation methods in the Kimi maintenance transport', async () => {
    client.destroy(); fake.process.emit('close', 0, null); fake = fakeProcess();
    vi.mocked(spawn).mockReturnValue(fake.process);
    client = new KimiDeletionClient('synthetic-kimi', ['acp'], process.cwd(), {});
    await expect(client.newSession(process.cwd())).rejects.toThrow('Disallowed');
    await expect(client.loadSession('synthetic', process.cwd())).rejects.toThrow('Disallowed');
    await expect(client.prompt('synthetic', [])).rejects.toThrow('Disallowed');
    await expect(client.setConfigOption('synthetic', 'model', 'synthetic')).rejects.toThrow('Disallowed');
    expect(fake.lines).toEqual([]);
    fake.process.push({ jsonrpc: '2.0', id: 99, method: 'authenticate', params: {} });
    await new Promise(resolve => setImmediate(resolve));
    expect(fake.lines.map(line => JSON.parse(line))).toEqual([{ jsonrpc: '2.0', id: 99, error: { code: -32601, message: 'Method not found' } }]);
  });

  it.each([false, true])('uses process-group cleanup only for managed ACP processes: %s', async managed => {
    client.destroy();
    fake.process.emit('close', 0, null);
    fake = fakeProcess();
    fake.process.pid = 424242;
    vi.mocked(spawn).mockReturnValue(fake.process);
    const signal = vi.spyOn(process, 'kill').mockReturnValue(true);
    try {
      client = new AcpClient('opencode', ['acp'], process.cwd(), callbacks, managed);
      const detached = managed && process.platform !== 'win32';
      const grouped = managed && process.platform === 'linux';
      expect(vi.mocked(spawn).mock.calls.at(-1)?.[2]?.detached).toBe(detached ? true : undefined);
      client.destroy();
      if (grouped) {
        expect(signal).toHaveBeenCalledWith(-424242, 'SIGTERM');
        expect(fake.process.kill).not.toHaveBeenCalled();
      } else {
        expect(signal).not.toHaveBeenCalled();
        expect(fake.process.kill).toHaveBeenCalledWith('SIGTERM');
      }
      fake.process.emit('close', 0, null);
      await client.waitForExit();
    } finally { signal.mockRestore(); }
  });

  it('initializes ACP protocol version 1', async () => {
    const pending = client.initialize();
    const sent = request(fake.lines, 'initialize');
    expect(sent.params).toEqual({ protocolVersion: 1, clientCapabilities: {} });
    fake.process.push({ jsonrpc: '2.0', id: sent.id, result: { protocolVersion: 1 } });
    await expect(pending).resolves.toMatchObject({ protocolVersion: 1 });
  });

  it.each([false, true])('passes an isolated environment through managed=%s launches', managed => {
    client.destroy();
    fake.process.emit('close', 0, null);
    fake = fakeProcess();
    vi.mocked(spawn).mockReturnValue(fake.process);
    const environment = { SYNTHETIC_ACP_ENV: 'child-only' };
    client = new AcpClient('synthetic-acp', ['acp'], process.cwd(), callbacks, managed, { env: environment });
    expect(vi.mocked(spawn).mock.calls.at(-1)?.[2]?.env).toEqual(environment);
    expect(process.env.SYNTHETIC_ACP_ENV).toBeUndefined();
    client.destroy();
    fake.process.emit('close', 0, null);
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

  it.each(['load', 'config', 'cancel', 'delete', 'close'])('revokes local schedule admission before %s, including failed controls', async action => {
    expect(client.sessionAdmission('synthetic-session')).toBeUndefined();
    const creating = client.newSession(process.cwd());
    fake.process.push({ jsonrpc: '2.0', id: request(fake.lines, 'session/new').id, result: { sessionId: 'synthetic-session' } });
    await creating;
    const identity = client.sessionAdmission('synthetic-session');
    expect(identity).toBeDefined(); expect(client.sessionAdmission('synthetic-session')).toBe(identity);
    let pending: Promise<unknown> | undefined;
    if (action === 'load') pending = client.loadSession('synthetic-session', process.cwd());
    if (action === 'config') pending = client.setConfigOption('synthetic-session', 'model', 'other');
    if (action === 'delete') pending = client.deleteSession('synthetic-session');
    if (action === 'cancel') client.sendCancel('synthetic-session');
    if (action === 'close') fake.process.emit('close', 0, null);
    expect(client.sessionAdmission('synthetic-session')).toBeUndefined();
    if (pending) {
      const sent = JSON.parse(fake.lines.at(-1)!);
      fake.process.push({ jsonrpc: '2.0', id: sent.id, error: { code: -32603, message: 'Synthetic uncertain control' } });
      await expect(pending).rejects.toThrow(); expect(client.sessionAdmission('synthetic-session')).toBeUndefined();
    }
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

  it('times out control requests, ignores late replies, and allows later requests', async () => {
    vi.useFakeTimers();
    try {
      const pending = client.setConfigOption('ses-1', 'model', 'model-a');
      const sent = request(fake.lines, 'session/set_config_option');
      const failed = expect(pending).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(10_001);
      await failed;
      expect((client as any).pendingRequests.size).toBe(0);
      fake.process.push({ jsonrpc: '2.0', id: sent.id, result: { configOptions: [] } });
      const next = client.setConfigOption('ses-1', 'effort', 'low');
      const nextRequest = JSON.parse(fake.lines[fake.lines.length - 1]);
      fake.process.push({ jsonrpc: '2.0', id: nextRequest.id, result: { configOptions: [] } });
      await expect(next).resolves.toMatchObject({ configOptions: [] });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('does not charge the control deadline to a long inference prompt', async () => {
    vi.useFakeTimers();
    try {
      const pending = client.prompt('ses-1', [{ type: 'text', text: 'inspect' }]);
      const sent = request(fake.lines, 'session/prompt');
      await vi.advanceTimersByTimeAsync(30_000);
      expect((client as any).pendingRequests.size).toBe(1);
      fake.process.push({ jsonrpc: '2.0', id: sent.id, result: { stopReason: 'end_turn' } });
      await expect(pending).resolves.toEqual({ stopReason: 'end_turn' });
    } finally { vi.useRealTimers(); }
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

  it('routes singular ACP config option update notifications', async () => {
    fake.process.push({
      jsonrpc: '2.0', method: 'session/update',
      params: {
        sessionId: 'ses-1',
        update: { sessionUpdate: 'config_option_update', configOptions: [{ id: 'thinking', name: 'Thinking', type: 'select' }] },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(callbacks.onConfigOptions).toHaveBeenCalledWith([{ id: 'thinking', name: 'Thinking', type: 'select' }]);
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
    expect(reply.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
  });

  async function requestPermission(id: number, options: any[]): Promise<any> {
    fake.process.push({
      jsonrpc: '2.0', id, method: 'session/request_permission',
      params: { sessionId: 'ses-1', toolCall: { title: 'Run pwd' }, options },
    });
    await new Promise((resolve) => setImmediate(resolve));
    return fake.lines.map((line) => JSON.parse(line)).find((message) => message.id === id)?.result;
  }

  const allow = { kind: 'allow_once', optionId: 'allow', name: 'Allow' };
  const reject = { kind: 'reject_once', optionId: 'reject', name: 'Reject' };

  it.each([[], null, {}, 'invalid'])('cancels absent or malformed permission options: %j', async options => {
    await expect(requestPermission(49, options as any)).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('cancels an allow-first permission request when the callback throws', async () => {
    vi.mocked(callbacks.onPermissionRequest!).mockRejectedValue(new Error('Mobile approval failed'));
    await expect(requestPermission(43, [allow, reject])).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it.each([-1, Number.NaN, 0.5, 2, Number.POSITIVE_INFINITY])(
    'cancels an invalid permission selection instead of defaulting to allow-first: %s',
    async (index) => {
      vi.mocked(callbacks.onPermissionRequest!).mockResolvedValue(index);
      await expect(requestPermission(44, [allow, reject])).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    },
  );

  it('cancels permission requests when no handler is configured', async () => {
    callbacks.onPermissionRequest = undefined;
    await expect(requestPermission(45, [allow])).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('preserves valid allow and reject selections', async () => {
    vi.mocked(callbacks.onPermissionRequest!).mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    await expect(requestPermission(46, [allow, reject])).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    await expect(requestPermission(47, [reject, allow])).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
  });

  it.each([
    [null],
    [{ optionId: 'unknown', name: 'Future option' }],
    [{ kind: 'future_kind', optionId: 'unknown', name: 'Future option' }],
    [{ kind: 'allow_future', optionId: 'unknown', name: 'Future allow option' }],
    [{ kind: 'allow_once', name: 'Missing option ID' }],
    [{ kind: 'allow_once', optionId: '', name: 'Empty option ID' }],
  ])('cancels unknown or malformed selected permission options: %j', async (option) => {
    await expect(requestPermission(48, [option])).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('returns structured ACP errors to callers', async () => {
    const pending = client.setConfigOption('ses-1', 'model', 'missing');
    const sent = request(fake.lines, 'session/set_config_option');
    fake.process.push({ jsonrpc: '2.0', id: sent.id, error: { code: -32602, message: 'invalid model' } });
    await expect(pending).rejects.toThrow('ACP error -32602: invalid model');
  });
});
