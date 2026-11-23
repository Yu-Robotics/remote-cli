import { randomUUID } from 'crypto';
import { isDeepStrictEqual } from 'util';
import type { AcpTransport } from '../acp/AcpClient';
import type { AcpContentBlock } from '../acp/AcpTypes';
import type { AgyCommandTasks } from './AgyCommandTasks';
import { AgySessionSchedules, type HookPayload } from '../../scheduling/agy/AgySessionSchedules';
import { creationReceipt, nativeWake, receiptText, type TranscriptRecord } from '../../scheduling/agy/transcript';

const listCall = { name: 'manage_task', args: { Action: 'list' } };
const denialFailure = 'AGY tool denial enforcement is unconfirmed; explicit clear is required before reuse.';

/** Ordinary ACP chat with scheduling permanently unavailable. The hook terminal
 * remains authoritative. This host never supplies original schedule admission. */
export class AgyChatHost {
  private records: TranscriptRecord[] = [];
  private turnStart?: number;
  private readonly observedTools = new Set<number>();
  private monitor: AgySessionSchedules;
  private failure?: string;
  // Live evidence only. A newly loaded session cannot inherit these exceptions.
  private readonly listDenials = new Map<number, string>();
  private pendingListStep?: number;
  private managedThisTurn = false;
  private admittedKill = false;
  get reusable(): boolean { return !this.blocked && this.pendingListStep === undefined && !this.records.some(row =>
    creationReceipt(row, this.sessionId, row.step_index) || nativeWake(row)
    || row.type === 'GENERIC' && row.status !== 'DONE' && !this.listDenials.has(row.step_index)); }
  get liveManagement(): boolean { return this.listDenials.size > 0 || this.admittedKill; }
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
  accept(event: string, payload: HookPayload, records: TranscriptRecord[], allowForegroundManagement = false, commands?: AgyCommandTasks) {
    this.records = records;
    if (this.managedThisTurn && this.active && !allowForegroundManagement) this.fence(denialFailure);
    if (this.listDenials.size) this.verifyListDenials(event, payload, records);
    if (event === 'PreInvocation' && this.turnStart === undefined && Number.isSafeInteger(payload.initialNumSteps)) this.turnStart = payload.initialNumSteps as number;
    const duplicateTool = this.observedTools.has(payload.stepIdx as number);
    if (event === 'PreToolUse' && Number.isSafeInteger(payload.stepIdx)) this.observedTools.add(payload.stepIdx as number);
    if (event === 'Stop' && records.some(row => row.type === 'GENERIC' && row.step_index >= (this.turnStart ?? Infinity) && !this.observedTools.has(row.step_index))) {
      this.fence('AGY tool hook coverage is incomplete; this conversation is not reusable.');
    }
    if (records.some(nativeWake)) this.fence('Unexpected native reminders were observed; this conversation is not reusable.');
    if (records.some(row => creationReceipt(row, this.sessionId, row.step_index))) this.fence('AGY background-task creation was observed; explicit clear is required before reuse.');
    const decision = this.monitor.accept(event, payload, records);
    // A relay decision is only a request: native hook execution can fail open
    // after receiving it. Never grant continuity from a later DONE/Stop success.
    if (event === 'PreToolUse' && decision.decision === 'deny') {
      const step = payload.stepIdx as number;
      const call = payload.toolCall as { name?: unknown; args?: unknown; id?: unknown } | undefined;
      const start = this.monitor.foregroundInvocationStart;
      const planner = records.at(-1);
      if (allowForegroundManagement && this.active && !this.cancelled && !duplicateTool && !this.blocked && start !== undefined
        && Number.isSafeInteger(step) && step > start && typeof call?.id === 'string' && call.id.length > 0 && call.id.length <= 256
        && call.name === listCall.name && planner && this.managementPlanner(planner, step, call.args)) {
        if (isDeepStrictEqual(call.args, listCall.args)) {
          const reason = 'Native task listing is unavailable in ordinary chat (' + randomUUID() + ').';
          this.listDenials.set(step, reason);
          this.pendingListStep = step;
          this.managedThisTurn = true;
          return { decision: 'deny' as const, reason };
        }
        if (commands?.admitKill(step, call.id, call.args, planner)) {
          this.admittedKill = this.managedThisTurn = true;
          return { decision: 'allow' as const };
        }
      }
      this.fence(denialFailure);
    }
    if (this.failure) return event === 'PreInvocation' ? { terminationBehavior: 'terminate' as const }
      : event === 'PreToolUse' ? { decision: 'deny' as const, reason: this.failure } : {};
    return decision;
  }
  private managementPlanner(row: TranscriptRecord | undefined, step: number, args: unknown): boolean {
    return row?.step_index === step - 1 && row.source === 'MODEL' && row.type === 'PLANNER_RESPONSE'
      && row.status === 'DONE' && isDeepStrictEqual(row.tool_calls, [{ name: listCall.name, args }]);
  }
  private verifyListDenials(event: string, payload: HookPayload, records: TranscriptRecord[]): void {
    // The relay supplies unique, ordered steps from this session's anchored native transcript.
    let confirmed = 0;
    for (const [index, row] of records.entries()) {
      const reason = this.listDenials.get(row.step_index);
      if (reason === undefined) continue;
      if (this.managementPlanner(records[index - 1], row.step_index, listCall.args) && row.status === 'ERROR' && !row.tool_calls?.length
        && receiptText(row) === 'Encountered error in step execution: tool call denied by pre-tool hook: ' + reason) confirmed++;
    }
    if (confirmed !== this.listDenials.size || this.pendingListStep !== undefined && event !== 'PostInvocation'
      || (event === 'PreToolUse' || event === 'PostToolUse') && this.listDenials.has(payload.stepIdx as number)) this.fence(denialFailure);
    this.pendingListStep = undefined;
  }
  suspendForeground(): boolean { return this.monitor.suspendForeground(); }
  async prompt(blocks: AcpContentBlock[], promptNative = (input: AcpContentBlock[]) => this.client.prompt(this.sessionId, input)): Promise<{ success: boolean; output: string; stopReason: string }> {
    if (this.active || this.blocked || !this.reusable) throw new Error(this.blocked ?? 'AGY chat is busy or has unsettled native work.');
    this.turnStart = undefined; this.observedTools.clear(); this.managedThisTurn = false;
    this.monitor.beginForeground(); this.active = true; this.cancelled = false;
    try {
      const terminal = await Promise.race([promptNative(blocks), new Promise<never>((_, reject) => { this.rejectCancel = reject; })]);
      if (terminal.stopReason === 'cancelled' || this.cancelled) {
        if (this.managedThisTurn) this.fence(denialFailure);
        // Cancellation is not success and cannot discharge earlier hook faults.
        if (this.blocked) throw new Error(this.blocked);
        this.monitor = this.newMonitor();
        return { success: false, output: 'AGY foreground cancelled; completed side effects remain.', stopReason: 'cancelled' };
      }
      const result = this.monitor.endForeground();
      if (this.managedThisTurn && (this.pendingListStep !== undefined || terminal.stopReason !== 'end_turn' || !result?.success || !this.reusable)) {
        this.fence(denialFailure);
      }
      if (!result || this.blocked) throw new Error(this.blocked ?? 'AGY foreground hook terminal is missing.');
      return { ...result, stopReason: terminal.stopReason };
    } catch (error) {
      this.fence('AGY chat outcome is unconfirmed; retained history cannot be resumed automatically.'); throw error;
    } finally {
      this.monitor.endForeground(); this.active = false; this.rejectCancel = undefined;
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
