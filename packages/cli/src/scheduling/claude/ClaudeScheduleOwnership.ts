import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { bootIdentity, kernelGate, syncDirectory, type BootIdentity, type KernelGate } from '../../delegation/OwnershipRuntime';

interface Receipt { version: 1; session: string; identity: BootIdentity; token: string; clean: boolean }
export interface ScheduleOwnershipDependencies {
  identity(): BootIdentity;
  gate(filename: string): KernelGate | undefined;
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
  reserve(allowFresh: boolean): void {
    if (this.live) { this.gate!.verify(); return; }
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
      this.admission = !saved ? 'fresh' : saved.clean ? 'clean' : 'reboot';
      this.receipt = { version: 1, session: this.session, identity: current, token: randomUUID(), clean: false };
      // Reserve before any successor can start. A crash during reconciliation
      // cannot authorize another same-boot successor from an older catalog row.
      this.write();
      this.live = true;
    } catch (error) { this.close(); throw error; }
  }
  assertRebootRecovery(): void {
    this.gate?.verify();
    if (!this.live || this.admission !== 'reboot') throw new Error('Unclean native schedule recovery requires verified predecessor loss on a later boot of the same machine.');
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
    if (receipt.version !== 1 || receipt.session !== this.session || typeof receipt.clean !== 'boolean'
      || !/^[a-f0-9-]{36}$/.test(receipt.token ?? '')
      || !['host', 'boot', 'namespace'].every(key => typeof receipt.identity?.[key] === 'string' && receipt.identity[key].length > 0)
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
