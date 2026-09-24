import { describe, it, expect } from 'vitest';
import {
  getToolEmoji,
  extractToolContext,
  createDividerElement,
  createMarkdownElement,
  createToolUseElement,
  createToolResultElement,
  formatFilePath,
  truncate,
} from '../src/utils/ToolFormatter';
import { ToolUseInfo, ToolResultInfo } from '../src/types';

function renderedDiff(elements: ReturnType<typeof createToolUseElement>): string {
  return elements.flatMap((element) => element.elements ?? [])
    .find((element) => /`{3,}diff\n/.test(element.content ?? ''))?.content ?? '';
}

describe('ToolFormatter', () => {
  describe('getToolEmoji', () => {
    it('should return correct emoji for known tools', () => {
      expect(getToolEmoji('Bash')).toBe('⚡');
      expect(getToolEmoji('Read')).toBe('📖');
      expect(getToolEmoji('Write')).toBe('✍️');
      expect(getToolEmoji('Edit')).toBe('✏️');
      expect(getToolEmoji('Grep')).toBe('🔍');
    });

    it('should return default emoji for unknown tools', () => {
      expect(getToolEmoji('UnknownTool')).toBe('🔧');
    });
  });

  describe('formatFilePath', () => {
    it('should replace home directory with ~', () => {
      const homeDir = process.env.HOME || '/Users';
      const filePath = `${homeDir}/workspace/test.ts`;
      expect(formatFilePath(filePath)).toBe('~/workspace/test.ts');
    });

    it('should keep non-home paths unchanged', () => {
      const filePath = '/tmp/test.ts';
      expect(formatFilePath(filePath)).toBe('/tmp/test.ts');
    });
  });

  describe('truncate', () => {
    it('should not truncate short strings', () => {
      const str = 'Hello';
      expect(truncate(str, 10)).toBe('Hello');
    });

    it('should truncate long strings', () => {
      const str = 'This is a very long string';
      expect(truncate(str, 10)).toBe('This is...');
    });

    it('should handle exact length', () => {
      const str = 'Exactly10!';
      expect(truncate(str, 10)).toBe('Exactly10!');
    });
  });

  describe('extractToolContext', () => {
    it('should extract Bash context', () => {
      const input = {
        command: 'npm test',
        description: 'Run tests',
      };
      const context = extractToolContext('Bash', input);
      expect(context).toContain('Run tests');
      expect(context).toContain('npm test');
    });

    it('should extract Read context', () => {
      const input = {
        file_path: '/Users/test/file.ts',
        offset: 10,
        limit: 20,
      };
      const context = extractToolContext('Read', input);
      expect(context).toContain('File:');
      expect(context).toContain('offset: 10');
      expect(context).toContain('limit: 20');
    });

    it('should extract Write context', () => {
      const input = {
        file_path: '/Users/test/file.ts',
        content: 'Line 1\nLine 2\nLine 3',
      };
      const context = extractToolContext('Write', input);
      expect(context).toContain('File:');
      expect(context).toContain('3 lines');
    });

    it('should extract Grep context', () => {
      const input = {
        pattern: 'function.*test',
        path: '/Users/test',
        glob: '*.ts',
      };
      const context = extractToolContext('Grep', input);
      expect(context).toContain('Pattern:');
      expect(context).toContain('function.*test');
      expect(context).toContain('Glob:');
    });
  });

  describe('createDividerElement', () => {
    it('should create a divider element', () => {
      const divider = createDividerElement();
      expect(divider).toEqual({ tag: 'hr' });
    });
  });

  describe('createMarkdownElement', () => {
    it('should create a markdown element', () => {
      const markdown = createMarkdownElement('# Hello World');
      expect(markdown).toEqual({
        tag: 'markdown',
        content: '# Hello World',
      });
    });
  });

  describe('createToolUseElement', () => {
    it('keeps parameter cards for edits without source text and unrelated backend tools', () => {
      const edit = createToolUseElement({ name: 'Edit', id: 'edit', input: { file_path: '/tmp/app.ts' } });
      expect(renderedDiff(edit)).toBe('');
      expect(edit[1].elements[0].content).toContain('/tmp/app.ts');

      const custom = createToolUseElement({ name: 'custom_compare', id: 'compare',
        input: { old_string: 'before', new_string: 'after' } });
      expect(renderedDiff(custom)).toBe('');
      expect(custom[1].header.title.content).toContain('custom_compare');
      expect(custom[1].elements[0].content).toContain('**old_string:** before');
      expect(custom[1].elements[0].content).toContain('**new_string:** after');
    });

    it('should create tool use elements', () => {
      const toolUse: ToolUseInfo = {
        name: 'Read',
        id: 'tool_abc123',
        input: {
          file_path: '/Users/test/file.ts',
        },
      };

      const elements = createToolUseElement(toolUse);

      expect(elements).toHaveLength(2);
      expect(elements[0]).toEqual({ tag: 'hr' });
      // Second element is now a collapsible_panel
      expect(elements[1].tag).toBe('collapsible_panel');
      expect(elements[1].header.title.content).toContain('TOOL USE');
      expect(elements[1].header.title.content).toContain('Read');
      expect(elements[1].header.title.content).toContain('tool_abc'); // Truncated ID (8 chars)
      // Content should be in the panel's elements
      expect(elements[1].elements[0].content).toContain('File:');
    });

    it('should include emoji in tool use element', () => {
      const toolUse: ToolUseInfo = {
        name: 'Bash',
        id: 'tool_xyz',
        input: { command: 'echo hello' },
      };

      const elements = createToolUseElement(toolUse);
      // Emoji should be in the header title
      expect(elements[1].header.title.content).toContain('⚡'); // Bash emoji
    });
  });

  describe('createToolResultElement', () => {
    it('should create success tool result elements with collapsible panel', () => {
      const toolResult: ToolResultInfo = {
        tool_use_id: 'tool_abc123',
        content: 'Command succeeded',
        is_error: false,
      };

      const elements = createToolResultElement(toolResult);

      expect(elements).toHaveLength(1);
      // Should be a collapsible_panel
      expect(elements[0].tag).toBe('collapsible_panel');
      expect(elements[0].expanded).toBe(false);
      // Header should contain status and tool ID
      expect(elements[0].header.title.content).toContain('SUCCESS');
      expect(elements[0].header.title.content).toContain('✅');
      expect(elements[0].header.title.content).toContain('tool_abc'); // Truncated ID (8 chars)
      // Content should be in the panel's elements
      expect(elements[0].elements[0].content).toContain('Command succeeded');
    });

    it('should create error tool result elements with collapsible panel', () => {
      const toolResult: ToolResultInfo = {
        tool_use_id: 'tool_xyz',
        content: 'Command failed',
        is_error: true,
      };

      const elements = createToolResultElement(toolResult);

      expect(elements).toHaveLength(1);
      // Should be a collapsible_panel
      expect(elements[0].tag).toBe('collapsible_panel');
      expect(elements[0].expanded).toBe(false);
      // Header should contain error status and tool ID
      expect(elements[0].header.title.content).toContain('ERROR');
      expect(elements[0].header.title.content).toContain('❌');
      // Content should be in the panel's elements
      expect(elements[0].elements[0].content).toContain('Command failed');
    });

    it('should truncate long result content', () => {
      const longContent = 'x'.repeat(1000);
      const toolResult: ToolResultInfo = {
        tool_use_id: 'tool_xyz',
        content: longContent,
        is_error: false,
      };

      const elements = createToolResultElement(toolResult);
      expect(elements).toHaveLength(1);
      expect(elements[0].tag).toBe('collapsible_panel');
      // Content should be truncated
      expect(elements[0].elements[0].content.length).toBeLessThan(longContent.length);
      expect(elements[0].elements[0].content).toContain('...');
    });

    it('should render diff results as an expanded-length diff code block', () => {
      const diff = ['--- a/src/app.ts', '+++ b/src/app.ts', '@@ -1 +1 @@', '-const oldValue = 1;', '+const newValue = 2;'].join('\n');
      const elements = createToolResultElement({
        tool_use_id: 'tool_diff',
        content: 'file_change (update): completed',
        diff,
        is_error: false,
      });

      expect(renderedDiff(elements)).toContain('-const oldValue = 1;');
      expect(elements[0].header.title.content).toContain('src/app.ts');
      expect(JSON.stringify(elements)).toContain('file_change (update): completed');
    });

    it('should render an Edit preview inside the existing tool card', () => {
      const elements = createToolUseElement({
        name: 'Edit',
        id: 'edit_1',
        input: {
          file_path: '/Users/test/src/app.ts',
          old_string: 'const oldValue = 1;\nreturn oldValue;',
          new_string: 'const newValue = 2;\nreturn newValue;',
        },
      });

      expect(elements[1].header.title.content).toContain('/Users/test/src/app.ts');
      expect(renderedDiff(elements)).toContain('-const oldValue = 1;');
      expect(renderedDiff(elements)).toContain('+const newValue = 2;');
    });

    it('should preserve unchanged lines between separate edits', () => {
      const elements = createToolUseElement({
        name: 'Edit',
        id: 'edit_multiple',
        input: {
          file_path: '/Users/test/src/app.ts',
          old_string: 'const first = 1;\nconst unchanged = true;\nconst last = 3;',
          new_string: 'const first = 2;\nconst unchanged = true;\nconst last = 4;',
        },
      });

      const rendered = renderedDiff(elements);
      expect(rendered).toContain(' const unchanged = true;');
      expect(rendered).not.toContain('-const unchanged = true;');
      expect(rendered).not.toContain('+const unchanged = true;');
      expect(rendered.indexOf('-const first = 1;')).toBeLessThan(rendered.indexOf('+const first = 2;'));
    });

    it('renders Write contents without claiming an existing file was newly created', () => {
      const elements = createToolUseElement({
        name: 'Write',
        id: 'write_1',
        input: {
          file_path: '/Users/test/src/new.ts',
          content: 'export const value = 1;\n',
        },
      });

      expect(JSON.stringify(elements)).toContain('previous file contents are unavailable');
      expect(renderedDiff(elements)).toContain('+export const value = 1;');
      expect(renderedDiff(elements)).not.toContain('/dev/null');
    });

    it('should use a longer fence when diff content contains triple backticks', () => {
      const elements = createToolResultElement({
        tool_use_id: 'tool_fence',
        content: 'file change',
        diff: '--- a/doc.md\n+++ b/doc.md\n@@ -1 +1 @@\n-```old\n+```new',
        is_error: false,
      });

      const rendered = renderedDiff(elements);
      expect(rendered).toContain('````diff\n');
      expect(rendered.endsWith('\n````')).toBe(true);
    });

    it('truncates long diffs on complete lines with an explicit notice', () => {
      const diff = Array.from({ length: 200 }, (_, index) => `+line-${index}`).join('\n');
      const elements = createToolResultElement({
        tool_use_id: 'tool_long_diff',
        content: 'file change',
        diff,
        is_error: false,
      });

      const rendered = renderedDiff(elements);
      expect(JSON.stringify(elements)).toContain('Preview shortened');
      expect(rendered).toContain('40 lines omitted');
      expect(rendered).toContain('+line-159');
      expect(rendered).not.toContain('+line-160');
    });

    it('should handle empty content', () => {
      const toolResult: ToolResultInfo = {
        tool_use_id: 'tool_xyz',
        content: '',
        is_error: false,
      };

      const elements = createToolResultElement(toolResult);

      expect(elements).toHaveLength(1);
      expect(elements[0].tag).toBe('collapsible_panel');
      // Should show "no output" placeholder
      expect(elements[0].elements[0].content).toContain('no output');
    });
  });
});
