import { afterEach, describe, expect, it, vi } from 'vitest';
import { apply, inject } from '../../src/executor/dsh/DshAccountUsagePlugin';
import { DSH_ACCOUNT_USAGE_PREFIX } from '../../src/executor/dsh/DshAccountUsage';

afterEach(() => vi.restoreAllMocks());

describe('DSH account query plugin', () => {
  it('calls only the native balance service and emits a sanitized projection', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const metadata = { version: '1.2.3', locale: 'en-US', timezoneOffsetSeconds: 0 };
    const getBalance = vi.fn().mockResolvedValue({
      status: 'ready', value: [{ currency: 'USD', balance: '2.00000001' }], bonusWallets: [],
      token: 'test-only-not-for-display', email: 'fixture@example.com',
    });
    expect(inject).toEqual(['deepseekAccount']);
    await apply({ deepseekAccount: { getBalance } }, metadata);
    expect(getBalance).toHaveBeenCalledTimes(1);
    expect(getBalance).toHaveBeenCalledWith(metadata);
    expect(write).toHaveBeenCalledWith(`${DSH_ACCOUNT_USAGE_PREFIX}${JSON.stringify({ output: '- Recharge balance: USD 2.00000001' })}\n`);
    expect(write.mock.calls[0][0]).not.toContain('test-only-not-for-display');
    expect(write.mock.calls[0][0]).not.toContain('fixture@example.com');
  });

  it.each([null, { status: 'failed' }, new Error('Authorization: test-only-secret')])
    ('emits only an unavailable result for failed account queries: %#', async value => {
      const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      const getBalance = vi.fn();
      if (value instanceof Error) getBalance.mockRejectedValue(value); else getBalance.mockResolvedValue(value);
      await apply({ deepseekAccount: { getBalance } }, { version: '1.2.3', locale: 'en-US', timezoneOffsetSeconds: 0 });
      expect(write).toHaveBeenCalledWith(`${DSH_ACCOUNT_USAGE_PREFIX}{"output":null}\n`);
    });
});
