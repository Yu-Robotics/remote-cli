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
  async start(): Promise<void> { this.starts += 1; this.running = true; this.launches.push({ ...this.launch }); }
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
    expect(latest().starts).toBe(1);
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
    expect(latest().launches.at(-1)!.sessionName).toBe('remote-cli-thread-pi');
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

  it('still deletes remote-cli created history on /clear', async () => {
    expect((await run()).success).toBe(true);
    const owned = pointer().sessionFile as string;
    await fs.mkdir(path.dirname(owned), { recursive: true });
    await fs.writeFile(owned, '{}\n');
    executor.resetContext();
    expect(existsSync(owned)).toBe(false);
  });

  it('release blocks remote work across restarts until the session is connected again', async () => {
    await executor.adoptNativeSession({ sessionId: NATIVE_ID, sessionFile: nativeFile });
    expect(await executor.releaseNativeSession()).toEqual({ success: true });
    expect(latest().running).toBe(false);
    expect(pointer()).toMatchObject({ adopted: true, released: true });
    const blocked = await run();
    expect(blocked.success).toBe(false);
    expect(blocked.error).toContain('released its Pi session');

    await executor.destroy();
    executor = create();
    expect((await run()).error).toContain('released its Pi session');
    expect(latest().starts).toBe(0);

    expect((await executor.adoptNativeSession({ sessionId: NATIVE_ID, sessionFile: nativeFile })).success).toBe(true);
    expect(pointer().released).toBeUndefined();
    expect((await run()).success).toBe(true);
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
    expect(launch.sessionName).toBe('remote-cli-thread-pi');
  });

  it('refuses release and detach without an adopted session or during a turn, and reports stop failures', async () => {
    expect((await executor.releaseNativeSession()).success).toBe(false);
    expect((await executor.detachNativeSession()).success).toBe(false);
    await executor.adoptNativeSession({ sessionId: NATIVE_ID, sessionFile: nativeFile });
    latest().stopFails = true;
    expect((await executor.releaseNativeSession()) as any).toMatchObject({ success: false, error: expect.stringContaining('still held') });
    expect((await executor.detachNativeSession()) as any).toMatchObject({ success: false, error: expect.stringContaining('still connected') });
    latest().stopFails = false;
    let release!: () => void;
    latest().promptGate = new Promise(resolve => { release = resolve; });
    const turn = run();
    await vi.waitFor(() => expect(latest().prompts()).toBe(1));
    expect((await executor.releaseNativeSession()) as any).toMatchObject({ error: expect.stringContaining('/abort') });
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
