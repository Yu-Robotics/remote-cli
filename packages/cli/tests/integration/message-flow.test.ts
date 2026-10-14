import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocketClient } from '../../src/client/WebSocketClient';
import { MessageHandler } from '../../src/client/MessageHandler';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { ThreadExecutorPool } from '../../src/thread/ThreadExecutorPool';
import { ThreadManager } from '../../src/thread/ThreadManager';
import { IncomingMessage } from '../../src/types';
import os from 'os';
import path from 'path';

// Mock os.homedir() to respect process.env.HOME for isolated tests
const originalHomedir = os.homedir();
vi.spyOn(os, 'homedir').mockImplementation(() => process.env.HOME || originalHomedir);

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
      setWorkingDirectory: vi.fn().mockResolvedValue({ cwd: path.join(os.homedir(), 'projects'), changed: false }),
      isThreadBusy: vi.fn().mockReturnValue(false),
      setThreadBusy: vi.fn(),
      setThreadError: vi.fn(),
      getStatus: vi.fn().mockReturnValue('idle'),
      getSummaries: vi.fn().mockReturnValue([{ id: defaultThread.id, name: 'default', status: 'idle' }]),
      getBackendKey: vi.fn().mockReturnValue('claude'),
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
      getConfigDir: vi.fn(() => '/tmp/test-config'),
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
    it.each([true, false])('intercepts resume without a model prompt (real slash envelope: %s)', async isSlashCommand => {
      await handler.handleMessage({ type: 'command', messageId: 'msg_005', content: '/resume',
        isSlashCommand, workingDirectory: '~/projects', timestamp: Date.now() });

      expect(executor.execute).not.toHaveBeenCalled();
      expect(mockThreadPool.getExecutor).not.toHaveBeenCalled();
      expect(mockThreadPool.setWorkingDirectory).not.toHaveBeenCalled();
      expect(mockThreadManager.updateThread).not.toHaveBeenCalled();
      expect(wsClient.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'response', messageId: 'msg_005', success: false, error: expect.stringContaining('disabled'),
      }));
    });

    it.each(['claude', 'codex', 'agy', 'opencode', 'kimi', 'zcode', 'dsh'])('fails closed for unverified %s without constructing its executor', async backend => {
      mockThreadPool.getBackendKey.mockReturnValue(backend);
      (handler as any).config.get.mockImplementation((key: string) => key === 'sessionSharing' ? { enabled: true } : undefined);
      await handler.handleMessage({ type: 'command', messageId: 'resume-native', content: '/resume id native-example',
        isSlashCommand: true, openId: 'owner-example', timestamp: Date.now() });
      expect(executor.execute).not.toHaveBeenCalled();
      expect(mockThreadPool.getExecutor).not.toHaveBeenCalled();
      expect(wsClient.send).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: expect.stringContaining('not available') }));
    });

    it('rejects an unknown Pi session ID without constructing its executor', async () => {
      mockThreadPool.getBackendKey.mockReturnValue('pi');
      (handler as any).config.get.mockImplementation((key: string) => key === 'sessionSharing' ? { enabled: true } : undefined);
      const guardSpy = vi.spyOn(guard, 'isSafePath').mockReturnValue(true);
      await handler.handleMessage({ type: 'command', messageId: 'resume-pi-id', content: '/resume id native-example',
        isSlashCommand: true, openId: 'owner-example', timestamp: Date.now() });
      expect(executor.execute).not.toHaveBeenCalled();
      expect(mockThreadPool.getExecutor).not.toHaveBeenCalled();
      expect(wsClient.send).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: expect.stringContaining('No Pi session with that ID') }));
      guardSpy.mockRestore();
    });

    it('lists Pi sessions read-only when sharing is enabled, without constructing an executor', async () => {
      mockThreadPool.getBackendKey.mockReturnValue('pi');
      (handler as any).config.get.mockImplementation((key: string) => key === 'sessionSharing' ? { enabled: true } : undefined);
      const guardSpy = vi.spyOn(guard, 'isSafePath').mockReturnValue(true);
      await handler.handleMessage({ type: 'command', messageId: 'resume-list', content: '/resume', isSlashCommand: true, timestamp: Date.now() });
      expect(mockThreadPool.getExecutor).not.toHaveBeenCalled();
      expect(executor.execute).not.toHaveBeenCalled();
      expect(wsClient.send).toHaveBeenCalledWith(expect.objectContaining({
        messageId: 'resume-list', success: true, output: expect.stringContaining('read-only'),
      }));
      const sent = wsClient.send.mock.calls.map((call: any[]) => call[0]).find((m: any) => m.messageId === 'resume-list');
      expect(sent.output).toContain('nothing is loaded and no task is sent until you confirm');
      guardSpy.mockRestore();
    });

    it('lists Codex sessions read-only on a Codex thread without constructing an executor', async () => {
      // os.homedir() is pinned by the suite setup, so the adapter's default HOME is the real one.
      mockThreadPool.getBackendKey.mockReturnValue('codex');
      (handler as any).config.get.mockImplementation((key: string) => key === 'sessionSharing' ? { enabled: true } : undefined);
      const guardSpy = vi.spyOn(guard, 'isSafePath').mockReturnValue(true);
      await handler.handleMessage({ type: 'command', messageId: 'resume-codex', content: '/resume', isSlashCommand: true, timestamp: Date.now() });
      expect(mockThreadPool.getExecutor).not.toHaveBeenCalled();
      expect(executor.execute).not.toHaveBeenCalled();
      const sent = wsClient.send.mock.calls.map((call: any[]) => call[0]).find((m: any) => m.messageId === 'resume-codex');
      expect(sent.success).toBe(true);
      expect(sent.output).toContain('Codex sessions in this workspace');
      expect(sent.output).toContain('not available yet');
      guardSpy.mockRestore();
    });

    it('lists Claude Code sessions read-only on a Claude thread without constructing an executor', async () => {
      // The default backend for this suite is claude; the real project store for this
      // workspace has no transcripts, so the answer is an explicit empty catalog.
      (handler as any).config.get.mockImplementation((key: string) => key === 'sessionSharing' ? { enabled: true } : undefined);
      const guardSpy = vi.spyOn(guard, 'isSafePath').mockReturnValue(true);
      await handler.handleMessage({ type: 'command', messageId: 'resume-claude', content: '/resume', isSlashCommand: true, timestamp: Date.now() });
      expect(mockThreadPool.getExecutor).not.toHaveBeenCalled();
      expect(executor.execute).not.toHaveBeenCalled();
      const sent = wsClient.send.mock.calls.map((call: any[]) => call[0]).find((m: any) => m.messageId === 'resume-claude');
      expect(sent.success).toBe(true);
      expect(sent.output).toContain('Claude Code sessions in this workspace');
      expect(sent.output).toContain('not available yet');
      guardSpy.mockRestore();
    });

    it('rejects a catalog request for a disallowed working directory', async () => {
      mockThreadPool.getBackendKey.mockReturnValue('pi');
      (handler as any).config.get.mockImplementation((key: string) => key === 'sessionSharing' ? { enabled: true } : undefined);
      const guardSpy = vi.spyOn(guard, 'isSafePath').mockReturnValue(false);
      await handler.handleMessage({ type: 'command', messageId: 'resume-denied', content: '/r', timestamp: Date.now() });
      expect(wsClient.send).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'resume-denied', success: false, error: expect.stringContaining('not allowed') }));
      guardSpy.mockRestore();
    });

    it('returns thread summaries so the card heading resolves without constructing an executor', async () => {
      await handler.handleMessage({ type: 'command', messageId: 'resume-heading', content: '/resume', isSlashCommand: true, timestamp: Date.now() });
      expect(mockThreadPool.getExecutor).not.toHaveBeenCalled();
      expect(wsClient.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'response', messageId: 'resume-heading', threadId: 'default-id',
        threads: [expect.objectContaining({ id: 'default-id', name: 'default' })],
      }));
    });

    it('keeps resume and session inspection responsive while ordinary work is busy', async () => {
      mockThreadPool.isThreadBusy.mockReturnValue(true);
      await handler.handleMessage({ type: 'command', messageId: 'session-control', content: '/session', isSlashCommand: true, timestamp: Date.now() });
      expect(mockThreadPool.getExecutor).not.toHaveBeenCalled();
      expect(mockThreadPool.setThreadBusy).not.toHaveBeenCalled();
      expect(executor.execute).not.toHaveBeenCalled();
    });

    it('rejects a session control for a missing thread rather than falling back to default', async () => {
      await handler.handleMessage({ type: 'command', messageId: 'session-missing', threadId: 'missing-thread', content: '/r', timestamp: Date.now() });
      expect(mockThreadPool.getBackendKey).not.toHaveBeenCalled();
      expect(mockThreadPool.getExecutor).not.toHaveBeenCalled();
      expect(wsClient.send).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: expect.stringContaining('no longer exists') }));
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
        expect.objectContaining({ type: 'response', messageId: 'msg_009', success: false, queueConfirmation: expect.any(Object) })
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
      executor.getCurrentWorkingDirectory.mockReturnValue(path.join(os.homedir(), 'projects'));

      await handler.handleMessage({ type: 'command', messageId: 'msg_011', content: 'Execute task', workingDirectory: './my-app', timestamp: Date.now() });

      expect(mockThreadPool.setWorkingDirectory).toHaveBeenCalledWith('default-id', './my-app');
      expect(executor.execute).toHaveBeenCalledWith('Execute task', expect.any(Object));
    });

    it('does not execute a prompt if the directory and session transition fails', async () => {
      mockThreadPool.setWorkingDirectory.mockRejectedValueOnce(new Error('Cannot remove stale session binding'));

      await handler.handleMessage({ type: 'command', messageId: 'failed-cd', content: 'Execute task', workingDirectory: '~/work', timestamp: Date.now() });

      expect(executor.execute).not.toHaveBeenCalled();
      expect(wsClient.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'response', messageId: 'failed-cd', success: false, error: 'Cannot remove stale session binding',
      }));
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
