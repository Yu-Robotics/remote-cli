import { describe, expect, it } from 'vitest';
import { createDiffPanels, createEditPanels, createWritePanels } from '../src/utils/DiffFormatter';
import { createToolResultElement } from '../src/utils/ToolFormatter';

function preview(panel: any): string {
  return panel.elements.find((element: any) => element.content?.startsWith('**Copyable diff preview'))?.content ?? '';
}

describe('DiffFormatter', () => {
  it('renders a diff-only result with explicit red/green lines and a file summary', () => {
    const panels = createToolResultElement({ tool_use_id: 'edit', content: '', is_error: false,
      diff: '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new' });
    expect(panels).toHaveLength(1);
    expect(panels[0].header.title.content).toContain('src/app.ts');
    expect(panels[0].header.title.content).toContain("<font color='green'>+1</font>");
    expect(panels[0].header.title.content).toContain("<font color='red'>−1</font>");
    const colored = panels[0].elements.find((element: any) => element.content?.startsWith('<font'));
    expect(colored.content).toContain("<font color='red'>-old</font>");
    expect(colored.content).toContain("<font color='green'>+new</font>");
    expect(preview(panels[0])).toContain('-old\n+new');
  });

  it('shows an edit near the end of a long snippet instead of truncating before it', () => {
    const old = Array.from({ length: 220 }, (_, i) => `const value${i + 1} = 1;`);
    const changed = [...old];
    changed[210] = 'const value211 = 2;';
    const panel = createEditPanels({ file_path: 'app.ts', old_string: old.join('\n'), new_string: changed.join('\n') }, 'Edit')![0];
    expect(preview(panel)).toContain('-const value211 = 1;\n+const value211 = 2;');
    expect(preview(panel)).toContain('@@ -208,7 +208,7 @@');
    expect(preview(panel)).not.toContain('const value1 =');
    expect(preview(panel)).not.toContain('omitted');
    expect(panel.elements[0].content).toContain('relative to the edited snippet');
  });

  it('compacts native full-file hunks while preserving real source line numbers', () => {
    const lines = Array.from({ length: 220 }, (_, i) => ` line${i + 1}`);
    lines.splice(210, 1, '-old', '+new');
    const panel = createDiffPanels(`--- a/a.ts\n+++ b/a.ts\n@@ -101,220 +101,220 @@\n${lines.join('\n')}`, 'Updated')[0];
    expect(preview(panel)).toContain('@@ -308,7 +308,7 @@');
    expect(preview(panel)).toContain('-old\n+new');
    expect(preview(panel)).not.toContain(' line1\n');
  });

  it('normalizes ACP old/new text and leaves unchanged lines out of change counts', () => {
    const panel = createDiffPanels('--- a/app.ts\n+++ b/app.ts\n-keep\n-old\n-tail\n+keep\n+new\n+tail', 'Updated')[0];
    expect(panel.header.title.content).toContain('+1</font>');
    expect(panel.header.title.content).toContain('−1</font>');
    expect(preview(panel)).toContain(' keep');
    expect(preview(panel)).not.toContain('-keep');
  });

  it('gives later files their own budget and shows both sides of a large replacement', () => {
    const large = [...Array.from({ length: 300 }, (_, i) => `-old${i}`), ...Array.from({ length: 300 }, (_, i) => `+new${i}`)];
    const diff = `--- a/first.ts\n+++ b/first.ts\n@@ -1,300 +1,300 @@\n${large.join('\n')}\n--- a/second.ts\n+++ b/second.ts\n@@ -1 +1 @@\n-before\n+after`;
    const panels = createDiffPanels(diff, 'Updated');
    expect(panels).toHaveLength(2);
    expect(panels[0].header.title.content).toContain('+300');
    expect(preview(panels[0])).toContain('-old0');
    expect(preview(panels[0])).toContain('+new0');
    expect(preview(panels[0])).toContain('omitted');
    expect(panels[1].header.title.content).toContain('second.ts');
    expect(preview(panels[1])).toContain('-before\n+after');
    expect(JSON.stringify(panels).length).toBeLessThan(40000);
  });

  it('escapes source markup and preserves original indentation in the copyable preview', () => {
    const code = '\t  <at id=all></at> **bold** [link](https://example.com) & `code`';
    const panel = createEditPanels({ file_path: '<at id=all>.ts', old_string: 'old', new_string: code }, 'Edit')![0];
    const colored = panel.elements.find((element: any) => element.content?.startsWith('<font')).content;
    expect(colored).not.toContain('<at');
    expect(colored).not.toContain('**bold**');
    expect(colored).toContain('&#60;at');
    expect(colored).toContain('\u00a0'.repeat(6));
    expect(panel.header.title.content).not.toContain('<at');
    expect(preview(panel)).toContain(`+${code}`);
  });

  it.each([
    ['--- a/new.ts\n+++ b/new.ts\n@@ -0,0 +1 @@\n+created', '@@ -0,0 +1,1 @@'],
    ['--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-removed', '@@ -1,1 +0,0 @@'],
  ])('preserves insertion and deletion positions', (diff, header) => {
    const panel = createDiffPanels(diff, 'Updated')[0];
    expect(preview(panel)).toContain(header);
    expect(panel.header.title.content).not.toContain('/dev/null');
  });

  it('reports omitted files and hunks instead of silently dropping them', () => {
    const hunk = (i: number) => `@@ -${i * 10 + 1} +${i * 10 + 1} @@\n-old\n+new`;
    const diff = Array.from({ length: 9 }, (_, file) => `--- a/f${file}.ts\n+++ b/f${file}.ts\n${Array.from({ length: 10 }, (_, i) => hunk(i)).join('\n')}`).join('\n');
    const panels = createDiffPanels(diff, 'Updated');
    expect(panels.filter((panel) => panel.tag === 'collapsible_panel')).toHaveLength(6);
    expect(JSON.stringify(panels)).toContain('3 additional files omitted');
    expect(panels[0].elements[0].content).toContain('2 additional hunks omitted');
    expect(JSON.stringify(panels).length).toBeLessThan(60000);
  });

  it('preserves malformed patch text without inventing change counts', () => {
    const panel = createDiffPanels('--- a/a.ts\n+++ b/a.ts\n@@ invalid @@\n-old\n+new', 'Updated')[0];
    expect(preview(panel)).toContain('@@ invalid @@');
    expect(panel.header.title.content).not.toContain('+1');
    expect(panel.elements[0].content).toContain('counts are unavailable');
  });

  it('labels unchanged input and oversized input honestly', () => {
    const same = createEditPanels({ file_path: 'same.ts', old_string: 'same', new_string: 'same' }, 'Edit')![0];
    expect(preview(same)).toBe('');
    expect(same.header.title.content).not.toContain('+');
    const huge = createWritePanels({ file_path: 'large.txt', content: 'x'.repeat(1_000_001) }, 'Write')![0];
    expect(huge.elements[0].content).toContain('too large');
    expect(JSON.stringify(huge).length).toBeLessThan(1000);
    const empty = createWritePanels({ file_path: 'cleared.txt', content: '' }, 'Write')![0];
    expect(empty.elements[0].content).toContain('Written content is empty');
    expect(JSON.stringify(empty)).not.toContain('No textual changes');
  });
});
