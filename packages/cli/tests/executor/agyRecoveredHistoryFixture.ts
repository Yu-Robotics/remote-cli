import os from 'os';
import path from 'path';
import { nativeEfficiencyReminder } from '../../src/executor/agy/AgyRecoveredHistory';
import { NOTIFICATION_PREFIX, type TranscriptRecord } from '../../src/scheduling/agy/transcript';

export const tool = (name: string) => 'mcp_remote-cli-delegation_remote_cli_schedule_' + name;
const restart = NOTIFICATION_PREFIX + '[Message] timestamp=2026-01-01T00:00:00Z sender=system priority=MESSAGE_PRIORITY_LOW content=[Notice] All your subagents and background tasks have been stopped due to server restart. If you want a subagent to continue working, it needs to be revived by sending it a new message. If resuming work, please check on status and restart as needed.\n</SYSTEM_MESSAGE>';
const scheduleId = 'managed-' + 'a'.repeat(48);
export const when = { kind: 'cron', expression: '0 9 * * *', timezone: 'UTC' };
export const created = { status: 'succeeded', requestId: 'create-1', scheduleId,
  records: [{ id: scheduleId, state: 'active', backend: 'agy', rule: { kind: 'cron' }, prompt: 'Synthetic' }], card: 'Card sent.' };

/** A synthetic main conversation shaped like a recovered AGY history. */
export function syntheticHistory(): TranscriptRecord[] {
  const rows: Omit<TranscriptRecord, 'step_index'>[] = [
    { source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'Synthetic request' },
    { source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: '', tool_calls: [
      { name: 'run_command', args: { CommandLine: 'echo fixture', Cwd: os.tmpdir() } },
      { name: 'read_file', args: { AbsolutePath: path.join(os.tmpdir(), 'fixture-readme') } },
      { name: tool('capabilities'), args: { toolSummary: 'Check scheduling' } },
    ] },
    { source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'Created At: synthetic\nCommand exited with code 0.\n\nCommand output:\nfixture\n' },
    { source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'Synthetic file content' },
    { source: 'MODEL', type: 'GENERIC', status: 'DONE', content: JSON.stringify({ backend: 'agy', capability: {}, now: '2026-01-01T00:00:00Z', hostTimezone: 'UTC' }) },
    { source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', content: nativeEfficiencyReminder },
    { source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: '', tool_calls: [{ name: tool('list'), args: { requestId: 'list-1', toolSummary: 'List schedules' } }] },
    { source: 'MODEL', type: 'GENERIC', status: 'ERROR', content: 'Encountered error in step execution: ' + JSON.stringify({ error: 'No active delegation turn' }) },
    { source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: '', tool_calls: [{ name: tool('create'), args: { requestId: 'create-1', when, prompt: 'Synthetic', toolSummary: 'Create a timer' } }] },
    { source: 'MODEL', type: 'GENERIC', status: 'DONE', content: JSON.stringify(created) },
    { source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: '', tool_calls: [{ name: 'run_command', args: { CommandLine: 'true' } }] },
    { source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'Command exited with code 0.\n\nNo output from the command.' },
    { source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Synthetic answer' },
    { source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', content: restart },
  ];
  return rows.map((row, step_index) => ({ step_index, ...row }));
}
