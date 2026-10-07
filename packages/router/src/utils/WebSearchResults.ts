import { activityLiteral } from './ActivityProgress';

function bounded(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return;
  const text = value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  if (!text) return;
  const points = Array.from(text);
  return points.length > limit ? `${points.slice(0, limit - 1).join('')}…` : text;
}

/** Revalidate links at the rendering boundary, including data from future peers. */
function link(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048
    || /[\u0000-\u0020\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/.test(value)) return;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.href.length > 2048) return;
    return parsed.href.replace(/[()<>'"\[\]\\]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  } catch { return; }
}

/** Use one existing Markdown detail node regardless of native result count. */
export function webSearchResultMarkdown(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.results) || !Number.isSafeInteger(raw.omittedResults) || (raw.omittedResults as number) < 0) return;
  const lines: string[] = [];
  let shown = 0;
  for (const entry of raw.results.slice(0, 5)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const title = bounded(entry.title, 160), url = link(entry.url), snippet = bounded(entry.snippet, 240);
    if (!title && !url && !snippet) continue;
    lines.push([
      `**${++shown}.** ${activityLiteral(title ?? 'Web result')}`,
      url ? `[Open source](${url})` : undefined,
      snippet ? activityLiteral(snippet) : undefined,
    ].filter(Boolean).join('\n'));
  }
  const omitted = Math.min(Number.MAX_SAFE_INTEGER, (raw.omittedResults as number) + raw.results.length - shown);
  if (omitted) lines.push(`${omitted} additional result entries omitted from this preview.`);
  return lines.join('\n\n') || 'No result entries were returned by the backend.';
}
