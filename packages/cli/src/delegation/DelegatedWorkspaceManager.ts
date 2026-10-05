import { createHash, randomUUID } from 'crypto';
import { constants } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { DelegatedWorkerLane } from './DelegatedWorkerSessionStore';
import { captureCheckpoint, createCheckpointCommit, GIT_OID, GitCommandError, gitText, runGit,
  type GitCheckpoint } from './GitCheckpoint';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RECORD_BYTES = 128 * 1024;

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
  constructor(private readonly directory = path.join(os.homedir(), '.remote-cli', 'delegation-workspaces')) {}

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
        if (!record || record.blocked || record.pendingTaskId) blocked.add(id);
        else this.assertLifecycle(record);
      } catch { blocked.add(id); }
    }
    return blocked;
  }

  async prepare(lane: DelegatedWorkerLane, source: DelegatedWorkspaceSource,
    input: GitCheckpoint, taskId: string): Promise<DelegatedWorkspace> {
    return this.withLane(lane.id, () => this.prepareLocked(lane, source, input, taskId));
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
        || previous.source.cwd !== source.cwd || previous.blocked || previous.pendingTaskId) {
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
    const workspace: DelegatedWorkspace = { laneId: lane.id, threadId: lane.threadId,
      workspaceGeneration: lane.workspaceGeneration, source, directory,
      cwd: path.join(directory, source.relativeCwd), taskId, taskRef, input, checkoutState: 'present' };
    await this.write('lanes', lane.id, workspace);
    await this.validateWorkspace(workspace);
    return workspace;
  }

  async collect(workspace: DelegatedWorkspace, successful: boolean): Promise<DelegatedArtifactView> {
    return this.withLane(workspace.laneId, () => this.collectLocked(workspace, successful));
  }

  private async collectLocked(workspace: DelegatedWorkspace, successful: boolean): Promise<DelegatedArtifactView> {
    const record = await this.read<DelegatedWorkspace>('lanes', workspace.laneId);
    if (!record || record.taskId !== workspace.taskId || record.blocked
      || record.checkoutState && record.checkoutState !== 'present') {
      throw new Error('Worker workspace task changed before collection');
    }
    await this.validateWorkspace(workspace);
    const checkpoint = await captureCheckpoint(workspace.directory);
    const output = await createCheckpointCommit(workspace.directory, checkpoint.tree, workspace.input.commit,
      `Remote CLI worker artifact ${workspace.taskId}`);
    await runGit(workspace.directory, ['update-ref', this.outputRef(workspace.taskId), output]);
    await runGit(workspace.directory, ['update-ref', `refs/remote-cli/worker-history/${workspace.taskId}`, checkpoint.head]);
    const artifact: Artifact = { taskId: workspace.taskId, laneId: workspace.laneId,
      threadId: workspace.threadId, workspaceGeneration: workspace.workspaceGeneration,
      source: workspace.source, input: workspace.input, output, tree: checkpoint.tree,
      originalHead: checkpoint.head, successful,
      disposition: checkpoint.tree === workspace.input.tree ? 'applied' : 'pending', createdAt: Date.now() };
    // Durable artifact + refs precede any index/branch update in the owned checkout.
    await this.write('artifacts', artifact.taskId, artifact);
    const currentBranch = await gitText(workspace.directory, ['branch', '--show-current']);
    if (currentBranch || checkpoint.head !== await gitText(workspace.directory, ['rev-parse', 'HEAD'])) {
      await this.write('lanes', workspace.laneId, { ...workspace, blocked: true, pendingTaskId: artifact.taskId });
      throw new Error('Worker changed its branch during execution; the artifact is preserved for manual recovery');
    }
    // Mixed reset only updates OUR index/branch to the preserved working files. Never touches the parent index.
    await runGit(workspace.directory, ['reset', '--mixed', output]);
    await runGit(workspace.directory, ['update-ref', workspace.taskRef, output]);
    await this.assertClean(workspace.directory);
    await this.write('lanes', workspace.laneId, { ...workspace,
      pendingTaskId: artifact.disposition === 'pending' ? artifact.taskId : undefined });
    return this.view(artifact);
  }

  async integrate(owner: IntegrationOwner, taskId: string, action: unknown, expectedRevision: unknown): Promise<unknown> {
    this.assertId(taskId);
    const artifact = await this.read<Artifact>('artifacts', taskId);
    if (!artifact) throw new Error('Worker artifact not found');
    const result = await this.withLane(artifact.laneId, () => this.integrateLocked(owner, taskId, action, expectedRevision));
    if (action === 'apply' || action === 'inspect' && (result as DelegatedArtifactView).deliveredAtHead) {
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
      // Intentional non-integration is not deletion. The immutable artifact remains inspectable.
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
      if (workspace) await this.write('lanes', laneId, { ...workspace, blocked: true });
    });
  }

  /** Called only after worker exit or a durable delivery receipt; never races a cleanup deadline. */
  async reclaim(taskId: string): Promise<boolean> {
    try {
      this.assertId(taskId);
      const artifact = await this.read<Artifact>('artifacts', taskId);
      if (!artifact) return false;
      return await this.withLane(artifact.laneId, () => this.reclaimLocked(taskId, artifact.laneId));
    } catch {
      // Physical cleanup is optional. Do not turn a delivered result into a failed task.
      console.warn('[Delegation] Worker checkout retained; automatic reclamation could not be verified');
      return false;
    }
  }

  private async reclaimLocked(taskId: string, laneId: string): Promise<boolean> {
    const workspace = await this.read<DelegatedWorkspace>('lanes', laneId);
    const artifact = await this.read<Artifact>('artifacts', taskId);
    if (!workspace || workspace.taskId !== taskId || !artifact || workspace.blocked || workspace.pendingTaskId
      || artifact.successful !== true || artifact.disposition !== 'applied' || artifact.recovery) return false;
    await this.validateReclamationArtifact(workspace, artifact);
    if (workspace.checkoutState === 'reclaimed') return false;
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
      await runGit(workspace.source.root, ['worktree', 'remove', workspace.directory]);
      if (await this.pathExists(workspace.directory) || await this.registration(workspace.source, workspace.directory)) {
        throw new Error('Worker checkout removal was not confirmed');
      }
      await this.write('lanes', laneId, { ...intent, checkoutState: 'reclaimed' });
      return true;
    });
  }

  private async validateReclamationArtifact(workspace: DelegatedWorkspace, artifact: Artifact): Promise<void> {
    await this.validateWorkspaceRecord(workspace);
    await this.validateArtifact(artifact, { threadId: workspace.threadId, cwd: workspace.source.cwd,
      workspaceGeneration: workspace.workspaceGeneration });
    if (artifact.laneId !== workspace.laneId || artifact.taskId !== workspace.taskId
      || artifact.input.commit !== workspace.input.commit || artifact.input.tree !== workspace.input.tree
      || artifact.successful !== true || artifact.disposition !== 'applied' || artifact.recovery
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
      const reclaimed: DelegatedWorkspace = { ...workspace, checkoutState: 'reclaimed' };
      await this.write('lanes', workspace.laneId, reclaimed);
      return reclaimed;
    }
    if (workspace.checkoutState === 'reclaiming' && exists && registered) {
      // A fully intact checkout can cancel an interrupted intent. Partial/foreign paths cannot.
      await this.verifyCheckout(workspace, artifact);
      const present: DelegatedWorkspace = { ...workspace, checkoutState: 'present', reclamation: undefined };
      await this.write('lanes', workspace.laneId, present);
      return present;
    }
    throw new Error('Reclaimed worker path is occupied or partially registered; manual recovery is required');
  }

  private async verifyCheckout(workspace: DelegatedWorkspace, artifact: Artifact): Promise<void> {
    await this.validateWorkspace(workspace);
    const registered = await this.registration(workspace.source, workspace.directory);
    if (!registered || registered.locked || registered.head !== artifact.output
      || await gitText(workspace.directory, ['branch', '--show-current'])
      || await gitText(workspace.directory, ['rev-parse', 'HEAD']) !== artifact.output
      || (await runGit(workspace.directory, ['ls-files', '-u', '-z'])).length) {
      throw new Error('Worker checkout is locked, unresolved, or no longer at its saved output');
    }
    await this.assertClean(workspace.directory);
    // Git status and a copied index can hide changed bytes behind assume-unchanged,
    // skip-worktree, or stat-cache flags. Hash actual bytes without filters or index metadata.
    const files = new Map<string, { mode: string; oid: string }>();
    const directories = new Set(['']);
    const tree = await runGit(workspace.source.root, ['ls-tree', '-r', '-z', '--full-tree', artifact.tree]);
    if (!Buffer.from(tree.toString('utf8')).equals(tree)) throw new Error('Non-UTF-8 checkout paths require manual cleanup');
    for (const entry of tree.toString('utf8').split('\0').filter(Boolean)) {
      const match = /^(100644|100755|120000) blob ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/s.exec(entry);
      if (!match) throw new Error('Unsupported checkout tree entry');
      const [, mode, oid, name] = match;
      if (!inside(workspace.directory, path.join(workspace.directory, name)) || name.split('/').includes('.git')
        || files.has(name)) throw new Error('Invalid checkout tree path');
      files.set(name, { mode, oid });
      let parent = path.posix.dirname(name);
      while (parent !== '.') { directories.add(parent); parent = path.posix.dirname(parent); }
    }
    const buffer = Buffer.alloc(64 * 1024);
    const walk = async (relative: string): Promise<void> => {
      const absolute = path.join(workspace.directory, relative);
      if (await fs.realpath(absolute) !== absolute) throw new Error('Checkout directory changed during verification');
      for (const name of await fs.readdir(absolute)) {
        const child = relative ? `${relative}/${name}` : name;
        const file = path.join(workspace.directory, child);
        const stat = await fs.lstat(file);
        if (child === '.git' && stat.isFile() && !stat.isSymbolicLink()) continue;
        if (stat.isDirectory() && directories.has(child)) { await walk(child); continue; }
        const expected = files.get(child);
        if (!expected || (expected.mode === '120000' ? !stat.isSymbolicLink() : !stat.isFile())) {
          throw new Error('Checkout contains unknown, ignored, or unsupported files');
        }
        if (process.platform !== 'win32' && expected.mode !== '120000'
          && Boolean(stat.mode & 0o111) !== (expected.mode === '100755')) throw new Error('Checkout file mode changed');
        const hash = createHash(expected.oid.length === 64 ? 'sha256' : 'sha1');
        hash.update(`blob ${stat.size}\0`);
        if (stat.isSymbolicLink()) hash.update(await fs.readlink(file, { encoding: 'buffer' }));
        else {
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
      }
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
    // Compatible with Git 2.34: merge in an owned scratch checkout, never in the user's worktree.
    const wrapper = await createCheckpointCommit(artifact.source.root, current.tree, artifact.input.commit,
      `Remote CLI integration input ${artifact.taskId}`);
    const integrationDirectory = await fs.mkdtemp(path.join(this.directory, 'integration-'));
    let created = false;
    let preserve = false;
    try {
      await this.withRepository(artifact.source,
        () => runGit(artifact.source.root, ['worktree', 'add', '--detach', integrationDirectory, wrapper]));
      created = true;
      try {
        await runGit(integrationDirectory, ['-c', 'user.name=Remote CLI', '-c', 'user.email=remote-cli@example.com',
          'merge', '--no-commit', '--no-ff', '--no-edit', artifact.output]);
      } catch (error) {
        const conflicts = (await runGit(integrationDirectory, ['diff', '--name-only', '--diff-filter=U', '-z']))
          .toString('utf8').split('\0').filter(Boolean);
        if (!conflicts.length) throw error;
        preserve = true;
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
        await this.withRepository(artifact.source,
          () => runGit(artifact.source.root, ['worktree', 'remove', '--force', integrationDirectory]))
          .catch(() => console.warn('[Delegation] Integration scratch worktree retained for manual cleanup'));
      } else if (!created) {
        // Failed setup can leave partial files; preserve them without masking the setup error.
        await fs.rmdir(integrationDirectory)
          .catch(() => console.warn('[Delegation] Partial integration directory retained for manual cleanup'));
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
      ...(artifact.recovery ? { recovery: artifact.recovery } : {}) };
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
  }

  private assertLifecycle(workspace: DelegatedWorkspace): void {
    const state = workspace.checkoutState ?? 'present';
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
    return this.serialize(`repository:${source.commonDirectory}`, operation);
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
    await this.safeDirectory(this.directory);
    await Promise.all(['lanes', 'artifacts', 'trees'].map(name => this.safeDirectory(path.join(this.directory, name))));
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

  private async write(kind: 'lanes' | 'artifacts', id: string, record: unknown): Promise<void> {
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
