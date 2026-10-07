import type { ActivityProgressInfo } from '../types';
import { normalizeActivity } from '../executor/Activity';

/** Display cadence, independent of execution liveness and task timeouts. */
export const ACTIVITY_PROGRESS_INTERVAL_MS = 2_500;

/** One bounded snapshot per request or worker, never a transcript or heartbeat. */
export class ActivityProgress {
  private pending?: ActivityProgressInfo;
  private reported?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(private readonly send: (activity: ActivityProgressInfo) => boolean) {}

  offer(value: unknown, immediate = false): void {
    if (this.stopped) return;
    const activity = normalizeActivity(value);
    if (!activity) return;
    this.pending = activity;
    if (immediate) {
      this.cancelTimer();
      this.flush();
    } else if (!this.timer && this.key(activity) !== this.reported) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flush();
      }, ACTIVITY_PROGRESS_INTERVAL_MS);
      this.timer.unref?.();
    }
  }

  flush(): void {
    if (this.stopped || !this.pending) return;
    const key = this.key(this.pending);
    if (key === this.reported) return;
    try {
      if (this.send({ ...this.pending })) this.reported = key;
    } catch {
      // A later event can retry delivery; never interrupt an executor callback.
    }
  }

  /** Drop delayed output at an execution boundary without ending the request. */
  clear(): void {
    this.cancelTimer();
    this.pending = undefined;
    this.reported = undefined;
  }

  dispose(): void {
    this.stopped = true;
    this.clear();
  }

  private cancelTimer(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private key(activity: ActivityProgressInfo): string {
    return `${activity.source}\n${activity.text}`;
  }
}
