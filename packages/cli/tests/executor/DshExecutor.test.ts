import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { DshExecutor, type DshExecutorOptions } from '../../src/executor/DshExecutor';
import type { AcpEventCallbacks, AcpTransport } from '../../src/executor/acp/AcpClient';
import type { AcpContentBlock, AcpConfigOption } from '../../src/executor/acp/AcpTypes';

const model = '["deepseek-official","deepseek-v4-flash"]';
const otherModel = '["deepseek-official","deepseek-v4-pro"]';
class FakeTransport implements AcpTransport {
  options: AcpConfigOption[] = [
    { id: 'model', name: 'Model', type: 'select', currentValue: model,
      options: [{ value: model, name: 'Flash' }, { value: otherModel, name: 'Pro' }] },
    { id: 'reasoning_effort', name: 'Effort', type: 'select', currentValue: 'high',
      options: [{ value: '', name: 'Default' }, { value: 'high', name: 'High' }] },
  ];
  constructor(readonly events: AcpEventCallbacks, readonly id: string, images: boolean) {
    this.initialize.mockResolvedValue({ protocolVersion: 1, agentCapabilities: {
      sessionCapabilities: { resume: {} }, promptCapabilities: { image: images },
    } });
  }
  initialize = vi.fn();
  newSession = vi.fn(async () => ({ sessionId: this.id, configOptions: this.options }));
  loadSession = vi.fn(async () => ({ configOptions: this.options }));
  prompt = vi.fn(async (_id: string, _blocks: AcpContentBlock[]) => {
    this.events.onThoughtChunk?.({ type: 'text', text: 'private reasoning' });
    this.events.onTextChunk?.({ type: 'text', text: 'public answer' });
    return { stopReason: 'end_turn' };
  });
  setConfigOption = vi.fn(async (_id: string, key: string, value: string) => {
    this.options.find(option => option.id === key)!.currentValue = value;
    return { configOptions: this.options };
  });
  deleteSession = vi.fn().mockResolvedValue(undefined);
  sendCancel = vi.fn();
  destroy = vi.fn();
  waitForExit = vi.fn().mockResolvedValue(undefined);
}

describe('DshExecutor', () => {
  let directory: string;
  let executor: DshExecutor;
  let transports: FakeTransport[];
  let executors: DshExecutor[];
  let images: boolean;
  let customize: ((transport: FakeTransport) => void) | undefined;
  const pointer = () => path.join(directory, 'sessions', 'thread.json');
  const handoff = () => path.join(directory, 'sessions', 'thread.handoff.json');
  const current = () => transports[transports.length - 1];
  const create = (options: Partial<DshExecutorOptions> = {}) => {
    const instance = new DshExecutor(new DirectoryGuard([directory]), {
      initialWorkingDirectory: directory, sessionBaseDir: path.join(directory, 'sessions'),
      threadId: 'thread', autoApprove: false,
      clientFactory: events => {
        const transport = new FakeTransport(events, `session-${transports.length}`, images);
        customize?.(transport);
        transports.push(transport);
        return transport;
      }, ...options,
    });
    executors.push(instance);
    return instance;
  };
  beforeEach(() => {
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-cli-dsh-test-')));
    vi.spyOn(os, 'homedir').mockReturnValue(directory);
    transports = []; executors = []; images = false; customize = undefined;
    executor = create();
  });
  afterEach(async () => {
    for (const instance of executors) { await instance.destroy(); await instance.waitForExit(); }
    vi.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('streams answers without thoughts, persists and resumes only its thread', async () => {
    const stream = vi.fn(); const display = vi.fn();
    expect(await executor.execute('hi', { onStream: stream, onDisplayText: display })).toMatchObject({ success: true, output: 'public answer' });
    expect(stream).toHaveBeenCalledTimes(1);
    expect(display).toHaveBeenCalledWith('public answer');
    expect(fs.existsSync(pointer())).toBe(true);
    await executor.destroy(); executor = create();
    await executor.execute('again');
    expect(current().loadSession).toHaveBeenCalledWith('session-0', directory);
    expect(current().newSession).not.toHaveBeenCalled();
    const independent = create({ threadId: 'other' }); await independent.execute('independent');
    expect(current().newSession).toHaveBeenCalled();
    expect(current().loadSession).not.toHaveBeenCalled();
  });

  it('fails before creating a process when the requested working directory is not allowed', () => {
    expect(() => create({ initialWorkingDirectory: '/outside-dsh-test' })).toThrow();
    expect(transports).toHaveLength(0);
  });

  it.each(['abort', 'resetContext', 'destroy'] as const)('stops a DSH transport still initializing on %s', async action => {
    let reject!: (error: Error) => void;
    customize = t => {
      t.initialize.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
      t.destroy.mockImplementation(() => reject(new Error('Stopped during initialization')));
    };
    const result = executor.execute('pending');
    await vi.waitFor(() => expect(reject).toBeTypeOf('function'));
    await executor[action]();
    expect(current().destroy).toHaveBeenCalledTimes(1);
    expect(await result).toMatchObject({ success: false });
    expect(current().newSession).not.toHaveBeenCalled();
    await executor.waitForExit();
    expect(current().waitForExit).toHaveBeenCalled();
  });

  it('does not reopen a destroyed DSH executor through catalog methods', async () => {
    await executor.destroy();
    await expect(executor.listModels()).rejects.toThrow('destroyed');
    expect(transports).toHaveLength(0);
  });

  it('does not replace a saved conversation after a temporary resume failure', async () => {
    await executor.execute('hi'); await executor.destroy();
    const saved = fs.readFileSync(pointer(), 'utf8');
    customize = t => t.loadSession.mockRejectedValue(new Error('Provider unavailable'));
    executor = create();
    expect(await executor.execute('again')).toMatchObject({ success: false });
    expect(current().newSession).not.toHaveBeenCalled();
    expect(fs.readFileSync(pointer(), 'utf8')).toBe(saved);
    expect(current().destroy).toHaveBeenCalled();
    customize = undefined;
    expect(await executor.execute('retry')).toMatchObject({ success: true });
    expect(current().loadSession).toHaveBeenCalled();
  });

  it('starts fresh only when the saved session is genuinely missing', async () => {
    await executor.execute('hi'); await executor.destroy();
    customize = t => t.loadSession.mockRejectedValue(new Error('Session not found'));
    executor = create();
    expect(await executor.execute('again')).toMatchObject({ success: true });
    expect(current().newSession).toHaveBeenCalled();
  });

  it('uses opaque model IDs, native effort values and conservative image metadata', async () => {
    const models = await executor.listModels();
    expect(models[0]).toMatchObject({ id: model, inputModalities: ['text'], supportedReasoningEfforts: ['auto', 'high'] });
    expect(await executor.setModel(otherModel)).toMatchObject({ success: true });
    expect(current().setConfigOption).toHaveBeenCalledWith('session-0', 'model', otherModel);
    expect(await executor.setEffort('auto')).toMatchObject({ success: true });
    expect(current().setConfigOption).toHaveBeenCalledWith('session-0', 'reasoning_effort', '');
    expect(await executor.setEffort('impossible')).toMatchObject({ success: false });
    expect(await executor.setModel('made-up')).toMatchObject({ success: false });
    await executor.destroy(); images = true; executor = create();
    expect((await executor.listModels())[0].inputModalities).toEqual(['text', 'image']);
    expect((await executor.listModels())[1].inputModalities).toEqual(['text']);
  });

  it('applies configured model and effort on startup', async () => {
    executor = create({ model: otherModel, effort: 'auto' });
    await executor.execute('hello');
    expect(current().setConfigOption).toHaveBeenCalledWith('session-0', 'model', otherModel);
    expect(current().setConfigOption).toHaveBeenCalledWith('session-0', 'reasoning_effort', '');
  });

  it('rejects the whole image prompt without silently dropping attachments', async () => {
    expect(await executor.execute('look', { attachments: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }] })).toMatchObject({ success: false, error: expect.stringContaining('No part') });
    expect(current().prompt).not.toHaveBeenCalled();
    await executor.destroy(); images = true; executor = create();
    expect(await executor.execute('look', { attachments: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }] })).toMatchObject({ success: true });
    expect(current().prompt.mock.calls[0][1]).toEqual([{ type: 'text', text: 'look' }, { type: 'image', data: 'AA==', mimeType: 'image/png' }]);
  });

  it('reports only validated context occupancy, not invented billing tokens', async () => {
    expect(executor.getContextUsage()).toBeNull();
    await executor.execute('hi');
    current().events.onUsage?.({ sessionUpdate: 'usage_update', used: 25, size: 100 });
    expect(executor.getContextUsage()).toEqual({ contextTokens: 25, contextWindow: 100, contextPercent: 25 });
    current().events.onUsage?.({ sessionUpdate: 'usage_update', used: -1, size: 0 });
    expect(executor.getContextUsage()?.contextTokens).toBe(25);
    executor.resetContext(); expect(executor.getContextUsage()).toBeNull();
  });

  it('relays permission questions and respects denial', async () => {
    await executor.execute('hi');
    const decision = current().events.onPermissionRequest!('Run shell', [
      { optionId: 'yes', kind: 'allow_once', name: 'Allow' }, { optionId: 'no', kind: 'reject_once', name: 'Deny' },
    ]);
    expect(executor.isWaitingInput()).toBe(true);
    expect(executor.sendInput('no')).toBe(true);
    expect(await decision).toBe(1);
  });

  it('mounts delegation MCP on new and resumed sessions without changing the native command', async () => {
    const connection = { url: 'http://127.0.0.1:1234', token: 'test-only' };
    await executor.configureDelegation(connection); await executor.execute('hi');
    expect(current().newSession.mock.calls[0]).toEqual([directory, [expect.objectContaining({ name: 'remote-cli-delegation', command: process.execPath })]]);
    await executor.destroy(); executor = create();
    await executor.configureDelegation(connection); await executor.execute('again');
    expect(current().loadSession.mock.calls[0]).toEqual(['session-0', directory, [expect.objectContaining({ name: 'remote-cli-delegation' })]]);
  });

  it('durably compacts by summary/reset and seeds exactly one successful turn after restart', async () => {
    await executor.execute('hi');
    expect(await executor.compactWhenFull()).toMatchObject({ success: true, output: expect.stringContaining('native DSH history is retained') });
    expect(fs.existsSync(pointer())).toBe(false);
    expect(fs.statSync(handoff()).mode & 0o777).toBe(0o600);
    expect(await executor.compactWhenFull()).toMatchObject({ success: true });
    await executor.destroy(); executor = create();
    expect(await executor.execute('continue')).toMatchObject({ success: true });
    expect(current().newSession).toHaveBeenCalled();
    expect(JSON.stringify(current().prompt.mock.calls[0][1])).toContain('public answer');
    expect(fs.existsSync(handoff())).toBe(false);
    await executor.execute('next');
    expect(current().prompt.mock.calls[1][1]).toEqual([{ type: 'text', text: 'next' }]);
  });

  it('preserves the compact seed across rejection and failed turns', async () => {
    await executor.compactWhenFull();
    await executor.execute('image', { attachments: [{ type: 'image', data: '', mimeType: 'image/png' }] });
    expect(fs.existsSync(handoff())).toBe(true);
    customize = t => t.prompt.mockResolvedValueOnce({ stopReason: 'cancelled' });
    expect(await executor.execute('retry')).toMatchObject({ success: false });
    expect(fs.existsSync(handoff())).toBe(true);
    customize = undefined;
    await executor.execute('retry again');
    expect(fs.existsSync(handoff())).toBe(false);
  });

  it('preserves original history when summarization fails or returns no answer', async () => {
    await executor.execute('hi');
    current().prompt.mockResolvedValueOnce({ stopReason: 'error' });
    expect(await executor.compactWhenFull()).toMatchObject({ success: false });
    expect(fs.existsSync(pointer())).toBe(true);
    current().prompt.mockResolvedValueOnce({ stopReason: 'end_turn' });
    expect(await executor.compactWhenFull()).toMatchObject({ success: false });
    expect(fs.existsSync(pointer())).toBe(true);
    expect(fs.existsSync(handoff())).toBe(false);
  });

  it('preserves the original conversation when writing a compact handoff fails', async () => {
    await executor.execute('hi');
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(await executor.compactWhenFull()).toMatchObject({ success: false });
    write.mockRestore();
    expect(fs.existsSync(pointer())).toBe(true);
    expect(fs.existsSync(handoff())).toBe(false);
    expect(executor.isBusy()).toBe(false);
  });

  it('rejects concurrent compaction and discards late summaries after cancellation', async () => {
    await executor.execute('hi');
    let finish!: (result: { stopReason: string }) => void;
    current().prompt.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const compact = executor.compactWhenFull();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(executor.isBusy()).toBe(true);
    expect(await executor.execute('later')).toMatchObject({ success: false });
    expect(await executor.compactWhenFull()).toMatchObject({ success: false });
    expect(await executor.abort()).toBe(true);
    expect(current().sendCancel).toHaveBeenCalledWith('session-0');
    current().events.onTextChunk?.({ type: 'text', text: 'late summary' }); finish({ stopReason: 'end_turn' });
    expect(await compact).toMatchObject({ success: false });
    expect(fs.existsSync(handoff())).toBe(false);
    expect(fs.existsSync(pointer())).toBe(true);
  });

  it('finishes an interrupted reset on restart and clears only owned pointers', async () => {
    await executor.execute('hi'); await executor.destroy();
    fs.writeFileSync(handoff(), JSON.stringify({ text: 'saved summary', cwd: directory, sourceSessionId: 'session-0' }));
    const native = path.join(directory, 'native-history'); fs.writeFileSync(native, 'retain');
    executor = create(); expect(fs.existsSync(pointer())).toBe(false);
    await executor.deleteThreadData('thread');
    expect(fs.existsSync(handoff())).toBe(false);
    expect(fs.readFileSync(native, 'utf8')).toBe('retain');
  });

  it('clears compact summaries on explicit clear or working-directory changes', async () => {
    await executor.compactWhenFull(); executor.resetContext();
    expect(fs.existsSync(handoff())).toBe(false);
    await executor.compactWhenFull();
    const other = path.join(directory, 'other'); fs.mkdirSync(other);
    await executor.setWorkingDirectory(other);
    expect(fs.existsSync(handoff())).toBe(false);
    await executor.execute('hi');
    expect(current().prompt.mock.calls[0][1]).toEqual([{ type: 'text', text: 'hi' }]);
    expect(current().newSession).toHaveBeenCalledWith(other);
  });

  it('rejects unsupported interactive commands but permits absolute file paths', async () => {
    expect(await executor.execute('/skills')).toMatchObject({ success: false, error: expect.stringContaining('slash commands') });
    expect(transports).toHaveLength(0);
    expect(await executor.execute('/tmp/example.txt please read this')).toMatchObject({ success: true });
  });
});
