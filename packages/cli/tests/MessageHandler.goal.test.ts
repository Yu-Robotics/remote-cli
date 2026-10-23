import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { MessageHandler } from '../src/client/MessageHandler';
import { DirectoryGuard } from '../src/security/DirectoryGuard';
import type { ExecuteOptions, ExecuteResult, ExecutorGoalRunRequest } from '../src/executor/IExecutor';
import type { Thread } from '../src/thread/types';

async function fixture() {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'goal-handler-')));
  const threads: Thread[] = ['thread-a', 'thread-b'].map(id => ({ id, name: id, workingDirectory: cwd,
    sessionId: null, createdAt: 0, lastActiveAt: 0, delegation: false }));
  let backend = 'codex';
  const busy = new Set<string>();
  const makeExecutor = (id: string) => ({
    execute: vi.fn(async (_prompt: string, options: ExecuteOptions) => {
      options.onStream?.('Ordinary reply'); return { success: true, output: 'Ordinary reply' };
    }),
    getCurrentWorkingDirectory: vi.fn(() => cwd), setWorkingDirectory: vi.fn(async () => {}),
    resetContext: vi.fn(), abort: vi.fn(async () => true), destroy: vi.fn(async () => {}),
    isGoalRunning: vi.fn(() => false),
    isWaitingInput: vi.fn(() => false), sendInput: vi.fn(() => true), setModel: vi.fn(),
    getGoal: vi.fn(async () => id === 'thread-a' ? { threadId: 'native-a', objective: 'Fix the tests', status: 'active' as const,
      tokenBudget: 40000, tokensUsed: 123, timeUsedSeconds: 9, createdAt: 0, updatedAt: 1 } : null),
    executeGoal: vi.fn(async (_request: ExecutorGoalRunRequest, options: ExecuteOptions): Promise<ExecuteResult> => {
      options.onStream?.('Goal complete'); return { success: true, output: 'Goal complete' };
    }),
    pauseGoal: vi.fn(async () => ({ success: true, output: 'Goal paused' })),
    clearGoal: vi.fn(async () => ({ success: true, output: 'Goal cleared' })),
  });
  const executors = new Map(threads.map(thread => [thread.id, makeExecutor(thread.id)]));
  const pool = {
    getExecutor: vi.fn((id: string) => executors.get(id)), getBackendKey: vi.fn(() => backend),
    getSummaries: vi.fn(() => threads.map(thread => ({ id: thread.id, name: thread.name,
      status: busy.has(thread.id) ? 'running' : 'idle' }))),
    isThreadBusy: vi.fn((id: string) => busy.has(id)),
    setThreadBusy: vi.fn((id: string, value: boolean) => { value ? busy.add(id) : busy.delete(id); }),
    setThreadError: vi.fn(), destroyAll: vi.fn(async () => {}),
  };
  const manager = {
    getDefaultThread: vi.fn(() => threads[0]), getThread: vi.fn((id: string) => threads.find(thread => thread.id === id)),
    listThreads: vi.fn(() => threads), updateThread: vi.fn(async (id: string, fields: Partial<Thread>) => {
      const thread = threads.find(thread => thread.id === id)!; Object.assign(thread, fields); return thread;
    }),
  };
  const ws = { send: vi.fn(), trackTask: vi.fn(), hasPendingTaskResults: vi.fn(() => false),
    isConnected: vi.fn(() => true), onClose: vi.fn() };
  const config = { get: vi.fn((key: string) => key === 'executor' ? { type: backend } : undefined),
    getConfigDir: vi.fn(() => path.join(cwd, 'config')), getAll: vi.fn(() => ({ executor: { type: backend } })) };
  const handler = new MessageHandler(ws as any, pool as any, manager as any, new DirectoryGuard([cwd]), config as any);
  let sequence = 0;
  const send = (content: string, threadId = 'thread-a', extra: Record<string, unknown> = {}) => handler.handleMessage({
    type: 'command', messageId: `goal-command-${++sequence}`, openId: 'owner', threadId, content,
    isSlashCommand: true, timestamp: Date.now(), ...extra,
  } as any);
  const responses = () => ws.send.mock.calls.map(([message]) => message).filter(message => message.type === 'response');
  return { cwd, threads, busy, executors, executor: executors.get('thread-a')!, handler, pool, manager, ws, send, responses,
    setBackend: (value: string) => { backend = value; } };
}

describe('MessageHandler native goal commands', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    f = await fixture();
  });
  afterEach(async () => { await f.handler.destroy(); await rm(f.cwd, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('reads only the addressed thread goal without starting model work', async () => {
    await f.send('/goal');
    expect(f.responses().at(-1)).toMatchObject({ success: true, threadId: 'thread-a', output: expect.stringContaining('Tokens used: 123 / 40000') });
    await f.send('/goal', 'thread-b');
    expect(f.responses().at(-1).output).toContain('No Codex goal');
    expect(f.executor.getGoal).toHaveBeenCalledTimes(1);
    expect(f.executors.get('thread-b')!.getGoal).toHaveBeenCalledTimes(1);
    expect(f.executor.execute).not.toHaveBeenCalled();
    expect(f.executor.executeGoal).not.toHaveBeenCalled();
  });

  it.each(['claude', 'agy', 'pi'])('never forwards goal commands to the %s backend', async backend => {
    f.setBackend(backend);
    await f.send('/goal Fix the tests');
    expect(f.responses().at(-1)).toMatchObject({ success: false, error: expect.stringContaining('requires the Codex') });
    expect(f.executor.execute).not.toHaveBeenCalled();
    expect(f.executor.executeGoal).not.toHaveBeenCalled();
    expect(f.executor.getGoal).not.toHaveBeenCalled();
  });

  it('validates input and missing adapter support before any native mutation', async () => {
    await f.send('/goal --budget 0 Fix');
    expect(f.responses().at(-1).success).toBe(false);
    await f.send('/goal help');
    expect(f.responses().at(-1)).toMatchObject({ success: true, output: expect.stringContaining('/goal resume') });
    (f.executor as any).executeGoal = undefined;
    await f.send('/goal Fix');
    expect(f.responses().at(-1).success).toBe(false);
    expect(f.executor.execute).not.toHaveBeenCalled();
  });

  it('runs native goals and resumes through the existing output and operation lifecycle', async () => {
    await f.send('/goal --budget 40000 Fix the tests');
    expect(f.executor.executeGoal).toHaveBeenCalledWith({ objective: 'Fix the tests', tokenBudget: 40000 },
      expect.objectContaining({ onStream: expect.any(Function), onToolUse: expect.any(Function), onApprovalRequest: expect.any(Function) }));
    expect(f.ws.send.mock.calls.some(([message]) => message.type === 'stream' && message.chunk === 'Goal complete')).toBe(true);
    expect(f.responses().at(-1).success).toBe(true);
    expect(f.busy.has('thread-a')).toBe(false);
    await f.send('/goal resume');
    expect(f.executor.executeGoal.mock.calls.at(-1)![0]).toEqual({});
    expect(f.executor.execute).not.toHaveBeenCalled();
  });

  it('requires explicit delegation opt-out and an empty queue for activation', async () => {
    delete f.threads[0].delegation;
    await f.send('/goal Fix');
    expect(f.responses().at(-1).error).toContain('/delegation off');
    f.threads[0].delegation = false;
    (f.handler as any).pausedQueues.add('thread-a');
    (f.handler as any).threadQueues.set('thread-a', [{ messageId: 'queued', threadId: 'thread-a', content: 'Queued work' }]);
    await f.send('/goal resume');
    expect(f.responses().at(-1).error).toContain('queue');
    expect(f.executor.executeGoal).not.toHaveBeenCalled();
    (f.handler as any).threadQueues.clear();
    (f.handler as any).pausedQueues.clear();
  });

  it('retains image delivery and reply-wide deduplication across native goal turns', async () => {
    const bytes = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082', 'hex');
    const first = { type: 'image' as const, data: bytes.toString('base64'), mimeType: 'image/png' };
    const second = { ...first, data: Buffer.concat([bytes, Buffer.from('second')]).toString('base64') };
    f.executor.executeGoal.mockImplementation(async (_request, options) => {
      options.onStream?.('First automatic turn');
      options.onImage?.(first);
      await Promise.resolve();
      options.onStream?.('Second automatic turn');
      options.onImage?.(first);
      options.onImage?.(second);
      return { success: true, output: 'Done' };
    });
    await f.send('/goal Draw both charts');
    const messages = f.ws.send.mock.calls.map(([message]) => message);
    expect(messages.filter(message => message.streamType === 'image').map(message => message.image)).toEqual([first, second]);
    expect(f.responses().at(-1).success).toBe(true);
    expect(f.busy.has('thread-a')).toBe(false);
  });

  it('displays a native stop result even when no assistant text was streamed', async () => {
    f.executor.executeGoal.mockResolvedValue({ success: true, output: 'Goal paused before any model output' });
    await f.send('/goal Fix');
    expect(f.ws.send.mock.calls.some(([message]) => message.type === 'stream'
      && message.chunk === 'Goal paused before any model output')).toBe(true);
  });

  it('keeps goal controls available during work and human approval while excluding settings writes', async () => {
    let finish!: (result: ExecuteResult) => void;
    f.executor.executeGoal.mockImplementation(async () => new Promise(resolve => { finish = resolve; }));
    const running = f.send('/goal Fix the tests');
    await vi.waitFor(() => expect(f.executor.executeGoal).toHaveBeenCalledTimes(1));
    expect(f.busy.has('thread-a')).toBe(true);
    f.executor.isWaitingInput.mockReturnValue(true);
    await f.send('/goal');
    expect(f.responses().at(-1).success).toBe(true);
    await f.send('/goal resume');
    expect(f.responses().at(-1).success).toBe(false);
    await f.send('/model other');
    expect(f.responses().at(-1).success).toBe(false);
    await f.send('/backend 2', 'thread-b');
    expect(f.responses().at(-1).success).toBe(false);
    expect(f.executor.setModel).not.toHaveBeenCalled();
    f.executor.pauseGoal.mockImplementation(async () => { finish({ success: true, output: 'Paused' }); return { success: true, output: 'Goal paused' }; });
    await f.send('/goal pause');
    await running;
    expect(f.executor.pauseGoal).toHaveBeenCalledTimes(1);
    expect(f.executor.sendInput).not.toHaveBeenCalled();
    expect(f.busy.has('thread-a')).toBe(false);
  });

  it('clears goals during a busy thread without changing native session context', async () => {
    f.busy.add('thread-a');
    f.executor.isWaitingInput.mockReturnValue(true);
    await f.send('/goal clear');
    expect(f.executor.clearGoal).toHaveBeenCalledTimes(1);
    expect(f.responses().at(-1)).toMatchObject({ success: true, output: 'Goal cleared' });
    expect(f.executor.resetContext).not.toHaveBeenCalled();
    expect(f.executor.sendInput).not.toHaveBeenCalled();
  });

  it('leaves other threads available while a goal owns one thread', async () => {
    let finish!: (result: ExecuteResult) => void;
    f.executor.executeGoal.mockImplementation(async () => new Promise(resolve => { finish = resolve; }));
    const running = f.send('/goal Fix the tests');
    await vi.waitFor(() => expect(f.executor.executeGoal).toHaveBeenCalledTimes(1));
    await f.send('Explain another project', 'thread-b', { isSlashCommand: false });
    expect(f.executors.get('thread-b')!.execute).toHaveBeenCalledTimes(1);
    expect(f.responses().at(-1)).toMatchObject({ success: true, threadId: 'thread-b' });
    expect(f.busy.has('thread-a')).toBe(true);
    finish({ success: true });
    await running;
  });

  it('does not replay durable activation after model errors', async () => {
    f.executor.executeGoal.mockResolvedValue({ success: false, error: 'Prompt too long: unsupported model' });
    await f.send('/goal Fix');
    expect(f.executor.executeGoal).toHaveBeenCalledTimes(1);
    expect(f.executor.execute).not.toHaveBeenCalled();
    expect(f.responses().at(-1).success).toBe(false);
    expect(f.busy.has('thread-a')).toBe(false);
  });

  it('rejects attachments explicitly and contains native control failures', async () => {
    await f.send('/goal Fix', 'thread-a', { fileIds: ['file-fixture'] });
    expect(f.responses().at(-1).error).toContain('No goal was changed');
    expect(f.executor.executeGoal).not.toHaveBeenCalled();
    f.executor.getGoal.mockRejectedValue(new Error('Native goals are unavailable'));
    await f.send('/goal');
    expect(f.responses().at(-1)).toMatchObject({ success: false, error: expect.stringContaining('Native goals are unavailable') });
  });

  it('preserves ordinary backend execution when no goal command is used', async () => {
    await f.send('Explain this code', 'thread-a', { isSlashCommand: false });
    expect(f.executor.execute).toHaveBeenCalledTimes(1);
    expect(f.executor.executeGoal).not.toHaveBeenCalled();
    expect(f.executor.getGoal).not.toHaveBeenCalled();
    expect(f.responses().at(-1).success).toBe(true);
  });

  it.each(['pause', 'clear', 'abort'])('cancels goal preparation before acknowledging %s', async control => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const preparing = new Promise<void>(resolve => { entered = resolve; });
    f.manager.updateThread.mockImplementationOnce(async (id, fields) => {
      entered(); await gate;
      const thread = f.threads.find(thread => thread.id === id)!;
      Object.assign(thread, fields); return thread;
    });
    const starting = f.send('/goal Fix the tests');
    await preparing;
    const stopping = f.send(control === 'abort' ? '/abort' : `/goal ${control}`);
    if (control !== 'abort') {
      await stopping;
      expect(f.responses().at(-1).success).toBe(true);
    }
    release(); await Promise.all([starting, stopping]);
    expect(f.executor.executeGoal).not.toHaveBeenCalled();
    expect(f.executor.execute).not.toHaveBeenCalled();
    expect(f.responses().some(response => response.error?.includes('activation was cancelled'))).toBe(true);
    expect(f.busy.size).toBe(0);
  });

  it('reports an unconfirmed goal abort without blocking retries or releasing the running task', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.executor.executeGoal.mockImplementationOnce(async () => { await gate; return { success: true }; });
    const running = f.send('/goal Fix the tests');
    await vi.waitFor(() => expect(f.executor.executeGoal).toHaveBeenCalledTimes(1));
    f.executor.isGoalRunning.mockReturnValue(true);
    f.executor.abort.mockResolvedValue(false);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        await f.send('/abort');
        expect(f.responses().at(-1)).toMatchObject({ success: false, error: expect.stringContaining('stop could not be confirmed') });
        expect(f.busy.has('thread-a')).toBe(true);
      }
      expect(f.executor.abort).toHaveBeenCalledTimes(2);
    } finally { release(); await running; }
  });

  it('reports the same unconfirmed stop for overlapping goal abort requests', async () => {
    let finishGoal!: () => void;
    let finishAbort!: (value: boolean) => void;
    const goal = new Promise<void>(resolve => { finishGoal = resolve; });
    const abort = new Promise<boolean>(resolve => { finishAbort = resolve; });
    f.executor.executeGoal.mockImplementationOnce(async () => { await goal; return { success: true }; });
    const running = f.send('/goal Fix the tests');
    await vi.waitFor(() => expect(f.executor.executeGoal).toHaveBeenCalledTimes(1));
    f.executor.isGoalRunning.mockReturnValue(true);
    f.executor.abort.mockImplementationOnce(() => abort);
    try {
      const first = f.send('/abort');
      await vi.waitFor(() => expect(f.executor.abort).toHaveBeenCalledTimes(1));
      const second = f.send('/abort');
      await new Promise(resolve => setImmediate(resolve));
      finishAbort(false);
      await Promise.all([first, second]);
      expect(f.executor.abort).toHaveBeenCalledTimes(1);
      expect(f.responses().slice(-2)).toEqual([
        expect.objectContaining({ success: false, error: expect.stringContaining('stop could not be confirmed') }),
        expect.objectContaining({ success: false, error: expect.stringContaining('stop could not be confirmed') }),
      ]);
      expect(f.busy.has('thread-a')).toBe(true);
    } finally { finishAbort(false); finishGoal(); await running; }
  });
});
