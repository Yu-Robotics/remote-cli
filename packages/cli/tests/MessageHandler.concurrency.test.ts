import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MessageHandler } from '../src/client/MessageHandler';
import { ThreadExecutorPool } from '../src/thread/ThreadExecutorPool';
import { DirectoryGuard } from '../src/security/DirectoryGuard';
import { ConfigManager } from '../src/config/ConfigManager';
import { ThreadManager } from '../src/thread/ThreadManager';

describe('MessageHandler Concurrency', () => {
  let handler: MessageHandler;
  let mockWsClient: any;
  let mockThreadPool: any;
  let mockThreadManager: any;
  let mockGuard: any;
  let mockConfig: any;
  let mockExecutor: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockWsClient = {
      isConnected: vi.fn().mockReturnValue(true),
      send: vi.fn(),
    };

    mockExecutor = {
      execute: vi.fn().mockImplementation(() => new Promise((resolve) => {
        // Simulate a long running task
        setTimeout(() => resolve({ success: true, output: 'done' }), 50);
      })),
      resetContext: vi.fn(),
      abort: vi.fn().mockResolvedValue(true),
      getCurrentWorkingDirectory: vi.fn().mockReturnValue('/mock/dir'),
      setWorkingDirectory: vi.fn().mockResolvedValue(undefined),
    };

    let isBusy = false;
    mockThreadPool = {
      getExecutor: vi.fn().mockReturnValue(mockExecutor),
      isThreadBusy: vi.fn().mockImplementation(() => isBusy),
      setThreadBusy: vi.fn().mockImplementation((id, busy) => { isBusy = busy; }),
      setThreadError: vi.fn(),
      getSummaries: vi.fn().mockReturnValue([]),
      getBackendKey: vi.fn().mockReturnValue('claude'),
      destroyAll: vi.fn().mockResolvedValue(undefined),
    };

    mockThreadManager = {
      getThread: vi.fn().mockReturnValue({ id: 'thread-1', name: 'Thread 1' }),
      getDefaultThread: vi.fn().mockReturnValue({ id: 'thread-1', name: 'Thread 1' }),
      updateThread: vi.fn().mockResolvedValue(undefined),
      createThread: vi.fn().mockResolvedValue({ id: 'thread-2', name: 'thread-2', sessionId: null }),
      listThreads: vi.fn().mockReturnValue([{ id: 'thread-1', name: 'Thread 1' }]),
    };

    mockGuard = new DirectoryGuard(['/mock/dir']);

    mockConfig = {
      get: vi.fn().mockReturnValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
      getConfigDir: vi.fn().mockReturnValue('/mock/config/dir'),
    };

    handler = new MessageHandler(
      mockWsClient,
      mockThreadPool,
      mockThreadManager,
      mockGuard,
      mockConfig
    );
  });

  afterEach(async () => {
    if (handler) {
      await handler.destroy();
    }
  });

  it('should block concurrent commands while an executor is busy', async () => {
    // Send first command
    const p1 = handler.handleMessage({
      type: 'command',
      messageId: 'msg-1',
      content: 'Hello AI',
      timestamp: Date.now(),
    } as any);

    // Send second command immediately before first completes
    const p2 = handler.handleMessage({
      type: 'command',
      messageId: 'msg-2',
      content: '/clear',
      timestamp: Date.now(),
    } as any);

    const p3 = handler.handleMessage({
      type: 'command',
      messageId: 'msg-3',
      content: 'Another prompt',
      timestamp: Date.now(),
    } as any);

    await Promise.all([p1, p2, p3]);

    // First command should have started execution
    expect(mockExecutor.execute).toHaveBeenCalledTimes(1);

    // Control commands are rejected, while normal messages require queue confirmation.
    expect(mockWsClient.send).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('is busy') }));
    expect(mockWsClient.send).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'msg-3', queueConfirmation: expect.any(Object) }));
    
    // Only the slash command is rejected directly.
    const busyCalls = mockWsClient.send.mock.calls.filter((c: any) => 
      c[0].error && c[0].error.includes('is busy')
    );
    expect(busyCalls.length).toBe(1);
    
    // resetContext shouldn't be called because the /clear command was blocked
    expect(mockExecutor.resetContext).not.toHaveBeenCalled();
  });

  it('should handle /abort even when thread is busy', async () => {
    // Set thread to busy manually
    mockThreadPool.setThreadBusy('thread-1', true);

    await handler.handleMessage({
      type: 'command',
      messageId: 'msg-abort',
      content: '/abort',
      timestamp: Date.now(),
    } as any);

    // abort bypasses busy check
    expect(mockExecutor.abort).toHaveBeenCalledTimes(1);

    // Should respond with aborted message
    expect(mockWsClient.send).toHaveBeenCalledWith(expect.objectContaining({ output: expect.stringContaining('aborted') }));
  });

  it('should allow /thread new even when the caller thread is busy', async () => {
    // Regression: the router's "+ New" card button sends "/thread new" without a
    // threadId, so it always resolves to the default thread. It must not be
    // rejected just because that thread is busy.
    mockThreadPool.setThreadBusy('thread-1', true);

    await handler.handleMessage({
      type: 'command',
      messageId: 'msg-thread-new',
      content: '/thread new',
      timestamp: Date.now(),
    } as any);

    expect(mockThreadManager.createThread).toHaveBeenCalledTimes(1);
    expect(mockWsClient.send).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'msg-thread-new',
      success: true,
    }));
  });

  it('should allow /thread new with an explicit name when the caller thread is busy', async () => {
    mockThreadPool.setThreadBusy('thread-1', true);

    await handler.handleMessage({
      type: 'command',
      messageId: 'msg-thread-new-named',
      content: '/thread new my-feature',
      timestamp: Date.now(),
    } as any);

    expect(mockThreadManager.createThread).toHaveBeenCalledWith(
      'my-feature',
      '/mock/dir',
      'claude'
    );
  });

  it('should allow /thread list when the caller thread is busy', async () => {
    mockThreadPool.setThreadBusy('thread-1', true);
    mockThreadPool.getSummaries.mockReturnValue([
      { id: 'thread-1', name: 'Thread 1', status: 'running', backend: 'claude' },
    ]);

    await handler.handleMessage({
      type: 'command',
      messageId: 'msg-thread-list',
      content: '/thread list',
      timestamp: Date.now(),
    } as any);

    expect(mockWsClient.send).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'msg-thread-list',
      success: true,
      output: expect.stringContaining('Thread 1'),
    }));
  });

  it('should still reject /thread delete when the caller thread is busy', async () => {
    mockThreadPool.setThreadBusy('thread-1', true);
    mockThreadManager.getThreadByName = vi.fn().mockReturnValue({ id: 'thread-2', name: 'thread-2' });

    await handler.handleMessage({
      type: 'command',
      messageId: 'msg-thread-delete',
      content: '/thread delete thread-2',
      timestamp: Date.now(),
    } as any);

    expect(mockWsClient.send).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'msg-thread-delete',
      error: expect.stringContaining('is busy'),
    }));
  });

  it('should wait for abort cleanup before starting a new command', async () => {
    let rejectFirst!: (error: Error) => void;
    let resolveSecond!: (result: any) => void;
    let finishAbort!: () => void;
    const abortCleanup = new Promise<void>((resolve) => { finishAbort = resolve; });

    mockExecutor.execute
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
    mockExecutor.abort.mockImplementation(async () => {
      rejectFirst(new Error('Command aborted by user'));
      await abortCleanup;
      return true;
    });

    const first = handler.handleMessage({
      type: 'command',
      messageId: 'msg-first',
      content: 'Long task',
      timestamp: Date.now(),
    } as any);
    await vi.waitFor(() => expect(mockExecutor.execute).toHaveBeenCalledTimes(1));

    const abort = handler.handleMessage({
      type: 'command',
      messageId: 'msg-abort',
      content: '/abort',
      timestamp: Date.now(),
    } as any);
    await first;

    const next = handler.handleMessage({
      type: 'command',
      messageId: 'msg-next',
      content: 'Run after abort',
      timestamp: Date.now(),
    } as any);
    await Promise.resolve();

    expect(mockExecutor.execute).toHaveBeenCalledTimes(1);
    expect(mockWsClient.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'stream',
      messageId: 'msg-next',
      chunk: expect.stringContaining('Waiting for the current abort'),
    }));

    finishAbort();
    await abort;
    await vi.waitFor(() => expect(mockExecutor.execute).toHaveBeenCalledTimes(2));
    expect(mockThreadPool.isThreadBusy('thread-1')).toBe(true);

    resolveSecond({ success: true, output: 'done' });
    await next;
    expect(mockThreadPool.isThreadBusy('thread-1')).toBe(false);
    expect(mockWsClient.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'response',
      messageId: 'msg-next',
      success: true,
    }));
  });

  it('should wait for the interrupted command to settle when abort returns first', async () => {
    let resolveFirst!: (result: any) => void;
    mockExecutor.execute
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ success: true, output: 'next done' });
    mockExecutor.abort.mockResolvedValue(true);

    const first = handler.handleMessage({
      type: 'command',
      messageId: 'msg-first',
      content: 'Long task',
      timestamp: Date.now(),
    } as any);
    await vi.waitFor(() => expect(mockExecutor.execute).toHaveBeenCalledTimes(1));

    const abort = handler.handleMessage({
      type: 'command',
      messageId: 'msg-abort',
      content: '/abort',
      timestamp: Date.now(),
    } as any);
    const next = handler.handleMessage({
      type: 'command',
      messageId: 'msg-next',
      content: 'Run after abort',
      timestamp: Date.now(),
    } as any);
    await Promise.resolve();

    expect(mockExecutor.execute).toHaveBeenCalledTimes(1);
    resolveFirst({ success: false, error: 'Aborted by user' });
    await Promise.all([first, abort, next]);

    expect(mockExecutor.execute).toHaveBeenCalledTimes(2);
    expect(mockWsClient.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'response',
      messageId: 'msg-next',
      success: true,
    }));
  });
});
