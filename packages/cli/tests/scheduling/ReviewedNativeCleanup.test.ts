import { describe, expect, it, vi } from 'vitest';
import { ReviewedNativeCleanup, cleanupInventory, type NativeCleanupDefinition, type NativeCleanupSession } from '../../src/scheduling/ReviewedNativeCleanup';
const definition = (id = 'legacy-one'): NativeCleanupDefinition => ({ id, prompt: `Synthetic ${id}`, cron: '* * * * *', recurring: true, durable: false });
function fixture() {
  let now = 1000, valid = true;
  let entries = [definition(), definition('sibling')];
  const manager = new ReviewedNativeCleanup(() => now, 1000);
  const host: NativeCleanupSession = { binding: 'host-one', sessionId: 'session-one', current: () => valid,
    inventory: vi.fn(async () => structuredClone(entries)),
    remove: vi.fn(async target => { entries = entries.filter(entry => entry.id !== target.id); }) };
  return { manager, host, entries: () => entries, change: (rows: NativeCleanupDefinition[]) => { entries = rows; },
    expire: () => { now += 1001; }, retire: () => { valid = false; } };
}
describe('owner-reviewed native cleanup', () => {
  it('reviews native-only and legacy definitions without inventing recovery metadata, and preserves siblings', async () => {
    const f = fixture(); const observe = vi.fn(async () => {});
    const review = await f.manager.prepare('owner-thread-epoch', 'review', f.host);
    expect(review.candidates).toEqual(f.entries());
    expect(review.warning).toContain('unknown');
    expect(await f.manager.prepare('owner-thread-epoch', 'review', f.host)).toEqual(review);
    const result = await f.manager.confirm('owner-thread-epoch', 'confirm', review.token, ['legacy-one'], f.host, observe);
    expect(result.absentIds).toEqual(['legacy-one']); expect(f.entries()).toEqual([definition('sibling')]);
    expect(observe.mock.calls.map(call => call[1])).toEqual([false, true]);
    await f.manager.confirm('owner-thread-epoch', 'confirm', review.token, ['legacy-one'], f.host);
    expect(f.host.remove).toHaveBeenCalledTimes(1);
  });
  it('retains the full forecast for review while allowing only nextFireAt to advance', async () => {
    const f = fixture(); f.entries()[0].nextFireAt = 1893459600000;
    const review = await f.manager.prepare('owner', 'review', f.host);
    expect(review.candidates[0].nextFireAt).toBe(1893459600000);
    f.entries()[0].nextFireAt = 1893459660000;
    expect((await f.manager.prepare('owner', 'review', f.host)).digest).toBe(review.digest);
    await expect(f.manager.confirm('owner', 'confirm', review.token, ['legacy-one'], f.host)).resolves.toHaveProperty('absentIds', ['legacy-one']);
    expect(() => cleanupInventory({ jobs: [{ ...definition(), nextFireAt: {} }] })).toThrow();
  });
  it('reviews project jobs without claiming their session provenance and preserves them during session-only cleanup', async () => {
    const f = fixture();
    const project = { ...definition('project') }; delete project.durable;
    f.change([definition(), project, { ...definition('durable'), durable: true }]);
    expect(cleanupInventory({ jobs: f.entries() })).toHaveLength(3);
    const review = await f.manager.prepare('owner', 'review', f.host);
    expect(review.blockedIds).toEqual(['project', 'durable']);
    for (const id of review.blockedIds) {
      await expect(f.manager.confirm('owner', 'confirm', review.token, [id], f.host)).rejects.toThrow('lack session attribution');
    }
    expect(f.host.remove).not.toHaveBeenCalled();
    await f.manager.confirm('owner', 'confirm', review.token, ['legacy-one'], f.host);
    expect(f.entries().map(entry => entry.id)).toEqual(['project', 'durable']);
  });
  it.each(['owner', 'binding', 'session', 'expiry', 'current'])('rejects a stale %s before native deletion', async kind => {
    const f = fixture(); const review = await f.manager.prepare('owner', 'review', f.host);
    if (kind === 'binding') f.host.binding = 'replacement';
    if (kind === 'session') f.host.sessionId = 'other';
    if (kind === 'expiry') f.expire();
    if (kind === 'current') f.retire();
    await expect(f.manager.confirm(kind === 'owner' ? 'foreign' : 'owner', 'confirm', review.token, ['legacy-one'], f.host)).rejects.toThrow('expired or owner/session/host changed');
    expect(f.host.remove).not.toHaveBeenCalled();
  });
  it.each(['prompt', 'cron', 'recurring', 'durable', 'sibling', 'missing', 'extra'])('invalidates a changed %s inventory', async field => {
    const f = fixture(); const review = await f.manager.prepare('owner', 'review', f.host);
    const rows = f.entries();
    if (field === 'missing') f.change(rows.slice(1));
    else if (field === 'extra') f.change([...rows, definition('unknown')]);
    else if (field === 'sibling') rows[1].prompt = 'changed sibling';
    else (rows[0] as any)[field] = typeof rows[0][field] === 'boolean' ? !rows[0][field] : 'changed';
    await expect(f.manager.confirm('owner', 'confirm', review.token, ['legacy-one'], f.host)).rejects.toThrow('inventory changed');
    expect(f.host.remove).not.toHaveBeenCalled();
  });
  it('retains uncertainty when a selected job disappears without a deletion receipt', async () => {
    const f = fixture(); const review = await f.manager.prepare('owner', 'review', f.host);
    vi.mocked(f.host.remove).mockImplementation(async target => { f.change(f.entries().filter(entry => entry.id !== target.id)); throw new Error('lost receipt'); });
    const observe = vi.fn(async () => {});
    await expect(f.manager.confirm('owner', 'confirm', review.token, ['legacy-one'], f.host, observe)).rejects.toThrow('lost receipt');
    await expect(f.manager.confirm('owner', 'confirm', review.token, ['legacy-one'], f.host, observe)).rejects.toThrow('inventory changed');
    expect(f.host.remove).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls).toHaveLength(1);
    expect(observe).toHaveBeenCalledWith(expect.any(Array), false);
    await expect(f.manager.confirm('owner', 'different', review.token, ['legacy-one'], f.host)).rejects.toThrow('already started');
    await expect(f.manager.confirm('owner', 'confirm', review.token, ['sibling'], f.host)).rejects.toThrow('already started');
  });
  it('keeps uncertain deletion retryable and refuses resurrected or changed definitions', async () => {
    const f = fixture(); const review = await f.manager.prepare('owner', 'review', f.host);
    vi.mocked(f.host.remove).mockRejectedValueOnce(new Error('unconfirmed'));
    await expect(f.manager.confirm('owner', 'confirm', review.token, ['legacy-one'], f.host)).rejects.toThrow('unconfirmed');
    await f.manager.confirm('owner', 'confirm', review.token, ['legacy-one'], f.host);
    f.change([definition(), definition('sibling')]);
    await expect(f.manager.confirm('owner', 'confirm', review.token, ['legacy-one'], f.host)).rejects.toThrow('inventory changed');
    expect(f.host.remove).toHaveBeenCalledTimes(2);
  });
  it('requires absence after deletion and stops when owner retires during inventory or persistence', async () => {
    const f = fixture(); const review = await f.manager.prepare('owner', 'review', f.host);
    vi.mocked(f.host.remove).mockResolvedValue(undefined);
    await expect(f.manager.confirm('owner', 'confirm', review.token, ['legacy-one'], f.host)).rejects.toThrow('not confirmed');
    await expect(f.manager.confirm('owner', 'confirm', review.token, ['legacy-one'], f.host, async () => f.retire())).rejects.toThrow('changed');
    expect(f.host.remove).toHaveBeenCalledTimes(1);
  });
  it('bounds review display, supports exact subsets, rejects guessed IDs and malformed selection', async () => {
    const f = fixture();
    await expect(f.manager.prepare('owner', 'bad', f.host, ['foreign'])).rejects.toThrow('not in the bound session');
    await expect(f.manager.prepare('owner', 'bad', f.host, ['legacy-one', 'legacy-one'])).rejects.toThrow('not in the bound session');
    const review = await f.manager.prepare('owner', 'review', f.host, ['legacy-one']);
    expect(review.candidates).toHaveLength(1);
    await expect(f.manager.prepare('owner', 'review', f.host, ['sibling'])).rejects.toThrow('different arguments');
    await expect(f.manager.confirm('owner', 'confirm', 'unknown', ['legacy-one'], f.host)).rejects.toThrow('Unknown');
    for (const ids of [[], ['sibling'], ['legacy-one', 'legacy-one']]) {
      await expect(f.manager.confirm('owner', 'confirm', review.token, ids, f.host)).rejects.toThrow('exact native IDs');
    }
    f.change(Array.from({ length: 5 }, (_, index) => ({ ...definition(`large-${index}`), prompt: 'x'.repeat(16000) })));
    await expect(f.manager.prepare('owner', 'large', f.host)).rejects.toThrow('too large to display');
    expect((await f.manager.prepare('owner', 'small', f.host, ['large-0'])).candidates).toHaveLength(1);
    f.expire();
    expect((await f.manager.prepare('owner', 'review', f.host, ['large-0'])).token).not.toBe(review.token);
  });
  it('rejects review replay after inventory changes and expiration during an inventory call', async () => {
    const f = fixture(); await f.manager.prepare('owner', 'review', f.host);
    f.change([]);
    await expect(f.manager.prepare('owner', 'review', f.host)).rejects.toThrow('inventory changed');
    vi.mocked(f.host.inventory).mockImplementation(async () => { f.retire(); return []; });
    await expect(f.manager.prepare('owner', 'another', f.host)).rejects.toThrow('changed');
  });
  it('rejects complete-inventory overflow and malformed structured fields, preserving omitted one-shot recurrence', () => {
    const once = { ...definition(), recurring: undefined }; delete once.recurring;
    expect(cleanupInventory({ jobs: [once] })).toEqual([once]);
    for (const value of [undefined, {}, { jobs: [], hasMore: true }, { jobs: {} }, { jobs: Array.from({ length: 101 }, (_, i) => definition(`job-${i}`)) },
      { jobs: [definition(), definition()] }, { jobs: [null] }, { jobs: [{ ...definition(), id: '__proto__' }] },
      ...['prompt', 'cron', 'recurring', 'durable'].map(field => ({ jobs: [{ ...definition(), [field]: 1 }] }))]) {
      expect(() => cleanupInventory(value)).toThrow();
    }
  });
});
