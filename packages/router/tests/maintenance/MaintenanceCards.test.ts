import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { MaintenanceCards, updateNoticeElements } from '../../src/maintenance/MaintenanceCards';
import { NoticeReceipts } from '../../src/maintenance/NoticeReceipts';
import { BankedResetReminders } from '../../../cli/src/maintenance/BankedResetReminders';
import { codexQuotaObservation } from '../../../cli/src/maintenance/CodexQuota';

const key = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const generation = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const notice = () => ({ type: 'update_notice', noticeKey: key, fromVersion: '1.6.122', toVersion: '1.6.125', page: {
  coverage: 'complete', sections: [{ version: '1.6.125', text: '### Added\n- A feature' }], offset: 0, nextOffset: 1, totalSections: 2,
} });

describe('standalone maintenance cards', () => {
  let directory: string;
  let receipts: NoticeReceipts;
  let cards: MaintenanceCards;
  let deps: any;
  let now: number;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'maintenance-cards-test-')); now = 1800000000000;
    receipts = new NoticeReceipts(path.join(directory, 'receipts.json'), () => now);
    deps = { owner: vi.fn().mockResolvedValue('owner-fixture'), send: vi.fn().mockResolvedValue(true),
      create: vi.fn().mockResolvedValue('card-fixture'), update: vi.fn().mockResolvedValue(undefined), now: () => now };
    cards = new MaintenanceCards(receipts, deps);
  });
  afterEach(async () => { cards.destroy(); await fs.rm(directory, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('resolves the original device owner and ACKs only after delivery and a durable receipt', async () => {
    await cards.receiveNotice({ ...notice(), openId: 'untrusted-payload-owner' }, 'device-fixture', () => true);
    expect(deps.create).toHaveBeenCalledWith('owner-fixture', expect.any(Array), expect.any(Object));
    expect(deps.send).toHaveBeenCalledWith('device-fixture', expect.objectContaining({ type: 'update_notice_ack', fromVersion: '1.6.122', toVersion: '1.6.125' }));
    expect(await receipts.find('device-fixture', key)).toMatchObject({ cardId: 'card-fixture' });
    const restarted = new MaintenanceCards(new NoticeReceipts(path.join(directory, 'receipts.json'), () => now), deps);
    await restarted.receiveNotice(notice(), 'device-fixture', () => true);
    expect(deps.create).toHaveBeenCalledTimes(1); expect(deps.send).toHaveBeenCalledTimes(2);
  });
  it('serializes duplicate delivery and preserves a successful card when the receipt write fails', async () => {
    const remember = vi.spyOn(receipts, 'remember').mockRejectedValueOnce(new Error('disk failure'));
    await expect(cards.receiveNotice(notice(), 'device-fixture', () => true)).rejects.toThrow('disk failure');
    expect(deps.send).not.toHaveBeenCalled();
    await Promise.all([cards.receiveNotice(notice(), 'device-fixture', () => true), cards.receiveNotice(notice(), 'device-fixture', () => true)]);
    expect(remember).toHaveBeenCalledTimes(2); expect(deps.create).toHaveBeenCalledTimes(1);
    expect(deps.send).toHaveBeenCalledTimes(2);
  });
  it('withholds ACK on failed card delivery, unknown owner, stale connections and ownership changes', async () => {
    deps.create.mockResolvedValueOnce(null); await cards.receiveNotice(notice(), 'device-fixture', () => true);
    expect(deps.send).not.toHaveBeenCalled();
    deps.owner.mockResolvedValueOnce(undefined); await cards.receiveNotice(notice(), 'device-fixture', () => true);
    await cards.receiveNotice(notice(), 'device-fixture', () => false); expect(deps.create).toHaveBeenCalledTimes(1);
    let current = true;
    deps.create.mockImplementationOnce(async () => { current = false; return 'card-fixture'; });
    await cards.receiveNotice(notice(), 'device-fixture', () => current); expect(deps.send).not.toHaveBeenCalled();
    deps.owner.mockResolvedValue('another-owner'); await cards.receiveNotice(notice(), 'device-fixture', () => true);
    expect(deps.send).not.toHaveBeenCalled();
  });
  it('pages the same immutable range only for the original user/card/device and an outstanding request', async () => {
    await cards.receiveNotice(notice(), 'device-fixture', () => true);
    const receipt = (await receipts.find('device-fixture', key))!;
    await expect(cards.view('foreign-owner', receipt.id, receipt.cardId, 1, () => () => true)).rejects.toThrow();
    await expect(cards.view('owner-fixture', receipt.id, 'foreign-card', 1, () => () => true)).rejects.toThrow();
    await expect(cards.view('owner-fixture', receipt.id, receipt.cardId, 1, () => undefined)).rejects.toThrow();
    expect(await cards.view('owner-fixture', receipt.id, receipt.cardId, 1, () => () => true)).toContain('Loading');
    const request = deps.send.mock.calls.at(-1)[1];
    expect(request).toMatchObject({ type: 'update_notice_view', fromVersion: '1.6.122', toVersion: '1.6.125', offset: 1 });
    expect(await cards.view('owner-fixture', receipt.id, receipt.cardId, 1, () => () => true)).toContain('already');
    const response = { ...notice(), type: 'update_notice_page', requestId: request.requestId, page: { coverage: 'complete', sections: [{ version: '1.6.123', text: '- Earlier' }], offset: 1, totalSections: 2 } };
    await cards.receivePage({ ...response, toVersion: '1.6.126' }, 'device-fixture'); expect(deps.update).not.toHaveBeenCalled();
    await cards.receivePage(response, 'foreign-device'); expect(deps.update).not.toHaveBeenCalled();
    await cards.receivePage(response, 'device-fixture'); expect(deps.update).toHaveBeenCalledTimes(1);
    await cards.receivePage(response, 'device-fixture'); expect(deps.update).toHaveBeenCalledTimes(1);
  });
  it('rejects expired or disconnected paging and foreign/oversized/malformed payloads', async () => {
    await cards.receiveNotice({ ...notice(), noticeKey: 'invalid' }, 'device-fixture', () => true);
    await cards.receiveNotice({ ...notice(), page: { ...notice().page, sections: [{ version: '1.6.125', text: 'x'.repeat(25000) }] } }, 'device-fixture', () => true);
    await cards.receiveNotice({ ...notice(), page: { ...notice().page, offset: 1 } }, 'device-fixture', () => true);
    for (const details of [123, null, { text: '- A feature' }, 'x'.repeat(25000)]) {
      await cards.receiveNotice({ ...notice(), page: { ...notice().page, sections: [{ version: '1.6.125', text: '- Summary', details }] } }, 'device-fixture', () => true);
    }
    expect(deps.create).not.toHaveBeenCalled();
    await cards.receiveNotice(notice(), 'device-fixture', () => true); const record = (await receipts.find('device-fixture', key))!;
    await cards.view('owner-fixture', record.id, record.cardId, 1, () => () => true); const request = deps.send.mock.calls.at(-1)[1];
    now += 31000; await cards.receivePage({ ...notice(), requestId: request.requestId, page: { ...notice().page, offset: 1 } }, 'device-fixture');
    expect(deps.update).not.toHaveBeenCalled();
    cards.disconnect('device-fixture');
    now += 31 * 86400_000; await expect(cards.view('owner-fixture', record.id, record.cardId, 0, () => () => true)).rejects.toThrow();
  });
  it('delivers button-free quota guidance and retains validated legacy dismissal callbacks', async () => {
    const message = { type: 'subscription_reminder', reminder: { reminderId: key, generation, expiresAt: now + 3600000, activationAvailable: false } };
    await Promise.all([cards.receiveReminder(message, 'device-fixture', () => true), cards.receiveReminder(message, 'device-fixture', () => true)]);
    expect(deps.create).toHaveBeenCalledTimes(1);
    expect(deps.create.mock.calls[0][2]).toMatchObject({
      title: { content: '🎯 Codex Reset' }, template: 'blue',
    });
    const elements = deps.create.mock.calls[0][1];
    const markdown = elements.filter((element: any) => element.tag === 'markdown');
    const text = markdown.map((element: any) => element.content).join('\n');
    expect(text).toContain('Weekly quota reset: 100%');
    expect(markdown).toHaveLength(1);
    expect(text).toContain('Without new Codex usage, the reset countdown may keep moving forward. Send Codex a normal task to start the next usage window.');
    expect(text).not.toMatch(/activation|Send Hi|Proposed prompt|local Codex CLI|No action is required|\/status|\bverify\b/i);
    expect(elements.some((element: any) => element.tag === 'button')).toBe(false);
    expect(deps.send).toHaveBeenCalledWith('device-fixture', expect.objectContaining({ type: 'subscription_reminder_ack', reminderId: key, generation }));
    await expect(cards.reply('foreign-owner', key, 'card-fixture', 'send_hi')).rejects.toThrow();
    await expect(cards.reply('owner-fixture', key, 'foreign-card', 'send_hi')).rejects.toThrow();
    await expect(cards.reply('owner-fixture', key, 'card-fixture', 'send_hi')).rejects.toThrow('notification-only');
    await expect(cards.reply('owner-fixture', key, 'card-fixture', 'unknown')).rejects.toThrow('Invalid');
    deps.send.mockClear();
    await expect(cards.reply('owner-fixture', key, 'card-fixture', 'not_now')).resolves.toBe('This notice will not be repeated. No model request was sent.');
    expect(deps.send).not.toHaveBeenCalled();
    await cards.reply('owner-fixture', key, 'card-fixture', 'dismiss');
    expect(deps.send).toHaveBeenCalledWith('device-fixture', expect.objectContaining({ type: 'subscription_action', decision: 'dismiss' }));
    expect(deps.update.mock.calls[0][1].some((element: any) => element.tag === 'button')).toBe(false);
    expect(deps.update.mock.calls[0][1].filter((element: any) => element.tag === 'markdown')).toHaveLength(2);
    expect(deps.update.mock.calls[0][2]).toMatchObject({ title: deps.create.mock.calls[0][2].title, template: 'grey' });
    const count = deps.send.mock.calls.length; await cards.reply('owner-fixture', key, 'card-fixture', 'dismiss'); expect(deps.send).toHaveBeenCalledTimes(count);
    cards.disconnect('device-fixture'); await expect(cards.reply('owner-fixture', key, 'card-fixture', 'dismiss')).rejects.toThrow();
  });
  it('selects Codex-specific copy for explicit and legacy reminders without reusing it for unsupported backends', async () => {
    const reminder = { reminderId: key, generation, expiresAt: now + 3600000, activationAvailable: false };
    for (const backend of ['claude', 'agy', 'pi', 'opencode', 'kimi', 'zcode', 'dsh', '__proto__', 'constructor', null, {}, ['codex']]) {
      await cards.receiveReminder({ reminder: { ...reminder, backend } }, 'device-fixture', () => true);
    }
    expect(deps.create).not.toHaveBeenCalled(); expect(deps.send).not.toHaveBeenCalled();
    await cards.receiveReminder({ reminder }, 'device-fixture', () => true);
    cards.disconnect('device-fixture');
    await cards.receiveReminder({ reminder: { ...reminder, backend: 'codex' } }, 'device-fixture', () => true);
    expect(deps.create).toHaveBeenCalledTimes(2); expect(deps.send).toHaveBeenCalledTimes(2);
    expect(deps.create.mock.calls[1]).toEqual(deps.create.mock.calls[0]);
    expect(deps.send.mock.calls[1][1]).toMatchObject({ type: 'subscription_reminder_ack', reminderId: key, generation });
  });
  it('rejects expired/unowned/unsafe reminders and does not acknowledge failed delivery', async () => {
    const r = { reminderId: key, generation, expiresAt: now + 3600000, activationAvailable: false };
    for (const reminder of [{ ...r, activationAvailable: true }, { ...r, generation: 'invalid' }, { ...r, expiresAt: now - 1 }]) {
      await cards.receiveReminder({ reminder }, 'device-fixture', () => true);
    }
    expect(deps.create).not.toHaveBeenCalled();
    deps.create.mockResolvedValueOnce(null); await cards.receiveReminder({ reminder: r }, 'device-fixture', () => true); expect(deps.send).not.toHaveBeenCalled();
    await cards.receiveReminder({ reminder: r }, 'device-fixture', () => true);
    now += 3600001; await expect(cards.reply('owner-fixture', key, 'card-fixture', 'dismiss')).rejects.toThrow();
  });
  it('shows an independent button-free banked balance increase and ACKs only successful delivery', async () => {
    const reminder = { reminderId: key, generation, expiresAt: now + 3600000, activationAvailable: false,
      backend: 'codex', kind: 'banked_reset_increase', previousCount: 3, availableCount: 5 };
    deps.create.mockResolvedValueOnce(null); await cards.receiveReminder({ reminder }, 'device-fixture', () => true);
    expect(deps.send).not.toHaveBeenCalled();
    await Promise.all([cards.receiveReminder({ reminder }, 'device-fixture', () => true), cards.receiveReminder({ reminder }, 'device-fixture', () => true)]);
    expect(deps.create).toHaveBeenCalledTimes(2);
    expect(deps.create.mock.calls[1][2]).toMatchObject({ title: { content: '🎁 Codex Banked Reset' } });
    const elements = deps.create.mock.calls[1][1];
    expect(elements).toHaveLength(1); expect(elements[0].content).toContain('3 → 5 (+2)');
    expect(elements[0].content).toContain('Available at the latest check: 5');
    expect(elements[0].content).not.toContain('Weekly quota');
    expect(elements.some((e: any) => e.tag === 'button')).toBe(false);
    expect(deps.send).toHaveBeenCalledWith('device-fixture', { type: 'subscription_reminder_ack', reminderId: key, generation });
    const acknowledged = deps.send.mock.calls.length;
    await cards.receiveReminder({ reminder: { ...reminder, availableCount: 6 } }, 'device-fixture', () => true);
    await cards.receiveReminder({ reminder: { ...reminder, kind: undefined, previousCount: undefined, availableCount: undefined } }, 'device-fixture', () => true);
    expect(deps.create).toHaveBeenCalledTimes(2); expect(deps.send).toHaveBeenCalledTimes(acknowledged);
    await expect(cards.reply('foreign-owner', key, 'card-fixture', 'dismiss')).rejects.toThrow();
    await expect(cards.reply('owner-fixture', key, 'card-fixture', 'send_hi')).rejects.toThrow('notification-only');
    await cards.reply('owner-fixture', key, 'card-fixture', 'dismiss');
    expect(deps.update.mock.calls[0][1][0].content).toContain('3 → 5 (+2)');
  });
  it('rejects non-increases, invalid counts and unknown notice kinds without publication or ACK', async () => {
    const r = { reminderId: key, generation, expiresAt: now + 3600000, activationAvailable: false,
      backend: 'codex', kind: 'banked_reset_increase', previousCount: 2, availableCount: 3 };
    for (const reminder of [{ ...r, previousCount: -1 }, { ...r, previousCount: '2' }, { ...r, previousCount: 1.5 },
      { ...r, availableCount: 2 }, { ...r, availableCount: 1 }, { ...r, availableCount: '3' }, { ...r, availableCount: Number.MAX_SAFE_INTEGER + 1 },
      { ...r, availableCount: null }, { ...r, previousCount: undefined }, { ...r, backend: undefined }, { ...r, kind: 'unknown' },
      { ...r, kind: undefined }]) await cards.receiveReminder({ reminder }, 'device-fixture', () => true);
    expect(deps.create).not.toHaveBeenCalled(); expect(deps.send).not.toHaveBeenCalled();
    await cards.receiveReminder({ reminder: { ...r, previousCount: 0, availableCount: 1 } }, 'device-fixture', () => false);
    expect(deps.create).not.toHaveBeenCalled();
    deps.owner.mockResolvedValueOnce(undefined);
    await cards.receiveReminder({ reminder: r }, 'device-fixture', () => true); expect(deps.create).not.toHaveBeenCalled();
  });
  it('deduplicates a real banked event across a lost ACK and reconnect, then delivers later growth separately', async () => {
    let connected = true, loseAck = true;
    const messages: any[] = [], flights: Promise<void>[] = [];
    const client = new BankedResetReminders(message => {
      messages.push(message); flights.push(cards.receiveReminder(message, 'device-fixture', () => connected));
    }, generation, () => now);
    deps.send.mockImplementation(async (_device: string, message: any) => {
      if (loseAck) return false;
      return client.handle(message);
    });
    try {
      client.registered(true);
      for (const count of [5, 3, 4]) {
        client.observe(codexQuotaObservation({ rateLimitResetCredits: { availableCount: count, credits: null } }, 'account-fixture', 'credential-fixture', now++)!);
      }
      await Promise.all(flights); expect(deps.create).toHaveBeenCalledTimes(1); expect(messages).toHaveLength(1);
      expect(messages[0].reminder).toMatchObject({ previousCount: 3, availableCount: 4 });
      connected = false; client.disconnected(); cards.disconnect('device-fixture');
      await expect(cards.reply('owner-fixture', messages[0].reminder.reminderId, 'card-fixture', 'dismiss')).rejects.toThrow();
      loseAck = false; connected = true; client.registered(true); await Promise.all(flights);
      expect(deps.create).toHaveBeenCalledTimes(1); expect(deps.send).toHaveBeenCalledTimes(2);
      expect(messages[1]).toEqual(messages[0]);
      client.disconnected(); client.registered(true); expect(messages).toHaveLength(2);
      client.observe(codexQuotaObservation({ rateLimitResetCredits: { availableCount: 5 } }, 'account-fixture', 'credential-fixture', now++)!);
      await Promise.all(flights); expect(deps.create).toHaveBeenCalledTimes(2);
      expect(messages[2].reminder.reminderId).not.toBe(messages[0].reminder.reminderId);
    } finally { client.stop(); }
  });
  it('remembers definite banked delivery even if its socket closes during card creation, and revalidates ownership', async () => {
    const reminder = { reminderId: key, generation, expiresAt: now + 3600000, activationAvailable: false,
      backend: 'codex', kind: 'banked_reset_increase', previousCount: 2, availableCount: 3 };
    let connected = true;
    deps.create.mockImplementationOnce(async () => { connected = false; cards.disconnect('device-fixture'); return 'card-fixture'; });
    await cards.receiveReminder({ reminder }, 'device-fixture', () => connected);
    expect(deps.create).toHaveBeenCalledTimes(1); expect(deps.send).not.toHaveBeenCalled();
    connected = true; deps.owner.mockResolvedValue('another-owner-fixture');
    await cards.receiveReminder({ reminder }, 'device-fixture', () => connected);
    expect(deps.create).toHaveBeenCalledTimes(1); expect(deps.send).not.toHaveBeenCalled();
    deps.owner.mockResolvedValue('owner-fixture');
    await cards.receiveReminder({ reminder: { ...reminder, availableCount: 4 } }, 'device-fixture', () => connected);
    expect(deps.send).not.toHaveBeenCalled();
    await cards.receiveReminder({ reminder }, 'device-fixture', () => connected);
    expect(deps.create).toHaveBeenCalledTimes(1); expect(deps.send).toHaveBeenCalledTimes(1);
    await expect(cards.reply('owner-fixture', key, 'card-fixture', 'dismiss')).rejects.toThrow();
    now = reminder.expiresAt; await cards.receiveReminder({ reminder }, 'device-fixture', () => connected);
    expect((cards as any).bankedReceipts.size).toBe(0); expect(deps.send).toHaveBeenCalledTimes(1);
  });
  it('bounds retained banked receipts including in-flight creations without evicting unexpired delivery evidence', async () => {
    const reminder = { reminderId: key, generation, expiresAt: now + 3600000, activationAvailable: false,
      backend: 'codex', kind: 'banked_reset_increase', previousCount: 2, availableCount: 3 };
    const retained = (cards as any).bankedReceipts;
    for (let i = 0; i < 999; i++) retained.set(`fixture-${i}`, { ...reminder, deviceId: 'device-fixture', openId: 'owner-fixture', cardId: `card-${i}` });
    let complete!: (cardId: string) => void;
    deps.create.mockImplementationOnce(() => new Promise<string>(resolve => { complete = resolve; }));
    const first = cards.receiveReminder({ reminder }, 'device-fixture', () => true);
    const second = cards.receiveReminder({ reminder: { ...reminder, reminderId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' } }, 'device-fixture', () => true);
    try { await vi.waitFor(() => expect(deps.create).toHaveBeenCalledTimes(1)); }
    finally { complete('card-fixture'); await Promise.all([first, second]); }
    expect(retained.size).toBe(1000); expect(deps.send).toHaveBeenCalledTimes(1);
    cards.disconnect('device-fixture'); await cards.receiveReminder({ reminder }, 'device-fixture', () => true);
    expect(deps.create).toHaveBeenCalledTimes(1); expect(deps.send).toHaveBeenCalledTimes(2);
    cards.destroy(); expect(retained.size).toBe(0);
  });
  it('renders full Markdown release sections collapsed, with coverage and paging kept separate', () => {
    const elements = updateNoticeElements(notice() as any, key);
    expect(elements.some(e => e.tag === 'collapsible_panel' && e.expanded === false && e.elements.some((b: any) => b.tag === 'markdown'))).toBe(true);
    expect(elements.some(e => e.tag === 'button' && e.behaviors[0].value.offset === 1)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(elements))).toBeLessThan(32 * 1024);
  });
  it('shows localized summaries directly while collapsing only technical details, including requested pages', async () => {
    const summary = '### \u66f4\u65b0\n- \u529f\u80fd\u6539\u5584';
    const section = { version: '1.6.125', text: summary, details: '### Fixed\n- Technical implementation details' };
    const message = { ...notice(), page: { ...notice().page, sections: [section] } };
    await cards.receiveNotice(message, 'device-fixture', () => true);
    const verify = (elements: any[]) => {
      expect(elements.filter(e => e.tag === 'markdown').some(e => e.content.includes(summary))).toBe(true);
      expect(elements.filter(e => e.tag === 'markdown').some(e => e.content.includes(section.details))).toBe(false);
      const panels = elements.filter(e => e.tag === 'collapsible_panel');
      expect(panels).toHaveLength(1);
      expect(panels[0]).toMatchObject({ expanded: false, elements: [{ tag: 'markdown', content: section.details }] });
    };
    verify(deps.create.mock.calls[0][1]);
    expect(deps.send).toHaveBeenCalledWith('device-fixture', expect.objectContaining({ type: 'update_notice_ack' }));
    const receipt = (await receipts.find('device-fixture', key))!;
    await cards.view('owner-fixture', receipt.id, receipt.cardId, 1, () => () => true);
    const request = deps.send.mock.calls.at(-1)[1];
    await cards.receivePage({ ...message, type: 'update_notice_page', requestId: request.requestId,
      page: { ...message.page, offset: 1, nextOffset: undefined } }, 'device-fixture');
    verify(deps.update.mock.calls[0][1]);
    // Older CLI sections retain the original collapsed presentation.
    const legacyElements = updateNoticeElements({ ...message, page: { ...message.page, sections: [{ version: section.version, text: section.text }] } } as any, key);
    expect(legacyElements.filter(e => e.tag === 'collapsible_panel')[0]).toMatchObject({
      expanded: false, elements: [{ tag: 'markdown', content: summary }],
    });
  });
  it('shows a full-range overview above collapsed version records on initial delivery and later pages', async () => {
    const overview = { totalGroups: 2, totalItems: 2, groups: [
      { topic: 'feature', title: 'Feature', items: ['A visible change'] },
      { topic: 'older', title: 'Older feature', items: ['A change outside the current page'] },
    ] };
    const message = { ...notice(), page: { ...notice().page, overview,
      sections: [{ version: '1.6.125', text: '- Original summary', details: '- Original technical detail' }] } };
    await cards.receiveNotice(message, 'device-fixture', () => true);
    const verify = (elements: any[]) => {
      const visible = elements.filter(e => e.tag === 'markdown').map(e => e.content).join('\n');
      expect(visible).toContain('A visible change'); expect(visible).toContain('A change outside the current page');
      expect(visible).not.toContain('Original summary'); expect(visible).not.toContain('Original technical detail');
      const panels = elements.filter(e => e.tag === 'collapsible_panel');
      expect(panels).toHaveLength(1); expect(panels[0].expanded).toBe(false);
      expect(panels[0].elements.map((e: any) => e.content).join('\n')).toContain('Original summary');
      expect(panels[0].elements.map((e: any) => e.content).join('\n')).toContain('Original technical detail');
    };
    verify(deps.create.mock.calls[0][1]);
    const receipt = (await receipts.find('device-fixture', key))!;
    await cards.view('owner-fixture', receipt.id, receipt.cardId, 1, () => () => true);
    const request = deps.send.mock.calls.at(-1)[1];
    await cards.receivePage({ ...message, type: 'update_notice_page', requestId: request.requestId,
      page: { ...message.page, offset: 1, nextOffset: undefined } }, 'device-fixture');
    verify(deps.update.mock.calls[0][1]);
    const truncated = updateNoticeElements({ ...message, page: { ...message.page, overview: { ...overview, totalItems: 20 } } } as any, key);
    expect(truncated.some(e => e.tag === 'markdown' && e.content.includes('2 of 20 unique changes'))).toBe(true);
  });
  it('rejects malformed or oversized overviews without sending a delivery acknowledgement', async () => {
    const group = { topic: 'feature', title: 'Feature', items: ['A change'] };
    const valid = { totalGroups: 1, totalItems: 1, groups: [group] };
    const invalid = [null, {}, { ...valid, groups: [] }, { ...valid, groups: Array(7).fill(group) },
      { ...valid, totalGroups: 0 }, { ...valid, totalGroups: 1.5 }, { ...valid, totalItems: 0 }, { ...valid, totalItems: 1.5 },
      { ...valid, groups: [null] }, { ...valid, groups: [{ ...group, topic: 123 }] }, { ...valid, groups: [{ ...group, topic: 'Invalid topic' }] },
      { ...valid, groups: [{ ...group, title: 123 }] }, { ...valid, groups: [{ ...group, title: ' Feature' }] }, { ...valid, groups: [{ ...group, title: '' }] },
      { ...valid, groups: [{ ...group, title: 'x'.repeat(81) }] }, { ...valid, groups: [{ ...group, title: '*Feature*' }] },
      { ...valid, groups: [{ ...group, items: null }] }, { ...valid, groups: [{ ...group, items: [] }] },
      { ...valid, groups: [{ ...group, items: Array(13).fill('A change') }] }, { ...valid, groups: [{ ...group, items: [123] }] },
      { ...valid, groups: [{ ...group, items: [' Change'] }] }, { ...valid, groups: [{ ...group, items: [''] }] },
      { ...valid, groups: [{ ...group, items: ['Two\nlines'] }] }, { ...valid, groups: [{ ...group, items: ['x'.repeat(2049)] }] },
      { ...valid, totalItems: 2, groups: [{ ...group, items: ['A change', 'A change'] }] },
      { totalGroups: 2, totalItems: 2, groups: [group, group] },
      { ...valid, groups: [{ ...group, items: ['A change', 'Another change'] }] },
      { totalGroups: 2, totalItems: 13, groups: [{ ...group, items: Array.from({ length: 12 }, (_, n) => `Fix ${n}`) }, { ...group, topic: 'other' }] },
      { ...valid, totalItems: 4, groups: [{ ...group, items: Array.from({ length: 4 }, (_, n) => 'x'.repeat(2000) + n) }] },
    ];
    for (const overview of invalid) await cards.receiveNotice({ ...notice(), page: { ...notice().page, overview } }, 'device-fixture', () => true);
    expect(deps.create).not.toHaveBeenCalled(); expect(deps.send).not.toHaveBeenCalled();
  });
  it('fails closed on corrupt receipt stores, preventing publication without durable deduplication', async () => {
    await fs.writeFile(path.join(directory, 'receipts.json'), '{broken');
    await expect(cards.receiveNotice(notice(), 'device-fixture', () => true)).rejects.toThrow('storage');
    expect(deps.create).not.toHaveBeenCalled();
  });
});
