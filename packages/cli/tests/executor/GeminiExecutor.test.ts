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
    mockPrompt.mockResolvedValue({ sessionId: 'mock-session-id', stopReason: 'end_turn' });
    mockNewSession.mockResolvedValue('mock-session-id');
    mockSetSessionMode.mockResolvedValue(undefined);
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
});
