import { describe, expect, it, vi } from 'vitest';
import { EventEmitter, once } from 'events';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { setTimeout as delay } from 'timers/promises';
import { ManagedProcessGroups, type GroupExitDependencies } from '../../src/executor/ManagedProcessGroups';
import { AcpClient } from '../../src/executor/acp/AcpClient';

const pid = 2147000001;
const absent = () => { throw Object.assign(new Error('Synthetic absent process group'), { code: 'ESRCH' }); };
function stat(id = pid, state = 'S', group = pid, birth = 100, session = pid): string {
  return `${id} (synthetic (worker)) ${[state, 1, group, session, ...Array(15).fill(0), birth].join(' ')}`;
}
function fixture(overrides: Partial<GroupExitDependencies> = {}) {
  let now = 0;
  const runtime: GroupExitDependencies = {
    platform: 'linux', readStat: vi.fn(() => stat()), pids: vi.fn(async () => []),
    probe: vi.fn(), signal: vi.fn(), pause: async () => { now += 25; }, now: () => now, timeoutMs: 100,
    ...overrides,
  };
  const child = Object.assign(new EventEmitter(), { pid }) as unknown as ChildProcess;
  const groups = new ManagedProcessGroups(runtime);
  groups.track(child);
  return { groups, child, runtime, spawn: () => child.emit('spawn'), close: () => child.emit('close', 0) };
}

describe('managed process-group evidence', () => {
  it('keeps transport close separate from group exit and escalates a surviving group', async () => {
    const entry = fixture(); entry.spawn();
    await expect(entry.groups.waitForExit()).rejects.toThrow('transport exit');
    vi.mocked(entry.runtime.pids).mockResolvedValueOnce([String(pid)]).mockResolvedValue([]);
    vi.mocked(entry.runtime.signal).mockImplementation(() => { vi.mocked(entry.runtime.probe).mockImplementation(absent); });
    entry.close(); await entry.groups.waitForExit(); await entry.groups.waitForExit();
    expect(entry.runtime.signal).toHaveBeenCalledTimes(1);
    expect(entry.runtime.signal).toHaveBeenCalledWith(pid);
  });

  it.each([undefined, 0, 1, -1, 1.5, Number.NaN, process.pid])('never signals an invalid or missing owned PID %s', async invalid => {
    const entry = fixture(); Object.assign(entry.child, { pid: invalid }); entry.spawn(); entry.close();
    await expect(entry.groups.waitForExit()).rejects.toThrow('identity');
    expect(entry.runtime.signal).not.toHaveBeenCalled();
    expect(entry.runtime.readStat).not.toHaveBeenCalled();
  });

  it.each(['darwin', 'win32', 'freebsd'])('holds unsupported %s confirmation without signalling', async platform => {
    const entry = fixture({ platform }); entry.spawn(); entry.close();
    await expect(entry.groups.waitForExit()).rejects.toThrow('unavailable on this platform');
    expect(entry.runtime.signal).not.toHaveBeenCalled();
  });

  it.each([stat(pid, 'S', pid + 1), stat(pid, 'S', pid, 100, pid + 1), 'malformed'])('rejects unproven isolation or identity', async raw => {
    const entry = fixture({ readStat: vi.fn(() => raw) }); entry.spawn(); entry.close();
    await expect(entry.groups.waitForExit()).rejects.toThrow('identity');
    expect(entry.runtime.signal).not.toHaveBeenCalled();
  });

  it('never signals a reused leader PID', async () => {
    const entry = fixture(); entry.spawn();
    vi.mocked(entry.runtime.pids).mockResolvedValue([String(pid)]);
    vi.mocked(entry.runtime.readStat).mockReturnValue(stat(pid, 'S', pid, 200));
    entry.close(); await expect(entry.groups.waitForExit()).rejects.toThrow('identity changed');
    expect(entry.runtime.signal).not.toHaveBeenCalled();
  });

  it.each(['EACCES', 'EIO'])('holds incomplete inventory on %s', async code => {
    const entry = fixture(); entry.spawn();
    vi.mocked(entry.runtime.pids).mockResolvedValue([String(pid + 1)]);
    vi.mocked(entry.runtime.readStat).mockImplementation(() => { throw Object.assign(new Error('Synthetic stat failure'), { code }); });
    entry.close(); await expect(entry.groups.waitForExit()).rejects.toThrow('inventory is unavailable');
    expect(entry.runtime.signal).not.toHaveBeenCalled();
  });

  it('retains zombie-only or vanished snapshots while the kernel still reports a group', async () => {
    const entry = fixture(); entry.spawn();
    vi.mocked(entry.runtime.pids).mockResolvedValue(['self', String(pid), String(pid + 1)]);
    vi.mocked(entry.runtime.readStat).mockImplementation(id => {
      if (id === pid) return stat(pid, 'Z');
      throw Object.assign(new Error('Synthetic vanished process'), { code: 'ENOENT' });
    });
    entry.close(); await expect(entry.groups.waitForExit()).rejects.toThrow('could not be confirmed');
    expect(entry.runtime.signal).not.toHaveBeenCalled();
    expect(entry.runtime.probe).toHaveBeenCalledWith(pid);
    vi.mocked(entry.runtime.probe).mockImplementation(absent);
    await entry.groups.waitForExit();
  });

  it('bounds uncertain termination and allows confirmation after the cause is resolved', async () => {
    const entry = fixture(); entry.spawn();
    vi.mocked(entry.runtime.pids).mockResolvedValue([String(pid)]);
    entry.close(); await expect(entry.groups.waitForExit()).rejects.toThrow('could not be confirmed');
    vi.mocked(entry.runtime.pids).mockResolvedValue([]);
    vi.mocked(entry.runtime.probe).mockImplementation(absent);
    await entry.groups.waitForExit();
    expect(entry.runtime.signal).toHaveBeenCalledTimes(1);
  });

  it.each(['vanished', 'zombie'] as const)('finds a same-group fork when its enumerated parent becomes %s before stat', async state => {
    const entry = fixture(); entry.spawn();
    const parent = pid + 1;
    const descendant = pid + 2;
    let forked = false;
    let killed = false;
    vi.mocked(entry.runtime.pids).mockImplementation(async () => [String(forked ? descendant : parent)]);
    vi.mocked(entry.runtime.readStat).mockImplementation(id => {
      if (id === parent) {
        // B is created after the PID listing, before A's stat is read. Both
        // inherit the original PGID/SID; neither uses setsid or setpgid.
        forked = true;
        if (state === 'vanished') throw Object.assign(new Error('Synthetic parent exited'), { code: 'ENOENT' });
        return stat(parent, 'Z', pid, 101);
      }
      return stat(descendant, killed ? 'Z' : 'S', pid, 102);
    });
    vi.mocked(entry.runtime.probe).mockImplementation(() => { if (killed) absent(); });
    vi.mocked(entry.runtime.signal).mockImplementation(() => { killed = true; });
    entry.close(); await entry.groups.waitForExit();
    expect(entry.runtime.readStat).toHaveBeenCalledWith(descendant);
    expect(entry.runtime.signal).toHaveBeenCalledTimes(1);
    expect(entry.runtime.signal).toHaveBeenCalledWith(pid);
    expect(entry.runtime.probe).toHaveBeenCalledTimes(3);
  });

  it('never treats repeated empty snapshots as absence proof', async () => {
    const entry = fixture(); entry.spawn(); entry.close();
    await expect(entry.groups.waitForExit()).rejects.toThrow('could not be confirmed');
    expect(entry.runtime.pids).toHaveBeenCalledTimes(4);
    expect(entry.runtime.signal).not.toHaveBeenCalled();
    vi.mocked(entry.runtime.probe).mockImplementation(absent);
    await entry.groups.waitForExit();
  });

  it.each(['EPERM', 'EIO'])('retains the group when the kernel probe fails with %s', async code => {
    const entry = fixture({ probe: vi.fn(() => { throw Object.assign(new Error('Synthetic probe failure'), { code }); }) });
    entry.spawn(); entry.close();
    await expect(entry.groups.waitForExit()).rejects.toThrow('absence is unavailable');
    expect(entry.runtime.signal).not.toHaveBeenCalled();
  });

  it('does not substitute a kill ESRCH error for the required kernel absence probe', async () => {
    const entry = fixture({ pids: vi.fn(async () => [String(pid)]), signal: vi.fn(absent) });
    entry.spawn(); entry.close();
    await expect(entry.groups.waitForExit()).rejects.toThrow('could not be confirmed');
    expect(entry.runtime.signal).toHaveBeenCalledTimes(1);
  });

  it('rejects an oversized inventory', async () => {
    const entry = fixture(); entry.spawn();
    vi.mocked(entry.runtime.pids).mockResolvedValue(Array(100_001).fill('self'));
    entry.close(); await expect(entry.groups.waitForExit()).rejects.toThrow('inventory is incomplete');
  });

  it('holds signal permission errors instead of confirming exit', async () => {
    const entry = fixture(); entry.spawn();
    vi.mocked(entry.runtime.pids).mockResolvedValue([String(pid)]);
    vi.mocked(entry.runtime.signal).mockImplementation(() => { throw Object.assign(new Error('Synthetic signal denial'), { code: 'EPERM' }); });
    entry.close(); await expect(entry.groups.waitForExit()).rejects.toThrow('could not be stopped');
  });
});

describe.skipIf(process.platform !== 'linux')('native Linux managed ACP teardown', () => {
  it('confirms kernel absence after an isolated direct child is reaped', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'managed-group-test-')));
    const child = spawn(process.execPath, ['-e', "process.send('ready');setInterval(()=>{},1000);"], {
      cwd: root, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, HOME: root, USERPROFILE: root },
    });
    const closed = once(child, 'close');
    const groups = new ManagedProcessGroups();
    groups.track(child);
    try {
      await once(child, 'message', { signal: AbortSignal.timeout(5_000) });
      child.kill('SIGTERM');
      await closed;
      await groups.waitForExit();
      expect(() => process.kill(-child.pid!, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }));
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  it('stops a TERM-ignoring descendant after the parent closes its redirected transport first', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'managed-group-test-')));
    const ready = path.join(root, 'ready.json');
    const heartbeat = path.join(root, 'heartbeat');
    const descendant = `const fs=require('fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'x'),20);process.send('ready');`;
    const script = `const fs=require('fs');const {spawn}=require('child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','ignore','ignore','ipc']});child.once('message',()=>fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({parent:process.pid,child:child.pid})));process.on('SIGTERM',()=>process.exit(0));`;
    const client = new AcpClient(process.execPath, ['-e', script], root, {}, true, {
      delegationWorker: true, env: { ...process.env, HOME: root, USERPROFILE: root },
    });
    const native = (client as unknown as { child: ChildProcess }).child;
    let owned: { parent: number; child: number } | undefined;
    let confirmed = false;
    let checked = false;
    const checkGroup = async () => {
      try { await client.waitForManagedProcessGroupExit(); confirmed = true; }
      catch (error) {
        // Some Linux hosts do not promptly reap orphaned zombies. The kernel
        // still sees their group, so the checkout must remain held on timeout.
        expect((error as Error).message).toContain('could not be confirmed');
      }
      checked = true;
    };
    try {
      const deadline = Date.now() + 5_000;
      while (!owned && Date.now() < deadline) {
        try { owned = JSON.parse(await fs.readFile(ready, 'utf8')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await delay(10); }
      }
      expect(owned).toBeDefined();
      client.destroy();
      await client.waitForExit();
      await checkGroup();
      if (confirmed) expect(() => process.kill(-native.pid!, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }));
      const raw = await fs.readFile(`/proc/${owned!.child}/stat`, 'utf8').catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      if (raw) expect(raw.slice(raw.lastIndexOf(')') + 2).split(' ')[0]).toMatch(/^[ZXx]$/);
      const before = await fs.readFile(heartbeat, 'utf8').catch(() => '');
      await delay(60);
      expect(await fs.readFile(heartbeat, 'utf8').catch(() => '')).toBe(before);
    } finally {
      client.destroy();
      // Only the process group created by this fixture is eligible for this fallback.
      if (!confirmed && native.pid) {
        try { process.kill(-native.pid, 'SIGKILL'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
      try {
        await client.waitForExit();
        if (!checked) await checkGroup();
      } finally { await fs.rm(root, { recursive: true, force: true }); }
    }
  }, 15_000);
});
