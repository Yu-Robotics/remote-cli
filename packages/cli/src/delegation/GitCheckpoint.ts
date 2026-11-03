import { sharedLinkBlob, SharedLinkCapture, type SharedLinkOptions, type SharedLinkBinding, type SharedSymlinkPolicy } from './SharedSymlinks';
import { ownedSpawn as spawn } from './OwnershipRuntime';
import { createHash, randomUUID } from 'crypto';
import { constants } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { checkFilesInBatches } from './BoundedFileChecks';

export const CHECKPOINT_LIMITS = { commandMs: 15_000, checkoutMs: 120_000, outputBytes: 32 * 1024 * 1024 } as const;
export const GIT_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/** Match Git for Windows without folding alias/.. components or changing POSIX names. */
export function gitLinkTarget(target: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? target.replace(/\\/g, '/') : target;
}

export interface GitCheckpoint {
  head: string;
  tree: string;
  commit: string;
  revision: string;
  repositories?: NestedRepositoryCheckpoint[];
  sharedLinks?: SharedLinkBinding[];
  sharedSymlinkPolicy?: SharedSymlinkPolicy;
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
    // Skip configuration values for labels only; deadlines match fixed call sites.
    let operationIndex = 0;
    while (args[operationIndex] === '-c' && operationIndex + 1 < args.length) operationIndex += 2;
    const command = args[operationIndex];
    const subcommand = args[operationIndex + 1];
    const worktreeOperation = command === 'worktree' && ['add', 'list', 'remove'].includes(subcommand);
    const operation = worktreeOperation ? `worktree ${subcommand}` : command;
    const timeoutMs = args[0] === 'checkout' || (args[0] === 'worktree' && args[1] === 'add')
      ? CHECKPOINT_LIMITS.checkoutMs : CHECKPOINT_LIMITS.commandMs;
    const startedAt = Date.now();
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
    const timer = setTimeout(() => stop(new Error(`Git ${operation} timed out after ${Date.now() - startedAt}ms (limit ${timeoutMs}ms)`)), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > CHECKPOINT_LIMITS.outputBytes) stop(new Error(`Git ${operation} output exceeded the checkpoint limit`));
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => { detail = (detail + chunk.toString('utf8')).slice(-2000); });
    child.on('error', error => { failure = error; });
    child.stdin.on('error', () => { /* The exit event reports a rejected input pipe. */ });
    child.on('close', code => {
      clearTimeout(timer); clearTimeout(killTimer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new GitCommandError(operation, code, detail.trim()));
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
  repositories: NestedRepositoryCheckpoint[] = [], shared?: { policy: SharedSymlinkPolicy; links: SharedLinkBinding[] }): string {
  const hash = createHash('sha256').update(head).update('\0').update(tree).update('\0').update(index);
  if (repositories.length) hash.update('\0repositories\0').update(JSON.stringify(repositories));
  if (shared) hash.update('\0shared-links-v1\0').update(JSON.stringify(shared));
  return hash.digest('hex');
}

async function packFileHash(file: string): Promise<string> {
  const before = await fs.lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Unsafe existing Git pack entry');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const same = (stat: typeof before) => stat.isFile() && stat.dev === before.dev && stat.ino === before.ino
      && stat.size === before.size && stat.mtimeNs === before.mtimeNs && stat.ctimeNs === before.ctimeNs;
    if (!same(await handle.stat({ bigint: true }))) throw new Error('Git pack identity changed');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let size = 0n;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += BigInt(bytesRead);
      if (size > before.size) throw new Error('Git pack grew during verification');
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (size !== before.size || !same(await handle.stat({ bigint: true })) || !same(await fs.lstat(file, { bigint: true }))) {
      throw new Error('Git pack changed during verification');
    }
    return hash.digest('hex');
  } finally { await handle.close(); }
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
    for (const file of files) {
      const sourceFile = path.join(incoming, 'pack', file);
      const targetFile = path.join(published, file);
      try {
        // Both directories are on the object-store volume. An exclusive hard
        // link publishes complete bytes atomically, including on Windows where
        // rename cannot replace an existing read-only Git pack.
        await fs.link(sourceFile, targetFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (await packFileHash(sourceFile) !== await packFileHash(targetFile)) {
          throw new Error('Existing Git pack differs from the completed transfer');
        }
      }
    }
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
      if (failure) return;
      failure = error;
      // A full receiver pipe can pause stdout again after the producer exits.
      // Break that dependency and drain unread output so both close events can
      // arrive, while still waiting for confirmed child exit before cleanup.
      pack.stdout.unpipe(unpack.stdin);
      pack.stdout.resume();
      pack.stdin.destroy();
      unpack.stdin.destroy();
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

async function readIndex(file: string): Promise<{ bytes: Buffer; mtime?: Date }> {
  try {
    const stat = await fs.stat(file);
    if (stat.size > CHECKPOINT_LIMITS.outputBytes) throw new Error('Git index exceeds the checkpoint limit');
    const bytes = await fs.readFile(file);
    // ENOENT permits bootstrap; an existing zero-byte file is damaged metadata,
    // not a valid empty Git index. Never silently reconstruct it from HEAD.
    if (!bytes.length) throw new Error('Git index is empty or corrupt; repair the existing index before delegating');
    return { bytes, mtime: stat.mtime };
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

interface SymbolicLinkSnapshot { target: string; identity: string }
interface FileInventory {
  cached: string[];
  repositories: string[];
  plainDirectories: string[];
  shadowed: string[];
  links: Map<string, SymbolicLinkSnapshot>;
}

async function validateLinkTarget(root: string, scope: string, file: string, target: string, shared?: SharedLinkCapture, logical = false): Promise<void> {
  if (shared && await shared.accept(root, scope, file, target, logical)) return;
  const resolved = path.resolve(root, path.dirname(file), target);
  if (path.isAbsolute(target) || !within(scope, resolved)) {
    throw new Error(`Checkpoint symbolic links must remain relative and inside the repository: ${JSON.stringify(relativeName(scope, root, file))}`);
  }
  try {
    // Keep target components intact: normalizing alias/.. first could hide an
    // escape through a symlink that the filesystem resolves before the parent.
    const original = `${path.join(root, path.dirname(file))}${path.sep}${target}`;
    if (!within(scope, await fs.realpath(original))) throw new Error('Checkpoint symbolic-link chain escapes the repository');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

/** Read only the link itself, after ruling out linked ancestors. */
async function snapshotSymbolicLink(root: string, scope: string, file: string, shared?: SharedLinkCapture): Promise<SymbolicLinkSnapshot> {
  const parts = file.split('/');
  for (let count = 1; count < parts.length; count++) {
    if ((await fs.lstat(path.join(root, ...parts.slice(0, count)))).isSymbolicLink()) {
      throw new Error('Checkpoint symbolic-link ancestor changed during capture');
    }
  }
  const absolute = path.join(root, file);
  const identity = async () => {
    const stat = await fs.lstat(absolute, { bigint: true });
    if (!stat.isSymbolicLink()) throw new Error('Checkpoint symbolic link changed during capture');
    return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  };
  const before = await identity();
  const target = await fs.readlink(absolute);
  await validateLinkTarget(root, scope, file, target, shared);
  // Retain the original live-link canonical check as well as validating the
  // captured target text; platform path handling must not weaken containment.
  try {
    if (!within(scope, await fs.realpath(absolute)) && !(shared && await shared.accept(root, scope, file, target))) throw new Error('Checkpoint symbolic-link chain escapes the repository');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (before !== await identity() || target !== await fs.readlink(absolute)) {
    throw new Error('Checkpoint symbolic link changed during capture');
  }
  return { target, identity: before };
}

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

/** Reject nested grants before Git can recursively inventory any source paths. */
async function sharedPathspecs(root: string, scope: string, shared?: SharedLinkCapture): Promise<string[]> {
  const paths = shared?.paths ?? [];
  const unsupported = () => new Error('Shared-symlink grants inside nested repositories are not supported; move the link to the outer repository.');
  if (root !== scope) {
    const prefix = path.relative(scope, root).split(path.sep).join('/') + '/';
    if (paths.some(file => file.startsWith(prefix))) throw unsupported();
    return [];
  }
  const checked = new Set<string>();
  const exists = async (file: string): Promise<boolean> => {
    try { await fs.lstat(file); return true; }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false; throw error; }
  };
  for (const file of paths) {
    const parts = file.split('/');
    for (let count = 1; count < parts.length; count++) {
      const directory = path.join(root, ...parts.slice(0, count));
      if (checked.has(directory)) continue;
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== directory) {
        throw new Error('Checkpoint shared-link ancestor changed during capture');
      }
      if (await exists(path.join(directory, '.git'))
        || await exists(path.join(directory, 'HEAD')) && await exists(path.join(directory, 'objects')) && await exists(path.join(directory, 'refs'))) {
        throw unsupported();
      }
      checked.add(directory);
    }
  }
  // Literal directory pathspecs exclude the exact node and all descendants,
  // even if a validated link changes to a directory before native Git starts.
  return paths.map(file => `:(top,exclude,literal)${file}`);
}

async function validateFiles(root: string, scope: string, ancestors: string[], env?: Record<string, string>, shared?: SharedLinkCapture, exclusions: readonly string[] = []): Promise<FileInventory> {
  const untracked = entries(await runGit(root, ['ls-files', '-z', '--others', '--exclude-standard', ...(exclusions.length ? ['--', '.', ...exclusions] : [])], undefined, env));
  const sensitive = untracked.find(sensitiveUntracked);
  if (sensitive) {
    throw new Error(`Untracked credential/config file ${JSON.stringify(relativeName(scope, root, sensitive))} prevents a safe checkpoint. Exclude it with Git ignore rules before delegating.`);
  }
  // One read of the checkpoint index provides paths, conflict stages, and
  // hidden-entry flags. Never clear flags or rely on Git add to reveal them.
  const staged = entries(await runGit(root, ['ls-files', '--stage', '-v', '-z'], undefined, env)).map(entry => {
    const header = entry.slice(0, entry.indexOf('\t'));
    const fields = /^([A-Za-z?]) ([0-7]{6}) ([a-f0-9]+) ([0-3])$/.exec(header);
    if (!fields || !GIT_OID.test(fields[3])) throw new Error('Invalid Git checkpoint index entry');
    if (fields[4] !== '0') throw new Error('Resolve the existing Git index conflicts before delegating');
    if (/^[a-zS]$/.test(fields[1])) {
      throw new Error('Git checkpoints cannot include assume-unchanged or skip-worktree entries. Resolve those flags and sparse checkouts explicitly before delegating.');
    }
    return entry.slice(2);
  });
  if (shared?.physical && root === scope) {
    for (const binding of shared.bindings) {
      const entry = staged.find(e => e.slice(e.indexOf('\t') + 1) === binding.path);
      const match = entry && /^120000 ([a-f0-9]+) 0\t/.exec(entry);
      if (!match || sharedLinkBlob(binding.linkText, match[1].length) !== match[1]) {
        throw new Error('Shared link-node index changes require manual recovery');
      }
    }
  }
  const cached = staged.map(entry => entry.slice(entry.indexOf('\t') + 1));
  const gitlinks = new Set(staged.filter(entry => entry.startsWith('160000 ')).map(entry => entry.slice(entry.indexOf('\t') + 1)));
  const files = [...new Set(cached.concat(untracked.map(file => file.replace(/\/$/, '')), root === scope ? shared?.paths ?? [] : []))];
  const sharedPaths = new Set(root === scope ? shared?.paths ?? [] : []);
  const cachedPaths = new Set(cached);
  const shadowed = new Set<string>();
  const links = new Map<string, Promise<SymbolicLinkSnapshot>>();
  const recordLink = (file: string) => {
    let checking = links.get(file);
    if (!checking) { checking = snapshotSymbolicLink(root, scope, file, shared); links.set(file, checking); }
    return checking;
  };
  const parents = new Map<string, Promise<string | undefined>>();
  const checked = new Map<string, Promise<void>>();
  const repositories = new Set<string>();
  const plainDirectories: string[] = [];
  const checkRepository = (directory: string): Promise<void> => {
    if (directory === '.') return Promise.resolve();
    let checking = checked.get(directory);
    if (!checking) {
      checking = (async () => {
        const absolute = path.join(root, directory);
        try {
          await fs.lstat(path.join(absolute, '.git'));
        } catch (error) {
          if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
          throw error;
        }
        await nestedGitDirectory(absolute, scope, ancestors);
        repositories.add(directory);
      })();
      checked.set(directory, checking);
    }
    return checking;
  };
  const checkParent = (directory: string): Promise<string | undefined> => {
    if (directory === '.') return Promise.resolve(undefined);
    let checking = parents.get(directory);
    if (!checking) {
      checking = (async () => {
        // Shared promises make every sibling await the same complete ancestor
        // validation, including rejection, before inspecting its own entry.
        const ancestor = await checkParent(path.posix.dirname(directory));
        if (ancestor) return ancestor;
        if (sharedPaths.has(directory)) { await recordLink(directory); return directory; }
        try {
          if ((await fs.lstat(path.join(root, directory))).isSymbolicLink()) {
            await recordLink(directory);
            return directory;
          }
          await checkRepository(directory);
        } catch (error) {
          if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        }
      })();
      parents.set(directory, checking);
    }
    return checking;
  };
  await checkFilesInBatches(files, async file => {
    if (!file || path.isAbsolute(file) || file.split('/').some(part => part === '..' || part.toLowerCase() === '.git')) {
      throw new Error('Unsafe path in the Git checkpoint');
    }
    const ancestor = await checkParent(path.posix.dirname(file));
    if (ancestor) {
      // Only copied index entries may be shadowed. A newly discovered child
      // crossing a link indicates inventory churn, not permission to traverse it.
      if (!cachedPaths.has(file)) throw new Error('Checkpoint paths changed across a symbolic-link directory');
      shadowed.add(file);
      return;
    }
    if (sharedPaths.has(file)) { await recordLink(file); return; }
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
      if (stat.isSymbolicLink()) await recordLink(file);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  });
  const nested = [...repositories].sort().filter(directory => ![...repositories].some(other => directory.startsWith(`${other}/`)));
  if (root === scope && shared?.paths.some(file => nested.some(directory => file.startsWith(`${directory}/`)))) {
    throw new Error('Shared-symlink grants inside nested repositories are not supported; move the link to the outer repository.');
  }
  return { cached, repositories: nested, plainDirectories, shadowed: [...shadowed],
    links: new Map(await Promise.all([...links].map(async ([file, checking]) => [file, await checking] as const))) };
}

/** Validate the captured entries after Git filters and filesystem changes. */
async function validateTree(root: string, scope: string, tree: string, links: Map<string, SymbolicLinkSnapshot>, shared?: SharedLinkCapture): Promise<void> {
  const files = entries(await runGit(root, ['ls-tree', '-r', '-l', '-z', tree]));
  const capturedLinks = new Set<string>();
  for (const file of files) {
    const header = file.slice(0, file.indexOf('\t')).trim().split(/\s+/);
    const size = Number(header[3]);
    const gitlink = header[0] === '160000' && header[1] === 'commit' && GIT_OID.test(header[2]);
    if (!gitlink && (!/^(100644|100755|120000)$/.test(header[0]) || header[1] !== 'blob' || !Number.isSafeInteger(size) || size < 0)) {
      throw new Error('Checkpoint tree contains an unsupported entry');
    }
    const name = file.slice(file.indexOf('\t') + 1);
    if (header[0] === '120000') {
      const bytes = await runGit(root, ['cat-file', 'blob', header[2]]);
      const target = bytes.toString('utf8');
      if (!Buffer.from(target).equals(bytes) || !target || target.includes('\0')) throw new Error('Invalid checkpoint symbolic-link target');
      await validateLinkTarget(root, scope, name, target, shared, true);
      const binding = root === scope ? shared?.bindings.find(b => b.path === name) : undefined;
      if (links.has(name) && (binding?.linkText ?? gitLinkTarget(links.get(name)!.target)) !== target) throw new Error('Checkpoint symbolic link changed during capture');
      capturedLinks.add(name);
    }
  }
  for (const file of links.keys()) {
    if (!capturedLinks.has(file)) throw new Error('Checkpoint symbolic link changed during capture');
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

interface TreeCapture { head: string; tree: string; index: Buffer; repositories: NestedRepositoryCheckpoint[]; links: Map<string, SymbolicLinkSnapshot> }

async function captureTree(root: string, scope: string, nested: boolean, imported: Set<string>,
  validatedTrees: Set<string>, ancestors: string[], shared?: SharedLinkCapture): Promise<TreeCapture> {
  const exclusions = await sharedPathspecs(root, scope, shared);
  if (root === scope) await shared?.verify();
  if (nested) await validateNestedConfig(root);
  const head = await checkpointHead(root, nested);
  // Resolve the index once per pass, but reread its bytes at the end. The next
  // pass resolves it afresh; no repository metadata is cached across passes.
  const indexFile = path.resolve(root, await gitText(root, ['rev-parse', '--git-path', 'index']));
  const originalIndex = await readIndex(indexFile);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-cli-checkpoint-'));
  try {
    const env = { GIT_INDEX_FILE: path.join(directory, 'index') };
    if (originalIndex.bytes.length) {
      await fs.writeFile(env.GIT_INDEX_FILE, originalIndex.bytes, { mode: 0o600 });
      // Git's racy-clean check compares file times with the index's own time.
      // A fresh copy timestamp can incorrectly bless same-size stale entries.
      if (originalIndex.mtime) await fs.utimes(env.GIT_INDEX_FILE, originalIndex.mtime, originalIndex.mtime);
    } else await runGit(root, head ? ['read-tree', head] : ['read-tree', '--empty'], undefined, env);
    let inventory = await validateFiles(root, scope, ancestors, env, shared, exclusions);
    const links = new Map<string, SymbolicLinkSnapshot>();
    const rememberLinks = () => {
      for (const [file, link] of inventory.links) {
        // Flattened repositories validate their own links in their own capture.
        if (inventory.repositories.some(directory => file.startsWith(`${directory}/`))) continue;
        const prior = links.get(file);
        if (prior && (prior.target !== link.target || prior.identity !== link.identity)) {
          throw new Error('Checkpoint symbolic link changed during capture');
        }
        links.set(file, link);
      }
    };
    const verifyLinks = async () => {
      for (const [file, expected] of links) {
        const current = await snapshotSymbolicLink(root, scope, file, shared);
        if (current.target !== expected.target || current.identity !== expected.identity) {
          throw new Error('Checkpoint symbolic link changed during capture');
        }
      }
    };
    rememberLinks();
    for (;;) {
      const replaced = inventory.repositories.concat(inventory.plainDirectories);
      const shadowed = new Set(inventory.shadowed);
      const removed = inventory.cached.filter(file => shadowed.has(file)
        || replaced.some(directory => file === directory || file.startsWith(`${directory}/`)));
      if (!removed.length) break;
      await verifyLinks();
      await runGit(root, ['update-index', '--force-remove', '-z', '--stdin'], `${removed.join('\0')}\0`, env);
      // Insert opaque link text, never force-add a filesystem path that could
      // turn into a directory and sweep ignored content during a race.
      const shadowingLinks = new Set<string>();
      for (const child of shadowed) {
        for (let parent = path.posix.dirname(child); parent !== '.'; parent = path.posix.dirname(parent)) {
          if (links.has(parent)) { shadowingLinks.add(parent); break; }
        }
      }
      const replacements: string[] = [];
      for (const [file, link] of links) {
        if (!shadowingLinks.has(file)) continue;
        const blob = await gitText(root, ['hash-object', '-w', '--stdin'], gitLinkTarget(link.target));
        if (!GIT_OID.test(blob)) throw new Error('Git returned an invalid symbolic-link blob');
        replacements.push(`120000 ${blob}\t${file}\0`);
      }
      if (replacements.length) await runGit(root, ['update-index', '-z', '--index-info'], replacements.join(''), env);
      if (originalIndex.mtime) await fs.utimes(env.GIT_INDEX_FILE, originalIndex.mtime, originalIndex.mtime);
      // Replacing a gitlink can expose more embedded repositories. Preserve
      // earlier discoveries even if outer ignore rules now hide their paths.
      const next = await validateFiles(root, scope, ancestors, env, shared, exclusions);
      const discovered = [...new Set([...inventory.repositories, ...next.repositories])].sort();
      inventory = { ...next, repositories: discovered.filter(directory => !discovered.some(other => directory.startsWith(`${other}/`))) };
      rememberLinks();
    }
    await verifyLinks();
    await runGit(root, ['add', '--all', '--', '.', ...inventory.repositories.map(directory => `:(top,exclude,literal)${directory}`), ...exclusions], undefined, env);
    await verifyLinks();
    if (links.size || root === scope && shared?.bindings.length) {
      await shared?.verify();
      // Ordinary links use Git's Windows separator representation so an
      // unchanged checkout remains clean after index refresh. Preserve raw
      // component order and the recorded logical text of mapped shared links.
      const targets = new Map([...links].map(([file, link]) => [file, gitLinkTarget(link.target)]));
      if (root === scope) for (const binding of shared?.bindings ?? []) targets.set(binding.path, binding.linkText);
      const normalized: string[] = [];
      for (const [file, target] of targets) {
        const blob = await gitText(root, ['hash-object', '-w', '--stdin'], target);
        if (!GIT_OID.test(blob)) throw new Error('Git returned an invalid symbolic-link blob');
        normalized.push(`120000 ${blob}\t${file}\0`);
      }
      await runGit(root, ['update-index', '-z', '--index-info'], normalized.join(''), env);
      await verifyLinks();
      await shared?.verify();
    }
    const repositories: NestedRepositoryCheckpoint[] = [];
    for (const relative of inventory.repositories) {
      const child = path.join(root, relative);
      try {
        const gitDirectory = await nestedGitDirectory(child, scope, ancestors);
        const snapshot = await captureTree(child, scope, true, imported, validatedTrees, [...ancestors, gitDirectory], shared);
        for (const [file, link] of snapshot.links) links.set(`${relative}/${file}`, link);
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
    if (head !== await checkpointHead(root, nested) || !originalIndex.bytes.equals((await readIndex(indexFile)).bytes)) {
      throw new Error('Workspace changed while its checkpoint was being captured; retry after edits stop');
    }
    if (!GIT_OID.test(tree)) throw new Error('Git returned an invalid checkpoint tree');
    // Identical content-addressed trees need one successful entry audit per
    // repository in this capture. Working-file inventories still run twice.
    const validation = JSON.stringify([root, tree]);
    if (!validatedTrees.has(validation) || links.size) {
      await validateTree(root, scope, tree, links, shared);
      validatedTrees.add(validation);
    }
    await verifyLinks();
    return { head, tree, index: originalIndex.bytes, repositories, links };
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

/** Flatten nested working files in private trees; never alter any source HEAD or index. */
export async function captureCheckpoint(root: string, options: SharedLinkOptions = {}): Promise<GitCheckpoint> {
  root = await fs.realpath(root);
  // Reuse only transfers completed in this capture, never just an existing tree
  // object that could still reference missing descendants in the object store.
  const imported = new Set<string>();
  const validatedTrees = new Set<string>();
  const common = await fs.realpath(path.resolve(root, await gitText(root, ['rev-parse', '--git-common-dir'])));
  const gitDirectory = await fs.realpath(await gitText(root, ['rev-parse', '--absolute-git-dir']));
  const ancestors = [...new Set([common, gitDirectory])];
  const shared = options.policy || options.bindings || options.sharedSymlinks !== undefined
    ? new SharedLinkCapture(root, { ...options, forbiddenTargets: [...(options.forbiddenTargets ?? []), common, gitDirectory] }) : undefined;
  await shared?.initialize();
  const first = await captureTree(root, root, false, imported, validatedTrees, ancestors, shared);
  const second = await captureTree(root, root, false, imported, validatedTrees, ancestors, shared);
  const payload = shared?.bindings.length ? { policy: shared.policy, links: shared.bindings } : undefined;
  const revision = checkpointRevision(first.head, first.tree, first.index, first.repositories, payload);
  const linksChanged = first.links.size !== second.links.size || [...first.links].some(([file, link]) => {
    const next = second.links.get(file);
    return !next || next.target !== link.target || next.identity !== link.identity;
  });
  if (linksChanged || revision !== checkpointRevision(second.head, second.tree, second.index, second.repositories, payload)) {
    throw new Error('Workspace changed while its checkpoint was being captured; retry after edits stop');
  }
  return { head: first.head, tree: first.tree,
    commit: await createCheckpointCommit(root, first.tree, first.head, `Remote CLI input checkpoint ${randomUUID()}`),
    revision, ...(first.repositories.length ? { repositories: first.repositories } : {}),
    ...(payload ? { sharedSymlinkPolicy: payload.policy, sharedLinks: payload.links } : {}) };
}
