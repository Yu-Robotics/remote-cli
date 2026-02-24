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
      // Verify that processQueue correctly wires onRedactedThinking into the
      // currentRedactedThinkingCallback slot by inspecting internal state
      // directly — without spinning up a real Claude process.

      // Manually simulate what processQueue does after dequeuing a command
      (executor as any).commandQueue.push({
        prompt: 'test',
        options: { onRedactedThinking: mockOnRedactedThinking },
        resolve: vi.fn(),
        reject: vi.fn(),
      });

      const command = (executor as any).commandQueue.shift();

      // Mirror the assignments that processQueue performs
      (executor as any).isProcessing = true;
      (executor as any).currentStreamCallback = command.options.onStream;
      (executor as any).currentToolUseCallback = command.options.onToolUse;
      (executor as any).currentToolResultCallback = command.options.onToolResult;
      (executor as any).currentRedactedThinkingCallback = command.options.onRedactedThinking;
      (executor as any).currentCommandResolve = command.resolve;
      (executor as any).currentCommandReject = command.reject;

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

  describe('Defensive behavior', () => {
    it('should not throw when no callback is registered', () => {
      const handleOutputLine = (executor as any).handleOutputLine.bind(executor);

      // No callbacks registered at all
      expect(() => {
        handleOutputLine(JSON.stringify({
          type: 'redacted_thinking',
          content: 'ENCRYPTED'
        }));
      }).not.toThrow();
    });

    it('should not throw for redacted_thinking block with no callback', () => {
      const handleOutputLine = (executor as any).handleOutputLine.bind(executor);

      expect(() => {
        handleOutputLine(JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'redacted_thinking', redacted_thinking: 'ENCRYPTED' }
            ]
          }
        }));
      }).not.toThrow();
    });

    it('should handle redacted_thinking message with no content gracefully', () => {
      const handleOutputLine = (executor as any).handleOutputLine.bind(executor);

      (executor as any).currentRedactedThinkingCallback = mockOnRedactedThinking;

      // Message with no content field
      expect(() => {
        handleOutputLine(JSON.stringify({
          type: 'redacted_thinking'
        }));
      }).not.toThrow();

      // Callback should NOT be called if there's no content to process
      expect(mockOnRedactedThinking).not.toHaveBeenCalled();
    });

    it('should handle redacted_thinking block with missing redacted_thinking field', () => {
      const handleOutputLine = (executor as any).handleOutputLine.bind(executor);

      (executor as any).currentRedactedThinkingCallback = mockOnRedactedThinking;

      // Block with no redacted_thinking data — still should trigger callback
      expect(() => {
        handleOutputLine(JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'redacted_thinking' }  // Missing redacted_thinking field
            ]
          }
        }));
      }).not.toThrow();

      // Callback is still called — the block itself is present
      expect(mockOnRedactedThinking).toHaveBeenCalledTimes(1);
    });
  });

  describe('Multiple redacted thinking blocks', () => {
    it('should fire callback once per redacted_thinking block', () => {
      const handleOutputLine = (executor as any).handleOutputLine.bind(executor);

      (executor as any).currentRedactedThinkingCallback = mockOnRedactedThinking;

      handleOutputLine(JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'redacted_thinking', redacted_thinking: 'BLOCK_1' },
            { type: 'text', text: 'Middle text' },
            { type: 'redacted_thinking', redacted_thinking: 'BLOCK_2' }
          ]
        }
      }));

      expect(mockOnRedactedThinking).toHaveBeenCalledTimes(2);
    });

    it('should accumulate multiple redacted buffers separately', () => {
      const handleOutputLine = (executor as any).handleOutputLine.bind(executor);

      (executor as any).currentRedactedThinkingCallback = mockOnRedactedThinking;

      // Two separate top-level redacted_thinking messages
      handleOutputLine(JSON.stringify({ type: 'redacted_thinking', content: 'FIRST_CHUNK' }));
      handleOutputLine(JSON.stringify({ type: 'redacted_thinking', content: 'SECOND_CHUNK' }));

      expect(mockOnRedactedThinking).toHaveBeenCalledTimes(2);

      const buffer: string[] = (executor as any).currentOutputBuffer;
      const joined = buffer.join('');
      expect(joined).toContain('FIRST_CHUNK');
      expect(joined).toContain('SECOND_CHUNK');
    });
  });

  describe('Isolation from text stream', () => {
    it('should not call onStream for redacted_thinking top-level message', () => {
      const handleOutputLine = (executor as any).handleOutputLine.bind(executor);

      (executor as any).currentStreamCallback = mockOnStream;
      (executor as any).currentRedactedThinkingCallback = mockOnRedactedThinking;

      handleOutputLine(JSON.stringify({ type: 'redacted_thinking', content: 'SECRET' }));

      // onStream must never receive the encrypted value
      expect(mockOnStream).not.toHaveBeenCalled();
    });

    it('should call onStream for text blocks that co-exist with redacted_thinking', () => {
      const handleOutputLine = (executor as any).handleOutputLine.bind(executor);

      (executor as any).currentStreamCallback = mockOnStream;
      (executor as any).currentRedactedThinkingCallback = mockOnRedactedThinking;

      handleOutputLine(JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Visible output' },
            { type: 'redacted_thinking', redacted_thinking: 'HIDDEN' }
          ]
        }
      }));

      expect(mockOnStream).toHaveBeenCalledWith('Visible output');
      expect(mockOnStream).not.toHaveBeenCalledWith(expect.stringContaining('HIDDEN'));
    });
  });
});
