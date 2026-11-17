import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DshExecutor } from '../../src/executor/DshExecutor';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { ScheduleService, SCHEDULE_CATALOG_FILE } from '../../src/scheduling/ScheduleService';
import { AutomaticUpdater } from '../../src/update/AutomaticUpdater';

import { Host, deferred } from './SyntheticDshScheduleHost';

describe('DSH abrupt lifecycle through production adapters', () => {
  let root: string, executor: DshExecutor, service: ScheduleService;
  let hosts: Host[], history: string[], executors: DshExecutor[], services: ScheduleService[];
  const owner = { threadId: 'thread', openId: 'fixture-owner', generation: 'generation' };
  const catalog = () => JSON.parse(fs.readFileSync(path.join(root, 'catalog', SCHEDULE_CATALOG_FILE), 'utf8'));
  const makeExecutor = (configure?: (host: Host) => void) => {
    const result = new DshExecutor(new DirectoryGuard([root]), { initialWorkingDirectory: root, threadId: 'thread',
      sessionBaseDir: path.join(root, 'sessions'), clientFactory: () => { const host = new Host(history); configure?.(host); hosts.push(host); return host; } });
    executors.push(result); return result;
  };
  const makeService = () => {
    const result = new ScheduleService({ directory: path.join(root, 'catalog'), isOwnerCurrent: () => true, now: () => Date.now(),
      provider: { cleanupFor: () => executor.nativeScheduleCleanup, create: (input, emit) => executor.createNativeSchedule(input, emit) },
      deliver: async () => {} });
    services.push(result); return result;
  };
  const create = () => service.create(owner, { id: 'job', backend: 'dsh', threadId: 'thread', cwd: root, prompt: 'Synthetic reminder',
    rule: { kind: 'cron', expression: '*/5 * * * *', timezone: 'UTC' } });
  beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-recovery-')));
    vi.spyOn(os, 'homedir').mockReturnValue(root); vi.stubEnv('HOME', root); vi.stubEnv('USERPROFILE', root);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    hosts = []; history = []; executors = []; services = [];
    executor = makeExecutor(); service = makeService(); await service.initialize();
  });
  afterEach(async () => {
    vi.clearAllTimers(); vi.useRealTimers();
    await Promise.allSettled(services.map(value => value.destroy()));
    await Promise.all(executors.map(value => value.destroy()));
    await Promise.all(hosts.map(value => value.waitForExit()));
    vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true });
  });

  it('persists real adapter deletion proof for history purge after a client restart', async () => {
    await create(); await service.cancel(owner, 'job');
    expect(catalog().records[0]).toMatchObject({ state: 'cancelled', cleanupConfirmed: true });
    expect(catalog().version).toBe(6);
    await service.destroy(); await executor.destroy();
    const before = hosts.length;
    executor = makeExecutor(); service = makeService(); await service.initialize();
    expect(await service.purge(owner, { ids: ['job'] })).toMatchObject({ removedIds: ['job'], pending: [], errors: [] });
    expect(hosts).toHaveLength(before); expect(catalog().records).toEqual([]);
  });

  it('does not recover an unqualified lineage or issue any schedule RPC during shutdown', async () => {
    await executor.execute('Original foreground'); await create();
    const original = executor.getSessionId(); const host = hosts[0];
    expect(executor.nativeScheduleCleanup.cancelRetained).toBeUndefined();
    expect(JSON.parse(catalog().records[0].recovery.identity).sessionId).toBe(original);
    expect(service.canRestartWithoutActiveWork()).toBe(true);
    const before = JSON.stringify(catalog());
    await service.destroy(); await executor.destroy();
    expect(JSON.stringify(catalog())).toBe(before); expect(host.sendCancel).not.toHaveBeenCalled();
    executor = makeExecutor(); service = makeService(); await service.initialize();
    expect(hosts).toHaveLength(1); expect(executor.getSessionId()).toBe(original);
    expect((await service.list(owner))[0]).toMatchObject({ state: 'interrupted', error: expect.stringContaining('not recreated') });
  });
  it('allows idle future schedules through update admission without drain or recreation', async () => {
    await create(); const install = vi.fn(async () => {});
    const updater = new AutomaticUpdater('1.6.256', { tryBeginAutomaticUpdate: () => service.canRestartWithoutActiveWork(),
      endAutomaticUpdate: () => {} }, { installVersion: install, restartAfterUpdate: false });
    await updater.handleRouterVersion('1.6.257');
    expect(install).toHaveBeenCalledOnce(); expect(hosts).toHaveLength(1);
    expect(hosts[0].destroy).not.toHaveBeenCalled(); expect(hosts[0].sendCancel).not.toHaveBeenCalled();
  });
  it('keeps active work and pending delivery safety independent of idle future scheduling', async () => {
    await create(); hosts[0].start(hosts[0].rows[0]); await service.list(owner);
    expect(service.canRestartWithoutActiveWork()).toBe(false);
    hosts[0].finish('Synthetic scheduled output'); await service.retryDeliveries();
    expect(service.canRestartWithoutActiveWork()).toBe(true);
  });
});
