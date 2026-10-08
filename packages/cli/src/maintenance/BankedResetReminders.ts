import { randomUUID } from 'crypto';
import { INSPECTION_INTERVAL_MS } from './CodexWeekly';
import type { CodexQuotaObservation } from './CodexQuota';

interface Reminder {
  reminderId: string;
  generation: string;
  expiresAt: number;
  activationAvailable: false;
  backend: 'codex';
  kind: 'banked_reset_increase';
  previousCount: number;
  availableCount: number;
}

/** Process-local comparisons: acknowledged increases never suppress later increases. */
export class BankedResetReminders {
  private accountKey?: string;
  private previous?: { count: number; observedAt: number };
  private reminder?: Reminder;
  private supported = false;
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly send: (message: object) => void, private readonly generation: string,
    private readonly now = Date.now, private readonly retryMs = 60_000) {}

  registered(supported: boolean): void { this.supported = supported; this.deliver(); }
  disconnected(): void { this.supported = false; this.clearTimer(); }
  stop(): void { this.stopped = true; this.disconnected(); this.clearReminder(); this.previous = undefined; this.accountKey = undefined; }

  observe(current: CodexQuotaObservation): void {
    if (this.stopped) return;
    if (current.accountKey !== this.accountKey || this.previous && current.observedAt < this.previous.observedAt) {
      this.accountKey = current.accountKey;
      this.previous = undefined;
      this.clearReminder();
    }
    const count = current.bankedResetCount;
    if (count === undefined) return;
    const previous = this.previous;
    // Every valid sample becomes the baseline, including consumption and equal balances.
    this.previous = { count, observedAt: current.observedAt };
    if (!previous || count < previous.count) this.clearReminder();
    if (previous && count > previous.count) {
      this.clearReminder();
      this.reminder = { reminderId: randomUUID(), generation: this.generation, expiresAt: this.now() + 2 * INSPECTION_INTERVAL_MS,
        activationAvailable: false, backend: 'codex', kind: 'banked_reset_increase', previousCount: previous.count, availableCount: count };
      this.deliver();
    }
  }

  handle(message: any): boolean {
    if (!this.supported || !this.reminder || this.reminder.expiresAt <= this.now()
      || message.reminderId !== this.reminder.reminderId || message.generation !== this.generation) return false;
    if (message.type === 'subscription_reminder_ack' || message.type === 'subscription_action' && message.decision === 'dismiss') {
      this.clearReminder();
      return true;
    }
    return false;
  }

  private deliver(): void {
    if (this.stopped || !this.supported || !this.reminder || this.timer) return;
    if (this.reminder.expiresAt <= this.now()) { this.clearReminder(); return; }
    try { this.send({ type: 'subscription_reminder', reminder: this.reminder }); } catch { /* Retry delivery only, never consume credits or run a model. */ }
    this.timer = setTimeout(() => { this.timer = undefined; this.deliver(); }, this.retryMs);
    this.timer.unref?.();
  }
  private clearTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  private clearReminder(): void { this.reminder = undefined; this.clearTimer(); }
}
