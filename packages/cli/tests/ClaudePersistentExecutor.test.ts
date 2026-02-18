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
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(),
  },
  existsSync: vi.fn(() => true),  // Default to true for working directory checks
  readFileSync: vi.fn(),
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
    mockFs.readFileSync.mockReturnValue('undefined');  // Default: no session file data

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
});
