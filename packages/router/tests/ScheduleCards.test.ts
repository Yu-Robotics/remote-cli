import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScheduleCards, parseScheduleMenu } from '../src/feishu/ScheduleCards';
import { FeishuLongConnHandler } from '../src/feishu/FeishuLongConnHandler';
import type { ScheduleMenu } from '../src/types/ScheduleCards';

function buttons(elements: any[]): any[] {
  return elements.flatMap(element => element.columns?.flatMap((column: any) => column.elements.filter((child: any) => child.tag === 'button')) ?? []);
}
function fixture(count = 1, rule = '* * * * * (UTC)') {
  const menu: ScheduleMenu = { snapshotId: 'snapshot', threadId: 'original-thread', threadName: 'Original thread', expiresAt: Date.now() + 60_000,
    entries: Array.from({ length: count }, (_, index) => ({ value: `choice-${index}`, id: `schedule-${index}`, backend: 'claude',
      state: 'active', rule, prompt: '<at id="all">**synthetic**</at>', canCancel: true })) };
  const transport = { ownsDevice: vi.fn(async () => true), available: vi.fn(() => true), send: vi.fn(async () => true), update: vi.fn(async () => {}) };
  const cards = new ScheduleCards(transport);
  const present = cards.present({ openId: 'owner', deviceId: 'device', expectedThreadId: 'original-thread', menu })!;
  present.deliver(['card']);
  const latest = () => transport.update.mock.calls.at(-1)?.[1] ?? present.elements;
  const payload = (op: string) => buttons(latest()).find(button => button.behaviors[0].value.op === op)?.behaviors[0].value;
  const click = (op: string) => cards.click('owner', 'card', payload(op));
  const settle = async () => { await (cards as any).states.values().next().value?.chain; };
  const result = async (success = true, overrides = {}) => {
    const request = transport.send.mock.calls.at(-1)![1] as any;
    await cards.resolve('device', { ...request, type: 'schedule_action_result', success,
      menu: { ...menu, snapshotId: 'next', entries: menu.entries.map(entry => ({ ...entry, state: success && request.operation === 'cancel' ? 'cancelled' : 'active', canCancel: !success || request.operation !== 'cancel' })) }, ...overrides });
  };
  return { cards, menu, transport, present, latest, payload, click, settle, result };
}
afterEach(() => { vi.useRealTimers(); });

describe('ScheduleCards', () => {
  it('puts the prompt first, uses a readable status chip, and keeps the full ID in subdued metadata', () => {
    const f = fixture();
    const first = f.latest()[0];
    expect(first).toMatchObject({ tag: 'markdown' });
    expect(first.content).toContain('synthetic');
    expect(first.content).not.toContain('schedule-0');
    expect(JSON.stringify(f.latest())).toMatch(/<text_tag color='green'>Scheduled<\/text_tag>/);
    expect(JSON.stringify(f.latest())).toContain('Reference:');
    expect(JSON.stringify(f.latest())).toContain('schedule-0');
    expect(f.latest().find(element => element.content?.startsWith('When:'))?.content).toBe('When: \\* \\* \\* \\* \\* \\(UTC\\)\nReference: `schedule-0`');
    expect(f.latest().at(-1)).toMatchObject({ tag: 'markdown', text_size: 'notation' });
    expect(f.latest().at(-1).content).toContain('not recreated after restart');
    f.cards.destroy();
  });

  it('formats one-shot rules in explicit UTC without changing recurring timezone text', () => {
    const f = fixture(1, '2026-02-03T04:05:00.000Z');
    expect(JSON.stringify(f.latest())).toContain('2026-02-03 04:05:00 UTC');
    f.cards.destroy();
    const recurring = fixture(1, '0 9 * * * (Asia/Shanghai)');
    expect(recurring.latest().find(element => element.content?.startsWith('When:'))?.content).toContain('Asia/Shanghai');
    recurring.cards.destroy();
  });

  it('requires confirmation, supports Back, and changes state only after the matching CLI receipt', async () => {
    const f = fixture();
    await f.click('cancel'); await f.settle();
    expect(f.transport.send).not.toHaveBeenCalled();
    expect(JSON.stringify(f.latest())).toContain('Work already queued or running may still finish');
    expect(JSON.stringify(f.latest())).toContain('The conversation remains available');
    await f.click('back'); await f.settle();
    expect(f.transport.send).not.toHaveBeenCalled();
    await f.click('cancel'); await f.settle();
    await f.click('confirm'); await f.settle();
    expect(f.transport.send).toHaveBeenCalledWith('device', expect.objectContaining({ type: 'schedule_action', operation: 'cancel', threadId: 'original-thread', value: 'choice-0' }));
    expect(JSON.stringify(f.latest())).toContain('Waiting for confirmation');
    expect(JSON.stringify(f.latest())).not.toContain('Cancellation confirmed');
    await f.result();
    expect(JSON.stringify(f.latest())).toContain('Cancellation confirmed');
    expect(buttons(f.latest()).find(button => button.behaviors[0].value.op === 'cancel').disabled).toBe(true);
    f.cards.destroy();
  });

  it('routes actual Feishu operator/card callbacks and refreshes without a normal command', async () => {
    const f = fixture();
    const dispatch = (openId: string, card: string) => FeishuLongConnHandler.prototype.handleCardAction.call({ scheduleCards: f.cards, recordUserActivity: vi.fn() }, {
      operator: { open_id: openId }, context: { open_message_id: card }, action: { value: JSON.stringify(f.payload('refresh')) },
    });
    expect((await dispatch('other', 'card'))?.toast.type).toBe('error');
    expect((await dispatch('owner', 'forged-card'))?.toast.type).toBe('error');
    expect((await dispatch('owner', 'card'))?.toast.type).toBe('info');
    expect(f.transport.send.mock.calls[0][1]).toMatchObject({ type: 'schedule_action', operation: 'refresh' });
    await f.result();
    expect(JSON.stringify(f.latest())).toContain('Status refreshed');
    f.cards.destroy();
  });

  it('suppresses duplicate clicks and ignores replies with different device, owner, thread or snapshot', async () => {
    const f = fixture();
    const old = f.payload('refresh');
    await Promise.all([f.cards.click('owner', 'card', old), f.cards.click('owner', 'card', old)]);
    expect(f.transport.send).toHaveBeenCalledOnce();
    const request = f.transport.send.mock.calls[0][1] as any;
    await f.cards.resolve('wrong', { ...request, type: 'schedule_action_result', success: true });
    for (const change of [{ openId: 'other' }, { threadId: 'other' }, { snapshotId: 'other' }, { messageId: 'other' }]) await f.result(true, change);
    await f.settle();
    expect(JSON.stringify(f.latest())).toContain('Waiting for confirmation');
    await f.result();
    await expect(f.cards.click('owner', 'card', old)).rejects.toThrow('changed');
    f.cards.destroy();
  });

  it('treats timeout as unknown and retries the same request, accepting a late receipt', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.click('refresh');
    await vi.advanceTimersByTimeAsync(15_000); await f.settle();
    expect(JSON.stringify(f.latest())).toContain('Outcome unknown');
    await f.click('retry');
    expect(f.transport.send.mock.calls[1][1]).toEqual(f.transport.send.mock.calls[0][1]);
    await f.result();
    expect(JSON.stringify(f.latest())).toContain('Status refreshed');
    f.cards.destroy();
  });

  it('does not claim cancellation after failed cleanup, and exposes a fresh confirmation for retry', async () => {
    const f = fixture();
    await f.click('cancel'); await f.settle(); await f.click('confirm');
    await f.result(false);
    expect(JSON.stringify(f.latest())).toContain('Cancellation was not confirmed');
    expect(buttons(f.latest()).find(button => button.behaviors[0].value.op === 'cancel').disabled).toBe(false);
    await f.click('cancel'); await f.settle(); await f.click('confirm');
    await f.result(true);
    f.cards.destroy();
  });

  it('does not label an already completed task as cancelled', async () => {
    const f = fixture();
    await f.click('cancel'); await f.settle(); await f.click('confirm');
    await f.result(true, { menu: { ...f.menu, entries: [{ ...f.menu.entries[0], state: 'completed', canCancel: false }] } });
    expect(JSON.stringify(f.latest())).not.toContain('Cancellation confirmed');
    expect(JSON.stringify(f.latest())).toContain('Completed');
    f.cards.destroy();
  });

  it.each([false, true])('shows unconfirmed native cleanup instead of cancelled status (receipt success %s)', async success => {
    const f = fixture();
    await f.click('cancel'); await f.settle(); await f.click('confirm');
    await f.result(success, { menu: { ...f.menu, entries: [{ ...f.menu.entries[0], state: 'cancelled', canCancel: true }] } });
    const rendered = JSON.stringify(f.latest());
    expect(rendered).toContain('Stopping · exit unconfirmed');
    expect(rendered).not.toContain('**Status:** cancelled');
    expect(rendered).not.toContain('Cancellation confirmed by the CLI');
    expect(buttons(f.latest()).find(button => button.text.content === 'Retry stopping task').disabled).toBe(false);
    f.cards.destroy();
  });

  it('rechecks asynchronous ownership after disconnect and does not send a stale control', async () => {
    const f = fixture();
    let release!: (value: boolean) => void;
    f.transport.ownsDevice.mockImplementationOnce(() => new Promise<boolean>(resolve => { release = resolve; }));
    const click = f.click('refresh');
    f.cards.disconnect('device'); release(true);
    await expect(click).rejects.toThrow('unavailable');
    expect(f.transport.send).not.toHaveBeenCalled();
    f.cards.destroy();
  });

  it('never applies an in-flight result after device ownership changed', async () => {
    const f = fixture();
    await f.click('refresh'); await f.settle();
    f.transport.ownsDevice.mockResolvedValue(false);
    await f.result();
    expect(JSON.stringify(f.latest())).not.toContain('Status refreshed');
    f.cards.destroy();
  });

  it('fails closed after Router restart, disconnect, expiry or an undelivered/split card', async () => {
    vi.useFakeTimers();
    const f = fixture(); const payload = f.payload('refresh');
    const fresh = new ScheduleCards(f.transport);
    await expect(fresh.click('owner', 'card', payload)).rejects.toThrow('expired');
    f.cards.disconnect('device');
    await expect(f.cards.click('owner', 'card', payload)).rejects.toThrow('expired');
    const prepared = fresh.present({ openId: 'owner', deviceId: 'device', expectedThreadId: 'original-thread', menu: f.menu })!;
    const newPayload = buttons(prepared.elements)[0].behaviors[0].value;
    await expect(fresh.click('owner', 'card', newPayload)).rejects.toThrow('expired');
    prepared.deliver(['one', 'two']);
    await expect(fresh.click('owner', 'one', newPayload)).rejects.toThrow('expired');
    await vi.advanceTimersByTimeAsync(61_000);
    expect(fresh.present({ openId: 'owner', deviceId: 'device', expectedThreadId: 'original-thread', menu: f.menu })).toBeUndefined();
    fresh.destroy(); f.cards.destroy();
  });

  it('paginates a full catalog within card budgets, escaping untrusted text and keeping navigation local', async () => {
    const f = fixture(100);
    expect(JSON.stringify(f.latest())).toContain('\\\\<at');
    for (let index = 0; index < 100; index++) {
      expect(Buffer.byteLength(JSON.stringify(f.latest()))).toBeLessThan(16 * 1024);
      expect(f.latest().length).toBeLessThan(20);
      expect(JSON.stringify(f.latest())).toContain(`schedule-${index}`);
      if (index < 99) {
        const next = buttons(f.latest()).find(button => button.text.content === 'Next').behaviors[0].value;
        await f.cards.click('owner', 'card', next); await f.settle();
      }
    }
    expect(f.transport.send).not.toHaveBeenCalled();
    f.cards.destroy();
  });

  it.each([null, {}, { entries: [] }, { threadId: 'wrong' }, { entries: [{ value: '__proto__' }] }, { expiresAt: 1 },
    { entries: Array(101).fill({}) }])('rejects invalid or wrongly routed menu %j', change => {
    const f = fixture();
    const menu = change === null ? null : { ...f.menu, ...change };
    const prepared = f.cards.present({ openId: 'owner', deviceId: 'device', expectedThreadId: 'original-thread', menu });
    if (change && Object.keys(change).length === 0 || change && 'entries' in change && Array.isArray(change.entries) && !change.entries.length) {
      expect(prepared).toBeDefined(); prepared?.discard();
    } else expect(prepared).toBeUndefined();
    expect(parseScheduleMenu({ ...f.menu, entries: [{ ...f.menu.entries[0], prompt: 'x'.repeat(241) }] })).toBeUndefined();
    f.cards.destroy();
  });

  it('bounds interactive state without evicting requests awaiting confirmation', async () => {
    const f = fixture();
    const original = f.payload('refresh');
    for (let index = 0; index < 100; index++) {
      const prepared = f.cards.present({ openId: 'owner', deviceId: 'device', expectedThreadId: 'original-thread', menu: f.menu })!;
      prepared.deliver([`card-${index}`]);
      const payload = buttons(prepared.elements)[0].behaviors[0].value;
      await f.cards.click('owner', `card-${index}`, payload);
    }
    expect(f.cards.present({ openId: 'owner', deviceId: 'device', expectedThreadId: 'original-thread', menu: f.menu })).toBeUndefined();
    await expect(f.cards.click('owner', 'card', original)).rejects.toThrow('expired');
    f.cards.destroy();
  });

  it('recovers visible controls after a failed card patch without repeating the native operation', async () => {
    const f = fixture();
    const old = f.payload('refresh');
    f.transport.update.mockRejectedValue(new Error('synthetic patch failure'));
    await f.cards.click('owner', 'card', old); await f.result();
    f.transport.update.mockResolvedValue();
    await expect(f.cards.click('owner', 'card', old)).rejects.toThrow('changed');
    await f.settle();
    expect(JSON.stringify(f.latest())).toContain('Status refreshed');
    expect(f.transport.send).toHaveBeenCalledOnce();
    f.cards.destroy();
  });

  it('reports transport failure as unknown and disables old cancellation eligibility when a receipt has no fresh view', async () => {
    const f = fixture();
    f.transport.send.mockRejectedValueOnce(new Error('offline'));
    await f.click('refresh'); await f.settle();
    expect(JSON.stringify(f.latest())).toContain('unknown');
    await f.click('retry'); await f.result(true, { menu: undefined });
    expect(buttons(f.latest()).find(button => button.behaviors[0].value.op === 'cancel').disabled).toBe(true);
    f.cards.destroy();
  });
});
