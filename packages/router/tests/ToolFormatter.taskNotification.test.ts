import { describe, it, expect } from 'vitest';
import { createTaskNotificationElement } from '../src/utils/ToolFormatter';
import type { TaskNotificationInfo } from '../src/types';

type CardElements = ReturnType<typeof createTaskNotificationElement>;
const details = (elements: CardElements) => elements.find(element => element.tag === 'collapsible_panel')!;
const visibleText = (elements: CardElements) => elements
  .filter(element => element.tag === 'markdown').map(element => element.content).join('\n');

describe('background task notification card', () => {
  const task: TaskNotificationInfo = {
    taskId: 'b4a2f1c9', status: 'completed', summary: 'Build finished successfully',
    outputFile: '/tmp/claude-outputs/b4a2f1c9.log',
  };

  it.each([
    ['completed', 'green'], ['failed', 'red'], ['stopped', 'orange'],
  ] as const)('keeps the %s outcome visible while details are collapsed', (status, color) => {
    const elements = createTaskNotificationElement({ ...task, status });
    const visible = visibleText(elements);
    expect(visible).toMatch(/background task/i);
    expect(visible).toContain(`color='${color}'`);
    expect(visible.toLowerCase()).toContain(status);
    expect(details(elements)).toMatchObject({
      expanded: false, header: { title: { tag: 'markdown', content: expect.stringMatching(/details/i) } },
    });
  });

  it('keeps task and thread context visible with rich results and output inside details', () => {
    const elements = createTaskNotificationElement({ ...task,
      summary: '# Build result\n\n**Passed** all checks.\n\n- [Report](https://example.com/report)\n\n```sh\nnpm test\n```',
    }, 'refactor-login');
    const visible = visibleText(elements);
    expect(visible).toContain(task.taskId);
    expect(visible).toContain('refactor-login');
    expect(visible).not.toContain('Build result');
    expect(visible).not.toContain(task.outputFile);
    const body = details(elements).elements[0];
    expect(body).toMatchObject({
      tag: 'markdown', content: expect.stringMatching(/^# Build result\n/),
    });
    expect(body.content).toContain('**Passed**');
    expect(body.content).toContain('[Report](https://example.com/report)');
    expect(body.content).toContain('```sh\nnpm test\n```');
    expect(body.content).toContain(task.outputFile);
    expect(visible).toMatch(/reply.*card.*thread/i);
    const withoutThread = visibleText(createTaskNotificationElement(task));
    expect(withoutThread).toContain(task.taskId);
    expect(withoutThread).not.toContain('refactor-login');
  });

  it.each([
    ['plain text', 'x'.repeat(3000), 'x'.repeat(1501)],
    ['Unicode', '🧪'.repeat(3000), '🧪'.repeat(1501)],
    ['fenced code', '```sh\n' + 'x'.repeat(3000) + '\n```', 'x'.repeat(1501)],
  ])('bounds %s details and marks omitted content', (kind, summary, omitted) => {
    const content = details(createTaskNotificationElement({ ...task, summary })).elements[0].content;
    expect(content.length).toBeLessThan(10000);
    expect(content).toMatch(/truncated/i);
    expect(content).not.toContain(omitted);
    if (kind === 'fenced code') expect(content.match(/```/g)).toHaveLength(2);
  });

  it('does not expose a surrogate pair split at the failure-preview input boundary', () => {
    const elements = createTaskNotificationElement({ ...task, status: 'failed', summary: ' '.repeat(3001) + '🧪' });
    expect(visibleText(elements)).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(details(elements).elements[0].content).toMatch(/truncated/i);
  });

  it.each(['completed', 'failed'] as const)('handles an empty %s result without inventing content', status => {
    const elements = createTaskNotificationElement({ ...task, status, summary: '', outputFile: '' });
    const body = details(elements).elements[0].content;
    expect(body).toMatch(/no summary/i);
    expect(body).not.toContain('Output:');
    expect(body).not.toContain(task.outputFile);
    if (status === 'failed') expect(visibleText(elements)).toMatch(/no failure summary/i);
  });

  it('shows a bounded plain-text failure summary without expanding full output', () => {
    const summary = '# Failure\n\n**Authentication failed**: session expired.\n\n```text\n' + 'log '.repeat(1000);
    const elements = createTaskNotificationElement({ ...task, status: 'failed', summary });
    const preview = elements.find(element => element.tag === 'markdown' && element.content.includes('Authentication failed'))!;
    expect(preview.content.length).toBeLessThan(250);
    expect(preview.content).not.toContain('\n');
    expect(preview.content).not.toContain('**Authentication failed**');
    expect(preview.content).toContain('session expired');
    expect(preview.content).not.toContain(task.outputFile);
    expect(details(elements).expanded).toBe(false);
    expect(visibleText(createTaskNotificationElement({ ...task, summary }))).not.toContain('Authentication failed');
  });

  it('renders untrusted context, failure text, and output paths without creating card markup', () => {
    const injection = '</raw><at id="all">Notify everyone</at>';
    const elements = createTaskNotificationElement({
      taskId: injection, status: 'failed', summary: `Failure: ${injection}`,
      outputFile: `/tmp/${injection}.log`,
    }, `thread\n${injection}`);
    const serialized = JSON.stringify(elements);
    expect(serialized).not.toContain('<at');
    expect(serialized).toContain('&lt;');
    expect(details(elements).expanded).toBe(false);
    expect(visibleText(elements)).not.toContain('/tmp/');
  });

  it.each(['future-status', 'constructor', '__proto__'])('keeps unknown status %s neutral', status => {
    const visible = visibleText(createTaskNotificationElement({ ...task, status: status as any }));
    expect(visible).toContain("color='grey'");
    expect(visible).toMatch(/ended/i);
    expect(visible).not.toMatch(/stopped|failed|completed/i);
  });
});
