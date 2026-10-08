import { describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { isMainThread } from 'worker_threads';
import config, { realGitTestFiles, testWorkerLimits } from '../vitest.config';

describe('CLI test scheduling', () => {
  it('bounds real Git suites separately without raising ordinary test deadlines', () => {
    const workers = testWorkerLimits(os.availableParallelism?.() ?? os.cpus().length);
    expect(isMainThread).toBe(false);
    expect(config.test).toMatchObject({
      pool: 'threads', minWorkers: 1, maxWorkers: workers.threads,
      poolOptions: { forks: { minForks: 1, maxForks: workers.gitForks } },
    });
    expect(config.test?.testTimeout).toBeUndefined();
    expect(config.test?.hookTimeout).toBeUndefined();
    expect(config.test?.poolMatchGlobs).toEqual(realGitTestFiles.map(file => [`**/${file}`, 'forks']));
  });

  it.each([
    [1, 1, 1], [2, 1, 1], [3, 1, 2], [4, 2, 2], [7, 2, 4], [8, 4, 4], [64, 4, 4],
    [0, 1, 1], [-1, 1, 1], [NaN, 1, 1], [Infinity, 1, 1],
  ])('bounds both pools for %s available CPUs', (cpus, gitForks, threads) => {
    expect(testWorkerLimits(cpus)).toEqual({ gitForks, threads });
  });

  it('routes every real Git fixture consumer to the bounded pool', async () => {
    const consumers: string[] = [];
    for (const directory of ['tests/delegation', 'tests/integration']) {
      for (const file of await fs.readdir(directory)) {
        if (!file.endsWith('.test.ts')) continue;
        const contents = await fs.readFile(path.join(directory, file), 'utf8');
        if (/from ['"][^'"]*gitFixture['"]/.test(contents)) consumers.push(`${directory}/${file}`);
      }
    }
    expect(consumers.sort()).toEqual([...realGitTestFiles].sort());
  });
});
