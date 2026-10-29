import { randomUUID } from 'crypto';
import { constants, type Stats } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { performance } from 'perf_hooks';
import { setTimeout as delay } from 'timers/promises';

const REPOSITORY_WAIT_MS = 30_000;
const POLL_MS = 50;
const RECOVERY = 'Stop the other owner and confirm all of its delegated children have exited before controlled lock recovery. Locks are never stolen based on PID or age.';

interface DirectoryIdentity {
  path: string;
  stat: Stats;
}

interface Lease {
  path: string;
  parent: DirectoryIdentity;
  stat: Stats;
  contents: Buffer;
}

interface StorageLease {
  directory: DirectoryIdentity;
  lock: Lease;
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

async function directoryIdentity(directory: string): Promise<DirectoryIdentity> {
  const canonical = await fs.realpath(directory);
  const stat = await fs.lstat(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Delegation lock directory is not a regular directory');
  return { path: canonical, stat };
}

async function verifyDirectory(directory: DirectoryIdentity): Promise<void> {
  const current = await fs.lstat(directory.path);
  if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(directory.stat, current)
    || await fs.realpath(directory.path) !== directory.path) {
    throw new Error('Delegation lock directory identity changed; refusing further operations');
  }
}

/** Returns null only for an existing regular lock. Never follows or edits it. */
async function claim(parent: DirectoryIdentity, name: string): Promise<Lease | null> {
  await verifyDirectory(parent);
  const lockPath = path.join(parent.path, name);
  let handle;
  try {
    handle = await fs.open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  } catch (error) {
    if (code(error) !== 'EEXIST') throw error;
    // A contender can finish between exclusive open and lstat. Retry normally.
    const existing = await fs.lstat(lockPath).catch(error => {
      if (code(error) === 'ENOENT') return null;
      throw error;
    });
    if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) {
      throw new Error(`Unsafe delegation lock entry; refusing to follow or remove it. ${RECOVERY}`);
    }
    return null;
  }
  try {
    const contents = Buffer.from(JSON.stringify({ version: 1, token: randomUUID(), pid: process.pid }) + '\n');
    await handle.writeFile(contents);
    await handle.sync();
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== contents.length) throw new Error('Invalid delegation lock identity');
    return { path: lockPath, parent, stat, contents };
  } catch (error) {
    // Partial initialization is deliberately retained: ownership has not been
    // established, so an error cannot authorize unlinking the pathname.
    throw new Error(`Delegation lock initialization failed and may require recovery. ${RECOVERY}`, { cause: error });
  } finally {
    await handle.close();
  }
}

async function verifyLease(lease: Lease): Promise<void> {
  await verifyDirectory(lease.parent);
  const before = await fs.lstat(lease.path);
  const valid = (stat: Stats) => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
    && sameIdentity(lease.stat, stat) && stat.size === lease.contents.length;
  const unchanged = (stat: Stats) => valid(stat) && stat.mtimeMs === before.mtimeMs && stat.ctimeMs === before.ctimeMs;
  if (!valid(before)) throw new Error('Delegation lock ownership changed; refusing to remove or use a foreign lock');
  const handle = await fs.open(lease.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!valid(await handle.stat())) throw new Error('Delegation lock ownership changed before verification');
    const bytes = Buffer.alloc(lease.contents.length + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== lease.contents.length || !bytes.subarray(0, offset).equals(lease.contents)
      || !unchanged(await handle.stat())) throw new Error('Delegation lock token changed; refusing to remove or use a foreign lock');
  } finally {
    await handle.close();
  }
  if (!unchanged(await fs.lstat(lease.path))) throw new Error('Delegation lock was replaced during verification');
}

async function relinquish(lease: Lease): Promise<void> {
  await verifyLease(lease);
  // Cooperative owners never replace an occupied slot. Node has no portable
  // compare-and-unlink syscall; this is not a sandbox against hostile OS writers.
  await fs.unlink(lease.path);
}

/**
 * Acquire before constructing mutable delegation stores. The storage lock is a
 * sibling `<canonical-root>.ownership` file, outside inventoried storage contents.
 * Repository locks live in the canonical Git common directory, shared by every
 * storage root. Neither lock is automatically recovered after a crash: parent
 * death (even a missing PID) does not establish delegated-child termination.
 *
 * release() fences new/waiting operations and drains running callbacks. Callers
 * must also drain their other store writes and native workers before release.
 * Requires a filesystem providing atomic exclusive create to all participants.
 */
export class DelegationOwnership {
  private readonly root: string;
  private storage: StorageLease | undefined;
  private acquiring: Promise<void> | undefined;
  private releasing: Promise<void> | undefined;
  private closing = false;
  private readonly operations = new Set<Promise<unknown>>();

  constructor(root: string) {
    if (!root.trim()) throw new Error('Delegation storage root cannot be empty');
    this.root = path.resolve(root);
  }

  /** Reentrant, not reference counted; independent instances must contend. */
  acquire(): Promise<void> {
    if (this.closing) return Promise.reject(new Error('Delegation ownership is releasing or requires recovery'));
    if (this.acquiring) return this.acquiring;
    const current = this.storage;
    const attempt = current ? this.verifyStorage(current).then(() => {
      if (this.closing || this.storage !== current) throw new Error('Delegation ownership acquisition cancelled by release');
    }) : this.acquireStorage();
    this.acquiring = attempt;
    void attempt.then(() => { this.acquiring = undefined; }, () => { this.acquiring = undefined; });
    return attempt;
  }

  private async acquireStorage(): Promise<void> {
    // Only empty directories are created here; no store or inventory is opened.
    await fs.mkdir(this.root, { recursive: true });
    const directory = await directoryIdentity(this.root);
    if (directory.path === path.parse(directory.path).root) throw new Error('A filesystem root cannot be a delegation storage root');
    const parent = await directoryIdentity(path.dirname(directory.path));
    const lock = await claim(parent, `${path.basename(directory.path)}.ownership`);
    if (!lock) throw new Error(`Delegation storage is already owned or has an abandoned lock. ${RECOVERY}`);
    const storage = { directory, lock };
    try {
      await this.verifyStorage(storage);
      if (this.closing) throw new Error('Delegation ownership acquisition cancelled by release');
      this.storage = storage;
    } catch (error) {
      try { await relinquish(lock); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Delegation acquisition failed; lock recovery is required'); }
      throw error;
    }
  }

  private async verifyStorage(storage: StorageLease): Promise<void> {
    if (await fs.realpath(this.root) !== storage.directory.path) throw new Error('Delegation storage alias changed; ownership is fenced');
    await verifyDirectory(storage.directory);
    await verifyLease(storage.lock);
  }

  release(): Promise<void> {
    if (this.releasing) return this.releasing;
    this.closing = true;
    const attempt = (async () => {
      await this.acquiring?.catch(() => undefined);
      await Promise.allSettled([...this.operations]);
      if (this.storage) {
        await relinquish(this.storage.lock);
        this.storage = undefined;
      }
    })();
    this.releasing = attempt;
    void attempt.then(() => {
      this.releasing = undefined;
      this.closing = false;
    }, () => {
      this.releasing = undefined;
      // A failed release retains the fence. Retrying release is allowed.
    });
    return attempt;
  }

  /** Non-reentrant short repository exclusion; waiting never holds another selector. */
  withRepository<T>(commonDirectory: string, operation: () => Promise<T>): Promise<T> {
    const storage = this.storage;
    if (!storage || this.closing) return Promise.reject(new Error('Acquire delegation ownership before repository operations; release may already be pending'));
    const task = this.runRepository(storage, commonDirectory, operation);
    this.operations.add(task);
    void task.then(() => { this.operations.delete(task); }, () => { this.operations.delete(task); });
    return task;
  }

  private async runRepository<T>(storage: StorageLease, commonDirectory: string, operation: () => Promise<T>): Promise<T> {
    const requestedDirectory = path.resolve(commonDirectory);
    const directory = await directoryIdentity(requestedDirectory);
    const deadline = performance.now() + REPOSITORY_WAIT_MS;
    let lock: Lease | null = null;
    while (!lock) {
      if (this.closing || this.storage !== storage) throw new Error('Delegation repository operation cancelled by ownership release');
      await this.verifyStorage(storage);
      if (performance.now() >= deadline) throw new Error(`Timed out after ${REPOSITORY_WAIT_MS}ms waiting for delegation repository ownership. ${RECOVERY}`);
      lock = await claim(directory, 'remote-cli-delegation.ownership');
      if (!lock) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new Error(`Timed out after ${REPOSITORY_WAIT_MS}ms waiting for delegation repository ownership. ${RECOVERY}`);
        await delay(Math.min(POLL_MS, remaining));
      }
    }
    let result: T | undefined;
    let failure: unknown;
    let failed = false;
    try {
      if (this.closing || this.storage !== storage) throw new Error('Delegation repository operation cancelled by ownership release');
      await this.verifyStorage(storage);
      await verifyLease(lock);
      if (await fs.realpath(requestedDirectory) !== directory.path) throw new Error('Delegation repository alias changed; operation is fenced');
      if (performance.now() >= deadline) throw new Error(`Timed out after ${REPOSITORY_WAIT_MS}ms waiting for delegation repository ownership`);
      result = await operation();
      await this.verifyStorage(storage);
      if (await fs.realpath(requestedDirectory) !== directory.path) throw new Error('Delegation repository alias changed during the operation');
    } catch (error) { failed = true; failure = error; }
    try { await relinquish(lock); }
    catch (cleanup) {
      this.closing = true;
      if (failed) throw new AggregateError([failure, cleanup], 'Delegation operation and lock cleanup failed; recovery is required');
      throw cleanup;
    }
    if (failed) throw failure;
    return result as T;
  }
}
