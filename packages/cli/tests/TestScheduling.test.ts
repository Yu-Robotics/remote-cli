import { describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { isMainThread } from 'worker_threads';
import { createRequire } from 'module';
import config, { processIsolatedTestFiles, processIsolatedTestGlobs, realGitTestFiles, testWorkerLimits } from '../vitest.config';

// Exercise the matcher used by the installed Vitest, including its dot-path defaults.
const { isMatch } = createRequire(require.resolve('vitest/package.json'))('micromatch') as {
  isMatch(file: string, glob: string): boolean;
};

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
    expect(config.test?.poolMatchGlobs).toEqual(processIsolatedTestGlobs(path.resolve('.')));
  });

  it.each([
    'tests/ScheduleService.test.ts',
    'tests/delegation/ManagedNativeSessionDeletion.test.ts',
    'tests/delegation/ManagedHistoryBackends.test.ts',
  ])('isolates native lock release and reacquisition in %s', file => {
    expect(config.test?.poolMatchGlobs?.some(([glob, pool]) =>
      pool === 'forks' && isMatch(path.resolve(file).split(path.sep).join('/'), glob))).toBe(true);
  });

  it.each([
    path.posix.join('/fixture', 'checkout', 'packages', 'cli'),
    path.posix.join('/fixture', '.remote-cli', 'checkout [one]', 'packages', 'cli'),
    path.win32.join('C:\\', 'fixture', '.remote-cli', 'checkout [one]', 'packages', 'cli'),
    path.win32.join('\\\\fixture-server\\share', '.remote-cli', 'checkout', 'packages', 'cli'),
  ])('keeps native suites in forks under %s', root => {
    const normalized = root.replace(/\\/g, '/');
    const globs = processIsolatedTestGlobs(root);
    const poolFor = (file: string) => globs.find(([glob]) => isMatch(file, glob))?.[1] ?? 'threads';
    for (const file of processIsolatedTestFiles) {
      expect(poolFor(`${normalized}/${file}`)).toBe('forks');
      expect(poolFor(`${normalized}-other/${file}`)).toBe('threads');
    }
    expect(poolFor(`${normalized}/tests/TestScheduling.test.ts`)).toBe('threads');
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
