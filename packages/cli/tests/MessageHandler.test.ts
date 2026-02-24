import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MessageHandler } from '../src/client/MessageHandler';
import { ClaudeExecutor } from '../src/executor/ClaudeExecutor';
import { WebSocketClient } from '../src/client/WebSocketClient';
import { DirectoryGuard } from '../src/security/DirectoryGuard';
import { ConfigManager } from '../src/config/ConfigManager';

// Mock dependencies
vi.mock('../src/executor/ClaudeExecutor');
vi.mock('../src/client/WebSocketClient');

describe('MessageHandler', () => {
  let handler: MessageHandler;
  let mockExecutor: any;
  let mockWsClient: any;
  let directoryGuard: DirectoryGuard;
  let mockConfig: any;

  beforeEach(() => {
    vi.clearAllMocks();

    directoryGuard = new DirectoryGuard(['~/test-project']);

    // Mock ClaudeExecutor
    mockExecutor = {
      execute: vi.fn(),
      setWorkingDirectory: vi.fn(),
      getCurrentWorkingDirectory: vi.fn(() => '/home/user/test-project'),
      resetContext: vi.fn(),
      destroy: vi.fn(),
    };
    (ClaudeExecutor as any).mockImplementation(() => mockExecutor);

    // Mock WebSocketClient
    mockWsClient = {
      send: vi.fn(),
      isConnected: vi.fn(() => true),
    };

    // Mock ConfigManager
    mockConfig = {
      get: vi.fn(),
      set: vi.fn().mockResolvedValue(undefined),
      has: vi.fn(() => true),
      getAll: vi.fn(() => ({})),
      save: vi.fn().mockResolvedValue(undefined),
    };

    handler = new MessageHandler(mockWsClient, mockExecutor, directoryGuard, mockConfig);
  });

  afterEach(() => {
    handler.destroy();
  });

  describe('initialization', () => {
    it('should create handler with dependencies', () => {
      expect(handler).toBeDefined();
      expect(handler).toBeInstanceOf(MessageHandler);
    });
  });

  describe('message handling', () => {
    it('should handle command messages', async () => {
      mockExecutor.execute.mockResolvedValue({
        success: true,
        output: 'Command executed successfully',
      });

      const message = {
        type: 'command',
        messageId: 'msg-123',
        content: 'list files',
        timestamp: Date.now(),
      };

      await handler.handleMessage(message);

      expect(mockExecutor.execute).toHaveBeenCalledWith(
        'list files',
        expect.any(Object)
      );
      expect(mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'response',
          messageId: 'msg-123',
          success: true,
        })
      );
    });

    it('should handle execution errors', async () => {
      mockExecutor.execute.mockResolvedValue({
        success: false,
        error: 'Execution failed',
      });

      const message = {
        type: 'command',
        messageId: 'msg-456',
        content: 'invalid command',
        timestamp: Date.now(),
      };

      await handler.handleMessage(message);

      expect(mockWsClient.send).toHaveBeenCalledWith(
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

      await handler.handleMessage(message);

      expect(mockExecutor.execute).not.toHaveBeenCalled();
      expect(mockWsClient.send).not.toHaveBeenCalled();
    });

    it('should handle malformed messages gracefully', async () => {
      const message = {
        type: 'command',
        // Missing messageId and content
      };

      await handler.handleMessage(message);

      expect(mockExecutor.execute).not.toHaveBeenCalled();
    });
  });

  describe('command shortcuts', () => {
    it('should expand /r to resume command', async () => {
      mockExecutor.execute.mockResolvedValue({ success: true, output: 'ok' });

      const message = {
        type: 'command',
        messageId: 'msg-123',
        content: '/r',
        timestamp: Date.now(),
      };

      await handler.handleMessage(message);

      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.stringContaining('resume'),
        expect.any(Object)
      );
    });

    it('should expand /c to continue command', async () => {
      mockExecutor.execute.mockResolvedValue({ success: true, output: 'ok' });

      const message = {
        type: 'command',
        messageId: 'msg-123',
        content: '/c',
        timestamp: Date.now(),
      };

      await handler.handleMessage(message);

      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.stringContaining('continue'),
        expect.any(Object)
      );
    });

    it('should expand /resume to full resume command', async () => {
      mockExecutor.execute.mockResolvedValue({ success: true, output: 'ok' });

      const message = {
        type: 'command',
        messageId: 'msg-123',
        content: '/resume',
        timestamp: Date.now(),
      };

      await handler.handleMessage(message);

      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.stringContaining('resume'),
        expect.any(Object)
      );
    });

    it('should expand /continue to full continue command', async () => {
      mockExecutor.execute.mockResolvedValue({ success: true, output: 'ok' });

      const message = {
        type: 'command',
        messageId: 'msg-123',
        content: '/continue',
        timestamp: Date.now(),
      };

      await handler.handleMessage(message);

      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.stringContaining('continue'),
        expect.any(Object)
      );
    });

    it('should not expand /r in middle of text', async () => {
      mockExecutor.execute.mockResolvedValue({ success: true, output: 'ok' });

      const message = {
        type: 'command',
        messageId: 'msg-123',
        content: 'some /r text',
        timestamp: Date.now(),
      };

      await handler.handleMessage(message);

      expect(mockExecutor.execute).toHaveBeenCalledWith('some /r text', expect.any(Object));
    });
  });

  describe('status command', () => {
    it('should handle /status command', async () => {
      const message = {
        type: 'command',
        messageId: 'msg-123',
        content: '/status',
        timestamp: Date.now(),
      };

      await handler.handleMessage(message);

      expect(mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'response',
          messageId: 'msg-123',
          success: true,
          output: expect.stringContaining('test-project'),
        })
      );
      expect(mockExecutor.execute).not.toHaveBeenCalled();
    });
  });

  describe('help command', () => {
    it('should handle /help command', async () => {
      const message = {
        type: 'command',
        messageId: 'msg-123',
        content: '/help',
        timestamp: Date.now(),
      };

      await handler.handleMessage(message);

      expect(mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'response',
          messageId: 'msg-123',
          success: true,
          output: expect.stringContaining('Available commands'),
        })
      );
      expect(mockExecutor.execute).not.toHaveBeenCalled();
    });
  });

  describe('clear command', () => {
    it('should handle /clear command', async () => {
      const message = {
        type: 'command',
        messageId: 'msg-123',
        content: '/clear',
        timestamp: Date.now(),
      };

      await handler.handleMessage(message);

      expect(mockExecutor.resetContext).toHaveBeenCalled();
      expect(mockWsClient.send).toHaveBeenCalledWith(
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
      const message = {
        type: 'command',
        messageId: 'msg-123',
        content: '/cd ~/test-project',
        timestamp: Date.now(),
      };

      await handler.handleMessage(message);

      expect(mockExecutor.setWorkingDirectory).toHaveBeenCalledWith('~/test-project');
      expect(mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'response',
          messageId: 'msg-123',
          success: true,
        })
      );
    });

    it('should handle /cd command with invalid directory', async () => {
      mockExecutor.setWorkingDirectory.mockImplementation(() => {
        throw new Error('Directory not allowed');
      });

      const message = {
        type: 'command',
        messageId: 'msg-123',
        content: '/cd /etc',
        timestamp: Date.now(),
      };

      await handler.handleMessage(message);

      expect(mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'response',
          messageId: 'msg-123',
          success: false,
          error: expect.stringContaining('not allowed'),
        })
      );
    });

    it('should handle /cd command without directory', async () => {
      const message = {
        type: 'command',
        messageId: 'msg-123',
        content: '/cd',
        timestamp: Date.now(),
      };

      await handler.handleMessage(message);

      expect(mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'response',
          messageId: 'msg-123',
          success: false,
        })
      );
    });
  });

  describe('streaming output', () => {
    it('should send streaming chunks', async () => {
      let streamCallback: ((chunk: string) => void) | undefined;

      mockExecutor.execute.mockImplementation(async (_prompt: string, options: any) => {
        streamCallback = options.onStream;
        if (streamCallback) {
          streamCallback('chunk 1');
          streamCallback('chunk 2');
          streamCallback('chunk 3');
        }
        return { success: true, output: 'final output' };
      });

      const message = {
        type: 'command',
        messageId: 'msg-123',
        content: 'test command',
        timestamp: Date.now(),
      };

      await handler.handleMessage(message);

      expect(mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'stream',
          messageId: 'msg-123',
          chunk: 'chunk 1',
        })
      );
      expect(mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'stream',
          messageId: 'msg-123',
          chunk: 'chunk 2',
        })
      );
      expect(mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'stream',
          messageId: 'msg-123',
          chunk: 'chunk 3',
        })
      );
    });

    it('should handle streaming errors gracefully', async () => {
      mockWsClient.send.mockImplementation(() => {
        throw new Error('WebSocket send failed');
      });

      mockExecutor.execute.mockImplementation(async (_prompt: string, options: any) => {
        if (options.onStream) {
          options.onStream('test chunk');
        }
        return { success: true, output: 'ok' };
      });

      const message = {
        type: 'command',
        messageId: 'msg-123',
        content: 'test',
        timestamp: Date.now(),
      };

      // Should not throw
      await handler.handleMessage(message);
      expect(mockExecutor.execute).toHaveBeenCalled();
    });
  });

  describe('concurrent execution prevention', () => {
    it('should prevent concurrent command execution', async () => {
      mockExecutor.execute.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ success: true, output: 'ok' }), 100))
      );

      const message1 = {
        type: 'command',
        messageId: 'msg-1',
        content: 'command 1',
        timestamp: Date.now(),
      };

      const message2 = {
        type: 'command',
        messageId: 'msg-2',
        content: 'command 2',
        timestamp: Date.now(),
      };

      const promise1 = handler.handleMessage(message1);
      const promise2 = handler.handleMessage(message2);

      await Promise.all([promise1, promise2]);

      // Second command should be rejected with busy error
      const calls = mockWsClient.send.mock.calls;
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
      mockExecutor.execute
        .mockRejectedValueOnce(new Error('First error'))
        .mockResolvedValueOnce({ success: true, output: 'ok' });

      const message1 = {
        type: 'command',
        messageId: 'msg-1',
        content: 'failing command',
        timestamp: Date.now(),
      };

      const message2 = {
        type: 'command',
        messageId: 'msg-2',
        content: 'working command',
        timestamp: Date.now(),
      };

      await handler.handleMessage(message1);
      await handler.handleMessage(message2);

      expect(mockExecutor.execute).toHaveBeenCalledTimes(2);
      expect(mockWsClient.send).toHaveBeenCalledTimes(2);
    });
  });

  describe('cleanup', () => {
    it('should cleanup resources on destroy', () => {
      handler.destroy();
      expect(() => handler.destroy()).not.toThrow();
    });

    it('should reject messages after destroy', async () => {
      handler.destroy();

      const message = {
        type: 'command',
        messageId: 'msg-123',
        content: 'test',
        timestamp: Date.now(),
      };

      await handler.handleMessage(message);

      expect(mockExecutor.execute).not.toHaveBeenCalled();
    });
  });

  describe('message validation', () => {
    it('should validate message structure', async () => {
      const invalidMessages = [
        null,
        undefined,
        {},
        { type: 'command' }, // Missing messageId
        { type: 'command', messageId: 'msg-123' }, // Missing content
        { messageId: 'msg-123', content: 'test' }, // Missing type
      ];

      for (const msg of invalidMessages) {
        await handler.handleMessage(msg as any);
      }

      expect(mockExecutor.execute).not.toHaveBeenCalled();
    });
  });

  describe('working directory context', () => {
    it('should include working directory in responses', async () => {
      mockExecutor.execute.mockResolvedValue({
        success: true,
        output: 'Command output',
      });

      const message = {
        type: 'command',
        messageId: 'msg-123',
        content: 'test command',
        timestamp: Date.now(),
      };

      await handler.handleMessage(message);

      expect(mockWsClient.send).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/home/user/test-project',
        })
      );
    });
  });

  describe('file read detection', () => {
    it('should inject hint for Chinese read commands', async () => {
      mockExecutor.execute.mockResolvedValue({ success: true, output: 'ok' });

      const message = {
        type: 'command',
        messageId: 'msg-123',
        content: '读取 config.ts',
        timestamp: Date.now(),
      };

      await handler.handleMessage(message);

      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.stringContaining('[System hint:'),
        expect.any(Object)
      );
    });

    it('should inject hint for English read commands', async () => {
      mockExecutor.execute.mockResolvedValue({ success: true, output: 'ok' });

      const message = {
        type: 'command',
        messageId: 'msg-123',
        content: 'show file package.json',
        timestamp: Date.now(),
      };

      await handler.handleMessage(message);

      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.stringContaining('[System hint:'),
        expect.any(Object)
      );
    });

    it('should not inject hint for general commands', async () => {
      mockExecutor.execute.mockResolvedValue({ success: true, output: 'ok' });

      const message = {
        type: 'command',
        messageId: 'msg-123',
        content: 'fix the login bug',
        timestamp: Date.now(),
      };

      await handler.handleMessage(message);

      expect(mockExecutor.execute).toHaveBeenCalledWith(
        'fix the login bug',
        expect.any(Object)
      );
    });

    it('should strip --full and skip hint', async () => {
      mockExecutor.execute.mockResolvedValue({ success: true, output: 'ok' });

      const message = {
        type: 'command',
        messageId: 'msg-123',
        content: 'read file.ts --full',
        timestamp: Date.now(),
      };

      await handler.handleMessage(message);

      const executedContent = mockExecutor.execute.mock.calls[0][0];
      expect(executedContent).not.toContain('--full');
      expect(executedContent).not.toContain('[System hint:');
    });
  });
});
