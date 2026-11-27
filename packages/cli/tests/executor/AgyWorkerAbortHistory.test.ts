import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AgyCommandTasks } from '../../src/executor/agy/AgyCommandTasks';
import { retiredWorkerHistory, workerAbortBoundary } from '../../src/executor/agy/AgyWorkerAbortHistory';
import { NOTIFICATION_PREFIX, type TranscriptRecord } from '../../src/scheduling/agy/transcript';
import { syntheticHistory } from './agyRecoveredHistoryFixture';

const commands = new AgyCommandTasks('synthetic-session', 'unused-home');
const input = syntheticHistory()[0];
const restart = { ...syntheticHistory().at(-1)!, step_index: 1 };

describe('AGY aborted worker transcript boundary', () => {
  it('accepts an exact appended notice and rejects a rewritten prefix or unexpected sender', () => {
    const boundary = workerAbortBoundary([input], commands)!;
    expect(retiredWorkerHistory([input, restart], boundary, commands)?.count).toBe(2);
    expect(retiredWorkerHistory([{ ...input, content: 'replaced' }], boundary, commands)).toBeUndefined();
    expect(retiredWorkerHistory([input, { ...restart, content: restart.content!.replace('sender=system', 'sender=foreign') }], boundary, commands)).toBeUndefined();
  });

  it('matches late cancellation only to a retired command in the same session and native log', () => {
    const home = os.tmpdir();
    const session = 'synthetic-session';
    const tracker = new AgyCommandTasks(session, home);
    const id = session + '/task-2';
    const log = pathToFileURL(path.join(home, '.gemini', 'antigravity-cli', 'brain', session, '.system_generated', 'tasks', 'task-2.log')).href;
    const content = NOTIFICATION_PREFIX + '[Message] timestamp=2026-01-01T00:00:00Z sender=' + id
      + ' priority=MESSAGE_PRIORITY_LOW content=Task id "' + id + '" was canceled with result:\nTool execution was canceled\nLog: '
      + log + '\n</SYSTEM_MESSAGE>';
    const row = { step_index: 5, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', content };
    const retired = new Set([2]);
    expect(tracker.retiredCommandExit(row, retired)).toBe(2);
    expect(tracker.retiredCommandExit(row)).toBeUndefined();
    for (const changed of [content.replace('sender=' + id, 'sender=other/task-2'), content.replace(log, log + '.old')]) {
      expect(tracker.retiredCommandExit({ ...row, content: changed }, retired)).toBeUndefined();
    }
    expect(tracker.pending).toBe(false);
  });

  it('preserves the native step gap reserved by an interrupted foreground command', () => {
    const tracker = new AgyCommandTasks('synthetic-session', os.tmpdir());
    const planner = { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE',
      tool_calls: [{ name: 'run_command', args: {} }] };
    tracker.observe('PreInvocation', { hookEventName: 'PreInvocation', conversationId: 'synthetic-session', initialNumSteps: 1 }, [input], true);
    tracker.observeTool(2, 'run_command', 'call-2', {}, os.tmpdir(), false);
    const prior = workerAbortBoundary([input, planner], tracker)!;
    const next = { ...input, step_index: 3 };
    expect(workerAbortBoundary([input, planner, next], tracker, prior)).toMatchObject({ count: 3, lastStep: 3 });
    expect(workerAbortBoundary([input, planner, { ...next, step_index: 4 }], tracker, prior)).toBeUndefined();
  });

  it.each(['missing receipt', 'missing hook', 'denied operation', 'error', 'foreign source', 'gap'])(
    'withholds a worker receipt for %s', kind => {
      const name = kind === 'denied operation' ? 'schedule' : 'run_command';
      const rows: TranscriptRecord[] = [input, { step_index: 1, type: 'PLANNER_RESPONSE', source: 'MODEL',
        status: 'DONE', tool_calls: [{ name, args: {} }] }];
      if (kind !== 'missing receipt') rows.push({ step_index: kind === 'gap' ? 3 : 2, type: 'GENERIC',
        source: kind === 'foreign source' ? 'SYSTEM' : 'MODEL', status: kind === 'error' ? 'ERROR' : 'DONE',
        content: kind === 'missing hook' ? 'Tool is running as a background task with task id: synthetic-session/task-2' : 'synthetic output' });
      expect(workerAbortBoundary(rows, commands)).toBeUndefined();
    });
});
