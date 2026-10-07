import type { ActivityProgressInfo } from '../types';

export const ACTIVITY_ELEMENT_ID = 'execution_activity';
export const ACTIVITY_TEXT_LIMIT = 240;
const SOURCES = new Set(['public_text', 'reasoning_summary', 'plan', 'tool', 'state']);

/** Accept only public, bounded snapshots; provenance never implies task completion. */
export function parseActivityProgress(value: unknown): ActivityProgressInfo | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const { source, text } = value as Record<string, unknown>;
  if (typeof source !== 'string' || !SOURCES.has(source) || typeof text !== 'string') return;
  const normalized = text.replace(/[\t\r\n]/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
    .replace(/\s+/g, ' ').trim();
  if (!normalized) return;
  return { source: source as ActivityProgressInfo['source'], text: Array.from(normalized).slice(0, ACTIVITY_TEXT_LIMIT).join('') };
}

/** Activity is literal text, not an opportunity to inject mentions or card markup. */
export function activityLiteral(text: string): string {
  return `<raw>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</raw>`;
}

export function createActivityElement(activity: ActivityProgressInfo) {
  return { tag: 'markdown', element_id: ACTIVITY_ELEMENT_ID,
    content: `Running · ${activityLiteral(activity.text)}`, text_size: 'notation' };
}
