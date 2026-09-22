import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { ZCodeExecutor } from '../../src/executor/ZCodeExecutor';
import type { AcpEventCallbacks, AcpTransport } from '../../src/executor/acp/AcpClient';
import type { AcpConfigOption, AcpContentBlock, AcpSessionResult } from '../../src/executor/acp/AcpTypes';

const originalHome = process.env.HOME;
const originalHomedir = os.homedir();

const options: AcpConfigOption[] = [
  {
    id: 'model', name: 'Model', type: 'select', currentValue: 'GLM-5.3',
    options: [{ value: 'GLM-5.3', name: 'GLM-5.3' }, { value: 'GLM-5.3-Flash', name: 'GLM-5.3-Flash' }],
  },
  {
    id: 'thought', name: 'Reasoning effort', type: 'select', currentValue: 'max',
    options: ['low', 'high', 'max'].map((value) => ({ value, name: value })),
  },
];

class FakeZCodeTransport implements AcpTransport {
  initialize = vi.fn().mockResolvedValue({});
  newSession = vi.fn(async (): Promise<AcpSessionResult> => ({ sessionId: 'sess-zcode', configOptions: options }));
  loadSession = vi.fn(async (): Promise<AcpSessionResult> => ({ sessionId: 'sess-zcode', configOptions: options }));
  prompt = vi.fn(async (): Promise<{ stopReason: string }> => ({ stopReason: 'end_turn' }));
  setConfigOption = vi.fn(async (_sessionId: string, id: string, value: string): Promise<AcpSessionResult> => ({
    configOptions: options.map((option) => option.id === id ? { ...option, currentValue: value } : option),
  }));
  compactSession = vi.fn(async () => ({ stopReason: 'end_turn' }));
  deleteSession = vi.fn().mockResolvedValue(undefined);
  sendCancel = vi.fn();
  destroy = vi.fn();
}

describe('ZCodeExecutor', () => {
  let home: string;
  let project: string;
  let transport: FakeZCodeTransport;
  let callbacks: AcpEventCallbacks;
  let executor: ZCodeExecutor;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(originalHomedir, '.zcode-executor-test-'));
    project = path.join(home, 'project');
    await fs.mkdir(project);
    process.env.HOME = home;
    transport = new FakeZCodeTransport();
    callbacks = {};
    executor = new ZCodeExecutor(new DirectoryGuard([home]), {
      initialWorkingDirectory: project,
      threadId: 'thread-zcode',
      sessionBaseDir: path.join(home, '.remote-cli', 'zcode-sessions'),
      clientFactory: (next) => {
        callbacks = next;
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

  it('streams text, tools, and image input while persisting the ZCode session', async () => {
    const chunks: string[] = [];
    const onToolUse = vi.fn();
    const onToolResult = vi.fn();
    transport.prompt.mockImplementationOnce(async () => {
      callbacks.onTextChunk?.({ type: 'text', text: 'done' });
      callbacks.onToolCall?.({ toolCallId: 'tool-1', title: 'Bash', kind: 'execute', rawInput: { command: 'pwd' } });
      callbacks.onToolResult?.({ toolCallId: 'tool-1', status: 'completed', rawOutput: '/tmp' });
      return { stopReason: 'end_turn' };
    });

    const result = await executor.execute('inspect', {
      attachments: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
      onStream: (chunk) => chunks.push(chunk),
      onToolUse,
      onToolResult,
    });

    expect(result).toMatchObject({ success: true, output: 'done', sessionAbbr: 'sess-zco' });
    expect(chunks).toEqual(['done']);
    expect(transport.prompt).toHaveBeenCalledWith('sess-zcode', [
      { type: 'text', text: 'inspect' },
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
    ]);
    expect(onToolUse).toHaveBeenCalledWith({ id: 'tool-1', name: 'Bash', input: { command: 'pwd' } });
    expect(onToolResult).toHaveBeenCalledWith({ tool_use_id: 'tool-1', content: '/tmp', is_error: false });
    const stored = JSON.parse(await fs.readFile(path.join(home, '.remote-cli', 'zcode-sessions', 'thread-zcode.json'), 'utf8'));
    expect(stored).toMatchObject({ id: 'sess-zcode', cwd: project });
  });

  it('lists models, changes model and thought level, and uses native compaction', async () => {
    const models = await executor.listModels();
    expect(models.map((model) => model.id)).toEqual(['GLM-5.3', 'GLM-5.3-Flash']);
    await expect(executor.setModel('GLM-5.3-Flash')).resolves.toMatchObject({ success: true });
    await expect(executor.setEffort('high')).resolves.toMatchObject({ success: true });
    await expect(executor.compactWhenFull()).resolves.toMatchObject({ success: true });
    expect(transport.setConfigOption).toHaveBeenCalledWith('sess-zcode', 'model', 'GLM-5.3-Flash');
    expect(transport.setConfigOption).toHaveBeenCalledWith('sess-zcode', 'thought', 'high');
    expect(transport.compactSession).toHaveBeenCalledWith('sess-zcode');
    expect(transport.prompt).not.toHaveBeenCalledWith('sess-zcode', [{ type: 'text', text: '/compact' }]);
  });

  it('relays ZCode questions through the mobile input flow even with auto-approval enabled', async () => {
    let selected = -1;
    transport.prompt.mockImplementationOnce(async () => {
      selected = await callbacks.onPermissionRequest!('Choose a strategy', [
        { kind: 'allow_once', optionId: 'q0_opt_0', name: 'Fast' },
        { kind: 'allow_once', optionId: 'q0_opt_1', name: 'Safe' },
        { kind: 'reject_once', optionId: 'q0_skip', name: 'Skip' },
      ]);
      return { stopReason: 'end_turn' };
    });
    const running = executor.execute('choose', {});
    await vi.waitFor(() => expect(executor.isWaitingInput()).toBe(true));
    expect(executor.sendInput('2')).toBe(true);
    await expect(running).resolves.toMatchObject({ success: true });
    expect(selected).toBe(1);
  });
});
