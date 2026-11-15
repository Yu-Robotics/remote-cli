import type { DelegationCloseoutIssue } from './DelegationManager';

export const ARTIFACT_CLOSEOUT_BACKOFF = { initialMs: 1_000, maxMs: 30_000 } as const;

/** Request-local pacing; only resolving an existing obligation resets the delay. */
export class ArtifactCloseoutContinuation {
  private previous = new Set<string>();
  private delayMs = 0;

  nextDelay(issues: readonly DelegationCloseoutIssue[]): number {
    const remaining = new Set(issues.map(issue => issue.taskId));
    const progressed = [...this.previous].some(id => !remaining.has(id));
    this.delayMs = !remaining.size || !this.previous.size || progressed ? 0
      : Math.min(this.delayMs ? this.delayMs * 2 : ARTIFACT_CLOSEOUT_BACKOFF.initialMs, ARTIFACT_CLOSEOUT_BACKOFF.maxMs);
    this.previous = remaining;
    return this.delayMs;
  }
}

/** Cancellation releases both the timer and listener before the caller settles. */
export function waitForArtifactCloseout(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      reject(new Error('Artifact closeout continuation was cancelled'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}
