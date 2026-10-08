import { describe, expect, it } from 'vitest';
import { inflateRawSync } from 'zlib';
import { zipFixture } from './helpers/documentFixtures';

function bitwiseCrc(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

describe('document ZIP fixtures', () => {
  it.each([
    Buffer.alloc(0), Buffer.from('123456789'), Buffer.from('Synthetic document'),
    Buffer.from(Array.from({ length: 256 }, (_, byte) => byte)),
    Buffer.from(Array.from({ length: 8192 }, (_, index) => (index * 37) & 0xff)),
  ].map(data => ({ bytes: data.length, data })))('preserves CRC and every payload byte for a $bytes-byte fixture', ({ data }) => {
    const zip = zipFixture([['entry.txt', data]]);
    const filenameLength = zip.readUInt16LE(26);
    const compressedLength = zip.readUInt32LE(18);
    const compressed = zip.subarray(30 + filenameLength, 30 + filenameLength + compressedLength);
    const directory = zip.readUInt32LE(zip.length - 6);
    expect(zip.readUInt32LE(14)).toBe(bitwiseCrc(data));
    expect(zip.readUInt32LE(directory + 16)).toBe(bitwiseCrc(data));
    expect(zip.readUInt32LE(22)).toBe(data.length);
    expect(zip.readUInt32LE(directory + 24)).toBe(data.length);
    expect(inflateRawSync(compressed)).toEqual(data);
    if (data.toString() === '123456789') expect(zip.readUInt32LE(14)).toBe(0xcbf43926);
  });

  it('keeps each entry independently addressable in a multi-entry archive', () => {
    const zip = zipFixture([['first.txt', 'first'], ['second.txt', Buffer.from([0, 128, 255])]]);
    let offset = zip.readUInt32LE(zip.length - 6);
    for (const [name, payload] of [['first.txt', Buffer.from('first')], ['second.txt', Buffer.from([0, 128, 255])]] as const) {
      const length = zip.readUInt16LE(offset + 28);
      const local = zip.readUInt32LE(offset + 42);
      expect(zip.subarray(offset + 46, offset + 46 + length).toString()).toBe(name);
      expect(zip.readUInt32LE(local + 14)).toBe(bitwiseCrc(payload));
      expect(zip.readUInt32LE(offset + 16)).toBe(bitwiseCrc(payload));
      offset += 46 + length;
    }
  });
});
