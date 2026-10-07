import { describe, expect, it } from 'vitest';
import { codexWebSearchUse, codexWebSearchResult } from '../../src/executor/CodexWebSearch';

describe('Codex native web items', () => {
  it('preserves multi-query actions and meaningful native labels', () => {
    expect(codexWebSearchUse({ title: 'Look up documentation', action: { type: 'search', queries: ['first', 'second'] } }))
      .toEqual({ input: { query: 'first / second', action: 'search', queries: ['first', 'second'] }, description: 'Look up documentation' });
    expect(codexWebSearchUse({ query: 'native display', description: 'Native description', title: 'Native title',
      action: { type: 'search', query: 'fallback' } })).toEqual({
      input: { query: 'native display', action: 'search' }, description: 'Native description',
    });
    expect(codexWebSearchUse({ action: { type: 'search', query: 'single query' } }).input.query).toBe('single query');
  });

  it.each(['openPage', 'findInPage'])('preserves %s URL and pattern without guessing from activity', type => {
    const mapped = codexWebSearchUse({ action: { type, url: 'https://example.com/docs', pattern: 'needle' } });
    expect(mapped.input).toMatchObject({ query: 'https://example.com/docs', url: 'https://example.com/docs', action: type });
    expect(mapped.input.pattern).toBe(type === 'findInPage' ? 'needle' : undefined);
    expect(mapped.description).toBe(type === 'openPage' ? 'Open web page' : 'Find text on web page');
    expect(codexWebSearchUse({ action: { type, url: false, pattern: null } }).input.query).toBe('');
  });

  it.each([undefined, null, [], { type: 'unknown', raw: 'not a public label' }])('keeps unsupported actions unlabeled (%j)', action => {
    expect(codexWebSearchUse({ action })).toEqual({ input: { query: '' }, description: undefined });
  });

  it('bounds and normalizes action text in Unicode code points', () => {
    const mapped = codexWebSearchUse({ query: '🧪'.repeat(1100), description: '\u001b[31m\u202e ' + '🧪'.repeat(100),
      action: { type: 'search', queries: ['\u0000 first\n second', null, '🧪'.repeat(600), 'a', 'b', 'ignored'] } });
    expect(Array.from(mapped.input.query as string)).toHaveLength(1000);
    expect(Array.from(mapped.description!)).toHaveLength(60);
    expect(mapped.input.queries).toEqual(['first second', '🧪'.repeat(499) + '…', 'a', 'b']);
    expect(mapped.input.omittedQueries).toBe(2);
    expect(JSON.stringify(mapped)).not.toContain('ignored');
    const fallback = codexWebSearchUse({ action: { type: 'search', queries: Array(8).fill('x'.repeat(600)) } });
    expect(Array.from(fallback.input.query as string)).toHaveLength(1000);
    expect(fallback.input.omittedQueries).toBe(3);
  });

  it('forwards real native result fields and a plaintext old-peer fallback', () => {
    const result = codexWebSearchResult({ id: 'web-1', results: [{ type: 'search_result', domain: 'example.com',
      ref_id: 'opaque-citation', title: 'Example docs', url: 'https://example.com/docs', snippet: 'Public excerpt',
      thumbnail_url: 'https://example.com/thumbnail' }] });
    expect(result).toEqual({ tool_use_id: 'web-1', is_error: false,
      webSearch: { results: [{ title: 'Example docs', url: 'https://example.com/docs', snippet: 'Public excerpt' }], omittedResults: 0 },
      content: '1. Example docs\nSource: https://example.com/docs\nExcerpt: Public excerpt' });
    expect(JSON.stringify(result)).not.toMatch(/opaque-citation|thumbnail/);
  });

  it('prevents untrusted fields from closing the fixed code fence on older Routers', () => {
    const result = codexWebSearchResult({ id: 'fenced', results: [
      { title: 'Documentation', snippet: '```' },
      { title: '<at id=all>Untrusted mention</at>', url: 'https://example.com/docs', snippet: '\n~~~\n```\n' },
    ] });
    expect(result.content).toContain('Excerpt: ```');
    expect(result.content).toContain('2. <at id=all>Untrusted mention</at>');
    expect(result.content.split('\n').every(line => !/^\s{0,3}(?:`{3,}|~{3,})/.test(line))).toBe(true);
    expect(result.webSearch?.results[0].snippet).toBe('```');
  });

  it('distinguishes a missing or malformed field from an explicitly empty result array', () => {
    expect(codexWebSearchResult({ id: 'old' })).toEqual({ tool_use_id: 'old', is_error: false,
      content: 'Web result entries were not provided by this Codex version.' });
    expect(codexWebSearchResult({ id: 'bad', results: {} })).toEqual({ tool_use_id: 'bad', is_error: false,
      content: 'Web result entries are unavailable: unsupported result format.' });
    expect(codexWebSearchResult({ id: 'empty', results: [] })).toEqual({ tool_use_id: 'empty', is_error: false,
      webSearch: { results: [], omittedResults: 0 }, content: 'No result entries were returned by the backend.' });
  });

  it('bounds result counts, titles and snippets and explicitly reports every omitted entry', () => {
    const result = codexWebSearchResult({ id: 'many', results: [null, [], 42, {},
      { title: '🧪'.repeat(200), snippet: '\u001b[31m\u202e ' + '🧪'.repeat(300) },
      ...Array.from({ length: 100 }, () => ({ title: 'Additional result' }))] });
    expect(result.webSearch?.results).toHaveLength(1);
    expect(Array.from(result.webSearch!.results[0].title!)).toHaveLength(160);
    expect(Array.from(result.webSearch!.results[0].snippet!)).toHaveLength(240);
    expect(result.webSearch?.omittedResults).toBe(104);
    expect(result.content).toContain('104 additional result entries omitted');
    expect(result.content).not.toMatch(/[\u001b\u202e]/);
  });

  it.each(['javascript:alert(1)', 'data:text/html,test', 'file:///etc/example', 'https://user:secret@example.com/',
    'https://example.com/\npath', 'https://example.com/\u202epath', 'not a URL', 'https://example.com/' + 'x'.repeat(2100), 42])(
    'does not forward an unsafe or malformed result link (%j)', target => {
      const result = codexWebSearchResult({ id: 'bad-link', results: [{ title: 'Still readable', url: target }] });
      expect(result.webSearch?.results).toEqual([{ title: 'Still readable' }]);
      expect(codexWebSearchUse({ action: { type: 'openPage', url: target } }).input).not.toHaveProperty('url');
    });

  it('retains URL-only and snippet-only entries, normalizing safe URLs', () => {
    expect(codexWebSearchResult({ id: 'partials', results: [{ url: 'HTTPS://EXAMPLE.COM' }, { snippet: 'Excerpt' }] }).webSearch)
      .toEqual({ results: [{ url: 'https://example.com/' }, { snippet: 'Excerpt' }], omittedResults: 0 });
  });

  it.each(['failed', 'cancelled', 'interrupted'])('does not label a %s search successful', status => {
    expect(codexWebSearchResult({ id: 'failed', status, results: [{ title: 'Not a successful result' }] }))
      .toEqual({ tool_use_id: 'failed', content: 'Web search did not complete.', is_error: true });
    expect(codexWebSearchResult({ id: 'failed', error: { message: 'Network failed' } }).content).toBe('Network failed');
    expect(codexWebSearchResult({ id: 'failed', error: 'Denied' }).content).toBe('Denied');
  });
});
