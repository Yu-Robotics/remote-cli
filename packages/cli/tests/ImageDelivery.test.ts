import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageDelivery, ImageReadPool, IMAGE_DELIVERY_LIMITS } from '../src/utils/ImageDelivery';
import type { ImageBlock } from '../src/types';
import { CodexImages } from '../src/executor/codex/CodexImages';

const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082', 'hex');
const image = (suffix = ''): ImageBlock => ({ type: 'image', data: Buffer.concat([png, Buffer.from(suffix)]).toString('base64'), mimeType: 'image/png' });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(overrides: Record<string, unknown> = {}) {
  const options = { readFile: vi.fn(async () => image()), publish: vi.fn(), notice: vi.fn(), isCurrent: () => true,
    pool: new ImageReadPool(), ...overrides };
  return { ...options, delivery: new ImageDelivery(options) };
}
afterEach(() => vi.useRealTimers());

describe('ImageDelivery', () => {
  it('deduplicates decoded content across inline, explicit file and Markdown paths', async () => {
    const f = fixture();
    f.delivery.offerImage(image());
    f.delivery.offerFile('./chart.png');
    f.delivery.offerText('![chart](./chart.png)');
    await f.delivery.finish();
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(f.notice).not.toHaveBeenCalled();
    const next = fixture();
    next.delivery.offerImage(image());
    await next.delivery.finish();
    expect(next.publish).toHaveBeenCalledTimes(1);
  });

  it('permits changed bytes at the same path and drains reads accepted before finish', async () => {
    const pending = deferred<ImageBlock>();
    const f = fixture({ readFile: vi.fn().mockResolvedValueOnce(image()).mockReturnValueOnce(pending.promise) });
    f.delivery.offerFile('chart.png');
    await f.delivery.drain();
    f.delivery.offerFile('chart.png');
    const finishing = f.delivery.finish();
    await Promise.resolve();
    expect(f.publish).toHaveBeenCalledTimes(1);
    pending.resolve(image('changed'));
    await finishing;
    expect(f.publish).toHaveBeenCalledTimes(2);
    f.delivery.offerImage(image('late'));
    expect(f.publish).toHaveBeenCalledTimes(2);
  });

  it('bounds candidates before decoding or opening and bounds delivered images', async () => {
    const f = fixture();
    for (let index = 0; index < 40; index++) f.delivery.offerImage(image(String(index)));
    await f.delivery.finish();
    expect(f.publish).toHaveBeenCalledTimes(8);
    expect(f.notice).toHaveBeenCalledWith(expect.stringContaining('Images omitted: 32'));
    expect(f.notice).toHaveBeenCalledWith(expect.stringContaining('candidate limit'));
    const invalid = fixture();
    for (let index = 0; index < 32; index++) invalid.delivery.offerImage({ type: 'image', data: 'invalid', mimeType: 'image/png' });
    invalid.delivery.offerFile('never-opened.png');
    await invalid.delivery.finish();
    expect(invalid.readFile).not.toHaveBeenCalled();
  });

  it('does not fetch remote URLs or scan non-string results', async () => {
    const f = fixture();
    f.delivery.offerText({ content: './private.png' });
    f.delivery.offerText('![remote](https://example.com/chart.png)');
    f.delivery.offerText('ordinary response');
    await f.delivery.finish();
    expect(f.readFile).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });

  it('scans long streamed output incrementally and preserves split image destinations', async () => {
    const f = fixture();
    f.delivery.offerStream('x'.repeat(IMAGE_DELIVERY_LIMITS.scanLength - 10) + '\n![chart](');
    f.delivery.offerStream('./chart.png)\n');
    f.delivery.offerStream('x'.repeat(IMAGE_DELIVERY_LIMITS.scanLength));
    await f.delivery.finish();
    expect(f.readFile).toHaveBeenCalledWith('./chart.png');
    expect(f.publish).toHaveBeenCalledTimes(1);
  });

  it('reports bounded aggregate scans and drops text from a superseded execution phase', async () => {
    const f = fixture();
    let eligible = true;
    f.delivery.offerStream('![old](old.png)', () => eligible);
    eligible = false;
    f.delivery.offerStream('New output');
    f.delivery.offerText('x'.repeat(IMAGE_DELIVERY_LIMITS.scanLength + 1));
    await f.delivery.finish();
    expect(f.readFile).not.toHaveBeenCalled();
    expect(f.notice).toHaveBeenCalledWith(expect.stringContaining('scanning reached its text limit'));
  });

  it('contains read errors, invalid references and publish errors without private details', async () => {
    const f = fixture({ readFile: vi.fn().mockRejectedValue(new Error('private path details')),
      publish: vi.fn(() => { throw new Error('private transport details'); }) });
    f.delivery.offerImage(image());
    f.delivery.offerFile('chart.png');
    f.delivery.offerFile('x'.repeat(IMAGE_DELIVERY_LIMITS.pathLength + 1));
    await f.delivery.finish();
    expect(f.notice).toHaveBeenCalledWith(expect.stringContaining('Images omitted: 3'));
    expect(f.notice.mock.calls.flat().join(' ')).not.toContain('private');
    const missing = fixture({ readFile: vi.fn(async () => null) });
    missing.delivery.offerFile('missing.png');
    await missing.delivery.finish();
    expect(missing.notice).toHaveBeenCalledWith(expect.stringContaining('unavailable'));
  });

  it.each(['cancel', 'owner', 'phase'])('fences an accepted read after %s changes', async kind => {
    const pending = deferred<ImageBlock>();
    let current = true;
    let eligible = true;
    const f = fixture({ readFile: vi.fn(() => pending.promise), isCurrent: () => current });
    f.delivery.offerFile('chart.png', () => eligible);
    await Promise.resolve();
    if (kind === 'cancel') f.delivery.cancel();
    if (kind === 'owner') current = false;
    if (kind === 'phase') eligible = false;
    pending.resolve(image());
    await f.delivery.finish();
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.notice).not.toHaveBeenCalled();
  });

  it('keeps the real read permit after timeout and discards its late result', async () => {
    vi.useFakeTimers();
    const pending = deferred<ImageBlock>();
    const pool = new ImageReadPool(1, 1);
    const first = fixture({ pool, readFile: vi.fn(() => pending.promise), readTimeoutMs: 20 });
    first.delivery.offerFile('slow.png');
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(20);
    await first.delivery.finish();
    const second = fixture({ pool });
    second.delivery.offerFile('queued.png');
    second.delivery.offerFile('rejected.png');
    await Promise.resolve();
    expect(second.readFile).not.toHaveBeenCalled();
    pending.resolve(image());
    await second.delivery.finish();
    expect(first.publish).not.toHaveBeenCalled();
    expect(second.readFile).toHaveBeenCalledTimes(1);
    expect(second.notice).toHaveBeenCalledWith(expect.stringContaining('capacity reached'));
  });

  it('discards pre-disconnect reads but accepts newly emitted images after recovery', async () => {
    const pending = deferred<ImageBlock>();
    const f = fixture({ readFile: vi.fn(() => pending.promise) });
    f.delivery.offerFile('before-disconnect.png');
    await Promise.resolve();
    f.delivery.invalidatePending();
    pending.resolve(image());
    f.delivery.offerImage(image('after-recovery'));
    await f.delivery.finish();
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(f.publish).toHaveBeenCalledWith(image('after-recovery'));
  });

  it('does not let adapter parsing deduplicate an image rejected by its publication owner', async () => {
    let current = false;
    const f = fixture({ isCurrent: () => current });
    const parser = new CodexImages();
    const forward = (id: string) => {
      const result = parser.extract({ type: 'imageGeneration', status: 'completed', id, result: image().data }, 'turn');
      for (const artifact of result.artifacts) if ('image' in artifact) f.delivery.offerImage(artifact.image);
    };
    forward('before-recovery');
    current = true;
    forward('after-recovery');
    await f.delivery.finish();
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(f.notice).not.toHaveBeenCalled();
  });

  it('drain deadline cancels queued reads without waiting for an underlying hung read', async () => {
    vi.useFakeTimers();
    const pending = deferred<ImageBlock>();
    const pool = new ImageReadPool(1, 2);
    const f = fixture({ pool, readFile: vi.fn(() => pending.promise), readTimeoutMs: 100, drainTimeoutMs: 10 });
    f.delivery.offerFile('active.png');
    f.delivery.offerFile('queued.png');
    const finishing = f.delivery.finish();
    await vi.advanceTimersByTimeAsync(10);
    await finishing;
    expect(f.notice).toHaveBeenCalledWith(expect.stringContaining('Images omitted: 2'));
    pending.resolve(image());
    await vi.runAllTimersAsync();
    expect(f.readFile).toHaveBeenCalledTimes(1);
    expect(f.publish).not.toHaveBeenCalled();
  });

  it('drops ineligible callbacks before consuming admission and cancels queued work', async () => {
    const pending = deferred<ImageBlock>();
    const pool = new ImageReadPool(1, 1);
    const blocker = fixture({ pool, readFile: vi.fn(() => pending.promise) });
    blocker.delivery.offerFile('active.png');
    const f = fixture({ pool });
    for (let index = 0; index < 40; index++) f.delivery.offerImage(image(), () => false);
    f.delivery.offerFile('queued.png');
    f.delivery.cancel();
    pending.resolve(image());
    await blocker.delivery.finish();
    await f.delivery.finish();
    expect(f.readFile).not.toHaveBeenCalled();
    expect(f.notice).not.toHaveBeenCalled();
  });
});
