import { describe, it, expect } from 'vitest';
import {
  formatToolUseMessage,
  formatToolResultMessage,
  createResponseSeparator,
  createToolUseCard,
  createToolResultCard,
  createDividerElement,
  createMarkdownElement,
} from '../src/utils/FeishuMessageFormatter';

describe('FeishuMessageFormatter', () => {
  describe('formatToolUseMessage', () => {
    it('keeps both the Bash description and command in a compact tool indicator', () => {
      const output = formatToolUseMessage({
        name: 'Bash', id: 'tool-1', input: { command: 'ls -la', description: 'List files' },
      });
      expect(output).toContain('**Bash**');
      expect(output).toContain('List files');
      expect(output).toContain('ls -la');
      expect(output).not.toContain('>');
    });

    it('shows the Bash command when no description is available', () => {
      expect(formatToolUseMessage({ name: 'Bash', id: 'tool-1', input: { command: 'npm test' } }))
        .toContain('`npm test`');
    });

    it.each([
      ['command', 80], ['description', 70],
    ] as const)('bounds long Bash %s text', (field, limit) => {
      const output = formatToolUseMessage({
        name: 'Bash', id: 'tool-1', input: { [field]: 'a'.repeat(100) },
      });
      expect(output).toContain('...');
      expect(output.length).toBeLessThan(limit);
    });

    it.each(['Read', 'Write', 'Edit'])('keeps the %s tool name and file path', name => {
      const output = formatToolUseMessage({ name, id: 'tool-1', input: { file_path: '/path/to/file.txt' } });
      expect(output).toContain(`**${name}**`);
      expect(output).toContain('`/path/to/file.txt`');
    });

    it.each([
      { name: 'Grep', input: { pattern: 'searchTerm', path: '/src' }, expected: ['`searchTerm`', '`/src`'] },
      { name: 'Glob', input: { pattern: '*.ts' }, expected: ['`*.ts`'] },
      { name: 'WebFetch', input: { url: 'https://example.com/api' }, expected: ['`https://example.com/api`'] },
      { name: 'Task', input: { prompt: 'Analyze this code', subagent_type: 'code-reviewer' }, expected: ['Analyze this code'] },
      { name: 'TodoWrite', input: { todos: [
        { content: 'Task 1', status: 'in_progress' }, { content: 'Task 2', status: 'pending' },
      ] }, expected: ['2 item(s)'] },
      { name: 'AskUserQuestion', input: { question: 'Which option do you prefer?' }, expected: ['Which option do you prefer?'] },
    ])('extracts meaningful context for $name', ({ name, input, expected }) => {
      const output = formatToolUseMessage({ name, id: 'tool-1', input });
      expect(output).toContain(`**${name}**`);
      for (const text of expected) expect(output).toContain(text);
    });

    it.each(['UnknownTool', 'Edit', 'Grep', 'Glob'])('keeps the %s name and generic description when specialized context is missing', name => {
      const output = formatToolUseMessage({
        name, id: 'tool-1', input: { description: 'Custom task' },
      });
      expect(output).toContain(`**${name}**`);
      expect(output).toContain('Custom task');
    });

    it.each(['Write', 'Task'])('omits unrelated parameters when %s has no useful context', name => {
      const output = formatToolUseMessage({
        name, id: 'tool-1', input: { param1: 'value1', param2: 'value2' },
      });
      expect(output).toContain(`**${name}**`);
      expect(output).not.toContain('param1');
      expect(output).not.toContain('value1');
    });

    it('keeps the filename visible when shortening a long file path', () => {
      const output = formatToolUseMessage({ name: 'Read', id: 'tool-1',
        input: { file_path: '/project/components/deep/nested/directory/very-long-file-name.ts' } });
      expect(output).toContain('very-long-file-name.ts');
      expect(output).toContain('...');
    });
  });

  describe('formatToolResultMessage', () => {
    it('reports success without repeating short or long result bodies', () => {
      for (const content of ['Operation completed successfully', 'a'.repeat(300)]) {
        const output = formatToolResultMessage({ id: 'tool-1', content, isError: false });
        expect(output).toMatch(/done|success|complete/i);
        expect(output).not.toMatch(/failed|error/i);
        expect(output).not.toContain(content);
        expect(output).not.toContain('>');
        expect(output.length).toBeLessThan(50);
      }
    });

    it('includes failure details', () => {
      const output = formatToolResultMessage({
        id: 'tool-1', content: 'Error: Something went wrong', isError: true,
      });
      expect(output).toMatch(/failed/i);
      expect(output).toContain('Error: Something went wrong');
    });

    it('bounds long error details', () => {
      const output = formatToolResultMessage({ id: 'tool-1', content: 'a'.repeat(300), isError: true });
      expect(output).toMatch(/failed/i);
      expect(output).toContain('...');
      expect(output.length).toBeLessThan(250);
    });
  });

  describe('tool cards', () => {
    it('renders tool parameters as Markdown with the tool identity and ID', () => {
      const card = createToolUseCard({
        name: 'Bash', id: 'tool-unique', input: { command: 'npm test', description: 'Run tests' },
      });
      expect(card).toMatchObject({
        config: { wide_screen_mode: true },
        header: { template: 'blue', title: { tag: 'plain_text', content: expect.stringContaining('Bash') } },
      });
      expect(card.elements.map((element: any) => element.tag)).toEqual(['markdown', 'note']);
      expect(card.elements[0].content).toContain('npm test');
      expect(card.elements[0].content).toContain('Run tests');
      expect(card.elements[1].elements[0]).toMatchObject({
        tag: 'plain_text', content: expect.stringContaining('tool-unique'),
      });
    });

    it.each([
      [false, 'green', 'Success'], [true, 'red', 'Failed'],
    ] as const)('distinguishes result card state (isError=%s)', (isError, template, status) => {
      const card = createToolResultCard({ id: 'tool-1', content: 'Result details', isError });
      expect(card).toMatchObject({
        config: { wide_screen_mode: true },
        header: { template, title: { tag: 'plain_text', content: expect.stringContaining(status) } },
      });
      expect(card.elements[0]).toEqual({ tag: 'markdown', content: 'Result details' });
      expect(card.elements[1].elements[0].content).toContain('tool-1');
    });

    it('bounds card content to the Feishu limit', () => {
      const card = createToolResultCard({ id: 'tool-1', content: 'x'.repeat(5000), isError: false });
      expect(card.elements[0]).toEqual({ tag: 'markdown', content: 'x'.repeat(4000) });
    });
  });

  it('preserves response boundaries and Markdown element content, including empty content', () => {
    expect(createResponseSeparator()).toBe('\n\n');
    expect(createDividerElement()).toEqual({ tag: 'hr' });
    for (const content of ['**Bold text** and `code`', '']) {
      expect(createMarkdownElement(content)).toEqual({ tag: 'markdown', content });
    }
  });
});
