import { describe, expect, it } from 'vitest';
import { CARD_TABLE_LIMIT, countCardTables, isCardTableLimitError, limitCardTables, plainTextCard, prepareTableElements } from '../src/utils/CardTables';

const table = (name: string) => `| Name | Value |\n| --- | --- |\n| ${name} | 1 |\n`;

describe('card table budgets', () => {
  it('counts pipe tables, quoted tables, and native tables inside containers', () => {
    const content = table('first') + '\nName | Value\n:--- | ---:\nsecond | 2\n\n'
      + table('third').trim().split('\n').map(line => `> ${line}`).join('\r\n');
    expect(countCardTables({ tag: 'collapsible_panel', elements: [
      { tag: 'markdown', content }, { tag: 'table', rows: [] },
    ] })).toBe(4);
  });

  it('leaves code examples, escaped pipes, and raw text out of the budget', () => {
    const content = ['````md', '```', table('backticks'), '```', '````',
      '~~~md', table('tildes'), '~~~', '<raw>', table('raw'), '</raw>',
      table('indented').split('\n').map(line => `    ${line}`).join('\n'),
      'Name \\| Value\n--- | ---\n'].join('\n');
    expect(countCardTables({ tag: 'markdown', content })).toBe(0);
    expect(countCardTables({ tag: 'markdown', content: '```\n' + table('unfinished code') })).toBe(0);
  });

  it('splits a large Markdown element without losing or changing any source text', () => {
    const content = Array.from({ length: 10 }, (_, index) => `Section ${index}\n\n${table(`row-${index}`)}\n`).join('');
    const source = { tag: 'markdown', text_size: 'normal', content };
    const parts = prepareTableElements([source]);
    expect(parts).toHaveLength(4);
    expect(parts.map(part => part.content).join('')).toBe(content);
    expect(source.content).toBe(content);
    parts.forEach(part => {
      expect(part.text_size).toBe('normal');
      expect(countCardTables(part)).toBeLessThanOrEqual(CARD_TABLE_LIMIT);
    });
  });

  it('keeps oversized nested containers intact and preserves excess tables as code', () => {
    const source = { tag: 'collapsible_panel', header: { title: { tag: 'markdown', content: 'Details' } },
      elements: Array.from({ length: 7 }, (_, index) => ({ tag: 'markdown', content: table(`row-${index}`) })) };
    const [prepared] = prepareTableElements([source]);
    expect(prepared.tag).toBe('collapsible_panel');
    expect(countCardTables(prepared)).toBe(3);
    expect(countCardTables(source)).toBe(7);
    for (let index = 0; index < 7; index++) expect(JSON.stringify(prepared)).toContain(`row-${index}`);
    expect(countCardTables(limitCardTables([source, { tag: 'table', rows: [{ value: 'native row' }] }]))).toBe(3);
  });

  it('uses literal text for an API fallback without losing code fences or buttons', () => {
    const source = [{ tag: 'markdown', content: `${table('visible')}\n\`\`\`ts\nconst x = 1;\n\`\`\`` },
      { tag: 'table', rows: [{ value: 'native row' }] },
      { tag: 'button', text: { tag: 'plain_text', content: 'Switch' }, value: { threadId: 'thread-2' } }];
    const result = plainTextCard(source);
    expect(countCardTables(result)).toBe(0);
    expect(result[0].content).toContain(source[0].content);
    expect(result[1].content).toContain('native row');
    expect(result[2]).toEqual(source[2]);
  });

  it('falls back only for the specific table error, not generic 400 or element limits', () => {
    const detail = { code: 230099, msg: 'ext=ErrCode: 11310; ErrMsg: card table number over limit; ErrorValue: table;' };
    expect(isCardTableLimitError({ response: { data: detail } })).toBe(true);
    expect(isCardTableLimitError(detail)).toBe(true);
    expect(isCardTableLimitError({ ...detail, code: 230020 })).toBe(false);
    expect(isCardTableLimitError({ ...detail, msg: 'ErrCode: 11310; element limit exceeded' })).toBe(false);
    expect(isCardTableLimitError(new Error('Request failed with status code 400'))).toBe(false);
  });
});
