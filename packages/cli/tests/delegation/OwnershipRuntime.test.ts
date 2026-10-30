import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'events';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn as spawnProcess } from 'child_process';
vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
import { assertRecoverable, bootIdentity, kernelGate, ownedSpawn, ownerRecord, encodeOwner, ProcessJournal,
  withProcessJournal, type OwnerRecord } from '../../src/delegation/OwnershipRuntime';

let directory: string;
let filename: string;
const closed: Array<() => void> = [];
const current = { host: 'synthetic-host', boot: 'synthetic-boot', namespace: 'synthetic-namespace' };
let owner: OwnerRecord;
beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ownership-runtime-')));
  filename = path.join(directory, 'children');
  owner = { version: 2, token: randomUUID(), pid: 123456, ...current };
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of closed.splice(0)) close();
  fs.rmSync(directory, { recursive: true, force: true });
});
const absent = () => { throw Object.assign(new Error('No such process'), { code: 'ESRCH' }); };
function journal(lines: unknown[] = []) {
  fs.writeFileSync(filename, owner.token + '\n' + lines.map(line => JSON.stringify(line) + '\n').join(''));
}
const recover = () => assertRecoverable(encodeOwner(owner), filename, current);

describe('kernel ownership gates', () => {
  it('excludes independent descriptors and releases by closing, keeping the stable inode', () => {
    const first = kernelGate(filename)!;
    closed.push(() => first.close());
    const inode = fs.statSync(filename).ino;
    expect(kernelGate(filename)).toBeUndefined();
    first.close();
    const second = kernelGate(filename)!;
    closed.push(() => second.close());
    expect(fs.statSync(filename).ino).toBe(inode);
    expect(() => first.verify()).toThrow('closed');
    second.verify();
  });

  it.skipIf(process.platform === 'win32')('fences a renamed gate rather than following a new inode', () => {
    const gate = kernelGate(filename)!;
    closed.push(() => gate.close());
    fs.renameSync(filename, filename + '.old');
    fs.writeFileSync(filename, '');
    expect(() => gate.verify()).toThrow('identity changed');
  });

  it('refuses a directory as a gate', () => {
    fs.mkdirSync(filename);
    expect(() => kernelGate(filename)).toThrow();
  });
});

describe('crash-recovery evidence', () => {
  it('records a stable host and boot identity with the owner PID and random token', () => {
    expect(bootIdentity()).toEqual(bootIdentity());
    expect(ownerRecord()).toMatchObject({ version: 2, pid: process.pid, ...bootIdentity() });
    expect(ownerRecord().token).not.toBe(ownerRecord().token);
  });

  it('recovers an idle dead owner on the same boot', () => {
    journal();
    vi.spyOn(process, 'kill').mockImplementation(absent);
    expect(recover).not.toThrow();
  });

  it('does not mistake an alive owner or an inaccessible owner for a stale PID', () => {
    journal();
    const probe = vi.spyOn(process, 'kill').mockReturnValue(true);
    expect(recover).toThrow('still alive');
    probe.mockImplementation(() => { throw Object.assign(new Error('Denied'), { code: 'EPERM' }); });
    expect(recover).toThrow('Denied');
  });

  it.skipIf(process.platform !== 'linux')('recognizes PID reuse using birth identity without signalling the process', () => {
    owner.pid = process.pid;
    owner.birth = '-synthetic-previous-process';
    journal();
    const probe = vi.spyOn(process, 'kill').mockReturnValue(true);
    expect(recover).not.toThrow();
    expect(probe).toHaveBeenCalledWith(process.pid, 0);
  });

  it('allows reboot recovery on the same host without trusting a reused PID or an incomplete launch journal', () => {
    owner.boot = 'previous-boot';
    owner.namespace = 'previous-namespace';
    fs.writeFileSync(filename, 'torn launch');
    const probe = vi.spyOn(process, 'kill');
    expect(recover).not.toThrow();
    expect(probe).not.toHaveBeenCalled();
  });

  it('does not mistake corrupted boot metadata for evidence of a reboot', () => {
    const raw = encodeOwner(owner).toString().replace('synthetic-boot', 'corrupted-boot');
    expect(() => assertRecoverable(Buffer.from(raw), filename, current)).toThrow('checksum failed');
  });

  it.each(['host', 'namespace'] as const)('rejects foreign %s identity', field => {
    owner[field] = 'foreign';
    expect(recover).toThrow(/another host|another PID namespace/);
  });

  it.each(['{', JSON.stringify({ version: 1, token: 'legacy', pid: 123 })])('preserves legacy or damaged metadata', raw => {
    expect(() => assertRecoverable(Buffer.from(raw), filename, current)).toThrow(/controlled recovery/);
  });

  it.each(['missing', 'partial', 'token', 'transition', 'oversize'])('rejects a %s process journal', mode => {
    vi.spyOn(process, 'kill').mockImplementation(absent);
    if (mode === 'partial') fs.writeFileSync(filename, owner.token + '\n{"');
    if (mode === 'token') fs.writeFileSync(filename, 'wrong-token\n');
    if (mode === 'transition') journal([{ id: randomUUID(), event: 'absent' }]);
    if (mode === 'oversize') fs.writeFileSync(filename, Buffer.alloc(16 * 1024 * 1024 + 1));
    expect(recover).toThrow();
  });

  it('retains a reservation interrupted before child identity publication', () => {
    journal([{ id: randomUUID(), event: 'reserve' }]);
    vi.spyOn(process, 'kill').mockImplementation(absent);
    expect(recover).toThrow('launch was interrupted');
  });

  it.skipIf(process.platform === 'win32')('checks kernel group absence even when the parent PID is gone', () => {
    const id = randomUUID();
    journal([{ id, event: 'reserve' }, { id, event: 'spawn', pid: 234567, group: true }]);
    const probe = vi.spyOn(process, 'kill').mockImplementation(pid => pid > 0 ? absent() : true);
    expect(recover).toThrow('still exists');
    expect(probe).toHaveBeenCalledWith(-234567, 0);
    probe.mockImplementation(absent);
    expect(recover).not.toThrow();
  });

  it('does not infer descendant exit from a non-group child record', () => {
    const id = randomUUID();
    journal([{ id, event: 'reserve' }, { id, event: 'spawn', pid: 234567, group: false }]);
    vi.spyOn(process, 'kill').mockImplementation(absent);
    expect(recover).toThrow('child-tree exit is unconfirmed');
  });

  it('accepts a durably confirmed failed launch', () => {
    const id = randomUUID();
    journal([{ id, event: 'reserve' }, { id, event: 'absent' }]);
    vi.spyOn(process, 'kill').mockImplementation(absent);
    expect(recover).not.toThrow();
  });
});

describe('durable launch admission', () => {
  it('bounds completed history while retaining unresolved launch evidence through atomic compaction', () => {
    const log = new ProcessJournal(filename, owner.token, () => {}, 512);
    closed.push(() => log.close());
    const unresolved = randomUUID();
    log.append({ id: unresolved, event: 'reserve' });
    for (let index = 0; index < 40; index++) {
      const id = randomUUID();
      log.append({ id, event: 'reserve' });
      log.append({ id, event: 'absent' });
    }
    expect(fs.statSync(filename).size).toBeLessThan(1024);
    vi.spyOn(process, 'kill').mockImplementation(absent);
    expect(recover).toThrow('launch was interrupted');
    log.append({ id: unresolved, event: 'absent' });
    expect(recover).not.toThrow();
    expect(fs.readdirSync(directory)).toEqual(['children']);
  });

  it('preserves the old complete journal when compaction publication fails', () => {
    const log = new ProcessJournal(filename, owner.token, () => {}, 128);
    closed.push(() => log.close());
    log.append({ id: randomUUID(), event: 'reserve' });
    log.append({ id: randomUUID(), event: 'reserve' });
    const original = fs.readFileSync(filename);
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('Synthetic rename failure'); });
    expect(() => log.append({ id: randomUUID(), event: 'reserve' })).toThrow('rename failure');
    expect(fs.readFileSync(filename)).toEqual(original);
    expect(fs.readdirSync(directory)).toEqual(['children']);
  });

  it('journals before a real child starts, then records its group and exit', async () => {
    const log = new ProcessJournal(filename, owner.token, () => {});
    closed.push(() => log.close());
    const child = withProcessJournal(log, () => ownedSpawn(process.execPath, ['-e', ''], { stdio: 'ignore' }));
    const before = fs.readFileSync(filename, 'utf8');
    expect(before).toContain('"event":"reserve"');
    expect(before).toContain(`"pid":${child.pid}`);
    await once(child, 'close');
    if (process.platform !== 'win32') expect(fs.readFileSync(filename, 'utf8')).toContain('"event":"absent"');
  });

  it('does not launch if the pre-spawn journal cannot be flushed', () => {
    const log = new ProcessJournal(filename, owner.token, () => {});
    closed.push(() => log.close());
    const spawn = vi.mocked(spawnProcess).mockClear();
    vi.spyOn(fs, 'fsyncSync').mockImplementation(() => { throw new Error('Synthetic storage failure'); });
    expect(() => withProcessJournal(log, () => ownedSpawn(process.execPath, ['-e', '']))).toThrow('storage failure');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('fences late callbacks after journal closure', () => {
    const log = new ProcessJournal(filename, owner.token, () => {});
    log.close();
    expect(() => withProcessJournal(log, () => ownedSpawn(process.execPath, ['-e', '']))).toThrow('journal is closed');
  });

  it('does not change ordinary spawn options outside an owned scope', async () => {
    const spy = vi.mocked(spawnProcess).mockClear();
    const options = { stdio: 'ignore' as const, detached: false };
    const child = ownedSpawn(process.execPath, ['-e', ''], options);
    await once(child, 'close');
    expect(spy).toHaveBeenCalledWith(process.execPath, ['-e', ''], options);
    expect(fs.existsSync(filename)).toBe(false);
  });
});
