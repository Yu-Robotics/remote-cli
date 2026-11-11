import type { ChildProcess, SpawnOptions } from 'child_process';
import fs from 'fs/promises';
import { randomUUID } from 'crypto';
import { ManagedProcessGroups } from '../executor/ManagedProcessGroups';
import { spawnManaged } from '../executor/ManagedSpawn';
import { NativeScheduleCleanupError, type NativeScheduleEvent, type NativeScheduleHandle,
  type NativeScheduleInput, type NativeScheduleProvider } from './types';
import { createLaunch, type DshLaunch } from './dsh/launch';
import { COMMAND, EVENT, VERSION, MAX_FRAME, MAX_OUTPUT, JsonLines, identifier, instant, matchesRecord,
  normalizeRule, object, validPrompt, type ObjectValue } from './dsh/protocol';

export interface DshNativeScheduleProviderOptions {
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  /** Test seam; production requires the existing native process-group / Windows Job exit proof. */
  confirmProcessExit?: (child: ChildProcess) => Promise<void>;
  launch?: () => Promise<DshLaunch>;
  managementTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  now?: () => number;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
interface Pending { done: ReturnType<typeof deferred<any>>; validate: (value: ObjectValue) => any }

/** First-party DSH timing over ACP, with a process-owned host event/CRUD adapter. Never resumes a scope. */
export class DshNativeScheduleProvider implements NativeScheduleProvider {
  constructor(private readonly options: DshNativeScheduleProviderOptions = {}) {}
  async create(input: NativeScheduleInput, onEvent: (event: NativeScheduleEvent) => void): Promise<NativeScheduleHandle> {
    input = { ...input, rule: { ...input.rule } };
    const rule = normalizeRule(input.rule, (this.options.now ?? Date.now)());
    if (!identifier(input.id) || !validPrompt(input.prompt)) throw new Error('Invalid DSH schedule ID or prompt.');
    for (const value of [input.command, input.model, input.effort]) {
      if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > 1024 || /[\x00-\x1f]/.test(value))) {
        throw new Error('Invalid DSH launch option.');
      }
    }
    let cwd: string;
    try { cwd = await fs.realpath(input.cwd); if (!(await fs.stat(cwd)).isDirectory()) throw new Error(); }
    catch { throw new Error('DSH schedule working directory is unavailable.'); }
    const launch = await (this.options.launch ?? createLaunch)();
    let session: DshSession;
    try { session = new DshSession({ ...input, rule, cwd }, onEvent, launch, this.options); }
    catch { await launch.dispose(); throw new Error('Native DSH schedule process could not start.'); }
    try { await session.start(); return session; }
    catch (error) {
      try { await session.stop(); }
      catch { throw new NativeScheduleCleanupError('DSH creation failed; process-tree exit or owned storage cleanup is unconfirmed. Retry cleanup with this handle.', session); }
      throw error;
    }
  }
}

class DshSession implements NativeScheduleHandle {
  private jobId = '';
  get nativeId(): string { return this.jobId; }
  private sessionId = '';
  private readonly title = `remote-cli-${randomUUID()}`;
  private child!: ChildProcess;
  private readonly groups = new ManagedProcessGroups();
  private readonly ready = deferred<void>();
  private readonly exited = deferred<void>();
  private readonly pending = new Map<string, Pending>();
  private sequence = 0;
  private rpcId = 0;
  private commandId = 0;
  private closed = false;
  private leaderExited = false;
  private spawnFailed = false;
  private spawned = false;
  private stopping = false;
  private confirmed = false;
  private cancelRequested = false;
  private failure?: Error;
  private shutdown?: Promise<void>;
  private serial: Promise<unknown> = Promise.resolve();
  private active?: { id: string; turn: number; messageId: string; occurrenceAt: string };
  private lastOccurrence = '';
  private lastTurn = 0;
  private readonly reader = new JsonLines(frame => this.frame(frame));
  private readonly timeout: number;
  private readonly shutdownTimeout: number;

  constructor(private readonly input: NativeScheduleInput, private readonly onEvent: (event: NativeScheduleEvent) => void,
    private readonly launch: DshLaunch, private readonly options: DshNativeScheduleProviderOptions) {
    this.timeout = options.managementTimeoutMs ?? 30_000;
    this.shutdownTimeout = options.shutdownTimeoutMs ?? 2_000;
  }

  private launchProcess(): void {
    const { options, input, launch } = this;
    try { this.child = (options.spawn ?? ((command, args, opts) => spawnManaged(true, command, args, opts)))(input.command ?? 'dsh', launch.args, {
      cwd: input.cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true,
      detached: process.platform !== 'win32',
    }); } catch { throw new Error('Native DSH schedule process could not start.'); }
    if (!options.confirmProcessExit) this.groups.track(this.child);
    this.child.once('spawn', () => { this.spawned = true; });
    this.child.on('error', () => {
      this.spawnFailed = !this.spawned && this.child.pid === undefined;
      this.fail('Native DSH process could not start or be controlled.');
    });
    this.child.once('exit', () => {
      this.leaderExited = true;
      // Closing owned pipes permits close/group proof even if a descendant inherited stdout.
      if (!this.stopping) this.fail('Native DSH process exited unexpectedly.');
      this.child.stdout?.destroy(); this.child.stderr?.destroy();
    });
    this.child.once('close', () => {
      this.closed = true;
      this.exited.resolve();
      this.rejectPending(new Error('Native DSH process closed.'));
      if (this.active) {
        const active = this.active; this.active = undefined;
        this.emit({ type: 'completed', occurrenceId: active.id, success: false, error: 'Native DSH exited before completion was confirmed.' });
      }
      if (!this.stopping) this.fail('Native DSH process closed unexpectedly.');
    });
    if (!this.child.stdin || !this.child.stdout || !this.child.stderr) throw new Error('Native DSH stdio is unavailable.');
    this.child.stdout!.on('data', (chunk: Buffer | string) => {
      if (this.closed) return;
      try { this.reader.read(chunk); } catch { this.fail('Invalid or ambiguous DSH scheduling protocol.'); }
    });
    this.child.stdout!.on('error', () => this.fail('Native DSH output failed.'));
    this.child.stdin!.on('error', () => this.fail('Native DSH input failed.'));
    this.child.stderr!.on('data', () => {});
    this.child.stderr!.on('error', () => {});
  }

  async start(): Promise<void> {
    this.launchProcess();
    await this.bounded(this.ready.promise);
    await this.rpc('initialize', { protocolVersion: 1, clientCapabilities: {} }, value => {
      if (value.protocolVersion !== 1) throw new Error();
    });
    await this.rpc('session/new', { cwd: this.input.cwd, mcpServers: [] }, value => {
      if (!identifier(value.sessionId) || this.sessionId) throw new Error();
      this.sessionId = value.sessionId;
    });
    for (const [configId, value] of [['model', this.input.model], ['reasoning_effort', this.input.effort]] as const) {
      if (value === undefined) continue;
      const selected = configId === 'reasoning_effort' && value === 'auto' ? '' : value;
      await this.rpc('session/set_config_option', { sessionId: this.sessionId, configId, value: selected }, result => {
        if (!Array.isArray(result.configOptions) || !result.configOptions.some(option => option.id === configId && option.currentValue === selected)) throw new Error();
      });
    }
    await this.manage('bind', { cwd: this.input.cwd }, () => {});
    await this.manage('create', { rule: this.input.rule, prompt: this.input.prompt, title: this.title }, result => {
      if (this.jobId || !identifier(result.nativeId) || !matchesRecord(result.record, this.input.rule, this.input.prompt, this.title, result.nativeId)) throw new Error();
      this.jobId = result.nativeId;
    });
    if (this.failure) throw this.failure;
  }

  list(): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.confirmed) return false;
      this.assertLive();
      const present = await this.manage('list', {}, result => {
        if (result.nativeId !== this.jobId || !Array.isArray(result.records) || result.records.length > 1
          || result.records.some(row => !matchesRecord(row, this.input.rule, this.input.prompt, this.title, this.jobId))) throw new Error();
        return result.records.length === 1;
      });
      if (!present) await this.stop();
      return present;
    });
  }
  cancel(): Promise<void> {
    return this.enqueue(async () => {
      if (this.confirmed) return;
      try {
        this.assertLive();
        this.cancelRequested = true;
        await this.manage('cancel', {}, result => this.validateDeletion(result));
      } finally { await this.stop(); }
    });
  }
  private validateDeletion(result: ObjectValue): void {
    if ((this.jobId && result.nativeId !== this.jobId) || (!this.jobId && result.nativeId !== '' && !identifier(result.nativeId))
      || result.deleted !== true || result.remaining !== 0) throw new Error();
  }

  stop(): Promise<void> {
    if (this.confirmed) return Promise.resolve();
    if (this.shutdown) return this.shutdown;
    this.stopping = true;
    this.rejectPending(new Error('Native DSH schedule is stopping.'));
    this.shutdown = this.shutdownProcess();
    void this.shutdown.catch(() => {
      this.shutdown = undefined;
      this.emit({ type: 'stopped', reason: 'DSH process-tree exit or private storage cleanup is unconfirmed.', exitConfirmed: false });
    });
    return this.shutdown;
  }
  private async shutdownProcess(): Promise<void> {
    if (!this.child) {
      await this.launch.dispose();
      this.confirmed = true;
      this.emit({ type: 'stopped', reason: 'Native DSH launch did not start.', exitConfirmed: true });
      return;
    }
    // Best-effort native deletion precedes EOF. Even a broken protocol must retain process ownership.
    if (!this.closed && !this.failure && this.sessionId) {
      try { await this.manage('cancel', {}, result => this.validateDeletion(result), true); } catch { /* Continue containment. */ }
    }
    try { this.child.stdin?.end(); } catch { /* Continue containment. */ }
    if (!await this.waitForClose()) {
      this.signal('SIGTERM');
      if (!await this.waitForClose()) { this.signal('SIGKILL'); if (!await this.waitForClose()) throw new Error('DSH process exit is unconfirmed.'); }
    }
    if (this.options.confirmProcessExit) await this.options.confirmProcessExit(this.child);
    else if (!this.spawnFailed) await this.groups.waitForExit();
    await this.launch.dispose();
    this.confirmed = true;
    this.emit({ type: 'stopped', reason: this.failure?.message ?? 'Native DSH schedule stopped.', exitConfirmed: true });
  }
  private signal(signal: NodeJS.Signals): void {
    try {
      if (!this.options.spawn && process.platform === 'linux' && !this.leaderExited && this.child.pid) process.kill(-this.child.pid, signal);
      else this.child.kill(signal);
    } catch { /* A signal attempt is never exit proof. */ }
  }
  private async waitForClose(): Promise<boolean> {
    if (this.closed) return true;
    let timer: NodeJS.Timeout | undefined;
    try { return await Promise.race([this.exited.promise.then(() => true), new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(false), this.shutdownTimeout);
    })]); } finally { clearTimeout(timer); }
  }
  private assertLive(): void {
    if (this.failure) throw this.failure;
    if (this.stopping || this.closed) throw new Error('Native DSH schedule is stopped.');
  }
  private emit(event: NativeScheduleEvent): void {
    try { this.onEvent(event); } catch { if (!this.stopping) this.fail('DSH schedule event delivery failed.'); }
  }
  private fail(message: string): void {
    this.failure ??= new Error(message);
    this.rejectPending(this.failure);
    void this.stop().catch(() => {});
  }
  private rejectPending(error: Error): void {
    this.ready.reject(error);
    for (const request of this.pending.values()) request.done.reject(error);
    this.pending.clear();
  }
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.serial.then(run);
    this.serial = next.catch(() => {});
    return next;
  }
  private async bounded<T>(work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try { return await Promise.race([work, new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Native DSH schedule operation timed out.')), this.timeout);
    })]); } finally { clearTimeout(timer); }
  }
  private send(frame: ObjectValue): void {
    if (this.closed || !this.child.stdin?.writable) throw new Error('Native DSH input is unavailable.');
    const line = JSON.stringify(frame) + '\n';
    if (Buffer.byteLength(line) > MAX_FRAME || this.child.stdin.writableLength > MAX_FRAME) throw new Error('Native DSH input limit exceeded.');
    this.child.stdin.write(line, error => { if (error) this.fail('Native DSH input write failed.'); });
  }
  private async request(key: string, frame: ObjectValue, validate: Pending['validate'], allowStopping = false): Promise<any> {
    if (!allowStopping) this.assertLive();
    const done = deferred<any>();
    this.pending.set(key, { done, validate });
    try { this.send(frame); return await this.bounded(done.promise); }
    catch { if (!this.stopping) this.fail('Native DSH schedule operation failed or timed out.'); throw new Error('Native DSH schedule operation failed or timed out.'); }
    finally { this.pending.delete(key); }
  }
  private rpc(method: string, params: ObjectValue, validate: Pending['validate']): Promise<any> {
    const id = ++this.rpcId;
    return this.request(`rpc:${id}`, { jsonrpc: '2.0', id, method, params }, validate);
  }
  private manage(operation: string, extras: ObjectValue, validate: Pending['validate'], allowStopping = false): Promise<any> {
    const requestId = ++this.commandId;
    return this.request(`command:${requestId}`, { jsonrpc: '2.0', method: COMMAND, params: {
      version: VERSION, scope: this.launch.scope, requestId, operation, sessionId: this.sessionId, ...extras,
    } }, result => {
      if (result.operation !== operation || result.sessionId !== this.sessionId) throw new Error();
      return validate(result);
    }, allowStopping);
  }
  private settle(key: string, value: unknown): void {
    const request = this.pending.get(key);
    if (!request) { if (this.stopping) return; throw new Error(); }
    if (!object(value)) throw new Error();
    const validated = request.validate(value);
    this.pending.delete(key);
    request.done.resolve(validated);
  }

  private frame(frame: ObjectValue): void {
    // Once provenance or transport integrity is lost, later frames cannot repair it.
    // Keep the active occurrence for the confirmed-close failure path.
    if (this.failure) return;
    if (frame.jsonrpc !== '2.0') throw new Error();
    if (frame.method === EVENT) {
      const p = frame.params;
      if (!object(p) || 'id' in frame || p.version !== VERSION || p.scope !== this.launch.scope || p.sequence !== this.sequence + 1) throw new Error();
      this.sequence = p.sequence;
      if (p.kind === 'ready') {
        if (this.sequence !== 1) throw new Error();
        this.ready.resolve();
      } else if (p.kind === 'fatal') this.fail('Native DSH schedule bridge rejected ownership or protocol state.');
      else if (p.kind === 'receipt') this.settle(`command:${p.requestId}`, p);
      else if (p.kind === 'started' || p.kind === 'completed') this.occurrence(p);
      else throw new Error();
    } else if ('id' in frame && !('method' in frame)) {
      if ('error' in frame) throw new Error();
      this.settle(`rpc:${frame.id}`, frame.result);
    } else if ('id' in frame) {
      // Unattended execution never auto-grants unknown approvals or client-side execution.
      if (frame.method === 'session/request_permission' && frame.params?.sessionId === this.sessionId) {
        this.send({ jsonrpc: '2.0', id: frame.id, result: { outcome: { outcome: 'cancelled' } } });
      } else this.send({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Unsupported unattended client request.' } });
    } else if (frame.method === 'session/update') {
      if (frame.params?.sessionId !== this.sessionId) throw new Error();
      // Output belongs to the bridge's native turn, not to ACP chunk arrival order.
    }
  }
  private occurrence(p: ObjectValue): void {
    if (!this.jobId || p.nativeId !== this.jobId || p.sessionId !== this.sessionId || !identifier(p.messageId)
      || !Number.isSafeInteger(p.turn) || p.turn < 1 || !instant(p.occurrenceAt)) throw new Error();
    const id = `${p.nativeId}:${p.occurrenceAt}`;
    if (p.kind === 'started') {
      if (this.active || p.turn <= this.lastTurn || p.occurrenceAt <= this.lastOccurrence
        || (this.input.rule.kind === 'once' && p.occurrenceAt !== this.input.rule.at)) throw new Error();
      this.lastTurn = p.turn; this.lastOccurrence = p.occurrenceAt;
      this.active = { id, turn: p.turn, messageId: p.messageId, occurrenceAt: p.occurrenceAt };
      this.emit({ type: 'started', occurrenceId: id });
    } else {
      if (!this.active || this.active.id !== id || this.active.turn !== p.turn || this.active.messageId !== p.messageId
        || typeof p.success !== 'boolean' || typeof p.output !== 'string' || Buffer.byteLength(p.output) > MAX_OUTPUT
        || (p.error !== undefined && (typeof p.error !== 'string' || p.error.length > 256))) throw new Error();
      this.active = undefined;
      this.emit({ type: 'completed', occurrenceId: id, success: p.success, output: p.output,
        ...(p.success ? {} : { error: 'Native DSH scheduled turn did not complete successfully.' }) });
      if (this.input.rule.kind === 'once' && !this.cancelRequested && !this.stopping) void this.stop().catch(() => {});
    }
  }
}
