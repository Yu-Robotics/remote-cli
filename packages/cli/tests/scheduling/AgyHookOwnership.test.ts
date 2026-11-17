import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { once } from 'events';
import { installAgyScheduleHooks } from '../../src/scheduling/agy/AgyHookRelay';

let home: string;
beforeEach(async () => { home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agy-hook-owner-'))); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(home, { recursive: true, force: true }); });
const endpoint = { url: 'http://127.0.0.1:1/hook', token: 'synthetic-token' };
import { crashAgyOverlay } from './agyHookCrashFixture';
import { ownAgyHooks } from '../../src/scheduling/agy/AgyHookOwnership';
import { ownedSpawn, confirmOwnedProcessTreeExit } from '../../src/delegation/OwnershipRuntime';
vi.mock('../../src/delegation/OwnershipRuntime', async load => {
  const actual = await load<typeof import('../../src/delegation/OwnershipRuntime')>();
  const { syntheticOwnershipRuntime } = await import('../delegation/syntheticOwnershipRuntime');
  return syntheticOwnershipRuntime(actual);
});
describe('AGY owned hook crash leftovers', () => {
  it('recovers a proven dead overlay for a fresh explicit selection without native session loading', async () => {
    await crashAgyOverlay(home);
    const restore = await installAgyScheduleHooks(home, endpoint);
    await restore();
    await expect(fs.access(path.join(home, '.gemini', 'config', 'hooks.json'))).rejects.toThrow();
  });
});

describe('AGY hook ownership exclusion and transactional restoration', () => {
  const hooks = () => path.join(home, '.gemini', 'config', 'hooks.json');
  const metadata = () => path.join(home, '.remote-cli-agy-hooks.owner.json');
  it('does not replace a live owner, unlink its gate or run after restoration', async () => {
    const lease = await installAgyScheduleHooks(home, endpoint); const before = await fs.readFile(hooks());
    await expect(installAgyScheduleHooks(home, endpoint)).rejects.toThrow('still active');
    expect(await fs.readFile(hooks())).toEqual(before); await lease(); await lease();
    expect(() => lease.run(() => undefined)).toThrow('changed');
    expect((await fs.lstat(path.join(home, '.remote-cli-agy-hooks.gate'))).isFile()).toBe(true);
  });
  it('requires exact child-tree join even while the overlay owner is still running', async () => {
    const lease = await installAgyScheduleHooks(home, endpoint);
    const child = lease.run(() => ownedSpawn(process.execPath, ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'ignore'] }));
    const exit = once(child, 'close'); await once(child.stdout!, 'data');
    try { await expect(lease()).rejects.toThrow('still active'); }
    finally { child.kill('SIGKILL'); await exit; }
    // The fixture has no descendants; exact exit is known and is recorded using
    // the same receipt API as ManagedProcessGroups.
    confirmOwnedProcessTreeExit(child); await lease();
  });
  it.skipIf(process.platform === 'win32')('free parent gate never overrides a surviving native group', async () => {
    const native = spawn(process.execPath, ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const exit = once(native, 'close'); await once(native.stdout!, 'data');
    try {
      await crashAgyOverlay(home, { groupPid: native.pid });
      const before = await fs.readFile(hooks());
      await expect(installAgyScheduleHooks(home, endpoint)).rejects.toThrow('still active');
      expect(await fs.readFile(hooks())).toEqual(before);
    } finally { native.kill('SIGKILL'); await exit; }
    const lease = await installAgyScheduleHooks(home, endpoint); await lease();
  });
  it('preserves unknown legacy overlays and gives ownership guidance, not helper advice', async () => {
    await fs.mkdir(path.dirname(hooks()), { recursive: true });
    const original = JSON.stringify({ 'remote-cli-native-schedule': { enabled: true }, user: {} });
    await fs.writeFile(hooks(), original);
    await expect(installAgyScheduleHooks(home, endpoint)).rejects.toThrow('prior overlay without ownership metadata');
    expect(await fs.readFile(hooks(), 'utf8')).toBe(original);
  });
  it('retains corrupt durable ownership and does not guess a dead parent from it', async () => {
    await crashAgyOverlay(home); await fs.writeFile(metadata(), '{}');
    const original = await fs.readFile(hooks());
    await expect(installAgyScheduleHooks(home, endpoint)).rejects.toThrow('cannot be proved');
    expect(await fs.readFile(hooks())).toEqual(original);
  });
  it('refuses changed owned group and preserves unrelated edits when recovered after a crash', async () => {
    await crashAgyOverlay(home); const original = await fs.readFile(hooks(), 'utf8');
    const edit = JSON.parse(original); edit['remote-cli-native-schedule'].enabled = false;
    await fs.writeFile(hooks(), JSON.stringify(edit));
    await expect(installAgyScheduleHooks(home, endpoint)).rejects.toThrow('changed');
    const safe = JSON.parse(original); safe['new-user-hooks'] = { enabled: false };
    await fs.writeFile(hooks(), JSON.stringify(safe));
    const lease = await installAgyScheduleHooks(home, endpoint); await lease();
    expect(JSON.parse(await fs.readFile(hooks(), 'utf8'))).toEqual({ 'new-user-hooks': { enabled: false } });
  });
  it('refuses replacement hook and private directory symlinks', async context => {
    await crashAgyOverlay(home); const original = await fs.readFile(hooks());
    const other = path.join(home, 'synthetic-other'); await fs.writeFile(other, original);
    await fs.unlink(hooks());
    try { await fs.symlink(other, hooks()); }
    catch (error) { if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') { context.skip(); return; } throw error; }
    await expect(installAgyScheduleHooks(home, endpoint)).rejects.toThrow('changed');
    expect(await fs.readFile(other)).toEqual(original);
  });
  it('releases the gate after pre-publication failure without removing user groups', async () => {
    expect(() => ownAgyHooks(home, () => { throw new Error('Synthetic build failure'); })).toThrow('changed');
    const lease = await installAgyScheduleHooks(home, endpoint); await lease();
  });
  it.each([2, 3, 4])('recovers an installation killed before atomic rename %s', async rename => {
    const shared = path.join(home, 'shared'); await fs.mkdir(shared); await fs.writeFile(path.join(shared, 'hooks.json'), '{}');
    await fs.mkdir(path.join(home, '.gemini'));
    await fs.symlink(shared, path.join(home, '.gemini', 'config'), process.platform === 'win32' ? 'junction' : 'dir');
    await crashAgyOverlay(home, { crashRename: rename });
    const lease = await installAgyScheduleHooks(home, endpoint); await lease();
    expect((await fs.lstat(path.join(home, '.gemini', 'config'))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(shared, 'hooks.json'), 'utf8')).toBe('{}');
  });
  it.each([2, 3, 4])('recovers restoration killed before atomic rename %s', async rename => {
    const shared = path.join(home, 'shared'); await fs.mkdir(shared); await fs.writeFile(path.join(shared, 'hooks.json'), '{}');
    await fs.mkdir(path.join(home, '.gemini'));
    await fs.symlink(shared, path.join(home, '.gemini', 'config'), process.platform === 'win32' ? 'junction' : 'dir');
    await crashAgyOverlay(home, { crashRename: rename, restoring: true });
    const lease = await installAgyScheduleHooks(home, endpoint); await lease();
    expect((await fs.lstat(path.join(home, '.gemini', 'config'))).isSymbolicLink()).toBe(true);
  });
});

describe('AGY hook evidence remains conservative', () => {
  const meta = () => path.join(home, '.remote-cli-agy-hooks.owner.json');
  const hooks = () => path.join(home, '.gemini', 'config', 'hooks.json');
  async function journal() {
    const saved = JSON.parse(await fs.readFile(meta(), 'utf8')).value;
    return { saved, file: path.join(home, `.remote-cli-agy-hooks-${saved.token}`, 'processes') };
  }
  it.each(['reservation', 'partial', 'missing', 'unconfirmed-tree'])('does not replace an overlay with %s child evidence', async mode => {
    await crashAgyOverlay(home); const { saved, file } = await journal();
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    if (mode === 'missing') await fs.unlink(file);
    else if (mode === 'partial') await fs.appendFile(file, '{');
    else {
      await fs.appendFile(file, JSON.stringify({ id, event: 'reserve' }) + '\n');
      if (mode === 'unconfirmed-tree') await fs.appendFile(file, JSON.stringify({ id, event: 'spawn', pid: JSON.parse(saved.owner).pid, group: false }) + '\n');
    }
    const before = await fs.readFile(hooks());
    await expect(installAgyScheduleHooks(home, endpoint)).rejects.toThrow('cannot be proved');
    expect(await fs.readFile(hooks())).toEqual(before);
  });
  it('rejects truncated local closure receipts before removing hooks', async () => {
    const lease = await installAgyScheduleHooks(home, endpoint); const { file } = await journal();
    const original = await fs.readFile(file); await fs.writeFile(file, original.subarray(0, original.length - 1));
    await expect(lease()).rejects.toThrow('cannot be proved');
    await fs.writeFile(file, original); await lease();
  });
  it('does not overwrite a replacement file even when its group text matches', async () => {
    await crashAgyOverlay(home); const original = await fs.readFile(hooks());
    const replacement = path.join(home, 'replacement'); await fs.writeFile(replacement, original); await fs.rename(replacement, hooks());
    await expect(installAgyScheduleHooks(home, endpoint)).rejects.toThrow('changed');
    expect(await fs.readFile(hooks())).toEqual(original);
  });
  it('never follows a redirected per-HOME gate or ancestor', async context => {
    const outside = path.join(home, 'synthetic-outside'); await fs.mkdir(outside);
    const sharedFile = path.join(outside, 'gate'); await fs.writeFile(sharedFile, 'Synthetic untouched');
    const gate = path.join(home, '.remote-cli-agy-hooks.gate');
    try { await fs.symlink(sharedFile, gate); }
    catch (error) { if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') { context.skip(); return; } throw error; }
    await expect(installAgyScheduleHooks(home, endpoint)).rejects.toThrow('changed');
    expect(await fs.readFile(sharedFile, 'utf8')).toBe('Synthetic untouched'); await fs.unlink(gate);
    await fs.symlink(outside, path.join(home, '.gemini'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(installAgyScheduleHooks(home, endpoint)).rejects.toThrow('changed');
    expect(await fs.readdir(outside)).toEqual(['gate']);
  });
  it('refuses malformed user groups and oversized documents without publication', async () => {
    await fs.mkdir(path.dirname(hooks()), { recursive: true }); await fs.writeFile(hooks(), '[]');
    await expect(installAgyScheduleHooks(home, endpoint)).rejects.toThrow('changed');
    await fs.writeFile(hooks(), ' '.repeat(256 * 1024 + 1));
    await expect(installAgyScheduleHooks(home, endpoint)).rejects.toThrow('changed');
    expect((await fs.stat(hooks())).size).toBe(256 * 1024 + 1);
  });
});

it('preserves deleted shared links and unknown scratchpad files instead of sweeping user edits', async () => {
  const shared = path.join(home, 'shared'); await fs.mkdir(shared);
  await fs.writeFile(path.join(shared, 'hooks.json'), '{}'); await fs.writeFile(path.join(shared, 'settings.json'), '{}');
  await fs.mkdir(path.join(home, '.gemini'));
  const config = path.join(home, '.gemini', 'config');
  await fs.symlink(shared, config, process.platform === 'win32' ? 'junction' : 'dir');
  const lease = await installAgyScheduleHooks(home, endpoint);
  await fs.unlink(path.join(config, 'settings.json'));
  const t = JSON.parse(await fs.readFile(path.join(home, '.remote-cli-agy-hooks.owner.json'), 'utf8')).value;
  const note = path.join(home, `.remote-cli-agy-hooks-${t.token}`, 'user-note'); await fs.writeFile(note, 'Synthetic retained edit');
  await lease(); expect((await fs.lstat(config)).isDirectory()).toBe(true);
  await expect(fs.lstat(path.join(config, 'settings.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(note, 'utf8')).toBe('Synthetic retained edit');
  expect(await fs.readFile(path.join(shared, 'settings.json'), 'utf8')).toBe('{}');
});
