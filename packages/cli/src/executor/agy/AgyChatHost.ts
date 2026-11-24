import { randomUUID } from 'crypto';
import { isDeepStrictEqual } from 'util';
import type { AcpTransport } from '../acp/AcpClient';
import type { AcpContentBlock } from '../acp/AcpTypes';
import type { AgyCommandTasks } from './AgyCommandTasks';
import { AgySessionSchedules, type HookPayload } from '../../scheduling/agy/AgySessionSchedules';
import { creationReceipt, nativeWake, receiptText, type TranscriptRecord } from '../../scheduling/agy/transcript';

const listCall = { name: 'manage_task', args: { Action: 'list' } };
const denialFailure = 'AGY tool denial enforcement is unconfirmed; explicit clear is required before reuse.';
const foregroundFailure = 'AGY foreground tool outcome is unconfirmed; explicit clear is required before reuse.';

/** Ordinary ACP chat with scheduling permanently unavailable. The hook terminal
 * remains authoritative. This host never supplies original schedule admission. */
export class AgyChatHost {
  private records: TranscriptRecord[] = [];
  private turnStart?: number;
  private readonly observedTools = new Set<number>();
  private monitor: AgySessionSchedules;
  private failure?: string;
  // Live evidence only. A newly loaded session cannot inherit these exceptions.
  private readonly managementDenials = new Map<number, { reason: string; planner: TranscriptRecord }>();
  private pendingDenialStep?: number;
  private requiredTerminal?: string;
  private readonly ordinaryCalls = new Map<number, { call: unknown; planner: TranscriptRecord; error?: string }>();
  private readonly toolErrors = new Map<number, { planner: TranscriptRecord; receipt: TranscriptRecord }>();
  private admittedKill = false;
  get reusable(): boolean { return !this.blocked && this.pendingDenialStep === undefined && !this.records.some(row =>
    creationReceipt(row, this.sessionId, row.step_index) || nativeWake(row)
    || row.type === 'GENERIC' && row.status !== 'DONE' && !this.managementDenials.has(row.step_index)
      && !this.toolErrors.has(row.step_index)); }
  get hasForegroundToolErrors(): boolean { return this.toolErrors.size > 0; }
  get liveManagement(): boolean { return this.managementDenials.size > 0 || this.admittedKill; }
  private active = false;
  private cancelled = false;
  private rejectCancel?: (error: Error) => void;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly client: AcpTransport, readonly sessionId: string,
    private readonly cwd: string, private readonly threadId: string, initialRecords: TranscriptRecord[] = []) {
    this.records = initialRecords;
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
    commands?: AgyCommandTasks, fullHistory = records) {
    this.records = records;
    if (this.requiredTerminal && this.active && !allowForegroundManagement) this.fence(this.requiredTerminal);
    if (this.managementDenials.size) this.verifyManagementDenials(event, payload, records);
    if (event === 'PreInvocation' && this.turnStart === undefined && Number.isSafeInteger(payload.initialNumSteps)) this.turnStart = payload.initialNumSteps as number;
    const duplicateTool = this.observedTools.has(payload.stepIdx as number);
    if (event === 'PreToolUse' && Number.isSafeInteger(payload.stepIdx)) this.observedTools.add(payload.stepIdx as number);
    if (event === 'Stop' && records.some(row => row.type === 'GENERIC' && row.step_index >= (this.turnStart ?? Infinity) && !this.observedTools.has(row.step_index))) {
      this.fence('AGY tool hook coverage is incomplete; this conversation is not reusable.');
    }
    const start = this.turnStart ?? Infinity;
    if (event === 'Stop' && this.active && records.some(row => row.step_index >= start && this.toolErrors.has(row.step_index))) {
      const last = records.at(-1);
      const settled = payload.fullyIdle === true || payload.fullyIdle === false && commands?.ordinaryCommandsPending;
      if (payload.continuationActive !== false || !settled || last?.type !== 'PLANNER_RESPONSE'
        || last.source !== 'MODEL' || last.status !== 'DONE' || last.tool_calls?.length) this.fence(foregroundFailure);
    }
    if (records.some(nativeWake)) this.fence('Unexpected native reminders were observed; this conversation is not reusable.');
    if (records.some(row => creationReceipt(row, this.sessionId, row.step_index))) this.fence('AGY background-task creation was observed; explicit clear is required before reuse.');
    const decision = this.monitor.accept(event, payload, records);
    this.observeOrdinaryTool(event, payload, records, allowForegroundManagement && this.active && !this.cancelled
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
        if (proof && isDeepStrictEqual(row, proof.receipt) && isDeepStrictEqual(records[index - 1], proof.planner)) verified++;
      }
      if (verified !== this.toolErrors.size || (event === 'PreToolUse' || event === 'PostToolUse')
        && this.toolErrors.has(payload.stepIdx as number)) this.fence(foregroundFailure);
    }
    const tail = records.at(-1);
    // The error hook precedes its transcript receipt. Join it at the end of the same invocation.
    if (event === 'PostInvocation') {
      for (const [step, pending] of this.ordinaryCalls) {
        const index = records.findIndex(row => row.step_index === step);
        const row = records[index];
        if (!pending.error) {
          if (row?.status !== 'DONE') this.fence(foregroundFailure);
          continue;
        }
        if (foreground && row?.status === 'ERROR' && !row.tool_calls?.length
          && isDeepStrictEqual(records[index - 1], pending.planner)
          && receiptText(row) === 'Encountered error in step execution: ' + pending.error) {
          this.toolErrors.set(step, { planner: pending.planner, receipt: structuredClone(row) });
        } else this.fence(foregroundFailure);
      }
      this.ordinaryCalls.clear();
      return;
    }
    const step = payload.stepIdx as number;
    const pending = this.ordinaryCalls.get(step);
    if (pending && event === 'PostToolUse') {
      if (!payload.error && !pending.error) { this.ordinaryCalls.delete(step); return; }
      this.requiredTerminal ??= foregroundFailure;
      if (!foreground || pending.error || !isDeepStrictEqual(payload.toolCall, pending.call)
        || !isDeepStrictEqual(tail, pending.planner) || typeof payload.error !== 'string' || !payload.error.trim()
        || payload.error.startsWith('tool call denied by pre-tool hook:')) this.fence(foregroundFailure);
      else pending.error = payload.error;
      return;
    }
    if (!foreground || !tail) return;
    if (pending && event === 'PreToolUse') { this.fence(foregroundFailure); return; }
    const call = payload.toolCall as { id?: unknown; name?: unknown; args?: unknown } | undefined;
    const start = this.monitor.foregroundInvocationStart;
    if (event === 'PreToolUse' && admitted && start !== undefined && step > start && tail.step_index === step - 1
      && typeof call?.name === 'string' && !['run_command', 'manage_task', 'schedule', 'ask_question'].includes(call.name)
      && typeof call.id === 'string' && call.id.length > 0 && call.id.length <= 256
      && call.args && typeof call.args === 'object' && !Array.isArray(call.args) && tail.source === 'MODEL'
      && tail.type === 'PLANNER_RESPONSE' && tail.status === 'DONE' && isDeepStrictEqual(tail.tool_calls, [{ name: call.name, args: call.args }])) {
      this.ordinaryCalls.set(step, { call: structuredClone(call), planner: structuredClone(tail) });
    }
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
  suspendForeground(): boolean { return this.monitor.suspendForeground(); }
  async prompt(blocks: AcpContentBlock[], promptNative = (input: AcpContentBlock[]) => this.client.prompt(this.sessionId, input)): Promise<{ success: boolean; output: string; stopReason: string }> {
    if (this.active || this.blocked || !this.reusable) throw new Error(this.blocked ?? 'AGY chat is busy or has unsettled native work.');
    this.turnStart = undefined; this.observedTools.clear(); this.requiredTerminal = undefined;
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
      if (this.requiredTerminal && (terminal.stopReason !== 'end_turn' || !result?.success || !this.reusable || this.ordinaryCalls.size)) {
        this.fence(this.requiredTerminal);
      }
      if (!result || this.blocked) throw new Error(this.blocked ?? 'AGY foreground hook terminal is missing.');
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
