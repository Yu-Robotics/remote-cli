import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CodexExecutor } from '../../src/executor/CodexExecutor';
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
 * Tests for CodexExecutor — the OpenAI Codex CLI backend (exec mode).
 *
 * CodexExecutor is one-shot per command: each execute() spawns
 * `codex exec --json --skip-git-repo-check ... "<prompt>"` (or
 * `codex exec resume ... <thread_id> "<prompt>"` once a thread id exists),
 * ends stdin immediately (codex reads piped stdin to EOF), streams NDJSON
 * events from stdout, and resolves when the process exits.
 *
 * Wire shapes below were captured from a live codex-cli 0.153.4 smoke test:
 *   thread.started {thread_id}
 *   turn.started
 *   item.started / item.completed {item:{id,type,...}}
 *     types: agent_message{text}, command_execution{command,aggregated_output,exit_code,status},
 *            file_change{changes:[{path,kind}],status}, error{message}, reasoning
 *   turn.completed {usage}
 *   turn.failed {error:{message}}
 *   error {message}
 */
describe('CodexExecutor', () => {
  let executor: CodexExecutor;
  let directoryGuard: DirectoryGuard;
  const mockSpawn = spawn as any;
  const mockFs = fs as any;

  // The most recently spawned mock process (each command spawns a new one)
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

  const emitThreadStarted = (threadId = 'thread-aaa', target?: any) => {
    emitJson({ type: 'thread.started', thread_id: threadId }, target);
  };

  const emitTurnStarted = (target?: any) => {
    emitJson({ type: 'turn.started' }, target);
  };

  const emitAgentMessage = (text: string, id = 'item_1', target?: any) => {
    emitJson({ type: 'item.completed', item: { id, type: 'agent_message', text } }, target);
  };

  const emitTurnCompleted = (target?: any) => {
    emitJson({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }, target);
  };

  /** Normal successful shutdown: turn.completed, then exit + close (code 0).
   *  Resolution happens on 'close' — stdio is only guaranteed flushed then. */
  const emitSuccessAndExit = (target?: any) => {
    emitTurnCompleted(target);
    const p = target ?? proc;
    p.emit('exit', 0, null);
    p.emit('close', 0, null);
  };

  /** Wait until at least one process has been spawned. */
  const waitForSpawn = async (minCount = 1) => {
    for (let i = 0; i < 100 && spawnedProcesses.length < minCount; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => setTimeout(r, 20));
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
    executor = new CodexExecutor(directoryGuard, {
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

  it('spawns codex exec with json flags and bypass by default, ending stdin immediately', async () => {
    const p = executor.execute('hello');
    await waitForSpawn();

    const [cmd, args] = mockSpawn.mock.calls[0];
    expect(cmd).toBe('codex');
    expect(args[0]).toBe('exec');
    expect(args).toContain('--json');
    expect(args).toContain('--skip-git-repo-check');
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    // Prompt is the last positional argument
    expect(args[args.length - 1]).toBe('hello');
    // stdin must be closed so codex does not wait for piped input
    expect(proc.stdin.end).toHaveBeenCalled();

    emitThreadStarted();
    emitTurnStarted();
    emitSuccessAndExit();
    await p;
  });

  it('omits --dangerously-bypass-approvals-and-sandbox when autoApprove is false', async () => {
    await executor.destroy();
    executor = new CodexExecutor(directoryGuard, {
      initialWorkingDirectory: '~/test-project',
      threadId: 'thread-1',
      autoApprove: false,
    });

    const p = executor.execute('hello');
    await waitForSpawn();

    const args = mockSpawn.mock.calls[0][1];
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');

    emitThreadStarted();
    emitSuccessAndExit();
    await p;
  });

  it('passes -m when a model is configured', async () => {
    await executor.destroy();
    executor = new CodexExecutor(directoryGuard, {
      initialWorkingDirectory: '~/test-project',
      threadId: 'thread-1',
      model: 'gpt-5.2-codex',
    });

    const p = executor.execute('hello');
    await waitForSpawn();

    const args = mockSpawn.mock.calls[0][1];
    const idx = args.indexOf('-m');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('gpt-5.2-codex');

    emitThreadStarted();
    emitSuccessAndExit();
    await p;
  });

  it('spawns in the configured working directory', async () => {
    const p = executor.execute('hello');
    await waitForSpawn();

    expect(mockSpawn.mock.calls[0][2].cwd).toBe(directoryGuard.resolveWorkingDirectory('~/test-project'));

    emitThreadStarted();
    emitSuccessAndExit();
    await p;
  });

  // ── Streaming and completion ──────────────────────────────────────────────

  it('streams agent_message text and resolves accumulated output on turn.completed + exit', async () => {
    const chunks: string[] = [];
    const p = executor.execute('say hi', { onStream: (c) => chunks.push(c) });
    await waitForSpawn();
    emitThreadStarted();
    emitTurnStarted();

    emitAgentMessage('Hello', 'item_1');
    emitAgentMessage(' world', 'item_2');

    // Not resolved on turn.completed alone, and not on 'exit' either —
    // stdio is only guaranteed flushed on 'close'
    emitTurnCompleted();
    let resolved = false;
    p.then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 30));
    expect(resolved).toBe(false);

    proc.emit('exit', 0, null);
    await new Promise((r) => setTimeout(r, 30));
    expect(resolved).toBe(false);

    proc.emit('close', 0, null);
    const result = await p;

    expect(chunks).toEqual(['Hello', ' world']);
    expect(result.success).toBe(true);
    expect(result.output).toBe('Hello world');
    expect(result.sessionAbbr).toBe('thread-aaa'.slice(0, 8));
  });

  it('emits onToolUse on command_execution item.started and onToolResult on item.completed', async () => {
    const toolUses: any[] = [];
    const toolResults: any[] = [];
    const p = executor.execute('run echo', {
      onToolUse: (t) => toolUses.push(t),
      onToolResult: (r) => toolResults.push(r),
    });
    await waitForSpawn();
    emitThreadStarted();
    emitTurnStarted();

    emitJson({
      type: 'item.started',
      item: { id: 'item_1', type: 'command_execution', command: '/bin/bash -lc "echo HELLO"', aggregated_output: '', exit_code: null, status: 'in_progress' },
    });
    emitJson({
      type: 'item.completed',
      item: { id: 'item_1', type: 'command_execution', command: '/bin/bash -lc "echo HELLO"', aggregated_output: 'HELLO\n', exit_code: 0, status: 'completed' },
    });
    emitSuccessAndExit();

    await p;

    expect(toolUses).toHaveLength(1);
    expect(toolUses[0]).toEqual({ id: 'item_1', name: 'Bash', input: { command: '/bin/bash -lc "echo HELLO"' } });
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toEqual({ tool_use_id: 'item_1', content: 'HELLO\n', is_error: false });
  });

  it('marks command_execution tool result as error when exit_code is non-zero', async () => {
    const toolResults: any[] = [];
    const p = executor.execute('run bad', { onToolResult: (r) => toolResults.push(r) });
    await waitForSpawn();
    emitThreadStarted();
    emitTurnStarted();

    emitJson({
      type: 'item.completed',
      item: { id: 'item_1', type: 'command_execution', command: 'bad', aggregated_output: 'command not found', exit_code: 127, status: 'completed' },
    });
    emitSuccessAndExit();
    await p;

    expect(toolResults[0].is_error).toBe(true);
  });

  it('marks command_execution tool result as error when status is failed', async () => {
    const toolResults: any[] = [];
    const p = executor.execute('run bad', { onToolResult: (r) => toolResults.push(r) });
    await waitForSpawn();
    emitThreadStarted();
    emitTurnStarted();

    emitJson({
      type: 'item.completed',
      item: { id: 'item_1', type: 'command_execution', command: 'bad', aggregated_output: '', exit_code: null, status: 'failed' },
    });
    emitSuccessAndExit();
    await p;

    expect(toolResults[0].is_error).toBe(true);
  });

  it('renders file_change items as an Edit tool card with the changed path', async () => {
    const toolUses: any[] = [];
    const toolResults: any[] = [];
    const p = executor.execute('create a file', {
      onToolUse: (t) => toolUses.push(t),
      onToolResult: (r) => toolResults.push(r),
    });
    await waitForSpawn();
    emitThreadStarted();
    emitTurnStarted();

    emitJson({
      type: 'item.completed',
      item: { id: 'item_1', type: 'file_change', changes: [{ path: '/tmp/x/patch-test.txt', kind: 'add' }], status: 'completed' },
    });
    emitSuccessAndExit();
    await p;

    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe('Edit');
    expect(toolUses[0].input).toEqual({ file_path: '/tmp/x/patch-test.txt' });
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0].tool_use_id).toBe('item_1');
    expect(toolResults[0].is_error).toBe(false);
  });

  it('renders web_search items as a WebSearch tool card', async () => {
    const toolUses: any[] = [];
    const p = executor.execute('search the web', { onToolUse: (t) => toolUses.push(t) });
    await waitForSpawn();
    emitThreadStarted();
    emitTurnStarted();

    emitJson({
      type: 'item.completed',
      item: { id: 'item_1', type: 'web_search', query: 'latest codex cli version' },
    });
    emitSuccessAndExit();
    await p;

    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe('WebSearch');
    expect(toolUses[0].input).toEqual({ query: 'latest codex cli version' });
  });

  it('treats item type error as non-fatal (metadata fallback warnings etc.)', async () => {
    const p = executor.execute('hi');
    await waitForSpawn();
    emitThreadStarted();

    emitJson({
      type: 'item.completed',
      item: { id: 'item_0', type: 'error', message: 'Model metadata for `openai/gpt-5.2-codex` not found. Defaulting to fallback metadata.' },
    });
    emitTurnStarted();
    emitAgentMessage('ok');
    emitSuccessAndExit();

    const result = await p;
    expect(result.success).toBe(true);
  });

  it('streams reasoning summaries as thinking text without polluting the final output', async () => {
    const chunks: string[] = [];
    const p = executor.execute('think', { onStream: (c) => chunks.push(c) });
    await waitForSpawn();
    emitThreadStarted();
    emitTurnStarted();

    // Aligned with the Claude backend: thinking content is streamed to the
    // user through the same channel, but kept out of the final result output.
    emitJson({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking...' }] } });
    emitAgentMessage('answer');
    emitSuccessAndExit();

    const result = await p;
    expect(result.success).toBe(true);
    expect(chunks).toEqual(['thinking...', 'answer']);
    expect(result.output).toBe('answer');
  });

  it('renders unknown tool-ish items (mcp_tool_call) as generic cards, like AGY pass-through', async () => {
    const toolUses: any[] = [];
    const toolResults: any[] = [];
    const p = executor.execute('call an mcp tool', {
      onToolUse: (t) => toolUses.push(t),
      onToolResult: (r) => toolResults.push(r),
    });
    await waitForSpawn();
    emitThreadStarted();
    emitTurnStarted();

    emitJson({
      type: 'item.completed',
      item: {
        id: 'item_1', type: 'mcp_tool_call', status: 'completed',
        server: 'github', tool: 'search_repos', arguments: '{"q":"remote-cli"}',
        result: 'found 3 repos',
      },
    });
    emitSuccessAndExit();
    await p;

    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe('mcp_tool_call');
    expect(toolUses[0].input).toEqual({ server: 'github', tool: 'search_repos', arguments: '{"q":"remote-cli"}' });
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toEqual({ tool_use_id: 'item_1', content: 'found 3 repos', is_error: false });
  });

  it('marks unknown tool-ish items as error when they carry an error or failed status', async () => {
    const toolResults: any[] = [];
    const p = executor.execute('call an mcp tool', { onToolResult: (r) => toolResults.push(r) });
    await waitForSpawn();
    emitThreadStarted();
    emitTurnStarted();

    emitJson({
      type: 'item.completed',
      item: { id: 'item_1', type: 'mcp_tool_call', status: 'failed', server: 'github', tool: 'search_repos', error: { message: 'MCP server unreachable' } },
    });
    emitSuccessAndExit();
    await p;

    expect(toolResults[0].is_error).toBe(true);
    expect(toolResults[0].content).toContain('MCP server unreachable');
  });

  // ── setModel ────────────────────────────────────────────────────────────

  it('setModel stores the model for the next spawn (one-shot: no kill needed)', async () => {
    const p1 = executor.execute('hi');
    await waitForSpawn();
    expect(mockSpawn.mock.calls[0][1]).not.toContain('-m');
    emitThreadStarted();
    emitTurnStarted();
    emitSuccessAndExit();
    await p1;

    const r = await executor.setModel('gpt-5.2-codex');
    expect(r.success).toBe(true);

    const p2 = executor.execute('after model switch');
    await waitForSpawn(2);
    const args = mockSpawn.mock.calls[1][1];
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-5.2-codex');

    emitThreadStarted('thread-aaa');
    emitTurnStarted();
    emitSuccessAndExit();
    await p2;
  });

  it('setModel does not disturb a running command', async () => {
    const p = executor.execute('running');
    await waitForSpawn();
    emitThreadStarted();
    emitTurnStarted();

    const r = await executor.setModel('gpt-5.2-codex');
    expect(r.success).toBe(true);
    expect(proc.kill).not.toHaveBeenCalled();

    emitSuccessAndExit();
    const result = await p;
    expect(result.success).toBe(true);
  });


  // ── Turn-level failure mapping ────────────────────────────────────────────

  it('resolves success=false with the error message on turn.failed', async () => {
    const p = executor.execute('boom');
    await waitForSpawn();
    emitThreadStarted();
    emitTurnStarted();

    emitJson({ type: 'turn.failed', error: { message: 'stream disconnected before completion' } });
    proc.emit('exit', 1, null);
    proc.emit('close', 1, null);

    const result = await p;
    expect(result.success).toBe(false);
    expect(result.error).toContain('stream disconnected');
  });

  it('resolves success=false on a top-level error event', async () => {
    const p = executor.execute('boom');
    await waitForSpawn();
    emitThreadStarted();

    emitJson({ type: 'error', message: 'model not found: foo' });
    proc.emit('exit', 1, null);
    proc.emit('close', 1, null);

    const result = await p;
    expect(result.success).toBe(false);
    expect(result.error).toContain('model not found');
  });

  it('fails the command when the process exits without a terminal event, including stderr tail', async () => {
    const p = executor.execute('hi');
    await waitForSpawn();

    proc.stderr.emit('data', Buffer.from('error: unexpected argument \'--sandbox\' found\n'));
    proc.emit('exit', 2, null);
    proc.emit('close', 2, null);

    const result = await p;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/exited/i);
    expect(result.error).toContain('--sandbox');
  });

  // ── Thread persistence and resume ─────────────────────────────────────────

  it('saves thread_id from thread.started to the per-thread session file', async () => {
    const p = executor.execute('hi');
    await waitForSpawn();
    emitThreadStarted('thread-xyz-789');
    emitTurnStarted();
    emitSuccessAndExit();
    await p;

    expect(mockFs.writeFileSync).toHaveBeenCalled();
    const [filePath, data] = mockFs.writeFileSync.mock.calls[0];
    expect(String(filePath)).toContain('codex-sessions');
    expect(String(filePath)).toContain('thread-1');
    expect(JSON.parse(data).id).toBe('thread-xyz-789');
    expect(executor.getSessionId()).toBe('thread-xyz-789');
  });

  it('resumes with codex exec resume once a thread id exists', async () => {
    const p1 = executor.execute('first');
    await waitForSpawn();
    emitThreadStarted('thread-keep');
    emitTurnStarted();
    emitSuccessAndExit();
    await p1;

    const p2 = executor.execute('second');
    await waitForSpawn(2);

    const args = mockSpawn.mock.calls[1][1];
    expect(args[0]).toBe('exec');
    expect(args[1]).toBe('resume');
    expect(args).toContain('--skip-git-repo-check');
    expect(args).toContain('--json');
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    // Thread id is a positional argument, followed by the prompt
    const threadIdx = args.indexOf('thread-keep');
    expect(threadIdx).toBeGreaterThan(-1);
    expect(args[args.length - 1]).toBe('second');
    // Regression guard: `codex exec resume` rejects --sandbox (usage error in 0.153.4)
    expect(args).not.toContain('--sandbox');

    emitThreadStarted('thread-keep');
    emitTurnStarted();
    emitSuccessAndExit();
    await p2;
  });

  it('loads persisted thread id on construction and resumes on the first command', async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ id: 'thread-stored' }));

    await executor.destroy();
    executor = new CodexExecutor(directoryGuard, {
      initialWorkingDirectory: '~/test-project',
      threadId: 'thread-1',
    });

    const p = executor.execute('continue please');
    await waitForSpawn();

    const args = mockSpawn.mock.calls[0][1];
    expect(args[1]).toBe('resume');
    expect(args).toContain('thread-stored');

    emitThreadStarted('thread-stored');
    emitTurnStarted();
    emitSuccessAndExit();
    await p;
  });

  it('uses legacy session file in working directory when no threadId is given', async () => {
    await executor.destroy();
    executor = new CodexExecutor(directoryGuard, {
      initialWorkingDirectory: '~/test-project',
    });

    const p = executor.execute('hi');
    await waitForSpawn();
    emitThreadStarted('thread-legacy');
    emitTurnStarted();
    emitSuccessAndExit();
    await p;

    const [filePath] = mockFs.writeFileSync.mock.calls[0];
    expect(String(filePath)).toContain('.codex-session');
  });

  // ── Queueing ──────────────────────────────────────────────────────────────

  it('runs commands sequentially — second process is not spawned until the first exits', async () => {
    const p1 = executor.execute('first');
    await waitForSpawn();
    emitThreadStarted();
    emitTurnStarted();

    const p2 = executor.execute('second');
    await new Promise((r) => setTimeout(r, 50));

    // Only one process so far
    expect(spawnedProcesses).toHaveLength(1);

    emitSuccessAndExit();
    await p1;

    await waitForSpawn(2);
    expect(spawnedProcesses).toHaveLength(2);
    expect(mockSpawn.mock.calls[1][1][mockSpawn.mock.calls[1][1].length - 1]).toBe('second');

    emitThreadStarted('thread-aaa');
    emitTurnStarted();
    emitSuccessAndExit();
    await p2;
  });

  // ── Working directory ─────────────────────────────────────────────────────

  it('setWorkingDirectory updates the cwd used by the next spawn', async () => {
    const p1 = executor.execute('hi');
    await waitForSpawn();
    emitThreadStarted();
    emitTurnStarted();
    emitSuccessAndExit();
    await p1;

    await executor.setWorkingDirectory('./work');

    const p2 = executor.execute('after move');
    await waitForSpawn(2);
    expect(mockSpawn.mock.calls[1][2].cwd).toBe(directoryGuard.resolveWorkingDirectory('./work'));

    emitThreadStarted('thread-aaa');
    emitTurnStarted();
    emitSuccessAndExit();
    await p2;
  });

  it('setWorkingDirectory rejects paths outside the whitelist', async () => {
    await expect(executor.setWorkingDirectory('/etc/passwd')).rejects.toThrow();
  });

  // ── resetContext / compact ────────────────────────────────────────────────

  it('resetContext clears the thread id so the next command starts a fresh thread', async () => {
    const p1 = executor.execute('hi');
    await waitForSpawn();
    emitThreadStarted('thread-old');
    emitTurnStarted();
    emitSuccessAndExit();
    await p1;
    expect(executor.getSessionId()).toBe('thread-old');

    executor.resetContext();
    expect(executor.getSessionId()).toBeNull();

    const p2 = executor.execute('fresh');
    await waitForSpawn(2);
    const args = mockSpawn.mock.calls[1][1];
    expect(args[0]).toBe('exec');
    expect(args[1]).not.toBe('resume');

    emitThreadStarted('thread-new');
    emitTurnStarted();
    emitSuccessAndExit();
    await p2;
  });

  it('compactWhenFull resets the conversation (codex exec has no native /compact)', async () => {
    const p = executor.execute('hi');
    await waitForSpawn();
    emitThreadStarted();
    emitTurnStarted();
    emitSuccessAndExit();
    await p;

    const result = await executor.compactWhenFull();
    expect(result.success).toBe(true);
    expect(executor.getSessionId()).toBeNull();
  });

  // ── Abort ─────────────────────────────────────────────────────────────────

  it('abort returns false when nothing is running', async () => {
    expect(await executor.abort()).toBe(false);
  });

  it('abort kills the process and resolves the in-flight command as aborted; thread id survives', async () => {
    const p = executor.execute('long running');
    await waitForSpawn();
    emitThreadStarted('thread-keep');
    emitTurnStarted();

    const running = proc;
    const aborted = await executor.abort();
    expect(aborted).toBe(true);
    expect(running.kill).toHaveBeenCalled();

    const result = await p;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/abort/i);
    expect(executor.getSessionId()).toBe('thread-keep');
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  it('destroy kills the running process', async () => {
    const p = executor.execute('hi');
    await waitForSpawn();
    emitThreadStarted();
    emitTurnStarted();
    emitSuccessAndExit();
    await p;

    const p2 = executor.execute('slow');
    await waitForSpawn(2);
    const running = proc;
    await executor.destroy();
    expect(running.kill).toHaveBeenCalled();
    expect(executor.isProcessRunning()).toBe(false);

    const r2 = await p2;
    expect(r2.success).toBe(false);
  });

  it('deleteThreadData removes the session file', async () => {
    const p = executor.execute('hi');
    await waitForSpawn();
    emitThreadStarted();
    emitTurnStarted();
    emitSuccessAndExit();
    await p;

    mockFs.existsSync.mockReturnValue(true);
    await executor.deleteThreadData('thread-1');
    expect(mockFs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining('thread-1'));
  });

  // ── Robustness ────────────────────────────────────────────────────────────

  it('ignores unknown events and item types without breaking the command', async () => {
    const p = executor.execute('hi');
    await waitForSpawn();
    emitThreadStarted();
    emitTurnStarted();

    emitJson({ type: 'some_future_event', data: {} });
    emitJson({ type: 'item.started', item: { id: 'item_9', type: 'brand_new_type' } });
    emitJson({ type: 'item.completed', item: { id: 'item_9', type: 'brand_new_type', status: 'completed' } });
    emitAgentMessage('done');
    emitSuccessAndExit();

    const result = await p;
    expect(result.success).toBe(true);
    expect(result.output).toBe('done');
  });

  it('tolerates malformed NDJSON lines', async () => {
    const p = executor.execute('hi');
    await waitForSpawn();
    emitThreadStarted();

    proc.stdout.emit('data', Buffer.from('this is not json\n'));
    proc.stdout.emit('data', Buffer.from('{"type":"turn.completed"')); // split across chunks
    proc.stdout.emit('data', Buffer.from(',"usage":{}}\n'));
    proc.emit('exit', 0, null);
    proc.emit('close', 0, null);

    const result = await p;
    expect(result.success).toBe(true);
  });

  it('fails the command with a friendly error when codex is not installed (spawn error)', async () => {
    const p = executor.execute('hi');
    await waitForSpawn();

    proc.emit('error', new Error('spawn codex ENOENT'));

    const result = await p;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not installed|not found/i);
  });

  it('sends only text when attachments are present (exec mode maps text only)', async () => {
    const p = executor.execute('look at this', {
      attachments: [{ type: 'image', data: 'base64data', mimeType: 'image/png' } as any],
    });
    await waitForSpawn();

    const args = mockSpawn.mock.calls[0][1];
    expect(args[args.length - 1]).toBe('look at this');

    emitThreadStarted();
    emitTurnStarted();
    emitSuccessAndExit();
    await p;
  });

  // ── Lifecycle hardening ─────────────────────────────────────────────────

  it('destroy rejects queued commands and never spawns them', async () => {
    const p1 = executor.execute('first');
    await waitForSpawn();
    emitThreadStarted();
    emitTurnStarted();

    const p2 = executor.execute('second'); // queued behind first
    await new Promise((r) => setTimeout(r, 30));

    const spawnsBefore = spawnedProcesses.length;
    await executor.destroy();

    const r1 = await p1;
    expect(r1.success).toBe(false);
    await expect(p2).rejects.toThrow(/destroyed/i);

    // No spawn for the queued command after destroy
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
    emitThreadStarted();
    emitTurnStarted();

    // Simulate EPIPE arriving asynchronously on the stdin socket
    proc.stdin.emit('error', new Error('write EPIPE'));

    emitSuccessAndExit();
    const result = await p;
    expect(result.success).toBe(true);
  });

  it('fails the command after the inactivity timeout and kills the process', async () => {
    await executor.destroy();
    executor = new CodexExecutor(directoryGuard, {
      initialWorkingDirectory: '~/test-project',
      threadId: 'thread-1',
      inactivityTimeoutMs: 150,
    });

    const p = executor.execute('hang forever');
    await waitForSpawn();
    emitThreadStarted();
    emitTurnStarted();

    // Silence for > 150ms
    await new Promise((r) => setTimeout(r, 400));

    const result = await p;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/inactiv/i);
    expect(proc.kill).toHaveBeenCalled();
  });

  it('inactivity timer resets on each stdout line', async () => {
    await executor.destroy();
    executor = new CodexExecutor(directoryGuard, {
      initialWorkingDirectory: '~/test-project',
      threadId: 'thread-1',
      inactivityTimeoutMs: 150,
    });

    const chunks: string[] = [];
    const p = executor.execute('slow but alive', { onStream: (c) => chunks.push(c) });
    await waitForSpawn();
    emitThreadStarted();
    emitTurnStarted();

    // Activity every 100ms for 350ms total — exceeds 150ms timeout if it didn't reset
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 100));
      emitAgentMessage(`chunk${i} `, `item_${i}`);
    }
    emitSuccessAndExit();
    const result = await p;
    expect(result.success).toBe(true);
    expect(result.output).toBe('chunk0 chunk1 chunk2 ');
  });

  it('escalates to SIGKILL when the process ignores SIGTERM', async () => {
    await executor.destroy();
    executor = new CodexExecutor(directoryGuard, {
      initialWorkingDirectory: '~/test-project',
      threadId: 'thread-1',
      killEscalationMs: 30,
    });

    const p = executor.execute('stubborn');
    await waitForSpawn();
    emitThreadStarted();
    emitTurnStarted();

    await executor.abort();
    const killCalls = proc.kill.mock.calls;
    expect(killCalls.length).toBe(1); // SIGTERM (default signal)

    await new Promise((r) => setTimeout(r, 100));
    expect(proc.kill.mock.calls.length).toBe(2);
    expect(proc.kill.mock.calls[1][0]).toBe('SIGKILL');

    await p;
    proc.emit('exit', null, 'SIGKILL');
    proc.emit('close', null, 'SIGKILL');
  });

  it('does not SIGKILL when the process exits promptly after SIGTERM', async () => {
    await executor.destroy();
    executor = new CodexExecutor(directoryGuard, {
      initialWorkingDirectory: '~/test-project',
      threadId: 'thread-1',
      killEscalationMs: 30,
    });

    const p = executor.execute('cooperative');
    await waitForSpawn();
    emitThreadStarted();
    emitTurnStarted();

    await executor.abort();
    proc.emit('exit', 0, null); // exits promptly
    proc.emit('close', 0, null);

    await new Promise((r) => setTimeout(r, 100));
    expect(proc.kill.mock.calls.length).toBe(1);

    await p;
  });

  it('handles multi-byte UTF-8 characters split across stdout chunks', async () => {
    const chunks: string[] = [];
    const p = executor.execute('say hello in Chinese', { onStream: (c) => chunks.push(c) });
    await waitForSpawn();
    emitThreadStarted();
    emitTurnStarted();

    const line = JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_1', type: 'agent_message', text: '你好' },
    }) + '\n';
    const buf = Buffer.from(line, 'utf8');
    // Split inside the first multi-byte character (你 = 0xE4 0xBD 0xA0)
    const splitAt = buf.indexOf(0xe4) + 1;
    proc.stdout.emit('data', buf.subarray(0, splitAt));
    proc.stdout.emit('data', buf.subarray(splitAt));

    emitSuccessAndExit();
    const result = await p;
    expect(result.success).toBe(true);
    expect(chunks.join('')).toContain('你好');
  });

  it('honors the per-command timeout option', async () => {
    const p = executor.execute('slow', { timeout: 150 });
    await waitForSpawn();
    emitThreadStarted();
    emitTurnStarted();

    await new Promise((r) => setTimeout(r, 400));

    const result = await p;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out/i);
    expect(proc.kill).toHaveBeenCalled();
  });

  // ── Exit-drain regressions ────────────────────────────────────────────────

  it('processes stdout data delivered between exit and close (stdio not yet flushed at exit)', async () => {
    const chunks: string[] = [];
    const p = executor.execute('hi', { onStream: (c) => chunks.push(c) });
    await waitForSpawn();
    emitThreadStarted();
    emitTurnStarted();

    // Process terminates, but the final events arrive AFTER 'exit' —
    // this is legal in Node (stdio may still be open at 'exit').
    proc.emit('exit', 0, null);
    emitAgentMessage('late chunk');
    emitTurnCompleted();
    proc.emit('close', 0, null);

    const result = await p;
    expect(result.success).toBe(true);
    expect(result.output).toBe('late chunk');
    expect(chunks).toEqual(['late chunk']);
  });

  it('parses a trailing NDJSON line without a newline when the process closes', async () => {
    const p = executor.execute('crash mid-write');
    await waitForSpawn();
    emitThreadStarted();
    emitTurnStarted();

    // Final turn.failed arrives without its terminating newline, then death
    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'turn.failed', error: { message: 'real crash reason' },
    })));
    proc.emit('exit', 1, null);
    proc.emit('close', 1, null);

    const result = await p;
    expect(result.success).toBe(false);
    expect(result.error).toContain('real crash reason');
  });

  it('passes prompts that start with a dash after -- so clap does not parse them as flags', async () => {
    const p = executor.execute('- fix the linter warnings');
    await waitForSpawn();

    const args = mockSpawn.mock.calls[0][1];
    const dashIdx = args.indexOf('--');
    expect(dashIdx).toBeGreaterThan(-1);
    expect(args[dashIdx + 1]).toBe('- fix the linter warnings');

    emitThreadStarted();
    emitSuccessAndExit();
    await p;
  });

  it('preserves a recorded turn.completed success when the watchdog fires before the process exits', async () => {
    await executor.destroy();
    executor = new CodexExecutor(directoryGuard, {
      initialWorkingDirectory: '~/test-project',
      threadId: 'thread-1',
      inactivityTimeoutMs: 150,
    });

    const p = executor.execute('finishes then hangs', {});
    await waitForSpawn();
    emitThreadStarted();
    emitTurnStarted();
    emitAgentMessage('work done');

    // Turn completes, but the process hangs without exiting
    emitTurnCompleted();
    await new Promise((r) => setTimeout(r, 400)); // watchdog fires

    const result = await p;
    expect(result.success).toBe(true);
    expect(result.output).toBe('work done');
    expect(proc.kill).toHaveBeenCalled();
  });
});

describe('createExecutor factory - codex backend', () => {
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
    p.stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
    p.kill = vi.fn();
    return p;
  };

  it('creates a CodexExecutor for type "codex"', async () => {
    const guard = new DirectoryGuard(['~/test-project']);
    const executor = createExecutor(guard, { type: 'codex' } as any, '~/test-project', 'thread-x');
    expect(executor).toBeInstanceOf(CodexExecutor);
    await executor.destroy();
  });

  it('passes executor.codex.model through as -m', async () => {
    const guard = new DirectoryGuard(['~/test-project']);
    const executor = createExecutor(
      guard,
      { type: 'codex', codex: { model: 'gpt-5.2-codex' } } as any,
      '~/test-project',
      'thread-x'
    ) as CodexExecutor;

    const p = executor.execute('hi');
    for (let i = 0; i < 100 && mockSpawn.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const args = mockSpawn.mock.calls[0][1];
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-5.2-codex');

    // Cleanup: finish the command and destroy
    const proc = mockSpawn.mock.results[0].value;
    proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'thread.started', thread_id: 't1' }) + '\n'));
    proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'turn.completed', usage: {} }) + '\n'));
    proc.emit('exit', 0, null);
    proc.emit('close', 0, null);
    await p;
    await executor.destroy();
  });

  it('per-thread model (from /model) takes precedence over executor.codex.model', async () => {
    const guard = new DirectoryGuard(['~/test-project']);
    const executor = createExecutor(
      guard,
      { type: 'codex', codex: { model: 'config-model' } } as any,
      '~/test-project',
      'thread-x',
      'thread-model'
    ) as CodexExecutor;

    const p = executor.execute('hi');
    for (let i = 0; i < 100 && mockSpawn.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const args = mockSpawn.mock.calls[0][1];
    expect(args[args.indexOf('-m') + 1]).toBe('thread-model');

    const proc = mockSpawn.mock.results[0].value;
    proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'thread.started', thread_id: 't1' }) + '\n'));
    proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'turn.completed', usage: {} }) + '\n'));
    proc.emit('exit', 0, null);
    proc.emit('close', 0, null);
    await p;
    await executor.destroy();
  });
});
