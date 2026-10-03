import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryKimiAccountUsage } from '../../src/executor/kimi/KimiAccountUsage';
import { buildBackendPath } from '../../src/utils/BackendEnvironment';

afterEach(() => vi.unstubAllEnvs());

function fakeProcess() {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  return child;
}

describe('KimiAccountUsage', () => {
  it('queries the loopback Kimi endpoint and formats plan-specific fields', async () => {
    const composed = buildBackendPath({ platform: 'linux', homeDir: '/home/example', nodePath: '/opt/node/bin/node', pathValue: '/opt/legacy/bin' });
    vi.stubEnv('PATH', composed);
    const child = fakeProcess();
    const spawnProcess = vi.fn(() => child) as any;
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          kind: 'ok',
          quota: {
            usages: {
              limit5h: { usedRatio: 0.25, resetAt: '2030-01-01T00:00:00Z' },
              limit7d: { usedRatio: 0.6 },
              monthTotal: { usedRatio: 0.4 },
              monthCode: { usedRatio: 0.1 },
            },
            extraUsage: {
              balanceCents: 1234,
              monthlyChargeLimitEnabled: true,
              monthlyChargeLimitCents: 5000,
              monthlyUsedCents: 875,
              currency: 'USD',
            },
          },
        },
      }),
    }) as any;

    const result = queryKimiAccountUsage('kimi-custom', '/project', {
      spawnProcess,
      fetchImpl,
      timeoutMs: 5_000,
    });
    child.stdout.emit('data', Buffer.from('\u001b[32mLocal: http://127.0.0.1:41234/#token=secret-token\u001b[0m\n'));

    await expect(result).resolves.toEqual(expect.stringContaining('5-hour quota: 75% remaining'));
    const output = await result;
    expect(output).toContain('Weekly quota: 40% remaining');
    expect(output).toContain('Monthly quota: 60% remaining');
    expect(output).toContain('Monthly code usage: 10% used');
    expect(output).toContain('Extra usage balance: $12.34');
    expect(spawnProcess).toHaveBeenCalledWith(
      'kimi-custom',
      ['web', '--no-open', '--port', '0', '--log-level', 'silent'],
      expect.objectContaining({ cwd: '/project', env: expect.objectContaining({ PATH: composed }) })
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:41234/api/v1/oauth/usage?provider=managed%3Akimi-code',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer secret-token' }) })
    );
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('returns no account usage when Kimi reports an unavailable managed account', async () => {
    const child = fakeProcess();
    const result = queryKimiAccountUsage('kimi', '/project', {
      spawnProcess: vi.fn(() => child) as any,
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: { kind: 'error', message: 'No token' } }),
      }) as any,
      timeoutMs: 5_000,
    });
    child.stdout.emit('data', Buffer.from('Local: http://127.0.0.1:45678/#token=local-token\n'));

    await expect(result).resolves.toBeNull();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
