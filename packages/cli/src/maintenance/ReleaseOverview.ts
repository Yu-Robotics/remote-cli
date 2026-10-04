export const OVERVIEW_BYTES = 6 * 1024;
export const OVERVIEW_MAX_GROUPS = 6;
export const OVERVIEW_MAX_ITEMS = 12;
export interface ReleaseChange { topic: string; title: string; text: string }
export interface ReleaseOverview {
  groups: { topic: string; title: string; items: string[] }[];
  totalGroups: number;
  totalItems: number;
}

export function validReleaseChanges(value: unknown): value is ReleaseChange[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 3 && value.every(change =>
    change && typeof change.topic === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(change.topic)
    && typeof change.title === 'string' && change.title.trim() === change.title && change.title.length > 0
    && Array.from(change.title).length <= 80 && !/[\r\n\[\]<>|*\x60]/.test(change.title)
    && typeof change.text === 'string' && change.text.trim() === change.text && change.text.length > 0
    && !/[\r\n]/.test(change.text) && Buffer.byteLength(change.text) <= 2 * 1024);
}

/** Aggregate the full selected range, never only the currently displayed page. */
export function buildReleaseOverview(sections: { changes?: ReleaseChange[] }[], budget = OVERVIEW_BYTES): ReleaseOverview | undefined {
  if (!Number.isFinite(budget) || budget <= 0 || !sections.length || sections.some(section => !section.changes)) return;
  const groups = new Map<string, { topic: string; title: string; items: string[]; seen: Set<string> }>();
  for (const section of sections) for (const change of section.changes!) {
    let group = groups.get(change.topic);
    if (!group) { group = { topic: change.topic, title: change.title, items: [], seen: new Set() }; groups.set(change.topic, group); }
    if (!group.seen.has(change.text)) { group.items.push(change.text); group.seen.add(change.text); }
  }
  const overview: ReleaseOverview = { groups: [], totalGroups: groups.size,
    totalItems: [...groups.values()].reduce((total, group) => total + group.items.length, 0) };
  let shown = 0;
  const limit = Math.min(budget, OVERVIEW_BYTES);
  for (const group of groups.values()) {
    if (overview.groups.length >= OVERVIEW_MAX_GROUPS || shown >= OVERVIEW_MAX_ITEMS) break;
    const visible = { topic: group.topic, title: group.title, items: [] as string[] };
    overview.groups.push(visible);
    for (const item of group.items) {
      if (shown >= OVERVIEW_MAX_ITEMS) break;
      visible.items.push(item);
      if (Buffer.byteLength(JSON.stringify(overview)) > limit) visible.items.pop();
      else shown++;
    }
    if (!visible.items.length) overview.groups.pop();
  }
  return overview.groups.length ? overview : undefined;
}
