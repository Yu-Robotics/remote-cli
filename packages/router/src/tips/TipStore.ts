import fs from 'fs/promises';
import { constants } from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';

export type TipSubscription = 'off' | 'daily' | 'weekly';
export interface TipDelivery {
  id: string;
  tipId?: string;
  automatic: boolean;
  at: number;
  state: 'reserved' | 'dispatching' | 'confirmed' | 'unknown';
}
export interface TipReceipt {
  id: string;
  cardId: string | null;
  kind: 'tip' | 'settings' | 'catalog' | 'help';
  tipId?: string;
  createdAt: number;
  revision: string;
  used: string[];
}
export interface TipUserState {
  version: 1;
  subscription: TipSubscription;
  timezone: string;
  revision: string;
  stopRevision: string | null;
  muteUntil: number;
  lastActivity: number;
  lastAutomaticAt: number;
  seen: string[];
  mastered: string[];
  deliveries: TipDelivery[];
  cards: TipReceipt[];
}

export const TIP_HISTORY_LIMIT = 128;
const MAX_BYTES = 256 * 1024;
const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const UUID = /^[a-f0-9-]{36}$/;
const finiteTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const record = (value: any, keys: string[]): boolean => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key));
const strings = (value: any, limit: number, valid: (item: string) => boolean): value is string[] => Array.isArray(value)
  && value.length <= limit && new Set(value).size === value.length && value.every(item => typeof item === 'string' && valid(item));

export function validTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 100 || !value) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(0); return true; } catch { return false; }
}

export function newTipState(timezone: string): TipUserState {
  return { version: 1, subscription: 'off', timezone, revision: randomUUID(), stopRevision: null, muteUntil: 0,
    lastActivity: 0, lastAutomaticAt: 0, seen: [], mastered: [], deliveries: [], cards: [] };
}

function validState(value: any): value is TipUserState {
  return record(value, ['version', 'subscription', 'timezone', 'revision', 'stopRevision', 'muteUntil', 'lastActivity', 'lastAutomaticAt', 'seen', 'mastered', 'deliveries', 'cards'])
    && value.version === 1 && ['off', 'daily', 'weekly'].includes(value.subscription) && validTimezone(value.timezone)
    && typeof value.revision === 'string' && UUID.test(value.revision)
    && (value.stopRevision === null || typeof value.stopRevision === 'string' && UUID.test(value.stopRevision))
    && ['muteUntil', 'lastActivity', 'lastAutomaticAt'].every(key => finiteTime(value[key]))
    && strings(value.seen, 4096, item => ID.test(item)) && strings(value.mastered, 4096, item => ID.test(item))
    && value.mastered.every((id: string) => value.seen.includes(id))
    && Array.isArray(value.deliveries) && value.deliveries.length <= TIP_HISTORY_LIMIT
    && value.deliveries.every((item: any) => record(item, ['id', 'tipId', 'automatic', 'at', 'state'])
      && typeof item.id === 'string' && UUID.test(item.id) && (item.tipId === undefined || typeof item.tipId === 'string' && ID.test(item.tipId))
      && typeof item.automatic === 'boolean' && finiteTime(item.at) && ['reserved', 'dispatching', 'confirmed', 'unknown'].includes(item.state))
    && Array.isArray(value.cards) && value.cards.length <= TIP_HISTORY_LIMIT
    && value.cards.every((item: any) => record(item, ['id', 'cardId', 'kind', 'tipId', 'createdAt', 'revision', 'used'])
      && typeof item.id === 'string' && UUID.test(item.id) && (item.cardId === null || typeof item.cardId === 'string' && item.cardId.length > 0 && item.cardId.length <= 200)
      && ['tip', 'settings', 'catalog', 'help'].includes(item.kind) && (item.tipId === undefined || typeof item.tipId === 'string' && ID.test(item.tipId))
      && finiteTime(item.createdAt) && typeof item.revision === 'string' && UUID.test(item.revision)
      && strings(item.used, 32, token => token.length <= 100));
}

/** One Router process owns this directory. This is not a cross-process lock. */
export class TipStore {
  private readonly writes = new Map<string, Promise<void>>();
  constructor(private readonly directory: string, private readonly timezone = 'Asia/Shanghai') {
    if (!validTimezone(timezone)) throw new Error('Invalid Tips timezone.');
  }

  private filename(openId: string, suffix = '.json'): string {
    return path.join(this.directory, createHash('sha256').update(openId).digest('hex') + suffix);
  }

  private async ready(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('Unsafe Tips directory.');
  }

  private async readFile(filename: string): Promise<any | undefined> {
    let handle;
    try {
      handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES || (stat.mode & 0o077) !== 0) throw new Error('Unsafe Tips file.');
      const text = await handle.readFile('utf8');
      if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Oversized Tips file.');
      return JSON.parse(text);
    } catch (error: any) {
      if (error.code === 'ENOENT') return undefined;
      throw new Error('Tips storage is unavailable.');
    } finally { await handle?.close(); }
  }

  async load(openId: string): Promise<TipUserState> {
    try {
      await this.ready();
      const value = await this.readFile(this.filename(openId));
      const state = value === undefined ? newTipState(this.timezone) : value;
      if (!validState(state)) throw new Error('Invalid Tips state.');
      const override = await this.readFile(this.filename(openId, '.off.json'));
      if (override !== undefined) {
        if (!record(override, ['version', 'off', 'revision']) || override.version !== 1 || override.off !== true
          || typeof override.revision !== 'string' || !UUID.test(override.revision)) throw new Error('Invalid Tips opt-out.');
        state.subscription = 'off';
        // Invalidate prior enrollment cards even if updating the main record failed.
        if (state.stopRevision !== override.revision) {
          state.revision = override.revision;
          state.stopRevision = override.revision;
        }
      }
      // Dispatch was already budgeted and marked seen before the external call.
      for (const delivery of state.deliveries) if (delivery.state === 'dispatching') delivery.state = 'unknown';
      return state;
    } catch { throw new Error('Tips storage is unavailable.'); }
  }

  private serialize(openId: string, work: () => Promise<void>): Promise<void> {
    const key = this.filename(openId);
    const next = (this.writes.get(key) ?? Promise.resolve()).then(work);
    const tail = next.catch(() => {});
    this.writes.set(key, tail);
    void tail.then(() => { if (this.writes.get(key) === tail) this.writes.delete(key); });
    return next;
  }

  private async atomic(filename: string, value: unknown): Promise<void> {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Tips state limit reached.');
    await this.ready();
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, filename);
      await this.syncDirectory();
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }

  private async syncDirectory(): Promise<void> {
    const handle = await fs.open(this.directory, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }

  save(openId: string, state: TipUserState): Promise<void> {
    // Capture the snapshot before queuing; callers cannot mutate a pending write.
    const snapshot = JSON.parse(JSON.stringify(state));
    return this.serialize(openId, async () => {
      try {
        if (!validState(snapshot)) throw new Error('Invalid Tips state.');
        await this.atomic(this.filename(openId), snapshot);
      } catch { throw new Error('Tips storage is unavailable.'); }
    });
  }

  /** A separate durable stop switch still works when the main record is corrupt. */
  optOut(openId: string): Promise<void> {
    return this.serialize(openId, async () => {
      try { await this.atomic(this.filename(openId, '.off.json'), { version: 1, off: true, revision: randomUUID() }); }
      catch { throw new Error('Tips storage is unavailable.'); }
    });
  }

  clearOptOut(openId: string): Promise<void> {
    return this.serialize(openId, async () => {
      try { await this.ready(); await fs.rm(this.filename(openId, '.off.json'), { force: true }); await this.syncDirectory(); }
      catch { throw new Error('Tips storage is unavailable.'); }
    });
  }
}
