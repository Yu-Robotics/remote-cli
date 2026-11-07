import { createHash, randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { constants } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { gitText, runGit } from './GitCheckpoint';
import { replaceAtomicFile } from './AtomicFile';
import type { DelegatedWorkspace } from './DelegatedWorkspaceManager';
import { assertDisposableTree } from './WorkspaceDisposal';
import { syncDirectory } from './OwnershipRuntime';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const RECORD_LIMIT = 128 * 1024;
const PLAN_LIMIT = 8 * 1024 * 1024;
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const inside = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Unknown inspection failure';
function metadata(bytes: Buffer): any {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('Invalid cleanup metadata JSON'); }
}

export interface CleanupLimits { entries: number; bytes: number; seconds: number }
export interface LegacyCleanupItem {
  kind?: 'scratch';
  scratchId?: string;
  laneId: string;
  /** Absent only on older frozen plans, which cannot retire missing-artifact obligations. */
  taskId?: string;
  workspaceFingerprint?: string;
  directory: string;
  sourceRoot: string;
  commonDirectory: string;
  registration: string;
  fingerprint: string;
  bytes: number;
}
export interface LegacyCleanupInventory {
  version: 1;
  root: string;
  incomplete: boolean;
  limits: CleanupLimits;
  items: LegacyCleanupItem[];
  excluded: Array<{ directory: string; reason: string }>;
  artifacts: Array<{ taskId: string; threadId: string; workspaceGeneration: number; disposition: string }>;
  discardedCheckouts: Array<{ taskId: string; laneId: string; directory: string; fingerprint: string; planHash: string }>;
}
interface CleanupPlan extends LegacyCleanupInventory { id: string; createdAt: string }
interface Progress { version: 1; planHash: string; items: Record<string, 'removing' | 'removed'> }
export interface CleanupOwnership {
  acquire(): Promise<unknown>;
  release(): Promise<unknown>;
  withRepository<T>(commonDirectory: string, callback: () => Promise<T>): Promise<T>;
}
interface CleanupDependencies {
  ownership?: (root: string) => Promise<CleanupOwnership>;
  mountPoints?: () => Promise<string[]>;
  remove?: (source: string, directory: string) => Promise<void>;
  assertOffline?: () => Promise<void>;
}

class Budget {
  entries = 0;
  bytes = 0;
  private readonly deadline: number;
  constructor(readonly limits: CleanupLimits) { this.deadline = Date.now() + limits.seconds * 1000; }
  check(entries = 0, bytes = 0): void {
    this.entries += entries; this.bytes += bytes;
    if (this.entries > this.limits.entries || this.bytes > this.limits.bytes || Date.now() > this.deadline) {
      throw new Error('Inventory budget exhausted; increase explicit scan limits and create a new plan');
    }
  }
}

/** Linux mount information includes same-device bind mounts; dev comparisons alone do not. */
async function localMountPoints(): Promise<string[]> {
  if (process.platform !== 'linux') throw new Error('Mount-boundary verification is unavailable on this platform; discard is disabled');
  const data = await boundedRead('/proc/self/mountinfo', 4 * 1024 * 1024, false);
  return data.toString('utf8').trim().split('\n').map(line => {
    const mount = line.split(' ')[4];
    if (!mount?.startsWith('/')) throw new Error('Unrecognized mount information');
    return mount.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
  });
}

async function canonicalDirectory(directory: string): Promise<void> {
  // NTFS file IDs can exceed Number.MAX_SAFE_INTEGER. Keep exact identities on every host.
  const stat = await fs.lstat(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.ino <= 0n
    || await fs.realpath(directory) !== directory) {
    throw new Error('Noncanonical or symbolic-link directory');
  }
}

async function boundedRead(file: string, limit = RECORD_LIMIT, ordinary = true): Promise<Buffer> {
  const before = await fs.lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.ino <= 0n
    || before.size > BigInt(limit)) throw new Error('Unsafe or oversized metadata file');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino) throw new Error('Metadata identity changed');
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size <= limit) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (size > limit || (ordinary && (opened.size !== BigInt(size) || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs))) {
      throw new Error('Metadata changed or exceeded its bound');
    }
    return buffer.subarray(0, size);
  } finally { await handle.close(); }
}

async function entries(directory: string, budget: Budget): Promise<string[]> {
  await canonicalDirectory(directory);
  const names: string[] = [];
  const handle = await fs.opendir(directory);
  for await (const entry of handle) { budget.check(1); names.push(entry.name); }
  return names.sort();
}

async function durableWrite(file: string, value: unknown, exclusive = false): Promise<void> {
  await canonicalDirectory(path.dirname(file));
  const bytes = JSON.stringify(value);
  if (Buffer.byteLength(bytes) > PLAN_LIMIT) throw new Error('Cleanup metadata is too large');
  const temporary = exclusive ? file : `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  if (!exclusive) await replaceAtomicFile(temporary, file);
  // Directory fsync is supported on Unix; Windows rejects directory handles.
  if (process.platform !== 'win32') {
    const parent = await fs.open(path.dirname(file), 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  }
}

/** Admission must treat both pending and completed tombstones as unavailable, never as an exit receipt. */
export async function hasLegacyDiscardTombstone(workerRoot: string, laneId: string): Promise<boolean> {
  if (!UUID.test(laneId)) throw new Error('Invalid lane ID');
  try {
    await canonicalDirectory(workerRoot);
    const directory = path.join(workerRoot, 'legacy-discarded');
    await canonicalDirectory(directory);
    await fs.lstat(path.join(directory, `${laneId}.json`)); return true;
  }
  catch (error) { if (missing(error)) return false; throw error; }
}

/** A completed explicit loss retires only the original checkout, never an artifact or native session. */
export async function completedLegacyDiscard(workspaceRoot: string, laneId: string, taskId: string,
  charge?: (bytes: number) => void): Promise<
  { fingerprint: string; planHash: string } | undefined> {
  if (!UUID.test(laneId) || !UUID.test(taskId)) return undefined;
  try {
    await canonicalDirectory(workspaceRoot);
    await canonicalDirectory(path.join(workspaceRoot, 'lanes'));
    const workerRoot = path.join(path.dirname(workspaceRoot), 'delegation-workers');
    await canonicalDirectory(workerRoot);
    const markers = path.join(workerRoot, 'legacy-discarded');
    await canonicalDirectory(markers);
    const markerBytes = await boundedRead(path.join(markers, `${laneId}.json`));
    charge?.(markerBytes.length);
    const marker = metadata(markerBytes);
    const receipt = await boundedRead(path.join(workspaceRoot, 'lanes', `${laneId}.json`));
    charge?.(receipt.length);
    const workspace = metadata(receipt);
    if (marker.version !== 1 || marker.state !== 'removed' || marker.kind !== undefined || marker.scratchId !== undefined
      || marker.laneId !== laneId || marker.taskId !== taskId || workspace.laneId !== laneId || workspace.taskId !== taskId
      || marker.workspaceFingerprint !== digest(receipt) || !HASH.test(marker.fingerprint) || !HASH.test(marker.planHash)
      || marker.directory !== workspace.directory || marker.sourceRoot !== workspace.source?.root
      || marker.commonDirectory !== workspace.source?.commonDirectory
      || marker.directory !== path.join(workspaceRoot, 'trees', digest(marker.sourceRoot), laneId)
      || typeof marker.registration !== 'string' || path.dirname(marker.registration) !== path.join(marker.commonDirectory, 'worktrees')) return undefined;
    await canonicalDirectory(marker.sourceRoot);
    await canonicalDirectory(marker.commonDirectory);
    await canonicalDirectory(path.dirname(marker.directory));
    try { await canonicalDirectory(path.dirname(marker.registration)); }
    catch (error) { if (!missing(error)) throw error; }
    for (const location of [marker.directory, marker.registration]) {
      try { await fs.lstat(location); return undefined; }
      catch (error) { if (!missing(error)) throw error; }
    }
    return { fingerprint: marker.fingerprint, planHash: marker.planHash };
  } catch {
    // Missing, legacy, malformed or inaccessible evidence is not retirement proof.
    return undefined;
  }
}

/**
 * Guarded loss of checkout contents. Frozen plans require offline ownership;
 * exact terminal failures support online disposal. Refs and native records are retained.
 * A ready label is not strict reclamation proof. Lane discard never manufactures
 * the reclaiming/reclaimed receipts required for safe native rehydration.
 * Shared ownership fences cooperating CLI writers, not arbitrary OS-user filesystem mutations.
 * Scan deadlines are checked between I/O operations; they do not cancel stalled filesystem reads.
 */
export class LegacyWorkspaceCleanup {
  readonly root: string;
  readonly workerRoot: string;
  private readonly workspaceRoot: string;
  constructor(remoteCliDirectory: string, private readonly dependencies: CleanupDependencies = {}) {
    this.root = path.resolve(remoteCliDirectory);
    this.workerRoot = path.join(this.root, 'delegation-workers');
    this.workspaceRoot = path.join(this.root, 'delegation-workspaces');
  }

  async scan(limits: CleanupLimits = { entries: 100_000, bytes: 1024 ** 3, seconds: 120 }): Promise<LegacyCleanupInventory> {
    this.validateLimits(limits);
    const inventory: LegacyCleanupInventory = { version: 1, root: this.root, incomplete: false, limits,
      items: [], excluded: [], artifacts: [], discardedCheckouts: [] };
    const budget = new Budget(limits);
    try { await fs.lstat(this.root); } catch (error) { if (missing(error)) return inventory; throw error; }
    try {
      await canonicalDirectory(this.root);
      const mounts = await (this.dependencies.mountPoints ?? localMountPoints)();
      for (const bucket of ['lanes', 'artifacts', 'trees']) {
        const location = path.join(this.workspaceRoot, bucket);
        try { await fs.lstat(location); } catch (error) { if (missing(error)) continue; throw error; }
        await canonicalDirectory(this.workspaceRoot);
        if (bucket === 'lanes') {
          for (const name of await entries(location, budget)) {
            const laneId = name.slice(0, -5);
            if (!name.endsWith('.json') || !UUID.test(laneId)) continue;
            const data = await boundedRead(path.join(location, name)); budget.check(0, data.length);
            const workspace = metadata(data);
            const discarded = await completedLegacyDiscard(this.workspaceRoot, laneId, workspace.taskId,
              bytes => budget.check(0, bytes));
            budget.check();
            if (discarded) inventory.discardedCheckouts.push({ laneId, taskId: workspace.taskId,
              directory: workspace.directory, ...discarded });
          }
        } else if (bucket === 'artifacts') {
          for (const name of await entries(location, budget)) {
            budget.check();
            if (!UUID.test(name.slice(0, -5)) || !name.endsWith('.json')) throw new Error('Unknown artifact metadata');
            const data = await boundedRead(path.join(location, name)); budget.check(0, data.length);
            const artifact = metadata(data);
            if (typeof artifact.threadId !== 'string' || artifact.threadId.length > 200
              || !Number.isSafeInteger(artifact.workspaceGeneration) || !['pending', 'retained', 'applied'].includes(artifact.disposition)) throw new Error('Invalid artifact summary metadata');
            inventory.artifacts.push({ taskId: name.slice(0, -5), threadId: artifact.threadId,
              workspaceGeneration: artifact.workspaceGeneration, disposition: artifact.disposition });
          }
        } else if (bucket === 'trees') {
          for (const hash of await entries(location, budget)) {
            budget.check();
            const group = path.join(location, hash);
            if (!HASH.test(hash)) { inventory.excluded.push({ directory: group, reason: 'Unknown repository bucket' }); continue; }
            try {
              await this.safeBoundary(group, mounts);
              for (const lane of await entries(group, budget)) {
                budget.check();
                const directory = path.join(group, lane);
                try { inventory.items.push(await this.inspect(directory, mounts, budget)); }
                catch (error) {
                  inventory.excluded.push({ directory, reason: errorText(error) });
                  if (/budget|EACCES|changed/i.test(errorText(error))) inventory.incomplete = true;
                }
              }
            } catch (error) { inventory.excluded.push({ directory: group, reason: errorText(error) }); inventory.incomplete = true; }
          }
        }
      }
      await this.scanScratch(inventory, mounts, budget);
    } catch (error) {
      inventory.incomplete = true;
      inventory.excluded.push({ directory: this.workspaceRoot, reason: errorText(error) });
    }
    return inventory;
  }

  private async scanScratch(inventory: LegacyCleanupInventory, mounts: string[], budget: Budget): Promise<void> {
    try { await fs.lstat(this.workspaceRoot); } catch (error) { if (missing(error)) return; throw error; }
    await this.safeBoundary(this.workspaceRoot, mounts);
    const candidates = new Map<string, string>();
    for (const name of await entries(this.workspaceRoot, budget)) {
      if (!name.startsWith('integration-')) continue;
      const directory = path.join(this.workspaceRoot, name);
      const id = name.slice('integration-'.length);
      if (!UUID.test(id)) inventory.excluded.push({ directory, reason: 'Unknown integration scratch directory; retained' });
      else candidates.set(id, directory);
    }
    const receipts = path.join(this.workspaceRoot, 'scratch');
    let present = false;
    try { await fs.lstat(receipts); present = true; } catch (error) { if (!missing(error)) throw error; }
    if (present) {
      for (const name of await entries(receipts, budget)) {
        const receipt = path.join(receipts, name);
        const id = name.slice(0, -5);
        if (!name.endsWith('.json') || !UUID.test(id)) {
          inventory.excluded.push({ directory: receipt, reason: 'Unknown scratch receipt; retained' });
        } else if (!candidates.has(id)) {
          // Inspect orphan metadata without interpreting its directory as deletion authority.
          let reason = 'Scratch checkout is absent; receipt retained';
          try {
            const bytes = await boundedRead(receipt); budget.check(0, bytes.length);
            const record = metadata(bytes);
            if (record.id !== id || record.directory !== path.join(this.workspaceRoot, `integration-${id}`)) {
              reason = 'Scratch receipt identity does not match its owned path; retained';
            }
          } catch (error) {
            reason = errorText(error);
            if (/budget|EACCES|changed/i.test(reason)) inventory.incomplete = true;
          }
          inventory.excluded.push({ directory: receipt, reason });
        }
      }
    }
    for (const directory of candidates.values()) {
      try { inventory.items.push(await this.inspect(directory, mounts, budget)); }
      catch (error) {
        inventory.excluded.push({ directory, reason: errorText(error) });
        if (/budget|EACCES|changed/i.test(errorText(error))) inventory.incomplete = true;
      }
    }
  }

  async plan(file: string, limits?: CleanupLimits): Promise<LegacyCleanupInventory> {
    const destination = path.resolve(file);
    this.assertExternal(destination);
    const inventory = await this.scan(limits);
    if (inventory.incomplete) throw new Error('Incomplete inventory cannot become an executable plan');
    const plan: CleanupPlan = { ...inventory, id: randomUUID(), createdAt: new Date().toISOString() };
    await durableWrite(destination, plan, true);
    return inventory;
  }

  async discard(file: string, flags: { discardContents: boolean; confirmWorkersStopped: boolean }): Promise<{ removed: number; errors: string[] }> {
    if (flags.discardContents !== true || flags.confirmWorkersStopped !== true) {
      throw new Error('Require --discard-contents and --confirm-workers-stopped; stop the daemon and all native workers manually first');
    }
    const planPath = path.resolve(file); this.assertExternal(planPath);
    await canonicalDirectory(path.dirname(planPath));
    const bytes = await boundedRead(planPath, PLAN_LIMIT);
    const plan = metadata(bytes) as CleanupPlan;
    if (plan.version !== 1 || plan.root !== this.root || plan.incomplete !== false || !UUID.test(plan.id)
      || !Array.isArray(plan.items) || plan.items.length > 100_000) throw new Error('Invalid or incomplete cleanup plan');
    this.validateLimits(plan.limits);
    const planHash = digest(bytes);
    const journalFile = `${planPath}.progress.json`;
    const journal: Progress = { version: 1, planHash, items: {} };
    try {
      const previous = metadata(await boundedRead(journalFile, PLAN_LIMIT));
      if (previous.version !== 1 || previous.planHash !== planHash || !previous.items || typeof previous.items !== 'object') throw new Error('Cleanup progress does not match the frozen plan');
      journal.items = previous.items;
    } catch (error) { if (!missing(error)) throw error; }
    await canonicalDirectory(this.root); await canonicalDirectory(this.workerRoot);
    await this.assertOffline();
    const ownership = await this.owner();
    await ownership.acquire();
    try {
      await this.assertOffline();
      const result = { removed: 0, errors: [] as string[] };
      for (const item of plan.items) {
        try {
          this.validateItem(item);
          const key = this.itemKey(item);
          await ownership.withRepository(item.commonDirectory, async () => {
            await this.assertOffline();
            const mounts = await (this.dependencies.mountPoints ?? localMountPoints)();
            await this.safeBoundary(this.workspaceRoot, mounts);
            if (journal.items[key] === 'removed') {
              await this.verifyIntent(item, planHash);
              await this.confirmRemoved(item); result.removed++; return;
            }
            let pending = journal.items[key] === 'removing';
            if (!pending && item.kind === 'scratch') {
              let markerExists = false;
              try { await fs.lstat(this.markerPath(item)); markerExists = true; }
              catch (error) { if (!missing(error)) throw error; }
              if (markerExists) {
                // Recover a crash between the durable scratch intent and journal.
                const state = await this.verifyIntent(item, planHash);
                if (state === 'removed') {
                  await this.confirmRemoved(item);
                  journal.items[key] = 'removed'; await durableWrite(journalFile, journal);
                  result.removed++; return;
                }
                pending = true;
              }
            }
            let absent = false;
            try { await fs.lstat(item.directory); } catch (error) { if (!missing(error)) throw error; absent = true; }
            if (pending) {
              await this.verifyIntent(item, planHash);
            }
            if (pending && absent) await this.confirmRemoved(item);
            else {
              const current = await this.inspect(item.directory, mounts, new Budget(plan.limits));
              if (current.fingerprint !== item.fingerprint || current.registration !== item.registration
                || item.taskId !== undefined && (current.taskId !== item.taskId || current.workspaceFingerprint !== item.workspaceFingerprint)
                || current.kind !== item.kind || current.scratchId !== item.scratchId || current.laneId !== item.laneId
                || current.commonDirectory !== item.commonDirectory || current.sourceRoot !== item.sourceRoot) throw new Error('Frozen checkout or receipt changed; create a new plan');
              if (!pending) {
                try { await fs.lstat(this.markerPath(item)); throw new Error('Target has a prior discard intent; manual quiescent recovery is required'); }
                catch (error) { if (!missing(error)) throw error; }
              }
              await fs.mkdir(path.dirname(this.markerPath(item)), { recursive: true, mode: 0o700 });
              await this.tombstone(item, planHash, 'pending');
              journal.items[key] = 'removing'; await durableWrite(journalFile, journal);
              await (this.dependencies.remove ?? (async (source, directory) => { await runGit(source, ['worktree', 'remove', '--force', directory]); }))(item.sourceRoot, item.directory);
              await this.confirmRemoved(item);
            }
            await this.tombstone(item, planHash, 'removed');
            journal.items[key] = 'removed'; await durableWrite(journalFile, journal);
            result.removed++;
          });
        } catch (error) { result.errors.push(`${this.itemKey(item)}: ${errorText(error)}`); }
      }
      return result;
    } finally { await ownership.release(); }
  }

  /**
   * Exact terminal failed-worker loss, independent of native-history deletion.
   * Online callers lend their real storage owner. A standalone caller acquires
   * its own maintenance lease and the SAME native repository lease as the daemon.
   * The pending compatible tombstone fences old-binary lane admission before loss.
   */
  async discardFailedWorker(laneId: string, taskId: string, owner?: CleanupOwnership): Promise<{ removed: true }> {
    if (!UUID.test(laneId) || !UUID.test(taskId)) throw new Error('Invalid failed-worker target');
    await canonicalDirectory(this.root); await canonicalDirectory(this.workerRoot);
    await canonicalDirectory(this.workspaceRoot); await canonicalDirectory(path.join(this.workspaceRoot, 'lanes'));
    await canonicalDirectory(path.join(this.workspaceRoot, 'artifacts'));
    const file = path.join(this.workspaceRoot, 'lanes', `${laneId}.json`);
    const workspaceBytes = await boundedRead(file);
    const workspace = metadata(workspaceBytes) as DelegatedWorkspace;
    if (workspace.taskId !== taskId || workspace.laneId !== laneId) throw new Error('Failed-worker task was rebound');
    let standalone: CleanupOwnership | undefined;
    if (!owner) {
      const modulePath = './DelegationOwnership';
      const { DelegationOwnership } = await import(modulePath);
      // This is real, journaled ownership, not a replacement for the daemon's
      // live storage lease. Repository exclusion and the terminal lane fence
      // allow unrelated daemon workers to continue using their existing owner.
      const lease: CleanupOwnership = new DelegationOwnership(path.join(this.root, 'failed-worker-disposal'));
      await lease.acquire(); standalone = lease; owner = lease;
    }
    try {
      return await owner!.withRepository(workspace.source.commonDirectory, async () => {
        await canonicalDirectory(this.root); await canonicalDirectory(this.workerRoot);
        if (!(await boundedRead(file)).equals(workspaceBytes)) throw new Error('Failed-worker workspace changed');
        if (await completedLegacyDiscard(this.workspaceRoot, laneId, taskId)) return { removed: true as const };
        const worker = metadata(await boundedRead(path.join(this.workerRoot, `${laneId}.json`)));
        const generation = worker.contextGeneration ?? 0;
        const workerKey = () => JSON.stringify([worker.id, worker.executorThreadId, worker.threadId, worker.workingDirectory,
          worker.workspaceGeneration, generation, worker.nativeGroupExitGeneration, worker.shutdownConfirmedGeneration]);
        const proof = workerKey();
        const artifactFile = path.join(this.workspaceRoot, 'artifacts', `${taskId}.json`);
        const backupFile = path.join(this.workerRoot, 'failed-disposal-intents', `${laneId}.artifact.json`);
        let artifactHash: string | undefined;
        try {
          const artifactBytes = await boundedRead(artifactFile);
          const artifact = metadata(artifactBytes);
          if (artifact.taskId !== taskId || artifact.laneId !== laneId || artifact.threadId !== workspace.threadId
            || artifact.disposalPolicy !== 1 || artifact.recovery || artifact.closeout?.taskId !== taskId
            || artifact.closeout?.recoverable !== false || !['applied', 'pending', 'retained'].includes(artifact.disposition)
            || artifact.workspaceGeneration !== workspace.workspaceGeneration
            || artifact.source?.root !== workspace.source.root || artifact.source?.cwd !== workspace.source.cwd
            || artifact.source?.commonDirectory !== workspace.source.commonDirectory || artifact.source?.relativeCwd !== workspace.source.relativeCwd
            || artifact.input?.commit !== workspace.input.commit || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(artifact.output ?? '')
            || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(artifact.tree ?? '')
            || artifact.closeout.output !== artifact.output || artifact.closeout.tree !== artifact.tree) {
            throw new Error('A valid pending artifact or parent recovery record must be preserved');
          }
          artifactHash = digest(artifactBytes);
        } catch (error) { if (!missing(error)) throw error; }
        let terminalRecord: { id: string; threadId: string; state: string; startedAt: number; finishedAt: number } | undefined;
        const assertEligible = async () => {
          for (const directory of [this.workerRoot, this.workspaceRoot, path.join(this.workspaceRoot, 'lanes'),
            path.join(this.workspaceRoot, 'artifacts')]) await canonicalDirectory(directory);
          const current = metadata(await boundedRead(path.join(this.workerRoot, `${laneId}.json`)));
          if (current.id !== laneId || current.executorThreadId !== `delegate-lane-${laneId}`
            || current.threadId !== workspace.threadId || current.workingDirectory !== workspace.source.cwd
            || current.workspaceGeneration !== workspace.workspaceGeneration || !Number.isSafeInteger(generation) || generation < 0
            || JSON.stringify([current.id, current.executorThreadId, current.threadId, current.workingDirectory,
            current.workspaceGeneration, current.contextGeneration ?? 0, current.nativeGroupExitGeneration,
            current.shutdownConfirmedGeneration]) !== proof || current.state !== 'dirty' || current.cleanupPending === true
            || current.nativeHistoryExitUnconfirmed === true || current.nativeMaintenanceExitUnconfirmed === true
            || current.nativeGroupExitGeneration !== generation || current.shutdownConfirmedGeneration !== generation
            || workspace.directory !== path.join(this.workspaceRoot, 'trees', digest(workspace.source.root), laneId)
            || workspace.cwd !== path.join(workspace.directory, workspace.source.relativeCwd)
            || workspace.disposalPolicy !== 1 || workspace.checkoutState !== 'present'
            || workspace.pendingTaskId !== undefined && workspace.pendingTaskId !== taskId
            || workspace.cleanup?.reason !== 'capture-failed' && workspace.failedCollection?.taskId !== taskId) throw new Error('Failed worker exit, failure or acquisition identity is unconfirmed');
          if (!(await boundedRead(file)).equals(workspaceBytes)) throw new Error('Failed-worker workspace changed');
          try {
            const artifact = await boundedRead(artifactFile);
            if (!artifactHash || digest(artifact) !== artifactHash) throw new Error('Artifact changed; preserve parent output');
          } catch (error) { if (!missing(error)) throw error; }
          if (workspace.failedCollection?.taskId === taskId
            && ['failed', 'cancelled', 'timed_out', 'interrupted'].includes(workspace.failedCollection.state)
            && workspace.exitConfirmation?.taskId === taskId
            && workspace.exitConfirmation.contextGeneration === generation && Number.isFinite(workspace.exitConfirmation.confirmedAt)
            && workspace.exitConfirmation.confirmedAt > 0) return;
          let task: any;
          try {
            await canonicalDirectory(path.join(this.root, 'delegation'));
            task = metadata(await boundedRead(path.join(this.root, 'delegation', `${taskId}.json`)));
          }
          catch (error) {
            if (!missing(error)) throw error;
            const directory = path.join(this.workerRoot, 'failed-disposal-intents');
            await canonicalDirectory(directory);
            const prepared = metadata(await boundedRead(path.join(directory, `${laneId}.json`)));
            if (prepared.version !== 1 || prepared.proof !== proof || prepared.item?.taskId !== taskId
              || prepared.item?.workspaceFingerprint !== digest(workspaceBytes)) throw new Error('Prepared terminal evidence changed');
            task = prepared.terminal;
          }
          if (!task || task.id !== taskId || task.threadId !== workspace.threadId || !['failed', 'cancelled', 'timed_out', 'interrupted'].includes(task.state)
            || !Number.isFinite(task.finishedAt) || !Number.isFinite(task.startedAt) || task.finishedAt < task.startedAt) {
            throw new Error('Legacy target has no matching terminal failed task');
          }
          terminalRecord = { id: task.id, threadId: task.threadId, state: task.state, startedAt: task.startedAt, finishedAt: task.finishedAt };
        };
        await assertEligible();
        const directory = path.join(this.workerRoot, 'failed-disposal-intents');
        await fs.mkdir(directory, { recursive: true, mode: 0o700 }); await canonicalDirectory(directory);
        syncDirectory(this.workerRoot);
        const intentFile = path.join(directory, `${laneId}.json`);
        let intent: { version: number; proof: string; item: LegacyCleanupItem; artifactHash?: string; terminal?: typeof terminalRecord; identities: Array<[string, string, string]> };
        let bytes: Buffer;
        try { bytes = await boundedRead(intentFile); intent = metadata(bytes); }
        catch (error) {
          if (!missing(error)) throw error;
          const mounts = await (this.dependencies.mountPoints ?? localMountPoints)();
          await assertDisposableTree(workspace.directory, mounts, true, await this.credentialTemplates(workspace));
          const item = await this.inspect(workspace.directory, mounts, new Budget({ entries: 500_000, bytes: 1024 ** 3, seconds: 120 }));
          if (item.taskId !== taskId || item.workspaceFingerprint !== digest(workspaceBytes)
            || !workspace.checkoutIdentity) throw new Error('Failed worker identity is unavailable');
          await assertDisposableTree(item.directory, mounts, true, await this.credentialTemplates(workspace));
          const identities: Array<[string, string, string]> = [];
          for (const target of [item.directory, item.registration, item.sourceRoot, item.commonDirectory]) {
            const stat = await fs.lstat(target, { bigint: true });
            if (process.getuid && stat.uid !== BigInt(process.getuid())) throw new Error('Failed worker is not owned by this OS user');
            identities.push([target, String(stat.dev), String(stat.ino)]);
            if (target === item.directory && (Number(stat.dev) !== workspace.checkoutIdentity.dev || Number(stat.ino) !== workspace.checkoutIdentity.ino)) throw new Error('Failed checkout was replaced');
          }
          intent = { version: 1, proof, item, identities, ...(terminalRecord ? { terminal: terminalRecord } : {}), ...(artifactHash ? { artifactHash } : {}) };
          await durableWrite(intentFile, intent, true); bytes = await boundedRead(intentFile);
        }
        if (intent.terminal && terminalRecord && JSON.stringify(intent.terminal) !== JSON.stringify(terminalRecord)) throw new Error('Terminal task evidence changed');
        if (intent.artifactHash !== undefined) {
          if (!HASH.test(intent.artifactHash) || artifactHash && artifactHash !== intent.artifactHash) throw new Error('Prepared failed artifact changed');
          artifactHash = intent.artifactHash;
          if (!await this.exists(artifactFile) && (!await this.exists(backupFile)
            || digest(await boundedRead(backupFile)) !== artifactHash)) throw new Error('Failed artifact recovery evidence is missing');
        } else if (artifactHash) throw new Error('An artifact appeared after failed disposal preparation');
        const item = intent.item;
        this.validateItem(item);
        if (intent.version !== 1 || intent.proof !== proof || item.laneId !== laneId || item.taskId !== taskId
          || item.workspaceFingerprint !== digest(workspaceBytes) || item.directory !== workspace.directory
          || item.sourceRoot !== workspace.source.root || item.commonDirectory !== workspace.source.commonDirectory
          || !Array.isArray(intent.identities) || intent.identities.length !== 4) throw new Error('Failed-worker disposal intent changed');
        const expectedPaths = [item.directory, item.registration, item.sourceRoot, item.commonDirectory];
        if (intent.identities.some((entry, index) => !Array.isArray(entry) || entry.length !== 3
          || entry[0] !== expectedPaths[index] || !/^[0-9]+$/.test(entry[1]) || !/^[1-9][0-9]*$/.test(entry[2]))
          || !workspace.checkoutIdentity || intent.identities[0][1] !== String(workspace.checkoutIdentity.dev)
          || intent.identities[0][2] !== String(workspace.checkoutIdentity.ino)) throw new Error('Failed-worker identity manifest changed');
        const planHash = digest(bytes!);
        const verify = async () => {
          await assertEligible();
          await canonicalDirectory(directory);
          if (!(await boundedRead(intentFile)).equals(bytes!)) throw new Error('Failed-worker disposal intent changed');
          const mounts = await (this.dependencies.mountPoints ?? localMountPoints)();
          await this.safeBoundary(this.workspaceRoot, mounts);
          for (const [target, dev, ino] of intent.identities) {
            try {
              await canonicalDirectory(target); const stat = await fs.lstat(target, { bigint: true });
              if (String(stat.dev) !== dev || String(stat.ino) !== ino) throw new Error('Failed-worker target was replaced');
              await this.safeBoundary(target, mounts);
            } catch (error) { if (!missing(error) || target !== item.directory && target !== item.registration) throw error; }
          }
          if (await this.exists(item.registration)) {
            const back = (await boundedRead(path.join(item.registration, 'gitdir'))).toString('utf8').trim();
            const common = (await boundedRead(path.join(item.registration, 'commondir'))).toString('utf8').trim();
            if (path.resolve(back) !== path.join(item.directory, '.git')
              || await fs.realpath(path.resolve(item.registration, common)) !== item.commonDirectory) throw new Error('Failed registration was rebound');
            for (const name of ['locked', 'config.worktree']) if (await this.exists(path.join(item.registration, name))) throw new Error('Failed registration is locked or separately configured');
            if (await this.exists(path.join(item.directory, '.git'))
              && (await boundedRead(path.join(item.directory, '.git'))).toString('utf8').trim() !== `gitdir: ${item.registration}`) throw new Error('Failed checkout registration changed');
          }
          if (await this.exists(item.directory)) await assertDisposableTree(item.directory, mounts, true, await this.credentialTemplates(workspace));
        };
        await verify();
        await fs.mkdir(path.dirname(this.markerPath(item)), { recursive: true, mode: 0o700 });
        syncDirectory(this.workerRoot);
        try { await this.verifyIntent(item, planHash); }
        catch (error) { if (!missing(error)) throw error; await this.tombstone(item, planHash, 'pending', 'Authorized terminal failed-worker disposal; native history is preserved'); }
        await verify();
        if (await this.exists(item.directory) || await this.exists(item.registration)) {
          await (this.dependencies.remove ?? (async (source, target) => runGit(source, ['worktree', 'remove', '--force', target]).then(() => undefined)))(item.sourceRoot, item.directory);
        }
        await this.confirmRemoved(item);
        await verify();
        if (artifactHash && await this.exists(artifactFile)) {
          if (await this.exists(backupFile)) throw new Error('Failed artifact backup already exists');
          if (digest(await boundedRead(artifactFile)) !== artifactHash) throw new Error('Failed artifact changed before preservation');
          await fs.rename(artifactFile, backupFile);
          const handle = await fs.open(backupFile, 'r');
          try { await handle.sync(); } finally { await handle.close(); }
          if (digest(await boundedRead(backupFile)) !== artifactHash) throw new Error('Failed artifact backup changed');
          if (process.platform !== 'win32') {
            for (const directory of [path.dirname(artifactFile), path.dirname(backupFile)]) {
              const handle = await fs.open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); }
            }
          }
        }
        await this.tombstone(item, planHash, 'removed', 'Authorized terminal failed-worker disposal; native history is preserved');
        return { removed: true };
      });
    } finally { await standalone?.release(); }
  }

  /** Only unchanged, tracked public-template copies may be removed; originals and input blobs remain. */
  private async credentialTemplates(workspace: DelegatedWorkspace): Promise<Set<string>> {
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(workspace.input.tree)) throw new Error('Failed input tree is unverified');
    const identity = await fs.lstat(workspace.directory);
    if (!identity.isDirectory() || identity.isSymbolicLink() || identity.dev !== workspace.checkoutIdentity?.dev
      || identity.ino !== workspace.checkoutIdentity?.ino) throw new Error('Failed checkout was replaced');
    const entries = (await runGit(workspace.source.root, ['ls-tree', '-r', '-z', workspace.input.tree])).toString('utf8').split('\0');
    const allowed = new Set<string>();
    for (const entry of entries) {
      const match = /^100(?:644|755) blob ([a-f0-9]+)\t(.+)$/.exec(entry);
      if (!match || !/^\.env\.(example|sample|template)$/i.test(path.basename(match[2]))) continue;
      const file = path.join(workspace.directory, match[2]);
      try {
        if (!inside(workspace.directory, file) || await fs.realpath(path.dirname(file)) !== path.dirname(file)) throw new Error('Failed template path changed');
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        if (await gitText(workspace.source.root, ['hash-object', '--no-filters', '--', file]) === match[1]) allowed.add(file);
      } catch (error) { if (!missing(error)) throw error; }
    }
    return allowed;
  }

  private async exists(file: string): Promise<boolean> {
    try { await fs.lstat(file); return true; } catch (error) { if (missing(error)) return false; throw error; }
  }

  private async owner(): Promise<CleanupOwnership> {
    if (this.dependencies.ownership) return this.dependencies.ownership(this.workerRoot);
    // Shared with daemon admission. No stale-PID takeover or private cleanup lock.
    const modulePath = './DelegationOwnership';
    const { DelegationOwnership } = await import(modulePath);
    return new DelegationOwnership(this.workerRoot);
  }

  private async assertOffline(): Promise<void> {
    if (this.dependencies.assertOffline) return this.dependencies.assertOffline();
    try {
      const config = metadata(await boundedRead(path.join(this.root, 'config.json')));
      const service = config.service;
      if (service?.running === true) throw new Error('Daemon is recorded as running; stop it explicitly before discard');
      if (service?.pid !== undefined) {
        if (!Number.isSafeInteger(service.pid) || service.pid <= 0) throw new Error('Unknown daemon PID state');
        try { process.kill(service.pid, 0); throw new Error('Configured daemon PID still exists'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
    } catch (error) { if (!missing(error)) throw error; }
    const home = path.dirname(this.root);
    const unit = path.join(home, '.config', 'systemd', 'user', 'remote-cli.service');
    if (process.platform === 'linux') {
      let installed = false;
      try { await fs.lstat(unit); installed = true; } catch (error) { if (!missing(error)) throw error; }
      if (installed) {
        const status = await new Promise<string>((resolve, reject) => {
          execFile('systemctl', ['--user', 'show', 'remote-cli.service', '--property=ActiveState,MainPID', '--no-pager'],
            { timeout: 5000, maxBuffer: 16 * 1024, encoding: 'utf8' }, (error, stdout) => {
              if (error) reject(new Error('Cannot verify user service state; stop and verify it manually'));
              else resolve(stdout);
            });
        });
        const values = Object.fromEntries(status.trim().split('\n').map(line => line.split('=')));
        if (values.ActiveState !== 'inactive' || values.MainPID !== '0') throw new Error('User service is active or uncertain; stop it explicitly before discard');
      }
    }
    // This check is a veto, never evidence of worker exit. The explicit offline
    // attestation and root owner are also mandatory, including for older daemons.
  }

  private async safeBoundary(directory: string, mounts: string[]): Promise<void> {
    await canonicalDirectory(directory);
    if (mounts.some(mount => inside(directory, mount))) throw new Error('Mounted directory or descendant is excluded');
  }

  private validateLimits(limits: CleanupLimits): void {
    if (!limits || !Number.isSafeInteger(limits.entries) || limits.entries < 1 || limits.entries > 1_000_000
      || !Number.isSafeInteger(limits.bytes) || limits.bytes < 1 || limits.bytes > 1024 ** 4
      || !Number.isSafeInteger(limits.seconds) || limits.seconds < 1 || limits.seconds > 3600) throw new Error('Invalid inventory limits');
  }

  private validateItem(item: LegacyCleanupItem): void {
    if (!item || !UUID.test(item.laneId)
      || (item.taskId !== undefined || item.workspaceFingerprint !== undefined)
        && (!UUID.test(item.taskId ?? '') || !HASH.test(item.workspaceFingerprint ?? ''))
      || typeof item.sourceRoot !== 'string' || !path.isAbsolute(item.sourceRoot)
      || typeof item.commonDirectory !== 'string' || !path.isAbsolute(item.commonDirectory)
      || typeof item.registration !== 'string' || !inside(path.join(item.commonDirectory, 'worktrees'), item.registration)
      || item.registration === path.join(item.commonDirectory, 'worktrees') || !HASH.test(item.fingerprint)
      || (item.kind !== undefined && item.kind !== 'scratch')
      || (item.kind === 'scratch'
        ? !UUID.test(item.scratchId ?? '') || item.directory !== path.join(this.workspaceRoot, `integration-${item.scratchId}`)
        : item.scratchId !== undefined || item.directory !== path.join(this.workspaceRoot, 'trees', digest(item.sourceRoot), item.laneId))) throw new Error('Foreign or invalid cleanup target');
    if (inside(item.directory, this.root) || inside(item.directory, item.sourceRoot) || inside(this.workspaceRoot, item.sourceRoot)) throw new Error('Source repository overlaps managed storage');
  }

  private assertExternal(file: string): void {
    if (inside(this.workspaceRoot, file) || inside(this.workerRoot, file)) throw new Error('Plan and progress must be outside managed workspace and worker storage');
  }

  private async inspect(directory: string, mounts: string[], budget: Budget): Promise<LegacyCleanupItem> {
    budget.check();
    const name = path.basename(directory);
    const scratchId = name.startsWith('integration-') ? name.slice('integration-'.length) : undefined;
    let laneId = name;
    if (!UUID.test(scratchId ?? laneId)) throw new Error('Unknown lane directory');
    await this.safeBoundary(this.workspaceRoot, mounts);
    await canonicalDirectory(this.workerRoot);
    let receipt: Buffer;
    let laneBytes: Buffer;
    let workspace: any;
    if (scratchId) {
      await canonicalDirectory(path.join(this.workspaceRoot, 'scratch'));
      receipt = await boundedRead(path.join(this.workspaceRoot, 'scratch', `${scratchId}.json`));
      workspace = metadata(receipt);
      laneId = workspace.laneId;
      if (workspace.id !== scratchId || !UUID.test(laneId) || !UUID.test(workspace.taskId)
        || workspace.directory !== directory || !Number.isFinite(workspace.updatedAt) || workspace.updatedAt <= 0
        || !['allocating', 'present', 'conflict', 'cleanup-pending'].includes(workspace.state)
        || !workspace.source || ['root', 'cwd', 'commonDirectory', 'relativeCwd'].some(key => typeof workspace.source[key] !== 'string')) {
        throw new Error('Scratch receipt identity or state does not match its checkout; retained');
      }
      await canonicalDirectory(path.join(this.workspaceRoot, 'artifacts'));
      laneBytes = await boundedRead(path.join(this.workspaceRoot, 'artifacts', `${workspace.taskId}.json`));
      const artifact = metadata(laneBytes);
      if (artifact.taskId !== workspace.taskId || artifact.laneId !== laneId || !artifact.source
        || ['root', 'cwd', 'commonDirectory', 'relativeCwd'].some(key => artifact.source[key] !== workspace.source[key])) {
        throw new Error('Scratch receipt and historical artifact identity do not match; retained');
      }
    } else {
      await canonicalDirectory(path.join(this.workspaceRoot, 'lanes'));
      receipt = await boundedRead(path.join(this.workspaceRoot, 'lanes', `${laneId}.json`));
      laneBytes = await boundedRead(path.join(this.workerRoot, `${laneId}.json`));
      workspace = metadata(receipt);
      const lane = metadata(laneBytes);
      if (workspace.laneId !== laneId || lane.id !== laneId || lane.executorThreadId !== `delegate-lane-${laneId}`
        || !UUID.test(workspace.taskId) || workspace.taskRef !== `refs/remote-cli/tasks/${workspace.taskId}`
        || lane.threadId !== workspace.threadId || lane.workspaceGeneration !== workspace.workspaceGeneration
        || !Number.isSafeInteger(workspace.workspaceGeneration) || workspace.workspaceGeneration < 0
        || lane.workingDirectory !== workspace.source?.cwd || workspace.directory !== directory
        || !['ready', 'dirty', 'preparing', 'running'].includes(lane.state)) throw new Error('Lane and workspace identity do not match');
    }
    budget.check(0, receipt.length + laneBytes.length);
    const source = workspace.source;
    const item: LegacyCleanupItem = { ...(scratchId ? { kind: 'scratch' as const, scratchId } : {}), laneId,
      taskId: workspace.taskId, workspaceFingerprint: digest(receipt), directory, sourceRoot: source.root, commonDirectory: source.commonDirectory,
      registration: path.join(source.commonDirectory, 'worktrees', 'unverified'), fingerprint: '0'.repeat(64), bytes: 0 };
    this.validateItem(item);
    await canonicalDirectory(source.root); await canonicalDirectory(source.commonDirectory);
    if (source.cwd !== path.join(source.root, source.relativeCwd) || !inside(source.root, source.cwd)
      || (!scratchId && workspace.cwd !== path.join(directory, source.relativeCwd))) throw new Error('Working directory identity changed');
    await canonicalDirectory(source.cwd);
    if (await fs.realpath(await gitText(source.root, ['rev-parse', '--show-toplevel'])) !== source.root
      || await fs.realpath(path.resolve(source.root, await gitText(source.root, ['rev-parse', '--git-common-dir']))) !== source.commonDirectory) throw new Error('Source registration changed');
    await this.safeBoundary(directory, mounts);
    const gitfile = (await boundedRead(path.join(directory, '.git'))).toString('utf8').trim();
    if (!gitfile.startsWith('gitdir: ')) throw new Error('Unknown Git registration');
    const registration = path.resolve(directory, gitfile.slice(8));
    if (path.dirname(registration) !== path.join(source.commonDirectory, 'worktrees')) throw new Error('Foreign Git registration');
    await this.safeBoundary(registration, mounts);
    for (const name of ['locked', 'config.worktree']) {
      try { await fs.lstat(path.join(registration, name)); throw new Error('Locked or separately configured worktree is excluded'); }
      catch (error) { if (!missing(error)) throw error; }
    }
    const back = await boundedRead(path.join(registration, 'gitdir'));
    const common = await boundedRead(path.join(registration, 'commondir'));
    const head = await boundedRead(path.join(registration, 'HEAD'));
    if (path.resolve(back.toString('utf8').trim()) !== path.join(directory, '.git')
      || await fs.realpath(path.resolve(registration, common.toString('utf8').trim())) !== source.commonDirectory
      || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head.toString('utf8').trim())) throw new Error('Registration is not an owned detached worktree');
    if (!await this.registered(source.root, directory)) throw new Error('Worktree registration is missing');
    // Version 1 POSIX plans freeze numeric identities and millisecond timestamps.
    // Windows needs exact NTFS IDs and nanoseconds; its native discard remains disabled.
    const statOptions = { bigint: process.platform === 'win32' };
    const hash = createHash('sha256').update(receipt).update(laneBytes).update(back).update(common).update(head);
    for (const location of [source.root, source.commonDirectory, registration]) {
      const identity = await fs.lstat(location, statOptions);
      hash.update(JSON.stringify([location, ...('mtimeNs' in identity
        ? [identity.dev.toString(), identity.ino.toString()] : [identity.dev, identity.ino])]));
    }
    const artifactDirectory = path.join(this.workspaceRoot, 'artifacts');
    try {
      await canonicalDirectory(artifactDirectory);
      const artifact = await boundedRead(path.join(artifactDirectory, `${workspace.taskId}.json`));
      budget.check(0, artifact.length); hash.update(artifact);
    } catch (error) { if (!missing(error)) throw error; hash.update('no-artifact'); }
    const rootStat = await fs.lstat(directory, statOptions);
    const beforeBytes = budget.bytes;
    const walk = async (current: string, depth: number, device = rootStat.dev): Promise<void> => {
      if (depth > 128) throw new Error('Inventory depth budget exhausted');
      budget.check();
      const before = await fs.lstat(current, statOptions);
      if ((typeof before.ino === 'number' && !Number.isSafeInteger(before.ino)) || before.ino <= 0 || before.dev !== device
        || (!before.isFile() && !before.isDirectory() && !before.isSymbolicLink())) throw new Error('Uncertain identity, device boundary, or special file is excluded');
      hash.update(JSON.stringify([path.relative(directory, current), ...('mtimeNs' in before
        ? [before.dev, before.ino, before.mode, before.size, before.mtimeNs, before.ctimeNs].map(value => value.toString())
        : [before.dev, before.ino, before.mode, before.size, before.mtimeMs, before.ctimeMs])]));
      if (before.isSymbolicLink()) {
        // Git removes the link itself. Never enumerate or read its referent.
        hash.update(await fs.readlink(current));
      } else if (before.isDirectory()) {
        const names = await entries(current, budget);
        if (names.includes('HEAD') && names.includes('objects') && names.includes('refs')) throw new Error('Nested bare Git repository is excluded');
        for (const name of names) {
          if (name.toLowerCase() === '.git' && (current !== directory || name !== '.git')) throw new Error('Nested Git repository is excluded');
          await walk(path.join(current, name), depth + 1, device);
        }
      } else {
        const handle = await fs.open(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        try {
          const opened = await handle.stat(statOptions);
          if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('Checkout identity changed');
          const buffer = Buffer.alloc(64 * 1024);
          while (true) {
            budget.check();
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
            if (!bytesRead) break;
            budget.check(0, bytesRead); hash.update(buffer.subarray(0, bytesRead));
          }
        } finally { await handle.close(); }
      }
      const after = await fs.lstat(current, statOptions);
      const timeChanged = 'mtimeNs' in before && 'mtimeNs' in after
        ? before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
        : before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs;
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || timeChanged) throw new Error('Checkout changed during inventory');
    };
    await walk(directory, 0);
    // Conflict stages and merge state can change without changing checkout bytes.
    // Freeze the owned Git administrative files as well as the visible contents.
    await walk(registration, 0, (await fs.lstat(registration, statOptions)).dev);
    return { ...item, registration, fingerprint: hash.digest('hex'), bytes: budget.bytes - beforeBytes };
  }

  private async registered(source: string, directory: string): Promise<boolean> {
    const output = await gitText(source, ['-c', 'core.quotePath=false', 'worktree', 'list', '--porcelain']);
    return output.split('\n').some(line => {
      if (!line.startsWith('worktree ')) return false;
      const value = line.slice(9);
      return path.resolve(value.startsWith('"') ? JSON.parse(value) : value) === directory;
    });
  }

  private async confirmRemoved(item: LegacyCleanupItem): Promise<void> {
    await canonicalDirectory(item.sourceRoot); await canonicalDirectory(item.commonDirectory);
    for (const location of [item.directory, item.registration]) {
      try { await fs.lstat(location); throw new Error('Removal is incomplete; manual quiescent recovery is required'); }
      catch (error) { if (!missing(error)) throw error; }
    }
    if (await this.registered(item.sourceRoot, item.directory)) throw new Error('Removal registration remains; manual recovery is required');
  }

  private async tombstone(item: LegacyCleanupItem, planHash: string, state: 'pending' | 'removed', reason?: string): Promise<void> {
    await durableWrite(this.markerPath(item), {
      ...(item.kind === 'scratch' ? { kind: 'scratch', scratchId: item.scratchId } : {}),
      version: 1, laneId: item.laneId, directory: item.directory, fingerprint: item.fingerprint, planHash, state,
      taskId: item.taskId, workspaceFingerprint: item.workspaceFingerprint,
      sourceRoot: item.sourceRoot, commonDirectory: item.commonDirectory, registration: item.registration,
      // Never an invented successful task, native-session reset, or process-exit receipt.
      reason: reason ?? (item.kind === 'scratch' ? 'Explicit offline integration scratch discard; originating lane and native context are unchanged'
        : 'Explicit offline checkout discard; native context must not be resumed automatically'),
    });
  }

  private itemKey(item: LegacyCleanupItem): string {
    return item?.kind === 'scratch' ? `scratch:${item.scratchId}` : item?.laneId ?? 'unknown';
  }

  private markerPath(item: LegacyCleanupItem): string {
    return path.join(this.workerRoot, item.kind === 'scratch' ? 'legacy-discarded-scratch' : 'legacy-discarded', `${item.scratchId ?? item.laneId}.json`);
  }

  private async verifyIntent(item: LegacyCleanupItem, planHash: string): Promise<'pending' | 'removed'> {
    await canonicalDirectory(path.dirname(this.markerPath(item)));
    const marker = metadata(await boundedRead(this.markerPath(item)));
    if (marker.planHash !== planHash || marker.fingerprint !== item.fingerprint || marker.laneId !== item.laneId
      || marker.taskId !== item.taskId || marker.workspaceFingerprint !== item.workspaceFingerprint
      || item.taskId !== undefined && (marker.sourceRoot !== item.sourceRoot
        || marker.commonDirectory !== item.commonDirectory || marker.registration !== item.registration)
      || marker.directory !== item.directory || marker.kind !== item.kind || marker.scratchId !== item.scratchId
      || !['pending', 'removed'].includes(marker.state)) throw new Error('Discard intent changed; manual recovery is required');
    return marker.state;
  }
}
