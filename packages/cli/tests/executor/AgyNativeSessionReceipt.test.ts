import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { AgyExecutor } from '../../src/executor/AgyExecutor';
import type { DirectoryGuard } from '../../src/security/DirectoryGuard';
import type { AgyDeletionTarget } from '../../src/delegation/AgySessionDeletion';


// These tests supply EventEmitter processes, not OS workers. Native admission and
// containment are exercised by ManagedSpawn.native.test.ts on each native runner.
vi.mock('../../src/executor/ManagedSpawn', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/executor/ManagedSpawn')>();
  const { ownedSpawn } = await import('../../src/delegation/OwnershipRuntime');
  return { ...actual, spawnManaged: (_enabled: boolean, ...args: Parameters<typeof ownedSpawn>) => ownedSpawn(...args) };
});

vi.mock('child_process', () => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock('os', async importOriginal => {
  const actual = await importOriginal<typeof import('os')>();
  const homedir = vi.fn(() => { throw new Error('Synthetic HOME must be configured before executor construction'); });
  return { ...actual, homedir, default: { ...actual, homedir } };
});
vi.mock('../../src/executor/ManagedProcessGroups', () => ({ ManagedProcessGroups: class {
  track() {}
  async waitForExit() {}
} }));

const ID = '11111111-1111-4111-8111-111111111111';
const NEXT = '22222222-2222-4222-8222-222222222222';
const LANE = 'delegate-lane-33333333-3333-4333-8333-333333333333';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('AGY managed native creation receipts', () => {
  let home: string;
  let scope: string;
  let executor: AgyExecutor;
  let proc: any;
  let targets: AgyDeletionTarget[];
  let failures: ReturnType<typeof vi.fn>;
  let releases: Array<() => void>;
  const emit = (event: unknown, source = proc) => source.stdout.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
  const initialize = (id = ID) => {
    fs.mkdirSync(path.join(scope, 'conversations'), { recursive: true });
    fs.writeFileSync(path.join(scope, 'conversations', `${id}.db`), 'SQLite format 3\0synthetic');
    emit({ event: 'init', conversation_id: id });
  };
  const finish = (id: string | undefined = ID) => emit({ event: 'result', result: { status: 'SUCCESS', conversation_id: id, response: 'output' } });
  const observe = (callback = async (target: AgyDeletionTarget) => { targets.push(target); }) => {
    executor.observeNativeSessionCreation(callback, failures);
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    home = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agy-receipt-test-')));
    vi.mocked(os.homedir).mockReturnValue(home);
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('synthetic absent group'), { code: 'ESRCH' }); });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    targets = [];
    failures = vi.fn(async () => {});
    releases = [];
    vi.mocked(spawn).mockImplementation(() => {
      proc = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(), stderr: new EventEmitter(),
        stdin: Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() }),
        pid: 987654,
      });
      const child = proc;
      child.kill = vi.fn(() => { child.emit('exit', 0, null); child.emit('close'); return true; });
      return child;
    });
    const guard = { resolveWorkingDirectory: () => home } as unknown as DirectoryGuard;
    executor = new AgyExecutor(guard, { threadId: LANE, initialWorkingDirectory: home, delegationWorker: true });
    scope = path.join(home, '.remote-cli', 'agy-homes', LANE, '.gemini', 'antigravity-cli');
  });

  afterEach(async () => {
    for (const release of releases) release();
    await executor.destroy();
    await executor.waitForExit();
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('accepts init after the prompt, persists before success, and reuses the same child before reset', async () => {
    const saved = deferred();
    releases.push(saved.resolve);
    observe(async target => { targets.push(target); await saved.promise; });
    let settled = false;
    const first = executor.execute('first').then(result => { settled = true; return result; });
    expect(proc.stdin.write).toHaveBeenCalledOnce();
    initialize();
    finish();
    await vi.waitFor(() => expect(targets).toHaveLength(1));
    expect(settled).toBe(false);
    await expect(executor.waitForManagedProcessGroupExit()).rejects.toThrow('coverage');
    saved.resolve();
    expect((await first).success).toBe(true);
    const second = executor.execute('second');
    finish();
    expect((await second).success).toBe(true);
    expect(spawn).toHaveBeenCalledOnce();
    expect(targets).toHaveLength(1);
    expect(targets[0].sessionId).toBe(ID);
    expect(failures).not.toHaveBeenCalled();
  });

  it('drains admitted observations before clearing the pointer and ignores late events from the old process', async () => {
    const saved = deferred();
    releases.push(saved.resolve);
    observe(async target => { targets.push(target); await saved.promise; });
    const running = executor.execute('first');
    initialize();
    await vi.waitFor(() => expect(targets).toHaveLength(1));
    const old = proc;
    let resetDone = false;
    const resetting = executor.resetContext().then(() => { resetDone = true; });
    expect(resetDone).toBe(false);
    expect(fs.existsSync(targets[0].pointer)).toBe(true);
    emit({ event: 'init', conversation_id: NEXT }, old);
    saved.resolve();
    await resetting;
    expect((await running).success).toBe(false);
    expect(fs.existsSync(targets[0].pointer)).toBe(false);
    const second = executor.execute('new context');
    initialize(NEXT);
    finish(NEXT);
    expect((await second).success).toBe(true);
    expect(targets.map(target => target.sessionId)).toEqual([ID, NEXT]);
    expect((vi.mocked(spawn).mock.calls[1][1] as string[])).not.toContain('--conversation');
  });

  it('captures a first identity supplied only by the result event', async () => {
    observe();
    const running = executor.execute('first');
    fs.mkdirSync(path.join(scope, 'conversations'), { recursive: true });
    fs.writeFileSync(path.join(scope, 'conversations', `${ID}.db`), 'SQLite format 3\0synthetic');
    finish();
    expect((await running).success).toBe(true);
    expect(targets.map(target => target.sessionId)).toEqual([ID]);
  });

  it('reports missing or malformed native identities and does not pretend successful receipt persistence', async () => {
    observe();
    const running = executor.execute('first');
    emit({ event: 'init', conversation_id: '../invalid' });
    finish('../invalid');
    expect((await running).success).toBe(false);
    expect(failures).toHaveBeenCalledOnce();
    expect(targets).toHaveLength(0);
  });

  it('persists coverage failure when reset interrupts startup before init', async () => {
    observe();
    const running = executor.execute('first');
    const old = proc;
    await executor.resetContext();
    emit({ event: 'init', conversation_id: ID }, old);
    expect((await running).success).toBe(false);
    expect(failures).toHaveBeenCalledOnce();
    expect(targets).toHaveLength(0);
  });

  it('blocks exit proof when durable failure reporting also fails', async () => {
    executor.observeNativeSessionCreation(async () => { throw new Error('receipt failure'); }, async () => { throw new Error('failure receipt failure'); });
    const running = executor.execute('first');
    initialize();
    finish();
    expect((await running).success).toBe(false);
    await executor.destroy();
    await expect(executor.waitForManagedProcessGroupExit()).rejects.toThrow('coverage');
  });

  it('never adopts an existing database as freshly created', async () => {
    fs.mkdirSync(path.join(scope, 'conversations'), { recursive: true });
    fs.writeFileSync(path.join(scope, 'conversations', `${ID}.db`), 'preexisting');
    observe();
    const running = executor.execute('first');
    initialize();
    finish();
    expect((await running).success).toBe(false);
    expect(targets).toHaveLength(0);
    expect(failures).toHaveBeenCalledOnce();
  });

  it('does not recapture a persisted resume pointer as fresh ownership', async () => {
    await executor.destroy();
    fs.mkdirSync(path.join(scope, 'conversations'), { recursive: true });
    fs.writeFileSync(path.join(scope, 'conversations', `${ID}.db`), 'existing');
    // Legacy cache links are retained without breaking ordinary context reuse.
    const sharedCache = path.join(home, 'legacy-shared-cache');
    fs.mkdirSync(sharedCache);
    fs.symlinkSync(sharedCache, path.join(scope, 'cache'), 'dir');
    fs.writeFileSync(path.join(home, '.remote-cli', 'agy-sessions', `${LANE}.json`), JSON.stringify({ id: ID, adopted: true }));
    executor = new AgyExecutor({ resolveWorkingDirectory: () => home } as unknown as DirectoryGuard,
      { threadId: LANE, initialWorkingDirectory: home, delegationWorker: true });
    observe();
    const running = executor.execute('resume');
    initialize();
    finish();
    expect((await running).success).toBe(true);
    expect(targets).toHaveLength(0);
    expect(await fs.promises.realpath(path.join(scope, 'cache'))).toBe(sharedCache);
    expect(vi.mocked(spawn).mock.calls[0][1]).toContain('--conversation');
  });

  it('keeps new turns usable in a legacy shared-cache lane without authorizing deletion', async () => {
    const sharedCache = path.join(home, 'legacy-shared-cache');
    fs.mkdirSync(sharedCache);
    fs.mkdirSync(scope, { recursive: true });
    fs.symlinkSync(sharedCache, path.join(scope, 'cache'), 'dir');
    observe();
    const running = executor.execute('new conversation after legacy context reset');
    initialize();
    finish();
    expect((await running).success).toBe(true);
    expect(targets).toHaveLength(1);
    expect(failures).not.toHaveBeenCalled();
    expect(await fs.promises.realpath(path.join(scope, 'cache'))).toBe(sharedCache);
    const { deleteOwnedAgySession } = await import('../../src/delegation/AgySessionDeletion');
    const result = await deleteOwnedAgySession(targets[0], {
      confirmedProcessGroupExit: true, persistPrepared: async () => {},
    });
    expect(result.state).toBe('held');
    expect(fs.existsSync(targets[0].createdFile.path)).toBe(true);
  });

  it('uses a private worker cache and preserves shared settings and managed deliverables', async () => {
    const shared = path.join(home, '.gemini', 'antigravity-cli');
    fs.mkdirSync(path.join(shared, 'cache'), { recursive: true });
    fs.writeFileSync(path.join(shared, 'settings.json'), 'synthetic settings');
    observe();
    const running = executor.execute('first');
    initialize();
    finish();
    expect((await running).success).toBe(true);
    expect(fs.lstatSync(path.join(scope, 'cache')).isDirectory()).toBe(true);
    expect(await fs.promises.realpath(path.join(scope, 'cache'))).toBe(path.join(scope, 'cache'));
    expect(await fs.promises.realpath(path.join(scope, 'settings.json'))).toBe(path.join(shared, 'settings.json'));
    fs.mkdirSync(path.join(scope, 'brain', ID), { recursive: true });
    fs.writeFileSync(path.join(scope, 'brain', ID, 'output.md'), 'required deliverable');
    await executor.deleteThreadData(LANE);
    expect(fs.readFileSync(path.join(scope, 'brain', ID, 'output.md'), 'utf8')).toBe('required deliverable');
    expect(fs.readFileSync(path.join(shared, 'settings.json'), 'utf8')).toBe('synthetic settings');
  });
});
