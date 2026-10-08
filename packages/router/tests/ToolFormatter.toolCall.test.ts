import { describe, expect, it } from 'vitest';
import { createToolCallElement, createToolCallSummary, createToolResultElement, createToolUseElement,
  type FeishuCardElement } from '../src/utils/ToolFormatter';

const input = () => createToolUseElement({ name: 'Read', id: 'read-1', input: { file_path: '/project/example.ts' } });
const result = (is_error = false, content = 'Example output') => createToolResultElement({ tool_use_id: 'read-1', is_error, content });

function countTags(value: any): number {
  if (!value || typeof value !== 'object') return 0;
  return (value.tag ? 1 : 0) + Object.values(value).reduce<number>((sum, child) => sum + countTags(child), 0);
}

describe('single tool-call disclosure', () => {
  it.each(['Inspect working changes', 'Read config.ts', 'Search files', 'List directory',
    'Run npm command', 'Run Git command', 'Run shell command', 'Search files / Run shell command',
    'Read aaaaaaaa… / Read b.ts / Search files / +1 more'])(
    'keeps native command descriptions in the existing heading without adding nodes (%s)', description => {
      const tool = { name: 'Bash', id: 'native-command', input: { command: 'synthetic-private-command' }, description };
      const base = { name: tool.name, id: tool.id, inputElements: createToolUseElement(tool) };
      const summary = createToolCallSummary(tool);
      for (const completed of [{}, { resultElements: result() }, { resultElements: result(true), isError: true }]) {
        const plain = createToolCallElement({ ...base, ...completed });
        const described = createToolCallElement({ ...base, summary, ...completed });
        expect(described.header.title.content).toContain(` · <raw>${description}</raw>`);
        expect(described.header.title.content).not.toContain(tool.input.command);
        expect(countTags(described)).toBe(countTags(plain));
      }
    });

  it.each([
    ['Read', { file_path: '/project/config.ts' }, 'config.ts'],
    ['Bash', { description: 'Run tests', command: 'npm test' }, 'Run tests'],
  ])('uses the same compact heading for %s in every state', (name, args, summary) => {
    const tool = { name: name as string, id: 'full-tool-identifier', input: args };
    const state = { name: tool.name, id: tool.id, summary: createToolCallSummary(tool), inputElements: createToolUseElement(tool) };
    const expected = ` <raw>${name}</raw> · <raw>${summary}</raw>`;
    for (const [color, symbol, label, completed] of [
      ['blue', '•', 'Awaiting result', {}],
      ['green', '•', 'Succeeded', { resultElements: result() }],
      ['red', '•', 'Failed', { resultElements: result(true), isError: true }],
    ] as const) {
      const panel = createToolCallElement({ ...state, ...completed });
      expect(panel.header.title.content).toBe(`<font color='${color}'>${symbol}</font>${expected}`);
      expect(panel.header.title.content).not.toMatch(/SUCCESS|ERROR|TOOL USE|full-tool-identifier|text_tag/);
      expect(panel.header.icon.token).toBe('down-small-ccm_outlined');
      expect(panel.elements[0].content).toContain(`**Status:** ${label}`);
      expect(panel.elements[0].content).toContain('**Tool ID:** <raw>full-tool-identifier</raw>');
      expect(countTags(panel)).toBe('resultElements' in completed ? 5 : 4);
    }
  });

  it.each([
    ['Read', { file_path: '/project/config.ts', description: 'Read configuration' }, 'Read configuration'],
    ['Edit', { path: 'src/app.ts' }, 'app.ts'],
    ['Write', { file_path: 'C:\\project\\app.ts' }, 'app.ts'],
    ['NotebookEdit', { notebook_path: '/project/example.ipynb' }, 'example.ipynb'],
    ['Bash', { description: '  Run\n tests  ', command: 'private command argument' }, 'Run tests'],
    ['Other', { title: 'Inspect results' }, 'Inspect results'],
    ['Bash', { description: '\u0000', title: 'Fallback title' }, 'Fallback title'],
    ['Bash', { command: 'private command argument' }, undefined],
    ['Other', { url: 'https://example.com/private-query', query: 'private query' }, undefined],
    ['Read', { file_path: '..', description: 'Inspect parent' }, 'Inspect parent'],
    ['Read', null, undefined],
    ['Other', ['unexpected'], undefined],
    ['Other', { description: 42, title: {} }, undefined],
  ])('selects only an explicit label or basename for %s (%j)', (name, args, expected) => {
    expect(createToolCallSummary({ name: name as string, input: args })).toBe(expected);
  });

  it.each([
    [{ description: 'Inspect configuration', title: 'Read file', input: { description: 'Input description', file_path: '/project/config.ts' } }, 'Inspect configuration'],
    [{ title: 'Native title', input: { description: 'Input description' } }, 'Input description'],
    [{ title: 'Run unit tests', input: { command: 'npm test', title: 'Input title' } }, 'Run unit tests'],
    [{ title: '  Run\n tests  ', input: {} }, 'Run tests'],
    [{ description: 42, title: {}, input: { description: 'Input description' } }, 'Input description'],
    [{ description: '\u0000', title: 'Useful title', input: {} }, 'Useful title'],
    [{ title: 'read', input: { file_path: '/project/config.ts' } }, 'config.ts'],
    [{ title: '/project/config.ts', input: { file_path: '/project/config.ts' } }, 'config.ts'],
    [{ title: 'Read', input: {} }, undefined],
    [{ input: { command: 'private command argument', url: 'https://example.com/private-query', query: 'private query' } }, undefined],
  ])('prefers meaningful per-call labels over file basenames without repeating the tool name (%j)', (fields, expected) => {
    expect(createToolCallSummary({ id: 'call-1', name: 'Read', ...fields } as any)).toBe(expected);
  });

  it('renders native labels literally without allocating any additional card elements', () => {
    const tool = { id: 'call-1', name: 'Bash', input: { command: 'npm test' }, title: '<at id=all>Run tests</at>' };
    const base = { name: tool.name, id: tool.id, inputElements: createToolUseElement(tool) };
    const plain = createToolCallElement(base);
    const labelled = createToolCallElement({ ...base, summary: createToolCallSummary(tool) });
    expect(countTags(labelled)).toBe(countTags(plain));
    expect(labelled.header.title.content).toContain('<raw>&lt;at id=all&gt;Run tests&lt;/at&gt;</raw>');
    expect(labelled.header.title.content).not.toContain('npm test');
    expect(labelled.header.title.content).not.toContain('<at id=all>');
  });

  it('bounds and escapes headings without exposing commands, directory prefixes, controls, or mentions', () => {
    const summary = createToolCallSummary({ name: 'Bash', input: { description: '\u001b[31m<at id=all>\u202e ' + '🧪'.repeat(80), command: 'private command argument' } })!;
    expect(Array.from(summary)).toHaveLength(60);
    expect(summary.endsWith('…')).toBe(true);
    expect(summary).not.toMatch(/[\u001b\u202e\r\n]/);
    expect(summary).not.toContain('private command argument');
    const panel = createToolCallElement({ name: '<font color=red>Bash</font>', summary, id: '<at id=all>', inputElements: input() });
    expect(panel.header.title.content).toContain('&lt;at id=all&gt;');
    expect(panel.header.title.content).toContain('&lt;font color=red&gt;');
    expect(panel.header.title.content).not.toContain('<at id=all>');
    expect(panel.header.title.content).not.toContain('/project/');
    expect(JSON.stringify(panel.elements)).toContain('**Tool ID:** <raw>&lt;at id=all&gt;</raw>');
    expect(createToolCallElement({ name: 'Bash', summary: '\n\t' }).header.title.content).toBe("<font color='blue'>•</font> <raw>Bash</raw>");
    expect(createToolCallElement({ name: 'x'.repeat(100), summary: 'y'.repeat(1000) }).header.title.content).not.toContain('y'.repeat(61));
  });

  it.each([
    'call  opaque-identifier-123',
    ' call  opaque-identifier-123 ',
    'call\u00a0\u00a0opaque-identifier-123',
    '<at id=all>call  opaque & id</at>',
    'x'.repeat(200),
  ])('preserves the complete opaque Tool ID literally in expanded details (%j)', id => {
    const panel = createToolCallElement({ name: 'Read', id, inputElements: input(), resultElements: result() });
    const escapedId = id.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    expect(panel.elements[0].content).toContain(`**Tool ID:** <raw>${escapedId}</raw>\n`);
    expect(panel.header.title.content).not.toContain(escapedId);
    expect(countTags(panel)).toBe(5);
  });

  it('keeps input and output in one collapsed row with fewer tagged nodes', () => {
    const inputElements = input();
    const resultElements = result();
    const panel = createToolCallElement({ name: 'Read', id: 'read-1', inputElements, resultElements, isError: false });
    expect(panel.tag).toBe('collapsible_panel');
    expect(panel.expanded).toBe(false);
    expect(panel.header.title.content).toContain("<font color='green'>•</font>");
    expect(panel.header.title.content).toContain('Read');
    expect(panel.elements).toHaveLength(2);
    expect(JSON.stringify(panel.elements)).toContain('**Input**');
    expect(JSON.stringify(panel.elements)).toContain('/project/example.ts');
    expect(JSON.stringify(panel.elements)).toContain('**Result**');
    expect(JSON.stringify(panel.elements)).toContain('Example output');
    expect(countTags(panel)).toBe(5);
    expect(countTags([...inputElements, ...resultElements])).toBe(9);
    expect(inputElements[1].elements[0].content).not.toContain('**Input**');
  });

  it.each([undefined, false, true])('keeps a blue pending dot before a result arrives regardless of the error flag (%s)', isError => {
    const panel = createToolCallElement({ name: 'Read', id: 'read-1', inputElements: input(), isError });
    expect(panel.header.title.content).toContain("<font color='blue'>•</font>");
    expect(panel.header.title.content).not.toContain("<font color='green'>•</font>");
    expect(panel.header.title.content).not.toContain("<font color='red'>•</font>");
    expect(panel.elements[0].content).toContain('**Status:** Awaiting result');
    expect(JSON.stringify(panel.elements)).not.toContain('**Result**');
  });

  it('keeps a stable Router-owned element identity across result updates and reused backend IDs', () => {
    const panel = createToolCallElement({ elementIndex: 7, id: 'read-1', inputElements: input() });
    const completed = createToolCallElement({ elementIndex: 7, id: 'read-1', inputElements: input(), resultElements: result() });
    const reused = createToolCallElement({ elementIndex: 8, id: 'read-1', inputElements: input() });
    expect(panel.element_id).toBe('tc_7');
    expect(completed.element_id).toBe(panel.element_id);
    expect(reused.element_id).toBe('tc_8');
    expect(createToolCallElement({}).element_id).toBeUndefined();
  });

  it('keeps failed and empty outcomes explicit without dropping the input', () => {
    const failed = createToolCallElement({ name: 'Read', inputElements: input(), resultElements: result(true, 'Permission denied'), isError: true });
    expect(failed.header.title.content).toContain("color='red'");
    expect(failed.header.title.content).toContain("<font color='red'>•</font>");
    expect(JSON.stringify(failed.elements)).toContain('Permission denied');
    expect(JSON.stringify(failed.elements)).toContain('/project/example.ts');
    const empty = createToolCallElement({ resultElements: result(false, '') });
    expect(empty.header.title.content).toContain('Tool');
    expect(JSON.stringify(empty.elements)).toContain('no output');
  });

  it('preserves bounded result previews and treats identity as literal text', () => {
    const panel = createToolCallElement({ name: '<at id=all>Read</at>', id: 'unknown', inputElements: input(), resultElements: result(false, 'x'.repeat(1000)) });
    expect(panel.header.title.content).toContain('&lt;at id=all&gt;');
    expect(panel.header.title.content).not.toContain('<at id=all>');
    expect(panel.header.title.content).not.toContain('unknown');
    expect(JSON.stringify(panel.elements)).toContain('...');
    expect(JSON.stringify(panel.elements)).not.toContain('x'.repeat(1000));
  });

  it.each(['Edit', 'Write'])('keeps %s preview metadata and copyable changes inside the same row', name => {
    const inputElements = createToolUseElement({ name, id: 'change-1', input: { file_path: '/project/app.ts',
      old_string: 'const before = 1;', new_string: 'const after = 2;', content: 'const after = 2;' } });
    const resultElements = createToolResultElement({ tool_use_id: 'change-1', content: 'Changes applied', is_error: false,
      diff: '--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-const before = 1;\n+const after = 2;' });
    const panel = createToolCallElement({ name, id: 'change-1', inputElements, resultElements, isError: false });
    expect(panel.elements.every((element: FeishuCardElement) => element.tag !== 'collapsible_panel' && element.tag !== 'hr')).toBe(true);
    const rendered = JSON.stringify(panel.elements);
    expect(rendered).toContain('/project/app.ts');
    expect(rendered).toContain('app.ts');
    expect(rendered).toContain("color='green'>+1");
    expect(rendered).toContain('Copyable diff preview');
    expect(rendered).toContain('+const after = 2;');
    expect(rendered).toContain('Changes applied');
    if (name === 'Edit') expect(rendered).toContain('-const before = 1;');
    else expect(rendered).toContain('previous file contents are unavailable');
  });

  it('preserves multi-file diffs and omissions inside one disclosure', () => {
    const diff = Array.from({ length: 7 }, (_, i) => `--- a/file-${i}.ts\n+++ b/file-${i}.ts\n@@ -1 +1 @@\n-old\n+new`).join('\n');
    const panel = createToolCallElement({ name: 'Edit', resultElements: createToolResultElement({ tool_use_id: 'change-1', content: '', diff }) });
    expect(panel.tag).toBe('collapsible_panel');
    expect(JSON.stringify(panel.elements)).toContain('file-5.ts');
    expect(JSON.stringify(panel.elements)).toContain('1 additional files omitted');
    expect(panel.elements.every((element: FeishuCardElement) => element.tag === 'markdown')).toBe(true);
  });

  it('handles non-Markdown preview children without losing content', () => {
    const panel = createToolCallElement({ inputElements: [{ tag: 'collapsible_panel', elements: [{ tag: 'img', img_key: 'img_example' }] }] });
    expect(panel.elements).toEqual([{ tag: 'markdown', content: '**Status:** Awaiting result\n\n**Input**' }, { tag: 'img', img_key: 'img_example' }]);
    const imageOnly = createToolCallElement({ inputElements: [{ tag: 'img', img_key: 'img_example' }] });
    expect(imageOnly.elements).toEqual([{ tag: 'markdown', content: '**Status:** Awaiting result' }, { tag: 'img', img_key: 'img_example' }]);
    expect(countTags(imageOnly)).toBe(5);
  });
});
