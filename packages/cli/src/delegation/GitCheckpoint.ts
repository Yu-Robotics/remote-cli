import { spawn } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

export const CHECKPOINT_LIMITS = { files: 10_000, bytes: 128 * 1024 * 1024,
  commandMs: 15_000, outputBytes: 32 * 1024 * 1024 } as const;
export const GIT_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export interface GitCheckpoint {
  head: string;
  tree: string;
  commit: string;
  revision: string;
}

export class GitCommandError extends Error {
  constructor(readonly command: string, readonly code: number | null, readonly detail: string) {
    super(`Git ${command} failed${code === null ? '' : ` (${code})`}: ${detail.slice(0, 600)}`);
  }
}

/** Fixed argv only; neither a shell nor the user's Git environment selects the repository. */
export async function runGit(cwd: string, args: string[], input?: Buffer | string,
  extraEnv: Record<string, string> = {}): Promise<Buffer> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
      '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], {
      cwd, env: { ...env, LC_ALL: 'C', ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'],
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

export function checkpointRevision(head: string, tree: string, index: Buffer): string {
  return createHash('sha256').update(head).update('\0').update(tree).update('\0').update(index).digest('hex');
}

async function readIndex(root: string): Promise<Buffer> {
  const file = path.resolve(root, await gitText(root, ['rev-parse', '--git-path', 'index']));
  try {
    if ((await fs.stat(file)).size > CHECKPOINT_LIMITS.outputBytes) throw new Error('Git index exceeds the checkpoint limit');
    return await fs.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0);
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

async function boundFiles(root: string): Promise<void> {
  const untracked = entries(await runGit(root, ['ls-files', '-z', '--others', '--exclude-standard']));
  if (untracked.some(sensitiveUntracked)) {
    throw new Error('Untracked credential/config files prevent a safe checkpoint. Exclude them with Git ignore rules before delegating.');
  }
  const files = [...new Set(entries(await runGit(root, ['ls-files', '-z', '--cached'])).concat(untracked))];
  if (files.length > CHECKPOINT_LIMITS.files) throw new Error('Workspace exceeds the checkpoint file-count limit');
  let bytes = 0;
  const parents = new Set<string>();
  for (const file of files) {
    if (!file || path.isAbsolute(file) || file.split('/').some(part => part === '..' || part.toLowerCase() === '.git')) {
      throw new Error('Unsafe path in the Git checkpoint');
    }
    let parent = path.dirname(file);
    while (parent !== '.' && !parents.has(parent)) {
      parents.add(parent);
      try {
        if ((await fs.lstat(path.join(root, parent))).isSymbolicLink()) throw new Error('Checkpoint paths cannot cross a symbolic-link directory');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      parent = path.dirname(parent);
    }
    try {
      const stat = await fs.lstat(path.join(root, file));
      if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error('Submodules and special files are not supported by Git worktree checkpoints');
      if (stat.isSymbolicLink()) {
        const target = await fs.readlink(path.join(root, file));
        const resolved = path.relative(root, path.resolve(root, path.dirname(file), target));
        if (path.isAbsolute(target) || resolved === '..' || resolved.startsWith(`..${path.sep}`) || path.isAbsolute(resolved)) {
          throw new Error('Checkpoint symbolic links must remain relative and inside the repository');
        }
        try {
          const canonical = path.relative(root, await fs.realpath(path.join(root, file)));
          if (canonical === '..' || canonical.startsWith(`..${path.sep}`) || path.isAbsolute(canonical)) {
            throw new Error('Checkpoint symbolic-link chain escapes the repository');
          }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      bytes += stat.size;
      if (bytes > CHECKPOINT_LIMITS.bytes) throw new Error('Workspace exceeds the checkpoint byte limit');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

/** Filters and concurrent file growth must not enlarge the immutable tree beyond the filesystem preflight. */
async function boundTree(root: string, tree: string): Promise<void> {
  const files = entries(await runGit(root, ['ls-tree', '-r', '-l', '-z', tree]));
  if (files.length > CHECKPOINT_LIMITS.files) throw new Error('Checkpoint tree exceeds the file-count limit');
  let bytes = 0;
  for (const file of files) {
    const header = file.slice(0, file.indexOf('\t')).trim().split(/\s+/);
    const size = Number(header[3]);
    if (header[1] !== 'blob' || !Number.isSafeInteger(size) || size < 0) {
      throw new Error('Checkpoint tree contains an unsupported entry');
    }
    bytes += size;
    if (bytes > CHECKPOINT_LIMITS.bytes) throw new Error('Checkpoint tree exceeds the byte limit');
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

/** Captures working files, including staged/unstaged/untracked input, without writing the user's index. */
export async function captureCheckpoint(root: string): Promise<GitCheckpoint> {
  const head = await gitText(root, ['rev-parse', '--verify', 'HEAD']);
  if (!GIT_OID.test(head)) throw new Error('Git worktree delegation requires an initial commit');
  if ((await runGit(root, ['ls-files', '-u', '-z'])).length) throw new Error('Resolve the existing Git index conflicts before delegating');
  const originalIndex = await readIndex(root);
  await boundFiles(root);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-cli-checkpoint-'));
  try {
    const env = { GIT_INDEX_FILE: path.join(directory, 'index') };
    if (originalIndex.length) await fs.writeFile(env.GIT_INDEX_FILE, originalIndex, { mode: 0o600 });
    else await runGit(root, ['read-tree', head], undefined, env);
    await runGit(root, ['add', '--all', '--', '.'], undefined, env);
    const tree = await gitText(root, ['write-tree'], undefined, env);
    await runGit(root, ['add', '--all', '--', '.'], undefined, env);
    if (tree !== await gitText(root, ['write-tree'], undefined, env)
      || head !== await gitText(root, ['rev-parse', 'HEAD']) || !originalIndex.equals(await readIndex(root))) {
      throw new Error('Workspace changed while its checkpoint was being captured; retry after edits stop');
    }
    if (!GIT_OID.test(tree)) throw new Error('Git returned an invalid checkpoint tree');
    await boundTree(root, tree);
    return { head, tree, commit: await createCheckpointCommit(root, tree, head, `Remote CLI input checkpoint ${randomUUID()}`),
      revision: checkpointRevision(head, tree, originalIndex) };
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
