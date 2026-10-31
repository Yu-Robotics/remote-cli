import { createHash } from 'crypto';
import { constants } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { GIT_OID, gitText, runGit } from './GitCheckpoint';
import { WorkspaceCleanupError } from './WorkspaceDisposal';

const POINTER_BYTES = 1024;

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function hold(): never { throw new WorkspaceCleanupError('lfs-payload-unverified'); }

/** Hash bounded chunks without filters, following neither file nor parent symlinks. */
async function hashFile(file: string, sizes: readonly number[], mode?: string): Promise<{ size: number; sha256: string }> {
  const parent = path.dirname(file);
  if (await fs.realpath(parent) !== parent) hold();
  const before = await fs.lstat(file);
  if (!before.isFile() || !sizes.includes(before.size)) hold();
  if (mode && process.platform !== 'win32' && Boolean(before.mode & 0o111) !== (mode === '100755')) hold();
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const same = (stat: typeof before) => stat.isFile() && stat.dev === before.dev && stat.ino === before.ino
      && stat.mode === before.mode && stat.size === before.size && stat.mtimeMs === before.mtimeMs && stat.ctimeMs === before.ctimeMs;
    if (!same(await handle.stat())) hold();
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let size = 0;
    // Read at most the checked length plus one byte, even if another writer grows it.
    while (size <= before.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - size + 1), null);
      if (!bytesRead) break;
      size += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (size !== before.size || !same(await handle.stat()) || !same(await fs.lstat(file))
      || await fs.realpath(parent) !== parent) hold();
    return { size, sha256: hash.digest('hex') };
  } finally { await handle.close(); }
}

/** Local-only recovery proof. No fetch, clean/smudge filter, or object-store mutation is performed here. */
export class LfsCheckoutVerifier {
  private mediaDirectory?: Promise<string>;

  constructor(private readonly checkout: string, private readonly sourceRoot: string,
    private readonly managedRoot: string) {}

  private async resolveMediaDirectory(): Promise<string> {
    const common = await fs.realpath(path.resolve(this.checkout,
      await gitText(this.checkout, ['rev-parse', '--git-common-dir'])));
    const resolve = async (cwd: string) => {
      // Ask the installed LFS implementation to resolve lfs.storage, including relative
      // and per-worktree configuration. `env` is local metadata, not a network request.
      const output = await gitText(cwd, ['lfs', 'env']);
      const matches = output.split(/\r?\n/).filter(line => line.startsWith('LocalMediaDir='));
      if (matches.length !== 1) hold();
      const directory = matches[0].slice('LocalMediaDir='.length);
      if (!path.isAbsolute(directory) || await fs.realpath(directory) !== directory) hold();
      return directory;
    };
    const directory = await resolve(this.checkout);
    // The surviving source must resolve the same store after the worktree is removed.
    if (directory !== await resolve(this.sourceRoot)
      || inside(this.checkout, directory) || inside(await fs.realpath(this.managedRoot), directory)
      || inside(path.join(common, 'worktrees'), directory)) hold();
    return directory;
  }

  async verify(file: string, blob: string, mode: string): Promise<void> {
    try {
      if (!inside(this.checkout, file) || !['100644', '100755'].includes(mode) || !GIT_OID.test(blob)) hold();
      // Bound the saved blob before reading it. Git object IDs are immutable; no
      // checkout-supplied pointer or attribute can substitute a different blob.
      const length = Number(await gitText(this.sourceRoot, ['cat-file', '-s', blob]));
      if (!Number.isSafeInteger(length) || length < 0 || length >= POINTER_BYTES) hold();
      const pointer = await runGit(this.sourceRoot, ['cat-file', 'blob', blob]);
      if (pointer.length !== length) hold();
      // Git LFS stores empty files as ordinary empty Git blobs, without a pointer
      // or a separate LFS object. The saved blob already preserves all bytes.
      if (length === 0) {
        await hashFile(file, [0], mode);
        return;
      }
      const match = /^version https:\/\/git-lfs.github.com\/spec\/v1\noid sha256:([a-f0-9]{64})\nsize (0|[1-9][0-9]*)\n$/.exec(pointer.toString('ascii'));
      // Extensions and noncanonical encodings require manual recovery for now.
      if (!match || !Buffer.from(match[0], 'ascii').equals(pointer)) hold();
      const [, oid, textSize] = match;
      const size = Number(textSize);
      if (!Number.isSafeInteger(size)) hold();
      const actual = await hashFile(file, [size, pointer.length], mode);
      const materialized = actual.size === size && actual.sha256 === oid;
      const pointerOnly = actual.size === pointer.length
        && actual.sha256 === createHash('sha256').update(pointer).digest('hex');
      if (!materialized && !pointerOnly) hold();
      const media = await (this.mediaDirectory ??= this.resolveMediaDirectory());
      const object = path.join(media, oid.slice(0, 2), oid.slice(2, 4), oid);
      const durable = await hashFile(object, [size]);
      // Even an exact pointer-only checkout is held when the local payload is
      // absent: a Git ref preserves the pointer, not the referenced LFS bytes.
      if (durable.sha256 !== oid) hold();
    } catch {
      // Keep failures actionable without exposing config, object paths, or Git output.
      hold();
    }
  }
}
