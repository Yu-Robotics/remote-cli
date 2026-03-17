import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocketClient } from '../../src/client/WebSocketClient';
import { MessageHandler } from '../../src/client/MessageHandler';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { ThreadExecutorPool } from '../../src/thread/ThreadExecutorPool';
import { ThreadManager } from '../../src/thread/ThreadManager';
import { IncomingMessage } from '../../src/types';

vi.mock('../../src/client/WebSocketClient');

describe('Integration: Message Flow', () => {
  let wsClient: any;
  let executor: any;
  let guard: DirectoryGuard;
  let handler: MessageHandler;
  let mockThreadPool: any;
  let mockThreadManager: any;

  beforeEach(() => {
    vi.clearAllMocks();

    wsClient = {
      send: vi.fn(),
      on: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    (WebSocketClient as any).mockImplementation(() => wsClient);

    executor = {
      execute: vi.fn(),
      getCurrentWorkingDirectory: vi.fn(() => '~/projects'),
      setWorkingDirectory: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(true),
      resetContext: vi.fn(),
      destroy: vi.fn().mockResolvedValue(undefined),
    };

    guard = new DirectoryGuard(['~/projects', '~/work']);

    const defaultThread = { id: 'default-id', name: 'default', workingDirectory: '~/projects', sessionId: null, createdAt: 0, lastActiveAt: 0 };

    mockThreadManager = {
      getDefaultThread: vi.fn().mockReturnValue(defaultThread),
      getThread: vi.fn().mockImplementation((id: string) => id === defaultThread.id ? defaultThread : undefined),
      getThreadByName: vi.fn().mockImplementation((name: string) => name === 'default' ? defaultThread : undefined),
      listThreads: vi.fn().mockReturnValue([defaultThread]),
      createThread: vi.fn().mockResolvedValue({ id: 'new-id', name: 'thread-2', workingDirectory: '~/projects', sessionId: null, createdAt: Date.now(), lastActiveAt: Date.now() }),
      deleteThread: vi.fn().mockResolvedValue(undefined),
      updateThread: vi.fn().mockImplementation(async (_id: string, updates: any) => ({ ...defaultThread, ...updates })),
      getSessionFilePath: vi.fn().mockReturnValue('/tmp/session.jsonl'),
    } as unknown as ThreadManager;

    mockThreadPool = {
      getExecutor: vi.fn().mockReturnValue(executor),
      isThreadBusy: vi.fn().mockReturnValue(false),
      setThreadBusy: vi.fn(),
      setThreadError: vi.fn(),
      getStatus: vi.fn().mockReturnValue('idle'),
      getSummaries: vi.fn().mockReturnValue([{ id: defaultThread.id, name: 'default', status: 'idle' }]),
      destroyThread: vi.fn().mockResolvedValue(undefined),
      destroyAll: vi.fn().mockResolvedValue(undefined),
      switchBackend: vi.fn().mockResolvedValue(undefined),
    } as unknown as ThreadExecutorPool;

    const mockConfig: any = {
      get: vi.fn(),
      set: vi.fn().mockResolvedValue(undefined),
      has: vi.fn(() => true),
      getAll: vi.fn(() => ({})),
      save: vi.fn().mockResolvedValue(undefined),
    };

    handler = new MessageHandler(wsClient, mockThreadPool, mockThreadManager, guard, mockConfig);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Command execution flow', () => {
    it('should handle simple command message', async () => {
      executor.execute.mockResolvedValueOnce({ success: true, output: 'Task completed successfully' });

      const message: IncomingMessage = {
        type: 'command',
        messageId: 'msg_001',
        content: 'List files in current directory',
        workingDirectory: '~/projects',
        timestamp: Date.now(),
      };

      await handler.handleMessage(message);

      expect(executor.execute).toHaveBeenCalledWith(
        'List files in current directory',
        expect.objectContaining({ onStream: expect.any(Function) })
      );
      expect(wsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'response', messageId: 'msg_001', success: true })
      );
    });

    it('should reject command with unsafe directory', async () => {
      const message: IncomingMessage = {
        type: 'command',
        messageId: 'msg_002',
        content: 'Read /etc/passwd file',
        workingDirectory: '/etc',
        timestamp: Date.now(),
      };

      await handler.handleMessage(message);

      expect(executor.execute).not.toHaveBeenCalled();
      expect(wsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'response', messageId: 'msg_002', success: false, error: expect.stringContaining('whitelist') })
      );
    });

    it('should handle command with streaming progress', async () => {
      executor.execute.mockImplementationOnce(async (_content: string, options: any) => {
        options.onStream?.('Starting code analysis...');
        await new Promise((r) => setTimeout(r, 10));
        options.onStream?.('Fixing errors...');
        await new Promise((r) => setTimeout(r, 10));
        options.onStream?.('Running tests...');
        return { success: true, output: 'All tests passed' };
      });

      const message: IncomingMessage = {
        type: 'command',
        messageId: 'msg_003',
        content: 'Fix TypeScript errors',
        workingDirectory: '~/projects',
        timestamp: Date.now(),
      };

      await handler.handleMessage(message);

      expect(wsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'stream', messageId: 'msg_003', chunk: 'Starting code analysis...' })
      );
      expect(wsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'stream', messageId: 'msg_003', chunk: 'Fixing errors...' })
      );
      expect(wsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'stream', messageId: 'msg_003', chunk: 'Running tests...' })
      );
      expect(wsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'response', messageId: 'msg_003', success: true })
      );
    });

    it('should handle command execution error', async () => {
      executor.execute.mockRejectedValueOnce(new Error('Execution timeout'));

      const message: IncomingMessage = {
        type: 'command',
        messageId: 'msg_004',
        content: 'Complex long-running task',
        workingDirectory: '~/projects',
        timestamp: Date.now(),
      };

      await handler.handleMessage(message);

      expect(wsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'response', messageId: 'msg_004', success: false, error: 'Execution timeout' })
      );
    });
  });

  describe('Special command handling', () => {
    it('should handle resume command', async () => {
      executor.execute.mockResolvedValueOnce({ success: true, output: 'Session resumed' });

      await handler.handleMessage({ type: 'command', messageId: 'msg_005', content: '/resume', workingDirectory: '~/projects', timestamp: Date.now() });

      expect(executor.execute).toHaveBeenCalledWith('Please resume the previous conversation', expect.any(Object));
    });

    it('should handle continue command', async () => {
      executor.execute.mockResolvedValueOnce({ success: true, output: 'Continuing' });

      await handler.handleMessage({ type: 'command', messageId: 'msg_006', content: '/continue', workingDirectory: '~/work', timestamp: Date.now() });

      expect(executor.execute).toHaveBeenCalledWith('Please continue from where we left off', expect.any(Object));
    });

    it('should handle status query', async () => {
      await handler.handleMessage({ type: 'status', messageId: 'msg_007', timestamp: Date.now() });

      expect(wsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'status',
          messageId: 'msg_007',
          status: expect.objectContaining({
            connected: true,
            allowedDirectories: expect.arrayContaining(['~/projects', '~/work']),
            currentWorkingDirectory: expect.any(String),
          }),
        })
      );
    });
  });

  describe('Concurrent command handling (per-thread)', () => {
    it('should reject concurrent commands on same thread (one at a time)', async () => {
      let callCount = 0;
      mockThreadPool.isThreadBusy = vi.fn().mockImplementation(() => callCount++ > 0);

      executor.execute.mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve({ success: true, output: 'Done' }), 100))
      );

      const message1: IncomingMessage = {
        type: 'command', messageId: 'msg_008', content: 'Long running task', workingDirectory: '~/projects', timestamp: Date.now(),
      };
      const message2: IncomingMessage = {
        type: 'command', messageId: 'msg_009', content: 'Another task', workingDirectory: '~/projects', timestamp: Date.now() + 1,
      };

      const promise1 = handler.handleMessage(message1);
      await new Promise((r) => setTimeout(r, 10));
      await handler.handleMessage(message2);

      expect(wsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'response', messageId: 'msg_009', success: false, error: expect.stringContaining('busy') })
      );

      await promise1;
      expect(executor.execute).toHaveBeenCalledTimes(1);
    });
  });

  describe('Directory path resolution', () => {
    it('should resolve tilde paths', async () => {
      executor.execute.mockResolvedValueOnce({ success: true, output: 'File created' });

      await handler.handleMessage({ type: 'command', messageId: 'msg_010', content: 'Create file', workingDirectory: '~/projects', timestamp: Date.now() });

      expect(executor.execute).toHaveBeenCalledWith('Create file', expect.any(Object));
    });

    it('should handle relative paths from allowed directories', async () => {
      executor.execute.mockResolvedValueOnce({ success: true, output: 'Task done' });

      await handler.handleMessage({ type: 'command', messageId: 'msg_011', content: 'Execute task', workingDirectory: '~/projects/my-app', timestamp: Date.now() });

      expect(executor.execute).toHaveBeenCalledWith('Execute task', expect.any(Object));
    });

    it('should reject path traversal attempts', async () => {
      await handler.handleMessage({ type: 'command', messageId: 'msg_012', content: 'Read file', workingDirectory: '~/projects/../../../etc', timestamp: Date.now() });

      expect(executor.execute).not.toHaveBeenCalled();
      expect(wsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'response', messageId: 'msg_012', success: false, error: expect.stringContaining('whitelist') })
      );
    });
  });

  describe('Message validation', () => {
    it('should reject malformed messages', async () => {
      await handler.handleMessage({ type: 'command' } as any);

      expect(executor.execute).not.toHaveBeenCalled();
      expect(wsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: expect.stringContaining('Invalid') })
      );
    });

    it('should handle unknown message types', async () => {
      await handler.handleMessage({ type: 'unknown_type', messageId: 'msg_013', timestamp: Date.now() } as any);

      expect(wsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'msg_013', success: false, error: expect.stringContaining('Unknown message type') })
      );
    });
  });
});
