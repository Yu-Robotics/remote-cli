import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { MessageHandler } from '../src/client/MessageHandler';
import { WebSocketClient } from '../src/client/WebSocketClient';
import { DirectoryGuard } from '../src/security/DirectoryGuard';
import { ThreadExecutorPool } from '../src/thread/ThreadExecutorPool';
import { ThreadManager } from '../src/thread/ThreadManager';

vi.mock('../src/client/WebSocketClient');

vi.mock('child_process', async (importActual) => {
  const actual = await importActual<typeof import('child_process')>();
  return { ...actual, spawn: vi.fn() };
});

const mockSpawn = vi.mocked(spawn);

/** A fake ChildProcess with EventEmitter stdout/stderr. */
function fakeChild() {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

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
    getConfigDir: vi.fn(() => '/tmp/test-config'),
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
    getBackendKey: vi.fn().mockImplementation(() => {
      const config = mockConfig.get('executor');
      const type = config?.type as string | undefined;
      return type === 'agy' || type === 'gemini' ? 'agy' : type === 'codex' ? 'codex' : 'claude';
    }),
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

    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    ctx = buildHandler();
  });

  afterEach(async () => {
    await ctx.handler.destroy();
  });

  describe('multimodal prompts', () => {
    it('should pass attachments to executor.execute', async () => {
      ctx.mockExecutor.execute.mockResolvedValue({ success: true, output: 'Saw the image' });

      const message = {
        type: 'command',
        messageId: 'msg-img',
        content: 'describe this',
        attachments: [{
          type: 'image',
          data: 'base64data',
          mimeType: 'image/png'
        }],
        timestamp: Date.now(),
      };

      await ctx.handler.handleMessage(message as any);

      expect(ctx.mockExecutor.execute).toHaveBeenCalledWith(
        'describe this',
        expect.objectContaining({
          attachments: [
            expect.objectContaining({ type: 'image', data: 'base64data' })
          ]
        })
      );
    });

    it('should handle images with empty content', async () => {
      ctx.mockExecutor.execute.mockResolvedValue({ success: true, output: 'Saw the image' });

      const message = {
        type: 'command',
        messageId: 'msg-img-only',
        content: '',
        attachments: [{
          type: 'image',
          data: 'base64data',
          mimeType: 'image/png'
        }],
        timestamp: Date.now(),
      };

      await ctx.handler.handleMessage(message as any);

      expect(ctx.mockExecutor.execute).toHaveBeenCalledWith(
        '',
        expect.objectContaining({
          attachments: [expect.any(Object)]
        })
      );
    });
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

  describe('model command', () => {
    it('should switch model and persist it to ThreadManager', async () => {
      ctx.mockExecutor.setModel = vi.fn().mockResolvedValue({ success: true, output: 'Model set to opus.' });

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-model', content: '/model opus', timestamp: Date.now() });

      expect(ctx.mockExecutor.setModel).toHaveBeenCalledWith('opus', expect.any(Function));
      // Claude backend: persist under models.claude and keep the legacy
      // `model` field in sync.
      expect(ctx.mockThreadManager.updateThread).toHaveBeenCalledWith(
        'default-thread-id',
        { model: 'opus', models: { claude: 'opus' } }
      );
      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'response', messageId: 'msg-model', success: true })
      );
    });

    it('should persist the model under the agy key when the AGY backend is active', async () => {
      ctx.mockConfig.get.mockImplementation((key: string) =>
        key === 'executor' ? { type: 'agy' } : undefined
      );
      ctx.mockExecutor.setModel = vi.fn().mockResolvedValue({ success: true, output: 'Model set.' });

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-model-agy', content: '/model gemini-3.1-pro-high', timestamp: Date.now() });

      expect(ctx.mockThreadManager.updateThread).toHaveBeenCalledWith(
        'default-thread-id',
        { models: { agy: 'gemini-3.1-pro-high' } }
      );
      // Must NOT touch the legacy (claude-only) model field
      expect(ctx.mockThreadManager.updateThread).not.toHaveBeenCalledWith(
        'default-thread-id',
        expect.objectContaining({ model: expect.anything() })
      );
    });

    it('should merge with existing per-backend models', async () => {
      ctx.mockConfig.get.mockImplementation((key: string) =>
        key === 'executor' ? { type: 'codex' } : undefined
      );
      ctx.mockThreadManager.getThread.mockReturnValue({
        id: 'default-thread-id', name: 'default', workingDirectory: '/home/user/test-project',
        sessionId: null, createdAt: 0, lastActiveAt: 0,
        models: { agy: 'gemini-3.8-flash-low' },
      });
      ctx.mockExecutor.setModel = vi.fn().mockResolvedValue({ success: true, output: 'Model set.' });

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-model-codex', content: '/model gpt-5.2-codex', timestamp: Date.now() });

      expect(ctx.mockThreadManager.updateThread).toHaveBeenCalledWith(
        'default-thread-id',
        { models: { agy: 'gemini-3.8-flash-low', codex: 'gpt-5.2-codex' } }
      );
    });

    it('should not persist model when setModel fails', async () => {
      ctx.mockExecutor.setModel = vi.fn().mockResolvedValue({ success: false, error: 'Unknown model' });

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-model-fail', content: '/model bogus', timestamp: Date.now() });

      expect(ctx.mockThreadManager.updateThread).not.toHaveBeenCalledWith(
        'default-thread-id',
        expect.objectContaining({ model: expect.anything() })
      );
      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'response', messageId: 'msg-model-fail', success: false, error: 'Unknown model' })
      );
    });

    it('should return error when executor does not support setModel', async () => {
      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-model-unsupported', content: '/model opus', timestamp: Date.now() });

      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: expect.stringContaining('not supported') })
      );
    });
  });

  describe('bare /model (list models for the active backend)', () => {
    function useBackend(executorConfig: any, threadOverrides: any = {}) {
      ctx.mockConfig.get.mockImplementation((key: string) =>
        key === 'executor' ? executorConfig : undefined
      );
      const thread = {
        id: 'default-thread-id', name: 'default', workingDirectory: '/home/user/test-project',
        sessionId: null, createdAt: 0, lastActiveAt: 0, ...threadOverrides,
      };
      ctx.mockThreadManager.getThread.mockImplementation((id: string) => id === thread.id ? thread : undefined);
      ctx.mockThreadManager.getDefaultThread.mockReturnValue(thread);
      return thread;
    }

    async function runBareModel() {
      const child = fakeChild();
      mockSpawn.mockReturnValue(child);
      const p = ctx.handler.handleMessage({
        type: 'command', messageId: 'msg-model-list', content: '/model', timestamp: Date.now(),
      } as any);
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
      return { child, done: p };
    }

    it('claude: lists models via claude --print /model and shows the current selection', async () => {
      useBackend(undefined, { models: { claude: 'opus' } });
      const { child, done } = await runBareModel();

      expect(mockSpawn).toHaveBeenCalledWith('claude', ['/model', '--print'], expect.anything());

      child.stdout.emit('data', Buffer.from('Current model: sonnet\nUsage: /model <name>. Available: sonnet, opus, haiku'));
      child.emit('exit', 0);
      await done;

      const call = ctx.mockWsClient.send.mock.calls.find((c: any[]) => c[0].messageId === 'msg-model-list' && c[0].type === 'response');
      expect(call[0].success).toBe(true);
      expect(call[0].output).toContain('opus');                       // current thread selection
      expect(call[0].output).toContain('sonnet, opus, haiku');        // available list
    });

    it('agy: lists models via agy models and shows the per-backend selection', async () => {
      useBackend({ type: 'agy' }, { models: { agy: 'gemini-3.1-pro-high' } });
      const { child, done } = await runBareModel();

      expect(mockSpawn).toHaveBeenCalledWith('agy', ['models'], expect.anything());

      child.stdout.emit('data', Buffer.from('gemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)'));
      child.emit('exit', 0);
      await done;

      const call = ctx.mockWsClient.send.mock.calls.find((c: any[]) => c[0].messageId === 'msg-model-list' && c[0].type === 'response');
      expect(call[0].success).toBe(true);
      expect(call[0].output).toContain('gemini-3.1-pro-high');
      expect(call[0].output).toContain('gemini-3.8-flash-high');
    });

    it('agy: honors executor.agy.command override for the listing', async () => {
      useBackend({ type: 'agy', agy: { command: '/opt/agy-x' } });
      const { child, done } = await runBareModel();

      expect(mockSpawn).toHaveBeenCalledWith('/opt/agy-x', ['models'], expect.anything());
      child.emit('exit', 0);
      await done;
    });

    it('codex: lists app-server models and shows the current selection', async () => {
      useBackend({ type: 'codex' }, { models: { codex: 'gpt-5.2-codex' } });
      ctx.mockExecutor.listModels = vi.fn().mockResolvedValue([
        { id: 'gpt-5.2-codex', displayName: 'GPT-5.2 Codex' },
        { id: 'gpt-5.3-codex', displayName: 'GPT-5.3 Codex', isDefault: true },
      ]);

      await ctx.handler.handleMessage({
        type: 'command', messageId: 'msg-model-list', content: '/model', timestamp: Date.now(),
      } as any);

      expect(mockSpawn).not.toHaveBeenCalled();
      const call = ctx.mockWsClient.send.mock.calls.find((c: any[]) => c[0].messageId === 'msg-model-list' && c[0].type === 'response');
      expect(call[0].success).toBe(true);
      expect(call[0].output).toContain('gpt-5.2-codex');
      expect(call[0].output).toContain('gpt-5.3-codex');
      expect(ctx.mockExecutor.listModels).toHaveBeenCalledOnce();
    });

    it('shows "backend default" when no model has been selected', async () => {
      useBackend({ type: 'agy' });
      const { child, done } = await runBareModel();

      child.stdout.emit('data', Buffer.from('gemini-3.8-flash-high\tGemini 3.8 Flash (High)'));
      child.emit('exit', 0);
      await done;

      const call = ctx.mockWsClient.send.mock.calls.find((c: any[]) => c[0].messageId === 'msg-model-list' && c[0].type === 'response');
      expect(call[0].output).toMatch(/default/i);
    });

    it('degrades gracefully when the listing command fails', async () => {
      useBackend({ type: 'agy' }, { models: { agy: 'gemini-3.1-pro-high' } });
      const { child, done } = await runBareModel();

      child.stderr.emit('data', Buffer.from('network error'));
      child.emit('exit', 1);
      await done;

      const call = ctx.mockWsClient.send.mock.calls.find((c: any[]) => c[0].messageId === 'msg-model-list' && c[0].type === 'response');
      expect(call[0].success).toBe(true);
      expect(call[0].output).toContain('gemini-3.1-pro-high');   // current still shown
    });

    it('degrades gracefully when the listing command hangs', async () => {
      useBackend({ type: 'agy' });
      const { done } = await runBareModel();
      // Never emit exit — the listing helper must time out on its own
      await done;

      const call = ctx.mockWsClient.send.mock.calls.find((c: any[]) => c[0].messageId === 'msg-model-list' && c[0].type === 'response');
      expect(call[0].success).toBe(true);
    }, 20000);
  });

  describe('effort command', () => {
    it('sets and persists Codex reasoning effort', async () => {
      ctx.mockConfig.get.mockImplementation((key: string) =>
        key === 'executor' ? { type: 'codex' } : undefined
      );
      ctx.mockExecutor.setEffort = vi.fn().mockResolvedValue({ success: true, output: 'Reasoning effort set to high.' });

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-effort', content: '/effort high', timestamp: Date.now() });

      expect(ctx.mockExecutor.setEffort).toHaveBeenCalledWith('high');
      expect(ctx.mockThreadManager.updateThread).toHaveBeenCalledWith(
        'default-thread-id',
        { efforts: { codex: 'high' } }
      );
      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, output: 'Reasoning effort set to high.' })
      );
    });

    it('removes the persisted Codex override after auto succeeds', async () => {
      ctx.mockConfig.get.mockImplementation((key: string) =>
        key === 'executor' ? { type: 'codex' } : undefined
      );
      ctx.mockThreadManager.getThread.mockReturnValue({
        id: 'default-thread-id', name: 'default', workingDirectory: '/home/user/test-project',
        sessionId: null, createdAt: 0, lastActiveAt: 0,
        efforts: { codex: 'high' },
      });
      ctx.mockExecutor.setEffort = vi.fn().mockResolvedValue({ success: true, output: 'Restored.' });

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-effort-auto', content: '/effort auto', timestamp: Date.now() });

      expect(ctx.mockThreadManager.updateThread).toHaveBeenCalledWith(
        'default-thread-id',
        { efforts: undefined }
      );
    });

    it('lists Codex effort metadata for the active model', async () => {
      ctx.mockConfig.get.mockImplementation((key: string) =>
        key === 'executor' ? { type: 'codex', codex: { model: 'gpt-a' } } : undefined
      );
      ctx.mockExecutor.listModels = vi.fn().mockResolvedValue([{ id: 'gpt-a', displayName: 'GPT A', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['low', 'medium', 'high'] }]);

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-effort-list', content: '/effort', timestamp: Date.now() });

      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        output: expect.stringContaining('Model default: medium'),
      }));
    });

    it('sets and persists AGY reasoning effort', async () => {
      ctx.mockConfig.get.mockImplementation((key: string) =>
        key === 'executor' ? { type: 'agy' } : undefined
      );
      ctx.mockExecutor.setEffort = vi.fn().mockResolvedValue({ success: true, output: 'Reasoning effort set to medium.' });

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-agy-effort', content: '/effort medium', timestamp: Date.now() });

      expect(ctx.mockExecutor.setEffort).toHaveBeenCalledWith('medium');
      expect(ctx.mockThreadManager.updateThread).toHaveBeenCalledWith(
        'default-thread-id',
        { efforts: { agy: 'medium' } }
      );
    });

    it('lists AGY effort levels without invoking the executor', async () => {
      ctx.mockConfig.get.mockImplementation((key: string) =>
        key === 'executor' ? { type: 'agy' } : undefined
      );
      ctx.mockExecutor.setEffort = vi.fn();
      ctx.mockThreadManager.getThread.mockReturnValue({
        id: 'default-thread-id', name: 'default', workingDirectory: '/home/user/test-project',
        sessionId: null, createdAt: 0, lastActiveAt: 0,
        efforts: { agy: 'low' },
      });

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-agy-effort-list', content: '/effort', timestamp: Date.now() });

      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        output: expect.stringContaining('Supported levels: low, medium, high'),
      }));
      expect(ctx.mockExecutor.setEffort).not.toHaveBeenCalled();
    });

    it('removes only the persisted AGY override after auto succeeds', async () => {
      ctx.mockConfig.get.mockImplementation((key: string) =>
        key === 'executor' ? { type: 'agy' } : undefined
      );
      ctx.mockThreadManager.getThread.mockReturnValue({
        id: 'default-thread-id', name: 'default', workingDirectory: '/home/user/test-project',
        sessionId: null, createdAt: 0, lastActiveAt: 0,
        efforts: { agy: 'high', codex: 'medium' },
      });
      ctx.mockExecutor.setEffort = vi.fn().mockResolvedValue({ success: true, output: 'Restored.' });

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-agy-effort-auto', content: '/effort auto', timestamp: Date.now() });

      expect(ctx.mockThreadManager.updateThread).toHaveBeenCalledWith(
        'default-thread-id',
        { efforts: { codex: 'medium' } }
      );
    });

    it('reports effort as not supported yet on Claude Code', async () => {
      ctx.mockConfig.get.mockImplementation((key: string) =>
        key === 'executor' ? { type: 'claude-persistent' } : undefined
      );

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-effort-claude', content: '/effort high', timestamp: Date.now() });

      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: expect.stringContaining('not supported yet'),
      }));
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

    it('clears a persisted unavailable Codex model and retries with the default', async () => {
      const unavailableModelError = '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.2-codex\' model is not supported when using Codex with a ChatGPT account."}}';
      ctx.mockConfig.get.mockImplementation((key: string) =>
        key === 'executor' ? { type: 'codex', codex: { transport: 'exec' } } : undefined
      );
      ctx.mockThreadManager.getThread.mockReturnValue({
        id: 'default-thread-id',
        name: 'default',
        workingDirectory: '/home/user/test-project',
        sessionId: null,
        createdAt: 0,
        lastActiveAt: 0,
        models: { agy: 'gemini-3.8-flash-low', codex: 'gpt-5.2-codex' },
      });
      ctx.mockExecutor.clearModel = vi.fn();
      ctx.mockExecutor.execute
        .mockResolvedValueOnce({ success: false, error: unavailableModelError })
        .mockResolvedValueOnce({ success: true, output: 'recovered' });

      await ctx.handler.handleMessage({
        type: 'command',
        messageId: 'msg-invalid-codex-model',
        content: 'continue the task',
        timestamp: Date.now(),
      });

      expect(ctx.mockThreadManager.updateThread).toHaveBeenCalledWith(
        'default-thread-id',
        { models: { agy: 'gemini-3.8-flash-low' } }
      );
      expect(ctx.mockExecutor.clearModel).toHaveBeenCalledOnce();
      expect(ctx.mockExecutor.execute).toHaveBeenCalledTimes(2);
      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'stream',
        messageId: 'msg-invalid-codex-model',
        chunk: expect.stringContaining('retrying with the backend default'),
      }));
      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'response',
        messageId: 'msg-invalid-codex-model',
        success: true,
      }));
    });
  });

  describe('cleanup', () => {
    it('should cleanup resources on destroy', async () => {
      await ctx.handler.destroy();
      expect(ctx.mockThreadPool.destroyAll).toHaveBeenCalledWith({ deleteData: false });
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

      expect(ctx.mockThreadManager.createThread).toHaveBeenCalledWith('my-feat', expect.any(String), 'claude');
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

    it('returns error when threadId does not exist', async () => {
      ctx.mockThreadManager.getThread = vi.fn().mockReturnValue(undefined);

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-notfound', content: 'hello', threadId: 'ghost-id', timestamp: Date.now() });

      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: expect.stringContaining('Thread not found') })
      );
      expect(ctx.mockExecutor.execute).not.toHaveBeenCalled();
    });

    it('routes to default thread when threadId is absent', async () => {
      ctx.mockExecutor.execute.mockResolvedValue({ success: true });

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-nothread', content: 'hello', timestamp: Date.now() });

      expect(ctx.mockThreadManager.getDefaultThread).toHaveBeenCalled();
      expect(ctx.mockThreadPool.getExecutor).toHaveBeenCalledWith('default-thread-id');
    });

    it('should auto-generate thread name when /thread new has no name', async () => {
      ctx.mockThreadManager.listThreads = vi.fn().mockReturnValue([
        { id: 'default-thread-id', name: 'default', workingDirectory: '/tmp', sessionId: null, createdAt: 0, lastActiveAt: 0 },
      ]);

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-tn-auto', content: '/thread new', timestamp: Date.now() });

      expect(ctx.mockThreadManager.createThread).toHaveBeenCalledWith('thread-2', expect.any(String), 'claude');
    });

    it('should use timestamp fallback when all auto thread names are taken', async () => {
      const existingThreads = Array.from({ length: 98 }, (_, i) => ({
        id: `id-${i + 2}`, name: `thread-${i + 2}`, workingDirectory: '/tmp', sessionId: null, createdAt: i, lastActiveAt: i,
      }));
      existingThreads.unshift({ id: 'default-thread-id', name: 'default', workingDirectory: '/tmp', sessionId: null, createdAt: 0, lastActiveAt: 0 });
      ctx.mockThreadManager.listThreads = vi.fn().mockReturnValue(existingThreads);

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-tn-ts', content: '/thread new', timestamp: Date.now() });

      const callArg = (ctx.mockThreadManager.createThread as any).mock.calls[0][0];
      expect(callArg).toMatch(/^thread-\d+$/);
      expect(callArg).not.toBe('thread-99');
    });

    it('should return error when /thread delete has no name argument', async () => {
      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-td-noname', content: '/thread delete', timestamp: Date.now() });

      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: expect.stringContaining('Usage') })
      );
    });

    it('should return error when /thread delete targets non-existent thread', async () => {
      ctx.mockThreadManager.getThreadByName = vi.fn().mockReturnValue(undefined);

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-td-ghost', content: '/thread delete ghost', timestamp: Date.now() });

      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: expect.stringContaining('not found') })
      );
    });

    it('should return error when deleteThread throws', async () => {
      const targetThread = { id: 'target-id', name: 'my-thread', workingDirectory: '/tmp', sessionId: null, createdAt: 0, lastActiveAt: 0 };
      ctx.mockThreadManager.getThreadByName = vi.fn().mockReturnValue(targetThread);
      ctx.mockThreadPool.isThreadBusy = vi.fn().mockReturnValue(false);
      ctx.mockThreadManager.deleteThread = vi.fn().mockRejectedValue(new Error('Cannot delete default thread'));

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-td-throw', content: '/thread delete my-thread', timestamp: Date.now() });

      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: expect.stringContaining('Cannot delete default thread') })
      );
    });

    it('should return error on unknown /thread subcommand', async () => {
      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-tu', content: '/thread foo', timestamp: Date.now() });

      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: expect.stringContaining('Unknown /thread subcommand') })
      );
    });

    it('should return error when /thread new fails (MAX_THREADS reached)', async () => {
      ctx.mockThreadManager.createThread = vi.fn().mockRejectedValue(new Error('Maximum 5 threads allowed'));

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-tn-max', content: '/thread new feat', timestamp: Date.now() });

      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: expect.stringContaining('Maximum 5 threads allowed') })
      );
    });

    it('should include threads in /thread new success response', async () => {
      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-tn-threads', content: '/thread new my-feat', timestamp: Date.now() });

      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, threads: expect.any(Array) })
      );
    });

    it('should include threads in /thread delete success response', async () => {
      const targetThread = { id: 'target-id', name: 'my-feat', workingDirectory: '/tmp', sessionId: null, createdAt: 0, lastActiveAt: 0 };
      ctx.mockThreadManager.getThreadByName = vi.fn().mockReturnValue(targetThread);
      ctx.mockThreadPool.isThreadBusy = vi.fn().mockReturnValue(false);

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-td-threads', content: '/thread delete my-feat', timestamp: Date.now() });

      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, threads: expect.any(Array) })
      );
    });
  });

  describe('/abort command', () => {
    it('should abort running command and clear busy flag', async () => {
      ctx.mockThreadPool.isThreadBusy = vi.fn().mockReturnValue(true);
      ctx.mockExecutor.abort = vi.fn().mockResolvedValue(true);

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-abort', content: '/abort', timestamp: Date.now() });

      expect(ctx.mockExecutor.abort).toHaveBeenCalled();
      expect(ctx.mockThreadPool.setThreadBusy).toHaveBeenCalledWith('default-thread-id', false);
      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, output: expect.stringContaining('aborted') })
      );
    });

    it('should respond gracefully when abort returns false (nothing executing)', async () => {
      ctx.mockThreadPool.isThreadBusy = vi.fn().mockReturnValue(false);
      ctx.mockExecutor.abort = vi.fn().mockResolvedValue(false);

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-abort-noop', content: '/abort', timestamp: Date.now() });

      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, output: expect.stringContaining('No command is currently executing') })
      );
    });

    it('should abort command on a specific thread (not default)', async () => {
      const otherThread = { id: 'other-id', name: 'thread-2', workingDirectory: '/tmp', sessionId: null, createdAt: 0, lastActiveAt: 0 };
      ctx.mockThreadManager.getThread = vi.fn().mockImplementation((id: string) =>
        id === 'other-id' ? otherThread : undefined
      );
      ctx.mockExecutor.abort = vi.fn().mockResolvedValue(true);

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-abort-t2', content: '/abort', threadId: 'other-id', timestamp: Date.now() });

      expect(ctx.mockThreadPool.getExecutor).toHaveBeenCalledWith('other-id');
      expect(ctx.mockExecutor.abort).toHaveBeenCalled();
    });

    it('should notify user if abort was called when not busy (executor reset)', async () => {
      ctx.mockThreadPool.isThreadBusy = vi.fn().mockReturnValue(false);
      ctx.mockExecutor.abort = vi.fn().mockResolvedValue(true);

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-abort-reset', content: '/abort', timestamp: Date.now() });

      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, output: expect.stringContaining('No command was executing') })
      );
    });
  });

  describe('interactive input mode', () => {
    it('should call sendInput when executor is waiting for input', async () => {
      ctx = buildHandler({
        isWaitingInput: vi.fn().mockReturnValue(true),
        sendInput: vi.fn().mockReturnValue(true),
      });

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-input', content: 'yes', timestamp: Date.now() });

      expect(ctx.mockExecutor.sendInput).toHaveBeenCalledWith('yes');
      expect(ctx.mockExecutor.execute).not.toHaveBeenCalled();
      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, output: expect.stringContaining('yes') })
      );
    });

    it('should return error when sendInput returns false', async () => {
      ctx = buildHandler({
        isWaitingInput: vi.fn().mockReturnValue(true),
        sendInput: vi.fn().mockReturnValue(false),
      });

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-input-fail', content: 'yes', timestamp: Date.now() });

      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: expect.stringContaining('Failed') })
      );
    });

    it('should return error when interactive input is empty', async () => {
      ctx = buildHandler({
        isWaitingInput: vi.fn().mockReturnValue(true),
        sendInput: vi.fn().mockReturnValue(true),
      });

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-input-empty', content: '   ', timestamp: Date.now() });

      expect(ctx.mockExecutor.sendInput).not.toHaveBeenCalled();
      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: expect.stringContaining('non-empty input') })
      );
    });
  });

  describe('status query', () => {
    it('should include thread summaries in status response', async () => {
      await ctx.handler.handleMessage({ type: 'status', messageId: 'msg-status', timestamp: Date.now() });

      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'status',
          status: expect.objectContaining({ threads: expect.any(Array) }),
        })
      );
    });
  });

  describe('/cd command', () => {
    it('should persist working directory to ThreadManager after /cd', async () => {
      ctx.mockExecutor.setWorkingDirectory = vi.fn().mockResolvedValue(undefined);
      ctx.mockExecutor.getCurrentWorkingDirectory = vi.fn().mockReturnValue('/new/dir');

      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-cd', content: '/cd /new/dir', timestamp: Date.now() });

      expect(ctx.mockThreadManager.updateThread).toHaveBeenCalledWith(
        'default-thread-id',
        expect.objectContaining({ workingDirectory: '/new/dir' })
      );
      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, output: expect.stringContaining('/new/dir') })
      );
    });

    it('should return error when /cd is called without directory argument', async () => {
      await ctx.handler.handleMessage({ type: 'command', messageId: 'msg-cd-noarg', content: '/cd', timestamp: Date.now() });

      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: expect.stringContaining('Usage') })
      );
    });
  });

  describe('slash command passthrough (backend-aware)', () => {
    function useBackend(executorConfig: any) {
      ctx.mockConfig.get.mockImplementation((key: string) =>
        key === 'executor' ? executorConfig : undefined
      );
    }

    async function runSlash(content: string) {
      const child = fakeChild();
      mockSpawn.mockReturnValue(child);
      const p = ctx.handler.handleMessage({
        type: 'command',
        messageId: 'msg-slash',
        content,
        isSlashCommand: true,
        timestamp: Date.now(),
      } as any);
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
      return { child, done: p };
    }

    it('should keep spawning claude --print on the default (Claude) backend', async () => {
      useBackend(undefined);
      const { child, done } = await runSlash('/doctor');

      expect(mockSpawn).toHaveBeenCalledWith(
        'claude',
        ['/doctor', '--print'],
        expect.objectContaining({ cwd: '/home/user/test-project' })
      );

      child.stdout.emit('data', Buffer.from('doctor output'));
      child.emit('exit', 0);
      await done;

      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, output: 'doctor output' })
      );
    });

    it('should forward whitelisted read-only commands to agy -p on the AGY backend', async () => {
      useBackend({ type: 'agy' });
      const { child, done } = await runSlash('/usage');

      expect(mockSpawn).toHaveBeenCalledWith(
        'agy',
        ['-p', '/usage'],
        expect.objectContaining({ cwd: '/home/user/test-project' })
      );

      child.stdout.emit('data', Buffer.from('Weekly Limit Remaining 87%'));
      child.emit('exit', 0);
      await done;

      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, output: 'Weekly Limit Remaining 87%' })
      );
    });

    it('should treat the legacy "gemini" backend slot as AGY', async () => {
      useBackend({ type: 'gemini' });
      const { child, done } = await runSlash('/skills');

      expect(mockSpawn).toHaveBeenCalledWith('agy', ['-p', '/skills'], expect.anything());

      child.emit('exit', 0);
      await done;
      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ success: true })
      );
    });

    it('should honor executor.agy.command override for the agy binary', async () => {
      useBackend({ type: 'agy', agy: { command: '/opt/agy-custom' } });
      const { child, done } = await runSlash('/usage');

      expect(mockSpawn).toHaveBeenCalledWith('/opt/agy-custom', ['-p', '/usage'], expect.anything());

      child.emit('exit', 0);
      await done;
    });

    // '/help' and '/model' are handled by remote-cli built-ins and never
    // reach the passthrough, so they are not exercised here.
    it.each(['/skills', '/usage', '/config', '/changelog', '/agents', '/permissions', '/hooks', '/credits'])(
      'should pass through %s on the AGY backend',
      async (cmd) => {
        useBackend({ type: 'agy' });
        const { child, done } = await runSlash(cmd);

        expect(mockSpawn).toHaveBeenCalledWith('agy', ['-p', cmd], expect.anything());
        child.emit('exit', 0);
        await done;
      }
    );

    it('should reject /compact on the AGY backend (model would fake a compaction)', async () => {
      useBackend({ type: 'agy' });
      // Exact '/compact' is intercepted by the built-in handler; an argument
      // makes it fall through to the passthrough path.
      await ctx.handler.handleMessage({
        type: 'command',
        messageId: 'msg-slash-compact',
        content: '/compact now',
        isSlashCommand: true,
        timestamp: Date.now(),
      } as any);

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('/compact'),
        })
      );
    });

    it('should reject unknown slash commands on the AGY backend with the supported list', async () => {
      useBackend({ type: 'agy' });
      await ctx.handler.handleMessage({
        type: 'command',
        messageId: 'msg-slash-unknown',
        content: '/review',
        isSlashCommand: true,
        timestamp: Date.now(),
      } as any);

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('/usage'),
        })
      );
    });

    it('should reject all slash commands on the Codex backend', async () => {
      useBackend({ type: 'codex' });
      await ctx.handler.handleMessage({
        type: 'command',
        messageId: 'msg-slash-codex',
        content: '/usage',
        isSlashCommand: true,
        timestamp: Date.now(),
      } as any);

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('Codex'),
        })
      );
    });

    it('should surface agy stderr on non-zero exit', async () => {
      useBackend({ type: 'agy' });
      const { child, done } = await runSlash('/credits');

      child.stderr.emit('data', Buffer.from('Error: no credits info found'));
      child.emit('exit', 1);
      await done;

      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: expect.stringContaining('no credits info found') })
      );
    });

    it('should report a spawn failure with the backend label', async () => {
      useBackend({ type: 'codex' });
      // Codex never spawns; use AGY to exercise the spawn error path.
      useBackend({ type: 'agy' });
      const { child, done } = await runSlash('/usage');

      child.emit('error', new Error('spawn agy ENOENT'));
      await done;

      expect(ctx.mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: expect.stringContaining('spawn agy ENOENT') })
      );
    });
  });
});
