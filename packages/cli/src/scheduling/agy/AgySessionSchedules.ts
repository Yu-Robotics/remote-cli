import { performance } from 'perf_hooks';
import { createHash, randomUUID } from 'crypto';
import { isDeepStrictEqual } from 'util';
import { nativeRule } from '../claude/rules';
import { NativeScheduleCleanupError, NativeScheduleNotAdmittedError } from '../types';
import type { NativeScheduleEvent, NativeScheduleHandle, NativeScheduleInput, NativeScheduleProvider, NativeScheduleToolAction } from '../types';
import { creationReceipt, creationDescription, deletionReceipt, inventoryReceipt, matchesWake, nativeWake, nativeRestartNotice, type TranscriptRecord } from './transcript';

export type HookPayload = Record<string, unknown>;
export type HookDecision = { decision?: 'allow' | 'deny'; reason?: string; terminationBehavior?: 'terminate' };
interface Job {
  input: NativeScheduleInput; id: string; description?: string; cancelled: boolean; absent: boolean; completed?: boolean; retiredBeforeWake?: boolean; firstPossibleWake?: number;
  emit(event: NativeScheduleEvent): void; admit(): boolean;
}
interface Operation {
  action: NativeScheduleToolAction; callId?: string; step?: number;
  receipt?: string | boolean | ReturnType<typeof inventoryReceipt>; job?: Job; received?: () => void;
}
export interface AgySessionScheduleOptions {
  sessionId: string;
  threadId: string;
  /** Unique to this exact native process, never a persisted resume identity. */
  hostId?: string;
  cwd: string;
  timezone: string;
  /** Must use the SAME original ACP session and serialize with foreground prompts. */
  manage(action: NativeScheduleToolAction): Promise<{ stopReason: string }>;
  isCurrent(): boolean;
  timeoutMs?: number;
  beforeMutation?(): Promise<void>;
  now?: () => number;
}

/** Session-scoped native provider. No timers except bounded receipt waits, no
 * implicit restart/replay. Hook callbacks must originate from the private relay.
 * Recovery is deliberately absent: native inventory cannot prove queue absence. */
export class AgySessionSchedules implements NativeScheduleProvider {
  private readonly hostId: string;
  private readonly jobs = new Map<string, Job>();
  private operation?: Operation;
  private tail: Promise<unknown> = Promise.resolve();
  private ready = false;
  private scope?: { id: string; current(): boolean; inTurn: boolean };
  get busy(): boolean { return this.boundary !== undefined || !!this.operation; }
  get hasJobs(): boolean { return this.jobs.size > 0; }
  get pendingMutation(): boolean { return !!this.operation || !!this.scope; }
  // The admitted management scope is not itself an unsettled native receipt.
  // Keep it in pendingMutation for host transitions, but allow its own purge.
  get cleanupMutationPending(): boolean { return !!this.operation || this.mutationUncertain && !this.exited; }
  async withOperation<T>(id: string, current: () => boolean, run: () => Promise<T>, inTurn: boolean): Promise<T> {
    if (this.scope || (inTurn && !this.foreground)) throw new Error('AGY schedule operation scope is unavailable.');
    this.check(); this.scope = { id, current, inTurn };
    try { return await run(); } finally { this.scope = undefined; }
  }
  action(id: string): NativeScheduleToolAction | undefined {
    return this.scope?.id === id && this.scope.inTurn && this.scope.current() && !this.operation?.callId
      ? this.operation?.action : undefined;
  }

  private failure?: string;
  private backgroundUnknown = false;
  private mutationUncertain = false;
  private cancellationInvalid = false;
  private cancellationCaptured = false;
  private cancellationInProgress = false;
  /** Guard only the interval before ANY possible native firing. This does not
   * deduce queue emptiness from inventory or from fullyIdle. */
  cancellationWindow(allowForeground = false, allowManagementScope = false): () => void {
    this.check();
    if (this.operation || this.scope && (!allowManagementScope || this.scope.inTurn) || (!allowForeground && (this.foreground || this.boundary !== undefined))
      || this.backgroundUnknown || this.mutationUncertain || this.observed.size || this.pendingWakes.size) {
      throw new Error('AGY cancellation retirement requires never-fired definitions and no unknown native work.');
    }
    const now = Date.now(), mono = performance.now();
    const cutoffs = [...this.jobs.values()].filter(job => !job.retiredBeforeWake).map(job => job.firstPossibleWake ?? 0);
    const cutoff = Math.min(...cutoffs, now + 30000);
    const deadline = mono + cutoff - now;
    const check = () => {
      // Reject clock discontinuities and require exit before the earliest native
      // deadline, including a reserve for clock granularity. No timer drives work.
      if (this.cancellationInvalid || [...this.jobs.values()].some(job => !job.cancelled && !job.completed && !job.admit()) || this.backgroundUnknown || this.mutationUncertain || this.observed.size || this.pendingWakes.size
        || Date.now() + 1000 >= cutoff || performance.now() + 1000 >= deadline
        || Math.abs((Date.now() - now) - (performance.now() - mono)) > 250) {
        throw new Error('AGY cancellation deadline or queued-work proof expired; retirement is unconfirmed.');
      }
    };
    check(); this.cancellationCaptured = true; return check;
  }

  private exited = false;
  private seenSessionStart = false;
  private seenHookTerminal = false;
  private boundary?: number;
  private invocation?: { number: number; start: number; outputs?: Map<number, string> };
  private lastTerminal = -1;
  private foreground = false;
  private executionForeground = false;
  private executionManagement = false;
  private foregroundResult?: { success: boolean; output: string };
  private readonly pendingWakes = new Map<number, { job: Job; row: TranscriptRecord; id: string }>();
  private readonly observed = new Map<number, string>();
  private readonly terminals = new Map<number, string>();
  constructor(private readonly options: AgySessionScheduleOptions) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(options.sessionId)) throw new Error('Invalid native AGY session identity.');
    this.hostId = options.hostId ?? randomUUID();
  }

  get status(): { qualified: boolean; blocked?: string } {
    return { qualified: this.ready && !this.failure, blocked: this.failure };
  }

  /** Explicit native inventory management, never an idle wakeup nudge. The
   * caller must not attach a restored/uncertain predecessor to qualify it. */
  qualify(): Promise<void> {
    return this.serial(async () => {
      this.check();
      if (this.ready) return;
      const rows = await this.run({ tool: 'manage_task', input: { Action: 'list' } });
      if ((!this.seenSessionStart && !this.seenHookTerminal) || !Array.isArray(rows) || rows.length) {
        this.fence('AGY requires observed native hooks and a fresh, empty task inventory on the original live host.');
        throw new Error(this.failure);
      }
      this.ready = true;
    });
  }

  create(input: NativeScheduleInput, emit: Job['emit'], admit: () => boolean = () => true): Promise<NativeScheduleHandle> {
    input = structuredClone(input);
    return this.serial(async () => {
      this.check();
      if (!this.ready || ((this.foreground || this.boundary !== undefined) && !this.scope?.inTurn) || input.backend !== 'agy' || input.threadId !== this.options.threadId || input.cwd !== this.options.cwd
        || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.id) || this.jobs.has(input.id) || this.jobs.size >= 100
        || !input.prompt.trim() || Buffer.byteLength(input.prompt) > 64 * 1024 || !admit()) {
        throw new NativeScheduleNotAdmittedError('AGY schedule session, owner, capacity or input is not qualified.');
      }
      const args: Record<string, unknown> = { Prompt: input.prompt };
      const now = (this.options.now ?? Date.now)();
      if (input.rule.kind === 'once') {
        const at = Date.parse(input.rule.at);
        if (!Number.isFinite(at) || at <= now || at - now > 7 * 86400_000) throw new NativeScheduleNotAdmittedError('AGY one-shot must be in the next seven days.');
        args.DurationSeconds = Math.ceil((at - now) / 1000); args.TimerCondition = 'never';
      } else {
        const rule = nativeRule(input.rule, now);
        if (rule.timezone !== this.options.timezone) throw new NativeScheduleNotAdmittedError('AGY cron timezone must match the original native host.');
        args.CronExpression = rule.cron; args.ExactTiming = true; args.IsDaemon = true;
      }
      const job: Job = { input, id: '', cancelled: false, absent: false, emit, admit };
      await this.options.beforeMutation?.();
      this.check();
      if (!admit()) throw new NativeScheduleNotAdmittedError('AGY schedule admission changed before native creation.');
      this.jobs.set(input.id, job);
      const handle = this.handle(job);
      try {
        const receipt = await this.run({ tool: 'schedule', input: args }, job);
        if (typeof receipt !== 'string' || receipt !== job.id) throw new Error('Native AGY creation receipt is missing.');
        return handle;
      } catch {
        // The tool may have committed even when ACP/Stop timed out. Keep ownership
        // and prevent retries; never infer absence from a missing creation receipt.
        throw new NativeScheduleCleanupError('AGY creation is uncertain; retain this host and cleanup obligation.', handle);
      }
    });
  }

  private handle(job: Job): NativeScheduleHandle {
    const self = this;
    return {
      get nativeId() { return job.id; },
      get nativeDefinitionAbsent() { return job.absent && !self.exited; },
      cancellationKeepsRunning: true,
      // Empty definitions are not empty queues. Require exact group exit or
      // separately proved deletion before any possible native wake.
      get retirementConfirmed() { return self.exited || job.retiredBeforeWake === true; },
      list: () => self.serial(() => self.present(job)),
      cancel: () => {
        // ScheduleService persists cancellation before this call. The in-memory
        // intent is synchronous too, before the first awaited native mutation.
        job.cancelled = true;
        return self.serial(async () => {
          self.check();
          if (!job.id) throw new Error('AGY native identity is unresolved; no blind deletion or recreation is allowed.');
          let beforeWake: (() => void) | undefined;
          try { beforeWake = self.cancellationWindow(false, true); } catch { /* Deletion still works without an execution-retirement receipt. */ }
          if (await self.present(job)) {
            if (await self.run({ tool: 'manage_task', input: { Action: 'kill', TaskId: job.id } }) !== true
              || await self.present(job)) throw new Error('AGY exact native deletion is unconfirmed.');
          }
          if (beforeWake) {
            try { beforeWake(); job.retiredBeforeWake = true; }
            catch { /* Deadline races retain queued-work uncertainty. */ }
          }
        });
      },
      stop: () => job.completed || job.absent ? Promise.resolve() : self.handle(job).cancel(),
    };
  }

  private async present(job: Job): Promise<boolean> {
    this.check();
    if (!job.id) throw new Error('AGY native task identity is unresolved.');
    const rows = await this.run({ tool: 'manage_task', input: { Action: 'list' } });
    if (!Array.isArray(rows)) throw new Error('AGY native inventory receipt is missing.');
    const row = rows.find(row => row.taskId === job.id);
    if (row && (row.toolName !== 'schedule' || row.description !== job.description
      || (job.input.rule.kind === 'cron' ? row.isDaemon !== true : row.isDaemon === true))) {
      this.fence('AGY native task ownership changed.'); throw new Error(this.failure);
    }
    if (row) job.retiredBeforeWake = false;
    job.absent = !row;
    return !!row;
  }

  /** Called before a genuine foreground prompt; ACP text is not schedule output. */
  beginForeground(): void { this.check(); if (this.operation || this.foreground || this.boundary !== undefined) throw new Error('AGY host is busy.'); this.foregroundResult = undefined; this.foreground = true; this.executionForeground = true; }
  endForeground(): { success: boolean; output: string } | undefined { this.foreground = false; return this.foregroundResult; }
  foregroundCancelled(): void {
    this.cancellationInProgress = this.cancellationCaptured;
    this.foreground = false;
    this.stopForTransition('AGY foreground cancelled: native notifications may remain queued. Further dispatch is blocked; no management prompt was sent.');
  }
  processClosed(confirmed: boolean): void {
    this.exited = confirmed;
    for (const job of this.jobs.values()) job.absent = false;
    this.stopForTransition(confirmed ? 'AGY native host exited; queued work remains unresolved; schedules are not restored.' : 'AGY native host retirement is unconfirmed.', confirmed);
  }
  private ownershipLost(reason: string): void {
    // sendCancel deliberately revokes ACP admission. Late authenticated receipts
    // still invalidate the proof if they contain unknown work; token revocation
    // alone must not defeat the already captured, deadline-bounded exit check.
    if (this.cancellationInProgress) this.stopForTransition(reason);
    else this.fence(reason);
  }
  fence(reason: string, exitConfirmed = false): void {
    this.cancellationInvalid = true;
    this.stopForTransition(reason, exitConfirmed);
  }
  private stopForTransition(reason: string, exitConfirmed = false): void {
    if (this.failure && !exitConfirmed) return;
    this.failure ??= reason;
    for (const job of this.jobs.values()) job.emit({ type: 'stopped', reason, exitConfirmed });
  }

  accept(event: string, payload: HookPayload, records: TranscriptRecord[]): HookDecision {
    try {
      if (payload.conversationId !== this.options.sessionId || payload.cwd !== this.options.cwd || payload.hookEventName !== event) {
        throw new Error('AGY hook session or working directory changed.');
      }
      if (event === 'SessionStart') this.seenSessionStart = true;
      // Observe revisions at every callback: background GENERIC receipts mutate
      // at earlier indices. Only previously delivered wake/output records freeze.
      for (const [index, signature] of this.terminals) {
        const row = records.find(row => row.step_index === index);
        if (!row || this.signature(row) !== signature) throw new Error('AGY transcript was compacted or rewrote delivered provenance.');
      }
      if (records.some(row => nativeWake(row) && ![...this.jobs.values()].some(job => job.id === nativeWake(row)!.sender))) this.backgroundUnknown = true;
      if (records.some(row => row.source === 'SYSTEM' && row.type === 'SYSTEM_MESSAGE' && /sender=/.test(row.content ?? '') && !nativeWake(row) && !nativeRestartNotice(row))) this.backgroundUnknown = true;
      this.observeReceipt(records);
      // Preserve native mutation evidence even after revocation, but do not use
      // it to authorize new work. Previously observed wakes retain their join.
      if (!this.options.isCurrent() || this.scope && !this.scope.current()) this.ownershipLost('AGY original host or operation ownership is no longer current.');
      if (event === 'PreToolUse') return this.tool(payload);
      if (event === 'PreInvocation') {
        if (this.failure || !this.options.isCurrent() || [...this.jobs.values()].some(job => !job.cancelled && !job.completed && !job.admit())) {
          this.ownershipLost('AGY schedule ownership/admission is no longer current.'); return { terminationBehavior: 'terminate' };
        }
        if (!Number.isSafeInteger(payload.initialNumSteps) || (payload.initialNumSteps as number) < 0
          || !Number.isSafeInteger(payload.invocationNum) || (payload.invocationNum as number) < 0) throw new Error('AGY invocation boundary is missing.');
        if (this.boundary === undefined) {
          if ((payload.initialNumSteps as number) <= this.lastTerminal) throw new Error('AGY transcript execution boundary regressed.');
          this.boundary = payload.initialNumSteps as number;
        }
        if (this.invocation && (!this.invocation.outputs || (payload.initialNumSteps as number) < this.invocation.start)) throw new Error('AGY invocation sequence is incomplete.');
        this.invocation = { number: payload.invocationNum as number, start: payload.initialNumSteps as number };
      }
      if (event === 'PostInvocation') {
        const invocation = this.invocation;
        if (!invocation || payload.invocationNum !== invocation.number || payload.initialNumSteps !== invocation.start) throw new Error('AGY invocation completion does not match its start.');
        invocation.outputs = new Map(records.filter(row => row.step_index >= invocation.start
          && row.source === 'MODEL' && row.type === 'PLANNER_RESPONSE' && row.status === 'DONE' && !row.tool_calls?.length)
          .map(row => [row.step_index, this.signature(row)]));
      }
      if (this.boundary !== undefined && !this.failure) this.observeWakes(records);
      if (event === 'Stop' && this.boundary !== undefined) this.complete(payload, records);
      return {};
    } catch {
      this.fence('AGY hook/transcript evidence is invalid or incomplete; further execution is blocked.');
      return event === 'PreInvocation' ? { terminationBehavior: 'terminate' }
        : event === 'PreToolUse' ? { decision: 'deny', reason: this.failure } : {};
    }
  }

  private tool(payload: HookPayload): HookDecision {
    const call = payload.toolCall as { id?: unknown; name?: unknown; args?: unknown } | undefined;
    const deny = { decision: 'deny' as const, reason: 'Use the exact authorized native schedule operation.' };
    if (this.failure || !this.options.isCurrent()) return deny;
    if (!call || typeof call.name !== 'string' || typeof call.id !== 'string' || call.id.length > 256
      || !Number.isSafeInteger(payload.stepIdx) || (payload.stepIdx as number) < 0) return deny;
    const op = this.operation;
    if (!['schedule', 'manage_task'].includes(call.name) && !/remote_cli_schedule_(create|list|cancel|purge|operation|capabilities)$/.test(call.name)) this.backgroundUnknown = true;
    if (!op) return ['schedule', 'manage_task'].includes(call.name) ? deny : { decision: 'allow' };
    if (this.scope?.inTurn && !['schedule', 'manage_task'].includes(call.name)) return { decision: 'allow' };
    if (this.scope && !this.scope.current()) return deny;
    if (op.callId || call.name !== op.action.tool || !isDeepStrictEqual(call.args, op.action.input)) return deny;
    if (op.job) {
      const now = Date.now();
      op.job.firstPossibleWake = op.action.input.DurationSeconds !== undefined
        ? now + Number(op.action.input.DurationSeconds) * 1000 : Math.floor(now / 60000) * 60000 + 60000;
    }
    op.callId = call.id; op.step = payload.stepIdx as number;
    return { decision: 'allow' };
  }

  private observeReceipt(records: TranscriptRecord[]): void {
    const op = this.operation;
    if (!op || op.step === undefined || op.receipt !== undefined) return;
    const record = records.find(row => row.step_index === op.step);
    if (op.action.tool === 'schedule') {
      const id = creationReceipt(record, this.options.sessionId, op.step);
      if (id) { op.receipt = id; op.job!.id = id; op.job!.description = creationDescription(record); }
    } else if (op.action.input.Action === 'list') op.receipt = inventoryReceipt(record);
    else if (deletionReceipt(record, op.action.input.TaskId as string)) op.receipt = true;
    if (op.receipt !== undefined) op.received?.();
  }

  private observeWakes(records: TranscriptRecord[]): void {
    for (const row of records.filter(row => row.step_index >= this.boundary!)) {
      const wake = nativeWake(row);
      if (!wake) continue;
      const job = [...this.jobs.values()].find(job => job.id === wake.sender);
      if (!job) { this.backgroundUnknown = true; continue; }
      if (!matchesWake(job.input.prompt, wake.prompt, job.input.rule.kind === 'cron')) throw new Error('AGY owned native wake changed.');
      if (this.observed.has(row.step_index)) {
        if (this.observed.get(row.step_index) !== this.signature(row)) throw new Error('AGY occurrence identity changed.');
        continue;
      }
      if (job.cancelled || job.completed || !this.options.isCurrent() || !job.admit()) throw new Error('AGY new occurrence is no longer admitted.');
      if (this.observed.size >= 4096) throw new Error('AGY occurrence evidence capacity reached.');
      const id = createHash('sha256').update(`${this.hostId}:${this.options.sessionId}:${job.id}:${row.step_index}`).digest('hex');
      this.observed.set(row.step_index, this.signature(row));
      this.pendingWakes.set(row.step_index, { job, row, id });
      job.emit({ type: 'started', occurrenceId: id });
    }
  }

  private complete(payload: HookPayload, records: TranscriptRecord[]): void {
    // Native executionNum resets between executions and is not invocationNum.
    // Require the matching Pre/PostInvocation and its completed output snapshot;
    // an old Stop must not settle a newly started invocation without that proof.
    const invocation = this.invocation;
    if (!invocation?.outputs) throw new Error('AGY Stop lacks a matching invocation completion.');
    const rows = records.filter(row => row.step_index >= this.boundary!);
    const wakes = [...this.pendingWakes.values()];
    for (const { row } of wakes) {
      const current = records.find(value => value.step_index === row.step_index);
      if (!current || this.signature(current) !== this.observed.get(row.step_index)) throw new Error('AGY active occurrence provenance changed.');
    }
    const outputs = rows.filter(row => row.source === 'MODEL' && row.type === 'PLANNER_RESPONSE' && row.status === 'DONE' && !row.tool_calls?.length);
    const latest = outputs.filter(row => row.step_index >= invocation.start);
    if (latest.length !== invocation.outputs.size || latest.some(row => invocation.outputs!.get(row.step_index) !== this.signature(row))
      || payload.terminationReason === 'NO_TOOL_CALL' && latest.length === 0) throw new Error('AGY Stop output is not confirmed by its invocation.');
    // Stop is the native batch terminal; fullyIdle is NOT future-job absence.
    const success = payload.terminationReason === 'NO_TOOL_CALL' && payload.error === '' && outputs.length > 0;
    const prefix = wakes.length && (this.executionForeground || this.executionManagement) ? 'Native combined result for scheduled reminders and foreground/management input:\n'
      : rows.filter(row => nativeWake(row)).length > 1 ? 'Native combined result for concurrently due tasks:\n' : '';
    let output = prefix + outputs.map(row => row.content ?? '').join('\n');
    if (Buffer.byteLength(output) > 256 * 1024) output = Buffer.from(output).subarray(0, 255 * 1024).toString('utf8') + '\n[Native output truncated]';
    if (this.executionForeground) this.foregroundResult = { success, output };
    if (this.terminals.size + wakes.length + outputs.length > 8192) throw new Error('AGY occurrence evidence capacity reached.');
    this.lastTerminal = Math.max(this.lastTerminal, ...rows.map(row => row.step_index));
    this.seenHookTerminal = true;
    this.boundary = undefined;
    this.invocation = undefined;
    this.executionForeground = false; this.executionManagement = false;
    this.pendingWakes.clear();
    for (const { job, row, id } of wakes) {
      this.observed.set(row.step_index, this.signature(row));
      this.terminals.set(row.step_index, this.signature(row));
      for (const result of outputs) this.terminals.set(result.step_index, this.signature(result));
      // Do not retroactively suppress an admitted result after cancellation.
      if (job.input.rule.kind === 'once') job.completed = true;
      job.emit({ type: 'completed', occurrenceId: id, success, output,
        ...(!success && { error: 'Native AGY batch did not complete successfully.' }) });
    }
  }

  private signature(row: TranscriptRecord): string { return createHash('sha256').update(JSON.stringify(row)).digest('hex'); }
  private check(): void {
    if (this.failure || this.exited || !this.options.isCurrent() || this.scope && !this.scope.current()) throw new NativeScheduleNotAdmittedError(this.failure ?? 'AGY host ownership is no longer current.');
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const work = this.tail.then(run); this.tail = work.catch(() => {}); return work;
  }
  private async run(action: NativeScheduleToolAction, job?: Job): Promise<Operation['receipt']> {
    this.check();
    if (this.operation || ((this.foreground || this.boundary !== undefined) && !this.scope?.inTurn)) throw new NativeScheduleNotAdmittedError('AGY original host is busy.');
    const op: Operation = { action, job }; this.operation = op;
    const inTurn = this.scope?.inTurn === true;
    if (!inTurn) this.executionManagement = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const receipt = new Promise<{ stopReason: string }>(resolve => { op.received = () => resolve({ stopReason: 'end_turn' }); });
      const result = await Promise.race([inTurn ? receipt : this.options.manage(action), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('AGY management receipt timed out.')), this.options.timeoutMs ?? 30_000);
      })]);
      this.check();
      if (result.stopReason !== 'end_turn' || op.receipt === undefined || this.failure || !inTurn && this.boundary !== undefined) throw new Error('AGY management terminal/receipt is unconfirmed.');
      return op.receipt;
    } catch (error) {
      this.mutationUncertain = true;
      this.fence('AGY management outcome is uncertain; no automatic retry or host replacement is allowed.'); throw error;
    } finally { if (timer) clearTimeout(timer); this.operation = undefined; }
  }
}
