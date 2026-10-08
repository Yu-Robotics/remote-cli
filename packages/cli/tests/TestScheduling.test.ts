import { describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { isMainThread } from 'worker_threads';
import config, { realGitTestFiles } from '../vitest.config';

describe('CLI test scheduling', () => {
  it('bounds real Git suites separately without raising ordinary test deadlines', () => {
    expect(isMainThread).toBe(false);
    expect(config.test).toMatchObject({
      pool: 'threads', minWorkers: 1, maxWorkers: 2,
      poolOptions: { forks: { minForks: 1, maxForks: 1 } },
    });
    expect(config.test?.testTimeout).toBeUndefined();
    expect(config.test?.hookTimeout).toBeUndefined();
    expect(config.test?.poolMatchGlobs).toEqual(realGitTestFiles.map(file => [`**/${file}`, 'forks']));
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
