import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AgyExecutor } from '../../src/executor/AgyExecutor';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import type { AgyDeletionTarget } from '../../src/delegation/AgySessionDeletion';
const state = vi.hoisted(() => ({ home: '', id: '11111111-1111-4111-8111-111111111111', clients: [] as any[], lostReply: false, group: true, promptWait: undefined as Promise<void> | undefined }));
vi.mock('os', async load => { const actual = await load<typeof import('os')>(); return { ...actual, homedir: () => state.home, default: { ...actual, homedir: () => state.home } }; });
vi.mock('../../src/executor/agy/AgyAcpRuntime', () => ({ AgyAcpRuntime: class {
  running = false; closed = false; prompts: string[] = []; allocationUnconfirmed = false; started = false;
  constructor(public options: any) { state.clients.push(this); }
  async start() {
    if (this.started) return; this.started = true; this.running = true;
    if (!this.options.sessionId) this.options.beforeAllocation?.();
    if (state.lostReply) { this.allocationUnconfirmed = true; this.running = false; throw new Error('Synthetic lost allocation reply'); }
    const store = path.join(this.options.home, '.gemini', 'antigravity-cli', 'conversations'); fs.mkdirSync(store, { recursive: true });
    if (!this.options.sessionId) fs.writeFileSync(path.join(store, `${state.id}.db`), 'SQLite format 3\0synthetic');
    try { await this.options.saveSession(this.options.sessionId ?? state.id); }
    catch (error) { this.running = false; throw error; }
  }
  async execute(prompt: string, options: any) {
    this.options.beforePrompt?.(); this.prompts.push(options.resolvePrompt?.(this.options.sessionId ?? state.id) ?? prompt);
    await state.promptWait; this.options.settledPrompt?.(true); return { success: true, output: 'Synthetic terminal' };
  }
  async close() { if (!state.group) throw new Error('Unconfirmed group'); this.running = false; this.closed = true; this.options.ownedSessionClosed(this.options.sessionId ?? state.id); }
  async waitForManagedProcessGroupExit() { if (!state.group) throw new Error('Unconfirmed group'); }
} }));
const lane = 'delegate-lane-33333333-3333-4333-8333-333333333333';
let executor: AgyExecutor, targets: AgyDeletionTarget[], failures: ReturnType<typeof vi.fn>;
const make = () => new AgyExecutor(new DirectoryGuard([state.home]), { threadId: lane, initialWorkingDirectory: state.home, delegationWorker: true });
const pointer = () => path.join(state.home, '.remote-cli', 'agy-sessions', `${lane}.json`);
const observe = (callback = async (target: AgyDeletionTarget) => { targets.push(target); }) => executor.observeNativeSessionCreation(callback, failures);
beforeEach(() => {
  state.home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-receipt-'))); vi.stubEnv('HOME', state.home); vi.stubEnv('USERPROFILE', state.home);
  state.clients = []; state.lostReply = false; state.group = true; state.promptWait = undefined;
  targets = []; failures = vi.fn(async () => {}); executor = make();
});
afterEach(async () => { state.group = true; await executor.destroy(); vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(state.home, { recursive: true, force: true }); });
describe('ACP worker creation receipts before dispatch', () => {
  it('waits for the formal receipt before first prompt, preserving native inode and pointer hash', async () => {
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    observe(async target => { targets.push(target); await held; });
    const pending = executor.execute('first'); await vi.waitFor(() => expect(targets).toHaveLength(1));
    expect(state.clients[0].prompts).toEqual([]); expect(fs.existsSync(targets[0].createdFile.path)).toBe(true);
    expect(targets[0].sessionId).toBe(state.id); expect(targets[0].pointerHash).toMatch(/^[a-f0-9]{64}$/);
    await expect(executor.resetContext()).rejects.toThrow('pending');
    release(); expect((await pending).success).toBe(true); expect(failures).not.toHaveBeenCalled();
  });
  it('loads an eligible same-policy worker without recapturing ownership or rewriting its pointer', async () => {
    observe(); await executor.execute('fixed policy plus task'); const original = fs.readFileSync(pointer(), 'utf8');
    await executor.destroy(); executor = make(); const loadedObserver = vi.fn(); observe(loadedObserver);
    await executor.execute('next task', { resolvePrompt: id => id === state.id ? 'dynamic task only' : 'fixed' });
    expect(state.clients[1].options.sessionId).toBe(state.id); expect(state.clients[1].prompts).toEqual(['dynamic task only']);
    expect(loadedObserver).not.toHaveBeenCalled(); expect(fs.readFileSync(pointer(), 'utf8')).toBe(original);
    expect(targets).toHaveLength(1);
  });
  it('refuses a pre-fix continuity receipt even if its old flags claimed settlement', async () => {
    observe(); await executor.execute('old task'); await executor.destroy();
    const file = pointer() + '.worker-policy'; const proof = JSON.parse(fs.readFileSync(file, 'utf8'));
    proof.policy = 'hook-denial-v1'; fs.writeFileSync(file, JSON.stringify(proof)); executor = make();
    await expect(executor.execute('next task')).rejects.toThrow('explicit /clear'); expect(state.clients).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).policy).toBe('hook-denial-v1');
  });
  it('refuses a previously existing database as a new creation receipt before prompt', async () => {
    const store = path.join(state.home, '.remote-cli', 'agy-homes', lane, '.gemini', 'antigravity-cli', 'conversations');
    fs.mkdirSync(store, { recursive: true }); fs.writeFileSync(path.join(store, `${state.id}.db`), 'Synthetic existing data');
    observe(); await expect(executor.execute('unsafe')).rejects.toThrow('receipt');
    expect(targets).toEqual([]); expect(failures).toHaveBeenCalledOnce(); expect(state.clients[0].prompts).toEqual([]);
  });
  it('keeps ambiguous allocation evidence across restart without retrying or clearing', async () => {
    observe(); state.lostReply = true;
    await expect(executor.execute('uncertain')).rejects.toThrow('lost'); expect(failures).toHaveBeenCalledOnce();
    expect(fs.existsSync(pointer() + '.allocation-unconfirmed')).toBe(true); await executor.destroy();
    executor = make(); await expect(executor.execute('retry')).rejects.toThrow('allocation');
    await expect(executor.resetContext()).rejects.toThrow('allocation'); expect(state.clients).toHaveLength(1);
  });
  it('preserves native receipt failures and refuses process-group disposal proof', async () => {
    observe(async () => { throw new Error('Synthetic persistence failure'); });
    await expect(executor.execute('task')).rejects.toThrow('receipt'); await executor.destroy();
    await expect(executor.waitForManagedProcessGroupExit()).rejects.toThrow('unconfirmed');
    expect(failures).toHaveBeenCalledOnce(); expect(fs.existsSync(pointer())).toBe(true);
  });
  it('retains group uncertainty and refuses a replacement worker after unconfirmed close', async () => {
    observe(); await executor.execute('task'); state.group = false;
    await expect(executor.destroy()).rejects.toThrow('Unconfirmed');
    const replacement = make(); await expect(replacement.execute('unsafe')).rejects.toThrow('cannot safely resume');
    expect(state.clients).toHaveLength(1); await replacement.destroy();
  });
  it('invalidates settled eligibility before prompt and never infers safety from a missing policy', async () => {
    observe(); let release!: () => void; state.promptWait = new Promise(resolve => { release = resolve; });
    const work = executor.execute('held'); await vi.waitFor(() => expect(state.clients[0]?.prompts).toHaveLength(1));
    const proof = JSON.parse(fs.readFileSync(pointer() + '.worker-policy', 'utf8')); expect(proof.settled).toBe(false);
    const replacement = make(); await expect(replacement.execute('unsafe')).rejects.toThrow('cannot safely resume'); await replacement.destroy();
    release(); await work; await executor.destroy(); fs.unlinkSync(pointer() + '.worker-policy'); executor = make();
    await expect(executor.execute('missing evidence')).rejects.toThrow('cannot safely resume');
  });
  it('does not erase original history on legacy refusal or explicit pointer reset', async () => {
    fs.writeFileSync(pointer(), JSON.stringify({ id: state.id })); executor = make(); observe();
    await expect(executor.execute('legacy')).rejects.toThrow('worker card Clear'); await executor.resetContext();
    expect(failures).not.toHaveBeenCalled(); expect(state.clients).toHaveLength(0);
    await executor.execute('new'); expect(targets).toHaveLength(1);
  });
  it('keeps shared-cache history observable but never turns it into private deletion authority', async context => {
    const master = path.join(state.home, '.gemini', 'antigravity-cli'); fs.mkdirSync(path.join(master, 'cache'), { recursive: true });
    const scope = path.join(state.home, '.remote-cli', 'agy-homes', lane, '.gemini', 'antigravity-cli'); fs.mkdirSync(scope, { recursive: true });
    try { fs.symlinkSync(path.join(master, 'cache'), path.join(scope, 'cache'), 'dir'); }
    catch (error) { if (process.platform === 'win32' && ['EPERM','EACCES'].includes((error as any).code)) { context.skip(); return; } throw error; }
    observe(); await executor.execute('task'); expect(targets).toHaveLength(1);
    const { verifyAgyDeletionTarget } = await import('../../src/delegation/AgySessionDeletion');
    await expect(verifyAgyDeletionTarget(targets[0])).rejects.toThrow();
  });
});
