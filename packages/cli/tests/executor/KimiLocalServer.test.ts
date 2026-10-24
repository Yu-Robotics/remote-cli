import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withKimiLocalServer } from '../../src/executor/kimi/KimiLocalServer';

let serial = 0;
function fixture(exitOn: 'SIGTERM' | 'SIGKILL' | 'never' = 'SIGTERM') {
  const child: any = new EventEmitter();
  child.pid = 123;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(signal => {
    if (signal === exitOn) queueMicrotask(() => child.emit('close', 0));
    return true;
  });
  const spawnProcess = vi.fn(() => child) as any;
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { items: [] } })));
  const deps = { spawnProcess, fetchImpl: fetchImpl as any, timeoutMs: 100, killGraceMs: 10 };
  const command = `synthetic-kimi-${++serial}`;
  const start = () => child.stdout.emit('data', Buffer.from('Local: http://127.0.0.1:41234/#token=synthetic-token\n'));
  const query = () => withKimiLocalServer(command, '/project', request => request('models'), deps);
  return { child, spawnProcess, fetchImpl, deps, command, start, query };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('KimiLocalServer', () => {
  it('binds loopback, disables automatic unscoped refresh and keeps authentication out of argv', async () => {
    const f = fixture();
    const result = f.query();
    f.start();
    await expect(result).resolves.toMatchObject({ code: 0 });
    expect(f.spawnProcess).toHaveBeenCalledWith(f.command,
      ['web', '--no-open', '--host', '127.0.0.1', '--port', '0', '--log-level', 'silent'],
      expect.objectContaining({ env: expect.objectContaining({
        KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START: 'false', KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS: '0',
      }) }));
    expect(JSON.stringify(f.spawnProcess.mock.calls)).not.toContain('synthetic-token');
    expect(f.fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:41234/api/v1/models', expect.objectContaining({
      method: 'GET', redirect: 'error', headers: expect.objectContaining({ Authorization: 'Bearer synthetic-token' }),
    }));
    expect(f.child.kill).toHaveBeenCalledOnce();
    expect(f.child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('waits for confirmed close, escalates to SIGKILL, and never returns before exit', async () => {
    vi.useFakeTimers();
    const f = fixture('SIGKILL');
    let settled = false;
    const result = f.query().then(value => { settled = true; return value; });
    f.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(f.child.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(10);
    await result;
    expect(f.child.kill.mock.calls.map(call => call[0])).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('blocks repeated spawning after an unconfirmed exit, until the original child closes', async () => {
    vi.useFakeTimers();
    const f = fixture('never');
    const rejected = expect(f.query()).rejects.toThrow('exit could not be confirmed');
    f.start();
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    await expect(f.query()).rejects.toThrow('has not exited');
    expect(f.spawnProcess).toHaveBeenCalledOnce();
    f.child.emit('close', 0);
    await Promise.resolve();
    f.child.kill.mockImplementation(() => { queueMicrotask(() => f.child.emit('close', 0)); return true; });
    const retry = f.query();
    f.start();
    await retry;
    expect(f.spawnProcess).toHaveBeenCalledTimes(2);
  });

  it('aborts a timed-out request and discards late settlement without issuing another request', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let resolve!: (response: Response) => void;
    f.fetchImpl.mockImplementation(() => new Promise(done => { resolve = done; }));
    const rejected = expect(withKimiLocalServer(f.command, '/project', async request => {
      await request('refreshOAuth');
      return request('models');
    }, f.deps)).rejects.toThrow('timed out');
    f.start();
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect((f.fetchImpl.mock.calls[0] as any)[1].signal.aborted).toBe(true);
    resolve(new Response('{}'));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fetchImpl).toHaveBeenCalledOnce();
    expect(f.child.kill).toHaveBeenCalledOnce();
  });

  it('fits the settings deadline with default request and SIGKILL cleanup budgets', async () => {
    vi.useFakeTimers();
    const f = fixture('SIGKILL');
    f.fetchImpl.mockImplementation(() => new Promise(() => {}));
    let settled = false;
    const query = withKimiLocalServer(f.command, '/project', request => request('models'), {
      spawnProcess: f.spawnProcess, fetchImpl: f.fetchImpl as any,
    }).finally(() => { settled = true; });
    const rejected = expect(query).rejects.toThrow('timed out');
    f.start();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(501);
    await rejected;
    expect(settled).toBe(true);
    expect(f.child.kill.mock.calls.map(call => call[0])).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it.each(['throw', 'error'])('contains spawn %s without leaking the command or native error', async kind => {
    const f = fixture();
    if (kind === 'throw') f.spawnProcess.mockImplementation(() => { throw new Error('synthetic-private-detail'); });
    if (kind === 'error') f.child.pid = undefined;
    const rejected = f.query().then(() => null, error => error);
    if (kind === 'error') f.child.emit('error', new Error('synthetic-private-detail'));
    const error = await rejected;
    expect(error.message).toContain('Upgrade Kimi');
    expect(error.message).not.toContain('synthetic-private-detail');
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['http://example.com:41234', 'http://127.0.0.1:65536'])('never sends credentials to an invalid announced origin (%s)', async origin => {
    vi.useFakeTimers();
    const f = fixture();
    const rejected = expect(f.query()).rejects.toThrow('timed out');
    f.child.stdout.emit('data', Buffer.from(`Local: ${origin}/#token=synthetic-token\n`));
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it('waits for a complete announcement and bounds both stdout and stderr', async () => {
    const f = fixture();
    const rejected = expect(f.query()).rejects.toThrow('output exceeded');
    f.child.stdout.emit('data', Buffer.from('Local: http://127.0.0.1:41234/#token=partial'));
    await Promise.resolve();
    expect(f.fetchImpl).not.toHaveBeenCalled();
    f.child.stderr.emit('data', Buffer.alloc(64 * 1024 + 1));
    await rejected;
    expect(f.child.kill).toHaveBeenCalledOnce();
  });

  it.each(['declared', 'streamed', 'json', 'redirect', 'unsupported', 'network'])('contains %s response failures and always closes its child', async kind => {
    const f = fixture();
    if (kind === 'declared') f.fetchImpl.mockResolvedValue(new Response('{}', { headers: { 'content-length': String(1024 * 1024 + 1) } }));
    if (kind === 'streamed') f.fetchImpl.mockResolvedValue(new Response('x'.repeat(1024 * 1024 + 1)));
    if (kind === 'json') f.fetchImpl.mockResolvedValue(new Response('synthetic-private-detail'));
    if (kind === 'redirect') f.fetchImpl.mockResolvedValue(new Response('', { status: 302, headers: { location: 'https://example.com' } }));
    if (kind === 'unsupported') f.fetchImpl.mockResolvedValue(new Response('', { status: 404 }));
    if (kind === 'network') f.fetchImpl.mockRejectedValue(new Error('synthetic-private-detail'));
    const rejected = f.query().then(() => { throw new Error('Expected failure'); }, error => error);
    f.start();
    const error = await rejected;
    expect(error.message).not.toContain('synthetic-private-detail');
    expect(error.message).not.toContain('synthetic-token');
    if (kind === 'unsupported') expect(error.message).toContain('Upgrade Kimi');
    expect(f.child.kill).toHaveBeenCalledOnce();
  });

  it('reports missing web support without exposing startup errors', async () => {
    const f = fixture();
    const rejected = expect(f.query()).rejects.toThrow('Upgrade Kimi');
    f.child.stderr.emit('data', Buffer.from('synthetic-private-error'));
    f.child.emit('close', 1);
    await rejected;
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
});
