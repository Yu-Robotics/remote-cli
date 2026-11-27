import { createHash, randomUUID } from 'crypto';
import { isDeepStrictEqual } from 'util';
import type { AcpTransport } from '../acp/AcpClient';
import type { AcpContentBlock } from '../acp/AcpTypes';
import type { AgyCommandTasks } from './AgyCommandTasks';
import { AgySessionSchedules, type HookPayload } from '../../scheduling/agy/AgySessionSchedules';
import { creationReceipt, nativeWake, receiptText, type TranscriptRecord } from '../../scheduling/agy/transcript';
import { agyDispatchConflicts, agyValidationRejection, type AgyValidationRejection } from './AgyValidationRejection';

const listCall = { name: 'manage_task', args: { Action: 'list' } };
const denialFailure = 'AGY tool denial enforcement is unconfirmed; explicit clear is required before reuse.';
const foregroundFailure = 'AGY foreground tool outcome is unconfirmed; explicit clear is required before reuse.';

// Bound per-call planner and sibling snapshots for a single parallel batch.
const maxToolBatch = 64;
type ToolError = { planner: TranscriptRecord; receipt: TranscriptRecord; siblings?: TranscriptRecord[] };

/** Native reserves one consecutive receipt step per planner call, in planner order.
 * During the tool hooks only a prefix of those receipts may have been flushed. */
function toolPlanner(rows: TranscriptRecord[], end: number, step: number): TranscriptRecord | undefined {
  if (!Number.isSafeInteger(step) || end < 0 || rows[end].step_index >= step) return;
  for (let i = end; i >= 0; i--) {
    const row = rows[i];
    if (step - row.step_index > maxToolBatch) return;
    if (row.source !== 'MODEL' || rows[end].step_index - row.step_index !== end - i) return;
    if (row.type === 'PLANNER_RESPONSE' && row.status === 'DONE') {
      const count = row.tool_calls?.length ?? 0;
      if (count <= maxToolBatch && step - row.step_index <= count) return row;
      return;
    }
    if (row.type !== 'GENERIC' || row.tool_calls?.length) return;
  }
}

function toolErrorAt(rows: TranscriptRecord[], index: number): ToolError | undefined {
  const receipt = rows[index];
  if (!receipt || rows[index - 1]?.step_index !== receipt.step_index - 1) return;
  const planner = toolPlanner(rows, index - 1, receipt.step_index);
  if (!planner) return;
  const count = planner.tool_calls!.length;
  if (count === 1) return { planner, receipt };
  const first = index - (receipt.step_index - planner.step_index - 1);
  const batch = rows.slice(first, first + count);
  if (batch.length !== count || batch.some((row, offset) => row.step_index !== planner.step_index + 1 + offset
    || row.source !== 'MODEL' || row.type !== 'GENERIC' || row.tool_calls?.length
    || !['DONE', 'ERROR'].includes(row.status))) return;
  return { planner, receipt, siblings: batch.filter(row => row !== receipt) };
}

function toolErrorDigest(errors: ToolError[]): string {
  return createHash('sha256').update(JSON.stringify(errors.sort((a, b) => a.receipt.step_index - b.receipt.step_index))).digest('hex');
}

/** The transcript supplies the rows; only the retired foreground host supplies their authority. */
export function restoreAgyToolErrors(records: TranscriptRecord[], digest: string): ToolError[] {
  const errors: ToolError[] = [];
  for (const [index, receipt] of records.entries()) {
    if (receipt.type !== 'GENERIC' || !['ERROR', 'INVALID'].includes(receipt.status)) continue;
    const proof = toolErrorAt(records, index);
    if (!proof) throw new Error(foregroundFailure);
    errors.push(proof);
  }
  if (!errors.length || toolErrorDigest(errors) !== digest) throw new Error('AGY checkpoint tool evidence changed.');
  return errors;
}

/** Ordinary ACP chat with scheduling permanently unavailable. The hook terminal
 * remains authoritative. This host never supplies original schedule admission. */
export class AgyChatHost {
  private records: TranscriptRecord[] = [];
  private turnStart?: number;
  private readonly observedTools = new Set<number>();
  private readonly postedTools = new Set<number>();
  private monitor: AgySessionSchedules;
  private failure?: string;
  // Live evidence only. A newly loaded session cannot inherit these exceptions.
  private readonly managementDenials = new Map<number, { reason: string; planner: TranscriptRecord }>();
  private pendingDenialStep?: number;
  private requiredTerminal?: string;
  private readonly ordinaryCalls = new Map<number, { call: unknown; planner: TranscriptRecord; error?: string }>();
  private readonly toolErrors = new Map<number, ToolError>();
  private checkingLoadedHistory: boolean;
  // Native argument rejections before dispatch. They have no tool hooks by design.
  private readonly turnRejections: AgyValidationRejection[] = [];
  private readonly dispatches: Array<{ name?: unknown; rawInput?: unknown }> = [];
  private invocationStart?: number;
  private admittedKill = false;
  // Same-process human admission never grants management, worker or checkpoint
  // authority. Only the current foreground's paired hook and ACP terminals set it.
  private ordinaryMain = false;
  private policyFailure?: string;
  private idleStop = false;
  // A human-only terminal is local to this host and its unchanged native history.
  private humanHistory?: { count: number; digest: string };
  private settledHumanTurn = false;
  get humanContinuation(): boolean { return this.settledHumanTurn && !this.blocked && !this.active; }

  private restrictReuse(reason: string): void {
    if (this.ordinaryMain && this.active) this.policyFailure ??= reason;
    else this.fence(reason);
  }

  get reusable(): boolean { return !this.policyFailure && !this.blocked && this.pendingDenialStep === undefined && !this.records.some(row =>
    creationReceipt(row, this.sessionId, row.step_index) || nativeWake(row)
    || row.type === 'GENERIC' && row.status !== 'DONE' && !this.managementDenials.has(row.step_index)
      && !this.toolErrors.has(row.step_index)); }
  get restrictedToHuman(): boolean { return !!this.policyFailure; }
  get hasForegroundToolErrors(): boolean { return this.toolErrors.size > 0; }
  checkpointToolErrors(): string | undefined {
    return this.hasForegroundToolErrors ? toolErrorDigest([...this.toolErrors.values()]) : undefined;
  }
  get liveManagement(): boolean { return this.managementDenials.size > 0 || this.admittedKill; }
  private active = false;
  private cancelled = false;
  private rejectCancel?: (error: Error) => void;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly client: AcpTransport, readonly sessionId: string,
    private readonly cwd: string, private readonly threadId: string, initialRecords: TranscriptRecord[] = [],
    restoredErrors: ToolError[] = [], private readonly nativeVersion?: string) {
    this.records = initialRecords;
    for (const proof of restoredErrors) this.toolErrors.set(proof.receipt.step_index, proof);
    this.checkingLoadedHistory = restoredErrors.length > 0;
    this.monitor = this.newMonitor();
  }
  private newMonitor(): AgySessionSchedules {
    return new AgySessionSchedules({ sessionId: this.sessionId, cwd: this.cwd, threadId: this.threadId,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, isCurrent: () => !this.failure,
      manage: async () => { throw new Error('Native scheduling is unavailable on this ACP chat host.'); } });
  }
  get blocked(): string | undefined { return this.failure ?? this.monitor.status.blocked; }
  fence(reason: string): void { this.failure ??= reason; }
  accept(event: string, payload: HookPayload, records: TranscriptRecord[], allowForegroundManagement = false,
    commands?: AgyCommandTasks, fullHistory = records, ordinaryForeground = allowForegroundManagement) {
    this.records = records;
    if (this.humanHistory) {
      const prefix = fullHistory.slice(0, this.humanHistory.count);
      if (createHash('sha256').update(JSON.stringify(prefix)).digest('hex') !== this.humanHistory.digest) {
        this.fence('AGY foreground history changed after its confirmed terminal.');
      }
    }
    this.settledHumanTurn = false;
    this.idleStop = this.active && event === 'Stop' && payload.fullyIdle === true && payload.continuationActive === false;
    if (this.checkingLoadedHistory) {
      if (!['SessionStart', 'PreInvocation'].includes(event) || !this.reusable) this.fence(foregroundFailure);
      if (event === 'PreInvocation') this.checkingLoadedHistory = false;
    }
    if (this.requiredTerminal && this.active && !allowForegroundManagement && !ordinaryForeground) this.fence(this.requiredTerminal);
    if (this.managementDenials.size) this.verifyManagementDenials(event, payload, records);
    if (event === 'PreInvocation' && this.turnStart === undefined && Number.isSafeInteger(payload.initialNumSteps)) this.turnStart = payload.initialNumSteps as number;
    if (event === 'PreInvocation') this.invocationStart = this.active && Number.isSafeInteger(payload.initialNumSteps) ? payload.initialNumSteps as number : undefined;
    const duplicateTool = this.observedTools.has(payload.stepIdx as number);
    if (event === 'PreToolUse' && Number.isSafeInteger(payload.stepIdx)) this.observedTools.add(payload.stepIdx as number);
    if (event === 'PostToolUse' && Number.isSafeInteger(payload.stepIdx)) this.postedTools.add(payload.stepIdx as number);
    if (event === 'Stop' && records.some(row => row.type === 'GENERIC' && row.step_index >= (this.turnStart ?? Infinity)
      && !this.observedTools.has(row.step_index) && !(row.status === 'INVALID' && this.toolErrors.has(row.step_index)))) {
      this.restrictReuse('AGY tool hook coverage is incomplete; this conversation is not reusable.');
    }
    if (event === 'Stop' && this.active && this.ordinaryMain && (payload.continuationActive === true
      || payload.fullyIdle === false && !commands?.outstandingCount)) this.fence('AGY native foreground still has active work.');
    const start = this.turnStart ?? Infinity;
    if (event === 'Stop' && this.active && records.some(row => row.step_index >= start
      && this.toolErrors.has(row.step_index))) {
      const last = records.at(-1);
      const settled = payload.fullyIdle === true || payload.fullyIdle === false && !!commands?.outstandingCount;
      if (payload.continuationActive !== false || !settled) this.fence(foregroundFailure);
      else if (last?.type !== 'PLANNER_RESPONSE' || last.source !== 'MODEL' || last.status !== 'DONE'
        || last.tool_calls?.length) this.restrictReuse(foregroundFailure);
    }
    if (records.some(nativeWake)) this.restrictReuse('Unexpected native reminders were observed; this conversation is not reusable.');
    if (records.some(row => creationReceipt(row, this.sessionId, row.step_index))) this.restrictReuse('AGY background-task creation was observed; explicit clear is required before reuse.');
    const decision = this.monitor.accept(event, payload, records);
    this.observeOrdinaryTool(event, payload, records, ordinaryForeground && this.active && !this.cancelled
      && !this.blocked, decision.decision === 'allow' && !duplicateTool);
    // A relay decision is only a request: native hook execution can fail open
    // after receiving it. Never grant continuity from a later DONE/Stop success.
    if (event === 'PreToolUse' && decision.decision === 'deny') {
      const step = payload.stepIdx as number;
      const call = payload.toolCall as { name?: unknown; args?: unknown; id?: unknown } | undefined;
      const start = this.monitor.foregroundInvocationStart;
      const planner = records.at(-1);
      if (allowForegroundManagement && this.active && !this.cancelled && !duplicateTool && !this.blocked && start !== undefined
        && Number.isSafeInteger(step) && step > start && typeof call?.id === 'string' && call.id.length > 0 && call.id.length <= 256
        && call.name === listCall.name && call.args && typeof call.args === 'object' && !Array.isArray(call.args)
        && planner && this.managementPlanner(planner, step, call.args)) {
        if (commands?.admitStatus(step, call.id, call.args, fullHistory)) {
          this.requiredTerminal ??= foregroundFailure;
          return { decision: 'allow' as const };
        }
        if (commands?.admitKill(step, call.id, call.args, planner)) {
          this.requiredTerminal ??= foregroundFailure;
          this.admittedKill = true;
          return { decision: 'allow' as const };
        }
        let message = 'This native task management request is unavailable in ordinary chat';
        if (isDeepStrictEqual(call.args, listCall.args)) message = 'Native task listing is unavailable in ordinary chat';
        const reason = message + ' (' + randomUUID() + ').';
        this.requiredTerminal = denialFailure;
        this.managementDenials.set(step, { planner: structuredClone(planner), reason });
        this.pendingDenialStep = step;
        return { decision: 'deny' as const, reason };
      }
      this.fence(denialFailure);
    }
    if (this.idleStop && this.ordinaryMain && !this.reusable && !this.blocked) {
      this.humanHistory = { count: fullHistory.length, digest: createHash('sha256').update(JSON.stringify(fullHistory)).digest('hex') };
    }
    if (this.failure) return event === 'PreInvocation' ? { terminationBehavior: 'terminate' as const }
      : event === 'PreToolUse' ? { decision: 'deny' as const, reason: this.failure } : {};
    return decision;
  }
  private observeOrdinaryTool(event: string, payload: HookPayload, records: TranscriptRecord[], foreground: boolean,
    admitted: boolean): void {
    // Keep these exceptions tied to the original planner and immutable receipt on this live host.
    if (this.toolErrors.size) {
      let verified = 0;
      for (const [index, row] of records.entries()) {
        const proof = this.toolErrors.get(row.step_index);
        if (proof && isDeepStrictEqual(toolErrorAt(records, index), proof)) verified++;
      }
      if (verified !== this.toolErrors.size || (event === 'PreToolUse' || event === 'PostToolUse')
        && this.toolErrors.has(payload.stepIdx as number)) this.fence(foregroundFailure);
    }
    // The error hook precedes its transcript receipt. Join it at the end of the same invocation.
    if (event === 'PostInvocation') {
      for (const [step, pending] of this.ordinaryCalls) {
        const index = records.findIndex(row => row.step_index === step);
        const row = records[index];
        if (!pending.error) {
          if (row?.status !== 'DONE') this.restrictReuse(foregroundFailure);
          continue;
        }
        const proof = toolErrorAt(records, index);
        if (foreground && proof && row?.status === 'ERROR' && !row.tool_calls?.length
          && isDeepStrictEqual(proof.planner, pending.planner)
          && receiptText(row) === 'Encountered error in step execution: ' + pending.error) {
          if (proof.siblings?.some(sibling => !this.observedTools.has(sibling.step_index) || !this.postedTools.has(sibling.step_index))) {
            this.restrictReuse(foregroundFailure);
          } else this.toolErrors.set(step, structuredClone(proof));
        } else if (foreground && (!row || row.source === 'MODEL')
          && (!receiptText(row)?.startsWith('Encountered error in step execution: ')
            || receiptText(row) === 'Encountered error in step execution: ' + pending.error)
          && isDeepStrictEqual(records.find(r => r.step_index === pending.planner.step_index), pending.planner)) {
          // A new receipt shape has no durable tool proof. A contradictory
          // authenticated hook or rewritten planner still fences the live host.
          this.restrictReuse(foregroundFailure);
        } else this.fence(foregroundFailure);
      }
      this.ordinaryCalls.clear();
      if (foreground) this.observeRejections(payload, records);
      return;
    }
    const step = payload.stepIdx as number;
    const pending = this.ordinaryCalls.get(step);
    if (pending && event === 'PostToolUse') {
      if (!payload.error && !pending.error) { this.ordinaryCalls.delete(step); return; }
      this.requiredTerminal ??= foregroundFailure;
      if (!foreground || pending.error || !isDeepStrictEqual(payload.toolCall, pending.call)
        || !isDeepStrictEqual(records.find(row => row.step_index === pending.planner.step_index), pending.planner)
        || typeof payload.error !== 'string' || !payload.error.trim()
        || payload.error.startsWith('tool call denied by pre-tool hook:')) this.fence(foregroundFailure);
      else pending.error = payload.error;
      return;
    }
    if (!foreground) return;
    if (pending && event === 'PreToolUse') { this.fence(foregroundFailure); return; }
    const call = payload.toolCall as { id?: unknown; name?: unknown; args?: unknown } | undefined;
    const start = this.monitor.foregroundInvocationStart;
    if (event === 'PreToolUse' && admitted && !this.postedTools.has(step) && start !== undefined && step > start
      && typeof call?.name === 'string' && !['run_command', 'manage_task', 'schedule', 'ask_question'].includes(call.name)
      && typeof call.id === 'string' && call.id.length > 0 && call.id.length <= 256
      && call.args && typeof call.args === 'object' && !Array.isArray(call.args)) {
      const planner = toolPlanner(records, records.length - 1, step);
      if (planner && planner.step_index >= start && isDeepStrictEqual(planner.tool_calls?.[step - planner.step_index - 1],
        { name: call.name, args: call.args })) {
        this.ordinaryCalls.set(step, { call: structuredClone(call), planner: structuredClone(planner) });
      }
    }
  }
  /** Native AGY flushes an argument rejection by the PostInvocation of its own invocation. */
  private observeRejections(payload: HookPayload, records: TranscriptRecord[]): void {
    const start = payload.initialNumSteps;
    if (!Number.isSafeInteger(start) || start !== this.invocationStart || (start as number) < (this.turnStart ?? Infinity)) return;
    for (const [index, row] of records.entries()) {
      const step = row.step_index;
      if (step <= (start as number) || row.type !== 'GENERIC' || row.status !== 'INVALID' || this.toolErrors.has(step)
        || this.observedTools.has(step) || this.postedTools.has(step)) continue;
      const rejection = agyValidationRejection(this.nativeVersion, records[index - 1], row);
      if (!rejection || records[index - 1].step_index < (start as number)) continue;
      this.requiredTerminal ??= foregroundFailure;
      this.toolErrors.set(step, { planner: structuredClone(records[index - 1]), receipt: structuredClone(row) });
      this.turnRejections.push(rejection);
    }
  }
  /** ACP tool updates of the active turn. A rejected call must never appear as dispatched. */
  observeDispatch(update: { name?: unknown; rawInput?: unknown }): void {
    if (!this.active) return;
    this.dispatches.push({ name: update.name, rawInput: structuredClone(update.rawInput) });
    if (this.dispatches.length > 4096) this.fence(foregroundFailure);
  }
  private managementPlanner(row: TranscriptRecord | undefined, step: number, args: unknown): boolean {
    return row?.step_index === step - 1 && row.source === 'MODEL' && row.type === 'PLANNER_RESPONSE'
      && row.status === 'DONE' && isDeepStrictEqual(row.tool_calls, [{ name: listCall.name, args }]);
  }
  private verifyManagementDenials(event: string, payload: HookPayload, records: TranscriptRecord[]): void {
    // The relay supplies unique, ordered steps from this session's anchored native transcript.
    let confirmed = 0;
    for (const [index, row] of records.entries()) {
      const denial = this.managementDenials.get(row.step_index);
      if (!denial) continue;
      if (isDeepStrictEqual(records[index - 1], denial.planner) && row.status === 'ERROR' && !row.tool_calls?.length
        && receiptText(row) === 'Encountered error in step execution: tool call denied by pre-tool hook: ' + denial.reason) confirmed++;
    }
    if (confirmed !== this.managementDenials.size || this.pendingDenialStep !== undefined && event !== 'PostInvocation'
      || (event === 'PreToolUse' || event === 'PostToolUse') && this.managementDenials.has(payload.stepIdx as number)) this.fence(denialFailure);
    this.pendingDenialStep = undefined;
  }
  /** At an explicit worker abort there may be no Stop to perform the usual hook coverage check. */
  hasForegroundToolCoverage(rows: TranscriptRecord[]): boolean {
    const start = this.turnStart;
    return this.active && start !== undefined && rows.every(row =>
      row.type !== 'GENERIC' || row.step_index < start || this.observedTools.has(row.step_index));
  }
  suspendForeground(): boolean { return this.monitor.suspendForeground(); }
  async prompt(blocks: AcpContentBlock[], promptNative = (input: AcpContentBlock[]) => this.client.prompt(this.sessionId, input),
    admission: 'strict' | 'main' | 'confirmed-human' = 'strict'): Promise<{ success: boolean; output: string; stopReason: string }> {
    if (this.active || this.blocked || !this.reusable && !(admission === 'confirmed-human' && this.humanContinuation)) throw new Error(this.blocked ?? this.policyFailure ?? 'AGY chat is busy or has unsettled native work.');
    this.ordinaryMain = admission !== 'strict';
    this.settledHumanTurn = false;
    this.idleStop = false;
    this.turnStart = undefined; this.observedTools.clear(); this.postedTools.clear(); this.requiredTerminal = undefined;
    this.turnRejections.length = 0; this.dispatches.length = 0; this.invocationStart = undefined;
    this.monitor.beginForeground(); this.active = true; this.cancelled = false;
    try {
      const terminal = await Promise.race([promptNative(blocks), new Promise<never>((_, reject) => { this.rejectCancel = reject; })]);
      if (terminal.stopReason === 'cancelled' || this.cancelled) {
        if (this.requiredTerminal) this.fence(this.requiredTerminal);
        // Cancellation is not success and cannot discharge earlier hook faults.
        if (this.blocked) throw new Error(this.blocked);
        this.monitor = this.newMonitor();
        return { success: false, output: 'AGY foreground cancelled; completed side effects remain.', stopReason: 'cancelled' };
      }
      const result = this.monitor.endForeground();
      // The ACP prompt response follows every update of its turn.
      if (this.turnRejections.some(rejection => this.dispatches.some(update => agyDispatchConflicts(rejection, update)))) {
        this.fence(foregroundFailure);
      }
      const completed = terminal.stopReason === 'end_turn' && result?.success === true;
      const settled = this.ordinaryMain && this.idleStop && completed;
      const ordinaryTerminal = settled && this.requiredTerminal === foregroundFailure;
      if (this.requiredTerminal && (!completed || !this.reusable && !ordinaryTerminal || this.ordinaryCalls.size)) {
        this.fence(this.requiredTerminal);
      }
      if (!result || this.blocked) throw new Error(this.blocked ?? 'AGY foreground hook terminal is missing.');
      if (!this.reusable && !settled && this.policyFailure) throw new Error(this.policyFailure);
      if (this.ordinaryMain && !completed) {
        this.fence('AGY native foreground did not complete successfully.');
        return { ...result, success: false, stopReason: terminal.stopReason };
      }
      if (settled && !this.reusable) this.policyFailure ??= foregroundFailure;
      this.settledHumanTurn = settled;
      return { ...result, stopReason: terminal.stopReason };
    } catch (error) {
      this.fence('AGY chat outcome is unconfirmed; retained history cannot be resumed automatically.'); throw error;
    } finally {
      this.monitor.endForeground(); this.active = false; this.rejectCancel = undefined; this.ordinaryCalls.clear();
      if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    }
  }
  cancelForeground(): boolean {
    if (!this.active || this.cancelled) return false;
    this.cancelled = true; this.client.sendCancel(this.sessionId);
    this.timer = setTimeout(() => this.rejectCancel?.(new Error('AGY cancellation terminal remains unconfirmed.')), 5000);
    return true;
  }
}
