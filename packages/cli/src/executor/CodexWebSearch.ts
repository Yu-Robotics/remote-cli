import type { ToolResultInfo, WebSearchResultsInfo } from '../types';

const RESULT_LIMIT = 5;

/** Bound display fields without forwarding opaque citations or thumbnail data. */
function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return;
  const clean = value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  if (!clean) return;
  const points = Array.from(clean);
  return points.length > limit ? `${points.slice(0, limit - 1).join('')}…` : clean;
}

function url(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048
    || /[\u0000-\u0020\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/.test(value)) return;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return;
    return parsed.href.length <= 2048 ? parsed.href : undefined;
  } catch { return; }
}

/** The native action is per invocation, not an execution-wide reasoning summary. */
export function codexWebSearchUse(item: Record<string, any>): {
  input: Record<string, unknown>; description?: string;
} {
  const action = item.action && typeof item.action === 'object' && !Array.isArray(item.action) ? item.action : {};
  const input: Record<string, unknown> = { query: text(item.query, 1000) ?? '' };
  let description: string | undefined;
  if (action.type === 'search') {
    input.action = 'search';
    const queries = Array.isArray(action.queries)
      ? action.queries.slice(0, 5).map((q: unknown) => text(q, 500)).filter(Boolean) : [];
    if (queries.length) input.queries = queries;
    if (Array.isArray(action.queries) && action.queries.length > queries.length) input.omittedQueries = action.queries.length - queries.length;
    if (!input.query) input.query = text(action.query, 1000) ?? text(queries.join(' / '), 1000) ?? '';
    description = 'Search the web';
  } else if (action.type === 'openPage' || action.type === 'findInPage') {
    input.action = action.type;
    const target = url(action.url);
    if (target) input.url = target;
    if (action.type === 'findInPage') {
      const pattern = text(action.pattern, 500);
      if (pattern) input.pattern = pattern;
    }
    if (!input.query) input.query = target ?? '';
    description = action.type === 'openPage' ? 'Open web page' : 'Find text on web page';
  }
  return { input, description: text(item.description, 60) ?? text(item.title, 60) ?? description };
}

/** Results may be missing on older app servers; missing does not mean zero hits. */
export function codexWebSearchResult(item: Record<string, any>): ToolResultInfo {
  const isError = ['failed', 'cancelled', 'interrupted'].includes(item.status) || Boolean(item.error);
  const base = { tool_use_id: item.id, is_error: isError };
  if (isError) {
    return { ...base, content: text(item.error?.message ?? item.error, 1000) ?? 'Web search did not complete.' };
  }
  if (!Array.isArray(item.results)) {
    return { ...base, content: item.results === undefined
      ? 'Web result entries were not provided by this Codex version.'
      : 'Web result entries are unavailable: unsupported result format.' };
  }
  const results: WebSearchResultsInfo['results'] = [];
  // Inspect only a bounded window; the native array length still reports omissions.
  for (const raw of item.results.slice(0, RESULT_LIMIT)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const title = text(raw.title, 160), link = url(raw.url), snippet = text(raw.snippet, 240);
    if (!title && !link && !snippet) continue;
    results.push({ ...(title ? { title } : {}), ...(link ? { url: link } : {}), ...(snippet ? { snippet } : {}) });
  }
  const webSearch = { results, omittedResults: item.results.length - results.length };
  // Older Routers wrap this fallback in a fixed code fence. Every untrusted
  // field stays on a prefixed line so it cannot terminate that outer fence.
  const lines = results.map((entry, index) => [
    `${index + 1}. ${entry.title ?? 'Web result'}`,
    entry.url ? `Source: ${entry.url}` : undefined,
    entry.snippet ? `Excerpt: ${entry.snippet}` : undefined,
  ].filter(Boolean).join('\n'));
  if (webSearch.omittedResults) lines.push(`${webSearch.omittedResults} additional result entries omitted from this preview.`);
  return { ...base, webSearch, content: lines.join('\n\n') || 'No result entries were returned by the backend.' };
}
