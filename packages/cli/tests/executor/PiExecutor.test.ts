import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { PiExecutor } from '../../src/executor/PiExecutor';
import type { PiLaunchOptions, PiRpcResponse, PiTransport } from '../../src/executor/pi/PiTypes';

const originalHome = process.env.HOME;
const originalHomedir = os.homedir();

const models = [
  { id: 'gemini-3-flash', name: 'Gemini 3 Flash', provider: 'google', reasoning: true, input: ['text', 'image'] },
  { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', provider: 'anthropic', reasoning: true, input: ['text', 'image'] },
];

class FakePiTransport implements PiTransport {
  running = false;
  starts = 0;
  launch: PiLaunchOptions;
  events = new Set<(event: Record<string, any>) => void>();
  request = vi.fn(async (command: Record<string, unknown>): Promise<PiRpcResponse> => {
    if (command.type === 'prompt') {
      this.emit({ type: 'agent_start' });
      this.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'done' },
      });
      this.emit({
        type: 'tool_execution_start',
        toolCallId: 'tool-1',
        toolName: 'bash',
        args: { command: 'pwd' },
      });
      this.emit({
        type: 'tool_execution_end',
        toolCallId: 'tool-1',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: '/tmp' }] },
        isError: false,
      });
      this.emit({ type: 'agent_settled' });
      return { type: 'response', command: 'prompt', success: true };
    }
    if (command.type === 'get_state') {
      return {
        type: 'response',
        command: 'get_state',
        success: true,
        data: { sessionId: 'sess-pi-1', sessionFile: path.join(this.launch.sessionDir ?? '/tmp', 'sess-pi-1.jsonl') },
      };
    }
    if (command.type === 'get_available_models') {
      return { type: 'response', command: 'get_available_models', success: true, data: { models } };
    }
    if (command.type === 'get_session_stats') {
      return {
        type: 'response',
        command: 'get_session_stats',
        success: true,
        data: {
          tokens: { input: 50000, output: 10000, cacheRead: 40000, cacheWrite: 5000, total: 105000 },
          contextUsage: { tokens: 60000, contextWindow: 200000, percent: 30 },
        },
      };
    }
    if (command.type === 'set_model') {
      return { type: 'response', command: 'set_model', success: true, data: models[1] };
    }
    if (command.type === 'set_thinking_level') {
      return { type: 'response', command: 'set_thinking_level', success: true };
    }
    if (command.type === 'get_available_thinking_levels') {
      return {
        type: 'response',
        command: 'get_available_thinking_levels',
        success: true,
        data: { levels: ['off', 'minimal', 'low', 'medium', 'high'] },
      };
    }
    if (command.type === 'compact') {
      return { type: 'response', command: 'compact', success: true, data: { summary: 'compacted' } };
    }
    if (command.type === 'get_commands') {
      return {
        type: 'response',
        command: 'get_commands',
        success: true,
        data: { commands: [{ name: 'skill:review', description: 'Review diffs', source: 'skill' }] },
      };
    }
    if (command.type === 'new_session' || command.type === 'abort' || command.type === 'clear_queue') {
      return { type: 'response', command: String(command.type), success: true };
    }
    return { type: 'response', command: String(command.type), success: true };
  });
  send = vi.fn();

  constructor(launch: PiLaunchOptions) {
    this.launch = launch;
  }

  async start(): Promise<void> {
    this.starts += 1;
    this.running = true;
  }

  onEvent(handler: (event: Record<string, any>) => void): () => void {
    this.events.add(handler);
    return () => this.events.delete(handler);
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  updateLaunch(partial: Partial<PiLaunchOptions>): void {
    this.launch = { ...this.launch, ...partial };
  }

  emit(event: Record<string, any>): void {
    for (const handler of this.events) handler(event);
  }
}

describe('PiExecutor', () => {
  let home: string;
  let project: string;
  let transport: FakePiTransport;
  let executor: PiExecutor;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(originalHomedir, '.pi-executor-test-'));
    project = path.join(home, 'project');
    await fs.mkdir(project);
    process.env.HOME = home;
    executor = new PiExecutor(new DirectoryGuard([home]), {
      initialWorkingDirectory: project,
      threadId: 'thread-pi',
      sessionBaseDir: path.join(home, '.remote-cli', 'pi-sessions'),
      clientFactory: (launch) => {
        transport = new FakePiTransport(launch);
        return transport;
      },
    });
  });

  afterEach(async () => {
    await executor.destroy();
    await fs.rm(home, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it('streams text, tools, and image input while persisting the Pi session', async () => {
    const chunks: string[] = [];
    const onToolUse = vi.fn();
    const onToolResult = vi.fn();

    const result = await executor.execute('inspect', {
      attachments: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
      onStream: (chunk) => chunks.push(chunk),
      onToolUse,
      onToolResult,
    });

    expect(result).toMatchObject({ success: true, output: 'done', sessionAbbr: 'sess-pi-' });
    expect(transport.launch.approveProject).toBe(true);
    expect(chunks).toEqual(['done']);
    expect(transport.request).toHaveBeenCalledWith(expect.objectContaining({
      type: 'prompt',
      message: 'inspect',
      images: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
    }));
    expect(onToolUse).toHaveBeenCalledWith({ id: 'tool-1', name: 'Bash', input: { command: 'pwd' } });
    expect(onToolResult).toHaveBeenCalledWith({ tool_use_id: 'tool-1', content: '/tmp', is_error: false });
    const stored = JSON.parse(await fs.readFile(path.join(home, '.remote-cli', 'pi-sessions', 'thread-pi.json'), 'utf8'));
    expect(stored).toMatchObject({ id: 'sess-pi-1', cwd: project });
  });

  it('fails a settled agent turn that produced no text', async () => {
    transport.request.mockImplementation(async (command: Record<string, unknown>) => {
      if (command.type === 'prompt') {
        transport.emit({ type: 'agent_start' });
        transport.emit({
          type: 'message_end',
          message: { role: 'assistant', content: [] },
        });
        transport.emit({ type: 'agent_settled' });
        return { type: 'response', command: 'prompt', success: true };
      }
      if (command.type === 'get_last_assistant_text') {
        return { type: 'response', command: 'get_last_assistant_text', success: true, data: { text: '' } };
      }
      if (command.type === 'get_state') {
        return {
          type: 'response',
          command: 'get_state',
          success: true,
          data: { sessionId: 'sess-pi-1', sessionFile: path.join(home, 'sess.jsonl'), isStreaming: false },
        };
      }
      return { type: 'response', command: String(command.type), success: true };
    });

    const result = await executor.execute('hello', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('without a text response');
  });

  it('lists models, changes model and thinking level, and uses native compaction', async () => {
    const listed = await executor.listModels();
    expect(listed.map((model) => model.id)).toEqual(['google/gemini-3-flash', 'anthropic/claude-sonnet-4']);
    await expect(executor.setModel('anthropic/claude-sonnet-4')).resolves.toMatchObject({ success: true });
    await expect(executor.setEffort('high')).resolves.toMatchObject({ success: true });
    await expect(executor.setEffort('auto')).resolves.toMatchObject({ success: true });
    await expect(executor.compactWhenFull()).resolves.toMatchObject({ success: true, output: 'compacted' });
    expect(transport.request).toHaveBeenCalledWith(expect.objectContaining({
      type: 'set_model',
      provider: 'anthropic',
      modelId: 'claude-sonnet-4',
    }));
    expect(transport.request).toHaveBeenCalledWith(expect.objectContaining({
      type: 'set_thinking_level',
      level: 'high',
    }));
    expect(transport.request).toHaveBeenCalledWith(expect.objectContaining({
      type: 'set_thinking_level',
      level: 'medium',
    }));
    expect(transport.request).toHaveBeenCalledWith({ type: 'compact' }, expect.any(Number));
  });

  it('returns Pi session and context usage from the official RPC statistics', async () => {
    await expect(executor.getContextUsage()).resolves.toEqual({
      inputTokens: 50000,
      outputTokens: 10000,
      cacheReadTokens: 40000,
      cacheWriteTokens: 5000,
      totalTokens: 105000,
      contextTokens: 60000,
      contextWindow: 200000,
      contextPercent: 30,
    });
    expect(transport.request).toHaveBeenCalledWith({ type: 'get_session_stats' });
  });

  it('returns no usage when an older Pi RPC does not expose session statistics', async () => {
    await executor.listModels();
    transport.request.mockResolvedValueOnce({
      type: 'response',
      command: 'get_session_stats',
      success: false,
      error: 'Unknown command type: get_session_stats',
    });

    await expect(executor.getContextUsage()).resolves.toBeNull();
  });

  it('resets context by dropping the session and recycling the process', async () => {
    const transports: FakePiTransport[] = [];
    await executor.destroy();
    executor = new PiExecutor(new DirectoryGuard([home]), {
      initialWorkingDirectory: project,
      threadId: 'thread-pi',
      sessionBaseDir: path.join(home, '.remote-cli', 'pi-sessions'),
      clientFactory: (launch) => {
        transport = new FakePiTransport(launch);
        transports.push(transport);
        return transport;
      },
    });

    await executor.execute('inspect', {});
    const first = transports[0];
    const pointerPath = path.join(home, '.remote-cli', 'pi-sessions', 'thread-pi.json');
    expect(first.running).toBe(true);
    await expect(fs.readFile(pointerPath, 'utf8')).resolves.toContain('sess-pi-1');

    executor.resetContext();

    expect(first.running).toBe(false);
    expect(first.request).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'new_session' }));
    await expect(fs.access(pointerPath)).rejects.toMatchObject({ code: 'ENOENT' });

    const result = await executor.execute('inspect', {});
    expect(result).toMatchObject({ success: true, output: 'done' });
    expect(transports[1]).toBeDefined();
    expect(transports[1]).not.toBe(first);
    expect(transports[1].request).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'new_session' }));
    await expect(fs.readFile(pointerPath, 'utf8')).resolves.toContain('sess-pi-1');
  });

  it('applies clearModel to the running RPC immediately', async () => {
    await executor.listModels();
    await expect(executor.setModel('anthropic/claude-sonnet-4')).resolves.toMatchObject({ success: true });
    await executor.clearModel();
    expect(transport.request).toHaveBeenCalledWith(expect.objectContaining({
      type: 'set_model',
      provider: 'google',
      modelId: 'gemini-3-flash',
    }));
    expect(transport.launch.model).toBeUndefined();
  });

  it('surfaces agent_end errors instead of an empty successful turn', async () => {
    transport.request.mockImplementation(async (command: Record<string, unknown>) => {
      if (command.type === 'prompt') {
        transport.emit({ type: 'agent_start' });
        transport.emit({
          type: 'agent_end',
          willRetry: false,
          messages: [{
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage: '403 quota exceeded',
          }],
        });
        transport.emit({ type: 'agent_settled' });
        return { type: 'response', command: 'prompt', success: true };
      }
      if (command.type === 'get_last_assistant_text') {
        return { type: 'response', command: 'get_last_assistant_text', success: true, data: { text: '' } };
      }
      if (command.type === 'get_state') {
        return {
          type: 'response',
          command: 'get_state',
          success: true,
          data: { sessionId: 'sess-pi-1', sessionFile: path.join(home, 'sess.jsonl'), isStreaming: false },
        };
      }
      return { type: 'response', command: String(command.type), success: true };
    });

    const result = await executor.execute('hello', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('403 quota exceeded');
  });

  it('uses the agent_end retry error when the turn settles without text', async () => {
    transport.request.mockImplementation(async (command: Record<string, unknown>) => {
      if (command.type === 'prompt') {
        transport.emit({ type: 'agent_start' });
        transport.emit({
          type: 'agent_end',
          willRetry: true,
          messages: [{
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage: '529 overloaded',
          }],
        });
        transport.emit({ type: 'agent_settled' });
        return { type: 'response', command: 'prompt', success: true };
      }
      if (command.type === 'get_last_assistant_text') {
        return { type: 'response', command: 'get_last_assistant_text', success: true, data: { text: '' } };
      }
      if (command.type === 'get_state') {
        return {
          type: 'response',
          command: 'get_state',
          success: true,
          data: { sessionId: 'sess-pi-1', isStreaming: false },
        };
      }
      return { type: 'response', command: String(command.type), success: true };
    });

    const result = await executor.execute('hello', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('529 overloaded');
  });

  it('keeps the retry error when agent_settled arrives before auto_retry_end', async () => {
    transport.request.mockImplementation(async (command: Record<string, unknown>) => {
      if (command.type === 'prompt') {
        transport.emit({ type: 'agent_start' });
        transport.emit({
          type: 'agent_end',
          willRetry: true,
          messages: [{
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage: '529 overloaded',
          }],
        });
        transport.emit({ type: 'agent_settled' });
        transport.emit({
          type: 'auto_retry_end',
          success: false,
          attempt: 3,
          finalError: '529 overloaded_error: Overloaded',
        });
        return { type: 'response', command: 'prompt', success: true };
      }
      if (command.type === 'get_last_assistant_text') {
        return { type: 'response', command: 'get_last_assistant_text', success: true, data: { text: '' } };
      }
      if (command.type === 'get_state') {
        return {
          type: 'response',
          command: 'get_state',
          success: true,
          data: { sessionId: 'sess-pi-1', isStreaming: false },
        };
      }
      return { type: 'response', command: String(command.type), success: true };
    });

    const result = await executor.execute('hello', {});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/529/);
  });

  it('streams Pi retry progress without adding it to the final model output', async () => {
    transport.request.mockImplementation(async (command: Record<string, unknown>) => {
      if (command.type === 'prompt') {
        transport.emit({ type: 'agent_start' });
        transport.emit({
          type: 'auto_retry_start',
          attempt: 1,
          maxAttempts: 3,
          delayMs: 2000,
          errorMessage: '529 overloaded',
        });
        transport.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'recovered' } });
        transport.emit({ type: 'auto_retry_end', success: true, attempt: 2 });
        transport.emit({ type: 'agent_settled' });
        return { type: 'response', command: 'prompt', success: true };
      }
      if (command.type === 'get_state') {
        return { type: 'response', command: 'get_state', success: true, data: { sessionId: 'sess-pi-1' } };
      }
      return { type: 'response', command: String(command.type), success: true };
    });
    const chunks: string[] = [];

    const result = await executor.execute('hello', { onStream: (chunk) => chunks.push(chunk) });

    expect(result).toMatchObject({ success: true, output: 'recovered' });
    expect(chunks.join('')).toContain('Pi retry 1/3 in 2s: 529 overloaded');
    expect(result.output).not.toContain('Pi retry');
  });

  it('ignores message tool-call deltas and emits tools from execution events once', async () => {
    transport.request.mockImplementation(async (command: Record<string, unknown>) => {
      if (command.type === 'prompt') {
        transport.emit({ type: 'agent_start' });
        transport.emit({
          type: 'message_update',
          assistantMessageEvent: {
            type: 'toolcall_end',
            toolCall: { id: 'tool-current', name: 'bash', arguments: { command: 'pwd' } },
          },
        });
        transport.emit({
          type: 'tool_execution_start',
          toolCallId: 'tool-current',
          toolName: 'bash',
          args: { command: 'pwd' },
        });
        transport.emit({
          type: 'tool_execution_end',
          toolCallId: 'tool-current',
          result: { content: [{ type: 'text', text: '/tmp' }] },
          isError: false,
        });
        transport.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'done' } });
        transport.emit({ type: 'agent_settled' });
        return { type: 'response', command: 'prompt', success: true };
      }
      if (command.type === 'get_state') {
        return { type: 'response', command: 'get_state', success: true, data: { sessionId: 'sess-pi-1' } };
      }
      return { type: 'response', command: String(command.type), success: true };
    });
    const onToolUse = vi.fn();
    const onToolResult = vi.fn();

    await executor.execute('inspect', { onToolUse, onToolResult });

    expect(onToolUse).toHaveBeenCalledTimes(1);
    expect(onToolUse).toHaveBeenCalledWith({ id: 'tool-current', name: 'Bash', input: { command: 'pwd' } });
    expect(onToolResult).toHaveBeenCalledTimes(1);
  });

  it('aborts an in-flight turn without waiting for agent_settled', async () => {
    transport.request.mockImplementation(async (command: Record<string, unknown>) => {
      if (command.type === 'prompt') {
        transport.emit({ type: 'agent_start' });
        return { type: 'response', command: 'prompt', success: true };
      }
      if (command.type === 'get_state') {
        return { type: 'response', command: 'get_state', success: true, data: { sessionId: 'sess-pi-1' } };
      }
      return { type: 'response', command: String(command.type), success: true };
    });

    const running = executor.execute('long turn', {});
    await vi.waitFor(() => expect(transport.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'prompt' })));
    await expect(executor.abort()).resolves.toBe(true);
    await expect(running).resolves.toMatchObject({ success: false, error: 'Aborted' });
    expect(transport.request).toHaveBeenCalledWith({ type: 'clear_queue' });
    expect(transport.request).toHaveBeenCalledWith({ type: 'abort' });
  });

  it('starts a fresh Pi session after a working-directory change', async () => {
    const other = path.join(home, 'other');
    await fs.mkdir(other);
    await executor.execute('inspect', {});
    expect(transport.starts).toBe(1);
    expect(transport.running).toBe(true);

    await executor.setWorkingDirectory(other);
    expect(transport.running).toBe(false);
    expect(executor.getCurrentWorkingDirectory()).toBe(other);
    expect(executor.getSessionId()).toBeNull();
    expect(transport.launch).toMatchObject({
      cwd: other,
      sessionId: 'thread-pi',
    });
    expect(transport.launch.sessionFile).toBeUndefined();
    await expect(fs.access(path.join(home, '.remote-cli', 'pi-sessions', 'thread-pi.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });

    await executor.execute('inspect', {});
    expect(transport.starts).toBe(2);
    expect(transport.running).toBe(true);
    expect(transport.launch.cwd).toBe(other);
    expect(executor.getSessionId()).toBe('sess-pi-1');
  });

  it('surfaces extension_error on the active turn', async () => {
    transport.request.mockImplementation(async (command: Record<string, unknown>) => {
      if (command.type === 'prompt') {
        transport.emit({ type: 'agent_start' });
        transport.emit({
          type: 'extension_error',
          extensionPath: '/tmp/ext.ts',
          event: 'tool_call',
          error: 'extension exploded',
        });
        transport.emit({ type: 'agent_settled' });
        return { type: 'response', command: 'prompt', success: true };
      }
      if (command.type === 'get_last_assistant_text') {
        return { type: 'response', command: 'get_last_assistant_text', success: true, data: { text: '' } };
      }
      if (command.type === 'get_state') {
        return { type: 'response', command: 'get_state', success: true, data: { sessionId: 'sess-pi-1' } };
      }
      return { type: 'response', command: String(command.type), success: true };
    });

    const result = await executor.execute('hello', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('extension exploded');
  });

  it('writes the session pointer without leaving a temporary file', async () => {
    await executor.execute('inspect', {});
    const pointerDir = path.join(home, '.remote-cli', 'pi-sessions');
    const stored = JSON.parse(await fs.readFile(path.join(pointerDir, 'thread-pi.json'), 'utf8'));
    expect(stored).toMatchObject({ id: 'sess-pi-1', cwd: project });
    const leftovers = (await fs.readdir(pointerDir)).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('lists Pi skills through get_commands instead of prompting the model', async () => {
    const result = await executor.execute('/skills', {});
    expect(result.success).toBe(true);
    expect(result.output).toContain('/skill:review');
    expect(transport.request).toHaveBeenCalledWith({ type: 'get_commands' });
    expect(transport.request).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'prompt' }));
  });

  it('forwards only slash commands advertised by Pi RPC', async () => {
    await expect(executor.execute('/skill:review', {})).resolves.toMatchObject({ success: true, output: 'done' });
    expect(transport.request).toHaveBeenCalledWith({ type: 'get_commands' });
    expect(transport.request).toHaveBeenCalledWith(expect.objectContaining({
      type: 'prompt',
      message: '/skill:review',
    }));

    transport.request.mockClear();
    const unsupported = await executor.execute('/settings', {});
    expect(unsupported.success).toBe(false);
    expect(unsupported.error).toContain('does not expose /settings');
    expect(transport.request).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'prompt' }));
  });

  it('relays select prompts through the mobile input flow when auto-approval is off', async () => {
    await executor.destroy();
    executor = new PiExecutor(new DirectoryGuard([home]), {
      initialWorkingDirectory: project,
      threadId: 'thread-pi',
      sessionBaseDir: path.join(home, '.remote-cli', 'pi-sessions'),
      autoApprove: false,
      clientFactory: (launch) => {
        transport = new FakePiTransport(launch);
        transport.request.mockImplementation(async (command: Record<string, unknown>) => {
          if (command.type === 'prompt') {
            transport.emit({
              type: 'extension_ui_request',
              id: 'ui-1',
              method: 'select',
              title: 'Allow dangerous command?',
              options: ['Allow', 'Block'],
            });
            await vi.waitFor(() => {
              expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({
                type: 'extension_ui_response',
                id: 'ui-1',
              }));
            });
            transport.emit({ type: 'agent_start' });
            transport.emit({
              type: 'message_update',
              assistantMessageEvent: { type: 'text_delta', delta: 'ok' },
            });
            transport.emit({ type: 'agent_settled' });
            return { type: 'response', command: 'prompt', success: true };
          }
          if (command.type === 'get_state') {
            return { type: 'response', command: 'get_state', success: true, data: { sessionId: 'sess-pi-1' } };
          }
          return { type: 'response', command: String(command.type), success: true };
        });
        return transport;
      },
    });

    const running = executor.execute('choose', {});
    await vi.waitFor(() => expect(executor.isWaitingInput()).toBe(true));
    expect(transport.launch.approveProject).toBe(false);
    expect(executor.sendInput('   ')).toBe(false);
    expect(executor.isWaitingInput()).toBe(true);
    expect(executor.sendInput('2')).toBe(true);
    await expect(running).resolves.toMatchObject({ success: true, output: 'ok' });
    expect(transport.send).toHaveBeenCalledWith({
      type: 'extension_ui_response',
      id: 'ui-1',
      value: 'Block',
    });
  });

  it('renders nonstandard object select options without losing their values', async () => {
    transport.request.mockImplementation(async (command: Record<string, unknown>) => {
      if (command.type === 'prompt') {
        transport.emit({
          type: 'extension_ui_request',
          id: 'ui-object',
          method: 'select',
          title: 'Choose a mode',
          options: [
            { label: 'Preview', value: 'preview', description: 'Read-only inspection' },
            { label: 'Apply', value: 'apply', description: 'Modify files' },
          ],
        });
        await vi.waitFor(() => expect(transport.send).toHaveBeenCalledWith({
          type: 'extension_ui_response',
          id: 'ui-object',
          value: 'apply',
        }));
        transport.emit({ type: 'agent_start' });
        transport.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'applied' } });
        transport.emit({ type: 'agent_settled' });
        return { type: 'response', command: 'prompt', success: true };
      }
      if (command.type === 'get_state') {
        return { type: 'response', command: 'get_state', success: true, data: { sessionId: 'sess-pi-1' } };
      }
      return { type: 'response', command: String(command.type), success: true };
    });
    const chunks: string[] = [];

    const running = executor.execute('choose', { onStream: (chunk) => chunks.push(chunk) });
    await vi.waitFor(() => expect(executor.isWaitingInput()).toBe(true));
    expect(chunks.join('')).toContain('2. Apply — Modify files');
    expect(chunks.join('')).not.toContain('[object Object]');
    expect(executor.sendInput('Apply')).toBe(true);

    await expect(running).resolves.toMatchObject({ success: true, output: 'applied' });
  });

  it('relays extension confirmations even when project trust is enabled', async () => {
    transport.request.mockImplementation(async (command: Record<string, unknown>) => {
      if (command.type === 'prompt') {
        transport.emit({
          type: 'extension_ui_request',
          id: 'ui-confirm',
          method: 'confirm',
          title: 'Clear the session?',
        });
        await vi.waitFor(() => expect(transport.send).toHaveBeenCalledWith({
          type: 'extension_ui_response',
          id: 'ui-confirm',
          cancelled: true,
        }));
        transport.emit({ type: 'agent_start' });
        transport.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'kept' } });
        transport.emit({ type: 'agent_settled' });
        return { type: 'response', command: 'prompt', success: true };
      }
      if (command.type === 'get_state') {
        return { type: 'response', command: 'get_state', success: true, data: { sessionId: 'sess-pi-1' } };
      }
      return { type: 'response', command: String(command.type), success: true };
    });

    const running = executor.execute('confirm', {});
    await vi.waitFor(() => expect(executor.isWaitingInput()).toBe(true));
    expect(executor.sendInput('no')).toBe(true);

    await expect(running).resolves.toMatchObject({ success: true, output: 'kept' });
    expect(transport.send).toHaveBeenCalledWith({
      type: 'extension_ui_response',
      id: 'ui-confirm',
      cancelled: true,
    });
  });
});
