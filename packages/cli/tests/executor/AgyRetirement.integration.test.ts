import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { once } from 'events';
import { AgyExecutor } from '../../src/executor/AgyExecutor';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
const fixture = vi.hoisted(() => ({ home: '', script: '', children: [] as ChildProcess[], restored: vi.fn() }));
vi.mock('os', async load => { const actual = await load<typeof import('os')>(); return { ...actual, homedir: () => fixture.home, default: { ...actual, homedir: () => fixture.home } }; });
vi.mock('../../src/executor/ManagedSpawn', async load => {
  const actual = await load<typeof import('../../src/executor/ManagedSpawn')>();
  return { ...actual, spawnManaged: (enabled: boolean, _command: string, args: string[], options: any) => {
    // Reject arbitrary backend selection; the only executable is this owned Node fixture.
    if (_command !== 'synthetic-agy-acp') throw new Error('Unexpected native backend command');
    const child = actual.spawnManaged(enabled, process.execPath, [fixture.script, ...args], options);
    fixture.children.push(child); return child;
  } };
});
vi.mock('../../src/scheduling/agy/AgyHookRelay', () => ({
  AgyHookRelay: class { async start() { return { url: 'http://127.0.0.1:1/hook', token: 'synthetic' }; } bindSession() {} async close() {} },
  installAgyScheduleHooks: async (...args: any[]) => {
    const actual = await vi.importActual<any>('../../src/scheduling/agy/AgyHookRelay');
    const lease = await actual.installAgyScheduleHooks(...args);
    return Object.assign(async () => { await lease(); fixture.restored(); }, { run: (callback: () => unknown) => lease.run(callback) });
  },
}));
vi.mock('../../src/delegation/OwnershipRuntime', async load => {
  const actual = await load<typeof import('../../src/delegation/OwnershipRuntime')>();
  const { syntheticOwnershipRuntime } = await import('../delegation/syntheticOwnershipRuntime');
  return syntheticOwnershipRuntime(actual);
});
let executor: AgyExecutor;
beforeEach(() => {
  fixture.home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-retirement-')));
  vi.stubEnv('HOME', fixture.home); vi.stubEnv('USERPROFILE', fixture.home);
  fixture.script = path.join(fixture.home, 'fixture.cjs'); fixture.children = []; fixture.restored.mockClear();
  fs.writeFileSync(fixture.script, `
const readline = require('node:readline');
const send = x => process.stdout.write(JSON.stringify(x) + '\\n');
setInterval(() => {}, 1000);
process.on('SIGTERM', () => require('node:fs').writeFileSync(require('node:path').join(process.env.HOME, 'signal-received'), 'yes'));
readline.createInterface({input:process.stdin}).on('line', line => {
 const request=JSON.parse(line);
 if(request.method==='fixture_exit') process.exit(0);
 if(request.method==='initialize') send({jsonrpc:'2.0',id:request.id,result:{}});
 if(request.method==='session/new') send({jsonrpc:'2.0',id:request.id,result:{sessionId:'synthetic-session',configOptions:[]}});
});`);
  executor = new AgyExecutor(new DirectoryGuard([fixture.home]), { threadId: 'synthetic-thread', initialWorkingDirectory: fixture.home, agyCommand: 'synthetic-agy-acp' });
});
afterEach(async () => {
  for (const child of fixture.children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const closed = once(child, 'close'); child.kill('SIGKILL'); await closed;
  }
  await executor.destroy(); vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(fixture.home, { recursive: true, force: true });
});
describe('AGY ACP exact OS process retirement', () => {
  it('joins the exact ACP group before releasing hooks and prevents a successor', async () => {
    const runtime = await (executor as any).runtime(); await runtime.start();
    const child = fixture.children[0];
    let closed = false; const closing = executor.destroy().then(() => { closed = true; });
    if (process.platform === 'linux') {
      await vi.waitFor(() => expect(fs.existsSync(path.join((runtime as any).options.home, 'signal-received'))).toBe(true));
      expect(closed).toBe(false);
    }
    expect(executor.getSessionId()).toBe('synthetic-session'); if (process.platform === 'linux') expect(fixture.restored).not.toHaveBeenCalled();
    await expect(executor.execute('no successor')).rejects.toThrow('destroyed'); expect(fixture.children).toHaveLength(1);
    await closing; expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    if (process.platform === 'linux') expect(child.signalCode).toBe('SIGKILL'); expect(fixture.restored).toHaveBeenCalledOnce();
  }, 10_000);
  it('joins a real closed ACP process before thread-data erasure', async () => {
    const runtime = await (executor as any).runtime(); await runtime.start(); const child = fixture.children[0];
    const closed = once(child, 'close'); child.stdin!.write(JSON.stringify({ method: 'fixture_exit' }) + '\n'); const [code] = await closed;
    await executor.deleteThreadData('synthetic-thread');
    expect(code).toBe(0); expect(executor.getSessionId()).toBeNull(); expect(fixture.restored).toHaveBeenCalledOnce();
  });
});
