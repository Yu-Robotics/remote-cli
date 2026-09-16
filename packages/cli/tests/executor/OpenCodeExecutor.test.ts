import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { OpenCodeExecutor } from '../../src/executor/OpenCodeExecutor';
import type { AcpEventCallbacks, AcpTransport } from '../../src/executor/acp/AcpClient';
import type { AcpConfigOption, AcpContentBlock, AcpSessionResult } from '../../src/executor/acp/AcpTypes';

const originalHomedir = os.homedir();
vi.spyOn(os, 'homedir').mockImplementation(() => process.env.HOME || originalHomedir);

const options: AcpConfigOption[] = [
  {
    id: 'model', name: 'Model', type: 'select', currentValue: 'opencode/free-a',
    options: [{ value: 'opencode/free-a', name: 'Free A' }, { value: 'opencode/free-b', name: 'Free B' }],
  },
  {
    id: 'effort', name: 'Effort', type: 'select', currentValue: 'default',
    options: ['minimal', 'low', 'medium', 'high', 'default'].map((value) => ({ value, name: value })),
  },
];

class FakeTransport implements AcpTransport {
  initialize = vi.fn().mockResolvedValue({ protocolVersion: 1 });
  newSession = vi.fn(async (): Promise<AcpSessionResult> => ({ sessionId: 'ses-new', configOptions: options }));
  loadSession = vi.fn(async (): Promise<AcpSessionResult> => ({ configOptions: options }));
  setConfigOption = vi.fn(async (_sessionId: string, id: string, value: string): Promise<AcpSessionResult> => ({
    configOptions: options.map((option) => option.id === id ? { ...option, currentValue: value } : option),
  }));
  deleteSession = vi.fn().mockResolvedValue(undefined);
  sendCancel = vi.fn();
  destroy = vi.fn();
  prompt = vi.fn(async (_sessionId: string, _blocks: AcpContentBlock[]) => ({ stopReason: 'end_turn' }));
}

describe('OpenCodeExecutor', () => {
  let home: string;
  let project: string;
  let transport: FakeTransport;
  let callbacks: AcpEventCallbacks;
  let executor: OpenCodeExecutor;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-executor-test-'));
    project = path.join(home, 'project');
    await fs.mkdir(project);
    process.env.HOME = home;
    transport = new FakeTransport();
    callbacks = {};
    executor = new OpenCodeExecutor(new DirectoryGuard([home]), {
      initialWorkingDirectory: project,
      threadId: 'thread-a',
      sessionBaseDir: path.join(home, '.remote-cli', 'opencode-sessions'),
      clientFactory: (next) => {
        callbacks = next;
        return transport;
      },
    });
  });

  afterEach(async () => {
    await executor.destroy();
    await fs.rm(home, { recursive: true, force: true });
    delete process.env.HOME;
  });

  it('creates a session, streams text, and persists the session pointer', async () => {
    transport.prompt.mockImplementationOnce(async () => {
      callbacks.onTextChunk?.({ type: 'text', text: 'hello' });
      return { stopReason: 'end_turn' };
    });
    const chunks: string[] = [];
    const result = await executor.execute('hi', { onStream: (chunk) => chunks.push(chunk) });

    expect(result).toMatchObject({ success: true, output: 'hello', sessionAbbr: 'ses-new' });
    expect(chunks).toEqual(['hello']);
    expect(transport.newSession).toHaveBeenCalledWith(project);
    const stored = JSON.parse(await fs.readFile(path.join(home, '.remote-cli', 'opencode-sessions', 'thread-a.json'), 'utf8'));
    expect(stored.id).toBe('ses-new');
  });

  it('loads a persisted session after executor recreation', async () => {
    await fs.mkdir(path.join(home, '.remote-cli', 'opencode-sessions'), { recursive: true });
    await fs.writeFile(
      path.join(home, '.remote-cli', 'opencode-sessions', 'thread-b.json'),
      JSON.stringify({ id: 'ses-existing', cwd: project })
    );
    const restored = new OpenCodeExecutor(new DirectoryGuard([home]), {
      initialWorkingDirectory: project,
      threadId: 'thread-b',
      sessionBaseDir: path.join(home, '.remote-cli', 'opencode-sessions'),
      clientFactory: () => transport,
    });
    await restored.execute('continue', {});
    expect(transport.loadSession).toHaveBeenCalledWith('ses-existing', project);
    expect(transport.newSession).not.toHaveBeenCalled();
    await restored.destroy();
  });

  it('passes image attachments as native ACP content blocks', async () => {
    await executor.execute('inspect', {
      attachments: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
    });
    expect(transport.prompt).toHaveBeenCalledWith('ses-new', [
      { type: 'text', text: 'inspect' },
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
    ]);
  });

  it('maps ACP tool calls and results to executor callbacks', async () => {
    const onToolUse = vi.fn();
    const onToolResult = vi.fn();
    transport.prompt.mockImplementationOnce(async () => {
      callbacks.onToolCall?.({ toolCallId: 'tool-1', title: 'Run command', kind: 'execute', rawInput: { command: 'pwd' } });
      callbacks.onToolResult?.({ toolCallId: 'tool-1', status: 'completed', content: [{ type: 'text', text: '/tmp' }] });
      return { stopReason: 'end_turn' };
    });
    await executor.execute('pwd', { onToolUse, onToolResult });
    expect(onToolUse).toHaveBeenCalledWith({ id: 'tool-1', name: 'Bash', input: { command: 'pwd' } });
    expect(onToolResult).toHaveBeenCalledWith({ tool_use_id: 'tool-1', content: '/tmp', is_error: false });
  });

  it('lists models from ACP session config options', async () => {
    const models = await executor.listModels();
    expect(models.map((model) => model.id)).toEqual(['opencode/free-a', 'opencode/free-b']);
    expect(models[0]).toMatchObject({ isDefault: true, inputModalities: ['text', 'image'] });
  });

  it('sets a known model and rejects an unknown model', async () => {
    await executor.listModels();
    await expect(executor.setModel('opencode/free-b')).resolves.toMatchObject({ success: true });
    expect(transport.setConfigOption).toHaveBeenCalledWith('ses-new', 'model', 'opencode/free-b');
    await expect(executor.setModel('missing/model')).resolves.toMatchObject({ success: false });
  });

  it('maps auto effort to the ACP default option', async () => {
    await executor.listModels();
    await expect(executor.setEffort('auto')).resolves.toMatchObject({ success: true });
    expect(transport.setConfigOption).toHaveBeenCalledWith('ses-new', 'effort', 'default');
  });

  it('sends cooperative cancellation for an active prompt', async () => {
    let finish!: (value: { stopReason: string }) => void;
    transport.prompt.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const running = executor.execute('wait', {});
    await vi.waitFor(() => expect(transport.prompt).toHaveBeenCalled());
    await expect(executor.abort()).resolves.toBe(true);
    expect(transport.sendCancel).toHaveBeenCalledWith('ses-new');
    finish({ stopReason: 'cancelled' });
    await expect(running).resolves.toMatchObject({ success: false });
  });

  it('starts a fresh session after changing working directory', async () => {
    const other = path.join(home, 'other');
    await fs.mkdir(other);
    await executor.execute('first', {});
    await executor.setWorkingDirectory(other);
    transport.newSession.mockResolvedValueOnce({ sessionId: 'ses-other', configOptions: options });
    await executor.execute('second', {});
    expect(transport.destroy).toHaveBeenCalled();
    expect(executor.getSessionId()).toBe('ses-other');
  });

  it('recreates the ACP transport after a prompt failure', async () => {
    const replacement = new FakeTransport();
    transport.prompt.mockRejectedValueOnce(new Error('ACP process exited'));
    let created = 0;
    const recovering = new OpenCodeExecutor(new DirectoryGuard([home]), {
      initialWorkingDirectory: project,
      threadId: 'thread-recovery',
      sessionBaseDir: path.join(home, '.remote-cli', 'opencode-sessions'),
      clientFactory: (next) => {
        callbacks = next;
        return created++ === 0 ? transport : replacement;
      },
    });

    await expect(recovering.execute('first', {})).resolves.toMatchObject({ success: false });
    await expect(recovering.execute('second', {})).resolves.toMatchObject({ success: true });
    expect(transport.destroy).toHaveBeenCalled();
    expect(replacement.loadSession).toHaveBeenCalledWith('ses-new', project);
    await recovering.destroy();
  });
});
