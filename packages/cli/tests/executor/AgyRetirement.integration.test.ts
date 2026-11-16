import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { once } from 'events';
import { AgyExecutor } from '../../src/executor/AgyExecutor';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';

// Real OS children speak only this test's stream-json fixture. No AGY binary,
// user configuration, account or provider is involved in this regression.
const launch = vi.hoisted(() => ({ fixture: '', home: '', children: [] as ChildProcess[] }));
vi.mock('../../src/executor/ManagedSpawn', () => ({
  spawnManaged: (_managed: boolean, _command: string, args: string[], options: { cwd: string }) => {
    const child = spawn(process.execPath, [launch.fixture, ...args], {
      cwd: options.cwd, stdio: 'pipe',
      env: { HOME: launch.home, USERPROFILE: launch.home, PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
    });
    launch.children.push(child);
    return child;
  },
}));
vi.mock('os', async importOriginal => {
  const actual = await importOriginal<typeof import('os')>();
  const homedir = () => launch.home;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

describe('AGY host retirement with a real subprocess', () => {
  let executor: AgyExecutor;
  beforeEach(() => {
    launch.home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-retirement-')));
    launch.fixture = path.join(launch.home, 'fixture.cjs');
    launch.children = [];
    fs.writeFileSync(launch.fixture, `
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
process.on('SIGTERM', () => send({ event: 'fixture_signal_received' }));
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.event === 'fixture_exit') process.exit(0);
  send({ event: 'init', conversation_id: 'synthetic-conversation' });
  if (message.message.content !== 'hold') send({ event: 'result', result: {
    status: 'SUCCESS', response: 'fixture completed', conversation_id: 'synthetic-conversation'
  } });
});
`);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    executor = new AgyExecutor(new DirectoryGuard([launch.home]), {
      initialWorkingDirectory: launch.home, killEscalationMs: 1_500,
    });
  });
  afterEach(async () => {
    // Close every real fixture even when an assertion fails. These children have
    // no descendants; await OS close before removing their temporary directory.
    await Promise.all(launch.children.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = once(child, 'close');
      child.kill('SIGKILL');
      await closed;
    }));
    await executor.destroy();
    vi.restoreAllMocks();
    fs.rmSync(launch.home, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')('waits for an uncooperative POSIX child before reporting abort and dispatching a successor', async () => {
    const running = executor.execute('hold');
    await vi.waitFor(() => expect(executor.getSessionId()).toBe('synthetic-conversation'));
    const old = launch.children[0];
    let signalObserved = false;
    old.stdout!.on('data', chunk => { if (chunk.toString().includes('fixture_signal_received')) signalObserved = true; });
    let aborted = false;
    const aborting = executor.abort().then(result => { aborted = true; return result; });
    await expect(running).resolves.toMatchObject({ success: false });
    const next = executor.execute('next');
    await vi.waitFor(() => expect(signalObserved).toBe(true));
    expect(aborted).toBe(false);
    expect(launch.children).toHaveLength(1);
    expect(old.exitCode).toBeNull();
    expect(executor.isBusy()).toBe(true);
    // Test-only control acknowledges real exit; kill() success was insufficient.
    old.stdin!.write(JSON.stringify({ event: 'fixture_exit' }) + '\n');
    expect(await aborting).toBe(true);
    await expect(next).resolves.toMatchObject({ success: true, output: 'fixture completed' });
    expect(old.exitCode).toBe(0);
    expect(launch.children).toHaveLength(2);
    expect(launch.children[1].spawnargs).toEqual(expect.arrayContaining(['--conversation', 'synthetic-conversation']));
  });

  it('joins a real closed child before removing its isolated thread data', async () => {
    const result = await executor.execute('complete');
    expect(result.success).toBe(true);
    const child = launch.children[0];
    // Close first to make this cleanup check portable: Windows SIGTERM cannot
    // be held by the JavaScript signal handler used in the POSIX case above.
    const closed = once(child, 'close');
    child.stdin!.write(JSON.stringify({ event: 'fixture_exit' }) + '\n');
    await closed;
    await executor.deleteThreadData('synthetic-thread');
    expect(child.exitCode).toBe(0);
    expect(executor.getSessionId()).toBeNull();
  });
});
