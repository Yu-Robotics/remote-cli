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
    [[{ type: 'unknown', command: 'npm test -- --silent' }], 'Run npm command'],
    [[{ type: 'unknown', command: 'git status --short' }], 'Run Git command'],
    [[{ type: 'unknown', command: 'custom-program synthetic-private-argument' }], 'Run shell command'],
    [[{ type: 'unknown' }], 'Run shell command'],
    [[{ type: 'read', name: '\u001b[31mapp\u001b[0m\u0000.ts\n' }], 'Read app.ts'],
  ])('uses only structured action metadata (%j)', (actions, expected) => {
    expect(describeCodexCommandActions(actions)).toBe(expected);
  });

  it.each([undefined, null, {}, 'read', [], [null], [false], [42], ['read'], [[]], [{}],
    [{ type: 'futureAction' }],
    [{ type: 'search' }, { type: 'futureAction' }],
    [{ type: 'read', name: 'app.ts' }, null],
  ])('omits malformed, absent, and unsupported future actions (%j)', actions => {
    expect(describeCodexCommandActions(actions)).toBeUndefined();
  });

  it.each([
    ['npx vitest run', 'Run npm command'], ['pnpm test', 'Run pnpm command'],
    ['yarn test', 'Run Yarn command'], ['bun test', 'Run Bun command'],
    ['python app.py', 'Run Python command'], ['python3 app.py', 'Run Python command'],
    ['node app.js', 'Run Node.js command'], ['pytest tests', 'Run tests'],
    ['vitest run', 'Run tests'], ['tsc --noEmit', 'Run TypeScript compiler'],
    ['make check', 'Run Make command'], ['cmake --build build', 'Run CMake command'],
    ['cargo test', 'Run Cargo command'], ['go test ./...', 'Run Go command'],
    ['docker version', 'Run Docker command'],
  ])('uses a fixed operation label for %s, not its arguments', (cmd, label) => {
    expect(describeCodexCommandActions([{ type: 'unknown', command: cmd }])).toBe(label);
    expect(describeCodexCommandActions(undefined, cmd)).toBe(label);
  });

  it.each([
    'npm test && custom-program', 'git status; custom-program', 'git status | custom-program',
    'git status > /private/output', 'git status\ncustom-program', 'git status\rcustom-program',
    'git show $(custom-program)', 'git show `custom-program`', 'SECRET=value git status',
    '/private/tool/script --synthetic-secret', 'toString synthetic-private-argument',
    'constructor synthetic-private-argument', 'npmtest synthetic-private-argument',
    'git' + ' '.repeat(4097), '', false, undefined,
  ])('keeps compound, custom, and untrusted shell commands generic (%s)', cmd => {
    expect(describeCodexCommandActions([{ type: 'unknown', command: cmd }])).toBe('Run shell command');
  });

  it('does not hide an unknown operation behind a recognized prefix', () => {
    expect(describeCodexCommandActions([
      { type: 'search', query: 'synthetic-private-query' },
      { type: 'unknown', command: '/private/script synthetic-private-argument' },
    ])).toBe('Search files / Run shell command');
  });

  it('labels missing native actions without borrowing turn-level reasoning', () => {
    expect(describeCodexCommandActions(undefined, 'git status')).toBe('Run Git command');
    expect(describeCodexCommandActions([], 'custom-program')).toBe('Run shell command');
  });

  it('uses the native schema field even if tool-call argument names are also present', () => {
    expect(describeCodexCommandActions([{ type: 'unknown', command: 'git status', cmd: 'npm test' }]))
      .toBe('Run Git command');
    expect(describeCodexCommandActions([{ type: 'unknown', cmd: 'git status' }]))
      .toBe('Run shell command');
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
