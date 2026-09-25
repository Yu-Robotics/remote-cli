import { v4 as uuidv4 } from 'uuid';
import type { OutgoingMessage, TaskResumeInfo } from '../types';

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
  recovered: boolean;
  recoveryFailures: number;
  recoveryPaused: boolean;
  result?: { success: boolean; error?: string; finishedAt: number };
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
    this.connected = false;
    this.clearTimers();
    this.inFlight = undefined;
    for (const entry of this.tasks.values()) {
      entry.needsRecovery = true;
      entry.recovered = true;
      entry.recoveryId = uuidv4();
      entry.recoveryFailures = 0;
      entry.recoveryPaused = false;
    }
  }

  registered(supported: boolean): void {
    this.connected = true;
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

  send(message: any): void {
    const entry = this.tasks.get(message.messageId);
    if (!entry) {
      this.sendRaw(message);
      return;
    }
    if (message.type === 'response' && typeof message.success === 'boolean') {
      entry.result = { success: message.success, error: message.error?.slice(0, 500), finishedAt: Date.now() };
      if (typeof message.cwd === 'string') entry.task.cwd = message.cwd.slice(0, 4096);
      this.prune();
    }
    if (!this.connected || entry.needsRecovery) {
      this.pump();
      return;
    }
    // Aggregate plans and final bodies may contain text generated before reconnecting.
    if (entry.recovered && (message.streamType === 'plan_mode' || message.type === 'structured')) return;
    try {
      this.sendRaw(entry.recovered && message.type === 'response'
        ? { ...message, output: undefined, error: entry.result?.error } : message);
    } catch (error) {
      this.disconnected();
      return;
    }
    if (entry.result) {
      if (!this.supported) this.tasks.delete(message.messageId);
      else this.waitForResultReceipt();
    }
  }

  acknowledge(message: any): void {
    if (message.type === 'task_result_ack') {
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
            error: entry.result.error, timestamp: Date.now() });
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
    };
    this.inFlight = { messageId: task.messageId, recoveryId: entry.recoveryId, state: taskResume.state };
    this.acknowledgementTimer = setTimeout(() => this.failRecovery(), RETRY_DELAY);
    this.acknowledgementTimer.unref?.();
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
      console.error(`[TaskRecovery] Pausing task ${entry.task.messageId} after ${entry.recoveryFailures} failed recovery attempts; recovery will wait for another connection.`);
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
    if (this.resultTimer || !this.connected || !this.supported) return;
    this.resultTimer = setTimeout(() => {
      this.resultTimer = undefined;
      for (const entry of this.tasks.values()) {
        if (entry.result && !entry.recoveryPaused) { entry.needsRecovery = true; entry.recovered = true; }
      }
      this.pump();
    }, RETRY_DELAY);
    this.resultTimer.unref?.();
  }

  private clearAcknowledgementTimer(): void {
    if (this.acknowledgementTimer) clearTimeout(this.acknowledgementTimer);
    this.acknowledgementTimer = undefined;
  }

  private clearTimers(): void {
    this.clearAcknowledgementTimer();
    if (this.retry) clearTimeout(this.retry.timer);
    this.retry = undefined;
    if (this.resultTimer) clearTimeout(this.resultTimer);
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
