import { createHash } from 'crypto';
import { codexWeeklyObservation, type WeeklyObservation } from './CodexWeekly';

export interface CodexQuotaObservation {
  /** Local-only account fingerprint, independent of credentials and quota buckets. */
  accountKey: string;
  observedAt: number;
  weekly?: WeeklyObservation;
  /** Missing means unknown, never zero. Detail rows are not a balance. */
  bankedResetCount?: number;
}

/** Read both signals from one native response without requiring a weekly window for banked credits. */
export function codexQuotaObservation(raw: unknown, accountId: string, credentialGeneration: string,
  observedAt: number): CodexQuotaObservation | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !accountId || !Number.isFinite(observedAt)) return;
  const value = raw as any;
  if (value.accountId != null && value.accountId !== accountId) return;
  const count = value.rateLimitResetCredits?.availableCount;
  return {
    accountKey: createHash('sha256').update(JSON.stringify(['codex-reset-credits', accountId])).digest('hex'),
    observedAt,
    weekly: codexWeeklyObservation(raw, accountId, credentialGeneration, observedAt),
    bankedResetCount: Number.isSafeInteger(count) && count >= 0 ? count : undefined,
  };
}
