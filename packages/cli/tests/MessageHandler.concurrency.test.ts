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
      destroyAll: vi.fn().mockResolvedValue(undefined),
    };

    mockThreadManager = {
      getThread: vi.fn().mockReturnValue({ id: 'thread-1', name: 'Thread 1' }),
      getDefaultThread: vi.fn().mockReturnValue({ id: 'thread-1', name: 'Thread 1' }),
      updateThread: vi.fn().mockResolvedValue(undefined),
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

    // Second and third commands should be rejected because thread is busy
    expect(mockWsClient.send).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('is busy') }));
    
    // send should be called twice with the busy message
    const busyCalls = mockWsClient.send.mock.calls.filter((c: any) => 
      c[0].error && c[0].error.includes('is busy')
    );
    expect(busyCalls.length).toBe(2);
    
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
});
