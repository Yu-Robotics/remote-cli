import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ClaudePersistentExecutor } from '../src/executor/ClaudePersistentExecutor';
import { DirectoryGuard } from '../src/security/DirectoryGuard';
import { EventEmitter } from 'events';

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

// Mock fs for session file operations
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => true),  // Default to true for working directory checks
    readFileSync: vi.fn(() => JSON.stringify({ id: 'test-session' })),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
  existsSync: vi.fn(() => true),  // Default to true for working directory checks
  readFileSync: vi.fn(() => JSON.stringify({ id: 'test-session' })),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { spawn } from 'child_process';
import fs from 'fs';

describe('ClaudePersistentExecutor', () => {
  let executor: ClaudePersistentExecutor;
  let directoryGuard: DirectoryGuard;
  const mockSpawn = spawn as any;
  const mockFs = fs as any;
  let mockChildProcess: any;

  beforeEach(() => {
    vi.clearAllMocks();

    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // Reset mock implementations
    mockFs.existsSync.mockReturnValue(true);  // Default: files and directories exist
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ id: 'test-session' }));  // Default: valid session

    directoryGuard = new DirectoryGuard(['~/test-project', './work']);

    // Mock spawn to return a mock child process
    mockChildProcess = new EventEmitter() as any;
    mockChildProcess.stdout = new EventEmitter();
    mockChildProcess.stderr = new EventEmitter();
    mockChildProcess.stdin = {
      write: vi.fn(),
      end: vi.fn(),
    };
    mockChildProcess.kill = vi.fn();
    mockChildProcess.pid = 12345;

    mockSpawn.mockReturnValue(mockChildProcess);

    executor = new ClaudePersistentExecutor(directoryGuard);
  });

  afterEach(async () => {
    await executor.destroy();
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('should create executor with directory guard', () => {
      expect(executor).toBeDefined();
      expect(executor).toBeInstanceOf(ClaudePersistentExecutor);
    });

    it('should have default working directory', () => {
      const cwd = executor.getCurrentWorkingDirectory();
      expect(cwd).toBeDefined();
      expect(typeof cwd).toBe('string');
    });

    it('should initialize with custom working directory', () => {
      const customDir = '~/test-project';
      const customExecutor = new ClaudePersistentExecutor(directoryGuard, customDir);
      const cwd = customExecutor.getCurrentWorkingDirectory();
      expect(cwd).toContain('test-project');
    });

    it('should fall back to process.cwd() if custom directory is invalid', () => {
      const invalidDir = '/etc/passwd'; // Not in allowed directories
      const customExecutor = new ClaudePersistentExecutor(directoryGuard, invalidDir);
      const cwd = customExecutor.getCurrentWorkingDirectory();
      // Should fall back to process.cwd()
      expect(cwd).toBe(process.cwd());
    });
  });

  describe('working directory management', () => {
    it('should set working directory if path is safe', async () => {
      const safePath = '~/test-project';
      await executor.setWorkingDirectory(safePath);
      const cwd = executor.getCurrentWorkingDirectory();
      expect(cwd).toContain('test-project');
    });

    it('should throw error if path is not safe', async () => {
      const unsafePath = '/etc/passwd';
      await expect(executor.setWorkingDirectory(unsafePath)).rejects.toThrow();
    });

    it('should normalize tilde paths', async () => {
      await executor.setWorkingDirectory('~/test-project');
      const cwd = executor.getCurrentWorkingDirectory();
      expect(cwd).not.toContain('~');
      expect(cwd).toContain('test-project');
    });
  });

  describe('incremental text output', () => {
    const emit = (message: Record<string, unknown>) => {
      mockChildProcess.stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`));
    };
    const stream = (event: Record<string, unknown>, parent: string | null = null) => {
      emit({ type: 'stream_event', event, parent_tool_use_id: parent });
    };
    const beginText = (id: string, index = 0, parent: string | null = null, text = '') => {
      stream({ type: 'message_start', message: { id } }, parent);
      stream({ type: 'content_block_start', index, content_block: { type: 'text', text } }, parent);
    };
    const delta = (text: string, index = 0, parent: string | null = null) => {
      stream({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } }, parent);
    };
    const assistant = (id: string, content: Record<string, unknown>[], parent: string | null = null) => {
      emit({ type: 'assistant', message: { id, role: 'assistant', content }, parent_tool_use_id: parent });
    };

    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
      // Finish any turn left open by a failed assertion before closing the mock process.
      emit({ type: 'result', subtype: 'success' });
      mockChildProcess.emit('exit', 0, null);
      mockChildProcess.emit('close', 0, null);
      vi.useRealTimers();
    });

    it.each(['before', 'after'])('streams text before completion and deduplicates a final block received %s stream end', async (order) => {
      const onStream = vi.fn();
      const completed = vi.fn();
      const result = executor.execute('Explain the change', { onStream }).then(completed);
      await vi.advanceTimersByTimeAsync(1000);

      beginText('message-1', 1, null, 'Hel');
      delta('lo ', 1);
      delta('world', 1);
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Internal reasoning' } });
      emit({ type: 'system', subtype: 'status', status: 'compacting' });
      emit({ type: 'system', subtype: 'api_retry', attempt: 1, retry_delay_ms: 1000 });

      expect(onStream.mock.calls.map(([text]) => text)).toEqual(['Hel', 'lo ', 'world']);
      expect(completed).not.toHaveBeenCalled();
      if (order === 'after') stream({ type: 'message_stop' });
      assistant('message-1', [{ type: 'text', text: 'Hello world' }]);
      if (order === 'before') stream({ type: 'message_stop' });
      expect(onStream.mock.calls.map(([text]) => text).join('')).toBe('Hello world');

      emit({ type: 'result', subtype: 'success' });
      await result;
      expect(completed).toHaveBeenCalledWith(expect.objectContaining({ success: true, output: 'Hello world' }));
    });

    it('keeps interleaved messages distinct and preserves text without streaming events', async () => {
      const onStream = vi.fn();
      const result = executor.execute('Review the changes', { onStream });
      await vi.advanceTimersByTimeAsync(1000);

      beginText('main-message');
      delta('Same');
      beginText('child-message', 0, 'task-tool');
      delta('Same', 0, 'task-tool');
      assistant('child-message', [{ type: 'text', text: 'Same' }], 'task-tool');
      assistant('main-message', [{ type: 'text', text: 'Same' }]);
      // A second block may repeat the first block's text within the same message.
      stream({ type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } });
      delta('Same', 2);
      assistant('main-message', [{ type: 'text', text: 'Same' }]);
      assistant('unstreamed-message', [{ type: 'text', text: 'Same' }]);
      // If only a prefix arrived incrementally, preserve the rest of the final block.
      beginText('partial-message');
      delta('Part');
      assistant('partial-message', [{ type: 'text', text: 'Partial text' }]);
      emit({ type: 'result', subtype: 'success' });

      expect(onStream.mock.calls.map(([text]) => text)).toEqual(['Same', 'Same', 'Same', 'Same', 'Part', 'ial text']);
      await expect(result).resolves.toMatchObject({ success: true, output: 'SameSameSameSamePartial text' });

      const nextStream = vi.fn();
      const next = executor.execute('Continue', { onStream: nextStream });
      assistant('next-message', [{ type: 'text', text: 'Same' }]);
      emit({ type: 'result', subtype: 'success' });
      await expect(next).resolves.toMatchObject({ success: true, output: 'Same' });
      expect(nextStream).toHaveBeenCalledTimes(1);
      expect(nextStream).toHaveBeenCalledWith('Same');
    });

    it('keeps tool callbacks and plan text in order without duplicating streamed text', async () => {
      const events: string[] = [];
      const onPlanMode = vi.fn((text: string) => events.push(`plan:${text}`));
      const result = executor.execute('Plan the change', {
        onStream: (text) => events.push(`text:${text}`),
        onToolUse: (tool) => events.push(`tool:${tool.name}`),
        onPlanMode,
      });
      await vi.advanceTimersByTimeAsync(1000);

      assistant('enter-plan', [{ type: 'tool_use', id: 'enter', name: 'EnterPlanMode', input: {} }]);
      beginText('plan-message');
      delta('Step 1.');
      assistant('plan-message', [{ type: 'text', text: 'Step 1.' }]);
      stream({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'read', name: 'Read' } });
      stream({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path":' } });
      assistant('plan-message', [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'README.md' } }]);
      assistant('exit-plan', [{ type: 'tool_use', id: 'exit', name: 'ExitPlanMode', input: {} }]);
      emit({ type: 'result', subtype: 'success' });

      expect(events).toEqual(['text:Step 1.', 'tool:Read', 'plan:Step 1.']);
      expect(onPlanMode).toHaveBeenCalledTimes(1);
      expect(onPlanMode).toHaveBeenCalledWith('Step 1.');
      await expect(result).resolves.toMatchObject({ success: true, output: 'Step 1.' });
    });
  });

  describe('process startup', () => {
    it('should return error if working directory does not exist', async () => {
      // Set working directory to a safe path
      await executor.setWorkingDirectory('~/test-project');

      // Mock fs.existsSync to return false for the working directory check
      // but true for session file checks
      let callCount = 0;
      mockFs.existsSync.mockImplementation((path: string) => {
        callCount++;
        // First call is for session file check, return false (no session file)
        if (callCount === 1) {
          return false;
        }
        // Second call is for working directory validation in startProcess, return false
        return false;
      });

      // Execute a command - should fail gracefully without crashing
      const result = await executor.execute('test command');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Working directory does not exist');
      expect(mockSpawn).not.toHaveBeenCalled();
    });
  });

  describe('cleanup', () => {
    it('should cleanup resources on destroy', async () => {
      await executor.destroy();
      expect(() => executor.destroy()).not.toThrow();
    });

    it('should reject executions after destroy', async () => {
      await executor.destroy();
      const result = await executor.execute('test command');

      expect(result.success).toBe(false);
      expect(result.error).toContain('destroyed');
    });
  });

  describe('session resumption', () => {
    it('should handle non-existent session ID gracefully', async () => {
      // Mock a session file with a non-existent session ID
      const nonExistentSessionId = 'non-existent-session-id-12345';

      // Setup mocks to allow reading session file AND ensure working directory exists
      let existsCallCount = 0;
      mockFs.existsSync.mockImplementation((path: string) => {
        existsCallCount++;
        // First call: check for session file (return true - session file exists)
        if (existsCallCount === 1) {
          return true;
        }
        // Second call: check working directory exists before starting process (return true)
        return true;
      });

      mockFs.readFileSync.mockReturnValue(JSON.stringify({ id: nonExistentSessionId }));

      // Create a new executor that will load the non-existent session
      const testExecutor = new ClaudePersistentExecutor(directoryGuard, '~/test-project');

      // Verify the session ID was loaded
      expect(testExecutor.getSessionId()).toBe(nonExistentSessionId);

      // Mock spawn to simulate Claude CLI error when resuming non-existent session
      const mockErrorProcess = new EventEmitter() as any;
      mockErrorProcess.stdout = new EventEmitter();
      mockErrorProcess.stderr = new EventEmitter();
      mockErrorProcess.stdin = {
        write: vi.fn(),
        end: vi.fn(),
      };
      mockErrorProcess.kill = vi.fn();
      mockErrorProcess.pid = 99999;

      mockSpawn.mockReturnValue(mockErrorProcess);

      // Execute a command - this should trigger process start with --resume
      const executePromise = testExecutor.execute('test command');

      // Wait for process to start
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Verify spawn was called with --resume and the non-existent session ID
      expect(mockSpawn).toHaveBeenCalledWith(
        'claude',
        expect.arrayContaining(['--resume', nonExistentSessionId]),
        expect.any(Object)
      );

      // Simulate Claude CLI error output on stderr
      const errorMessage = 'Error: Session not found: non-existent-session-id-12345\nPlease check your session ID or start a new session.\n';
      mockErrorProcess.stderr.emit('data', Buffer.from(errorMessage));

      // Simulate process exit with error code (this triggers the error handling)
      // Emit both 'exit' and 'close' - 'close' fires after all stdio streams close
      mockErrorProcess.emit('exit', 1, null);
      mockErrorProcess.emit('close', 1, null);

      // The execution should be rejected with a user-friendly error about session not found
      await expect(executePromise).rejects.toThrow(/Session not found.*start a fresh session/s);

      // Cleanup
      await testExecutor.destroy();
    });

    it('should start fresh session if session file does not exist', async () => {
      // Setup mocks: session file doesn't exist, but working directory does
      let existsCallCount = 0;
      mockFs.existsSync.mockImplementation((path: string) => {
        existsCallCount++;
        // First call: check for session file (return false - no session file)
        if (existsCallCount === 1) {
          return false;
        }
        // Second call: check working directory exists (return true)
        return true;
      });

      // Create a new executor
      const testExecutor = new ClaudePersistentExecutor(directoryGuard, '~/test-project');

      // Session ID should be null since no session file exists
      expect(testExecutor.getSessionId()).toBeNull();

      // Mock a fresh child process for this test
      const freshMockProcess = new EventEmitter() as any;
      freshMockProcess.stdout = new EventEmitter();
      freshMockProcess.stderr = new EventEmitter();
      freshMockProcess.stdin = {
        write: vi.fn(),
        end: vi.fn(),
      };
      freshMockProcess.kill = vi.fn();
      freshMockProcess.pid = 88888;

      mockSpawn.mockReturnValue(freshMockProcess);

      // Execute a command
      const executePromise = testExecutor.execute('test command');

      // Wait for process to start
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Verify spawn was called WITHOUT --resume flag
      const spawnCalls = mockSpawn.mock.calls;
      const lastCall = spawnCalls[spawnCalls.length - 1];
      expect(lastCall).toBeDefined();
      expect(lastCall[0]).toBe('claude');
      expect(lastCall[1]).not.toContain('--resume');
      expect(lastCall[2].env).toMatchObject({ CLAUDECODE: '', CLAUDE_CODE: '' });

      // Simulate successful process initialization
      freshMockProcess.stdout.emit('data', Buffer.from(JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'new-session-12345',
        cwd: '/home/user/test-project'
      }) + '\n'));

      // Simulate result message
      freshMockProcess.stdout.emit('data', Buffer.from(JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'Command executed successfully',
        is_error: false
      }) + '\n'));

      const result = await executePromise;
      expect(result.success).toBe(true);
      expect(testExecutor.getSessionId()).toBe('new-session-12345');

      // Simulate process exit before cleanup to prevent timeout
      // Emit both 'exit' and 'close' - 'close' fires after all stdio streams close
      freshMockProcess.emit('exit', 0, null);
      freshMockProcess.emit('close', 0, null);

      // Wait a bit for exit handler to complete
      await new Promise(resolve => setTimeout(resolve, 100));

      // Cleanup
      await testExecutor.destroy();
    }, 10000); // Increase timeout to 10 seconds

    it('should resume existing valid session after destroy and recreate', async () => {
      // Step 1: First executor, no session file yet
      let existsCallCount = 0;
      mockFs.existsSync.mockImplementation(() => {
        existsCallCount++;
        // First call: session file check on init (not found)
        if (existsCallCount === 1) return false;
        // Subsequent calls: working directory exists
        return true;
      });

      const firstExecutor = new ClaudePersistentExecutor(directoryGuard, '~/test-project');
      expect(firstExecutor.getSessionId()).toBeNull();

      const firstProcess = new EventEmitter() as any;
      firstProcess.stdout = new EventEmitter();
      firstProcess.stderr = new EventEmitter();
      firstProcess.stdin = { write: vi.fn(), end: vi.fn() };
      firstProcess.kill = vi.fn();
      firstProcess.pid = 11111;
      mockSpawn.mockReturnValue(firstProcess);

      const firstExecutePromise = firstExecutor.execute('echo "first"');
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Simulate session init with a session ID
      firstProcess.stdout.emit('data', Buffer.from(JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'saved-session-abc123',
        cwd: '/home/user/test-project',
      }) + '\n'));

      firstProcess.stdout.emit('data', Buffer.from(JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'first command',
        is_error: false,
      }) + '\n'));

      const firstResult = await firstExecutePromise;
      expect(firstResult.success).toBe(true);
      expect(firstExecutor.getSessionId()).toBe('saved-session-abc123');

      // Simulate clean exit
      firstProcess.emit('exit', 0, null);
      firstProcess.emit('close', 0, null);
      await new Promise(resolve => setTimeout(resolve, 100));
      await firstExecutor.destroy();

      // Step 2: Second executor, session file exists with saved ID
      existsCallCount = 0;
      mockFs.existsSync.mockImplementation(() => {
        existsCallCount++;
        // First call: session file check (found)
        if (existsCallCount === 1) return true;
        return true;
      });
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ id: 'saved-session-abc123' }));

      const secondExecutor = new ClaudePersistentExecutor(directoryGuard, '~/test-project');

      // Verify session ID was loaded from file
      expect(secondExecutor.getSessionId()).toBe('saved-session-abc123');

      const secondProcess = new EventEmitter() as any;
      secondProcess.stdout = new EventEmitter();
      secondProcess.stderr = new EventEmitter();
      secondProcess.stdin = { write: vi.fn(), end: vi.fn() };
      secondProcess.kill = vi.fn();
      secondProcess.pid = 22222;
      mockSpawn.mockReturnValue(secondProcess);

      const secondExecutePromise = secondExecutor.execute('echo "second"');
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Verify spawn was called with --resume and the saved session ID
      expect(mockSpawn).toHaveBeenCalledWith(
        'claude',
        expect.arrayContaining(['--resume', 'saved-session-abc123']),
        expect.any(Object)
      );

      secondProcess.stdout.emit('data', Buffer.from(JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'saved-session-abc123',
        cwd: '/home/user/test-project',
      }) + '\n'));

      secondProcess.stdout.emit('data', Buffer.from(JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'second command',
        is_error: false,
      }) + '\n'));

      const secondResult = await secondExecutePromise;
      expect(secondResult.success).toBe(true);
      expect(secondExecutor.getSessionId()).toBe('saved-session-abc123');

      secondProcess.emit('exit', 0, null);
      secondProcess.emit('close', 0, null);
      await new Promise(resolve => setTimeout(resolve, 100));
      await secondExecutor.destroy();
    }, 10000);
  });

  describe('compact()', () => {
    it('should resolve immediately when no active session exists', async () => {
      mockFs.existsSync.mockReturnValue(false);
      const noSessionExecutor = new ClaudePersistentExecutor(directoryGuard, '~/test-project');

      const result = await noSessionExecutor.compact();

      expect(result.success).toBe(true);
      expect(result.output).toContain('No active session');
      await noSessionExecutor.destroy();
    });

    it('should send /compact as a slash command to stdin', async () => {
      const testExecutor = new ClaudePersistentExecutor(directoryGuard, '~/test-project');

      const freshProcess = new EventEmitter() as any;
      freshProcess.stdout = new EventEmitter();
      freshProcess.stderr = new EventEmitter();
      freshProcess.stdin = { write: vi.fn(), end: vi.fn() };
      freshProcess.kill = vi.fn();
      freshProcess.pid = 99999;
      mockSpawn.mockReturnValue(freshProcess);

      // Start compact (which will spawn process and queue the command)
      const compactPromise = testExecutor.compact();

      // Wait for process to start
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Simulate process init
      freshProcess.stdout.emit('data', Buffer.from(JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'compact-session',
        cwd: '/home/user/test-project',
      }) + '\n'));

      // Verify stdin received a message with isSlashCommand: true
      expect(freshProcess.stdin.write).toHaveBeenCalled();
      const writtenArg = freshProcess.stdin.write.mock.calls[0][0] as string;
      const parsed = JSON.parse(writtenArg.trim());
      expect(parsed.isSlashCommand).toBe(true);
      expect(parsed.message.content).toBe('/compact');

      // Simulate successful result
      freshProcess.stdout.emit('data', Buffer.from(JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'Conversation compacted.',
        is_error: false,
      }) + '\n'));

      const result = await compactPromise;
      expect(result.success).toBe(true);

      freshProcess.emit('exit', 0, null);
      freshProcess.emit('close', 0, null);
      await new Promise(resolve => setTimeout(resolve, 100));
      await testExecutor.destroy();
    }, 10000);

    it('should resolve with error when compact fails', async () => {
      const testExecutor = new ClaudePersistentExecutor(directoryGuard, '~/test-project');

      const freshProcess = new EventEmitter() as any;
      freshProcess.stdout = new EventEmitter();
      freshProcess.stderr = new EventEmitter();
      freshProcess.stdin = { write: vi.fn(), end: vi.fn() };
      freshProcess.kill = vi.fn();
      freshProcess.pid = 77777;
      mockSpawn.mockReturnValue(freshProcess);

      const compactPromise = testExecutor.compact();

      await new Promise(resolve => setTimeout(resolve, 1100));

      freshProcess.stdout.emit('data', Buffer.from(JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'compact-fail-session',
        cwd: '/home/user/test-project',
      }) + '\n'));

      // Simulate error result
      freshProcess.stdout.emit('data', Buffer.from(JSON.stringify({
        type: 'result',
        subtype: 'error',
        result: 'Compaction failed: internal error',
        is_error: true,
      }) + '\n'));

      await expect(compactPromise).rejects.toThrow('Compaction failed');

      freshProcess.emit('exit', 0, null);
      freshProcess.emit('close', 0, null);
      await new Promise(resolve => setTimeout(resolve, 100));
      await testExecutor.destroy();
    }, 10000);
  });

  describe('model selection', () => {
    it('passes --model to spawn args when constructed with a model', async () => {
      const freshMockProcess = new EventEmitter() as any;
      freshMockProcess.stdout = new EventEmitter();
      freshMockProcess.stderr = new EventEmitter();
      freshMockProcess.stdin = { write: vi.fn(), end: vi.fn() };
      freshMockProcess.kill = vi.fn();
      freshMockProcess.pid = 66666;
      mockSpawn.mockReturnValue(freshMockProcess);

      const modelExecutor = new ClaudePersistentExecutor(directoryGuard, '~/test-project', 'thread-1', 'opus');

      const executePromise = modelExecutor.execute('hello');
      await new Promise(resolve => setTimeout(resolve, 1100));

      expect(mockSpawn).toHaveBeenCalledWith(
        'claude',
        expect.arrayContaining(['--model', 'opus']),
        expect.any(Object)
      );

      freshMockProcess.stdout.emit('data', Buffer.from(JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'opus-session',
        cwd: '/home/user/test-project',
      }) + '\n'));
      freshMockProcess.stdout.emit('data', Buffer.from(JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'hi',
        is_error: false,
      }) + '\n'));

      await executePromise;
      freshMockProcess.emit('exit', 0, null);
      freshMockProcess.emit('close', 0, null);
      await new Promise(resolve => setTimeout(resolve, 100));
      await modelExecutor.destroy();
    }, 10000);

    it('does not add --model to spawn args when no model is configured', async () => {
      const freshMockProcess = new EventEmitter() as any;
      freshMockProcess.stdout = new EventEmitter();
      freshMockProcess.stderr = new EventEmitter();
      freshMockProcess.stdin = { write: vi.fn(), end: vi.fn() };
      freshMockProcess.kill = vi.fn();
      freshMockProcess.pid = 77777;
      mockSpawn.mockReturnValue(freshMockProcess);

      const noModelExecutor = new ClaudePersistentExecutor(directoryGuard, '~/test-project');

      const executePromise = noModelExecutor.execute('hello');
      await new Promise(resolve => setTimeout(resolve, 1100));

      const spawnCalls = mockSpawn.mock.calls;
      const lastCall = spawnCalls[spawnCalls.length - 1];
      expect(lastCall[1]).not.toContain('--model');

      freshMockProcess.stdout.emit('data', Buffer.from(JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'no-model-session',
        cwd: '/home/user/test-project',
      }) + '\n'));
      freshMockProcess.stdout.emit('data', Buffer.from(JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'hi',
        is_error: false,
      }) + '\n'));

      await executePromise;
      freshMockProcess.emit('exit', 0, null);
      freshMockProcess.emit('close', 0, null);
      await new Promise(resolve => setTimeout(resolve, 100));
      await noModelExecutor.destroy();
    }, 10000);
  });

  describe('setModel()', () => {
    it('sends /model <name> as a slash command to stdin', async () => {
      const testExecutor = new ClaudePersistentExecutor(directoryGuard, '~/test-project');

      const freshProcess = new EventEmitter() as any;
      freshProcess.stdout = new EventEmitter();
      freshProcess.stderr = new EventEmitter();
      freshProcess.stdin = { write: vi.fn(), end: vi.fn() };
      freshProcess.kill = vi.fn();
      freshProcess.pid = 44444;
      mockSpawn.mockReturnValue(freshProcess);

      const setModelPromise = testExecutor.setModel('opus');

      await new Promise(resolve => setTimeout(resolve, 1100));

      freshProcess.stdout.emit('data', Buffer.from(JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'model-session',
        cwd: '/home/user/test-project',
      }) + '\n'));

      expect(freshProcess.stdin.write).toHaveBeenCalled();
      const writtenArg = freshProcess.stdin.write.mock.calls[0][0] as string;
      const parsed = JSON.parse(writtenArg.trim());
      expect(parsed.isSlashCommand).toBe(true);
      expect(parsed.message.content).toBe('/model opus');

      freshProcess.stdout.emit('data', Buffer.from(JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'Model set to opus.',
        is_error: false,
      }) + '\n'));

      const result = await setModelPromise;
      expect(result.success).toBe(true);

      freshProcess.emit('exit', 0, null);
      freshProcess.emit('close', 0, null);
      await new Promise(resolve => setTimeout(resolve, 100));
      await testExecutor.destroy();
    }, 10000);

    it('includes --model in spawn args for the next process start after setModel', async () => {
      const testExecutor = new ClaudePersistentExecutor(directoryGuard, '~/test-project');

      const freshProcess = new EventEmitter() as any;
      freshProcess.stdout = new EventEmitter();
      freshProcess.stderr = new EventEmitter();
      freshProcess.stdin = { write: vi.fn(), end: vi.fn() };
      freshProcess.kill = vi.fn();
      freshProcess.pid = 55555;
      mockSpawn.mockReturnValue(freshProcess);

      const setModelPromise = testExecutor.setModel('haiku');
      await new Promise(resolve => setTimeout(resolve, 1100));

      expect(mockSpawn).toHaveBeenCalledWith(
        'claude',
        expect.arrayContaining(['--model', 'haiku']),
        expect.any(Object)
      );

      freshProcess.stdout.emit('data', Buffer.from(JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'haiku-session',
        cwd: '/home/user/test-project',
      }) + '\n'));
      freshProcess.stdout.emit('data', Buffer.from(JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'Model set to haiku.',
        is_error: false,
      }) + '\n'));

      await setModelPromise;
      freshProcess.emit('exit', 0, null);
      freshProcess.emit('close', 0, null);
      await new Promise(resolve => setTimeout(resolve, 100));
      await testExecutor.destroy();
    }, 10000);
  });

  describe('compactWhenFull()', () => {
    it('should return error when no active session exists', async () => {
      // When session file doesn't exist, sessionId will be null
      mockFs.existsSync.mockReturnValue(false);
      const noSessionExecutor = new ClaudePersistentExecutor(directoryGuard, '~/test-project');

      const result = await noSessionExecutor.compactWhenFull();

      expect(result.success).toBe(false);
      expect(result.error).toContain('No active session');
      await noSessionExecutor.destroy();
    });

    it('should run external compact, reload session, and restart', async () => {
      // Constructor reads session from disk via loadSessionId() — mock returns 'test-session'
      // No persistent process is running (constructor doesn't spawn one)
      // So stopProcess() returns immediately

      const compactProcess = new EventEmitter() as any;
      compactProcess.stdout = new EventEmitter();
      compactProcess.stderr = new EventEmitter();
      compactProcess.stdin = { write: vi.fn(), end: vi.fn() };
      compactProcess.kill = vi.fn();
      compactProcess.pid = 22222;

      const restartProcess = new EventEmitter() as any;
      restartProcess.stdout = new EventEmitter();
      restartProcess.stderr = new EventEmitter();
      restartProcess.stdin = { write: vi.fn(), end: vi.fn() };
      restartProcess.kill = vi.fn();
      restartProcess.pid = 33333;

      mockSpawn
        .mockReturnValueOnce(compactProcess)   // external compact (first spawn)
        .mockReturnValueOnce(restartProcess);  // restart after compact (second spawn)

      const testExecutor = new ClaudePersistentExecutor(directoryGuard, '~/test-project');
      // sessionId = 'test-session' from mockFs.readFileSync default

      const compactPromise = testExecutor.compactWhenFull();

      // Compact process emits output and exits successfully
      await new Promise(resolve => setTimeout(resolve, 10));
      compactProcess.stdout.emit('data', Buffer.from('Compacted successfully.\n'));
      compactProcess.emit('exit', 0, null);
      compactProcess.emit('close', 0, null);

      // After compact, loadSessionId() re-reads from disk — return new session
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ id: 'new-compacted-session' }));

      // startProcess() waits 1000ms internally; let it complete
      const result = await compactPromise;

      expect(result.success).toBe(true);
      expect(result.output).toContain('Compacted');

      // Verify external compact spawned with --resume and --print
      expect(mockSpawn).toHaveBeenCalledTimes(2);
      const compactCall = mockSpawn.mock.calls[0];
      expect(compactCall[1]).toContain('--resume');
      expect(compactCall[1]).toContain('test-session');
      expect(compactCall[1]).toContain('--print');
      expect(compactCall[1]).toContain('/compact');

      restartProcess.emit('exit', 0, null);
      restartProcess.emit('close', 0, null);
      await testExecutor.destroy();
    }, 10000);

    it('should restart process if external compact fails', async () => {
      // No persistent process running — stopProcess() returns immediately
      const failingCompactProcess = new EventEmitter() as any;
      failingCompactProcess.stdout = new EventEmitter();
      failingCompactProcess.stderr = new EventEmitter();
      failingCompactProcess.stdin = { write: vi.fn(), end: vi.fn() };
      failingCompactProcess.kill = vi.fn();
      failingCompactProcess.pid = 55555;

      const restartProcess = new EventEmitter() as any;
      restartProcess.stdout = new EventEmitter();
      restartProcess.stderr = new EventEmitter();
      restartProcess.stdin = { write: vi.fn(), end: vi.fn() };
      restartProcess.kill = vi.fn();
      restartProcess.pid = 66666;

      mockSpawn
        .mockReturnValueOnce(failingCompactProcess)
        .mockReturnValueOnce(restartProcess);

      const testExecutor = new ClaudePersistentExecutor(directoryGuard, '~/test-project');

      const compactPromise = testExecutor.compactWhenFull();

      // Compact process fails (non-zero exit)
      await new Promise(resolve => setTimeout(resolve, 10));
      failingCompactProcess.emit('exit', 1, null);
      failingCompactProcess.emit('close', 1, null);

      const result = await compactPromise;

      expect(result.success).toBe(false);
      expect(result.error).toContain('code 1');

      // Verify process was restarted despite compact failure
      expect(mockSpawn).toHaveBeenCalledTimes(2);

      restartProcess.emit('exit', 0, null);
      restartProcess.emit('close', 0, null);
      await testExecutor.destroy();
    }, 10000);

    it('should stream compact output to onStream callback', async () => {
      // No persistent process running — stopProcess() returns immediately
      const compactProcess = new EventEmitter() as any;
      compactProcess.stdout = new EventEmitter();
      compactProcess.stderr = new EventEmitter();
      compactProcess.stdin = { write: vi.fn(), end: vi.fn() };
      compactProcess.kill = vi.fn();
      compactProcess.pid = 88888;

      const restartProcess = new EventEmitter() as any;
      restartProcess.stdout = new EventEmitter();
      restartProcess.stderr = new EventEmitter();
      restartProcess.stdin = { write: vi.fn(), end: vi.fn() };
      restartProcess.kill = vi.fn();
      restartProcess.pid = 99999;

      mockSpawn
        .mockReturnValueOnce(compactProcess)
        .mockReturnValueOnce(restartProcess);

      const testExecutor = new ClaudePersistentExecutor(directoryGuard, '~/test-project');

      const chunks: string[] = [];
      const compactPromise = testExecutor.compactWhenFull((chunk) => chunks.push(chunk));

      await new Promise(resolve => setTimeout(resolve, 10));
      compactProcess.stdout.emit('data', Buffer.from('Summarizing...'));
      compactProcess.stdout.emit('data', Buffer.from('Done.'));
      compactProcess.emit('exit', 0, null);
      compactProcess.emit('close', 0, null);

      await compactPromise;

      expect(chunks).toContain('Summarizing...');
      expect(chunks).toContain('Done.');

      restartProcess.emit('exit', 0, null);
      restartProcess.emit('close', 0, null);
      await testExecutor.destroy();
    }, 10000);
  });
});
