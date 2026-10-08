import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SubscriptionInspection, inspectionAdapters } from '../../src/maintenance/SubscriptionInspection';
import { codexQuotaObservation } from '../../src/maintenance/CodexQuota';
import { INSPECTION_INTERVAL_MS, WEEK_SECONDS } from '../../src/maintenance/CodexWeekly';
import type { SubscriptionReminderStore } from '../../src/maintenance/SubscriptionReminderStore';

describe('banked and weekly reminders from the same independent inspection', () => {
  let manager: SubscriptionInspection, send: ReturnType<typeof vi.fn>, inspect: ReturnType<typeof vi.fn>;
  let store: { initialize: ReturnType<typeof vi.fn>; isSuppressed: ReturnType<typeof vi.fn>; setSuppressed: ReturnType<typeof vi.fn> };
  let time: number, account: string, count: number | undefined, used: number, weekly: boolean;
  const sample = () => codexQuotaObservation({ accountId: account, rateLimitResetCredits: { availableCount: count, credits: null },
    ...(weekly ? { rateLimits: { limitId: 'codex', secondary: { usedPercent: used, windowDurationMins: 10080, resetsAt: time / 1000 + WEEK_SECONDS } } } : {}),
  }, account, 'credential-fixture', time);
  const next = async () => { time += INSPECTION_INTERVAL_MS; await manager.cycle(); };
  const acknowledge = async (reminder: any) => manager.handle({ type: 'subscription_reminder_ack', ...reminder });
  beforeEach(() => {
    vi.useFakeTimers(); time = 1800000000000; account = 'account-fixture'; count = 2; used = 20; weekly = true;
    send = vi.fn(); inspect = vi.fn(async () => sample());
    store = { initialize: vi.fn().mockResolvedValue(undefined), isSuppressed: vi.fn().mockResolvedValue(false), setSuppressed: vi.fn().mockResolvedValue(undefined) };
    manager = new SubscriptionInspection(inspectionAdapters(inspect), send, () => time, undefined, undefined, store as unknown as SubscriptionReminderStore);
    manager.registered(true, true);
  });
  afterEach(async () => { await manager.stop(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it('observes each count once without additional native calls or weekly-window eligibility', async () => {
    weekly = false; await manager.cycle(); count = 1; await next(); count = 2; await next();
    expect(inspect).toHaveBeenCalledTimes(3); expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].reminder).toMatchObject({ previousCount: 1, availableCount: 2, kind: 'banked_reset_increase' });
    await acknowledge(send.mock.calls[0][0].reminder); count = 3; await next();
    expect(send).toHaveBeenCalledTimes(2); expect(store.setSuppressed).not.toHaveBeenCalled();
  });
  it('keeps weekly durable suppression and banked event acknowledgements independent', async () => {
    used = 0; await manager.cycle(); count = 3; await next();
    expect(send).toHaveBeenCalledTimes(2);
    const banked = send.mock.calls.find(([m]) => m.reminder.kind === 'banked_reset_increase')![0].reminder;
    const regular = send.mock.calls.find(([m]) => m.reminder.kind === undefined)![0].reminder;
    await acknowledge(banked); expect(store.setSuppressed).not.toHaveBeenCalled();
    await acknowledge(regular); expect(store.setSuppressed).toHaveBeenCalledTimes(1);
    expect(store.setSuppressed).toHaveBeenCalledWith(sample()!.weekly!.accountKey, true);
    count = 4; await next(); expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.at(-1)![0].reminder.kind).toBe('banked_reset_increase');
    await acknowledge(banked); await vi.advanceTimersByTimeAsync(60_000); expect(send).toHaveBeenCalledTimes(4);
    await acknowledge(send.mock.calls.at(-1)![0].reminder); await next(); expect(send).toHaveBeenCalledTimes(4);
  });
  it('continues to notice growth even when a previous weekly episode was suppressed before startup', async () => {
    store.isSuppressed.mockResolvedValue(true); used = 0; await manager.cycle(); count = 3; await next();
    expect(send).toHaveBeenCalledTimes(1); expect(send.mock.calls[0][0].reminder.kind).toBe('banked_reset_increase');
  });
  it('requires the separate peer capability and reuses pending delivery without another status read', async () => {
    manager.registered(true); await manager.cycle(); count = 3; await next(); expect(send).not.toHaveBeenCalled();
    manager.registered(false, true); expect(send).not.toHaveBeenCalled();
    manager.registered(true, true); expect(send).toHaveBeenCalledTimes(1); expect(inspect).toHaveBeenCalledTimes(2);
    await acknowledge(send.mock.calls[0][0].reminder); manager.disconnected(); manager.registered(true, true);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('does not invent zero on unknown responses and cancels old-account notices on a proven switch', async () => {
    await manager.cycle(); inspect.mockRejectedValueOnce(new Error('unavailable-fixture')); await next();
    count = undefined; await next(); count = 2; await next(); expect(send).not.toHaveBeenCalled();
    count = 3; await next(); expect(send).toHaveBeenCalledTimes(1);
    used = 0; await next(); await next(); expect(send).toHaveBeenCalledTimes(2);
    const staleWeekly = send.mock.calls[1][0].reminder;
    weekly = false; count = undefined; account = 'other-account-fixture'; await next();
    await acknowledge(staleWeekly); await vi.advanceTimersByTimeAsync(60_000); expect(send).toHaveBeenCalledTimes(2);
    expect(store.setSuppressed).not.toHaveBeenCalled();
    count = 10; await next(); expect(send).toHaveBeenCalledTimes(2);
    count = 11; await next(); expect(send).toHaveBeenCalledTimes(3);
  });
  it('pauses both reminder deliveries on unsafe storage and stops cleanly without re-probing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    store.initialize.mockRejectedValueOnce(new Error('private-fixture')); await manager.cycle();
    manager.registered(true, true); count = 3; await next();
    expect(inspect).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    await manager.stop(); await manager.cycle(); expect(inspect).not.toHaveBeenCalled();
  });
});
