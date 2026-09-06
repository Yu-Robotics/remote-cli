import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgyExecutor } from '../../src/executor/AgyExecutor';
import { createExecutor } from '../../src/executor';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { EventEmitter } from 'events';

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

// Mock fs for session file operations
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => '{}'),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => '{}'),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { spawn } from 'child_process';
import * as fs from 'fs';

/**
 * Tests for AgyExecutor — the Antigravity CLI (agy) backend.
 *
 * agy speaks Claude-Code-style stream-json: NDJSON in on stdin
 * ({"event":"user","message":{"content":"..."}}) and NDJSON events out on
 * stdout (init / step_update / result). One persistent process per
 * conversation; resume across processes via `--conversation <id>`.
 *
 * Wire shapes below were captured from a live agy 1.1.9 smoke test.
 */
describe('AgyExecutor', () => {
  let executor: AgyExecutor;
  let directoryGuard: DirectoryGuard;
  const mockSpawn = spawn as any;
  const mockFs = fs as any;

  // The most recently spawned mock process (respawns replace it)
  let proc: any;
  let spawnedProcesses: any[];

  const makeMockProcess = () => {
    const p: any = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    // stdin must be a real EventEmitter so async socket errors (EPIPE) can be tested
    p.stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
    p.kill = vi.fn();
    p.pid = Math.floor(Math.random() * 100000);
    return p;
  };

  const emitJson = (obj: Record<string, unknown>, target?: any) => {
    (target ?? proc).stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n'));
  };

  const emitInit = (conversationId = 'conv-aaa', target?: any) => {
    emitJson({
      event: 'init',
      conversation_id: conversationId,
      init: { cwd: '/home/user/test-project', tools: ['run_command'], permission_mode: 'always-proceed' },
    }, target);
  };

  const emitResult = (overrides: Record<string, unknown> = {}, target?: any) => {
    emitJson({
      event: 'result',
      result: {
        conversation_id: 'conv-aaa',
        status: 'SUCCESS',
        response: 'Done\n',
        duration_seconds: 1,
        num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 1, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 2 },
        ...overrides,
      },
    }, target);
  };

  /** Wait until at least one process has been spawned and the prompt written. */
  const waitForSpawn = async () => {
    for (let i = 0; i < 100 && spawnedProcesses.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => setTimeout(r, 20));
  };

  const lastStdinLine = (target?: any) => {
    const p = target ?? proc;
    const calls = p.stdin.write.mock.calls;
    return calls.length ? JSON.parse(calls[calls.length - 1][0]) : null;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    mockFs.existsSync.mockReturnValue(false);
    mockFs.readFileSync.mockReturnValue('{}');

    spawnedProcesses = [];
    mockSpawn.mockImplementation(() => {
      proc = makeMockProcess();
      spawnedProcesses.push(proc);
      return proc;
    });

    directoryGuard = new DirectoryGuard(['~/test-project', './work']);
    executor = new AgyExecutor(directoryGuard, {
      initialWorkingDirectory: '~/test-project',
      threadId: 'thread-1',
    });
  });

  afterEach(async () => {
    for (const p of spawnedProcesses) {
      p.emit('exit', 0, null);
      p.emit('close', 0, null);
    }
    await executor.destroy();
    vi.clearAllMocks();
  });

  // ── Process spawning ──────────────────────────────────────────────────────

  it('spawns agy with stream-json flags and skip-permissions by default', async () => {
    const p = executor.execute('hello');
    await waitForSpawn();

    const [cmd, args] = mockSpawn.mock.calls[0];
    expect(cmd).toBe('agy');
    expect(args).toContain('--input-format=stream-json');
    expect(args).toContain('--output-format=stream-json');
    expect(args).toContain('--dangerously-skip-permissions');

    emitInit();
    emitResult();
    await p;
  });

  it('omits --dangerously-skip-permissions when autoApprove is false', async () => {
    await executor.destroy();
    executor = new AgyExecutor(directoryGuard, {
      initialWorkingDirectory: '~/test-project',
      threadId: 'thread-1',
      autoApprove: false,
    });

    const p = executor.execute('hello');
    await waitForSpawn();

    const args = mockSpawn.mock.calls[0][1];
    expect(args).not.toContain('--dangerously-skip-permissions');

    emitInit();
    emitResult();
    await p;
  });

  it('passes --model when configured', async () => {
    await executor.destroy();
    executor = new AgyExecutor(directoryGuard, {
      initialWorkingDirectory: '~/test-project',
      threadId: 'thread-1',
      model: 'gemini-3-pro',
    });

    const p = executor.execute('hello');
    await waitForSpawn();

    const args = mockSpawn.mock.calls[0][1];
    const idx = args.indexOf('--model');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('gemini-3-pro');

    emitInit();
    emitResult();
    await p;
  });

  it('spawns in the configured working directory', async () => {
    const p = executor.execute('hello');
    await waitForSpawn();

    expect(mockSpawn.mock.calls[0][2].cwd).toBe(directoryGuard.resolveWorkingDirectory('~/test-project'));

    emitInit();
    emitResult();
    await p;
  });

  // ── Prompt sending ────────────────────────────────────────────────────────

  it('sends the prompt as an NDJSON user event on stdin', async () => {
    const p = executor.execute('fix the bug');
    await waitForSpawn();

    expect(lastStdinLine()).toEqual({
      event: 'user',
      message: { content: 'fix the bug' },
    });

    emitInit();
    emitResult();
    await p;
  });

  it('sends only text when attachments are present (agy stream-json supports text blocks only)', async () => {
    const p = executor.execute('look at this', {
      attachments: [{ type: 'image', data: 'base64data', mimeType: 'image/png' } as any],
    });
    await waitForSpawn();

    const line = lastStdinLine();
    expect(line.event).toBe('user');
    expect(line.message.content).toBe('look at this');

    emitInit();
    emitResult();
    await p;
  });

  // ── Streaming and completion ──────────────────────────────────────────────

  it('streams agent_response text_delta chunks and resolves accumulated output on result SUCCESS', async () => {
    const chunks: string[] = [];
    const p = executor.execute('say hi', { onStream: (c) => chunks.push(c) });
    await waitForSpawn();
    emitInit();

    emitJson({ event: 'step_update', step_update: { conversation_id: 'conv-aaa', step_index: 0, state: 'DONE', step_type: 'user_input' } });
    emitJson({ event: 'step_update', step_update: { conversation_id: 'conv-aaa', step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Hello' } });
    emitJson({ event: 'step_update', step_update: { conversation_id: 'conv-aaa', step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: ' world\n' } });

    // Not resolved until result arrives
    let resolved = false;
    p.then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 30));
    expect(resolved).toBe(false);

    emitResult({ response: 'Hello world\n' });
    const result = await p;

    expect(chunks).toEqual(['Hello', ' world\n']);
    expect(result.success).toBe(true);
    expect(result.output).toBe('Hello world\n');
    expect(result.sessionAbbr).toBe('conv-aaa'.slice(0, 8));
  });

  it('emits onToolUse on tool step ACTIVE and onToolResult on DONE, mapping run_command to Bash', async () => {
    const toolUses: any[] = [];
    const toolResults: any[] = [];
    const p = executor.execute('run echo', {
      onToolUse: (t) => toolUses.push(t),
      onToolResult: (r) => toolResults.push(r),
    });
    await waitForSpawn();
    emitInit();

    emitJson({
      event: 'step_update',
      step_update: {
        conversation_id: 'conv-aaa', step_index: 2, state: 'ACTIVE', step_type: 'tool',
        tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'echo HELLO' } },
      },
    });
    emitJson({
      event: 'step_update',
      step_update: {
        conversation_id: 'conv-aaa', step_index: 2, state: 'DONE', step_type: 'tool',
        tool_name: 'run_command', duration_seconds: 0.02,
        tool_info: { name: 'run_command', parameters: { CommandLine: 'echo HELLO' }, output: 'HELLO\r\n' },
      },
    });
    emitResult();

    await p;

    expect(toolUses).toHaveLength(1);
    expect(toolUses[0]).toEqual({ id: 'agy-step-2', name: 'Bash', input: { command: 'echo HELLO' } });
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toEqual({ tool_use_id: 'agy-step-2', content: 'HELLO\r\n', is_error: false });
  });

  it('marks tool result as error when tool_info contains an error object', async () => {
    const toolResults: any[] = [];
    const p = executor.execute('run bad', { onToolResult: (r) => toolResults.push(r) });
    await waitForSpawn();
    emitInit();

    emitJson({
      event: 'step_update',
      step_update: {
        conversation_id: 'conv-aaa', step_index: 2, state: 'DONE', step_type: 'tool',
        tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'bad' }, error: { message: 'exit 127' } },
      },
    });
    emitResult();
    await p;

    expect(toolResults[0].is_error).toBe(true);
  });

  it('passes unknown tool names through unchanged', async () => {
    const toolUses: any[] = [];
    const p = executor.execute('browse', { onToolUse: (t) => toolUses.push(t) });
    await waitForSpawn();
    emitInit();

    emitJson({
      event: 'step_update',
      step_update: {
        conversation_id: 'conv-aaa', step_index: 1, state: 'ACTIVE', step_type: 'tool',
        tool_name: 'browser_click_element', tool_info: { name: 'browser_click_element', parameters: { Selector: '#btn' } },
      },
    });
    emitResult();
    await p;

    expect(toolUses[0].name).toBe('browser_click_element');
    expect(toolUses[0].input).toEqual({ Selector: '#btn' });
  });

  // ── Result status mapping ─────────────────────────────────────────────────

  it('resolves success=false with the error message on result status ERROR', async () => {
    const p = executor.execute('boom');
    await waitForSpawn();
    emitInit();
    emitResult({ status: 'ERROR', response: '', error: 'authentication failed or timed out' });

    const result = await p;
    expect(result.success).toBe(false);
    expect(result.error).toContain('authentication failed');
  });

  it('resolves success=false on INTERRUPTED status', async () => {
    const p = executor.execute('long task');
    await waitForSpawn();
    emitInit();
    emitResult({ status: 'INTERRUPTED', response: '' });

    const result = await p;
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  // ── Conversation persistence and resume ───────────────────────────────────

  it('saves conversation_id from init to the per-thread session file', async () => {
    const p = executor.execute('hi');
    await waitForSpawn();
    emitInit('conv-xyz-789');
    emitResult({ conversation_id: 'conv-xyz-789' });
    await p;

    expect(mockFs.writeFileSync).toHaveBeenCalled();
    const [filePath, data] = mockFs.writeFileSync.mock.calls[0];
    expect(String(filePath)).toContain('agy-sessions');
    expect(String(filePath)).toContain('thread-1');
    expect(JSON.parse(data).id).toBe('conv-xyz-789');
    expect(executor.getSessionId()).toBe('conv-xyz-789');
  });

  it('loads persisted conversation id on construction and resumes with --conversation', async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ id: 'conv-stored' }));

    await executor.destroy();
    executor = new AgyExecutor(directoryGuard, {
      initialWorkingDirectory: '~/test-project',
      threadId: 'thread-1',
    });

    const p = executor.execute('continue please');
    await waitForSpawn();

    const args = mockSpawn.mock.calls[0][1];
    const idx = args.indexOf('--conversation');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('conv-stored');

    emitInit('conv-stored');
    emitResult({ conversation_id: 'conv-stored' });
    await p;
  });

  it('uses legacy session file in working directory when no threadId is given', async () => {
    await executor.destroy();
    executor = new AgyExecutor(directoryGuard, {
      initialWorkingDirectory: '~/test-project',
    });

    const p = executor.execute('hi');
    await waitForSpawn();
    emitInit('conv-legacy');
    emitResult({ conversation_id: 'conv-legacy' });
    await p;

    const [filePath] = mockFs.writeFileSync.mock.calls[0];
    expect(String(filePath)).toContain('.agy-session');
  });

  // ── Queueing ──────────────────────────────────────────────────────────────

  it('runs commands sequentially — second prompt is not written until first result arrives', async () => {
    const p1 = executor.execute('first');
    await waitForSpawn();
    emitInit();

    const p2 = executor.execute('second');
    await new Promise((r) => setTimeout(r, 50));

    // Only one prompt written so far
    expect(proc.stdin.write.mock.calls).toHaveLength(1);

    emitResult();
    await p1;

    await new Promise((r) => setTimeout(r, 50));
    expect(proc.stdin.write.mock.calls).toHaveLength(2);
    expect(lastStdinLine().message.content).toBe('second');

    emitResult();
    await p2;
  });

  // ── Working directory ─────────────────────────────────────────────────────

  it('setWorkingDirectory to the same directory is a no-op (no respawn)', async () => {
    const p = executor.execute('hi');
    await waitForSpawn();
    emitInit();
    emitResult();
    await p;

    const procsBefore = spawnedProcesses.length;
    await executor.setWorkingDirectory('~/test-project');
    expect(spawnedProcesses.length).toBe(procsBefore);
  });

  it('setWorkingDirectory to a new directory kills the process; next execute respawns there and resumes the conversation', async () => {
    const p = executor.execute('hi');
    await waitForSpawn();
    emitInit('conv-keep');
    emitResult({ conversation_id: 'conv-keep' });
    await p;

    const oldProc = proc;
    await executor.setWorkingDirectory('./work');
    expect(oldProc.kill).toHaveBeenCalled();

    const p2 = executor.execute('after move');
    await waitForSpawn();
    expect(spawnedProcesses.length).toBe(2);
    const [_, args, opts] = mockSpawn.mock.calls[1];
    expect(opts.cwd).toBe(directoryGuard.resolveWorkingDirectory('./work'));
    expect(args).toContain('--conversation');
    expect(args[args.indexOf('--conversation') + 1]).toBe('conv-keep');

    emitInit('conv-keep');
    emitResult({ conversation_id: 'conv-keep' });
    await p2;
  });

  it('setWorkingDirectory rejects paths outside the whitelist', async () => {
    await expect(executor.setWorkingDirectory('/etc/passwd')).rejects.toThrow();
  });

  // ── resetContext / compact ────────────────────────────────────────────────

  it('resetContext kills the process and clears the conversation id (fresh session next time)', async () => {
    const p = executor.execute('hi');
    await waitForSpawn();
    emitInit('conv-old');
    emitResult({ conversation_id: 'conv-old' });
    await p;
    expect(executor.getSessionId()).toBe('conv-old');

    executor.resetContext();
    expect(executor.getSessionId()).toBeNull();

    const p2 = executor.execute('fresh');
    await waitForSpawn();
    const args = mockSpawn.mock.calls[1][1];
    expect(args).not.toContain('--conversation');

    emitInit('conv-new');
    emitResult({ conversation_id: 'conv-new' });
    await p2;
  });

  it('compactWhenFull summarizes, resets, and carries the summary into the next command only', async () => {
    const p = executor.execute('hi');
    await waitForSpawn();
    emitInit('conv-old');
    emitResult({ conversation_id: 'conv-old' });
    await p;

    const chunks: string[] = [];
    const compactPromise = executor.compactWhenFull((c) => chunks.push(c));
    await new Promise((r) => setTimeout(r, 50));

    // A handoff-summary turn runs on the same process before the reset
    expect(lastStdinLine().message.content).toContain('CONTEXT HANDOFF REQUEST');
    emitJson({ event: 'step_update', step_update: { conversation_id: 'conv-old', step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'SUMMARY: discussed the frobnicate bug' } });
    emitResult({ conversation_id: 'conv-old', response: 'SUMMARY: discussed the frobnicate bug' });

    const result = await compactPromise;
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/summar/i);
    expect(executor.getSessionId()).toBeNull(); // conversation reset
    expect(chunks.join('')).toContain('SUMMARY: discussed the frobnicate bug'); // summary streamed

    // The next command respawns fresh (no --conversation) with the summary seeded
    const p2 = executor.execute('continue the fix');
    await waitForSpawn();
    expect(spawnedProcesses.length).toBe(2);
    expect(mockSpawn.mock.calls[1][1]).not.toContain('--conversation');
    const seeded = lastStdinLine().message.content;
    expect(seeded).toContain('SUMMARY: discussed the frobnicate bug');
    expect(seeded).toContain('background context, not new instructions');
    expect(seeded).toContain('continue the fix');
    emitInit('conv-new');
    emitResult({ conversation_id: 'conv-new' });
    await p2;

    // The seed is consumed — the command after that is clean
    const p3 = executor.execute('plain prompt');
    await new Promise((r) => setTimeout(r, 50));
    expect(lastStdinLine().message.content).toBe('plain prompt');
    emitResult({ conversation_id: 'conv-new' });
    await p3;
  });

  it('compactWhenFull falls back to a plain reset with an honest warning when the summary turn fails', async () => {
    const p = executor.execute('hi');
    await waitForSpawn();
    emitInit('conv-old');
    emitResult({ conversation_id: 'conv-old' });
    await p;

    const compactPromise = executor.compactWhenFull();
    await new Promise((r) => setTimeout(r, 50));
    // Summary turn fails (e.g. context already too full)
    emitResult({ conversation_id: 'conv-old', status: 'ERROR', response: '', error: 'context too long' });

    const result = await compactPromise;
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/without carryover|reset/i);
    expect(executor.getSessionId()).toBeNull();

    // No seed — the next prompt goes through unmodified
    const p2 = executor.execute('clean start');
    await waitForSpawn();
    expect(lastStdinLine().message.content).toBe('clean start');
    emitInit('conv-new');
    emitResult({ conversation_id: 'conv-new' });
    await p2;
  });

  it('resetContext discards a pending handoff seed (/clear means a real fresh start)', async () => {
    const p = executor.execute('hi');
    await waitForSpawn();
    emitInit('conv-old');
    emitResult({ conversation_id: 'conv-old' });
    await p;

    const compactPromise = executor.compactWhenFull();
    await new Promise((r) => setTimeout(r, 50));
    emitResult({ conversation_id: 'conv-old', response: 'SUMMARY: stuff' });
    await compactPromise;

    // User clears before sending another message
    executor.resetContext();

    const p2 = executor.execute('fresh');
    await waitForSpawn();
    expect(lastStdinLine().message.content).toBe('fresh');
    emitInit('conv-new2');
    emitResult({ conversation_id: 'conv-new2' });
    await p2;
  });

  // ── Abort ─────────────────────────────────────────────────────────────────

  it('abort returns false when nothing is running', async () => {
    expect(await executor.abort()).toBe(false);
  });

  it('abort kills the process and resolves the in-flight command as aborted', async () => {
    const p = executor.execute('long running');
    await waitForSpawn();
    emitInit();

    const running = proc;
    const aborted = await executor.abort();
    expect(aborted).toBe(true);
    expect(running.kill).toHaveBeenCalled();

    const result = await p;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/abort/i);
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  it('destroy ends stdin and kills the process', async () => {
    const p = executor.execute('hi');
    await waitForSpawn();
    emitInit();
    emitResult();
    await p;

    const running = proc;
    await executor.destroy();
    expect(running.stdin.end).toHaveBeenCalled();
    expect(running.kill).toHaveBeenCalled();
    expect(executor.isProcessRunning()).toBe(false);
  });

  it('deleteThreadData removes the session file', async () => {
    const p = executor.execute('hi');
    await waitForSpawn();
    emitInit();
    emitResult();
    await p;

    mockFs.existsSync.mockReturnValue(true);
    await executor.deleteThreadData('thread-1');
    expect(mockFs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining('thread-1'));
  });

  // ── Robustness ────────────────────────────────────────────────────────────

  it('ignores unknown events and step types without breaking the command', async () => {
    const p = executor.execute('hi');
    await waitForSpawn();
    emitInit();

    emitJson({ event: 'some_future_event', data: {} });
    emitJson({ event: 'step_update', step_update: { conversation_id: 'conv-aaa', step_index: 1, state: 'DONE', step_type: 'system_message' } });
    emitJson({ event: 'step_update', step_update: { conversation_id: 'conv-aaa', step_index: 2, state: 'DONE', step_type: 'checkpoint' } });
    emitJson({ event: 'step_update', step_update: { conversation_id: 'conv-aaa', step_index: 3, state: 'DONE', step_type: 'agent_response' } }); // no text_delta

    emitResult();
    const result = await p;
    expect(result.success).toBe(true);
  });

  it('tolerates malformed NDJSON lines', async () => {
    const p = executor.execute('hi');
    await waitForSpawn();
    emitInit();

    proc.stdout.emit('data', Buffer.from('this is not json\n'));
    proc.stdout.emit('data', Buffer.from('{"event":"result"')); // split across chunks
    proc.stdout.emit('data', Buffer.from(',"result":{"conversation_id":"conv-aaa","status":"SUCCESS","response":"ok","duration_seconds":1,"num_turns":1,"usage":{}}}\n'));

    const result = await p;
    expect(result.success).toBe(true);
  });

  it('fails the command with a friendly error when agy is not installed (spawn error)', async () => {
    const p = executor.execute('hi');
    await waitForSpawn();

    proc.emit('error', new Error('spawn agy ENOENT'));

    const result = await p;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not installed|not found/i);
  });

  it('fails the in-flight command when the process exits unexpectedly', async () => {
    const p = executor.execute('hi');
    await waitForSpawn();
    emitInit();

    proc.emit('exit', 1, null);
    proc.emit('close', 1, null);

    const result = await p;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/exited/i);
  });

  it('respawns on the next execute after an unexpected exit, resuming the conversation', async () => {
    const p = executor.execute('hi');
    await waitForSpawn();
    emitInit('conv-crash');
    proc.emit('exit', 1, null);
    proc.emit('close', 1, null);
    await p;

    const p2 = executor.execute('again');
    await waitForSpawn();
    expect(spawnedProcesses.length).toBe(2);
    const args = mockSpawn.mock.calls[1][1];
    expect(args[args.indexOf('--conversation') + 1]).toBe('conv-crash');

    emitInit('conv-crash');
    emitResult({ conversation_id: 'conv-crash' });
    const r2 = await p2;
    expect(r2.success).toBe(true);
  });

  // ── Lifecycle hardening ─────────────────────────────────────────────────

  it('destroy rejects queued commands and never respawns', async () => {
    const p1 = executor.execute('first');
    await waitForSpawn();
    emitInit();

    const p2 = executor.execute('second'); // queued behind first
    await new Promise((r) => setTimeout(r, 30));

    const spawnsBefore = spawnedProcesses.length;
    await executor.destroy();

    const r1 = await p1;
    expect(r1.success).toBe(false);
    await expect(p2).rejects.toThrow(/destroyed/i);

    // No respawn after destroy
    await new Promise((r) => setTimeout(r, 100));
    expect(spawnedProcesses.length).toBe(spawnsBefore);
  });

  it('execute after destroy rejects immediately', async () => {
    await executor.destroy();
    await expect(executor.execute('late')).rejects.toThrow(/destroyed/i);
    expect(spawnedProcesses.length).toBe(0);
  });

  it('destroy is idempotent', async () => {
    await executor.destroy();
    await executor.destroy();
  });

  it('ignores async stdin errors (EPIPE) without crashing or hanging the command', async () => {
    const p = executor.execute('hi');
    await waitForSpawn();
    emitInit();

    // Simulate EPIPE arriving asynchronously on the stdin socket
    proc.stdin.emit('error', new Error('write EPIPE'));

    emitResult();
    const result = await p;
    expect(result.success).toBe(true);
  });

  it('fails the command after the inactivity timeout and kills the process', async () => {
    await executor.destroy();
    executor = new AgyExecutor(directoryGuard, {
      initialWorkingDirectory: '~/test-project',
      threadId: 'thread-1',
      inactivityTimeoutMs: 150,
    });

    const p = executor.execute('hang forever');
    await waitForSpawn();
    emitInit();

    // Silence for > 150ms
    await new Promise((r) => setTimeout(r, 400));

    const result = await p;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/inactiv/i);
    expect(proc.kill).toHaveBeenCalled();
  });

  it('inactivity timer resets on each stdout line', async () => {
    await executor.destroy();
    executor = new AgyExecutor(directoryGuard, {
      initialWorkingDirectory: '~/test-project',
      threadId: 'thread-1',
      inactivityTimeoutMs: 150,
    });

    const chunks: string[] = [];
    const p = executor.execute('slow but alive', { onStream: (c) => chunks.push(c) });
    await waitForSpawn();
    emitInit();

    // Activity every 100ms for 350ms total — exceeds 150ms timeout if it didn't reset
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 100));
      emitJson({ event: 'step_update', step_update: { conversation_id: 'conv-aaa', step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: `chunk${i} ` } });
    }
    emitResult();
    const result = await p;
    expect(result.success).toBe(true);
    expect(result.output).toBe('chunk0 chunk1 chunk2 ');
  });

  it('escalates to SIGKILL when the process ignores SIGTERM', async () => {
    await executor.destroy();
    executor = new AgyExecutor(directoryGuard, {
      initialWorkingDirectory: '~/test-project',
      threadId: 'thread-1',
      killEscalationMs: 30,
    });

    const p = executor.execute('stubborn');
    await waitForSpawn();
    emitInit();

    await executor.abort();
    const killCalls = proc.kill.mock.calls;
    expect(killCalls.length).toBe(1); // SIGTERM (default signal)

    await new Promise((r) => setTimeout(r, 100));
    expect(proc.kill.mock.calls.length).toBe(2);
    expect(proc.kill.mock.calls[1][0]).toBe('SIGKILL');

    await p;
    proc.emit('exit', null, 'SIGKILL');
  });

  it('does not SIGKILL when the process exits promptly after SIGTERM', async () => {
    await executor.destroy();
    executor = new AgyExecutor(directoryGuard, {
      initialWorkingDirectory: '~/test-project',
      threadId: 'thread-1',
      killEscalationMs: 30,
    });

    const p = executor.execute('cooperative');
    await waitForSpawn();
    emitInit();

    await executor.abort();
    proc.emit('exit', 0, null); // exits promptly

    await new Promise((r) => setTimeout(r, 100));
    expect(proc.kill.mock.calls.length).toBe(1);

    await p;
  });

  it('handles multi-byte UTF-8 characters split across stdout chunks', async () => {
    const chunks: string[] = [];
    const p = executor.execute('say hello in Chinese', { onStream: (c) => chunks.push(c) });
    await waitForSpawn();
    emitInit();

    const line = JSON.stringify({
      event: 'step_update',
      step_update: { conversation_id: 'conv-aaa', step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: '你好' },
    }) + '\n';
    const buf = Buffer.from(line, 'utf8');
    // Split inside the first multi-byte character (你 = 0xE4 0xBD 0xA0)
    const splitAt = buf.indexOf(0xe4) + 1;
    proc.stdout.emit('data', buf.subarray(0, splitAt));
    proc.stdout.emit('data', buf.subarray(splitAt));

    emitResult();
    const result = await p;
    expect(result.success).toBe(true);
    expect(chunks.join('')).toContain('你好');
  });

  // ── setModel ────────────────────────────────────────────────────────────

  it('setModel kills the idle process so the next command respawns with --model, preserving the conversation', async () => {
    const p1 = executor.execute('hi');
    await waitForSpawn();
    expect(mockSpawn.mock.calls[0][1]).not.toContain('--model');
    emitInit('conv-keep');
    emitResult({ conversation_id: 'conv-keep' });
    await p1;

    const r = await executor.setModel('gemini-3.8-flash-low');
    expect(r.success).toBe(true);
    expect(proc.kill).toHaveBeenCalled(); // idle process restarted for the model change

    const p2 = executor.execute('after model switch');
    await waitForSpawn();
    expect(spawnedProcesses.length).toBe(2);
    const args = mockSpawn.mock.calls[1][1];
    expect(args[args.indexOf('--model') + 1]).toBe('gemini-3.8-flash-low');
    // Conversation survives the model switch
    expect(args[args.indexOf('--conversation') + 1]).toBe('conv-keep');

    emitInit('conv-keep');
    emitResult({ conversation_id: 'conv-keep' });
    await p2;
  });

  it('setModel while a command is running defers the respawn until the command finishes', async () => {
    const p = executor.execute('running');
    await waitForSpawn();
    emitInit('conv-keep');

    const r = await executor.setModel('gemini-3.8-flash-low');
    expect(r.success).toBe(true);
    expect(proc.kill).not.toHaveBeenCalled(); // running command is not disturbed

    emitResult({ conversation_id: 'conv-keep' });
    await p;

    // After the command finishes, the process is recycled for the model change
    expect(proc.kill).toHaveBeenCalled();

    const p2 = executor.execute('next');
    await waitForSpawn();
    const args = mockSpawn.mock.calls[1][1];
    expect(args[args.indexOf('--model') + 1]).toBe('gemini-3.8-flash-low');

    emitInit('conv-keep');
    emitResult({ conversation_id: 'conv-keep' });
    await p2;
  });
});

describe('createExecutor factory - agy backend', () => {
  const mockSpawn = spawn as any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockSpawn.mockReturnValue(makeFactoryMockProcess());
  });

  const makeFactoryMockProcess = () => {
    const p: any = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.stdin = { write: vi.fn(), end: vi.fn() };
    p.kill = vi.fn();
    return p;
  };

  it('creates an AgyExecutor for type "agy"', async () => {
    const guard = new DirectoryGuard(['~/test-project']);
    const executor = createExecutor(guard, { type: 'agy' }, '~/test-project', 'thread-x');
    expect(executor).toBeInstanceOf(AgyExecutor);
    await executor.destroy();
  });

  it('maps legacy type "gemini" to the AGY backend (index slot migration)', async () => {
    const guard = new DirectoryGuard(['~/test-project']);
    const executor = createExecutor(guard, { type: 'gemini' } as any, '~/test-project', 'thread-x');
    expect(executor).toBeInstanceOf(AgyExecutor);
    await executor.destroy();
  });

  it('reads legacy executor.gemini.model as a fallback for agy.model', async () => {
    const guard = new DirectoryGuard(['~/test-project']);
    const executor = createExecutor(
      guard,
      { type: 'gemini', gemini: { model: 'legacy-model' } } as any,
      '~/test-project',
      'thread-x'
    ) as AgyExecutor;

    const p = executor.execute('hi');
    for (let i = 0; i < 100 && mockSpawn.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const args = mockSpawn.mock.calls[0][1];
    expect(args[args.indexOf('--model') + 1]).toBe('legacy-model');

    // Cleanup: finish the command and destroy
    const proc = mockSpawn.mock.results[0].value;
    proc.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: 'c1', init: {} }) + '\n'));
    proc.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: '', duration_seconds: 0, num_turns: 1, usage: {} } }) + '\n'));
    await p;
    await executor.destroy();
  });

  it('agy case also falls back to legacy gemini.model (config switched type before migrating fields)', async () => {
    const guard = new DirectoryGuard(['~/test-project']);
    const executor = createExecutor(
      guard,
      { type: 'agy', gemini: { model: 'legacy-model-2' } } as any,
      '~/test-project',
      'thread-x'
    ) as AgyExecutor;

    const p = executor.execute('hi');
    for (let i = 0; i < 100 && mockSpawn.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const args = mockSpawn.mock.calls[0][1];
    expect(args[args.indexOf('--model') + 1]).toBe('legacy-model-2');

    const proc = mockSpawn.mock.results[0].value;
    proc.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: 'c2', init: {} }) + '\n'));
    proc.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'result', result: { conversation_id: 'c2', status: 'SUCCESS', response: '', duration_seconds: 0, num_turns: 1, usage: {} } }) + '\n'));
    await p;
    await executor.destroy();
  });

  it('per-thread model (from /model) takes precedence over executor.agy.model', async () => {
    const guard = new DirectoryGuard(['~/test-project']);
    const executor = createExecutor(
      guard,
      { type: 'agy', agy: { model: 'config-model' } },
      '~/test-project',
      'thread-x',
      'thread-model'
    ) as AgyExecutor;

    const p = executor.execute('hi');
    for (let i = 0; i < 100 && mockSpawn.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const args = mockSpawn.mock.calls[0][1];
    expect(args[args.indexOf('--model') + 1]).toBe('thread-model');

    const proc = mockSpawn.mock.results[0].value;
    proc.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'init', conversation_id: 'c3', init: {} }) + '\n'));
    proc.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'result', result: { conversation_id: 'c3', status: 'SUCCESS', response: '', duration_seconds: 0, num_turns: 1, usage: {} } }) + '\n'));
    await p;
    await executor.destroy();
  });
});
