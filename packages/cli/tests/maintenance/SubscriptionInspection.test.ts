import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { SubscriptionInspection, inspectionAdapters } from '../../src/maintenance/SubscriptionInspection';
import { codexWeeklyObservation, floatingWeeklyPair, WEEK_SECONDS, INSPECTION_INTERVAL_MS, type WeeklyObservation } from '../../src/maintenance/CodexWeekly';

const epoch = 1800000000000;
function raw(time = epoch, used = 0, remaining = WEEK_SECONDS) {
  return { accountId: 'account-fixture', rateLimitsByLimitId: { codex: { limitId: 'codex', primary: null,
    secondary: { usedPercent: used, windowDurationMins: 10080, resetsAt: time / 1000 + remaining } } } };
}
const observation = (time = epoch, used = 0, remaining = WEEK_SECONDS): WeeklyObservation => codexWeeklyObservation(raw(time, used, remaining), 'account-fixture', 'fixture-generation', time)!;

describe('typed Codex weekly observation', () => {
  it('uses usage, remaining reset time and advancing deadline, not the seven-day window length alone', () => {
    const previous = observation(); const current = observation(epoch + INSPECTION_INTERVAL_MS);
    expect(floatingWeeklyPair(previous, current)).toBe(true);
    const fixed = codexWeeklyObservation(raw(epoch + INSPECTION_INTERVAL_MS, 0, WEEK_SECONDS - 3600), 'account-fixture', 'fixture-generation', epoch + INSPECTION_INTERVAL_MS)!;
    expect(fixed.candidate).toBe(false); expect(floatingWeeklyPair(previous, fixed)).toBe(false);
    expect(observation(epoch, 10).candidate).toBe(false);
    expect(floatingWeeklyPair(previous, observation(epoch + 60_000))).toBe(false);
    expect(floatingWeeklyPair(previous, { ...current, identity: 'different-account' })).toBe(false);
  });
  it.each([
    [INSPECTION_INTERVAL_MS - 120_000, true], [INSPECTION_INTERVAL_MS + 120_000, true],
    [INSPECTION_INTERVAL_MS - 121_000, false], [INSPECTION_INTERVAL_MS + 121_000, false],
  ])('bounds the actual sample interval %i to one hour plus or minus two minutes', (elapsed, eligible) => {
    expect(floatingWeeklyPair(observation(), observation(epoch + elapsed))).toBe(eligible);
  });
  it.each([[-121, false], [-120, true], [120, true], [121, false]])(
    'requires the reset timestamp shift to track elapsed seconds within the tolerance: %i', (drift, eligible) => {
      const previousOffset = drift < 0 ? 60 : -60;
      const previous = observation(epoch, 0, WEEK_SECONDS + previousOffset);
      const current = observation(epoch + INSPECTION_INTERVAL_MS, 0, WEEK_SECONDS + previousOffset + drift);
      expect(previous.candidate && current.candidate).toBe(true);
      expect(current.resetsAt).toBeGreaterThan(previous.resetsAt);
      expect(floatingWeeklyPair(previous, current)).toBe(eligible);
    });
  it.each([[-121, false], [-120, true], [120, true], [121, false]])(
    'requires each zero-usage sample to have seven days remaining within the tolerance: %i', (offset, candidate) => {
      expect(observation(epoch, 0, WEEK_SECONDS + offset).candidate).toBe(candidate);
    });
  it('handles null windows, legacy buckets and multiple buckets without guessing a weekly identity', () => {
    const r = raw(); r.rateLimitsByLimitId.codex.primary = null;
    expect(codexWeeklyObservation(r, 'account-fixture', 'g', epoch)).toBeDefined();
    const legacy = { rateLimits: r.rateLimitsByLimitId.codex };
    expect(codexWeeklyObservation(legacy, 'account-fixture', 'g', epoch)).toBeDefined();
    const multiple = { rateLimitsByLimitId: { ...r.rateLimitsByLimitId, other: { limitId: 'other', primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: epoch / 1000 + 10 }, secondary: null } } };
    expect(codexWeeklyObservation(multiple, 'account-fixture', 'g', epoch)).toBeDefined();
    (multiple.rateLimitsByLimitId.other.primary as any).windowDurationMins = 10080;
    expect(codexWeeklyObservation(multiple, 'account-fixture', 'g', epoch)).toBeUndefined();
    expect(codexWeeklyObservation({ rateLimits: { primary: null, secondary: null } }, 'account-fixture', 'g', epoch)).toBeUndefined();
  });
  it('keeps the durable account key stable across credentials and deadlines, but separates accounts and quota buckets', () => {
    const first = observation();
    const refreshed = codexWeeklyObservation(raw(epoch + INSPECTION_INTERVAL_MS), 'account-fixture', 'refreshed-fixture', epoch + INSPECTION_INTERVAL_MS)!;
    expect(refreshed.identity).not.toBe(first.identity);
    expect(refreshed.accountKey).toBe(first.accountKey);
    expect(first.accountKey).toMatch(/^[a-f0-9]{64}$/);
    const another = raw(); another.accountId = 'another-account-fixture';
    expect(codexWeeklyObservation(another, another.accountId, 'fixture-generation', epoch)!.accountKey).not.toBe(first.accountKey);
    const bucket = { rateLimitsByLimitId: { other: { ...raw().rateLimitsByLimitId.codex, limitId: 'other' } } };
    expect(codexWeeklyObservation(bucket, 'account-fixture', 'fixture-generation', epoch)!.accountKey).not.toBe(first.accountKey);
  });
  it.each([NaN, Infinity, -1, 101, '0', null])('rejects invalid usage %j and never manufactures a candidate', invalid => {
    const r = raw(); (r.rateLimitsByLimitId.codex.secondary as any).usedPercent = invalid;
    expect(codexWeeklyObservation(r, 'account-fixture', 'g', epoch)).toBeUndefined();
  });
  it('rejects malformed shapes, conflicting account/bucket identities and invalid reset timestamps', () => {
    for (const r of [null, {}, { rateLimitsByLimitId: [] }, { accountId: 'another-account', rateLimits: raw().rateLimitsByLimitId.codex },
      { rateLimitsByLimitId: { codex: { limitId: 'other' } } }, { rateLimits: { primary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 'later' } } }]) {
      expect(codexWeeklyObservation(r, 'account-fixture', 'g', epoch)).toBeUndefined();
    }
  });
});

describe('hourly subscription inspection', () => {
  let time: number;
  let inspect: ReturnType<typeof vi.fn>;
  let send: ReturnType<typeof vi.fn>;
  let manager: SubscriptionInspection;
  beforeEach(() => {
    vi.useFakeTimers(); time = epoch; inspect = vi.fn(async () => observation(time)); send = vi.fn();
    manager = new SubscriptionInspection(inspectionAdapters(inspect), send, () => time);
    manager.registered(true);
  });
  afterEach(async () => { await manager.stop(); vi.clearAllTimers(); vi.useRealTimers(); });
  const advanceSample = async (hours = 1) => { time += hours * INSPECTION_INTERVAL_MS; await manager.cycle(); };
  const delivered = () => { const message = send.mock.calls.at(-1)![0]; manager.handle({ type: 'subscription_reminder_ack', ...message.reminder }); return message; };

  it('visits every backend slot but calls only the implemented Codex adapter, once per process', async () => {
    const slots = inspectionAdapters(inspect);
    expect(slots.map(s => s.backend)).toEqual(['claude', 'codex', 'agy', 'pi', 'opencode', 'kimi', 'zcode', 'dsh']);
    await Promise.all(slots.map(a => a.inspect(new AbortController().signal)));
    expect(inspect).toHaveBeenCalledTimes(1);
    manager.start(); await vi.advanceTimersByTimeAsync(0);
    expect(inspect).toHaveBeenCalledTimes(2); expect(send).not.toHaveBeenCalled();
    time += INSPECTION_INTERVAL_MS; await vi.advanceTimersByTimeAsync(INSPECTION_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('starts with a silent baseline, requires two hourly votes, suppresses duplicates and rearms only on a valid active state', async () => {
    await manager.cycle(); time += 60_000; await manager.cycle(); expect(send).not.toHaveBeenCalled();
    time = epoch + INSPECTION_INTERVAL_MS; await manager.cycle(); const message = delivered();
    expect(message.reminder.backend).toBe('codex');
    expect(JSON.stringify(message)).not.toMatch(/account-fixture|fixture-generation|resetsAt|identity/);
    await advanceSample(); expect(send).toHaveBeenCalledTimes(1);
    inspect.mockImplementation(async () => observation(time, 1)); await advanceSample();
    inspect.mockImplementation(async () => observation(time)); await advanceSample(); await advanceSample();
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('preserves a valid baseline and delivered suppression through malformed, unavailable and missed observations', async () => {
    await manager.cycle(); inspect.mockResolvedValueOnce(undefined); time += 30_000; await manager.cycle();
    time = epoch + INSPECTION_INTERVAL_MS; await manager.cycle(); delivered();
    inspect.mockRejectedValueOnce(new Error('provider failed')); await advanceSample();
    await advanceSample(); await advanceSample(); expect(send).toHaveBeenCalledTimes(1);
  });
  it('retains reminders behind an old Router and retries failed cards without executing prompts', async () => {
    manager.registered(false); await manager.cycle(); await advanceSample(); expect(send).not.toHaveBeenCalled();
    send.mockImplementationOnce(() => { throw new Error('offline'); }); manager.registered(true);
    await vi.advanceTimersByTimeAsync(60_000); expect(send).toHaveBeenCalledTimes(2);
    const message = delivered(); manager.disconnected(); manager.registered(true); expect(send).toHaveBeenCalledTimes(2);
    manager.handle({ type: 'subscription_action', ...message.reminder, decision: 'send_hi' });
    expect(inspect).toHaveBeenCalledTimes(2);
  });
  it('ignores prompt and unknown actions without executing work or suppressing delivery retries', async () => {
    await manager.cycle(); await advanceSample(); const message = send.mock.calls[0][0];
    for (const decision of ['send_hi', 'not_now', 'unknown']) {
      manager.handle({ type: 'subscription_action', ...message.reminder, decision });
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(inspect).toHaveBeenCalledTimes(2); expect(send).toHaveBeenCalledTimes(2);
    manager.handle({ type: 'subscription_action', ...message.reminder, decision: 'dismiss' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(inspect).toHaveBeenCalledTimes(2); expect(send).toHaveBeenCalledTimes(2);
  });
  it('rejects stale or foreign ACKs/actions and resets the baseline on a proven identity change', async () => {
    await manager.cycle(); await advanceSample(); const message = send.mock.calls[0][0];
    manager.handle({ type: 'subscription_reminder_ack', ...message.reminder, generation: 'foreign' });
    await vi.advanceTimersByTimeAsync(60_000); expect(send).toHaveBeenCalledTimes(2);
    delivered(); inspect.mockImplementation(async () => ({ ...observation(time), identity: 'new-account', accountKey: 'f'.repeat(64) }));
    await advanceSample(); expect(send).toHaveBeenCalledTimes(2); await advanceSample(); expect(send).toHaveBeenCalledTimes(3);
  });
  it('serializes cycles, aborts on shutdown and never catches up with a burst after an outage', async () => {
    let finish!: (v: WeeklyObservation) => void, started!: () => void;
    const probing = new Promise<void>(resolve => { started = resolve; });
    inspect.mockImplementationOnce(() => new Promise<WeeklyObservation>(resolve => { finish = resolve; started(); }));
    const first = manager.cycle(); const second = manager.cycle(); await probing;
    try { expect(inspect).toHaveBeenCalledTimes(1); }
    finally { finish(observation()); await Promise.all([first, second]); }
    await advanceSample(3); expect(send).not.toHaveBeenCalled();
    await manager.stop(); await manager.cycle(); expect(inspect).toHaveBeenCalledTimes(2);
  });
});
