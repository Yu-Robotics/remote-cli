import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock, MockInstance } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

vi.mock('../../src/config/ConfigManager', () => ({ ConfigManager: { initialize: vi.fn() } }));
vi.mock('../../src/storage/JsonStore', () => ({ JsonStore: vi.fn() }));
vi.mock('../../src/server', () => ({ RouterServer: vi.fn() }));

import { startCommand } from '../../src/commands/start';
import { ConfigManager } from '../../src/config/ConfigManager';
import { PidManager } from '../../src/utils/PidManager';
import { JsonStore } from '../../src/storage/JsonStore';
import { RouterServer } from '../../src/server';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const signals = ['SIGTERM', 'SIGINT'] as const;

describe('Router startup admission and lifecycle', () => {
  let directory: string;
  let pidFile: string;
  let config: { get: Mock<[string, string], string> };
  let store: { initialize: ReturnType<typeof vi.fn> };
  let server: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
  let exit: MockInstance<Parameters<typeof process.exit>, ReturnType<typeof process.exit>>;
  let previousSignals: Record<(typeof signals)[number], Function[]>;

  function signal(name: (typeof signals)[number]) {
    const added = process.listeners(name).filter(listener => !previousSignals[name].includes(listener));
    expect(added).toHaveLength(1);
    added[0](name);
  }

  async function expectExit(code: number) {
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(code);
    });
    for (const name of signals) expect(process.listeners(name)).toEqual(previousSignals[name]);
  }

  beforeEach(async () => {
    vi.resetAllMocks();
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'router-start-test-')));
    pidFile = path.join(directory, '.remote-cli-router', 'server.pid');
    vi.spyOn(os, 'homedir').mockReturnValue(directory);
    config = { get: vi.fn((_section: string, key: string): string => key === 'appId' ? 'synthetic-app' : 'synthetic-placeholder') };
    vi.mocked(ConfigManager.initialize).mockResolvedValue(config as unknown as ConfigManager);
    store = { initialize: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(JsonStore).mockImplementation(() => store as unknown as JsonStore);
    server = { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(RouterServer).mockImplementation(() => server as unknown as RouterServer);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    previousSignals = { SIGTERM: process.listeners('SIGTERM'), SIGINT: process.listeners('SIGINT') };
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const name of signals) {
      for (const listener of process.listeners(name)) {
        if (!previousSignals[name].includes(listener)) process.off(name, listener);
      }
    }
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('recovers a persisted self-PID while ordinary stop/status probes still report the current process', async () => {
    const manager = new PidManager();
    await manager.writePid(process.pid);
    expect(await manager.getRunningPid()).toBe(process.pid);
    expect(manager.isProcessRunning(process.pid)).toBe(true);
    await startCommand();
    expect(exit).not.toHaveBeenCalled();
    expect(ConfigManager.initialize).toHaveBeenCalledTimes(1);
    expect(store.initialize).toHaveBeenCalledTimes(1);
    expect(server.start).toHaveBeenCalledTimes(1);
    const owned = await fs.readFile(pidFile, 'utf8');
    expect(owned.split('\n')[0]).toBe(String(process.pid));
    expect(owned.split('\n')[1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(await manager.getRunningPid()).toBe(process.pid);
    signal('SIGTERM'); await expectExit(0);
    expect(await manager.readPid()).toBeNull();
  });

  it('refuses a different live PID without writing or deleting its record', async () => {
    const manager = new PidManager();
    const otherPid = process.pid + 1;
    await manager.writePid(otherPid);
    vi.spyOn(PidManager.prototype, 'isProcessRunning').mockReturnValue(true);
    await startCommand();
    await expectExit(1);
    expect(ConfigManager.initialize).not.toHaveBeenCalled();
    expect(RouterServer).not.toHaveBeenCalled();
    expect(await fs.readFile(pidFile, 'utf8')).toBe(String(otherPid));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`PID: ${otherPid}`));
  });

  it.each(signals)('stops before owned PID cleanup and exits once on %s', async name => {
    await startCommand();
    const stopping = deferred<void>(); server.stop.mockReturnValue(stopping.promise);
    const cleanup = vi.spyOn(PidManager.prototype, 'removeOwnedPid');
    signal(name);
    await vi.waitFor(() => expect(server.stop).toHaveBeenCalledTimes(1));
    expect(cleanup).not.toHaveBeenCalled(); expect(exit).not.toHaveBeenCalled();
    expect(await fs.readFile(pidFile, 'utf8')).toContain(String(process.pid));
    stopping.resolve(); await expectExit(0);
    expect(cleanup).toHaveBeenCalledTimes(1);
    await expect(fs.stat(pidFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining(`Received ${name}`));
  });

  it.each(['appId', 'appSecret'])('does not claim a PID or initialize storage when %s is missing', async missing => {
    config.get.mockImplementation((_section, key) => key === missing ? '' : 'synthetic-placeholder');
    await startCommand(); await expectExit(1);
    expect(JsonStore).not.toHaveBeenCalled(); expect(RouterServer).not.toHaveBeenCalled();
    await expect(fs.stat(pidFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Missing required configuration'));
  });

  it.each(['pid-probe', 'configuration', 'pid-write', 'store-construction', 'store-initialization', 'server-construction', 'server-start'])(
    'cleans only owned resources after a %s startup failure', async stage => {
      const error = new Error('Synthetic startup failure');
      const cleanup = vi.spyOn(PidManager.prototype, 'removeOwnedPid');
      if (stage === 'pid-probe') vi.spyOn(PidManager.prototype, 'getRunningPid').mockRejectedValue(error);
      if (stage === 'configuration') vi.mocked(ConfigManager.initialize).mockRejectedValue(error);
      if (stage === 'pid-write') {
        const write = PidManager.prototype.writeOwnedPid;
        vi.spyOn(PidManager.prototype, 'writeOwnedPid').mockImplementation(async function (this: PidManager, pid) {
          await write.call(this, pid); throw error;
        });
      }
      if (stage === 'store-construction') vi.mocked(JsonStore).mockImplementation(() => { throw error; });
      if (stage === 'store-initialization') store.initialize.mockRejectedValue(error);
      if (stage === 'server-construction') vi.mocked(RouterServer).mockImplementation(() => { throw error; });
      if (stage === 'server-start') server.start.mockRejectedValue(error);
      await startCommand(); await expectExit(1);
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(server.stop).toHaveBeenCalledTimes(stage === 'server-start' ? 1 : 0);
      await expect(fs.stat(pidFile)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(console.error).toHaveBeenCalledWith('Failed to start router server:', error.message);
    },
  );

  it.each(['pid-probe', 'configuration', 'pid-write', 'store-construction', 'store-initialization', 'server-construction', 'server-start'])(
    'observes SIGTERM during %s and never enters a later startup stage', async stage => {
      const entered = deferred<void>(); const pending = deferred<void>();
      if (stage === 'pid-probe') vi.spyOn(PidManager.prototype, 'getRunningPid').mockImplementation(async () => {
        entered.resolve(); await pending.promise; return null;
      });
      if (stage === 'configuration') vi.mocked(ConfigManager.initialize).mockImplementation(async () => {
        entered.resolve(); await pending.promise; return config as unknown as ConfigManager;
      });
      if (stage === 'pid-write') {
        const write = PidManager.prototype.writeOwnedPid;
        vi.spyOn(PidManager.prototype, 'writeOwnedPid').mockImplementation(async function (this: PidManager, pid) {
          await write.call(this, pid); entered.resolve(); await pending.promise;
        });
      }
      if (stage === 'store-construction') vi.mocked(JsonStore).mockImplementation(() => {
        signal('SIGTERM'); entered.resolve(); return store as unknown as JsonStore;
      });
      if (stage === 'store-initialization') store.initialize.mockImplementation(async () => {
        entered.resolve(); await pending.promise;
      });
      if (stage === 'server-construction') vi.mocked(RouterServer).mockImplementation(() => {
        signal('SIGTERM'); entered.resolve(); return server as unknown as RouterServer;
      });
      if (stage === 'server-start') server.start.mockImplementation(async () => {
        entered.resolve(); await pending.promise;
      });
      const starting = startCommand(); await entered.promise;
      if (!['store-construction', 'server-construction'].includes(stage)) signal('SIGTERM');
      pending.resolve(); await starting; await expectExit(0);
      expect(server.start).toHaveBeenCalledTimes(stage === 'server-start' ? 1 : 0);
      expect(server.stop).toHaveBeenCalledTimes(['server-start', 'server-construction'].includes(stage) ? 1 : 0);
      if (stage === 'pid-probe') expect(ConfigManager.initialize).not.toHaveBeenCalled();
      if (['pid-probe', 'configuration', 'pid-write'].includes(stage)) expect(JsonStore).not.toHaveBeenCalled();
      if (stage === 'store-construction') expect(store.initialize).not.toHaveBeenCalled();
      if (['store-construction', 'store-initialization'].includes(stage)) expect(RouterServer).not.toHaveBeenCalled();
      await expect(fs.stat(pidFile)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('preserves another startup token when shutdown cleanup runs', async () => {
    await startCommand();
    const replacement = new PidManager(); await replacement.writeOwnedPid(process.pid);
    const content = await fs.readFile(pidFile, 'utf8');
    signal('SIGTERM'); await expectExit(0);
    expect(await fs.readFile(pidFile, 'utf8')).toBe(content);
    await replacement.removeOwnedPid();
  });

  it('cleans the owned PID even if a partially started server fails to stop', async () => {
    server.start.mockRejectedValue(new Error('Synthetic start failure'));
    server.stop.mockRejectedValue(new Error('Synthetic stop failure'));
    await startCommand(); await expectExit(1);
    expect(server.stop).toHaveBeenCalledTimes(1);
    await expect(fs.stat(pidFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(console.error).toHaveBeenCalledWith('Error during shutdown:', expect.any(Error));
  });

  it('handles PID cleanup failure without an unhandled rejection or a repeated exit', async () => {
    await startCommand();
    vi.spyOn(PidManager.prototype, 'removeOwnedPid').mockRejectedValue(new Error('Synthetic cleanup failure'));
    signal('SIGTERM'); await expectExit(1);
    expect(console.error).toHaveBeenCalledWith('Error removing Router PID file:', expect.any(Error));
    expect(await fs.readFile(pidFile, 'utf8')).toContain(String(process.pid));
  });

  it('attempts owned cleanup after the shutdown deadline and can recover again if that cleanup fails', async () => {
    await startCommand();
    vi.useFakeTimers();
    const stopping = deferred<void>(); server.stop.mockReturnValueOnce(stopping.promise);
    const cleanup = vi.spyOn(PidManager.prototype, 'removeOwnedPid').mockRejectedValueOnce(new Error('Synthetic cleanup failure'));
    signal('SIGTERM'); await vi.advanceTimersByTimeAsync(5000);
    await expectExit(1); expect(cleanup).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    stopping.resolve(); await Promise.resolve();
    await startCommand();
    signal('SIGTERM'); await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(2));
    expect(exit.mock.calls.map(call => call[0])).toEqual([1, 0]);
    expect(cleanup).toHaveBeenCalledTimes(2);
    await expect(fs.stat(pidFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['resolve', 'reject'] as const)('bounds a hung startup and ignores its late %s', async outcome => {
    vi.useFakeTimers();
    const pending = deferred<ConfigManager>();
    vi.mocked(ConfigManager.initialize).mockReturnValue(pending.promise);
    const cleanup = vi.spyOn(PidManager.prototype, 'removeOwnedPid').mockResolvedValue(undefined);
    const starting = startCommand();
    await vi.waitFor(() => expect(ConfigManager.initialize).toHaveBeenCalledTimes(1));
    signal('SIGTERM'); await vi.advanceTimersByTimeAsync(5000);
    await starting; await expectExit(1);
    if (outcome === 'resolve') pending.resolve(config as unknown as ConfigManager);
    else pending.reject(new Error('Synthetic late startup failure'));
    await pending.promise.catch(() => {}); await Promise.resolve();
    expect(exit).toHaveBeenCalledTimes(1); expect(cleanup).toHaveBeenCalledTimes(1);
    expect(JsonStore).not.toHaveBeenCalled(); expect(RouterServer).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)('does not stop or clean again after a timed-out server start has a late %s', async outcome => {
    const pending = deferred<void>(); const entered = deferred<void>();
    server.start.mockImplementation(() => { entered.resolve(); return pending.promise; });
    const starting = startCommand(); await entered.promise;
    vi.useFakeTimers();
    const cleanup = vi.spyOn(PidManager.prototype, 'removeOwnedPid').mockResolvedValue(undefined);
    signal('SIGTERM'); await vi.advanceTimersByTimeAsync(5000);
    await starting; await expectExit(1);
    if (outcome === 'resolve') pending.resolve(); else pending.reject(new Error('Synthetic late start failure'));
    await pending.promise.catch(() => {}); await Promise.resolve();
    expect(server.stop).not.toHaveBeenCalled(); expect(cleanup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it.each(['resolve', 'reject'] as const)('bounds a hung owned cleanup and ignores its late %s', async outcome => {
    await startCommand(); vi.useFakeTimers();
    const pending = deferred<void>();
    const cleanup = vi.spyOn(PidManager.prototype, 'removeOwnedPid').mockReturnValue(pending.promise);
    signal('SIGTERM'); await vi.advanceTimersByTimeAsync(1000); await expectExit(1);
    if (outcome === 'resolve') pending.resolve(); else pending.reject(new Error('Synthetic late cleanup failure'));
    await pending.promise.catch(() => {}); await Promise.resolve();
    expect(cleanup).toHaveBeenCalledTimes(1); expect(exit).toHaveBeenCalledTimes(1);
  });

  it('uses a second signal to attempt cleanup immediately and ignores a late stop rejection', async () => {
    await startCommand();
    const stopping = deferred<void>(); server.stop.mockReturnValue(stopping.promise);
    const cleanup = vi.spyOn(PidManager.prototype, 'removeOwnedPid');
    signal('SIGTERM'); await vi.waitFor(() => expect(server.stop).toHaveBeenCalledTimes(1));
    signal('SIGINT'); await expectExit(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    const replacement = new PidManager(); await replacement.writeOwnedPid(process.pid);
    const content = await fs.readFile(pidFile, 'utf8');
    stopping.reject(new Error('Synthetic late stop failure'));
    await stopping.promise.catch(() => {}); await Promise.resolve();
    expect(exit).toHaveBeenCalledTimes(1); expect(cleanup).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(pidFile, 'utf8')).toBe(content);
    await replacement.removeOwnedPid();
  });
});
