import { createHash, randomUUID } from 'crypto';
import type { ScheduleActionMessage, ScheduleActionResult, ScheduleMenu } from '../types/ScheduleCards';
import type { ScheduleOwner, ScheduleRecord } from './types';

interface Dependencies {
  current(owner: ScheduleOwner): boolean;
  threadName(threadId: string): string;
  records(owner: ScheduleOwner): Promise<ScheduleRecord[]>;
  canCancel(owner: ScheduleOwner, id: string): boolean;
  refresh(owner: ScheduleOwner): Promise<void>;
  cancel(owner: ScheduleOwner, id: string): Promise<unknown>;
  exclusive<T>(owner: ScheduleOwner, body: () => Promise<T>): Promise<T>;
}
interface Snapshot { owner: ScheduleOwner; menu: ScheduleMenu }
interface Receipt { digest: string; expires: number; pending: boolean; result: Promise<ScheduleActionResult> }
const TTL = 15 * 60_000;
const valid = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
const literal = (value: string, max: number) => value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max);

/** No disk access or subscriptions until an explicit schedule command opens a snapshot. */
export class ScheduleCardService {
  private snapshots = new Map<string, Snapshot>();
  private receipts = new Map<string, Receipt>();
  private epoch = 0;
  constructor(private readonly dependencies: Dependencies) {}

  invalidate(): void { this.epoch++; this.snapshots.clear(); }
  destroy(): void { this.invalidate(); this.receipts.clear(); }

  open(owner: ScheduleOwner, records: ScheduleRecord[]): ScheduleMenu {
    this.prune();
    if (!this.dependencies.current(owner)) throw new Error('Schedule context changed. Use /schedule list.');
    if (this.snapshots.size >= 100) this.snapshots.delete(this.snapshots.keys().next().value!);
    const menu: ScheduleMenu = { snapshotId: randomUUID(), threadId: owner.threadId,
      threadName: literal(this.dependencies.threadName(owner.threadId), 100), expiresAt: Date.now() + TTL,
      entries: records.slice(0, 100).map(record => ({ value: randomUUID(), id: record.id, backend: record.backend,
        state: record.state, rule: literal(record.rule.kind === 'once' ? record.rule.at
          : `${record.rule.expression} (${record.rule.timezone})`, 160), prompt: literal(record.prompt, 240),
        ...(record.error ? { error: literal(record.error, 240) } : {}),
        canCancel: this.dependencies.canCancel(owner, record.id) })) };
    this.snapshots.set(menu.snapshotId, { owner: { ...owner }, menu });
    return structuredClone(menu);
  }

  action(request: ScheduleActionMessage): Promise<ScheduleActionResult> {
    this.prune();
    const reply = (success: boolean, error?: string, menu?: ScheduleMenu): ScheduleActionResult => ({
      type: 'schedule_action_result', messageId: request.messageId, openId: request.openId, threadId: request.threadId,
      snapshotId: request.snapshotId, success, ...(error ? { error } : {}), ...(menu ? { menu } : {}), timestamp: Date.now(),
    });
    if (![request.messageId, request.openId, request.threadId, request.snapshotId].every(valid)
      || !['refresh', 'cancel'].includes(request.operation)
      || (request.operation === 'cancel' ? !valid(request.value) : request.value !== undefined)) {
      return Promise.resolve(reply(false, 'Invalid schedule action.'));
    }
    const snapshot = this.snapshots.get(request.snapshotId);
    if (!snapshot || snapshot.owner.openId !== request.openId || snapshot.owner.threadId !== request.threadId
      || !this.dependencies.current(snapshot.owner)) {
      return Promise.resolve(reply(false, 'This schedule card has expired or its context changed. Use /schedule list.'));
    }
    const entry = snapshot.menu.entries.find(item => item.value === request.value);
    if (request.operation === 'cancel' && (!entry || !entry.canCancel)) return Promise.resolve(reply(false, 'Cancellation is unavailable on this card. Refresh it first.'));
    const digest = createHash('sha256').update(JSON.stringify([request.openId, request.threadId,
      request.snapshotId, request.operation, request.value])).digest('hex');
    const previous = this.receipts.get(request.messageId);
    if (previous) return previous.digest === digest ? previous.result
      : Promise.resolve(reply(false, 'This request ID belongs to another schedule action.'));
    if (this.receipts.size >= 500) return Promise.resolve(reply(false, 'Schedule confirmation storage is full. Try again later.'));
    const epoch = this.epoch;
    const receipt: Receipt = { digest, expires: Date.now() + TTL, pending: true, result: Promise.resolve(reply(false)) };
    receipt.result = Promise.resolve().then(async () => {
      let success = false;
      let error: string | undefined;
      let menu: ScheduleMenu | undefined;
      try {
        await this.dependencies.exclusive(snapshot.owner, async () => {
          if (epoch !== this.epoch || !this.dependencies.current(snapshot.owner)) throw new Error('stale');
          if (request.operation === 'cancel') await this.dependencies.cancel(snapshot.owner, entry!.id);
          else await this.dependencies.refresh(snapshot.owner);
          success = true;
        });
      } catch {
        error = request.operation === 'cancel'
          ? 'Cancellation was not confirmed. Refresh the status or retry cleanup.'
          : 'Status refresh failed. Try again or use /schedule list.';
      }
      try {
        if (epoch === this.epoch && this.dependencies.current(snapshot.owner)) {
          const records = await this.dependencies.records(snapshot.owner);
          if (epoch === this.epoch && this.dependencies.current(snapshot.owner)) menu = this.open(snapshot.owner, records);
        }
      } catch { /* The operation receipt remains authoritative even if a new view is unavailable. */ }
      receipt.pending = false;
      return reply(success, error, menu);
    });
    this.receipts.set(request.messageId, receipt);
    return receipt.result;
  }

  private prune(): void {
    for (const [id, item] of this.snapshots) if (item.menu.expiresAt <= Date.now()) this.snapshots.delete(id);
    for (const [id, item] of this.receipts) if (!item.pending && item.expires <= Date.now()) this.receipts.delete(id);
  }
}
