import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocketClient } from '../../src/client/WebSocketClient';
import { MessageHandler } from '../../src/client/MessageHandler';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { ThreadExecutorPool } from '../../src/thread/ThreadExecutorPool';
import { ThreadManager } from '../../src/thread/ThreadManager';
import { IncomingMessage } from '../../src/types';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';

vi.mock('../../src/client/WebSocketClient');

describe('Integration: Message Flow', () => {
  let home: string;
  let projects: string;
  let wsClient: any;
  let executor: any;
  let guard: DirectoryGuard;
  let handler: MessageHandler;
  let mockThreadPool: any;
  let mockThreadManager: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'message-flow-')));
    projects = path.join(home, 'projects');
    await fs.mkdir(path.join(projects, 'my-app'), { recursive: true });
    await fs.mkdir(path.join(home, 'work'));
    await fs.mkdir(path.join(home, 'restricted'));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('HOMEDRIVE', path.parse(home).root.replace(/[\\/]$/, ''));
    vi.stubEnv('HOMEPATH', home.slice(path.parse(home).root.length - 1));
    // Native catalog overrides must not point outside this fixture's home.
    vi.stubEnv('CODEX_HOME', path.join(home, '.codex'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(home, '.claude'));
    vi.stubEnv('PI_CODING_AGENT_DIR', path.join(home, '.pi', 'agent'));
    vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', undefined);

    wsClient = {
      send: vi.fn(),
      on: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    (WebSocketClient as any).mockImplementation(() => wsClient);

    executor = {
      execute: vi.fn(),
      getCurrentWorkingDirectory: vi.fn(() => projects),
      setWorkingDirectory: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(true),
      resetContext: vi.fn(),
      destroy: vi.fn().mockResolvedValue(undefined),
    };

    guard = new DirectoryGuard(['~/projects', '~/work']);

    const defaultThread = { id: 'default-id', name: 'default', workingDirectory: projects, sessionId: null, createdAt: 0, lastActiveAt: 0 };

    mockThreadManager = {
      contextResets: { assertReady: vi.fn() },
      getDefaultThread: vi.fn().mockReturnValue(defaultThread),
      getThread: vi.fn().mockImplementation((id: string) => id === defaultThread.id ? defaultThread : undefined),
      getThreadByName: vi.fn().mockImplementation((name: string) => name === 'default' ? defaultThread : undefined),
      listThreads: vi.fn().mockReturnValue([defaultThread]),
      createThread: vi.fn().mockResolvedValue({ id: 'new-id', name: 'thread-2', workingDirectory: projects, sessionId: null, createdAt: Date.now(), lastActiveAt: Date.now() }),
      deleteThread: vi.fn().mockResolvedValue(undefined),
      updateThread: vi.fn().mockImplementation(async (_id: string, updates: any) => Object.assign(defaultThread, updates)),
      getSessionFilePath: vi.fn().mockReturnValue(path.join(home, '.remote-cli', 'session.jsonl')),
    } as unknown as ThreadManager;

    const busy = new Set<string>();
    mockThreadPool = {
      getExecutor: vi.fn().mockReturnValue(executor),
      getExistingExecutor: vi.fn().mockReturnValue(executor),
      setWorkingDirectory: vi.fn(async (_id: string, target: string) => {
        const previous = executor.getCurrentWorkingDirectory();
        const cwd = guard.resolveWorkingDirectory(target, previous);
        if (!(await fs.stat(cwd)).isDirectory()) throw new Error('Not a directory');
        executor.getCurrentWorkingDirectory.mockReturnValue(cwd);
        defaultThread.workingDirectory = cwd;
        return { cwd, changed: cwd !== previous };
      }),
      isThreadBusy: vi.fn((id: string) => busy.has(id)),
      setThreadBusy: vi.fn((id: string, value: boolean) => { if (value) busy.add(id); else busy.delete(id); }),
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
      getConfigDir: vi.fn(() => path.join(home, '.remote-cli')),
    };

    handler = new MessageHandler(wsClient, mockThreadPool, mockThreadManager, guard, mockConfig);
  });

  afterEach(async () => {
    try { await handler?.destroy(); }
    finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await fs.rm(home, { recursive: true, force: true });
    }
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
        content: 'Read restricted file',
        workingDirectory: path.join(home, 'restricted'),
        timestamp: Date.now(),
      };

      await handler.handleMessage(message);

      expect(executor.execute).not.toHaveBeenCalled();
      expect(wsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'response', messageId: 'msg_002', success: false, error: expect.stringContaining('whitelist') })
      );
    });

    it('still rejects ordinary execution when the isolated home has uncertain worker ownership', async () => {
      await fs.mkdir(path.join(home, '.remote-cli'));
      await fs.writeFile(path.join(home, '.remote-cli', 'delegation-workers.ownership'), 'synthetic unknown owner');
      await handler.handleMessage({ type: 'command', messageId: 'uncertain-worker', content: 'Run a task' });
      expect(executor.execute).not.toHaveBeenCalled();
      expect(wsClient.send).toHaveBeenCalledWith(expect.objectContaining({
        messageId: 'uncertain-worker', success: false, error: expect.stringContaining('may still write files'),
      }));
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
      await handler.handleMessage({ type: 'command', messageId: 'resume-pi-id', content: '/resume id native-example',
        isSlashCommand: true, openId: 'owner-example', timestamp: Date.now() });
      expect(executor.execute).not.toHaveBeenCalled();
      expect(mockThreadPool.getExecutor).not.toHaveBeenCalled();
      expect(wsClient.send).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: expect.stringContaining('No Pi session with that ID') }));
    });

    it('lists Pi sessions read-only when sharing is enabled, without constructing an executor', async () => {
      mockThreadPool.getBackendKey.mockReturnValue('pi');
      (handler as any).config.get.mockImplementation((key: string) => key === 'sessionSharing' ? { enabled: true } : undefined);
      await handler.handleMessage({ type: 'command', messageId: 'resume-list', content: '/resume', isSlashCommand: true, timestamp: Date.now() });
      expect(mockThreadPool.getExecutor).not.toHaveBeenCalled();
      expect(executor.execute).not.toHaveBeenCalled();
      expect(wsClient.send).toHaveBeenCalledWith(expect.objectContaining({
        messageId: 'resume-list', success: true, output: expect.stringContaining('read-only'),
      }));
      const sent = wsClient.send.mock.calls.map((call: any[]) => call[0]).find((m: any) => m.messageId === 'resume-list');
      expect(sent.output).toContain('nothing is loaded and no task is sent until you confirm');
    });

    it('lists Codex sessions read-only on a Codex thread without constructing an executor', async () => {
      // The native catalog is empty inside the isolated fixture home.
      mockThreadPool.getBackendKey.mockReturnValue('codex');
      (handler as any).config.get.mockImplementation((key: string) => key === 'sessionSharing' ? { enabled: true } : undefined);
      await handler.handleMessage({ type: 'command', messageId: 'resume-codex', content: '/resume', isSlashCommand: true, timestamp: Date.now() });
      expect(mockThreadPool.getExecutor).not.toHaveBeenCalled();
      expect(executor.execute).not.toHaveBeenCalled();
      const sent = wsClient.send.mock.calls.map((call: any[]) => call[0]).find((m: any) => m.messageId === 'resume-codex');
      expect(sent.success).toBe(true);
      expect(sent.output).toContain('Codex sessions in this workspace');
      expect(sent.output).toContain('No Codex sessions were found');
    });

    it('lists Claude Code sessions read-only on a Claude thread without constructing an executor', async () => {
      // The fixture project has no transcripts, so the answer is an empty catalog.
      (handler as any).config.get.mockImplementation((key: string) => key === 'sessionSharing' ? { enabled: true } : undefined);
      await handler.handleMessage({ type: 'command', messageId: 'resume-claude', content: '/resume', isSlashCommand: true, timestamp: Date.now() });
      expect(mockThreadPool.getExecutor).not.toHaveBeenCalled();
      expect(executor.execute).not.toHaveBeenCalled();
      const sent = wsClient.send.mock.calls.map((call: any[]) => call[0]).find((m: any) => m.messageId === 'resume-claude');
      expect(sent.success).toBe(true);
      expect(sent.output).toContain('Claude Code sessions in this workspace');
      expect(sent.output).toContain('No Claude Code sessions were found');
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
      expect(executor.getCurrentWorkingDirectory()).toBe(path.join(home, 'work'));
      expect(mockThreadManager.getDefaultThread().workingDirectory).toBe(path.join(home, 'work'));
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
      let finish!: () => void;
      const execution = new Promise<{ success: boolean; output: string }>(resolve => {
        finish = () => resolve({ success: true, output: 'Done' });
      });
      executor.execute.mockReturnValueOnce(execution);

      const message1: IncomingMessage = {
        type: 'command', messageId: 'msg_008', content: 'Long running task', workingDirectory: '~/projects', timestamp: Date.now(),
      };
      const message2: IncomingMessage = {
        type: 'command', messageId: 'msg_009', content: 'Another task', workingDirectory: '~/projects', timestamp: Date.now() + 1,
      };

      const promise1 = handler.handleMessage(message1);
      try {
        await vi.waitFor(() => expect(executor.execute).toHaveBeenCalledOnce());
        expect(mockThreadPool.isThreadBusy('default-id')).toBe(true);
        await handler.handleMessage(message2);
        expect(wsClient.send).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'response', messageId: 'msg_009', success: false, queueConfirmation: expect.any(Object) })
        );
      } finally {
        finish();
        await promise1;
      }
      expect(executor.execute).toHaveBeenCalledTimes(1);
      expect(mockThreadPool.isThreadBusy('default-id')).toBe(false);
    });
  });

  describe('Directory path resolution', () => {
    it('should resolve tilde paths', async () => {
      executor.execute.mockResolvedValueOnce({ success: true, output: 'File created' });

      await handler.handleMessage({ type: 'command', messageId: 'msg_010', content: 'Create file', workingDirectory: '~/projects', timestamp: Date.now() });

      expect(executor.execute).toHaveBeenCalledWith('Create file', expect.any(Object));
      expect(executor.getCurrentWorkingDirectory()).toBe(projects);
      expect(mockThreadManager.getDefaultThread().workingDirectory).toBe(projects);
    });

    it('should handle relative paths from allowed directories', async () => {
      executor.execute.mockResolvedValueOnce({ success: true, output: 'Task done' });

      await handler.handleMessage({ type: 'command', messageId: 'msg_011', content: 'Execute task', workingDirectory: './my-app', timestamp: Date.now() });

      expect(mockThreadPool.setWorkingDirectory).toHaveBeenCalledWith('default-id', './my-app');
      expect(executor.execute).toHaveBeenCalledWith('Execute task', expect.any(Object));
      expect(executor.getCurrentWorkingDirectory()).toBe(path.join(projects, 'my-app'));
      expect(mockThreadManager.getDefaultThread().workingDirectory).toBe(path.join(projects, 'my-app'));
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
      await handler.handleMessage({ type: 'command', messageId: 'msg_012', content: 'Read file', workingDirectory: '~/projects/../restricted', timestamp: Date.now() });

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
