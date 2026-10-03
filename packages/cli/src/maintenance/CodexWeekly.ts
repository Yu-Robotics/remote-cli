export const WEEK_SECONDS = 7 * 86400;
export const INSPECTION_INTERVAL_MS = 3600_000;
export interface WeeklyObservation {
  identity: string;
  /** Local sampling time in milliseconds. */
  observedAt: number;
  /** Absolute provider reset timestamp in Unix seconds. */
  resetsAt: number;
  candidate: boolean;
}

/** Parse native numeric fields, never formatted /status text or window length alone. */
export function codexWeeklyObservation(raw: unknown, accountId: string, credentialGeneration: string, observedAt: number): WeeklyObservation | undefined {
  if (!raw || typeof raw !== 'object' || !accountId || !Number.isFinite(observedAt)) return;
  const value = raw as any;
  if (value.accountId != null && value.accountId !== accountId) return;
  let buckets: Array<[string, any]>;
  if (value.rateLimitsByLimitId != null) {
    if (typeof value.rateLimitsByLimitId !== 'object' || Array.isArray(value.rateLimitsByLimitId)) return;
    buckets = Object.entries(value.rateLimitsByLimitId);
  } else if (value.rateLimits && typeof value.rateLimits === 'object') {
    buckets = [[value.rateLimits.limitId ?? 'codex', value.rateLimits]];
  } else return;
  const weekly: Array<{ bucket: string; reset: number; used: number }> = [];
  for (const [key, bucket] of buckets) {
    if (!bucket || typeof bucket !== 'object' || !key || key.length > 200) return;
    if (bucket.limitId != null && bucket.limitId !== key) return;
    for (const field of ['primary', 'secondary']) {
      const window = bucket[field];
      if (window == null) continue;
      if (typeof window !== 'object' || !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100
        || !Number.isFinite(window.windowDurationMins) || window.windowDurationMins <= 0
        || !Number.isSafeInteger(window.resetsAt) || window.resetsAt <= 0) return;
      if (window.windowDurationMins === 10080) weekly.push({ bucket: key, reset: window.resetsAt, used: window.usedPercent });
    }
  }
  // Ambiguous weekly buckets cannot authorize a reminder for a guessed account/window.
  if (weekly.length !== 1) return;
  const w = weekly[0];
  return { identity: JSON.stringify([accountId, credentialGeneration, w.bucket]), observedAt, resetsAt: w.reset,
    candidate: w.used === 0 && Math.abs(w.reset - observedAt / 1000 - WEEK_SECONDS) <= 120 };
}

/** Notification eligibility only; advancing timestamps do not prove a quota reset occurred. */
export function floatingWeeklyPair(previous: WeeklyObservation, current: WeeklyObservation): boolean {
  const elapsed = current.observedAt - previous.observedAt;
  return previous.identity === current.identity && previous.candidate && current.candidate
    && elapsed >= INSPECTION_INTERVAL_MS - 120_000 && elapsed <= INSPECTION_INTERVAL_MS + 120_000
    && Math.abs(current.resetsAt - previous.resetsAt - elapsed / 1000) <= 120;
}
