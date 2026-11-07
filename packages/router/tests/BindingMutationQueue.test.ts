import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { BindingManager } from '../src/binding/BindingManager';
import { JsonStore } from '../src/storage/JsonStore';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('binding mutation queues shared by store identity', () => {
  let root: string;
  let store: JsonStore;
  let first: BindingManager;
  let second: BindingManager;
  let stores: JsonStore[];
  let pending: Promise<unknown>[];
  let releases: Array<() => void>;

  function track<T>(operation: Promise<T>): Promise<T> {
    pending.push(operation);
    void operation.catch(() => {});
    return operation;
  }

  function gate() {
    const value = deferred();
    releases.push(value.resolve);
    return value;
  }

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'binding-mutation-queue-')));
    vi.spyOn(os, 'homedir').mockReturnValue(root);
    pending = []; releases = []; stores = [];
    store = new JsonStore(path.join(root, 'bindings.json'), 0);
    stores.push(store);
    await store.initialize();
    first = new BindingManager(store);
    second = new BindingManager(store);
    await first.bindUser('synthetic-owner', 'synthetic-device', 'Synthetic device');
  });

  afterEach(async () => {
    releases.forEach(release => release());
    await Promise.allSettled(pending);
    await Promise.all(stores.map(item => item.flush()));
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('holds another manager through the whole approval callback, including card invalidation', async () => {
    const entered = deferred(), release = gate();
    const events: string[] = [];
    const approval = track(first.approveExistingDeviceKey('synthetic-owner', 'synthetic-device',
      first.getCardThreadEpoch('synthetic-owner', 'synthetic-device'), async () => {
        // Invalidation is also called by production enrollment callbacks and must not re-enter the queue.
        await second.invalidateDeviceCards('synthetic-device');
        events.push('approval-start'); entered.resolve();
        await release.promise;
        events.push('approval-end');
      }));
    await entered.promise;
    const removal = track(second.unbindUser('synthetic-owner', async () => { events.push('revoke'); }));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(events).toEqual(['approval-start']);
    release.resolve();
    await Promise.all([approval, removal]);
    expect(events).toEqual(['approval-start', 'approval-end', 'revoke']);
    expect(await first.getDeviceBinding('synthetic-device')).toBeNull();
  });

  it('checks a queued approval against the epoch after unbind and same-owner rebind', async () => {
    const epoch = first.getCardThreadEpoch('synthetic-owner', 'synthetic-device');
    const entered = deferred(), release = gate();
    const removal = track(first.unbindUser('synthetic-owner', async () => {
      entered.resolve(); await release.promise;
    }));
    await entered.promise;
    const rebound = track(second.bindUser('synthetic-owner', 'synthetic-device', 'Synthetic rebound'));
    const approve = vi.fn(async () => {});
    const stale = track(second.approveExistingDeviceKey('synthetic-owner', 'synthetic-device', epoch, approve));
    release.resolve();
    await Promise.all([removal, rebound]);
    await expect(stale).rejects.toThrow('ownership changed');
    expect(approve).not.toHaveBeenCalled();
    expect(await first.getDeviceBinding('synthetic-device')).toMatchObject({ openId: 'synthetic-owner' });
  });

  it('continues queued mutations from another manager after an approval fails', async () => {
    const entered = deferred(), release = gate();
    const events: string[] = [];
    const approval = track(first.approveExistingDeviceKey('synthetic-owner', 'synthetic-device',
      first.getCardThreadEpoch('synthetic-owner', 'synthetic-device'), async () => {
        entered.resolve(); await release.promise;
        events.push('approval-failed');
        throw new Error('Synthetic key persistence failure');
      }));
    await entered.promise;
    const removal = track(second.unbindDevice('synthetic-owner', 'synthetic-device', async () => {
      events.push('revoke');
    }));
    release.resolve();
    await expect(approval).rejects.toThrow('Synthetic key persistence failure');
    await expect(removal).resolves.toBe(true);
    expect(events).toEqual(['approval-failed', 'revoke']);
    await second.bindUser('synthetic-owner', 'synthetic-device', 'Synthetic retry');
    expect(await first.getDeviceBinding('synthetic-device')).toMatchObject({ openId: 'synthetic-owner' });
  });

  it('drains callbacks from another manager on close while unrelated stores keep progressing', async () => {
    const otherStore = new JsonStore(path.join(root, 'other-bindings.json'), 0);
    stores.push(otherStore); await otherStore.initialize();
    const other = new BindingManager(otherStore);
    const entered = deferred(), release = gate();
    const approval = track(first.approveExistingDeviceKey('synthetic-owner', 'synthetic-device',
      first.getCardThreadEpoch('synthetic-owner', 'synthetic-device'), async () => {
        entered.resolve(); await release.promise;
      }));
    await entered.promise;
    let closed = false;
    const closing = track(second.close().then(() => { closed = true; }));
    await track(other.bindUser('independent-owner', 'independent-device', 'Independent device'));
    expect(closed).toBe(false);
    expect(await other.getDeviceBinding('independent-device')).toMatchObject({ openId: 'independent-owner' });
    release.resolve();
    await Promise.all([approval, closing]);
    expect(closed).toBe(true);
  });
});
