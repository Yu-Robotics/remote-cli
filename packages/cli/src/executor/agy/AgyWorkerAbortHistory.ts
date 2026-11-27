import { nativeRestartNotice, receiptText, type TranscriptRecord } from '../../scheduling/agy/transcript';
import type { AgyCommandTasks } from './AgyCommandTasks';
import { agyHistoryDigest, isAgyVerifiedHistory, nativeEfficiencyReminder, type AgyVerifiedHistory } from './AgyRecoveredHistory';

export function workerNotice(row: TranscriptRecord): boolean {
  return row.status === 'DONE' && !row.tool_calls?.length && (nativeRestartNotice(row) || nativeRestartNotice(row, 'user force cancellation')
    || row.source === 'SYSTEM' && row.type === 'SYSTEM_MESSAGE' && row.content === nativeEfficiencyReminder);
}

export function workerHistoryPrefix(rows: TranscriptRecord[], saved: AgyVerifiedHistory): boolean {
  return isAgyVerifiedHistory(saved, true) && rows.length >= saved.count && (rows[saved.count - 1]?.step_index ?? -1) === saved.lastStep
    && agyHistoryDigest(rows.slice(0, saved.count)) === saved.digest;
}

export function workerBoundary(rows: TranscriptRecord[]): AgyVerifiedHistory {
  return { count: rows.length, lastStep: rows.at(-1)?.step_index ?? -1, digest: agyHistoryDigest(rows) };
}

/** Only a witnessed shell task may have unfinished native work at explicit abort.
 * A stopped group retires that task. It cannot attest an unknown tool or a queued wake. */
export function workerAbortBoundary(rows: TranscriptRecord[], commands: AgyCommandTasks,
  prior?: AgyVerifiedHistory, accepted?: ReadonlyMap<number, TranscriptRecord>): AgyVerifiedHistory | undefined {
  if (prior && !workerHistoryPrefix(rows, prior)) return;
  for (let index = prior?.count ?? 0; index < rows.length; index++) {
    const row = rows[index];
    const previous = rows[index - 1];
    const followsAbortedCall = index === prior?.count && row.source === 'USER_EXPLICIT' && row.type === 'USER_INPUT'
      && previous?.tool_calls?.length && row.step_index === previous.step_index + previous.tool_calls.length + 1;
    if (row.step_index !== (previous?.step_index ?? -1) + 1 && !followsAbortedCall) return;
    if (accepted?.has(row.step_index) || workerNotice(row) || row.type === 'SYSTEM_MESSAGE' && commands.witnessedReceipt(row)) continue;
    if (row.status !== 'DONE') return;
    if (row.source === 'USER_EXPLICIT' && row.type === 'USER_INPUT' && !row.tool_calls?.length) continue;
    if (row.source !== 'MODEL' || row.type !== 'PLANNER_RESPONSE') return;
    const plannerIndex = index;
    for (const call of row.tool_calls ?? []) {
      const result = rows[++index];
      const name = (call as { name?: unknown } | null)?.name;
      // The process can exit after the authenticated PreToolUse hook and
      // before native writes its tool result. No command is reopened on load.
      if (!result && name === 'run_command' && commands.witnessedForegroundCommand(row.step_index + index - plannerIndex, (call as { args?: unknown }).args)) continue;
      if (typeof name !== 'string' || name === 'schedule' || name === 'manage_task'
        || !result || result.step_index !== row.step_index + index - plannerIndex || result.type !== 'GENERIC' || result.source !== 'MODEL' || result.tool_calls?.length) return;
      if (name === 'run_command' && commands.witnessedReceipt(result)) continue;
      const text = receiptText(result);
      if (result.status !== 'DONE' || text === undefined || text.startsWith('Tool is running as a background task')
        || text.startsWith('Encountered error in step execution:')) return;
    }
  }
  return workerBoundary(rows);
}

/** After cancellation the only allowed additions are passive native notices and
 * one authenticated terminal notice per previously outstanding shell command. */
export function retiredWorkerHistory(rows: TranscriptRecord[], prefix: AgyVerifiedHistory, commands: AgyCommandTasks): AgyVerifiedHistory | undefined {
  if (!workerHistoryPrefix(rows, prefix)) return;
  const exited = new Set<number>();
  for (let index = prefix.count; index < rows.length; index++) {
    const row = rows[index];
    if (row.step_index !== (rows[index - 1]?.step_index ?? -1) + 1) return;
    if (workerNotice(row)) continue;
    const target = commands.retiredCommandExit(row);
    if (target === undefined || exited.has(target)) return;
    exited.add(target);
  }
  return workerBoundary(rows);
}
