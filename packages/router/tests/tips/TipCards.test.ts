import { describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { catalogCard, messageCard, settingsCard, text, tipCard, ui } from '../../src/tips/TipCards';
import { newTipState } from '../../src/tips/TipStore';
import type { TipReceipt } from '../../src/tips/TipStore';

const receipt: TipReceipt = { id: randomUUID(), cardId: 'synthetic-card', kind: 'tip', tipId: 'tip-1', createdAt: 1000, revision: randomUUID(), used: [] };
const tip = { id: 'tip-1', topic: 'Topic', title: 'Synthetic tutorial', problem: 'Problem', benefit: 'Benefit', action: 'Action',
  example: '/effort high', detail: 'Detail', image: 'synthetic.png' };

describe('passive localized Tips cards', () => {
  it('retains the uploaded image in summary, detail, and example views with callback-only buttons', () => {
    for (const view of ['summary', 'detail', 'example'] as const) {
      const card = tipCard(tip, receipt, 'uploaded-key', view);
      expect(card.elements[0]).toMatchObject({ tag: 'img', img_key: 'uploaded-key' });
      expect(JSON.stringify(card)).toContain(ui.passive);
      expect(JSON.stringify(card)).not.toContain('open_url');
      expect(JSON.stringify(card)).toContain('"action":"tips"');
    }
  });

  it('shows default daily delivery with pause, stop, and frequency controls', () => {
    const card = settingsCard(newTipState('Asia/Shanghai'), receipt, 1000);
    const content = JSON.stringify(card);
    expect(content).toContain(ui.stateDaily);
    expect(ui.consent).toContain('\u9ed8\u8ba4\u6bcf\u5929\u63a8\u9001\u4e00\u6761');
    const actions = card.elements.flatMap(element => element.columns ?? [])
      .flatMap((column: any) => column.elements)
      .flatMap((button: any) => button.behaviors.map((behavior: any) => behavior.value));
    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: 'off' }),
      expect.objectContaining({ op: 'mute', value: '7' }),
      expect.objectContaining({ op: 'subscribe', value: 'weekly' }),
    ]));
  });

  it('displays preference controls, timezone, schedule, mute expiry, and explicit resumption controls', () => {
    const state = newTipState('Asia/Shanghai'); state.subscription = 'weekly'; state.muteUntil = 1800000000000;
    const card = settingsCard(state, receipt, 1000);
    expect(JSON.stringify(card)).toContain(ui.stateWeekly); expect(JSON.stringify(card)).toContain('Asia/Shanghai');
    expect(JSON.stringify(card)).toContain(ui.resume); expect(JSON.stringify(card)).toContain(ui.consent);
    state.subscription = 'daily'; expect(JSON.stringify(settingsCard(state, receipt, state.muteUntil))).toContain(ui.stateDaily);
    state.subscription = 'off'; expect(JSON.stringify(settingsCard(state, receipt, state.muteUntil))).toContain(ui.stateOff);
  });

  it('bounds catalog pagination dynamically, including empty and partial pages', () => {
    const catalog = Array.from({ length: 32 }, (_, index) => ({ ...tip, id: `tip-${index}` }));
    expect(catalogCard(catalog, receipt).elements[1].columns[0].elements[0].text.content).toBe(tip.title);
    expect(JSON.stringify(catalogCard(catalog, receipt, 0))).not.toContain('"op":"page","value":"-1"');
    expect(JSON.stringify(catalogCard(catalog, receipt, 999))).toContain('"value":"tip-31"');
    expect(JSON.stringify(catalogCard([], receipt, -1))).toContain('1 / 1');
    expect(text('{known} {unknown}', { known: 2 })).toBe('2 {unknown}');
    expect(messageCard('Synthetic status').elements).toHaveLength(1);
  });
});
