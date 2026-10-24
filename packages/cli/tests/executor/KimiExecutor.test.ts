import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { refreshKimiModelCatalog } from '../../src/executor/kimi/KimiModelCatalog';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { KimiExecutor } from '../../src/executor/KimiExecutor';
import type { AcpEventCallbacks, AcpTransport } from '../../src/executor/acp/AcpClient';
import type { AcpConfigOption, AcpContentBlock, AcpSessionResult } from '../../src/executor/acp/AcpTypes';

const originalHome = process.env.HOME;
const originalHomedir = os.homedir();

const configOptions: AcpConfigOption[] = [
  {
    id: 'model', name: 'Model', type: 'select', currentValue: 'kimi-k2.7',
    options: [{ value: 'kimi-k2.7', name: 'Kimi K2.7' }],
  },
  {
    id: 'thinking', name: 'Thinking', type: 'select', currentValue: 'high',
    options: ['off', 'low', 'medium', 'high'].map((value) => ({ value, name: value })),
  },
];

class FakeKimiTransport implements AcpTransport {
  initialize = vi.fn().mockResolvedValue({ protocolVersion: 1 });
  newSession = vi.fn(async (): Promise<AcpSessionResult> => ({ sessionId: 'session-kimi', configOptions }));
  loadSession = vi.fn(async (): Promise<AcpSessionResult> => ({ configOptions }));
  prompt = vi.fn(async (_sessionId: string, _blocks: AcpContentBlock[]) => ({ stopReason: 'end_turn' }));
  setConfigOption = vi.fn(async (): Promise<AcpSessionResult> => ({ configOptions }));
  deleteSession = vi.fn().mockResolvedValue(undefined);
  sendCancel = vi.fn();
  destroy = vi.fn();
}

describe('KimiExecutor', () => {
  let home: string;
  let project: string;
  let transport: FakeKimiTransport;
  let callbacks: AcpEventCallbacks;
  let executor: KimiExecutor;
  let accountUsageQuery: ReturnType<typeof vi.fn>;
  let modelCatalogQuery: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(originalHomedir, '.kimi-executor-test-'));
    project = path.join(home, 'project');
    await fs.mkdir(project);
    process.env.HOME = home;
    transport = new FakeKimiTransport();
    callbacks = {};
    accountUsageQuery = vi.fn().mockResolvedValue(null);
    modelCatalogQuery = vi.fn().mockResolvedValue([{ id: 'kimi-k2.7', displayName: 'Kimi K2.7',
      supportedReasoningEfforts: ['off', 'low', 'medium', 'high'] }]);
    executor = new KimiExecutor(new DirectoryGuard([home]), {
      initialWorkingDirectory: project,
      threadId: 'thread-kimi',
      sessionBaseDir: path.join(home, '.remote-cli', 'kimi-sessions'),
      clientFactory: (next) => {
        callbacks = next;
        return transport;
      },
      accountUsageQuery,
      modelCatalogQuery,
    });
  });

  afterEach(async () => {
    await executor.destroy();
    await fs.rm(home, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it('runs Kimi turns over ACP and persists the session pointer', async () => {
    transport.prompt.mockImplementationOnce(async () => {
      callbacks.onTextChunk?.({ type: 'text', text: 'Kimi response' });
      return { stopReason: 'end_turn' };
    });
    const result = await executor.execute('hello', {});
    expect(result).toMatchObject({ success: true, output: 'Kimi response' });
    expect(transport.newSession).toHaveBeenCalledWith(project);
    const stored = JSON.parse(await fs.readFile(path.join(home, '.remote-cli', 'kimi-sessions', 'thread-kimi.json'), 'utf8'));
    expect(stored.id).toBe('session-kimi');
    expect(modelCatalogQuery).not.toHaveBeenCalled();
  });

  it('refreshes the native catalog before listing models without starting an inference session', async () => {
    await expect(executor.listModels()).resolves.toEqual([
      expect.objectContaining({ id: 'kimi-k2.7', supportedReasoningEfforts: ['off', 'low', 'medium', 'high'] }),
    ]);
    expect(modelCatalogQuery).toHaveBeenCalledWith('kimi', project);
    expect(transport.initialize).not.toHaveBeenCalled();
    expect(transport.prompt).not.toHaveBeenCalled();
  });

  it('reloads native records before selecting a refreshed alias while retaining the same session', async () => {
    await executor.execute('seed', {});
    modelCatalogQuery.mockResolvedValue([{ id: 'kimi-code/k3.1-pro', displayName: 'K3.1 Pro' }]);
    transport.setConfigOption.mockImplementation(async () => {
      if (!transport.loadSession.mock.calls.length) throw new Error('Native model records are still stale.');
      return { configOptions };
    });
    expect(await executor.listModels()).toMatchObject([{ id: 'kimi-code/k3.1-pro' }]);
    // A delayed snapshot from the existing ACP child cannot undo discovery.
    callbacks.onConfigOptions?.(configOptions);
    expect(await executor.setModel('kimi-code/k3.1-pro')).toMatchObject({ success: true });
    expect(transport.setConfigOption).toHaveBeenCalledWith('session-kimi', 'model', 'kimi-code/k3.1-pro');
    expect(transport.newSession).toHaveBeenCalledOnce();
    expect(transport.loadSession).toHaveBeenCalledWith('session-kimi', project);
    expect(transport.destroy).toHaveBeenCalledOnce();
    expect(executor.getSessionId()).toBe('session-kimi');
    expect(transport.prompt).toHaveBeenCalledOnce();
  });

  it.each(['reset', 'directory', 'destroy'])('does not resume an obsolete session when %s races native catalog reload', async change => {
    await executor.execute('seed', {});
    await executor.listModels();
    let confirmExit!: () => void;
    const exit = new Promise<void>(resolve => { confirmExit = resolve; });
    (transport as any).waitForExit = vi.fn(() => exit);
    const changing = executor.setModel('kimi-k2.7');
    await vi.waitFor(() => expect(transport.destroy).toHaveBeenCalledOnce());
    if (change === 'reset') executor.resetContext();
    else if (change === 'destroy') await executor.destroy();
    else {
      const other = path.join(home, 'other-project');
      await fs.mkdir(other);
      await executor.setWorkingDirectory(other);
    }
    confirmExit();
    expect(await changing).toMatchObject({ success: false });
    expect(transport.setConfigOption).not.toHaveBeenCalled();
    expect(transport.loadSession).not.toHaveBeenCalled();
  });

  it('retains the conversation binding when refreshed-session resume fails', async () => {
    await executor.execute('seed', {});
    await executor.listModels();
    transport.loadSession.mockRejectedValueOnce(new Error('Transient resume failure'));
    expect(await executor.setModel('kimi-k2.7')).toMatchObject({ success: false });
    expect(executor.getSessionId()).toBe('session-kimi');
    expect(transport.newSession).toHaveBeenCalledOnce();
    expect(transport.setConfigOption).not.toHaveBeenCalled();
    expect(executor.isProcessRunning()).toBe(false);
    const stored = JSON.parse(await fs.readFile(path.join(home, '.remote-cli', 'kimi-sessions', 'thread-kimi.json'), 'utf8'));
    expect(stored.id).toBe('session-kimi');
  });

  it('selects a replacement without replaying a previous model removed from the catalog', async () => {
    expect(await executor.setModel('kimi-k2.7')).toMatchObject({ success: true });
    modelCatalogQuery.mockResolvedValue([{ id: 'kimi-code/k3.1-pro', displayName: 'K3.1 Pro' }]);
    await executor.listModels();
    transport.setConfigOption.mockClear();
    transport.setConfigOption.mockImplementation(async (_session, _kind, value) => {
      if (value === 'kimi-k2.7') throw new Error('The old alias was removed.');
      return { configOptions };
    });
    expect(await executor.setModel('kimi-code/k3.1-pro')).toMatchObject({ success: true });
    expect(transport.setConfigOption.mock.calls).toEqual([['session-kimi', 'model', 'kimi-code/k3.1-pro']]);
    expect(executor.getSessionId()).toBe('session-kimi');
  });

  it.each(['reset', 'directory', 'destroy'])('retires initialization and rejects selection after %s', async change => {
    await executor.execute('seed', {});
    await executor.listModels();
    let initialize!: (value: unknown) => void;
    transport.initialize.mockImplementationOnce(() => new Promise(resolve => { initialize = resolve; }));
    const changing = executor.setModel('kimi-k2.7');
    await vi.waitFor(() => expect(transport.initialize).toHaveBeenCalledTimes(2));
    if (change === 'reset') executor.resetContext();
    else if (change === 'destroy') await executor.destroy();
    else {
      const other = path.join(home, 'other-project');
      await fs.mkdir(other);
      await executor.setWorkingDirectory(other);
    }
    initialize({ protocolVersion: 1 });
    expect(await changing).toMatchObject({ success: false });
    expect(transport.destroy).toHaveBeenCalledTimes(2);
    expect(transport.setConfigOption).not.toHaveBeenCalled();
    expect(transport.loadSession).not.toHaveBeenCalled();
    expect(executor.isProcessRunning()).toBe(false);
  });

  it('coalesces concurrent lists but refreshes again for every later explicit query', async () => {
    let finish!: (value: any[]) => void;
    modelCatalogQuery.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = executor.listModels(), second = executor.listModels();
    await Promise.resolve();
    expect(modelCatalogQuery).toHaveBeenCalledOnce();
    finish([{ id: 'new', displayName: 'New' }]);
    expect(await first).toEqual(await second);
    await executor.listModels();
    expect(modelCatalogQuery).toHaveBeenCalledTimes(2);
  });

  it('uses aliases discovered by a separate settings preview when applying to a stale live thread', async () => {
    const command = 'synthetic-cross-executor-kimi';
    const live = new KimiExecutor(new DirectoryGuard([home]), { kimiCommand: command,
      initialWorkingDirectory: project, threadId: 'live', sessionBaseDir: path.join(home, 'live-sessions'),
      clientFactory: () => transport });
    try {
      await live.execute('seed', {});
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 123;
      child.kill = vi.fn(() => { queueMicrotask(() => child.emit('close', 0)); return true; });
      const refresh = refreshKimiModelCatalog(command, project, {
        spawnProcess: vi.fn(() => child) as any,
        fetchImpl: vi.fn(async (url: string) => new Response(JSON.stringify({ code: 0,
          data: url.endsWith('refresh_oauth') ? { changed: [], unchanged: ['managed:kimi-code'], failed: [] }
            : { items: [{ model: 'kimi-code/k3.1-pro' }] } }))) as any,
      });
      child.stdout.emit('data', Buffer.from('Local: http://127.0.0.1:41234/#token=synthetic-token\n'));
      await refresh;
      expect(await live.setModel('kimi-code/k3.1-pro')).toMatchObject({ success: true });
      expect(transport.setConfigOption).toHaveBeenCalledWith('session-kimi', 'model', 'kimi-code/k3.1-pro');
      expect(transport.newSession).toHaveBeenCalledOnce();
      expect(transport.destroy).toHaveBeenCalledOnce();
      expect(transport.loadSession).toHaveBeenCalledWith('session-kimi', project);
    } finally { await live.destroy(); }
  });

  it('reports a failed refresh and retries rather than returning the old ACP catalog', async () => {
    await executor.execute('seed', {});
    modelCatalogQuery.mockRejectedValueOnce(new Error('Synthetic refresh failure'));
    await expect(executor.listModels()).rejects.toThrow('Synthetic refresh failure');
    await expect(executor.listModels()).resolves.toHaveLength(1);
    expect(modelCatalogQuery).toHaveBeenCalledTimes(2);
  });

  it('refuses discovery while a turn is active without cancelling the turn', async () => {
    let finish!: (result: { stopReason: string }) => void;
    transport.prompt.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const turn = executor.execute('work', {});
    await vi.waitFor(() => expect(transport.prompt).toHaveBeenCalled());
    await expect(executor.listModels()).rejects.toThrow('busy');
    expect(modelCatalogQuery).not.toHaveBeenCalled();
    expect(transport.destroy).not.toHaveBeenCalled();
    finish({ stopReason: 'end_turn' });
    await turn;
  });

  it.each(['reset', 'directory', 'destroy', 'abort', 'turn'])('fences a delayed catalog after %s without killing active work', async change => {
    let finish!: (value: any[]) => void;
    modelCatalogQuery.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const listing = executor.listModels();
    const rejected = expect(listing).rejects.toThrow(/changed|busy|cancelled/);
    await Promise.resolve();
    let turn: Promise<unknown> | undefined;
    let finishTurn!: (result: { stopReason: string }) => void;
    if (change === 'reset') executor.resetContext();
    if (change === 'directory') await executor.setWorkingDirectory(home);
    if (change === 'destroy') await executor.destroy();
    if (change === 'abort') await executor.abort();
    if (change === 'turn') {
      transport.prompt.mockImplementationOnce(() => new Promise(resolve => { finishTurn = resolve; }));
      turn = executor.execute('work', {});
      await vi.waitFor(() => expect(transport.prompt).toHaveBeenCalled());
    }
    finish([{ id: 'late', displayName: 'Late' }]);
    await rejected;
    if (change === 'turn') {
      expect(transport.destroy).not.toHaveBeenCalled();
      finishTurn({ stopReason: 'end_turn' });
      await turn;
    }
  });

  it('maps effort to the Kimi thinking config option', async () => {
    await executor.listModels();
    await expect(executor.setEffort('high')).resolves.toMatchObject({ success: true });
    expect(transport.setConfigOption).toHaveBeenCalledWith('session-kimi', 'thinking', 'high');
  });

  it('maps auto effort to Kimi automatic thinking selection', async () => {
    await executor.listModels();
    await expect(executor.setEffort('auto')).resolves.toMatchObject({ success: true });
    expect(transport.setConfigOption).toHaveBeenCalledWith('session-kimi', 'thinking', 'on');
  });

  it('queries Kimi account usage independently from the ACP conversation', async () => {
    accountUsageQuery.mockResolvedValue('- Monthly quota: 64% remaining');

    await expect(executor.getAccountUsage()).resolves.toBe('- Monthly quota: 64% remaining');
    expect(accountUsageQuery).toHaveBeenCalledWith('kimi', project);
    expect(transport.prompt).not.toHaveBeenCalled();
  });

  it('returns Kimi login guidance when ACP requires authentication', async () => {
    transport.newSession.mockRejectedValueOnce(new Error('ACP error -32000: Authentication required'));
    await expect(executor.execute('hello', {})).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('kimi login'),
    });
  });
});
