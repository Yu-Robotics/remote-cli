import { describe, expect, it } from 'vitest';
import { createToolCallElement, createToolResultElement, createToolUseElement,
  type FeishuCardElement } from '../src/utils/ToolFormatter';

const input = () => createToolUseElement({ name: 'Read', id: 'read-1', input: { file_path: '/project/example.ts' } });
const result = (is_error = false, content = 'Example output') => createToolResultElement({ tool_use_id: 'read-1', is_error, content });

function countTags(value: any): number {
  if (!value || typeof value !== 'object') return 0;
  return (value.tag ? 1 : 0) + Object.values(value).reduce<number>((sum, child) => sum + countTags(child), 0);
}

describe('single tool-call disclosure', () => {
  it('keeps input and output in one collapsed row with fewer tagged nodes', () => {
    const inputElements = input();
    const resultElements = result();
    const panel = createToolCallElement({ name: 'Read', id: 'read-1', inputElements, resultElements, isError: false });
    expect(panel.tag).toBe('collapsible_panel');
    expect(panel.expanded).toBe(false);
    expect(panel.header.title.content).toContain('SUCCESS');
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

  it('does not invent success before any result arrives', () => {
    const panel = createToolCallElement({ name: 'Read', id: 'read-1', inputElements: input() });
    expect(panel.header.title.content).toContain('TOOL USE');
    expect(panel.header.title.content).not.toContain('SUCCESS');
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
    expect(failed.header.title.content).toContain('ERROR');
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
    expect(panel.elements).toEqual([{ tag: 'markdown', content: '**Input**' }, { tag: 'img', img_key: 'img_example' }]);
  });
});
