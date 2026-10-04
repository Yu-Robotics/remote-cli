import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { KimiExecutor } from '../../src/executor/KimiExecutor';
import { OpenCodeExecutor } from '../../src/executor/OpenCodeExecutor';
import { ZCodeExecutor } from '../../src/executor/ZCodeExecutor';
import { DshExecutor } from '../../src/executor/DshExecutor';
import type { AcpEventCallbacks, AcpTransport } from '../../src/executor/acp/AcpClient';
import type { AcpContentBlock, AcpSessionResult } from '../../src/executor/acp/AcpTypes';

class FakeTransport implements AcpTransport {
  initialize = vi.fn().mockResolvedValue({});
  newSession = vi.fn(async (): Promise<AcpSessionResult> => ({ sessionId: 'output-session', configOptions: [] }));
  loadSession = vi.fn(async (): Promise<AcpSessionResult> => ({ configOptions: [] }));
  prompt = vi.fn(async (_id: string, _blocks: AcpContentBlock[]) => ({ stopReason: 'end_turn' }));
  setConfigOption = vi.fn().mockResolvedValue({ configOptions: [] });
  deleteSession = vi.fn().mockResolvedValue(undefined);
  sendCancel = vi.fn();
  destroy = vi.fn();
  waitForExit = vi.fn().mockResolvedValue(undefined);
}

describe.each([
  ['Kimi', KimiExecutor], ['OpenCode', OpenCodeExecutor], ['ZCode', ZCodeExecutor],
  ['DSH', DshExecutor],
] as const)('%s thought isolation', (_backend, Executor) => {
  let directory: string;
  let executor: KimiExecutor | OpenCodeExecutor | ZCodeExecutor | DshExecutor;
  let callbacks: AcpEventCallbacks;
  let transport: FakeTransport;

  const create = (delegationWorker = false) => new Executor(new DirectoryGuard([directory]), {
    initialWorkingDirectory: directory, threadId: 'output-test', autoApprove: false,
    delegationWorker,
    sessionBaseDir: path.join(directory, 'sessions'),
    clientFactory: next => { callbacks = next; return transport; },
  });

  beforeEach(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'remote-cli-acp-output-')));
    vi.spyOn(os, 'homedir').mockReturnValue(directory);
    transport = new FakeTransport();
    callbacks = {};
    executor = create();
  });

  afterEach(async () => {
    await executor.destroy();
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('excludes interleaved thoughts without filtering ordinary response wording', async () => {
    transport.prompt.mockImplementationOnce(async () => {
      callbacks.onThoughtChunk?.({ type: 'text', text: 'PRIVATE_BEFORE' });
      callbacks.onTextChunk?.({ type: 'text', text: 'Thinking about ' });
      callbacks.onThoughtChunk?.({ type: 'text', text: 'PRIVATE_BETWEEN' });
      callbacks.onTextChunk?.({ type: 'text', text: '**documentation**.' });
      callbacks.onThoughtChunk?.({ type: 'text', text: 'PRIVATE_AFTER' });
      return { stopReason: 'end_turn' };
    });
    const stream = vi.fn(), display = vi.fn();
    const result = await executor.execute('review', { onStream: stream, onDisplayText: display });
    expect(result).toMatchObject({ success: true, output: 'Thinking about **documentation**.' });
    expect(stream.mock.calls).toEqual([['Thinking about '], ['**documentation**.']]);
    expect(display.mock.calls).toEqual(stream.mock.calls);
    expect(transport.setConfigOption).not.toHaveBeenCalled();
  });

  it('reads cached native model/effort options without starting or querying a backend', async () => {
    expect(executor.getExecutionMetadata()).toMatchObject({ modelSource: 'default', effortSource: 'default' });
    expect(transport.initialize).not.toHaveBeenCalled();
    transport.newSession.mockResolvedValueOnce({ sessionId: 'metadata-session', configOptions: [
      { id: 'model', currentValue: 'native-model' },
      { id: ({ Kimi: 'thinking', OpenCode: 'effort', ZCode: 'thought', DSH: 'reasoning_effort' })[_backend], currentValue: _backend === 'Kimi' ? 'on' : 'high' },
    ] });
    await executor.execute('inspect', {});
    const before = transport.prompt.mock.calls.length;
    expect(executor.getExecutionMetadata()).toMatchObject({ model: 'native-model', modelSource: 'reported' });
    expect(executor.getExecutionMetadata()).toMatchObject({ reasoningEffort: _backend === 'Kimi' ? 'on' : 'high', effortSource: 'reported' });
    expect(transport.prompt.mock.calls.length).toBe(before);
    expect(transport.setConfigOption).not.toHaveBeenCalled();
    callbacks.onConfigOptions?.([{ id: 'model', currentValue: 'updated-model' }]);
    expect(executor.getExecutionMetadata()).toMatchObject({ model: 'updated-model', modelSource: 'reported' });
  });

  it('does not attribute previous-client settings when a resumed client omits native options', async () => {
    transport.newSession.mockResolvedValueOnce({ sessionId: 'metadata-session', configOptions: [
      { id: 'model', currentValue: 'previous-model', options: [{ value: 'previous-model', name: 'Previous model' }] },
      { id: ({ Kimi: 'thinking', OpenCode: 'effort', ZCode: 'thought', DSH: 'reasoning_effort' })[_backend], currentValue: 'high' },
    ] });
    await executor.execute('first', {});
    expect(executor.getExecutionMetadata()).toMatchObject({ modelSource: 'reported', effortSource: 'reported' });
    (executor as any).destroyClient();
    transport.loadSession.mockResolvedValueOnce({});
    await executor.execute('second', {});
    expect(executor.getExecutionMetadata()).toMatchObject({ model: undefined, modelSource: 'default', reasoningEffort: undefined, effortSource: 'default' });
    expect(await executor.listModels()).toMatchObject([{ id: 'previous-model' }]);
    expect(transport.setConfigOption).not.toHaveBeenCalled();
  });

  it('finishes a thought-only turn with empty output', async () => {
    transport.prompt.mockImplementationOnce(async () => {
      callbacks.onThoughtChunk?.({ type: 'text', text: 'PRIVATE_ONLY' });
      return { stopReason: 'end_turn' };
    });
    const stream = vi.fn(), display = vi.fn();
    await expect(executor.execute('review', { onStream: stream, onDisplayText: display }))
      .resolves.toMatchObject({ success: true, output: '' });
    expect(stream).not.toHaveBeenCalled();
    expect(display).not.toHaveBeenCalled();
  });

  it('retains public images, plans, and tool events', async () => {
    const image = { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' } as const;
    transport.prompt.mockImplementationOnce(async () => {
      callbacks.onThoughtChunk?.(image);
      callbacks.onTextChunk?.(image);
      callbacks.onPlan?.([{ content: 'Review documentation', status: 'in_progress' }]);
      callbacks.onToolCall?.({ toolCallId: 'read-1', kind: 'read', rawInput: { file_path: 'README.md' } });
      callbacks.onToolResult?.({ toolCallId: 'read-1', status: 'completed', rawOutput: 'Document contents' });
      return { stopReason: 'end_turn' };
    });
    const onImage = vi.fn(), onPlanMode = vi.fn(), onToolUse = vi.fn(), onToolResult = vi.fn();
    await executor.execute('review', { onImage, onPlanMode, onToolUse, onToolResult });
    expect(onImage).toHaveBeenCalledTimes(1);
    expect(onImage).toHaveBeenCalledWith(image);
    expect(onPlanMode).toHaveBeenCalledWith('[in_progress] Review documentation');
    expect(onToolUse).toHaveBeenCalledWith({ id: 'read-1', name: 'Read', input: { file_path: 'README.md' } });
    expect(onToolResult).toHaveBeenCalledWith({ tool_use_id: 'read-1', content: 'Document contents', is_error: false });
  });

  it.each([false, true])('preserves replay semantics and filters thoughts with worker=%s', async managed => {
    await executor.execute('first turn', {});
    await executor.destroy();
    executor = create(managed);
    transport.loadSession.mockImplementationOnce(async () => {
      callbacks.onThoughtChunk?.({ type: 'text', text: 'PRIVATE_REPLAY' });
      callbacks.onTextChunk?.({ type: 'text', text: 'Historical answer' });
      return { configOptions: [] };
    });
    transport.prompt.mockImplementationOnce(async () => {
      callbacks.onTextChunk?.({ type: 'text', text: 'Fresh answer' });
      return { stopReason: 'end_turn' };
    });
    const stream = vi.fn();
    const suppressReplay = managed || _backend === 'DSH';
    await expect(executor.execute('next turn', { onStream: stream }))
      .resolves.toMatchObject({ success: true, output: suppressReplay ? 'Fresh answer' : 'Historical answerFresh answer' });
    expect(transport.loadSession).toHaveBeenCalled();
    expect(stream.mock.calls.flat()).toEqual(suppressReplay ? ['Fresh answer'] : ['Historical answer', 'Fresh answer']);
  });

  it.each([false, true])('preserves interactive input with question=%s', async question => {
    let selected = -1;
    transport.prompt.mockImplementationOnce(async () => {
      callbacks.onThoughtChunk?.({ type: 'text', text: 'PRIVATE_PROMPT' });
      selected = await callbacks.onPermissionRequest!('Choose an action', question ? [
        { optionId: 'q0_a', kind: 'allow_once', name: 'First' },
        { optionId: 'q0_b', kind: 'allow_once', name: 'Second' },
      ] : [
        { optionId: 'yes', kind: 'allow_once' },
        { optionId: 'no', kind: 'reject_once' },
      ]);
      callbacks.onTextChunk?.({ type: 'text', text: 'Selection received' });
      return { stopReason: 'end_turn' };
    });
    const stream = vi.fn();
    const running = executor.execute('review', { onStream: stream });
    await vi.waitFor(() => expect(executor.isWaitingInput()).toBe(true));
    expect(stream.mock.calls.flat().join('')).toContain('Choose an action');
    expect(executor.sendInput(question ? '2' : 'yes')).toBe(true);
    const result = await running;
    expect(selected).toBe(question ? 1 : 0);
    expect(result.success).toBe(true);
    expect(result.output).toContain('Selection received');
    expect(result.output).not.toContain('PRIVATE_PROMPT');
    expect(stream.mock.calls.flat().join('')).not.toContain('PRIVATE_PROMPT');
  });
});
