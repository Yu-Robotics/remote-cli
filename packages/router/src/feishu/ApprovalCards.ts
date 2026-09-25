import type { ApprovalAction, ApprovalRequestMessage, ApprovalResolvedMessage, ApprovalStatus } from '../types';

interface CardState {
  request: ApprovalRequestMessage;
  deviceId: string;
  cardId?: string;
  ready?: Promise<void>;
  status: ApprovalStatus | 'pending' | 'disconnected';
  error?: string;
  submitting?: boolean;
  timer?: NodeJS.Timeout;
  updating?: Promise<void>;
}

interface ApprovalCardTransport {
  ownsDevice(openId: string, deviceId: string): Promise<boolean>;
  sendToDevice(deviceId: string, message: object): Promise<boolean>;
  create(openId: string, elements: any[], header?: Record<string, unknown>): Promise<string | null>;
  update(cardId: string, elements: any[], header?: Record<string, unknown>): Promise<void>;
  registerReplyRoute(cardId: string, threadId: string, deviceId: string): void;
}

/** A button answers one original request, independent of the user's active thread/device. */
export class ApprovalCards {
  private readonly pending = new Map<string, CardState>();
  private readonly finished = new Map<string, number>();

  constructor(private readonly transport: ApprovalCardTransport) {}

  async receive(request: ApprovalRequestMessage, deviceId: string, current: () => boolean): Promise<void> {
    if (!request || typeof request.messageId !== 'string' || typeof request.openId !== 'string'
      || !(await this.transport.ownsDevice(request.openId, deviceId)) || !current()) return;
    if (!this.validRequest(request)) {
      await this.unavailable(deviceId, request.messageId);
      return;
    }
    this.prune();
    const key = `${deviceId}:${request.messageId}`;
    if (this.finished.has(key) || this.pending.has(key)) return;
    if (this.pending.size >= 500) {
      await this.unavailable(deviceId, request.messageId);
      return;
    }
    const entry: CardState = { request, deviceId, status: 'pending' };
    this.pending.set(key, entry);
    entry.ready = (async () => {
      try {
        entry.cardId = await this.transport.create(request.openId, this.elements(entry), this.header(entry)) ?? undefined;
        if (entry.cardId) this.transport.registerReplyRoute(entry.cardId, request.threadId, deviceId);
      } catch { /* Fall back to the existing text approval flow. */ }
      if (!entry.cardId) {
        if (this.pending.get(key) === entry) this.pending.delete(key);
        if (entry.status === 'pending' && current()) await this.unavailable(deviceId, request.messageId);
      }
    })();
    await entry.ready;
    if (entry.status !== 'pending') await this.refresh(entry);
  }

  async resolve(message: ApprovalResolvedMessage, deviceId: string): Promise<void> {
    if (typeof message.messageId !== 'string' || message.messageId.length > 4096
      || !['pending', 'approved', 'denied', 'remembered', 'expired'].includes(message.status)) return;
    const key = `${deviceId}:${message.messageId}`;
    const entry = this.pending.get(key);
    if (!entry) {
      // A completion can overtake asynchronous binding lookup/card creation.
      // Keep bounded tombstones so a late request cannot recreate an active card.
      if (message.status !== 'pending') {
        this.finished.set(key, Date.now());
        this.prune();
      }
      return;
    }
    if (entry.request.openId !== message.openId || entry.request.threadId !== message.threadId) return;
    entry.status = message.status;
    entry.error = typeof message.error === 'string' ? message.error.slice(0, 500) : undefined;
    entry.submitting = false;
    clearTimeout(entry.timer);
    if (message.status !== 'pending') {
      this.pending.delete(key);
      this.finished.set(key, Date.now());
      this.prune();
    }
    await this.refresh(entry);
  }

  async click(openId: string, requestId: string, cardId: string, action: ApprovalAction): Promise<string> {
    const entry = [...this.pending.values()].find(state => state.request.messageId === requestId && state.cardId === cardId);
    if (!entry || entry.request.openId !== openId) throw new Error('This approval is expired or does not belong to you.');
    if (!['approve', 'deny', 'remember'].includes(action) || (action === 'remember' && !entry.request.approval.canRemember)) {
      throw new Error('This approval does not support that action.');
    }
    const key = `${entry.deviceId}:${requestId}`;
    if (!(await this.transport.ownsDevice(openId, entry.deviceId)) || this.pending.get(key) !== entry) {
      throw new Error('This approval is no longer available.');
    }
    if (entry.submitting) return 'Approval already sent. Waiting for CLI confirmation.';
    entry.submitting = true;
    entry.error = undefined;
    // An acknowledgement is authoritative. A send or a button click alone is not approval.
    entry.timer = setTimeout(() => {
      if (this.pending.get(key) !== entry) return;
      entry.submitting = false;
      entry.error = 'No CLI confirmation received. Retry or check the device connection.';
      void this.refresh(entry);
    }, 30000);
    entry.timer.unref?.();
    let sent = false;
    try {
      sent = await this.transport.sendToDevice(entry.deviceId, { type: 'approval_response', messageId: requestId,
        taskMessageId: entry.request.taskMessageId, openId, threadId: entry.request.threadId, action, timestamp: Date.now() });
    } catch { /* Retain the request so the user can retry. */ }
    if (!sent) {
      clearTimeout(entry.timer);
      entry.submitting = false;
      throw new Error('The original CLI device is offline. Reconnect it before approving.');
    }
    void this.refresh(entry);
    return 'Approval sent. Waiting for CLI confirmation.';
  }

  disconnect(deviceId: string): void {
    for (const [key, entry] of this.pending) {
      if (entry.deviceId !== deviceId) continue;
      this.pending.delete(key);
      clearTimeout(entry.timer);
      entry.status = 'disconnected';
      void this.refresh(entry);
    }
  }

  destroy(): void {
    for (const deviceId of new Set([...this.pending.values()].map(entry => entry.deviceId))) this.disconnect(deviceId);
    this.finished.clear();
  }

  private async unavailable(deviceId: string, messageId: string): Promise<void> {
    await this.transport.sendToDevice(deviceId, { type: 'approval_unavailable', messageId, timestamp: Date.now() });
  }

  private async refresh(entry: CardState): Promise<void> {
    const previous = entry.updating;
    entry.updating = (async () => {
      await entry.ready;
      await previous;
      if (entry.cardId) await this.transport.update(entry.cardId, this.elements(entry), this.header(entry));
    })().catch(error => console.error('[ApprovalCards] Failed to update approval card:', error instanceof Error ? error.message : error));
    await entry.updating;
  }

  private header(entry: CardState): Record<string, unknown> {
    const { status } = entry;
    const [template, title]: [string, string] = status === 'pending'
      ? (entry.submitting ? ['blue', '⏳ Waiting for CLI confirmation'] : ['blue', '🔐 Permission request'])
      : ({
        approved: ['green', '✅ Approved'],
        remembered: ['green', '✅ Approved and directory access remembered'],
        denied: ['red', '❌ Denied'],
        expired: ['orange', '⏰ Approval expired'],
        disconnected: ['grey', '🔌 Device disconnected'],
      } as Record<string, [string, string]>)[status] ?? ['grey', '🔐 Permission request'];
    return { template, title: { tag: 'plain_text', content: title } };
  }

  private elements(entry: CardState): any[] {
    const { request, status } = entry;
    const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_{}\[\]()!|#]/g, '\\$&');
    const [kindIcon, kindLabel] = ({ command: ['💻', 'Command'], file: ['📝', 'File'],
      permissions: ['🔑', 'Permissions'] } as Record<string, [string, string]>)[request.approval.kind] ?? ['🔐', 'Request'];
    const description = request.approval.description;
    // Fenced code blocks keep commands readable; fall back to escaped text when
    // the description itself contains a fence.
    const descriptionBlock = description.includes('```') ? escape(description) : '```\n' + description + '\n```';
    const elements: any[] = [
      { tag: 'markdown', content: `🧵 **${escape(request.threadName)}**  ·  📂 \`${escape(request.cwd)}\`` },
      { tag: 'hr' },
      { tag: 'markdown', content: `${kindIcon} **${kindLabel}**\n${descriptionBlock}` },
    ];
    if (request.approval.canRemember) elements.push({ tag: 'markdown', content:
      `🧠 *Always allow* also grants this thread write access to:\n${request.approval.writableRoots!.map(root => `- \`${escape(root)}\``).join('\n')}` });
    if (request.approval.kind === 'permissions') elements.push({ tag: 'markdown', content: '*Allow grants the displayed permissions for the current turn.*' });
    if (request.approval.kind !== 'permissions') elements.push({ tag: 'markdown', content: '*Approving this action may allow execution outside the sandbox.*' });
    if (status === 'disconnected') elements.push({ tag: 'markdown', content: '*A pending request will get a new card after reconnecting.*' });
    if (entry.error) elements.push({ tag: 'markdown', content: `⚠️ ${escape(entry.error)}` });
    if (status === 'pending' && !entry.submitting) {
      const buttons: any[] = [
        { tag: 'button', type: 'primary', text: { tag: 'plain_text', content: 'Allow once' },
          behaviors: [{ type: 'callback', value: { action: 'approval_reply', requestId: request.messageId, decision: 'approve' } }] },
        { tag: 'button', type: 'default', text: { tag: 'plain_text', content: 'Deny' },
          behaviors: [{ type: 'callback', value: { action: 'approval_reply', requestId: request.messageId, decision: 'deny' } }] },
      ];
      if (request.approval.canRemember) buttons.push({ tag: 'button', type: 'default',
        text: { tag: 'plain_text', content: 'Always allow' },
        behaviors: [{ type: 'callback', value: { action: 'approval_reply', requestId: request.messageId, decision: 'remember' } }] });
      elements.push({ tag: 'button_group', buttons });
    }
    return elements;
  }

  private validRequest(request: ApprovalRequestMessage): boolean {
    const approval = request?.approval;
    return !!request && [request.messageId, request.taskMessageId, request.openId, request.threadId, request.threadName, request.cwd]
      .every(value => typeof value === 'string' && value.length > 0 && value.length <= 4096)
      && !!approval && approval.requestId === request.messageId && ['command', 'file', 'permissions'].includes(approval.kind)
      && typeof approval.description === 'string' && approval.description.length <= 16000
      && typeof approval.canRemember === 'boolean' && (!approval.canRemember || (Array.isArray(approval.writableRoots)
        && approval.writableRoots.length > 0 && approval.writableRoots.length <= 50
        && approval.writableRoots.every(root => typeof root === 'string' && root.length > 0 && root.length <= 4096)));
  }

  private prune(): void {
    for (const [key, time] of this.finished) {
      if (time < Date.now() - 60 * 60 * 1000 || this.finished.size > 1000) this.finished.delete(key);
    }
  }
}
