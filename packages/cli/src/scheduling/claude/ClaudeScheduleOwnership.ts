import fs from 'fs';
import path from 'path';
import { assertScheduleHostAvailable, scheduleProcesses, type ScheduleHostIdentity, type ScheduleProcess } from './ClaudeScheduleProcesses';
import { createHash, randomUUID } from 'crypto';
import { bootIdentity, kernelGate, syncDirectory, type BootIdentity, type KernelGate } from '../../delegation/OwnershipRuntime';

interface Receipt { version: 1 | 2; nativeHost?: ScheduleHostIdentity; ownerToken?: string; predecessorUncertain?: true; session: string; identity: BootIdentity; token: string; clean: boolean }
export interface ScheduleOwnershipDependencies {
  identity(): BootIdentity;
  gate(filename: string): KernelGate | undefined;
  processes?(): ScheduleProcess[];
}

/** One durable host fence per native session, not an occurrence execution journal.
 * Same-boot parent/PID absence is deliberately insufficient: descendants can escape.
 */
export class ClaudeScheduleOwnership {
  readonly filename: string;
  private gate?: KernelGate;
  private receipt?: Receipt;
  private live = false;
  private admission?: 'fresh' | 'clean' | 'reboot';
  constructor(pointer: string, private readonly session: string,
    private readonly dependencies: ScheduleOwnershipDependencies = { identity: bootIdentity, gate: kernelGate }) {
    this.filename = `${pointer}.schedule-${createHash('sha256').update(session).digest('hex')}.json`;
  }
  exists(): boolean { return fs.existsSync(this.filename); }
  /** Stable only across proven clean handoffs; dirty rearm starts a new lineage. */
  get ownerToken(): string | undefined { return this.live ? this.receipt?.ownerToken ?? this.receipt?.token : undefined; }
  private matchesOwner(receipt: Receipt, ownerToken?: string): boolean {
    return ownerToken !== undefined && ownerToken === (receipt.ownerToken ?? receipt.token);
  }
  reserve(allowFresh: boolean, ownerToken?: string): void {
    if (this.live) {
      this.gate!.verify();
      if (this.receipt?.predecessorUncertain && !this.matchesOwner(this.receipt, ownerToken)) {
        throw new Error('Native schedule belongs to an uncertain predecessor ownership incarnation.');
      }
      return;
    }
    if (!this.gate) {
      fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
      this.gate = this.dependencies.gate(`${this.filename}.lock`);
      if (!this.gate) throw new Error('Another client owns this native schedule session.');
    }
    try {
      this.gate.verify();
      const current = this.dependencies.identity();
      const saved = this.read();
      if (!saved && !allowFresh) throw new Error('Native schedule predecessor identity is missing; automatic recovery is blocked.');
      if (saved && saved.identity.host !== current.host) throw new Error('Native schedule predecessor belongs to another machine.');
      if (saved && !saved.clean && saved.identity.boot === current.boot) {
        throw new Error('Native schedule predecessor exit is unconfirmed in this boot; PID absence cannot exclude surviving work.');
      }
      if (saved?.predecessorUncertain && saved.identity.boot === current.boot && !this.matchesOwner(saved, ownerToken)) {
        throw new Error('Native schedule belongs to an uncertain predecessor ownership incarnation.');
      }
      this.admission = !saved ? 'fresh' : saved.clean ? 'clean' : 'reboot';
      this.receipt = { version: 1, session: this.session, identity: current, token: randomUUID(), ownerToken: saved?.clean ? saved.ownerToken ?? saved.token : randomUUID(), clean: false,
        ...(saved?.identity.boot === current.boot && saved.predecessorUncertain && { predecessorUncertain: true as const }) };
      // Reserve before any successor can start. A crash during reconciliation
      // cannot authorize another same-boot successor from an older catalog row.
      this.write();
      this.live = true;
    } catch (error) { this.close(); throw error; }
  }
  /** New explicit jobs may use this original session after exclusive host
   * verification. Old uncertain obligations remain archived, never called clean
   * and never reused to recover old definitions or admitted occurrences. */
  reserveForNewJob(pid: number, command: string): void {
    if (this.live) {
      this.gate!.verify();
      if (this.receipt?.nativeHost && this.receipt.nativeHost.pid !== pid) throw new Error('Native schedule host identity changed.');
      this.bindHost(pid); return;
    }
    fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    this.gate ??= this.dependencies.gate(`${this.filename}.lock`);
    if (!this.gate) throw new Error('Another client owns this native schedule session.');
    try {
      this.gate.verify();
      const saved = this.read(), identity = this.dependencies.identity();
      if (saved && saved.identity.host !== identity.host) throw new Error('Native schedule predecessor belongs to another machine.');
      if (saved && saved.identity.boot === identity.boot && saved.identity.namespace !== identity.namespace) {
        throw new Error('Native schedule predecessor belongs to another PID namespace.');
      }
      const nativeHost = assertScheduleHostAvailable((this.dependencies.processes ?? scheduleProcesses)(), this.session, pid, command,
        saved?.identity.boot === identity.boot ? saved.nativeHost : undefined,
        !!saved && !saved.clean && saved.identity.boot === identity.boot && !saved.nativeHost);
      if (saved && !saved.clean) {
        const archive = `${this.filename}.retired-${saved.token}`;
        const bytes = fs.readFileSync(this.filename);
        if (fs.existsSync(archive)) {
          const stat = fs.lstatSync(archive);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8192
            || !fs.readFileSync(archive).equals(bytes)) throw new Error('Retired native ownership diagnostic changed.');
        } else {
          const temporary = `${archive}.${randomUUID()}.tmp`;
          try {
            const fd = fs.openSync(temporary, 'wx', 0o600);
            try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
            this.gate.verify();
            fs.renameSync(temporary, archive);
            syncDirectory(path.dirname(archive));
          } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
        }
      }
      this.receipt = { version: 2, session: this.session, identity, token: randomUUID(), ownerToken: saved?.clean ? saved.ownerToken ?? saved.token : randomUUID(), clean: false, nativeHost,
        ...(saved && saved.identity.boot === identity.boot && (!saved.clean || saved.predecessorUncertain) && { predecessorUncertain: true as const }) };
      this.write(); this.live = true;
      // This admission is deliberately never reboot proof for old recovery.
      this.admission = saved?.clean ? 'clean' : 'fresh';
    } catch (error) { this.close(); throw error; }
  }
  /** Bind a clean/reboot restoration reservation to its initialized host before
   * any Cron tool can run. A crash before this write leaves legacy scan fallback. */
  bindHost(pid: number): void {
    if (!this.live || !this.receipt || !this.gate) throw new Error('Native schedule host reservation is unavailable.');
    if (this.receipt.nativeHost?.pid === pid) return;
    const host = (this.dependencies.processes ?? scheduleProcesses)().find(item => item.pid === pid);
    if (!host) throw new Error('Current native host identity is unavailable.');
    const previous = this.receipt;
    this.receipt = { ...previous, version: 2, nativeHost: { pid, ...(host.birth && { birth: host.birth }) } };
    try { this.write(); }
    catch (error) { this.receipt = previous; this.close(); throw error; }
  }
  assertRebootRecovery(): void {
    this.gate?.verify();
    if (!this.live || this.admission !== 'reboot') throw new Error('Unclean native schedule recovery requires verified predecessor loss on a later boot of the same machine.');
  }
  /** Acquire exclusion for removal only. Never overwrite the predecessor receipt
   * or grant execution admission from a same-boot dirty predecessor.
   */
  cancellationProof(ownerToken?: string): boolean {
    if (!this.gate) {
      this.gate = this.dependencies.gate(`${this.filename}.lock`);
      if (!this.gate) throw new Error('Another client owns this native schedule session.');
    }
    this.gate.verify();
    const saved = this.read();
    const current = this.dependencies.identity();
    if (!saved || saved.identity.host !== current.host) {
      throw new Error('Native cancellation ownership receipt is missing or belongs to another machine. Preserve the session for manual review.');
    }
    return saved.identity.boot !== current.boot || (!saved.predecessorUncertain || this.matchesOwner(saved, ownerToken)) && (saved.clean || this.live && saved.token === this.receipt?.token);
  }
  /** Explicit local definition removal does not invent predecessor proof. */
  reviewedRemovalLease(): { verify(): void; retirementConfirmed(ownerToken?: string): boolean; close(): void } {
    const existing = this.gate;
    fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    const gate = existing ?? this.dependencies.gate(`${this.filename}.lock`);
    if (!gate) throw new Error('Another client owns this native schedule session.');
    try {
      gate.verify();
      const saved = this.read();
      if (saved && saved.identity.host !== this.dependencies.identity().host) {
        throw new Error('Native ownership receipt belongs to another machine.');
      }
      return { verify: () => gate.verify(), retirementConfirmed: (ownerToken?: string) => {
        gate.verify();
        const receipt = this.read(), current = this.dependencies.identity();
        return !!receipt && receipt.identity.host === current.host
          && (receipt.identity.boot !== current.boot || (!receipt.predecessorUncertain || this.matchesOwner(receipt, ownerToken)) && (receipt.clean || this.live && receipt.token === this.receipt?.token));
      }, close: () => { if (!existing) gate.close(); } };
    } catch (error) { if (!existing) gate.close(); throw error; }
  }
  hostClosed(): void { this.live = false; }
  confirmClean(): void {
    if (this.live || !this.receipt || !this.gate) throw new Error('Native schedule host exit is unconfirmed.');
    this.gate.verify();
    this.receipt.clean = true;
    this.write();
  }
  close(): void { this.gate?.close(); this.gate = undefined; this.live = false; }
  private read(): Receipt | undefined {
    let stat: fs.Stats;
    try { stat = fs.lstatSync(this.filename); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8192) throw new Error('Unsafe native schedule ownership receipt.');
    const value = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
    const { checksum, ...receipt } = value;
    if (![1, 2].includes(receipt.version) || receipt.session !== this.session || typeof receipt.clean !== 'boolean'
      || !/^[a-f0-9-]{36}$/.test(receipt.token ?? '')
      || !['host', 'boot', 'namespace'].every(key => typeof receipt.identity?.[key] === 'string' && receipt.identity[key].length > 0)
      || receipt.ownerToken !== undefined && !/^[a-f0-9-]{36}$/.test(receipt.ownerToken)
      || receipt.predecessorUncertain !== undefined && receipt.predecessorUncertain !== true
      || receipt.version === 2 && (!Number.isSafeInteger(receipt.nativeHost?.pid) || receipt.nativeHost.pid <= 1
        || receipt.nativeHost.birth !== undefined && typeof receipt.nativeHost.birth !== 'string')
      || checksum !== createHash('sha256').update(JSON.stringify(receipt)).digest('hex')) {
      throw new Error('Native schedule ownership receipt is invalid; preserve it for review.');
    }
    return receipt;
  }
  private write(): void {
    this.gate!.verify();
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({ ...this.receipt,
          checksum: createHash('sha256').update(JSON.stringify(this.receipt)).digest('hex') }));
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      this.gate!.verify();
      fs.renameSync(temporary, this.filename);
      syncDirectory(path.dirname(this.filename));
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
}
