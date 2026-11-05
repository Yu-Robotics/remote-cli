import { confirmOwnedProcessTreeExit } from '../delegation/OwnershipRuntime';
import { managedJob, type ManagedJob } from './ManagedSpawn';
import { nativeBindings } from '../native/NativeBindings';
import type { ChildProcess } from 'child_process';
import { readFileSync, promises as fs } from 'fs';
import { performance } from 'perf_hooks';
import { constants as osConstants } from 'os';
import { setTimeout as delay } from 'timers/promises';

interface ProcessIdentity { pid: number; state: string; group: number; session: number; birth: bigint }
export interface GroupExitDependencies {
  platform: string;
  readStat(pid: number): string;
  processIdentity?(pid: number): ProcessIdentity;
  pids(group?: number): Promise<string[]>;
  /** Signal zero: only ESRCH is kernel evidence that the group no longer exists. */
  probe(group: number): void;
  signal(group: number): void;
  pause(): Promise<void>;
  now(): number;
  timeoutMs: number;
}

const defaults: GroupExitDependencies = {
  platform: process.platform,
  ...(process.platform === 'darwin' ? { processIdentity: (pid: number) => {
    const record = nativeBindings().processInfo(pid);
    return { ...record, birth: BigInt(record.birth) };
  } } : {}),
  readStat: pid => readFileSync(`/proc/${pid}/stat`, 'utf8'),
  pids: async group => {
    if (process.platform === 'darwin') return nativeBindings().processIds(group!);
    const names = await fs.readdir('/proc');
    if (!names.includes(String(process.pid)) || !readFileSync('/proc/self/stat', 'utf8').startsWith(`${process.pid} (`)) {
      throw new Error('Managed process-group inventory does not match this PID namespace');
    }
    return names;
  },
  probe: group => { process.kill(-group, 0); },
  signal: group => { process.kill(-group, 'SIGKILL'); },
  pause: () => delay(25),
  now: () => performance.now(),
  timeoutMs: 3_000,
};

function identity(raw: string, pid: number): ProcessIdentity {
  const end = raw.lastIndexOf(')');
  const fields = raw.slice(end + 2).trim().split(/\s+/);
  if (raw.length > 64 * 1024 || !raw.startsWith(`${pid} (`) || end < 0
    || !/^[A-Za-z]$/.test(fields[0] ?? '') || !/^\d+$/.test(fields[19] ?? '')
    || !/^\d+$/.test(fields[2] ?? '') || !/^\d+$/.test(fields[3] ?? '')) {
    throw new Error('Managed process identity is unavailable');
  }
  return { pid, state: fields[0], group: Number(fields[2]), session: Number(fields[3]), birth: BigInt(fields[19]) };
}

// Native errors may carry paths or other context. Expose only a known errno,
// never the raw message, stack, or arbitrary properties from a failed probe.
function probeErrorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(osConstants.errno, code) ? code : 'UNKNOWN';
}

interface Group {
  job?: ManagedJob;
  child: ChildProcess;
  leader?: ProcessIdentity;
  closed: boolean;
  confirmed: boolean;
  proof?: Promise<void>;
}

/**
 * Kernel confirmation that an owned process group (or Windows Job) is empty.
 * A transport close is insufficient: escalation continues after the leader exits.
 * POSIX PID snapshots authorize escalation, never completion: a member can fork
 * and exit between enumeration and stat. Only the kernel's ESRCH completes proof.
 * Unreaped zombies can therefore retain the checkout until their reaper runs.
 * Descendants that escape with setsid/setpgid are NOT covered by this evidence.
 */
export class ManagedProcessGroups {
  private readonly groups = new Set<Group>();
  constructor(private readonly dependencies: GroupExitDependencies = defaults) {}

  track(child: ChildProcess): void {
    const group: Group = { closed: false, confirmed: false, child, job: managedJob(child) };
    this.groups.add(group);
    child.once('spawn', () => {
      const pid = child.pid;
      if (!['linux', 'darwin'].includes(this.dependencies.platform) || !Number.isSafeInteger(pid) || pid! <= 1 || pid === process.pid) return;
      try {
        const leader = this.dependencies.processIdentity?.(pid!) ?? identity(this.dependencies.readStat(pid!), pid!);
        if (leader.group === pid && leader.session === pid) group.leader = leader;
      } catch { /* Missing identity is retained as uncertainty, never permission to signal. */ }
    });
    if (this.dependencies.platform === 'darwin') child.once('exit', () => {
      group.closed = true;
      void this.prove(group).catch(() => undefined);
    });
    child.once('close', () => {
      group.closed = true;
      // Start while the owned identity is fresh; do not defer old PGIDs until a later task.
      void this.prove(group).catch(() => undefined);
    });
  }

  async waitForExit(): Promise<void> {
    await Promise.all([...this.groups].map(group => this.prove(group)));
  }

  private prove(group: Group): Promise<void> {
    if (group.confirmed) return Promise.resolve();
    if (group.proof) return group.proof;
    const proof = this.confirm(group).then(() => { group.confirmed = true; confirmOwnedProcessTreeExit(group.child); this.groups.delete(group); });
    group.proof = proof;
    void proof.then(() => { group.proof = undefined; }, () => { group.proof = undefined; });
    return proof;
  }

  private async confirm(group: Group): Promise<void> {
    const runtime = this.dependencies;
    if (runtime.platform === 'win32') {
      if (group.closed && group.job?.confirmed) return;
      if (!group.closed || !group.job || group.job.closed) throw new Error('Managed Windows job exit is unconfirmed');
      const native = nativeBindings();
      native.terminateJob(group.job.handle);
      const deadline = runtime.now() + runtime.timeoutMs;
      while (native.jobCount(group.job.handle) !== 0) {
        if (runtime.now() >= deadline) throw new Error('Managed Windows job still has active processes');
        await runtime.pause();
      }
      native.close(group.job.handle); group.job.closed = true; return;
    }
    if (!['linux', 'darwin'].includes(runtime.platform)) throw new Error('Managed process-group exit confirmation is unavailable on this platform; preserve the checkout');
    if (!group.closed || !group.leader) throw new Error('Managed process-group identity or transport exit is unconfirmed; preserve the checkout');
    const leader = group.leader;
    const deadline = runtime.now() + runtime.timeoutMs;
    let signalled = false;
    let lastProbeError: string | undefined;
    const unconfirmed = () => new Error(`Managed process-group exit could not be confirmed${
      lastProbeError ? ` (last probe error: ${lastProbeError})` : ''}; preserve the checkout`);
    while (true) {
      if (runtime.now() >= deadline) throw unconfirmed();
      const names = await runtime.pids(leader.group);
      if (names.length > 100_000) throw new Error('Managed process-group inventory is incomplete; preserve the checkout');
      let live = false;
      for (const name of names) {
        if (!/^[1-9]\d*$/.test(name)) continue;
        if (runtime.now() >= deadline) throw unconfirmed();
        let member: ProcessIdentity;
        try { member = runtime.processIdentity?.(Number(name)) ?? identity(runtime.readStat(Number(name)), Number(name)); }
        catch (error) {
          if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
          throw new Error('Managed process-group inventory is unavailable; preserve the checkout');
        }
        if (member.pid === leader.pid && member.birth !== leader.birth) throw new Error('Managed process-group identity changed; preserve the checkout');
        if (member.group !== leader.group) continue;
        if (member.session !== leader.session || member.birth < leader.birth) throw new Error('Managed process-group identity changed; preserve the checkout');
        if (!['Z', 'X', 'x'].includes(member.state)) live = true;
      }
      // A seemingly empty (or zombie-only) snapshot can miss a newly forked
      // same-group writer. Repeated snapshots do not close that race either.
      try { runtime.probe(leader.group); }
      catch (error) {
        const code = probeErrorCode(error);
        if (code === 'ESRCH') return;
        if (runtime.platform !== 'darwin' || code !== 'EPERM') {
          throw new Error(`Managed process-group absence is unavailable (probe error: ${code}); preserve the checkout`);
        }
        // XNU killpg1 filters zombies from group iteration and can return EPERM
        // while that group still exists (xnu-11417.140.69, kern_sig.c:1703-1712).
        // EPERM is uncertainty, not absence or permission to signal. Re-enumerate
        // and revalidate identity until ESRCH or the unchanged original deadline.
        lastProbeError = code;
      }
      if (live && !signalled && runtime.platform === 'linux') {
        try { runtime.signal(leader.group); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('Managed process group could not be stopped; preserve the checkout'); }
        signalled = true;
      }
      await runtime.pause();
    }
  }
}
