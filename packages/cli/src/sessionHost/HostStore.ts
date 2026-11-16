import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { kernelGate, syncDirectory, type KernelGate } from '../delegation/OwnershipRuntime';
import { canonical, fields, HostError, identifier, integer, payload, secret,
  type HostEvent, type OperationReceipt } from './HostProtocol';

interface StoredOperation extends OperationReceipt { digest: string; requestSequence?: number }
export interface HostState {
  version: 2;
  acceptedThrough: number;
  retiredThrough: number;
  binding: string;
  epoch: number;
  sequence: number;
  acknowledged: number;
  operations: StoredOperation[];
  events: HostEvent[];
}
export interface HostLimits { operations: number; events: number }

/** Synchronous, bounded transactions: no await can interleave acceptance and dispatch. */
export class HostStore {
  private gate: KernelGate;
  private readonly file: string;
  private readonly directory: string;
  private readonly identity: fs.Stats;
  private value: HostState;
  private faulted = false;
  private closed = false;
  readonly limits: HostLimits;

  constructor(directory: string, binding: string, limits: HostLimits = { operations: 64, events: 64 }) {
    secret(binding);
    for (const limit of Object.values(limits)) if (!Number.isInteger(limit) || limit < 1 || limit > 64) throw new HostError('invalid_capacity');
    this.limits = { ...limits };
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const entry = fs.lstatSync(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink() || process.platform !== 'win32' && (entry.mode & 0o077) !== 0) throw new HostError('unsafe_store_directory');
    this.directory = fs.realpathSync(directory);
    this.identity = fs.statSync(this.directory);
    this.file = path.join(this.directory, 'state.json');
    const gate = kernelGate(path.join(this.directory, 'writer.lock'));
    if (!gate) throw new HostError('host_already_owned');
    this.gate = gate;
    this.value = { version: 2, acceptedThrough: 0, retiredThrough: 0, binding, epoch: 0, sequence: 0, acknowledged: 0, operations: [], events: [] };
    try {
      if (fs.existsSync(this.file)) {
        this.checkFile();
        const loaded = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (loaded?.version === 1) { loaded.version = 2; loaded.acceptedThrough = 0; loaded.retiredThrough = 0; }
        this.validate(loaded, binding);
        this.value = loaded;
      }
      // Restart never dispatches old accepted inputs. Their reserved output slots
      // become durable uncertainty events; no native absence/retirement is inferred.
      this.change(state => {
        state.epoch++;
        for (const operation of state.operations) if (operation.status === 'pending') {
          operation.status = 'unknown'; operation.error = 'host_restarted';
          this.addEvent(state, operation);
        }
      });
    } catch (error) { gate.close(); throw error; }
  }

  get failed(): boolean { return this.faulted; }
  snapshot(): HostState { return structuredClone(this.value); }
  change(update: (next: HostState) => void): void {
    if (this.closed || this.faulted) throw new HostError('storage_unavailable');
    const next = this.snapshot();
    update(next);
    this.validate(next, this.value.binding);
    const temporary = path.join(this.directory, `.state-${randomUUID()}.tmp`);
    try {
      this.gate.verify();
      const current = fs.lstatSync(this.directory);
      if (!current.isDirectory() || current.isSymbolicLink() || current.ino !== this.identity.ino || current.dev !== this.identity.dev) throw new HostError('store_identity_changed');
      if (fs.existsSync(this.file)) this.checkFile();
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.file);
      syncDirectory(this.directory);
      this.value = next;
    } catch {
      // Rename may already have committed. Never roll back and redispatch from
      // stale in-memory state after an uncertain persistence outcome.
      this.faulted = true;
      throw new HostError('storage_unavailable');
    } finally { try { fs.unlinkSync(temporary); } catch { /* Renamed or not created. */ } }
  }

  addEvent(state: HostState, receipt: OperationReceipt): void {
    const { requestId, status, result, error } = receipt;
    state.events.push({ id: randomUUID(), sequence: ++state.sequence, requestId, status,
      ...(result !== undefined ? { result } : {}), ...(error ? { error } : {}) });
  }
  compactAcknowledged(state: HostState): void {
    while (state.retiredThrough < state.acceptedThrough) {
      const next = state.retiredThrough + 1;
      const operation = state.operations.find(op => op.requestSequence === next);
      if (!operation || operation.status === 'pending' || state.events.some(event => event.requestId === operation.requestId)) break;
      state.operations = state.operations.filter(op => op !== operation);
      state.retiredThrough = next;
    }
  }
  close(): void { if (!this.closed) { this.closed = true; this.gate.close(); } }

  private checkFile(): void {
    const stat = fs.lstatSync(this.file);
    // Counts and payload limits independently bound even a hostile catalog read.
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024
      || process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new HostError('unsafe_store_file');
  }
  private validate(value: unknown, binding: string): asserts value is HostState {
    fields(value, ['version', 'binding', 'epoch', 'sequence', 'acknowledged', 'operations', 'events', 'acceptedThrough', 'retiredThrough']);
    if (value.version !== 2 || value.binding !== binding || !Array.isArray(value.operations) || !Array.isArray(value.events)) throw new HostError('invalid_store');
    integer(value.acceptedThrough); integer(value.retiredThrough);
    if (value.retiredThrough > value.acceptedThrough) throw new HostError('invalid_store');
    integer(value.epoch); integer(value.sequence); integer(value.acknowledged);
    if (value.acknowledged > value.sequence || value.operations.length > this.limits.operations || value.events.length > this.limits.events) throw new HostError('invalid_store');
    const requests = new Map<string, StoredOperation>();
    for (const raw of value.operations) {
      fields(raw, ['requestId', 'digest', 'status'], ['result', 'error', 'requestSequence']);
      if (raw.requestSequence !== undefined) {
        integer(raw.requestSequence);
        if (raw.requestId !== `sequenced-${raw.requestSequence}` || raw.requestSequence <= value.retiredThrough || raw.requestSequence > value.acceptedThrough) throw new HostError('invalid_store');
      }
      identifier(raw.requestId); secret(raw.digest);
      this.validateReceipt(raw);
      if (requests.has(raw.requestId)) throw new HostError('invalid_store');
      requests.set(raw.requestId, raw as unknown as StoredOperation);
    }
    if ([...requests.values()].filter(op => op.requestSequence !== undefined).length !== value.acceptedThrough - value.retiredThrough) throw new HostError('invalid_store');
    const ids = new Set<string>();
    const eventRequests = new Set<string>();
    for (const [index, raw] of value.events.entries()) {
      fields(raw, ['id', 'sequence', 'requestId', 'status'], ['result', 'error']);
      identifier(raw.id); identifier(raw.requestId); integer(raw.sequence); this.validateReceipt(raw);
      const op = requests.get(raw.requestId);
      if (!op || raw.status === 'pending' || raw.sequence !== value.acknowledged + index + 1 || ids.has(raw.id) || eventRequests.has(raw.requestId)
        || canonical([raw.status, raw.result ?? null, raw.error ?? null]) !== canonical([op.status, op.result ?? null, op.error ?? null])) throw new HostError('invalid_store');
      ids.add(raw.id);
      eventRequests.add(raw.requestId);
    }
    if (value.events.length !== value.sequence - value.acknowledged
      || [...requests.values()].filter(op => op.status !== 'pending').length + value.retiredThrough !== value.sequence
      || value.events.length + [...requests.values()].filter(op => op.status === 'pending').length > this.limits.events) throw new HostError('invalid_store');
  }
  private validateReceipt(raw: Record<string, unknown>): void {
    if (raw.status === 'completed') {
      if (!Object.hasOwn(raw, 'result') || Object.hasOwn(raw, 'error')) throw new HostError('invalid_store');
      payload(raw.result);
    } else if (raw.status === 'pending') {
      if (Object.hasOwn(raw, 'result') || Object.hasOwn(raw, 'error')) throw new HostError('invalid_store');
    } else if (raw.status === 'failed' || raw.status === 'unknown') {
      const allowed = raw.status === 'failed' ? ['runtime_failed', 'invalid_runtime_result'] : ['host_restarted'];
      if (Object.hasOwn(raw, 'result') || !allowed.includes(raw.error as string)) throw new HostError('invalid_store');
    } else throw new HostError('invalid_store');
  }
}
