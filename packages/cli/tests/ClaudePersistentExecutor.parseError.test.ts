/**
 * Unit tests for error message parsing in ClaudePersistentExecutor
 */
import { describe, it, expect } from 'vitest';
import { ClaudePersistentExecutor } from '../src/executor/ClaudePersistentExecutor';
import { DirectoryGuard } from '../src/security/DirectoryGuard';

describe('ClaudePersistentExecutor - Error Message Parsing', () => {
  // Access private method for testing
  function parseErrorMessage(executor: ClaudePersistentExecutor, code: number | null, stderr: string): string {
    // @ts-expect-error - accessing private method for testing
    return executor.parseErrorMessage(code, stderr);
  }

  it('should return friendly message for session not found error', () => {
    const executor = new ClaudePersistentExecutor(new DirectoryGuard(['/']), '/tmp');
    const stderr = 'Error: Session not found: 550e8400-e29b-41d4-a716-446655440000\nPlease check your session ID or start a new session.';

    const message = parseErrorMessage(executor, 1, stderr);

    expect(message).toContain('❌ Session not found');
    expect(message).toContain('previous session may have expired');
    expect(message).toContain('/clear');
  });

  it('should return friendly message for session errors', () => {
    const executor = new ClaudePersistentExecutor(new DirectoryGuard(['/']), '/tmp');
    const stderr = 'Error: Invalid session error occurred';

    const message = parseErrorMessage(executor, 1, stderr);

    expect(message).toContain('❌ Session error occurred');
    expect(message).toContain('/clear');
  });

  it('should return friendly message for authentication errors', () => {
    const executor = new ClaudePersistentExecutor(new DirectoryGuard(['/']), '/tmp');
    const stderr = 'Error: authentication failed';

    const message = parseErrorMessage(executor, 1, stderr);

    expect(message).toContain('❌ Authentication error');
    expect(message).toContain('claude auth login');
  });

  it('should return friendly message for network errors', () => {
    const executor = new ClaudePersistentExecutor(new DirectoryGuard(['/']), '/tmp');
    const stderr = 'Error: network connection failed';

    const message = parseErrorMessage(executor, 1, stderr);

    expect(message).toContain('❌ Network connection error');
    expect(message).toContain('internet connection');
  });

  it('should return generic error with stderr content', () => {
    const executor = new ClaudePersistentExecutor(new DirectoryGuard(['/']), '/tmp');
    const stderr = 'Some random error message that does not match any pattern';

    const message = parseErrorMessage(executor, 1, stderr);

    expect(message).toContain('❌ Claude process exited with error');
    expect(message).toContain('Some random error message');
  });

  it('should truncate very long stderr messages', () => {
    const executor = new ClaudePersistentExecutor(new DirectoryGuard(['/']), '/tmp');
    const longError = 'A'.repeat(600);

    const message = parseErrorMessage(executor, 1, longError);

    expect(message.length).toBeLessThan(600);
    expect(message).toContain('(truncated)');
  });

  it('should return generic error without stderr', () => {
    const executor = new ClaudePersistentExecutor(new DirectoryGuard(['/']), '/tmp');

    const message = parseErrorMessage(executor, 1, '');

    expect(message).toContain('❌ Claude process exited unexpectedly');
    expect(message).toContain('/clear');
    expect(message).toContain('try again');
  });
});
