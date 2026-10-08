import { defineConfig } from 'vitest/config';
import os from 'os';

export function testWorkerLimits(parallelism: number) {
  const cpus = Number.isFinite(parallelism) ? Math.max(1, Math.floor(parallelism)) : 1;
  const gitForks = cpus >= 4 ? 2 : 1;
  return { gitForks, threads: Math.max(1, Math.min(4, cpus - gitForks)) };
}

const workers = testWorkerLimits(os.availableParallelism?.() ?? os.cpus().length);

export const realGitTestFiles = [
  'tests/delegation/GitCheckpoint.test.ts',
  'tests/delegation/gitFixture.test.ts',
  'tests/delegation/DelegatedWorkspaceManager.test.ts',
  'tests/delegation/DelegatedWorkspaceReclamation.test.ts',
  'tests/delegation/DelegatedWorkspaceHistoryDelivery.test.ts',
  'tests/delegation/DelegationGitLifecycle.test.ts',
  'tests/delegation/DelegationWorktrees.test.ts',
  'tests/delegation/NestedRepositories.test.ts',
  'tests/integration/delegation-closeout.test.ts',
];

export default defineConfig({
  test: {
    // Keep real Git process isolation, but do not serialize every expensive
    // suite on multicore hosts. Reserve capacity for the lightweight threads.
    pool: 'threads',
    minWorkers: 1,
    maxWorkers: workers.threads,
    // Vitest matches absolute test paths, not paths relative to this config.
    poolMatchGlobs: realGitTestFiles.map(file => [`**/${file}`, 'forks'] as [string, 'forks']),
    poolOptions: { forks: { minForks: 1, maxForks: workers.gitForks } },
  },
});
