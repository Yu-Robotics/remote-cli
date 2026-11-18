import { expect, it, vi } from 'vitest';
import { apply, inject } from '../../../src/scheduling/dsh/NativeScheduleToolGuard';

it('denies direct native scheduling from the first tool invocation, regardless of managed registration', () => {
  const guard = vi.fn((_check: (execution: { name: string }) => string | undefined) => () => {});
  const provide = vi.fn();
  apply({ tools: { guard }, provide });
  expect(inject).toEqual(['tools']);
  const check = guard.mock.calls[0][0];
  for (const name of ['schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit', 'schedule_delete', 'schedule_future']) {
    expect(check({ name })).toContain('managed scheduling tools');
  }
  expect(check({ name: 'remote_cli_schedule_create' })).toBeUndefined();
  expect(check({ name: 'read_file' })).toBeUndefined();
  expect(provide).toHaveBeenCalledWith('remoteCliScheduleGuardReady', {});
  expect(guard.mock.invocationCallOrder[0]).toBeLessThan(provide.mock.invocationCallOrder[0]);
});
