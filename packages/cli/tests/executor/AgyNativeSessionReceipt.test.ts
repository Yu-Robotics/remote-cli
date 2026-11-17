import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { AgyExecutor } from '../../src/executor/AgyExecutor';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import type { AgyDeletionTarget } from '../../src/delegation/AgySessionDeletion';
const state = vi.hoisted(() => ({ home: '', id: '11111111-1111-4111-8111-111111111111', clients: [] as any[], captureError: undefined as string | undefined, lostReply: false, group: true, promptWait: undefined as Promise<void> | undefined, promptStarted: undefined as (() => void) | undefined }));
vi.mock('os', async load => { const actual = await load<typeof import('os')>(); return { ...actual, homedir: () => state.home, default: { ...actual, homedir: () => state.home } }; });
// Keep real capture/verification. Expose only known path-free error categories in
// this fixture; production deliberately suppresses nested filesystem messages.
vi.mock('../../src/delegation/AgySessionDeletion', async load => {
  const actual = await load<typeof import('../../src/delegation/AgySessionDeletion')>();
  return { ...actual, captureAgyDeletionTarget: async (input: Parameters<typeof actual.captureAgyDeletionTarget>[0]) => {
    try { return await actual.captureAgyDeletionTarget(input); }
    catch (error) {
      const message = error instanceof Error ? error.message : '';
      const allowed = ['Native path is redirected', 'Native path type or links changed',
        'Native path ownership is unavailable', 'AGY native home changed', 'AGY metadata changed',
        'AGY pointer changed', 'Native root identity changed', 'Invalid AGY creation identity'];
      const code = (error as NodeJS.ErrnoException)?.code;
      state.captureError = allowed.includes(message) ? message
        : ['ENOENT', 'EPERM', 'EACCES', 'ELOOP', 'EINVAL'].includes(code ?? '') ? `Filesystem ${code}` : 'Other capture failure';
      throw error;
    }
  } };
});
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
    catch (error) { this.running = false; throw new Error(state.captureError ? `AGY receipt fixture: ${state.captureError}` : (error as Error).message); }
  }
  async execute(prompt: string, options: any) {
    this.options.beforePrompt?.(); this.prompts.push(options.resolvePrompt?.(this.options.sessionId ?? state.id) ?? prompt);
    state.promptStarted?.();
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
beforeEach(async () => {
  // The native realpath API also resolves Windows directory spelling/aliases.
  // The JS realpathSync walker only resolves links and can retain that spelling.
  state.home = await fs.promises.realpath(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-receipt-'))); vi.stubEnv('HOME', state.home); vi.stubEnv('USERPROFILE', state.home);
  state.clients = []; state.captureError = undefined; state.lostReply = false; state.group = true; state.promptWait = undefined; state.promptStarted = undefined;
  targets = []; failures = vi.fn(async () => {}); executor = make();
});
afterEach(async () => { state.group = true; await executor.destroy(); vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(state.home, { recursive: true, force: true }); });
describe('ACP worker creation receipts before dispatch', () => {
  it('waits for the formal receipt before first prompt, preserving native inode and pointer hash', async () => {
    let release!: () => void, received!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const receipt = new Promise<void>(resolve => { received = resolve; });
    observe(async target => { targets.push(target); received(); await held; });
    const pending = executor.execute('first');
    await Promise.race([receipt, pending.then(() => { throw new Error('Prompt completed before receipt gate'); })]);
    expect(targets).toHaveLength(1);
    expect(state.clients[0].prompts).toEqual([]); expect(fs.existsSync(targets[0].createdFile.path)).toBe(true);
    expect(targets[0].sessionId).toBe(state.id);
    expect(targets[0].pointerHash).toBe(createHash('sha256').update(fs.readFileSync(pointer())).digest('hex'));
    const stat = fs.statSync(targets[0].createdFile.path, { bigint: true });
    expect(targets[0].createdFile).toMatchObject({ dev: String(stat.dev), ino: String(stat.ino) });
    await expect(executor.resetContext()).rejects.toThrow('pending');
    release(); expect((await pending).success).toBe(true); expect(failures).not.toHaveBeenCalled();
  });
  it('uses the native canonical fixture HOME and preserves strict alias rejection before prompt', async () => {
    expect(state.home).toBe(await fs.promises.realpath(state.home));
    expect(os.homedir()).toBe(state.home); expect(process.env.USERPROFILE).toBe(state.home);
    const realpath = fs.promises.realpath.bind(fs.promises);
    // Model the Windows JS-walker/native-realpath spelling discrepancy without
    // accepting a case-folded identity or touching any external filesystem path.
    vi.spyOn(fs.promises, 'realpath').mockImplementation(async file =>
      String(file) === state.home ? state.home + '-different-spelling' : realpath(file));
    observe(); await expect(executor.execute('refuse alias')).rejects.toThrow('Native path is redirected');
    expect(state.captureError).toBe('Native path is redirected');
    expect(targets).toEqual([]); expect(failures).toHaveBeenCalledOnce(); expect(state.clients[0].prompts).toEqual([]);
    await executor.destroy(); await expect(executor.waitForManagedProcessGroupExit()).rejects.toThrow('unconfirmed');
  });

  it.runIf(process.platform === 'win32')('reproduces the Windows noncanonical drive spelling refusal without weakening receipt checks', async () => {
    const canonical = state.home;
    const alias = canonical[0] === canonical[0].toUpperCase()
      ? canonical[0].toLowerCase() + canonical.slice(1) : canonical[0].toUpperCase() + canonical.slice(1);
    expect(fs.realpathSync(alias)).toBe(alias);
    expect(await fs.promises.realpath(alias)).toBe(canonical);
    await executor.destroy(); state.home = alias; executor = make(); observe();
    await expect(executor.execute('refuse noncanonical home')).rejects.toThrow('Native path is redirected');
    expect(targets).toEqual([]); expect(state.clients[0].prompts).toEqual([]);
    expect(failures).toHaveBeenCalledOnce();
    // Preserve the failed lane's pointer and evidence. A separate canonical
    // fixture proves the ordinary path; never clear uncertain allocation here.
    state.home = canonical;
  });

  it('refuses a replaced creation root even when capture itself returns a valid receipt', async () => {
    const { captureAgyDeletionTarget } = await import('../../src/delegation/AgySessionDeletion');
    const actual = captureAgyDeletionTarget;
    vi.spyOn(await import('../../src/delegation/AgySessionDeletion'), 'captureAgyDeletionTarget').mockImplementation(async input => {
      const target = await actual(input); return { ...target, scope: { ...target.scope, ino: `${BigInt(target.scope.ino) + 1n}` } };
    });
    observe(); await expect(executor.execute('refuse replacement')).rejects.toThrow('receipt');
    expect(targets).toEqual([]); expect(failures).toHaveBeenCalledOnce(); expect(state.clients[0].prompts).toEqual([]);
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
    let release!: () => void; state.promptWait = new Promise(resolve => { release = resolve; });
    let releaseReceipt!: () => void, enteredReceipt!: () => void;
    const receiptGate = new Promise<void>(resolve => { releaseReceipt = resolve; });
    const receiptEntered = new Promise<void>(resolve => { enteredReceipt = resolve; });
    const promptStarted = new Promise<void>(resolve => { state.promptStarted = resolve; });
    observe(async target => { targets.push(target); enteredReceipt(); await receiptGate; });
    const work = executor.execute('held');
    const unexpectedCompletion = work.then(() => { throw new Error('Held turn completed before prompt gate'); });
    await Promise.race([receiptEntered, unexpectedCompletion]);
    expect(state.clients[0].prompts).toEqual([]);
    releaseReceipt();
    // Observe the actual dispatch boundary, not a one-second filesystem polling budget.
    await Promise.race([promptStarted, unexpectedCompletion]);
    expect(state.clients[0].prompts).toHaveLength(1);
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
