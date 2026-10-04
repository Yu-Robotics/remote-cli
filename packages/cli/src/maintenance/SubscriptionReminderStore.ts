import path from 'path';
import { createHash } from 'crypto';
import { PrivateStore } from './PrivateStore';

interface Ledger { format: 1; suppressedAccounts: string[] }
const FINGERPRINT = /^[a-f0-9]{64}$/;
const MAX_ACCOUNTS = 256;
function validLedger(value: any): value is Ledger {
  return value?.format === 1 && Object.keys(value).every(key => key === 'format' || key === 'suppressedAccounts')
    && Array.isArray(value.suppressedAccounts) && value.suppressedAccounts.length <= MAX_ACCOUNTS
    && value.suppressedAccounts.every((key: unknown) => typeof key === 'string' && FINGERPRINT.test(key))
    && new Set(value.suppressedAccounts).size === value.suppressedAccounts.length;
}

/** Persist delivery suppression, never credentials, raw account IDs, or quota observations. */
export class SubscriptionReminderStore {
  private readonly store: PrivateStore<Ledger>;
  private accounts = new Set<string>();
  private initializing?: Promise<void>;
  private operations = Promise.resolve();

  constructor(configDir: string, serverUrl: string, deviceId: string) {
    const namespace = createHash('sha256').update(JSON.stringify([serverUrl, deviceId])).digest('hex');
    this.store = new PrivateStore(path.join(configDir, 'subscription-reminders', `${namespace}.json`), validLedger);
  }

  initialize(): Promise<void> {
    return this.initializing ??= this.store.read().then(ledger => {
      this.accounts = new Set(ledger?.suppressedAccounts ?? []);
    });
  }

  async isSuppressed(accountKey: string): Promise<boolean> {
    if (!FINGERPRINT.test(accountKey)) throw new Error('Invalid quota account fingerprint.');
    await this.initialize();
    await this.operations;
    return this.accounts.has(accountKey);
  }

  setSuppressed(accountKey: string, suppressed: boolean): Promise<void> {
    const operation = this.operations.then(async () => {
      if (!FINGERPRINT.test(accountKey)) throw new Error('Invalid quota account fingerprint.');
      await this.initialize();
      if (this.accounts.has(accountKey) === suppressed) return;
      const next = new Set(this.accounts);
      if (suppressed) next.add(accountKey); else next.delete(accountKey);
      await this.store.write({ format: 1, suppressedAccounts: [...next] });
      this.accounts = next;
    });
    this.operations = operation.catch(() => {});
    return operation;
  }
}
