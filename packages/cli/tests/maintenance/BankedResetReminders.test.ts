import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BankedResetReminders } from '../../src/maintenance/BankedResetReminders';
import type { CodexQuotaObservation } from '../../src/maintenance/CodexQuota';
import { INSPECTION_INTERVAL_MS } from '../../src/maintenance/CodexWeekly';

const generation = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const accountKey = 'a'.repeat(64);
describe('strictly increasing banked reset reminders', () => {
  let send: ReturnType<typeof vi.fn>, manager: BankedResetReminders, now: number;
  const sample = (count?: number, account = accountKey, time = now): CodexQuotaObservation => ({ accountKey: account, observedAt: time, bankedResetCount: count });
  const observe = (count?: number) => { now += INSPECTION_INTERVAL_MS; manager.observe(sample(count)); };
  const ack = (reminder = send.mock.calls.at(-1)![0].reminder) => manager.handle({ type: 'subscription_reminder_ack', ...reminder });
  beforeEach(() => {
    vi.useFakeTimers(); now = 1800000000000; send = vi.fn();
    manager = new BankedResetReminders(send, generation, () => now); manager.registered(true);
  });
  afterEach(() => { manager.stop(); vi.clearAllTimers(); vi.useRealTimers(); });

  it('silently establishes a baseline, then notifies only strict increases over the immediately previous valid count', () => {
    observe(5); observe(5); observe(3); expect(send).not.toHaveBeenCalled();
    observe(4); expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ type: 'subscription_reminder', reminder: {
      backend: 'codex', kind: 'banked_reset_increase', previousCount: 3, availableCount: 4, activationAvailable: false,
    } });
    expect(JSON.stringify(send.mock.calls)).not.toMatch(/accountKey|observedAt|identity/);
    expect(ack()).toBe(true); observe(4); observe(1); expect(send).toHaveBeenCalledTimes(1);
    observe(2); expect(send).toHaveBeenCalledTimes(2); ack(); observe(0); observe(1); expect(send).toHaveBeenCalledTimes(3);
  });
  it('keeps the last valid count across unavailable evidence rather than manufacturing growth from zero', () => {
    observe(undefined); observe(2); observe(undefined); observe(2); expect(send).not.toHaveBeenCalled();
    observe(undefined); observe(3); expect(send).toHaveBeenCalledTimes(1); expect(send.mock.calls[0][0].reminder.previousCount).toBe(2);
  });
  it('isolates accounts and makes account switches, clock rollback and restarts silent baselines', () => {
    observe(2); observe(3); const stale = send.mock.calls[0][0].reminder;
    manager.observe(sample(undefined, 'b'.repeat(64))); expect(ack(stale)).toBe(false);
    manager.observe(sample(10, 'b'.repeat(64))); expect(send).toHaveBeenCalledTimes(1);
    manager.observe(sample(12, 'b'.repeat(64), now - 1)); expect(send).toHaveBeenCalledTimes(1);
    manager.observe(sample(2)); observe(3); expect(send).toHaveBeenCalledTimes(2);
    manager.stop(); manager = new BankedResetReminders(send, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', () => now); manager.registered(true);
    observe(5); expect(send).toHaveBeenCalledTimes(2); expect(ack(stale)).toBe(false);
    observe(6); expect(send).toHaveBeenCalledTimes(3);
  });
  it('gates new notices for old peers and retries the same event until an exact ACK without another probe', async () => {
    manager.registered(false); observe(2); observe(3); expect(send).not.toHaveBeenCalled();
    send.mockImplementationOnce(() => { throw new Error('offline'); }); manager.registered(true);
    const first = send.mock.calls[0][0].reminder;
    for (const message of [
      { type: 'subscription_reminder_ack', ...first, reminderId: 'foreign' },
      { type: 'subscription_reminder_ack', ...first, generation: 'foreign' },
      { type: 'subscription_action', ...first, decision: 'send_hi' },
      { type: 'subscription_action', ...first, decision: 'not_now' },
    ]) expect(manager.handle(message)).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000); expect(send).toHaveBeenCalledTimes(2); expect(send.mock.calls[1][0].reminder).toEqual(first);
    manager.disconnected(); await vi.advanceTimersByTimeAsync(60_000); expect(send).toHaveBeenCalledTimes(2);
    manager.registered(true); expect(send).toHaveBeenCalledTimes(3); ack();
    manager.disconnected(); manager.registered(true); await vi.advanceTimersByTimeAsync(60_000); expect(send).toHaveBeenCalledTimes(3);
    observe(4); expect(send).toHaveBeenCalledTimes(4); expect(ack(first)).toBe(false);
    const latest = send.mock.calls.at(-1)![0].reminder;
    expect(manager.handle({ type: 'subscription_action', ...latest, decision: 'dismiss' })).toBe(true);
  });
  it('replaces superseded increases and cancels pending delivery after consumption, expiry or shutdown', async () => {
    manager.registered(false); observe(1); observe(2); observe(3); manager.registered(true);
    expect(send.mock.calls[0][0].reminder).toMatchObject({ previousCount: 2, availableCount: 3 });
    observe(3); await vi.advanceTimersByTimeAsync(60_000); expect(send).toHaveBeenCalledTimes(2);
    observe(2); await vi.advanceTimersByTimeAsync(60_000); expect(send).toHaveBeenCalledTimes(2);
    observe(3); const expired = send.mock.calls.at(-1)![0].reminder;
    now = expired.expiresAt; expect(ack(expired)).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000); expect(send).toHaveBeenCalledTimes(3);
    observe(4); expect(send).toHaveBeenCalledTimes(4); manager.stop(); observe(5); manager.registered(true);
    await vi.advanceTimersByTimeAsync(60_000); expect(send).toHaveBeenCalledTimes(4);
  });
});
