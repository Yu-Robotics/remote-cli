import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DshExecutor } from '../../src/executor/DshExecutor';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { ScheduleService, SCHEDULE_CATALOG_FILE } from '../../src/scheduling/ScheduleService';
import { AutomaticUpdater } from '../../src/update/AutomaticUpdater';

import { Host, deferred } from './SyntheticDshScheduleHost';

describe('DSH orderly recovery through production adapters', () => {
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
    const result = new ScheduleService({ directory: path.join(root, 'catalog'), isOwnerCurrent: () => true, canRecover: () => true, now: () => Date.now(),
      provider: { recoveryFor: () => executor.nativeScheduleRecovery, create: (input, emit) => executor.createNativeSchedule(input, emit) },
      deliver: async () => {} });
    services.push(result); return result;
  };
  const create = () => service.create(owner, { id: 'job', backend: 'dsh', threadId: 'thread', cwd: root, prompt: 'Synthetic reminder',
    rule: { kind: 'cron', expression: '*/5 * * * *', timezone: 'UTC' } });
  beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-recovery-')));
    vi.spyOn(os, 'homedir').mockReturnValue(root);
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
    vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true });
  });

  it('restores at startup without a prompt, retaining original session and future context', async () => {
    await executor.execute('Original foreground'); await create();
    expect(service.canSuspendForRestart()).toBe(true);
    await service.destroy(); await executor.destroy();
    expect(catalog().records[0].recovery.handoff).toBe('clean');
    expect(hosts[0].sendCancel).not.toHaveBeenCalled();
    executor = makeExecutor(); service = makeService(); await service.initialize(); await service.recover();
    expect(hosts).toHaveLength(2);
    expect(hosts[1].loadSession).toHaveBeenCalledWith('original-session', root);
    expect(hosts[1].newSession).not.toHaveBeenCalled(); expect(hosts[1].prompt).not.toHaveBeenCalled();
    expect((await service.list(owner))[0].state).toBe('active');
    hosts[1].start(hosts[1].rows[0]); hosts[1].finish('First restored occurrence'); await service.retryDeliveries();
    await executor.execute('Later foreground');
    hosts[1].start(hosts[1].rows[0], 2); hosts[1].finish('Second restored occurrence', 2); await service.retryDeliveries();
    expect(history).toEqual(['Original foreground', 'First restored occurrence', 'Later foreground', 'Second restored occurrence']);
  });

  it('drains a racing occurrence and joins actual host exit before clean checkpoint or install', async () => {
    await create(); const host = hosts[0], idle = deferred<void>(), exit = deferred<void>();
    host.idle.mockImplementationOnce(() => idle.promise); host.exitGate = exit.promise;
    host.deleteRace = () => host.start(host.rows[0]);
    const install = vi.fn(async () => {}), processExit = vi.fn();
    const updater = new AutomaticUpdater('1.6.237', { tryBeginAutomaticUpdate: () => service.canSuspendForRestart(),
      prepareAutomaticUpdate: () => service.suspendForRestart(), endAutomaticUpdate: () => service.recover() },
      { installVersion: install, beforeRestart: async () => {}, exitProcess: processExit });
    const update = updater.handleRouterVersion('1.6.238');
    await vi.waitFor(() => expect(host.idle).toHaveBeenCalled());
    expect(install).not.toHaveBeenCalled(); expect(host.destroy).not.toHaveBeenCalled();
    host.finish('Drained occurrence'); idle.resolve();
    await vi.waitFor(() => expect(host.destroy).toHaveBeenCalled());
    expect(catalog().records[0].recovery.handoff).toBeUndefined(); expect(install).not.toHaveBeenCalled();
    exit.resolve(); await update;
    expect(install).toHaveBeenCalledOnce(); expect(processExit).toHaveBeenCalledWith(0);
    expect(catalog().records[0].recovery.handoff).toBe('clean');
  });

  it.each(['failure', 'manual'] as const)('restores suspended tasks after %s installation without replaying foreground', async mode => {
    await create();
    const updater = new AutomaticUpdater('1.6.237', { tryBeginAutomaticUpdate: () => service.canSuspendForRestart(),
      prepareAutomaticUpdate: () => service.suspendForRestart(), endAutomaticUpdate: () => service.recover() },
      { restartAfterUpdate: mode !== 'manual', installVersion: async () => { if (mode === 'failure') throw new Error('Synthetic install failure'); },
        beforeRestart: vi.fn(), exitProcess: vi.fn(), failureRetryDelayMs: 60_000 });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await updater.handleRouterVersion('1.6.238');
    vi.clearAllTimers(); vi.useRealTimers();
    expect(hosts).toHaveLength(2); expect(hosts[1].loadSession).toHaveBeenCalled();
    expect((await service.list(owner))[0].state).toBe('active'); expect(hosts[1].rows).toHaveLength(1);
    expect(history).toEqual([]);
  });

  it('does not reconstruct a dirty crash snapshot ', async () => {
    await create(); const dirty = catalog();
    await service.destroy(); await executor.destroy();
    fs.writeFileSync(path.join(root, 'catalog', SCHEDULE_CATALOG_FILE), JSON.stringify(dirty));
    executor = makeExecutor(); service = makeService(); await service.initialize(); await service.recover();
    expect(hosts).toHaveLength(1); expect((await service.list(owner))[0].error).toContain('Dirty shutdown');
  });
  it('refuses missing original session without a replacement session or mutation', async () => {
    await create(); await service.destroy(); await executor.destroy();
    executor = makeExecutor(); executor.resetContext();
    service = makeService(); await service.initialize(); await service.recover();
    expect(hosts).toHaveLength(1);
    expect((await service.list(owner))[0]).toMatchObject({ state: 'interrupted', recovery: { status: 'blocked' } });
    expect(service.hasActiveSchedules()).toBe(true);
  });

  it('retains dirty proof and refuses installation while actual host exit is unconfirmed', async () => {
    await create(); const exit = deferred<void>(); hosts[0].exitGate = exit.promise;
    const install = vi.fn(), updater = new AutomaticUpdater('1.6.237', {
      tryBeginAutomaticUpdate: () => service.canSuspendForRestart(), prepareAutomaticUpdate: () => service.suspendForRestart(),
      endAutomaticUpdate: async () => { if (service.hasUnresolvedHandoff()) throw new Error('Handoff remains unresolved'); },
    }, { installVersion: install });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const update = updater.handleRouterVersion('1.6.238');
    await vi.waitFor(() => expect(hosts[0].destroy).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(8001); await update;
    expect(install).not.toHaveBeenCalled(); expect(service.hasUnresolvedHandoff()).toBe(true);
    expect(catalog().records[0].recovery.handoff).toBeUndefined();
    expect((await executor.execute('Must remain fenced')).success).toBe(false);
    exit.resolve(); await hosts[0].waitForExit(); vi.useRealTimers();
  });

  it('expires clean one-shots without resetting their deadline or retaining a foreground fence', async () => {
    await service.create(owner, { id: 'once', backend: 'dsh', threadId: 'thread', cwd: root, prompt: 'Synthetic once',
      rule: { kind: 'once', at: new Date(Math.ceil(Date.now() / 60_000) * 60_000 + 60_000).toISOString() } });
    await service.suspendForRestart();
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 120_000);
    await service.recover();
    expect((await service.list(owner))[0].error).toContain('deadline expired');
    expect(service.hasActiveSchedules()).toBe(false); expect(hosts).toHaveLength(1);
    expect((await executor.execute('Fresh foreground')).success).toBe(true);
  });

  it('reconstructs multiple jobs on one original session and never resurrects a clean cancellation', async () => {
    await create();
    await service.create(owner, { id: 'second', backend: 'dsh', threadId: 'thread', cwd: root, prompt: 'Second reminder',
      rule: { kind: 'cron', expression: '*/10 * * * *', timezone: 'UTC' } });
    await service.suspendForRestart(); await service.cancel(owner, 'job'); await service.recover();
    expect(hosts).toHaveLength(2); expect(hosts[1].rows.map(row => row.title)).toEqual(['second']);
    expect((await service.list(owner)).find(row => row.id === 'job')?.state).toBe('cancelled');
  });

  it('consumes clean proof before error-after-commit and never replays that crash snapshot', async () => {
    await create(); await service.destroy(); await executor.destroy();
    let committed: any;
    executor = makeExecutor(host => {
      host.createError = new Error('Synthetic error after commit');
      host.createCommitted = () => { committed = catalog(); };
    });
    service = makeService(); await service.initialize(); await service.recover();
    expect(committed.records[0]).toMatchObject({ state: 'creating' });
    expect(committed.records[0].recovery.handoff).toBeUndefined();
    expect(hosts[1].rows).toHaveLength(0); // Actual adapter reconciles its exact owned title and deletes the committed row.
    await executor.destroy(); await executor.waitForExit();
    fs.writeFileSync(path.join(root, 'catalog', SCHEDULE_CATALOG_FILE), JSON.stringify(committed));
    executor = makeExecutor(); service = makeService(); await service.initialize(); await service.recover();
    expect(hosts).toHaveLength(2); expect((await service.list(owner))[0].recovery?.status).toBe('blocked');
  });

});
