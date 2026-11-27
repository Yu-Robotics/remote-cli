import { createHash } from 'crypto';
import { MAX_RECORDS, NOTIFICATION_PREFIX, nativeRestartNotice, receiptText, type TranscriptRecord } from '../../scheduling/agy/transcript';

/** Exact transcript prefix whose terminal history was verified before host timing resumed. */
export interface AgyVerifiedHistory { count: number; lastStep: number; digest: string }

const unverified = 'AGY recovered history contains unverified work; host timing remains unavailable.';
const errorPrefix = 'Encountered error in step execution: ';
const scheduleTool = 'mcp_remote-cli-delegation_remote_cli_schedule_';
const requestPattern = /^[A-Za-z0-9_-]{1,80}$/;
// Bound per-planner batches, matching the live parallel-tool proof.
const maxBatch = 64;
const settledStates = ['active', 'running', 'completed', 'cancelled'];
// AGY keeps the native exit header in this preview even when stdout was truncated.
// Never open the referenced file or look for an exit marker inside command output.
const commandPreview = /^The tool's output was truncated due to being too long\. You can find the full output in a file at file:\/\/[^\r\n]+\.\n\nHere is a preview with the middle of the output truncated:\nCreated At: [^\r\n]+\nCompleted At: [^\r\n]+\n/;

/** Static native guidance. It carries no sender, task identity or queued input. */
export const nativeEfficiencyReminder = NOTIFICATION_PREFIX + 'Reminder: work efficiently. In this turn, issue in parallel every '
  + 'independent search, read and edit or write you need next. Never one call per turn; never repeat a search or re-read '
  + 'content you already know that hasn\'t changed. Working efficiently never means skipping checks to save turns; verify in '
  + 'one command after your last edit and don\'t re-run passing tests or diffs without new edits.\n</SYSTEM_MESSAGE>';

export function agyHistoryDigest(rows: TranscriptRecord[]): string {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every(key => Object.hasOwn(value, key)) && keys.every(key => required.includes(key) || optional.includes(key));
}
function parse(text: string): Record<string, unknown> | undefined {
  try { const value = JSON.parse(text); return record(value) ? value : undefined; }
  catch { return undefined; }
}
/** A settled tool result never asks the model to perform a native follow-up. */
function settled(result: Record<string, unknown>): boolean {
  return !Object.hasOwn(result, 'nativeAction') && !Object.hasOwn(result, 'instruction') && result.status !== 'pending';
}

function plainRow(row: TranscriptRecord): boolean {
  if (row.status !== 'DONE' || row.tool_calls?.length) return false;
  return row.source === 'USER_EXPLICIT' && row.type === 'USER_INPUT'
    || row.source === 'MODEL' && row.type === 'PLANNER_RESPONSE'
    || nativeRestartNotice(row)
    || row.source === 'SYSTEM' && row.type === 'SYSTEM_MESSAGE' && row.content === nativeEfficiencyReminder;
}

function listArgs(args: Record<string, unknown>, required: boolean): boolean {
  return exactKeys(args, required ? ['requestId'] : [], required ? [] : ['requestId'])
    && (args.requestId === undefined || typeof args.requestId === 'string' && requestPattern.test(args.requestId));
}

/** Only receipts whose terminal text proves a completed synchronous call qualify. */
function terminalReceipt(name: string, args: Record<string, unknown>, receipt: TranscriptRecord, liveRecovery: boolean): boolean {
  if (receipt.source !== 'MODEL' || receipt.type !== 'GENERIC' || receipt.tool_calls?.length) return false;
  const text = receiptText(receipt);
  if (text === undefined) return false;
  if (receipt.status === 'ERROR') {
    // The bounded read-only list failure is the only accepted error receipt.
    if (name !== scheduleTool + 'list' || !listArgs(args, false) || !text.startsWith(errorPrefix)) return false;
    const error = parse(text.slice(errorPrefix.length));
    return !!error && exactKeys(error, ['error']) && typeof error.error === 'string' && error.error.length > 0 && error.error.length <= 4096;
  }
  if (receipt.status !== 'DONE' || text.startsWith(errorPrefix)) return false;
  if (name === 'run_command') {
    return typeof args.CommandLine === 'string'
      && /^Command exited with code -?\d+\.\n\n(?:Command output:[\s\S]*|No output from the command\.)$/.test(text.replace(commandPreview, ''));
  }
  if (name === 'read_file') return !text.startsWith('Tool is running as a background task');
  if (name === 'ask_question') return liveRecovery && Array.isArray(args.questions);
  const result = parse(text);
  if (!result || !settled(result)) return false;
  if (name === scheduleTool + 'capabilities') {
    return exactKeys(args, []) && exactKeys(result, ['backend', 'capability', 'now', 'hostTimezone']) && result.backend === 'agy';
  }
  if (name === scheduleTool + 'list') {
    return listArgs(args, true) && result.requestId === args.requestId
      && (result.status === 'succeeded' && Array.isArray(result.records) || result.status === 'failed');
  }
  if (name === scheduleTool + 'create') {
    const records = result.records;
    return !liveRecovery && exactKeys(args, ['requestId', 'when', 'prompt']) && typeof args.requestId === 'string' && requestPattern.test(args.requestId)
      && exactKeys(result, ['status', 'requestId', 'scheduleId', 'records'], ['card']) && result.status === 'succeeded'
      && result.requestId === args.requestId && typeof result.scheduleId === 'string' && /^managed-[a-f0-9]{48}$/.test(result.scheduleId)
      && Array.isArray(records) && records.length === 1 && record(records[0]) && records[0].id === result.scheduleId
      && records[0].backend === 'agy' && settledStates.includes(records[0].state as string);
  }
  return false;
}

/** Verify contiguous native history containing only settled synchronous calls.
 * Native background receipts, wakes, foreign input, pending calls and unknown tools fail closed.
 * Questions are only accepted from a live foreground suffix that answered them. */
export function verifyAgyTerminalHistory(rows: TranscriptRecord[], start = 0, liveRecovery = false): void {
  if (rows.length > MAX_RECORDS) throw new Error(unverified);
  for (let index = 0; index < rows.length;) {
    const row = rows[index];
    if (row.step_index !== start + index) throw new Error(unverified);
    if (plainRow(row)) { index++; continue; }
    const calls = row.tool_calls;
    if (row.source !== 'MODEL' || row.type !== 'PLANNER_RESPONSE' || row.status !== 'DONE'
      || !calls?.length || calls.length > maxBatch) throw new Error(unverified);
    for (const [offset, call] of calls.entries()) {
      const receipt = rows[index + 1 + offset];
      if (!record(call) || !exactKeys(call, ['name', 'args']) || typeof call.name !== 'string' || !record(call.args)
        || receipt?.step_index !== row.step_index + 1 + offset) throw new Error(unverified);
      // toolSummary is native display metadata. Keep it in the history digest.
      const { toolSummary, ...args } = call.args;
      if (toolSummary !== undefined && typeof toolSummary !== 'string'
        || !terminalReceipt(call.name, args, receipt, liveRecovery)) throw new Error(unverified);
    }
    index += 1 + calls.length;
  }
}

export function isAgyVerifiedHistory(value: unknown, allowGaps = false): value is AgyVerifiedHistory {
  return record(value) && exactKeys(value, ['count', 'lastStep', 'digest']) && Number.isSafeInteger(value.count)
    && (value.count as number) >= 0 && (value.count as number) <= MAX_RECORDS
    && (allowGaps && (value.count as number) > 0 ? Number.isSafeInteger(value.lastStep) && (value.lastStep as number) >= (value.count as number) - 1
      : value.lastStep === (value.count as number) - 1)
    && typeof value.digest === 'string' && /^[a-f0-9]{64}$/.test(value.digest);
}

/** Revalidate a checkpointed prefix in a fresh process before excluding it from live controls. */
export function restoreAgyVerifiedHistory(rows: TranscriptRecord[], saved: AgyVerifiedHistory): AgyVerifiedHistory {
  const prefix = rows.slice(0, saved.count);
  if (!isAgyVerifiedHistory(saved) || prefix.length !== saved.count || agyHistoryDigest(prefix) !== saved.digest) {
    throw new Error('AGY verified history changed.');
  }
  verifyAgyTerminalHistory(prefix);
  return { count: saved.count, lastStep: saved.lastStep, digest: saved.digest };
}
