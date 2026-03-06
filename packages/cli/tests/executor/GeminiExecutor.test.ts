import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { GeminiExecutor } from '../../src/executor/GeminiExecutor';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';

// Mock os module so homedir() returns tmpdir() — allows /tmp test directories to
// be treated as "inside home directory" by DirectoryGuard
vi.mock('os', async (importOriginal) => {
  const original = await importOriginal<typeof os>();
  return {
    ...original,
    homedir: () => original.tmpdir(),
  };
});

// ─── Mock AcpClient ─────────────────────────────────────────────────────────

const mockPrompt = vi.fn();
const mockSendCancel = vi.fn();
const mockDestroy = vi.fn();
const mockInitialize = vi.fn().mockResolvedValue(undefined);
const mockNewSession = vi.fn().mockResolvedValue('mock-session-id');

vi.mock('../../src/executor/acp/AcpClient', () => ({
  AcpClient: vi.fn().mockImplementation((_cmd, _args, _cwd, callbacks) => ({
    initialize: mockInitialize,
    newSession: mockNewSession,
    prompt: async (sessionId: string, promptText: string) => {
      // Simulate streaming text chunks via callback
      callbacks.onTextChunk('Hello ');
      callbacks.onTextChunk('world');
      if (callbacks.onToolCall) {
        callbacks.onToolCall('tc-1', 'read_file', 'file');
      }
      if (callbacks.onToolResult) {
        callbacks.onToolResult('tc-1', 'completed', 'file contents');
      }
      return mockPrompt(sessionId, promptText);
    },
    sendCancel: mockSendCancel,
    destroy: mockDestroy,
  })),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createExecutor(tmpDir: string): GeminiExecutor {
  const guard = new DirectoryGuard([tmpDir]);
  return new GeminiExecutor(guard, { initialWorkingDirectory: tmpDir });
}

describe('GeminiExecutor', () => {
  let tmpDir: string;
  let executor: GeminiExecutor;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-exec-test-'));
    executor = createExecutor(tmpDir);
    vi.clearAllMocks();
    mockPrompt.mockResolvedValue({ sessionId: 'mock-session-id', stopReason: 'end_turn' });
    mockNewSession.mockResolvedValue('mock-session-id');
  });

  it('should return getCurrentWorkingDirectory', () => {
    expect(executor.getCurrentWorkingDirectory()).toBe(tmpDir);
  });

  it('should stream text chunks via onStream callback', async () => {
    const onStream = vi.fn();
    const result = await executor.execute('hello', { onStream });

    expect(result.success).toBe(true);
    expect(onStream).toHaveBeenCalledWith('Hello ');
    expect(onStream).toHaveBeenCalledWith('world');
  });

  it('should accumulate output from text chunks', async () => {
    const result = await executor.execute('hello', {});
    expect(result.output).toBe('Hello world');
  });

  it('should fire onToolUse and onToolResult callbacks', async () => {
    const onToolUse = vi.fn();
    const onToolResult = vi.fn();

    await executor.execute('list files', { onToolUse, onToolResult });

    expect(onToolUse).toHaveBeenCalledWith(expect.objectContaining({ id: 'tc-1', name: 'read_file' }));
    expect(onToolResult).toHaveBeenCalledWith(expect.objectContaining({ tool_use_id: 'tc-1', is_error: false }));
  });

  it('should reuse the same session on second execute', async () => {
    await executor.execute('first', {});
    await executor.execute('second', {});

    // newSession should only be called once (on first execute)
    expect(mockNewSession).toHaveBeenCalledTimes(1);
  });

  it('should include session history context on second execute', async () => {
    await executor.execute('first question', {});
    await executor.execute('follow-up question', {});

    // Second prompt call should contain history context prefix
    const secondCall = mockPrompt.mock.calls[1];
    expect(secondCall[1]).toContain('=== PREVIOUS CONVERSATION ===');
    expect(secondCall[1]).toContain('[User]: first question');
  });

  it('should create a new session after resetContext', async () => {
    await executor.execute('first', {});
    executor.resetContext();
    await executor.execute('second', {});

    // After reset, a new session must be created
    expect(mockNewSession).toHaveBeenCalledTimes(2);
  });

  it('should not include history after resetContext', async () => {
    await executor.execute('first question', {});
    executor.resetContext();
    await executor.execute('fresh start', {});

    const secondCall = mockPrompt.mock.calls[1];
    expect(secondCall[1]).not.toContain('=== PREVIOUS CONVERSATION ===');
    expect(secondCall[1]).toBe('fresh start');
  });

  it('should destroy client and return true on abort', async () => {
    await executor.execute('task in progress', {});
    const result = await executor.abort();

    expect(result).toBe(true);
    expect(mockDestroy).toHaveBeenCalled();
  });

  it('should return false on abort when no session is active', async () => {
    const result = await executor.abort();
    expect(result).toBe(false);
  });

  it('should destroy client session on setWorkingDirectory', async () => {
    // Mocking resolveWorkingDirectory to avoid home-dir restriction in test environment
    const guard = new DirectoryGuard([tmpDir]);
    vi.spyOn(guard, 'resolveWorkingDirectory').mockReturnValue(tmpDir + '/new');

    const ex = new GeminiExecutor(guard, { initialWorkingDirectory: tmpDir });
    await ex.execute('first', {});

    await ex.setWorkingDirectory(tmpDir + '/new');

    expect(ex.getCurrentWorkingDirectory()).toBe(tmpDir + '/new');
    expect(mockDestroy).toHaveBeenCalled();
  });

  it('should reject setWorkingDirectory to disallowed path', async () => {
    await expect(
      executor.setWorkingDirectory('/etc/passwd')
    ).rejects.toThrow();
  });

  it('should destroy client on destroy()', async () => {
    await executor.execute('test', {});
    await executor.destroy();
    expect(mockDestroy).toHaveBeenCalled();
  });

  it('should handle refusal stop reason as failure', async () => {
    mockPrompt.mockResolvedValueOnce({ sessionId: 'mock-session-id', stopReason: 'refusal' });
    const result = await executor.execute('do something refused', {});
    expect(result.success).toBe(false);
  });

  it('should return error on ACP client exception', async () => {
    mockPrompt.mockRejectedValueOnce(new Error('ACP error'));
    const result = await executor.execute('failing task', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('ACP error');
  });
});
