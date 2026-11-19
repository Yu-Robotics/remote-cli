import { expect, it } from 'vitest';
import { createTaskNotificationElement } from '../src/utils/ToolFormatter';

it('escapes untrusted context and output paths in the exported notification renderer', () => {
  const markup = '<at id="all">example</at>';
  const card = createTaskNotificationElement({
    taskId: markup, status: 'failed', summary: 'Error: ' + markup, outputFile: markup + '.log',
  }, markup);
  const serialized = JSON.stringify(card);
  expect(serialized).not.toContain('<at');
  expect(serialized).toContain('&lt;');
});

it.each(['Failure '.repeat(1000), ' '.repeat(3001) + '\u{1F9EA}'])(
  'bounds the failure preview without splitting a surrogate pair', summary => {
    const card = createTaskNotificationElement({ taskId: 'job', status: 'failed', summary, outputFile: '' });
    const preview = card.filter(element => element.tag === 'markdown').map(element => element.content).join('\n');
    expect(preview.length).toBeLessThan(500);
    expect(preview).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    const details = card.find(element => element.tag === 'collapsible_panel');
    expect(details?.elements[0].content).toMatch(/truncated/i);
  },
);
