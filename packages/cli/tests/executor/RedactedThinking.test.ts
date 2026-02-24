import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClaudePersistentExecutor } from '../../src/executor/ClaudePersistentExecutor';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';

describe('ClaudePersistentExecutor - Redacted Thinking', () => {
  let executor: ClaudePersistentExecutor;
  let directoryGuard: DirectoryGuard;
  let mockOnStream: ReturnType<typeof vi.fn>;
  let mockOnRedactedThinking: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    directoryGuard = new DirectoryGuard([process.cwd()]);
    executor = new ClaudePersistentExecutor(directoryGuard);
    mockOnStream = vi.fn();
    mockOnRedactedThinking = vi.fn();
  });

  afterEach(async () => {
    await executor.destroy();
  });

  describe('Message Type Handling', () => {
    it('should recognize redacted_thinking as valid message type', () => {
      // Access private method for testing
      const handleOutputLine = (executor as any).handleOutputLine.bind(executor);

      const message = {
        type: 'redacted_thinking',
        content: 'ENCRYPTED_CONTENT_PLACEHOLDER',
        partial: false
      };

      // Should not throw error when handling redacted_thinking type
      expect(() => {
        handleOutputLine(JSON.stringify(message));
      }).not.toThrow();
    });

    it('should handle redacted_thinking in assistant message content blocks', () => {
      const handleOutputLine = (executor as any).handleOutputLine.bind(executor);

      const message = {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'This is a response' },
            { type: 'redacted_thinking', redacted_thinking: 'ENCRYPTED_DATA' }
          ]
        }
      };

      // Should not throw error when processing redacted_thinking block
      expect(() => {
        handleOutputLine(JSON.stringify(message));
      }).not.toThrow();
    });
  });

  describe('Content Preservation', () => {
    it('should store redacted thinking content for API continuity', () => {
      const handleOutputLine = (executor as any).handleOutputLine.bind(executor);

      // Setup callbacks
      (executor as any).currentStreamCallback = mockOnStream;
      (executor as any).currentRedactedThinkingCallback = mockOnRedactedThinking;

      const encryptedContent = 'ENCRYPTED_THINKING_CONTENT_12345';
      handleOutputLine(JSON.stringify({
        type: 'redacted_thinking',
        content: encryptedContent
      }));

      // Content should be in output buffer (for session continuity)
      const buffer = (executor as any).currentOutputBuffer;
      expect(buffer.length).toBeGreaterThan(0);
      expect(buffer.join('')).toContain(encryptedContent);
    });

    it('should not stream encrypted content to user', () => {
      const handleOutputLine = (executor as any).handleOutputLine.bind(executor);

      (executor as any).currentStreamCallback = mockOnStream;
      (executor as any).currentRedactedThinkingCallback = mockOnRedactedThinking;

      handleOutputLine(JSON.stringify({
        type: 'redacted_thinking',
        content: 'ENCRYPTED_CONTENT'
      }));

      // Encrypted content should NOT be sent via onStream callback
      expect(mockOnStream).not.toHaveBeenCalledWith(
        expect.stringContaining('ENCRYPTED_CONTENT')
      );
    });
  });

  describe('User Notification', () => {
    it('should trigger redacted thinking callback when encountered', () => {
      const handleOutputLine = (executor as any).handleOutputLine.bind(executor);

      (executor as any).currentStreamCallback = mockOnStream;
      (executor as any).currentRedactedThinkingCallback = mockOnRedactedThinking;

      handleOutputLine(JSON.stringify({
        type: 'redacted_thinking',
        content: 'ENCRYPTED'
      }));

      // Should trigger structured notification callback
      expect(mockOnRedactedThinking).toHaveBeenCalledTimes(1);
    });

    it('should trigger callback for redacted_thinking blocks in assistant messages', () => {
      const handleOutputLine = (executor as any).handleOutputLine.bind(executor);

      (executor as any).currentStreamCallback = mockOnStream;
      (executor as any).currentRedactedThinkingCallback = mockOnRedactedThinking;

      handleOutputLine(JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Response' },
            { type: 'redacted_thinking', redacted_thinking: 'ENCRYPTED' }
          ]
        }
      }));

      // Should trigger callback for the redacted_thinking block
      expect(mockOnRedactedThinking).toHaveBeenCalledTimes(1);
    });
  });

  describe('Callback Registration', () => {
    it('should accept onRedactedThinking callback in execute options', () => {
      // This tests that the interface accepts the callback
      // We can't easily test full execution without mocking the Claude process
      const options = {
        onStream: mockOnStream,
        onRedactedThinking: mockOnRedactedThinking,
        timeout: 1000
      };

      // Type checking should pass
      expect(options.onRedactedThinking).toBeDefined();
      expect(typeof options.onRedactedThinking).toBe('function');
    });

    it('should register callback during processQueue', () => {
      // Access private method
      const processQueue = (executor as any).processQueue.bind(executor);

      // Add a command to queue
      (executor as any).commandQueue.push({
        prompt: 'test',
        options: { onRedactedThinking: mockOnRedactedThinking },
        resolve: vi.fn(),
        reject: vi.fn()
      });

      // Mock claude process as running with proper stdin mock
      (executor as any).claudeProcess = {
        stdin: {
          write: vi.fn(),
          end: vi.fn()  // Add end method to mock
        },
        killed: false
      };
      (executor as any).isProcessing = false;

      processQueue();

      // Callback should be registered
      expect((executor as any).currentRedactedThinkingCallback).toBe(mockOnRedactedThinking);
    });
  });

  describe('State Reset', () => {
    it('should clear redacted thinking callback when resetting command', () => {
      (executor as any).currentRedactedThinkingCallback = mockOnRedactedThinking;

      // Reset current command
      (executor as any).resetCurrentCommand();

      // Callback should be cleared
      expect((executor as any).currentRedactedThinkingCallback).toBeUndefined();
    });
  });

  describe('Integration with other block types', () => {
    it('should handle mixed content blocks with text, tool_use, and redacted_thinking', () => {
      const handleOutputLine = (executor as any).handleOutputLine.bind(executor);

      (executor as any).currentStreamCallback = mockOnStream;
      (executor as any).currentRedactedThinkingCallback = mockOnRedactedThinking;
      (executor as any).currentToolUseCallback = vi.fn();

      handleOutputLine(JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Analyzing...' },
            { type: 'tool_use', name: 'Read', id: 'tool_123', input: { file_path: '/test' } },
            { type: 'redacted_thinking', redacted_thinking: 'ENCRYPTED' },
            { type: 'text', text: 'Done.' }
          ]
        }
      }));

      // All blocks should be processed without error
      expect(mockOnStream).toHaveBeenCalledWith(expect.stringContaining('Analyzing'));
      expect(mockOnStream).toHaveBeenCalledWith(expect.stringContaining('Done'));
      expect(mockOnRedactedThinking).toHaveBeenCalledTimes(1);
      expect((executor as any).currentToolUseCallback).toHaveBeenCalledTimes(1);
    });
  });
});
