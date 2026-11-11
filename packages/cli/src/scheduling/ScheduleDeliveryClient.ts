import type { WebSocketClient } from '../client/WebSocketClient';
import type { QueueStartedInfo } from '../types';
import type { ScheduleDelivery } from './types';
import { isNativeScheduleBackend } from './ScheduleCapabilities';

const ACK_TIMEOUT_MS = 15_000;
const MAX_PENDING = 100;
const MAX_RESULT_CHARACTERS = 64 * 1024;

interface PendingDelivery {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  responseStarted: boolean;
  sent: boolean;
  acknowledged: boolean;
}

function boundedResult(text: string | undefined): string | undefined {
  if (text === undefined || text.length <= MAX_RESULT_CHARACTERS) return text;
  const marker = '\n\n[Scheduled result truncated for delivery.]';
  return text.slice(0, MAX_RESULT_CHARACTERS - marker.length) + marker;
}

/** Sends an outbox result, never replaying a model turn or tracking its bytes in TaskRecovery. */
export class ScheduleDeliveryClient {
  private readonly pending = new Map<string, PendingDelivery>();
  private readonly unsubscribeAck: () => void;
  private readonly unsubscribeClose: () => void;
  private destroyed = false;

  constructor(private readonly wsClient: WebSocketClient) {
    this.unsubscribeAck = wsClient.onTaskResultAck(messageId => {
      const pending = this.pending.get(messageId);
      // A receipt during queue_started cannot acknowledge the response still to be sent.
      if (!pending?.responseStarted) return;
      pending.acknowledged = true;
      if (pending.sent) this.finish(messageId);
    });
    this.unsubscribeClose = wsClient.onClose(() => this.rejectAll('Scheduled result delivery disconnected'));
  }

  /** Caller must verify negotiated scheduleResultsV1 support and current schedule ownership. */
  deliver(delivery: ScheduleDelivery, threadName: string): Promise<void> {
    if (this.destroyed) return Promise.reject(new Error('Scheduled result delivery is shut down'));
    if (!this.wsClient.isConnected()) return Promise.reject(new Error('Scheduled result delivery is disconnected'));
    const existing = this.pending.get(delivery.id);
    if (existing) return existing.promise;
    if (this.pending.size >= MAX_PENDING) return Promise.reject(new Error('Too many pending scheduled results'));
    const schedule = delivery.schedule;
    if ([delivery.id, schedule.id, schedule.openId, schedule.threadId].some(value => !value || value.length > 256)
      || !schedule.cwd || schedule.cwd.length > 4096 || !isNativeScheduleBackend(schedule.backend)) {
      return Promise.reject(new Error('Invalid scheduled result routing metadata'));
    }
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((accept, decline) => { resolve = accept; reject = decline; });
    const pending: PendingDelivery = {
      promise, resolve, reject, responseStarted: false, sent: false, acknowledged: false,
      timer: setTimeout(() => this.finish(delivery.id, new Error('Scheduled result receipt timed out')), ACK_TIMEOUT_MS),
    };
    this.pending.set(delivery.id, pending);
    const queueStarted: QueueStartedInfo = {
      source: 'schedule', scheduleId: schedule.id, threadName: threadName.slice(0, 100), backend: schedule.backend,
      cwd: schedule.cwd, preview: schedule.prompt.replace(/\s+/g, ' ').slice(0, 240), remainingCount: 0,
    };
    const routing = { messageId: delivery.id, openId: schedule.openId, threadId: schedule.threadId,
      cwd: schedule.cwd, queueStarted };
    try {
      if (!this.wsClient.send({ type: 'queue_started', ...routing, timestamp: Date.now() })) {
        throw new Error('Scheduled result start was not sent');
      }
      if (this.pending.get(delivery.id) !== pending) return promise;
      pending.responseStarted = true;
      if (!this.wsClient.send({ type: 'response', ...routing, timestamp: Date.now(), success: delivery.success,
        output: boundedResult(delivery.output), error: boundedResult(delivery.error) })) {
        throw new Error('Scheduled result was not sent');
      }
      pending.sent = true;
      if (pending.acknowledged) this.finish(delivery.id);
    } catch {
      this.finish(delivery.id, new Error('Scheduled result transport send failed'));
    }
    return promise;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsubscribeAck();
    this.unsubscribeClose();
    this.rejectAll('Scheduled result delivery is shut down');
  }

  private finish(messageId: string, error?: Error): void {
    const pending = this.pending.get(messageId);
    if (!pending) return;
    this.pending.delete(messageId);
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve();
  }

  private rejectAll(message: string): void {
    for (const id of this.pending.keys()) this.finish(id, new Error(message));
  }
}
