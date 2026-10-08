import { UpdateNotices } from './UpdateNotices';
import { CodexStatusProbe } from './CodexStatusProbe';
import { inspectionAdapters, SubscriptionInspection } from './SubscriptionInspection';
import { SubscriptionReminderStore } from './SubscriptionReminderStore';
import type { ExecutorConfig } from '../types/config';
export interface MaintenanceTransport { send(message: object): void; on(event: 'disconnected', handler: () => void): void }

/** Local service lifecycle, deliberately independent of normal task and updater routing. */
export class MaintenanceClient {
  private readonly updates?: UpdateNotices;
  private readonly subscriptions?: SubscriptionInspection;
  private runningVersion?: string;
  private bound = false;
  private stopped = false;
  private initializing?: Promise<void>;
  constructor(transport: MaintenanceTransport, configDir: string, serverUrl: string, deviceId: string,
    config: () => ExecutorConfig | undefined, enabled: { updateNotice?: boolean; subscriptionInspection?: boolean } = {}) {
    if (enabled.updateNotice !== false) this.updates = new UpdateNotices(configDir, serverUrl, deviceId, m => transport.send(m));
    if (enabled.subscriptionInspection !== false) {
      const probe = new CodexStatusProbe({ config });
      this.subscriptions = new SubscriptionInspection(inspectionAdapters(signal => probe.inspect(signal)), m => transport.send(m),
        Date.now, undefined, undefined, new SubscriptionReminderStore(configDir, serverUrl, deviceId));
    }
    transport.on('disconnected', () => { this.bound = false; this.updates?.disconnected(); this.subscriptions?.disconnected(); });
  }

  async started(version: string): Promise<void> {
    this.runningVersion = version;
    await this.initialize();
  }

  private initialize(): Promise<void> {
    if (this.stopped || !this.bound || !this.runningVersion) return Promise.resolve();
    return this.initializing ??= (async () => {
      try { await this.updates?.started(this.runningVersion!); } catch { console.warn('[Maintenance] Update notices unavailable; normal messaging is unchanged.'); }
      if (!this.stopped) this.subscriptions?.start();
    })();
  }

  async handle(message: any): Promise<boolean> {
    if (message.type === 'binding_confirm') {
      this.bound = message.data?.success === true;
      this.updates?.registered(message.data?.success === true && message.data?.capabilities?.updateNotice === true);
      this.subscriptions?.registered(message.data?.success === true && message.data?.capabilities?.subscriptionInspection === true,
        message.data?.success === true && message.data?.capabilities?.bankedResetReminder === true);
      await this.initialize();
      return false;
    }
    if (message.type === 'update_notice_ack' || message.type === 'update_notice_view') {
      try { await this.updates?.handle(message); } catch { console.warn('[Maintenance] Update notice acknowledgement or paging failed.'); }
      return true;
    }
    if (message.type === 'subscription_reminder_ack' || message.type === 'subscription_action') { await this.subscriptions?.handle(message); return true; }
    return false;
  }
  async stop(): Promise<void> { this.stopped = true; this.updates?.stop(); await this.subscriptions?.stop(); }
}
