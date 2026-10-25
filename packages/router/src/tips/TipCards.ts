import ui from './ui.zh-CN.json';
import type { TipDefinition } from './TipTypes';
import type { TipReceipt, TipUserState } from './TipStore';

export { ui };
export const TIP_PAGE_SIZE = 6;
export interface TipCard { elements: any[]; header: Record<string, unknown> }
export function text(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key) => values[key] === undefined ? match : String(values[key]));
}
const markdown = (content: string): any => ({ tag: 'markdown', content });
const note = (content: string): any => ({ tag: 'markdown', content, text_size: 'notation' });
const header = (content: string): Record<string, unknown> => ({ title: { tag: 'plain_text', content }, template: 'blue' });
function button(receipt: TipReceipt, label: string, op: string, value?: string): any {
  return { tag: 'button', text: { tag: 'plain_text', content: label }, type: 'default', behaviors: [{ type: 'callback',
    value: { action: 'tips', id: receipt.id, op, ...(value === undefined ? {} : { value }) } }] };
}
function row(elements: any[]): any {
  return { tag: 'column_set', flex_mode: 'stretch', columns: elements.map(element => ({ tag: 'column', width: 'auto', elements: [element] })) };
}

/** Every tutorial view retains its uploaded illustration and inline usage note. */
export function tipCard(tip: TipDefinition, receipt: TipReceipt, image: string, view: 'summary' | 'example' = 'summary'): TipCard {
  return { header: header(tip.title), elements: [
    { tag: 'img', img_key: image, alt: { tag: 'plain_text', content: tip.title }, mode: 'fit_horizontal', preview: true },
    markdown(`**${ui.problem}**\n${tip.problem}\n\n**${ui.benefit}**\n${tip.benefit}\n\n**${ui.action}**\n${tip.action}`),
    note(`**${ui.usageNote}**\n${tip.detail}`),
    ...(view === 'example' ? [markdown(tip.example)] : []), note(ui.passive),
    row([button(receipt, ui.example, 'example'), button(receipt, ui.next, 'next')]),
    row([button(receipt, ui.mastered, 'mastered'), button(receipt, ui.settings, 'settings')]),
  ] };
}

export function settingsCard(state: TipUserState, receipt: TipReceipt, now: number): TipCard {
  const status = state.subscription === 'off' ? ui.stateOff : state.subscription === 'daily' ? ui.stateDaily : ui.stateWeekly;
  const until = new Intl.DateTimeFormat('zh-CN', { timeZone: state.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(state.muteUntil);
  return { header: header(ui.settingsTitle), elements: [markdown(`${status}\n${text(ui.timezone, { timezone: state.timezone })}`),
    ...(state.muteUntil > now ? [markdown(text(ui.muted, { until }))] : []), note(ui.consent), note(ui.schedule),
    row([button(receipt, ui.daily, 'subscribe', 'daily'), button(receipt, ui.weekly, 'subscribe', 'weekly'), button(receipt, ui.off, 'off')]),
    row([1, 3, 7, 14].map(days => button(receipt, ui[`mute${days}` as 'mute1'], 'mute', String(days)))),
    ...(state.muteUntil > now ? [row([button(receipt, ui.resume, 'unmute')])] : []),
  ] };
}

export function catalogCard(catalog: readonly TipDefinition[], receipt: TipReceipt, page = 0): TipCard {
  const pages = Math.max(1, Math.ceil(catalog.length / TIP_PAGE_SIZE));
  const index = Math.max(0, Math.min(page, pages - 1));
  return { header: header(ui.catalogTitle), elements: [note(ui.passive),
    ...catalog.slice(index * TIP_PAGE_SIZE, (index + 1) * TIP_PAGE_SIZE).map(tip => row([button(receipt, tip.title, 'show', tip.id)])),
    note(text(ui.page, { page: index + 1, total: pages })), row([
      ...(index > 0 ? [button(receipt, ui.previous, 'page', String(index - 1))] : []),
      ...(index + 1 < pages ? [button(receipt, ui.more, 'page', String(index + 1))] : []),
      button(receipt, ui.settings, 'settings'),
    ]),
  ] };
}

export function messageCard(message: string): TipCard {
  return { header: header(ui.title), elements: [markdown(message)] };
}
