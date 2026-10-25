import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import { constants } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { newTipState, TipStore, validTimezone, type TipUserState } from '../../src/tips/TipStore';
import { TipService } from '../../src/tips/TipService';

describe('private Tips persistence', () => {
  let directory: string;
  let store: TipStore;
  const user = 'synthetic-store-user';
  const filename = async () => path.join(directory, (await fs.readdir(directory)).find(name => !name.endsWith('.off.json'))!);
  beforeEach(async () => { directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tips-store-test-'))); store = new TipStore(directory); });
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }); });

  it('defaults daily, hashes filenames and only writes private bounded JSON', async () => {
    const state = await store.load(user); expect(state.subscription).toBe('daily'); expect(state.timezone).toBe('Asia/Shanghai');
    await store.save(user, state); const file = await filename();
    expect(path.basename(file)).toMatch(/^[a-f0-9]{64}\.json$/);
    expect((await fs.stat(file)).mode & 0o077).toBe(0); expect((await fs.stat(directory)).mode & 0o077).toBe(0);
    expect(await store.load(user)).toEqual(state); expect(await fs.readFile(file, 'utf8')).not.toContain(user);
  });

  it.each([0, 1800000000000])('durably migrates an implicit off default while retaining mute %i and all user history', async muteUntil => {
    // Serialize the historical v1 shape independently of the current default-state factory.
    const previous: TipUserState = { version: 1, subscription: 'off', timezone: 'America/Los_Angeles',
      revision: randomUUID(), stopRevision: null, muteUntil: 0, lastActivity: 0, lastAutomaticAt: 0,
      seen: [], mastered: [], deliveries: [], cards: [] };
    previous.muteUntil = muteUntil; previous.lastActivity = 1000; previous.lastAutomaticAt = 500;
    previous.seen = ['tip-1', 'tip-2']; previous.mastered = ['tip-1'];
    previous.cards = [{ id: randomUUID(), cardId: 'synthetic-settings-card', kind: 'settings',
      createdAt: 1000, revision: previous.revision, used: ['mute:7'] }];
    previous.deliveries = [{ id: randomUUID(), tipId: 'tip-2', at: 500, automatic: true, state: 'unknown' }];
    const legacyFile = path.join(directory, `${createHash('sha256').update(user).digest('hex')}.json`);
    await fs.writeFile(legacyFile, JSON.stringify(previous), { mode: 0o600 });

    const migrated = await new TipStore(directory, 'UTC').load(user);
    expect(migrated).toEqual({ ...previous, subscription: 'daily', revision: expect.any(String) });
    expect(migrated.revision).not.toBe(previous.revision);
    expect(JSON.parse(await fs.readFile(await filename(), 'utf8'))).toEqual(migrated);
    expect(await new TipStore(directory).load(user)).toEqual(migrated);
  });

  it.each(['daily', 'weekly'] as const)('preserves an existing %s preference and prior explicit-stop evidence', async subscription => {
    const previous = newTipState('UTC'); previous.subscription = subscription;
    previous.stopRevision = randomUUID(); previous.muteUntil = 1800000000000;
    await store.save(user, previous);
    expect(await new TipStore(directory).load(user)).toEqual(previous);
  });

  it('preserves a legacy explicit stop even when its separate marker is absent', async () => {
    const previous = newTipState('UTC'); previous.subscription = 'off'; previous.stopRevision = randomUUID();
    await store.save(user, previous);
    expect(await new TipStore(directory).load(user)).toEqual(previous);
    expect(await fs.readdir(directory)).toHaveLength(1);
  });

  it('keeps a durable opt-out effective across restart even without a main record', async () => {
    await store.optOut(user);
    const stopped = await new TipStore(directory).load(user);
    expect(stopped.subscription).toBe('off'); expect(stopped.stopRevision).not.toBeNull();
    await store.save(user, stopped);
    expect(await new TipStore(directory).load(user)).toEqual(stopped);
  });

  it('fails closed when migration cannot persist and retries without losing the old record', async () => {
    const previous = newTipState('UTC'); previous.subscription = 'off'; await store.save(user, previous);
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('synthetic migration rename failure'));
    await expect(store.load(user)).rejects.toThrow('Tips storage is unavailable.');
    expect(JSON.parse(await fs.readFile(await filename(), 'utf8'))).toEqual(previous);
    expect(await fs.readdir(directory)).toHaveLength(1);
    expect((await store.load(user)).subscription).toBe('daily');
  });

  it.skipIf(process.platform === 'win32').each(['state', 'opt-out'])('rejects a %s FIFO without blocking reads or shutdown', async kind => {
    await store.save(user, newTipState('UTC'));
    const file = kind === 'state' ? await filename() : (await filename()).replace(/\.json$/, '.off.json');
    await fs.rm(file, { force: true });
    await promisify(execFile)('mkfifo', ['-m', '600', file]);
    let blocked = false; let release: ReturnType<typeof fs.open> | undefined;
    // A regression still gets an eventual writer, so a failed assertion cannot hang the test process.
    const watchdog = setTimeout(() => { blocked = true; release = fs.open(file, constants.O_RDWR | constants.O_NONBLOCK); }, 1000);
    const service = new TipService({ directory, catalog: [], users: async () => [], isBound: async () => true,
      canDeliver: async () => true, image: async () => null, create: async () => null, update: async () => {} });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(store.load(user)).rejects.toThrow('Tips storage is unavailable.');
      await service.activity(user); await service.stop();
      expect(blocked).toBe(false);
    } finally { clearTimeout(watchdog); await release?.then(handle => handle.close()); }
  });

  it('captures queued snapshots, serializes writes, and leaves no temporary artifacts', async () => {
    const first = newTipState('UTC'); const saving = store.save(user, first); first.subscription = 'weekly';
    await saving; expect((await store.load(user)).subscription).toBe('daily');
    await Promise.all([store.save(user, first), store.save(user, { ...first, subscription: 'daily' })]);
    expect((await store.load(user)).subscription).toBe('daily'); expect(await fs.readdir(directory)).toHaveLength(1);
  });

  it('normalizes a crash during dispatch to unknown without dropping seen or cooldown', async () => {
    const state = newTipState('UTC'); state.seen = ['tip-1']; state.lastAutomaticAt = 1000;
    state.deliveries.push({ id: randomUUID(), tipId: 'tip-1', at: 1000, automatic: true, state: 'dispatching' });
    await store.save(user, state);
    expect((await new TipStore(directory).load(user)).deliveries[0].state).toBe('unknown');
    expect((await store.load(user)).seen).toEqual(['tip-1']); expect((await store.load(user)).lastAutomaticAt).toBe(1000);
  });

  it.each([
    { version: 2 }, { subscription: 'unexpected' }, { timezone: 'Invalid/Zone' }, { revision: 'bad' }, { lastActivity: -1 },
    { seen: ['tip-1', 'tip-1'] }, { mastered: ['missing'] }, { seen: ['invalid id'] }, { privateField: 'not-allowed' },
    { deliveries: [{ state: 'unexpected' }] }, { cards: [{ cardId: 42 }] }, { cards: Array(129).fill({}) },
  ])('rejects invalid schema %j without replacing previous valid state', async invalid => {
    const state = newTipState('UTC'); await store.save(user, state);
    await expect(store.save(user, { ...state, ...invalid } as any)).rejects.toThrow('Tips storage is unavailable.');
    expect(await store.load(user)).toEqual(state);
    await fs.writeFile(await filename(), JSON.stringify({ ...state, ...invalid }));
    await expect(store.load(user)).rejects.toThrow('Tips storage is unavailable.');
  });

  it('rejects malformed, oversized, world-readable, non-file and symlinked records', async () => {
    await store.save(user, newTipState('UTC')); const file = await filename();
    await fs.writeFile(file, '{'); await expect(store.load(user)).rejects.toThrow();
    await fs.writeFile(file, ' '.repeat(256 * 1024 + 1)); await expect(store.load(user)).rejects.toThrow();
    await store.save(user, newTipState('UTC')); await fs.chmod(file, 0o644); await expect(store.load(user)).rejects.toThrow();
    await fs.rm(file); await fs.mkdir(file); await expect(store.load(user)).rejects.toThrow();
    await fs.rm(file, { recursive: true }); await fs.symlink(path.join(directory, 'missing'), file); await expect(store.load(user)).rejects.toThrow();
  });

  it('rejects an unsafe directory and invalid configured timezone', async () => {
    expect(() => new TipStore(directory, 'Invalid/Zone')).toThrow('Invalid Tips timezone.');
    expect(validTimezone(null)).toBe(false); expect(validTimezone('')).toBe(false); expect(validTimezone('UTC')).toBe(true);
    await fs.chmod(directory, 0o755); await expect(store.load(user)).rejects.toThrow();
    await fs.chmod(directory, 0o700);
    const target = path.join(directory, 'target'); await fs.mkdir(target, { mode: 0o700 });
    const link = path.join(directory, 'link'); await fs.symlink(target, link);
    await expect(new TipStore(link).load(user)).rejects.toThrow();
  });

  it('preserves the old record and cleans up on atomic rename failure', async () => {
    const previous = newTipState('UTC'); await store.save(user, previous);
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('synthetic rename failure'));
    await expect(store.save(user, { ...previous, subscription: 'weekly' })).rejects.toThrow();
    expect(await store.load(user)).toEqual(previous); expect(await fs.readdir(directory)).toHaveLength(1);
  });

  it('lets an independent opt-out win through main-state corruption and incomplete enrollment', async () => {
    const state = newTipState('UTC'); state.subscription = 'daily'; await store.save(user, state);
    await store.optOut(user); expect((await store.load(user)).subscription).toBe('off');
    await store.save(user, { ...state, subscription: 'weekly' }); expect((await store.load(user)).subscription).toBe('off');
    await store.clearOptOut(user); expect((await store.load(user)).subscription).toBe('weekly');
    await fs.writeFile(await filename(), '{'); await store.optOut(user); await expect(store.load(user)).rejects.toThrow();
    expect((await fs.readdir(directory)).some(name => name.endsWith('.off.json'))).toBe(true);
  });

  it('fails closed on an invalid stop marker instead of ignoring it', async () => {
    const previous = newTipState('UTC'); previous.subscription = 'off';
    await store.save(user, previous); await store.optOut(user);
    const marker = (await fs.readdir(directory)).find(name => name.endsWith('.off.json'))!;
    await fs.writeFile(path.join(directory, marker), JSON.stringify({ version: 1, off: false }));
    await expect(store.load(user)).rejects.toThrow();
    expect(JSON.parse(await fs.readFile(await filename(), 'utf8'))).toEqual(previous);
  });
});
