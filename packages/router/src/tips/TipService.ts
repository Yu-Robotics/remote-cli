import { randomUUID } from 'crypto';
import type { TipAction, TipDefinition, TipServiceOptions } from './TipTypes';
import { TipStore, TIP_HISTORY_LIMIT, validTimezone } from './TipStore';
import type { TipReceipt, TipUserState } from './TipStore';
import { catalogCard, messageCard, settingsCard, tipCard, TIP_PAGE_SIZE, ui } from './TipCards';
import type { TipCard } from './TipCards';

const DAY = 86400_000;
const NAVIGATION_LIFETIME = DAY;
const CONTROL_LIFETIME = 30 * DAY;
export const TIP_TRANSPORT_TIMEOUT = 15_000;
const TICK_INTERVAL = 60_000;

function localTime(time: number, timezone: string): { day: string; minute: number; weekday: string } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(time);
  const part = (name: string) => parts.find(value => value.type === name)!.value;
  return { day: `${part('year')}-${part('month')}-${part('day')}`, minute: Number(part('hour')) * 60 + Number(part('minute')), weekday: part('weekday') };
}

/** Single-process, user-scoped educational delivery. No executor or device API is used. */
export class TipService {
  private readonly store: TipStore;
  private readonly now: () => number;
  private readonly locks = new Map<string, Promise<void>>();
  private readonly pendingActivity = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>;
  private ticking?: Promise<void>;
  private stopped = false;

  constructor(private readonly options: TipServiceOptions) {
    this.now = options.now ?? Date.now;
    this.store = new TipStore(options.directory, options.timezone ?? 'Asia/Shanghai');
    if (new Set(options.catalog.map(tip => tip.id)).size !== options.catalog.length
      || options.catalog.some(tip => !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(tip.id))) throw new Error('Invalid Tips catalog.');
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.tick(); }, TICK_INTERVAL);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    // Injected transport is bounded here too. Late transport results cannot write or send again.
    await this.ticking;
    await Promise.all([...this.locks.values()]);
  }

  private async external<T>(work: () => Promise<T>): Promise<T> {
    if (this.stopped) throw new Error('Tips service is stopped.');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.resolve().then(() => {
        if (this.stopped) throw new Error('Tips service is stopped.');
        return work();
      }), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Tips transport timed out.')), TIP_TRANSPORT_TIMEOUT);
        timer.unref();
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private lock<T>(openId: string, work: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(openId) ?? Promise.resolve()).then(work);
    const tail = next.then(() => {}, () => {});
    this.locks.set(openId, tail);
    void tail.then(() => {
      if (this.locks.get(openId) === tail) {
        this.locks.delete(openId);
        this.pendingActivity.delete(openId);
      }
    });
    return next;
  }

  private observeActivity(openId: string): void {
    // Do not wait behind an image upload to observe a new user interaction.
    if (this.locks.has(openId)) this.pendingActivity.set(openId, this.now());
  }

  private async bound(openId: string): Promise<boolean> {
    return !this.stopped && await this.external(() => this.options.isBound(openId)) && !this.stopped;
  }

  private async warning(openId: string, message: string): Promise<void> {
    try {
      if (!await this.bound(openId)) return;
      const card = messageCard(message);
      await this.external(() => this.options.create(openId, card.elements, card.header, randomUUID()));
    } catch { /* Educational failures never interrupt ordinary task handling. */ }
  }

  async activity(openId: string): Promise<void> {
    if (this.stopped) return;
    this.observeActivity(openId);
    await this.lock(openId, async () => {
      try {
        if (!await this.bound(openId)) return;
        const state = await this.store.load(openId);
        state.lastActivity = this.now();
        await this.store.save(openId, state);
      } catch { console.warn('Tips activity storage is unavailable.'); }
    });
  }

  private prune(state: TipUserState): void {
    state.cards = state.cards.filter(card => this.now() - card.createdAt < CONTROL_LIFETIME).slice(-(TIP_HISTORY_LIMIT - 1));
    state.deliveries = state.deliveries.slice(-(TIP_HISTORY_LIMIT - 1));
  }

  private nextTip(state: TipUserState): TipDefinition | undefined {
    return this.options.catalog.find(tip => !state.seen.includes(tip.id));
  }

  private quiet(openId: string, state: TipUserState): boolean {
    const activity = Math.max(state.lastActivity, this.pendingActivity.get(openId) ?? 0);
    const age = this.now() - activity;
    return activity > 0 && age >= 120_000 && age <= 7 * DAY;
  }

  private eligible(openId: string, state: TipUserState): boolean {
    const now = this.now();
    if (state.subscription === 'off' || state.muteUntil > now || !this.quiet(openId, state) || !this.nextTip(state)) return false;
    const local = localTime(now, state.timezone);
    if (local.minute < 630 || local.minute >= 1140 || state.subscription === 'weekly' && !['Tue', 'Thu'].includes(local.weekday)) return false;
    return !state.lastAutomaticAt || now - state.lastAutomaticAt >= 20 * 3600_000
      && localTime(state.lastAutomaticAt, state.timezone).day !== local.day;
  }

  private async deliver(openId: string, state: TipUserState, kind: TipReceipt['kind'], render: (receipt: TipReceipt, image: string) => TipCard,
    tip?: TipDefinition, automatic = false, beforeDispatch?: () => void): Promise<boolean> {
    if (!await this.bound(openId) || automatic && (!this.eligible(openId, state) || !await this.external(() => this.options.canDeliver(openId)))) return false;
    this.prune(state);
    const receipt: TipReceipt = { id: randomUUID(), cardId: null, kind, ...(tip ? { tipId: tip.id } : {}), createdAt: this.now(), revision: state.revision, used: [] };
    const delivery = { id: receipt.id, ...(tip ? { tipId: tip.id } : {}), automatic, at: this.now(), state: 'reserved' as const };
    state.cards.push(receipt);
    state.deliveries.push(delivery);
    await this.store.save(openId, state);
    let image = '';
    if (tip) {
      try { image = await this.external(() => this.options.image(tip)) ?? ''; } catch { return false; }
      if (!image) return false;
    }
    if (!await this.bound(openId) || automatic && (!this.eligible(openId, state) || !await this.external(() => this.options.canDeliver(openId)))) return false;
    const card = render(receipt, image);
    const intent = state.deliveries.find(item => item.id === receipt.id)!;
    intent.state = 'dispatching';
    intent.at = this.now();
    if (tip && !state.seen.includes(tip.id)) state.seen.push(tip.id);
    if (automatic) state.lastAutomaticAt = intent.at;
    beforeDispatch?.();
    // A failed write forbids invocation. A crash after this write is an uncertain send, never a replay.
    await this.store.save(openId, state);
    let cardId: string | null = null;
    try {
      if (await this.bound(openId) && (!automatic || this.quiet(openId, state)
        && await this.external(() => this.options.canDeliver(openId)) && this.quiet(openId, state))) {
        cardId = await this.external(() => this.options.create(openId, card.elements, card.header, receipt.id));
      }
    } catch { /* The remote side may have accepted the card. */ }
    intent.state = cardId ? 'confirmed' : 'unknown';
    receipt.cardId = cardId;
    await this.store.save(openId, state);
    return Boolean(cardId);
  }

  private async settings(openId: string, state: TipUserState): Promise<void> {
    await this.deliver(openId, state, 'settings', receipt => settingsCard(state, receipt, this.now()));
  }

  private async showTip(openId: string, state: TipUserState, tip = this.nextTip(state), beforeDispatch?: () => void): Promise<boolean> {
    if (!tip) return this.deliver(openId, state, 'help', () => messageCard(ui.exhausted), undefined, false, beforeDispatch);
    const sent = await this.deliver(openId, state, 'tip', (receipt, image) => tipCard(tip, receipt, image), tip, false, beforeDispatch);
    if (!sent && !state.seen.includes(tip.id)) await this.warning(openId, ui.imageFailed);
    return sent;
  }

  private async change(openId: string, state: TipUserState, apply: () => void, enroll = false): Promise<void> {
    apply();
    state.revision = randomUUID();
    await this.store.save(openId, state);
    // Persist enrollment first; an existing stop switch wins through every failure/crash gap.
    if (enroll) await this.store.clearOptOut(openId);
  }

  private async off(openId: string): Promise<void> {
    await this.store.optOut(openId);
    try {
      const state = await this.store.load(openId);
      state.subscription = 'off'; state.revision = randomUUID(); state.lastActivity = this.now();
      await this.store.save(openId, state);
    } catch { /* The independent stop switch is already durable. */ }
  }

  async command(openId: string, content: string): Promise<void> {
    if (this.stopped) return;
    this.observeActivity(openId);
    await this.lock(openId, async () => {
      try {
        if (!await this.bound(openId)) return;
        const parts = content.trim().split(/\s+/);
        if (parts.shift()?.toLowerCase() !== '/tips') return;
        const [op = 'next', value, ...extra] = parts;
        if (op === 'off' && value === undefined) {
          await this.off(openId); await this.warning(openId, ui.stopped); return;
        }
        const state = await this.store.load(openId);
        state.lastActivity = this.now();
        await this.store.save(openId, state);
        if (extra.length || !['mute', 'timezone'].includes(op) && value !== undefined) {
          await this.deliver(openId, state, 'help', () => messageCard(ui.help)); return;
        }
        switch (op) {
          case 'next': await this.showTip(openId, state); break;
          case 'list': await this.deliver(openId, state, 'catalog', receipt => catalogCard(this.options.catalog, receipt)); break;
          case 'settings': await this.settings(openId, state); break;
          case 'daily': case 'weekly':
            await this.change(openId, state, () => { state.subscription = op; state.muteUntil = 0; }, true);
            await this.settings(openId, state); break;
          case 'mute':
            if (!value || !/^\d{1,3}$/.test(value) || Number(value) < 1 || Number(value) > 365) {
              await this.deliver(openId, state, 'help', () => messageCard(ui.invalidDays)); break;
            }
            await this.change(openId, state, () => { state.muteUntil = this.now() + Number(value) * DAY; });
            await this.settings(openId, state); break;
          case 'unmute':
            await this.change(openId, state, () => { state.muteUntil = 0; });
            await this.settings(openId, state); break;
          case 'timezone':
            if (!validTimezone(value)) { await this.deliver(openId, state, 'help', () => messageCard(ui.invalidTimezone)); break; }
            await this.change(openId, state, () => { state.timezone = value; });
            await this.settings(openId, state); break;
          default: await this.deliver(openId, state, 'help', () => messageCard(ui.help));
        }
      } catch { await this.warning(openId, ui.unavailable); }
    });
  }

  private validAction(payload: unknown): payload is TipAction {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    const value = payload as TipAction;
    return Object.keys(value).every(key => ['action', 'id', 'op', 'value'].includes(key)) && value.action === 'tips'
      && typeof value.id === 'string' && value.id.length === 36 && typeof value.op === 'string' && value.op.length < 30
      && (value.value === undefined || typeof value.value === 'string' && value.value.length <= 100);
  }

  async action(openId: string, cardId: string, payload: unknown): Promise<string> {
    if (this.stopped) return ui.unavailable;
    this.observeActivity(openId);
    return this.lock(openId, async () => {
      try {
        if (!await this.bound(openId)) return ui.unbound;
        if (!this.validAction(payload)) return ui.invalid;
        const state = await this.store.load(openId);
        const receipt = state.cards.find(card => card.id === payload.id && card.cardId === cardId);
        if (!receipt || this.now() - receipt.createdAt >= CONTROL_LIFETIME || receipt.createdAt > this.now()) return ui.stale;
        const { op, value } = payload;
        const navigation = ['detail', 'example', 'next', 'mastered', 'show', 'page'].includes(op);
        if (navigation && this.now() - receipt.createdAt >= NAVIGATION_LIFETIME) return ui.stale;
        if (op === 'settings' && value === undefined) {
          state.lastActivity = this.now(); await this.settings(openId, state); return ui.delivered;
        }
        if (receipt.kind === 'settings') {
          if (op === 'off' && value === undefined) { await this.off(openId); return ui.stopped; }
          if (op === 'subscribe' && ['daily', 'weekly'].includes(value ?? '') || op === 'unmute' && value === undefined) {
            if (receipt.revision !== state.revision) return ui.stale;
            state.lastActivity = this.now();
            await this.change(openId, state, () => {
              if (op === 'subscribe') state.subscription = value as 'daily' | 'weekly';
              state.muteUntil = 0;
            }, op === 'subscribe');
            await this.settings(openId, state); return ui.saved;
          }
          if (op === 'mute' && ['1', '3', '7', '14'].includes(value ?? '')) {
            const token = `${op}:${value}`;
            if (receipt.used.includes(token)) return ui.already;
            const until = this.now() + Number(value) * DAY;
            if (receipt.revision !== state.revision && until < state.muteUntil) return ui.stale;
            await this.change(openId, state, () => {
              receipt.used.push(token); state.lastActivity = this.now(); state.muteUntil = until;
            });
            await this.settings(openId, state); return ui.saved;
          }
        }
        if (receipt.kind === 'catalog') {
          if (op === 'page' && value !== undefined && /^\d{1,4}$/.test(value) && Number(value) < Math.ceil(this.options.catalog.length / TIP_PAGE_SIZE)) {
            state.lastActivity = this.now(); await this.store.save(openId, state);
            const card = catalogCard(this.options.catalog, receipt, Number(value));
            await this.update(openId, cardId, card); return ui.delivered;
          }
          if (op === 'show' && value !== undefined) {
            const tip = this.options.catalog.find(item => item.id === value);
            if (!tip) return ui.invalid;
            const token = `show:${value}`;
            if (receipt.used.includes(token)) return ui.already;
            if (receipt.used.length >= 32) return ui.stale;
            state.lastActivity = this.now(); await this.store.save(openId, state);
            return await this.showTip(openId, state, tip, () => receipt.used.push(token)) ? ui.delivered : ui.unavailable;
          }
        }
        if (receipt.kind === 'tip' && value === undefined) {
          const tip = this.options.catalog.find(item => item.id === receipt.tipId);
          if (!tip) return ui.stale;
          if (op === 'next' || op === 'mastered') {
            if (receipt.used.includes(op)) return ui.already;
            state.lastActivity = this.now();
            if (op === 'next') {
              await this.store.save(openId, state);
              return await this.showTip(openId, state, undefined, () => receipt.used.push(op)) ? ui.delivered : ui.unavailable;
            }
            receipt.used.push(op);
            if (op === 'mastered' && !state.mastered.includes(tip.id)) state.mastered.push(tip.id);
            await this.store.save(openId, state);
            return ui.learned;
          }
          if (op === 'detail' || op === 'example') {
            const image = await this.external(() => this.options.image(tip));
            if (!image) return ui.imageFailed;
            state.lastActivity = this.now(); await this.store.save(openId, state);
            // Previously delivered detail buttons refresh the current summary without a separate view.
            await this.update(openId, cardId, tipCard(tip, receipt, image, op === 'example' ? 'example' : 'summary')); return ui.delivered;
          }
        }
        return ui.invalid;
      } catch { return ui.unavailable; }
    });
  }

  private async update(openId: string, cardId: string, card: TipCard): Promise<void> {
    if (!await this.bound(openId)) throw new Error('Tips user is no longer bound.');
    await this.external(() => this.options.update(cardId, card.elements, card.header));
  }

  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.ticking) return this.ticking;
    const work = this.scheduledTick().catch(() => { console.warn('Tips scheduler is unavailable.'); });
    this.ticking = work;
    void work.then(() => { if (this.ticking === work) this.ticking = undefined; });
    return work;
  }

  private async scheduledTick(): Promise<void> {
    const users = [...new Set(await this.external(() => this.options.users()))];
    // Bound concurrency prevents a large binding list from flooding image uploads or storage.
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(4, users.length) }, async () => {
      while (!this.stopped && index < users.length) {
        const openId = users[index++];
        await this.lock(openId, async () => {
          try {
            if (!await this.bound(openId)) return;
            const state = await this.store.load(openId);
            if (!this.eligible(openId, state)) return;
            const tip = this.nextTip(state)!;
            await this.deliver(openId, state, 'tip', (receipt, image) => tipCard(tip, receipt, image), tip, true);
          } catch { console.warn('Tips delivery is unavailable.'); }
        });
      }
    }));
  }
}
