import { spawn } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

export const CHECKPOINT_LIMITS = { commandMs: 15_000, outputBytes: 32 * 1024 * 1024 } as const;
export const GIT_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export interface GitCheckpoint {
  head: string;
  tree: string;
  commit: string;
  revision: string;
  repositories?: NestedRepositoryCheckpoint[];
}

export interface NestedRepositoryCheckpoint {
  path: string;
  identity: string;
  revision: string;
}

export class GitCommandError extends Error {
  constructor(readonly command: string, readonly code: number | null, readonly detail: string) {
    super(`Git ${command} failed${code === null ? '' : ` (${code})`}: ${detail.slice(0, 600)}`);
  }
}

function gitEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  return { ...inherited, LC_ALL: 'C', ...extra };
}

function gitArguments(args: string[]): string[] {
  return ['-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
    '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args];
}

/** Fixed argv only; neither a shell nor the user's Git environment selects the repository. */
export async function runGit(cwd: string, args: string[], input?: Buffer | string,
  extraEnv: Record<string, string> = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', gitArguments(args), {
      cwd, env: gitEnvironment(extraEnv), stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let detail = '';
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 500);
    };
    const timer = setTimeout(() => stop(new Error(`Git ${args[0]} timed out`)), CHECKPOINT_LIMITS.commandMs);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > CHECKPOINT_LIMITS.outputBytes) stop(new Error(`Git ${args[0]} output exceeded the checkpoint limit`));
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => { detail = (detail + chunk.toString('utf8')).slice(-2000); });
    child.on('error', error => { failure = error; });
    child.stdin.on('error', () => { /* The exit event reports a rejected input pipe. */ });
    child.on('close', code => {
      clearTimeout(timer); clearTimeout(killTimer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new GitCommandError(args[0], code, detail.trim()));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(input);
  });
}

export async function gitText(cwd: string, args: string[], input?: Buffer | string,
  env?: Record<string, string>): Promise<string> {
  return (await runGit(cwd, args, input, env)).toString('utf8').trim();
}

export function checkpointRevision(head: string, tree: string, index: Buffer,
  repositories: NestedRepositoryCheckpoint[] = []): string {
  const hash = createHash('sha256').update(head).update('\0').update(tree).update('\0').update(index);
  if (repositories.length) hash.update('\0repositories\0').update(JSON.stringify(repositories));
  return hash.digest('hex');
}

/** Transfer local objects through a pipe, without buffering repository contents or fetching a remote. */
export async function importGitTree(source: string, destination: string, tree: string): Promise<void> {
  if (!GIT_OID.test(tree)) throw new Error('Invalid nested checkpoint tree');
  if (await gitText(source, ['rev-parse', '--show-object-format']) !== await gitText(destination, ['rev-parse', '--show-object-format'])) {
    throw new Error('Nested repository uses a different Git object format');
  }
  const objects = await fs.realpath(path.resolve(destination, await gitText(destination, ['rev-parse', '--git-path', 'objects'])));
  const incoming = await fs.mkdtemp(path.join(objects, 'tmp_objdir-incoming-'));
  try {
    await fs.mkdir(path.join(incoming, 'pack'));
    const published = path.join(objects, 'pack');
    await fs.mkdir(published, { recursive: true });
    await transferGitTree(source, destination, tree, {
      GIT_OBJECT_DIRECTORY: incoming,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(objects),
    });
    const files = await fs.readdir(path.join(incoming, 'pack'));
    if (!files.some(file => file.endsWith('.pack')) || !files.some(file => file.endsWith('.idx'))
      || files.some(file => !/^pack-(?:[a-f0-9]{40}|[a-f0-9]{64})\.(?:pack|idx|rev)$/.test(file))) {
      throw new Error('Nested Git transfer produced an incomplete pack');
    }
    // Only complete packs leave quarantine. Publish indexes last so Git never
    // discovers a pack while its bytes are still being received or promoted.
    files.sort((left, right) => Number(left.endsWith('.idx')) - Number(right.endsWith('.idx')));
    for (const file of files) await fs.rename(path.join(incoming, 'pack', file), path.join(published, file));
  } finally {
    // transferGitTree settles only after both children exit. Remove only this
    // operation's quarantine, never sweep another process's temporary packs.
    await fs.rm(incoming, { recursive: true, force: true });
  }
}

async function transferGitTree(source: string, destination: string, tree: string, receiveEnv: Record<string, string>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const pack = spawn('git', gitArguments(['pack-objects', '--compression=1', '--window=0', '--threads=1', '--stdout', '--revs']), {
      cwd: source, env: gitEnvironment(), stdio: ['pipe', 'pipe', 'pipe'],
    });
    const unpack = spawn('git', gitArguments(['index-pack', '--threads=1', '--stdin']), {
      cwd: destination, env: gitEnvironment(receiveEnv), stdio: ['pipe', 'pipe', 'pipe'],
    });
    let closed = 0;
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      pack.kill('SIGTERM'); unpack.kill('SIGTERM');
      killTimer ??= setTimeout(() => { pack.kill('SIGKILL'); unpack.kill('SIGKILL'); }, 500);
    };
    const timer = setTimeout(() => stop(new Error('Nested Git object transfer timed out')), CHECKPOINT_LIMITS.commandMs);
    for (const [name, child] of [['pack-objects', pack], ['index-pack', unpack]] as const) {
      let detail = '';
      child.stderr.on('data', (chunk: Buffer) => { detail = (detail + chunk.toString('utf8')).slice(-2000); });
      child.on('error', stop);
      child.stdin.on('error', () => { /* Closing either process reports the transfer failure. */ });
      child.on('close', code => {
        if (code !== 0) stop(new GitCommandError(name, code, detail.trim()));
        if (++closed === 2) {
          clearTimeout(timer); clearTimeout(killTimer);
          if (failure) reject(failure); else resolve();
        }
      });
    }
    unpack.stdout.resume();
    pack.stdout.pipe(unpack.stdin);
    pack.stdin.end(`${tree}\n`);
  });
}

async function readIndex(root: string): Promise<{ bytes: Buffer; mtime?: Date }> {
  const file = path.resolve(root, await gitText(root, ['rev-parse', '--git-path', 'index']));
  try {
    const stat = await fs.stat(file);
    if (stat.size > CHECKPOINT_LIMITS.outputBytes) throw new Error('Git index exceeds the checkpoint limit');
    return { bytes: await fs.readFile(file), mtime: stat.mtime };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { bytes: Buffer.alloc(0) };
    throw error;
  }
}

function entries(bytes: Buffer): string[] {
  const decoded = bytes.toString('utf8');
  if (!Buffer.from(decoded).equals(bytes)) throw new Error('Git checkpoint paths must use valid UTF-8');
  return decoded.split('\0').filter(Boolean);
}

function sensitiveUntracked(file: string): boolean {
  const parts = file.split('/');
  const name = parts[parts.length - 1].toLowerCase();
  return parts.some(part => ['.remote-cli', '.ssh', '.codex', '.gemini'].includes(part.toLowerCase()))
    || /^(?:id_rsa|id_ed25519|credentials\.json|auth\.json|\.npmrc|\.netrc)$/.test(name)
    || /^\.env(?:\.|$)/.test(name) && !/^\.env\.(?:example|sample|template)$/.test(name)
    || /\.(?:pem|key|p12|pfx)$/.test(name);
}

interface FileInventory { cached: string[]; repositories: string[]; plainDirectories: string[] }

function relativeName(scope: string, root: string, file: string): string {
  return path.relative(scope, path.join(root, file)).split(path.sep).join('/');
}

function within(directory: string, target: string): boolean {
  const relative = path.relative(directory, target);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

async function nestedGitDirectory(root: string, scope: string, ancestors: string[]): Promise<string> {
  const metadata = await fs.lstat(path.join(root, '.git'));
  const name = JSON.stringify(path.relative(scope, root).split(path.sep).join('/'));
  if (metadata.isSymbolicLink() || !metadata.isFile() && !metadata.isDirectory()) {
    throw new Error(`Unsupported nested Git metadata at ${name}`);
  }
  const gitDirectory = await fs.realpath(await gitText(root, ['rev-parse', '--absolute-git-dir']));
  const common = await fs.realpath(path.resolve(root, await gitText(root, ['rev-parse', '--git-common-dir'])));
  if (ancestors.includes(common)) throw new Error(`Nested worktree shares an ancestor repository at ${name}; exclude it before delegating`);
  const embedded = metadata.isDirectory() && gitDirectory === await fs.realpath(path.join(root, '.git'));
  const submodule = metadata.isFile() && ancestors.some(parent => within(path.join(parent, 'modules'), gitDirectory));
  if ((!embedded && !submodule) || common !== gitDirectory) {
    throw new Error(`Nested Git metadata is outside the permitted repository boundary at ${name}; manual recovery is required`);
  }
  if (await fs.realpath(await gitText(root, ['rev-parse', '--show-toplevel'])) !== root) {
    throw new Error(`Nested Git repository root does not match ${name}`);
  }
  return gitDirectory;
}

async function validateNestedConfig(root: string): Promise<void> {
  try {
    const configured = await gitText(root, ['config', '--show-scope', '--name-only', '--get-regexp',
      '^(filter\\..*\\.(clean|smudge|process)|extensions\\.partialclone|remote\\..*\\.promisor)$']);
    // Global filters are already trusted by the selected outer repository. Do
    // not discover and execute additional commands from nested-local config.
    if (configured.split('\n').some(line => /^(local|worktree)\s/.test(line) || /\s(?:extensions\.partialclone|remote\..*\.promisor)$/.test(line))) {
      throw new Error('Nested repository filters or partial-clone configuration require manual recovery');
    }
  } catch (error) {
    if (!(error instanceof GitCommandError && error.code === 1)) throw error;
  }
}

async function validateFiles(root: string, scope: string, ancestors: string[], env?: Record<string, string>): Promise<FileInventory> {
  const untracked = entries(await runGit(root, ['ls-files', '-z', '--others', '--exclude-standard'], undefined, env));
  const sensitive = untracked.find(sensitiveUntracked);
  if (sensitive) {
    throw new Error(`Untracked credential/config file ${JSON.stringify(relativeName(scope, root, sensitive))} prevents a safe checkpoint. Exclude it with Git ignore rules before delegating.`);
  }
  const staged = entries(await runGit(root, ['ls-files', '--stage', '-z'], undefined, env));
  const cached = staged.map(entry => entry.slice(entry.indexOf('\t') + 1));
  const gitlinks = new Set(staged.filter(entry => entry.startsWith('160000 ')).map(entry => entry.slice(entry.indexOf('\t') + 1)));
  const files = [...new Set(cached.concat(untracked.map(file => file.replace(/\/$/, ''))))];
  const parents = new Set<string>();
  const checked = new Set<string>();
  const repositories = new Set<string>();
  const plainDirectories: string[] = [];
  const checkRepository = async (directory: string): Promise<void> => {
    if (directory === '.' || checked.has(directory)) return;
    checked.add(directory);
    const absolute = path.join(root, directory);
    try {
      await fs.lstat(path.join(absolute, '.git'));
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
      throw error;
    }
    await nestedGitDirectory(absolute, scope, ancestors);
    repositories.add(directory);
  };
  for (const file of files) {
    if (!file || path.isAbsolute(file) || file.split('/').some(part => part === '..' || part.toLowerCase() === '.git')) {
      throw new Error('Unsafe path in the Git checkpoint');
    }
    let parent = path.posix.dirname(file);
    while (parent !== '.' && !parents.has(parent)) {
      parents.add(parent);
      try {
        if ((await fs.lstat(path.join(root, parent))).isSymbolicLink()) {
          throw new Error(`Checkpoint paths cannot cross a symbolic-link directory: ${JSON.stringify(relativeName(scope, root, parent))}`);
        }
        await checkRepository(parent);
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
      parent = path.posix.dirname(parent);
    }
    try {
      const stat = await fs.lstat(path.join(root, file));
      if (stat.isDirectory()) {
        await checkRepository(file);
        // Git also lists the old path when an ordinary tracked file becomes a directory.
        if (gitlinks.has(file) && !repositories.has(file) && (await fs.readdir(path.join(root, file))).length) {
          plainDirectories.push(file);
        }
      } else if (!stat.isFile() && !stat.isSymbolicLink()) {
        const kind = stat.isFIFO() ? 'FIFO' : stat.isSocket() ? 'socket' : 'device or special file';
        throw new Error(`Unsupported checkpoint entry ${JSON.stringify(relativeName(scope, root, file))}: ${kind}`);
      }
      if (stat.isSymbolicLink()) {
        const target = await fs.readlink(path.join(root, file));
        const resolved = path.relative(scope, path.resolve(root, path.dirname(file), target));
        if (path.isAbsolute(target) || resolved === '..' || resolved.startsWith(`..${path.sep}`) || path.isAbsolute(resolved)) {
          throw new Error(`Checkpoint symbolic links must remain relative and inside the repository: ${JSON.stringify(relativeName(scope, root, file))}`);
        }
        try {
          const canonical = path.relative(scope, await fs.realpath(path.join(root, file)));
          if (canonical === '..' || canonical.startsWith(`..${path.sep}`) || path.isAbsolute(canonical)) {
            throw new Error('Checkpoint symbolic-link chain escapes the repository');
          }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  const nested = [...repositories].sort().filter(directory => ![...repositories].some(other => directory.startsWith(`${other}/`)));
  return { cached, repositories: nested, plainDirectories };
}

/** Validate the captured entries after Git filters and filesystem changes. */
async function validateTree(root: string, tree: string): Promise<void> {
  const files = entries(await runGit(root, ['ls-tree', '-r', '-l', '-z', tree]));
  for (const file of files) {
    const header = file.slice(0, file.indexOf('\t')).trim().split(/\s+/);
    const size = Number(header[3]);
    const gitlink = header[0] === '160000' && header[1] === 'commit' && GIT_OID.test(header[2]);
    if (!gitlink && (!/^(100644|100755|120000)$/.test(header[0]) || header[1] !== 'blob' || !Number.isSafeInteger(size) || size < 0)) {
      throw new Error('Checkpoint tree contains an unsupported entry');
    }
  }
}

export async function createCheckpointCommit(root: string, tree: string, parent: string, label: string): Promise<string> {
  if (!GIT_OID.test(tree) || !GIT_OID.test(parent)) throw new Error('Invalid checkpoint object ID');
  const commit = await gitText(root, ['commit-tree', tree, '-p', parent], `${label}\n`, {
    GIT_AUTHOR_NAME: 'Remote CLI', GIT_AUTHOR_EMAIL: 'remote-cli@example.com',
    GIT_COMMITTER_NAME: 'Remote CLI', GIT_COMMITTER_EMAIL: 'remote-cli@example.com',
  });
  if (!GIT_OID.test(commit)) throw new Error('Git returned an invalid checkpoint commit');
  return commit;
}

async function checkpointHead(root: string, nested: boolean): Promise<string> {
  try { return await gitText(root, ['rev-parse', '--verify', 'HEAD']); }
  catch (error) {
    if (nested && error instanceof GitCommandError) {
      const branch = await gitText(root, ['symbolic-ref', '-q', 'HEAD']);
      try { await runGit(root, ['show-ref', '--verify', '--quiet', branch]); }
      catch (missing) { if (missing instanceof GitCommandError && missing.code === 1) return ''; }
    }
    throw new Error(`Git checkpoint requires a usable HEAD${nested ? '' : ' and an initial commit'}`);
  }
}

interface TreeCapture { head: string; tree: string; index: Buffer; repositories: NestedRepositoryCheckpoint[] }

async function validateIndexFlags(root: string, env: Record<string, string>): Promise<void> {
  const flags = entries(await runGit(root, ['ls-files', '-v', '-z'], undefined, env));
  // Preserve the source index and never guess whether sparse absences are deletions.
  if (flags.some(entry => /^[a-zS] /.test(entry))) {
    throw new Error('Git checkpoints cannot include assume-unchanged or skip-worktree entries. Resolve those flags and sparse checkouts explicitly before delegating.');
  }
}

async function captureTree(root: string, scope: string, nested: boolean, imported: Set<string>, ancestors: string[]): Promise<TreeCapture> {
  if (nested) await validateNestedConfig(root);
  const head = await checkpointHead(root, nested);
  if ((await runGit(root, ['ls-files', '-u', '-z'])).length) throw new Error('Resolve the existing Git index conflicts before delegating');
  const originalIndex = await readIndex(root);
  let inventory = await validateFiles(root, scope, ancestors);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-cli-checkpoint-'));
  try {
    const env = { GIT_INDEX_FILE: path.join(directory, 'index') };
    if (originalIndex.bytes.length) {
      await fs.writeFile(env.GIT_INDEX_FILE, originalIndex.bytes, { mode: 0o600 });
      // Git's racy-clean check compares file times with the index's own time.
      // A fresh copy timestamp can incorrectly bless same-size stale entries.
      if (originalIndex.mtime) await fs.utimes(env.GIT_INDEX_FILE, originalIndex.mtime, originalIndex.mtime);
    } else await runGit(root, head ? ['read-tree', head] : ['read-tree', '--empty'], undefined, env);
    await validateIndexFlags(root, env);
    for (;;) {
      const replaced = inventory.repositories.concat(inventory.plainDirectories);
      const removed = inventory.cached.filter(file => replaced.some(directory => file === directory || file.startsWith(`${directory}/`)));
      if (!removed.length) break;
      await runGit(root, ['update-index', '--force-remove', '-z', '--stdin'], `${removed.join('\0')}\0`, env);
      // Replacing a gitlink can expose more embedded repositories. Preserve
      // earlier discoveries even if outer ignore rules now hide their paths.
      const next = await validateFiles(root, scope, ancestors, env);
      const discovered = [...new Set([...inventory.repositories, ...next.repositories])].sort();
      inventory = { ...next, repositories: discovered.filter(directory => !discovered.some(other => directory.startsWith(`${other}/`))) };
    }
    await runGit(root, ['add', '--all', '--', '.', ...inventory.repositories.map(directory => `:(top,exclude,literal)${directory}`)], undefined, env);
    const repositories: NestedRepositoryCheckpoint[] = [];
    for (const relative of inventory.repositories) {
      const child = path.join(root, relative);
      try {
        const gitDirectory = await nestedGitDirectory(child, scope, ancestors);
        const snapshot = await captureTree(child, scope, true, imported, [...ancestors, gitDirectory]);
        const transfer = JSON.stringify([root, snapshot.tree]);
        if (!imported.has(transfer)) {
          await importGitTree(child, root, snapshot.tree);
          imported.add(transfer);
        }
        await runGit(root, ['read-tree', `--prefix=${relative}/`, snapshot.tree], undefined, env);
        const metadata = await fs.stat(gitDirectory);
        repositories.push({ path: relative, identity: createHash('sha256')
          .update(JSON.stringify([gitDirectory, metadata.dev, metadata.ino, metadata.birthtimeMs])).digest('hex'),
          revision: checkpointRevision(snapshot.head, snapshot.tree, snapshot.index, snapshot.repositories) });
        repositories.push(...snapshot.repositories.map(repository => ({ ...repository, path: `${relative}/${repository.path}` })));
      } catch (error) {
        throw new Error(`Nested checkpoint ${JSON.stringify(relativeName(scope, root, relative))} failed: ${(error as Error).message}`);
      }
    }
    const tree = await gitText(root, ['write-tree'], undefined, env);
    if (head !== await checkpointHead(root, nested) || !originalIndex.bytes.equals((await readIndex(root)).bytes)) {
      throw new Error('Workspace changed while its checkpoint was being captured; retry after edits stop');
    }
    if (!GIT_OID.test(tree)) throw new Error('Git returned an invalid checkpoint tree');
    await validateTree(root, tree);
    return { head, tree, index: originalIndex.bytes, repositories };
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

/** Flatten nested working files in private trees; never alter any source HEAD or index. */
export async function captureCheckpoint(root: string): Promise<GitCheckpoint> {
  root = await fs.realpath(root);
  // Reuse only transfers completed in this capture, never just an existing tree
  // object that could still reference missing descendants in the object store.
  const imported = new Set<string>();
  const common = await fs.realpath(path.resolve(root, await gitText(root, ['rev-parse', '--git-common-dir'])));
  const gitDirectory = await fs.realpath(await gitText(root, ['rev-parse', '--absolute-git-dir']));
  const ancestors = [...new Set([common, gitDirectory])];
  const first = await captureTree(root, root, false, imported, ancestors);
  const second = await captureTree(root, root, false, imported, ancestors);
  const revision = checkpointRevision(first.head, first.tree, first.index, first.repositories);
  if (revision !== checkpointRevision(second.head, second.tree, second.index, second.repositories)) {
    throw new Error('Workspace changed while its checkpoint was being captured; retry after edits stop');
  }
  return { head: first.head, tree: first.tree,
    commit: await createCheckpointCommit(root, first.tree, first.head, `Remote CLI input checkpoint ${randomUUID()}`),
    revision, ...(first.repositories.length ? { repositories: first.repositories } : {}) };
}
