'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const FIELDS = { id: 64, topic: 32, title: 40, problem: 100, benefit: 100,
  action: 180, example: 240, detail: 240, image: 68 };
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const IMAGE_WIDTH = 1600;
const IMAGE_HEIGHT = 1120;
const MAX_IMAGE_BYTES = 192 * 1024;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const value of data) crc = crcTable[(crc ^ value) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function bounded(value, limit) {
  return typeof value === 'string' && value.trim() === value && value.length > 0
    && [...value].length <= limit && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value);
}

function validateCatalog(catalog) {
  if (!Array.isArray(catalog) || catalog.length !== 25) throw new Error('Expected exactly 25 tips');
  const ids = new Set();
  const layouts = new Set();
  for (const tip of catalog) {
    if (!tip || typeof tip !== 'object' || Object.keys(tip).some(key => !(key in FIELDS) && key !== 'illustration')) {
      throw new Error('Unexpected tip catalog fields');
    }
    for (const [key, limit] of Object.entries(FIELDS)) {
      if (!bounded(tip[key], limit)) throw new Error(`Invalid tip field: ${key}`);
    }
    if (!ID.test(tip.id) || !ID.test(tip.topic) || ids.has(tip.id) || tip.image !== `${tip.id}.png`) {
      throw new Error('Invalid or duplicate tip ID, topic, or image');
    }
    const art = tip.illustration;
    if (!art || Object.keys(art).sort().join(',') !== 'labels,layout,takeaway'
      || art.layout !== tip.id || layouts.has(art.layout) || !bounded(art.takeaway, 40)
      || !Array.isArray(art.labels) || art.labels.length !== 6
      || art.labels.some(label => !bounded(label, 32))) throw new Error('Invalid tip illustration metadata');
    ids.add(tip.id);
    layouts.add(art.layout);
  }
  return catalog;
}

function validatePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 3 * 1024 || buffer.length > MAX_IMAGE_BYTES
    || !buffer.subarray(0, 8).equals(PNG)) throw new Error('Invalid or oversized tip PNG');
  let offset = 8;
  let header;
  let end = false;
  let palette = false;
  const compressed = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const next = offset + 12 + length;
    if (next > buffer.length) throw new Error('Truncated tip PNG');
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, next - 4);
    if (crc32(buffer.subarray(offset + 4, next - 4)) !== buffer.readUInt32BE(next - 4)) throw new Error('Invalid tip PNG checksum');
    if (offset === 8 && type !== 'IHDR') throw new Error('Missing tip PNG header');
    if (type === 'IHDR') {
      if (header || length !== 13 || data.readUInt32BE(0) !== IMAGE_WIDTH || data.readUInt32BE(4) !== IMAGE_HEIGHT
        || data[8] !== 8 || ![0, 2, 3, 4, 6].includes(data[9])
        || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) throw new Error('Invalid tip PNG dimensions or format');
      header = data;
    } else if (type === 'PLTE') palette = true;
    else if (type === 'IDAT') compressed.push(data);
    else if (type === 'IEND') {
      if (length !== 0 || next !== buffer.length) throw new Error('Invalid tip PNG ending');
      end = true;
    } else if (!['tRNS'].includes(type)) throw new Error('Unexpected tip PNG metadata or chunk');
    offset = next;
  }
  if (!header || !end || offset !== buffer.length || !compressed.length || (header[9] === 3 && !palette)) {
    throw new Error('Incomplete tip PNG');
  }
  const stride = IMAGE_WIDTH * ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[header[9]]) + 1;
  const pixels = zlib.inflateSync(Buffer.concat(compressed), { maxOutputLength: stride * IMAGE_HEIGHT });
  if (pixels.length !== stride * IMAGE_HEIGHT) throw new Error('Invalid tip PNG pixel data');
  for (let row = 0; row < IMAGE_HEIGHT; row++) if (pixels[row * stride] > 4) throw new Error('Invalid tip PNG row filter');
  return { width: IMAGE_WIDTH, height: IMAGE_HEIGHT, bytes: buffer.length };
}

/** Validate all inputs before emitting the resources consumed by packaged code. */
function buildTips({ sourceDirectory = path.resolve(__dirname, '../src/tips'),
  outputDirectory = path.resolve(__dirname, '../dist/tips') } = {}) {
  const resource = fs.readFileSync(path.join(sourceDirectory, 'catalog.zh-CN.json'));
  if (resource.length > 128 * 1024) throw new Error('Oversized tip catalog');
  const catalog = validateCatalog(JSON.parse(resource.toString('utf8')));
  const assets = path.join(sourceDirectory, 'assets');
  const expected = catalog.map(tip => tip.image).sort();
  if (fs.readdirSync(assets).sort().join('\n') !== expected.join('\n')) throw new Error('Tip assets do not match the catalog');
  const hashes = new Set();
  const images = catalog.map(tip => {
    const file = path.join(assets, tip.image);
    if (!fs.lstatSync(file).isFile()) throw new Error('Tip assets must be regular files');
    const buffer = fs.readFileSync(file);
    validatePng(buffer);
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    if (hashes.has(hash)) throw new Error('Duplicate tip illustration');
    hashes.add(hash);
    return { name: tip.image, buffer };
  });
  const total = images.reduce((sum, image) => sum + image.buffer.length, resource.length);
  if (total > MAX_TOTAL_BYTES) throw new Error('Tip resources exceed the package size budget');
  const outputAssets = path.join(outputDirectory, 'assets');
  // A revised catalog must not retain illustrations from an earlier build.
  // All input validation completes before replacing this generated directory.
  fs.rmSync(outputAssets, { recursive: true, force: true });
  fs.mkdirSync(outputAssets, { recursive: true });
  fs.writeFileSync(path.join(outputDirectory, 'catalog.zh-CN.json'), resource);
  for (const image of images) fs.writeFileSync(path.join(outputAssets, image.name), image.buffer);
  return { count: catalog.length, bytes: total };
}

module.exports = { buildTips, validateCatalog, validatePng };
if (require.main === module) {
  try {
    const result = buildTips();
    process.stdout.write(`Packaged ${result.count} tip illustrations (${result.bytes} bytes).\n`);
  } catch (error) {
    process.stderr.write(`Tip resource build failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
