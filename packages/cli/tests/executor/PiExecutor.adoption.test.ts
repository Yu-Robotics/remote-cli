import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs, existsSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { PiExecutor } from '../../src/executor/PiExecutor';
import type { PiLaunchOptions, PiRpcResponse, PiTransport } from '../../src/executor/pi/PiTypes';

const originalHome = process.env.HOME;
const originalHomedir = os.homedir();
const NATIVE_ID = '01900000-0000-7000-8000-0000000000aa';

/** Fake RPC process whose reported identity follows its launch unless overridden. */
class FakeTransport implements PiTransport {
  running = false;
  starts = 0;
  stopFails = false;
  reportedId?: string;
  streaming = false;
  promptGate?: Promise<void>;
  launches: PiLaunchOptions[] = [];
  loadedText?: string;
  handlers = new Set<(event: Record<string, any>) => void>();
  request = vi.fn(async (command: Record<string, unknown>): Promise<PiRpcResponse> => {
    if (command.type === 'get_state') {
      const fileId = this.launch.sessionFile ? /([^_/]+)\.jsonl$/.exec(this.launch.sessionFile)?.[1] : undefined;
      const sessionId = this.reportedId ?? fileId ?? this.launch.sessionId;
      const sessionFile = this.launch.sessionFile ?? path.join(this.launch.sessionDir ?? '/tmp', `${sessionId}.jsonl`);
      return { type: 'response', command: 'get_state', success: true,
        data: { sessionId, sessionFile, isStreaming: this.streaming, model: { provider: 'example', id: 'model-a' }, thinkingLevel: 'low' } };
    }
    if (command.type === 'prompt') {
      if (this.promptGate) await this.promptGate;
      this.emit({ type: 'agent_start' });
      this.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'done' } });
      this.emit({ type: 'agent_settled' });
    }
    return { type: 'response', command: String(command.type), success: true };
  });
  send = vi.fn();
  constructor(public launch: PiLaunchOptions) {}
  async start(): Promise<void> {
    this.starts += 1;
    this.running = true;
    this.launches.push({ ...this.launch });
    this.loadedText = this.launch.sessionFile ? readFileSync(this.launch.sessionFile, 'utf8') : undefined;
  }
  async stop(): Promise<void> {
    if (this.stopFails) throw new Error('Pi RPC process exit could not be confirmed');
    this.running = false;
  }
  isRunning(): boolean { return this.running; }
  updateLaunch(partial: Partial<PiLaunchOptions>): void { this.launch = { ...this.launch, ...partial }; }
  onEvent(handler: (event: Record<string, any>) => void): () => void { this.handlers.add(handler); return () => this.handlers.delete(handler); }
  emit(event: Record<string, any>): void { for (const handler of this.handlers) handler(event); }
  prompts(): number { return this.request.mock.calls.filter(([c]) => c.type === 'prompt').length; }
}

describe('PiExecutor native session adoption', () => {
  let home: string;
  let project: string;
  let nativeFile: string;
  let pointerDir: string;
  let transports: FakeTransport[];
  let executor: PiExecutor;
  const latest = () => transports[transports.length - 1];
  const create = () => new PiExecutor(new DirectoryGuard([home]), {
    initialWorkingDirectory: project,
    threadId: 'thread-pi',
    sessionBaseDir: pointerDir,
    clientFactory: (launch) => { const t = new FakeTransport(launch); transports.push(t); return t; },
  });
  const pointer = () => JSON.parse(readFileSync(path.join(pointerDir, 'thread-pi.json'), 'utf8'));
  const run = (prompt = 'continue') => executor.execute(prompt, { onStream: () => undefined } as any);

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(originalHomedir, '.pi-adoption-test-'));
    project = path.join(home, 'project');
    pointerDir = path.join(home, '.remote-cli', 'pi-sessions');
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(path.join(home, 'native'), { recursive: true });
    nativeFile = path.join(home, 'native', `2026-01-01T00-00-00-000Z_${NATIVE_ID}.jsonl`);
    await fs.writeFile(nativeFile, '{"type":"session"}\n');
    process.env.HOME = home;
    transports = [];
    executor = create();
  });

  afterEach(async () => {
    await executor.destroy().catch(() => undefined);
    await fs.rm(home, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it('opens the exact file, verifies identity without a prompt, and never renames it', async () => {
    const result = await executor.adoptNativeSession({ sessionId: NATIVE_ID, sessionFile: nativeFile });
    expect(result).toEqual({ success: true });
    const launch = latest().launches.at(-1)!;
    expect(launch.sessionFile).toBe(nativeFile);
    expect(launch.sessionName).toBeUndefined();
    expect(latest().request.mock.calls.map(([c]) => c.type)).toEqual(['get_state']);
    expect(pointer()).toMatchObject({ id: NATIVE_ID, sessionFile: nativeFile, adopted: true });
    expect(pointer().released).toBeUndefined();
    expect(executor.getExecutionMetadata()).toMatchObject({ model: 'example/model-a' });

    expect((await run()).success).toBe(true);
    expect(latest().prompts()).toBe(1);
    expect(latest().starts).toBe(2);
  });

  it('reloads local appends before every adopted turn without losing identity or renaming', async () => {
    await executor.adoptNativeSession({ sessionId: NATIVE_ID, sessionFile: nativeFile });
    expect((await run('first remote turn')).success).toBe(true);
    await fs.appendFile(nativeFile, 'SYNTHETIC-LOCAL-UPDATE\n');
    expect((await run('return from local')).success).toBe(true);
    expect(latest().starts).toBe(3);
    expect(latest().loadedText).toContain('SYNTHETIC-LOCAL-UPDATE');
    expect(latest().prompts()).toBe(2);
    expect(latest().launch.sessionFile).toBe(nativeFile);
    expect(latest().launch.sessionName).toBeUndefined();
    expect(pointer().id).toBe(NATIVE_ID);
  });

  it('blocks dispatch on a reload stop failure or mismatching identity, even with a live idle client', async () => {
    await executor.adoptNativeSession({ sessionId: NATIVE_ID, sessionFile: nativeFile });
    latest().stopFails = true;
    const failedStop = await run();
    expect(failedStop.error).toContain('exit could not be confirmed');
    expect(latest().prompts()).toBe(0);
    latest().stopFails = false;
    latest().reportedId = 'replacement';
    expect((await run()).error).toContain('different session');
    expect(latest().prompts()).toBe(0);
    expect(pointer().id).toBe(NATIVE_ID);
  });

  it('reserves a preparing turn and cancels reset before any prompt is sent', async () => {
    await executor.adoptNativeSession({ sessionId: NATIVE_ID, sessionFile: nativeFile });
    let finishStop!: () => void;
    const stopped = new Promise<void>(resolve => { finishStop = resolve; });
    latest().stop = vi.fn(() => stopped);
    const turn = run();
    expect(executor.isBusy()).toBe(true);
    expect((await run('overlapping')).error).toContain('already running');
    expect((await executor.adoptNativeSession({ sessionId: NATIVE_ID, sessionFile: nativeFile })).success).toBe(false);
    expect((await executor.detachNativeSession()).success).toBe(false);
    // Reset during preparation must not dispatch against the replacement context.
    executor.resetContext();
    finishStop();
    expect((await turn).error).toContain('cancelled before startup');
    expect(latest().prompts()).toBe(0);
  });

  it('cancels an adopted reload through /abort before native prompt dispatch', async () => {
    await executor.adoptNativeSession({ sessionId: NATIVE_ID, sessionFile: nativeFile });
    const originalStart = latest().start.bind(latest());
    let finishStart!: () => void;
    latest().start = vi.fn(async () => { await new Promise<void>(resolve => { finishStart = resolve; }); await originalStart(); });
    const turn = run();
    await vi.waitFor(() => expect(finishStart).toBeDefined());
    expect(await executor.abort()).toBe(true);
    finishStart();
    expect((await turn).error).toContain('cancelled before dispatch');
    expect(latest().prompts()).toBe(0);
    expect(latest().running).toBe(false);
  });

  it('fails closed and restores the previous conversation when Pi reports another identity', async () => {
    expect((await run('before')).success).toBe(true);
    const before = pointer();
    latest().reportedId = 'substituted-fresh-session';
    const result = await executor.adoptNativeSession({ sessionId: NATIVE_ID, sessionFile: nativeFile });
    expect(result.success).toBe(false);
    expect((result as any).error).toContain('different session');
    expect((result as any).error).toContain('previous conversation is kept');
    expect(pointer()).toEqual(before);
    expect(existsSync(nativeFile)).toBe(true);
    latest().reportedId = undefined;
    expect((await run('after')).success).toBe(true);
    expect(latest().launches.at(-1)!.sessionFile).not.toBe(nativeFile);
    expect(latest().launches.at(-1)!.sessionName).toBe(`remote-cli-${latest().launches.at(-1)!.sessionId}`);
  });

  it('rejects a streaming native session and a missing file without touching the process', async () => {
    latest().streaming = true;
    expect((await executor.adoptNativeSession({ sessionId: NATIVE_ID, sessionFile: nativeFile })) as any)
      .toMatchObject({ success: false, error: expect.stringContaining('already running') });
    latest().streaming = false;
    const starts = latest().starts;
    expect((await executor.adoptNativeSession({ sessionId: NATIVE_ID, sessionFile: path.join(home, 'native', 'gone.jsonl') })) as any)
      .toMatchObject({ success: false, error: expect.stringContaining('no longer available') });
    expect(latest().starts).toBe(starts);
  });

  it('retires a process whose stop is unconfirmed after a failed verification', async () => {
    const first = latest();
    first.reportedId = 'substituted';
    first.stop = vi.fn()
      .mockResolvedValueOnce(undefined) // recycle before adoption
      .mockRejectedValue(new Error('exit unconfirmed'));
    const result = await executor.adoptNativeSession({ sessionId: NATIVE_ID, sessionFile: nativeFile });
    expect(result.success).toBe(false);
    expect(transports.length).toBe(2);
    expect(latest()).not.toBe(first);
  });

  it('reports stop failures and busy turns instead of adopting', async () => {
    latest().stopFails = true;
    expect((await executor.adoptNativeSession({ sessionId: NATIVE_ID, sessionFile: nativeFile })) as any)
      .toMatchObject({ success: false, error: expect.stringContaining('No session was changed') });
    latest().stopFails = false;
    let release!: () => void;
    latest().promptGate = new Promise(resolve => { release = resolve; });
    const turn = run();
    await vi.waitFor(() => expect(latest().prompts()).toBe(1));
    expect((await executor.adoptNativeSession({ sessionId: NATIVE_ID, sessionFile: nativeFile })) as any)
      .toMatchObject({ success: false, error: expect.stringContaining('Wait for the running Pi task') });
    release();
    await turn;
  });

  it('preserves adopted native history on /clear and on thread deletion', async () => {
    await executor.adoptNativeSession({ sessionId: NATIVE_ID, sessionFile: nativeFile });
    executor.resetContext();
    expect(existsSync(nativeFile)).toBe(true);
    expect(existsSync(path.join(pointerDir, 'thread-pi.json'))).toBe(false);

    await executor.adoptNativeSession({ sessionId: NATIVE_ID, sessionFile: nativeFile });
    await executor.destroy();
    const fresh = create();
    await fresh.deleteThreadData('thread-pi');
    expect(existsSync(nativeFile)).toBe(true);
    expect(existsSync(path.join(pointerDir, 'thread-pi.json'))).toBe(false);
    await fresh.destroy();
  });

  it('preserves ordinary foreground history and starts a different native ID on /clear', async () => {
    expect((await run()).success).toBe(true);
    const first = pointer();
    const owned = first.sessionFile as string;
    await fs.mkdir(path.dirname(owned), { recursive: true });
    await fs.writeFile(owned, 'SYNTHETIC-SAVED-HISTORY\n');
    executor.resetContext();
    expect(existsSync(owned)).toBe(true);
    expect(readFileSync(owned, 'utf8')).toBe('SYNTHETIC-SAVED-HISTORY\n');
    expect(latest().launch.sessionFile).toBeUndefined();
    expect(latest().launch.sessionId).not.toBe(first.id);
    expect(latest().launch.sessionId).not.toBe('thread-pi');
    expect((await run()).success).toBe(true);
    expect(pointer().id).not.toBe(first.id);
  });

  it('gives reset foreground sessions distinct names and does not rename a persisted reopen', async () => {
    const initialName = latest().launch.sessionName;
    expect(initialName).toBe(`remote-cli-${latest().launch.sessionId}`);
    await run();
    const file = pointer().sessionFile as string;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{}\n');
    await executor.destroy();
    executor = create();
    expect(latest().launch.sessionName).toBeUndefined();
    executor.resetContext();
    expect(latest().launch.sessionName).toBe(`remote-cli-${latest().launch.sessionId}`);
    expect(latest().launch.sessionName).not.toBe(initialName);
  });

  it('preserves ordinary foreground history when the remote thread data is deleted', async () => {
    await run();
    const file = pointer().sessionFile as string;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'SYNTHETIC-FOREGROUND-HISTORY\n');
    await executor.destroy();
    executor = create();
    await executor.deleteThreadData('thread-pi');
    expect(readFileSync(file, 'utf8')).toBe('SYNTHETIC-FOREGROUND-HISTORY\n');
    expect(existsSync(path.join(pointerDir, 'thread-pi.json'))).toBe(false);
  });

  it('does not resurrect the cleared session when restarted before the next prompt', async () => {
    await run();
    const oldId = pointer().id;
    executor.resetContext();
    await executor.destroy();
    executor = create();
    expect(latest().launch.sessionId).not.toBe(oldId);
    expect(latest().launch.sessionId).not.toBe('thread-pi');
    expect(latest().launch.sessionFile).toBeUndefined();
    await run();
    expect(pointer().id).not.toBe(oldId);
  });

  it.each([
    { threadId: 'delegate-lane-synthetic', delegationWorker: true },
    { threadId: 'settings-meta-synthetic', delegationWorker: false },
  ])('retains disposable reset behavior for synthetic runtime $threadId', async options => {
    await executor.destroy();
    executor = new PiExecutor(new DirectoryGuard([home]), {
      initialWorkingDirectory: project, sessionBaseDir: pointerDir, ...options,
      clientFactory: launch => { const transport = new FakeTransport(launch); transports.push(transport); return transport; },
    });
    await run();
    const owned = latest().launch.sessionFile ?? path.join(latest().launch.sessionDir!, `${options.threadId}.jsonl`);
    await fs.mkdir(path.dirname(owned), { recursive: true });
    await fs.writeFile(owned, '{}\n');
    executor.resetContext();
    expect(existsSync(owned)).toBe(false);
    expect(latest().launch.sessionId).toBe(options.threadId);
  });

  it('ignores a legacy released pointer and reloads before remote work after restart', async () => {
    await executor.adoptNativeSession({ sessionId: NATIVE_ID, sessionFile: nativeFile });
    await executor.destroy();
    await fs.writeFile(path.join(pointerDir, 'thread-pi.json'), JSON.stringify({ ...pointer(), released: true }));
    executor = create();
    expect((await run()).success).toBe(true);
    expect(latest().starts).toBe(1);
    expect(latest().launch.sessionFile).toBe(nativeFile);
    expect(latest().prompts()).toBe(1);
  });

  it('detach keeps the native file and starts a fresh remote-cli conversation next', async () => {
    await executor.adoptNativeSession({ sessionId: NATIVE_ID, sessionFile: nativeFile });
    expect(await executor.detachNativeSession()).toEqual({ success: true });
    expect(existsSync(nativeFile)).toBe(true);
    const detached = pointer();
    expect(detached.adopted).toBeUndefined();
    expect(detached.sessionFile).toBeUndefined();
    expect(detached.id).not.toBe(NATIVE_ID);
    expect((await run()).success).toBe(true);
    const launch = latest().launches.at(-1)!;
    expect(launch.sessionFile).toBeUndefined();
    expect(launch.sessionId).toBe(detached.id);
    expect(launch.sessionName).toBe(`remote-cli-${detached.id}`);
  });

  it('refuses detach without an adopted session or during a turn, and reports stop failures', async () => {
    expect((await executor.detachNativeSession()).success).toBe(false);
    await executor.adoptNativeSession({ sessionId: NATIVE_ID, sessionFile: nativeFile });
    latest().stopFails = true;
    expect((await executor.detachNativeSession()) as any).toMatchObject({ success: false, error: expect.stringContaining('still connected') });
    latest().stopFails = false;
    let release!: () => void;
    latest().promptGate = new Promise(resolve => { release = resolve; });
    const turn = run();
    await vi.waitFor(() => expect(latest().prompts()).toBe(1));
    expect((await executor.detachNativeSession()) as any).toMatchObject({ error: expect.stringContaining('/abort') });
    release();
    await turn;
  });

  it('never substitutes a fresh session when the adopted file disappears or its identity changes', async () => {
    await executor.adoptNativeSession({ sessionId: NATIVE_ID, sessionFile: nativeFile });
    await executor.destroy();
    executor = create();
    latest().reportedId = 'substituted';
    const mismatch = await run();
    expect(mismatch.success).toBe(false);
    expect(mismatch.error).toContain('different session');
    expect(latest().prompts()).toBe(0);
    expect(latest().running).toBe(false);

    await fs.rm(nativeFile);
    const starts = latest().starts;
    const missing = await run();
    expect(missing.error).toContain('no longer available');
    expect(latest().starts).toBe(starts);
  });
});
