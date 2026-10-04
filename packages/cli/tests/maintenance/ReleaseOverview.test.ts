import { describe, it, expect } from 'vitest';
import { buildReleaseOverview, validReleaseChanges, OVERVIEW_BYTES, OVERVIEW_MAX_GROUPS, OVERVIEW_MAX_ITEMS } from '../../src/maintenance/ReleaseOverview';

describe('bounded release overview', () => {
  const change = { topic: 'feature', title: 'Feature', text: 'A change' };

  it('deduplicates identical items only within a feature and retains distinct fixes in source order', () => {
    const sections = [
      { changes: [change, { ...change, text: 'Another fix' }, { ...change, topic: 'other', title: 'Other' }] },
      { changes: [change, { ...change, text: 'Older fix' }] },
    ];
    expect(buildReleaseOverview(sections)).toEqual({ totalGroups: 2, totalItems: 4, groups: [
      { topic: 'feature', title: 'Feature', items: ['A change', 'Another fix', 'Older fix'] },
      { topic: 'other', title: 'Other', items: ['A change'] },
    ] });
    expect(sections[0].changes).toHaveLength(3);
  });

  it('falls back for old metadata, empty ranges, and unusable overview budgets', () => {
    expect(buildReleaseOverview([])).toBeUndefined();
    expect(buildReleaseOverview([{ changes: [change] }, {}])).toBeUndefined();
    expect(buildReleaseOverview([{ changes: [] }])).toBeUndefined();
    for (const budget of [0, -1, NaN, Infinity, 1]) expect(buildReleaseOverview([{ changes: [change] }], budget)).toBeUndefined();
  });

  it('bounds features, items, and UTF-8 bytes without discarding the original records or their counts', () => {
    const manyItems = Array.from({ length: 20 }, (_, n) => ({ changes: [{ ...change, text: `Fix ${n}` }] }));
    const items = buildReleaseOverview(manyItems)!;
    expect(items.totalItems).toBe(20);
    expect(items.groups[0].items).toHaveLength(OVERVIEW_MAX_ITEMS);
    expect(manyItems.flatMap(s => s.changes)).toHaveLength(20);
    const manyGroups = Array.from({ length: 10 }, (_, n) => ({ changes: [{ ...change, topic: `feature-${n}`, title: `Feature ${n}` }] }));
    const groups = buildReleaseOverview(manyGroups)!;
    expect(groups).toMatchObject({ totalGroups: 10, totalItems: 10 });
    expect(groups.groups).toHaveLength(OVERVIEW_MAX_GROUPS);
    const utf8 = Array.from({ length: 8 }, (_, n) => ({ changes: [{ ...change, topic: `feature-${n}`, text: '\u4e2d'.repeat(450) + n }] }));
    const sized = buildReleaseOverview(utf8)!;
    expect(Buffer.byteLength(JSON.stringify(sized))).toBeLessThanOrEqual(OVERVIEW_BYTES);
    expect(sized.totalItems).toBe(8);
    expect(sized.groups.reduce((n, group) => n + group.items.length, 0)).toBeLessThan(8);
    expect(utf8.flatMap(s => s.changes)).toHaveLength(8);
  });

  it('validates only bounded, single-line feature metadata from bundled artifacts', () => {
    expect(validReleaseChanges([change])).toBe(true);
    for (const invalid of [null, {}, [], [change, change, change, change], [null],
      [{ ...change, topic: 123 }], [{ ...change, topic: 'Invalid topic' }],
      [{ ...change, title: 123 }], [{ ...change, title: ' Feature' }], [{ ...change, title: '' }],
      [{ ...change, title: 'x'.repeat(81) }], [{ ...change, title: '*Feature*' }],
      [{ ...change, text: 123 }], [{ ...change, text: ' Change' }], [{ ...change, text: '' }],
      [{ ...change, text: 'Two\nlines' }], [{ ...change, text: '\u4e2d'.repeat(1000) }]]) {
      expect(validReleaseChanges(invalid)).toBe(false);
    }
  });
});
