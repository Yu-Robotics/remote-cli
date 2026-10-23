import { describe, expect, it } from 'vitest';
import { MAX_IMAGE_BYTES, sniffImageMime, validateImageBlock } from '../src/utils/ImageValidation';

const png = Buffer.from('89504e470d0a1a0a', 'hex');
const samples: Array<[string, Buffer]> = [
  ['image/png', png],
  ['image/jpeg', Buffer.from('ffd8ffe000104a4649460001', 'hex')],
  ['image/webp', Buffer.from('524946460400000057454250', 'hex')],
  ['image/gif', Buffer.from('GIF87a')],
  ['image/gif', Buffer.from('GIF89a')],
  ['image/tiff', Buffer.from('49492a0008000000', 'hex')],
  ['image/tiff', Buffer.from('4d4d002a00000008', 'hex')],
  ['image/bmp', Buffer.from('424d0e000000000000000e000000', 'hex')],
  ['image/x-icon', Buffer.from('000001000100', 'hex')],
];

describe('ImageValidation', () => {
  it.each(samples)('recognizes %s bytes and returns only wire fields', (mimeType, bytes) => {
    const data = bytes.toString('base64');
    expect(sniffImageMime(bytes)).toBe(mimeType);
    expect(validateImageBlock({ type: 'image', data, mimeType, metadata: 'synthetic-private-marker' }))
      .toEqual({ type: 'image', data, mimeType });
  });

  it.each([null, undefined, false, 1, 'image', [], {}, { type: 'text' },
    { type: 'image', data: 1, mimeType: 'image/png' }, { type: 'image', data: '', mimeType: 'image/png' },
    { type: 'image', data: png.toString('base64') }, { type: 'image', data: png.toString('base64'), mimeType: null },
  ])('rejects invalid runtime shapes (%j)', image => {
    expect(validateImageBlock(image)).toBeNull();
  });

  it('requires MIME agreement with bytes, allowing documented aliases', () => {
    const data = png.toString('base64');
    expect(validateImageBlock({ type: 'image', data, mimeType: 'image/jpeg' })).toBeNull();
    expect(validateImageBlock({ type: 'image', data, mimeType: 'application/octet-stream' })).toBeNull();
    expect(validateImageBlock({ type: 'image', data, mimeType: ' IMAGE/PNG ' })?.mimeType).toBe('image/png');
    for (const [alias, canonical] of [
      ['image/jpg', 'image/jpeg'], ['image/x-ms-bmp', 'image/bmp'], ['image/vnd.microsoft.icon', 'image/x-icon'],
    ]) {
      const bytes = samples.find(([mime]) => mime === canonical)![1];
      expect(validateImageBlock({ type: 'image', data: bytes.toString('base64'), mimeType: alias })?.mimeType).toBe(canonical);
    }
  });

  it('rejects unsupported, truncated, and high-bit signature lookalikes', () => {
    const highBitGif = Buffer.from([...Buffer.from('GIF89a')].map(byte => byte | 0x80));
    for (const bytes of [Buffer.alloc(0), png.subarray(0, 7), Buffer.from('<svg/>'),
      Buffer.from('image-data'), highBitGif, Buffer.from('000001000000', 'hex'), Buffer.from('RIFFabcdWAVE')]) {
      expect(sniffImageMime(bytes)).toBeNull();
      expect(validateImageBlock({ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' })).toBeNull();
    }
    expect(sniffImageMime(null as unknown as Buffer)).toBeNull();
  });

  it('requires canonical base64, including zero pad bits', () => {
    const canonical = png.toString('base64');
    // The last significant character uses only four bits for this eight-byte value.
    const noncanonical = canonical.slice(0, -2) + 'p=';
    expect(Buffer.from(noncanonical, 'base64')).toEqual(png);
    for (const data of [canonical.slice(0, -1), `${canonical}\n`, ` ${canonical}`, noncanonical,
      `${canonical}=`, `data:image/png;base64,${canonical}`, '!!!!', 'AA=A', '_w==', '-w==']) {
      expect(validateImageBlock({ type: 'image', data, mimeType: 'image/png' })).toBeNull();
    }
  });

  it('accepts exactly 2 MiB and rejects encoded and decoded size overflow', () => {
    const exact = Buffer.alloc(MAX_IMAGE_BYTES);
    png.copy(exact);
    expect(validateImageBlock({ type: 'image', data: exact.toString('base64'), mimeType: 'image/png' })).not.toBeNull();
    for (const extra of [1, 2, 3]) {
      const oversized = Buffer.concat([exact, Buffer.alloc(extra)]).toString('base64');
      expect(validateImageBlock({ type: 'image', data: oversized, mimeType: 'image/png' })).toBeNull();
    }
  });
});
