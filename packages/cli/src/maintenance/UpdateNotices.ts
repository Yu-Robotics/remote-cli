import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { PrivateStore } from './PrivateStore';
import { compareNoticeVersions, validNoticeVersion } from './Version';
import { loadReleaseIndex, releasePage, type ReleaseIndex } from './ReleaseNotes';

interface PendingNotice { noticeKey: string; fromVersion: string; toVersion: string }
interface Ledger {
  format: 1;
  lastStartedVersion: string;
  notificationBaselineVersion: string;
  firstAdoptionVersion: string;
  pending?: PendingNotice;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function validLedger(value: any): value is Ledger {
  return value?.format === 1 && validNoticeVersion(value.lastStartedVersion) && validNoticeVersion(value.notificationBaselineVersion)
    && validNoticeVersion(value.firstAdoptionVersion) && (!value.pending || UUID.test(value.pending.noticeKey)
      && validNoticeVersion(value.pending.fromVersion) && validNoticeVersion(value.pending.toVersion)
      && value.pending.fromVersion === value.notificationBaselineVersion && compareNoticeVersions(value.pending.fromVersion, value.pending.toVersion) < 0);
}

/** A notice tracks successful starts, not package installation or WebSocket OPEN. */
export class UpdateNotices {
  private ledger?: Ledger;
  private index?: ReleaseIndex;
  private supported = false;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private operations = Promise.resolve();
  private readonly store: PrivateStore<Ledger>;

  constructor(configDir: string, serverUrl: string, deviceId: string, private readonly send: (message: object) => void,
    private readonly retryMs = 60_000) {
    const namespace = createHash('sha256').update(JSON.stringify([serverUrl, deviceId])).digest('hex');
    this.store = new PrivateStore(path.join(configDir, 'update-notices', `${namespace}.json`), validLedger);
  }

  async started(version: string): Promise<void> {
    if (!validNoticeVersion(version)) throw new Error('Invalid running CLI version.');
    this.index = await loadReleaseIndex();
    const previous = await this.store.read();
    const next: Ledger = previous ? { ...previous, lastStartedVersion: version } : {
      format: 1, lastStartedVersion: version, notificationBaselineVersion: version, firstAdoptionVersion: version,
    };
    if (previous) {
      if (compareNoticeVersions(version, next.notificationBaselineVersion) <= 0
        || compareNoticeVersions(version, previous.lastStartedVersion) < 0) delete next.pending;
      else if (compareNoticeVersions(version, previous.lastStartedVersion) > 0) next.pending = {
        noticeKey: randomUUID(), fromVersion: next.notificationBaselineVersion, toVersion: version,
      };
    }
    await this.store.write(next);
    this.ledger = next;
    this.deliver();
  }

  registered(supported: boolean): void { this.supported = supported; this.deliver(); }
  disconnected(): void { this.supported = false; this.clearTimer(); }
  stop(): void { this.stopped = true; this.disconnected(); }

  handle(message: any): Promise<void> {
    const operation = this.operations.then(async () => {
      if (!this.supported || this.stopped || !this.ledger) return;
      if (message.type === 'update_notice_ack') {
        const pending = this.ledger.pending;
        if (!pending || message.noticeKey !== pending.noticeKey || message.fromVersion !== pending.fromVersion
          || message.toVersion !== pending.toVersion) return;
        const next: Ledger = { ...this.ledger, notificationBaselineVersion: pending.toVersion };
        delete next.pending;
        await this.store.write(next);
        this.ledger = next; this.clearTimer();
      } else if (message.type === 'update_notice_view') {
        const { fromVersion: from, toVersion: to, offset, requestId, noticeKey } = message;
        if (!UUID.test(requestId) || !UUID.test(noticeKey) || !validNoticeVersion(from) || !validNoticeVersion(to)
          || compareNoticeVersions(from, this.ledger.firstAdoptionVersion) < 0
          || compareNoticeVersions(to, this.ledger.lastStartedVersion) > 0 || compareNoticeVersions(from, to) >= 0
          || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000) return;
        this.send({ type: 'update_notice_page', noticeKey, requestId, fromVersion: from, toVersion: to,
          page: releasePage(this.index, from, to, offset) });
      }
    });
    this.operations = operation.catch(() => {});
    return operation;
  }

  private deliver(): void {
    if (this.stopped || !this.supported || !this.ledger?.pending || this.timer) return;
    const pending = this.ledger.pending;
    try { this.send({ type: 'update_notice', ...pending, page: releasePage(this.index, pending.fromVersion, pending.toVersion) }); }
    catch { /* Retain the notice for a later compatible connection. */ }
    this.timer = setTimeout(() => { this.timer = undefined; this.deliver(); }, this.retryMs);
    this.timer.unref?.();
  }

  private clearTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
}
