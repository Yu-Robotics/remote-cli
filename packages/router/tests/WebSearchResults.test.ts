import { describe, expect, it } from 'vitest';
import { webSearchResultMarkdown } from '../src/utils/WebSearchResults';
import { createToolCallElement, createToolResultElement, createToolUseElement, extractToolContext } from '../src/utils/ToolFormatter';
import { codexWebSearchResult } from '../../cli/src/executor/CodexWebSearch';
import MarkdownIt from 'markdown-it';

describe('bounded native web result previews', () => {
  it('keeps the native plaintext fallback inside one literal code fence for older Routers', () => {
    const result = codexWebSearchResult({ id: 'legacy-web', results: [
      { title: 'Documentation', snippet: '```' },
      { title: '<at id=all>Untrusted mention</at>', url: 'https://example.com/docs', snippet: 'Public excerpt' },
    ] });
    const preview = createToolResultElement({ ...result, webSearch: undefined });
    const tokens = new MarkdownIt({ html: true }).parse(preview[0].elements[0].content, {});
    expect(tokens.map(token => token.type)).toEqual(['fence']);
    expect(tokens[0].content).toContain('Excerpt: ```');
    expect(tokens[0].content).toContain('<at id=all>Untrusted mention</at>');
    expect(tokens[0].content).toContain('Source: https://example.com/docs');
  });

  it('renders clickable sources, literal titles and snippets in the existing output node', () => {
    const webSearch = { results: [{ title: '<at id=all>Example</at> [fake](javascript:evil)',
      url: 'https://example.com/docs', snippet: '**bold** </raw><at id=all>mention</at>' }], omittedResults: 0 };
    const info = { tool_use_id: 'web', content: 'Old-peer plaintext', is_error: false, webSearch };
    const preview = createToolResultElement(info);
    const text = preview[0].elements[0].content;
    expect(text).toContain('[Open source](https://example.com/docs)');
    expect(text).toContain('<raw>&lt;at id=all&gt;Example&lt;/at&gt; [fake](javascript:evil)</raw>');
    expect(text).toContain('<raw>**bold** &lt;/raw&gt;&lt;at id=all&gt;mention&lt;/at&gt;</raw>');
    expect(text).not.toMatch(/```|<at id=all>/);
    const state = { name: 'WebSearch', id: 'web', inputElements: createToolUseElement({ name: 'WebSearch', id: 'web', input: { query: 'docs' } }) };
    const paired = createToolCallElement({ ...state, resultElements: preview });
    expect(paired.elements).toHaveLength(2);
    expect(paired.elements[1].content).toContain('**Result**');
  });

  it.each([undefined, null, [], {}, { results: {} }, { results: [], omittedResults: -1 },
    { results: [], omittedResults: NaN }, { results: [], omittedResults: '1' }])('falls back for unsupported metadata (%j)', raw => {
    expect(webSearchResultMarkdown(raw)).toBeUndefined();
    expect(createToolResultElement({ tool_use_id: 'web', content: 'Fallback result', is_error: false, webSearch: raw as any })[0].elements[0].content)
      .toContain('```\nFallback result\n```');
  });

  it('does not replace failure text with a success preview', () => {
    const element = createToolResultElement({ tool_use_id: 'web', content: 'Failed', is_error: true,
      webSearch: { results: [{ title: 'Stale result' }], omittedResults: 0 } });
    expect(element[0].elements[0].content).toBe('Failed');
  });

  it('bounds untrusted peer data and reports extra or malformed entries', () => {
    const text = webSearchResultMarkdown({ results: [null, [], {},
      { title: '\u001b[31m\u202e' + '🧪'.repeat(200), snippet: 'x'.repeat(300) },
      { snippet: 'Excerpt only' }, { title: 'Extra' }], omittedResults: 2 })!;
    expect(text).toContain('🧪'.repeat(159) + '…');
    expect(text).toContain('x'.repeat(239) + '…');
    expect(text).toContain('Web result');
    expect(text).toContain('6 additional result entries omitted');
    expect(text).not.toMatch(/\u001b|\u202e|Extra/);
    expect(webSearchResultMarkdown({ results: [], omittedResults: 0 })).toBe('No result entries were returned by the backend.');
  });

  it.each(['javascript:alert(1)', 'file:///etc/example', 'https://user:secret@example.com/',
    'https://example.com/\npath', 'https://example.com/\u202epath', 'not a URL', 'https://example.com/' + 'x'.repeat(2100), 42])(
    'refuses unsafe links even from a future peer (%j)', url => {
      expect(webSearchResultMarkdown({ results: [{ title: 'Readable', url }], omittedResults: 0 }))
        .toBe('**1.** <raw>Readable</raw>');
    });

  it('escapes URL delimiters without modifying the source destination', () => {
    const text = webSearchResultMarkdown({ results: [{ url: "https://example.com/a(b)?q='[x]'" }], omittedResults: 0 })!;
    expect(text).toContain('[Open source](https://example.com/a%28b%29?q=%27%5Bx%5D%27)');
  });

  it('shows literal search, open and find context without extra detail elements', () => {
    expect(extractToolContext('WebSearch', { query: '<at id=all>', action: 'findInPage',
      url: 'https://example.com/docs', pattern: '**pattern**', queries: ['first', 42, 'second'], omittedQueries: 3 }))
      .toBe('**Query:** <raw>&lt;at id=all&gt;</raw>\n**Action:** findInPage\n**URL:** <raw>https://example.com/docs</raw>\n**Pattern:** <raw>**pattern**</raw>\n**Search:** <raw>first</raw>\n**Search:** <raw>second</raw>\n3 additional queries omitted.');
  });
});
