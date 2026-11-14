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
