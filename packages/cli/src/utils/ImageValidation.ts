import type { ImageBlock } from '../types';

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_ENCODED_BYTES = 4 * Math.ceil(MAX_IMAGE_BYTES / 3);

/** Identify supported signatures, without claiming to decode or sanitize the image. */
export function sniffImageMime(bytes: Buffer): string | null {
  if (!Buffer.isBuffer(bytes)) return null;
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF'
    && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('latin1', 0, 6))) return 'image/gif';
  if (bytes.length >= 4 && ['49492a00', '4d4d002a'].includes(bytes.subarray(0, 4).toString('hex'))) return 'image/tiff';
  if (bytes.length >= 14 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  if (bytes.length >= 6 && bytes.readUInt32LE(0) === 0x00010000 && bytes.readUInt16LE(4) > 0) return 'image/x-icon';
  return null;
}

/**
 * Accept only canonical, padded base64 within the decoded size limit. The declared
 * MIME must agree with the signature (including common BMP/ICO/JPEG aliases).
 * Return only wire fields, with MIME derived from bytes; never forward metadata.
 */
export function validateImageBlock(image: unknown): ImageBlock | null {
  if (!image || typeof image !== 'object') return null;
  const candidate = image as Partial<ImageBlock>;
  if (candidate.type !== 'image' || typeof candidate.data !== 'string' || typeof candidate.mimeType !== 'string') return null;
  const data = candidate.data;
  if (!data.length || data.length > MAX_ENCODED_BYTES || data.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null;
  const decodedSize = data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
  if (decodedSize <= 0 || decodedSize > MAX_IMAGE_BYTES) return null;
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length !== decodedSize || bytes.toString('base64') !== data) return null;
  const mimeType = sniffImageMime(bytes);
  const aliases: Record<string, string> = {
    'image/jpg': 'image/jpeg',
    'image/x-ms-bmp': 'image/bmp',
    'image/vnd.microsoft.icon': 'image/x-icon',
  };
  const declared = candidate.mimeType.trim().toLowerCase();
  if (!mimeType || (aliases[declared] ?? declared) !== mimeType) return null;
  return { type: 'image', data, mimeType };
}
