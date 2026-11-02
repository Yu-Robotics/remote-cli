import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { KimiExecutor } from '../../src/executor/KimiExecutor';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import type { AcpTransport } from '../../src/executor/acp/AcpClient';
import type { AcpConfigOption, AcpSessionResult } from '../../src/executor/acp/AcpTypes';
import { kimiModeOption } from './kimiAcpFixture';

class NativeKimiFixture implements AcpTransport {
  options: AcpConfigOption[] = [kimiModeOption('plan'),
    { id: 'model', name: 'Model', type: 'select', currentValue: 'model-a',
      options: ['model-a', 'model-b'].map(value => ({ value, name: value })) },
    { id: 'thinking', name: 'Thinking', type: 'select', currentValue: 'low',
      options: ['low', 'high', 'on'].map(value => ({ value, name: value })) }];
  initialize = vi.fn(async () => ({}));
  newSession = vi.fn(async (): Promise<AcpSessionResult> => ({ sessionId: 'native-session', configOptions: this.options }));
  loadSession = vi.fn(async (): Promise<AcpSessionResult> => ({ configOptions: this.options }));
  setConfigOption = vi.fn(async (_session: string, id: string, value: string): Promise<AcpSessionResult> => {
    this.options = this.options.map(option => option.id === id ? { ...option, currentValue: value } : option);
    return { configOptions: this.options };
  });
  prompt = vi.fn(async () => ({ stopReason: 'end_turn' }));
  deleteSession = vi.fn(async () => {});
  sendCancel = vi.fn();
  destroy = vi.fn();
  waitForExit = vi.fn(async () => {});
}

describe('Kimi native approval policy', () => {
  let directory: string;
  let executor: KimiExecutor;
  let first: NativeKimiFixture;
  let replacement: NativeKimiFixture;
  let factory: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'kimi-native-policy-')));
    vi.spyOn(os, 'homedir').mockReturnValue(directory);
    first = new NativeKimiFixture();
    replacement = new NativeKimiFixture();
    factory = vi.fn().mockReturnValueOnce(first).mockReturnValue(replacement);
  });

  afterEach(async () => {
    await executor?.destroy();
    await executor?.waitForExit();
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  function create(options: { autoApprove?: boolean; model?: string; effort?: string } = {}): void {
    executor = new KimiExecutor(new DirectoryGuard([directory]), { ...options,
      initialWorkingDirectory: directory, threadId: 'synthetic', sessionBaseDir: directory,
      clientFactory: factory,
      modelCatalogQuery: async () => [{ id: 'model-b', displayName: 'Model B' }],
    });
  }

  async function persist(): Promise<void> {
    await fs.writeFile(path.join(directory, 'synthetic.json'), JSON.stringify({ id: 'existing', cwd: directory }));
  }

  it('confirms Never Ask after model and thinking configuration before the first prompt', async () => {
    create({ model: 'model-b', effort: 'high' });
    expect(await executor.execute('synthetic task')).toMatchObject({ success: true });
    expect(first.setConfigOption.mock.calls).toEqual([
      ['native-session', 'model', 'model-b'], ['native-session', 'thinking', 'high'], ['native-session', 'mode', 'auto'],
    ]);
    expect(first.setConfigOption.mock.invocationCallOrder.at(-1)).toBeLessThan(first.prompt.mock.invocationCallOrder[0]);
    expect(first.options.find(option => option.id === 'mode')?.currentValue).toBe('auto');
  });

  it.each([true, false])('overrides a resumed native mode with autoApprove=%s', async autoApprove => {
    await persist();
    first.options[0] = kimiModeOption(autoApprove ? 'plan' : 'auto');
    create({ autoApprove });
    expect(await executor.execute('continue')).toMatchObject({ success: true });
    expect(first.loadSession).toHaveBeenCalledWith('existing', directory);
    expect(first.newSession).not.toHaveBeenCalled();
    expect(first.setConfigOption).toHaveBeenCalledWith('existing', 'mode', autoApprove ? 'auto' : 'default');
  });

  it('restores manual mode for a fresh session without choosing an answer', async () => {
    create({ autoApprove: false });
    await executor.execute('synthetic task');
    expect(first.setConfigOption.mock.calls).toEqual([['native-session', 'mode', 'default']]);
  });

  it('refuses automatic mode as a substitute when native manual approval is unavailable', async () => {
    first.options[0] = { ...kimiModeOption('auto'), options: [{ value: 'auto', name: 'Auto' }] };
    create({ autoApprove: false });
    expect(await executor.execute('synthetic task')).toMatchObject({ success: false, error: expect.stringContaining('manual approval') });
    expect(first.setConfigOption).not.toHaveBeenCalled();
    expect(first.prompt).not.toHaveBeenCalled();
  });

  it.each(['missing', 'unsupported', 'wrong-type', 'rejected', 'mismatch', 'unconfirmed'])
    ('sends no prompt when native Never Ask is %s', async failure => {
      if (failure === 'missing') first.options = first.options.filter(option => option.id !== 'mode');
      if (failure === 'unsupported') first.options[0] = { ...kimiModeOption(), options: [{ value: 'default', name: 'Default' }] };
      if (failure === 'wrong-type') first.options[0] = { ...kimiModeOption(), type: 'future-mode-type' };
      if (failure === 'rejected') first.setConfigOption.mockRejectedValueOnce(new Error('synthetic rejection'));
      if (failure === 'mismatch') first.setConfigOption.mockResolvedValueOnce({ configOptions: [kimiModeOption('yolo')] });
      if (failure === 'unconfirmed') first.setConfigOption.mockResolvedValueOnce({});
      create();
      expect(await executor.execute('synthetic task')).toMatchObject({ success: false, error: expect.stringContaining('could not confirm native Never Ask') });
      expect(first.prompt).not.toHaveBeenCalled();
      expect(first.destroy).toHaveBeenCalledOnce();
      expect(executor.isProcessRunning()).toBe(false);
    });

  it('rejects a resumed client that omits approval capabilities instead of using the old advertisement', async () => {
    create();
    await executor.execute('first');
    await executor.configureDelegation({ url: 'http://127.0.0.1:9999/', token: 'synthetic-token' });
    replacement.loadSession.mockResolvedValueOnce({});
    expect(await executor.execute('second')).toMatchObject({ success: false, error: expect.stringContaining('Never Ask') });
    expect(replacement.setConfigOption).not.toHaveBeenCalled();
    expect(replacement.prompt).not.toHaveBeenCalled();
    expect(executor.getSessionId()).toBe('native-session');
  });

  it('retries failed metadata initialization with a new transport and the same durable session', async () => {
    create({ model: 'model-b' });
    first.setConfigOption.mockImplementationOnce(async () => ({ configOptions: first.options }));
    first.setConfigOption.mockRejectedValueOnce(new Error('synthetic mode rejection'));
    await expect(executor.listEfforts()).rejects.toThrow('Never Ask');
    expect(executor.isProcessRunning()).toBe(false);
    expect(first.destroy).toHaveBeenCalledOnce();
    await expect(executor.listEfforts()).resolves.toMatchObject({ choices: expect.any(Array) });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(replacement.loadSession).toHaveBeenCalledWith('native-session', directory);
    expect(replacement.newSession).not.toHaveBeenCalled();
    expect(replacement.setConfigOption.mock.calls).toEqual([
      ['native-session', 'model', 'model-b'], ['native-session', 'mode', 'auto'],
    ]);
    expect(first.prompt).not.toHaveBeenCalled();
  });

  it('reasserts native policy after idle model and effort changes', async () => {
    create();
    await executor.execute('seed');
    first.setConfigOption.mockClear();
    expect(await executor.setModel('model-b')).toMatchObject({ success: true });
    expect(await executor.setEffort('high')).toMatchObject({ success: true });
    expect(first.setConfigOption.mock.calls).toEqual([
      ['native-session', 'model', 'model-b'], ['native-session', 'mode', 'auto'],
      ['native-session', 'thinking', 'high'], ['native-session', 'mode', 'auto'],
    ]);
  });

  it('retires a cached client when a later settings change cannot restore Never Ask', async () => {
    create();
    await executor.execute('seed');
    first.setConfigOption.mockImplementationOnce(async () => ({ configOptions: first.options }));
    first.setConfigOption.mockResolvedValueOnce({ configOptions: [kimiModeOption('plan')] });
    expect(await executor.setEffort('high')).toMatchObject({ success: false, error: expect.stringContaining('Never Ask') });
    expect(executor.isProcessRunning()).toBe(false);
    expect(first.destroy).toHaveBeenCalledOnce();
    expect(await executor.execute('retry')).toMatchObject({ success: true });
    expect(replacement.setConfigOption).toHaveBeenCalledWith('native-session', 'mode', 'auto');
    expect(first.prompt).toHaveBeenCalledOnce();
  });

  it.each(['initialize', 'newSession', 'loadSession'] as const)('cancels pending %s before any policy or prompt can run', async stage => {
    if (stage === 'loadSession') await persist();
    let finish!: (result: AcpSessionResult) => void;
    const pending = new Promise<AcpSessionResult>(resolve => { finish = resolve; });
    first[stage].mockImplementationOnce(() => pending);
    create();
    const running = executor.execute('synthetic task');
    await vi.waitFor(() => expect(first[stage]).toHaveBeenCalled());
    expect(await executor.abort()).toBe(true);
    expect(first.destroy).toHaveBeenCalledOnce();
    finish({ sessionId: 'late-session', configOptions: first.options });
    expect(await running).toMatchObject({ success: false, error: expect.stringContaining('cancelled') });
    expect(first.setConfigOption).not.toHaveBeenCalled();
    expect(first.prompt).not.toHaveBeenCalled();
    expect(executor.getSessionId()).toBe(stage === 'loadSession' ? 'existing' : null);
  });

  it('reasserts native policy after refreshed model selection recreates the process', async () => {
    create();
    await executor.execute('seed');
    await executor.listModels();
    expect(await executor.setModel('model-b')).toMatchObject({ success: true });
    expect(replacement.loadSession).toHaveBeenCalledWith('native-session', directory);
    expect(replacement.setConfigOption.mock.calls).toEqual([
      ['native-session', 'model', 'model-b'], ['native-session', 'mode', 'auto'],
    ]);
    expect(replacement.prompt).not.toHaveBeenCalled();
  });

  it.each(['abort', 'reset', 'destroy'])('retires pending mode negotiation after %s without prompting or caching it', async action => {
    let finish!: (result: AcpSessionResult) => void;
    first.setConfigOption.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    create();
    const running = executor.execute('synthetic task');
    await vi.waitFor(() => expect(first.setConfigOption).toHaveBeenCalled());
    if (action === 'abort') expect(await executor.abort()).toBe(true);
    else if (action === 'reset') executor.resetContext();
    else await executor.destroy();
    expect(first.destroy).toHaveBeenCalledOnce();
    finish({ configOptions: [kimiModeOption('auto')] });
    expect(await running).toMatchObject({ success: false, error: expect.stringContaining('cancelled') });
    expect(first.prompt).not.toHaveBeenCalled();
    expect(executor.isProcessRunning()).toBe(false);
    if (action === 'abort') {
      expect(await executor.execute('retry')).toMatchObject({ success: true });
      expect(replacement.loadSession).toHaveBeenCalledWith('native-session', directory);
    }
  });
});
