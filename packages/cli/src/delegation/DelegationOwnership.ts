import syncFs, { constants, type Stats } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { performance } from 'perf_hooks';
import { setTimeout as delay } from 'timers/promises';
import { kernelGate, ownerRecord, encodeOwner, assertRecoverable, ProcessJournal, withProcessJournal, syncDirectory, type KernelGate } from './OwnershipRuntime';

const REPOSITORY_WAIT_MS = 30_000;
const POLL_MS = 50;
const RECOVERY = 'An active owner or unconfirmed legacy recovery blocks delegation. Retry after the owner and its children exit; never move a live ownership file.';

interface DirectoryIdentity {
  path: string;
  stat: Stats;
}

interface Lease {
  path: string;
  parent: DirectoryIdentity;
  stat: Stats;
  contents: Buffer;
  gate: KernelGate;
  journal: ProcessJournal;
  ownerRemoved?: boolean;
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
  const gate = kernelGate(`${lockPath}.guard`);
  if (!gate) return null;
  let journal: ProcessJournal | undefined;
  let temporary: string | undefined;
  try {
    const existing = await fs.lstat(lockPath).catch(error => {
      if (code(error) === 'ENOENT') return undefined;
      throw error;
    });
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink() || ![1, 2].includes(existing.nlink) || existing.size > 16 * 1024) {
        throw new Error(`Unsafe delegation lock entry; refusing to follow or remove it. ${RECOVERY}`);
      }
      const contents = await fs.readFile(lockPath);
      assertRecoverable(contents, `${lockPath}.children`);
      if (existing.nlink === 2) {
        const record = JSON.parse(contents.toString());
        const staging = `${lockPath}.${record.token}.initializing`;
        const staged = await fs.lstat(staging);
        if (!staged.isFile() || staged.isSymbolicLink() || !sameIdentity(existing, staged) || staged.nlink !== 2) {
          throw new Error('Unsafe delegation lock hard links');
        }
        await fs.unlink(staging);
      }
      gate.verify();
      await verifyDirectory(parent);
      const current = await fs.lstat(lockPath);
      if (!sameIdentity(existing, current) || !(await fs.readFile(lockPath)).equals(contents)) {
        throw new Error('Delegation ownership changed during recovery');
      }
      await fs.unlink(lockPath);
      syncDirectory(parent.path);
    }
    // No owner record means no child launch was admitted. A journal left by
    // initialization/release can be removed under the stable kernel gate.
    const journalPath = `${lockPath}.children`;
    const oldJournal = await fs.lstat(journalPath).catch(error => {
      if (code(error) === 'ENOENT') return undefined;
      throw error;
    });
    if (oldJournal) {
      if (!oldJournal.isFile() || oldJournal.isSymbolicLink() || oldJournal.nlink !== 1) throw new Error('Unsafe delegation process journal');
      await fs.unlink(journalPath);
    }
    const record = ownerRecord();
    const contents = encodeOwner(record);
    journal = new ProcessJournal(journalPath, record.token, () => {
      gate.verify();
      const directory = syncFs.lstatSync(parent.path);
      const owner = syncFs.lstatSync(lockPath);
      if (!sameIdentity(parent.stat, directory) || directory.isSymbolicLink()
        || !owner.isFile() || owner.isSymbolicLink() || owner.nlink !== 1 || owner.size !== contents.length
        || !syncFs.readFileSync(lockPath).equals(contents)) {
        throw new Error('Delegation ownership changed before child launch');
      }
    });
    temporary = `${lockPath}.${record.token}.initializing`;
    const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
    // Publish complete metadata atomically without overwriting an old binary
    // that raced us using exclusive create. All future native launches journal
    // under the gate; an empty or torn owner record is never published.
    await fs.link(temporary, lockPath);
    await fs.unlink(temporary);
    temporary = undefined;
    syncDirectory(parent.path);
    return { path: lockPath, parent, stat: await fs.lstat(lockPath), contents, gate, journal };
  } catch (error) {
    journal?.close();
    if (temporary) await fs.unlink(temporary).catch(() => undefined);
    gate.close();
    throw error;
  }
}

async function verifyLease(lease: Lease): Promise<void> {
  lease.gate.verify();
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
  if (!lease.ownerRemoved) {
    await verifyLease(lease);
    // Cooperative owners serialize on the stable kernel gate. This is not a
    // sandbox against an OS writer that ignores or replaces the gate.
    await fs.unlink(lease.path);
    lease.ownerRemoved = true;
  } else {
    lease.gate.verify();
    await verifyDirectory(lease.parent);
    const replacement = await fs.lstat(lease.path).catch(error => {
      if (code(error) === 'ENOENT') return undefined;
      throw error;
    });
    if (replacement) throw new Error('Delegation owner record reappeared during release');
  }
  syncDirectory(lease.parent.path);
  lease.journal.close();
  await fs.unlink(lease.journal.filename).catch(error => { if (code(error) !== 'ENOENT') throw error; });
  // Keep the gate through partial release failures, so the same owner can
  // retry without racing a new owner or requiring a service restart.
  lease.gate.close();
}

/**
 * Acquire before constructing mutable delegation stores. The storage lock is a
 * sibling `<canonical-root>.ownership` file, outside inventoried storage contents.
 * Repository locks live in the canonical Git common directory, shared by every
 * storage root. Stable native gates serialize recovery; owner metadata and
 * durable child journals distinguish a dead owner from surviving children.
 *
 * release() fences new/waiting operations and drains running callbacks. Callers
 * must also drain their other store writes and native workers before release.
 * Requires local filesystems with native locking, atomic links and durable writes.
 * Old version-1 placeholders require a quiescent migration; they lack child evidence.
 */
export class DelegationOwnership {
  private readonly root: string;
  private storage: StorageLease | undefined;
  private acquiring: Promise<void> | undefined;
  private releasing: Promise<void> | undefined;
  private closing = false;
  private readonly operations = new Set<Promise<unknown>>();
  private readonly repositoryReleases = new Set<Lease>();

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
    if (!lock) throw new Error(`Delegation storage is already owned by an active process (kernel lock held). ${RECOVERY}`);
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
      for (const lock of this.repositoryReleases) {
        await relinquish(lock);
        this.repositoryReleases.delete(lock);
      }
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

  /** Preserve ownership context through worker creation, execution and teardown. */
  async withProcesses<T>(operation: () => Promise<T>): Promise<T> {
    const storage = this.storage;
    if (!storage) throw new Error('Acquire delegation ownership before launching processes');
    const task = withProcessJournal(storage.lock.journal, operation);
    this.operations.add(task);
    try { return await task; } finally { this.operations.delete(task); }
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
      result = await withProcessJournal(storage.lock.journal, () => withProcessJournal(lock!.journal, operation));
      await this.verifyStorage(storage);
      if (await fs.realpath(requestedDirectory) !== directory.path) throw new Error('Delegation repository alias changed during the operation');
    } catch (error) { failed = true; failure = error; }
    this.repositoryReleases.add(lock);
    try { await relinquish(lock); this.repositoryReleases.delete(lock); }
    catch (cleanup) {
      this.closing = true;
      if (failed) throw new AggregateError([failure, cleanup], 'Delegation operation and lock cleanup failed; recovery is required');
      throw cleanup;
    }
    if (failed) throw failure;
    return result as T;
  }
}
