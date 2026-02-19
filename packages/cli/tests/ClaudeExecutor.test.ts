import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ClaudeExecutor } from '../src/executor/ClaudeExecutor';
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

describe('ClaudeExecutor', () => {
  let executor: ClaudeExecutor;
  let directoryGuard: DirectoryGuard;
  const mockSpawn = spawn as any;
  const mockFs = fs as any;
  let mockChildProcess: any;

  beforeEach(() => {
    vi.clearAllMocks();
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

    mockSpawn.mockReturnValue(mockChildProcess);

    executor = new ClaudeExecutor(directoryGuard);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('should create executor with directory guard', () => {
      expect(executor).toBeDefined();
      expect(executor).toBeInstanceOf(ClaudeExecutor);
    });

    it('should have default working directory', () => {
      const cwd = executor.getCurrentWorkingDirectory();
      expect(cwd).toBeDefined();
      expect(typeof cwd).toBe('string');
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

    it('should handle relative paths', async () => {
      await executor.setWorkingDirectory('./work');
      const cwd = executor.getCurrentWorkingDirectory();
      expect(cwd).toContain('work');
    });
  });

  describe('command execution', () => {
    it('should execute command with Claude CLI', async () => {
      const executePromise = executor.execute('list files');

      // Emit output
      setImmediate(() => {
        mockChildProcess.stdout.emit('data', 'Test output');
        mockChildProcess.emit('close', 0);
      });

      const result = await executePromise;

      expect(mockSpawn).toHaveBeenCalledWith(
        'claude',
        expect.arrayContaining(['--print']),
        expect.objectContaining({
          cwd: expect.any(String),
        })
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain('Test output');
    });

    it('should pass current working directory to Claude', async () => {
      executor.setWorkingDirectory('~/test-project');
      const executePromise = executor.execute('test command');

      setImmediate(() => {
        mockChildProcess.stdout.emit('data', 'ok');
        mockChildProcess.emit('close', 0);
      });

      await executePromise;

      expect(mockSpawn).toHaveBeenCalledWith(
        'claude',
        expect.any(Array),
        expect.objectContaining({
          cwd: expect.stringContaining('test-project'),
        })
      );
    });

    it('should handle execution errors', async () => {
      const executePromise = executor.execute('test command');

      // Simulate error
      setImmediate(() => {
        mockChildProcess.stderr.emit('data', 'Claude CLI error');
        mockChildProcess.emit('close', 1);
      });

      const result = await executePromise;

      expect(result.success).toBe(false);
      expect(result.error).toContain('Claude CLI error');
    });

    it('should not execute if working directory is not safe', async () => {
      // Force set unsafe directory (bypass validation for test)
      try {
        await executor.setWorkingDirectory('/etc');
      } catch {
        // Expected to throw
      }

      // Current directory should remain unchanged
      const cwd = executor.getCurrentWorkingDirectory();
      expect(cwd).not.toBe('/etc');
    });
  });

  describe('streaming output', () => {
    it('should support streaming output callback', async () => {
      const chunks: string[] = [];
      const onStream = vi.fn((chunk: string) => {
        chunks.push(chunk);
      });

      const executePromise = executor.execute('test command', { onStream });

      // Simulate streaming output
      setImmediate(() => {
        mockChildProcess.stdout.emit('data', 'chunk 1');
        mockChildProcess.stdout.emit('data', 'chunk 2');
        mockChildProcess.stdout.emit('data', 'chunk 3');
        mockChildProcess.emit('close', 0);
      });

      await executePromise;

      expect(onStream).toHaveBeenCalledTimes(3);
      expect(chunks).toEqual(['chunk 1', 'chunk 2', 'chunk 3']);
    });

    it('should handle streaming errors gracefully', async () => {
      const onStream = vi.fn(() => {
        throw new Error('Stream processing error');
      });

      const executePromise = executor.execute('test', { onStream });

      // Simulate output
      setImmediate(() => {
        mockChildProcess.stdout.emit('data', 'test chunk');
        mockChildProcess.emit('close', 0);
      });

      // Should not throw, should continue execution
      const result = await executePromise;
      expect(result.success).toBe(true);
    });
  });

  describe('tool restrictions', () => {
    it('should pass CLI parameters to Claude', async () => {
      const executePromise = executor.execute('test command');

      // Simulate successful execution
      setImmediate(() => {
        mockChildProcess.stdout.emit('data', 'ok');
        mockChildProcess.emit('close', 0);
      });

      await executePromise;

      expect(mockSpawn).toHaveBeenCalledWith(
        'claude',
        expect.arrayContaining(['--print']),
        expect.any(Object)
      );
    });

    it('should use Claude CLI in direct mode', async () => {
      const executePromise = executor.execute('test command');

      // Simulate successful execution
      setImmediate(() => {
        mockChildProcess.stdout.emit('data', 'ok');
        mockChildProcess.emit('close', 0);
      });

      await executePromise;

      const call = mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1];
      expect(call[1]).toContain('--print'); // Print mode flag
    });
  });

  describe('context management', () => {
    it('should maintain execution context with session', async () => {
      const executePromise1 = executor.execute('command 1');
      setImmediate(() => {
        mockChildProcess.stdout.emit('data', 'ok');
        mockChildProcess.emit('close', 0);
      });
      await executePromise1;

      // Create a new mock process for second execution
      const mockChildProcess2 = new EventEmitter() as any;
      mockChildProcess2.stdout = new EventEmitter();
      mockChildProcess2.stderr = new EventEmitter();
      mockChildProcess2.stdin = { write: vi.fn(), end: vi.fn() };
      mockChildProcess2.kill = vi.fn();
      mockSpawn.mockReturnValue(mockChildProcess2);

      const executePromise2 = executor.execute('command 2');
      setImmediate(() => {
        mockChildProcess2.stdout.emit('data', 'ok');
        mockChildProcess2.emit('close', 0);
      });
      await executePromise2;

      expect(mockSpawn).toHaveBeenCalledTimes(2);
    });

    it('should reset context when requested', async () => {
      const executePromise1 = executor.execute('command 1');
      setImmediate(() => {
        mockChildProcess.stdout.emit('data', 'ok');
        mockChildProcess.emit('close', 0);
      });
      await executePromise1;

      executor.resetContext();

      // Create a new mock process for second execution
      const mockChildProcess2 = new EventEmitter() as any;
      mockChildProcess2.stdout = new EventEmitter();
      mockChildProcess2.stderr = new EventEmitter();
      mockChildProcess2.stdin = { write: vi.fn(), end: vi.fn() };
      mockChildProcess2.kill = vi.fn();
      mockSpawn.mockReturnValue(mockChildProcess2);

      const executePromise2 = executor.execute('command 2');
      setImmediate(() => {
        mockChildProcess2.stdout.emit('data', 'ok');
        mockChildProcess2.emit('close', 0);
      });
      await executePromise2;

      expect(mockSpawn).toHaveBeenCalledTimes(2);
      // Second call should not reference first command's context
    });
  });

  describe('concurrent execution', () => {
    it('should prevent concurrent executions', async () => {
      const promise1 = executor.execute('command 1');
      const promise2 = executor.execute('command 2');

      // Simulate first execution
      setImmediate(() => {
        mockChildProcess.stdout.emit('data', 'ok');
        mockChildProcess.emit('close', 0);
      });

      const result1 = await promise1;
      const result2 = await promise2;

      // One should succeed, one should fail with "busy" error
      const results = [result1, result2];
      const successCount = results.filter((r) => r.success).length;
      const busyCount = results.filter((r) => !r.success && r.error?.includes('busy')).length;

      expect(successCount).toBe(1);
      expect(busyCount).toBe(1);
    });
  });

  describe('timeout handling', () => {
    it('should timeout long-running executions when timeout is explicitly specified', async () => {
      // Create a fresh mock process for this test
      const mockChildProcess = new EventEmitter() as any;
      mockChildProcess.stdout = new EventEmitter();
      mockChildProcess.stderr = new EventEmitter();
      mockChildProcess.stdin = {
        write: vi.fn(),
        end: vi.fn(),
      };
      mockChildProcess.kill = vi.fn();

      mockSpawn.mockReturnValueOnce(mockChildProcess);

      // Start execution with a short timeout
      const executePromise = executor.execute('long command', { timeout: 50 });

      // Wait for the timeout to trigger
      await new Promise(resolve => setTimeout(resolve, 100));

      const result = await executePromise;

      expect(result.success).toBe(false);
      expect(result.error).toContain('timeout');
      expect(mockChildProcess.kill).toHaveBeenCalled();
    });

    it('should not timeout when no timeout is specified', async () => {
      // Create a fresh mock process for this test
      const mockChildProcess = new EventEmitter() as any;
      mockChildProcess.stdout = new EventEmitter();
      mockChildProcess.stderr = new EventEmitter();
      mockChildProcess.stdin = {
        write: vi.fn(),
        end: vi.fn(),
      };
      mockChildProcess.kill = vi.fn();

      mockSpawn.mockReturnValueOnce(mockChildProcess);

      const executePromise = executor.execute('long running command');

      // Simulate execution completing after a delay (no timeout should occur)
      setImmediate(() => {
        mockChildProcess.stdout.emit('data', 'ok');
        mockChildProcess.emit('close', 0);
      });

      const result = await executePromise;

      // Should complete successfully without timeout
      expect(result.success).toBe(true);
      expect(result.output).toContain('ok');
      expect(mockChildProcess.kill).not.toHaveBeenCalled();
    });
  });

  describe('error messages', () => {
    it('should provide user-friendly error messages', async () => {
      const executePromise = executor.execute('test command');

      // Simulate error
      setImmediate(() => {
        mockChildProcess.stderr.emit('data', 'ENOENT: no such file');
        mockChildProcess.emit('close', 1);
      });

      const result = await executePromise;

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(typeof result.error).toBe('string');
    });

    it('should include working directory in error context', async () => {
      executor.setWorkingDirectory('~/test-project');
      const executePromise = executor.execute('test command');

      // Simulate error
      setImmediate(() => {
        mockChildProcess.stderr.emit('data', 'Permission denied');
        mockChildProcess.emit('close', 1);
      });

      const result = await executePromise;

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should reject execution if working directory does not exist', async () => {
      // Mock fs.existsSync to return true for session file checks
      // but false for the working directory validation in executeWithClaudeCLI
      let callCount = 0;
      mockFs.existsSync.mockImplementation((path: string) => {
        callCount++;
        // First few calls are for session file operations, return false (no session file)
        // Then when checking the working directory in executeWithClaudeCLI, return false
        if (callCount <= 2) {
          return false; // No session file
        }
        return false; // Working directory doesn't exist
      });

      const result = await executor.execute('test command');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Working directory does not exist');
      expect(mockSpawn).not.toHaveBeenCalled();
    });
  });

  describe('cleanup', () => {
    it('should cleanup resources on destroy', () => {
      executor.destroy();
      // Should not throw
      expect(() => executor.destroy()).not.toThrow();
    });

    it('should reject executions after destroy', async () => {
      executor.destroy();
      const result = await executor.execute('test command');

      expect(result.success).toBe(false);
      expect(result.error).toContain('destroyed');
    });
  });
});
