import { randomUUID } from 'crypto';
import type { UserBinding } from '../types';

export const CARD_THREAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_CARD_THREADS = 10_000;
export const MAX_DEVICE_CARD_THREADS = 2_000;

export interface CardThreadAssociation {
  threadId: string;
  deviceId: string;
  openId: string;
  epoch: string;
  expiresAt: number;
}

export interface CardThreadState {
  version: 1;
  generations: Record<string, { openId: string; epoch: string }>;
  cards: Record<string, CardThreadAssociation>;
}

const record = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
const epoch = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);

export function validCardThread(cardId: string, value: unknown, now = Date.now()): value is CardThreadAssociation {
  return identifier(cardId) && record(value) && identifier(value.threadId) && identifier(value.deviceId)
    && identifier(value.openId) && epoch(value.epoch) && Number.isSafeInteger(value.expiresAt)
    && value.expiresAt > now && value.expiresAt <= now + CARD_THREAD_TTL_MS;
}

/** Optional routing metadata is disposable; malformed authority is never reconstructed from cards. */
export function reconcileCardThreads(raw: unknown, bindings: Record<string, UserBinding>,
  deviceOwners: Record<string, string>, invalidate = new Set<string>()): CardThreadState {
  const valid = record(raw) && raw.version === 1 && record(raw.generations) && record(raw.cards)
    && Object.values(raw.generations).every(value => record(value) && identifier(value.openId) && epoch(value.epoch));
  const generations: CardThreadState['generations'] = Object.create(null);
  const owners = new Map<string, string[]>();
  for (const [openId, binding] of Object.entries(bindings)) {
    for (const device of binding.devices) owners.set(device.deviceId, [...(owners.get(device.deviceId) ?? []), openId]);
  }
  for (const [deviceId, candidates] of owners) {
    const openId = candidates[0];
    if (candidates.length !== 1 || deviceOwners[deviceId] !== openId) continue;
    const previous = valid && Object.hasOwn(raw.generations, deviceId) ? raw.generations[deviceId] : undefined;
    generations[deviceId] = previous?.openId === openId && !invalidate.has(deviceId)
      ? { openId, epoch: previous.epoch } : { openId, epoch: randomUUID() };
  }
  const cards: CardThreadState['cards'] = Object.create(null);
  const counts = new Map<string, number>();
  let total = 0;
  if (valid) {
    // Keep the newest original expirations. Reloading and updating never extend a card's lifetime.
    const entries = Object.entries(raw.cards).filter((item): item is [string, CardThreadAssociation] => validCardThread(item[0], item[1]))
      .sort((a, b) => b[1].expiresAt - a[1].expiresAt);
    for (const [id, entry] of entries) {
      const owner = generations[entry.deviceId];
      const count = counts.get(entry.deviceId) ?? 0;
      if (!owner || owner.openId !== entry.openId || owner.epoch !== entry.epoch || count >= MAX_DEVICE_CARD_THREADS) continue;
      if (total >= MAX_CARD_THREADS) break;
      total++;
      cards[id] = Object.keys(entry).length === 5 ? entry : { threadId: entry.threadId, deviceId: entry.deviceId,
        openId: entry.openId, epoch: entry.epoch, expiresAt: entry.expiresAt };
      counts.set(entry.deviceId, count + 1);
    }
  }
  return { version: 1, generations, cards };
}
