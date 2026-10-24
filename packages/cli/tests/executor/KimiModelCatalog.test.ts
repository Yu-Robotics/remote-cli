import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { latestKimiModelCatalog, refreshKimiModelCatalog } from '../../src/executor/kimi/KimiModelCatalog';

const refreshed = { code: 0, data: { changed: [{ provider_id: 'managed:kimi-code', provider_name: 'Kimi Code', added: 2, removed: 0 }], unchanged: [], failed: [] } };
const catalog = { code: 0, data: { items: [
  { model: 'kimi-code/k3.1-pro', display_name: 'K3.1 Pro', support_efforts: ['low', 'high', 'max'], default_effort: 'max' },
  { model: 'kimi-code/k3.1-pro-highspeed', display_name: 'K3.1 Pro Highspeed' },
] } };
let serial = 0;
function fixture() {
  const children: any[] = [];
  const spawnProcess = vi.fn(() => {
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 123;
    child.kill = vi.fn(() => { queueMicrotask(() => child.emit('close', 0)); return true; });
    children.push(child);
    queueMicrotask(() => child.stdout.emit('data', Buffer.from('Local: http://127.0.0.1:41234/#token=synthetic-token\n')));
    return child;
  }) as any;
  const fetchImpl = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('refresh_oauth') ? refreshed : catalog)));
  const command = `synthetic-catalog-${++serial}`;
  return { children, spawnProcess, fetchImpl, command, query: (cwd = '/project') => refreshKimiModelCatalog(command, cwd, { spawnProcess, fetchImpl: fetchImpl as any }) };
}
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('KimiModelCatalog', () => {
  it('refreshes OAuth before listing aliases using only fixed metadata endpoints', async () => {
    const f = fixture();
    expect(await f.query()).toMatchObject([{ id: 'kimi-code/k3.1-pro' }, { id: 'kimi-code/k3.1-pro-highspeed' }]);
    expect(f.fetchImpl.mock.calls.map(call => call[0])).toEqual([
      'http://127.0.0.1:41234/api/v1/providers:refresh_oauth', 'http://127.0.0.1:41234/api/v1/models',
    ]);
    expect((f.fetchImpl.mock.calls[0] as any)[1].method).toBe('POST');
    expect(f.children[0].kill).toHaveBeenCalledOnce();
    expect(latestKimiModelCatalog(f.command)).toMatchObject([{ id: 'kimi-code/k3.1-pro' }, { id: 'kimi-code/k3.1-pro-highspeed' }]);
  });

  it('coalesces command/home queries across directories and refreshes anew after completion', async () => {
    const f = fixture();
    const [a, b] = await Promise.all([f.query(), f.query('/other-project')]);
    expect(a).toEqual(b);
    expect(f.spawnProcess).toHaveBeenCalledOnce();
    await f.query();
    expect(f.spawnProcess).toHaveBeenCalledTimes(2);
    vi.stubEnv('KIMI_CODE_HOME', '/synthetic-other-home');
    await f.query();
    expect(f.spawnProcess).toHaveBeenCalledTimes(3);
  });

  it.each([
    { code: 1, data: refreshed.data },
    { data: refreshed.data },
    { code: 0, data: { changed: refreshed.data.changed, unchanged: [], failed: [{ provider: 'managed:kimi-code', reason: 'synthetic-private-detail' }] } },
    { code: 0, data: { changed: 'invalid', unchanged: [], failed: [] } },
    { code: 0, data: { changed: [{}], unchanged: [], failed: [] } },
  ])('rejects malformed or unsuccessful HTTP-200 refresh results and permits retry (%#)', async body => {
    const f = fixture();
    f.fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify(body)));
    const error = await f.query().then(() => null, error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain('synthetic-private-detail');
    expect(f.fetchImpl).toHaveBeenCalledOnce();
    expect(latestKimiModelCatalog(f.command)).toBeUndefined();
    await expect(f.query()).resolves.toHaveLength(2);
    expect(f.spawnProcess).toHaveBeenCalledTimes(2);
  });

  it('keeps configured models available when there is no OAuth provider to refresh', async () => {
    const f = fixture();
    f.fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ code: 0,
      data: { changed: [], unchanged: [], failed: [] } })));
    await expect(f.query()).resolves.toHaveLength(2);
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect(f.children[0].kill).toHaveBeenCalledOnce();
  });

  it.each([
    { code: 0, data: { items: [] } },
    { code: 0, data: { items: [{ model: 'bad\nidentifier' }] } },
    { code: 0, data: { items: [{ model: 'valid', support_efforts: 'invalid' }] } },
    { code: 1, data: catalog.data },
  ])('rejects unusable catalogs rather than silently falling back to stale models (%#)', async body => {
    const f = fixture();
    f.fetchImpl.mockImplementation(async url => new Response(JSON.stringify(url.endsWith('refresh_oauth') ? refreshed : body)));
    await expect(f.query()).rejects.toThrow('invalid model catalog');
    expect(f.children[0].kill).toHaveBeenCalledOnce();
  });
});
