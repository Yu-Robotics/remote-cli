import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { SubscriptionInspection, inspectionAdapters } from '../../src/maintenance/SubscriptionInspection';
import { SubscriptionReminderStore } from '../../src/maintenance/SubscriptionReminderStore';
import { PrivateStore } from '../../src/maintenance/PrivateStore';
import { codexWeeklyObservation, INSPECTION_INTERVAL_MS, WEEK_SECONDS } from '../../src/maintenance/CodexWeekly';

describe('quota reminder suppression across service lifetimes', () => {
  let directory: string, time: number, used: number, account: string, credential: string;
  let inspect: ReturnType<typeof vi.fn>, send: ReturnType<typeof vi.fn>, clients: SubscriptionInspection[];
  const store = () => new SubscriptionReminderStore(directory, 'https://router.example.com', 'device-fixture');
  const observation = () => codexWeeklyObservation({ accountId: account, rateLimits: {
    limitId: 'codex', secondary: { usedPercent: used, windowDurationMins: 10080, resetsAt: time / 1000 + WEEK_SECONDS },
  } }, account, credential, time)!;
  const make = () => {
    const client = new SubscriptionInspection(inspectionAdapters(inspect), send, () => time, undefined, undefined, store());
    clients.push(client); client.registered(true); return client;
  };
  const next = async (client: SubscriptionInspection) => { time += INSPECTION_INTERVAL_MS; await client.cycle(); };
  const acknowledge = async (client: SubscriptionInspection) => {
    const message = send.mock.calls.at(-1)![0];
    await client.handle({ type: 'subscription_reminder_ack', ...message.reminder }); return message;
  };
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-inspection-test-'));
    time = 1800000000000; used = 0; account = 'account-fixture'; credential = 'credential-fixture'; clients = [];
    inspect = vi.fn(async () => observation()); send = vi.fn();
  });
  afterEach(async () => { await Promise.all(clients.map(client => client.stop())); vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }); });

  it('keeps delivered suppression through reconnection, upgrades, and credential refresh without persisting observations', async () => {
    const first = make(); await first.cycle(); expect(send).not.toHaveBeenCalled();
    await next(first); await acknowledge(first); expect(send).toHaveBeenCalledTimes(1);
    first.disconnected(); first.registered(true); await next(first); expect(send).toHaveBeenCalledTimes(1);
    await first.stop(); credential = 'refreshed-credential-fixture'; time += INSPECTION_INTERVAL_MS;
    const restarted = make(); await restarted.cycle(); await next(restarted); await next(restarted);
    expect(send).toHaveBeenCalledTimes(1);
    credential = 'another-refreshed-fixture'; await next(restarted); await next(restarted);
    expect(send).toHaveBeenCalledTimes(1);
    const filename = (await fs.readdir(path.join(directory, 'subscription-reminders')))[0];
    const ledger = await fs.readFile(path.join(directory, 'subscription-reminders', filename), 'utf8');
    expect(JSON.parse(ledger)).toEqual({ format: 1, suppressedAccounts: [observation().accountKey] });
    expect(ledger + JSON.stringify(send.mock.calls)).not.toMatch(/account-fixture|credential-fixture|observedAt|resetsAt|accountKey|identity/);
  });

  it('durably rearms after valid usage and still requires two new hourly observations after another restart', async () => {
    const first = make(); await first.cycle(); await next(first); await acknowledge(first); await first.stop();
    used = 1; const active = make(); await active.cycle(); await active.stop();
    expect(await store().isSuppressed(observation().accountKey)).toBe(false);
    used = 0; const restarted = make(); await restarted.cycle(); expect(send).toHaveBeenCalledTimes(1);
    await next(restarted); expect(send).toHaveBeenCalledTimes(2);
  });

  it('preserves delivered state through unavailable probes and keeps switched accounts independent', async () => {
    const first = make(); await first.cycle(); await next(first); await acknowledge(first); await first.stop();
    const restarted = make(); inspect.mockResolvedValueOnce(undefined); await restarted.cycle();
    inspect.mockRejectedValueOnce(new Error('provider unavailable')); await next(restarted); await next(restarted);
    expect(send).toHaveBeenCalledTimes(1);
    account = 'another-account-fixture'; await next(restarted); await next(restarted); expect(send).toHaveBeenCalledTimes(2);
    await acknowledge(restarted); account = 'account-fixture'; await next(restarted); await next(restarted);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('does not suppress unacknowledged delivery or accept ACKs from a prior process generation', async () => {
    const first = make(); await first.cycle(); await next(first); const stale = send.mock.calls[0][0]; await first.stop();
    const restarted = make(); await restarted.cycle(); expect(send).toHaveBeenCalledTimes(1);
    await next(restarted); expect(send).toHaveBeenCalledTimes(2);
    await restarted.handle({ type: 'subscription_reminder_ack', ...stale.reminder });
    expect(await store().isSuppressed(observation().accountKey)).toBe(false);
    await acknowledge(restarted); expect(await store().isSuppressed(observation().accountKey)).toBe(true);
  });

  it('waits for an accepted ACK write to finish before an upgrade shutdown completes', async () => {
    const client = make(); await client.cycle(); await next(client);
    let release!: () => void, writing!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { writing = resolve; });
    const original = PrivateStore.prototype.write;
    vi.spyOn(PrivateStore.prototype, 'write').mockImplementationOnce(async function(value) { writing(); await gate; await original.call(this, value); });
    const acknowledgement = acknowledge(client); await started;
    let stopped = false; const shutdown = client.stop().then(() => { stopped = true; });
    try { await Promise.resolve(); expect(stopped).toBe(false); }
    finally { release(); await Promise.all([acknowledgement, shutdown]); }
    const restarted = make(); await restarted.cycle(); await next(restarted); expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not let an ACK queued during a valid active observation suppress the next eligible episode', async () => {
    const client = make(); await client.cycle(); await next(client);
    let finish!: (value: ReturnType<typeof observation>) => void, entered!: () => void;
    const probing = new Promise<void>(resolve => { entered = resolve; });
    inspect.mockImplementationOnce(() => new Promise<ReturnType<typeof observation>>(resolve => { finish = resolve; entered(); }));
    time += INSPECTION_INTERVAL_MS; const cycle = client.cycle(); await probing;
    const acknowledgement = acknowledge(client); used = 1; finish(observation()); await Promise.all([cycle, acknowledgement]);
    expect(await store().isSuppressed(observation().accountKey)).toBe(false);
    used = 0; await next(client); await next(client); expect(send).toHaveBeenCalledTimes(2);
  });

  it('rejects a late ACK while a valid non-candidate observation is clearing its durable marker', async () => {
    const client = make(); await client.cycle(); await next(client); const message = await acknowledge(client);
    let release!: () => void, writing!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { writing = resolve; });
    const original = PrivateStore.prototype.write;
    vi.spyOn(PrivateStore.prototype, 'write').mockImplementationOnce(async function(value) { writing(); await gate; await original.call(this, value); });
    used = 1; time += INSPECTION_INTERVAL_MS; const clearing = client.cycle(); await started;
    const lateAck = client.handle({ type: 'subscription_reminder_ack', ...message.reminder });
    release(); await Promise.all([clearing, lateAck]);
    expect(await store().isSuppressed(observation().accountKey)).toBe(false);
    await client.stop(); used = 0;
    const restarted = make(); await restarted.cycle(); await next(restarted); expect(send).toHaveBeenCalledTimes(2);
  });

  it('pauses only reminders on corrupt local state or a failed ACK write, without logging private errors', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = make(); await client.cycle(); await next(client);
    vi.spyOn(PrivateStore.prototype, 'write').mockRejectedValueOnce(new Error('private-storage-fixture-error'));
    await acknowledge(client); const probes = inspect.mock.calls.length; await next(client); await next(client);
    expect(inspect).toHaveBeenCalledTimes(probes); expect(send).toHaveBeenCalledTimes(1); expect(warn).toHaveBeenCalledTimes(1);
    await client.stop();
    await store().setSuppressed(observation().accountKey, true);
    const filename = (await fs.readdir(path.join(directory, 'subscription-reminders')))[0];
    const file = path.join(directory, 'subscription-reminders', filename); await fs.writeFile(file, '{broken-fixture');
    const restarted = make(); await restarted.cycle(); await next(restarted);
    expect(inspect).toHaveBeenCalledTimes(probes); expect(send).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(file, 'utf8')).toBe('{broken-fixture');
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private-storage-fixture-error|broken-fixture/);
  });
});
