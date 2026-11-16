import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ClaudeScheduleOwnership, type ScheduleOwnershipDependencies } from '../../src/scheduling/claude/ClaudeScheduleOwnership';

let root: string, boot: string, host: string;
let held: Set<string>, guards: ClaudeScheduleOwnership[];
let dependencies: ScheduleOwnershipDependencies;
function guard(session = 'fixture-session') {
  const value = new ClaudeScheduleOwnership(path.join(root, 'session.json'), session, dependencies);
  guards.push(value); return value;
}
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-ownership-')));
  vi.spyOn(os, 'homedir').mockReturnValue(root);
  boot = 'boot-one'; host = 'fixture-host'; held = new Set(); guards = [];
  dependencies = { identity: () => ({ host, boot, namespace: 'fixture-namespace' }),
    gate: filename => {
      if (held.has(filename)) return;
      held.add(filename); let closed = false;
      return { verify: () => { if (closed) throw new Error('Closed fixture gate'); }, close: () => { closed = true; held.delete(filename); } };
    } };
});
afterEach(() => { for (const value of guards) value.close(); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

describe('Claude schedule predecessor ownership', () => {
  it('reports retirement only from a live owned, clean, or later-boot receipt without rewriting it', () => {
    const first = guard();
    let lease = first.reviewedRemovalLease(); expect(lease.retirementConfirmed()).toBe(false); lease.close();
    first.reserve(true); lease = first.reviewedRemovalLease(); expect(lease.retirementConfirmed()).toBe(true);
    first.hostClosed(); expect(lease.retirementConfirmed()).toBe(false); lease.close(); first.close();
    const second = guard(); const before = fs.readFileSync(second.filename, 'utf8');
    lease = second.reviewedRemovalLease(); expect(lease.retirementConfirmed()).toBe(false);
    boot = 'boot-two'; expect(lease.retirementConfirmed()).toBe(true);
    host = 'another-host'; expect(lease.retirementConfirmed()).toBe(false); host = 'fixture-host';
    expect(fs.readFileSync(second.filename, 'utf8')).toBe(before);
    lease.close(); expect(() => lease.retirementConfirmed()).toThrow('Closed fixture gate');
    second.reserve(false); second.hostClosed(); second.confirmClean(); second.close();
    lease = guard().reviewedRemovalLease(); expect(lease.retirementConfirmed()).toBe(true); lease.close();
  });
  it('leases explicit removal without a receipt and never creates execution proof', () => {
    const a = guard(), b = guard();
    const lease = a.reviewedRemovalLease(); lease.verify();
    expect(a.exists()).toBe(false);
    expect(() => b.reviewedRemovalLease()).toThrow('Another client');
    expect(() => a.assertRebootRecovery()).toThrow('later boot');
    lease.close(); const next = b.reviewedRemovalLease(); next.close();
    expect(a.exists()).toBe(false);
  });
  it('preserves an existing live receipt/lock and rejects foreign or malformed proof', () => {
    const a = guard(); a.reserve(true);
    const before = fs.readFileSync(a.filename, 'utf8');
    const lease = a.reviewedRemovalLease(); lease.verify(); lease.close();
    expect(fs.readFileSync(a.filename, 'utf8')).toBe(before);
    expect(() => guard().reviewedRemovalLease()).toThrow('Another client');
    a.close(); host = 'foreign-host';
    expect(() => guard().reviewedRemovalLease()).toThrow('another machine');
    host = 'fixture-host'; fs.writeFileSync(a.filename, '{}');
    expect(() => guard().reviewedRemovalLease()).toThrow('invalid');
    expect(held.size).toBe(0);
  });
  it('stays dormant until used and serializes owners across clients', () => {
    const a = guard(), b = guard(); expect(a.exists()).toBe(false);
    a.reserve(true); a.reserve(true);
    expect(() => b.reserve(false)).toThrow('Another client');
    expect(() => a.confirmClean()).toThrow('exit is unconfirmed');
    expect(() => a.assertRebootRecovery()).toThrow('later boot');
    a.hostClosed(); a.confirmClean(); a.close();
    b.reserve(false); expect(b.exists()).toBe(true);
    expect(() => b.assertRebootRecovery()).toThrow('later boot');
  });
  it('blocks same-boot crash, absent/reused PIDs and foreign namespaces without probing or killing', () => {
    const a = guard(); a.reserve(true); a.hostClosed(); a.close();
    const kill = vi.spyOn(process, 'kill');
    const b = guard();
    expect(() => b.reserve(false)).toThrow('PID absence');
    dependencies.identity = () => ({ host, boot, namespace: 'different-namespace' });
    expect(() => b.reserve(false)).toThrow('PID absence');
    expect(kill).not.toHaveBeenCalled();
  });
  it('allows a verified same-machine reboot and reserves before a second crash', () => {
    const a = guard(); a.reserve(true); a.close(); boot = 'boot-two';
    const b = guard(); b.reserve(false); b.assertRebootRecovery(); b.reserve(false);
    b.close();
    expect(() => guard().reserve(false)).toThrow('PID absence');
    boot = 'boot-three'; const c = guard(); c.reserve(false); c.assertRebootRecovery();
  });
  it('refuses foreign-machine and missing predecessor evidence', () => {
    expect(() => guard().reserve(false)).toThrow('identity is missing');
    const a = guard(); a.reserve(true); a.close(); host = 'another-fixture-host'; boot = 'boot-two';
    expect(() => guard().reserve(false)).toThrow('another machine');
  });
  it('allows removal-only inspection without granting same-boot execution admission', () => {
    const first = guard(); first.reserve(true);
    expect(first.cancellationProof()).toBe(true);
    expect(() => guard().cancellationProof()).toThrow('Another client');
    first.hostClosed(); expect(first.cancellationProof()).toBe(false); first.close();
    const successor = guard(); const before = fs.readFileSync(successor.filename, 'utf8');
    expect(successor.cancellationProof()).toBe(false);
    expect(fs.readFileSync(successor.filename, 'utf8')).toBe(before);
    expect(() => successor.reserve(false)).toThrow('PID absence');
    expect(() => successor.assertRebootRecovery()).toThrow('later boot');
    boot = 'boot-two'; expect(successor.cancellationProof()).toBe(true);
    expect(fs.readFileSync(successor.filename, 'utf8')).toBe(before);
  });
  it('requires a valid same-machine receipt for cancellation and accepts clean exit evidence', () => {
    const first = guard(); expect(() => first.cancellationProof()).toThrow('missing');
    first.reserve(true); first.hostClosed(); first.confirmClean(); first.close();
    const successor = guard(); expect(successor.cancellationProof()).toBe(true);
    host = 'another-fixture-host'; expect(() => successor.cancellationProof()).toThrow('another machine');
  });
  it.each([false, true])('rearms new work after a dirty receipt without certifying old work (legacy=%s)', legacy => {
    dependencies.processes = () => [{ pid: 101, birth: 'one', command: 'fixture-native --resume fixture-session' }];
    const first = guard();
    if (legacy) first.reserve(true); else first.reserveForNewJob(101, 'fixture-native');
    const before = fs.readFileSync(first.filename, 'utf8');
    first.close();
    dependencies.processes = () => [{ pid: 102, birth: 'two', command: 'fixture-native --resume fixture-session' }];
    const second = guard(); second.reserveForNewJob(102, 'fixture-native');
    expect(JSON.parse(fs.readFileSync(second.filename, 'utf8'))).toMatchObject({ version: 2, clean: false,
      predecessorUncertain: true, nativeHost: { pid: 102, birth: 'two' } });
    const token = JSON.parse(before).token;
    expect(fs.readFileSync(`${first.filename}.retired-${token}`, 'utf8')).toBe(before);
    expect(second.cancellationProof()).toBe(false);
    expect(() => second.assertRebootRecovery()).toThrow('later boot');
    const lease = second.reviewedRemovalLease(); expect(lease.retirementConfirmed()).toBe(false); lease.close();
    const currentToken = second.ownerToken;
    expect(second.cancellationProof(currentToken)).toBe(true);
    second.hostClosed(); second.confirmClean(); second.close();
    expect(() => guard().reserve(false)).toThrow('uncertain predecessor');
    const third = guard(); third.reserve(false, currentToken); third.bindHost(102);
    expect(third.cancellationProof()).toBe(false);
    expect(third.ownerToken).toBe(currentToken);
    expect(third.cancellationProof(currentToken)).toBe(true);
    expect(third.cancellationProof(token)).toBe(false);
    expect(() => third.reserve(true, token)).toThrow('uncertain predecessor');
  });
  it('rejects live exact hosts and foreign namespaces before archiving or changing a receipt', () => {
    dependencies.processes = () => [{ pid: 101, birth: 'one', command: 'fixture-native' }];
    const first = guard(); first.reserveForNewJob(101, 'fixture-native'); first.close();
    const before = fs.readFileSync(first.filename, 'utf8');
    dependencies.processes = () => [{ pid: 101, birth: 'one', command: 'fixture-native' },
      { pid: 102, birth: 'two', command: 'fixture-native --resume fixture-session' }];
    expect(() => guard().reserveForNewJob(102, 'fixture-native')).toThrow('still alive');
    dependencies.identity = () => ({ host, boot, namespace: 'foreign-namespace' });
    expect(() => guard().reserveForNewJob(102, 'fixture-native')).toThrow('namespace');
    expect(fs.readFileSync(first.filename, 'utf8')).toBe(before);
    expect(fs.readdirSync(root).some(name => name.includes('.retired-'))).toBe(false);
  });
  it('keeps a crash before diagnostic publication usable without repairing the receipt', () => {
    dependencies.processes = () => [{ pid: 101, command: 'fixture-native' }];
    const first = guard(); first.reserve(true); first.close();
    const second = guard();
    const write = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('Synthetic crash'); });
    expect(() => second.reserveForNewJob(101, 'fixture-native')).toThrow('Synthetic crash');
    write.mockRestore();
    second.reserveForNewJob(101, 'fixture-native');
    second.reserveForNewJob(101, 'fixture-native');
    expect(() => guard().reserveForNewJob(101, 'fixture-native')).toThrow('Another client');
  });

  it('does not retain an in-memory host binding after its durable publication fails', () => {
    dependencies.processes = () => [{ pid: 101, birth: 'one', command: 'fixture-native' }];
    const first = guard(); first.reserve(true);
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('Synthetic binding write failure'); });
    expect(() => first.bindHost(101)).toThrow('binding write failure');
    expect(() => first.bindHost(101)).toThrow('reservation is unavailable');
    expect(JSON.parse(fs.readFileSync(first.filename, 'utf8')).version).toBe(1);
    rename.mockRestore();
    first.reserveForNewJob(101, 'fixture-native');
    expect(JSON.parse(fs.readFileSync(first.filename, 'utf8'))).toMatchObject({ version: 2, nativeHost: { pid: 101 } });
  });

  it('keeps different native sessions independent', () => {
    const a = guard(), b = guard('new-fixture-session'); a.reserve(true); b.reserve(true);
    expect(a.filename).not.toBe(b.filename);
  });
  it('rejects corrupted receipts and preserves the original evidence', () => {
    const a = guard(); a.reserve(true); a.close();
    const bytes = fs.readFileSync(a.filename, 'utf8').replace('"clean":false', '"clean":true');
    fs.writeFileSync(a.filename, bytes);
    expect(() => guard().reserve(false)).toThrow('receipt is invalid');
    expect(fs.readFileSync(a.filename, 'utf8')).toBe(bytes);
  });
  it('refuses nonregular and oversized receipt entries', () => {
    const a = guard(); fs.mkdirSync(a.filename);
    expect(() => a.reserve(false)).toThrow('Unsafe'); fs.rmdirSync(a.filename);
    fs.writeFileSync(a.filename, 'x'.repeat(8193));
    expect(() => a.reserve(false)).toThrow('Unsafe');
  });
  it('fails closed when identity or durable publication fails, cleaning temporary files', () => {
    dependencies.identity = () => { throw new Error('Identity unavailable'); };
    const a = guard(); expect(() => a.reserve(true)).toThrow('Identity unavailable');
    dependencies.identity = () => ({ host, boot, namespace: 'fixture-namespace' });
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('Publication failure'); });
    expect(() => a.reserve(true)).toThrow('Publication failure');
    expect(held.size).toBe(0); expect(fs.readdirSync(root).some(name => name.endsWith('.tmp'))).toBe(false);
  });
});
