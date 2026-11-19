import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, it } from 'vitest';
import { AgyCommandTasks } from '../../src/executor/agy/AgyCommandTasks';
import { NOTIFICATION_PREFIX, type TranscriptRecord } from '../../src/scheduling/agy/transcript';

describe('owned AGY command evidence', () => {
  const home = path.join(os.tmpdir(), 'synthetic-agy-home');
  const session = 'synthetic-session';
  const log = pathToFileURL(path.join(home, '.gemini', 'antigravity-cli', 'brain', session, '.system_generated', 'tasks', 'task-4.log')).href;
  const id = session + '/task-4';
  const call = { name: 'run_command', id: 'command', args: { CommandLine: 'synthetic', WaitMsBeforeAsync: 500 } };
  const post = { stepIdx: 4, conversationId: session, cwd: home, hookEventName: 'PostToolUse', toolCall: call };
  const receipt: TranscriptRecord = { step_index: 4, source: 'MODEL', type: 'GENERIC', status: 'RUNNING',
    content: `Tool is running as a background task with task id: ${id}\nTask Description: work\nTask logs are available at: ${log}` };
  const terminal: TranscriptRecord = { step_index: 7, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE',
    content: NOTIFICATION_PREFIX + `[Message] timestamp=2026-01-01T00:00:00Z sender=${id} priority=MESSAGE_PRIORITY_HIGH content=Task id "${id}" finished with result:\nCommand exited with code 0.\n\nCommand output:\nOK\n\nLog: ${log}\n</SYSTEM_MESSAGE>` };
  function fixture(start = 4) {
    const tasks = new AgyCommandTasks(session, home);
    tasks.observe('PreInvocation', { initialNumSteps: start }, [], true);
    tasks.observeTool(4, call.name, call.id, call.args, home);
    return tasks;
  }
  it('rejects an older tool index and a conflicting hook identity', () => {
    expect(() => fixture(5).observe('PostToolUse', {}, [receipt], true)).toThrow();
    expect(() => fixture().observeTool(4, 'other-tool', 'different', {}, home)).toThrow();
  });
  function yielded() {
    const tasks = fixture();
    tasks.observe('Stop', {}, [receipt], true);
    tasks.endForeground();
    return tasks;
  }
  it.each([
    { ...post, stepIdx: 3 }, { ...post, conversationId: 'foreign' }, { ...post, cwd: path.dirname(home) },
    { ...post, hookEventName: 'PreToolUse' }, { ...post, toolCall: { ...call, id: 'other' } },
    { ...post, toolCall: { ...call, name: 'schedule' } }, { ...post, toolCall: { ...call, args: {} } },
  ])('rejects a delayed post with mismatched call provenance', payload => {
    expect(() => yielded().observe('PostToolUse', payload, [receipt], false)).toThrow();
  });
  it('consumes a delayed post once and requires its completion before Stop', () => {
    const tasks = yielded();
    tasks.observe('PostToolUse', post, [receipt], false);
    expect(() => tasks.observe('PostToolUse', post, [receipt], false)).toThrow();
    tasks.observe('PreInvocation', {}, [receipt], false);
    expect(() => tasks.observe('Stop', {}, [receipt], false)).toThrow();
    expect(tasks.pending).toBe(true);
  });
  it('rejects replay of a foreground post that preceded the yield receipt', () => {
    const tasks = fixture();
    tasks.observe('PostToolUse', post, [], true);
    tasks.observe('Stop', {}, [receipt], true);
    tasks.endForeground();
    expect(() => tasks.observe('PostToolUse', post, [receipt], false)).toThrow();
  });
  it('waits for notification Stop after native nonzero completion with no output', () => {
    const tasks = yielded();
    tasks.observe('PostToolUse', post, [receipt], false);
    tasks.observe('PreInvocation', {}, [receipt], false);
    const rows = [receipt, { ...terminal, content: terminal.content!.replace('code 0.\n\nCommand output:\nOK\n', 'code 7.\n\nNo output from the command.') }];
    tasks.observe('PostInvocation', {}, rows, false);
    expect(tasks.pending).toBe(true);
    tasks.observe('Stop', {}, rows, false);
    expect(tasks.pending).toBe(false);
  });
  it('rejects missing evidence, wrong-session notifications and an echoed completion', () => {
    const tasks = fixture();
    tasks.observe('PostToolUse', {}, [receipt], true);
    expect(() => tasks.observe('PostInvocation', {}, [], true)).toThrow();
    expect(() => tasks.observe('PostInvocation', {}, [receipt, { ...terminal,
      content: terminal.content!.replace('sender=' + id, 'sender=other/task-4') }], true)).toThrow();
    tasks.observe('PostInvocation', {}, [receipt, { ...terminal, source: 'MODEL' }], true);
    expect(tasks.pending).toBe(true);
  });
  it('rejects unrelated work in the same batch as an idle completion', () => {
    const tasks = fixture();
    tasks.observe('PostToolUse', {}, [receipt], true);
    tasks.endForeground();
    const unrelated = { step_index: 6, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'other work' };
    expect(() => tasks.observe('PreInvocation', {}, [receipt, unrelated, terminal], false)).toThrow();
  });
});
