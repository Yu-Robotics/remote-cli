import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { GeminiExecutor } from '../../src/executor/GeminiExecutor';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';

// Mock os module so homedir() and tmpdir() return paths that DirectoryGuard allows.
// On macOS, os.tmpdir() may return /var/folders/... which is blocked as a system dir.
// We resolve to the real path (e.g. /private/tmp on macOS) to avoid symlink issues.
vi.mock('os', async (importOriginal) => {
  const original = await importOriginal<typeof os>();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsSync = require('fs') as typeof import('fs');
  const realTmpDir = fsSync.realpathSync(original.tmpdir());
  return {
    ...original,
    homedir: () => realTmpDir,
    tmpdir: () => realTmpDir,
  };
});

// ─── Mock AcpClient ─────────────────────────────────────────────────────────

const mockPrompt = vi.fn();
const mockDestroy = vi.fn();
const mockInitialize = vi.fn().mockResolvedValue(undefined);
const mockNewSession = vi.fn().mockResolvedValue('mock-session-id');
const mockSetSessionMode = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/executor/acp/AcpClient', () => ({
  AcpClient: vi.fn().mockImplementation((_cmd, _args, _cwd, callbacks) => ({
    initialize: mockInitialize,
    newSession: mockNewSession,
    setSessionMode: mockSetSessionMode,
    prompt: async (sessionId: string, promptText: string) => {
      // Simulate streaming text chunks via callback
      callbacks.onTextChunk('Hello ');
      callbacks.onTextChunk('world');
      if (callbacks.onToolCall) {
        // Use real ACP kind ('read') + a file path as title
        callbacks.onToolCall('tc-1', '/src/index.ts', 'read');
      }
      if (callbacks.onToolResult) {
        callbacks.onToolResult('tc-1', 'completed', 'file contents');
      }
      return mockPrompt(sessionId, promptText);
    },
    destroy: mockDestroy,
  })),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createExecutor(tmpDir: string, autoApprove = true): GeminiExecutor {
  const guard = new DirectoryGuard([tmpDir]);
  return new GeminiExecutor(guard, { initialWorkingDirectory: tmpDir, autoApprove });
}

describe('GeminiExecutor', () => {
  let tmpDir: string;
  let executor: GeminiExecutor;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-exec-test-'));
    executor = createExecutor(tmpDir);
    vi.clearAllMocks();
    mockInitialize.mockResolvedValue(undefined);
    mockNewSession.mockResolvedValue('mock-session-id');
    mockSetSessionMode.mockResolvedValue(undefined);
    mockPrompt.mockResolvedValue({ sessionId: 'mock-session-id', stopReason: 'end_turn' });
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

    // mapAcpToolCall maps kind='read' → name='Read', input.file_path = title
    expect(onToolUse).toHaveBeenCalledWith(expect.objectContaining({ id: 'tc-1', name: 'Read' }));
    expect(onToolResult).toHaveBeenCalledWith(expect.objectContaining({ tool_use_id: 'tc-1', is_error: false }));
  });

  it('should spawn a new ACP client for each execute call', async () => {
    const { AcpClient } = await import('../../src/executor/acp/AcpClient');
    const MockAcpClient = vi.mocked(AcpClient);
    MockAcpClient.mockClear();

    await executor.execute('first', {});
    await executor.execute('second', {});

    // Each execute() spawns a new process
    expect(MockAcpClient).toHaveBeenCalledTimes(2);
    expect(mockNewSession).toHaveBeenCalledTimes(2);
  });

  it('should destroy the client after each execute call', async () => {
    await executor.execute('first', {});
    expect(mockDestroy).toHaveBeenCalledTimes(1);

    await executor.execute('second', {});
    expect(mockDestroy).toHaveBeenCalledTimes(2);
  });

  it('should include history context on second execute within same conversation', async () => {
    await executor.execute('first question', {});
    await executor.execute('follow-up question', {});

    // Second prompt call should include history from first turn
    const secondCall = mockPrompt.mock.calls[1];
    expect(secondCall[1]).toContain('=== PREVIOUS CONVERSATION ===');
    expect(secondCall[1]).toContain('first question');
    expect(secondCall[1]).toContain('follow-up question');
  });

  it('should NOT include history after resetContext', async () => {
    await executor.execute('first question', {});
    executor.resetContext();
    await executor.execute('fresh start', {});

    const secondCall = mockPrompt.mock.calls[1];
    expect(secondCall[1]).not.toContain('=== PREVIOUS CONVERSATION ===');
    expect(secondCall[1]).toBe('fresh start');
  });

  it('should reset conversation ID on setWorkingDirectory', async () => {
    await executor.execute('first question', {});

    const guard = new DirectoryGuard([tmpDir]);
    vi.spyOn(guard, 'resolveWorkingDirectory').mockReturnValue(tmpDir + '/sub');
    const ex = new GeminiExecutor(guard, { initialWorkingDirectory: tmpDir });
    await ex.execute('first', {});
    await ex.setWorkingDirectory(tmpDir + '/sub');
    await ex.execute('after dir change', {});

    // After directory change, the second executor's second call has no history
    const lastCall = mockPrompt.mock.calls[mockPrompt.mock.calls.length - 1];
    expect(lastCall[1]).not.toContain('=== PREVIOUS CONVERSATION ===');
    expect(lastCall[1]).toBe('after dir change');
  });

  it('should return true on abort when in-flight', async () => {
    // Simulate a slow prompt so inflightClient is set
    let resolvePrompt!: () => void;
    mockPrompt.mockImplementationOnce(() => new Promise<{ sessionId: string; stopReason: string }>((resolve) => {
      resolvePrompt = () => resolve({ sessionId: 'mock-session-id', stopReason: 'cancelled' });
    }));

    const executePromise = executor.execute('long task', {});
    // Allow microtasks for initialize/newSession to run
    await new Promise((r) => setTimeout(r, 10));

    const aborted = await executor.abort();
    expect(aborted).toBe(true);
    resolvePrompt();
    await executePromise;
  });

  it('should return false on abort when no in-flight request', async () => {
    const result = await executor.abort();
    expect(result).toBe(false);
  });

  it('should reject setWorkingDirectory to disallowed path', async () => {
    await expect(
      executor.setWorkingDirectory('/etc/passwd')
    ).rejects.toThrow();
  });

  it('should destroy in-flight client on destroy()', async () => {
    let resolvePrompt!: () => void;
    mockPrompt.mockImplementationOnce(() => new Promise<{ sessionId: string; stopReason: string }>((resolve) => {
      resolvePrompt = () => resolve({ sessionId: 'mock-session-id', stopReason: 'end_turn' });
    }));

    const executePromise = executor.execute('test', {});
    await new Promise((r) => setTimeout(r, 10));

    await executor.destroy();
    expect(mockDestroy).toHaveBeenCalled();
    resolvePrompt();
    await executePromise;
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

  it('should pass --yolo CLI flag when autoApprove=true', async () => {
    const { AcpClient } = await import('../../src/executor/acp/AcpClient');
    const MockAcpClient = vi.mocked(AcpClient);
    MockAcpClient.mockClear();

    const guard = new DirectoryGuard([tmpDir]);
    const ex = new GeminiExecutor(guard, { initialWorkingDirectory: tmpDir, autoApprove: true });
    await ex.execute('test', {});

    const callArgs = MockAcpClient.mock.calls[0];
    expect(callArgs[1]).toContain('--yolo'); // geminiArgs array
  });

  it('should NOT pass --yolo CLI flag when autoApprove=false', async () => {
    const { AcpClient } = await import('../../src/executor/acp/AcpClient');
    const MockAcpClient = vi.mocked(AcpClient);
    MockAcpClient.mockClear();

    const guard = new DirectoryGuard([tmpDir]);
    const ex = new GeminiExecutor(guard, { initialWorkingDirectory: tmpDir, autoApprove: false });
    await ex.execute('test', {});

    const callArgs = MockAcpClient.mock.calls[0];
    expect(callArgs[1]).not.toContain('--yolo');
  });

  it('should call setSessionMode with yolo when autoApprove=true', async () => {
    await executor.execute('test', {});
    expect(mockSetSessionMode).toHaveBeenCalledWith('mock-session-id', 'yolo');
  });

  describe('multi-thread isolation', () => {
    it('should not clear conversationId when setWorkingDirectory is called with threadId', async () => {
      const subDir = path.join(tmpDir, 'sub');
      fs.mkdirSync(subDir, { recursive: true });
      const guard = new DirectoryGuard([tmpDir, subDir]);

      // Override internal state to allow /tmp paths regardless of homeDir
      const realTmpDir = fs.realpathSync(tmpDir);
      const realSubDir = fs.realpathSync(subDir);
      (guard as any).allowedDirs = new Set([tmpDir, subDir, realTmpDir, realSubDir]);
      (guard as any).homeDir = path.dirname(tmpDir); // set homeDir to parent of tmpDir so check passes
      
      const ex = new GeminiExecutor(guard, { initialWorkingDirectory: tmpDir, threadId: 'thread-123' });
      await ex.execute('first', {});
      
      const sessionManagerRemove = vi.spyOn((ex as any).sessionManager, 'remove');
      
      await ex.setWorkingDirectory(subDir);
      
      expect((ex as any).conversationId).toBe('thread-123');
      expect(ex.getCurrentWorkingDirectory()).toBe(subDir);
      expect(sessionManagerRemove).not.toHaveBeenCalled();
    });

    it('should not clear conversationId on resetContext but should remove session file when threadId is set', async () => {
      const guard = new DirectoryGuard([tmpDir]);
      const ex = new GeminiExecutor(guard, { initialWorkingDirectory: tmpDir, threadId: 'thread-456' });
      await ex.execute('first', {});
      
      const sessionManagerRemove = vi.spyOn((ex as any).sessionManager, 'remove');
      
      ex.resetContext();
      
      expect((ex as any).conversationId).toBe('thread-456');
      expect(sessionManagerRemove).toHaveBeenCalledWith('thread-456');
    });

    it('should remove conversationId on resetContext when threadId is NOT set', async () => {
      await executor.execute('first', {});
      const convId = (executor as any).conversationId;
      expect(convId).toBeTruthy();

      const sessionManagerRemove = vi.spyOn((executor as any).sessionManager, 'remove');
      
      executor.resetContext();
      
      expect((executor as any).conversationId).toBeNull();
      expect(sessionManagerRemove).toHaveBeenCalledWith(convId);
    });

    it('deleteThreadData should remove conversation file', async () => {
      const guard = new DirectoryGuard([tmpDir]);
      const ex = new GeminiExecutor(guard, { initialWorkingDirectory: tmpDir, threadId: 'thread-789' });
      await ex.execute('first', {});

      const sessionManagerRemove = vi.spyOn((ex as any).sessionManager, 'remove');
      
      await ex.deleteThreadData!('thread-789');
      
      expect(sessionManagerRemove).toHaveBeenCalledWith('thread-789');
    });
  });

  describe('compactWhenFull()', () => {
    it('should return success with no-op message when no active conversation', async () => {
      const result = await executor.compactWhenFull!();
      expect(result.success).toBe(true);
      expect(result.output).toContain('No active conversation');
    });

    it('should truncate history and return removed count after conversation starts', async () => {
      // Build up history by executing 12 turns
      for (let i = 0; i < 6; i++) {
        await executor.execute(`question ${i}`, {});
      }

      const chunks: string[] = [];
      const result = await executor.compactWhenFull!((chunk) => chunks.push(chunk));

      expect(result.success).toBe(true);
      // 12 entries (6 user + 6 assistant) minus 10 kept = 2 removed
      expect(result.output).toContain('removed 2');
      expect(chunks.some((c) => c.includes('Truncating'))).toBe(true);
    });

    it('should return already compact message when history fits within keepCount', async () => {
      // Only 2 turns (4 entries) — well within the default 10 keep
      await executor.execute('turn 1', {});
      await executor.execute('turn 2', {});

      const result = await executor.compactWhenFull!();
      expect(result.success).toBe(true);
      expect(result.output).toContain('already compact');
    });

    it('should be discoverable via in operator (IExecutor optional method)', () => {
      expect('compactWhenFull' in executor).toBe(true);
    });
  });

  // ─── Quota fallback chain ─────────────────────────────────────────────────

  describe('quota fallback chain', () => {
    it('should retry with flash when configured model exhausts quota', async () => {
      const { AcpClient } = await import('../../src/executor/acp/AcpClient');
      const MockAcpClient = vi.mocked(AcpClient);
      MockAcpClient.mockClear();

      // First call throws quota error, second succeeds
      mockPrompt
        .mockRejectedValueOnce(new Error('You have exhausted your capacity for today'))
        .mockResolvedValueOnce({ sessionId: 'mock-session-id', stopReason: 'end_turn' });

      const onStream = vi.fn();
      const guard = new DirectoryGuard([tmpDir]);
      const ex = new GeminiExecutor(guard, { initialWorkingDirectory: tmpDir, model: 'pro' });
      const result = await ex.execute('prompt', { onStream });

      expect(result.success).toBe(true);
      // Fallback notice streamed to user
      expect(onStream).toHaveBeenCalledWith(expect.stringContaining('Quota exhausted'));
      expect(onStream).toHaveBeenCalledWith(expect.stringContaining('flash'));
      // Two ACP clients spawned (one per model attempt)
      expect(MockAcpClient).toHaveBeenCalledTimes(2);
    });

    it('should retry with flash-lite when both pro and flash exhaust quota', async () => {
      const { AcpClient } = await import('../../src/executor/acp/AcpClient');
      const MockAcpClient = vi.mocked(AcpClient);
      MockAcpClient.mockClear();

      mockPrompt
        .mockRejectedValueOnce(new Error('You have exhausted your capacity'))
        .mockRejectedValueOnce(new Error('quota exceeded'))
        .mockResolvedValueOnce({ sessionId: 'mock-session-id', stopReason: 'end_turn' });

      const guard = new DirectoryGuard([tmpDir]);
      const ex = new GeminiExecutor(guard, { initialWorkingDirectory: tmpDir, model: 'pro' });
      const result = await ex.execute('prompt', {});

      expect(result.success).toBe(true);
      expect(MockAcpClient).toHaveBeenCalledTimes(3);
    });

    it('should not retry the same model alias that is already configured', async () => {
      const { AcpClient } = await import('../../src/executor/acp/AcpClient');
      const MockAcpClient = vi.mocked(AcpClient);
      MockAcpClient.mockClear();

      // model='flash' is in the fallback list — it should be skipped so only flash-lite is tried
      mockPrompt
        .mockRejectedValueOnce(new Error('exhausted your capacity'))
        .mockResolvedValueOnce({ sessionId: 'mock-session-id', stopReason: 'end_turn' });

      const guard = new DirectoryGuard([tmpDir]);
      const ex = new GeminiExecutor(guard, { initialWorkingDirectory: tmpDir, model: 'flash' });
      const result = await ex.execute('prompt', {});

      expect(result.success).toBe(true);
      // Should only try flash (configured) + flash-lite — not flash twice
      expect(MockAcpClient).toHaveBeenCalledTimes(2);
    });

    it('should return failure with friendly error when all models exhaust quota', async () => {
      mockPrompt.mockRejectedValue(new Error('You have exhausted your capacity'));

      const guard = new DirectoryGuard([tmpDir]);
      const ex = new GeminiExecutor(guard, { initialWorkingDirectory: tmpDir, model: 'pro' });
      const result = await ex.execute('prompt', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('All Gemini models');
      expect(result.error).toContain('exhausted quota');
      expect(result.error).toContain('/backend');
    });

    it('should retry with flash on "No capacity available" ACP 500 error', async () => {
      const { AcpClient } = await import('../../src/executor/acp/AcpClient');
      const MockAcpClient = vi.mocked(AcpClient);
      MockAcpClient.mockClear();

      mockPrompt
        .mockRejectedValueOnce(new Error('ACP error 500: No capacity available for model gemini-3.1-pro-preview on the server'))
        .mockResolvedValueOnce({ sessionId: 'mock-session-id', stopReason: 'end_turn' });

      const onStream = vi.fn();
      const guard = new DirectoryGuard([tmpDir]);
      const ex = new GeminiExecutor(guard, { initialWorkingDirectory: tmpDir, model: 'pro' });
      const result = await ex.execute('prompt', { onStream });

      expect(result.success).toBe(true);
      expect(onStream).toHaveBeenCalledWith(expect.stringContaining('Quota exhausted'));
      expect(onStream).toHaveBeenCalledWith(expect.stringContaining('flash'));
      expect(MockAcpClient).toHaveBeenCalledTimes(2);
    });

    it('should exhaust all fallbacks on repeated "No capacity available" errors', async () => {
      mockPrompt.mockRejectedValue(new Error('ACP error 500: No capacity available for model gemini-3.1-pro-preview on the server'));

      const guard = new DirectoryGuard([tmpDir]);
      const ex = new GeminiExecutor(guard, { initialWorkingDirectory: tmpDir, model: 'pro' });
      const result = await ex.execute('prompt', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('All Gemini models');
      expect(result.error).toContain('/backend');
    });

    it('should NOT retry on non-quota errors', async () => {
      const { AcpClient } = await import('../../src/executor/acp/AcpClient');
      const MockAcpClient = vi.mocked(AcpClient);
      MockAcpClient.mockClear();

      mockPrompt.mockRejectedValueOnce(new Error('Network connection refused'));

      const result = await executor.execute('prompt', {});

      expect(result.success).toBe(false);
      // Only one attempt made — no fallback for non-quota errors
      expect(MockAcpClient).toHaveBeenCalledTimes(1);
      expect(result.error).toContain('Network connection refused');
    });

    it('should include quota reset hint in error when reset time is in message', async () => {
      mockPrompt.mockRejectedValue(new Error('You have exhausted your capacity. Quota will reset after 2h30m.'));

      const guard = new DirectoryGuard([tmpDir]);
      const ex = new GeminiExecutor(guard, { initialWorkingDirectory: tmpDir });
      const result = await ex.execute('prompt', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('2h30m');
    });

    it('should stream fallback notice before each retry', async () => {
      mockPrompt
        .mockRejectedValueOnce(new Error('exhausted your capacity'))
        .mockRejectedValueOnce(new Error('quota exceeded'))
        .mockResolvedValueOnce({ sessionId: 'mock-session-id', stopReason: 'end_turn' });

      const streamedChunks: string[] = [];
      const guard = new DirectoryGuard([tmpDir]);
      const ex = new GeminiExecutor(guard, { initialWorkingDirectory: tmpDir, model: 'pro' });
      await ex.execute('prompt', { onStream: (c) => streamedChunks.push(c) });

      const notices = streamedChunks.filter((c) => c.includes('Quota exhausted'));
      // Two quota failures → two notices streamed
      expect(notices).toHaveLength(2);
    });
  });

  // ─── buildFriendlyError ───────────────────────────────────────────────────

  describe('buildFriendlyError', () => {
    it('should suggest /backend switch on ENOENT error', async () => {
      mockPrompt.mockRejectedValueOnce(new Error('ENOENT: no such file or directory'));
      const result = await executor.execute('prompt', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('not installed');
      expect(result.error).toContain('/backend');
    });

    it('should suggest /backend switch on "not found" error', async () => {
      mockPrompt.mockRejectedValueOnce(new Error('command not found: gemini'));
      const result = await executor.execute('prompt', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('not installed');
      expect(result.error).toContain('/backend');
    });

    it('should return raw message for unknown errors', async () => {
      mockPrompt.mockRejectedValueOnce(new Error('Something completely unexpected'));
      const result = await executor.execute('prompt', {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Something completely unexpected');
    });

    it('should include all model names in quota exhausted error', async () => {
      mockPrompt.mockRejectedValue(new Error('exhausted your capacity'));

      const guard = new DirectoryGuard([tmpDir]);
      const ex = new GeminiExecutor(guard, { initialWorkingDirectory: tmpDir, model: 'pro' });
      const result = await ex.execute('prompt', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('pro');
      expect(result.error).toContain('flash');
      expect(result.error).toContain('flash-lite');
      expect(result.error).toContain('/backend');
    });

    it('should match quota error on "quota" keyword in message', async () => {
      mockPrompt.mockRejectedValue(new Error('API quota limit reached'));

      const result = await executor.execute('prompt', {});

      expect(result.success).toBe(false);
      // When all models exhaust quota, buildFriendlyError returns the "All Gemini models" message
      expect(result.error).toContain('All Gemini models');
      expect(result.error).toContain('/backend');
    });

    it('should extract reset time hint from error message', async () => {
      mockPrompt.mockRejectedValue(new Error('exhausted your capacity, reset after 1h'));

      const guard = new DirectoryGuard([tmpDir]);
      const ex = new GeminiExecutor(guard, { initialWorkingDirectory: tmpDir });
      const result = await ex.execute('prompt', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('1h');
    });

    it('should return friendly message on Premature close error', async () => {
      mockPrompt.mockRejectedValueOnce(new Error('ACP error 500: Premature close'));
      const result = await executor.execute('task', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('server-side issue');
      expect(result.error).toContain('/backend');
    });

    it('should not include reset hint when no reset time in message', async () => {
      mockPrompt.mockRejectedValue(new Error('exhausted your capacity'));

      const guard = new DirectoryGuard([tmpDir]);
      const ex = new GeminiExecutor(guard, { initialWorkingDirectory: tmpDir });
      const result = await ex.execute('prompt', {});

      expect(result.success).toBe(false);
      // No spurious "Quota resets in undefined" text
      expect(result.error).not.toContain('undefined');
      expect(result.error).not.toContain('resets in');
    });
  });
});
