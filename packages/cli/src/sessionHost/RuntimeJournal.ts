import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { kernelGate, syncDirectory, type KernelGate } from '../delegation/OwnershipRuntime';
import type { NativeScheduleBackend } from '../scheduling/ScheduleCapabilities';
import type { NativeScheduleEvent, ScheduleOwner } from '../scheduling/types';

export interface RuntimeBinding extends ScheduleOwner { cwd: string; backend: NativeScheduleBackend; name: string; contextGeneration: number }
export interface RuntimeCommand {
  messageId: string; openId: string; threadId?: string; command: string;
  status: 'queued' | 'running' | 'completed' | 'acknowledged';
  response?: { success: boolean; output?: string; error?: string; threadId?: string };
}
interface State { version: 1; incarnation: string; owners: RuntimeBinding[]; commands: RuntimeCommand[];
  nativeEvents: { id: string; scheduleId: string; event: NativeScheduleEvent }[] }

/** Host-owned ingress, output and native callback acceptance. No clock or native replay. */
export class RuntimeJournal {
  private state: State;
  private gate: KernelGate;
  private readonly file: string;
  private readonly identity: fs.Stats;
  healthy = true;
  constructor(private readonly directory: string, incarnation: string) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const entry = fs.lstatSync(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink() || process.platform !== 'win32' && (entry.mode & 0o077) !== 0) throw new Error('Unsafe runtime directory.');
    this.directory = fs.realpathSync(directory); this.identity = fs.statSync(this.directory);
    this.file = path.join(this.directory, 'runtime.json');
    const gate = kernelGate(path.join(directory, 'runtime.lock'));
    if (!gate) throw new Error('Another retained runtime owns this directory.');
    this.gate = gate;
    this.state = { version: 1, incarnation, owners: [], commands: [], nativeEvents: [] };
    try {
      if (fs.existsSync(this.file)) {
        const stat = fs.lstatSync(this.file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32 * 1024 * 1024
          || process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('Unsafe runtime journal.');
        const previous = JSON.parse(fs.readFileSync(this.file, 'utf8')) as State;
        if (previous.version !== 1 || !Array.isArray(previous.owners) || !Array.isArray(previous.commands) || !Array.isArray(previous.nativeEvents)) throw new Error('Invalid runtime journal.');
        // A released filesystem lock is not proof that a native predecessor died.
        // Never start a new executor or turn a callback snapshot into native restore.
        if (previous.owners.length || previous.commands.length || previous.nativeEvents.length) throw new Error('Retained native runtime restart requires inspection; existing sessions are not imported or recreated.');
      }
      this.change(() => {});
    } catch (error) { gate.close(); throw error; }
  }
  snapshot(): State { return structuredClone(this.state); }
  change(update: (state: State) => void): void {
    if (!this.healthy) throw new Error('Runtime journal is unavailable.');
    const next = this.snapshot(); update(next);
    if (next.owners.length > 10 || next.commands.length > 10_000 || next.nativeEvents.length > 512
      || next.commands.filter(command => command.status !== 'acknowledged').length > 128) throw new Error('Retained runtime capacity exhausted; no accepted output was evicted.');
    const bytes = JSON.stringify(next);
    if (Buffer.byteLength(bytes) > 32 * 1024 * 1024) throw new Error('Retained runtime storage capacity exhausted.');
    const temporary = path.join(this.directory, `.runtime-${randomUUID()}.tmp`);
    try {
      this.gate.verify();
      const directory = fs.lstatSync(this.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink() || directory.ino !== this.identity.ino || directory.dev !== this.identity.dev) throw new Error('Runtime directory identity changed.');
      if (fs.existsSync(this.file)) {
        const file = fs.lstatSync(this.file);
        if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1) throw new Error('Unsafe runtime journal.');
      }
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.file); syncDirectory(this.directory); this.state = next;
    } catch { this.healthy = false; throw new Error('Runtime persistence outcome is unknown; native admission is fenced.'); }
    finally { try { fs.unlinkSync(temporary); } catch { /* Already replaced. */ } }
  }
  close(): void { this.healthy = false; this.gate.close(); }
}
