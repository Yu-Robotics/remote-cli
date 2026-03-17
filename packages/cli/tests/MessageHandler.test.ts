import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MessageHandler } from '../src/client/MessageHandler';
import { WebSocketClient } from '../src/client/WebSocketClient';
import { DirectoryGuard } from '../src/security/DirectoryGuard';
import { ThreadExecutorPool } from '../src/thread/ThreadExecutorPool';
import { ThreadManager } from '../src/thread/ThreadManager';

vi.mock('../src/client/WebSocketClient');

/**
 * Build a minimal MessageHandler with mocked threadPool, threadManager, and executor.
 * The mock executor is bound to the 'default' thread.
 */
function buildHandler(mockExecutorOverrides: Record<string, any> = {}) {
  const mockExecutor: any = {
    execute: vi.fn(),
    setWorkingDirectory: vi.fn().mockResolvedValue(undefined),
    getCurrentWorkingDirectory: vi.fn(() => '/home/user/test-project'),
    resetContext: vi.fn(),
    abort: vi.fn().mockResolvedValue(true),
    destroy: vi.fn().mockResolvedValue(undefined),
    ...mockExecutorOverrides,
  };

  const mockWsClient: any = {
    send: vi.fn(),
    isConnected: vi.fn(() => true),
  };

  const directoryGuard = new DirectoryGuard(['~/test-project']);

  const mockConfig: any = {
    get: vi.fn(),
    set: vi.fn().mockResolvedValue(undefined),
    has: vi.fn(() => true),
    getAll: vi.fn(() => ({})),
    save: vi.fn().mockResolvedValue(undefined),
  };

  // Default thread stub
  const defaultThread = { id: 'default-thread-id', name: 'default', workingDirectory: '/home/user/test-project', sessionId: null, createdAt: 0, lastActiveAt: 0 };

  const mockThreadManager = {
    getDefaultThread: vi.fn().mockReturnValue(defaultThread),
    getThread: vi.fn().mockImplementation((id: string) => id === defaultThread.id ? defaultThread : undefined),
    getThreadByName: vi.fn().mockImplementation((name: string) => name === 'default' ? defaultThread : undefined),
    listThreads: vi.fn().mockReturnValue([defaultThread]),
    createThread: vi.fn().mockResolvedValue({ id: 'new-thread-id', name: 'thread-2', workingDirectory: '/home/user/test-project', sessionId: null, createdAt: Date.now(), lastActiveAt: Date.now() }),
    deleteThread: vi.fn().mockResolvedValue(undefined),
    updateThread: vi.fn().mockImplementation(async (id: string, updates: any) => ({ ...defaultThread, ...updates })),
    getSessionFilePath: vi.fn().mockReturnValue('/tmp/session.jsonl'),
  } as unknown as ThreadManager;

  const mockThreadPool = {
    getExecutor: vi.fn().mockReturnValue(mockExecutor),
    isThreadBusy: vi.fn().mockReturnValue(false),
    setThreadBusy: vi.fn(),
    setThreadError: vi.fn(),
    getStatus: vi.fn().mockReturnValue('idle'),
    getSummaries: vi.fn().mockReturnValue([{ id: defaultThread.id, name: 'default', status: 'idle' }]),
    destroyThread: vi.fn().mockResolvedValue(undefined),
    destroyAll: vi.fn().mockResolvedValue(undefined),
    switchBackend: vi.fn().mockResolvedValue(undefined),
  } as unknown as ThreadExecutorPool;

  const handler = new MessageHandler(
    mockWsClient,
    mockThreadPool,
    mockThreadManager,
    directoryGuard,
    mockConfig
  );

  return { handler, mockExecutor, mockWsClient, mockThreadPool, mockThreadManager, mockConfig };
}

describe('MessageHandler', () => {
  let ctx: ReturnType<typeof buildHandler>;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = buildHandler();
  });

  afterEach(async () => {
    await ctx.handler.destroy();
  });

  describe('initialization', () => {
    it('should create handler with dependencies', () => {
      expect(ctx.handler).toBeDefined();
      expect(ctx.handler).toBeInstanceOf(MessageHandler);
    });
  });

  describe('message handling', () => {
    it('should handle command messages', async () => {
      ctx.mockExecutor.execute.mockResolvedValue({
        success: true,
        output: 'Command executed successfully',
      });

      const message = {
        type: 'command',
        messageId: 'msg-123',
        content: 'list files',
        timestamp: Date.now(),
      };

      await ctx.handler.handleMessage(message);

      expect(ctx.mockExecutor.execute).toHaveBeenCalledWith(
        expect.stringContaining('list files'),
        expect.any(Object)
      );
      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'response',
          messageId: 'msg-123',
          success: true,
        })
      );
    });

    it('should handle execution errors', async () => {
      ctx.mockExecutor.execute.mockResolvedValue({
        success: false,
        error: 'Execution failed',
      });

      const message = {
        type: 'command',
        messageId: 'msg-456',
        content: 'invalid command',
        timestamp: Date.now(),
      };

      await ctx.handler.handleMessage(message);

      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'response',
          messageId: 'msg-456',
          success: false,
          error: 'Execution failed',
        })
      );
    });

    it('should ignore non-command messages', async () => {
      const message = {
        type: 'heartbeat',
        timestamp: Date.now(),
      };

      await ctx.handler.handleMessage(message);

      expect(ctx.mockExecutor.execute).not.toHaveBeenCalled();
      expect(ctx.mockWsClient.send).not.toHaveBeenCalled();
    });

    it('should handle malformed messages gracefully', async () => {
      const message = {
        type: 'command',
        // Missing messageId and content
      };

      await ctx.handler.handleMessage(message);

      expect(ctx.mockExecutor.execute).not.toHaveBeenCalled();
    });
  });

  describe('command shortcuts', () => {
    it('should expand /r to resume command', async () => {
      ctx.mockExecutor.execute.mockResolvedValue({ success: true, output: 'ok' });

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-123', content: '/r', timestamp: Date.now() });

      expect(ctx.mockExecutor.execute).toHaveBeenCalledWith(
        expect.stringContaining('resume'),
        expect.any(Object)
      );
    });

    it('should expand /c to continue command', async () => {
      ctx.mockExecutor.execute.mockResolvedValue({ success: true, output: 'ok' });

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-123', content: '/c', timestamp: Date.now() });

      expect(ctx.mockExecutor.execute).toHaveBeenCalledWith(
        expect.stringContaining('continue'),
        expect.any(Object)
      );
    });

    it('should expand /resume to full resume command', async () => {
      ctx.mockExecutor.execute.mockResolvedValue({ success: true, output: 'ok' });

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-123', content: '/resume', timestamp: Date.now() });

      expect(ctx.mockExecutor.execute).toHaveBeenCalledWith(
        expect.stringContaining('resume'),
        expect.any(Object)
      );
    });

    it('should expand /continue to full continue command', async () => {
      ctx.mockExecutor.execute.mockResolvedValue({ success: true, output: 'ok' });

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-123', content: '/continue', timestamp: Date.now() });

      expect(ctx.mockExecutor.execute).toHaveBeenCalledWith(
        expect.stringContaining('continue'),
        expect.any(Object)
      );
    });

    it('should not expand /r in middle of text', async () => {
      ctx.mockExecutor.execute.mockResolvedValue({ success: true, output: 'ok' });

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-123', content: 'some /r text', timestamp: Date.now() });

      expect(ctx.mockExecutor.execute).toHaveBeenCalledWith(
        expect.stringContaining('some /r text'),
        expect.any(Object)
      );
    });
  });

  describe('status command', () => {
    it('should handle /status command', async () => {
      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-123', content: '/status', timestamp: Date.now() });

      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'response',
          messageId: 'msg-123',
          success: true,
          output: expect.stringContaining('test-project'),
        })
      );
      expect(ctx.mockExecutor.execute).not.toHaveBeenCalled();
    });
  });

  describe('help command', () => {
    it('should handle /help command', async () => {
      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-123', content: '/help', timestamp: Date.now() });

      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'response',
          messageId: 'msg-123',
          success: true,
          output: expect.stringContaining('Available commands'),
        })
      );
      expect(ctx.mockExecutor.execute).not.toHaveBeenCalled();
    });
  });

  describe('clear command', () => {
    it('should handle /clear command', async () => {
      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-123', content: '/clear', timestamp: Date.now() });

      expect(ctx.mockExecutor.resetContext).toHaveBeenCalled();
      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'response',
          messageId: 'msg-123',
          success: true,
        })
      );
    });
  });

  describe('cd command', () => {
    it('should handle /cd command with valid directory', async () => {
      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-123', content: '/cd ~/test-project', timestamp: Date.now() });

      expect(ctx.mockExecutor.setWorkingDirectory).toHaveBeenCalledWith('~/test-project');
      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'response', messageId: 'msg-123', success: true })
      );
    });

    it('should handle /cd command with invalid directory', async () => {
      ctx.mockExecutor.setWorkingDirectory.mockRejectedValueOnce(new Error('Directory not allowed'));

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-123', content: '/cd /etc', timestamp: Date.now() });

      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'response',
          messageId: 'msg-123',
          success: false,
          error: expect.stringContaining('not allowed'),
        })
      );
    });

    it('should handle /cd command without directory', async () => {
      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-123', content: '/cd', timestamp: Date.now() });

      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'response', messageId: 'msg-123', success: false })
      );
    });
  });

  describe('streaming output', () => {
    it('should send streaming chunks', async () => {
      ctx.mockExecutor.execute.mockImplementation(async (_prompt: string, options: any) => {
        options.onStream?.('chunk 1');
        options.onStream?.('chunk 2');
        options.onStream?.('chunk 3');
        return { success: true, output: 'final output' };
      });

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-123', content: 'test command', timestamp: Date.now() });

      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'stream', messageId: 'msg-123', chunk: 'chunk 1' })
      );
      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'stream', messageId: 'msg-123', chunk: 'chunk 2' })
      );
      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'stream', messageId: 'msg-123', chunk: 'chunk 3' })
      );
    });

    it('should handle streaming errors gracefully', async () => {
      ctx.mockWsClient.send.mockImplementation(() => { throw new Error('WebSocket send failed'); });
      ctx.mockExecutor.execute.mockImplementation(async (_prompt: string, options: any) => {
        options.onStream?.('test chunk');
        return { success: true, output: 'ok' };
      });

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-123', content: 'test', timestamp: Date.now() });
      expect(ctx.mockExecutor.execute).toHaveBeenCalled();
    });
  });

  describe('concurrent execution prevention (per thread)', () => {
    it('should prevent concurrent command execution on the same thread', async () => {
      ctx.mockExecutor.execute.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ success: true, output: 'ok' }), 100))
      );

      // Simulate the pool reporting busy after first command starts
      let callCount = 0;
      ctx.mockThreadPool.isThreadBusy = vi.fn().mockImplementation(() => callCount++ > 0);
      ctx.mockThreadPool.setThreadBusy = vi.fn().mockImplementation(() => {});

      const promise1 = ctx.handler.handleMessage({ type: 'command', messageId: 'msg-1', content: 'command 1', timestamp: Date.now() });
      const promise2 = ctx.handler.handleMessage({ type: 'command', messageId: 'msg-2', content: 'command 2', timestamp: Date.now() });

      await Promise.all([promise1, promise2]);

      const calls = ctx.mockWsClient.send.mock.calls;
      const busyResponse = calls.find((call: any) =>
        call[0].messageId === 'msg-2' &&
        call[0].success === false &&
        call[0].error?.includes('busy')
      );
      expect(busyResponse).toBeDefined();
    });
  });

  describe('error recovery', () => {
    it('should recover from execution errors', async () => {
      ctx.mockExecutor.execute
        .mockRejectedValueOnce(new Error('First error'))
        .mockResolvedValueOnce({ success: true, output: 'ok' });

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-1', content: 'failing command', timestamp: Date.now() });
      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-2', content: 'working command', timestamp: Date.now() });

      expect(ctx.mockExecutor.execute).toHaveBeenCalledTimes(2);
    });
  });

  describe('cleanup', () => {
    it('should cleanup resources on destroy', async () => {
      await ctx.handler.destroy();
      await expect(ctx.handler.destroy()).resolves.not.toThrow();
    });

    it('should reject messages after destroy', async () => {
      await ctx.handler.destroy();

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-123', content: 'test', timestamp: Date.now() });

      expect(ctx.mockExecutor.execute).not.toHaveBeenCalled();
    });
  });

  describe('message validation', () => {
    it('should validate message structure', async () => {
      const invalidMessages = [
        null,
        undefined,
        {},
        { type: 'command' },
        { type: 'command', messageId: 'msg-123' },
        { messageId: 'msg-123', content: 'test' },
      ];

      for (const msg of invalidMessages) {
        await ctx.handler.handleMessage(msg as any);
      }

      expect(ctx.mockExecutor.execute).not.toHaveBeenCalled();
    });
  });

  describe('working directory context', () => {
    it('should include working directory in responses', async () => {
      ctx.mockExecutor.execute.mockResolvedValue({ success: true, output: 'Command output' });

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-123', content: 'test command', timestamp: Date.now() });

      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: '/home/user/test-project' })
      );
    });
  });

  describe('file read detection', () => {
    it('should inject hint for Chinese read commands', async () => {
      ctx.mockExecutor.execute.mockResolvedValue({ success: true, output: 'ok' });

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-123', content: '读取 config.ts', timestamp: Date.now() });

      expect(ctx.mockExecutor.execute).toHaveBeenCalledWith(
        expect.stringContaining('[System hint:'),
        expect.any(Object)
      );
    });

    it('should inject hint for English read commands', async () => {
      ctx.mockExecutor.execute.mockResolvedValue({ success: true, output: 'ok' });

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-123', content: 'show file package.json', timestamp: Date.now() });

      expect(ctx.mockExecutor.execute).toHaveBeenCalledWith(
        expect.stringContaining('[System hint:'),
        expect.any(Object)
      );
    });

    it('should not inject hint for general commands', async () => {
      ctx.mockExecutor.execute.mockResolvedValue({ success: true, output: 'ok' });

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-123', content: 'fix the login bug', timestamp: Date.now() });

      expect(ctx.mockExecutor.execute).toHaveBeenCalledWith('fix the login bug', expect.any(Object));
    });

    it('should strip --full and skip hint', async () => {
      ctx.mockExecutor.execute.mockResolvedValue({ success: true, output: 'ok' });

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-123', content: 'read file.ts --full', timestamp: Date.now() });

      const executedContent = ctx.mockExecutor.execute.mock.calls[0][0];
      expect(executedContent).not.toContain('--full');
      expect(executedContent).not.toContain('For files exceeding 50 lines');
    });
  });

  describe('compact command', () => {
    it('should handle /compact when executor supports it', async () => {
      ctx.mockExecutor.compactWhenFull = vi.fn().mockResolvedValue({ success: true });

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-compact', content: '/compact', timestamp: Date.now() });

      expect(ctx.mockExecutor.compactWhenFull).toHaveBeenCalled();
      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'stream', messageId: 'msg-compact', chunk: expect.stringContaining('Compressing') })
      );
      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'response', messageId: 'msg-compact', success: true, output: expect.stringContaining('compressed') })
      );
      expect(ctx.mockExecutor.execute).not.toHaveBeenCalled();
    });

    it('should report error when compact fails', async () => {
      ctx.mockExecutor.compactWhenFull = vi.fn().mockResolvedValue({ success: false, error: 'Compaction failed: internal error' });

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-compact-fail', content: '/compact', timestamp: Date.now() });

      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'response', messageId: 'msg-compact-fail', success: false, error: expect.stringContaining('Compaction failed') })
      );
    });

    it('should reject /compact when executor does not support it', async () => {
      // mockExecutor has no compactWhenFull()
      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-compact-unsupported', content: '/compact', timestamp: Date.now() });

      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'response', messageId: 'msg-compact-unsupported', success: false, error: expect.stringContaining('not supported') })
      );
      expect(ctx.mockExecutor.execute).not.toHaveBeenCalled();
    });

    it('should stream compact output chunks', async () => {
      ctx.mockExecutor.compactWhenFull = vi.fn().mockImplementation(async (onStream: (chunk: string) => void) => {
        onStream('Summarizing conversation...');
        onStream('Done.');
        return { success: true };
      });

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-compact-stream', content: '/compact', timestamp: Date.now() });

      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'stream', messageId: 'msg-compact-stream', chunk: 'Summarizing conversation...' })
      );
      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'stream', messageId: 'msg-compact-stream', chunk: 'Done.' })
      );
    });

    it('should include /compact in /help output', async () => {
      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-help', content: '/help', timestamp: Date.now() });

      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ output: expect.stringContaining('/compact') })
      );
    });
  });

  describe('Prompt too long error handling', () => {
    it('should return friendly message with /compact hint on Prompt too long error', async () => {
      ctx.mockExecutor.execute.mockResolvedValue({ success: false, error: 'Prompt too long: context exceeds model limit' });

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-toolong', content: 'do something', timestamp: Date.now() });

      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'response', messageId: 'msg-toolong', success: false, error: expect.stringContaining('/compact') })
      );
      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('/clear') })
      );
    });

    it('should pass through other errors unchanged', async () => {
      ctx.mockExecutor.execute.mockResolvedValue({ success: false, error: 'Some other error' });

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-other-error', content: 'do something', timestamp: Date.now() });

      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: 'Some other error' })
      );
    });
  });

  describe('/thread commands', () => {
    it('should list threads on /thread list', async () => {
      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-tl', content: '/thread list', timestamp: Date.now() });

      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, output: expect.stringContaining('default') })
      );
    });

    it('should list threads on /thread (bare)', async () => {
      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-t', content: '/thread', timestamp: Date.now() });

      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, output: expect.stringContaining('Threads') })
      );
    });

    it('should create thread on /thread new', async () => {
      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-tn', content: '/thread new my-feat', timestamp: Date.now() });

      expect(ctx.mockThreadManager.createThread).toHaveBeenCalledWith('my-feat', expect.any(String));
      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ success: true })
      );
    });

    it('should delete thread on /thread delete', async () => {
      const targetThread = { id: 'target-id', name: 'my-feat', workingDirectory: '/tmp', sessionId: null, createdAt: 0, lastActiveAt: 0 };
      ctx.mockThreadManager.getThreadByName = vi.fn().mockReturnValue(targetThread);
      ctx.mockThreadPool.isThreadBusy = vi.fn().mockReturnValue(false);

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-td', content: '/thread delete my-feat', timestamp: Date.now() });

      expect(ctx.mockThreadPool.destroyThread).toHaveBeenCalledWith('target-id');
      expect(ctx.mockThreadManager.deleteThread).toHaveBeenCalledWith('target-id');
      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    it('should refuse delete on running thread', async () => {
      const targetThread = { id: 'target-id', name: 'busy', workingDirectory: '/tmp', sessionId: null, createdAt: 0, lastActiveAt: 0 };
      ctx.mockThreadManager.getThreadByName = vi.fn().mockReturnValue(targetThread);
      ctx.mockThreadPool.isThreadBusy = vi.fn().mockReturnValue(true);

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-tdbusy', content: '/thread delete busy', timestamp: Date.now() });

      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: expect.stringContaining('running') })
      );
      expect(ctx.mockThreadManager.deleteThread).not.toHaveBeenCalled();
    });

    it('routes command to specified threadId', async () => {
      const otherThread = { id: 'other-id', name: 'thread-2', workingDirectory: '/tmp', sessionId: null, createdAt: 0, lastActiveAt: 0 };
      ctx.mockThreadManager.getThread = vi.fn().mockImplementation((id: string) =>
        id === 'other-id' ? otherThread : undefined
      );
      ctx.mockExecutor.execute.mockResolvedValue({ success: true });

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-t2', content: 'hello', threadId: 'other-id', timestamp: Date.now() });

      // Pool should be asked for the other thread's executor
      expect(ctx.mockThreadPool.getExecutor).toHaveBeenCalledWith('other-id');
    });
  });
});
