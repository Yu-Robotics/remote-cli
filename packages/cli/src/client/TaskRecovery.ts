import { parseAttachmentHints, type AttachmentHints } from '../output/Protocol';
import { taskCorrelation, taskEvent } from './TaskDiagnostics';
import { v4 as uuidv4 } from 'uuid';
import type { OutgoingMessage, TaskResumeInfo, ExecutionMetadata } from '../types';
import { boundExecutionMetadata } from '../executor/ExecutionMetadata';

export interface RecoverableTask {
  messageId: string;
  openId: string;
  threadId: string;
  threadName: string;
  backend: string;
  cwd: string;
  preview: string;
}

interface TaskState {
  task: RecoverableTask;
  recoveryId: string;
  needsRecovery: boolean;
  recoveryReason?: 'connection_loss' | 'result_ack_timeout';
  recovered: boolean;
  recoveryFailures: number;
  recoveryPaused: boolean;
  result?: { success: boolean; error?: string; finishedAt: number; attachmentHints?: AttachmentHints; executionMetadata?: ExecutionMetadata };
}

const RESULT_TTL = 24 * 60 * 60 * 1000;
const MAX_RESULTS = 100;
const RETRY_DELAY = 15000;
const MAX_RETRY_DELAY = 5 * 60 * 1000;
// Bound consecutive failures within a recovery round, not successful reconnects.
const MAX_RECOVERY_FAILURES = 20;

/** Keeps bounded task metadata across socket reconnects, never process output. */
export class TaskRecovery {
  private tasks = new Map<string, TaskState>();
  private connected = true;
  private supported = false;
  private inFlight?: { messageId: string; recoveryId: string; state: TaskResumeInfo['state'] };
  private acknowledgementTimer?: NodeJS.Timeout;
  private retry?: { messageId: string; timer: NodeJS.Timeout };
  private resultTimer?: NodeJS.Timeout;
  private receiptSequence = 0;
  private receiptArmedAt = 0;
  private connectionEpoch = 0;
  private hintsSupported = false;

  constructor(private readonly sendRaw: (message: any) => void) {}

  track(task: RecoverableTask): void {
    this.tasks.set(task.messageId, {
      task: { ...task, threadName: task.threadName.slice(0, 100), backend: task.backend.slice(0, 100),
        cwd: task.cwd.slice(0, 4096), preview: task.preview.replace(/\s+/g, ' ').slice(0, 240) },
      recoveryId: uuidv4(), needsRecovery: !this.connected, recovered: !this.connected,
      recoveryFailures: 0, recoveryPaused: false,
    });
  }

  disconnected(): void {
    taskEvent('recovery_disconnected', { connectionEpoch: this.connectionEpoch, tasks: this.tasks.size });
    this.connected = false;
    this.clearTimers();
    this.inFlight = undefined;
    for (const entry of this.tasks.values()) {
      entry.needsRecovery = true;
      entry.recoveryReason = 'connection_loss';
      entry.recovered = true;
      entry.recoveryId = uuidv4();
      entry.recoveryFailures = 0;
      entry.recoveryPaused = false;
    }
  }

  registered(supported: boolean, connectionEpoch?: number, hintsSupported = false): void {
    this.connectionEpoch = connectionEpoch ?? this.connectionEpoch + 1;
    taskEvent('recovery_registered', { connectionEpoch: this.connectionEpoch, supported });
    this.connected = true;
    this.hintsSupported = hintsSupported;
    this.supported = supported;
    if (!supported) {
      this.clearTimers();
      this.inFlight = undefined;
      for (const [id, entry] of this.tasks) {
        if (entry.result) this.tasks.delete(id);
        else entry.needsRecovery = false;
      }
    }
    this.pump();
  }

  canSendTaskOutput(messageId: string): boolean {
    return this.connected && !this.tasks.get(messageId)?.needsRecovery;
  }

  /** Return local transport acceptance, not a remote delivery acknowledgement. */
  send(message: any): boolean {
    if (message.type === 'response') {
      const { attachmentHints, ...response } = message;
      const hints = this.hintsSupported ? parseAttachmentHints(attachmentHints) : undefined;
      message = { ...response, ...(hints ? { attachmentHints: hints } : {}) };
    }
    const entry = this.tasks.get(message.messageId);
    if (!entry) {
      this.sendRaw(message);
      return true;
    }
    if (message.type === 'response' && typeof message.success === 'boolean') {
      entry.result = { success: message.success, error: message.error?.slice(0, 500), finishedAt: Date.now(),
        ...(message.attachmentHints ? { attachmentHints: message.attachmentHints } : {}) };
      if (message.executionMetadata?.backend === entry.task.backend) {
        entry.result.executionMetadata = boundExecutionMetadata(message.executionMetadata, entry.task.backend);
      }
      if (typeof message.cwd === 'string') entry.task.cwd = message.cwd.slice(0, 4096);
      this.prune();
    }
    if (!this.connected || entry.needsRecovery) {
      if (message.type === 'response') this.resultEvent(message.messageId, false);
      this.pump();
      return false;
    }
    // Aggregate plans and final bodies may contain text generated before reconnecting.
    if (entry.recovered && (message.streamType === 'plan_mode' || message.type === 'structured')) return false;
    try {
      this.sendRaw(entry.recovered && message.type === 'response'
        ? { ...message, output: undefined, error: entry.result?.error } : message);
    } catch (error) {
      if (message.type === 'response') this.resultEvent(message.messageId, false);
      this.disconnected();
      return false;
    }
    if (message.type === 'response') this.resultEvent(message.messageId, true);
    if (entry.result) {
      if (!this.supported) this.tasks.delete(message.messageId);
      else this.waitForResultReceipt();
    }
    return true;
  }

  acknowledge(message: any): void {
    if (message.type === 'task_result_ack') {
      taskEvent('result_ack_received', { task: taskCorrelation(message.messageId),
        trackedResult: !!this.tasks.get(message.messageId)?.result, connected: this.connected, connectionEpoch: this.connectionEpoch });
      if (this.tasks.get(message.messageId)?.result) this.tasks.delete(message.messageId);
      if (this.inFlight?.messageId === message.messageId) {
        this.inFlight = undefined;
        this.clearAcknowledgementTimer();
      }
      if (this.retry && this.retry.messageId === message.messageId) {
        clearTimeout(this.retry.timer);
        this.retry = undefined;
      }
      this.pump();
      return;
    }
    const pending = this.inFlight;
    if (!pending || pending.messageId !== message.messageId || pending.recoveryId !== message.recoveryId
      || pending.state !== message.state) return;
    taskEvent('resume_ack_received', { task: taskCorrelation(message.messageId), success: message.success === true,
      connected: this.connected, connectionEpoch: this.connectionEpoch });
    if (message.success !== true) {
      this.failRecovery();
      return;
    }
    this.inFlight = undefined;
    this.clearAcknowledgementTimer();
    const entry = this.tasks.get(message.messageId);
    if (entry) {
      entry.recoveryFailures = 0;
      if (pending.state !== 'running') this.tasks.delete(message.messageId);
      else {
        entry.needsRecovery = false;
        if (entry.result) {
          this.send({ type: 'response', messageId: message.messageId, openId: entry.task.openId,
            threadId: entry.task.threadId, cwd: entry.task.cwd, success: entry.result.success,
            error: entry.result.error, ...(this.hintsSupported && entry.result.attachmentHints ? { attachmentHints: entry.result.attachmentHints } : {}), timestamp: Date.now() });
        }
      }
    }
    this.pump();
  }

  hasPendingResults(): boolean {
    this.prune();
    return Array.from(this.tasks.values()).some(entry => !!entry.result && !entry.recoveryPaused);
  }

  destroy(): void {
    this.clearTimers();
    this.tasks.clear();
    this.inFlight = undefined;
  }

  private pump(): void {
    this.prune();
    if (!this.connected || !this.supported || this.inFlight || this.retry) return;
    const entry = Array.from(this.tasks.values()).find(item => item.needsRecovery && !item.recoveryPaused);
    if (!entry) {
      if (this.hasPendingResults()) this.waitForResultReceipt();
      return;
    }
    const { task, result } = entry;
    const taskResume: TaskResumeInfo = {
      recoveryId: entry.recoveryId, threadName: task.threadName, backend: task.backend,
      cwd: task.cwd, preview: task.preview,
      state: result ? (result.success ? 'completed' : 'failed') : 'running', error: result?.error,
      ...(result?.executionMetadata ? { executionMetadata: result.executionMetadata } : {}),
      ...(this.hintsSupported && result?.attachmentHints ? { attachmentHints: result.attachmentHints } : {}),
    };
    this.inFlight = { messageId: task.messageId, recoveryId: entry.recoveryId, state: taskResume.state };
    this.acknowledgementTimer = setTimeout(() => this.failRecovery(), RETRY_DELAY);
    this.acknowledgementTimer.unref?.();
    taskEvent('task_resume_send', { task: taskCorrelation(task.messageId), state: taskResume.state,
      reason: entry.recoveryReason ?? 'connection_loss', connected: this.connected, connectionEpoch: this.connectionEpoch });
    try {
      this.sendRaw({ type: 'task_resume', messageId: task.messageId, openId: task.openId,
        threadId: task.threadId, taskResume, timestamp: Date.now() } satisfies OutgoingMessage);
    } catch {
      this.disconnected();
    }
  }

  private failRecovery(): void {
    const pending = this.inFlight;
    if (!pending) return;
    this.inFlight = undefined;
    this.clearAcknowledgementTimer();
    const entry = this.tasks.get(pending.messageId);
    if (!entry) {
      this.pump();
      return;
    }
    entry.recoveryFailures += 1;
    if (entry.recoveryFailures >= MAX_RECOVERY_FAILURES) {
      // Keep the record so late output cannot bypass recovery or replay history.
      // A new connection starts another round; terminal records remain bounded.
      entry.recoveryPaused = true;
      taskEvent('recovery_paused', { task: taskCorrelation(entry.task.messageId), failures: entry.recoveryFailures });
      this.pump();
      return;
    }
    const delay = Math.min(RETRY_DELAY * 2 ** entry.recoveryFailures, MAX_RETRY_DELAY);
    const timer = setTimeout(() => {
      this.retry = undefined;
      this.pump();
    }, delay);
    timer.unref?.();
    this.retry = { messageId: pending.messageId, timer };
  }

  private waitForResultReceipt(): void {
    if (this.resultTimer) {
      taskEvent('result_receipt_timer_reused', { timer: this.receiptSequence, armedAt: this.receiptArmedAt,
        connected: this.connected, connectionEpoch: this.connectionEpoch });
      return;
    }
    if (!this.connected || !this.supported) return;
    const timer = ++this.receiptSequence;
    this.receiptArmedAt = Date.now();
    taskEvent('result_receipt_timer_armed', { timer, armedAt: this.receiptArmedAt, delayMs: RETRY_DELAY,
      connected: this.connected, connectionEpoch: this.connectionEpoch });
    this.resultTimer = setTimeout(() => {
      this.resultTimer = undefined;
      taskEvent('result_receipt_timer_fired', { timer, armedAt: this.receiptArmedAt, firedAt: Date.now(),
        connected: this.connected, connectionEpoch: this.connectionEpoch });
      for (const entry of this.tasks.values()) {
        if (entry.result && !entry.recoveryPaused) {
          entry.needsRecovery = true; entry.recovered = true; entry.recoveryReason = 'result_ack_timeout';
        }
      }
      this.pump();
    }, RETRY_DELAY);
    this.resultTimer.unref?.();
  }

  private resultEvent(messageId: string, acceptedLocally: boolean): void {
    taskEvent('result_send', { task: taskCorrelation(messageId), acceptedLocally,
      connected: this.connected, connectionEpoch: this.connectionEpoch, receiptTimer: this.resultTimer ? this.receiptSequence : undefined });
  }

  private clearAcknowledgementTimer(): void {
    if (this.acknowledgementTimer) clearTimeout(this.acknowledgementTimer);
    this.acknowledgementTimer = undefined;
  }

  private clearTimers(): void {
    this.clearAcknowledgementTimer();
    if (this.retry) clearTimeout(this.retry.timer);
    this.retry = undefined;
    if (this.resultTimer) {
      taskEvent('result_receipt_timer_cleared', { timer: this.receiptSequence, connectionEpoch: this.connectionEpoch });
      clearTimeout(this.resultTimer);
    }
    this.resultTimer = undefined;
  }

  private prune(): void {
    const completed = Array.from(this.tasks.entries()).filter(([, task]) => task.result)
      .sort(([, left], [, right]) => left.result!.finishedAt - right.result!.finishedAt);
    completed.forEach(([id, task], index) => {
      if (Date.now() - task.result!.finishedAt > RESULT_TTL || index < completed.length - MAX_RESULTS) this.tasks.delete(id);
    });
  }
}
