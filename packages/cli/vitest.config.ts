import { defineConfig } from 'vitest/config';
import os from 'os';
import path from 'path';

export function testWorkerLimits(parallelism: number) {
  const cpus = Number.isFinite(parallelism) ? Math.max(1, Math.floor(parallelism)) : 1;
  const gitForks = cpus >= 8 ? 4 : cpus >= 4 ? 2 : 1;
  return { gitForks, threads: Math.max(1, Math.min(4, cpus - gitForks)) };
}

const workers = testWorkerLimits(os.availableParallelism?.() ?? os.cpus().length);

export const realGitTestFiles = [
  'tests/delegation/GitCheckpoint.test.ts',
  'tests/delegation/SharedSymlinks.test.ts',
  'tests/delegation/gitFixture.test.ts',
  'tests/delegation/DelegatedWorkspaceManager.test.ts',
  'tests/delegation/DelegatedWorkspaceReclamation.test.ts',
  'tests/delegation/DelegatedWorkspaceHistoryDelivery.test.ts',
  'tests/delegation/DelegationGitLifecycle.test.ts',
  'tests/delegation/DelegationWorktrees.test.ts',
  'tests/delegation/DelegationDisposableLifecycle.test.ts',
  'tests/delegation/DisposableWorkspace.test.ts',
  'tests/delegation/LfsCheckout.test.ts',
  'tests/delegation/LegacyWorkspaceCleanup.test.ts',
  'tests/delegation/FailedWorkerDisposal.test.ts',
  'tests/delegation/FailedWorkerLifecycle.test.ts',
  'tests/delegation/NestedRepositories.test.ts',
  'tests/integration/delegation-closeout.test.ts',
];

// Native gates share process file descriptors, not Vitest's module isolation.
// Forking from another test thread can transiently inherit an open lock until
// exec, so release/reacquire assertions require an independent process.
export const nativeOwnershipTestFiles = [
  'tests/scheduling/AgyHookOwnership.test.ts',
  'tests/scheduling/AgyHookRelay.test.ts',
  'tests/executor/AgyAcpRuntime.test.ts',
  'tests/ClaudePersistentExecutor.scheduling.test.ts',
  'tests/ScheduleService.test.ts',
  'tests/MessageHandler.schedule.test.ts',
  'tests/ScheduleRecovery.test.ts',
  'tests/delegation/DelegationOwnership.test.ts',
  'tests/delegation/OwnershipRuntime.test.ts',
  'tests/delegation/ManagedNativeSessionDeletion.test.ts',
  'tests/delegation/ManagedHistoryBackends.test.ts',
  'tests/delegation/ManagedRemainingHistoryBackends.test.ts',
  'tests/integration/thread-context-reset.test.ts',
];
export const processIsolatedTestFiles = [...realGitTestFiles, ...nativeOwnershipTestFiles];

export function processIsolatedTestGlobs(root: string): [string, 'forks'][] {
  // A leading ** does not match hidden ancestors, including delegated checkouts
  // under .remote-cli. Match the literal checkout root, escaping glob syntax.
  const literalRoot = root.replace(/\\/g, '/').replace(/[?*+@!()[\]{}]/g, '\\$&');
  return processIsolatedTestFiles.map(file => [`${literalRoot}/${file}`, 'forks']);
}

export default defineConfig({
  test: {
    // Keep real Git process isolation, but do not serialize every expensive
    // suite on multicore hosts. Reserve capacity for the lightweight threads.
    pool: 'threads',
    minWorkers: 1,
    maxWorkers: workers.threads,
    // Vitest matches absolute test paths, not paths relative to this config.
    poolMatchGlobs: processIsolatedTestGlobs(path.resolve(__dirname)),
    poolOptions: { forks: { minForks: 1, maxForks: workers.gitForks } },
  },
});
