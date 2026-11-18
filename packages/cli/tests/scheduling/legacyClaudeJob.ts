import { vi } from 'vitest';
import type { ClaudeSessionSchedules } from '../../src/scheduling/claude/ClaudeSessionSchedules';

/** Install an already-acknowledged legacy definition in a synthetic live host. */
export function legacyClaudeJob(adapter: ClaudeSessionSchedules, id: string, nativeId: string) {
  const events = vi.fn();
  const marker = '[remote-cli:11111111-1111-4111-8111-111111111111]';
  const prompt = marker + '\nSynthetic recurring work';
  const job = { id, marker, prompt, nativeId, recurring: true, cron: '* * * * *', current: () => true,
    uncertain: false, retired: false, cancelled: false, emit: events };
  adapter['jobs'].set(id, job);
  return { handle: adapter['handle'](job), prompt, events };
}
