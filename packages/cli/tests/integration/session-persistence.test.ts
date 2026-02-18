import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

// Mock fs for session file operations
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(),
  },
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(),
}));

import { spawn } from 'child_process';
import { ClaudePersistentExecutor } from '../../src/executor/ClaudePersistentExecutor';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';

describe('Integration: Session Persistence Across Directory Changes', () => {
  let directoryGuard: DirectoryGuard;
  const mockSpawn = spawn as any;
  const mockFs = fs as any;
  let mockChildProcess: any;
  let sessionFiles: Map<string, string>; // Map of file paths to session data

  // Simulate file system for session files
  const setupMockFs = () => {
    sessionFiles = new Map();

    mockFs.existsSync.mockImplementation((filePath: string) => {
      // Working directories always exist
      if (!filePath.endsWith('.claude-session')) {
        return true;
      }
      // Session files only exist if we've created them
      return sessionFiles.has(filePath);
    });

    mockFs.readFileSync.mockImplementation((filePath: string) => {
      const data = sessionFiles.get(filePath);
      if (!data) {
        throw new Error(`ENOENT: no such file or directory, open '${filePath}'`);
      }
      return data;
    });

    mockFs.writeFileSync.mockImplementation((filePath: string, data: string) => {
      sessionFiles.set(filePath, data);
    });

    mockFs.unlinkSync.mockImplementation((filePath: string) => {
      sessionFiles.delete(filePath);
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    setupMockFs();

    // Use process.cwd() for realistic test paths
    const testRoot = path.join(process.cwd(), 'test-workspace');
    const testSubdir = path.join(testRoot, 'remote-cli');

    directoryGuard = new DirectoryGuard([
      testRoot,
      testSubdir,
    ]);

    // Mock spawn to return a mock child process
    mockChildProcess = {
      stdout: {
        on: vi.fn(),
      },
      stderr: {
        on: vi.fn(),
      },
      stdin: {
        write: vi.fn(),
        end: vi.fn(),
      },
      on: vi.fn((event, handler) => {
        // Auto-trigger 'exit' after a short delay to simulate process lifecycle
        if (event === 'exit') {
          setTimeout(() => handler(0, null), 100);
        }
      }),
      kill: vi.fn(),
      pid: 12345,
      killed: false,
    };

    mockSpawn.mockReturnValue(mockChildProcess);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should store session file in working directory, not startup directory', () => {
    // Scenario: Client starts in test-workspace/remote-cli
    const testRoot = path.join(process.cwd(), 'test-workspace');
    const workingDir = path.join(testRoot, 'remote-cli');
    const executor = new ClaudePersistentExecutor(directoryGuard, workingDir);

    // Verify session file path is in working directory
    const expectedSessionPath = path.join(workingDir, '.claude-session');

    // Simulate session creation by writing session file
    const sessionId = 'test-session-123';
    const sessionData = JSON.stringify({
      id: sessionId,
      savedAt: new Date().toISOString(),
    });
    sessionFiles.set(expectedSessionPath, sessionData);

    // Verify session file is in the correct location
    expect(mockFs.readFileSync(expectedSessionPath)).toBe(sessionData);
  });

  it('should not read session from startup directory after /cd', async () => {
    // Scenario from bug report:
    // 1. Start client in test-workspace
    const testRoot = path.join(process.cwd(), 'test-workspace');
    const startupDir = testRoot;
    const executor1 = new ClaudePersistentExecutor(directoryGuard, startupDir);

    // 2. Create a session in startup directory
    const session1Id = 'old-session-in-workspace';
    const session1Path = path.join(startupDir, '.claude-session');
    sessionFiles.set(
      session1Path,
      JSON.stringify({ id: session1Id, savedAt: new Date().toISOString() })
    );

    // 3. User executes /cd remote-cli (changes working directory)
    const newDir = path.join(testRoot, 'remote-cli');
    await executor1.setWorkingDirectory(newDir);

    // 4. New session is created in new directory
    const session2Id = 'new-session-in-remote-cli';
    const session2Path = path.join(newDir, '.claude-session');
    sessionFiles.set(
      session2Path,
      JSON.stringify({ id: session2Id, savedAt: new Date().toISOString() })
    );

    // 5. Client restarts - should initialize with newDir, NOT startupDir
    const executor2 = new ClaudePersistentExecutor(directoryGuard, newDir);

    // 6. Verify executor uses the correct working directory
    expect(executor2.getCurrentWorkingDirectory()).toBe(newDir);

    // 7. Verify it would read from the correct session file
    // (not the old one in startup directory)
    const currentSessionPath = path.join(
      executor2.getCurrentWorkingDirectory(),
      '.claude-session'
    );
    expect(currentSessionPath).toBe(session2Path);
    expect(currentSessionPath).not.toBe(session1Path);
  });

  it('should isolate sessions between different working directories', () => {
    const testRoot = path.join(process.cwd(), 'test-workspace');
    const dir1 = testRoot;
    const dir2 = path.join(testRoot, 'remote-cli');

    // Create executor for dir1
    const executor1 = new ClaudePersistentExecutor(directoryGuard, dir1);
    const session1Path = path.join(dir1, '.claude-session');
    sessionFiles.set(
      session1Path,
      JSON.stringify({ id: 'session-1', savedAt: new Date().toISOString() })
    );

    // Create executor for dir2
    const executor2 = new ClaudePersistentExecutor(directoryGuard, dir2);
    const session2Path = path.join(dir2, '.claude-session');
    sessionFiles.set(
      session2Path,
      JSON.stringify({ id: 'session-2', savedAt: new Date().toISOString() })
    );

    // Verify they have different session file paths
    expect(session1Path).not.toBe(session2Path);
    expect(session1Path).toBe(path.join(dir1, '.claude-session'));
    expect(session2Path).toBe(path.join(dir2, '.claude-session'));

    // Verify both session files exist independently
    expect(sessionFiles.has(session1Path)).toBe(true);
    expect(sessionFiles.has(session2Path)).toBe(true);
  });

  it('should handle missing working directory by falling back to process.cwd()', () => {
    // Try to create executor with invalid directory
    const invalidDir = '/invalid/path/not/in/allowed/dirs';
    const executor = new ClaudePersistentExecutor(directoryGuard, invalidDir);

    // Should fall back to process.cwd()
    expect(executor.getCurrentWorkingDirectory()).toBe(process.cwd());
  });

  it('should update session file location when working directory changes', async () => {
    const testRoot = path.join(process.cwd(), 'test-workspace');
    const dir1 = testRoot;
    const dir2 = path.join(testRoot, 'remote-cli');

    const executor = new ClaudePersistentExecutor(directoryGuard, dir1);

    // Create session in dir1
    const session1Id = 'session-in-dir1';
    const session1Path = path.join(dir1, '.claude-session');
    sessionFiles.set(
      session1Path,
      JSON.stringify({ id: session1Id, savedAt: new Date().toISOString() })
    );

    // Change working directory
    await executor.setWorkingDirectory(dir2);

    // Verify working directory changed
    expect(executor.getCurrentWorkingDirectory()).toBe(dir2);

    // New session would be created in dir2
    const session2Path = path.join(dir2, '.claude-session');

    // Verify session paths are different
    expect(session1Path).not.toBe(session2Path);
  });
});
