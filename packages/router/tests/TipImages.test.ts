import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import { TipImages, TIP_IMAGE_TIMEOUT } from '../src/tips/TipImages';
import type { TipDefinition } from '../src/tips/TipTypes';

const tip = { id: 'fixture', image: 'fixture.png' } as TipDefinition;
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('TipImages', () => {
  it('coalesces parallel requests and caches successful uploads', async () => {
    vi.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from('fixture'));
    const upload = vi.fn().mockResolvedValue('image-key'); const images = new TipImages(upload);
    expect(await Promise.all([images.get(tip), images.get(tip)])).toEqual(['image-key', 'image-key']);
    expect(await images.get(tip)).toBe('image-key');
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledWith(Buffer.from('fixture').toString('base64'), 'image/png');
  });

  it('retries a later request after missing files or rejected uploads', async () => {
    const read = vi.spyOn(fs, 'readFile').mockRejectedValueOnce(new Error('missing'));
    const upload = vi.fn().mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('offline')).mockResolvedValue('image-key');
    const images = new TipImages(upload);
    expect(await images.get(tip)).toBeNull();
    read.mockResolvedValue(Buffer.from('fixture'));
    expect(await images.get(tip)).toBeNull();
    expect(await images.get(tip)).toBeNull();
    expect(await images.get(tip)).toBe('image-key');
  });

  it('rejects empty or oversize illustrations before uploading', async () => {
    const read = vi.spyOn(fs, 'readFile').mockResolvedValueOnce(Buffer.alloc(0)).mockResolvedValueOnce(Buffer.alloc(2 * 1024 * 1024 + 1));
    const upload = vi.fn(); const images = new TipImages(upload);
    expect(await images.get(tip)).toBeNull();
    expect(await images.get(tip)).toBeNull();
    expect(read).toHaveBeenCalledTimes(2); expect(upload).not.toHaveBeenCalled();
  });

  it('evicts hung attempts and ignores late success while the replacement upload completes', async () => {
    vi.useFakeTimers();
    vi.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from('fixture'));
    let finishOld!: (value: string) => void;
    let finishNew!: (value: string) => void;
    const upload = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve; }));
    const images = new TipImages(upload);
    const old = images.get(tip);
    await vi.advanceTimersByTimeAsync(TIP_IMAGE_TIMEOUT);
    expect(await old).toBeNull();
    const replacement = images.get(tip);
    await vi.advanceTimersByTimeAsync(0);
    expect(upload).toHaveBeenCalledTimes(2);
    finishOld('stale-key'); await Promise.resolve();
    expect(images.get(tip)).toBe(replacement);
    finishNew('fresh-key'); expect(await replacement).toBe('fresh-key');
    expect(await images.get(tip)).toBe('fresh-key');
  });

  it('never starts an upload after the preceding file read has expired', async () => {
    vi.useFakeTimers();
    let finishRead!: (value: Buffer) => void;
    vi.spyOn(fs, 'readFile').mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }) as any)
      .mockResolvedValue(Buffer.from('fixture'));
    const upload = vi.fn().mockResolvedValue('fresh-key'); const images = new TipImages(upload);
    const expired = images.get(tip);
    await vi.advanceTimersByTimeAsync(TIP_IMAGE_TIMEOUT); expect(await expired).toBeNull();
    finishRead(Buffer.from('expired')); await vi.advanceTimersByTimeAsync(0);
    expect(upload).not.toHaveBeenCalled();
    expect(await images.get(tip)).toBe('fresh-key'); expect(upload).toHaveBeenCalledTimes(1);
  });
});
