import fs from 'fs/promises';
import { AgyCheckpoint, scheduleDigest, loadCheckpointSession, type AgyResumePermit } from '../../scheduling/agy/AgyCheckpoint';
import { randomUUID } from 'crypto';
import { AcpClient, type AcpTransport, type AcpEventCallbacks, type AcpSessionSetup } from '../acp/AcpClient';
import { applyAgySessionSettings } from './AgySessionSettings';
import { AgyAcpStartupError, type AgyAcpStartupStage } from './AgyAcpDiagnostics';
import type { AcpMcpServer } from '../acp/AcpTypes';
import type { ExecuteOptions, ExecuteResult } from '../IExecutor';
import { AgyScheduleHost } from '../../scheduling/agy/AgyScheduleHost';
import { AgyHookRelay, installAgyScheduleHooks } from '../../scheduling/agy/AgyHookRelay';
import { nativeBindings } from '../../native/NativeBindings';
import type { NativeScheduleInput, NativeScheduleEvent, NativeScheduleHandle } from '../../scheduling/types';

export interface AgyAcpRuntimeOptions {
  command: string; home: string; cwd: string; threadId: string; env: NodeJS.ProcessEnv;
  model?: string; effort?: string; autoApprove: boolean;
  mcpServers?: AcpMcpServer[];
  checkpoint?: AgyCheckpoint;
  resume?: AgyResumePermit;
  saveSession(id: string): void;
  /** A failed setup must retain an admission fence when persisting retirement. */
  retireSession(id: string, setupFailed?: boolean): void;
  /** Persist before the native schedule tool can run, even if its receipt is lost. */
  retainScheduleOwner(sessionId: string, hostId: string, retired: boolean): void;
  mapTool(name: string, args: Record<string, unknown>): { name: string; input: Record<string, unknown> };
}

/** Original ACP conversation. A one-use local checkpoint permits loading only
 * after exact group retirement before every possible owned native wake. */
export class AgyAcpRuntime {
  private client?: AcpTransport;
  private handoff = false;
  private handoffWork?: Promise<void>;
  private continuing = false;
  private continuationFailure?: string;
  private continued = false;
  get continuationSucceeded(): boolean { return this.continued; }
  private readonly entries = new Map<string, { input: NativeScheduleInput; emit(event: NativeScheduleEvent): void | Promise<void>; current(): boolean; handle: NativeScheduleHandle; cancelled: boolean }>();
  get continuationPending(): boolean { return this.continuing; }
  get checkpointClean(): boolean { return this.options.checkpoint?.read()?.state === 'clean'; }

  private host?: AgyScheduleHost;
  private relay?: AgyHookRelay;
  private restore?: () => Promise<void>;
  private starting?: Promise<void>;
  private closing = false;
  private closePromise?: Promise<void>;
  private noJobs?: { check(): void; prepared: ReturnType<AgyCheckpoint['prepare']> };
  private activity?: () => void;
  private closed = false;
  private allocationStarted = false;
  private allocatedSessionId?: string;
  private active?: ExecuteOptions;
  private activeDone?: Promise<unknown>;
  private retained = false;
  private hostId = randomUUID();
  private tools = new Map<number, string>();
  private streamed = '';
  private callbacks: AcpEventCallbacks;
  constructor(private readonly options: AgyAcpRuntimeOptions) {
    this.callbacks = {
      // ACP may flush old autonomous chunks into the next prompt. Only use it
      // before any managed timer exists; afterwards use current native records.
      onTextChunk: block => {
        this.activity?.();
        if (!this.retained && this.active && block.type === 'text' && typeof block.text === 'string') {
          this.streamed += block.text; this.active.onStream?.(block.text); this.active.onDisplayText?.(block.text);
        }
      },
      onPermissionRequest: async (_title, choices) => this.options.autoApprove
        ? choices.findIndex(choice => choice.kind === 'allow_once') : -1,
    };
  }
  get safeFallback(): boolean { return this.closed && !this.host && !this.allocationStarted; }
  get sessionId(): string | undefined { return this.host?.sessionId; }
  get hasJobs(): boolean { return this.retained; }
  get busy(): boolean { return this.continuing || !this.closed && ( !!this.active || !!this.starting || !!this.host?.schedules.busy); }
  get blocked(): string | undefined { return this.continuationFailure ?? this.host?.schedules.status.blocked; }
  get pendingMutation(): boolean { return !!this.host?.schedules.pendingMutation; }
  get running(): boolean { return !!this.client && !this.closed; }

  async start(): Promise<void> {
    if (this.closing || this.closed) throw new Error('AGY ACP host is retired.');
    if (this.host) return;
    if (this.starting) return this.starting;
    this.starting = this.open();
    try { await this.starting; }
    catch (error) {
      try { await this.close(); }
      catch (cleanup) { throw new AgyAcpStartupError('startup', error, cleanup); }
      throw error;
    } finally { this.starting = undefined; }
  }
  private async open(): Promise<void> {
    let stage: AgyAcpStartupStage = 'native-helper';
    try { await this.openSession(next => { stage = next; }); }
    catch (error) { throw new AgyAcpStartupError(stage, error); }
  }
  private async openSession(setStage: (stage: AgyAcpStartupStage) => void): Promise<void> {
    const native = nativeBindings();
    if (!native.readChunk || !native.openOutputChild) throw new Error('AGY ACP transcript handle support is unavailable.');
    setStage('hooks');
    await fs.mkdir(this.options.home, { recursive: true, mode: 0o700 });
    if (this.closing) throw new Error('AGY startup was retired.');
    this.relay = new AgyHookRelay(this.options.home, (event, payload, rows) => {
      if (!this.host) throw new Error('AGY hook arrived before session admission.');
      this.activity?.();
      const decision = this.host.schedules.accept(event, payload, rows);
      if (this.active && decision.decision !== 'deny') {
        if (event === 'PreToolUse') {
          const call = payload.toolCall as { id: string; name: string; args: Record<string, unknown> };
          if (call && Number.isSafeInteger(payload.stepIdx)) {
            this.tools.set(payload.stepIdx as number, call.id);
            this.active.onToolUse?.({ id: call.id, ...this.options.mapTool(call.name, call.args) });
          }
        }
        for (const [step, id] of this.tools) {
          const row = rows.find(row => row.step_index === step && row.type === 'GENERIC' && row.status === 'DONE');
          if (row) { this.active.onToolResult?.({ tool_use_id: id, content: (row.content ?? '').slice(0, 32768), is_error: false }); this.tools.delete(step); }
        }
      }
      return decision;
    }, () => this.host?.schedules.fence('AGY hook relay failed; native schedule state is unconfirmed.'));
    this.restore = await installAgyScheduleHooks(this.options.home, await this.relay.start());
    if (this.closing) throw new Error('AGY startup was retired.');
    const args = ['acp', '--stdio', '--process-per-session', '--disable-telemetry'];
    if (this.options.autoApprove) args.push('--dangerously-skip-permissions');
    setStage('process');
    this.client = new AcpClient(this.options.command, args, this.options.cwd, this.callbacks, true,
      { env: this.options.env, delegationWorker: true, onStderr: () => {} });
    setStage('initialize');
    await this.client.initialize();
    if (this.closing) throw new Error('AGY startup was retired.');
    const setup: AcpSessionSetup = async (session, configure) => {
      if (typeof session?.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(session.sessionId)) throw new Error('AGY ACP returned no valid session identity.');
      this.allocatedSessionId = session.sessionId;
      setStage('session-save');
      try { this.options.saveSession(session.sessionId); }
      catch { throw new Error('AGY ACP session identity could not be persisted. No prompt was sent.'); }
      if (this.closing) throw new Error('AGY startup was retired.');
      setStage('session-settings');
      await applyAgySessionSettings(session, async (id, value) => {
        if (this.closing) throw new Error('AGY startup was retired.');
        const result = await configure(id, value);
        if (this.closing) throw new Error('AGY startup was retired.');
        return result;
      }, this.options);
      if (this.closing) throw new Error('AGY startup was retired.');
    };
    let session: { sessionId?: string };
    // A lost/malformed allocation reply is not proof that no ACP session exists.
    this.allocationStarted = true;
    if (this.options.resume) {
      setStage('session-load');
      this.client = await loadCheckpointSession(this.client, this.options.resume, this.options.cwd, this.options.mcpServers, setup);
      session = { sessionId: this.options.resume.sessionId };
      this.options.resume = undefined;
    } else {
      setStage('session-create');
      if (!this.client.newSessionWithSetup) throw new Error('AGY ACP initial session setup is unavailable.');
      session = await this.client.newSessionWithSetup(this.options.cwd, this.options.mcpServers, setup);
    }
    if (this.closing) throw new Error('AGY startup was retired.');
    if (!session.sessionId) throw new Error('AGY ACP returned no session identity.');
    if (this.allocatedSessionId !== session.sessionId) throw new Error('AGY ACP initial session setup was not confirmed.');
    setStage('host-admission');
    this.host = new AgyScheduleHost(this.client, session.sessionId, {
      threadId: this.options.threadId, cwd: this.options.cwd,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      hostId: this.hostId, isCurrent: () => !this.closing,
      beforeMutation: async () => {
        this.options.retainScheduleOwner(session.sessionId!, this.hostId, false);
        this.retained = true;
      },
    });
    this.host.bind(this.relay);
    void this.client.waitForExit!().then(() => {
      if (!this.closing) this.host?.schedules.processClosed(false);
    });
  }

  async execute(prompt: string, options: ExecuteOptions): Promise<ExecuteResult> {
    await this.start();
    if (this.active) throw new Error('AGY foreground turn is already active.');
    this.active = options; this.streamed = ''; this.tools.clear();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inactive: ReturnType<typeof setTimeout> | undefined;
    this.activity = () => {
      if (inactive) clearTimeout(inactive);
      if (options.inactivityTimeout && options.inactivityTimeout > 0) inactive = setTimeout(() => this.host!.cancelForeground(), options.inactivityTimeout);
    };
    this.activity();
    try {
      if (options.timeout && options.timeout > 0) timer = setTimeout(() => this.host!.cancelForeground(), options.timeout);
      const work = this.host!.prompt([{ type: 'text', text: options.resolvePrompt?.(this.sessionId ?? null) ?? prompt }]);
      this.activeDone = work;
      const result = await work;
      // Current native Stop gives the final text without replaying buffered ACP
      // output. With timers, this is a batch projection, not token streaming.
      if (result.output && (this.retained || !this.streamed)) {
        options.onStream?.(result.output); options.onDisplayText?.(result.output);
      }
      return { success: result.success, output: result.output, sessionAbbr: this.sessionId?.slice(0, 8),
        ...(!result.success && { error: result.output }) };
    } finally { if (timer) clearTimeout(timer); if (inactive) clearTimeout(inactive); this.activity = undefined; this.active = undefined; this.activeDone = undefined; this.tools.clear(); }
  }
  async abort(): Promise<boolean> {
    this.continued = false;
    let window: (() => void) | undefined;
    let prepared: ReturnType<AgyCheckpoint['prepare']> | undefined;
    if (this.retained && this.options.checkpoint && this.active && !this.pendingMutation) {
      try {
        window = this.host!.schedules.checkpointWindow(true);
        prepared = this.options.checkpoint.prepare(this.sessionId!, this.definitions());
        this.handoff = true; this.continuing = true;
      } catch { /* Ordinary cancellation still works; unknown work remains fenced. */ }
    }
    const terminal = this.activeDone;
    const cancelled = this.host?.cancelForeground() ?? false;
    let confirmed = false;
    if (cancelled) {
      try { confirmed = (await terminal as { stopReason?: string } | undefined)?.stopReason === 'cancelled'; } catch { /* No confirmed terminal: retain uncertainty. */ }
    }
    if (cancelled && window && prepared) {
      try {
        if (!confirmed) throw new Error('AGY foreground cancellation terminal is unconfirmed.');
        window(); await this.close(); window();
        this.options.checkpoint!.confirm(prepared);
        await this.resumeCurrent();
        this.continued = true;
      } catch (error) {
        this.handoff = false;
        this.continuationFailure = error instanceof Error ? error.message : 'AGY continuation is unconfirmed.';
        this.host?.schedules.fence('AGY automatic continuation failed; retained work requires reconciliation.');
        for (const entry of this.entries.values()) entry.emit({ type: 'stopped', exitConfirmed: false,
          reason: error instanceof Error ? error.message : 'AGY continuation is unconfirmed.' });
      } finally { this.continuing = false; }
    }
    return cancelled;
  }
  private definitions(): Record<string, string> {
    return Object.fromEntries([...this.entries].filter(([, entry]) => !entry.cancelled)
      .map(([id, entry]) => [id, scheduleDigest(entry.input)]));
  }
  private async resumeCurrent(): Promise<void> {
    const entries = [...this.entries.values()].filter(entry => !entry.cancelled);
    if (entries.some(entry => !entry.current() || entry.input.rule.kind === 'once' && Date.parse(entry.input.rule.at) <= Date.now())) throw new Error('AGY continuation owner or deadline changed before loading.');
    const permit = this.options.checkpoint!.consume(this.sessionId!);
    this.client = undefined; this.host = undefined; this.relay = undefined; this.closed = false; this.allocatedSessionId = undefined;
    this.closing = false; this.closePromise = undefined; this.starting = undefined;
    this.hostId = randomUUID(); this.handoffWork = undefined;
    this.options.resume = permit;
    await this.start();
    await this.host!.qualify();
    for (const entry of entries) {
      if (!entry.current() || entry.input.rule.kind === 'once' && Date.parse(entry.input.rule.at) <= Date.now()) throw new Error('AGY continuation owner or deadline changed.');
      const previousNativeId = entry.handle.nativeId;
      entry.handle = await this.host!.create(entry.input, event => { if (!this.handoff || event.type !== 'stopped') return entry.emit(event); }, entry.current);
      await entry.emit({ type: 'rebound', previousNativeId, nativeId: entry.handle.nativeId });
    }
    this.handoff = false;
  }
  /** Shared ScheduleService calls this once per handle; the host-wide operation
   * is coalesced. Delete every owned definition before the first possible wake,
   * join the group before that same deadline, then publish a clean checkpoint. */
  releaseForRestart(): Promise<void> {
    if (this.handoffWork) return this.handoffWork;
    if (!this.options.checkpoint || !this.host || this.active || this.pendingMutation) return Promise.reject(new Error('AGY handoff is busy or unavailable.'));
    let window: () => void;
    try { window = this.host.schedules.checkpointWindow(); }
    catch (error) { return Promise.reject(error); } // No mutation: a later genuine idle retry is allowed.
    return this.handoffWork = (async () => {
      const prepared = this.options.checkpoint!.prepare(this.sessionId!, this.definitions());
      this.handoff = true;
      try {
        for (const entry of this.entries.values()) { window(); await entry.handle.cancel(); window(); }
        await this.close(); window();
        this.options.checkpoint!.confirm(prepared);
      } catch (error) {
        this.handoff = false; this.host?.schedules.fence('AGY orderly handoff could not exclude queued work.'); throw error;
      }
    })();
  }
  async withOperation<T>(id: string, current: () => boolean, run: () => Promise<T>, inTurn: boolean): Promise<T> {
    await this.start();
    return this.host!.schedules.withOperation(id, current, run, inTurn);
  }
  action(id: string) { return this.host?.schedules.action(id); }
  async create(input: NativeScheduleInput, emit: (event: NativeScheduleEvent) => void | Promise<void>, current: () => boolean): Promise<NativeScheduleHandle> {
    await this.start();
    await this.host!.qualify();
    const entry = { input: structuredClone(input), emit, current, handle: undefined as unknown as NativeScheduleHandle, cancelled: false };
    const actual = await this.host!.create(input, event => { if (!this.handoff || event.type !== 'stopped') return emit(event); }, current);
    entry.handle = actual; this.entries.set(input.id, entry);
    return {
      get nativeId() { return entry.handle.nativeId; },
      recoveryIdentity: input.recovery?.identity,
      get retirementConfirmed() { return entry.handle.retirementConfirmed; },
      get nativeDefinitionAbsent() { return entry.handle.nativeDefinitionAbsent; },
      cancellationKeepsRunning: true,
      list: () => entry.handle.list(),
      cancel: () => { entry.cancelled = true; return entry.handle.cancel(); },
      stop: () => entry.handle.stop(),
      ...(this.options.checkpoint ? { releaseForRestart: async () => { await this.releaseForRestart(); return { nativeDefinitionAbsent: true as const }; } } : {}),
    };
  }
  /** Join the exact tracked group before restoring hooks. Retirement does not
   * authorize loading this conversation: old SYSTEM reminders may survive. */
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    const noRemainingJobs = !this.retained || this.entries.size > 0 && [...this.entries.values()].every(entry => entry.cancelled && entry.handle.retirementConfirmed === true);
    if (!this.closing && noRemainingJobs && !this.active && this.host && this.options.checkpoint && !this.host.schedules.status.blocked) {
      try { this.noJobs = { check: this.host.schedules.checkpointWindow(), prepared: this.options.checkpoint.prepare(this.host.sessionId, {}) }; }
      catch { /* Ordinary chat can still retire without granting ACP recovery. */ }
    }
    this.closing = true;
    return this.closePromise ??= (async () => {
      await this.starting?.catch(() => {});
      await this.finishClose();
    })().catch(error => { this.closePromise = undefined; throw error; });
  }
  private async finishClose(): Promise<void> {
    this.closing = true;
    if (this.host) await this.host.close();
    else { this.client?.destroy(); await this.client?.waitForExit?.(); }
    if (this.client && !this.client.waitForManagedProcessGroupExit) throw new Error('AGY exact process-group retirement cannot be confirmed.');
    await this.client?.waitForManagedProcessGroupExit?.();
    if (this.host) {
      if (this.retained) this.options.retainScheduleOwner(this.host.sessionId, this.hostId, true);
      this.host.schedules.processClosed(true);
    }
    await this.relay?.close();
    await this.restore?.(); this.restore = undefined;
    if (this.allocatedSessionId) {
      try { this.options.retireSession(this.allocatedSessionId, !this.host); }
      catch { throw new Error('AGY ACP session retirement could not be persisted. Retain session evidence before retrying.'); }
    }
    this.closed = true;
    if (this.noJobs) {
      try { this.noJobs.check(); this.options.checkpoint!.confirm(this.noJobs.prepared); }
      catch { /* No clean proof is published when quiescence expired. */ }
      this.noJobs = undefined;
    }
  }
}
