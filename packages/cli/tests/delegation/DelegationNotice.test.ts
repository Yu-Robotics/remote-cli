import { describe, expect, it } from 'vitest';
import { formatDelegationNotice } from '../../src/delegation/DelegationNotice';
import type { DelegatedTaskRecord } from '../../src/delegation/DelegationStore';

const task: DelegatedTaskRecord = {
  id: 'task-1', threadId: 'parent', parentMessageId: 'message-1', backend: 'claude',
  objective: 'Review the proposed changes', state: 'succeeded', startedAt: 1000, finishedAt: 69000,
  output: 'Private worker transcript must not be repeated in the status notice.',
};

describe('delegation result notices', () => {
  it('distinguishes a never-started cancellation from elapsed execution', () => {
    const notice = formatDelegationNotice({ ...task, state: 'cancelled', startedAt: undefined,
      acceptedAt: 1000, error: 'Cancelled before the worker started.' });
    expect(notice).toContain('Not started');
    expect(notice).toContain('Cancelled before');
    expect(notice).not.toContain('1m 8s');
  });

  it('identifies the DSH worker', () => {
    expect(formatDelegationNotice({ ...task, backend: 'dsh' })).toContain('DSH · Delegated task');
  });

  it('identifies the worker and task without duplicating its answer', () => {
    const notice = formatDelegationNotice(task);
    expect(notice).toContain('Claude Code · Delegated task');
    expect(notice).toContain('Review the proposed changes');
    expect(notice).toContain('1m 8s');
    expect(notice).not.toContain(task.output);
    expect(notice).not.toContain('Reason:');
  });

  it.each([
    ['succeeded', 'Completed', 'green'], ['failed', 'Failed', 'red'],
    ['timed_out', 'Timed out', 'orange'], ['cancelled', 'Cancelled', 'neutral'],
    ['interrupted', 'Interrupted', 'orange'],
  ] as const)('shows the actual %s outcome', (state, label, color) => {
    const notice = formatDelegationNotice({ ...task, state, error: 'Native failure details' });
    expect(notice).toContain(`color='${color}'`);
    expect(notice).toContain(label);
    if (state !== 'succeeded') {
      expect(notice).toContain('**Reason:** <raw>Native failure details</raw>');
      expect(notice).not.toContain('Completed');
    }
  });

  it('keeps task and error text literal instead of injecting mentions, images, or layout', () => {
    const text = '\u001b[31m</raw><at id=all></at>\n![image](file.png) **status** & text\u001b[0m\u0000';
    const notice = formatDelegationNotice({ ...task, state: 'failed', objective: text, error: text });
    expect(notice).toContain('<raw>&lt;/raw&gt;&lt;at id=all&gt;&lt;/at&gt; ![image](file.png) **status** &amp; text</raw>');
    expect(notice).not.toContain('<at id=all>');
    expect(notice).not.toContain('\u001b');
    expect(notice).not.toContain('\u0000');
    expect(notice.split('\n').filter(line => line.startsWith('>'))).toHaveLength(3);
  });

  it('bounds long details without breaking Unicode and leaves the original record intact', () => {
    const record = { ...task, state: 'failed' as const, objective: '🚀'.repeat(500), error: '🚀'.repeat(5000) };
    const notice = formatDelegationNotice(record);
    expect(notice).toContain(`<raw>${'🚀'.repeat(159)}…</raw>`);
    expect(notice).toContain(`<raw>${'🚀'.repeat(399)}…</raw>`);
    expect(notice).not.toContain('\ufffd');
    expect(record.error).toHaveLength(10000);
  });

  it('does not invent a failure reason when the backend provides none', () => {
    const notice = formatDelegationNotice({ ...task, state: 'failed', error: '  ' });
    expect(notice).toContain('No error details were returned by the backend.');
  });
});
