import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { GeminiExecutor } from '../../src/executor/GeminiExecutor';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';

// Mock os module so homedir() and tmpdir() return paths that DirectoryGuard allows.
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

// ─── Mock AcpClient ──────────────────────────────────────────────────────────

const mockPrompt = vi.fn();
const mockDestroy = vi.fn();
const mockSendCancel = vi.fn();
const mockInitialize = vi.fn().mockResolvedValue(undefined);
const mockNewSession = vi.fn().mockResolvedValue('mock-session-id');
const mockSetSessionMode = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/executor/acp/AcpClient', () => ({
  AcpClient: vi.fn().mockImplementation((_cmd, _args, _cwd, callbacks) => ({
    initialize: mockInitialize,
    newSession: mockNewSession,
    setSessionMode: mockSetSessionMode,
    sendCancel: mockSendCancel,
    prompt: async (sessionId: string, promptText: string) => {
      callbacks.onTextChunk('Hello ');
      callbacks.onTextChunk('world');
      if (callbacks.onToolCall) {
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

    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    mockInitialize.mockResolvedValue(undefined);
    mockNewSession.mockResolvedValue('mock-session-id');
    mockSetSessionMode.mockResolvedValue(undefined);
    mockPrompt.mockResolvedValue({ stopReason: 'end_turn' });
  });

  afterEach(async () => {
    await executor.destroy();
  });

  // ─── Basic functionality ──────────────────────────────────────────────────

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

    expect(onToolUse).toHaveBeenCalledWith(expect.objectContaining({ id: 'tc-1', name: 'Read' }));
    expect(onToolResult).toHaveBeenCalledWith(expect.objectContaining({ tool_use_id: 'tc-1', is_error: false }));
  });

  // ─── Persistent session core behavior ────────────────────────────────────

  it('should reuse the same ACP client across multiple execute calls', async () => {
    const { AcpClient } = await import('../../src/executor/acp/AcpClient');
    const MockAcpClient = vi.mocked(AcpClient);
    MockAcpClient.mockClear();

    await executor.execute('first', {});
    await executor.execute('second', {});
    await executor.execute('third', {});

    // Only one process spawned for all three turns
    expect(MockAcpClient).toHaveBeenCalledTimes(1);
    expect(mockNewSession).toHaveBeenCalledTimes(1);
  });

  it('should NOT destroy the client after each execute call', async () => {
    await executor.execute('first', {});
    expect(mockDestroy).not.toHaveBeenCalled();

    await executor.execute('second', {});
    expect(mockDestroy).not.toHaveBeenCalled();
  });

  it('should send prompts directly WITHOUT history prefix on subsequent execute calls', async () => {
    await executor.execute('first question', {});
    await executor.execute('follow-up question', {});

    const secondCall = mockPrompt.mock.calls[1];
    // No history prefix — just the raw prompt
    expect(secondCall[1]).toBe('follow-up question');
    expect(secondCall[1]).not.toContain('=== PREVIOUS CONVERSATION ===');
    expect(secondCall[1]).not.toContain('first question');
  });

  it('should use the same sessionId for all prompts in a session', async () => {
    await executor.execute('first', {});
    await executor.execute('second', {});

    expect(mockPrompt.mock.calls[0][0]).toBe('mock-session-id');
    expect(mockPrompt.mock.calls[1][0]).toBe('mock-session-id');
  });

  // ─── Process crash recovery ───────────────────────────────────────────────

  it('should respawn a new ACP client if the process crashes between turns', async () => {
    const { AcpClient } = await import('../../src/executor/acp/AcpClient');
    const MockAcpClient = vi.mocked(AcpClient);

    await executor.execute('first', {});

    // Simulate crash: prompt throws — executor destroys client and returns error
    mockPrompt.mockRejectedValueOnce(new Error('AcpClient destroyed'));
    await executor.execute('second (crashes)', {});

    // Now persistent client is null — next execute must respawn
    MockAcpClient.mockClear();
    mockNewSession.mockResolvedValue('new-session-id');
    mockPrompt.mockResolvedValueOnce({ stopReason: 'end_turn' });

    await executor.execute('third after crash', {});

    // A new process was spawned for the third call
    expect(MockAcpClient).toHaveBeenCalledTimes(1);
  });

  // ─── setWorkingDirectory ──────────────────────────────────────────────────

  it('should destroy persistent client on setWorkingDirectory (no threadId)', async () => {
    const subDir = path.join(tmpDir, 'sub');
    fs.mkdirSync(subDir, { recursive: true });
    const realTmpDir = fs.realpathSync(tmpDir);
    const realSubDir = fs.realpathSync(subDir);
    const guard = new DirectoryGuard([tmpDir, subDir]);
    (guard as any).allowedDirs = new Set([tmpDir, subDir, realTmpDir, realSubDir]);
    (guard as any).homeDir = path.dirname(tmpDir);
    const ex = new GeminiExecutor(guard, { initialWorkingDirectory: tmpDir });

    await ex.execute('first', {});
    expect(mockDestroy).not.toHaveBeenCalled();

    await ex.setWorkingDirectory(subDir);
    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });

  it('should destroy persistent client on setWorkingDirectory even when threadId is set (if path changes)', async () => {
    const subDir = path.join(tmpDir, 'sub');
    fs.mkdirSync(subDir, { recursive: true });
    const guard = new DirectoryGuard([tmpDir, subDir]);
    const realTmpDir = fs.realpathSync(tmpDir);
    const realSubDir = fs.realpathSync(subDir);
    (guard as any).allowedDirs = new Set([tmpDir, subDir, realTmpDir, realSubDir]);
    (guard as any).homeDir = path.dirname(tmpDir);

    const ex = new GeminiExecutor(guard, { initialWorkingDirectory: tmpDir, threadId: 'thread-123' });
    await ex.execute('first', {});

    await ex.setWorkingDirectory(subDir);
    // Now destroys on dir change to ensure subprocess is in the correct directory
    expect(mockDestroy).toHaveBeenCalledTimes(1);
    expect(ex.getCurrentWorkingDirectory()).toBe(subDir);
  });

  it('should execute prompts sequentially via command queue', async () => {
    let resolve1!: (v: { stopReason: string }) => void;
    let resolve2!: (v: { stopReason: string }) => void;

    mockPrompt
      .mockImplementationOnce(() => new Promise((r) => { resolve1 = r; }))
      .mockImplementationOnce(() => new Promise((r) => { resolve2 = r; }));

    const p1 = executor.execute('first', {});
    const p2 = executor.execute('second', {});

    // second should not have started yet (mockPrompt only called once)
    await new Promise((r) => setTimeout(r, 10));
    expect(mockPrompt).toHaveBeenCalledTimes(1);

    resolve1({ stopReason: 'end_turn' });
    await p1;

    // Now second should start
    await new Promise((r) => setTimeout(r, 10));
    expect(mockPrompt).toHaveBeenCalledTimes(2);

    resolve2({ stopReason: 'end_turn' });
    await p2;
  });

  it('should reject setWorkingDirectory to disallowed path', async () => {
    await expect(
      executor.setWorkingDirectory('/etc/passwd')
    ).rejects.toThrow();
  });

  // ─── resetContext ─────────────────────────────────────────────────────────

  it('should destroy persistent client on resetContext', async () => {
    await executor.execute('first', {});
    expect(mockDestroy).not.toHaveBeenCalled();

    executor.resetContext();
    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });

  it('should spawn a fresh client after resetContext', async () => {
    const { AcpClient } = await import('../../src/executor/acp/AcpClient');
    const MockAcpClient = vi.mocked(AcpClient);

    await executor.execute('first', {});
    executor.resetContext();
    mockPrompt.mockClear();
    MockAcpClient.mockClear();

    await executor.execute('fresh start', {});
    expect(MockAcpClient).toHaveBeenCalledTimes(1);

    // Fresh start prompt has no history prefix
    expect(mockPrompt.mock.calls[0][1]).toBe('fresh start');
  });

  // ─── abort() ─────────────────────────────────────────────────────────────

  it('should return true on abort when in-flight and send ACP cancel before force-kill', async () => {
    vi.useFakeTimers();
    const localSendCancel = vi.fn();
    let resolvePrompt!: (v: { stopReason: string }) => void;

    const { AcpClient } = await import('../../src/executor/acp/AcpClient');
    vi.mocked(AcpClient).mockImplementationOnce((_cmd, _args, _cwd, _callbacks) => ({
      initialize: mockInitialize,
      newSession: mockNewSession,
      setSessionMode: mockSetSessionMode,
      sendCancel: localSendCancel,
      prompt: () => new Promise<{ stopReason: string }>((resolve) => { resolvePrompt = resolve; }),
      destroy: mockDestroy,
    }));

    const executePromise = executor.execute('long task', {});
    await vi.advanceTimersByTimeAsync(100);

    const aborted = await executor.abort();
    expect(aborted).toBe(true);
    expect(localSendCancel).toHaveBeenCalledWith('mock-session-id');

    await vi.advanceTimersByTimeAsync(3100);

    resolvePrompt({ stopReason: 'cancelled' });
    const result = await executePromise;
    expect(result.success).toBe(false);
    vi.useRealTimers();
  });

  it('should return false on abort when no in-flight request', async () => {
    const result = await executor.abort();
    expect(result).toBe(false);
  });

  it('should preserve persistent session after abort so next execute reuses it', async () => {
    const { AcpClient } = await import('../../src/executor/acp/AcpClient');
    const MockAcpClient = vi.mocked(AcpClient);

    let resolvePrompt!: (v: { stopReason: string }) => void;
    const localPrompt = vi.fn()
      .mockImplementationOnce(() => new Promise<{ stopReason: string }>((resolve) => { resolvePrompt = resolve; }))
      .mockResolvedValue({ stopReason: 'end_turn' });

    MockAcpClient.mockImplementationOnce((_cmd, _args, _cwd, _callbacks) => ({
      initialize: mockInitialize,
      newSession: mockNewSession,
      setSessionMode: mockSetSessionMode,
      sendCancel: vi.fn(),
      prompt: localPrompt,
      destroy: mockDestroy,
    }));

    const executePromise = executor.execute('task', {});
    await new Promise((r) => setTimeout(r, 10));

    await executor.abort();
    resolvePrompt({ stopReason: 'cancelled' });
    await executePromise;

    MockAcpClient.mockClear();

    // After abort, session is preserved — next execute reuses the existing client
    await executor.execute('after abort', {});
    expect(MockAcpClient).not.toHaveBeenCalled();
    expect(mockDestroy).not.toHaveBeenCalled();
  });

  it('should not leak timer on double-abort (second abort clears first timer)', async () => {
    vi.useFakeTimers();
    const localDestroy = vi.fn();

    const { AcpClient } = await import('../../src/executor/acp/AcpClient');
    vi.mocked(AcpClient).mockImplementationOnce((_cmd, _args, _cwd, _callbacks) => ({
      initialize: mockInitialize,
      newSession: mockNewSession,
      setSessionMode: mockSetSessionMode,
      sendCancel: vi.fn(),
      prompt: () => new Promise(() => {}), // never resolves
      destroy: localDestroy,
    }));

    try {
      executor.execute('slow task', {});
      await vi.advanceTimersByTimeAsync(20);

      await executor.abort(); // first abort at T=20, timer fires at T=3020
      await vi.advanceTimersByTimeAsync(100); // advance to T=120
      await executor.abort(); // second abort at T=120, clears first timer, new timer fires at T=3120

      // Advance past T=3020 (first timer's deadline) but before T=3120 (second timer's deadline).
      // If first timer wasn't cleared, destroy would fire here.
      await vi.advanceTimersByTimeAsync(2_950); // now at T=3070 — past 3020 but before 3120
      expect(localDestroy).not.toHaveBeenCalled(); // first timer was cleared

      // Advance past T=3120 — second timer fires, force-destroy happens.
      await vi.advanceTimersByTimeAsync(100); // now at T=3170
      expect(localDestroy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should force-destroy after CANCEL_GRACE_MS if Gemini does not respond to cancel', async () => {
    const localDestroy = vi.fn();

    const { AcpClient } = await import('../../src/executor/acp/AcpClient');
    vi.mocked(AcpClient).mockImplementationOnce((_cmd, _args, _cwd, _callbacks) => ({
      initialize: vi.fn().mockResolvedValue(undefined),
      newSession: vi.fn().mockResolvedValue('mock-session-id'),
      setSessionMode: vi.fn().mockResolvedValue(undefined),
      sendCancel: vi.fn(),
      prompt: () => new Promise(() => {}), // never resolves
      destroy: localDestroy,
    }));

    executor.execute('slow task', {});
    // Wait for initialize/newSession/setSessionMode promises to settle
    await new Promise((r) => setTimeout(r, 20));

    await executor.abort();
    expect(localDestroy).not.toHaveBeenCalled(); // still in grace period

    // Wait for the real CANCEL_GRACE_MS (3000ms) timer to fire
    await new Promise((r) => setTimeout(r, 3_100));
    expect(localDestroy).toHaveBeenCalled();
  }, 10_000);

  it('should treat cancelled stopReason as unsuccessful result', async () => {
    mockPrompt.mockResolvedValueOnce({ stopReason: 'cancelled' });
    const result = await executor.execute('task', {});
    expect(result.success).toBe(false);
  });

  // ─── destroy() ───────────────────────────────────────────────────────────

  it('should send ACP cancel and destroy persistent client on destroy()', async () => {
    const localSendCancel = vi.fn();
    let rejectPrompt!: (e: Error) => void;
    let promptRejected = false;

    const { AcpClient } = await import('../../src/executor/acp/AcpClient');
    vi.mocked(AcpClient).mockImplementationOnce((_cmd, _args, _cwd, _callbacks) => ({
      initialize: mockInitialize,
      newSession: mockNewSession,
      setSessionMode: mockSetSessionMode,
      sendCancel: localSendCancel,
      prompt: () => new Promise<{ stopReason: string }>((_resolve, reject) => { rejectPrompt = reject; }),
      destroy: vi.fn().mockImplementation(() => {
        if (!promptRejected) {
          promptRejected = true;
          rejectPrompt(new Error('AcpClient destroyed'));
        }
      }),
    }));

    const executePromise = executor.execute('test', {});
    await new Promise((r) => setTimeout(r, 10));

    await executor.destroy();
    expect(localSendCancel).toHaveBeenCalledWith('mock-session-id');

    const result = await executePromise;
    expect(result.success).toBe(false);
  });

  // ─── Error handling ───────────────────────────────────────────────────────

  it('should handle refusal stop reason as failure', async () => {
    mockPrompt.mockResolvedValueOnce({ stopReason: 'refusal' });
    const result = await executor.execute('do something refused', {});
    expect(result.success).toBe(false);
  });

  it('should return error on ACP client exception and destroy persistent client', async () => {
    mockPrompt.mockRejectedValueOnce(new Error('ACP connection lost'));
    const result = await executor.execute('failing task', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('ACP connection lost');

    // Client destroyed on error — next execute respawns
    const { AcpClient } = await import('../../src/executor/acp/AcpClient');
    const MockAcpClient = vi.mocked(AcpClient);
    MockAcpClient.mockClear();
    await executor.execute('after error', {});
    expect(MockAcpClient).toHaveBeenCalledTimes(1);
  });

  // ─── CLI flags ────────────────────────────────────────────────────────────

  it('should pass --yolo CLI flag when autoApprove=true', async () => {
    const { AcpClient } = await import('../../src/executor/acp/AcpClient');
    const MockAcpClient = vi.mocked(AcpClient);
    MockAcpClient.mockClear();

    const guard = new DirectoryGuard([tmpDir]);
    const ex = new GeminiExecutor(guard, { initialWorkingDirectory: tmpDir, autoApprove: true });
    await ex.execute('test', {});

    const callArgs = MockAcpClient.mock.calls[0];
    expect(callArgs[1]).toContain('--yolo');
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

  // ─── compactWhenFull ─────────────────────────────────────────────────────

  describe('compactWhenFull()', () => {
    it('should return success with no-op message when no active session', async () => {
      const result = await executor.compactWhenFull!();
      expect(result.success).toBe(true);
      expect(result.output).toContain('No active conversation');
    });

    it('should destroy persistent client to reset context', async () => {
      await executor.execute('question 1', {});
      expect(mockDestroy).not.toHaveBeenCalled();

      const result = await executor.compactWhenFull!();
      expect(result.success).toBe(true);
      expect(mockDestroy).toHaveBeenCalledTimes(1);
    });

    it('should spawn a fresh client after compactWhenFull', async () => {
      const { AcpClient } = await import('../../src/executor/acp/AcpClient');
      const MockAcpClient = vi.mocked(AcpClient);

      await executor.execute('question 1', {});
      await executor.compactWhenFull!();

      MockAcpClient.mockClear();
      await executor.execute('after compact', {});
      expect(MockAcpClient).toHaveBeenCalledTimes(1);
    });

    it('should stream a status message when resetting context', async () => {
      await executor.execute('question 1', {});

      const chunks: string[] = [];
      await executor.compactWhenFull!((chunk) => chunks.push(chunk));
      expect(chunks.length).toBeGreaterThan(0);
    });

    it('should be discoverable via in operator (IExecutor optional method)', () => {
      expect('compactWhenFull' in executor).toBe(true);
    });
  });

  // ─── deleteThreadData ─────────────────────────────────────────────────────

  describe('multi-thread isolation', () => {
    it('deleteThreadData should destroy client and not leave dangling state', async () => {
      const guard = new DirectoryGuard([tmpDir]);
      const ex = new GeminiExecutor(guard, { initialWorkingDirectory: tmpDir, threadId: 'thread-789' });
      await ex.execute('first', {});

      await ex.deleteThreadData!('thread-789');
      expect(mockDestroy).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Quota fallback chain ─────────────────────────────────────────────────

  describe('quota fallback chain', () => {
    it('should retry with flash when configured model exhausts quota', async () => {
      const { AcpClient } = await import('../../src/executor/acp/AcpClient');
      const MockAcpClient = vi.mocked(AcpClient);
      MockAcpClient.mockClear();

      mockPrompt
        .mockRejectedValueOnce(new Error('You have exhausted your capacity for today'))
        .mockResolvedValueOnce({ stopReason: 'end_turn' });

      const onStream = vi.fn();
      const guard = new DirectoryGuard([tmpDir]);
      const ex = new GeminiExecutor(guard, { initialWorkingDirectory: tmpDir, model: 'pro' });
      const result = await ex.execute('prompt', { onStream });

      expect(result.success).toBe(true);
      expect(onStream).toHaveBeenCalledWith(expect.stringContaining('Quota exhausted'));
      expect(onStream).toHaveBeenCalledWith(expect.stringContaining('flash'));
      // Two ACP clients: one per model attempt (quota error destroys client, respawns with new model)
      expect(MockAcpClient).toHaveBeenCalledTimes(2);
    });

    it('should retry with flash-lite when both pro and flash exhaust quota', async () => {
      const { AcpClient } = await import('../../src/executor/acp/AcpClient');
      const MockAcpClient = vi.mocked(AcpClient);
      MockAcpClient.mockClear();

      mockPrompt
        .mockRejectedValueOnce(new Error('You have exhausted your capacity'))
        .mockRejectedValueOnce(new Error('quota exceeded'))
        .mockResolvedValueOnce({ stopReason: 'end_turn' });

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

      mockPrompt
        .mockRejectedValueOnce(new Error('exhausted your capacity'))
        .mockResolvedValueOnce({ stopReason: 'end_turn' });

      const guard = new DirectoryGuard([tmpDir]);
      const ex = new GeminiExecutor(guard, { initialWorkingDirectory: tmpDir, model: 'flash' });
      const result = await ex.execute('prompt', {});

      expect(result.success).toBe(true);
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
        .mockResolvedValueOnce({ stopReason: 'end_turn' });

      const onStream = vi.fn();
      const guard = new DirectoryGuard([tmpDir]);
      const ex = new GeminiExecutor(guard, { initialWorkingDirectory: tmpDir, model: 'pro' });
      const result = await ex.execute('prompt', { onStream });

      expect(result.success).toBe(true);
      expect(onStream).toHaveBeenCalledWith(expect.stringContaining('Quota exhausted'));
      expect(MockAcpClient).toHaveBeenCalledTimes(2);
    });

    it('should exhaust all fallbacks on repeated "No capacity available" errors', async () => {
      mockPrompt.mockRejectedValue(new Error('ACP error 500: No capacity available'));

      const guard = new DirectoryGuard([tmpDir]);
      const ex = new GeminiExecutor(guard, { initialWorkingDirectory: tmpDir, model: 'pro' });
      const result = await ex.execute('prompt', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('All Gemini models');
    });

    it('should NOT retry on non-quota errors', async () => {
      const { AcpClient } = await import('../../src/executor/acp/AcpClient');
      const MockAcpClient = vi.mocked(AcpClient);
      MockAcpClient.mockClear();

      mockPrompt.mockRejectedValueOnce(new Error('Network connection refused'));

      const result = await executor.execute('prompt', {});

      expect(result.success).toBe(false);
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
        .mockResolvedValueOnce({ stopReason: 'end_turn' });

      const streamedChunks: string[] = [];
      const guard = new DirectoryGuard([tmpDir]);
      const ex = new GeminiExecutor(guard, { initialWorkingDirectory: tmpDir, model: 'pro' });
      await ex.execute('prompt', { onStream: (c) => streamedChunks.push(c) });

      const notices = streamedChunks.filter((c) => c.includes('Quota exhausted'));
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
      expect(result.error).not.toContain('undefined');
      expect(result.error).not.toContain('resets in');
    });
  });
});
