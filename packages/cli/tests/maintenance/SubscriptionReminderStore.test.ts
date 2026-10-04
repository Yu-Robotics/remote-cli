import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { SubscriptionReminderStore } from '../../src/maintenance/SubscriptionReminderStore';

const key = (name: string) => createHash('sha256').update(name).digest('hex');
describe('private quota delivery ledger', () => {
  let directory: string;
  const make = (server = 'https://router.example.com', device = 'device-fixture') => new SubscriptionReminderStore(directory, server, device);
  const filename = async () => path.join(directory, 'subscription-reminders', (await fs.readdir(path.join(directory, 'subscription-reminders')))[0]);
  beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-store-test-')); });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  it('restores only fingerprints in a private atomic file scoped to the Router and device', async () => {
    const store = make(), account = key('account-fixture');
    expect(await store.isSuppressed(account)).toBe(false);
    await store.setSuppressed(account, true);
    expect(await make().isSuppressed(account)).toBe(true);
    expect(await make('https://another.example.com').isSuppressed(account)).toBe(false);
    expect(await make(undefined, 'another-device-fixture').isSuppressed(account)).toBe(false);
    const file = await filename(), text = await fs.readFile(file, 'utf8');
    expect(JSON.parse(text)).toEqual({ format: 1, suppressedAccounts: [account] });
    expect(text + path.basename(file)).not.toMatch(/account-fixture|device-fixture|router\.example\.com|token|resetsAt|observedAt|credential/i);
    if (process.platform !== 'win32') {
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    }
  });

  it('serializes concurrent account updates and durably rearms only the specified account', async () => {
    const store = make(), first = key('first-fixture'), second = key('second-fixture');
    await Promise.all([store.setSuppressed(first, true), store.setSuppressed(second, true), store.setSuppressed(first, false)]);
    expect(await make().isSuppressed(first)).toBe(false);
    expect(await make().isSuppressed(second)).toBe(true);
    await expect(store.setSuppressed('raw-account-fixture', true)).rejects.toThrow('fingerprint');
  });

  it('fails closed without overwriting corrupt, oversized, duplicate, or unrecognized ledger data', async () => {
    await make().setSuppressed(key('account-fixture'), true);
    const file = await filename();
    for (const content of ['{broken', JSON.stringify({ format: 2, suppressedAccounts: [] }),
      JSON.stringify({ format: 1, suppressedAccounts: [key('a'), key('a')] }),
      JSON.stringify({ format: 1, suppressedAccounts: ['raw-account-fixture'] }),
      JSON.stringify({ format: 1, suppressedAccounts: [], accountId: 'account-fixture' }),
      JSON.stringify({ format: 1, suppressedAccounts: Array.from({ length: 257 }, (_, index) => key(String(index))) }),
      'x'.repeat(1024 * 1024 + 1)]) {
      await fs.writeFile(file, content);
      const store = make();
      await expect(store.initialize()).rejects.toThrow('could not be read');
      await expect(store.setSuppressed(key('b'), true)).rejects.toThrow('could not be read');
      expect(await fs.readFile(file, 'utf8')).toBe(content);
    }
  });

  it('rejects symlink state and refuses to evict existing suppression when the ledger is full', async () => {
    await make().setSuppressed(key('account-fixture'), true);
    const file = await filename();
    const content = JSON.stringify({ format: 1, suppressedAccounts: Array.from({ length: 256 }, (_, index) => key(String(index))) });
    await fs.writeFile(file, content);
    await expect(make().setSuppressed(key('overflow-fixture'), true)).rejects.toThrow('Invalid maintenance state');
    expect(await fs.readFile(file, 'utf8')).toBe(content);
    const target = path.join(directory, 'target-fixture.json');
    await fs.rename(file, target); await fs.symlink(target, file);
    await expect(make().initialize()).rejects.toThrow('could not be read');
    expect(await fs.readFile(target, 'utf8')).toBe(content);
  });
});
