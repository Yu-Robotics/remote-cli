import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MaintenanceClient } from '../../src/maintenance/MaintenanceClient';
import { UpdateNotices } from '../../src/maintenance/UpdateNotices';
import { SubscriptionInspection } from '../../src/maintenance/SubscriptionInspection';
import { SubscriptionReminderStore } from '../../src/maintenance/SubscriptionReminderStore';

const doubles = vi.hoisted(() => ({
  updates: { started: vi.fn(), registered: vi.fn(), handle: vi.fn(), stop: vi.fn(), disconnected: vi.fn() },
  subscriptions: { start: vi.fn(), registered: vi.fn(), handle: vi.fn(), stop: vi.fn(), disconnected: vi.fn() },
}));
vi.mock('../../src/maintenance/UpdateNotices', () => ({ UpdateNotices: vi.fn(() => doubles.updates) }));
vi.mock('../../src/maintenance/SubscriptionInspection', () => ({ SubscriptionInspection: vi.fn(() => doubles.subscriptions), inspectionAdapters: vi.fn() }));
vi.mock('../../src/maintenance/CodexStatusProbe', () => ({ CodexStatusProbe: vi.fn(() => ({ inspect: vi.fn() })) }));

describe('maintenance service lifecycle', () => {
  beforeEach(() => { vi.clearAllMocks(); doubles.updates.started.mockResolvedValue(undefined); doubles.updates.handle.mockResolvedValue(undefined); doubles.subscriptions.stop.mockResolvedValue(undefined); });
  const make = (enabled?: any) => new MaintenanceClient({ send: vi.fn(), on: vi.fn() }, '/temporary-fixture', 'https://router.example.com', 'device-fixture', () => undefined, enabled);
  it('waits for actual startup and negotiated capabilities, preserving unrelated/legacy traffic', async () => {
    const client = make();
    expect(vi.mocked(SubscriptionInspection).mock.calls[0][5]).toBeInstanceOf(SubscriptionReminderStore);
    expect(doubles.updates.started).not.toHaveBeenCalled(); expect(doubles.subscriptions.start).not.toHaveBeenCalled();
    expect(await client.handle({ type: 'binding_confirm', data: { success: true } })).toBe(false);
    expect(doubles.updates.registered).toHaveBeenLastCalledWith(false);
    expect(await client.handle({ type: 'stream' })).toBe(false);
    await client.started('1.6.122'); expect(doubles.updates.started).toHaveBeenCalledWith('1.6.122');
    await client.handle({ type: 'binding_confirm', data: { success: true, capabilities: { updateNotice: true, subscriptionInspection: true } } });
    expect(doubles.updates.registered).toHaveBeenLastCalledWith(true);
    expect(doubles.subscriptions.registered).toHaveBeenLastCalledWith(true, false);
    await client.handle({ type: 'binding_confirm', data: { success: true,
      capabilities: { subscriptionInspection: true, bankedResetReminder: true } } });
    expect(doubles.subscriptions.registered).toHaveBeenLastCalledWith(true, true);
    await client.handle({ type: 'binding_confirm', data: { success: false,
      capabilities: { subscriptionInspection: true, bankedResetReminder: true } } });
    expect(doubles.subscriptions.registered).toHaveBeenLastCalledWith(false, false);
    expect(await client.handle({ type: 'update_notice_ack' })).toBe(true);
    expect(await client.handle({ type: 'subscription_action', decision: 'send_hi' })).toBe(true);
    await client.stop(); expect(doubles.updates.stop).toHaveBeenCalled(); expect(doubles.subscriptions.stop).toHaveBeenCalled();
  });
  it('supports independent opt-out without changing normal messaging or starting a disabled probe', async () => {
    const client = make({ updateNotice: false, subscriptionInspection: false }); await client.started('1.6.122');
    expect(UpdateNotices).not.toHaveBeenCalled(); expect(SubscriptionInspection).not.toHaveBeenCalled();
    expect(await client.handle({ type: 'command' })).toBe(false);
  });
  it('never treats socket OPEN or a rejected registration as a successful version start', async () => {
    const client = make(); await client.started('1.6.122');
    await client.handle({ type: 'binding_confirm', data: { success: false } });
    expect(doubles.updates.started).not.toHaveBeenCalled(); expect(doubles.subscriptions.start).not.toHaveBeenCalled();
    await client.handle({ type: 'binding_confirm', data: { success: true } });
    expect(doubles.updates.started).toHaveBeenCalledTimes(1);
    await client.handle({ type: 'binding_confirm', data: { success: true } }); expect(doubles.updates.started).toHaveBeenCalledTimes(1);
  });
  it('keeps normal startup available if private maintenance storage is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    doubles.updates.started.mockRejectedValueOnce(new Error('private-storage-error'));
    const client = make(); await client.handle({ type: 'binding_confirm', data: { success: true } });
    await expect(client.started('1.6.122')).resolves.toBeUndefined();
    expect(doubles.subscriptions.start).toHaveBeenCalled(); expect(warn).toHaveBeenCalledWith(expect.not.stringContaining('private-storage-error')); warn.mockRestore();
  });
  it('waits for quota acknowledgement persistence without consuming unrelated messages', async () => {
    let complete!: () => void;
    doubles.subscriptions.handle.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }));
    const client = make();
    let handled = false;
    const acknowledgement = client.handle({ type: 'subscription_reminder_ack' }).then(value => { handled = value; });
    await Promise.resolve(); expect(handled).toBe(false);
    expect(await client.handle({ type: 'command' })).toBe(false);
    complete(); await acknowledgement; expect(handled).toBe(true);
  });
});
