import type { AcpTransport } from '../acp/AcpClient';
import type { AcpContentBlock } from '../acp/AcpTypes';
import { AgySessionSchedules, type HookPayload } from '../../scheduling/agy/AgySessionSchedules';
import { creationReceipt, nativeWake, type TranscriptRecord } from '../../scheduling/agy/transcript';

/** Ordinary ACP chat with scheduling permanently unavailable. The hook terminal
 * remains authoritative. This host never supplies original schedule admission. */
export class AgyChatHost {
  private records: TranscriptRecord[] = [];
  private turnStart?: number;
  private readonly observedTools = new Set<number>();
  private monitor: AgySessionSchedules;
  private failure?: string;
  get reusable(): boolean { return !this.blocked && !this.records.some(row => creationReceipt(row, this.sessionId, row.step_index) || nativeWake(row) || row.type === 'GENERIC' && row.status !== 'DONE'); }
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
  accept(event: string, payload: HookPayload, records: TranscriptRecord[]) {
    this.records = records;
    if (event === 'PreInvocation' && this.turnStart === undefined && Number.isSafeInteger(payload.initialNumSteps)) this.turnStart = payload.initialNumSteps as number;
    if (event === 'PreToolUse' && Number.isSafeInteger(payload.stepIdx)) this.observedTools.add(payload.stepIdx as number);
    if (event === 'Stop' && records.some(row => row.type === 'GENERIC' && row.step_index >= (this.turnStart ?? Infinity) && !this.observedTools.has(row.step_index))) {
      this.fence('AGY tool hook coverage is incomplete; this conversation is not reusable.');
    }
    if (records.some(nativeWake)) this.fence('Unexpected native reminders were observed; this conversation is not reusable.');
    if (records.some(row => creationReceipt(row, this.sessionId, row.step_index))) this.fence('AGY background-task creation was observed; explicit clear is required before reuse.');
    const decision = this.monitor.accept(event, payload, records);
    // A relay decision is only a request: native hook execution can fail open
    // after receiving it. Never grant continuity from a later DONE/Stop success.
    if (event === 'PreToolUse' && decision.decision === 'deny') this.fence('AGY tool denial enforcement is unconfirmed; explicit clear is required before reuse.');
    if (this.failure) return event === 'PreInvocation' ? { terminationBehavior: 'terminate' as const }
      : event === 'PreToolUse' ? { decision: 'deny' as const, reason: this.failure } : {};
    return decision;
  }
  async prompt(blocks: AcpContentBlock[]): Promise<{ success: boolean; output: string; stopReason: string }> {
    if (this.active || this.blocked || !this.reusable) throw new Error(this.blocked ?? 'AGY chat is busy or has unsettled native work.');
    this.turnStart = undefined; this.observedTools.clear();
    this.monitor.beginForeground(); this.active = true; this.cancelled = false;
    try {
      const terminal = await Promise.race([this.client.prompt(this.sessionId, blocks), new Promise<never>((_, reject) => { this.rejectCancel = reject; })]);
      if (terminal.stopReason === 'cancelled' || this.cancelled) {
        // Cancellation is not success and cannot discharge earlier hook faults.
        if (this.blocked) throw new Error(this.blocked);
        this.monitor = this.newMonitor();
        return { success: false, output: 'AGY foreground cancelled; completed side effects remain.', stopReason: 'cancelled' };
      }
      const result = this.monitor.endForeground();
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
