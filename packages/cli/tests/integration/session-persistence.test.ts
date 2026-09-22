import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ClaudePersistentExecutor } from '../../src/executor/ClaudePersistentExecutor';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';

vi.mock('child_process', () => ({ spawn: vi.fn() }));

function createChild() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: {
      write: vi.fn(),
      end: vi.fn(() => {
        queueMicrotask(() => {
          child.emit('exit', 0, null);
          child.emit('close', 0, null);
        });
      }),
    },
  });
  return child;
}

describe('Integration: Claude session persistence', () => {
  let home: string;
  let project: string;
  let guard: DirectoryGuard;
  let children: ReturnType<typeof createChild>[];
  let executors: ClaudePersistentExecutor[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-session-test-')));
    project = path.join(home, 'project');
    fs.mkdirSync(project);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    guard = new DirectoryGuard([home]);
    children = [];
    executors = [];
    vi.mocked(spawn).mockImplementation(() => {
      const child = createChild();
      children.push(child);
      return child as unknown as ChildProcess;
    });
  });

  afterEach(async () => {
    await Promise.all(executors.map(executor => executor.destroy()));
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  });

  function createExecutor(threadId?: string, cwd = project) {
    const executor = new ClaudePersistentExecutor(guard, cwd, threadId);
    executors.push(executor);
    return executor;
  }

  function sessionPath(threadId: string) {
    return path.join(home, '.remote-cli', 'claude-sessions', threadId + '.json');
  }

  function emit(child: ReturnType<typeof createChild>, message: object) {
    child.stdout.emit('data', Buffer.from(JSON.stringify(message) + '\n'));
  }

  async function executeTurn(executor: ClaudePersistentExecutor, sessionId: string) {
    const result = executor.execute('Continue the task');
    await vi.advanceTimersByTimeAsync(1000);
    const child = children.at(-1)!;
    expect(child.stdin.write).toHaveBeenCalledWith(expect.stringContaining('Continue the task'));
    emit(child, { type: 'system', subtype: 'init', session_id: sessionId });
    emit(child, { type: 'assistant', message: { content: [{ type: 'text', text: 'Done' }] } });
    emit(child, { type: 'result', subtype: 'success' });
    await expect(result).resolves.toMatchObject({ success: true, output: 'Done' });
  }

  it('persists an initialized session and resumes it after executor recreation', async () => {
    const executor = createExecutor('thread-a');
    await executeTurn(executor, 'session-a');
    expect(JSON.parse(fs.readFileSync(sessionPath('thread-a'), 'utf8')).id).toBe('session-a');
    await executor.destroy();

    await executeTurn(createExecutor('thread-a'), 'session-a');
    expect(spawn).toHaveBeenLastCalledWith(
      'claude', expect.arrayContaining(['--resume', 'session-a']), expect.objectContaining({ cwd: project }),
    );
  });

  it('keeps two threads in the same workspace isolated across recreation', async () => {
    const first = createExecutor('thread-a');
    const second = createExecutor('thread-b');
    await executeTurn(first, 'session-a');
    await executeTurn(second, 'session-b');
    expect(JSON.parse(fs.readFileSync(sessionPath('thread-a'), 'utf8')).id).toBe('session-a');
    expect(JSON.parse(fs.readFileSync(sessionPath('thread-b'), 'utf8')).id).toBe('session-b');
    await Promise.all([first.destroy(), second.destroy()]);

    for (const [threadId, sessionId] of [['thread-a', 'session-a'], ['thread-b', 'session-b']]) {
      await executeTurn(createExecutor(threadId), sessionId);
      expect(vi.mocked(spawn).mock.calls.at(-1)![1]).toEqual(expect.arrayContaining(['--resume', sessionId]));
    }
  });

  it('starts a fresh session after changing directory but keeps storage bound to the thread', async () => {
    const executor = createExecutor('thread-a');
    await executeTurn(executor, 'session-before');
    const other = path.join(home, 'other');
    fs.mkdirSync(other);
    const changingDirectory = executor.setWorkingDirectory(other);
    await vi.advanceTimersByTimeAsync(1000);
    await changingDirectory;
    expect(vi.mocked(spawn).mock.calls.at(-1)![1]).not.toContain('--resume');

    await executeTurn(executor, 'session-after');
    expect(JSON.parse(fs.readFileSync(sessionPath('thread-a'), 'utf8')).id).toBe('session-after');
    expect(fs.existsSync(path.join(other, '.claude-session'))).toBe(false);
    await executor.destroy();
    await executeTurn(createExecutor('thread-a', other), 'session-after');
    expect(spawn).toHaveBeenLastCalledWith(
      'claude', expect.arrayContaining(['--resume', 'session-after']), expect.objectContaining({ cwd: other }),
    );
  });

  it('resumes the legacy workspace session when no thread id is supplied', async () => {
    fs.writeFileSync(path.join(project, '.claude-session'), JSON.stringify({ id: 'legacy-session' }));
    await executeTurn(createExecutor(), 'legacy-session');
    expect(vi.mocked(spawn).mock.calls.at(-1)![1]).toEqual(expect.arrayContaining(['--resume', 'legacy-session']));
  });

  it('delivers redaction and plan events to the callbacks of the current execute call', async () => {
    const executor = createExecutor('thread-a');
    const previous = { onStream: vi.fn(), onRedactedThinking: vi.fn(), onPlanMode: vi.fn() };
    const current = { onStream: vi.fn(), onRedactedThinking: vi.fn(), onPlanMode: vi.fn() };

    for (const callbacks of [previous, current]) {
      const result = executor.execute('Plan this task', callbacks);
      await vi.advanceTimersByTimeAsync(1000);
      const child = children.at(-1)!;
      for (const block of [
        { type: 'redacted_thinking', redacted_thinking: 'ENCRYPTED_REASONING' },
        { type: 'tool_use', id: 'enter', name: 'EnterPlanMode', input: {} },
        { type: 'text', text: 'Step 1: Read the file' },
        { type: 'tool_use', id: 'exit', name: 'ExitPlanMode', input: {} },
      ]) {
        emit(child, { type: 'assistant', message: { content: [block] } });
      }
      emit(child, { type: 'result', subtype: 'success' });
      await expect(result).resolves.toMatchObject({ success: true });
      expect(callbacks.onRedactedThinking).toHaveBeenCalledTimes(1);
      expect(callbacks.onPlanMode).toHaveBeenCalledTimes(1);
      expect(callbacks.onPlanMode).toHaveBeenCalledWith('Step 1: Read the file');
      expect(JSON.stringify(callbacks.onStream.mock.calls)).not.toContain('ENCRYPTED_REASONING');
    }
    expect(previous.onRedactedThinking).toHaveBeenCalledTimes(1);
    expect(previous.onPlanMode).toHaveBeenCalledTimes(1);
  });
});
