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
  },
  existsSync: vi.fn(() => true),  // Default to true for working directory checks
  readFileSync: vi.fn(() => JSON.stringify({ id: 'test-session' })),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(),
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
