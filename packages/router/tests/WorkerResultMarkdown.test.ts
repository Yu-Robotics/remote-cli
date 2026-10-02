import { describe, expect, it } from 'vitest';
import MarkdownIt from 'markdown-it';
import { formatWorkerResultMarkdown } from '../src/utils/WorkerResultMarkdown';

const parser = new MarkdownIt({ html: false });
const render = (source: string, limit?: number) => parser.render(formatWorkerResultMarkdown(source, limit));

describe('worker result Markdown', () => {
  it('preserves headings, paragraphs, emphasis, lists, quotes, and links', () => {
    const source = '## **Review**\n\nFirst paragraph.\n\n**Passed** and *verified*.\n\n- One\n- Two\n\n3. Three\n4. Four\n\n> Note\n\n[Details](https://example.com/review)';
    expect(render(source)).toBe(parser.render(source));
  });

  it('preserves nested and multi-paragraph list items', () => {
    const source = '- Parent\n  - Child\n\n  More details.\n- Next';
    expect(render(source)).toBe(parser.render(source));
  });

  it.each(['- Parent\n  - Child\n- Next', '1. Parent\n   - Child\n2. Next', '- **Parent**\n  > Note\n- Next'])('preserves tight list spacing: %s', source => {
    expect(render(source)).toBe(parser.render(source));
  });

  it('keeps escaped Markdown punctuation literal', () => {
    const source = '\\*\\*plain\\*\\* \\[label\\](https://example.com)';
    expect(render(source)).toBe(parser.render(source));
  });

  it.each(['\\# Plain heading', '\\- Plain list', 'Plain\n\\===', '\\![caption](https://example.com/image.png)'])('does not reinterpret escaped block syntax: %s', source => {
    expect(render(source)).toBe(parser.render(source));
  });

  it('neutralizes Feishu tags and entity-encoded tags while preserving formatting', () => {
    const result = formatWorkerResultMarkdown('**Safe**\n\n<at id=all></at> <raw>raw</raw> <font color=red>red</font> &lt;at id=all&gt;');
    expect(result).toContain('**Safe**');
    expect(result).toContain('&lt;at id\\=all&gt;');
    expect(result).not.toMatch(/<(?:at|raw|font)\b/);
    expect(parser.render(result)).toContain('&lt;at id=all&gt;');
  });

  it('limits links to web and email destinations', () => {
    const result = formatWorkerResultMarkdown('[web](https://example.com/a_(b)) [mail](mailto:user@example.com) [file](file:///tmp/report.md) [script](javascript:alert(1))');
    const html = parser.render(result);
    expect(html).toContain('href="https://example.com/a_%28b%29"');
    expect(html).toContain('href="mailto:user@example.com"');
    expect(html).not.toContain('href="file:');
    expect(html).not.toContain('href="javascript:');
  });

  it('retains labels for unsupported application links', () => {
    const result = formatWorkerResultMarkdown('[**Open file**](vscode://file/tmp/report.md) [Call](tel:1234)');
    expect(parser.render(result)).toBe('<p><strong>Open file</strong> Call</p>\n');
  });

  it('preserves separators and strikethrough', () => {
    const source = '~~Old finding~~\n\n---\n\nNew finding';
    expect(render(source)).toBe(parser.render(source));
  });

  it('handles reference links and autolinks without exposing their source definitions', () => {
    const source = '[**Report**][ref]\n\n<https://example.com>\n\n[ref]: https://example.com/report';
    expect(render(source)).toBe(parser.render(source));
  });

  it('reduces images to their captions instead of creating remote or local image references', () => {
    const result = formatWorkerResultMarkdown('![Chart](./chart.png)\n\n![Remote](https://example.com/image.png)');
    expect(result).toBe('Chart\n\nRemote');
    expect(parser.render(result)).not.toContain('<img');
  });

  it('provides visible fallback text for captionless images and empty results', () => {
    expect(formatWorkerResultMarkdown('![](./chart.png)')).toBe('Image');
    expect(formatWorkerResultMarkdown(' \n\t\u0000')).toBe('_No text result._');
  });

  it('labels bounded streaming activity previews independently of final results', () => {
    expect(formatWorkerResultMarkdown('x'.repeat(801), 800, 'activity'))
      .toBe('x'.repeat(800) + '\n\n_Activity preview truncated._');
    expect(formatWorkerResultMarkdown(' ', 800, 'activity')).toBe('_No activity text yet._');
  });

  it.each(['`value`', '``a`b``', '`` `value` ``', '` `', '```ts\nconst x = `<at id=all>`;\n```', '    indented code\n'])('preserves code contents for %s', source => {
    expect(render(source)).toBe(parser.render(source));
  });

  it('closes a truncated code fence before displaying the truncation notice', () => {
    const result = formatWorkerResultMarkdown('```ts\n' + 'x'.repeat(100), 30);
    const html = parser.render(result);
    expect(html).toContain('</code></pre>\n<p><em>Result preview truncated.</em></p>');
    expect(html).not.toContain('x'.repeat(100));
  });

  it('normalizes line endings and removes controls without merging paragraphs', () => {
    expect(formatWorkerResultMarkdown('First\u0000\r\n\r\nSecond\u001b')).toBe('First\n\nSecond');
  });

  it('bounds Unicode by code point without leaving a broken surrogate', () => {
    const result = formatWorkerResultMarkdown('🙂'.repeat(1001));
    expect(result).toBe('🙂'.repeat(1000) + '\n\n_Result preview truncated._');
  });
});
