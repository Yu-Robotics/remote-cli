import { randomUUID } from 'crypto';
import type { ScheduleActionMessage, ScheduleActionResult, ScheduleCardEntry, ScheduleMenu } from '../types/ScheduleCards';

interface Transport {
  ownsDevice(openId: string, deviceId: string): Promise<boolean>;
  available(deviceId: string): boolean;
  send(deviceId: string, message: ScheduleActionMessage): Promise<boolean>;
  update(cardId: string, elements: any[]): Promise<void>;
}
interface State {
  id: string;
  openId: string;
  deviceId: string;
  menu: ScheduleMenu;
  cards: Set<string>;
  revision: number;
  page: number;
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

function formatUtcDateTime(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return;
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} UTC`;
}

function displayRule(rule: string): string {
  return formatUtcDateTime(rule) ?? rule;
}

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
export function parseScheduleMenu(value: unknown): ScheduleMenu | undefined {
  if (!value || typeof value !== 'object' || Buffer.byteLength(JSON.stringify(value)) > 128 * 1024) return;
  const menu = value as ScheduleMenu;
  if (!id(menu.snapshotId) || !id(menu.threadId) || !text(menu.threadName, 100)
    || !Number.isSafeInteger(menu.expiresAt) || menu.expiresAt <= Date.now() || menu.expiresAt > Date.now() + TTL + 60_000
    || !Array.isArray(menu.entries) || menu.entries.length > 100) return;
  const values = new Set<string>();
  for (const entry of menu.entries) {
    if (!entry || !id(entry.value) || !id(entry.id) || values.has(entry.value)
      || !['claude', 'dsh'].includes(entry.backend) || !['creating', 'active', 'running', 'completed', 'cancelled', 'interrupted', 'failed'].includes(entry.state)
      || !text(entry.rule, 160) || !text(entry.prompt, 240) || typeof entry.canCancel !== 'boolean'
      || (entry.error !== undefined && !text(entry.error, 240))) return;
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
    const menu = parseScheduleMenu(input.menu);
    if (!menu || !input.expectedThreadId || menu.threadId !== input.expectedThreadId
      || !this.transport.available(input.deviceId)) return;
    if (this.states.size >= MAX_CARDS) {
      const oldest = [...this.states.values()].find(state => !state.pending);
      if (!oldest) return;
      this.drop(oldest);
    }
    const state: State = { id: randomUUID(), openId: input.openId, deviceId: input.deviceId, menu,
      cards: new Set(), revision: 1, page: 0, chain: Promise.resolve() };
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
        await this.send(state);
        return 'Retrying confirmation of the original schedule action.';
      }
      return state.pending.timedOut ? 'The outcome is unknown. Retry confirmation.' : 'Waiting for CLI confirmation.';
    }
    if (payload.rev !== state.revision) {
      this.changed(state);
      throw new Error('This schedule card changed. Retry its latest buttons or use /schedule list.');
    }
    switch (payload.op) {
      case 'page': {
        const page = typeof payload.value === 'string' && /^\d{1,3}$/.test(payload.value) ? Number(payload.value) : -1;
        if (page < 0 || page >= state.menu.entries.length) throw new Error('Invalid schedule page.');
        state.page = page; state.confirm = undefined; this.changed(state); return 'Schedule page updated.';
      }
      case 'cancel': {
        const entry = state.menu.entries[state.page];
        if (!entry?.canCancel || entry.value !== payload.value) throw new Error('Refresh this schedule before cancelling it.');
        state.confirm = entry.value; this.changed(state); return 'Review the cancellation and confirm.';
      }
      case 'back': state.confirm = undefined; this.changed(state); return 'No cancellation was sent.';
      case 'confirm':
        if (!state.confirm || state.confirm !== state.menu.entries[state.page]?.value) throw new Error('Confirm cancellation from the latest card.');
        break;
      case 'refresh': break;
      default: throw new Error('Unknown schedule action.');
    }
    const request: ScheduleActionMessage = { type: 'schedule_action', messageId: randomUUID(), openId: state.openId,
      threadId: state.menu.threadId, snapshotId: state.menu.snapshotId, operation: payload.op === 'confirm' ? 'cancel' : 'refresh',
      ...(payload.op === 'confirm' ? { value: state.confirm } : {}), timestamp: Date.now() };
    state.pending = { request, timedOut: false }; state.confirm = undefined; state.notice = undefined;
    await this.send(state);
    return 'Waiting for CLI confirmation.';
  }

  private async send(state: State): Promise<void> {
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
      const menu = parseScheduleMenu(message.menu);
      if (menu && menu.threadId !== state.menu.threadId) return;
      clearTimeout(pending.timer); state.pending = undefined;
      const selectedId = state.menu.entries[state.page]?.id;
      if (menu) {
        state.menu = menu;
        state.page = Math.max(0, menu.entries.findIndex(entry => entry.id === selectedId));
      } else {
        // Without a fresh CLI snapshot, old cancellation eligibility is unsafe.
        state.menu.entries.forEach(entry => { entry.canCancel = false; });
      }
      state.notice = message.success ? (pending.request.operation === 'cancel'
        ? (menu?.entries.some(entry => entry.id === selectedId && entry.state === 'cancelled' && !entry.canCancel) ? 'Cancellation confirmed by the CLI.'
          : 'The CLI confirmed the request. Check the current task status below or refresh it.') : 'Status refreshed by the CLI.')
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
  private active(state: State): boolean { return this.states.get(state.id) === state && !state.expired && state.menu.expiresAt > Date.now(); }
  private drop(state: State): void { clearTimeout(state.pending?.timer); this.states.delete(state.id); }
  private prune(): void { for (const state of this.states.values()) if (state.menu.expiresAt <= Date.now()) this.drop(state); }
  private changed(state: State): void {
    state.revision++;
    state.chain = state.chain.catch(() => {}).then(async () => {
      if (this.states.get(state.id) !== state || !await this.transport.ownsDevice(state.openId, state.deviceId)
        || this.states.get(state.id) !== state) return;
      const elements = this.render(state);
      for (const card of state.cards) await this.transport.update(card, elements);
    }).catch(() => {});
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
    const entry = state.menu.entries[state.page];
    const elements: any[] = [];
    if (entry) {
      const cleanupPending = entry.canCancel && !['creating', 'active', 'running'].includes(entry.state);
      const status = statusPresentation(entry.state, cleanupPending);
      // Keep the user request as the visual headline. The complete task ID stays
      // available as a subdued reference for copy/paste and callback support.
      elements.push(markdown(`**${escape(entry.prompt)}**`));
      elements.push(markdown(`<text_tag color='${status.color}'>${status.label}</text_tag> · ${escape(entry.backend)} · ${escape(state.menu.threadName)}`));
      elements.push(notation(`When: ${escape(displayRule(entry.rule))}\nReference: \`${escape(entry.id)}\``));
      if (entry.error) elements.push(notation(`<text_tag color='red'>Details</text_tag> · ${escape(entry.error)}`));
      if (state.confirm) {
        elements.push(markdown('Cancel future runs of this task? Work already queued or running may still finish. The conversation remains available. Results already delivered cannot be recalled.'));
        elements.push(row([button('confirm', 'Confirm cancellation'), button('back', 'Back')]));
      } else elements.push(row([button('refresh', 'Refresh status'), button('cancel', cleanupPending ? 'Retry stopping task' : 'Cancel task', entry.value, blocked || !entry.canCancel)]));
      if (state.menu.entries.length > 1) {
        elements.push(markdown(`Task ${state.page + 1} of ${state.menu.entries.length}`));
        elements.push(row([button('page', 'Previous', String(state.page - 1), blocked || state.page === 0),
          button('page', 'Next', String(state.page + 1), blocked || state.page + 1 >= state.menu.entries.length)]));
      }
    } else elements.push(markdown(`**Scheduled tasks** · ${escape(state.menu.threadName)}`), notation('No schedules in this thread.'), row([button('refresh', 'Refresh status')]));
    if (state.notice) elements.push(notation(escape(state.notice)));
    if (state.pending) {
      elements.push(notation(state.pending.timedOut
        ? "<text_tag color='orange'>Outcome unknown</text_tag> · Retry confirmation; no success has been confirmed."
        : "<text_tag color='blue'>Waiting for confirmation</text_tag> · The CLI has not acknowledged this action yet."));
      if (state.pending.timedOut) elements.push(row([button('retry', 'Retry confirmation', undefined, !this.active(state))]));
    }
    elements.push(notation(state.expired ? 'Connection ended. Use /schedule list after reconnecting.'
      : `Keep the CLI running. Native timing is approximate; tasks are not recreated after restart.${entry?.backend === 'claude' ? ' Claude recurring tasks expire after seven days.' : ''} Use /schedule list for a fresh card.`));
    return elements;
  }
}
