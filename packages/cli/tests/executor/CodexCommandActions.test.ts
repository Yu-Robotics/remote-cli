import { describe, expect, it } from 'vitest';
import { describeCodexCommandActions } from '../../src/executor/CodexCommandActions';

describe('native Codex command-action descriptions', () => {
  it.each([
    [[{ type: 'read', name: 'app.ts', path: '/project/src/app.ts' }], 'Read app.ts'],
    [[{ type: 'read', name: 'app.ts', path: 'C:\\project\\src\\app.ts' }], 'Read app.ts'],
    [[{ type: 'read', name: '/project/app.ts' }], 'Read app.ts'],
    [[{ type: 'read', path: '', name: 'app.ts' }], 'Read app.ts'],
    [[{ type: 'read', path: 1, name: 'app.ts' }], 'Read app.ts'],
    [[{ type: 'read' }], 'Read file'],
    [[{ type: 'read', path: '/' }], 'Read file'],
    [[{ type: 'read', path: '.' }], 'Read file'],
    [[{ type: 'read', path: '..' }], 'Read file'],
    [[{ type: 'search', query: 'synthetic-private-query', path: '/project/private' }], 'Search files'],
    [[{ type: 'listFiles', path: '/project/private' }], 'List directory'],
    [[{ type: 'read', name: '\u001b[31mapp\u001b[0m\u0000.ts\n' }], 'Read app.ts'],
  ])('uses only structured action metadata (%j)', (actions, expected) => {
    expect(describeCodexCommandActions(actions)).toBe(expected);
  });

  it.each([undefined, null, {}, 'read', [], [null], [false], [42], ['read'], [[]], [{}],
    [{ type: 'unknown', command: 'npm test' }], [{ type: 'futureAction' }],
    [{ type: 'search' }, { type: 'unknown', command: 'npm test' }],
    [{ type: 'read', name: 'app.ts' }, null],
  ])('omits malformed, absent, unknown, and partly unknown actions (%j)', actions => {
    expect(describeCodexCommandActions(actions)).toBeUndefined();
  });

  it('describes all recognized operations and deduplicates repeated actions', () => {
    expect(describeCodexCommandActions([
      { type: 'read', name: 'app.ts' }, { type: 'search' }, { type: 'read', name: 'app.ts' },
      { type: 'listFiles' },
    ])).toBe('Read app.ts / Search files / List directory');
  });

  it('bounds the number of visible labels and reports omitted actions', () => {
    expect(describeCodexCommandActions(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'].map(name => ({ type: 'read', name }))))
      .toBe('Read a.ts / Read b.ts / Read c.ts / +2 more');
  });

  it('bounds Unicode labels without reading raw commands or execution output', () => {
    const text = describeCodexCommandActions([{ type: 'read', name: '🧪'.repeat(300),
      command: 'synthetic-private-command', aggregatedOutput: 'synthetic-private-output' }])!;
    expect(Array.from(text)).toHaveLength(60);
    expect(text).not.toContain('synthetic-private');
    expect(text).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it.each(['a'.repeat(225) + '.ts', '🧪'.repeat(100) + '.ts'])(
    'reserves separators and omission counts before bounding compound labels (%s)', name => {
      const text = describeCodexCommandActions([
        { type: 'read', name }, { type: 'read', name: 'b.ts' }, { type: 'search' }, { type: 'listFiles' },
      ])!;
      expect(Array.from(text).length).toBeLessThanOrEqual(60);
      expect(text).toMatch(/^Read .+… \/ Read b\.ts \/ Search files \/ \+1 more$/);
      expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    });

  it('shortens each long visible label without silently dropping recognized operations', () => {
    const text = describeCodexCommandActions(['a', 'b', 'c', 'd', 'e'].map(name => ({ type: 'read', name: name.repeat(225) + '.ts' })))!;
    expect(Array.from(text).length).toBeLessThanOrEqual(60);
    expect(text).toMatch(/^Read a+… \/ Read b+… \/ Read c+… \/ \+2 more$/);
  });
});
