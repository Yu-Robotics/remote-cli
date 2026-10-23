import { createHash } from 'crypto';

export const IMAGE_LIMITS = {
  bytes: 2 * 1024 * 1024,
  retainedBytes: 32 * 1024 * 1024,
  jobs: 32,
  uploads: 2,
  images: 8,
  attempts: 32,
  waitMs: 15_000,
  drainMs: 30_000,
} as const;

export interface ImageReply {
  closed: boolean;
  cancelled: boolean;
  deadline?: number;
  attempts: number;
  hashes: Set<string>;
  jobs: Set<ImageJob>;
  tail?: Promise<void>;
  failed: boolean;
}

interface ImageCallbacks {
  current: () => boolean;
  upload: (data: string, mimeType: string) => Promise<string | null>;
  publish: (key: string) => Promise<void>;
  failure: () => void;
}

interface ImageJob {
  reply: ImageReply;
  callbacks?: ImageCallbacks;
  data?: string;
  mimeType: string;
  bytes: number;
  active: boolean;
  live: boolean;
  ready: boolean;
  released: boolean;
  expires: number;
  timer?: ReturnType<typeof setTimeout>;
  resolve: () => void;
}

/** Reject noncanonical encodings without first allocating a decoded buffer. */
function decodedLength(data: unknown): number | undefined {
  if (typeof data !== 'string' || !data.length || data.length > 4 * Math.ceil(IMAGE_LIMITS.bytes / 3)
    || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const last = alphabet.indexOf(data[data.length - padding - 1]);
  if ((padding === 2 && (last & 15) !== 0) || (padding === 1 && (last & 3) !== 0)) return;
  const bytes = data.length / 4 * 3 - padding;
  if (bytes > 0 && bytes <= IMAGE_LIMITS.bytes) return bytes;
}

/** Logical cancellation never frees resources owned by an unsettled SDK upload. */
export class ImageLifecycle {
  private readonly waiting = new Set<ImageJob>();
  private active = 0;
  private retainedBytes = 0;
  private retainedJobs = 0;

  createReply(): ImageReply {
    return { closed: false, cancelled: false, attempts: 0, hashes: new Set(), jobs: new Set(), failed: false };
  }

  offer(reply: ImageReply, image: unknown, previous: Promise<void> | undefined, callbacks: ImageCallbacks): Promise<void> {
    if (reply.closed || reply.cancelled) return Promise.resolve();
    const fail = () => { reply.failed = true; callbacks.failure(); };
    if (++reply.attempts > IMAGE_LIMITS.attempts) { fail(); return Promise.resolve(); }
    const candidate = image as { type?: unknown; data?: unknown; mimeType?: unknown } | undefined;
    const bytes = decodedLength(candidate?.data);
    if (candidate?.type !== 'image' || bytes === undefined || typeof candidate.mimeType !== 'string'
      || !/^image\/(?:png|jpeg|gif|webp|bmp|tiff|x-icon)$/.test(candidate.mimeType)) {
      fail(); return Promise.resolve();
    }
    const data = candidate.data as string;
    // Charge worst-case UTF-16 storage plus the transient decoded bytes. The
    // reservation is global and precedes both decoding and asynchronous queueing.
    const reservation = data.length * 2 + bytes;
    if (this.retainedJobs >= IMAGE_LIMITS.jobs || this.retainedBytes + reservation > IMAGE_LIMITS.retainedBytes) {
      fail(); return Promise.resolve();
    }
    this.retainedBytes += reservation;
    this.retainedJobs++;
    const hash = createHash('sha256').update(Buffer.from(data, 'base64')).digest('hex');
    if (reply.hashes.has(hash) || reply.hashes.size >= IMAGE_LIMITS.images) {
      this.retainedBytes -= reservation;
      this.retainedJobs--;
      if (!reply.hashes.has(hash)) fail();
      return Promise.resolve();
    }
    reply.hashes.add(hash);
    let resolve!: () => void;
    const done = new Promise<void>(complete => { resolve = complete; });
    const job: ImageJob = { reply, callbacks, data, mimeType: candidate.mimeType, bytes: reservation,
      active: false, live: true, ready: false, released: false, expires: Date.now() + IMAGE_LIMITS.waitMs, resolve };
    reply.jobs.add(job);
    this.waiting.add(job);
    this.arm(job);
    const prefix = reply.tail;
    reply.tail = done;
    // Capture the accepted prefix before replacing tail; never await ourselves.
    const ready = () => { if (job.live) { job.ready = true; this.pump(); } };
    if (previous || prefix) void Promise.all([previous, prefix]).then(ready, () => this.finish(job, true));
    else ready();
    void done.then(() => { if (reply.tail === done) reply.tail = undefined; });
    return done;
  }

  close(reply: ImageReply, receivedAt = Date.now()): void {
    if (reply.closed) return;
    reply.closed = true;
    reply.deadline = receivedAt + IMAGE_LIMITS.drainMs;
    for (const job of reply.jobs) this.arm(job);
  }

  cancel(reply: ImageReply): void {
    reply.closed = true;
    reply.cancelled = true;
    for (const job of [...reply.jobs]) this.finish(job, false);
  }

  private arm(job: ImageJob): void {
    clearTimeout(job.timer);
    const deadline = Math.min(job.expires, job.reply.deadline ?? Infinity);
    job.timer = setTimeout(() => this.finish(job, true), Math.max(0, deadline - Date.now()));
    job.timer.unref?.();
  }

  private current(job: ImageJob): boolean {
    return job.live && !job.reply.cancelled && Date.now() < Math.min(job.expires, job.reply.deadline ?? Infinity)
      && job.callbacks?.current() === true;
  }

  private finish(job: ImageJob, failed: boolean): void {
    if (!job.live) return;
    job.live = false;
    clearTimeout(job.timer);
    this.waiting.delete(job);
    job.reply.jobs.delete(job);
    if (failed && !job.reply.cancelled) {
      job.reply.failed = true;
      job.callbacks?.failure();
    }
    job.callbacks = undefined;
    job.data = undefined;
    if (!job.active) this.release(job);
    job.resolve();
  }

  private release(job: ImageJob): void {
    if (job.released) return;
    job.released = true;
    this.retainedBytes -= job.bytes;
    this.retainedJobs--;
  }

  private pump(): void {
    for (const job of this.waiting) {
      if (this.active >= IMAGE_LIMITS.uploads) break;
      if (!job.ready) continue;
      if (!this.current(job)) { this.finish(job, false); continue; }
      this.waiting.delete(job);
      job.active = true;
      this.active++;
      const callbacks = job.callbacks!;
      // Keep the real permit and reservation through actual upload settlement,
      // even if the logical job expires or the connection is replaced meanwhile.
      let upload: Promise<string | null>;
      try { upload = callbacks.upload(job.data!, job.mimeType); }
      catch { upload = Promise.resolve(null); }
      void upload.catch(() => null).then(async key => {
        this.active--;
        this.release(job);
        job.data = undefined;
        this.pump();
        if (!this.current(job)) { this.finish(job, false); return; }
        if (!key) { this.finish(job, true); return; }
        try { await callbacks.publish(key); this.finish(job, false); }
        catch { this.finish(job, true); }
      });
    }
  }
}
