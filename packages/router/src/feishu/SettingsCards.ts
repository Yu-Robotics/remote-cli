import { randomUUID } from 'crypto';
import type {
  SettingsActionMessage,
  SettingsBackend,
  SettingsChoice,
  SettingsKind,
  SettingsMenu,
  SettingsResultMessage,
  SettingsScope,
} from '../types/Settings';

/**
 * Dedicated interactive settings cards (backend/model/effort/delegation menus).
 *
 * Menus are delivered as the finalized card of the originating command's
 * streaming placeholder, bound to the original user, device, thread, request
 * and CLI-owned snapshot. Callback values are untrusted: every click is
 * revalidated against the stored snapshot, the delivered card ID, the current
 * device ownership and the menu revision. Local draft edits (backend/scope/
 * page) never reach the CLI; only Confirm, an explicit choice, Reset,
 * Follow-global and target-backend views send a `settings_action`. A pending
 * request suppresses further mutations until a matching `settings_result`
 * arrives or the bounded wait expires (unknown, never success).
 */

export interface SettingsTransport {
  ownsDevice(openId: string, deviceId: string): Promise<boolean>;
  /** True only while the device's current connection negotiated settingsCards. */
  available(deviceId: string, kind?: SettingsKind): boolean;
  send(deviceId: string, message: object): Promise<boolean>;
  update(cardId: string, elements: any[], header?: Record<string, unknown>): Promise<void>;
}

export interface PreparedSettings {
  elements: any[];
  deliver(cardIds: string[]): void;
  discard(): void;
}

interface PendingRequest {
  requestId: string;
  label: string;
  message: SettingsActionMessage;
  timedOut?: boolean;
  timer?: NodeJS.Timeout;
}

interface MenuState {
  id: string;
  openId: string;
  deviceId: string;
  requestMessageId: string;
  menu: SettingsMenu;
  revision: number;
  page: number;
  draftBackend: SettingsBackend;
  draftScope: SettingsScope;
  draftFollowGlobal?: boolean;
  cards: Set<string>;
  pending?: PendingRequest;
  notice?: string;
  terminal?: string;
  createdAt: number;
  chain: Promise<void>;
  choiceLayout?: ChoiceLayout;
}

interface ChoicePage {
  choices: SettingsChoice[];
  index: number;
  total: number;
}

interface ChoiceLayout {
  menu: SettingsMenu;
  pending?: PendingRequest;
  timedOut?: boolean;
  notice?: string;
  pages: SettingsChoice[][];
}

type SettingsOperation = SettingsActionMessage['operation'];
type LocalOperation = 'draft_backend' | 'draft_scope' | 'draft_follow_global' | 'page';
type ClickOperation = SettingsOperation | LocalOperation | 'retry';

const BACKENDS: readonly SettingsBackend[] = ['claude', 'codex', 'opencode', 'kimi', 'zcode', 'pi', 'agy', 'dsh'];
const MAX_MENUS = 100;
const MAX_CARDS_PER_MENU = 4;
const MAX_MENU_AGE_MS = 24 * 60 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
// Delivery is a bare finalize: the handler adds no header/footer/thread-switch
// rows, and refreshes replace the whole body. The budget below therefore covers
// everything this controller renders, including section headings and dividers.
const MAX_TAGGED_NODES = 90;
const MAX_ELEMENTS_BYTES = 16 * 1024;
const MAX_BACKENDS = 16;
const MAX_CHOICES = 512;
const LIMITS = { id: 100, label: 80, value: 512, reason: 160, notice: 300 } as const;

const EXPIRED = 'This settings card has expired. Run the command again.';

function bounded(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  return Array.from(value.replace(/[\x00-\x1f\x7f]/g, ' ')).slice(0, max).join('');
}

/** Opaque native values are validated, never shortened or whitespace-normalized. */
function identifier(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value)
    ? value : undefined;
}

function escapeMarkdown(value: string): string {
  return value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_{}\[\]()!|#]/g, '\\$&');
}

function taggedNodes(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  let count = 0;
  const record = value as Record<string, unknown>;
  if (record.tag) count = 1;
  for (const child of Object.values(record)) {
    if (Array.isArray(child)) for (const item of child) count += taggedNodes(item);
    else if (child && typeof child === 'object') count += taggedNodes(child);
  }
  return count;
}

/** Validate and bound an untrusted wire menu. Returns undefined when unusable. */
export function sanitizeSettingsMenu(input: unknown): SettingsMenu | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Record<string, unknown>;
  const kind = raw.kind === 'backend' || raw.kind === 'model' || raw.kind === 'effort' || raw.kind === 'delegation' ? raw.kind : undefined;
  const snapshotId = identifier(raw.snapshotId, LIMITS.id);
  const threadId = identifier(raw.threadId, LIMITS.id);
  const threadName = bounded(raw.threadName, LIMITS.label);
  const coordinatorBackend = BACKENDS.includes(raw.coordinatorBackend as SettingsBackend) ? raw.coordinatorBackend as SettingsBackend : undefined;
  const targetBackend = BACKENDS.includes(raw.targetBackend as SettingsBackend) ? raw.targetBackend as SettingsBackend : undefined;
  const expiresAt = typeof raw.expiresAt === 'number' && Number.isFinite(raw.expiresAt) ? raw.expiresAt : undefined;
  if (!kind || !snapshotId || !threadId || !threadName || !coordinatorBackend || !targetBackend || !expiresAt || expiresAt <= 0) return undefined;
  if (kind === 'delegation' && (targetBackend !== coordinatorBackend || !['on', 'off'].includes(raw.configuredValue as string))) return undefined;

  const backends: SettingsMenu['backends'] = [];
  if (!Array.isArray(raw.backends)) return undefined;
  const seenBackends = new Set<string>();
  for (const entry of raw.backends.slice(0, MAX_BACKENDS)) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, unknown>;
    if (!BACKENDS.includes(candidate.value as SettingsBackend) || seenBackends.has(candidate.value as string)) continue;
    const label = bounded(candidate.label, LIMITS.label);
    if (!label) continue;
    seenBackends.add(candidate.value as string);
    backends.push({
      value: candidate.value as SettingsBackend,
      label,
      installed: candidate.installed === true,
      reason: bounded(candidate.reason, LIMITS.reason),
      worker: typeof candidate.worker === 'boolean' ? candidate.worker : undefined,
      version: bounded(candidate.version, LIMITS.label),
    });
  }
  if (!backends.some(backend => backend.value === targetBackend)) return undefined;

  const choices: SettingsChoice[] = [];
  const seenChoices = new Set<string>();
  for (const entry of Array.isArray(raw.choices) ? raw.choices.slice(0, MAX_CHOICES) : []) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, unknown>;
    const value = identifier(candidate.value, LIMITS.value);
    const label = bounded(candidate.label, LIMITS.label);
    if (!value || !label || seenChoices.has(value)) continue;
    if (kind === 'delegation' && value !== 'on' && value !== 'off') continue;
    seenChoices.add(value);
    choices.push({
      value,
      label,
      description: bounded(candidate.description, LIMITS.reason),
      disabled: candidate.disabled === true,
      reason: bounded(candidate.reason, LIMITS.reason),
    });
  }

  const effectiveSource = raw.effectiveSource === 'native' || raw.effectiveSource === 'configured' ? raw.effectiveSource : 'unknown';
  return {
    snapshotId,
    kind,
    threadId,
    threadName,
    coordinatorBackend,
    targetBackend,
    backends,
    choices,
    configuredValue: identifier(raw.configuredValue, LIMITS.value),
    effectiveValue: identifier(raw.effectiveValue, LIMITS.value),
    defaultValue: identifier(raw.defaultValue, LIMITS.value),
    effectiveSource,
    supportsReset: kind !== 'delegation' && raw.supportsReset === true,
    followsGlobal: typeof raw.followsGlobal === 'boolean' ? raw.followsGlobal : undefined,
    busy: raw.busy === true,
    expiresAt,
    unavailableReason: bounded(raw.unavailableReason, LIMITS.reason),
    omittedChoices: ((typeof raw.omittedChoices === 'number' && Number.isInteger(raw.omittedChoices) && raw.omittedChoices > 0
      ? Math.min(raw.omittedChoices, 100_000) : 0) + (Array.isArray(raw.choices) ? Math.max(0, raw.choices.length - MAX_CHOICES) : 0)) || undefined,
  };
}

export class SettingsCards {
  private readonly menus = new Map<string, MenuState>();

  constructor(private readonly transport: SettingsTransport) {}

  /** Build the card body for a freshly arrived menu; delivery binds actual card IDs. */
  present(input: { openId: string; deviceId: string; menu: unknown; requestMessageId: string; expectedThreadId?: string }): PreparedSettings | undefined {
    this.prune();
    const menu = sanitizeSettingsMenu(input.menu);
    if (!menu || menu.expiresAt <= Date.now()) return undefined;
    if (menu.kind === 'delegation' && !this.transport.available(input.deviceId, menu.kind)) return undefined;
    // A menu only lands on the card of its own thread's request.
    if (input.expectedThreadId && menu.threadId !== input.expectedThreadId) return undefined;
    for (const state of this.menus.values()) {
      if (state.deviceId === input.deviceId && state.menu.threadId === menu.threadId && state.menu.kind === menu.kind && !state.terminal) {
        this.setTerminal(state, 'Superseded by a newer settings card.');
      }
    }
    if (this.menus.size >= MAX_MENUS) {
      const evictable = [...this.menus.values()].filter(state => !state.pending)
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!evictable) return undefined;
      this.drop(evictable);
    }
    const state: MenuState = {
      id: randomUUID(),
      openId: input.openId,
      deviceId: input.deviceId,
      requestMessageId: input.requestMessageId,
      menu,
      revision: 1,
      page: 0,
      draftBackend: menu.targetBackend,
      draftScope: 'thread',
      cards: new Set(),
      createdAt: Date.now(),
      chain: Promise.resolve(),
    };
    this.menus.set(state.id, state);
    const elements = this.render(state);
    return {
      elements,
      deliver: cardIds => {
        // The byte budget guarantees a single chunk; if a split ever happened,
        // every chunk would carry partial controls, so degrade them all.
        if (cardIds.length !== 1) {
          this.setTerminal(state, 'This settings card could not stay interactive. Use the text command instead.');
          for (const cardId of cardIds.slice(0, MAX_CARDS_PER_MENU)) state.cards.add(cardId);
          this.refresh(state);
          return;
        }
        for (const cardId of cardIds.slice(0, MAX_CARDS_PER_MENU)) state.cards.add(cardId);
      },
      discard: () => this.drop(state),
    };
  }

  async click(openId: string, cardId: string, payload: { id?: string; rev?: number; op?: string; value?: string }): Promise<string> {
    this.prune();
    const state = typeof payload.id === 'string' ? this.menus.get(payload.id) : undefined;
    if (!state || !state.cards.has(cardId)) throw new Error(EXPIRED);
    if (state.terminal) throw new Error(state.terminal);
    if (typeof payload.rev !== 'number' || payload.rev > state.revision) throw new Error('This settings card is outdated. Use the latest card.');
    if (Date.now() > Math.min(state.menu.expiresAt, state.createdAt + MAX_MENU_AGE_MS)) throw new Error(EXPIRED);
    if (state.openId !== openId || !(await this.transport.ownsDevice(openId, state.deviceId))) {
      throw new Error('This settings card belongs to another user.');
    }
    if (this.menus.get(state.id) !== state || state.terminal) throw new Error(EXPIRED);
    if (Date.now() > Math.min(state.menu.expiresAt, state.createdAt + MAX_MENU_AGE_MS)) throw new Error(EXPIRED);
    const op = payload.op as ClickOperation | undefined;
    // Pending suppression precedes the revision check: a rapid second click from
    // the still-visible older revision must see "waiting", not "outdated".
    if (state.pending) {
      if (state.pending.timedOut && op === 'retry') {
        if (!this.transport.available(state.deviceId, state.menu.kind)) throw new Error('The original CLI is offline. Reconnect it and open a new settings card.');
        await this.sendPending(state, state.pending);
        return 'Retrying confirmation for the original settings request.';
      }
      return state.pending.timedOut ? 'The outcome is unknown. Retry confirmation or run the settings command again.'
        : `${state.pending.label} Waiting for the CLI.`;
    }
    if (op === 'page' || op === 'draft_backend' || op === 'draft_scope' || op === 'draft_follow_global') {
      // Local draft edits are deterministic against the immutable snapshot and
      // safe from any past revision of the same delivered card.
      return this.localEdit(state, op, payload.value);
    }
    // Mutations and view requests require the exact rendered revision: a stale
    // card must never silently apply a different operation.
    if (payload.rev !== state.revision) throw new Error('This settings card is outdated. Use the latest card.');
    if (!this.transport.available(state.deviceId, state.menu.kind)) {
      throw new Error('The original CLI is offline or does not support settings cards. Reconnect it first.');
    }
    const action = this.buildAction(state, op, payload.value);
    if (!action) throw new Error('That action is not available for this card.');

    const requestId = randomUUID();
    const pending: PendingRequest = { requestId, label: action.label, message: action.message(requestId) };
    state.pending = pending;
    await this.sendPending(state, pending);
    return action.toast;
  }

  private async sendPending(state: MenuState, pending: PendingRequest): Promise<void> {
    const { requestId } = pending;
    pending.timedOut = false;
    const timer = setTimeout(() => {
      if (this.menus.get(state.id) !== state || state.pending !== pending) return;
      pending.timedOut = true;
      pending.timer = undefined;
      state.notice = 'No confirmation from the CLI — the change may or may not have been applied. Retry confirmation for the same request, or run the settings command again.';
      this.touch(state);
    }, REQUEST_TIMEOUT_MS);
    timer.unref?.();
    pending.timer = timer;
    this.touch(state);
    try {
      const sent = await this.transport.send(state.deviceId, pending.message);
      if (!sent) throw new Error('offline');
    } catch {
      if (state.pending?.requestId === requestId) {
        clearTimeout(timer);
        pending.timedOut = true;
        pending.timer = undefined;
        state.notice = 'Could not contact the original CLI. The outcome is unknown; retry confirmation or open a new settings card.';
        this.touch(state);
      }
      throw new Error('Could not contact the original CLI. Reconnect it and retry.');
    }
  }

  /** Resolve a CLI settings_result. Only the matching pending request applies. */
  async resolve(deviceId: string, message: SettingsResultMessage): Promise<void> {
    if (typeof message?.messageId !== 'string' || typeof message.success !== 'boolean') return;
    for (const state of this.menus.values()) {
      if (state.deviceId !== deviceId || state.pending?.requestId !== message.messageId) continue;
      if (message.openId !== state.openId || message.threadId !== state.menu.threadId || message.snapshotId !== state.menu.snapshotId) continue;
      clearTimeout(state.pending.timer);
      state.pending = undefined;
      if (message.success) {
        const fresh = message.menu ? sanitizeSettingsMenu(message.menu) : undefined;
        if (message.menu && fresh && fresh.kind === state.menu.kind && fresh.threadId === state.menu.threadId) {
          // A fresh menu replaces page/draft state and invalidates old buttons.
          state.menu = fresh;
          state.page = 0;
          state.draftBackend = fresh.targetBackend;
          state.draftScope = 'thread';
          state.draftFollowGlobal = false;
          state.notice = bounded(message.notice, LIMITS.notice);
        } else {
          this.setTerminal(state, bounded(message.notice, LIMITS.notice) ?? 'Applied.');
          return;
        }
      } else {
        state.notice = bounded(message.error, LIMITS.notice) ?? 'The CLI rejected the change.';
      }
      this.touch(state);
      return;
    }
  }

  disconnect(deviceId: string): void {
    for (const state of [...this.menus.values()]) if (state.deviceId === deviceId) this.drop(state);
  }

  destroy(): void {
    for (const state of this.menus.values()) if (state.pending?.timer) clearTimeout(state.pending.timer);
    this.menus.clear();
  }

  private localEdit(state: MenuState, op: LocalOperation, value: unknown): string {
    if (op === 'page') {
      const target = Number(value);
      const pages = this.choicePages(state).length;
      if (!Number.isInteger(target) || target < 0 || target >= pages || target === state.page) throw new Error('That page is unavailable.');
      state.page = target;
      this.touch(state);
      return `Page ${target + 1} of ${pages}.`;
    }
    if (op === 'draft_backend' && state.menu.kind === 'backend') {
      const backend = state.menu.backends.find(entry => entry.value === value);
      if (!backend || !backend.installed) throw new Error('That backend is not available.');
      state.draftBackend = backend.value;
      state.draftFollowGlobal = false;
      this.touch(state);
      return `Selected ${backend.label}. Press Confirm to apply.`;
    }
    if (op === 'draft_scope' && state.menu.kind === 'backend') {
      if (value !== 'thread' && value !== 'all') throw new Error('Unknown scope.');
      state.draftScope = value;
      if (value === 'all') state.draftFollowGlobal = false;
      this.touch(state);
      return value === 'all'
        ? 'Scope: all threads on this device. Press Confirm to apply.'
        : 'Scope: this thread. Press Confirm to apply.';
    }
    if (op === 'draft_follow_global' && state.menu.kind === 'backend' && state.menu.followsGlobal === false) {
      state.draftFollowGlobal = true;
      state.draftScope = 'thread';
      this.touch(state);
      return 'Selected the global backend for this thread. Press Confirm to apply.';
    }
    throw new Error('That action is not available for this card.');
  }

  private buildAction(state: MenuState, op: ClickOperation | undefined, value: unknown): { label: string; toast: string; message: (requestId: string) => SettingsActionMessage } | undefined {
    const menu = state.menu;
    const base = (requestId: string): Omit<SettingsActionMessage, 'operation'> => ({
      type: 'settings_action',
      messageId: requestId,
      openId: state.openId,
      threadId: menu.threadId,
      snapshotId: menu.snapshotId,
      timestamp: Date.now(),
    });
    const busyBlocked = menu.busy;
    if (op === 'view' && menu.kind === 'delegation') {
      if (value !== undefined) return undefined;
      return { label: 'Refreshing delegation…', toast: 'Refreshing delegation…',
        message: requestId => ({ ...base(requestId), operation: 'view' }) };
    }
    if (op === 'view' && menu.kind !== 'backend') {
      const backend = menu.backends.find(entry => entry.value === value);
      if (!backend || !backend.installed) return undefined;
      return { label: `Loading ${backend.label}…`, toast: `Loading ${backend.label} settings…`,
        message: requestId => ({ ...base(requestId), operation: 'view', targetBackend: backend.value }) };
    }
    if (op === 'apply' && menu.kind !== 'backend') {
      const choice = menu.choices.find(entry => entry.value === value);
      if (!choice || choice.disabled || busyBlocked) return undefined;
      return { label: `Applying ${choice.label}…`, toast: `Applying ${choice.label}…`,
        message: requestId => ({ ...base(requestId), operation: 'apply', value: choice.value }) };
    }
    if (op === 'reset' && menu.kind !== 'backend' && menu.supportsReset && !busyBlocked) {
      return { label: 'Restoring the default…', toast: 'Restoring the default…',
        message: requestId => ({ ...base(requestId), operation: 'reset' }) };
    }
    if (op === 'apply' && menu.kind === 'backend') {
      if (state.draftFollowGlobal && menu.followsGlobal === false && !busyBlocked) {
        return { label: 'Following the global backend…', toast: 'Following the global backend…',
          message: requestId => ({ ...base(requestId), operation: 'follow_global' }) };
      }
      const backend = menu.backends.find(entry => entry.value === state.draftBackend);
      if (!backend || !backend.installed || busyBlocked) return undefined;
      return { label: `Applying ${backend.label}…`, toast: `Applying ${backend.label}…`,
        message: requestId => ({ ...base(requestId), operation: 'apply', value: backend.value, scope: state.draftScope }) };
    }
    return undefined;
  }

  private withinBudget(state: MenuState, elements: any[]): boolean {
    const card = { schema: '2.0', header: this.header(state), body: { elements } };
    return taggedNodes(card) <= MAX_TAGGED_NODES
      && Buffer.byteLength(JSON.stringify(card)) <= MAX_ELEMENTS_BYTES;
  }

  /** Show every choice when possible; otherwise pack complete, budgeted cards. */
  private choicePages(state: MenuState): SettingsChoice[][] {
    const choices = state.menu.choices;
    if (choices.length === 0 || state.menu.kind === 'backend' || state.menu.kind === 'delegation') return [choices];
    const layout = state.choiceLayout;
    if (layout?.menu === state.menu && layout.pending === state.pending
      && layout.timedOut === state.pending?.timedOut && layout.notice === state.notice) return layout.pages;
    const remember = (pages: SettingsChoice[][]) => {
      state.choiceLayout = { menu: state.menu, pending: state.pending, timedOut: state.pending?.timedOut, notice: state.notice, pages };
      return pages;
    };
    const fits = (renderState: MenuState, page: ChoicePage) => this.withinBudget(renderState, this.renderInteractive(renderState, page));
    if (fits(state, { choices, index: 0, total: 1 })) return remember([choices]);

    // Reserve callback revision width so paging cannot shift choice boundaries
    // when revisions gain digits. Reuse the layout until visible chrome changes.
    const packingState = { ...state, revision: Number.MAX_SAFE_INTEGER };

    const pages: SettingsChoice[][] = [];
    let offset = 0;
    while (offset < choices.length) {
      let low = 1;
      let high = choices.length - offset;
      let size = 0;
      while (low <= high) {
        const candidate = Math.floor((low + high) / 2);
        // Reserve the largest possible page-number labels and callback values.
        // Actual pages use fewer digits and never need more navigation space.
        if (fits(packingState, { choices: choices.slice(offset, offset + candidate), index: choices.length, total: choices.length + 2 })) {
          size = candidate;
          low = candidate + 1;
        } else {
          high = candidate - 1;
        }
      }
      // If even one choice cannot fit, keep it reachable through the existing
      // static fallback rather than dropping it or looping without progress.
      size = Math.max(1, size);
      pages.push(choices.slice(offset, offset + size));
      offset += size;
    }
    return remember(pages);
  }

  private touch(state: MenuState): void {
    state.revision += 1;
    this.refresh(state);
  }

  private setTerminal(state: MenuState, text: string): void {
    if (state.pending?.timer) clearTimeout(state.pending.timer);
    state.pending = undefined;
    state.terminal = text;
    state.revision += 1;
    this.refresh(state);
  }

  private drop(state: MenuState): void {
    if (state.pending?.timer) clearTimeout(state.pending.timer);
    this.menus.delete(state.id);
  }

  private refresh(state: MenuState): void {
    const elements = this.render(state);
    const header = this.header(state);
    state.chain = state.chain.then(async () => {
      for (const cardId of state.cards) {
        try { await this.transport.update(cardId, elements, header); } catch { /* The next interaction or delivery re-renders. */ }
      }
    }).catch(() => undefined);
  }

  private header(state: MenuState): Record<string, unknown> {
    const title = state.menu.kind === 'backend' ? '⚙️ Backend settings'
      : state.menu.kind === 'model' ? '🎯 Model settings' : state.menu.kind === 'delegation' ? '🤝 Agent delegation' : '⚡ Effort settings';
    return { title: { tag: 'plain_text', content: title }, template: state.terminal ? 'grey' : state.pending ? 'blue' : 'blue' };
  }

  private button(state: MenuState, op: ClickOperation, label: string, options: { value?: string; primary?: boolean; disabled?: boolean }): any {
    return {
      tag: 'button',
      text: { tag: 'plain_text', content: label },
      type: options.primary ? 'primary' : 'default',
      disabled: options.disabled === true,
      behaviors: [{ type: 'callback', value: { action: 'settings', id: state.id, rev: state.revision, op, ...(options.value !== undefined ? { value: options.value } : {}) } }],
    };
  }

  private row(buttons: any[]): any {
    return { tag: 'column_set', flex_mode: 'stretch', columns: buttons.map(button => ({ tag: 'column', width: 'auto', elements: [button] })) };
  }

  private note(content: string): any {
    return { tag: 'markdown', text_size: 'notation', content };
  }

  private render(state: MenuState): any[] {
    const pages = state.terminal ? undefined : this.choicePages(state);
    const index = pages ? Math.min(state.page, pages.length - 1) : 0;
    const elements = state.terminal ? this.renderTerminal(state)
      : this.renderInteractive(state, { choices: pages![index], index, total: pages!.length });
    // Budget guard: degrade to a static card instead of risking a split card
    // with controls detached from their bound chunk.
    if (!this.withinBudget(state, elements)) {
      return [
        { tag: 'markdown', content: `**Settings** · ${escapeMarkdown(state.menu.threadName)}` },
        this.note('This menu is too large to render safely as a card. Use the text command instead.'),
      ];
    }
    return elements;
  }

  private renderTerminal(state: MenuState): any[] {
    return [
      { tag: 'markdown', content: `**Settings** · ${escapeMarkdown(state.menu.threadName)}` },
      this.note(escapeMarkdown(state.terminal ?? 'Closed.')),
    ];
  }

  private renderInteractive(state: MenuState, page: ChoicePage): any[] {
    const menu = state.menu;
    const lines: string[] = [];
    const pending = state.pending;
    const blocked = Boolean(pending) || menu.busy;

    if (menu.kind === 'backend') {
      const current = this.backendLabel(state, menu.targetBackend);
      lines.push(`**Backend** · ${escapeMarkdown(menu.threadName)}`);
      lines.push(`Current: **${escapeMarkdown(current)}**${menu.followsGlobal === false ? ' (thread override)' : ' (global)'}`);
      if (state.draftScope === 'all') lines.push('⚠️ Switching all threads clears per-thread backend overrides and queued messages. Native conversations are kept.');
    } else if (menu.kind === 'delegation') {
      lines.push(`**Agent delegation** · ${escapeMarkdown(menu.threadName)}`);
      lines.push(`Current thread only · Main backend: **${escapeMarkdown(this.backendLabel(state, menu.coordinatorBackend))}**`);
      lines.push(`Delegation: **${menu.configuredValue === 'on' ? 'On' : 'Off'}**`);
    } else {
      lines.push(`**${menu.kind === 'model' ? 'Model' : 'Effort'}** · ${escapeMarkdown(this.backendLabel(state, menu.targetBackend))} · ${escapeMarkdown(menu.threadName)}`);
      lines.push(`Configured: ${menu.configuredValue ? `\`${escapeMarkdown(menu.configuredValue)}\`` : '—'}`
        + ` · Effective: ${menu.effectiveValue ? `\`${escapeMarkdown(menu.effectiveValue)}\`` : 'unknown'} (${menu.effectiveSource})`
        + ` · Default: ${menu.defaultValue ? `\`${escapeMarkdown(menu.defaultValue)}\`` : 'unknown'}`);
      if (menu.unavailableReason) lines.push(`⚠️ ${escapeMarkdown(menu.unavailableReason)}`);
      if (menu.omittedChoices) lines.push(`Only the first choices are shown; ${menu.omittedChoices} more via the text command.`);
    }
    if (menu.busy) lines.push('Thread is busy — changes are disabled until it finishes.');
    const unavailable = menu.backends.filter(backend => !backend.installed && backend.reason);
    if (menu.kind === 'backend' && unavailable.length > 0) {
      lines.push(unavailable.map(backend => `${escapeMarkdown(backend.label)}: ${escapeMarkdown(backend.reason!)}`).join(' · '));
    }

    const elements: any[] = [{ tag: 'markdown', content: lines.join('\n') }];
    if (state.notice) elements.push(this.note(escapeMarkdown(state.notice)));
    if (pending && !pending.timedOut) elements.push(this.note(`⏳ ${escapeMarkdown(pending.label)} Waiting for the CLI…`));

    if (menu.kind === 'backend') {
      elements.push(...this.renderBackendSections(state, blocked));
    } else if (menu.kind === 'delegation') {
      elements.push(...this.renderDelegationSections(state, blocked));
    } else {
      elements.push(...this.renderChoiceSections(state, blocked, page));
    }
    if (pending?.timedOut) elements.push(this.row([this.button(state, 'retry', 'Retry confirmation', { primary: true })]));
    return elements;
  }

  /** A visually separated functional section: divider, heading, subtitle, body. */
  private section(title: string, subtitle: string, body: any[]): any[] {
    return [{ tag: 'hr' }, { tag: 'markdown', content: title }, this.note(subtitle), ...body];
  }

  private renderDelegationSections(state: MenuState, blocked: boolean): any[] {
    const menu = state.menu;
    const buttons = menu.choices.map(choice => this.button(state, 'apply',
      `${choice.value === menu.configuredValue ? '✓ ' : ''}${choice.label}`, {
        value: choice.value, primary: choice.value === menu.configuredValue, disabled: blocked || choice.disabled,
      }));
    const availability = menu.backends.map(backend => {
      const status = !backend.installed ? 'Not installed' : backend.worker === true ? 'Ready'
        : backend.worker === false ? 'Blocked' : 'Availability unknown';
      const detail = backend.reason || backend.version;
      return this.note(`**${escapeMarkdown(backend.label)}**${backend.value === menu.coordinatorBackend ? ' (Main)' : ''} · ${status}`
        + (detail ? ` · ${escapeMarkdown(detail)}` : ''));
    });
    const elements = [
      ...this.section('**1 · Delegation**', 'Applies only to this thread. Click On or Off; the selection changes only after CLI confirmation.',
        [this.row(buttons), ...menu.choices.filter(choice => choice.disabled && choice.reason).map(choice => this.note(escapeMarkdown(choice.reason!))),
          this.row([this.button(state, 'view', 'Refresh', { disabled: Boolean(state.pending) })])]),
      ...this.section('**2 · Backend availability**',
        'Installation and sandbox policy only. Authentication and quota are checked when a task starts.', availability),
      this.note('Managed workers are unavailable while the coordinator sandbox is enabled. Same-backend workers use independent sessions and cannot delegate recursively.'),
    ];
    if (menu.coordinatorBackend === 'zcode') elements.push(this.note('ZCode delegation temporarily replaces user-configured MCP servers. Off restores the normal MCP configuration.'));
    return elements;
  }

  private renderBackendSections(state: MenuState, blocked: boolean): any[] {
    const menu = state.menu;
    const elements: any[] = [];
    const current = this.backendLabel(state, menu.targetBackend);
    const draftNote = state.draftFollowGlobal
      ? ' Draft: follow the global backend — applies after Confirm.'
      : state.draftBackend !== menu.targetBackend
        ? ` Draft: **${escapeMarkdown(this.backendLabel(state, state.draftBackend))}** — applies after Confirm.`
        : '';

    const backendButtons = menu.backends.map(backend => {
      const isCurrent = backend.value === menu.targetBackend;
      const isDraft = !state.draftFollowGlobal && backend.value === state.draftBackend;
      const label = `${isDraft ? '✓ ' : ''}${backend.label}${isCurrent ? ' (current)' : ''}`.slice(0, LIMITS.label);
      return this.button(state, 'draft_backend', label, {
        value: backend.value,
        primary: isDraft,
        disabled: blocked || !backend.installed,
      });
    });
    const backendRows: any[] = [];
    for (let index = 0; index < backendButtons.length; index += 4) backendRows.push(this.row(backendButtons.slice(index, index + 4)));
    elements.push(...this.section('**1 · Choose backend**',
      `Current: **${escapeMarkdown(current)}**. Pick a backend to draft it — nothing changes until Confirm.${draftNote}`,
      backendRows));

    const scopeButtons = [
      this.button(state, 'draft_scope', `${state.draftScope === 'thread' ? '✓ ' : ''}Current thread`, {
        value: 'thread', primary: state.draftScope === 'thread', disabled: blocked,
      }),
      this.button(state, 'draft_scope', `${state.draftScope === 'all' ? '✓ ' : ''}All threads`, {
        value: 'all', primary: state.draftScope === 'all', disabled: blocked,
      }),
    ];
    let scopeSubtitle = 'Choose where the change applies: only this thread, or every thread on this device.';
    if (menu.followsGlobal === false) {
      scopeButtons.push(this.button(state, 'draft_follow_global', `${state.draftFollowGlobal ? '✓ ' : ''}Follow global`, {
        primary: Boolean(state.draftFollowGlobal), disabled: blocked,
      }));
      scopeSubtitle += ' Follow global uses the device-wide backend for this thread only.';
    }
    elements.push(...this.section('**2 · Apply to**', scopeSubtitle, [this.row(scopeButtons)]));

    elements.push(...this.section('**3 · Confirm**',
      'Only Confirm applies the drafted backend and scope.',
      [this.row([this.button(state, 'apply', 'Confirm', { primary: true, disabled: blocked })])]));
    return elements;
  }

  private renderChoiceSections(state: MenuState, blocked: boolean, page: ChoicePage): any[] {
    const menu = state.menu;
    const elements: any[] = [];
    const targetLabel = this.backendLabel(state, menu.targetBackend);

    const targetButton = (backend: SettingsMenu['backends'][number]) =>
      this.button(state, 'view', `${backend.value === menu.targetBackend ? '✓ ' : ''}${backend.label}`.slice(0, LIMITS.label), {
        value: backend.value,
        primary: backend.value === menu.targetBackend,
        disabled: Boolean(state.pending) || !backend.installed,
      });
    const main = menu.backends.find(backend => backend.value === menu.coordinatorBackend);
    const others = menu.backends.filter(backend => backend.value !== menu.coordinatorBackend).map(targetButton);
    const targetRows: any[] = [this.note('**Main backend · current thread**')];
    targetRows.push(main ? this.row([targetButton(main)])
      : this.note(`${escapeMarkdown(this.backendLabel(state, menu.coordinatorBackend))} is not available in this menu.`));
    if (others.length > 0) {
      targetRows.push({ tag: 'hr' }, this.note('**Other backends · worker preferences**'));
      for (let index = 0; index < others.length; index += 4) targetRows.push(this.row(others.slice(index, index + 4)));
    }
    elements.push(...this.section('**1 · Target backend**',
      `Settings below belong to **${escapeMarkdown(targetLabel)}**. Viewing another target never switches the conversation's backend.`,
      targetRows));

    const { choices, index, total } = page;
    const selectedValue = menu.configuredValue ?? menu.effectiveValue;
    const choiceBody: any[] = [];
    if (choices.length === 0) {
      choiceBody.push(this.note(menu.unavailableReason ? 'No choices available.' : 'No choices reported by the backend.'));
    }
    const choiceButtons = choices.map(choice =>
      this.button(state, 'apply', `${choice.value === selectedValue ? '✓ ' : ''}${choice.label}${choice.disabled && choice.reason ? ` (${choice.reason})` : ''}`.slice(0, LIMITS.label), {
        value: choice.value,
        primary: choice.value === selectedValue,
        disabled: blocked || choice.disabled,
      }));
    for (let index = 0; index < choiceButtons.length; index += 2) choiceBody.push(this.row(choiceButtons.slice(index, index + 2)));
    elements.push(...this.section(`**2 · ${menu.kind === 'model' ? 'Model' : 'Effort'} for ${escapeMarkdown(targetLabel)}**`,
      'Tap a choice to apply it immediately — it is saved per backend for this thread and used by future workers.',
      choiceBody));

    const utility: any[] = [];
    utility.push(this.button(state, 'view', 'Refresh', { value: menu.targetBackend,
      disabled: Boolean(state.pending) || !menu.backends.some(backend => backend.value === menu.targetBackend && backend.installed) }));
    if (total > 1) {
      utility.push(this.button(state, 'page', '◀ Prev', { value: String(index - 1), disabled: blocked || index === 0 }));
      utility.push(this.button(state, 'page', `${index + 1}/${total}`, { value: String(index), disabled: true }));
      utility.push(this.button(state, 'page', 'Next ▶', { value: String(index + 1), disabled: blocked || index >= total - 1 }));
    }
    if (menu.supportsReset) utility.push(this.button(state, 'reset', 'Reset to default', { disabled: blocked }));
    if (utility.length > 0) {
      elements.push(...this.section('**3 · More actions**',
        `Refresh reloads the choices from the backend.${menu.supportsReset ? ' Reset restores the default.' : ''}`,
        [this.row(utility)]));
    }
    return elements;
  }

  private backendLabel(state: MenuState, backend: SettingsBackend): string {
    return state.menu.backends.find(entry => entry.value === backend)?.label ?? backend;
  }

  private prune(): void {
    const now = Date.now();
    for (const state of [...this.menus.values()]) {
      if (state.pending && !state.pending.timedOut) continue;
      if (now > Math.min(state.menu.expiresAt, state.createdAt + MAX_MENU_AGE_MS)) this.drop(state);
    }
  }
}
