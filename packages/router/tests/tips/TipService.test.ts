import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { TipService, TIP_TRANSPORT_TIMEOUT } from '../../src/tips/TipService';
import { newTipState, TipStore } from '../../src/tips/TipStore';
import { ui } from '../../src/tips/TipCards';
import type { TipServiceOptions } from '../../src/tips/TipTypes';

const DAY = 86400_000;
const user = 'synthetic-user';
const catalog = Array.from({ length: 32 }, (_, index) => ({ id: `tip-${index}`, topic: 'Topic', title: `Tip ${index}`,
  problem: 'A synthetic problem', benefit: 'Less effort', action: 'Read the example', example: '/backend 1 @', detail: 'Static detail', image: `tip-${index}.png` }));

describe('Router-owned Tips', () => {
  let directory: string;
  let now: number;
  let options: TipServiceOptions;
  let service: TipService;
  let store: TipStore;
  let sequence: number;
  const services: TipService[] = [];
  const createService = () => { const next = new TipService(options); services.push(next); return next; };
  const state = () => store.load(user);
  const subscribe = async (frequency = 'daily') => { await service.command(user, `/tips ${frequency}`); vi.mocked(options.create).mockClear(); };
  const quiet = () => { now += 120_000; };
  const click = async (op: string, value?: string, receipt?: Awaited<ReturnType<typeof state>>['cards'][number]) => {
    const card = receipt ?? (await state()).cards.at(-1)!;
    return service.action(user, card.cardId!, { action: 'tips', id: card.id, op, ...(value === undefined ? {} : { value }) });
  };

  beforeEach(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tips-core-test-')));
    now = Date.parse('2026-10-27T02:30:00Z'); sequence = 0;
    options = { directory, catalog, now: () => now, users: vi.fn().mockResolvedValue([user, user]),
      isBound: vi.fn().mockResolvedValue(true), canDeliver: vi.fn().mockResolvedValue(true),
      image: vi.fn().mockResolvedValue('synthetic-image-key'), create: vi.fn().mockImplementation(async () => `synthetic-card-${++sequence}`),
      update: vi.fn().mockResolvedValue(undefined) };
    store = new TipStore(directory);
    service = createService();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(services.splice(0).map(instance => instance.stop()));
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('delivers daily without manual subscription after activity and quiet, retaining deduplication across restart', async () => {
    await service.tick(); expect(options.create).not.toHaveBeenCalled();
    await service.activity(user); await service.tick(); expect(options.create).not.toHaveBeenCalled();
    quiet(); await service.tick(); expect(options.create).toHaveBeenCalledTimes(1);
    expect((await state()).subscription).toBe('daily'); expect((await state()).seen).toEqual(['tip-0']);
    await service.stop(); service = createService(); await service.tick();
    expect(options.create).toHaveBeenCalledTimes(1);
    now += DAY; await service.tick(); expect(options.create).toHaveBeenCalledTimes(2);
  });

  it.each([0, DAY])('migrates legacy implicit off and keeps mute %i, progress and cooldown through restart', async muteDuration => {
    const previous = newTipState('Asia/Shanghai'); previous.subscription = 'off';
    previous.muteUntil = muteDuration ? now + muteDuration : 0; previous.lastActivity = now - 120_000;
    previous.lastAutomaticAt = now; previous.seen = ['tip-0']; previous.mastered = ['tip-0'];
    await store.save(user, previous);
    await service.tick(); expect(options.create).not.toHaveBeenCalled();
    expect(await state()).toMatchObject({ subscription: 'daily', muteUntil: previous.muteUntil,
      lastActivity: previous.lastActivity, lastAutomaticAt: previous.lastAutomaticAt,
      seen: previous.seen, mastered: previous.mastered });
    await service.stop(); service = createService();
    now += DAY - 1; await service.tick(); expect(options.create).not.toHaveBeenCalled();
    now++; await service.tick(); expect(options.create).toHaveBeenCalledTimes(1);
    expect((await state()).seen).toEqual(['tip-0', 'tip-1']);
    expect((await state()).mastered).toEqual(['tip-0']);
  });

  it('does not send before legacy migration persists and retries safely after storage recovers', async () => {
    const previous = newTipState('Asia/Shanghai'); previous.subscription = 'off'; previous.lastActivity = now - 120_000;
    await store.save(user, previous);
    const file = path.join(directory, (await fs.readdir(directory))[0]);
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('synthetic migration write failure'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await service.tick(); expect(options.create).not.toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(previous);
    await service.tick(); expect(options.create).toHaveBeenCalledTimes(1);
    expect((await state()).subscription).toBe('daily'); expect((await state()).seen).toEqual(['tip-0']);
  });

  it('invalidates pre-migration settings cards while retaining their safe stop control', async () => {
    const previous = newTipState('Asia/Shanghai'); previous.subscription = 'off'; previous.muteUntil = now + DAY;
    const receipt = { id: randomUUID(), cardId: 'synthetic-legacy-settings', kind: 'settings' as const,
      createdAt: now, revision: previous.revision, used: [] };
    previous.cards = [receipt]; await store.save(user, previous);
    expect(await click('subscribe', 'weekly', receipt)).toBe(ui.stale);
    expect(await click('unmute', undefined, receipt)).toBe(ui.stale);
    expect((await state()).subscription).toBe('daily'); expect((await state()).muteUntil).toBe(previous.muteUntil);
    await service.stop(); service = createService();
    expect(await click('subscribe', 'daily', receipt)).toBe(ui.stale);
    expect(await click('off', undefined, receipt)).toBe(ui.stopped);
    expect((await state()).subscription).toBe('off');
  });

  it('allows manual offline browsing without executor metadata', async () => {
    vi.mocked(options.canDeliver).mockResolvedValue(false);
    await service.activity(user); quiet(); await service.tick();
    expect(options.create).not.toHaveBeenCalled();
    vi.mocked(options.canDeliver).mockClear();
    await service.command(user, '/tips');
    expect(options.create).toHaveBeenCalledTimes(1);
    const [target, elements] = vi.mocked(options.create).mock.calls[0];
    expect(target).toBe(user); expect(elements[0]).toMatchObject({ tag: 'img', img_key: 'synthetic-image-key' });
    expect(await click('example')).toBe(ui.delivered);
    expect(JSON.stringify(vi.mocked(options.update).mock.calls[0])).toContain('/backend 1 @');
    expect((await state()).subscription).toBe('daily');
    expect(options.canDeliver).not.toHaveBeenCalled();
    const files = await fs.readdir(directory);
    expect(files.every(name => !name.includes(user))).toBe(true);
    expect(await fs.readFile(path.join(directory, files[0]), 'utf8')).not.toContain(user);
  });

  it('does not create records for wholly unbound users or act on their cards', async () => {
    vi.mocked(options.isBound).mockResolvedValue(false);
    await service.activity(user); await service.command(user, '/tips daily'); await service.tick();
    expect(await fs.readdir(directory)).toEqual([]);
    expect(await service.action(user, 'card', {})).toBe(ui.unbound);
    expect(options.create).not.toHaveBeenCalled();
  });

  it.each([1, 3, 7])('persists %i-day mute across restart and resumes only its previous frequency', async days => {
    await subscribe(); await service.command(user, `/tips mute ${days}`);
    const muted = await state(); expect(muted.muteUntil).toBe(now + days * DAY);
    await service.stop(); service = createService();
    now += days * DAY - 1000; await service.activity(user); quiet(); now -= 120_000;
    vi.mocked(options.create).mockClear(); await service.tick(); expect(options.create).not.toHaveBeenCalled();
    now += 121_000; await service.tick(); expect(options.create).toHaveBeenCalledTimes(1);
  });

  it('persists opt-out across restarts and unmute never enrolls an off user', async () => {
    await service.activity(user); await service.command(user, '/tips off'); await service.stop(); service = createService();
    await service.command(user, '/tips mute 1'); await service.command(user, '/tips unmute'); quiet();
    vi.mocked(options.create).mockClear(); await service.tick();
    expect(options.create).not.toHaveBeenCalled(); expect((await state()).subscription).toBe('off');
    await subscribe(); quiet(); await service.tick(); expect(options.create).toHaveBeenCalledTimes(1);
  });

  it('serializes simultaneous ticks across duplicate device/user entries and defers busy or recent activity', async () => {
    await service.activity(user); await service.tick(); expect(options.create).not.toHaveBeenCalled();
    quiet(); vi.mocked(options.canDeliver).mockResolvedValue(false);
    await service.tick(); expect(options.image).not.toHaveBeenCalled();
    vi.mocked(options.canDeliver).mockResolvedValue(true);
    await Promise.all([service.tick(), service.tick(), service.tick()]);
    expect(options.create).toHaveBeenCalledTimes(1); expect((await state()).seen).toEqual(['tip-0']);
    await service.tick(); expect(options.create).toHaveBeenCalledTimes(1);
  });

  it('enforces local schedule, same-day budget, 20-hour cooldown and skips missed days without backlog', async () => {
    await service.activity(user); now = Date.parse('2026-10-27T02:29:00Z'); await service.tick(); expect(options.create).not.toHaveBeenCalled();
    now = Date.parse('2026-10-27T03:00:00Z'); await service.tick(); expect(options.create).toHaveBeenCalledTimes(1);
    now = Date.parse('2026-10-27T10:59:00Z'); await service.tick(); expect(options.create).toHaveBeenCalledTimes(1);
    now = Date.parse('2026-10-28T02:30:00Z'); await service.tick(); expect(options.create).toHaveBeenCalledTimes(2);
    now = Date.parse('2026-10-29T11:00:00Z'); await service.tick(); expect(options.create).toHaveBeenCalledTimes(2);
    now = Date.parse('2026-11-10T03:00:00Z'); await service.tick(); expect(options.create).toHaveBeenCalledTimes(2);
    await service.activity(user); quiet(); await service.tick(); expect(options.create).toHaveBeenCalledTimes(3);
    await service.tick(); expect(options.create).toHaveBeenCalledTimes(3);
  });

  it('does not bypass 20-hour cooldown on the next local day or after timezone changes', async () => {
    await subscribe(); now = Date.parse('2026-10-27T10:50:00Z'); await service.tick();
    now = Date.parse('2026-10-28T02:30:00Z'); await service.tick(); expect(options.create).toHaveBeenCalledTimes(1);
    await service.command(user, '/tips timezone Pacific/Honolulu'); vi.mocked(options.create).mockClear(); quiet();
    await service.tick(); expect(options.create).not.toHaveBeenCalled();
    now = Date.parse('2026-10-28T08:00:00Z'); await service.tick(); expect(options.create).not.toHaveBeenCalled();
  });

  it('supports Tuesday/Thursday weekly delivery in the configured timezone', async () => {
    options.timezone = 'America/Los_Angeles'; await service.stop(); service = createService();
    now = Date.parse('2026-10-27T16:30:00Z'); await subscribe('weekly'); quiet(); await service.tick();
    expect(options.create).not.toHaveBeenCalled();
    now = Date.parse('2026-10-27T17:30:00Z'); await service.tick(); expect(options.create).toHaveBeenCalledTimes(1);
    now = Date.parse('2026-10-28T17:30:00Z'); await service.tick(); expect(options.create).toHaveBeenCalledTimes(1);
    now = Date.parse('2026-10-29T17:30:00Z'); await service.tick(); expect(options.create).toHaveBeenCalledTimes(2);
  });

  it('stops automatic delivery after all 32 stable tip IDs are seen', async () => {
    await subscribe();
    for (let index = 0; index < 32; index++) await service.command(user, '/tips next');
    expect((await state()).seen).toEqual(catalog.map(tip => tip.id));
    expect((await state()).cards.length).toBeLessThanOrEqual(128);
    vi.mocked(options.create).mockClear(); quiet(); await service.tick(); expect(options.create).not.toHaveBeenCalled();
    await service.command(user, '/tips');
    expect(JSON.stringify(vi.mocked(options.create).mock.calls[0])).toContain(ui.exhausted);
  });

  it('bounds delivery/card history while retaining stable seen and mastered IDs', async () => {
    const initial = await state(); initial.seen = ['tip-1']; initial.mastered = ['tip-1'];
    initial.cards = Array.from({ length: 128 }, (_, index) => ({ id: randomUUID(), cardId: `synthetic-history-${index}`,
      kind: 'help', createdAt: now, revision: initial.revision, used: [] }));
    initial.deliveries = initial.cards.map(card => ({ id: card.id, automatic: false, at: now, state: 'confirmed' }));
    await store.save(user, initial); await service.command(user, '/tips');
    const after = await state(); expect(after.cards).toHaveLength(128); expect(after.deliveries).toHaveLength(128);
    expect(after.cards.some(card => card.id === initial.cards[0].id)).toBe(false);
    expect(after.seen).toEqual(['tip-1', 'tip-0']); expect(after.mastered).toEqual(['tip-1']);
  });

  it('withholds automatic cards on image failures and permits a pre-dispatch retry', async () => {
    await subscribe(); quiet(); vi.mocked(options.image).mockRejectedValueOnce(new Error('synthetic upload failure'));
    await service.tick(); expect(options.create).not.toHaveBeenCalled();
    expect((await state()).seen).toEqual([]); expect((await state()).lastAutomaticAt).toBe(0);
    expect((await state()).deliveries.at(-1)?.state).toBe('reserved');
    await service.tick(); expect(options.create).toHaveBeenCalledTimes(1);
  });

  it('revalidates binding and busy state after upload before dispatch', async () => {
    await subscribe(); quiet();
    vi.mocked(options.image).mockImplementationOnce(async () => { vi.mocked(options.canDeliver).mockResolvedValue(false); return 'image'; });
    await service.tick(); expect(options.create).not.toHaveBeenCalled();
    vi.mocked(options.canDeliver).mockResolvedValue(true);
    vi.mocked(options.image).mockImplementationOnce(async () => { vi.mocked(options.isBound).mockResolvedValue(false); return 'image'; });
    await service.tick(); expect(options.create).not.toHaveBeenCalled(); expect((await state()).seen).toEqual([]);
  });

  it.each(['activity', 'off', 'action'])('observes queued %s while an automatic image upload is pending', async kind => {
    await subscribe(); quiet();
    const receipt = (await state()).cards.at(-1)!;
    let release!: (value: string) => void;
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(options.image).mockImplementationOnce(() => { entered(); return new Promise(resolve => { release = resolve; }); });
    const tick = service.tick(); await started;
    const activity = kind === 'activity' ? service.activity(user) : kind === 'off' ? service.command(user, '/tips off')
      : click('off', undefined, receipt);
    release('image'); await tick; await activity;
    expect(vi.mocked(options.create).mock.calls.some(([, elements]) => elements.some(element => element.tag === 'img'))).toBe(false);
    expect((await state()).seen).toEqual([]);
    expect((await state()).lastAutomaticAt).toBe(0);
    expect((service as any).pendingActivity.size).toBe(0);
    if (kind === 'activity') {
      quiet(); await service.tick(); expect((await state()).seen).toEqual(['tip-0']);
    } else expect((await state()).subscription).toBe('off');
  });

  it('withholds a dispatch when new activity arrives during the durable intent write', async () => {
    await subscribe(); quiet();
    const save = TipStore.prototype.save;
    let release!: () => void;
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(TipStore.prototype, 'save').mockImplementationOnce(function (id, value) { return save.call(this, id, value); })
      .mockImplementationOnce(async function (id, value) {
        entered(); await new Promise<void>(resolve => { release = resolve; }); return save.call(this, id, value);
      });
    const tick = service.tick(); await started;
    const activity = service.activity(user); release(); await tick; await activity;
    expect(options.create).not.toHaveBeenCalled();
    expect((await state()).deliveries.at(-1)?.state).toBe('unknown');
  });

  it.each(['reject', 'null'])('budgets an ambiguous create (%s), suppressing replay across restart', async mode => {
    await subscribe(); quiet();
    vi.mocked(options.create).mockImplementationOnce(async () => {
      const persisted = await state();
      expect(persisted.deliveries.at(-1)?.state).toBe('unknown');
      expect(persisted.seen).toContain('tip-0'); expect(persisted.lastAutomaticAt).toBe(now);
      if (mode === 'reject') throw new Error('synthetic unknown outcome');
      return null;
    });
    await service.tick(); expect((await state()).deliveries.at(-1)?.state).toBe('unknown');
    await service.stop(); service = createService(); await service.tick(); expect(options.create).toHaveBeenCalledTimes(1);
    now += DAY; await service.tick(); expect((await state()).seen).toEqual(['tip-0', 'tip-1']);
  });

  it('never invokes create after dispatch-marker persistence failure', async () => {
    await subscribe(); quiet();
    const original = TipStore.prototype.save;
    const save = vi.spyOn(TipStore.prototype, 'save').mockImplementation(async function (id, next) {
      if (next.deliveries.at(-1)?.state === 'dispatching') throw new Error('synthetic disk failure');
      return original.call(this, id, next);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await service.tick(); expect(options.create).not.toHaveBeenCalled(); expect((await state()).seen).toEqual([]);
    save.mockRestore(); await service.tick(); expect(options.create).toHaveBeenCalledTimes(1);
  });

  it('does not replay after create succeeds but receipt persistence fails', async () => {
    await subscribe(); quiet(); const original = TipStore.prototype.save;
    const save = vi.spyOn(TipStore.prototype, 'save').mockImplementation(async function (id, next) {
      if (next.deliveries.at(-1)?.state === 'confirmed') throw new Error('synthetic receipt failure');
      return original.call(this, id, next);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await service.tick(); expect(options.create).toHaveBeenCalledTimes(1);
    save.mockRestore(); await service.stop(); service = createService();
    await service.tick(); expect(options.create).toHaveBeenCalledTimes(1); expect((await state()).seen).toEqual(['tip-0']);
  });

  it('fails closed on corrupt preferences while preserving an independent durable off switch', async () => {
    await subscribe(); const filename = (await fs.readdir(directory)).find(name => name.endsWith('.json'))!;
    await fs.writeFile(path.join(directory, filename), '{', { mode: 0o600 });
    vi.spyOn(console, 'warn').mockImplementation(() => {}); quiet(); await service.tick(); expect(options.create).not.toHaveBeenCalled();
    await service.command(user, '/tips off');
    expect(JSON.stringify(vi.mocked(options.create).mock.calls.at(-1))).toContain(ui.stopped);
    expect((await fs.readdir(directory)).some(name => name.endsWith('.off.json'))).toBe(true);
    await service.stop(); service = createService(); vi.mocked(options.create).mockClear(); await service.tick(); expect(options.create).not.toHaveBeenCalled();
  });

  it('does not claim enrollment if preference persistence or opt-out removal fails', async () => {
    await service.command(user, '/tips off');
    const remove = vi.spyOn(TipStore.prototype, 'clearOptOut').mockRejectedValueOnce(new Error('synthetic remove failure'));
    await service.command(user, '/tips daily');
    expect((await state()).subscription).toBe('off');
    expect(JSON.stringify(vi.mocked(options.create).mock.calls.at(-1))).toContain(ui.unavailable);
    remove.mockRestore();
    vi.spyOn(TipStore.prototype, 'save').mockRejectedValueOnce(new Error('synthetic write failure'));
    await service.command(user, '/tips daily');
    expect((await state()).subscription).toBe('off');
  });

  it('invalidates old enrollment cards when off succeeds but the main preference write fails', async () => {
    await service.command(user, '/tips settings'); const old = (await state()).cards.at(-1)!;
    const save = vi.spyOn(TipStore.prototype, 'save').mockRejectedValueOnce(new Error('synthetic main write failure'));
    await service.command(user, '/tips off'); save.mockRestore();
    expect((await state()).subscription).toBe('off');
    expect(await click('subscribe', 'daily', old)).toBe(ui.stale);
    await service.stop(); service = createService();
    expect(await click('subscribe', 'daily', old)).toBe(ui.stale);
    await service.command(user, '/tips settings'); expect(await click('subscribe', 'daily')).toBe(ui.saved);
  });

  it('preserves settings revisions for later preference changes while the stop switch is present', async () => {
    await service.command(user, '/tips off'); await service.command(user, '/tips settings');
    const old = (await state()).cards.at(-1)!;
    await service.command(user, '/tips mute 7');
    expect(await click('subscribe', 'daily', old)).toBe(ui.stale);
    const fresh = (await state()).cards.at(-1)!;
    await service.activity(user);
    expect(await click('subscribe', 'daily', fresh)).toBe(ui.saved);
  });

  it('pins callbacks to the original operator/card, rejects forged controls, and revalidates unbind', async () => {
    await service.command(user, '/tips settings'); const receipt = (await state()).cards.at(-1)!;
    const payload = { action: 'tips', id: receipt.id, op: 'subscribe', value: 'daily' };
    expect(await service.action('foreign-user', receipt.cardId!, payload)).toBe(ui.stale);
    expect(await service.action(user, 'forged-card', payload)).toBe(ui.stale);
    for (const forged of [null, [], {}, { ...payload, extra: 'value' }, { ...payload, value: 'unsupported' }]) {
      expect(await service.action(user, receipt.cardId!, forged)).toBe(ui.invalid);
    }
    vi.mocked(options.isBound).mockResolvedValue(false);
    expect(await service.action(user, receipt.cardId!, payload)).toBe(ui.unbound);
    expect((await state()).subscription).toBe('daily');
  });

  it('reports an unavailable view if its binding disappears before the update', async () => {
    await service.command(user, '/tips');
    vi.mocked(options.isBound).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await click('detail')).toBe(ui.unavailable);
    expect(options.update).not.toHaveBeenCalled();
  });

  it('requires the current settings revision for enrollment/unmute while old stop/mute remain safe and idempotent', async () => {
    await service.command(user, '/tips settings'); const old = (await state()).cards.at(-1)!;
    expect(await click('subscribe', 'daily', old)).toBe(ui.saved);
    expect(await click('subscribe', 'weekly', old)).toBe(ui.stale);
    expect(await click('mute', '3', old)).toBe(ui.saved); const until = (await state()).muteUntil;
    now += 1000; expect(await click('mute', '3', old)).toBe(ui.already); expect((await state()).muteUntil).toBe(until);
    expect(await click('unmute', undefined, old)).toBe(ui.stale);
    expect(await click('off', undefined, old)).toBe(ui.stopped); expect((await state()).subscription).toBe('off');
    expect(await click('subscribe', 'weekly', old)).toBe(ui.stale);
    now += 30 * DAY; expect(await click('off', undefined, old)).toBe(ui.stale);
  });

  it('prevents stale mute buttons from shortening a newer pause while allowing a fresh deliberate change', async () => {
    await subscribe(); const old = (await state()).cards.at(-1)!;
    await service.command(user, '/tips mute 14');
    const fresh = (await state()).cards.at(-1)!;
    expect(await click('mute', '1', old)).toBe(ui.stale);
    expect((await state()).muteUntil).toBe(now + 14 * DAY);
    expect(await click('mute', '1', fresh)).toBe(ui.saved);
    expect((await state()).muteUntil).toBe(now + DAY);
  });

  it('keeps navigation for 24 hours and controls for 30 days, including across restart', async () => {
    await service.command(user, '/tips'); const receipt = (await state()).cards.at(-1)!;
    await service.stop(); service = createService();
    expect(await click('detail', undefined, receipt)).toBe(ui.delivered);
    expect(vi.mocked(options.update).mock.calls[0][1][0]).toMatchObject({ tag: 'img' });
    expect(await click('example', undefined, receipt)).toBe(ui.delivered);
    now += DAY; expect(await click('next', undefined, receipt)).toBe(ui.stale);
    expect(await click('settings', undefined, receipt)).toBe(ui.delivered);
  });

  it('makes next/mastered idempotent and only permits tutorial operations on tutorial cards', async () => {
    await service.command(user, '/tips'); const receipt = (await state()).cards.at(-1)!;
    expect(await click('subscribe', 'daily', receipt)).toBe(ui.invalid);
    expect(await click('mastered', undefined, receipt)).toBe(ui.learned);
    expect(await click('mastered', undefined, receipt)).toBe(ui.already);
    expect((await state()).mastered).toEqual(['tip-0']);
    expect(await click('next', undefined, receipt)).toBe(ui.delivered);
    expect(await click('next', undefined, receipt)).toBe(ui.already);
    expect(options.create).toHaveBeenCalledTimes(2);
  });

  it('keeps a next button retryable after image failure but consumes it on an uncertain dispatch', async () => {
    await service.command(user, '/tips'); const receipt = (await state()).cards.at(-1)!;
    vi.mocked(options.image).mockResolvedValueOnce(null);
    expect(await click('next', undefined, receipt)).toBe(ui.unavailable);
    expect((await state()).cards.find(card => card.id === receipt.id)?.used).not.toContain('next');
    vi.mocked(options.create).mockRejectedValueOnce(new Error('synthetic ambiguous create'));
    expect(await click('next', undefined, receipt)).toBe(ui.unavailable);
    expect(await click('next', undefined, receipt)).toBe(ui.already);
    expect((await state()).seen).toEqual(['tip-0', 'tip-1']);
  });

  it('browses bounded catalog pages without changing task settings', async () => {
    await service.command(user, '/tips list'); const receipt = (await state()).cards.at(-1)!;
    expect(JSON.stringify(vi.mocked(options.create).mock.calls[0][1])).not.toContain('Tip 6');
    expect(await click('page', '1', receipt)).toBe(ui.delivered);
    expect(await click('page', '999', receipt)).toBe(ui.invalid);
    expect(await click('show', 'unknown', receipt)).toBe(ui.invalid);
    expect(await click('show', 'tip-31', receipt)).toBe(ui.delivered);
    expect(await click('show', 'tip-31', receipt)).toBe(ui.already);
    expect((await state()).subscription).toBe('daily');
  });

  it.each(['/tips mute 0', '/tips mute 366', '/tips mute -1', '/tips mute NaN', '/tips timezone Invalid/Zone', '/tips mystery', '/tips daily extra', '/tips mute 1 extra'])('provides bounded help for invalid command %s', async command => {
    await service.command(user, command); expect((await state()).subscription).toBe('daily');
    expect(options.create).toHaveBeenCalledTimes(1);
  });

  it('isolates transport/storage errors in activity, commands, actions and the scheduler', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(options.users).mockRejectedValueOnce(new Error('synthetic list failure')); await service.tick();
    vi.mocked(options.isBound).mockRejectedValueOnce(new Error('synthetic binding failure')); await service.activity(user);
    vi.mocked(options.isBound).mockRejectedValueOnce(new Error('synthetic binding failure')); await service.command(user, '/tips');
    vi.mocked(options.isBound).mockRejectedValueOnce(new Error('synthetic binding failure'));
    expect(await service.action(user, 'synthetic-card', {})).toBe(ui.unavailable);
  });

  it('starts one unref timer and stops without future callbacks or sends', async () => {
    vi.useFakeTimers(); const tick = vi.spyOn(service, 'tick');
    service.start(); service.start(); await vi.advanceTimersByTimeAsync(60_000); expect(tick).toHaveBeenCalledTimes(1);
    await service.stop(); await vi.advanceTimersByTimeAsync(120_000); expect(tick).toHaveBeenCalledTimes(1);
    await service.command(user, '/tips'); await service.activity(user); await service.tick();
    expect(await service.action(user, 'synthetic-card', {})).toBe(ui.unavailable);
    expect(options.create).not.toHaveBeenCalled();
  });

  it('bounds unknown create, drains writes on stop, and ignores late results', async () => {
    await subscribe(); quiet(); let finish!: (value: string) => void;
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(options.create).mockImplementationOnce(() => { entered(); return new Promise(resolve => { finish = resolve; }); });
    vi.useFakeTimers(); const tick = service.tick(); await started;
    const stopping = service.stop(); await vi.advanceTimersByTimeAsync(TIP_TRANSPORT_TIMEOUT); await stopping; await tick;
    const before = await state(); expect(before.deliveries.at(-1)?.state).toBe('unknown');
    finish('late-card'); await Promise.resolve(); expect(await state()).toEqual(before);
    expect(options.create).toHaveBeenCalledTimes(1);
  });

  it('stops during an image upload without dispatching a late card', async () => {
    await subscribe(); quiet(); let release!: (value: string) => void;
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(options.image).mockImplementationOnce(() => { entered(); return new Promise(resolve => { release = resolve; }); });
    const tick = service.tick(); await started;
    const stopping = service.stop(); release('late-image'); await stopping; await tick;
    expect(options.create).not.toHaveBeenCalled(); expect((await state()).seen).toEqual([]);
  });
});
