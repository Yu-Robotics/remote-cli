import { describe, expect, it, vi } from 'vitest';
import { checkFilesInBatches } from '../../src/delegation/BoundedFileChecks';

describe('bounded filesystem checks', () => {
  it('checks every item with at most eight active operations', async () => {
    let active = 0;
    let maximum = 0;
    const checked: number[] = [];
    await checkFilesInBatches(Array.from({ length: 25 }, (_, index) => index), async value => {
      maximum = Math.max(maximum, ++active);
      await Promise.resolve();
      checked.push(value);
      active--;
    });
    expect(maximum).toBe(8);
    expect(active).toBe(0);
    expect(checked.sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, index) => index));
  });

  it('drains all started checks before rejecting and never starts the next batch', async () => {
    const failure = new Error('Synthetic verification failure');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered: number[] = [];
    const completed: number[] = [];
    let settled = false;
    const checking = checkFilesInBatches(Array.from({ length: 16 }, (_, index) => index), async value => {
      entered.push(value);
      if (value === 0) throw failure;
      await gate;
      completed.push(value);
    }).finally(() => { settled = true; });
    const rejection = expect(checking).rejects.toBe(failure);
    try {
      await vi.waitFor(() => expect(entered).toHaveLength(8));
      expect(settled).toBe(false);
      expect(completed).toEqual([]);
    } finally { release(); }
    await rejection;
    expect(completed).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(entered).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('handles synchronous throws and reports the first failing input after draining', async () => {
    const first = new Error('First synthetic failure');
    const second = new Error('Second synthetic failure');
    const checked: number[] = [];
    await expect(checkFilesInBatches([0, 1, 2], value => {
      checked.push(value);
      if (value === 0) throw first;
      if (value === 1) throw second;
      return Promise.resolve();
    })).rejects.toBe(first);
    expect(checked).toEqual([0, 1, 2]);
  });

  it('does not call the checker for an empty inventory', async () => {
    const check = vi.fn();
    await checkFilesInBatches([], check);
    expect(check).not.toHaveBeenCalled();
  });
});
