import { randomUUID } from 'crypto';
import { isScheduleBackend, scheduleView, type ScheduleView } from '../types/ScheduleCards';
import type { ScheduleActionMessage, ScheduleActionResult, ScheduleCardEntry, ScheduleMenu } from '../types/ScheduleCards';

interface Transport {
  ownsDevice(openId: string, deviceId: string): Promise<boolean>;
  available(deviceId: string, allBackends?: boolean): boolean;
  captureOwnership(openId: string, deviceId: string): () => boolean;
  send(deviceId: string, message: ScheduleActionMessage): Promise<boolean>;
  update(cardId: string, elements: any[], current: () => Promise<boolean>): Promise<void>;
}
interface State {
  id: string;
  openId: string;
  deviceId: string;
  ownsBinding: () => boolean;
  menu: ScheduleMenu;
  cards: Set<string>;
  revision: number;
  page: number;
  view: ScheduleView;
  stale?: boolean;
  confirm?: string;
  notice?: string;
  expired?: boolean;
  pending?: { request: ScheduleActionMessage; timedOut: boolean; timer?: NodeJS.Timeout };
  chain: Promise<void>;
}
const TTL = 15 * 60_000;
const MAX_CARDS = 100;
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max
  && !/[\x00-\x1f\x7f]/.test(value);
const id = (value: unknown): value is string => text(value, 256) && value.length > 0;
const escape = (value: string) => value.replace(/[\\`*_{}\[\]()<>!#|~]/g, '\\$&');

function formatUtcDateTime(value: string | number): string | undefined {
  if (typeof value === 'string' && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return;
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} UTC`;
}

function displayRule(rule: string): string {
  return formatUtcDateTime(rule) ?? rule;
}

const validSlotTime = (value: unknown): boolean => typeof value === 'number'
  && Number.isSafeInteger(value) && Number.isFinite(new Date(value).getTime());

function statusPresentation(state: ScheduleCardEntry['state'], cleanupPending: boolean): { label: string; color: string } {
  if (cleanupPending) return { label: 'Stopping · exit unconfirmed', color: 'orange' };
  switch (state) {
    case 'creating': return { label: 'Creating', color: 'blue' };
    case 'active': return { label: 'Scheduled', color: 'green' };
    case 'running': return { label: 'Running', color: 'blue' };
    case 'completed': return { label: 'Completed', color: 'grey' };
    case 'cancelled': return { label: 'Cancelled', color: 'grey' };
    case 'interrupted': return { label: 'Interrupted', color: 'orange' };
    case 'failed': return { label: 'Failed', color: 'red' };
  }
}

/** Reject malformed peer views before they enter card state or callback authority. */
export function parseScheduleMenu(value: unknown, allBackends = true): ScheduleMenu | undefined {
  if (!value || typeof value !== 'object' || Buffer.byteLength(JSON.stringify(value)) > 128 * 1024) return;
  const menu = value as ScheduleMenu;
  if (!id(menu.snapshotId) || !id(menu.threadId) || !text(menu.threadName, 100)
    || !Number.isSafeInteger(menu.expiresAt) || menu.expiresAt <= Date.now() || menu.expiresAt > Date.now() + TTL + 60_000
    || !Array.isArray(menu.entries) || menu.entries.length > 100) return;
  const values = new Set<string>();
  if (menu.more !== undefined && (!menu.more || typeof menu.more !== 'object' || Array.isArray(menu.more)
    || Object.entries(menu.more).some(([view, token]) => !['history', 'current'].includes(view) || !id(token)))) return;
  for (const entry of menu.entries) {
    if (!entry || !id(entry.value) || !id(entry.id) || values.has(entry.value)
      || !isScheduleBackend(entry.backend, allBackends) || !['creating', 'active', 'running', 'completed', 'cancelled', 'interrupted', 'failed'].includes(entry.state)
      || !text(entry.rule, 160) || !text(entry.prompt, 240) || typeof entry.canCancel !== 'boolean'
      || (entry.error !== undefined && !text(entry.error, 240))
      || (entry.nextDueAt !== undefined && !validSlotTime(entry.nextDueAt))
      || (entry.lastOccurrence !== undefined && (!entry.lastOccurrence || !validSlotTime(entry.lastOccurrence.dueAt)
        || !['succeeded', 'failed', 'unknown', 'skipped', 'aborted'].includes(entry.lastOccurrence.status)
        || (entry.lastOccurrence.error !== undefined && !text(entry.lastOccurrence.error, 240))))
      || (entry.pending !== undefined && !['execution', 'delivery'].includes(entry.pending))) return;
    values.add(entry.value);
  }
  return structuredClone(menu);
}

/** Ephemeral, delivered-card-bound controls. Task ownership and timing remain on the CLI. */
export class ScheduleCards {
  private states = new Map<string, State>();
  constructor(private readonly transport: Transport) {}

  present(input: { openId: string; deviceId: string; menu: unknown; expectedThreadId?: string }) {
    this.prune();
    const menu = parseScheduleMenu(input.menu, this.transport.available(input.deviceId, true));
    if (!menu || !input.expectedThreadId || menu.threadId !== input.expectedThreadId
      || !this.transport.available(input.deviceId)) return;
    if (this.states.size >= MAX_CARDS) {
      const oldest = [...this.states.values()].find(state => !state.pending);
      if (!oldest) return;
      this.drop(oldest);
    }
    const state: State = { id: randomUUID(), openId: input.openId, deviceId: input.deviceId, menu,
      ownsBinding: this.transport.captureOwnership(input.openId, input.deviceId),
      cards: new Set(), revision: 1, view: 'current', page: 0, chain: Promise.resolve() };
    this.states.set(state.id, state);
    return { elements: this.render(state), deliver: (cards: string[]) => {
      if (!this.active(state)) return;
      if (cards.length !== 1 || !id(cards[0])) { this.drop(state); return; }
      state.cards.add(cards[0]);
    }, discard: () => this.drop(state) };
  }

  async click(openId: string, cardId: string, payload: { id?: unknown; rev?: unknown; op?: unknown; value?: unknown }): Promise<string> {
    this.prune();
    const state = typeof payload.id === 'string' ? this.states.get(payload.id) : undefined;
    if (!state || !this.active(state) || !state.cards.has(cardId)) throw new Error('This schedule card has expired. Use /schedule list.');
    if (state.openId !== openId || !await this.transport.ownsDevice(openId, state.deviceId)) throw new Error('This schedule belongs to another user.');
    // Ownership lookup may race disconnect, expiry, or a newer callback.
    if (!this.active(state) || !this.transport.available(state.deviceId)) throw new Error('The original CLI is unavailable. Reconnect and use /schedule list.');
    if (!Number.isSafeInteger(payload.rev) || (payload.rev as number) < 1 || (payload.rev as number) > state.revision) throw new Error('Invalid schedule card revision.');
    if (state.pending) {
      if (payload.op === 'retry' && state.pending.timedOut) {
        return this.send(state);
      }
      return state.pending.timedOut ? 'The outcome is unknown. Retry confirmation.' : 'Waiting for CLI confirmation.';
    }
    if (payload.rev !== state.revision) {
      this.changed(state);
      throw new Error('This schedule card changed. Retry its latest buttons or use /schedule list.');
    }
    const entries = this.entries(state);
    let more: string | undefined;
    switch (payload.op) {
      case 'view': {
        if (payload.value !== 'current' && payload.value !== 'history') throw new Error('Invalid schedule view.');
        state.view = payload.value; state.page = 0; state.confirm = undefined; state.notice = undefined;
        if (!this.entries(state).length) more = state.menu.more?.[state.view];
        if (more) break;
        this.changed(state); return 'Schedule view updated.';
      }
      case 'page': {
        const page = typeof payload.value === 'string' && /^\d{1,4}$/.test(payload.value) ? Number(payload.value) : -1;
        if (page === entries.length && state.menu.more?.[state.view]) { more = state.menu.more[state.view]; break; }
        if (page < 0 || page >= entries.length) throw new Error('Invalid schedule page.');
        state.page = page; state.confirm = undefined; this.changed(state); return 'Schedule page updated.';
      }
      case 'cancel': {
        const entry = entries[state.page];
        if (state.stale || !entry?.canCancel || entry.value !== payload.value) throw new Error('Refresh this schedule before cancelling it.');
        state.confirm = entry.value; this.changed(state); return 'Review the cancellation and confirm.';
      }
      case 'back': state.confirm = undefined; this.changed(state); return 'No cancellation was sent.';
      case 'confirm':
        if (!state.confirm || state.stale || state.confirm !== entries[state.page]?.value) throw new Error('Confirm cancellation from the latest card.');
        break;
      case 'refresh': break;
      default: throw new Error('Unknown schedule action.');
    }
    const request: ScheduleActionMessage = { type: 'schedule_action', messageId: randomUUID(), openId: state.openId,
      threadId: state.menu.threadId, snapshotId: state.menu.snapshotId, operation: more ? 'more' : payload.op === 'confirm' ? 'cancel' : 'refresh',
      ...(more ? { value: more } : payload.op === 'confirm' ? { value: state.confirm } : {}), timestamp: Date.now() };
    state.pending = { request, timedOut: false }; state.confirm = undefined; state.notice = undefined;
    return this.send(state);
  }

  private async send(state: State): Promise<string> {
    const pending = state.pending!;
    clearTimeout(pending.timer);
    pending.timedOut = false;
    pending.timer = setTimeout(() => {
      if (!this.active(state) || state.pending !== pending) return;
      pending.timedOut = true; this.changed(state);
    }, 15_000);
    pending.timer.unref?.();
    this.changed(state);
    try {
      if (!await this.transport.send(state.deviceId, pending.request)) throw new Error('offline');
    } catch {
      if (state.pending === pending) {
        clearTimeout(pending.timer); pending.timedOut = true; this.changed(state);
      }
    }
    if (!this.active(state)) throw new Error('This schedule card has expired. Use /schedule list.');
    if (state.pending !== pending) return state.notice ?? 'Check the latest schedule card.';
    return pending.timedOut ? 'The outcome is unknown. Retry confirmation.' : 'Waiting for CLI confirmation.';
  }

  async resolve(deviceId: string, message: ScheduleActionResult): Promise<void> {
    this.prune();
    if (!message || !id(message.messageId) || typeof message.success !== 'boolean') return;
    for (const state of this.states.values()) {
      const pending = state.pending;
      if (!pending || state.deviceId !== deviceId || pending.request.messageId !== message.messageId
        || message.openId !== state.openId || message.threadId !== state.menu.threadId
        || message.snapshotId !== pending.request.snapshotId || !this.active(state)) continue;
      if (!await this.transport.ownsDevice(state.openId, deviceId) || !this.active(state)
        || state.pending !== pending || !this.transport.available(deviceId)) return;
      const menu = parseScheduleMenu(message.menu, this.transport.available(deviceId, true));
      if (menu && menu.threadId !== state.menu.threadId) return;
      clearTimeout(pending.timer); state.pending = undefined;
      if (pending.request.operation === 'more') {
        const known = new Set(state.menu.entries.map(entry => entry.value));
        if (message.success && menu?.snapshotId === state.menu.snapshotId && menu.expiresAt === state.menu.expiresAt
          && menu.entries[0]?.value === pending.request.value && state.menu.entries.length + menu.entries.length <= 2000
          && menu.entries.every(entry => scheduleView(entry) === state.view && !known.has(entry.value))) {
          state.page = this.entries(state).length;
          state.menu.entries.push(...menu.entries);
          state.menu.more![state.view] = menu.more?.[state.view];
        } else state.notice = 'Could not load this page. Retry or refresh the list.';
        this.changed(state); await state.chain; return;
      }
      const selectedId = this.entries(state)[state.page]?.id;
      if (menu) {
        state.menu = menu;
        state.stale = false;
        state.page = Math.max(0, this.entries(state).findIndex(entry => entry.id === selectedId));
      } else {
        // Without a fresh CLI snapshot, old cancellation eligibility is unsafe.
        state.stale = true;
      }
      state.notice = message.success ? (pending.request.operation === 'cancel'
        ? (menu?.entries.some(entry => entry.id === selectedId && entry.state === 'cancelled' && !entry.canCancel) ? 'Cancellation confirmed by the CLI.'
          : 'The CLI confirmed the request. Check the current task status below or refresh it.')
        : (menu ? 'Status refreshed from the CLI schedule catalog.' : 'Current catalog status is unavailable. Use /schedule list.'))
        : (pending.request.operation === 'cancel' ? 'Cancellation was not confirmed. Refresh the status or retry cleanup.' : 'Status refresh failed. Try again or use /schedule list.');
      this.changed(state);
      await state.chain;
    }
  }

  disconnect(deviceId: string): void {
    for (const state of this.states.values()) if (state.deviceId === deviceId) {
      clearTimeout(state.pending?.timer); state.pending = undefined; state.expired = true;
      this.changed(state);
    }
  }
  destroy(): void { for (const state of this.states.values()) this.drop(state); }
  private active(state: State): boolean { return this.states.get(state.id) === state && !state.expired && state.ownsBinding() && state.menu.expiresAt > Date.now(); }
  private drop(state: State): void { clearTimeout(state.pending?.timer); this.states.delete(state.id); }
  private prune(): void { for (const state of this.states.values()) if (state.menu.expiresAt <= Date.now()) this.drop(state); }
  private changed(state: State): void {
    state.revision++;
    state.chain = state.chain.catch(() => {}).then(async () => {
      const current = async () => this.active(state) && await this.transport.ownsDevice(state.openId, state.deviceId)
        && this.active(state) && this.transport.available(state.deviceId);
      if (!await current()) return;
      const elements = this.render(state);
      for (const card of state.cards) await this.transport.update(card, elements, current);
    }).catch(() => {});
  }

  private entries(state: State): ScheduleCardEntry[] {
    return state.menu.entries.filter(entry => scheduleView(entry) === state.view);
  }

  private render(state: State): any[] {
    const blocked = Boolean(state.pending) || !this.active(state);
    const markdown = (content: string) => ({ tag: 'markdown', content });
    const notation = (content: string) => ({ tag: 'markdown', text_size: 'notation', content });
    const button = (op: string, label: string, value?: string, disabled = blocked) => ({ tag: 'button',
      text: { tag: 'plain_text', content: label }, type: op === 'confirm' ? 'danger' : 'default', disabled,
      behaviors: [{ type: 'callback', value: { action: 'schedule', id: state.id, rev: state.revision, op, ...(value === undefined ? {} : { value }) } }] });
    const row = (buttons: any[]) => ({ tag: 'column_set', flex_mode: 'none', columns: buttons.map(item => ({
      tag: 'column', width: 'weighted', weight: 1, elements: [item],
    })) });
    const entries = this.entries(state);
    const entry = entries[state.page];
    const more = !!state.menu.more?.[state.view];
    const elements: any[] = [];
    if (entry) {
      const cleanupPending = entry.canCancel && !['creating', 'active', 'running'].includes(entry.state);
      const status = statusPresentation(entry.state, cleanupPending);
      // Keep the user request as the visual headline. The complete task ID stays
      // available as a subdued reference for copy/paste and callback support.
      elements.push(markdown(`**${escape(entry.prompt)}**`));
      elements.push(markdown(`<text_tag color='${status.color}'>${status.label}</text_tag> · ${escape(entry.backend)} · ${escape(state.menu.threadName)}`));
      elements.push(notation(`When: ${escape(displayRule(entry.rule))}\nReference: \`${escape(entry.id)}\``));
      if (state.view === 'current') {
        if (entry.nextDueAt !== undefined) elements.push(notation(`Next due: ${formatUtcDateTime(entry.nextDueAt)}`));
        const last = entry.lastOccurrence;
        if (last) elements.push(notation(`Latest slot: ${formatUtcDateTime(last.dueAt)} · ${last.status}`
          + (last.error ? `\n${escape(last.error)}` : '')));
      }
      if (entry.pending) elements.push(notation(entry.pending === 'delivery' ? 'Result delivery pending.' : 'Execution pending.'));
      if (entry.error) elements.push(notation(`<text_tag color='red'>Details</text_tag> · ${escape(entry.error)}`));
      if (state.confirm) {
        elements.push(markdown('Cancel future runs of this task? Work already queued or running may still finish. The conversation remains available. Results already delivered cannot be recalled.'));
        elements.push(row([button('confirm', 'Confirm cancellation'), button('back', 'Back')]));
      } else elements.push(row([button('refresh', 'Refresh status'), button('cancel', cleanupPending ? 'Retry stopping task' : 'Cancel task', entry.value, blocked || !!state.stale || !entry.canCancel)]));
      if (entries.length > 1 || more) {
        elements.push(markdown(`${state.view === 'history' ? 'History' : 'Current'} · Task ${state.page + 1} of ${entries.length}${more ? '+' : ''}`));
        elements.push(row([button('page', 'Previous', String(state.page - 1), blocked || state.page === 0),
          button('page', 'Next', String(state.page + 1), blocked || state.page + 1 >= entries.length && !more)]));
      }
    } else {
      elements.push(markdown(`**Scheduled tasks** · ${escape(state.menu.threadName)}`),
        notation(more ? 'More tasks are available.' : state.view === 'history' ? 'No schedule history in this thread.' : 'No current schedules in this thread.'),
        row([button('refresh', 'Refresh status'), ...(more ? [button('page', 'Load tasks', '0')] : [])]));
    }
    if (!state.confirm) elements.push(row([state.view === 'history' ? button('view', 'Back to current', 'current') : button('view', 'View history', 'history')]));
    if (state.notice) elements.push(notation(escape(state.notice)));
    if (state.pending) {
      elements.push(notation(state.pending.timedOut
        ? "<text_tag color='orange'>Outcome unknown</text_tag> · Retry confirmation; no success has been confirmed."
        : "<text_tag color='blue'>Waiting for confirmation</text_tag> · The CLI has not acknowledged this action yet."));
      if (state.pending.timedOut) elements.push(row([button('retry', 'Retry confirmation', undefined, !this.active(state))]));
    }
    elements.push(notation(state.expired ? 'Connection ended. Use /schedule list after reconnecting.'
      : 'Keep the CLI running when a task is due. Use /schedule list for a fresh card.'));
    return elements;
  }
}
