import { AsyncLocalStorage } from 'async_hooks';
import { spawn as nativeSpawn, execFileSync, type ChildProcess, type SpawnOptions } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import fs, { constants } from 'fs';
import path from 'path';
import { machineIdSync } from 'node-machine-id';

// Native, open-description locks: OFD locks on Linux, flock on macOS, and
// LockFileEx on Windows. Never unlink this gate: waiters must share its inode.
export interface KernelGate { verify(): void; close(): void }

export function kernelGate(filename: string): KernelGate | undefined {
  // Loading is lazy: ordinary backend execution without delegation must not
  // depend on the availability of a native ownership implementation.
  let nativeLocks: { tryLock(fd: number): boolean };
  try { nativeLocks = require('fs-native-extensions'); }
  catch (error) { throw new Error('Native delegation locking is unavailable on this platform; no unsafe fallback is enabled', { cause: error }); }
  try {
    const entry = fs.lstatSync(filename);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new Error('Unsafe delegation kernel lock entry');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const fd = fs.openSync(filename, constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const identity = fs.fstatSync(fd);
    const verify = () => {
      const current = fs.lstatSync(filename);
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
        || current.ino !== identity.ino || current.dev !== identity.dev) {
        throw new Error('Delegation kernel lock identity changed; refusing further operations');
      }
    };
    verify();
    if (!nativeLocks.tryLock(fd)) { fs.closeSync(fd); return undefined; }
    verify();
    let closed = false;
    return { verify: () => { if (closed) throw new Error('Delegation kernel lock is closed'); verify(); },
      close: () => { if (!closed) { fs.closeSync(fd); closed = true; } } };
  } catch (error) { fs.closeSync(fd); throw error; }
}

export interface BootIdentity { host: string; boot: string; namespace: string }
let cachedBoot: BootIdentity | undefined;
export function bootIdentity(): BootIdentity {
  if (cachedBoot) return cachedBoot;
  const host = createHash('sha256').update(machineIdSync(true)).digest('hex');
  let boot: string;
  let namespace = 'host';
  if (process.platform === 'linux') {
    boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    namespace = fs.readlinkSync('/proc/self/ns/pid');
    if (!fs.readFileSync('/proc/self/stat', 'utf8').startsWith(`${process.pid} (`)) {
      throw new Error('Delegation process inventory does not match this PID namespace');
    }
  } else if (process.platform === 'darwin') {
    boot = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8', timeout: 5000 }).trim();
  } else if (process.platform === 'win32') {
    boot = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString("o")'],
    { encoding: 'utf8', timeout: 10_000, windowsHide: true }).trim();
  } else throw new Error('Delegation crash recovery is unsupported on this operating system');
  if (!boot || boot.length > 256 || !host || !namespace) throw new Error('Delegation boot identity is unavailable');
  return cachedBoot = { host, boot, namespace };
}

export function processBirth(pid: number): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const birth = raw.slice(raw.lastIndexOf(')') + 2).split(/\s+/)[19];
    if (!raw.startsWith(`${pid} (`) || !/^\d+$/.test(birth ?? '')) throw new Error('Invalid process identity');
    return birth;
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw error;
  }
}

export interface OwnerRecord extends BootIdentity { version: 2; token: string; pid: number; birth?: string }
export function ownerRecord(): OwnerRecord {
  return { version: 2, token: randomUUID(), pid: process.pid, birth: processBirth(process.pid), ...bootIdentity() };
}

/** Detect accidental record corruption; this is not authentication against OS writers. */
export function encodeOwner(owner: OwnerRecord): Buffer {
  const checksum = createHash('sha256').update(JSON.stringify(owner)).digest('hex');
  return Buffer.from(JSON.stringify({ ...owner, checksum }) + '\n');
}

export function syncDirectory(directory: string): void {
  if (process.platform === 'win32') return; // Node cannot fsync Windows directory handles.
  const fd = fs.openSync(directory, constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

interface LaunchRecord { id: string; event: 'reserve' | 'spawn' | 'absent'; pid?: number; group?: boolean; birth?: string }
const MAX_JOURNAL = 16 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function readRegular(filename: string): Buffer {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_JOURNAL) {
    throw new Error('Unsafe or oversized delegation process journal');
  }
  const fd = fs.openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    if (opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error('Delegation process journal changed');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

/** No signalling or deletion: a dead parent alone never proves its children exited. */
export function assertRecoverable(raw: Buffer, journalPath: string, current = bootIdentity()): void {
  let owner: OwnerRecord;
  let checksum: string | undefined;
  try {
    const { checksum: saved, ...record } = JSON.parse(raw.toString('utf8')) as OwnerRecord & { checksum?: string };
    checksum = saved;
    owner = record;
  } catch { throw new Error('Invalid legacy ownership metadata; controlled recovery is required'); }
  if (owner.version !== 2 || !UUID.test(owner.token) || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
    || typeof owner.host !== 'string' || typeof owner.boot !== 'string' || !owner.boot || typeof owner.namespace !== 'string') {
    throw new Error('Legacy ownership has no crash-recovery evidence; controlled recovery is required');
  }
  if (checksum !== createHash('sha256').update(JSON.stringify(owner)).digest('hex')) {
    throw new Error('Delegation ownership checksum failed; preserve recovery state');
  }
  if (owner.host !== current.host) throw new Error('Delegation ownership belongs to another host; refusing recovery');
  // Reboot recovery applies only to this host. A foreign PID namespace in the
  // same boot is not evidence of process death.
  if (owner.boot !== current.boot) return;
  if (owner.namespace !== current.namespace) throw new Error('Delegation ownership belongs to another PID namespace');
  try {
    process.kill(owner.pid, 0);
    if (!owner.birth || processBirth(owner.pid) === owner.birth) throw new Error('Delegation owner process is still alive');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  const bytes = readRegular(journalPath);
  if (!bytes.length || bytes.at(-1) !== 10) throw new Error('Delegation process journal is incomplete; preserve recovery state');
  const lines = bytes.toString('utf8').trimEnd().split('\n');
  if (lines.shift() !== owner.token) throw new Error('Delegation process journal does not match its owner');
  const launches = new Map<string, LaunchRecord>();
  for (const line of lines) {
    const record: LaunchRecord = JSON.parse(line);
    if (!UUID.test(record.id)) throw new Error('Invalid delegation process journal entry');
    if (record.event === 'reserve' && !launches.has(record.id)) launches.set(record.id, record);
    else if (record.event === 'spawn' && launches.get(record.id)?.event === 'reserve'
      && Number.isSafeInteger(record.pid) && record.pid! > 1 && typeof record.group === 'boolean') launches.set(record.id, record);
    else if (record.event === 'absent' && launches.has(record.id)) launches.delete(record.id);
    else throw new Error('Invalid delegation process journal transition');
  }
  for (const launch of launches.values()) {
    if (launch.event !== 'spawn') throw new Error('Delegation child launch was interrupted before its identity was saved; preserve recovery state');
    if (!launch.group || process.platform === 'win32') throw new Error('Delegation child-tree exit is unconfirmed on this platform');
    try { process.kill(-launch.pid!, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue; throw error; }
    throw new Error(`Delegation child process group ${launch.pid} still exists; recovery will retry after it exits`);
  }
}

export class ProcessJournal {
  private fd: number;
  private closed = false;
  private readonly pending = new Map<string, LaunchRecord>();
  constructor(readonly filename: string, private readonly token: string, private readonly verifyOwner: () => void,
    private readonly compactBytes = 1024 * 1024) {
    this.fd = fs.openSync(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { fs.writeSync(this.fd, `${token}\n`); fs.fsyncSync(this.fd); }
    catch (error) { fs.closeSync(this.fd); this.closed = true; throw error; }
  }
  append(record: LaunchRecord): void {
    if (this.closed) throw new Error('Delegation process journal is closed');
    this.verifyOwner();
    const actual = fs.lstatSync(this.filename);
    const opened = fs.fstatSync(this.fd);
    if (!actual.isFile() || actual.isSymbolicLink() || actual.nlink !== 1 || actual.ino !== opened.ino || actual.dev !== opened.dev
      || actual.size >= MAX_JOURNAL) throw new Error('Delegation process journal changed or exceeded its limit');
    if (actual.size >= this.compactBytes) this.compact();
    // A close event may arrive after compaction already proved group absence.
    if (record.event === 'absent' && !this.pending.has(record.id)) return;
    const bytes = Buffer.from(JSON.stringify(record) + '\n');
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(this.fd, bytes, offset);
    fs.fsyncSync(this.fd);
    if (record.event === 'absent') this.pending.delete(record.id);
    else this.pending.set(record.id, record);
  }
  private compact(): void {
    const remaining = new Map(this.pending);
    for (const [id, record] of remaining) {
      if (record.event !== 'spawn' || !record.group || process.platform === 'win32') continue;
      try { process.kill(-record.pid!, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') remaining.delete(id); }
    }
    const lines = [this.token];
    for (const record of remaining.values()) {
      lines.push(JSON.stringify({ id: record.id, event: 'reserve' }));
      if (record.event === 'spawn') lines.push(JSON.stringify(record));
    }
    const temporary = `${this.filename}.${randomUUID()}.compacting`;
    let next: number | undefined = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(next, lines.join('\n') + '\n');
      fs.fsyncSync(next);
      this.verifyOwner();
      fs.renameSync(temporary, this.filename);
      const previous = this.fd;
      this.fd = next;
      next = undefined;
      fs.closeSync(previous);
      this.pending.clear();
      for (const [id, record] of remaining) this.pending.set(id, record);
      syncDirectory(path.dirname(this.filename));
    } finally {
      if (next !== undefined) fs.closeSync(next);
      try { fs.unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  close(): void { if (!this.closed) { fs.closeSync(this.fd); this.closed = true; } }
}

const context = new AsyncLocalStorage<readonly ProcessJournal[]>();
export function withProcessJournal<T>(journal: ProcessJournal, callback: () => T): T {
  return context.run([...new Set([...(context.getStore() ?? []), journal])], callback);
}

/** Outside managed ownership this is exactly Node spawn, including its options. */
export const ownedSpawn: typeof nativeSpawn = ((command: string, args: readonly string[], options?: SpawnOptions): ChildProcess => {
  const journals = context.getStore() ?? [];
  if (!journals.length) return nativeSpawn(command, args, options ?? {});
  const id = randomUUID();
  // Persist intent BEFORE spawn. A crash in the unavoidable spawn/record gap
  // remains protected until reboot; never infer that no child was created.
  for (const journal of journals) journal.append({ id, event: 'reserve' });
  let child: ChildProcess;
  try { child = nativeSpawn(command, args, { ...options, detached: process.platform !== 'win32' }); }
  catch (error) {
    for (const journal of journals) journal.append({ id, event: 'absent' });
    throw error;
  }
  const append = (record: LaunchRecord) => {
    // A failed durable update leaves the reservation intact. Do not turn an
    // EventEmitter callback failure into an uncaught exception or grant cleanup.
    try { for (const journal of journals) journal.append(record); } catch { /* Recovery remains fenced. */ }
  };
  if (Number.isSafeInteger(child.pid) && child.pid! > 1) {
    let birth: string | undefined;
    try { birth = processBirth(child.pid!); } catch { /* PID absence is checked by the kernel on recovery. */ }
    append({ id, event: 'spawn', pid: child.pid, group: process.platform !== 'win32', birth });
  }
  child.once('error', () => { if (!child.pid) append({ id, event: 'absent' }); });
  child.once('close', () => {
    if (!child.pid || process.platform === 'win32') return;
    try { process.kill(-child.pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') append({ id, event: 'absent' }); }
  });
  return child;
}) as typeof nativeSpawn;
