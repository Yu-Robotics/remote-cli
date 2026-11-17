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
  dependencies = { processes: () => [{ pid: 101, birth: 'one', command: 'fixture-native' }], identity: () => ({ host, boot, namespace: 'fixture-namespace' }),
    gate: filename => {
      if (held.has(filename)) return;
      held.add(filename); let closed = false;
      return { verify: () => { if (closed) throw new Error('Closed fixture gate'); }, close: () => { closed = true; held.delete(filename); } };
    } };
});
afterEach(() => { for (const value of guards) value.close(); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

describe('Claude abrupt schedule ownership', () => {
  it('keeps exact current owner cancellation distinct from archived predecessor obligations', () => {
    const first = guard(); first.reserveForNewJob(101, 'fixture-native');
    const oldToken = first.ownerToken, before = fs.readFileSync(first.filename, 'utf8');
    expect(first.cancellationProof(oldToken)).toBe(true); first.hostClosed();
    expect(first.cancellationProof(oldToken)).toBe(false); first.close();
    dependencies.processes = () => [{ pid: 102, birth: 'two', command: 'fixture-native --resume fixture-session' }];
    const second = guard(); second.reserveForNewJob(102, 'fixture-native');
    expect(second.cancellationProof(oldToken)).toBe(false); expect(second.cancellationProof(second.ownerToken)).toBe(true);
    const receipt = JSON.parse(fs.readFileSync(second.filename, 'utf8'));
    expect(receipt.version).toBe(3); expect(receipt.clean).toBeUndefined();
    expect(fs.readFileSync(`${first.filename}.retired-${JSON.parse(before).token}`, 'utf8')).toBe(before);
    const lease = second.reviewedRemovalLease(); expect(lease.retirementConfirmed(oldToken)).toBe(false);
    expect(lease.retirementConfirmed(second.ownerToken)).toBe(true); lease.close();
    second.hostClosed(); second.close(); const third = guard(); expect(third.cancellationProof(receipt.ownerToken)).toBe(false);
    boot = 'boot-two'; expect(third.cancellationProof(receipt.ownerToken)).toBe(true);
  });
  it('requires current exclusive ownership and exact process evidence', () => {
    const a = guard(); a.reserveForNewJob(101, 'fixture-native'); a.reserveForNewJob(101, 'fixture-native');
    expect(() => guard().reserveForNewJob(101, 'fixture-native')).toThrow('Another client');
    expect(() => a.reserveForNewJob(102, 'fixture-native')).toThrow('identity changed'); a.close();
    dependencies.processes = () => [{ pid: 101, birth: 'one', command: 'fixture-native' }, { pid: 102, birth: 'two', command: 'fixture-native' }];
    expect(() => guard().reserveForNewJob(102, 'fixture-native')).toThrow('still alive');
    dependencies.identity = () => ({ host, boot, namespace: 'foreign-namespace' });
    expect(() => guard().reserveForNewJob(102, 'fixture-native')).toThrow('namespace');
  });
  it('leases explicit removal without creating a receipt or any execution proof', () => {
    const a = guard(), b = guard(), lease = a.reviewedRemovalLease(); expect(lease.retirementConfirmed()).toBe(false);
    expect(a.exists()).toBe(false); expect(() => b.reviewedRemovalLease()).toThrow('Another client'); lease.close();
    expect(() => b.cancellationProof()).toThrow('missing'); b.close();
    expect('reserve' in a).toBe(false); expect('confirmClean' in a).toBe(false); expect('assertRebootRecovery' in a).toBe(false);
  });
  it('never treats legacy clean flags as current execution or same-boot cancellation authority', () => {
    const a = guard(); a.reserveForNewJob(101, 'fixture-native'); a.close();
    const { checksum: ignored, ...legacy } = JSON.parse(fs.readFileSync(a.filename, 'utf8'));
    legacy.version = 2; legacy.clean = true;
    const checksum = require('crypto').createHash('sha256').update(JSON.stringify(legacy)).digest('hex');
    fs.writeFileSync(a.filename, JSON.stringify({ ...legacy, checksum }));
    const next = guard(); expect(next.cancellationProof(legacy.ownerToken)).toBe(false);
    const lease = next.reviewedRemovalLease(); expect(lease.retirementConfirmed(legacy.ownerToken)).toBe(false); lease.close();
  });
  it('retains foreign, corrupt, nonregular or oversized receipts without accepting absence', () => {
    const a = guard(); a.reserveForNewJob(101, 'fixture-native'); a.close(); host = 'foreign-host';
    expect(() => guard().cancellationProof()).toThrow('another machine');
    for (const g of guards) g.close(); host = 'fixture-host';
    fs.writeFileSync(a.filename, '{}'); expect(() => guard().reviewedRemovalLease()).toThrow('invalid');
    fs.writeFileSync(a.filename, 'x'.repeat(8193)); expect(() => guard().reviewedRemovalLease()).toThrow('Unsafe');
    fs.unlinkSync(a.filename); fs.mkdirSync(a.filename); expect(() => guard().reserveForNewJob(101, 'fixture-native')).toThrow('Unsafe');
  });
  it('fails closed on publication failure and never changes an archived receipt', () => {
    const a = guard(); a.reserveForNewJob(101, 'fixture-native'); a.close();
    dependencies.processes = () => [{ pid: 102, birth: 'two', command: 'fixture-native' }];
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('Synthetic publication failure'); });
    const b = guard(); expect(() => b.reserveForNewJob(102, 'fixture-native')).toThrow('publication'); rename.mockRestore();
    expect(held.size).toBe(0); b.reserveForNewJob(102, 'fixture-native');
    const before = fs.readFileSync(b.filename, 'utf8'); b.close();
    expect(fs.readFileSync(b.filename, 'utf8')).toBe(before);
  });
  it('keeps different native sessions independent', () => {
    const a = guard(), b = guard('other-session'); a.reserveForNewJob(101, 'fixture-native'); b.reserveForNewJob(101, 'fixture-native');
    expect(a.filename).not.toBe(b.filename);
  });
});
