import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClaudePersistentExecutor } from '../../src/executor/ClaudePersistentExecutor';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';

describe('ClaudePersistentExecutor - Plan Mode', () => {
  let executor: ClaudePersistentExecutor;
  let directoryGuard: DirectoryGuard;
  let mockOnStream: ReturnType<typeof vi.fn>;
  let mockOnPlanMode: ReturnType<typeof vi.fn>;
  let mockOnToolUse: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    directoryGuard = new DirectoryGuard([process.cwd()]);
    executor = new ClaudePersistentExecutor(directoryGuard);
    mockOnStream = vi.fn();
    mockOnPlanMode = vi.fn();
    mockOnToolUse = vi.fn();
  });

  afterEach(async () => {
    await executor.destroy();
  });

  describe('EnterPlanMode detection', () => {
    it('should set isInPlanMode=true when EnterPlanMode tool_use is detected', () => {
      const handleOutputLine = (executor as any).handleOutputLine.bind(executor);

      (executor as any).currentStreamCallback = mockOnStream;
      (executor as any).currentPlanModeCallback = mockOnPlanMode;

      handleOutputLine(JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'EnterPlanMode', id: 'tool_plan_1', input: {} }
          ]
        }
      }));

      expect((executor as any).isInPlanMode).toBe(true);
    });

    it('should NOT forward EnterPlanMode as a tool_use card (no onToolUse call)', () => {
      const handleOutputLine = (executor as any).handleOutputLine.bind(executor);

      (executor as any).currentToolUseCallback = mockOnToolUse;

      handleOutputLine(JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'EnterPlanMode', id: 'tool_plan_1', input: {} }
          ]
        }
      }));

      expect(mockOnToolUse).not.toHaveBeenCalled();
    });

    it('should initialise an empty plan buffer on EnterPlanMode', () => {
      const handleOutputLine = (executor as any).handleOutputLine.bind(executor);

      // Pre-populate buffer with stale data
      (executor as any).planModeBuffer = ['stale'];

      handleOutputLine(JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'EnterPlanMode', id: 'tool_plan_1', input: {} }
          ]
        }
      }));

      expect((executor as any).planModeBuffer).toEqual([]);
    });
  });

  describe('Plan content buffering', () => {
    it('should buffer text blocks while in plan mode', () => {
      const handleOutputLine = (executor as any).handleOutputLine.bind(executor);

      (executor as any).currentStreamCallback = mockOnStream;
      (executor as any).currentPlanModeCallback = mockOnPlanMode;

      // Enter plan mode
      handleOutputLine(JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'EnterPlanMode', id: 'tool_plan_1', input: {} }
          ]
        }
      }));

      // Plan text
      handleOutputLine(JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: '1. First I will read the file\n2. Then I will edit it' }
          ]
        }
      }));

      expect((executor as any).planModeBuffer).toContain('1. First I will read the file\n2. Then I will edit it');
    });

    it('should still stream plan text to the user in real time while buffering', () => {
      const handleOutputLine = (executor as any).handleOutputLine.bind(executor);

      (executor as any).currentStreamCallback = mockOnStream;
      (executor as any).currentPlanModeCallback = mockOnPlanMode;

      // Enter plan mode
      handleOutputLine(JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'EnterPlanMode', id: 'tool_plan_1', input: {} }
          ]
        }
      }));

      // Plan text
      handleOutputLine(JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Step 1: read file' }
          ]
        }
      }));

      expect(mockOnStream).toHaveBeenCalledWith('Step 1: read file');
    });

    it('should NOT buffer text blocks when not in plan mode', () => {
      const handleOutputLine = (executor as any).handleOutputLine.bind(executor);

      (executor as any).currentStreamCallback = mockOnStream;

      handleOutputLine(JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Regular response' }
          ]
        }
      }));

      expect((executor as any).planModeBuffer).toEqual([]);
    });
  });

  describe('ExitPlanMode detection', () => {
    it('should set isInPlanMode=false on ExitPlanMode', () => {
      const handleOutputLine = (executor as any).handleOutputLine.bind(executor);

      (executor as any).currentPlanModeCallback = mockOnPlanMode;

      // Enter then exit
      handleOutputLine(JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'EnterPlanMode', id: 'tool_plan_1', input: {} }
          ]
        }
      }));
      handleOutputLine(JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'ExitPlanMode', id: 'tool_plan_2', input: {} }
          ]
        }
      }));

      expect((executor as any).isInPlanMode).toBe(false);
    });

    it('should fire onPlanMode callback with accumulated plan content on ExitPlanMode', () => {
      const handleOutputLine = (executor as any).handleOutputLine.bind(executor);

      (executor as any).currentStreamCallback = mockOnStream;
      (executor as any).currentPlanModeCallback = mockOnPlanMode;

      handleOutputLine(JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'EnterPlanMode', id: 'id1', input: {} }] }
      }));
      handleOutputLine(JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Plan step A\n' }] }
      }));
      handleOutputLine(JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Plan step B\n' }] }
      }));
      handleOutputLine(JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'ExitPlanMode', id: 'id2', input: {} }] }
      }));

      expect(mockOnPlanMode).toHaveBeenCalledTimes(1);
      const planContent: string = mockOnPlanMode.mock.calls[0][0];
      expect(planContent).toContain('Plan step A');
      expect(planContent).toContain('Plan step B');
    });

    it('should clear planModeBuffer after ExitPlanMode', () => {
      const handleOutputLine = (executor as any).handleOutputLine.bind(executor);

      (executor as any).currentPlanModeCallback = mockOnPlanMode;

      handleOutputLine(JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'EnterPlanMode', id: 'id1', input: {} }] }
      }));
      handleOutputLine(JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'some plan' }] }
      }));
      handleOutputLine(JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'ExitPlanMode', id: 'id2', input: {} }] }
      }));

      expect((executor as any).planModeBuffer).toEqual([]);
    });

    it('should NOT forward ExitPlanMode as a tool_use card', () => {
      const handleOutputLine = (executor as any).handleOutputLine.bind(executor);

      (executor as any).currentToolUseCallback = mockOnToolUse;
      (executor as any).currentPlanModeCallback = mockOnPlanMode;

      handleOutputLine(JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'EnterPlanMode', id: 'id1', input: {} }] }
      }));
      handleOutputLine(JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'ExitPlanMode', id: 'id2', input: {} }] }
      }));

      expect(mockOnToolUse).not.toHaveBeenCalled();
    });

    it('should not fire onPlanMode if plan content is empty', () => {
      const handleOutputLine = (executor as any).handleOutputLine.bind(executor);

      (executor as any).currentPlanModeCallback = mockOnPlanMode;

      // Enter and immediately exit with no text in between
      handleOutputLine(JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'EnterPlanMode', id: 'id1', input: {} }] }
      }));
      handleOutputLine(JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'ExitPlanMode', id: 'id2', input: {} }] }
      }));

      expect(mockOnPlanMode).not.toHaveBeenCalled();
    });
  });

  describe('Callback registration', () => {
    it('should accept onPlanMode callback in execute options', () => {
      const options = {
        onStream: mockOnStream,
        onPlanMode: mockOnPlanMode,
      };

      expect(options.onPlanMode).toBeDefined();
      expect(typeof options.onPlanMode).toBe('function');
    });

    it('should wire onPlanMode into currentPlanModeCallback via processQueue', () => {
      (executor as any).commandQueue.push({
        prompt: 'test',
        options: { onPlanMode: mockOnPlanMode },
        resolve: vi.fn(),
        reject: vi.fn(),
      });

      const command = (executor as any).commandQueue.shift();

      (executor as any).isProcessing = true;
      (executor as any).currentPlanModeCallback = command.options.onPlanMode;

      expect((executor as any).currentPlanModeCallback).toBe(mockOnPlanMode);
    });
  });

  describe('State reset', () => {
    it('should clear plan mode state on resetCurrentCommand', () => {
      (executor as any).isInPlanMode = true;
      (executor as any).planModeBuffer = ['some plan text'];
      (executor as any).currentPlanModeCallback = mockOnPlanMode;

      (executor as any).resetCurrentCommand();

      expect((executor as any).isInPlanMode).toBe(false);
      expect((executor as any).planModeBuffer).toEqual([]);
      expect((executor as any).currentPlanModeCallback).toBeUndefined();
    });
  });

  describe('Integration with other block types', () => {
    it('should handle regular tool_use blocks normally when not in plan mode', () => {
      const handleOutputLine = (executor as any).handleOutputLine.bind(executor);

      (executor as any).currentToolUseCallback = mockOnToolUse;

      handleOutputLine(JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', id: 'tool_read_1', input: { file_path: '/tmp/test' } }
          ]
        }
      }));

      expect(mockOnToolUse).toHaveBeenCalledWith({
        name: 'Read',
        id: 'tool_read_1',
        input: { file_path: '/tmp/test' }
      });
    });

    it('should handle mixed content: plan mode sandwich around regular tools', () => {
      const handleOutputLine = (executor as any).handleOutputLine.bind(executor);

      (executor as any).currentStreamCallback = mockOnStream;
      (executor as any).currentPlanModeCallback = mockOnPlanMode;
      (executor as any).currentToolUseCallback = mockOnToolUse;

      // Pre-plan text
      handleOutputLine(JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Let me plan this.' }] }
      }));

      // Enter plan mode
      handleOutputLine(JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'EnterPlanMode', id: 'id_enter', input: {} }] }
      }));

      // Plan text
      handleOutputLine(JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Step 1: Read file' }] }
      }));

      // Exit plan mode
      handleOutputLine(JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'ExitPlanMode', id: 'id_exit', input: {} }] }
      }));

      // Regular tool call after plan mode
      handleOutputLine(JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Read', id: 'id_read', input: { file_path: '/f' } }] }
      }));

      // Plan mode callback fires with plan content
      expect(mockOnPlanMode).toHaveBeenCalledTimes(1);
      expect(mockOnPlanMode.mock.calls[0][0]).toContain('Step 1: Read file');

      // Regular tool call forwarded normally
      expect(mockOnToolUse).toHaveBeenCalledTimes(1);
      expect(mockOnToolUse.mock.calls[0][0].name).toBe('Read');

      // Pre-plan text was streamed
      expect(mockOnStream).toHaveBeenCalledWith('Let me plan this.');
    });
  });

  describe('Defensive behavior', () => {
    it('should not throw when no onPlanMode callback is registered', () => {
      const handleOutputLine = (executor as any).handleOutputLine.bind(executor);

      // No callbacks registered
      expect(() => {
        handleOutputLine(JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'EnterPlanMode', id: 'id1', input: {} }] }
        }));
        handleOutputLine(JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'plan' }] }
        }));
        handleOutputLine(JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'ExitPlanMode', id: 'id2', input: {} }] }
        }));
      }).not.toThrow();
    });
  });
});
