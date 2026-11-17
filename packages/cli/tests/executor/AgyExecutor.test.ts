import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { AgyExecutor } from '../../src/executor/AgyExecutor';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { createExecutor } from '../../src/executor';
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
beforeEach(() => {
  fixture.home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-acp-executor-')));
  vi.stubEnv('HOME', fixture.home); vi.stubEnv('USERPROFILE', fixture.home);
  cwd = path.join(fixture.home, 'workspace'); fs.mkdirSync(cwd);
  fixture.runtimes = []; fixture.startup = false; fixture.close = false; fixture.wait = undefined; fixture.promptWait = undefined; fixture.saved = undefined;
  fixture.result = { success: true, output: 'Synthetic output' }; fixture.id = 0;
  vi.clearAllMocks(); executor = make();
});
afterEach(async () => { fixture.wait = undefined; fixture.close = false; await executor.destroy(); vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(fixture.home, { recursive: true, force: true }); });
describe('AGY ACP-only executor policies', () => {
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
