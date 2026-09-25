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
  recoveryAttempts: number;
  result?: { success: boolean; error?: string; finishedAt: number };
}

const RESULT_TTL = 24 * 60 * 60 * 1000;
const MAX_RESULTS = 100;
const RETRY_DELAY = 15000;
const MAX_RETRY_DELAY = 5 * 60 * 1000;
// Bounds total recovery effort per task so a permanently failing receiver
// (e.g. Feishu outage) does not retry forever.
const MAX_RECOVERY_ATTEMPTS = 20;

/** Keeps bounded task metadata across socket reconnects, never process output. */
export class TaskRecovery {
  private tasks = new Map<string, TaskState>();
  private connected = true;
  private supported = false;
  private inFlight?: { messageId: string; recoveryId: string; state: TaskResumeInfo['state'] };
  private retryTimer?: NodeJS.Timeout;
  private consecutiveFailures = 0;

  constructor(private readonly sendRaw: (message: any) => void) {}

  track(task: RecoverableTask): void {
    this.tasks.set(task.messageId, {
      task: { ...task, threadName: task.threadName.slice(0, 100), backend: task.backend.slice(0, 100),
        cwd: task.cwd.slice(0, 4096), preview: task.preview.replace(/\s+/g, ' ').slice(0, 240) },
      recoveryId: uuidv4(), needsRecovery: !this.connected, recovered: !this.connected,
      recoveryAttempts: 0,
    });
  }

  disconnected(): void {
    this.connected = false;
    this.clearTimer();
    this.inFlight = undefined;
    for (const entry of this.tasks.values()) {
      entry.needsRecovery = true;
      entry.recovered = true;
      entry.recoveryId = uuidv4();
    }
  }

  registered(supported: boolean): void {
    this.connected = true;
    this.supported = supported;
    this.consecutiveFailures = 0;
    if (!supported) {
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
      else this.scheduleRetry();
    }
  }

  acknowledge(message: any): void {
    if (message.type === 'task_result_ack') {
      if (this.tasks.get(message.messageId)?.result) this.tasks.delete(message.messageId);
      if (this.inFlight?.messageId === message.messageId) {
        this.inFlight = undefined;
        this.clearTimer();
      }
      this.pump();
      return;
    }
    const pending = this.inFlight;
    if (!pending || pending.messageId !== message.messageId || pending.recoveryId !== message.recoveryId
      || pending.state !== message.state) return;
    this.inFlight = undefined;
    this.clearTimer();
    const entry = this.tasks.get(message.messageId);
    if (entry && message.success === true) {
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
    if (message.success === true) {
      this.consecutiveFailures = 0;
      this.pump();
    } else {
      this.consecutiveFailures += 1;
      this.scheduleRetry();
    }
  }

  hasPendingResults(): boolean {
    this.prune();
    return Array.from(this.tasks.values()).some(entry => !!entry.result);
  }

  destroy(): void {
    this.clearTimer();
    this.tasks.clear();
    this.inFlight = undefined;
  }

  private pump(): void {
    this.prune();
    if (!this.connected || !this.supported || this.inFlight) return;
    let entry: TaskState | undefined;
    for (const item of this.tasks.values()) {
      if (!item.needsRecovery) continue;
      if (item.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
        console.error(`[TaskRecovery] Giving up on task ${item.task.messageId} after ${item.recoveryAttempts} recovery attempts; its status will not be recovered.`);
        this.tasks.delete(item.task.messageId);
        continue;
      }
      entry = item;
      break;
    }
    if (!entry) {
      if (this.hasPendingResults()) this.scheduleRetry();
      return;
    }
    entry.recoveryAttempts += 1;
    const { task, result } = entry;
    const taskResume: TaskResumeInfo = {
      recoveryId: entry.recoveryId, threadName: task.threadName, backend: task.backend,
      cwd: task.cwd, preview: task.preview,
      state: result ? (result.success ? 'completed' : 'failed') : 'running', error: result?.error,
    };
    this.inFlight = { messageId: task.messageId, recoveryId: entry.recoveryId, state: taskResume.state };
    try {
      this.sendRaw({ type: 'task_resume', messageId: task.messageId, openId: task.openId,
        threadId: task.threadId, taskResume, timestamp: Date.now() } satisfies OutgoingMessage);
      this.scheduleRetry();
    } catch {
      this.disconnected();
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer || !this.connected || !this.supported) return;
    // Exponential backoff per consecutive failure (nack or lost ack), so a
    // persistent receiver failure does not hammer the socket and Feishu API.
    const delay = Math.min(RETRY_DELAY * 2 ** this.consecutiveFailures, MAX_RETRY_DELAY);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.consecutiveFailures += 1;
      this.inFlight = undefined;
      for (const entry of this.tasks.values()) {
        if (entry.result) { entry.needsRecovery = true; entry.recovered = true; }
      }
      this.pump();
    }, delay);
    this.retryTimer.unref?.();
  }

  private clearTimer(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private prune(): void {
    const completed = Array.from(this.tasks.entries()).filter(([, task]) => task.result)
      .sort(([, left], [, right]) => left.result!.finishedAt - right.result!.finishedAt);
    completed.forEach(([id, task], index) => {
      if (Date.now() - task.result!.finishedAt > RESULT_TTL || index < completed.length - MAX_RESULTS) this.tasks.delete(id);
    });
  }
}
