import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { AgyExecutor } from '../../src/executor/AgyExecutor';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { createExecutor } from '../../src/executor';
import { MessageHandler } from '../../src/client/MessageHandler';
import { WebSocketClient } from '../../src/client/WebSocketClient';
import { ConfigManager } from '../../src/config/ConfigManager';
import { ThreadManager } from '../../src/thread/ThreadManager';
import { ThreadExecutorPool } from '../../src/thread/ThreadExecutorPool';
const fixture = vi.hoisted(() => ({ home: '', runtimes: [] as any[], startup: false, close: false, wait: undefined as Promise<void> | undefined,
  promptWait: undefined as Promise<void> | undefined, saved: undefined as Promise<void> | undefined, result: { success: true, output: 'Synthetic output' }, id: 0 }));
vi.mock('os', async load => { const actual = await load<typeof import('os')>(); return { ...actual, homedir: () => fixture.home, default: { ...actual, homedir: () => fixture.home } }; });
vi.mock('child_process', () => ({ spawn: vi.fn(() => { throw new Error('No legacy process permitted'); }), execFile: vi.fn() }));
vi.mock('../../src/executor/agy/AgyAcpRuntime', () => ({ AgyAcpRuntime: class {
  running = false; busy = false; hasJobs = false; blocked?: string; sessionId?: string; closed = false; canRetireForContextReset = true;
  get reusable() { return !this.blocked && !this.hasJobs; }
  changes: any[] = []; prompts: string[] = []; optionsSeen: any[] = [];
  constructor(public options: any) { fixture.runtimes.push(this); }
  async start() {
    if (this.sessionId) return;
    if (fixture.startup) throw new Error('Synthetic ACP startup refusal');
    this.running = true;
    this.sessionId = this.options.sessionId ?? `synthetic-${++fixture.id}`;
    if (!this.options.sessionId) this.options.beforeAllocation?.();
    await this.options.saveSession(this.sessionId); await fixture.saved;
  }
  async execute(prompt: string, options: any) {
    this.options.beforePrompt?.(); this.busy = true;
    this.prompts.push(options.resolvePrompt?.(this.sessionId) ?? prompt); this.optionsSeen.push(options);
    await fixture.promptWait; this.busy = false;
    this.options.settledPrompt?.(true); return fixture.result;
  }
  async close() { await fixture.wait; if (fixture.close) throw new Error('Synthetic group exit unconfirmed'); this.closed = true; this.running = false; if (this.sessionId) this.options.ownedSessionClosed(this.sessionId); }
  async waitForManagedProcessGroupExit() { if (!this.closed) throw new Error('Synthetic group still live'); }
  async abort() { return this.busy; }
  async changeSettings(change: any) { await this.start(); this.changes.push(change); }
  isWaitingInput() { return false; }
  sendInput() { return false; }
  respondToApproval() { return false; }
} }));
let executor: AgyExecutor, cwd: string;
const last = () => fixture.runtimes.at(-1);
const pointer = () => path.join(fixture.home, '.remote-cli', 'agy-sessions', 'synthetic-thread.json');
const make = (extra: object = {}) => new AgyExecutor(new DirectoryGuard([fixture.home]), { threadId: 'synthetic-thread', initialWorkingDirectory: cwd, ...extra });
function prepareFixture() {
  fixture.home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-acp-executor-')));
  vi.stubEnv('HOME', fixture.home); vi.stubEnv('USERPROFILE', fixture.home);
  cwd = path.join(fixture.home, 'workspace'); fs.mkdirSync(cwd);
  fixture.runtimes = []; fixture.startup = false; fixture.close = false; fixture.wait = undefined; fixture.promptWait = undefined; fixture.saved = undefined;
  fixture.result = { success: true, output: 'Synthetic output' }; fixture.id = 0;
  vi.clearAllMocks(); executor = make();
}
async function disposeFixture() {
  fixture.wait = undefined; fixture.close = false; await executor.destroy(); vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(fixture.home, { recursive: true, force: true });
}
describe('AGY ACP-only executor policies', () => {
  beforeEach(prepareFixture);
  afterEach(disposeFixture);
  it('never starts a legacy process on ACP startup failure', async () => {
    fixture.startup = true;
    await expect(executor.execute('task')).rejects.toThrow('startup'); expect(spawn).not.toHaveBeenCalled();
    expect(fs.existsSync(pointer())).toBe(false);
  });
  it.each([false, true])('passes private HOME, settings and approval policy to ACP (%s)', async automatic => {
    executor = make({ model: 'chosen', effort: 'high', autoApprove: automatic });
    await executor.execute('task');
    expect(last().options).toMatchObject({ model: 'chosen', effort: 'high', autoApprove: automatic, cwd });
    expect(last().options.env.HOME).toBe(path.join(fixture.home, '.remote-cli', 'agy-homes', 'synthetic-thread'));
    expect(last().options.env.USERPROFILE).toBe(last().options.env.HOME);
    expect(JSON.parse(fs.readFileSync(pointer(), 'utf8'))).toMatchObject({ id: executor.getSessionId(), transport: 'acp' });
    expect(spawn).not.toHaveBeenCalled();
  });
  it('persists settings metadata without creating a process just to report it', () => {
    executor = make({ model: 'chosen', effort: 'high' });
    expect(executor.getExecutionMetadata()).toMatchObject({ model: 'chosen', reasoningEffort: 'high' });
    expect(fixture.runtimes).toHaveLength(0);
  });
  it('resolves fixed versus dynamic prompt identity after allocation without duplicate setup', async () => {
    await executor.execute('first', { resolvePrompt: id => `full:${id}` });
    const id = executor.getSessionId(); await executor.execute('second', { resolvePrompt: current => current === id ? 'dynamic' : 'full' });
    expect(last().prompts).toEqual([`full:${id}`, 'dynamic']); expect(fixture.runtimes).toHaveLength(1);
  });
  it('refuses overlapping turns and control changes until the active turn settles', async () => {
    let release!: () => void; fixture.promptWait = new Promise(resolve => { release = resolve; });
    const pending = executor.execute('first'); await vi.waitFor(() => expect(last()?.prompts).toHaveLength(1));
    for (const operation of [() => executor.execute('second'), () => executor.resetContext(), () => executor.setModel('other'), () => executor.configureDelegation({ url: 'http://127.0.0.1:1', token: 'synthetic' })]) await expect(operation()).rejects.toThrow();
    expect(await executor.abort()).toBe(true); release(); await pending;
    expect(last().prompts).toEqual(['first']);
  });
  it('changes settings on the current runtime and rejects invalid efforts without dispatch', async () => {
    await executor.execute('first'); const id = executor.getSessionId();
    await executor.setModel('other'); await executor.setEffort('high'); await executor.setEffort('auto'); await executor.clearModel(); await executor.setMode('plan');
    expect(last().changes).toEqual([{ model: 'other' }, { effort: 'high' }, { resetEffort: true }, { resetModel: true }, { mode: 'plan' }]);
    expect((await executor.setEffort('invalid')).success).toBe(false); expect(executor.getSessionId()).toBe(id);
    expect(fixture.runtimes).toHaveLength(1); expect(last().closed).toBe(false);
  });
  it('reconnects managed tools only after exact exit, keeps identity and rotates token', async () => {
    await executor.configureDelegation({ url: 'http://127.0.0.1:1', token: 'synthetic-a' }); await executor.execute('first');
    const old = last(), id = executor.getSessionId(); let release!: () => void;
    fixture.wait = new Promise(resolve => { release = resolve; });
    const change = executor.configureDelegation({ url: 'http://127.0.0.1:2', token: 'synthetic-b' });
    await expect(executor.execute('during switch')).rejects.toThrow('busy'); expect(fixture.runtimes).toHaveLength(1);
    release(); await change; await executor.execute('second');
    expect(old.closed).toBe(true); expect(last().options.sessionId).toBe(id);
    expect(last().options.mcpServers[0].env).toContainEqual({ name: 'REMOTE_CLI_DELEGATION_TOKEN', value: 'synthetic-b' });
    expect(last().prompts).toEqual(['second']);
  });
  it('consumes reconnect permission before a failed load and refuses a retry', async () => {
    await executor.execute('first');
    await executor.configureDelegation({ url: 'http://127.0.0.1:2', token: 'synthetic' });
    fixture.startup = true; await expect(executor.execute('failed load')).rejects.toThrow('startup');
    fixture.startup = false; await expect(executor.execute('retry')).rejects.toThrow('cannot safely resume');
    expect(fixture.runtimes).toHaveLength(2);
  });
  it.each([false, true])('refuses legacy main/worker selection, then explicit clear preserves original history (%s)', async worker => {
    fs.writeFileSync(pointer(), JSON.stringify({ id: 'legacy-original' }));
    executor = make({ delegationWorker: worker });
    const history = path.join(fixture.home, 'original-native-history'); fs.writeFileSync(history, 'Synthetic retained history');
    await expect(executor.execute('unsafe')).rejects.toThrow(worker ? 'worker card Clear' : 'explicit /clear');
    expect(fixture.runtimes).toHaveLength(0); expect(executor.getSessionId()).toBe('legacy-original');
    await executor.resetContext(); await executor.execute('fresh');
    expect(executor.getSessionId()).not.toBe('legacy-original'); expect(fs.readFileSync(history, 'utf8')).toBe('Synthetic retained history');
  });
  it('does not load an old ACP pointer because the schedule journal is missing', async () => {
    fs.writeFileSync(pointer(), JSON.stringify({ id: 'old-acp', transport: 'acp' })); executor = make();
    await expect(executor.execute('unsafe')).rejects.toThrow('cannot safely resume'); expect(fixture.runtimes).toHaveLength(0);
    await executor.resetContext(); expect(fs.readdirSync(pointer() + '.detached-acp')).toHaveLength(1);
    await executor.execute('fresh'); await expect(executor.deleteThreadData('synthetic-thread')).rejects.toThrow('Detached');
  });
  it('does not turn an arbitrary worker ACP pointer or absent policy into load permission', async () => {
    fs.writeFileSync(pointer(), JSON.stringify({ id: 'old-acp', transport: 'acp' })); executor = make({ delegationWorker: true });
    await expect(executor.execute('unsafe')).rejects.toThrow('cannot safely resume'); expect(fixture.runtimes).toHaveLength(0);
  });

  it.each(['confirmed', 'replaced', 'unconfirmed'])('retires only its installed main pointer after %s group exit', async outcome => {
    fs.writeFileSync(pointer(), JSON.stringify({ id: 'detached-main', transport: 'acp' }));
    executor = make();
    await executor.resetContext();
    const archive = pointer() + '.detached-acp';
    const evidence = path.join(archive, fs.readdirSync(archive)[0]);
    const original = fs.readFileSync(evidence);
    await executor.execute('fresh');
    const nativeHistory = path.join(last().options.home, 'archived-history');
    fs.writeFileSync(nativeHistory, 'retain');
    expect(executor.canRetireAgySelection('synthetic-thread')).toBe(true);
    let release!: () => void;
    fixture.wait = new Promise(resolve => { release = resolve; });
    fixture.close = outcome === 'unconfirmed';
    const retirement = executor.retireAgySelection('synthetic-thread');
    expect(fs.existsSync(pointer())).toBe(true);
    // Replace even with the same session and generation. Ownership belongs
    // to the selection installed by this executor.
    if (outcome === 'replaced') {
      fs.writeFileSync(pointer() + '.replacement', fs.readFileSync(pointer()));
      fs.renameSync(pointer() + '.replacement', pointer());
    }
    release();
    if (outcome === 'confirmed') await expect(retirement).resolves.toBeUndefined();
    else await expect(retirement).rejects.toThrow(outcome === 'replaced' ? 'changed' : 'unconfirmed');
    expect(fs.existsSync(pointer())).toBe(outcome !== 'confirmed');
    expect(fs.readFileSync(evidence)).toEqual(original);
    expect(fs.readFileSync(nativeHistory, 'utf8')).toBe('retain');
  });

  it('refuses to apply main-thread retirement to a worker executor', async () => {
    executor = make({ delegationWorker: true });
    await executor.execute('worker');
    await expect(executor.retireAgySelection('synthetic-thread')).rejects.toThrow('main thread');
    expect(last().closed).toBe(false);
    expect(fs.existsSync(pointer())).toBe(true);
  });
  it('retains allocation uncertainty across executor reconstruction and blocks clear', async () => {
    fs.writeFileSync(pointer() + '.allocation-unconfirmed', '{}'); executor = make();
    await expect(executor.execute('retry')).rejects.toThrow('allocation'); await expect(executor.resetContext()).rejects.toThrow('allocation');
    expect(fixture.runtimes).toHaveLength(0);
  });
  it('keeps the pointer and refuses new work until exact reset retirement completes', async () => {
    await executor.execute('first'); const original = fs.readFileSync(pointer(), 'utf8'); let release!: () => void;
    fixture.wait = new Promise(resolve => { release = resolve; });
    const reset = executor.resetContext(); await expect(executor.execute('too early')).rejects.toThrow('busy');
    expect(fs.readFileSync(pointer(), 'utf8')).toBe(original); release(); await reset;
    expect(executor.getSessionId()).toBeNull(); expect(fs.existsSync(pointer())).toBe(false);
    await executor.execute('fresh'); expect(fixture.runtimes).toHaveLength(2);
  });
  it('preserves the pointer on failed destroy and allows only exact retirement retry', async () => {
    await executor.execute('first'); fixture.close = true;
    await expect(executor.destroy()).rejects.toThrow('unconfirmed'); expect(executor.hasUncertainShutdown()).toBe(true);
    await expect(executor.execute('no successor')).rejects.toThrow(); expect(fs.existsSync(pointer())).toBe(true);
    fixture.close = false; await executor.destroy(); expect(executor.hasUncertainShutdown()).toBe(false);
  });
  it('summarizes then explicitly resets and consumes its handoff once', async () => {
    await executor.execute('first'); const previous = executor.getSessionId();
    await expect(executor.compactWhenFull()).resolves.toMatchObject({ success: true });
    await executor.execute('next'); expect(executor.getSessionId()).not.toBe(previous);
    expect(last().prompts[0]).toContain('Synthetic output'); expect(last().prompts[0]).toContain('next');
    await executor.execute('plain'); expect(last().prompts[1]).toBe('plain');
  });
  it('reports summary failure honestly and clears a pending seed on explicit clear', async () => {
    await executor.execute('first'); fixture.result = { success: false, output: '' };
    expect((await executor.compactWhenFull()).output).toContain('without carryover');
    fixture.result = { success: true, output: 'Synthetic output' }; await executor.execute('fresh'); await executor.compactWhenFull();
    await executor.resetContext(); await executor.execute('plain'); expect(last().prompts).toEqual(['plain']);
  });
  it('validates working directory and resets context only for an actual directory change', async () => {
    await executor.execute('first'); await executor.setWorkingDirectory(cwd); expect(last().closed).toBe(false);
    const next = path.join(cwd, 'next'); fs.mkdirSync(next); await executor.setWorkingDirectory(next);
    expect(executor.getSessionId()).toBeNull(); expect(executor.getCurrentWorkingDirectory()).toBe(next);
    await expect(executor.setWorkingDirectory(path.dirname(fixture.home))).rejects.toThrow();
  });
  it('preserves supported images for the ACP runtime and does not manufacture output', async () => {
    const attachment = { type: 'image' as const, data: 'synthetic', mimeType: 'image/png' };
    await executor.execute('image', { attachments: [attachment] }); expect(last().optionsSeen[0].attachments).toEqual([attachment]);
  });
  it('runs account helpers and model catalog separately from conversation execution', async () => {
    vi.mocked(execFile).mockImplementation(((command: string, args: string[], options: any, callback: any) => {
      callback(null, args[0] === 'models' ? 'synthetic-model\tSynthetic Model\n' : `Synthetic ${args[1]} output`);
    }) as any);
    expect(await executor.getAccountUsage()).toContain('Synthetic /usage output'); expect(await executor.getAccountUsage()).toContain('Synthetic /credits output');
    expect(await executor.listModels()).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'synthetic-model' })]));
    expect(fixture.runtimes).toHaveLength(0); expect(spawn).not.toHaveBeenCalled();
  });
  it.each([
    { configured: true, inherited: 'false', expected: 'true' },
    { configured: false, inherited: 'true', expected: 'true' },
    { configured: undefined, inherited: 'false', expected: 'false' },
    { configured: undefined, inherited: undefined, expected: undefined },
  ])('passes token storage policy to catalog and account helpers ($configured, $inherited)', async ({
    configured, inherited, expected,
  }) => {
    const key = 'AGY_CLI_FORCE_FILE_TOKEN_STORAGE';
    vi.stubEnv(key, inherited ?? '');
    if (inherited === undefined) delete process.env[key];
    executor = createExecutor(new DirectoryGuard([fixture.home]), { type: 'agy', agy: { forceFileTokenStorage: configured } },
      cwd, 'synthetic-thread') as AgyExecutor;
    const queries: string[][] = [];
    vi.mocked(execFile).mockImplementation(((_command: string, args: string[], options: any, callback: any) => {
      queries.push(args);
      expect(options.env[key]).toBe(expected);
      callback(null, args[0] === 'models' ? 'fixture-model\tFixture Model\n' : 'Fixture usage');
    }) as any);
    await executor.listModels();
    await executor.getAccountUsage();
    await executor.listModels({ threadId: 'synthetic-thread' });
    expect(queries).toEqual([['models'], ['-p', '/usage'], ['-p', '/credits'], ['models']]);

    expect(process.env[key]).toBe(inherited);
  });
  it('refreshes from the selected thread provider settings and working directory on every request', async () => {
    const threadHome = path.join(fixture.home, '.remote-cli', 'agy-homes', 'synthetic-thread');
    const settingsDir = path.join(threadHome, '.gemini', 'antigravity-cli');
    fs.mkdirSync(settingsDir, { recursive: true });
    const settings = path.join(settingsDir, 'settings.json');
    vi.mocked(execFile).mockImplementation(((command: string, args: string[], options: any, callback: any) => {
      expect(command).toBe('agy');
      expect(args).toEqual(['models']);
      expect(options.cwd).toBe(cwd);
      expect(options.env).toMatchObject({ HOME: threadHome, USERPROFILE: threadHome });
      const { model } = JSON.parse(fs.readFileSync(settings, 'utf8'));
      callback(null, model + '\tFixture model\n');
    }) as any);
    for (const model of ['first-provider-model', 'replacement-model']) {
      fs.writeFileSync(settings, JSON.stringify({ model }));
      expect((await executor.listModels()).map(item => item.id)).toEqual([model]);
    }
    const preview = make({ threadId: 'settings-meta-synthetic', delegationWorker: true });
    expect((await preview.listModels({ threadId: 'synthetic-thread' }))[0].id).toBe('replacement-model');
    await expect(preview.listModels({ threadId: '..' })).rejects.toThrow('Invalid AGY catalog thread ID');
    expect(execFile).toHaveBeenCalledTimes(3);
    expect(fixture.runtimes).toHaveLength(0);
  });

  it('queries the account catalog before a thread HOME exists without allocating preview state', async () => {
    const id = 'settings-meta-synthetic';
    executor = make({ threadId: id, delegationWorker: true });
    vi.mocked(execFile).mockImplementation(((_command: string, args: string[], options: any, callback: any) => {
      expect(args).toEqual(['models']);
      expect(options.cwd).toBe(cwd);
      expect(options.env.HOME).toBe(fixture.home);
      callback(null, 'account-model\tAccount Model\n');
    }) as any);
    expect((await executor.listModels())[0].id).toBe('account-model');
    expect(fs.existsSync(path.join(fixture.home, '.remote-cli', 'agy-homes', id))).toBe(false);
    expect(fixture.runtimes).toHaveLength(0);
  });
  it('reports unavailable/invalid informational output without starting chat', async () => {
    vi.mocked(execFile).mockImplementation(((_command: string, _args: string[], _options: any, callback: any) => callback(new Error('Synthetic unavailable'), '')) as any);
    expect(await executor.getAccountUsage()).toBeNull(); await expect(executor.listModels()).rejects.toThrow('Failed to list');
    vi.mocked(execFile).mockImplementation(((_command: string, _args: string[], _options: any, callback: any) => callback(null, '')) as any);
    await expect(executor.listModels()).rejects.toThrow('no usable');
  });
  it('keeps factory precedence, manual approvals and worker policy without enabling legacy transport', async () => {
    executor = createExecutor(new DirectoryGuard([fixture.home]), { type: 'agy', agy: { model: 'global', autoApprove: false } }, cwd, 'synthetic-thread', 'thread-model', 'high', { delegationWorker: true }) as AgyExecutor;
    expect(executor.getExecutionMetadata()).toMatchObject({ model: 'thread-model', reasoningEffort: 'high' });
    await executor.execute('worker'); expect(last().options).toMatchObject({ worker: true, autoApprove: false });
    await expect(executor.configureManagedTools({ url: 'http://127.0.0.1:1', token: 'synthetic' })).rejects.toThrow('cannot register');
  });
  it('does not execute legacy unscoped chat or start after destruction', async () => {
    executor = new AgyExecutor(new DirectoryGuard([fixture.home]), { initialWorkingDirectory: cwd });
    await expect(executor.execute('unscoped')).rejects.toThrow('thread-scoped'); await executor.destroy();
    await expect(executor.execute('closed')).rejects.toThrow('destroyed'); expect(await executor.abort()).toBe(false);
  });
});

describe('AGY recovery through Feishu commands', () => {
  let handler: MessageHandler;
  beforeEach(prepareFixture);
  afterEach(async () => {
    fixture.close = false;
    try { await handler?.destroy(); } finally { await disposeFixture(); }
  });

  it('fences a failed backend switch until same-thread clear confirms exit and admits one fresh prompt', async () => {
    const config = await ConfigManager.initialize();
    await config.set('executor', { type: 'agy' });
    const manager = await ThreadManager.initialize(fixture.home);
    const threadId = (await manager.createThread('recovery', cwd, 'agy')).id;
    await manager.updateThread(threadId, { delegation: false });
    const guard = new DirectoryGuard([cwd]);
    const pool = new ThreadExecutorPool(manager, guard, { type: 'agy' });
    const socket = new WebSocketClient('ws://127.0.0.1', 'synthetic-device');
    const frames = vi.spyOn(socket, 'send').mockReturnValue(true);
    handler = new MessageHandler(socket, pool, manager, guard, config);
    let sequence = 0;
    const send = async (content: string, caller = threadId) => {
      const messageId = `recovery-${++sequence}`;
      await handler.handleMessage({ type: 'command', messageId, threadId: caller, openId: 'synthetic-owner',
        content, isSlashCommand: content.startsWith('/'), timestamp: Date.now() });
      const responses = frames.mock.calls.map(([frame]) => frame).filter(frame => frame.type === 'response' && frame.messageId === messageId);
      expect(responses).toHaveLength(1);
      expect(responses[0].threadId).toBe(caller);
      return responses[0];
    };
    expect(await send('Before switch')).toMatchObject({ success: true });
    const old = last();
    expect(old.prompts).toHaveLength(1);
    expect(old.prompts[0]).toContain('Before switch');
    const originalPrompt = old.prompts[0];
    const history = path.join(old.options.home, 'original-history');
    fs.writeFileSync(history, 'Synthetic native history');
    const selection = path.join(config.getConfigDir(), 'agy-sessions', threadId + '.json');
    const originalSelection = fs.readFileSync(selection);
    expect(JSON.parse(originalSelection.toString()).id).toBe(old.sessionId);

    vi.mocked(execFile).mockImplementation(((cmd: string, _args: string[], _options: unknown, done: (error: Error | null) => void) => {
      done(cmd === 'codex' ? null : new Error('Synthetic unavailable backend'));
    }) as typeof execFile);
    fixture.close = true;
    expect(await send('/backend 1 @')).toMatchObject({ success: false, error: expect.stringContaining('retry /clear in the original thread') });
    expect(pool.getBackendKey(threadId)).toBe('agy');
    for (const caller of [threadId, manager.getDefaultThread().id]) {
      expect(await send('/thread delete recovery', caller)).toMatchObject({ success: false, error: expect.stringContaining('retry /clear in that thread') });
    }
    expect(manager.getThreadByName('recovery')?.id).toBe(threadId);
    expect(await send('/clear')).toMatchObject({ success: false, error: expect.stringContaining('AGY host retirement is unconfirmed') });
    expect(await send('While retirement is unresolved')).toMatchObject({ success: false, error: expect.stringContaining('incomplete') });
    expect(old.closed).toBe(false);
    expect(fs.readFileSync(selection)).toEqual(originalSelection);
    expect(old.prompts).toEqual([originalPrompt]);
    expect(fixture.runtimes).toHaveLength(1);

    fixture.close = false;
    expect(await send('/clear')).toMatchObject({ success: true });
    expect(old.closed).toBe(true);
    expect(manager.contextResets.isPending(threadId)).toBe(false);
    expect(await send('After confirmed retirement')).toMatchObject({ success: true });
    expect(fixture.runtimes).toHaveLength(2);
    expect(last().sessionId).not.toBe(old.sessionId);
    expect(last().prompts).toEqual([expect.stringContaining('After confirmed retirement')]);
    expect(old.prompts).toEqual([originalPrompt]);
    expect(fs.readFileSync(history, 'utf8')).toBe('Synthetic native history');
  });
});
