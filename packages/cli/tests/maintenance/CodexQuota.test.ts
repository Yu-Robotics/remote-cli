import { describe, expect, it } from 'vitest';
import { codexQuotaObservation } from '../../src/maintenance/CodexQuota';
import { WEEK_SECONDS } from '../../src/maintenance/CodexWeekly';

const time = 1800000000000;
const parse = (raw: unknown, account = 'account-fixture', credential = 'credential-fixture') => codexQuotaObservation(raw, account, credential, time);

describe('native Codex banked reset observations', () => {
  it('uses the authoritative available count, not missing or capped detail rows', () => {
    for (const credits of [null, [], [{ status: 'available' }]]) {
      expect(parse({ rateLimitResetCredits: { availableCount: 5, credits } })).toMatchObject({ bankedResetCount: 5 });
    }
    expect(parse({ rateLimitResetCredits: { availableCount: 0, credits: null } })).toMatchObject({ bankedResetCount: 0 });
  });
  it.each([undefined, null, -1, 1.5, NaN, Infinity, '2', false, Number.MAX_SAFE_INTEGER + 1])(
    'preserves unavailable or invalid count %j as unknown, never zero', availableCount => {
      expect(parse({ rateLimitResetCredits: { availableCount, credits: [{ status: 'available' }] } })?.bankedResetCount).toBeUndefined();
    });
  it('accepts the count independently of missing, malformed or ambiguous weekly fields', () => {
    for (const rateLimitsByLimitId of [undefined, [], { first: { limitId: 'different' } }]) {
      const result = parse({ rateLimitsByLimitId, rateLimitResetCredits: { availableCount: 2 } });
      expect(result?.bankedResetCount).toBe(2); expect(result?.weekly).toBeUndefined();
    }
    for (const raw of [{}, { rateLimitResetCredits: null }, { rateLimitResetCredits: {} }]) {
      expect(parse(raw)?.bankedResetCount).toBeUndefined();
    }
  });
  it('retains weekly parsing and a stable private account fingerprint without exposing raw identities', () => {
    const raw = { accountId: 'account-fixture', rateLimitResetCredits: { availableCount: 2 }, rateLimits: {
      limitId: 'codex', primary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: time / 1000 + WEEK_SECONDS },
    } };
    const result = parse(raw)!;
    expect(result.weekly?.candidate).toBe(true);
    expect(result.accountKey).toMatch(/^[a-f0-9]{64}$/);
    expect(parse(raw, 'account-fixture', 'refreshed-fixture')?.accountKey).toBe(result.accountKey);
    expect(parse({ rateLimitResetCredits: { availableCount: 2 } }, 'another-account-fixture')?.accountKey).not.toBe(result.accountKey);
    expect(result.accountKey).not.toBe(result.weekly?.accountKey);
  });
  it('rejects conflicting account identity, malformed responses and invalid observation times', () => {
    for (const raw of [null, [], 'invalid', { accountId: 'foreign-fixture', rateLimitResetCredits: { availableCount: 2 } }]) expect(parse(raw)).toBeUndefined();
    expect(parse({}, '')).toBeUndefined();
    expect(codexQuotaObservation({}, 'account-fixture', 'credential-fixture', NaN)).toBeUndefined();
  });
});
