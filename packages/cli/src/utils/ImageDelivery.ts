import { createHash } from 'crypto';
import type { ImageBlock } from '../types';
import { extractLocalImagePaths } from './LocalImageDetector';
import { validateImageBlock } from './ImageValidation';

export const IMAGE_DELIVERY_LIMITS = {
  images: 8,
  candidates: 32,
  pathLength: 4096,
  scanLength: 512 * 1024,
  readTimeoutMs: 15_000,
  drainTimeoutMs: 30_000,
} as const;

interface ReadJob {
  run: (() => Promise<void>) | undefined;
  started: boolean;
}

/** Bound queued read jobs; the filesystem reader separately owns its actual I/O permits. */
export class ImageReadPool {
  private active = 0;
  private readonly queue: ReadJob[] = [];

  constructor(private readonly concurrency = 4, private readonly queuedLimit = 32) {}

  submit(run: () => Promise<void>): (() => void) | undefined {
    if (this.active >= this.concurrency && this.queue.length >= this.queuedLimit) return undefined;
    const job: ReadJob = { run, started: false };
    this.queue.push(job);
    this.pump();
    return () => {
      if (job.started) return;
      const index = this.queue.indexOf(job);
      if (index >= 0) this.queue.splice(index, 1);
      job.run = undefined;
    };
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift()!;
      const run = job.run;
      job.run = undefined;
      if (!run) continue;
      job.started = true;
      this.active++;
      // Collector timeout does not release this job's permit. The filesystem
      // reader also retains its I/O permit if its own deadline wins first.
      void Promise.resolve().then(run).catch(() => {}).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }
}

const sharedReads = new ImageReadPool();

interface ImageDeliveryOptions {
  readFile: (filePath: string) => Promise<{ data: string; mimeType: string } | null>;
  publish: (image: ImageBlock) => void;
  notice: (text: string) => void;
  isCurrent: () => boolean;
  pool?: ImageReadPool;
  readTimeoutMs?: number;
  drainTimeoutMs?: number;
}

interface PendingRead {
  done: Promise<void>;
  stop: () => void;
}

/** One logical reply owns deduplication and accepted asynchronous image reads. */
export class ImageDelivery {
  private attempts = 0;
  private omitted = 0;
  private closed = false;
  private cancelled = false;
  private readonly hashes = new Set<string>();
  private readonly pending = new Set<PendingRead>();
  private readonly reasons = new Set<string>();
  private streamText = '';
  private streamEligible: () => boolean = () => true;
  private readonly streamPaths = new Set<string>();
  private scanLimited = false;

  constructor(private readonly options: ImageDeliveryOptions) {}

  offerImage(image: ImageBlock, eligible = () => true): void {
    if (!this.admit(eligible)) return;
    this.deliver(image, eligible);
  }

  offerText(text: unknown, eligible = () => true): void {
    if (typeof text !== 'string' || !text || !this.current(eligible) || this.closed) return;
    // Do not retain transcripts or allocate an unbounded candidate collection.
    const bounded = text.slice(0, IMAGE_DELIVERY_LIMITS.scanLength);
    if (text.length > bounded.length) this.scanLimited = true;
    const paths = extractLocalImagePaths(bounded);
    for (const filePath of paths) this.offerFile(filePath, eligible);
  }

  /** Keep a bounded window, preserving a path-sized overlap at chunk boundaries. */
  offerStream(chunk: string, eligible = () => true): void {
    if (!chunk || this.closed || !this.current(eligible)) return;
    if (!this.streamEligible()) this.resetStream();
    this.streamEligible = eligible;
    let offset = 0;
    while (offset < chunk.length) {
      const take = Math.min(IMAGE_DELIVERY_LIMITS.scanLength - this.streamText.length, chunk.length - offset);
      this.streamText += chunk.slice(offset, offset + take);
      offset += take;
      if (this.streamText.length === IMAGE_DELIVERY_LIMITS.scanLength) {
        this.scanStream();
        this.streamText = this.streamText.slice(-IMAGE_DELIVERY_LIMITS.pathLength);
      }
    }
  }

  flushStream(): void {
    this.scanStream();
    this.streamText = '';
  }

  resetStream(): void {
    this.streamText = '';
    this.streamPaths.clear();
  }

  private scanStream(): void {
    if (!this.current(this.streamEligible)) return;
    for (const filePath of extractLocalImagePaths(this.streamText)) {
      if (this.streamPaths.has(filePath)) continue;
      if (this.streamPaths.size < IMAGE_DELIVERY_LIMITS.candidates) this.streamPaths.add(filePath);
      this.offerFile(filePath, this.streamEligible);
    }
  }

  offerFile(filePath: string, eligible = () => true): void {
    if (!this.admit(eligible)) return;
    if (typeof filePath !== 'string' || !filePath || filePath.length > IMAGE_DELIVERY_LIMITS.pathLength) {
      this.omit('invalid image reference');
      return;
    }
    let live = true;
    let resolve!: () => void;
    let cancelQueued: (() => void) | undefined;
    const done = new Promise<void>(complete => { resolve = complete; });
    const settle = () => {
      if (!live) return;
      live = false;
      clearTimeout(timer);
      this.pending.delete(pending);
      resolve();
    };
    const pending: PendingRead = { done, stop: () => { cancelQueued?.(); settle(); } };
    const timer = setTimeout(() => {
      if (live && this.current(eligible)) this.omit('image read timed out');
      pending.stop();
    }, this.options.readTimeoutMs ?? IMAGE_DELIVERY_LIMITS.readTimeoutMs);
    this.pending.add(pending);
    cancelQueued = (this.options.pool ?? sharedReads).submit(async () => {
      try {
        if (!live || !this.current(eligible)) return;
        const image = await this.options.readFile(filePath);
        if (!live || !this.current(eligible)) return;
        if (image) this.deliver({ type: 'image', data: image.data, mimeType: image.mimeType }, eligible);
        else this.omit('image unavailable or outside the allowed directories');
      } catch {
        if (live && this.current(eligible)) this.omit('image could not be read');
      } finally { settle(); }
    });
    if (!cancelQueued) {
      this.omit('image read capacity reached');
      settle();
    }
  }

  /** Drain a fixed prefix without closing admission for a managed continuation. */
  async drain(): Promise<void> {
    const prefix = [...this.pending];
    if (!prefix.length) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(prefix.map(job => job.done)),
      new Promise<void>(resolve => {
        timer = setTimeout(() => {
          for (const job of prefix) {
            if (!this.pending.has(job)) continue;
            if (this.current()) this.omit('image delivery timed out');
            job.stop();
          }
          resolve();
        }, this.options.drainTimeoutMs ?? IMAGE_DELIVERY_LIMITS.drainTimeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  async finish(): Promise<void> {
    this.flushStream();
    this.closed = true;
    await this.drain();
    if (this.omitted && this.current()) {
      this.options.notice(`\nImages omitted: ${this.omitted} (${[...this.reasons].join('; ')}).\n`);
    }
    if (this.scanLimited && this.current()) {
      this.options.notice('\nImage link scanning reached its text limit; some references may not have been inspected.\n');
    }
    this.cancel();
  }

  cancel(): void {
    this.closed = true;
    this.cancelled = true;
    this.invalidatePending();
  }

  /** Discard disconnected work while allowing newly emitted images after recovery. */
  invalidatePending(): void {
    this.resetStream();
    for (const job of [...this.pending]) job.stop();
  }

  private current(eligible = () => true): boolean {
    return !this.cancelled && this.options.isCurrent() && eligible();
  }

  private admit(eligible: () => boolean): boolean {
    if (this.closed || !this.current(eligible)) return false;
    if (this.attempts >= IMAGE_DELIVERY_LIMITS.candidates) {
      this.omit('image candidate limit reached');
      return false;
    }
    this.attempts++;
    return true;
  }

  private deliver(candidate: ImageBlock, eligible: () => boolean): void {
    if (!this.current(eligible)) return;
    const image = validateImageBlock(candidate);
    if (!image) { this.omit('invalid or oversized image'); return; }
    const hash = createHash('sha256').update(Buffer.from(image.data, 'base64')).digest('hex');
    if (this.hashes.has(hash)) return;
    if (this.hashes.size >= IMAGE_DELIVERY_LIMITS.images) { this.omit('image count limit reached'); return; }
    try {
      this.options.publish(image);
      this.hashes.add(hash);
    } catch { this.omit('image could not be sent'); }
  }

  private omit(reason: string): void {
    this.omitted = Math.min(Number.MAX_SAFE_INTEGER, this.omitted + 1);
    this.reasons.add(reason);
  }
}
