import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractLocalImagePaths, readLocalImages } from '../src/utils/LocalImageDetector';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('LocalImageDetector', () => {
  it('extracts Markdown and plain local image paths without duplicates', () => {
    expect(extractLocalImagePaths(
      '![chart](./chart.png) and /workspace/chart.png. Also chart.png',
    )).toEqual(['./chart.png', '/workspace/chart.png', 'chart.png']);
  });

  it('extracts standard Markdown image destinations with titles and angle brackets', () => {
    expect(extractLocalImagePaths(
      '![chart](./chart.png "Chart") ![plot](<charts/my plot.png>)',
    )).toEqual(['./chart.png', 'charts/my plot.png']);
  });

  it('extracts full and collapsed reference-style Markdown images', () => {
    expect(extractLocalImagePaths([
      '![chart][chart-ref]',
      '![plot][]',
      '![plot]',
      '',
      '[chart-ref]: ./chart.png',
      '[plot]: <./plot.png> "Plot"',
    ].join('\n'))).toEqual(['./chart.png', './plot.png']);
  });

  it('reads allowed images as base64 blocks', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'remote-cli-image-test-'));
    temporaryDirectories.push(directory);
    const imagePath = path.join(directory, 'chart.png');
    await mkdir(directory, { recursive: true });
    await writeFile(imagePath, Buffer.from('image-data'));

    const images = await readLocalImages(`![chart](${imagePath})`, directory, () => true);

    expect(images).toEqual([{
      path: imagePath,
      data: Buffer.from('image-data').toString('base64'),
      mimeType: 'image/png',
    }]);
  });

  it('does not read paths rejected by the directory policy', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'remote-cli-image-test-'));
    temporaryDirectories.push(directory);
    await writeFile(path.join(directory, 'chart.png'), Buffer.from('image-data'));

    await expect(readLocalImages('chart.png', directory, () => false)).resolves.toEqual([]);
  });
});
