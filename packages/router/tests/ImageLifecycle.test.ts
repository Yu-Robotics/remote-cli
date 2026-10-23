import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageLifecycle, IMAGE_LIMITS } from '../src/utils/ImageLifecycle';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const image = (data = 'aW1hZ2U=') => ({ type: 'image', data, mimeType: 'image/png' });
const callbacks = () => ({ current: () => true, upload: vi.fn(async () => 'key'),
  publish: vi.fn(async () => {}), failure: vi.fn() });

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('ImageLifecycle', () => {
  it.each(['Zh==', 'Zm9=', 'a W1hZ2U=', 'aW1hZ2U', '====', 'a'.repeat(4 * Math.ceil(IMAGE_LIMITS.bytes / 3) + 4)])(
    'rejects invalid or oversized encoding without decoding (case %#)', async data => {
      const pool = new ImageLifecycle(), cb = callbacks();
      const decode = vi.spyOn(Buffer, 'from');
      await pool.offer(pool.createReply(), image(data), undefined, cb);
      expect(decode.mock.calls.some(call => call[1] === 'base64')).toBe(false);
      expect(cb.upload).not.toHaveBeenCalled();
      expect(cb.failure).toHaveBeenCalledOnce();
    });

  it('enforces global retained bytes before decoding across different replies', async () => {
    const pool = new ImageLifecycle(), cb = callbacks(), blocked = deferred<void>();
    const data = Buffer.alloc(IMAGE_LIMITS.bytes, 7).toString('base64');
    const charge = data.length * 2 + IMAGE_LIMITS.bytes;
    const capacity = Math.floor(IMAGE_LIMITS.retainedBytes / charge);
    const decode = vi.spyOn(Buffer, 'from');
    const replies = Array.from({ length: capacity + 1 }, () => pool.createReply());
    const work = replies.map(reply => pool.offer(reply, image(data), blocked.promise, cb));
    expect(decode.mock.calls.filter(call => call[1] === 'base64')).toHaveLength(capacity);
    expect(cb.failure).toHaveBeenCalledOnce();
    expect((pool as any).retainedBytes).toBe(capacity * charge);
    replies.forEach(reply => pool.cancel(reply));
    await Promise.all(work);
    expect((pool as any).retainedBytes).toBe(0);
    expect((pool as any).waiting.size).toBe(0);
    blocked.resolve();
  });

  it('bounds queued work and removes timed-out waiters and their payloads', async () => {
    const pool = new ImageLifecycle(), cb = callbacks(), blocked = deferred<void>();
    const decode = vi.spyOn(Buffer, 'from');
    const work = Array.from({ length: IMAGE_LIMITS.jobs + 1 }, () => pool.offer(pool.createReply(), image(), blocked.promise, cb));
    expect(decode.mock.calls.filter(call => call[1] === 'base64')).toHaveLength(IMAGE_LIMITS.jobs);
    const jobs = [...(pool as any).waiting];
    await vi.advanceTimersByTimeAsync(IMAGE_LIMITS.waitMs);
    await Promise.all(work);
    expect((pool as any).waiting.size).toBe(0);
    expect((pool as any).retainedBytes).toBe(0);
    expect(jobs.every(job => job.data === undefined && job.callbacks === undefined)).toBe(true);
    blocked.resolve();
    await Promise.resolve();
    expect(cb.upload).not.toHaveBeenCalled();
  });

  it('holds two real permits and reservations after logical timeout, without replaying late results', async () => {
    const pool = new ImageLifecycle(), cb = callbacks(), first = deferred<string>(), second = deferred<string>();
    cb.upload.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const one = pool.offer(pool.createReply(), image(), undefined, cb);
    const two = pool.offer(pool.createReply(), image(), undefined, cb);
    await vi.advanceTimersByTimeAsync(IMAGE_LIMITS.waitMs);
    await Promise.all([one, two]);
    expect((pool as any).active).toBe(2);
    expect((pool as any).retainedJobs).toBe(2);
    expect((pool as any).retainedBytes).toBeGreaterThan(0);
    const third = pool.offer(pool.createReply(), image(), undefined, cb);
    expect(cb.upload).toHaveBeenCalledTimes(2);
    first.resolve('late-first');
    await vi.advanceTimersByTimeAsync(0);
    await third;
    expect(cb.upload).toHaveBeenCalledTimes(3);
    expect(cb.publish).toHaveBeenCalledOnce();
    expect(cb.publish).toHaveBeenCalledWith('key');
    second.resolve('late-second');
    await vi.advanceTimersByTimeAsync(0);
    expect((pool as any).retainedJobs).toBe(0);
    expect((pool as any).retainedBytes).toBe(0);
    expect((pool as any).waiting.size).toBe(0);
  });

  it('consults a close deadline applied after admission, and captures a fixed drain prefix', async () => {
    const pool = new ImageLifecycle(), cb = callbacks(), upload = deferred<string>();
    cb.upload.mockReturnValue(upload.promise);
    const reply = pool.createReply();
    const work = pool.offer(reply, image(), undefined, cb);
    pool.close(reply, Date.now() - IMAGE_LIMITS.drainMs + 50);
    await vi.advanceTimersByTimeAsync(50);
    await work;
    expect(reply.tail).toBeUndefined();
    await pool.offer(reply, image('b3RoZXI='), undefined, cb);
    expect(cb.upload).toHaveBeenCalledOnce();
    upload.resolve('late');
    await vi.advanceTimersByTimeAsync(0);
    expect(cb.publish).not.toHaveBeenCalled();
  });

  it('contains synchronous and asynchronous upload errors without retries or leaked reservations', async () => {
    const pool = new ImageLifecycle(), cb = callbacks();
    cb.upload.mockImplementationOnce(() => { throw new Error('synthetic SDK error'); })
      .mockRejectedValueOnce(new Error('synthetic SDK error'));
    await pool.offer(pool.createReply(), image(), undefined, cb);
    await pool.offer(pool.createReply(), image(), undefined, cb);
    expect(cb.upload).toHaveBeenCalledTimes(2);
    expect(cb.failure).toHaveBeenCalledTimes(2);
    expect((pool as any).active).toBe(0);
    expect((pool as any).retainedBytes).toBe(0);
  });
});
