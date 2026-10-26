import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { JsonStore } from '../src/storage/JsonStore';
import { BindingManager } from '../src/binding/BindingManager';
import { ThreadSelectionManager } from '../src/binding/ThreadSelectionManager';

describe('ThreadSelectionManager', () => {
  let home: string;
  let previousHome: string | undefined;
  let storePath: string;
  let store: JsonStore;
  let bindings: BindingManager;
  let selections: ThreadSelectionManager;
  let notices: string[];

  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(process.cwd(), '.thread-selection-test-')));
    previousHome = process.env.HOME;
    process.env.HOME = home;
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    storePath = path.join(home, 'bindings.json');
    store = new JsonStore(storePath, 0);
    await store.initialize();
    bindings = new BindingManager(store);
    notices = [];
    selections = new ThreadSelectionManager(bindings, {
      names: () => undefined,
      notify: async (_openId, text) => { notices.push(text); },
    });
    await bindings.bindUser('user-a', 'device-a', 'A');
    await bindings.bindUser('user-a', 'device-b', 'B');
  });

  afterEach(async () => {
    await store.flush().catch(() => undefined);
    vi.restoreAllMocks();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await fs.rm(home, { recursive: true, force: true });
  });

  it('restores independent per-device selections after reconstruction and A-B-A switching', async () => {
    expect(await selections.select('user-a', 'device-a', 'thread-a', 'A')).toBe('selected');
    await bindings.switchActiveDevice('user-a', 'device-b');
    expect(await selections.select('user-a', 'device-b', 'thread-b', 'B')).toBe('selected');
    expect(await selections.select('user-b', 'device-b', 'not-owner', 'B')).toBe('stale');

    await bindings.switchActiveDevice('user-a', 'device-b');
    expect((await selections.resolve('user-a', 'device-b'))?.threadId).toBe('thread-b');
    await bindings.switchActiveDevice('user-a', 'device-a');
    expect((await selections.resolve('user-a', 'device-a'))?.threadId).toBe('thread-a');

    const restoredStore = new JsonStore(storePath, 0);
    await restoredStore.initialize();
    const restored = new ThreadSelectionManager(new BindingManager(restoredStore), { names: () => undefined });
    expect((await restored.resolve('user-a', 'device-a'))?.threadId).toBe('thread-a');
    expect((await restored.resolve('user-a', 'device-b'))?.threadId).toBe('thread-b');
  });

  it('does not reuse a previous thread name after selecting a newly created thread', async () => {
    await selections.select('user-a', 'device-a', 'old-thread', 'Old Thread');
    const intent = selections.beginIntent('user-a', 'device-a');
    expect(await selections.completeNew(intent, 'new-thread')).toBe('selected');
    expect(await selections.resolve('user-a', 'device-a')).toEqual({ threadId: 'new-thread', threadName: 'new-thread' });
    await selections.observeCatalog('user-a', 'device-a', intent, [
      { id: 'default-id', name: 'default', status: 'idle' }, { id: 'new-thread', name: 'New Thread', status: 'idle' },
    ]);
    expect(await selections.resolve('user-a', 'device-a')).toEqual({ threadId: 'new-thread', threadName: 'New Thread' });
  });

  it('does not resurrect a selection after unbind and rebind', async () => {
    await selections.select('user-a', 'device-a', 'thread-a');
    await bindings.unbindDevice('user-a', 'device-a');
    await bindings.bindUser('user-a', 'device-a', 'A');
    expect(await selections.resolve('user-a', 'device-a')).toBeUndefined();
  });

  it('quarantines a malformed optional preference without disabling auth or overwriting it', async () => {
    await store.flush();
    const raw = JSON.parse(await fs.readFile(storePath, 'utf8'));
    raw.userBindings['user-a'].devices[0].selectedThreadId = 42;
    await fs.writeFile(storePath, JSON.stringify(raw), { mode: 0o600 });

    const loaded = new JsonStore(storePath, 0);
    await loaded.initialize();
    const loadedBindings = new BindingManager(loaded);
    const loadedSelections = new ThreadSelectionManager(loadedBindings, { names: () => undefined });
    expect((await loadedBindings.getDeviceBinding('device-a'))?.openId).toBe('user-a');
    await expect(loadedSelections.resolve('user-a', 'device-a')).rejects.toThrow('Select a thread again');
    await loadedBindings.updateLastActive('user-a');
    const preserved = JSON.parse(await fs.readFile(storePath, 'utf8'));
    expect(preserved.userBindings['user-a'].devices[0].selectedThreadId).toBe(42);

    expect(await loadedSelections.select('user-a', 'device-a', 'repaired')).toBe('selected');
    expect((await loadedSelections.resolve('user-a', 'device-a'))?.threadId).toBe('repaired');
    await loaded.flush();
  });

  it('queues preference writes after previously admitted debounced writes without waiting for debounce', async () => {
    const slowStore = new JsonStore(storePath, 60_000);
    await slowStore.initialize();
    const slowBindings = new BindingManager(slowStore);
    const slowSelections = new ThreadSelectionManager(slowBindings, { names: () => undefined });
    const order: string[] = [];
    const prior = slowStore.setBindingCode('prior-code', {
      code: 'prior-code', deviceId: 'device-a', createdAt: Date.now(), expiresAt: Date.now() + 1000,
    }).then(() => { order.push('binding'); });
    const selected = slowSelections.select('user-a', 'device-a', 'thread-a').then(result => {
      order.push('selection');
      return result;
    });
    await expect(selected).resolves.toBe('selected');
    await prior;
    expect(order).toEqual(['binding', 'selection']);
    expect(await slowStore.getBindingCode('prior-code')).toMatchObject({ deviceId: 'device-a' });
    expect((await slowSelections.resolve('user-a', 'device-a'))?.threadId).toBe('thread-a');
    await slowStore.flush();
  });

  it('fences late New Thread results by intent revision and ownership epoch', async () => {
    const first = selections.beginIntent('user-a', 'device-a');
    const second = selections.beginIntent('user-a', 'device-a');
    expect(await selections.completeNew(first, 'created-first')).toBe('stale');
    expect(await selections.completeNew(second, 'created-second')).toBe('selected');
    expect(await selections.select('user-a', 'device-a', 'explicit-later')).toBe('selected');
    expect(await selections.completeNew(second, 'created-second')).toBe('stale');
    expect((await selections.resolve('user-a', 'device-a'))?.threadId).toBe('explicit-later');

    const pending = selections.beginIntent('user-a', 'device-a');
    selections.invalidateDevice('user-a', 'device-a');
    expect(await selections.completeNew(pending, 'created-after-rebind')).toBe('stale');
  });

  it('does not persist New Thread selection after the original socket becomes stale', async () => {
    const pending = selections.beginIntent('user-a', 'device-a');
    expect(await selections.completeNew(pending, 'created-thread', () => false)).toBe('stale');
    expect(await selections.resolve('user-a', 'device-a')).toBeUndefined();
  });

  it('clears and notifies only for a current authoritative deletion', async () => {
    await selections.select('user-a', 'device-a', 'thread-a');
    const current = selections.capture('user-a', 'device-a');
    const catalog = [{ id: 'default-id', name: 'default', status: 'idle' as const }];
    expect(await selections.observeCatalog('user-a', 'device-a', current, catalog)).toBe('deleted');
    expect(await selections.resolve('user-a', 'device-a')).toBeUndefined();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('Future messages will use default');

    await selections.select('user-a', 'device-a', 'thread-a');
    const stale = selections.capture('user-a', 'device-a');
    selections.beginIntent('user-a', 'device-a');
    expect(await selections.observeCatalog('user-a', 'device-a', stale, catalog)).toBe('stale');
    expect((await selections.resolve('user-a', 'device-a'))?.threadId).toBe('thread-a');
  });

  it.each([
    { scenario: 'empty', catalog: [] },
    { scenario: 'missing default', catalog: [{ id: 'other', name: 'Other', status: 'idle' }] },
    { scenario: 'duplicate ID', catalog: [{ id: 'same', name: 'default', status: 'idle' }, { id: 'same', name: 'Other', status: 'idle' }] },
    { scenario: 'invalid status', catalog: [{ id: 'default-id', name: 'default', status: 'unknown' }] },
    { scenario: 'missing ID', catalog: [{ name: 'default', status: 'idle' }] },
    { scenario: 'oversized', catalog: Array.from({ length: 101 }, (_, index) => ({ id: `thread-${index}`, name: index ? `Thread ${index}` : 'default', status: 'idle' })) },
  ])('preserves selection for a $scenario catalog', async ({ catalog }) => {
    await selections.select('user-a', 'device-a', 'thread-a');
    const fence = selections.capture('user-a', 'device-a');
    expect(await selections.observeCatalog('user-a', 'device-a', fence, catalog as any)).toBe('none');
    expect(store.getDeviceThreadSelection('user-a', 'device-a')).toEqual({ status: 'valid', threadId: 'thread-a' });
    expect(notices).toHaveLength(0);
  });

  it('does not persist a superseded deletion while an earlier disk write is blocked', async () => {
    await selections.select('user-a', 'device-a', 'thread-a');
    const fence = selections.capture('user-a', 'device-a');
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
    const prior = store.setDeviceToUserMap('other-device', 'user-a');
    const setSelection = vi.spyOn(store, 'setDeviceThreadSelection');
    const clearing = selections.observeCatalog('user-a', 'device-a', fence,
      [{ id: 'default-id', name: 'default', status: 'idle' }]);
    try {
      await started;
      expect(setSelection).toHaveBeenCalled();
      selections.beginIntent('user-a', 'device-a');
    } finally { release(); }
    await prior;
    expect(await clearing).toBe('stale');
    expect(store.getDeviceThreadSelection('user-a', 'device-a')).toEqual({ status: 'valid', threadId: 'thread-a' });
    const reloaded = new JsonStore(storePath, 0);
    await reloaded.initialize();
    expect(reloaded.getDeviceThreadSelection('user-a', 'device-a')).toEqual({ status: 'valid', threadId: 'thread-a' });
    await reloaded.flush();
    expect(notices).toHaveLength(0);
  });

  it('requires an exact current missing-thread match before resetting without replay', async () => {
    await selections.select('user-a', 'device-a', 'thread-a');
    const fence = selections.capture('user-a', 'device-a');
    expect(await selections.handleMissingThread('user-a', 'device-a', fence, 'other-thread')).toBe('none');
    expect(await selections.handleMissingThread('user-a', 'device-a', fence, 'thread-a')).toBe('deleted');
    expect(await selections.resolve('user-a', 'device-a')).toBeUndefined();
    expect(notices).toHaveLength(1);
  });
});
