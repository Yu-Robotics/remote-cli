import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { deflateSync, inflateSync } from 'node:zlib';
import catalog from '../../src/tips/catalog.zh-CN.json';
import { TIPS, tipImagePath } from '../../src/tips/TipCatalog';

const localRequire = createRequire(import.meta.url);
const { buildTips, validateCatalog, validatePng } = localRequire('../../scripts/build-tips.cjs');
const source = path.resolve(__dirname, '../../src/tips');
const root = path.resolve(__dirname, '../../../..');
const temporary: string[] = [];
const makeTemp = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tip-catalog-test-'));
  temporary.push(directory);
  return directory;
};
const expectedIds = [
  'cross-backend-review', 'delegation-independent-checks', 'delegation-parallel-changes',
  'model-within-backend', 'delegation-by-instruction', 'delegation-allowance',
  'delegation-resolve-disagreement', 'backend-current-thread', 'effort-native-options',
  'queue-confirm', 'abort-consequences', 'file-needs-instruction', 'image-with-question',
  'device-selection', 'clear-thread-context', 'compact-backend', 'skills-by-backend',
];
const naturalInstructionIds = [
  'cross-backend-review', 'delegation-independent-checks', 'delegation-parallel-changes',
  'delegation-by-instruction', 'delegation-allowance', 'delegation-resolve-disagreement',
];
const find = (id: string) => TIPS.find(tip => tip.id === id)!;

const limits = { id: 64, topic: 32, title: 40, problem: 100, benefit: 100,
  action: 180, example: 240, detail: 240, image: 68 } as const;

type PngChunk = { type: string; data: Buffer };

/** Re-encode controlled mutations with valid checksums to reach the format/pixel guards. */
function encodeChunks(signature: Buffer, chunks: PngChunk[]): Buffer {
  return Buffer.concat([signature, ...chunks.map(({ type, data }) => {
    const chunk = Buffer.alloc(data.length + 12);
    chunk.writeUInt32BE(data.length, 0);
    chunk.write(type, 4, 4, 'ascii');
    data.copy(chunk, 8);
    let crc = 0xffffffff;
    for (const byte of chunk.subarray(4, chunk.length - 4)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
    return chunk;
  })]);
}

afterEach(() => {
  vi.doUnmock('../../src/tips/catalog.zh-CN.json');
  vi.resetModules();
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('reviewed illustrated tip catalog', () => {
  it('exposes 17 stable, frozen definitions with only contract fields', () => {
    expect(TIPS.map(tip => tip.id)).toEqual(expectedIds);
    expect(Object.isFrozen(TIPS)).toBe(true);
    expect(new Set(TIPS.map(tip => tip.id)).size).toBe(17);
    expect(validateCatalog(catalog)).toBe(catalog);
    for (const tip of TIPS) {
      expect(Object.isFrozen(tip)).toBe(true);
      expect(Object.keys(tip).sort()).toEqual(Object.keys(limits).sort());
      expect(tip.id).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
      expect(tip.topic).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
      for (const [field, limit] of Object.entries(limits)) {
        const value = tip[field as keyof typeof tip];
        expect([...value].length).toBeGreaterThan(0);
        expect([...value].length).toBeLessThanOrEqual(limit);
        expect(value).toBe(value.trim());
      }
      for (const field of ['title', 'problem', 'benefit', 'action', 'detail'] as const) {
        expect(tip[field]).toMatch(/\p{Script=Han}/u);
      }
      expect([...tip.detail].length).toBeLessThanOrEqual(80);
      expect(tip.problem.match(/\u3002/g)).toHaveLength(1);
      expect(tip.benefit.match(/\u3002/g)).toHaveLength(1);
      expect(tip.image).toBe(`${tip.id}.png`);
    }
    expect(new Set(catalog.map(tip => tip.illustration.layout)).size).toBe(17);
    expect(new Set(TIPS.map(tip => tip.title)).size).toBe(17);
    expect(new Set(TIPS.map(tip => tip.problem)).size).toBe(17);
  });

  it('keeps the accepted topics without restoring rejected subjects or invented commands', () => {
    for (const id of ['named-thread', 'reply-old-card', 'queue-clear', 'queue-continue', 'same-backend-worker']) {
      expect(expectedIds).not.toContain(id);
    }
    for (const tip of TIPS) {
      const text = JSON.stringify(tip);
      expect(text).not.toMatch(/\/(?:agent|delegate|worker|integrate)(?:\s|["\\])/);
      expect(text).not.toMatch(/\/thread\s+new|\/queue\s+(?:clear|continue)/);
      expect(text).not.toMatch(/\/backend\s+\d/);
      expect(text).not.toMatch(/https?:\/\/|(?:\d{1,3}\.){3}\d{1,3}|\/home\/|\/Users\//);
    }
    for (const id of naturalInstructionIds) {
      expect(find(id).action).not.toMatch(/\/[a-z]/);
      expect(find(id).example).not.toMatch(/^\//);
      expect(find(id).example).toMatch(/\p{Script=Han}/u);
    }
  });

  it('provides exactly six bounded localized step and key-point labels per illustration', () => {
    for (const entry of catalog) {
      expect(entry.illustration.layout).toBe(entry.id);
      expect(Object.keys(entry.illustration).sort()).toEqual(['labels', 'layout', 'takeaway']);
      expect(entry.illustration.labels).toHaveLength(6);
      for (const label of entry.illustration.labels) {
        expect(label).toMatch(/\p{Script=Han}/u);
        expect([...label].length).toBeLessThanOrEqual(32);
        expect(label).toBe(label.trim());
      }
      expect(entry.illustration.takeaway).toMatch(/\p{Script=Han}/u);
      expect([...entry.illustration.takeaway].length).toBeLessThanOrEqual(40);
    }
  });

  it('preserves independent-worker, integration, dictation and allowance boundaries', () => {
    expect(find('cross-backend-review').example).toMatch(/\u6574\u5408.*\u518d\u8bf7\u53e6\u4e00\u79cd/);
    expect(find('cross-backend-review').detail).toContain('\u4e0d\u4f1a\u81ea\u52a8\u5408\u5e76');
    expect(find('delegation-independent-checks').example).toMatch(/\u5b9e\u73b0.*\u6d4b\u8bd5.*\u6587\u6863/);
    expect(find('delegation-independent-checks').detail).toMatch(/\u540c\u4e00\u79cd\u540e\u7aef.*\u72ec\u7acb.*\u590d\u7528.*\u5386\u53f2/);
    expect(find('delegation-parallel-changes').detail).toMatch(/\u540d\u989d.*\u5e76\u53d1.*\u975e Git.*\u4e32\u884c/);
    expect(find('delegation-parallel-changes').detail).toContain('\u5de5\u4f5c\u6811\u4e0d\u662f\u7cfb\u7edf\u6c99\u7bb1');
    expect(find('delegation-parallel-changes').example).toMatch(/\u6574\u5408.*\u6d4b\u8bd5/);
    expect(find('delegation-by-instruction').action).toContain('\u542c\u5199\u8f6c\u6210\u6587\u5b57');
    expect(find('delegation-by-instruction').detail).toMatch(/\u539f\u59cb\u98de\u4e66\u8bed\u97f3.*\u4e0d\u4f1a\u88ab\u5904\u7406/);
    expect(find('delegation-by-instruction').example).toContain('\u4e3b\u52a9\u624b\u4fdd\u6301\u4e0d\u53d8');
    expect(find('delegation-allowance').benefit).toContain('\u624b\u52a8');
    expect(find('delegation-allowance').detail).toMatch(/\u4e0d\u4f1a\u81ea\u52a8\u6c47\u96c6.*\u8f6c\u79fb\u4f59\u989d.*\u8fc1\u79fb\u8fd0\u884c\u4e2d\u7684\u4efb\u52a1/);
    expect(find('delegation-resolve-disagreement').detail).toMatch(/\u4e3b\u52a9\u624b\u663e\u5f0f\u8f6c\u8ff0.*\u4e0d\u662f\u52a9\u624b\u4e4b\u95f4\u76f4\u63a5\u804a\u5929/);
    expect(find('delegation-resolve-disagreement').detail).toMatch(/\u4e0d\u4f1a\u81ea\u52a8\u5171\u4eab.*\u4e0d\u4fdd\u8bc1\u6b63\u786e/);
  });

  it('keeps settings scoped to the thread/backend and distinguishes discovery from invocation', () => {
    expect(find('backend-current-thread').action).toContain('Current thread');
    expect(find('backend-current-thread').example).toContain('/backend <index> @');
    expect(find('model-within-backend').example).toBe('/model');
    expect(find('model-within-backend').action).toContain('\u7a7a\u95f2');
    expect(find('model-within-backend').detail).toMatch(/\u5f53\u524d\u7ebf\u7a0b\u548c\u540e\u7aef.*\u540e\u7eed.*\u540c\u540e\u7aef.*\u5171\u4eab.*\u4e0d\u80fd\u9010\u4e2a\u72ec\u7acb\u8bbe\u7f6e/);
    expect(find('model-within-backend').detail).toContain('\u4e0d\u5207\u6362\u4e3b\u540e\u7aef');
    expect(find('effort-native-options').action).toContain('/effort auto');
    expect(find('effort-native-options').detail).toMatch(/\u540e\u7aef\u3001\u7248\u672c\u548c\u6a21\u578b.*\u53d6\u6d88\u624b\u52a8\u8986\u76d6/);
    expect(find('skills-by-backend').action).toMatch(/\/skills.*\u666e\u901a\u6587\u5b57.*\u5b9e\u9645\u6280\u80fd/);
    expect(find('skills-by-backend').detail).toMatch(/Claude.*\u5b9e\u9645\u6280\u80fd\u547d\u4ee4.*Codex.*\u672c\u5730\u53d1\u73b0.*\u4e0d\u652f\u6301 TUI/);
    expect(find('skills-by-backend').detail).toContain('\u4e0d\u4f1a\u81ea\u52a8\u8de8\u540e\u7aef\u540c\u6b65');
    expect(find('skills-by-backend').detail).toContain('DSH \u4e0d\u652f\u6301 /skills');
  });

  it('qualifies queue, attachment, device and conversation-reset workflows', () => {
    expect(find('queue-confirm').action).toContain('Add to queue');
    expect(find('queue-confirm').detail).toContain('\u5fc5\u987b\u660e\u786e\u786e\u8ba4');
    expect(find('abort-consequences').example).toBe('/abort');
    expect(find('abort-consequences').detail).toMatch(/\u5df2\u786e\u8ba4\u548c\u5f85\u786e\u8ba4.*\u4e0d\u4f1a\u56de\u6eda/);
    expect(find('file-needs-instruction').action).toContain('\u5b8c\u6210\u6587\u4ef6\u63a5\u6536\u6388\u6743');
    expect(find('file-needs-instruction').detail).toMatch(/\u4e0d\u4f1a\u81ea\u52a8\u542f\u52a8\u4efb\u52a1\u6216\u590d\u5236\u5230\u9879\u76ee\u76ee\u5f55.*\u89e3\u6790\u6709\u8303\u56f4\u9650\u5236/);
    expect(find('image-with-question').action).toContain('\u540c\u4e00\u6761\u98de\u4e66\u5bcc\u6587\u672c\u6d88\u606f');
    expect(find('image-with-question').detail).toMatch(/AGY \u53ea\u6536\u6587\u672c.*DSH.*\u8fde\u63a5\u80fd\u529b\u548c\u6240\u9009\u6a21\u578b/);
    expect(find('device-selection').example).toBe('/device\n/device <index>');
    expect(find('device-selection').detail).toMatch(/\u4e0d\u4f1a.*\u4efb\u52a1\u3001\u9879\u76ee\u6587\u4ef6\u6216\u4f1a\u8bdd\u5386\u53f2\u8fc1\u79fb/);
    expect(find('clear-thread-context').action).toMatch(/\u9000\u51fa\u5df2\u786e\u8ba4.*\/clear.*\/new/);
    expect(find('clear-thread-context').detail).toMatch(/1\.6\.177.*\u5168\u90e8\u540e\u7aef\u548c\u6258\u7ba1\u52a9\u624b/);
    expect(find('clear-thread-context').detail).toMatch(/\u5f52\u6863\u5386\u53f2\u3001\u767b\u5f55\u548c\u8bbe\u7f6e\u4fdd\u7559.*\u5176\u4ed6\u7ebf\u7a0b\u4e0d\u53d7\u5f71\u54cd/);
    expect(find('compact-backend').example).toBe('/compact');
    expect(find('compact-backend').detail).toMatch(/\u539f\u751f\u538b\u7f29\u6216\u6458\u8981\u540e\u91cd\u5f00.*\u4e0d\u4fdd\u8bc1\u4fdd\u7559\u5168\u90e8\u7ec6\u8282/);
    expect(find('compact-backend').detail).toContain('\u6458\u8981\u5931\u8d25\u53ef\u80fd\u76f4\u63a5\u91cd\u7f6e');
  });

  it('has one real, unique, bounded PNG per tip, with valid pixels and no embedded metadata', () => {
    expect(fs.readdirSync(path.join(source, 'assets')).sort()).toEqual(TIPS.map(tip => tip.image).sort());
    const hashes = new Set<string>();
    let total = 0;
    for (const tip of TIPS) {
      const image = fs.readFileSync(tipImagePath(tip));
      expect(validatePng(image)).toEqual({ width: 1600, height: 1120, bytes: image.length });
      expect(image.length).toBeGreaterThan(3 * 1024);
      hashes.add(createHash('sha256').update(image).digest('hex'));
      total += image.length;
    }
    expect(hashes.size).toBe(17);
    expect(total).toBeLessThan(5 * 1024 * 1024);
  });

  it.each(['../outside.png', '/tmp/outside.png', 'nested/image.png', 'cross-backend-review.PNG', 'cross-backend-review.svg', 'cross-backend-review.png\u0000'])(
    'rejects unsafe or mismatched image reference %s', image => {
      expect(() => tipImagePath({ id: TIPS[0].id, image })).toThrow('Invalid tip image reference');
    });

  it.each(['../outside', 'UpperCase', 'two--parts', '', 'a'.repeat(65)])('rejects unsafe tip ID %s', id => {
    expect(() => tipImagePath({ id, image: `${id}.png` })).toThrow('Invalid tip image reference');
  });

  it.each(['duplicate', 'count', 'blank', 'length', 'image', 'unexpected', 'layout', 'labels', 'labels-short', 'labels-long', 'label-length', 'takeaway', 'control'])(
    'rejects invalid catalog input: %s', kind => {
      const candidate = structuredClone(catalog) as any[];
      if (kind === 'duplicate') candidate[1] = candidate[0];
      if (kind === 'count') candidate.pop();
      if (kind === 'blank') candidate[0].problem = ' ';
      if (kind === 'length') candidate[0].title = 'x'.repeat(41);
      if (kind === 'image') candidate[0].image = '../outside.png';
      if (kind === 'unexpected') candidate[0].extra = true;
      if (kind === 'layout') candidate[0].illustration.layout = candidate[1].id;
      if (kind === 'labels') candidate[0].illustration.labels = ['x'];
      if (kind === 'labels-short') candidate[0].illustration.labels.pop();
      if (kind === 'labels-long') candidate[0].illustration.labels.push('Extra');
      if (kind === 'label-length') candidate[0].illustration.labels[0] = 'x'.repeat(33);
      if (kind === 'takeaway') candidate[0].illustration.takeaway = 'x'.repeat(41);
      if (kind === 'control') candidate[0].title = 'unsafe\u0000title';
      expect(() => validateCatalog(candidate)).toThrow();
    });

  it.each(['count', 'duplicate', 'topic', 'blank', 'length', 'image', 'control', 'non-string'])(
    'also refuses malformed packaged contract fields at runtime: %s', async kind => {
      const candidate = structuredClone(catalog) as any[];
      if (kind === 'count') candidate.pop();
      if (kind === 'duplicate') candidate[1] = candidate[0];
      if (kind === 'topic') candidate[0].topic = 'Not a topic';
      if (kind === 'blank') candidate[0].problem = ' ';
      if (kind === 'length') candidate[0].title = 'x'.repeat(41);
      if (kind === 'image') candidate[0].image = '../outside.png';
      if (kind === 'control') candidate[0].title = 'unsafe\u0000title';
      if (kind === 'non-string') candidate[0].title = 123;
      vi.resetModules();
      vi.doMock('../../src/tips/catalog.zh-CN.json', () => ({ default: candidate }));
      await expect(import('../../src/tips/TipCatalog')).rejects.toThrow();
    });

  it('rejects corrupt images instead of copying placeholders or truncated pixel data', () => {
    const good = fs.readFileSync(tipImagePath(TIPS[0]));
    for (const bad of [Buffer.from('not a PNG'), good.subarray(0, good.length - 12), Buffer.concat([good, Buffer.from('trailing')])]) {
      expect(() => validatePng(bad)).toThrow();
    }
    const corrupt = Buffer.from(good);
    corrupt[corrupt.length - 20] ^= 1;
    expect(() => validatePng(corrupt)).toThrow('checksum');
    expect(() => validatePng(Buffer.alloc(193 * 1024))).toThrow();
  });

  it.each(['legacy-dimensions', 'metadata', 'pixel-length', 'last-row-filter', 'inflate-limit'])(
    'retains PNG format and bounded decompression safeguards: %s', kind => {
      const good = fs.readFileSync(tipImagePath(TIPS[0]));
      let chunks: PngChunk[] = [];
      for (let offset = 8; offset < good.length;) {
        const length = good.readUInt32BE(offset);
        chunks.push({ type: good.toString('ascii', offset + 4, offset + 8),
          data: Buffer.from(good.subarray(offset + 8, offset + 8 + length)) });
        offset += length + 12;
      }
      let error: string | undefined;
      if (kind === 'legacy-dimensions') {
        chunks[0].data.writeUInt32BE(960, 0);
        chunks[0].data.writeUInt32BE(540, 4);
        error = 'dimensions or format';
      } else if (kind === 'metadata') {
        chunks.splice(1, 0, { type: 'tEXt', data: Buffer.from('Author\u0000Synthetic fixture') });
        error = 'metadata or chunk';
      } else {
        const firstData = chunks.findIndex(chunk => chunk.type === 'IDAT');
        let pixels = inflateSync(Buffer.concat(chunks.filter(chunk => chunk.type === 'IDAT').map(chunk => chunk.data)));
        if (kind === 'pixel-length') {
          pixels = pixels.subarray(0, pixels.length - 1);
          error = 'pixel data';
        } else if (kind === 'last-row-filter') {
          pixels[(pixels.length / 1120) * 1119] = 5;
          error = 'row filter';
        } else pixels = Buffer.concat([pixels, Buffer.from([0])]);
        chunks[firstData].data = deflateSync(pixels);
        chunks = chunks.filter((chunk, index) => chunk.type !== 'IDAT' || index === firstData);
      }
      expect(() => validatePng(encodeChunks(good.subarray(0, 8), chunks))).toThrow(error);
    });

  it('packages the JSON and all byte-identical images without a renderer dependency', () => {
    const outputDirectory = makeTemp();
    const result = buildTips({ sourceDirectory: source, outputDirectory });
    expect(result.count).toBe(17);
    expect(result.bytes).toBeLessThan(5 * 1024 * 1024);
    expect(JSON.parse(fs.readFileSync(path.join(outputDirectory, 'catalog.zh-CN.json'), 'utf8'))).toEqual(catalog);
    for (const tip of TIPS) expect(fs.readFileSync(path.join(outputDirectory, 'assets', tip.image)))
      .toEqual(fs.readFileSync(tipImagePath(tip)));
    expect(fs.readdirSync(outputDirectory).sort()).toEqual(['assets', 'catalog.zh-CN.json']);
  });

  it('replaces obsolete generated assets while preserving other build outputs', () => {
    const outputDirectory = makeTemp();
    const assets = path.join(outputDirectory, 'assets');
    fs.mkdirSync(assets);
    fs.writeFileSync(path.join(assets, 'obsolete-tip.png'), 'old generated illustration');
    fs.writeFileSync(path.join(outputDirectory, 'keep.js'), 'export {};');

    buildTips({ sourceDirectory: source, outputDirectory });

    expect(fs.readdirSync(assets).sort()).toEqual(TIPS.map(tip => tip.image).sort());
    expect(fs.readFileSync(path.join(outputDirectory, 'keep.js'), 'utf8')).toBe('export {};');
  });

  it.each(['missing', 'extra', 'duplicate', 'symlink', 'corrupt'])(
    'refuses incomplete or invalid asset sets before writing output: %s', kind => {
      const temporaryRoot = makeTemp();
      const input = path.join(temporaryRoot, 'source');
      const output = path.join(temporaryRoot, 'output');
      fs.cpSync(source, input, { recursive: true });
      const first = path.join(input, 'assets', TIPS[0].image);
      const second = path.join(input, 'assets', TIPS[1].image);
      if (kind === 'missing') fs.rmSync(first);
      if (kind === 'extra') fs.writeFileSync(path.join(input, 'assets', 'unexpected.png'), 'invalid');
      if (kind === 'duplicate') fs.copyFileSync(first, second);
      if (kind === 'symlink') { fs.rmSync(second); fs.symlinkSync(first, second); }
      if (kind === 'corrupt') fs.writeFileSync(first, 'invalid');
      expect(() => buildTips({ sourceDirectory: input, outputDirectory: output })).toThrow();
      expect(fs.existsSync(output)).toBe(false);
    });

  it('keeps source and tests English-only while importing localized resources', () => {
    for (const file of ['packages/router/src/tips/TipCatalog.ts', 'packages/router/scripts/build-tips.cjs',
      'packages/router/scripts/generate-tip-images.py', 'packages/router/tests/tips/TipCatalog.test.ts']) {
      expect(fs.readFileSync(path.join(root, file), 'utf8')).not.toMatch(/\p{Script=Han}/u);
    }
  });

  it('provides a 17-tip preview with local images and matching editable SVGs', () => {
    const svgDirectory = path.join(root, 'docs/tips/svg');
    expect(fs.readdirSync(svgDirectory).sort()).toEqual(TIPS.map(tip => `${tip.id}.svg`).sort());
    const gallery = fs.readFileSync(path.join(root, 'docs/tips-preview.html'), 'utf8');
    expect(gallery.match(/<article /g)).toHaveLength(17);
    expect(gallery.match(/<img /g)).toHaveLength(17);
    expect(gallery).not.toMatch(/<details(?:\s|>)/);
    expect(gallery).not.toMatch(/https?:\/\/|<script/);
    for (const tip of TIPS) {
      expect(gallery).toContain(`id="${tip.id}"`);
      expect(gallery).toContain(tip.detail);
      expect(gallery).toContain(`alt="${tip.title}"`);
      const relativeImage = `../packages/router/src/tips/assets/${tip.image}`;
      expect(gallery).toContain(`src="${relativeImage}"`);
      expect(fs.existsSync(path.resolve(root, 'docs', relativeImage))).toBe(true);
      const svg = fs.readFileSync(path.join(svgDirectory, `${tip.id}.svg`), 'utf8');
      expect(svg).toMatch(/<svg\b/);
      expect(svg).not.toMatch(/<script\b|\bon[a-z]+\s*=|\b(?:href|src)\s*=\s*["'](?:https?:|file:|\/\/)/i);
    }
  });
});
