import { describe, expect, it } from 'vitest';
import { agyHistoryDigest, isAgyVerifiedHistory, nativeEfficiencyReminder, restoreAgyVerifiedHistory,
  verifyAgyTerminalHistory } from '../../src/executor/agy/AgyRecoveredHistory';
import { NOTIFICATION_PREFIX, type TranscriptRecord } from '../../src/scheduling/agy/transcript';
import { created, syntheticHistory, tool, when } from './agyRecoveredHistoryFixture';

function mutate(rows: TranscriptRecord[], step: number, change: Partial<TranscriptRecord>): TranscriptRecord[] {
  return rows.map(row => row.step_index === step ? { ...row, ...change } : row);
}
const receipt = (value: unknown) => ({ content: JSON.stringify(value) });

describe('AGY recovered terminal history', () => {
  it('accepts settled synchronous calls, parallel ordering, the list error and static notices', () => {
    expect(() => verifyAgyTerminalHistory(syntheticHistory())).not.toThrow();
    expect(() => verifyAgyTerminalHistory([])).not.toThrow();
  });

  const rows = syntheticHistory();
  const preview = "The tool's output was truncated due to being too long. You can find the full output in a file at file:///fixture/output.txt."
    + '\n\nHere is a preview with the middle of the output truncated:\nCreated At: 2026-01-01T00:00:00Z\nCompleted At: 2026-01-01T00:00:01Z\n';
  it('accepts a native truncated command preview only when its leading receipt reports an exit', () => {
    expect(() => verifyAgyTerminalHistory(mutate(rows, 2, {
      content: preview + 'Command exited with code 1.\n\nCommand output:\npartial stdout',
    }))).not.toThrow();
    expect(() => verifyAgyTerminalHistory(mutate(rows, 2, {
      content: preview + 'Tool is running as a background task\nCommand exited with code 0.\n\nCommand output:\npartial stdout',
    }))).toThrow('unverified work');
  });
  it('accepts a closed schedule create only as historical evidence', () => {
    expect(() => verifyAgyTerminalHistory(rows.slice(8, 10), 8, true)).toThrow('unverified work');
  });
  const cases: Array<[string, TranscriptRecord[]]> = [
    ['gap in steps', rows.filter(row => row.step_index !== 4)],
    ['swapped parallel receipts', mutate(mutate(rows, 2, { content: rows[3].content }), 3, { content: rows[2].content })],
    ['missing trailing receipt', rows.slice(0, 11)],
    ['native async command', mutate(rows, 2, { status: 'RUNNING', content: 'Tool is running as a background task with task id: s/task-2\nTask Description: x\nTask logs are available at: file:///x' })],
    ['unterminated command output', mutate(rows, 2, { content: 'Synthetic command output' })],
    ['pending receipt', mutate(rows, 3, { status: 'RUNNING' })],
    ['unknown tool', mutate(rows, 1, { tool_calls: [{ name: 'grep_search', args: {} }, ...rows[1].tool_calls!.slice(1)] })],
    ['unproven alias', mutate(rows, 1, { tool_calls: [rows[1].tool_calls![0], { name: 'view_file', args: {} }, rows[1].tool_calls![2]] })],
    ['historical question', mutate(rows, 1, { tool_calls: [rows[1].tool_calls![0], { name: 'ask_question', args: { questions: [] } }, rows[1].tool_calls![2]] })],
    ['extra call field', mutate(rows, 10, { tool_calls: [{ name: 'run_command', args: { CommandLine: 'true' }, id: 'x' }] })],
    ['error on create', mutate(rows, 9, { status: 'ERROR', content: 'Encountered error in step execution: {"error":"failed"}' })],
    ['error with extra field', mutate(rows, 7, { content: 'Encountered error in step execution: {"error":"x","nativeAction":{}}' })],
    ['plain-text error', mutate(rows, 7, { content: 'Encountered error in step execution: denied' })],
    ['pending create', mutate(rows, 9, receipt({ ...created, status: 'pending' }))],
    ['create with native action', mutate(rows, 9, receipt({ ...created, nativeAction: { tool: 'schedule' } }))],
    ['failed create', mutate(rows, 9, receipt({ ...created, status: 'failed', error: 'x' }))],
    ['mismatched requestId', mutate(rows, 9, receipt({ ...created, requestId: 'other' }))],
    ['unpinned record', mutate(rows, 9, receipt({ ...created, records: [{ ...created.records[0], id: 'managed-' + 'b'.repeat(48) }] }))],
    ['foreign backend record', mutate(rows, 9, receipt({ ...created, records: [{ ...created.records[0], backend: 'codex' }] }))],
    ['creating record', mutate(rows, 9, receipt({ ...created, records: [{ ...created.records[0], state: 'creating' }] }))],
    ['create extra arguments', mutate(rows, 8, { tool_calls: [{ name: tool('create'), args: { requestId: 'create-1', when, prompt: 'Synthetic', owner: 'x' } }] })],
    ['mutating schedule tool', mutate(rows, 6, { tool_calls: [{ name: tool('cancel'), args: { requestId: 'list-1' } }] })],
    ['foreign message', mutate(rows, 5, { content: NOTIFICATION_PREFIX + '[Message] timestamp=2026-01-01T00:00:00Z sender=agent priority=MESSAGE_PRIORITY_HIGH content=x\n</SYSTEM_MESSAGE>' })],
    ['changed reminder', mutate(rows, 5, { content: nativeEfficiencyReminder.replace('efficiently', 'quickly') })],
    ['native wake', mutate(rows, 13, { content: NOTIFICATION_PREFIX + '[Message] timestamp=2026-01-01T00:00:00Z sender=s/task-2 priority=MESSAGE_PRIORITY_HIGH content=x\n</SYSTEM_MESSAGE>' })],
    ['unfinished planner', mutate(rows, 12, { status: 'RUNNING' })],
  ];
  it.each(cases)('rejects %s', (_name, changed) => {
    expect(() => verifyAgyTerminalHistory(changed)).toThrow('unverified work');
  });

  it('accepts a completed question only in a live foreground suffix', () => {
    const live: TranscriptRecord[] = [
      { step_index: 14, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: '', tool_calls: [{ name: 'ask_question', args: { questions: [] } }] },
      { step_index: 15, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'Answered: First' },
    ];
    expect(() => verifyAgyTerminalHistory(live, 14, true)).not.toThrow();
    expect(() => verifyAgyTerminalHistory(live, 14)).toThrow();
    expect(() => verifyAgyTerminalHistory(live, 13, true)).toThrow();
  });

  it('revalidates a saved prefix exactly and ignores later rows', () => {
    const history = syntheticHistory();
    const saved = { count: history.length, lastStep: history.length - 1, digest: agyHistoryDigest(history) };
    const later = [...history, { step_index: history.length, source: 'MODEL', type: 'GENERIC', status: 'ERROR', content: 'later' }];
    expect(restoreAgyVerifiedHistory(later, saved)).toEqual(saved);
    expect(() => restoreAgyVerifiedHistory(history.slice(1), saved)).toThrow('changed');
    expect(() => restoreAgyVerifiedHistory(mutate(history, 3, { content: 'tampered' }), saved)).toThrow('changed');
    expect(() => restoreAgyVerifiedHistory(history, { ...saved, lastStep: 0 })).toThrow('changed');
    const unsafe = mutate(history, 3, { status: 'RUNNING' });
    expect(() => restoreAgyVerifiedHistory(unsafe, { ...saved, digest: agyHistoryDigest(unsafe) })).toThrow('unverified work');
  });

  it.each([
    [{ count: 2, lastStep: 1, digest: 'a'.repeat(64) }, true],
    [{ count: 0, lastStep: -1, digest: 'a'.repeat(64) }, true],
    [{ count: 2, lastStep: 2, digest: 'a'.repeat(64) }, false],
    [{ count: -1, lastStep: -2, digest: 'a'.repeat(64) }, false],
    [{ count: 2, lastStep: 1, digest: 'A'.repeat(64) }, false],
    [{ count: 2, lastStep: 1, digest: 'a'.repeat(64), extra: true }, false],
    [null, false],
  ])('validates checkpoint shape %#', (value, valid) => {
    expect(isAgyVerifiedHistory(value)).toBe(valid);
  });
});
