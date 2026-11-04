import { vi } from 'vitest';
import type { CardThreadAssociation } from '../../src/storage/CardThreadState';

/** Storage double for transport tests; persistence and authority use real JsonStore fixtures elsewhere. */
export function cardThreadStorage() {
  const cards = new Map<string, CardThreadAssociation>();
  return {
    cards,
    getCardThreadEpoch: vi.fn(() => '00000000-0000-4000-8000-000000000001'),
    getCardThread: vi.fn((id: string) => {
      const card = cards.get(id);
      return card && card.expiresAt > Date.now() ? card : undefined;
    }),
    setCardThread: vi.fn(async (id: string, card: CardThreadAssociation, guard: () => boolean = () => true) => {
      if (guard()) cards.set(id, card);
    }),
    removeCardThread: vi.fn(async (id: string) => { cards.delete(id); }),
    invalidateDeviceCards: vi.fn(async (deviceId: string) => {
      for (const [id, card] of cards) if (card.deviceId === deviceId) cards.delete(id);
    }),
    pruneCardThreads: vi.fn(async () => {
      for (const [id, card] of cards) if (card.expiresAt <= Date.now()) cards.delete(id);
    }),
  };
}
