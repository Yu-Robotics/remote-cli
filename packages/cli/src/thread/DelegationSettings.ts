import type { Thread } from './types';

/** Missing preferences on existing threads inherit the enabled default. */
export function isDelegationEnabled(thread: Pick<Thread, 'delegation'> | undefined): boolean {
  return thread !== undefined && thread.delegation !== false;
}
