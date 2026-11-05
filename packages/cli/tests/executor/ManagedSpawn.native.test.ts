import { once } from 'events';
import { setTimeout as delay } from 'timers/promises';
import { describe, expect, it } from 'vitest';
import { spawnManaged } from '../../src/executor/ManagedSpawn';
import { ManagedProcessGroups } from '../../src/executor/ManagedProcessGroups';
import { nativeBindings } from '../../src/native/NativeBindings';

describe('native managed worker containment', () => {
  it('preserves ordinary stdin, stdout, environment, arguments and successful group exit', async () => {
    const child = spawnManaged(true, process.execPath, ['-e',
      'process.stdin.once("data", b => { process.stdout.write(JSON.stringify([b.toString(),process.env.SYNTHETIC_VALUE,process.argv[1]])); });', 'quoted " value'],
    { detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, SYNTHETIC_VALUE: 'test' } });
    const groups = new ManagedProcessGroups(); groups.track(child);
    let output = ''; child.stdout!.on('data', bytes => { output += bytes; });
    try {
      child.stdin!.end('input');
      const [code] = await once(child, 'close');
      expect(code).toBe(0);
      await groups.waitForExit();
      expect(JSON.parse(output)).toEqual(['input', 'test', 'quoted " value']);
    } finally { child.kill('SIGKILL'); child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); }
  });
  it('confirms descendant shutdown after abort without touching a separate process', async () => {
    const sentinel = spawnManaged(false, process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    const child = spawnManaged(true, process.execPath, ['-e',
      'const c=require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); c.once("spawn",()=>process.stdout.write(String(c.pid)+"\\n")); setInterval(()=>{},1000);'],
    { detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const groups = new ManagedProcessGroups(); groups.track(child);
    let ready = ''; const started = new Promise<void>(resolve => child.stdout!.on('data', bytes => { ready += bytes; if (ready.includes('\n')) resolve(); }));
    try {
      await Promise.race([started, once(child, 'close').then(() => { throw new Error('Worker exited before creating its child'); })]);
      const closed = once(child, 'close'); child.kill('SIGKILL'); await closed;
      await groups.waitForExit();
      if (process.platform !== 'win32') {
        // A completed proof must still be backed by kernel absence, including
        // after any earlier inconclusive Darwin probes.
        expect(() => process.kill(-child.pid!, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }));
      }
      expect(() => process.kill(sentinel.pid!, 0)).not.toThrow();
    } finally {
      child.kill('SIGKILL'); child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
      const closed = once(sentinel, 'close'); sentinel.kill('SIGKILL'); await closed;
    }
  });
  it.runIf(process.platform === 'win32')('retains a live job until the kernel reports zero members', async () => {
    const native = nativeBindings();
    const job = native.createJob(`Local\\remote-cli-native-test-${require('crypto').randomUUID()}`);
    try { expect(native.jobCount(job)).toBe(0); native.terminateJob(job); await delay(1); expect(native.jobCount(job)).toBe(0); }
    finally { native.close(job); }
  });
});
