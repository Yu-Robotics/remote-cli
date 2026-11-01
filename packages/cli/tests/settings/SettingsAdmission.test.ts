import { describe, expect, it } from 'vitest';
import { SettingsAdmission, SettingsBusyError } from '../../src/settings/SettingsAdmission';

function gate() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}

describe('settings command admission', () => {
  it('blocks writes while a command is admitted and releases its reader on failure', async () => {
    const admission = new SettingsAdmission();
    const hold = gate();
    const command = admission.command('thread-a', 'request-a', async () => { await hold.wait; throw new Error('Command failed'); });
    const failed = expect(command).rejects.toThrow('Command failed');
    expect(admission.hasCommand('thread-a')).toBe(true);
    expect(admission.hasCommand('thread-a', 'request-a')).toBe(false);
    await expect(admission.mutation('thread-a', async () => true)).rejects.toBeInstanceOf(SettingsBusyError);
    await expect(admission.mutation('*', async () => true)).rejects.toBeInstanceOf(SettingsBusyError);
    expect(await admission.mutation('thread-b', async () => 42)).toBe(42);
    hold.release();
    await failed;
    expect(admission.hasCommand('thread-a')).toBe(false);
    expect(await admission.mutation('thread-a', async () => 7)).toBe(7);
  });

  it.each(['thread-a', '*'])('holds new commands behind an admitted %s write', async target => {
    const admission = new SettingsAdmission();
    const hold = gate();
    const events: string[] = [];
    const write = admission.mutation(target, async () => { events.push('write'); await hold.wait; events.push('saved'); });
    const command = admission.command('thread-a', 'request-a', async () => { events.push('command'); });
    await Promise.resolve();
    expect(events).toEqual(['write']);
    expect(admission.isBlocked('thread-a')).toBe(true);
    await expect(admission.mutation('thread-a', async () => true)).rejects.toBeInstanceOf(SettingsBusyError);
    await expect(admission.mutation('*', async () => true)).rejects.toBeInstanceOf(SettingsBusyError);
    hold.release();
    await Promise.all([write, command]);
    expect(events).toEqual(['write', 'saved', 'command']);
    expect(admission.isBlocked('thread-a')).toBe(false);
  });

  it('does not serialize unrelated threads and releases a failed writer', async () => {
    const admission = new SettingsAdmission();
    const hold = gate();
    const write = admission.mutation('thread-a', async () => { await hold.wait; throw new Error('Save failed'); });
    const failed = expect(write).rejects.toThrow('Save failed');
    expect(await admission.command('thread-b', 'request-b', async () => 'parallel')).toBe('parallel');
    expect(await admission.mutation('thread-b', async () => 'saved')).toBe('saved');
    hold.release();
    await failed;
    expect(admission.isBlocked('thread-a')).toBe(false);
  });

  it('keeps concurrent reader reservations distinct even when request IDs repeat', async () => {
    const admission = new SettingsAdmission();
    const first = gate();
    const second = gate();
    const a = admission.command('thread-a', 'same-request', () => first.wait);
    const b = admission.command('thread-a', 'same-request', () => second.wait);
    first.release();
    await a;
    expect(admission.hasCommand('thread-a')).toBe(true);
    await expect(admission.mutation('thread-a', async () => true)).rejects.toBeInstanceOf(SettingsBusyError);
    second.release();
    await b;
    expect(admission.hasCommand('thread-a')).toBe(false);
  });
});

describe('recovery admission fencing', () => {
  it('retires cancellable readers without allowing their late completion to release a newer reader', async () => {
    const admission = new SettingsAdmission();
    const old = gate();
    const next = gate();
    let current!: () => boolean;
    const first = admission.command('thread', 'same-id', async isCurrent => { current = isCurrent; await old.wait; }, true);
    expect(current()).toBe(true);
    await admission.recovery('thread', async () => expect(current()).toBe(false));
    const second = admission.command('thread', 'same-id', () => next.wait, true);
    old.release();
    await first;
    expect(admission.hasCommand('thread')).toBe(true);
    await expect(admission.mutation('thread', async () => undefined)).rejects.toBeInstanceOf(SettingsBusyError);
    next.release();
    await second;
    expect(admission.hasCommand('thread')).toBe(false);
  });

  it('does not revoke native settings operations or allow overlapping recovery writers', async () => {
    const admission = new SettingsAdmission();
    const hold = gate();
    const native = admission.command('thread', 'compact', () => hold.wait);
    await expect(admission.recovery('thread', async () => undefined)).rejects.toBeInstanceOf(SettingsBusyError);
    hold.release();
    await native;
    const reset = gate();
    const recovery = admission.recovery('thread', () => reset.wait);
    await expect(admission.recovery('thread', async () => undefined)).rejects.toBeInstanceOf(SettingsBusyError);
    reset.release();
    await recovery;
  });
});
