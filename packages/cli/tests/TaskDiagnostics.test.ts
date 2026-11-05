import { afterEach, describe, expect, it, vi } from 'vitest';
import { taskCorrelation, taskEvent } from '../src/client/TaskDiagnostics';
import { taskCorrelation as routerCorrelation } from '../../router/src/utils/DeliveryDiagnostics';

describe('task diagnostic correlation', () => {
  afterEach(() => vi.restoreAllMocks());
  it('correlates the existing opaque ID across CLI and Router without wire fields', () => {
    const id = '1049b47b-afbf-4166-85e2-e5157deedb91';
    expect(taskCorrelation(id)).toMatch(/^[a-f0-9]{24}$/);
    expect(taskCorrelation(id)).toBe(routerCorrelation(id));
    expect(taskCorrelation(id)).not.toBe(taskCorrelation(`${id}x`));
    expect(taskCorrelation(undefined)).toBeUndefined();
    expect(taskCorrelation('x'.repeat(513))).toBeUndefined();
  });
  it('cannot let console failures interrupt transport', () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => { throw new Error('synthetic logger failure'); });
    expect(() => taskEvent('test_event')).not.toThrow();
    expect(log).toHaveBeenCalledWith('[TaskDiagnostics]', { event: 'test_event' });
  });
});
