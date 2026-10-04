import { createHash, randomUUID } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { DelegatedWorkerLane } from './DelegatedWorkerSessionStore';
import { captureCheckpoint, createCheckpointCommit, GIT_OID, gitText, runGit,
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
      } catch { blocked.add(id); }
    }
    return blocked;
  }

  async prepare(lane: DelegatedWorkerLane, source: DelegatedWorkspaceSource,
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
    const previous = await this.read<DelegatedWorkspace>('lanes', lane.id);
    if (previous) {
      await this.validateWorkspace(previous);
      if (previous.threadId !== lane.threadId || previous.workspaceGeneration !== lane.workspaceGeneration
        || previous.source.cwd !== source.cwd || previous.blocked || previous.pendingTaskId) {
        throw new Error('Worker workspace has unresolved artifacts or a changed identity');
      }
      await this.assertClean(previous.directory);
      // Never reset unknown files, including ignored files that checkout could overwrite.
      await runGit(directory, ['checkout', '--detach', '--no-overwrite-ignore', input.commit]);
    } else {
      try { await fs.lstat(directory); throw new Error('Unregistered worker directory requires manual recovery'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await this.safeDirectory(path.dirname(directory));
      // Anchor the baseline before creating any checkout, even if setup later fails.
      await runGit(source.root, ['update-ref', this.inputRef(taskId), input.commit]);
      await runGit(source.root, ['worktree', 'add', '--detach', directory, input.commit]);
    }
    await runGit(source.root, ['update-ref', this.inputRef(taskId), input.commit]);
    await runGit(source.root, ['update-ref', taskRef, input.commit]);
    const workspace: DelegatedWorkspace = { laneId: lane.id, threadId: lane.threadId,
      workspaceGeneration: lane.workspaceGeneration, source, directory,
      cwd: path.join(directory, source.relativeCwd), taskId, taskRef, input };
    await this.write('lanes', lane.id, workspace);
    await this.validateWorkspace(workspace);
    return workspace;
  }

  async collect(workspace: DelegatedWorkspace, successful: boolean): Promise<DelegatedArtifactView> {
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
    await this.validateArtifact(artifact, owner);
    owner.checkActive?.();
    const view = await this.view(artifact);
    const current = await captureCheckpoint(artifact.source.root);
    if (action === 'inspect') return { ...view, revision: current.revision,
      deliveryDirectory: artifact.source.cwd, integration: 'Explicit apply or retain is required for pending changes.' };
    if (action !== 'apply' && action !== 'retain') throw new Error('Artifact action must be inspect, apply, or retain');
    if (typeof expectedRevision !== 'string' || expectedRevision !== current.revision) {
      throw new Error('Delivery workspace changed; inspect the artifact again before integrating');
    }
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

  async describe(taskId: string): Promise<DelegatedArtifactView | undefined> {
    const artifact = await this.read<Artifact>('artifacts', taskId);
    return artifact ? this.view(artifact) : undefined;
  }

  /** Removing a conversation does not authorize deleting its files or pending artifacts. */
  async preserveLane(laneId: string): Promise<void> {
    const workspace = await this.read<DelegatedWorkspace>('lanes', laneId);
    if (workspace) await this.write('lanes', laneId, { ...workspace, blocked: true });
  }

  private async applyArtifact(artifact: Artifact, current: GitCheckpoint, owner: IntegrationOwner): Promise<unknown> {
    // Compatible with Git 2.34: merge in an owned scratch checkout, never in the user's worktree.
    const wrapper = await createCheckpointCommit(artifact.source.root, current.tree, artifact.input.commit,
      `Remote CLI integration input ${artifact.taskId}`);
    const integrationDirectory = await fs.mkdtemp(path.join(this.directory, 'integration-'));
    let created = false;
    let preserve = false;
    try {
      await runGit(artifact.source.root, ['worktree', 'add', '--detach', integrationDirectory, wrapper]);
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
        await runGit(artifact.source.root, ['worktree', 'remove', '--force', integrationDirectory])
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
      || !['pending', 'applied', 'retained'].includes(artifact.disposition)) throw new Error('Invalid or foreign worker artifact');
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
    this.assertId(workspace.laneId);
    this.assertId(workspace.taskId);
    if (workspace.taskRef !== `refs/remote-cli/tasks/${workspace.taskId}` || !GIT_OID.test(workspace.input.commit)) {
      throw new Error('Owned worker task reference is invalid');
    }
    await this.validateSource(workspace.source);
    if (workspace.directory !== this.worktreeDirectory(workspace.source, workspace.laneId)
      || workspace.cwd !== path.join(workspace.directory, workspace.source.relativeCwd)
      || await fs.realpath(workspace.directory) !== workspace.directory
      || await gitText(workspace.directory, ['rev-parse', '--show-toplevel']) !== workspace.directory
      || await fs.realpath(path.resolve(workspace.directory, await gitText(workspace.directory,
        ['rev-parse', '--git-common-dir']))) !== workspace.source.commonDirectory) {
      throw new Error('Owned worker worktree identity changed');
    }
    if (!inside(workspace.directory, await fs.realpath(workspace.cwd))) throw new Error('Worker directory escapes its worktree');
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
