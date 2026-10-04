import { randomUUID } from 'crypto';
import type { BackendKey } from '../types/config';
import { INSPECTION_INTERVAL_MS, floatingWeeklyPair, type WeeklyObservation } from './CodexWeekly';
import type { SubscriptionReminderStore } from './SubscriptionReminderStore';

export interface InspectionAdapter {
  backend: BackendKey;
  inspect(signal: AbortSignal): Promise<{ kind: 'unsupported' | 'unavailable' } | { kind: 'observed'; observation: WeeklyObservation }>;
}
// The false legacy field preserves compatibility; quota notices never support activation.
interface Reminder { reminderId: string; generation: string; expiresAt: number; activationAvailable: false; backend: 'codex' }
const BACKENDS: BackendKey[] = ['claude', 'codex', 'agy', 'pi', 'opencode', 'kimi', 'zcode', 'dsh'];
export function inspectionAdapters(codex: (signal: AbortSignal) => Promise<WeeklyObservation | undefined>): InspectionAdapter[] {
  return BACKENDS.map(backend => ({ backend, inspect: async signal => {
    if (backend !== 'codex') return { kind: 'unsupported' };
    const observation = await codex(signal);
    return observation ? { kind: 'observed', observation } : { kind: 'unavailable' };
  } }));
}

/** Observations stay in memory; acknowledged delivery suppression can survive CLI restarts. */
export class SubscriptionInspection {
  private previous?: WeeklyObservation;
  private reminder?: Reminder;
  private suppressed = false;
  private accountKey?: string;
  private conditionRevision = 0;
  private persistenceUnavailable = false;
  private operations = Promise.resolve();
  private supported = false;
  private stopped = false;
  private inFlight?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private deliveryTimer?: ReturnType<typeof setTimeout>;
  private readonly controller = new AbortController();
  private readonly generation = randomUUID();
  constructor(private readonly adapters: InspectionAdapter[], private readonly send: (message: object) => void,
    private readonly now = Date.now, private readonly intervalMs = INSPECTION_INTERVAL_MS, private readonly retryMs = 60_000,
    private readonly store?: SubscriptionReminderStore) {}

  start(): void { if (!this.stopped && !this.timer && !this.inFlight) this.scheduleCycle(0); }
  registered(supported: boolean): void { this.supported = supported; this.deliver(); }
  disconnected(): void { this.supported = false; this.clearDeliveryTimer(); }
  async stop(): Promise<void> {
    this.stopped = true; this.disconnected(); this.controller.abort();
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    await this.inFlight;
    await this.operations;
    this.previous = undefined; this.reminder = undefined;
  }

  cycle(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    const operation = this.enqueue(async () => {
      if (this.stopped || this.persistenceUnavailable) return;
      if (this.store) {
        try { await this.store.initialize(); }
        catch { this.disablePersistence(); return; }
      }
      for (const adapter of this.adapters) {
        if (this.stopped) break;
        let result: Awaited<ReturnType<InspectionAdapter['inspect']>>;
        try { result = await adapter.inspect(this.controller.signal); }
        catch { continue; } // Unavailable evidence never clears delivery suppression or a valid baseline.
        if (this.stopped || adapter.backend !== 'codex' || result.kind !== 'observed') continue;
        try {
          const current = result.observation;
          if (current.accountKey !== this.accountKey) {
            this.suppressed = this.store ? await this.store.isSuppressed(current.accountKey) : false;
            this.accountKey = current.accountKey; this.conditionRevision++;
            this.reminder = undefined; this.clearDeliveryTimer(); this.previous = undefined;
          }
          if (this.previous && (current.identity !== this.previous.identity || current.observedAt < this.previous.observedAt)) {
            this.reminder = undefined; this.clearDeliveryTimer(); this.previous = undefined;
          }
          if (!current.candidate) {
            this.conditionRevision++;
            this.reminder = undefined; this.clearDeliveryTimer();
            if (this.suppressed && this.store) await this.store.setSuppressed(current.accountKey, false);
            this.suppressed = false;
          }
          if (!this.suppressed && !this.reminder && this.previous && floatingWeeklyPair(this.previous, current)) {
            this.reminder = { reminderId: randomUUID(), generation: this.generation, expiresAt: this.now() + 2 * INSPECTION_INTERVAL_MS,
              activationAvailable: false, backend: 'codex' };
            this.deliver();
          }
          // Retry samples within the hourly cadence do not replace the previous independent sample.
          if (!this.previous || current.observedAt - this.previous.observedAt >= this.intervalMs - 120_000 || !current.candidate) this.previous = current;
        } catch { this.disablePersistence(); break; }
      }
    });
    this.inFlight = operation;
    return operation.finally(() => { if (this.inFlight === operation) this.inFlight = undefined; });
  }

  handle(message: any): Promise<void> {
    if (!this.supported || !this.reminder || !this.accountKey || message.reminderId !== this.reminder.reminderId || message.generation !== this.generation
      || this.reminder.expiresAt <= this.now()) return Promise.resolve();
    if (message.type === 'subscription_reminder_ack' || message.type === 'subscription_action' && message.decision === 'dismiss') {
      const accountKey = this.accountKey, revision = this.conditionRevision;
      this.suppressed = true; this.clearDeliveryTimer();
      return this.enqueue(async () => {
        // A valid non-candidate observation takes precedence over an ACK queued during that probe.
        if (this.persistenceUnavailable || this.accountKey === accountKey && this.conditionRevision !== revision) return;
        try { await this.store?.setSuppressed(accountKey, true); }
        catch { this.disablePersistence(); }
      });
    }
    // Every other action is ignored: quota notices never execute prompts or trigger extra probes.
    return Promise.resolve();
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.operations.then(operation);
    this.operations = result.catch(() => {});
    return result;
  }

  private disablePersistence(): void {
    if (!this.persistenceUnavailable) console.warn('[Maintenance] Quota reminders paused: local delivery state is unavailable. Normal messaging is unchanged.');
    this.persistenceUnavailable = true; this.clearDeliveryTimer();
  }

  private scheduleCycle(delay: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.cycle().finally(() => { if (!this.stopped) this.scheduleCycle(this.intervalMs); });
    }, delay);
    this.timer.unref?.();
  }
  private deliver(): void {
    if (this.stopped || this.persistenceUnavailable || !this.supported || !this.reminder || this.suppressed || this.deliveryTimer) return;
    if (this.reminder.expiresAt <= this.now()) { this.reminder = undefined; return; }
    try { this.send({ type: 'subscription_reminder', reminder: this.reminder }); } catch { /* Retry only the card, never a model request. */ }
    this.deliveryTimer = setTimeout(() => { this.deliveryTimer = undefined; this.deliver(); }, this.retryMs);
    this.deliveryTimer.unref?.();
  }
  private clearDeliveryTimer(): void { if (this.deliveryTimer) clearTimeout(this.deliveryTimer); this.deliveryTimer = undefined; }
}
