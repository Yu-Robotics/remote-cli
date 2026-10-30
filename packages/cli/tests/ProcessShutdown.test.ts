import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProcessShutdown } from '../src/utils/ProcessShutdown';

describe('process shutdown', () => {
  let host: EventEmitter & { exit: ReturnType<typeof vi.fn> };
  let shutdown: ProcessShutdown;
  let report: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    host = Object.assign(new EventEmitter(), { exit: vi.fn() });
    report = vi.fn();
    shutdown = new ProcessShutdown(host, report);
  });
  afterEach(() => { shutdown.dispose(); });

  it.each(['SIGTERM', 'SIGINT'])('waits for cleanup before exiting after %s', async signal => {
    let finish!: () => void;
    const cleanup = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    expect(shutdown.attach(cleanup)).toBe(true);
    host.emit(signal);
    const stopping = shutdown.stop();
    await Promise.resolve();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(host.exit).not.toHaveBeenCalled();
    host.emit('SIGINT'); host.emit('SIGTERM');
    finish(); await stopping;
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(host.exit).toHaveBeenCalledTimes(1);
    expect(host.exit).toHaveBeenCalledWith(0);
    expect(host.listenerCount('SIGTERM') + host.listenerCount('SIGINT')).toBe(0);
  });

  it('fences startup after a signal arrives before resources are registered', async () => {
    host.emit('SIGTERM');
    await Promise.resolve();
    expect(host.exit).not.toHaveBeenCalled();
    const cleanup = vi.fn(async () => {});
    expect(shutdown.attach(cleanup)).toBe(false);
    await shutdown.stop();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(host.exit).toHaveBeenCalledTimes(1);
    expect(host.exit).toHaveBeenCalledWith(0);
  });

  it('allows a failed startup without resources to settle a pending signal', async () => {
    host.emit('SIGTERM');
    shutdown.finishStartup();
    await shutdown.stop();
    expect(host.exit).toHaveBeenCalledTimes(1);
    expect(host.exit).toHaveBeenCalledWith(0);
  });

  it('reports uncertain cleanup and exits unsuccessfully without retrying or discarding state', async () => {
    const error = new Error('Native exit is unconfirmed; ownership remains held');
    const cleanup = vi.fn(async () => { throw error; });
    shutdown.attach(cleanup);
    host.emit('SIGTERM');
    await shutdown.stop();
    await shutdown.stop();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(error);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(host.exit).toHaveBeenCalledTimes(1);
    expect(host.exit).toHaveBeenCalledWith(1);
  });

  it('removes signal listeners when startup fails without receiving a signal', () => {
    shutdown.finishStartup(); shutdown.dispose();
    host.emit('SIGTERM'); host.emit('SIGINT');
    expect(host.exit).not.toHaveBeenCalled();
  });

  it('rejects replacement cleanup callbacks', () => {
    shutdown.attach(async () => {});
    expect(() => shutdown.attach(async () => {})).toThrow('already registered');
  });
});
