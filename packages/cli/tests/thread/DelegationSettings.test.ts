import { describe, expect, it } from 'vitest';
import { isDelegationEnabled } from '../../src/thread/DelegationSettings';

describe('effective delegation preference', () => {
  it.each([
    [{}, true],
    [{ delegation: true }, true],
    [{ delegation: false }, false],
    [undefined, false],
  ] as const)('resolves %j to %s without modifying stored state', (thread, enabled) => {
    const before = JSON.stringify(thread);
    expect(isDelegationEnabled(thread)).toBe(enabled);
    expect(JSON.stringify(thread)).toBe(before);
  });
});
