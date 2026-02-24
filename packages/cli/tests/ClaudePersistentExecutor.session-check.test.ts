/**
 * Tests for session validation before resume in ClaudePersistentExecutor
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ClaudePersistentExecutor } from '../src/executor/ClaudePersistentExecutor';
import { DirectoryGuard } from '../src/security/DirectoryGuard';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('ClaudePersistentExecutor - Session Validation', () => {
  let tempDir: string;
  let directoryGuard: DirectoryGuard;
  let executor: ClaudePersistentExecutor;

  beforeEach(() => {
    // Create a temporary directory under the real home directory
    // so DirectoryGuard's startsWith(homeDir) check passes
    const uniqueId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    tempDir = fs.mkdtempSync(path.join(os.homedir(), `.claude-session-test-${uniqueId}-`));

    directoryGuard = new DirectoryGuard([tempDir]);

    // Mock os.homedir for consistency in session file path resolution
    vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
  });

  afterEach(async () => {
    // Cleanup
    if (executor) {
      await executor.destroy();
    }

    // Remove temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    vi.restoreAllMocks();
  });

  it('should return friendly error when resume fails with non-existent session', async () => {
    // Create executor first in the temp directory
    executor = new ClaudePersistentExecutor(directoryGuard, tempDir);

    // Create a fake session file with a non-existent session ID
    const sessionFilePath = path.join(tempDir, '.claude-session');
    const fakeSessionId = '550e8400-e29b-41d4-a716-446655440000'; // Valid UUID but non-existent
    fs.writeFileSync(
      sessionFilePath,
      JSON.stringify({
        id: fakeSessionId,
        savedAt: new Date().toISOString(),
      }),
      'utf-8'
    );

    // Manually set the session ID (simulating a load from file)
    // @ts-expect-error - accessing private field for testing
    executor.sessionId = fakeSessionId;

    // Verify session ID was set
    expect(executor.getSessionId()).toBe(fakeSessionId);

    // Execute a command - should fail with a session-related friendly error
    try {
      await executor.execute('echo "test"', { timeout: 30000 });
      expect.fail('Expected execute to throw an error');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const errorMessage = (error as Error).message;
      // Should include a friendly session error message with /clear guidance
      expect(errorMessage).toMatch(/Session not found|session.*error|No conversation found/i);
      expect(errorMessage).toContain('/clear');
    }
  }, 60000);

  it('should handle missing session file gracefully', async () => {
    // Create a fresh executor directory with no session file
    const uniqueId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const freshTempDir = fs.mkdtempSync(path.join(os.homedir(), `.claude-fresh-session-${uniqueId}-`));
    const freshGuard = new DirectoryGuard([freshTempDir]);

    try {
      executor = new ClaudePersistentExecutor(freshGuard, freshTempDir);

      // Verify no session ID initially (no .claude-session file in freshTempDir)
      expect(executor.getSessionId()).toBeNull();

      // Execute a command
      const result = await executor.execute('echo "test"', { timeout: 30000 });

      // Verify command succeeded
      expect(result.success).toBe(true);

      // Verify a new session ID was created
      const sessionId = executor.getSessionId();
      expect(sessionId).not.toBeNull();
      expect(sessionId).toBeTruthy();

      // Verify session file was created
      const sessionFilePath = path.join(freshTempDir, '.claude-session');
      expect(fs.existsSync(sessionFilePath)).toBe(true);

      const sessionData = JSON.parse(fs.readFileSync(sessionFilePath, 'utf-8'));
      expect(sessionData.id).toBe(sessionId);
    } finally {
      // Cleanup (executor is destroyed in afterEach, but freshTempDir needs manual cleanup)
      if (fs.existsSync(freshTempDir)) {
        fs.rmSync(freshTempDir, { recursive: true, force: true });
      }
    }
  }, 60000);

  it('should resume existing valid session successfully', async () => {
    // First, create a valid session by executing a command
    executor = new ClaudePersistentExecutor(directoryGuard, tempDir);

    const firstResult = await executor.execute('echo "first command"', { timeout: 30000 });
    expect(firstResult.success).toBe(true);

    const firstSessionId = executor.getSessionId();
    expect(firstSessionId).not.toBeNull();

    // Destroy and recreate executor to simulate a restart
    await executor.destroy();

    executor = new ClaudePersistentExecutor(directoryGuard, tempDir);

    // Verify session ID was loaded from file
    expect(executor.getSessionId()).toBe(firstSessionId);

    // Execute another command - should resume the same session
    const secondResult = await executor.execute('echo "second command"', { timeout: 30000 });
    expect(secondResult.success).toBe(true);

    // Verify session ID remains the same
    expect(executor.getSessionId()).toBe(firstSessionId);
  }, 90000);
});
