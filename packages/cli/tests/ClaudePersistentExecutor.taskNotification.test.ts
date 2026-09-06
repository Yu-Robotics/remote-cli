import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ClaudePersistentExecutor } from '../src/executor/ClaudePersistentExecutor';
import { DirectoryGuard } from '../src/security/DirectoryGuard';
import { claudeCodeHooks, TaskNotificationContext } from '../src/hooks/ClaudeCodeHooks';
import { EventEmitter } from 'events';

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

// Mock fs for session file operations
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => JSON.stringify({ id: 'test-session' })),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => JSON.stringify({ id: 'test-session' })),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { spawn } from 'child_process';

/**
 * Tests for handling Claude Code 2.x `system` messages with
 * `subtype: 'task_notification'` (background task completion events).
 *
 * These events can arrive at any time — during an active command or while
 * the persistent process is idle — and must be surfaced via the hooks event
 * bus WITHOUT interfering with the current command lifecycle.
 */
describe('ClaudePersistentExecutor - task_notification', () => {
  let executor: ClaudePersistentExecutor;
  let directoryGuard: DirectoryGuard;
  const mockSpawn = spawn as any;
  let mockChildProcess: any;
  let receivedNotifications: TaskNotificationContext[];
  let notificationListener: (ctx: TaskNotificationContext) => void;

  const emitJson = (obj: Record<string, unknown>) => {
    mockChildProcess.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n'));
  };

  beforeEach(() => {
    vi.clearAllMocks();

    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    directoryGuard = new DirectoryGuard(['~/test-project', './work']);

    mockChildProcess = new EventEmitter() as any;
    mockChildProcess.stdout = new EventEmitter();
    mockChildProcess.stderr = new EventEmitter();
    mockChildProcess.stdin = { write: vi.fn(), end: vi.fn() };
    mockChildProcess.kill = vi.fn();
    mockChildProcess.pid = 12345;

    mockSpawn.mockReturnValue(mockChildProcess);

    receivedNotifications = [];
    notificationListener = (ctx: TaskNotificationContext) => {
      receivedNotifications.push(ctx);
    };
    claudeCodeHooks.onTaskNotification(notificationListener);

    executor = new ClaudePersistentExecutor(directoryGuard, '~/test-project', 'thread-1');
  });

  afterEach(async () => {
    claudeCodeHooks.removeAllHandlers();
    // Simulate process exit so destroy() doesn't hang waiting for 'close'
    mockChildProcess.emit('exit', 0, null);
    mockChildProcess.emit('close', 0, null);
    await executor.destroy();
    vi.clearAllMocks();
  });

  /**
   * Start the persistent process for the given command, wait for the command
   * to become current (startProcess has a 1000ms liveness timer before
   * processQueue shifts the command — messages emitted earlier would be
   * dropped), then emit the session init message.
   *
   * NOTE: intentionally returns void — the caller must keep the execute()
   * promise itself. Returning it from this async helper would make `await`
   * flatten to the command result and deadlock the test.
   */
  const startProcessAndInit = async (executePromise: Promise<unknown>) => {
    void executePromise; // Document that the caller owns the promise
    await new Promise(resolve => setTimeout(resolve, 1500));
    emitJson({
      type: 'system',
      subtype: 'init',
      session_id: 'session-xyz',
      cwd: '/home/user/test-project',
    });
  };

  const completeCommand = () => {
    emitJson({
      type: 'result',
      subtype: 'success',
      result: 'Done',
      is_error: false,
    });
  };

  it('should emit task:notification hook event when a task_notification system message arrives mid-command', async () => {
    const executePromise = executor.execute('test command');
    await startProcessAndInit(executePromise);

    emitJson({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'b4a2f1',
      status: 'completed',
      summary: 'Build finished successfully',
      output_file: '/tmp/claude-outputs/b4a2f1.log',
      session_id: 'session-xyz',
    });

    // The notification must NOT complete or interfere with the in-flight command
    let resolved = false;
    executePromise.then(() => { resolved = true; });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(resolved).toBe(false);

    completeCommand();
    const result = await executePromise;
    expect(result.success).toBe(true);

    expect(receivedNotifications).toHaveLength(1);
    expect(receivedNotifications[0]).toEqual({
      taskId: 'b4a2f1',
      status: 'completed',
      summary: 'Build finished successfully',
      outputFile: '/tmp/claude-outputs/b4a2f1.log',
      threadId: 'thread-1',
      sessionId: 'session-xyz',
    });
  }, 10000);

  it('should emit task:notification even when no command is active (idle process)', async () => {
    const executePromise = executor.execute('test command');
    await startProcessAndInit(executePromise);
    completeCommand();
    await executePromise;

    // Process is now idle — a background task completes
    emitJson({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'c7d8e9',
      status: 'failed',
      summary: 'Tests failed: 2 failures',
      output_file: '/tmp/claude-outputs/c7d8e9.log',
      session_id: 'session-xyz',
    });

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(receivedNotifications).toHaveLength(1);
    expect(receivedNotifications[0].taskId).toBe('c7d8e9');
    expect(receivedNotifications[0].status).toBe('failed');
  }, 10000);

  it('should support all three task statuses', async () => {
    const executePromise = executor.execute('test command');
    await startProcessAndInit(executePromise);
    completeCommand();
    await executePromise;

    const statuses = ['completed', 'failed', 'stopped'] as const;
    for (const status of statuses) {
      emitJson({
        type: 'system',
        subtype: 'task_notification',
        task_id: `task-${status}`,
        status,
        summary: `Task ${status}`,
        output_file: `/tmp/${status}.log`,
        session_id: 'session-xyz',
      });
    }

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(receivedNotifications.map(n => n.status)).toEqual(['completed', 'failed', 'stopped']);
  }, 10000);

  it('should ignore task_notification messages missing required fields', async () => {
    const executePromise = executor.execute('test command');
    await startProcessAndInit(executePromise);

    emitJson({
      type: 'system',
      subtype: 'task_notification',
      // task_id missing
      status: 'completed',
      summary: 'Incomplete event',
      session_id: 'session-xyz',
    });

    completeCommand();
    await executePromise;

    expect(receivedNotifications).toHaveLength(0);
  }, 10000);

  it('should still ignore other unknown system subtypes silently', async () => {
    const executePromise = executor.execute('test command');
    await startProcessAndInit(executePromise);

    // Unknown subtypes must not produce notifications or break the command
    emitJson({ type: 'system', subtype: 'some_future_subtype', foo: 'bar', session_id: 'session-xyz' });

    completeCommand();
    const result = await executePromise;

    expect(result.success).toBe(true);
    expect(receivedNotifications).toHaveLength(0);
  }, 10000);

  it('should not leak idle-time autonomous turn output into the next command result', async () => {
    // Command 1 completes normally
    const firstPromise = executor.execute('first command');
    await startProcessAndInit(firstPromise);
    completeCommand();
    const firstResult = await firstPromise;
    expect(firstResult.success).toBe(true);

    // Idle: a background task completes and Claude Code 2.x autonomously
    // starts a turn to react to it (observed on claude 2.1.231). With no
    // active command, the assistant text lands in the output buffer and the
    // trailing result is ignored by the duplicate-completion guard — which
    // returns early WITHOUT clearing the buffer.
    emitJson({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'The background task completed successfully.' }] },
      session_id: 'session-xyz',
    });
    emitJson({ type: 'result', subtype: 'success', result: 'The background task completed successfully.', is_error: false });

    // Command 2: its final output must NOT contain the autonomous turn's text
    const secondPromise = executor.execute('second command');
    await new Promise(resolve => setTimeout(resolve, 100));
    emitJson({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Here is the login fix.' }] },
      session_id: 'session-xyz',
    });
    completeCommand();
    const secondResult = await secondPromise;

    expect(secondResult.success).toBe(true);
    expect(secondResult.output).toContain('Here is the login fix.');
    expect(secondResult.output).not.toContain('background task completed');
  }, 10000);
});
