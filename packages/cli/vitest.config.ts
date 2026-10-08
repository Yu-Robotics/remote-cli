import { defineConfig } from 'vitest/config';

export const realGitTestFiles = [
  'tests/delegation/GitCheckpoint.test.ts',
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
    // Real Git suites share one process slot. Lightweight suites retain two
    // independent threads without multiplying Git subprocesses by CPU count.
    pool: 'threads',
    minWorkers: 1,
    maxWorkers: 2,
    // Vitest matches absolute test paths, not paths relative to this config.
    poolMatchGlobs: realGitTestFiles.map(file => [`**/${file}`, 'forks'] as [string, 'forks']),
    poolOptions: { forks: { minForks: 1, maxForks: 1 } },
  },
});
