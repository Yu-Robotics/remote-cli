import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

export interface NoticeReceipt {
  id: string;
  deviceId: string;
  openId: string;
  noticeKey: string;
  fromVersion: string;
  toVersion: string;
  cardId: string;
  deliveredAt: number;
}

/** Delivery receipts survive Router restarts. This is not an exactly-once Feishu transaction. */
export class NoticeReceipts {
  private records: NoticeReceipt[] = [];
  private loading?: Promise<void>;
  private writes = Promise.resolve();
  constructor(private readonly filename: string, private readonly now = Date.now) {}

  private ready(): Promise<void> {
    return this.loading ??= (async () => {
      try {
        const stat = await fs.lstat(this.filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Unsafe notice receipts.');
        const value = JSON.parse(await fs.readFile(this.filename, 'utf8'));
        if (!Array.isArray(value) || value.length > 1000 || value.some(r => !r ||
          ['id', 'deviceId', 'openId', 'noticeKey', 'fromVersion', 'toVersion', 'cardId'].some(k => typeof r[k] !== 'string' || r[k].length > 200)
          || !Number.isFinite(r.deliveredAt))) throw new Error('Invalid notice receipts.');
        this.records = value;
      } catch (error: any) { if (error.code !== 'ENOENT') throw new Error('Notice receipt storage is unavailable.'); }
    })();
  }

  async find(deviceId: string, noticeKey: string): Promise<NoticeReceipt | undefined> {
    await this.ready();
    return this.records.find(r => r.deviceId === deviceId && r.noticeKey === noticeKey && this.now() - r.deliveredAt < 30 * 86400_000);
  }

  async findCard(id: string, cardId: string): Promise<NoticeReceipt | undefined> {
    await this.ready();
    return this.records.find(r => r.id === id && r.cardId === cardId && this.now() - r.deliveredAt < 30 * 86400_000);
  }

  async remember(record: NoticeReceipt): Promise<void> {
    await this.ready();
    const operation = this.writes.then(async () => {
      const records = this.records.filter(r => this.now() - r.deliveredAt < 30 * 86400_000
        && !(r.deviceId === record.deviceId && r.noticeKey === record.noticeKey));
      records.push(record);
      const next = records.slice(-1000);
      await fs.mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
      const temporary = `${this.filename}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify(next), { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, this.filename);
        this.records = next;
      } finally { await fs.rm(temporary, { force: true }); }
    });
    this.writes = operation.catch(() => {});
    return operation;
  }
}
