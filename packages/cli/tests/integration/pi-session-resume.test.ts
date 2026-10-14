import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../src/client/WebSocketClient');

import { MessageHandler } from '../../src/client/MessageHandler';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { PiExecutor } from '../../src/executor/PiExecutor';
import { piProjectDirectoryName } from '../../src/session/adapters/PiSessionCatalog';
import type { PiLaunchOptions, PiRpcResponse, PiTransport } from '../../src/executor/pi/PiTypes';

const originalHome = process.env.HOME;
const originalHomedir = os.homedir.bind(os);
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
      this.emit({ type: 'agent_start' });
      this.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'continued' } });
      this.emit({ type: 'agent_settled' });
    }
    return { type: 'response', command: String(command.type), success: true };
  });
  send = vi.fn();
  async start(): Promise<void> { this.running = true; this.launches.push({ ...this.launch }); }
  async stop(): Promise<void> { this.running = false; }
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
  let executor: PiExecutor | undefined;
  let busy: boolean;
  const pointerFile = () => path.join(home, '.remote-cli', 'pi-sessions', 'thread-a.json');

  const send = async (messageId: string, content: string, extra: Record<string, unknown> = {}) => {
    await handler.handleMessage({ type: 'command', messageId, content, isSlashCommand: content.startsWith('/'),
      openId: 'owner-example', timestamp: Date.now(), ...extra } as any);
    await vi.waitFor(() => expect(wsClient.send.mock.calls.some(([m]: any[]) => m.messageId === messageId && m.type !== 'stream')).toBe(true));
    return wsClient.send.mock.calls.map(([m]: any[]) => m).filter((m: any) => m.messageId === messageId && m.type !== 'stream').at(-1);
  };
  const tokenAfter = (text: string, verb: string) => new RegExp(`/${verb} ([A-Za-z0-9_-]{12})`).exec(text)![1];

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-resume-flow-')));
    process.env.HOME = home;
    vi.spyOn(os, 'homedir').mockImplementation(() => process.env.HOME || originalHomedir());
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
    busy = false;
    executor = undefined;
    const guard = new DirectoryGuard([home]);
    wsClient = { send: vi.fn(), on: vi.fn(), isConnected: vi.fn(() => true) };
    const thread = { id: 'thread-a', name: 'default', workingDirectory: project, sessionId: null, createdAt: 0, lastActiveAt: 0 };
    const threadManager: any = {
      getDefaultThread: vi.fn(() => thread), getThread: vi.fn((id: string) => (id === 'thread-a' ? thread : undefined)),
      getThreadByName: vi.fn(), listThreads: vi.fn(() => [thread]), touchThread: vi.fn(), updateThread: vi.fn(),
    };
    const threadPool: any = {
      getExecutor: vi.fn(() => executor ??= new PiExecutor(guard, {
        initialWorkingDirectory: project, threadId: 'thread-a',
        clientFactory: launch => { const t = new Transport(launch); transports.push(t); return t; },
      })),
      isThreadBusy: vi.fn(() => busy),
      setThreadBusy: vi.fn((_id: string, value: boolean) => { busy = value; }),
      getSummaries: vi.fn(() => []),
      getBackendKey: vi.fn(() => 'pi'),
    };
    const config: any = { get: vi.fn((key: string) => (key === 'sessionSharing' ? { enabled: true } : undefined)),
      set: vi.fn(), has: vi.fn(() => true), getAll: vi.fn(() => ({})), getConfigDir: vi.fn(() => path.join(home, '.remote-cli')) };
    handler = new MessageHandler(wsClient, threadPool, threadManager, guard, config);
  });

  afterEach(async () => {
    await executor?.destroy();
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
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
    expect(busy).toBe(false);

    const status = await send('status', '/session');
    expect(status.output).toContain('remote-ready');

    // Re-selecting the same session in this thread is refused as already connected.
    const relist = await send('relist', '/resume');
    expect((await send('reselect', `/resume select ${tokenAfter(relist.output, 'resume select')} 1`)).error).toContain('already connected');
  });

  it('protects adopted history from /clear and supports release and detach', async () => {
    const list = await send('list', '/resume');
    const selected = await send('select', `/resume select ${tokenAfter(list.output, 'resume select')} 1`);
    await send('confirm', `/resume confirm ${tokenAfter(selected.output, 'resume confirm')}`);

    const released = await send('release', '/session release');
    expect(released.output).toContain('Released Pi session');
    expect(transports.at(-1)!.running).toBe(false);
    expect((await send('status', '/session')).output).toContain('released for local use');

    // Reconnect, then detach: history stays, the pointer forgets it.
    const again = await send('list-2', '/resume');
    const reselected = await send('select-2', `/resume select ${tokenAfter(again.output, 'resume select')} 1`);
    expect((await send('confirm-2', `/resume confirm ${tokenAfter(reselected.output, 'resume confirm')}`)).success).toBe(true);
    const prompt = await send('detach', '/session detach');
    const detached = await send('detach-confirm', `/session confirm ${tokenAfter(prompt.output, 'session confirm')}`);
    expect(detached.output).toContain('Detached');
    expect(fs.existsSync(nativeFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(pointerFile(), 'utf8')).adopted).toBeUndefined();

    // /clear after a new adoption keeps the native file.
    const third = await send('list-3', '/resume');
    const pick = await send('select-3', `/resume select ${tokenAfter(third.output, 'resume select')} 1`);
    await send('confirm-3', `/resume confirm ${tokenAfter(pick.output, 'resume confirm')}`);
    executor!.resetContext();
    expect(fs.existsSync(nativeFile)).toBe(true);
  });

  it('refuses to adopt while work is queued, and drains the queue after a successful adoption', async () => {
    const drain = vi.spyOn(handler as any, 'startNextQueuedCommand').mockResolvedValue(undefined);
    const list = await send('list', '/resume');
    const selected = await send('select', `/resume select ${tokenAfter(list.output, 'resume select')} 1`);
    (handler as any).threadQueues.set('thread-a', [{ content: 'queued work' }]);
    const blocked = await send('confirm', `/resume confirm ${tokenAfter(selected.output, 'resume confirm')}`);
    expect(blocked.error).toContain('running a task');
    expect(transports).toHaveLength(0);

    (handler as any).threadQueues.delete('thread-a');
    const again = await send('select-2', `/resume select ${tokenAfter(list.output, 'resume select')} 1`);
    const confirmed = await send('confirm-2', `/resume confirm ${tokenAfter(again.output, 'resume confirm')}`);
    expect(confirmed.success).toBe(true);
    expect(busy).toBe(false);
    expect(drain).toHaveBeenCalledWith('thread-a');
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
