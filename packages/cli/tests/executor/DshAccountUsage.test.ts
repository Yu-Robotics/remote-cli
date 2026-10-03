import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DSH_ACCOUNT_USAGE_PREFIX, formatDshAccountBalance, queryDshAccountUsage } from '../../src/executor/dsh/DshAccountUsage';

const snapshot = {
  status: 'ready',
  value: [{ currency: 'CNY', balance: '12.3400000000000001' }],
  bonusWallets: [{ currency: 'USD', balance: '0E-16' }],
};

function fixture(exitOnKill = true) {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.pid = 123;
  child.kill = vi.fn(() => {
    if (exitOnKill) queueMicrotask(() => child.emit('exit', 0));
    return true;
  });
  const spawnProcess = vi.fn(() => child);
  const run = (options = {}) => queryDshAccountUsage('custom-dsh', '/example/workspace', {
    spawnProcess: spawnProcess as any, timeoutMs: 100, killGraceMs: 10, ...options,
  });
  const reply = (output: unknown) => child.stdout.emit('data', Buffer.from(`${DSH_ACCOUNT_USAGE_PREFIX}${JSON.stringify({ output })}\n`));
  return { child, spawnProcess, run, reply, patch: () => spawnProcess.mock.calls[0][1][3] as string };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('DSH account balance', () => {
  it('preserves decimal precision and separates recharge and bonus currencies', () => {
    expect(formatDshAccountBalance(snapshot)).toBe('- Recharge balance: CNY 12.3400000000000001\n- Bonus balance: USD 0E-16');
    expect(formatDshAccountBalance({ ...snapshot, value: [{ currency: 'USD', balance: '0' }] })).toContain('USD 0');
  });

  it.each([
    null, { status: 'failed' }, { status: 'ready', value: [], bonusWallets: [] },
    { ...snapshot, value: [{ currency: 'USD', balance: 'NaN' }] },
    { ...snapshot, bonusWallets: [{ currency: 'USD', balance: 'Infinity' }] },
    { ...snapshot, value: [{ currency: '<at>', balance: '12' }] },
    { ...snapshot, value: [{ currency: 'USD', balance: '<at>12</at>' }] },
    { ...snapshot, value: [{ currency: 'USD', balance: 12 }] },
    { ...snapshot, value: Array(33).fill({ currency: 'USD', balance: '1' }) },
  ])('does not invent balances from an unavailable or malformed snapshot: %#', value => {
    expect(formatDshAccountBalance(value)).toBeNull();
  });

  it('uses an owned privacy overlay and terminates the query without starting an ACP turn', async () => {
    vi.stubEnv('DSH_TELEMETRY_DISABLED', '');
    const f = fixture(); const result = f.run();
    const [, args, options] = f.spawnProcess.mock.calls[0] as any;
    expect(args.slice(0, 3)).toEqual(['--profile', 'acp', '--patch']);
    expect(options).toMatchObject({ cwd: '/example/workspace', stdio: ['pipe', 'pipe', 'ignore'] });
    expect(options.env.DSH_TELEMETRY_DISABLED).toBe('1');
    expect(process.env.DSH_TELEMETRY_DISABLED).toBe('');
    const overlay = fs.readFileSync(f.patch(), 'utf8');
    expect(overlay).toContain('session-log-deepseek\n  config:\n    enabled: false');
    expect(overlay).toContain('session-telemetry-otel\n  config:\n    mode: DISABLED');
    expect(overlay).toContain('DshAccountUsagePlugin.js');
    expect(overlay).toContain('- insert:\n    - id: remote-cli-dsh-account-usage');
    expect(overlay).not.toContain('token:');
    f.child.stdout.emit('data', Buffer.from('Native startup diagnostics\n'));
    const line = `${DSH_ACCOUNT_USAGE_PREFIX}${JSON.stringify({ output: formatDshAccountBalance(snapshot) })}\n`;
    f.child.stdout.emit('data', Buffer.from(line.slice(0, 9)));
    f.child.stdout.emit('data', Buffer.from(line.slice(9)));
    expect(await result).toBe(formatDshAccountBalance(snapshot));
    expect(f.child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(fs.existsSync(path.dirname(f.patch()))).toBe(false);
  });

  it.each([null, 42, 'x'.repeat(4097)])('rejects an unavailable or oversized helper result: %#', async output => {
    const f = fixture(); const result = f.run(); f.reply(output);
    expect(await result).toBeNull();
    expect(fs.existsSync(path.dirname(f.patch()))).toBe(false);
  });

  it.each(['invalid JSON', 'excess output', 'exit', 'error', 'timeout'])('cleans up after %s', async reason => {
    const f = fixture(); const result = f.run({ timeoutMs: 15 });
    if (reason === 'invalid JSON') f.child.stdout.emit('data', Buffer.from(`${DSH_ACCOUNT_USAGE_PREFIX}{broken}\n`));
    if (reason === 'excess output') f.child.stdout.emit('data', Buffer.alloc(65 * 1024, 65));
    if (reason === 'exit') f.child.emit('exit', 1);
    if (reason === 'error') f.child.emit('error', new Error('provider detail must not be forwarded'));
    expect(await result).toBeNull();
    expect(fs.existsSync(path.dirname(f.patch()))).toBe(false);
  });

  it('escalates shutdown of its owned child without leaking the overlay', async () => {
    const f = fixture(false); const result = f.run(); f.reply('- Recharge balance: USD 1');
    expect(await result).toBe('- Recharge balance: USD 1');
    expect(f.child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    expect(fs.existsSync(path.dirname(f.patch()))).toBe(false);
  });

  it('cleans the overlay when spawning fails', async () => {
    const spawnProcess = vi.fn(() => { throw new Error('not installed'); });
    expect(await queryDshAccountUsage('missing-dsh', '/example/workspace', { spawnProcess: spawnProcess as any })).toBeNull();
    expect(fs.existsSync(path.dirname(spawnProcess.mock.calls[0][1][3]))).toBe(false);
  });

  it('fails closed without spawning if the query overlay cannot be written', async () => {
    const append = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => { throw new Error('read only'); });
    const spawnProcess = vi.fn();
    expect(await queryDshAccountUsage('dsh', '/example/workspace', { spawnProcess: spawnProcess as any })).toBeNull();
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(fs.existsSync(path.dirname(String(append.mock.calls[0][0])))).toBe(false);
  });
});
