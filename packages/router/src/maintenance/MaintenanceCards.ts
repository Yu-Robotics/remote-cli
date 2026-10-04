import { randomUUID } from 'crypto';
import { NoticeReceipts, type NoticeReceipt } from './NoticeReceipts';
import { createMarkdownElement, type FeishuCardElement } from '../utils/ToolFormatter';

interface Section { version: string; text: string }
interface Page { coverage: 'complete' | 'partial' | 'unavailable'; sections: Section[]; offset: number; nextOffset?: number; totalSections: number }
interface Notice { noticeKey: string; fromVersion: string; toVersion: string; page: Page }
// Add copy only when that backend's inspection semantics are supported.
const REMINDER_COPY = {
  codex: {
    title: '🎯 Codex Reset',
    summary: '**Weekly quota reset: 100%**\n\nBackend: Codex CLI',
    explanation: 'Without new Codex usage, the reset countdown may keep moving forward. Send Codex a normal task to start the next usage window.',
  },
} as const;
type ReminderBackend = keyof typeof REMINDER_COPY;
// The false legacy field preserves compatibility; quota notices never support activation.
interface Reminder { reminderId: string; generation: string; expiresAt: number; activationAvailable: false; backend?: ReminderBackend }
interface ReminderCard extends Reminder { deviceId: string; openId: string; cardId: string; current: () => boolean; dismissed: boolean }
export interface MaintenanceCardDependencies {
  owner: (deviceId: string) => Promise<string | undefined>;
  send: (deviceId: string, message: object) => Promise<boolean>;
  create: (openId: string, elements: FeishuCardElement[], header: Record<string, unknown>) => Promise<string | null>;
  update: (cardId: string, elements: FeishuCardElement[], header: Record<string, unknown>) => Promise<void>;
  now?: () => number;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
function version(value: unknown): value is string { return typeof value === 'string' && value.length <= 100 && VERSION.test(value); }
function validPage(value: any): value is Page {
  return value && ['complete', 'partial', 'unavailable'].includes(value.coverage) && Number.isSafeInteger(value.offset) && value.offset >= 0
    && Number.isSafeInteger(value.totalSections) && value.totalSections >= value.offset && value.totalSections <= 10000
    && Array.isArray(value.sections) && value.sections.length <= 10 && value.offset + value.sections.length <= value.totalSections
    && value.sections.every((s: any) => version(s?.version) && typeof s.text === 'string')
    && (value.nextOffset === undefined || value.sections.length > 0 && value.nextOffset === value.offset + value.sections.length && value.nextOffset < value.totalSections)
    && Buffer.byteLength(JSON.stringify(value)) <= 20 * 1024;
}
function validNotice(value: any): value is Notice {
  return UUID.test(value?.noticeKey) && version(value.fromVersion) && version(value.toVersion) && validPage(value.page);
}
function header(title: string, template = 'blue'): Record<string, unknown> { return { title: { tag: 'plain_text', content: title }, template }; }
function button(text: string, action: object, type = 'default'): FeishuCardElement {
  return { tag: 'button', text: { tag: 'plain_text', content: text }, type, behaviors: [{ type: 'callback', value: action }] };
}

export function updateNoticeElements(notice: Notice, id: string): FeishuCardElement[] {
  const page = notice.page;
  const coverage = page.coverage === 'complete' ? 'Bundled release notes' : page.coverage === 'partial'
    ? 'Some release notes are missing from this package.' : 'Release notes are unavailable in this package.';
  const elements: FeishuCardElement[] = [{ tag: 'markdown', content: `**${notice.fromVersion} → ${notice.toVersion}**\n\n${coverage}` }];
  for (const section of page.sections) elements.push({ tag: 'collapsible_panel', expanded: false,
    header: { title: { tag: 'plain_text', content: `Version ${section.version}` } },
    elements: [createMarkdownElement(section.text)] });
  if (page.totalSections) elements.push({ tag: 'markdown', text_size: 'notation',
    content: `Showing ${page.offset + 1}–${page.offset + page.sections.length} of ${page.totalSections} releases. Display paging does not change history coverage.` });
  if (page.nextOffset !== undefined) elements.push(button('View more', { action: 'maintenance_view', id, offset: page.nextOffset }));
  if (page.offset > 0) elements.push(button('Back to overview', { action: 'maintenance_view', id, offset: 0 }));
  return elements;
}

function reminderHeader(reminder: Reminder, dismissed = false): Record<string, unknown> {
  return header(REMINDER_COPY[reminder.backend ?? 'codex'].title, dismissed ? 'grey' : 'blue');
}
function reminderElements(reminder: Reminder, dismissed = false): FeishuCardElement[] {
  const copy = REMINDER_COPY[reminder.backend ?? 'codex'];
  return [{ tag: 'markdown', content: `${copy.summary}\n\n${copy.explanation}` },
    ...(dismissed ? [{ tag: 'markdown', content: 'Dismissed.' }] : [])];
}

/** Standalone maintenance cards never enter thread/output routing maps. */
export class MaintenanceCards {
  private readonly now: () => number;
  private readonly flights = new Map<string, Promise<void>>();
  private readonly deliveredWithoutReceipt = new Map<string, NoticeReceipt>();
  private readonly reminders = new Map<string, ReminderCard>();
  private readonly pageRequests = new Map<string, { record: NoticeReceipt; offset: number; current: () => boolean; expiresAt: number }>();
  constructor(private readonly receipts: NoticeReceipts, private readonly deps: MaintenanceCardDependencies) { this.now = deps.now ?? Date.now; }

  async receiveNotice(message: any, deviceId: string, current: () => boolean): Promise<void> {
    if (!validNotice(message) || message.page.offset !== 0) return;
    const key = JSON.stringify([deviceId, message.noticeKey]);
    const existing = this.flights.get(key);
    if (existing) { await existing; if (current()) await this.acknowledge(message, deviceId); return; }
    const operation = (async () => {
      const openId = await this.deps.owner(deviceId);
      if (!openId || !current()) return;
      let receipt = this.deliveredWithoutReceipt.get(key) ?? await this.receipts.find(deviceId, message.noticeKey);
      if (receipt && (receipt.openId !== openId || receipt.fromVersion !== message.fromVersion || receipt.toVersion !== message.toVersion)) return;
      if (!receipt) {
        const id = randomUUID();
        const cardId = await this.deps.create(openId, updateNoticeElements(message, id), header('📦 Remote CLI updated'));
        if (!cardId) return;
        receipt = { id, deviceId, openId, noticeKey: message.noticeKey, fromVersion: message.fromVersion, toVersion: message.toVersion, cardId, deliveredAt: this.now() };
        this.deliveredWithoutReceipt.set(key, receipt);
      }
      // A Feishu-success / storage-write crash gap cannot be made exactly once here.
      await this.receipts.remember(receipt);
      this.deliveredWithoutReceipt.delete(key);
      if (current() && await this.deps.owner(deviceId) === openId) await this.acknowledge(message, deviceId);
    })();
    this.flights.set(key, operation);
    try { await operation; } finally { if (this.flights.get(key) === operation) this.flights.delete(key); }
  }

  private async acknowledge(message: Notice, deviceId: string): Promise<void> {
    const receipt = await this.receipts.find(deviceId, message.noticeKey);
    if (!receipt || receipt.fromVersion !== message.fromVersion || receipt.toVersion !== message.toVersion
      || await this.deps.owner(deviceId) !== receipt.openId) return;
    await this.deps.send(deviceId, { type: 'update_notice_ack', noticeKey: message.noticeKey, fromVersion: message.fromVersion, toVersion: message.toVersion });
  }

  async view(openId: string, id: string, cardId: string, offset: number, connection: (deviceId: string) => (() => boolean) | undefined): Promise<string> {
    this.prune();
    const record = await this.receipts.findCard(id, cardId);
    if (!record || record.openId !== openId || await this.deps.owner(record.deviceId) !== openId) throw new Error('This update notice is no longer available.');
    const current = connection(record.deviceId);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000 || !current?.()) throw new Error('Reconnect a compatible CLI to view more release notes.');
    if ([...this.pageRequests.values()].some(p => p.record.id === id)) return 'Release notes are already loading.';
    const requestId = randomUUID();
    this.pageRequests.set(requestId, { record, offset, current, expiresAt: this.now() + 30_000 });
    if (!await this.deps.send(record.deviceId, { type: 'update_notice_view', requestId, noticeKey: record.noticeKey,
      fromVersion: record.fromVersion, toVersion: record.toVersion, offset })) { this.pageRequests.delete(requestId); throw new Error('This CLI is offline.'); }
    return 'Loading bundled release notes...';
  }

  async receivePage(message: any, deviceId: string): Promise<void> {
    this.prune();
    const requestId = message?.requestId;
    const pending = this.pageRequests.get(requestId);
    if (!pending || !validNotice(message) || pending.record.deviceId !== deviceId || message.noticeKey !== pending.record.noticeKey
      || message.fromVersion !== pending.record.fromVersion || message.toVersion !== pending.record.toVersion || message.page.offset !== pending.offset) return;
    this.pageRequests.delete(requestId);
    if (!pending.current() || await this.deps.owner(deviceId) !== pending.record.openId) return;
    await this.deps.update(pending.record.cardId, updateNoticeElements(message, pending.record.id), header('📦 Remote CLI updated'));
  }

  async receiveReminder(message: any, deviceId: string, current: () => boolean): Promise<void> {
    this.prune();
    const r = message?.reminder;
    if (!r || !UUID.test(r.reminderId) || !UUID.test(r.generation) || r.activationAvailable !== false || !Number.isFinite(r.expiresAt)
      || (r.backend !== undefined && (typeof r.backend !== 'string' || !Object.prototype.hasOwnProperty.call(REMINDER_COPY, r.backend)))
      || r.expiresAt <= this.now() || r.expiresAt > this.now() + 2 * 3600_000) return;
    const key = JSON.stringify([deviceId, r.reminderId]);
    const existing = this.flights.get(key);
    if (existing) { await existing; return; }
    const operation = (async () => {
      const openId = await this.deps.owner(deviceId);
      if (!openId || !current()) return;
      let record = this.reminders.get(key);
      if (record && (record.openId !== openId || record.generation !== r.generation)) return;
      if (!record) {
        const cardId = await this.deps.create(openId, reminderElements(r), reminderHeader(r));
        if (!cardId || !current()) return;
        record = { ...r, deviceId, openId, cardId, current, dismissed: false };
        this.reminders.set(key, record!);
      }
      if (await this.deps.owner(deviceId) === openId && current()) await this.deps.send(deviceId, {
        type: 'subscription_reminder_ack', reminderId: r.reminderId, generation: r.generation,
      });
    })();
    this.flights.set(key, operation);
    try { await operation; } finally { this.flights.delete(key); }
  }

  async reply(openId: string, id: string, cardId: string, decision: string): Promise<string> {
    this.prune();
    const record = [...this.reminders.values()].find(r => r.reminderId === id && r.cardId === cardId);
    if (!record || record.openId !== openId || await this.deps.owner(record.deviceId) !== openId || !record.current()) throw new Error('This reminder expired or its CLI reconnected.');
    if (decision === 'send_hi') throw new Error('Quota notices are notification-only. Model requests are not supported.');
    if (decision !== 'not_now' && decision !== 'dismiss') throw new Error('Invalid maintenance action.');
    if (record.dismissed) return 'This reminder was already dismissed.';
    // Accept the former passive action from existing cards, without offering it on new cards.
    if (decision === 'not_now') return 'This notice will not be repeated. No model request was sent.';
    record.dismissed = true;
    await this.deps.send(record.deviceId, { type: 'subscription_action', reminderId: id, generation: record.generation, decision: 'dismiss' });
    await this.deps.update(cardId, reminderElements(record, true), reminderHeader(record, true));
    return 'Dismissed. No model request was sent.';
  }

  disconnect(deviceId: string): void {
    for (const [key, r] of this.reminders) if (r.deviceId === deviceId) this.reminders.delete(key);
    for (const [key, r] of this.pageRequests) if (r.record.deviceId === deviceId) this.pageRequests.delete(key);
  }
  destroy(): void { this.reminders.clear(); this.pageRequests.clear(); }
  private prune(): void {
    for (const [key, r] of this.reminders) if (r.expiresAt <= this.now()) this.reminders.delete(key);
    for (const [key, r] of this.pageRequests) if (r.expiresAt <= this.now()) this.pageRequests.delete(key);
  }
}
