import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { MaintenanceCards, updateNoticeElements } from '../../src/maintenance/MaintenanceCards';
import { NoticeReceipts } from '../../src/maintenance/NoticeReceipts';

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
    expect(deps.create).not.toHaveBeenCalled();
    await cards.receiveNotice(notice(), 'device-fixture', () => true); const record = (await receipts.find('device-fixture', key))!;
    await cards.view('owner-fixture', record.id, record.cardId, 1, () => () => true); const request = deps.send.mock.calls.at(-1)[1];
    now += 31000; await cards.receivePage({ ...notice(), requestId: request.requestId, page: { ...notice().page, offset: 1 } }, 'device-fixture');
    expect(deps.update).not.toHaveBeenCalled();
    cards.disconnect('device-fixture');
    now += 31 * 86400_000; await expect(cards.view('owner-fixture', record.id, record.cardId, 0, () => () => true)).rejects.toThrow();
  });
  it('delivers actionable quota guidance without prompt actions and validates passive dismissal', async () => {
    const message = { type: 'subscription_reminder', reminder: { reminderId: key, generation, expiresAt: now + 3600000, activationAvailable: false } };
    await Promise.all([cards.receiveReminder(message, 'device-fixture', () => true), cards.receiveReminder(message, 'device-fixture', () => true)]);
    expect(deps.create).toHaveBeenCalledTimes(1);
    const elements = deps.create.mock.calls[0][1];
    const text = elements.filter((element: any) => element.tag === 'markdown').map((element: any) => element.content).join('\n');
    expect(text).toContain('Weekly quota available: 100%');
    expect(text).toContain('snapshot');
    expect(text).toContain('Without new Codex usage, the reset countdown may keep moving forward. Send Codex a normal task to start the next usage window.');
    expect(text).not.toMatch(/activation|Send Hi|Proposed prompt|local Codex CLI|No action is required|\/status|\bverify\b/i);
    expect(elements.filter((element: any) => element.tag === 'button').map((element: any) => element.behaviors[0].value.decision)).toEqual(['dismiss']);
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
  it('renders full Markdown release sections collapsed, with coverage and paging kept separate', () => {
    const elements = updateNoticeElements(notice() as any, key);
    expect(elements.some(e => e.tag === 'collapsible_panel' && e.expanded === false && e.elements.some((b: any) => b.tag === 'markdown'))).toBe(true);
    expect(elements.some(e => e.tag === 'button' && e.behaviors[0].value.offset === 1)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(elements))).toBeLessThan(32 * 1024);
  });
  it('fails closed on corrupt receipt stores, preventing publication without durable deduplication', async () => {
    await fs.writeFile(path.join(directory, 'receipts.json'), '{broken');
    await expect(cards.receiveNotice(notice(), 'device-fixture', () => true)).rejects.toThrow('storage');
    expect(deps.create).not.toHaveBeenCalled();
  });
});
