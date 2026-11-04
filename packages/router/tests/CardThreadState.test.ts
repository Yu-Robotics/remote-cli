import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { JsonStore } from '../src/storage/JsonStore';
import { BindingManager } from '../src/binding/BindingManager';
import { CARD_THREAD_TTL_MS, MAX_CARD_THREADS, MAX_DEVICE_CARD_THREADS, reconcileCardThreads } from '../src/storage/CardThreadState';

// Real snapshots exercise the same atomic write queue used by Router card registration.
describe('durable card associations', () => {
  let directory: string;
  let filename: string;
  let store: JsonStore;
  let bindings: BindingManager;
  beforeEach(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'router-card-state-')));
    vi.spyOn(os, 'homedir').mockReturnValue(directory);
    filename = path.join(directory, 'bindings.json');
    store = new JsonStore(filename, 0);
    await store.initialize();
    bindings = new BindingManager(store);
    await bindings.bindUser('user-a', 'device-a', 'A');
  });
  afterEach(async () => {
    await store.flush().catch(() => undefined);
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const reload = async (filename: string) => {
    const loaded = new JsonStore(filename, 0);
    await loaded.initialize();
    return loaded;
  };
  function entry(expiresAt = Date.now() + CARD_THREAD_TTL_MS) {
    return { threadId: 'thread-a', deviceId: 'device-a', openId: 'user-a',
      epoch: store.getCardThreadEpoch('user-a', 'device-a'), expiresAt };
  }

  it('preserves expiration through updates and reload, then removes expired records', async () => {
    const first = entry(Date.now() + 1000);
    await store.setCardThread('card-a', first);
    await store.setCardThread('card-a', entry());
    expect((await reload(filename)).getCardThread('card-a')).toEqual(first);
    vi.spyOn(Date, 'now').mockReturnValue(first.expiresAt);
    const expired = await reload(filename);
    expect(expired.getCardThread('card-a')).toBeUndefined();
    expect(JSON.parse(await fs.readFile(filename, 'utf8')).cardThreads.cards).toEqual({});
  });

  it.each([
    ['missing optional state', (raw: any) => { delete raw.cardThreads; }],
    ['invalid state version', (raw: any) => { raw.cardThreads.version = 2; }],
    ['malformed generations', (raw: any) => { raw.cardThreads.generations['device-a'].epoch = 0; }],
    ['malformed card', (raw: any) => { raw.cardThreads.cards['card-a'].openId = {}; }],
    ['excessive lifetime', (raw: any) => { raw.cardThreads.cards['card-a'].expiresAt = Date.now() + CARD_THREAD_TTL_MS * 2; }],
    ['unbound owner', (raw: any) => { raw.cardThreads.cards['card-a'].openId = 'other-user'; }],
  ])('discards %s authority while preserving bindings', async (_name, corrupt) => {
    await store.setCardThread('card-a', entry());
    const raw = JSON.parse(await fs.readFile(filename, 'utf8'));
    corrupt(raw);
    await fs.writeFile(filename, JSON.stringify(raw));
    const loaded = await reload(filename);
    expect(loaded.getUserByDeviceId('device-a')).toBe('user-a');
    expect(loaded.getCardThread('card-a')).toBeUndefined();
  });

  it('persists explicit removal and rejects delayed registration after revocation', async () => {
    const old = entry();
    await store.setCardThread('card-a', old);
    await store.removeCardThread('card-a');
    expect((await reload(filename)).getCardThread('card-a')).toBeUndefined();
    await store.invalidateDeviceCards('device-a');
    await store.setCardThread('late-card', old);
    expect((await reload(filename)).getCardThread('late-card')).toBeUndefined();
  });

  it.each(['switch', 'unbind', 'unbind-all', 'revoke'])('persists %s invalidation independently of Router callbacks', async action => {
    await bindings.bindUser('user-a', 'device-b', 'B');
    const old = entry();
    await store.setCardThread('card-a', old);
    if (action === 'switch') {
      await bindings.switchActiveDevice('user-a', 'device-b');
      await bindings.switchActiveDevice('user-a', 'device-a');
    } else if (action === 'revoke') await store.invalidateDeviceCards('device-a');
    else {
      if (action === 'unbind') await bindings.unbindDevice('user-a', 'device-a');
      else await bindings.unbindUser('user-a');
      await bindings.bindUser('user-a', 'device-a', 'A');
    }
    await store.setCardThread('late-card', old);
    const loaded = await reload(filename);
    expect(loaded.getCardThread('card-a')).toBeUndefined();
    expect(loaded.getCardThread('late-card')).toBeUndefined();
    expect(loaded.getCardThreadEpoch('user-a', 'device-a')).not.toBe(old.epoch);
  });

  it('does not publish a registration when replacement fails', async () => {
    vi.spyOn(store as any, 'writeSnapshot').mockRejectedValueOnce(new Error('Synthetic disk failure'));
    await expect(store.setCardThread('card-a', entry())).rejects.toThrow('Synthetic disk failure');
    expect(store.getCardThread('card-a')).toBeUndefined();
    expect((await reload(filename)).getCardThread('card-a')).toBeUndefined();
  });

  it('bounds global and per-device retention, evicting the oldest original expiration', async () => {
    for (let i = 1; i < 6; i++) await bindings.bindUser('user-a', `device-${i}`, `Device ${i}`);
    const raw = JSON.parse(await fs.readFile(filename, 'utf8'));
    const expiresAt = Date.now() + CARD_THREAD_TTL_MS;
    for (const [deviceId, generation] of Object.entries(raw.cardThreads.generations) as [string, any][]) {
      for (let i = 0; i <= MAX_DEVICE_CARD_THREADS; i++) {
        raw.cardThreads.cards[`${deviceId}-${i}`] = { ...entry(expiresAt - i), deviceId, epoch: generation.epoch };
      }
    }
    const state = reconcileCardThreads(raw.cardThreads, raw.userBindings, raw.deviceToUserMap);
    expect(Object.keys(state.cards)).toHaveLength(MAX_CARD_THREADS);
    const counts = new Map<string, number>();
    for (const card of Object.values(state.cards)) counts.set(card.deviceId, (counts.get(card.deviceId) ?? 0) + 1);
    expect([...counts.values()].every(count => count <= MAX_DEVICE_CARD_THREADS)).toBe(true);
    expect(state.cards[`device-a-${MAX_DEVICE_CARD_THREADS}`]).toBeUndefined();
  });
  it('fences reads and queued registrations while removal waits for disk', async () => {
    const old = entry();
    await store.setCardThread('card-a', old);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const write = (store as any).writeSnapshot.bind(store);
    vi.spyOn(store as any, 'writeSnapshot').mockImplementationOnce(async (snapshot: unknown) => {
      entered();
      await gate;
      return write(snapshot);
    });
    const registration = store.setCardThread('card-a', old);
    await started;
    const removal = store.removeCardThread('card-a');
    expect(store.getCardThread('card-a')).toBeUndefined();
    release();
    await Promise.all([registration, removal]);
    expect((await reload(filename)).getCardThread('card-a')).toBeUndefined();
  });

  it.each(['flush', 'pruneCardThreads'] as const)('retries failed removals during %s before restart', async retry => {
    await store.setCardThread('card-a', entry());
    vi.spyOn(store as any, 'writeSnapshot').mockRejectedValueOnce(new Error('Synthetic disk failure'));
    await expect(store.removeCardThread('card-a')).rejects.toThrow('Synthetic disk failure');
    expect(store.getCardThread('card-a')).toBeUndefined();
    await store[retry]();
    expect((await reload(filename)).getCardThread('card-a')).toBeUndefined();
  });

  it('reports repeated removal failures and keeps the card fenced until persistence recovers', async () => {
    await store.setCardThread('card-a', entry());
    const write = vi.spyOn(store as any, 'writeSnapshot').mockRejectedValue(new Error('Synthetic disk failure'));
    await expect(store.removeCardThread('card-a')).rejects.toThrow('Synthetic disk failure');
    await expect(store.flush()).rejects.toThrow('Synthetic disk failure');
    await expect(store.pruneCardThreads()).rejects.toThrow('Synthetic disk failure');
    expect(store.getCardThread('card-a')).toBeUndefined();
    write.mockRestore();
    await store.flush();
    expect((await reload(filename)).getCardThread('card-a')).toBeUndefined();
  });

  it('coalesces overlapping removals without releasing their read fence early', async () => {
    await store.setCardThread('card-a', entry());
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const original = (store as any).writeSnapshot.bind(store);
    const write = vi.spyOn(store as any, 'writeSnapshot').mockImplementationOnce(async snapshot => {
      entered();
      await gate;
      return original(snapshot);
    });
    const first = store.removeCardThread('card-a');
    await started;
    const second = store.removeCardThread('card-a');
    try {
      expect(first).toBe(second);
      expect(store.getCardThread('card-a')).toBeUndefined();
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await Promise.allSettled([first, second]);
    }
    expect((await reload(filename)).getCardThread('card-a')).toBeUndefined();
  });

});
