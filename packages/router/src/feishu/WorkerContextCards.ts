import { createHash, randomUUID } from 'crypto';

export interface WorkerContextTarget {
  openId: string;
  deviceId: string;
  threadId: string;
  laneId: string;
  generation: number;
}

interface Action extends WorkerContextTarget {
  createdAt: number;
  status: 'idle' | 'pending' | 'cleared' | 'failed';
  requestId?: string;
  error?: string;
  timer?: NodeJS.Timeout;
}

interface Transport {
  ownsDevice(openId: string, deviceId: string): Promise<boolean>;
  available(deviceId: string): boolean;
  send(deviceId: string, message: object): Promise<boolean>;
  refresh(cardId: string, rootId: string): Promise<void>;
}

const TTL = 24 * 60 * 60_000;
const MAX_ACTIONS = 500;
const MAX_CARD_BYTES = 8 * 1024 * 1024;
const PREFIX = 'wc_';

export function workerContextControl(id: string): any {
  return { tag: 'column_set', element_id: `${PREFIX}${createHash('sha256').update(id).digest('hex').slice(0, 16)}`, flex_mode: 'none', columns: [
    { tag: 'column', width: 'weighted', weight: 1, elements: [
      { tag: 'button', text: { tag: 'plain_text', content: 'Clear context' }, type: 'default',
        behaviors: [{ type: 'callback', value: { action: 'worker_context_clear', id } }] },
    ] },
  ] };
}

/** Ephemeral controls, bound to actual delivered cards; native reset epochs persist on the CLI. */
export class WorkerContextCards {
  private readonly actions = new Map<string, Action>();
  private readonly cards = new Map<string, { rootId: string; content: string; ids: Set<string>; bytes: number; createdAt: number }>();
  private cardBytes = 0;

  constructor(private readonly transport: Transport) {}

  register(target: WorkerContextTarget): string | undefined {
    this.prune();
    if (!this.transport.available(target.deviceId)) return;
    if (this.actions.size >= MAX_ACTIONS) {
      const oldest = [...this.actions].find(([, action]) => action.status !== 'pending');
      if (!oldest) return;
      clearTimeout(oldest[1].timer);
      this.actions.delete(oldest[0]);
    }
    const id = randomUUID();
    this.actions.set(id, { ...target, status: 'idle', createdAt: Date.now() });
    return id;
  }

  private visit(value: any, callback: (node: any, id: string) => void): void {
    if (!value || typeof value !== 'object') return;
    if (typeof value.element_id === 'string' && value.element_id.startsWith(PREFIX)) {
      const action = value.columns?.[0]?.elements?.[0]?.behaviors?.[0]?.value;
      if (action?.action === 'worker_context_clear' && typeof action.id === 'string') callback(value, action.id);
      return;
    }
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) for (const node of child) this.visit(node, callback);
      else if (child && typeof child === 'object') this.visit(child, callback);
    }
  }

  decorate(content: string): string {
    if (!content.includes(PREFIX)) return content;
    const card = JSON.parse(content);
    this.visit(card, (node, id) => {
      const action = this.actions.get(id);
      const replacement = workerContextControl(id);
      const elements = replacement.columns[0].elements;
      const button = elements[0];
      const status = action?.status;
      button.text.content = !action ? 'Context control expired' : status === 'pending' ? 'Clearing context...'
        : status === 'cleared' ? 'Context cleared' : status === 'failed' ? 'Retry clear context' : 'Clear context';
      button.disabled = !action || status === 'pending' || status === 'cleared';
      if (action?.error) elements.push({ tag: 'markdown', text_size: 'notation', content: action.error });
      Object.assign(node, replacement);
    });
    return JSON.stringify(card);
  }

  remember(cardId: string, rootId: string, content: string): void {
    this.prune();
    this.forgetCard(cardId);
    if (!content.includes(PREFIX)) return;
    const ids = new Set<string>();
    this.visit(JSON.parse(content), (_node, id) => { if (this.actions.has(id)) ids.add(id); });
    const bytes = Buffer.byteLength(content);
    if (!ids.size || bytes > MAX_CARD_BYTES) return;
    this.cards.set(cardId, { rootId, content, ids, bytes, createdAt: Date.now() });
    this.cardBytes += bytes;
    while (this.cardBytes > MAX_CARD_BYTES || this.cards.size > MAX_ACTIONS) this.forgetCard(this.cards.keys().next().value!);
  }

  rootFor(cardId: string): string | undefined { return this.cards.get(cardId)?.rootId; }

  contentFor(cardId: string): string | undefined {
    this.prune();
    const card = this.cards.get(cardId);
    return card ? this.decorate(card.content) : undefined;
  }

  async click(openId: string, id: string, cardId: string): Promise<string> {
    this.prune();
    const action = this.actions.get(id);
    if (!action || !this.cards.get(cardId)?.ids.has(id)) throw new Error('This Worker control has expired. Use a newer Worker card.');
    if (action.openId !== openId || !(await this.transport.ownsDevice(openId, action.deviceId))) throw new Error('This Worker belongs to another user.');
    if (action.status === 'cleared') {
      void this.refresh(id);
      return 'Context already cleared. The next delegation starts fresh.';
    }
    if (action.status === 'pending') return 'Clearing context. Waiting for the CLI.';
    if (!this.transport.available(action.deviceId)) throw new Error('The original CLI is offline or does not support context clearing. Reconnect it first.');
    const requestId = randomUUID();
    action.status = 'pending'; action.error = undefined; action.requestId = requestId;
    action.timer = setTimeout(() => {
      if (action.requestId !== requestId || action.status !== 'pending') return;
      action.status = 'failed'; action.error = 'CLI confirmation timed out. Retry when the device is connected.';
      void this.refresh(id);
    }, 15_000);
    action.timer.unref?.();
    // Do not hold a Feishu callback open while patching cards.
    void this.refresh(id);
    try {
      if (!await this.transport.send(action.deviceId, { type: 'worker_context_reset', messageId: requestId,
        threadId: action.threadId, laneId: action.laneId, generation: action.generation, timestamp: Date.now() })) {
        throw new Error('offline');
      }
    } catch {
      if (action.status === 'pending') {
        clearTimeout(action.timer); action.status = 'failed';
        action.error = 'Could not contact the original CLI. Reconnect it and retry.';
        void this.refresh(id);
      }
      throw new Error('Could not contact the original CLI. Reconnect it and retry.');
    }
    return 'Clearing Worker context. Files and results will be kept.';
  }

  async resolve(deviceId: string, message: any): Promise<void> {
    if (typeof message?.messageId !== 'string' || typeof message.success !== 'boolean') return;
    for (const [id, action] of this.actions) {
      if (action.deviceId !== deviceId || action.requestId !== message.messageId || action.status === 'cleared') continue;
      clearTimeout(action.timer);
      action.status = message.success ? 'cleared' : 'failed';
      // Only display known protocol errors; arbitrary peer text must not become card Markdown.
      const errors = [
        'This Worker card has expired. Use the latest Worker card.',
        'The Worker context has changed. Use the latest Worker card.',
        'The Worker is active or its shutdown is unconfirmed. Wait before clearing context.',
      ];
      action.error = message.success ? undefined : errors.includes(message.error) ? message.error
        : 'Could not clear Worker context. Check the local CLI and retry.';
      await this.refresh(id);
    }
  }

  private async refresh(id: string): Promise<void> {
    await Promise.all([...this.cards].filter(([, card]) => card.ids.has(id)).map(async ([cardId, card]) => {
      try { await this.transport.refresh(cardId, card.rootId); } catch { /* Retry decoration on the next card update or click. */ }
    }));
  }

  private forgetCard(id: string): void {
    const card = this.cards.get(id);
    if (card) this.cardBytes -= card.bytes;
    this.cards.delete(id);
  }

  private prune(): void {
    const cutoff = Date.now() - TTL;
    for (const [id, action] of this.actions) if (action.createdAt < cutoff) {
      clearTimeout(action.timer); this.actions.delete(id);
    }
    for (const [id, card] of this.cards) if (card.createdAt < cutoff) this.forgetCard(id);
  }

  destroy(): void {
    for (const action of this.actions.values()) clearTimeout(action.timer);
    this.actions.clear(); this.cards.clear(); this.cardBytes = 0;
  }
}
