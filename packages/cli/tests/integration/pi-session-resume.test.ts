import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../src/client/WebSocketClient');
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  const homedir = () => process.env.HOME || actual.homedir();
  return { ...actual, homedir, default: { ...actual, homedir } };
});

import { MessageHandler } from '../../src/client/MessageHandler';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { PiExecutor } from '../../src/executor/PiExecutor';
import { ThreadManager } from '../../src/thread/ThreadManager';
import { ThreadExecutorPool } from '../../src/thread/ThreadExecutorPool';
import { piProjectDirectoryName } from '../../src/session/adapters/PiSessionCatalog';
import type { PiLaunchOptions, PiRpcResponse, PiTransport } from '../../src/executor/pi/PiTypes';

const NATIVE_ID = '01900000-0000-7000-8000-0000000000bb';

/** RPC stand-in: reports the identity of the file it was launched with, like Pi. */
class Transport implements PiTransport {
  running = false;
  launches: PiLaunchOptions[] = [];
  handlers = new Set<(event: Record<string, any>) => void>();
  constructor(public launch: PiLaunchOptions) {}
  request = vi.fn(async (command: Record<string, unknown>): Promise<PiRpcResponse> => {
    if (command.type === 'get_state') {
      const header = this.launch.sessionFile ? JSON.parse(fs.readFileSync(this.launch.sessionFile, 'utf8').split('\n')[0]) : undefined;
      const sessionId = header?.id ?? this.launch.sessionId;
      return { type: 'response', command: 'get_state', success: true,
        data: { sessionId, sessionFile: this.launch.sessionFile ?? path.join(this.launch.sessionDir!, `${sessionId}.jsonl`), isStreaming: false } };
    }
    if (command.type === 'prompt') {
      const nativeFile = this.launch.sessionFile ?? path.join(this.launch.sessionDir!, `${this.launch.sessionId}.jsonl`);
      if (!fs.existsSync(nativeFile)) {
        fs.writeFileSync(nativeFile, JSON.stringify({ type: 'session', version: 3, id: this.launch.sessionId,
          cwd: this.launch.cwd, timestamp: new Date().toISOString() }) + '\n');
      }
      fs.appendFileSync(nativeFile, JSON.stringify({ type: 'message', id: `synthetic-${Date.now()}`, parentId: null,
        timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: command.message }] } }) + '\n');
      this.emit({ type: 'agent_start' });
      this.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'continued' } });
      this.emit({ type: 'agent_settled' });
    }
    return { type: 'response', command: String(command.type), success: true };
  });
  send = vi.fn();
  async start(): Promise<void> { this.running = true; this.launches.push({ ...this.launch }); }
  async stop(): Promise<void> { this.running = false; }
  async waitForExit(): Promise<void> {
    if (this.running) throw new Error('Synthetic Pi transport is still running');
  }
  isRunning(): boolean { return this.running; }
  updateLaunch(partial: Partial<PiLaunchOptions>): void { this.launch = { ...this.launch, ...partial }; }
  onEvent(handler: (event: Record<string, any>) => void): () => void { this.handlers.add(handler); return () => this.handlers.delete(handler); }
  emit(event: Record<string, any>): void { for (const handler of this.handlers) handler(event); }
}

describe('Integration: connecting a native Pi session from chat', () => {
  let home: string;
  let project: string;
  let nativeFile: string;
  let wsClient: any;
  let handler: MessageHandler;
  let transports: Transport[];
  let threadManager: ThreadManager;
  let threadPool: ThreadExecutorPool;
  let threadId: string;
  const originalHomedir = os.homedir.bind(os);
  const pointerFile = () => path.join(home, '.remote-cli', 'pi-sessions', `${threadId}.json`);

  const attach = () => {
    const guard = new DirectoryGuard([home]);
    wsClient = { send: vi.fn(), on: vi.fn(), isConnected: vi.fn(() => true), trackTask: vi.fn() };
    threadPool = new ThreadExecutorPool(threadManager, guard, { type: 'pi' }, (executorGuard, _config, cwd, id) =>
      new PiExecutor(executorGuard, {
        initialWorkingDirectory: cwd, threadId: id,
        clientFactory: launch => { const t = new Transport(launch); transports.push(t); return t; },
      }));
    const config: any = { get: vi.fn((key: string) => (key === 'sessionSharing' ? { enabled: true }
      : key === 'executor' ? { type: 'pi' } : undefined)),
      set: vi.fn(), has: vi.fn(() => true), getAll: vi.fn(() => ({})), getConfigDir: vi.fn(() => path.join(home, '.remote-cli')) };
    handler = new MessageHandler(wsClient, threadPool, threadManager, guard, config);
  };

  const send = async (messageId: string, content: string, extra: Record<string, unknown> = {}) => {
    await handler.handleMessage({ type: 'command', messageId, content, isSlashCommand: content.startsWith('/'),
      openId: 'owner-example', timestamp: Date.now(), ...extra } as any);
    await vi.waitFor(() => expect(wsClient.send.mock.calls.some(([m]: any[]) => m.messageId === messageId && m.type !== 'stream')).toBe(true));
    return wsClient.send.mock.calls.map(([m]: any[]) => m).filter((m: any) => m.messageId === messageId && m.type !== 'stream').at(-1);
  };
  const tokenAfter = (text: string, verb: string) => new RegExp(`/${verb} ([A-Za-z0-9_-]{12})`).exec(text)![1];

  beforeEach(async () => {
    home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-resume-flow-')));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.spyOn(os, 'homedir').mockImplementation(() => process.env.HOME || process.env.USERPROFILE || originalHomedir());
    project = path.join(home, 'project');
    fs.mkdirSync(project);
    const store = path.join(home, '.pi', 'agent', 'sessions', piProjectDirectoryName(project));
    fs.mkdirSync(store, { recursive: true });
    nativeFile = path.join(store, `2026-01-01T00-00-00-000Z_${NATIVE_ID}.jsonl`);
    fs.writeFileSync(nativeFile, [
      JSON.stringify({ type: 'session', version: 3, id: NATIVE_ID, timestamp: '2026-01-01T00:00:00.000Z', cwd: project }),
      JSON.stringify({ type: 'message', id: 'a', parentId: null, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: 'synthetic' } }),
      JSON.stringify({ type: 'session_info', id: 'b', parentId: 'a', timestamp: '2026-01-01T00:00:02.000Z', name: 'Local refactor' }),
    ].join('\n') + '\n');
    fs.utimesSync(nativeFile, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));

    transports = [];
    threadManager = await ThreadManager.initialize(home);
    threadId = threadManager.getDefaultThread().id;
    await threadManager.updateThread(threadId, { workingDirectory: project, delegation: false, backend: 'pi' });
    attach();
  });

  afterEach(async () => {
    try { await handler.destroy(); }
    finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps foreground A and B after /new and switches back to A only after confirmation', async () => {
    expect((await send('ordinary-a', 'SYNTHETIC-A')).success).toBe(true);
    const a = JSON.parse(fs.readFileSync(pointerFile(), 'utf8'));
    const bytesA = fs.readFileSync(a.sessionFile, 'utf8');
    const retired = threadPool.getExecutor(threadId);
    expect(a.adopted).toBeUndefined();

    const reset = await send('new', '/new');
    expect(reset.success, reset.error).toBe(true);
    expect(threadPool.getExistingExecutor(threadId)).toBeUndefined();
    expect(threadManager.contextResets.isPending(threadId)).toBe(false);
    expect(fs.readFileSync(a.sessionFile, 'utf8')).toBe(bytesA);
    expect((await send('ordinary-b', 'SYNTHETIC-B')).success).toBe(true);
    expect(threadPool.getExecutor(threadId)).not.toBe(retired);
    const b = JSON.parse(fs.readFileSync(pointerFile(), 'utf8'));
    expect(b.id).not.toBe(a.id);
    expect(b.sessionFile).not.toBe(a.sessionFile);
    expect(fs.readFileSync(b.sessionFile, 'utf8')).not.toContain('SYNTHETIC-A');

    const selected = await send('select-a', `/resume id ${a.id}`);
    expect(selected.success).toBe(true);
    // Drafts do not redirect ordinary work: it still belongs to B until confirm.
    expect((await send('before-confirm', 'STILL-IN-B')).success).toBe(true);
    expect(fs.readFileSync(b.sessionFile, 'utf8')).toContain('STILL-IN-B');
    expect(fs.readFileSync(a.sessionFile, 'utf8')).toBe(bytesA);
    const confirmed = await send('confirm-a', `/resume confirm ${tokenAfter(selected.output, 'resume confirm')}`);
    expect(confirmed.success).toBe(true);
    expect((await send('after-confirm', 'BACK-IN-A')).success).toBe(true);
    const resumed = JSON.parse(fs.readFileSync(pointerFile(), 'utf8'));
    expect(resumed.id).toBe(a.id);
    expect(resumed.adopted).toBe(true);
    expect(fs.readFileSync(a.sessionFile, 'utf8')).toContain('BACK-IN-A');
    expect(fs.readFileSync(b.sessionFile, 'utf8')).not.toContain('BACK-IN-A');

    const catalog = await send('catalog', '/resume');
    expect(catalog.output).toContain(a.id);
    expect(catalog.output).toContain(b.id);
  });

  it('retries /clear after an inactive pointer failure and restart without reopening or deleting Pi history', async () => {
    expect((await send('ordinary', 'PRESERVED-HISTORY')).success).toBe(true);
    const savedPointer = fs.readFileSync(pointerFile(), 'utf8');
    const saved = JSON.parse(savedPointer);
    const history = fs.readFileSync(saved.sessionFile, 'utf8');
    const invalidPointer = path.join(home, '.remote-cli', 'claude-sessions', `${threadId}.json`);
    fs.mkdirSync(invalidPointer, { recursive: true });

    expect(await send('failed-clear', '/clear')).toMatchObject({
      success: false, error: expect.stringContaining('Session binding is not a file'),
    });
    expect(threadManager.contextResets.isPending(threadId)).toBe(true);
    expect(() => threadPool.getExecutor(threadId)).toThrow('incomplete conversation reset');
    expect(fs.readFileSync(pointerFile(), 'utf8')).toBe(savedPointer);
    expect(fs.readFileSync(saved.sessionFile, 'utf8')).toBe(history);

    await handler.destroy();
    threadManager = await ThreadManager.initialize(home);
    attach();
    expect(threadManager.contextResets.isPending(threadId)).toBe(true);
    expect(await send('blocked', 'MUST-NOT-REOPEN')).toMatchObject({
      success: false, error: expect.stringContaining('incomplete conversation reset'),
    });
    expect(threadPool.getExistingExecutor(threadId)).toBeUndefined();

    fs.rmdirSync(invalidPointer);
    const cleared = await send('retry-clear', '/clear');
    expect(cleared.success, cleared.error).toBe(true);
    expect(threadManager.contextResets.isPending(threadId)).toBe(false);
    expect(fs.existsSync(pointerFile())).toBe(false);
    expect((await send('fresh', 'FRESH-HISTORY')).success).toBe(true);
    const fresh = JSON.parse(fs.readFileSync(pointerFile(), 'utf8'));
    expect(fresh.id).not.toBe(saved.id);
    expect(fresh.sessionFile).not.toBe(saved.sessionFile);
    expect(fs.readFileSync(saved.sessionFile, 'utf8')).toBe(history);
    expect(fs.readFileSync(fresh.sessionFile, 'utf8')).not.toContain('PRESERVED-HISTORY');
  });

  it('retains the Pi binding until exit is confirmed and /clear is retried', async () => {
    expect((await send('ordinary', 'PRESERVED-HISTORY')).success).toBe(true);
    const savedPointer = fs.readFileSync(pointerFile(), 'utf8');
    const saved = JSON.parse(savedPointer);
    const history = fs.readFileSync(saved.sessionFile, 'utf8');
    const retired = threadPool.getExecutor(threadId);
    const exit = vi.spyOn(transports.at(-1)!, 'waitForExit')
      .mockRejectedValueOnce(new Error('Synthetic unconfirmed Pi exit'));

    expect(await send('failed-clear', '/clear')).toMatchObject({
      success: false, error: expect.stringContaining('Synthetic unconfirmed Pi exit'),
    });
    expect(exit).toHaveBeenCalledOnce();
    expect(threadPool.getExistingExecutor(threadId)).toBe(retired);
    expect(() => threadPool.getExecutor(threadId)).toThrow('incomplete conversation reset');
    expect(fs.readFileSync(pointerFile(), 'utf8')).toBe(savedPointer);
    expect(fs.readFileSync(saved.sessionFile, 'utf8')).toBe(history);

    const cleared = await send('retry-clear', '/clear');
    expect(cleared.success, cleared.error).toBe(true);
    expect(exit).toHaveBeenCalledTimes(2);
    expect(threadPool.getExistingExecutor(threadId)).toBeUndefined();
    expect(fs.existsSync(pointerFile())).toBe(false);
    expect(fs.readFileSync(saved.sessionFile, 'utf8')).toBe(history);
    expect((await send('fresh', 'FRESH-HISTORY')).success).toBe(true);
    expect(JSON.parse(fs.readFileSync(pointerFile(), 'utf8')).id).not.toBe(saved.id);
  });

  it('lists, confirms and adopts the exact native file without sending a prompt', async () => {
    const list = await send('list', '/resume');
    expect(list.output).toContain('1. Local refactor');
    expect(list.output).not.toContain(nativeFile);
    expect(transports).toHaveLength(0);

    const selected = await send('select', `/resume select ${tokenAfter(list.output, 'resume select')} 1`);
    expect(selected.output).toContain('Connect this thread');
    expect(transports).toHaveLength(0);

    const before = fs.readFileSync(nativeFile, 'utf8');
    const confirmed = await send('confirm', `/resume confirm ${tokenAfter(selected.output, 'resume confirm')}`);
    expect(confirmed).toMatchObject({ success: true, output: expect.stringContaining(`Connected to Pi session \`${NATIVE_ID}\``) });
    const adoptedLaunch = transports[0].launches[0];
    expect(adoptedLaunch.sessionFile).toBe(nativeFile);
    expect(adoptedLaunch.sessionName).toBeUndefined();
    expect(transports[0].request.mock.calls.map(([c]) => c.type)).toEqual(['get_state']);
    expect(fs.readFileSync(nativeFile, 'utf8')).toBe(before);
    expect(JSON.parse(fs.readFileSync(pointerFile(), 'utf8'))).toMatchObject({ id: NATIVE_ID, sessionFile: nativeFile, adopted: true });
    expect(threadPool.isThreadBusy(threadId)).toBe(false);

    const status = await send('status', '/session');
    expect(status.output).toContain('reloads before every remote turn');

    // Re-selecting the same session in this thread is refused as already connected.
    const relist = await send('relist', '/resume');
    expect((await send('reselect', `/resume select ${tokenAfter(relist.output, 'resume select')} 1`)).error).toContain('already connected');
  });

  it('protects adopted history on clear and confirmed detach without a release step', async () => {
    const list = await send('list', '/resume');
    const selected = await send('select', `/resume select ${tokenAfter(list.output, 'resume select')} 1`);
    await send('confirm', `/resume confirm ${tokenAfter(selected.output, 'resume confirm')}`);
    expect((await send('status', '/session')).output).toContain('reloads before every remote turn');
    expect((await send('removed-command', '/session release')).success).toBe(false);
    const prompt = await send('detach', '/session detach');
    const detached = await send('detach-confirm', `/session confirm ${tokenAfter(prompt.output, 'session confirm')}`);
    expect(detached.output).toContain('Detached');
    expect(fs.existsSync(nativeFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(pointerFile(), 'utf8')).adopted).toBeUndefined();

    const again = await send('list-2', '/resume');
    const pick = await send('select-2', `/resume select ${tokenAfter(again.output, 'resume select')} 1`);
    await send('confirm-2', `/resume confirm ${tokenAfter(pick.output, 'resume confirm')}`);
    threadPool.getExecutor(threadId).resetContext();
    expect(fs.existsSync(nativeFile)).toBe(true);
  });

  it('refuses to adopt while work is queued, and drains the queue after a successful adoption', async () => {
    const drain = vi.spyOn(handler as any, 'startNextQueuedCommand').mockResolvedValue(undefined);
    const list = await send('list', '/resume');
    const selected = await send('select', `/resume select ${tokenAfter(list.output, 'resume select')} 1`);
    (handler as any).threadQueues.set(threadId, [{ content: 'queued work' }]);
    const blocked = await send('confirm', `/resume confirm ${tokenAfter(selected.output, 'resume confirm')}`);
    expect(blocked.error).toContain('running a task');
    expect(transports).toHaveLength(0);

    (handler as any).threadQueues.delete(threadId);
    const again = await send('select-2', `/resume select ${tokenAfter(list.output, 'resume select')} 1`);
    const confirmed = await send('confirm-2', `/resume confirm ${tokenAfter(again.output, 'resume confirm')}`);
    expect(confirmed.success).toBe(true);
    expect(threadPool.isThreadBusy(threadId)).toBe(false);
    expect(drain).toHaveBeenCalledWith(threadId);
  });

  it('reports a session-control failure without crashing the message handler', async () => {
    (handler as any).sessionControl.handle = vi.fn().mockRejectedValue(new Error('synthetic failure'));
    const reply = await send('boom', '/resume');
    expect(reply).toMatchObject({ success: false, error: expect.stringContaining('Session control failed: synthetic failure') });
  });

  it('refuses a confirmation after the native file changed locally', async () => {
    const list = await send('list', '/resume');
    const selected = await send('select', `/resume select ${tokenAfter(list.output, 'resume select')} 1`);
    fs.appendFileSync(nativeFile, JSON.stringify({ type: 'message', id: 'c', parentId: 'b', timestamp: '2026-01-01T00:00:03.000Z', message: { role: 'user', content: 'local' } }) + '\n');
    const confirmed = await send('confirm', `/resume confirm ${tokenAfter(selected.output, 'resume confirm')}`);
    expect(confirmed.error).toContain('changed after you selected it');
    expect(transports).toHaveLength(0);
  });
});
