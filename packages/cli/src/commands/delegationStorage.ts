import os from 'os';
import path from 'path';
import type { Command } from 'commander';
import { LegacyWorkspaceCleanup, type CleanupLimits } from '../delegation/LegacyWorkspaceCleanup';

export interface DelegationStorageOptions {
  task?: string;
  lane?: string;
  plan?: string;
  out?: string;
  discardContents?: boolean;
  confirmWorkersStopped?: boolean;
  maxEntries?: string;
  maxBytes?: string;
  maxSeconds?: string;
}

/** Local-only output may contain repository paths and thread identities. Never forward it to chat. */
export async function delegationStorageCommand(action: 'scan' | 'plan' | 'discard' | 'discard-failed', options: DelegationStorageOptions = {},
  cleanup = new LegacyWorkspaceCleanup(path.join(os.homedir(), '.remote-cli'))): Promise<unknown> {
  if (action === 'discard-failed') {
    if (!options.task || !options.lane) throw new Error('Require an exact --task and --lane');
    return cleanup.discardFailedWorker(options.lane, options.task);
  }
  const limits: CleanupLimits = { entries: Number(options.maxEntries ?? 100_000), bytes: Number(options.maxBytes ?? 1024 ** 3),
    seconds: Number(options.maxSeconds ?? 120) };
  if (action === 'scan') return cleanup.scan(limits);
  if (action === 'plan') {
    if (!options.out) throw new Error('Require --out with a new manifest file outside managed storage');
    return cleanup.plan(options.out, limits);
  }
  if (!options.plan) throw new Error('Require --plan with a frozen cleanup manifest');
  return cleanup.discard(options.plan, { discardContents: options.discardContents === true,
    confirmWorkersStopped: options.confirmWorkersStopped === true });
}

export function registerDelegationStorage(program: Command): void {
  const storage = program.command('delegation').description('Inspect local managed delegation storage')
    .command('storage').description('Guarded historical and failed-worker maintenance; never stops services');
  storage.command('discard-failed').description('Discard one proven stopped failed worker with no artifact; preserve native history and other workers')
    .requiredOption('--task <id>', 'Exact failed task UUID').requiredOption('--lane <id>', 'Exact owned lane UUID')
    .action(async options => {
      try { console.log(JSON.stringify(await delegationStorageCommand('discard-failed', options))); }
      catch (error) { console.error(error instanceof Error ? error.message : 'Failed-worker disposal held'); process.exitCode = 1; }
    });
  for (const action of ['scan', 'plan', 'discard'] as const) {
    const command = storage.command(action).description(action === 'scan' ? 'Read-only bounded disk inventory (no store initialization)'
      : action === 'plan' ? 'Freeze eligible checkout identities and contents in a new manifest'
        : 'Discard planned checkout contents offline; preserve repositories, artifacts, refs, and native sessions');
    if (action !== 'discard') command.option('--max-entries <count>', 'Inventory entry budget', '100000')
      .option('--max-bytes <count>', 'Total content bytes hashed', String(1024 ** 3))
      .option('--max-seconds <seconds>', 'Inventory deadline checked between I/O operations', '120');
    if (action === 'plan') command.requiredOption('--out <file>', 'New manifest path outside managed storage');
    if (action === 'discard') command.requiredOption('--plan <file>', 'Frozen manifest path')
      .option('--discard-contents', 'Permanently discard tracked, unsubmitted, untracked, and ignored checkout data')
      .option('--confirm-workers-stopped', 'Attest that daemon, supervisors, and ALL native workers are stopped');
    command.action(async options => {
      try {
        const result = await delegationStorageCommand(action, options);
        console.log(JSON.stringify(result, null, 2));
        if (result && typeof result === 'object' && (('incomplete' in result && result.incomplete)
          || ('errors' in result && Array.isArray(result.errors) && result.errors.length))) process.exitCode = 1;
      } catch (error) {
        console.error(error instanceof Error ? error.message : 'Delegation storage maintenance failed');
        process.exitCode = 1;
      }
    });
  }
}
