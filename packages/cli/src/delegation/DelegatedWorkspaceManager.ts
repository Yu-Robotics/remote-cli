import { AsyncLocalStorage } from 'async_hooks';
import type { DelegationOwnership } from './DelegationOwnership';
import { createHash, randomUUID } from 'crypto';
import { constants } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { DelegatedWorkerLane } from './DelegatedWorkerSessionStore';
import { captureCheckpoint, createCheckpointCommit, GIT_OID, GitCommandError, gitText, runGit,
  type GitCheckpoint } from './GitCheckpoint';
import { checkFilesInBatches } from './BoundedFileChecks';
import { completedLegacyDiscard } from './LegacyWorkspaceCleanup';
import { assertDisposableTree, exportWorkspaceFiles, verifyWorkspaceExports, type WorkspaceExport,
  WorkspaceCleanupError } from './WorkspaceDisposal';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RECORD_BYTES = 128 * 1024;
const INVENTORY_LIMIT = 10_000;
/** At most one bounded artifact listing plus the exact tasks of the bounded lane listing. */
export const WORKSPACE_INVENTORY_PAGE_LIMIT = INVENTORY_LIMIT * 2;
const INVENTORY_BYTES = 32 * 1024 * 1024;
const CLEANUP_ATTEMPTS = 3;

export interface WorkspaceCleanupHold {
  reason: string;
  attempts: number;
  updatedAt: number;
  retryable: boolean;
  nextRetryAt?: number;
}

export interface WorkspaceCollectionOptions {
  /** The caller owns admission and has confirmed exit of every worker writer. */
  exitConfirmed?: boolean;
  /** Files relative to the checkout root, copied outside it before disposal. */
  exports?: readonly string[];
}

export interface WorkspaceArtifactSummary {
  taskId: string;
  laneId: string;
  threadId: string;
  workspaceGeneration: number;
  cwd: string;
  disposition?: 'pending' | 'applied' | 'retained';
  successful?: boolean;
  outputCommit?: string;
  baseCommit?: string;
  exports?: WorkspaceExport[];
  disposalPolicy?: 1;
  checkoutState?: DelegatedWorkspace['checkoutState'];
  blocked?: boolean;
  pendingTaskId?: string;
  exitConfirmed: boolean;
  recoverable: boolean;
  recovery?: { beforeRef: string; targetRef: string };
  holdReason?: string;
  cleanup?: WorkspaceCleanupHold;
  /** Explicit loss of the original checkout; not successful collection or delivery. */
  discarded?: { fingerprint: string; planHash: string };
}

export interface IntegrationScratchReceipt {
  id: string;
  taskId: string;
  laneId: string;
  directory: string;
  source: DelegatedWorkspaceSource;
  state: 'allocating' | 'present' | 'conflict' | 'cleanup-pending' | 'reclaimed';
  updatedAt: number;
  holdReason?: string;
}

export interface DelegatedWorkspaceSource {
  cwd: string;
  root: string;
  commonDirectory: string;
  relativeCwd: string;
}

export interface DelegatedWorkspace {
  laneId: string;
  threadId: string;
  workspaceGeneration: number;
  source: DelegatedWorkspaceSource;
  directory: string;
  cwd: string;
  taskId: string;
  taskRef: string;
  input: GitCheckpoint;
  pendingTaskId?: string;
  blocked?: boolean;
  checkoutState?: 'present' | 'reclaiming' | 'reclaimed';
  reclamation?: { taskId: string; output: string; tree: string };
  disposalPolicy?: 1;
  checkoutIdentity?: { dev: number; ino: number };
  cleanup?: WorkspaceCleanupHold;
}

interface Artifact {
  taskId: string;
  laneId: string;
  threadId: string;
  workspaceGeneration: number;
  source: DelegatedWorkspaceSource;
  input: GitCheckpoint;
  output: string;
  tree: string;
  originalHead: string;
  successful: boolean;
  disposition: 'pending' | 'applied' | 'retained';
  createdAt: number;
  integratedTree?: string;
  deliveredAtHead?: string;
  recovery?: { beforeRef: string; targetRef: string };
  disposalPolicy?: 1;
  closeout?: { taskId: string; output: string; tree: string; exitConfirmedAt: number; recoverable: boolean };
  exports?: WorkspaceExport[];
}

export interface DelegatedArtifactView {
  taskId: string;
  disposition: Artifact['disposition'];
  successful: boolean;
  baseCommit: string;
  outputCommit: string;
  changedFiles: string[];
  filesTruncated: boolean;
  deliveredAtHead?: string;
  recovery?: { beforeRef: string; targetRef: string };
  exports?: WorkspaceExport[];
}

export interface IntegrationOwner {
  threadId: string;
  cwd: string;
  workspaceGeneration: number;
  checkActive?: () => void;
}

function inside(root: string, child: string): boolean {
  const relative = path.relative(root, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

/** Worktrees isolate checkout files, not process permissions. Artifacts are never expired with task diagnostics. */
export class DelegatedWorkspaceManager {
  private static readonly operations = new Map<string, Promise<void>>();
  private ownership?: DelegationOwnership;
  private beforeMutation?: () => Promise<void>;
  private readonly repositoryContext = new AsyncLocalStorage<ReadonlySet<string>>();

  setOwnership(ownership: DelegationOwnership, beforeMutation: () => Promise<void>): void {
    this.ownership = ownership;
    this.beforeMutation = beforeMutation;
  }
  constructor(private readonly directory = path.join(os.homedir(), '.remote-cli', 'delegation-workspaces'),
    private readonly disposalSupported = process.platform === 'linux') {}

  async discover(cwd: string): Promise<DelegatedWorkspaceSource | undefined> {
    // Avoid starting Git for ordinary directories (including environments without Git).
    let ancestor = cwd;
    while (true) {
      try { await fs.lstat(path.join(ancestor, '.git')); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return undefined;
      ancestor = parent;
    }
    if (await gitText(cwd, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
      throw new Error('Delegation requires a usable Git working tree, not a bare repository');
    }
    const root = await fs.realpath(await gitText(cwd, ['rev-parse', '--show-toplevel']));
    const commonDirectory = await fs.realpath(path.resolve(cwd, await gitText(cwd, ['rev-parse', '--git-common-dir'])));
    const relativeCwd = path.relative(root, cwd);
    if (!inside(root, cwd)) throw new Error('Selected working directory is outside the discovered repository');
    if (!GIT_OID.test(await gitText(cwd, ['rev-parse', '--verify', 'HEAD']))) {
      throw new Error('Git worktree delegation requires an initial commit');
    }
    return { cwd, root, commonDirectory, relativeCwd };
  }

  async baseline(source: DelegatedWorkspaceSource): Promise<GitCheckpoint> {
    await this.validateSource(source);
    return captureCheckpoint(source.root);
  }

  async unavailableLanes(): Promise<Set<string>> {
    const blocked = new Set<string>();
    await this.initialize();
    for (const name of await fs.readdir(path.join(this.directory, 'lanes'))) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      if (!UUID.test(id)) continue;
      try {
        const record = await this.read<DelegatedWorkspace>('lanes', id);
        if (!record || record.blocked || record.pendingTaskId || record.cleanup
          && !(record.checkoutState === 'reclaiming' && record.cleanup.retryable)) blocked.add(id);
        else this.assertLifecycle(record);
      } catch { blocked.add(id); }
    }
    return blocked;
  }

  async prepare(lane: DelegatedWorkerLane, source: DelegatedWorkspaceSource,
    input: GitCheckpoint, taskId: string): Promise<DelegatedWorkspace> {
    return this.withLane(lane.id, () => this.withRepository(source, () => this.prepareLocked(lane, source, input, taskId)));
  }

  private async prepareLocked(lane: DelegatedWorkerLane, source: DelegatedWorkspaceSource,
    input: GitCheckpoint, taskId: string): Promise<DelegatedWorkspace> {
    this.assertId(taskId);
    await this.initialize();
    await this.validateSource(source);
    this.assertId(lane.id);
    if (!GIT_OID.test(input.head) || !GIT_OID.test(input.tree) || !GIT_OID.test(input.commit)) {
      throw new Error('Invalid worker input checkpoint');
    }
    const directory = this.worktreeDirectory(source, lane.id);
    const taskRef = `refs/remote-cli/tasks/${taskId}`;
    let previous = await this.read<DelegatedWorkspace>('lanes', lane.id);
    if (previous) {
      await this.validateWorkspaceRecord(previous);
      if (previous.laneId !== lane.id || previous.threadId !== lane.threadId || previous.workspaceGeneration !== lane.workspaceGeneration
        || previous.source.cwd !== source.cwd || previous.blocked || previous.pendingTaskId
        || previous.disposalPolicy === 1 && previous.cleanup
          && !(previous.checkoutState === 'reclaiming' && previous.cleanup.retryable)) {
        throw new Error('Worker workspace has unresolved artifacts or a changed identity');
      }
      previous = await this.resolveReclamation(previous);
    }
    if (previous && previous.checkoutState !== 'reclaimed') {
      await this.validateWorkspace(previous);
      await this.assertClean(previous.directory);
      const indexEntries = (await runGit(previous.directory, ['ls-files', '-v', '-z'])).toString('utf8').split('\0').filter(Boolean);
      if (indexEntries.some(entry => !entry.startsWith('H '))) {
        throw new Error('Worker checkout has hidden index state; manual recovery is required');
      }
      // Never reset unknown files, including ignored files that checkout could overwrite.
      await runGit(directory, ['checkout', '--detach', '--no-overwrite-ignore', input.commit]);
    } else {
      try { await fs.lstat(directory); throw new Error('Unregistered worker directory requires manual recovery'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await this.safeDirectory(path.dirname(directory));
      // Anchor the baseline before creating any checkout, even if setup later fails.
      await runGit(source.root, ['update-ref', this.inputRef(taskId), input.commit]);
      await this.withRepository(source, async () => {
        if (await this.registration(source, directory)) throw new Error('Worker path is still registered; manual recovery is required');
        await runGit(source.root, ['worktree', 'add', '--detach', directory, input.commit]);
      });
    }
    await runGit(source.root, ['update-ref', this.inputRef(taskId), input.commit]);
    await runGit(source.root, ['update-ref', taskRef, input.commit]);
    const identity = await fs.lstat(directory);
    // Reusing a legacy checkout must not adopt its pre-existing ignored files as
    // disposable data. Only a newly created checkout opts into the new policy.
    const disposalPolicy = this.disposalSupported
      ? previous && previous.checkoutState !== 'reclaimed' ? previous.disposalPolicy : 1 : undefined;
    const workspace: DelegatedWorkspace = { laneId: lane.id, threadId: lane.threadId,
      workspaceGeneration: lane.workspaceGeneration, source, directory,
      cwd: path.join(directory, source.relativeCwd), taskId, taskRef, input, checkoutState: 'present',
      disposalPolicy, checkoutIdentity: { dev: identity.dev, ino: identity.ino } };
    await this.write('lanes', lane.id, workspace);
    await this.validateWorkspace(workspace);
    return workspace;
  }

  async collect(workspace: DelegatedWorkspace, successful: boolean,
    options: WorkspaceCollectionOptions = {}): Promise<DelegatedArtifactView> {
    return this.withLane(workspace.laneId, async () => {
      try { return await this.collectLocked(workspace, successful, options); }
      catch (error) {
        await this.recordHold(workspace.laneId, workspace.taskId, error, 'capture-failed');
        throw error;
      }
    });
  }

  private async collectLocked(workspace: DelegatedWorkspace, successful: boolean,
    options: WorkspaceCollectionOptions): Promise<DelegatedArtifactView> {
    const record = await this.read<DelegatedWorkspace>('lanes', workspace.laneId);
    if (!record || record.taskId !== workspace.taskId || record.blocked
      || record.checkoutState && record.checkoutState !== 'present') {
      throw new Error('Worker workspace task changed before collection');
    }
    await this.validateWorkspace(workspace);
    const saved = await this.read<Artifact>('artifacts', workspace.taskId);
    if (saved && record.disposalPolicy === 1) {
      await this.validateArtifact(saved, { threadId: record.threadId, cwd: record.source.cwd, workspaceGeneration: record.workspaceGeneration });
      if (saved.laneId !== record.laneId || saved.successful !== successful
        || await gitText(record.source.root, ['rev-parse', record.taskRef]) !== saved.output
        || await gitText(record.source.root, ['rev-parse', `refs/remote-cli/worker-history/${saved.taskId}`]) !== saved.originalHead) {
        throw new WorkspaceCleanupError('capture-receipt-incomplete');
      }
      // Retrying proof/export must never rewrite immutable output or native history refs.
      return this.finishCollection(record, saved, options);
    }
    const artifact = await this.withRepository(workspace.source, async () => {
    const checkpoint = await captureCheckpoint(workspace.directory);
    const opaque = (await runGit(workspace.directory, ['ls-tree', '-r', '-z', workspace.input.tree]))
      .toString('utf8').split('\0').filter(entry => entry.startsWith('160000 commit '))
      .map(entry => entry.slice(entry.indexOf('\t') + 1));
    const changed = (await runGit(workspace.directory, ['diff', '--name-only', '--no-renames', '-z',
      workspace.input.tree, checkpoint.tree, '--'])).toString('utf8').split('\0').filter(Boolean);
    const opaqueChange = opaque.find(name => changed.some(file => file === name || file.startsWith(`${name}/`)));
    const nestedChange = checkpoint.repositories?.[0]?.path;
    const unsupported = nestedChange !== undefined || opaqueChange !== undefined;
    const output = await createCheckpointCommit(workspace.directory, checkpoint.tree, workspace.input.commit,
      `Remote CLI worker artifact ${workspace.taskId}`);
    await runGit(workspace.directory, ['update-ref', this.outputRef(workspace.taskId), output]);
    await runGit(workspace.directory, ['update-ref', `refs/remote-cli/worker-history/${workspace.taskId}`, checkpoint.head]);
    const artifact: Artifact = { taskId: workspace.taskId, laneId: workspace.laneId,
      threadId: workspace.threadId, workspaceGeneration: workspace.workspaceGeneration,
      source: workspace.source, input: workspace.input, output, tree: checkpoint.tree,
      originalHead: checkpoint.head, successful: successful && !unsupported,
      disposition: !unsupported && checkpoint.tree === workspace.input.tree ? 'applied' : 'pending', createdAt: Date.now(),
      ...(record.disposalPolicy === 1 ? { disposalPolicy: 1 as const,
        ...(options.exitConfirmed === true ? { closeout: { taskId: workspace.taskId, output, tree: checkpoint.tree,
          exitConfirmedAt: Date.now(), recoverable: false } } : {}) } : {}) };
    // Durable artifact + refs precede any index/branch update in the owned checkout.
    await this.write('artifacts', artifact.taskId, artifact);
    if (unsupported) {
      await this.write('lanes', workspace.laneId, { ...workspace, blocked: true, pendingTaskId: artifact.taskId });
      throw new WorkspaceCleanupError('nested-repository', false,
        `${nestedChange !== undefined ? 'Worker created nested Git metadata' : 'Worker changed an uninitialized submodule'}; files and history were retained for manual recovery`);
    }
    const currentBranch = await gitText(workspace.directory, ['branch', '--show-current']);
    if (currentBranch || checkpoint.head !== await gitText(workspace.directory, ['rev-parse', 'HEAD'])) {
      await this.write('lanes', workspace.laneId, { ...workspace, blocked: true, pendingTaskId: artifact.taskId });
      throw new Error('Worker changed its branch during execution; the artifact is preserved for manual recovery');
    }
    // Mixed reset only updates OUR index/branch to the preserved working files. Never touches the parent index.
    await runGit(workspace.directory, ['reset', '--mixed', output]);
    await runGit(workspace.directory, ['update-ref', workspace.taskRef, output]);
    await this.assertClean(workspace.directory);
    // Persist pending before proof/export, so a failed proof cannot hide changed output.
    await this.write('lanes', workspace.laneId, { ...record,
      pendingTaskId: artifact.disposition === 'pending' ? artifact.taskId : undefined });
    return artifact;
    });
    return this.finishCollection(record, artifact, options);
  }

  private async finishCollection(record: DelegatedWorkspace, saved: Artifact,
    options: WorkspaceCollectionOptions): Promise<DelegatedArtifactView> {
    let artifact = saved;
    if (artifact.disposalPolicy === 1 && options.exitConfirmed === true && !artifact.closeout) {
      artifact = { ...artifact, closeout: { taskId: artifact.taskId, output: artifact.output, tree: artifact.tree,
        exitConfirmedAt: Date.now(), recoverable: false } };
      await this.write('artifacts', artifact.taskId, artifact);
    }
    if (artifact.disposalPolicy === 1 && artifact.closeout) {
      const closeout = artifact.closeout;
      if (options.exports !== undefined) {
        const directory = await this.exportDirectory(artifact.taskId, true);
        artifact = { ...artifact, exports: await exportWorkspaceFiles(record.directory, directory, options.exports) };
        await this.write('artifacts', artifact.taskId, artifact);
      }
      await this.verifyCheckout(record, artifact);
      artifact = { ...artifact, closeout: { ...closeout, recoverable: true },
        disposition: !artifact.successful && artifact.disposition === 'pending' ? 'retained' : artifact.disposition };
      await this.write('artifacts', artifact.taskId, artifact);
      await this.write('lanes', record.laneId, { ...record, cleanup: undefined,
        pendingTaskId: artifact.disposition === 'pending' ? artifact.taskId : undefined });
    } else if (artifact.disposalPolicy === 1) {
      await this.recordHold(record.laneId, record.taskId, new WorkspaceCleanupError('child-exit-unconfirmed'));
    }
    return this.view(artifact);
  }

  async integrate(owner: IntegrationOwner, taskId: string, action: unknown, expectedRevision: unknown): Promise<unknown> {
    this.assertId(taskId);
    const artifact = await this.read<Artifact>('artifacts', taskId);
    if (!artifact) throw new Error('Worker artifact not found');
    const result = await this.withLane(artifact.laneId, () => this.withRepository(artifact.source, () => this.integrateLocked(owner, taskId, action, expectedRevision)));
    if (action === 'apply' || action === 'retain' || action === 'inspect' && (result as DelegatedArtifactView).deliveredAtHead) {
      await this.reclaim(taskId);
    }
    return result;
  }

  private async integrateLocked(owner: IntegrationOwner, taskId: string, action: unknown, expectedRevision: unknown): Promise<unknown> {
    this.assertId(taskId);
    let artifact = await this.read<Artifact>('artifacts', taskId);
    if (!artifact) throw new Error('Worker artifact not found');
    await this.validateArtifact(artifact, owner);
    owner.checkActive?.();
    if (action !== 'inspect' && action !== 'apply' && action !== 'retain') {
      throw new Error('Artifact action must be inspect, apply, or retain');
    }
    const current = await captureCheckpoint(artifact.source.root);
    if (action !== 'inspect' && (typeof expectedRevision !== 'string' || expectedRevision !== current.revision)) {
      throw new Error('Delivery workspace changed; inspect the artifact again before integrating');
    }
    if (action !== 'retain') {
      try { artifact = await this.recognizeHistoricalDelivery(artifact, owner); }
      catch {
        console.warn('[Delegation] Historical delivery could not be verified; the artifact was preserved');
        // The receipt may already be durable even if clearing its marker failed.
        // Never apply stale pending state over a subsequently reverted delivery.
        try {
          const persisted = await this.read<Artifact>('artifacts', taskId);
          if (!persisted) throw new Error('Worker delivery receipt is missing');
          await this.validateArtifact(persisted, owner);
          artifact = persisted;
        } catch {
          if (action === 'apply') throw new Error('Worker delivery state is unavailable; inspect again before applying');
        }
      }
    }
    owner.checkActive?.();
    const view = await this.view(artifact);
    if (action === 'inspect') return { ...view, revision: current.revision,
      deliveryDirectory: artifact.source.cwd, integration: artifact.deliveredAtHead
        ? 'Historically delivered. Later delivery-branch changes do not reopen this artifact.'
        : 'Explicit apply or retain is required for pending changes.' };
    if (artifact.disposition !== 'pending') return view;
    if (action === 'retain') {
      owner.checkActive?.();
      // Retain preserves the immutable artifact. Opted-in disposable checkouts can close out.
      await this.resolveArtifact(artifact, 'retained');
      return this.view({ ...artifact, disposition: 'retained' });
    }
    if (!artifact.successful) throw new Error('Failed or cancelled worker changes require manual recovery; retain the artifact instead');
    if (artifact.recovery) throw new Error('A previous file application may be incomplete; compare its recovery snapshots and integrate manually or retain the artifact');
    await this.assertSelectedScope(artifact);
    return this.applyArtifact(artifact, current, owner);
  }

  /** Reconcile only the caller's exited, ready lanes. Admission never removes checkouts. */
  async reconcileHistoricalDelivery(owner: IntegrationOwner, lanes: DelegatedWorkerLane[],
    reclaim = false): Promise<DelegatedArtifactView[]> {
    const delivered: DelegatedArtifactView[] = [];
    for (const lane of lanes) {
      if (lane.state !== 'ready' || lane.threadId !== owner.threadId || lane.workingDirectory !== owner.cwd
        || lane.workspaceGeneration !== owner.workspaceGeneration) continue;
      owner.checkActive?.();
      try {
        const view = await this.withLane(lane.id, async () => {
          const workspace = await this.read<DelegatedWorkspace>('lanes', lane.id);
          if (!workspace || workspace.laneId !== lane.id || workspace.threadId !== owner.threadId
            || workspace.source.cwd !== owner.cwd || workspace.workspaceGeneration !== owner.workspaceGeneration
            || workspace.blocked || workspace.pendingTaskId !== workspace.taskId) return undefined;
          const artifact = await this.read<Artifact>('artifacts', workspace.taskId);
          if (!artifact || artifact.successful !== true || artifact.disposition === 'retained' || artifact.recovery) return undefined;
          const confirmed = await this.recognizeHistoricalDelivery(artifact, owner);
          return confirmed.disposition === 'applied' ? this.view(confirmed) : undefined;
        });
        if (view) {
          delivered.push(view);
          if (reclaim) { owner.checkActive?.(); await this.reclaim(view.taskId); }
        }
      } catch { console.warn('[Delegation] Historical delivery could not be verified; the worker lane was preserved'); }
    }
    return delivered;
  }

  private async recognizeHistoricalDelivery(artifact: Artifact, owner: IntegrationOwner): Promise<Artifact> {
    if (artifact.successful !== true || artifact.disposition === 'retained' || artifact.recovery) return artifact;
    const workspace = await this.read<DelegatedWorkspace>('lanes', artifact.laneId);
    if (!workspace || workspace.taskId !== artifact.taskId || workspace.laneId !== artifact.laneId
      || workspace.threadId !== owner.threadId || workspace.source.cwd !== owner.cwd
      || workspace.workspaceGeneration !== owner.workspaceGeneration || workspace.blocked) return artifact;
    if (artifact.disposition === 'applied' && !workspace.pendingTaskId) return artifact;
    if (workspace.pendingTaskId !== artifact.taskId || workspace.checkoutState && workspace.checkoutState !== 'present') return artifact;
    await this.validateWorkspaceRecord(workspace);
    await this.validateArtifact(artifact, owner);
    if (workspace.input.commit !== artifact.input.commit || workspace.input.tree !== artifact.input.tree
      || !GIT_OID.test(artifact.originalHead)
      || await gitText(workspace.source.root, ['rev-parse', workspace.taskRef]) !== artifact.output
      || await gitText(workspace.source.root, ['rev-parse', `refs/remote-cli/worker-history/${artifact.taskId}`]) !== artifact.originalHead) {
      throw new Error('Worker delivery references changed');
    }
    owner.checkActive?.();
    if (artifact.disposition === 'applied') {
      // A crash after the durable receipt must not strand its pending-lane marker.
      await this.resolveArtifact(artifact, 'applied', artifact.integratedTree);
      return artifact;
    }
    const head = await gitText(artifact.source.root, ['rev-parse', '--verify', 'HEAD']);
    if (!GIT_OID.test(head)) throw new Error('Delivery HEAD is unavailable');
    try {
      await runGit(artifact.source.root, ['--no-replace-objects', 'merge-base', '--is-ancestor', artifact.output, head]);
    } catch (error) {
      if (error instanceof GitCommandError && error.code === 1) return artifact;
      throw error;
    }
    if (await gitText(artifact.source.root, ['rev-parse', '--verify', 'HEAD']) !== head) {
      throw new Error('Delivery HEAD changed during historical verification');
    }
    owner.checkActive?.();
    const confirmed: Artifact = { ...artifact, disposition: 'applied', deliveredAtHead: head };
    // Record historical handoff, not current-byte inclusion or an integration tree.
    await this.resolveArtifact(confirmed, 'applied');
    return confirmed;
  }

  async describe(taskId: string): Promise<DelegatedArtifactView | undefined> {
    const artifact = await this.read<Artifact>('artifacts', taskId);
    return artifact ? this.view(artifact) : undefined;
  }

  /** Metadata inventory only: no mkdir, worker-store initialization, Git commands or record repair. */
  async enumerateArtifacts(options: { threadId?: string; cwd?: string; workspaceGeneration?: number;
    limit?: number; offset?: number; unresolvedOnly?: boolean; laneId?: string } = {}): Promise<{ items: WorkspaceArtifactSummary[]; total: number; incomplete: boolean }> {
    const records = new Map<string, Artifact>();
    const workspaces = new Map<string, DelegatedWorkspace>();
    const missingArtifacts = new Set<string>();
    let incomplete = false;
    let bytes = 0;
    const matches = (record: Artifact | DelegatedWorkspace): boolean =>
      (options.threadId === undefined || record.threadId === options.threadId)
      && (options.cwd === undefined || record.source?.cwd === options.cwd)
      && (options.workspaceGeneration === undefined || record.workspaceGeneration === options.workspaceGeneration)
      && (options.laneId === undefined || record.laneId === options.laneId);
    // Read current ownership before historical artifacts can exhaust the global budget.
    // Scope filtering bounds retained memory, while the read budget still bounds total I/O.
    for (const kind of ['lanes', 'artifacts'] as const) {
      const listing = await this.snapshotNames(kind);
      incomplete ||= listing.incomplete;
      bytes = 0;
      const charge = (size: number) => {
        bytes += size;
        if (bytes > INVENTORY_BYTES) throw new Error('Inventory byte budget exhausted');
      };
      for (const name of listing.names) {
        try {
          if (kind === 'artifacts') {
            if (records.has(name)) continue;
            const artifact = await this.readSnapshot<Artifact>(kind, name, charge);
            if (!artifact || artifact.taskId !== name || !this.validSummaryArtifact(artifact)) throw new Error('Invalid artifact');
            if (matches(artifact)) records.set(name, artifact);
          } else {
            const workspace = await this.readSnapshot<DelegatedWorkspace>(kind, name, charge);
            if (!workspace || workspace.laneId !== name || !UUID.test(workspace.taskId)
              || typeof workspace.threadId !== 'string' || typeof workspace.source?.cwd !== 'string'
              || !Number.isSafeInteger(workspace.workspaceGeneration)) throw new Error('Invalid workspace');
            if (matches(workspace)) workspaces.set(workspace.taskId, workspace);
          }
        } catch {
          if (kind === 'artifacts') missingArtifacts.delete(name);
          incomplete = true; if (bytes > INVENTORY_BYTES) break;
        }
      }
      if (kind === 'lanes') {
        // Exact current task IDs remain obligations even if historical enumeration
        // is truncated. This bounded pass never scans the entire store again.
        let currentBytes = 0;
        for (const workspace of workspaces.values()) {
          try {
            const artifact = await this.readSnapshot<Artifact>('artifacts', workspace.taskId, size => {
              currentBytes += size;
              if (currentBytes > INVENTORY_BYTES) throw new Error('Current artifact byte budget exhausted');
            });
            if (!artifact) { missingArtifacts.add(workspace.taskId); continue; }
            if (!this.validSummaryArtifact(artifact) || artifact.taskId !== workspace.taskId
              || artifact.laneId !== workspace.laneId || !matches(artifact)) throw new Error('Invalid current artifact');
            records.set(artifact.taskId, artifact);
          } catch { incomplete = true; if (currentBytes > INVENTORY_BYTES) break; }
        }
      }
    }
    const items: WorkspaceArtifactSummary[] = [];
    for (const taskId of new Set([...records.keys(), ...workspaces.keys()])) {
      const artifact = records.get(taskId);
      const workspace = workspaces.get(taskId);
      const item = this.summary(artifact, workspace);
      if (!artifact && workspace && missingArtifacts.has(taskId)) {
        item.discarded = await completedLegacyDiscard(this.directory, workspace.laneId, taskId);
      }
      if (options.threadId !== undefined && item.threadId !== options.threadId
        || options.cwd !== undefined && item.cwd !== options.cwd
        || options.workspaceGeneration !== undefined && item.workspaceGeneration !== options.workspaceGeneration) continue;
      if (options.laneId !== undefined && item.laneId !== options.laneId) continue;
      if (options.unresolvedOnly && item.disposition !== 'pending' && !item.recovery
        && (item.disposition !== undefined || item.discarded)) continue;
      items.push(item);
    }
    items.sort((a, b) => a.taskId.localeCompare(b.taskId));
    const offset = Number.isSafeInteger(options.offset) ? Math.max(0, options.offset!) : 0;
    const limit = Number.isSafeInteger(options.limit) ? Math.max(0, Math.min(WORKSPACE_INVENTORY_PAGE_LIMIT, options.limit!)) : 100;
    return { items: items.slice(offset, offset + limit), total: items.length, incomplete };
  }

  /** A caller must still hold its admission reservation; this is not an inactivity proof. */
  async getLaneCloseout(laneId: string): Promise<WorkspaceArtifactSummary | undefined> {
    const workspace = await this.readSnapshot<DelegatedWorkspace>('lanes', laneId);
    if (!workspace) return undefined;
    const artifact = await this.readSnapshot<Artifact>('artifacts', workspace.taskId);
    if (artifact && (!this.validSummaryArtifact(artifact) || artifact.laneId !== laneId)) throw new Error('Invalid lane artifact');
    const item = this.summary(artifact, workspace);
    if (!artifact) item.discarded = await completedLegacyDiscard(this.directory, laneId, workspace.taskId);
    return item;
  }

  async getArtifactExports(taskId: string): Promise<Array<WorkspaceExport & { file: string }>> {
    const artifact = await this.readSnapshot<Artifact>('artifacts', taskId);
    if (!artifact || !this.validSummaryArtifact(artifact)) throw new Error('Artifact is unavailable');
    const directory = await this.exportDirectory(taskId);
    await verifyWorkspaceExports(directory, artifact.exports ?? []);
    return (artifact.exports ?? []).map(entry => ({ ...entry, file: path.join(directory, entry.sha256) }));
  }

  async enumerateIntegrationScratch(): Promise<{ items: IntegrationScratchReceipt[]; incomplete: boolean }> {
    const listing = await this.snapshotNames('scratch');
    const items: IntegrationScratchReceipt[] = [];
    let incomplete = listing.incomplete;
    for (const id of listing.names) {
      try {
        const record = await this.readSnapshot<IntegrationScratchReceipt>('scratch', id);
        if (!record || record.id !== id || !UUID.test(record.taskId) || !UUID.test(record.laneId)
          || record.directory !== path.join(this.directory, `integration-${id}`)
          || !['allocating', 'present', 'conflict', 'cleanup-pending', 'reclaimed'].includes(record.state)) throw new Error('Invalid scratch receipt');
        items.push(record);
      } catch { incomplete = true; }
    }
    return { items, incomplete };
  }

  /** Owner-only retry. The owner must reserve these lanes and exclude every live/setup lane. */
  async retryReclamation(options: { limit?: number; excludedLaneIds?: ReadonlySet<string> } = {}): Promise<{
    attempted: number; reclaimed: number; held: number; incomplete: boolean }> {
    const inventory = await this.enumerateArtifacts({ limit: INVENTORY_LIMIT });
    const result = { attempted: 0, reclaimed: 0, held: 0, incomplete: inventory.incomplete };
    if (inventory.total > inventory.items.length) result.incomplete = true;
    if (result.incomplete) return result;
    const limit = Number.isSafeInteger(options.limit) ? Math.max(0, Math.min(100, options.limit!)) : 10;
    for (const item of inventory.items) {
      if (result.attempted >= limit) break;
      if (item.disposalPolicy !== 1 || !item.exitConfirmed || !item.recoverable || item.blocked
        || item.pendingTaskId || item.recovery || !['applied', 'retained'].includes(item.disposition ?? '')
        || item.checkoutState === undefined || item.checkoutState === 'reclaimed' || options.excludedLaneIds?.has(item.laneId)
        || item.cleanup && (!item.cleanup.retryable || item.cleanup.attempts >= CLEANUP_ATTEMPTS
          || (item.cleanup.nextRetryAt ?? 0) > Date.now())) continue;
      result.attempted++;
      if (await this.reclaim(item.taskId)) result.reclaimed++;
      else result.held++;
    }
    return result;
  }

  private validSummaryArtifact(artifact: Artifact): boolean {
    return UUID.test(artifact.taskId) && UUID.test(artifact.laneId) && typeof artifact.threadId === 'string'
      && Number.isSafeInteger(artifact.workspaceGeneration) && typeof artifact.source?.cwd === 'string'
      && GIT_OID.test(artifact.input?.commit) && GIT_OID.test(artifact.input?.tree) && GIT_OID.test(artifact.output)
      && GIT_OID.test(artifact.tree) && typeof artifact.successful === 'boolean'
      && ['pending', 'applied', 'retained'].includes(artifact.disposition);
  }

  private summary(artifact?: Artifact, workspace?: DelegatedWorkspace): WorkspaceArtifactSummary {
    const owner = artifact ?? workspace!;
    return { taskId: owner.taskId, laneId: owner.laneId, threadId: owner.threadId,
      workspaceGeneration: owner.workspaceGeneration, cwd: owner.source.cwd,
      disposition: artifact?.disposition, successful: artifact?.successful,
      outputCommit: artifact?.output, baseCommit: artifact?.input?.commit, exports: artifact?.exports,
      disposalPolicy: workspace?.disposalPolicy, checkoutState: workspace?.checkoutState,
      blocked: workspace?.blocked, pendingTaskId: workspace?.pendingTaskId,
      exitConfirmed: artifact?.closeout?.taskId === artifact?.taskId && Number.isFinite(artifact?.closeout?.exitConfirmedAt),
      recoverable: artifact?.closeout?.recoverable === true, recovery: artifact?.recovery,
      cleanup: workspace?.cleanup,
      holdReason: workspace?.cleanup?.reason ?? (workspace?.blocked ? 'preserved-for-recovery'
        : !artifact ? 'artifact-unavailable' : !workspace ? 'workspace-unavailable' : undefined) };
  }

  private async snapshotNames(kind: 'lanes' | 'artifacts' | 'scratch'): Promise<{ names: string[]; incomplete: boolean }> {
    const names: string[] = [];
    try {
      const directory = path.join(this.directory, kind);
      if (await fs.realpath(directory) !== directory || await fs.realpath(this.directory) !== this.directory) {
        return { names, incomplete: true };
      }
      const handle = await fs.opendir(directory);
      let count = 0;
      let incomplete = false;
      for await (const entry of handle) {
        if (++count > INVENTORY_LIMIT) { incomplete = true; break; }
        if (!entry.name.endsWith('.json')) continue;
        const id = entry.name.slice(0, -5);
        if (!UUID.test(id) || !entry.isFile() || entry.isSymbolicLink()) { incomplete = true; continue; }
        names.push(id);
      }
      return { names: names.sort(), incomplete };
    } catch (error) { return { names, incomplete: (error as NodeJS.ErrnoException).code !== 'ENOENT' }; }
  }

  private async readSnapshot<T>(kind: 'lanes' | 'artifacts' | 'scratch', id: string, charge?: (bytes: number) => void): Promise<T | undefined> {
    this.assertId(id);
    const directory = path.join(this.directory, kind);
    try {
      if (await fs.realpath(this.directory) !== this.directory || await fs.realpath(directory) !== directory) throw new Error('Unsafe inventory path');
      const file = path.join(directory, `${id}.json`);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > RECORD_BYTES) throw new Error('Invalid inventory record');
      charge?.(stat.size);
      const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = await handle.stat();
        if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size) throw new Error('Inventory changed');
        const buffer = Buffer.alloc(RECORD_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const after = await handle.stat();
        if (bytesRead !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('Inventory changed');
        return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as T;
      } finally { await handle.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }

  private async exportDirectory(taskId: string, create = false): Promise<string> {
    this.assertId(taskId);
    const root = path.join(this.directory, 'exports');
    const directory = path.join(root, taskId);
    if (create) { await this.initialize(); await this.safeDirectory(root); await this.safeDirectory(directory); }
    return directory;
  }

  private async recordHold(laneId: string, taskId: string, error: unknown, fallback = 'verification-failed'): Promise<void> {
    try {
      const workspace = await this.read<DelegatedWorkspace>('lanes', laneId);
      if (!workspace || workspace.taskId !== taskId || workspace.disposalPolicy !== 1) return;
      const detail = error instanceof Error ? error.message : '';
      const reason = error instanceof WorkspaceCleanupError ? error.reason
        : /checkout file|Saved checkout|file mode|blob|bytes/i.test(detail) ? 'tracked-files-changed'
        : /identity|reference|registration|receipt|locked|no longer/.test(detail) ? 'identity-or-registration-changed' : fallback;
      if (reason === 'preserved-for-recovery' && workspace.cleanup) return;
      const attempts = Math.min(CLEANUP_ATTEMPTS, (workspace.cleanup?.attempts ?? 0) + 1);
      const retryable = error instanceof WorkspaceCleanupError && error.retryable;
      await this.write('lanes', laneId, { ...workspace, cleanup: { reason, attempts, retryable, updatedAt: Date.now(),
        ...(retryable && attempts < CLEANUP_ATTEMPTS ? { nextRetryAt: Date.now() + 1000 * 2 ** attempts } : {}) } });
    } catch { console.warn('[Delegation] Cleanup hold could not be persisted; the checkout remains protected'); }
  }

  /** Closeout needs a fresh, owned receipt, not a cached result or an absent record. */
  async inspectCloseout(owner: IntegrationOwner, taskId: string): Promise<DelegatedArtifactView> {
    const saved = await this.read<Artifact>('artifacts', taskId);
    if (!saved) throw new Error('Worker artifact is unavailable');
    return this.withLane(saved.laneId, async () => {
      const artifact = await this.read<Artifact>('artifacts', taskId);
      if (!artifact || artifact.taskId !== taskId || artifact.laneId !== saved.laneId
        || typeof artifact.successful !== 'boolean') throw new Error('Invalid worker artifact receipt');
      await this.validateArtifact(artifact, owner);
      owner.checkActive?.();
      if (artifact.disposalPolicy === 1 && (!artifact.closeout?.recoverable
        || artifact.closeout.taskId !== artifact.taskId || artifact.closeout.output !== artifact.output
        || artifact.closeout.tree !== artifact.tree || !Number.isFinite(artifact.closeout.exitConfirmedAt))) {
        throw new WorkspaceCleanupError('recovery-unverified');
      }
      const workspace = await this.read<DelegatedWorkspace>('lanes', artifact.laneId);
      if (artifact.disposition !== 'retained' && workspace?.taskId === taskId && workspace.blocked) {
        throw new Error('Worker artifact collection requires recovery');
      }
      // Failed workers may have a no-change receipt, but cannot claim an applied patch.
      if (artifact.disposition === 'applied' && !artifact.successful && artifact.tree !== artifact.input.tree) {
        throw new Error('Unsuccessful worker changes have no delivery receipt');
      }
      const view = await this.view(artifact);
      owner.checkActive?.();
      return view;
    });
  }

  /** Removing a conversation does not authorize deleting its files or pending artifacts. */
  async preserveLane(laneId: string): Promise<void> {
    await this.withLane(laneId, async () => {
      const workspace = await this.read<DelegatedWorkspace>('lanes', laneId);
      if (workspace) {
        await this.write('lanes', laneId, { ...workspace, blocked: true });
        await this.recordHold(laneId, workspace.taskId, new WorkspaceCleanupError('preserved-for-recovery'));
      }
    });
  }

  /** Called only after worker exit or a durable delivery receipt; never races a cleanup deadline. */
  async reclaim(taskId: string): Promise<boolean> {
    try {
      this.assertId(taskId);
      const artifact = await this.read<Artifact>('artifacts', taskId);
      if (!artifact) return false;
      return await this.withLane(artifact.laneId, async () => {
        try { return await this.reclaimLocked(taskId, artifact.laneId); }
        catch (error) {
          await this.recordHold(artifact.laneId, taskId, error, 'verification-failed');
          return false;
        }
      });
    } catch {
      // Physical cleanup is optional. Do not turn a delivered result into a failed task.
      console.warn('[Delegation] Worker checkout retained; automatic reclamation could not be verified');
      return false;
    }
  }

  private async reclaimLocked(taskId: string, laneId: string): Promise<boolean> {
    const workspace = await this.read<DelegatedWorkspace>('lanes', laneId);
    const artifact = await this.read<Artifact>('artifacts', taskId);
    if (!workspace || workspace.taskId !== taskId || !artifact) return false;
    if (workspace.checkoutState === 'reclaimed') return false;
    if (!this.disposalSupported && (workspace.disposalPolicy === 1 || artifact.disposalPolicy === 1)) {
      throw new WorkspaceCleanupError('disposal-platform-unsupported');
    }
    if (workspace.blocked) throw new WorkspaceCleanupError('preserved-for-recovery');
    if (artifact.recovery) throw new WorkspaceCleanupError('parent-application-unresolved');
    if (workspace.pendingTaskId || artifact.disposition === 'pending') return false;
    await this.validateReclamationArtifact(workspace, artifact);
    if (workspace.checkoutState === 'reclaiming' && !await this.pathExists(workspace.directory)) {
      if (await this.registration(workspace.source, workspace.directory)) throw new WorkspaceCleanupError('partial-registration');
      await this.write('lanes', laneId, { ...workspace, checkoutState: 'reclaimed', cleanup: undefined });
      return true;
    }
    await this.verifyCheckout(workspace, artifact);
    const intent: DelegatedWorkspace = { ...workspace, checkoutState: 'reclaiming',
      reclamation: { taskId, output: artifact.output, tree: artifact.tree } };
    await this.write('lanes', laneId, intent);
    // Full byte verification holds only the lane guard, not other lanes' metadata admission.
    await this.verifyCheckout(intent, artifact);
    return this.withRepository(workspace.source, async () => {
      const latest = await this.read<DelegatedWorkspace>('lanes', laneId);
      if (!latest || JSON.stringify(latest) !== JSON.stringify(intent)) throw new Error('Worker reclamation intent changed');
      const registered = await this.registration(workspace.source, workspace.directory);
      if (!registered || registered.locked || registered.head !== artifact.output) {
        throw new Error('Worker registration changed before removal');
      }
      try {
        await runGit(workspace.source.root, ['worktree', 'remove',
          ...(workspace.disposalPolicy === 1 ? ['--force'] : []), workspace.directory]);
      } catch { throw new WorkspaceCleanupError('removal-failed', true); }
      if (await this.pathExists(workspace.directory) || await this.registration(workspace.source, workspace.directory)) {
        throw new Error('Worker checkout removal was not confirmed');
      }
      try { await this.write('lanes', laneId, { ...intent, checkoutState: 'reclaimed', cleanup: undefined }); }
      catch { throw new WorkspaceCleanupError('receipt-write-failed', true); }
      return true;
    });
  }

  private async validateReclamationArtifact(workspace: DelegatedWorkspace, artifact: Artifact): Promise<void> {
    await this.validateWorkspaceRecord(workspace);
    await this.validateArtifact(artifact, { threadId: workspace.threadId, cwd: workspace.source.cwd,
      workspaceGeneration: workspace.workspaceGeneration });
    if (workspace.disposalPolicy === 1 || artifact.disposalPolicy !== undefined) {
      if (workspace.disposalPolicy !== 1 || artifact.disposalPolicy !== 1) throw new WorkspaceCleanupError('policy-mismatch');
      if (!artifact.closeout) throw new WorkspaceCleanupError('child-exit-unconfirmed');
      const receipt = artifact.closeout;
      if (receipt.taskId !== artifact.taskId || receipt.output !== artifact.output || receipt.tree !== artifact.tree
        || !Number.isFinite(receipt.exitConfirmedAt) || receipt.exitConfirmedAt <= 0) throw new WorkspaceCleanupError('invalid-exit-receipt');
      if (receipt.recoverable !== true) throw new WorkspaceCleanupError('recovery-unverified');
      if (artifact.disposition !== 'applied' && artifact.disposition !== 'retained') throw new WorkspaceCleanupError('delivery-pending');
      if (!artifact.successful && artifact.disposition === 'applied' && artifact.tree !== artifact.input.tree) {
        throw new WorkspaceCleanupError('invalid-failed-disposition');
      }
      await verifyWorkspaceExports(await this.exportDirectory(artifact.taskId), artifact.exports ?? []);
    } else if (artifact.successful !== true || artifact.disposition !== 'applied') {
      throw new WorkspaceCleanupError('legacy-policy');
    }
    if (artifact.laneId !== workspace.laneId || artifact.taskId !== workspace.taskId
      || artifact.input.commit !== workspace.input.commit || artifact.input.tree !== workspace.input.tree
      || artifact.recovery
      || workspace.blocked || workspace.pendingTaskId
      || !GIT_OID.test(artifact.originalHead)
      || await gitText(workspace.source.root, ['rev-parse', workspace.taskRef]) !== artifact.output
      || await gitText(workspace.source.root, ['rev-parse', `refs/remote-cli/worker-history/${artifact.taskId}`]) !== artifact.originalHead) {
      throw new Error('Worker checkout has no matching delivery receipt');
    }
    if (workspace.reclamation && (workspace.reclamation.taskId !== artifact.taskId
      || workspace.reclamation.output !== artifact.output || workspace.reclamation.tree !== artifact.tree)) {
      throw new Error('Worker reclamation receipt changed');
    }
  }

  private async resolveReclamation(workspace: DelegatedWorkspace): Promise<DelegatedWorkspace> {
    if (!workspace.checkoutState || workspace.checkoutState === 'present') return workspace;
    // The caller holds the lane guard. This resolver does not mutate Git worktree metadata.
    const artifact = await this.read<Artifact>('artifacts', workspace.taskId);
    if (!artifact) throw new Error('Worker reclamation artifact is missing');
    await this.validateReclamationArtifact(workspace, artifact);
    const exists = await this.pathExists(workspace.directory);
    const registered = await this.registration(workspace.source, workspace.directory);
    if (!exists && !registered) {
      const reclaimed: DelegatedWorkspace = { ...workspace, checkoutState: 'reclaimed', cleanup: undefined };
      await this.write('lanes', workspace.laneId, reclaimed);
      return reclaimed;
    }
    if (workspace.checkoutState === 'reclaiming' && exists && registered) {
      // A fully intact checkout can cancel an interrupted intent. Partial/foreign paths cannot.
      await this.verifyCheckout(workspace, artifact);
      const present: DelegatedWorkspace = { ...workspace, checkoutState: 'present', reclamation: undefined, cleanup: undefined };
      await this.write('lanes', workspace.laneId, present);
      return present;
    }
    throw new Error('Reclaimed worker path is occupied or partially registered; manual recovery is required');
  }

  private async verifyCheckout(workspace: DelegatedWorkspace, artifact: Artifact): Promise<void> {
    await this.validateWorkspace(workspace);
    const disposable = workspace.disposalPolicy === 1 && artifact.disposalPolicy === 1;
    const registered = await this.registration(workspace.source, workspace.directory);
    if (!registered || registered.locked || registered.head !== artifact.output
      || await gitText(workspace.directory, ['branch', '--show-current'])
      || await gitText(workspace.directory, ['rev-parse', 'HEAD']) !== artifact.output
      || (await runGit(workspace.directory, ['ls-files', '-u', '-z'])).length) {
      throw new Error('Worker checkout is locked, unresolved, or no longer at its saved output');
    }
    if (disposable) {
      if ((await runGit(workspace.directory, ['status', '--porcelain=v1', '-z', '--untracked-files=no'])).length) {
        throw new WorkspaceCleanupError('tracked-files-changed');
      }
      const entries = (await runGit(workspace.directory, ['ls-files', '-v', '-z'])).toString('utf8').split('\0').filter(Boolean);
      if (entries.some(entry => !entry.startsWith('H '))) throw new WorkspaceCleanupError('hidden-index-state');
    } else await this.assertClean(workspace.directory);
    // Git status and a copied index can hide changed bytes behind assume-unchanged,
    // skip-worktree, or stat-cache flags. Hash actual bytes without filters or index metadata.
    const files = new Map<string, { mode: string; oid: string }>();
    const directories = new Set(['']);
    const tree = await runGit(workspace.source.root, ['ls-tree', '-r', '-z', '--full-tree', artifact.tree]);
    if (!Buffer.from(tree.toString('utf8')).equals(tree)) throw new Error('Non-UTF-8 checkout paths require manual cleanup');
    for (const entry of tree.toString('utf8').split('\0').filter(Boolean)) {
      const match = /^(100644|100755|120000|160000) (blob|commit) ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/s.exec(entry);
      if (!match) throw new Error('Unsupported checkout tree entry');
      const [, mode, type, oid, name] = match;
      if ((mode === '160000') !== (type === 'commit')) throw new Error('Unsupported checkout tree entry');
      if (!inside(workspace.directory, path.join(workspace.directory, name)) || name.split('/').includes('.git')
        || files.has(name)) throw new Error('Invalid checkout tree path');
      files.set(name, { mode, oid });
      let parent = path.posix.dirname(name);
      while (parent !== '.') { directories.add(parent); parent = path.posix.dirname(parent); }
    }
    if (disposable) {
      const attributes = (await runGit(workspace.directory, ['check-attr', '-z', '--stdin', 'filter'],
        Buffer.from([...files.keys()].join('\0') + '\0'))).toString('utf8').split('\0');
      for (let index = 2; index < attributes.length; index += 3) {
        if (attributes[index] === 'lfs') throw new WorkspaceCleanupError('lfs-payload-unverified');
        if (!['unspecified', 'unset'].includes(attributes[index])) throw new WorkspaceCleanupError('unsupported-filter');
      }
      await assertDisposableTree(workspace.directory);
      await verifyWorkspaceExports(await this.exportDirectory(artifact.taskId), artifact.exports ?? [], workspace.directory);
    }
    const walk = async (relative: string): Promise<void> => {
      const absolute = path.join(workspace.directory, relative);
      if (await fs.realpath(absolute) !== absolute) throw new Error('Checkout directory changed during verification');
      const children: string[] = [];
      await checkFilesInBatches(await fs.readdir(absolute), async name => {
        const child = relative ? `${relative}/${name}` : name;
        const file = path.join(workspace.directory, child);
        const stat = await fs.lstat(file);
        if (child === '.git' && stat.isFile() && !stat.isSymbolicLink()) return;
        if (stat.isDirectory() && directories.has(child)) { children.push(child); return; }
        const expected = files.get(child);
        if (expected?.mode === '160000' && stat.isDirectory() && !(await fs.readdir(file)).length) {
          files.delete(child);
          return;
        }
        if (!expected && disposable) return; // The complete boundary walk above validated disposable extras.
        if (!expected || (expected.mode === '120000' ? !stat.isSymbolicLink() : !stat.isFile())) {
          throw new Error('Checkout contains unknown, ignored, or unsupported files');
        }
        if (process.platform !== 'win32' && expected.mode !== '120000'
          && Boolean(stat.mode & 0o111) !== (expected.mode === '100755')) throw new Error('Checkout file mode changed');
        const hash = createHash(expected.oid.length === 64 ? 'sha256' : 'sha1');
        hash.update(`blob ${stat.size}\0`);
        if (stat.isSymbolicLink()) hash.update(await fs.readlink(file, { encoding: 'buffer' }));
        else {
          // Each concurrent reader owns its buffer; hash every byte without filters.
          const buffer = Buffer.alloc(Math.min(1024 * 1024, Math.max(1, stat.size)));
          const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          try {
            const opened = await handle.stat();
            if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) {
              throw new Error('Checkout file changed during verification');
            }
            let read = 0;
            while (true) {
              const chunk = await handle.read(buffer, 0, buffer.length, null);
              if (!chunk.bytesRead) break;
              read += chunk.bytesRead;
              if (read > stat.size) throw new Error('Checkout file grew during verification');
              hash.update(buffer.subarray(0, chunk.bytesRead));
            }
            const after = await handle.stat();
            if (read !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
              throw new Error('Checkout file changed during verification');
            }
          } finally { await handle.close(); }
        }
        if (hash.digest('hex') !== expected.oid) throw new Error('Checkout bytes differ from the saved output');
        files.delete(child);
      });
      // Descend only after draining the parent batch so depth cannot multiply
      // the descriptor or buffer bound, including on a failed verification.
      for (const child of children.sort()) await walk(child);
    };
    await walk('');
    if (files.size) throw new Error('Saved checkout files are missing');
  }

  private async registration(source: DelegatedWorkspaceSource, directory: string): Promise<{ head?: string; locked: boolean } | undefined> {
    let selected = false;
    let result: { head?: string; locked: boolean } | undefined;
    // Git 2.34 has no worktree-list -z option. Decode its quoted paths rather than
    // weakening ownership checks or raising the existing Git requirement.
    const output = await runGit(source.root, ['-c', 'core.quotePath=false', 'worktree', 'list', '--porcelain']);
    if (!Buffer.from(output.toString('utf8')).equals(output)) throw new Error('Unsupported Git worktree path encoding');
    for (const field of output.toString('utf8').split('\n')) {
      if (field.startsWith('worktree ')) {
        const encoded = field.slice(9);
        let decoded: unknown;
        try { decoded = encoded.startsWith('"') ? JSON.parse(encoded) : encoded; }
        catch { throw new Error('Unsupported Git worktree path encoding; manual recovery is required'); }
        if (typeof decoded !== 'string') throw new Error('Invalid Git worktree path');
        selected = decoded === directory;
        if (selected) result = { locked: false };
      } else if (selected && result) {
        if (field.startsWith('HEAD ')) result.head = field.slice(5);
        if (field === 'locked' || field.startsWith('locked ')) result.locked = true;
      }
    }
    return result;
  }

  private async pathExists(directory: string): Promise<boolean> {
    try { await fs.lstat(directory); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }

  private async applyArtifact(artifact: Artifact, current: GitCheckpoint, owner: IntegrationOwner): Promise<unknown> {
    const expectedRepositories = new Map((artifact.input.repositories ?? []).map(repository => [repository.path, repository.identity]));
    const currentRepositories = new Map((current.repositories ?? []).map(repository => [repository.path, repository.identity]));
    for (const [name, identity] of expectedRepositories) {
      if (currentRepositories.get(name) !== identity) {
        throw new Error(`Nested repository identity changed at ${JSON.stringify(name)}; manual integration is required`);
      }
    }
    // Never replace a live repository directory with a worker file or symbolic link.
    const changes = (await runGit(artifact.source.root, ['diff', '--name-only', '--no-renames', '-z',
      artifact.input.tree, artifact.tree, '--'])).toString('utf8').split('\0').filter(Boolean);
    for (const name of currentRepositories.keys()) {
      if (!expectedRepositories.has(name) && changes.some(file => file.startsWith(`${name}/`))
        || changes.some(file => name === file || name.startsWith(`${file}/`))) {
        throw new Error(`Worker changes replace a nested repository boundary at ${JSON.stringify(name)}; manual integration is required`);
      }
    }
    // Compatible with Git 2.34: merge in an owned scratch checkout, never in the user's worktree.
    const wrapper = await createCheckpointCommit(artifact.source.root, current.tree, artifact.input.commit,
      `Remote CLI integration input ${artifact.taskId}`);
    const scratchId = randomUUID();
    const integrationDirectory = path.join(this.directory, `integration-${scratchId}`);
    const scratch: IntegrationScratchReceipt = { id: scratchId, taskId: artifact.taskId, laneId: artifact.laneId,
      directory: integrationDirectory, source: artifact.source, state: 'allocating', updatedAt: Date.now() };
    await this.write('scratch', scratchId, scratch);
    const recordScratch = async (state: IntegrationScratchReceipt['state'], holdReason?: string): Promise<void> => {
      await this.write('scratch', scratchId, { ...scratch, state, holdReason, updatedAt: Date.now() });
    };
    await fs.mkdir(integrationDirectory, { mode: 0o700 });
    let created = false;
    let preserve = false;
    try {
      await this.withRepository(artifact.source,
        () => runGit(artifact.source.root, ['worktree', 'add', '--detach', integrationDirectory, wrapper]));
      created = true;
      await recordScratch('present');
      try {
        await runGit(integrationDirectory, ['-c', 'user.name=Remote CLI', '-c', 'user.email=remote-cli@example.com',
          'merge', '--no-commit', '--no-ff', '--no-edit', artifact.output]);
      } catch (error) {
        const conflicts = (await runGit(integrationDirectory, ['diff', '--name-only', '--diff-filter=U', '-z']))
          .toString('utf8').split('\0').filter(Boolean);
        if (!conflicts.length) throw error;
        preserve = true;
        await recordScratch('conflict', 'integration-conflict');
        return { ...await this.view(artifact), applied: false, conflicts: conflicts.slice(0, 60),
          conflictsTruncated: conflicts.length > 60, recoveryDirectory: integrationDirectory,
          detail: 'Merge conflicts are isolated here. The delivery workspace has not been changed.' };
      }
      const mergedTree = await gitText(integrationDirectory, ['write-tree']);
      const patch = await runGit(artifact.source.root, ['diff', '--binary', '--no-ext-diff', '--no-textconv',
        current.tree, mergedTree, '--']);
      if ((await captureCheckpoint(artifact.source.root)).revision !== current.revision) {
        throw new Error('Delivery workspace changed during integration; no patch was applied');
      }
      if (patch.length) {
        await runGit(artifact.source.root, ['apply', '--check', '--whitespace=nowarn', '-'], patch);
        const recoveryRoot = `refs/remote-cli/integrations/${randomUUID()}`;
        const recovery = { beforeRef: `${recoveryRoot}/before`, targetRef: `${recoveryRoot}/target` };
        const target = await createCheckpointCommit(artifact.source.root, mergedTree, current.commit,
          `Remote CLI integration target ${artifact.taskId}`);
        await runGit(artifact.source.root, ['update-ref', recovery.beforeRef, current.commit]);
        await runGit(artifact.source.root, ['update-ref', recovery.targetRef, target]);
        // A crash between mutation and receipt is unknown, not evidence of a clean rollback.
        await this.write('artifacts', artifact.taskId, { ...artifact, recovery });
        owner.checkActive?.();
        try { await runGit(artifact.source.root, ['apply', '--whitespace=nowarn', '-'], patch); }
        catch (error) {
          return { ...await this.view({ ...artifact, recovery }), applied: false, deliveryMayHaveChanged: true,
            error: error instanceof Error ? error.message.slice(0, 600) : 'File application failed',
            detail: 'Do not assume rollback. Compare the preserved before/target snapshots and recover manually.' };
        }
      }
      owner.checkActive?.();
      // Git apply does not stage or commit. Preserve the user's original staging choices.
      await this.resolveArtifact(artifact, 'applied', mergedTree);
      return { ...await this.view({ ...artifact, disposition: 'applied' }), applied: true,
        detail: 'Changes applied without staging, committing, or pushing. Verify the combined result before delivery.' };
    } finally {
      if (created && !preserve) {
        // This directory contains only captured integration input and a reproducible merge result.
        try {
          await this.withRepository(artifact.source,
            () => runGit(artifact.source.root, ['worktree', 'remove', '--force', integrationDirectory]));
          await recordScratch('reclaimed');
        } catch {
          await recordScratch('cleanup-pending', 'scratch-removal-failed').catch(() => undefined);
          console.warn('[Delegation] Integration scratch worktree retained for manual cleanup');
        }
      } else if (!created) {
        // Failed setup can leave partial files; preserve them without masking the setup error.
        try { await fs.rmdir(integrationDirectory); await recordScratch('reclaimed'); }
        catch {
          await recordScratch('cleanup-pending', 'scratch-setup-incomplete').catch(() => undefined);
          console.warn('[Delegation] Partial integration directory retained for manual cleanup');
        }
      }
    }
  }

  private async resolveArtifact(artifact: Artifact, disposition: 'applied' | 'retained', integratedTree?: string): Promise<void> {
    await this.write('artifacts', artifact.taskId, { ...artifact, disposition, integratedTree });
    const workspace = await this.read<DelegatedWorkspace>('lanes', artifact.laneId);
    if (workspace?.pendingTaskId === artifact.taskId) {
      await this.write('lanes', artifact.laneId, { ...workspace, pendingTaskId: undefined });
    }
  }

  private async view(artifact: Artifact): Promise<DelegatedArtifactView> {
    const files = (await runGit(artifact.source.root, ['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv',
      artifact.input.tree, artifact.tree, '--'])).toString('utf8').split('\0').filter(Boolean);
    return { taskId: artifact.taskId, disposition: artifact.disposition, successful: artifact.successful,
      baseCommit: artifact.input.commit, outputCommit: artifact.output,
      changedFiles: files.slice(0, 60), filesTruncated: files.length > 60,
      ...(artifact.deliveredAtHead ? { deliveredAtHead: artifact.deliveredAtHead } : {}),
      ...(artifact.recovery ? { recovery: artifact.recovery } : {}),
      ...(artifact.exports ? { exports: artifact.exports } : {}) };
  }

  private async assertSelectedScope(artifact: Artifact): Promise<void> {
    // Rename detection hides the removed source path from --name-only; validate BOTH endpoints.
    const files = (await runGit(artifact.source.root, ['diff', '--name-only', '-z', '--no-renames', artifact.input.tree, artifact.tree, '--']))
      .toString('utf8').split('\0').filter(Boolean);
    if (files.some(file => !inside(artifact.source.cwd, path.resolve(artifact.source.root, file)))) {
      throw new Error('Worker changes extend outside the selected working directory; manual integration is required');
    }
  }

  private async validateArtifact(artifact: Artifact, owner: IntegrationOwner): Promise<void> {
    if (artifact.taskId === undefined || !UUID.test(artifact.taskId) || !UUID.test(artifact.laneId)
      || artifact.threadId !== owner.threadId || artifact.source.cwd !== owner.cwd
      || artifact.workspaceGeneration !== owner.workspaceGeneration || !GIT_OID.test(artifact.output)
      || !GIT_OID.test(artifact.tree) || !GIT_OID.test(artifact.input.commit) || !GIT_OID.test(artifact.input.tree)
      || !['pending', 'applied', 'retained'].includes(artifact.disposition)
      || artifact.deliveredAtHead !== undefined && (!GIT_OID.test(artifact.deliveredAtHead) || artifact.disposition !== 'applied')) {
      throw new Error('Invalid or foreign worker artifact');
    }
    await this.validateSource(artifact.source);
    if (await gitText(artifact.source.root, ['rev-parse', this.outputRef(artifact.taskId)]) !== artifact.output
      || await gitText(artifact.source.root, ['rev-parse', this.inputRef(artifact.taskId)]) !== artifact.input.commit
      || await gitText(artifact.source.root, ['rev-parse', `${artifact.output}^{tree}`]) !== artifact.tree
      || await gitText(artifact.source.root, ['rev-parse', `${artifact.input.commit}^{tree}`]) !== artifact.input.tree) {
      throw new Error('Worker artifact reference changed; manual recovery is required');
    }
  }

  private async validateSource(source: DelegatedWorkspaceSource): Promise<void> {
    const discovered = await this.discover(source.cwd);
    if (!discovered || discovered.root !== source.root || discovered.commonDirectory !== source.commonDirectory
      || discovered.relativeCwd !== source.relativeCwd) throw new Error('Source repository identity changed');
  }

  private async validateWorkspace(workspace: DelegatedWorkspace): Promise<void> {
    await this.validateWorkspaceRecord(workspace);
    if (workspace.checkoutState === 'reclaimed' || !await this.pathExists(workspace.directory)) {
      throw new Error('Owned worker checkout is missing; an explicit reclamation receipt is required');
    }
    if (await fs.realpath(workspace.directory) !== workspace.directory
      || await gitText(workspace.directory, ['rev-parse', '--show-toplevel']) !== workspace.directory
      || await fs.realpath(path.resolve(workspace.directory, await gitText(workspace.directory,
        ['rev-parse', '--git-common-dir']))) !== workspace.source.commonDirectory) {
      throw new Error('Owned worker worktree identity changed');
    }
    if (!inside(workspace.directory, await fs.realpath(workspace.cwd))) throw new Error('Worker directory escapes its worktree');
    if (workspace.disposalPolicy === 1) {
      const stat = await fs.lstat(workspace.directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !workspace.checkoutIdentity
        || workspace.checkoutIdentity.dev !== stat.dev || workspace.checkoutIdentity.ino !== stat.ino) {
        throw new WorkspaceCleanupError('checkout-identity-changed');
      }
    }
  }

  private assertLifecycle(workspace: DelegatedWorkspace): void {
    const state = workspace.checkoutState ?? 'present';
    if (workspace.disposalPolicy !== undefined && workspace.disposalPolicy !== 1) throw new Error('Unknown workspace disposal policy');
    if (!['present', 'reclaiming', 'reclaimed'].includes(state)
      || (state === 'present' ? workspace.reclamation !== undefined : !workspace.reclamation)) {
      throw new Error('Invalid worker checkout lifecycle');
    }
  }

  private async validateWorkspaceRecord(workspace: DelegatedWorkspace): Promise<void> {
    this.assertId(workspace.laneId);
    this.assertId(workspace.taskId);
    this.assertLifecycle(workspace);
    if (workspace.taskRef !== `refs/remote-cli/tasks/${workspace.taskId}` || !GIT_OID.test(workspace.input.commit)) {
      throw new Error('Owned worker task reference is invalid');
    }
    await this.validateSource(workspace.source);
    if (workspace.directory !== this.worktreeDirectory(workspace.source, workspace.laneId)
      || workspace.cwd !== path.join(workspace.directory, workspace.source.relativeCwd)) {
      throw new Error('Owned worker worktree identity changed');
    }
  }

  private async assertClean(directory: string): Promise<void> {
    if ((await runGit(directory, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).length) {
      throw new Error('Worker worktree contains unaccounted changes; manual recovery is required');
    }
  }

  private worktreeDirectory(source: DelegatedWorkspaceSource, laneId: string): string {
    this.assertId(laneId);
    const key = createHash('sha256').update(source.root).digest('hex');
    return path.join(this.directory, 'trees', key, laneId);
  }

  private inputRef(taskId: string): string { this.assertId(taskId); return `refs/remote-cli/inputs/${taskId}`; }
  private outputRef(taskId: string): string { this.assertId(taskId); return `refs/remote-cli/artifacts/${taskId}`; }
  private assertId(id: string): void { if (!UUID.test(id)) throw new Error('Invalid worker workspace ID'); }

  private withLane<T>(laneId: string, operation: () => Promise<T>): Promise<T> {
    this.assertId(laneId);
    return this.serialize(`lane:${path.resolve(this.directory)}:${laneId}`, operation);
  }

  private withRepository<T>(source: DelegatedWorkspaceSource, operation: () => Promise<T>): Promise<T> {
    const held = this.repositoryContext.getStore();
    if (held?.has(source.commonDirectory)) return operation();
    return this.serialize(`repository:${source.commonDirectory}`, async () => {
      await this.beforeMutation?.();
      const run = () => this.repositoryContext.run(new Set([...(held ?? []), source.commonDirectory]), operation);
      return this.ownership ? this.ownership.withRepository(source.commonDirectory, run) : run();
    });
  }

  private async serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = DelegatedWorkspaceManager.operations.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    DelegatedWorkspaceManager.operations.set(key, current);
    await previous;
    try { return await operation(); }
    finally {
      release();
      if (DelegatedWorkspaceManager.operations.get(key) === current) DelegatedWorkspaceManager.operations.delete(key);
    }
  }

  private async initialize(): Promise<void> {
    await this.beforeMutation?.();
    await this.safeDirectory(this.directory);
    await Promise.all(['lanes', 'artifacts', 'trees', 'scratch'].map(name => this.safeDirectory(path.join(this.directory, name))));
  }

  private async safeDirectory(directory: string): Promise<void> {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== path.resolve(directory)) {
      throw new Error('Worker storage must be a canonical directory, not a symbolic link');
    }
  }

  private async read<T>(kind: 'lanes' | 'artifacts', id: string): Promise<T | undefined> {
    this.assertId(id);
    await this.initialize();
    const file = path.join(this.directory, kind, `${id}.json`);
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > RECORD_BYTES) throw new Error('Invalid worker workspace record');
      return JSON.parse(await fs.readFile(file, 'utf8')) as T;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }

  private async write(kind: 'lanes' | 'artifacts' | 'scratch', id: string, record: unknown): Promise<void> {
    this.assertId(id);
    await this.initialize();
    const data = JSON.stringify(record);
    if (Buffer.byteLength(data) > RECORD_BYTES) throw new Error('Worker workspace record is too large');
    const target = path.join(this.directory, kind, `${id}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, data, { mode: 0o600, flag: 'wx' });
    try { await fs.rename(temporary, target); } finally { await fs.rm(temporary, { force: true }); }
  }
}
