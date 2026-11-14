import { randomUUID } from 'crypto';
import { nativeRule } from './rules';
import { NativeScheduleCleanupError, type NativeScheduleInput, type NativeScheduleHandle, type NativeScheduleEvent } from '../types';

export interface NativeScheduleAction { tool: 'CronCreate' | 'CronList' | 'CronDelete'; input: Record<string, unknown> }
/** Deliberately incompatible with NativeScheduleHandle.releaseForRestart. */
export interface ClaudeDefinitionRemovalReceipt { ownedDefinitionsAbsent: true; quiescence: 'unverified' }
type Frame = Record<string, any>;
type Scope = { id: string; current: () => boolean; inTurn: boolean; ended?: boolean; mutations: Set<string>; done: Promise<void> };
interface Job {
  id: string; marker: string; prompt: string; nativeId?: string; recurring: boolean; deadline?: number;
  current(): boolean; uncertain: boolean; retired: boolean; cancelled: boolean; emit(event: NativeScheduleEvent): void;
  definitionAbsent?: boolean;
  recovering?: boolean;
  onceDefinitionAlreadyAbsent?: true;
}
interface Pending {
  action: NativeScheduleAction; job: Job; scope?: Scope; toolId?: string;
  managementId?: string;
  preserveOccurrences?: true;
  resolve(text: string): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>;
}
interface Occurrence { id: string; job?: Job; terminal?: string }
interface NativeBatch { occurrences: Occurrence[]; result?: Frame }
export const SCHEDULE_HOOK = 'remote-cli-session-schedules';
export const SCHEDULE_HOOKS = {
  PreToolUse: [{ matcher: '.*', hookCallbackIds: [SCHEDULE_HOOK], timeout: 10 }],
  UserPromptSubmit: [{ hookCallbackIds: [SCHEDULE_HOOK], timeout: 10 }],
};
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const canonical = (value: any): string => JSON.stringify(value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);

/** One adapter per foreground process. It owns jobs, never the shared process or its history. */
export class ClaudeSessionSchedules {
  private jobs = new Map<string, Job>();
  private pending?: Pending;
  private scope?: Scope;
  private batch?: NativeBatch;
  private submitted?: Job;
  private capable = false;
  private managementTurn = false;
  private closed = false;
  private skipUnadmitted = false;
  private seen = new Set<string>();
  private resultIds = new Set<string>();
  private foregroundId?: string;
  private foregroundStarted = false;
  private definitionRemoval?: { lease: { isCurrent(): boolean }; operation?: Promise<ClaudeDefinitionRemovalReceipt> };
  foregroundDispatched(id: string, management = false): void {
    this.foregroundId = id; this.foregroundStarted = false; this.managementTurn = management;
    if (management && this.pending && !this.pending.scope?.inTurn) this.pending.managementId = id;
  }
  private authorized = new Map<string, { action: NativeScheduleAction; job: Job; preserveOccurrences?: true }>();
  constructor(private readonly options: {
    send(frame: Frame): void;
    manage(prompt: string, current: () => boolean): Promise<{ success: boolean }>;
    wake(): void;
    timezone?: string;
    timeoutMs?: number;
  }) {}

  get busy(): boolean { return !!this.batch || !!this.submitted; }
  get hasJobs(): boolean { return [...this.jobs.values()].some(job => !job.retired); }
  get hasPendingMutation(): boolean { return !!this.scope?.mutations.size || [...this.jobs.values()].some(job => !job.retired && job.uncertain); }

  /** Synchronous admission boundary, before any await or deletion. */
  beginRestart(): void { this.skipUnadmitted = true; }
  get admittedWork(): boolean { return !!this.submitted || !!this.batch?.occurrences.some(item => item.job); }

  /**
   * Preparation only: delete owned future definitions without revoking already
   * fired occurrence authority. The caller must fence ordinary input on this
   * exact host and retain the lease on failure. This is NOT a queue-drain proof,
   * restart receipt or permission to close stdin. The executor must separately
   * fence prompt admission, drain admitted work and confirm the exact host exit.
   */
  removeFutureDefinitionsForRestart(lease: { isCurrent(): boolean }): Promise<ClaudeDefinitionRemovalReceipt> {
    if (this.definitionRemoval?.lease === lease && this.definitionRemoval.operation) return this.definitionRemoval.operation;
    if (this.closed || !this.capable || !lease.isCurrent() || this.scope || this.pending || this.authorized.size || this.hasPendingMutation
      || this.definitionRemoval && this.definitionRemoval.lease !== lease) {
      return Promise.reject(new Error('Native definition removal ownership is unavailable.'));
    }
    const removal = this.definitionRemoval ??= { lease };
    const current = () => !this.closed && lease.isCurrent();
    const operation = Promise.resolve().then(async (): Promise<ClaudeDefinitionRemovalReceipt> => {
      if (!current()) throw new Error('Native definition removal lease expired.');
      for (const job of this.jobs.values()) {
        if (job.retired || job.cancelled) continue;
        if (!current() || !job.current()) throw new Error('Native definition removal lease expired.');
        await this.inToolOperation(`restart-${job.id}`, () => current() && job.current(), async () => {
          // Inventory may show a one-shot already removed by native firing.
          // Preserve its occurrence authority; absence is not completion.
          if (this.inventory(job, await this.request(job, { tool: 'CronList', input: {} }))) {
            try { await this.request(job, { tool: 'CronDelete', input: { id: job.nativeId } }, true); }
            catch (error) {
              if (!current()) throw error;
              // An error-after-commit still needs an authoritative list below.
            }
          } else if (!job.recurring) job.onceDefinitionAlreadyAbsent = true;
          if (!current() || !job.current()) throw new Error('Native definition removal lease expired.');
          if (this.inventory(job, await this.request(job, { tool: 'CronList', input: {} }))) {
            throw new Error('Native definition removal remains unconfirmed.');
          }
          job.definitionAbsent = true;
        }, false);
      }
      if (!current()) throw new Error('Native definition removal lease expired.');
      return { ownedDefinitionsAbsent: true, quiescence: 'unverified' };
    });
    removal.operation = operation;
    void operation.finally(() => { if (removal.operation === operation) removal.operation = undefined; }).catch(() => {});
    return operation;
  }
  async inToolOperation<T>(id: string, current: () => boolean, run: () => Promise<T>, inTurn = true): Promise<T> {
    if (this.scope) throw new Error('A native schedule operation is already active.');
    let finish!: () => void;
    const scope: Scope = { id, current, inTurn, mutations: new Set(), done: new Promise(resolve => { finish = resolve; }) }; this.scope = scope;
    try { return await run(); } finally { if (this.scope === scope) this.scope = undefined; finish(); }
  }
  /** Capture existing mutation ownership before revoking foreground authority. Never creates jobs. */
  captureCancellation(): (current: () => boolean) => Promise<void> {
    const scope = this.scope;
    const ids = new Set(scope?.mutations);
    for (const job of this.jobs.values()) if (job.uncertain) ids.add(job.id);
    return async current => {
      await scope?.done;
      for (const id of ids) {
        if (!current()) throw new Error('Cancellation cleanup lease expired.');
        const job = this.jobs.get(id);
        if (!job || job.retired || this.closed) continue;
        await this.inToolOperation(id, current, async () => {
          await this.cancel(job);
          if (this.inventory(job, await this.request(job, { tool: 'CronList', input: {} }))) {
            throw new Error('Cancelled native mutation still exists in inventory.');
          }
          if (!this.batch?.occurrences.some(item => item.job === job)) this.retire(job, 'Cancelled foreground mutation reconciled on the original native host.');
        }, false);
      }
    };
  }
  action(id: string): NativeScheduleAction | undefined {
    return this.pending?.scope?.inTurn && this.pending.scope.id === id && this.pending.scope.current() && !this.pending.toolId
      ? structuredClone(this.pending.action) : undefined;
  }

  async create(input: NativeScheduleInput, emit: Job['emit'], current: () => boolean = () => true,
    timezone = this.options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, restore = false): Promise<NativeScheduleHandle> {
    if (this.closed || this.definitionRemoval || this.jobs.has(input.id) || this.jobs.size >= 100 || [...this.jobs.values()].filter(j => !j.retired).length >= 5) {
      throw new Error('Native session schedule identity or capacity is unavailable.');
    }
    const rule = nativeRule(input.rule, Date.now());
    let cron = rule.cron;
    if (rule.at) {
      const formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
      const parts = formatter.formatToParts(rule.at);
      // During a daylight-saving rollback cron could select an earlier instance
      // of the same wall minute. Refuse that ambiguity rather than fire early.
      for (let minutes = 1; minutes <= 180; minutes++) {
        const earlier = rule.at - minutes * 60_000;
        if (earlier > Date.now() && formatter.format(earlier) === formatter.format(rule.at)) {
          throw new Error('This one-shot time is ambiguous in the native session timezone. Choose a time outside the clock rollback.');
        }
      }
      const part = (name: string) => Number(parts.find(p => p.type === name)!.value);
      cron = `${part('minute')} ${part('hour')} ${part('day')} ${part('month')} *`;
    } else if (new Intl.DateTimeFormat('en', { timeZone: rule.timezone }).resolvedOptions().timeZone
      !== new Intl.DateTimeFormat('en', { timeZone: timezone }).resolvedOptions().timeZone) {
      throw new Error(`Shared Claude schedules use the native session timezone (${timezone}); choose that timezone. The conversation timezone was not changed.`);
    }
    const stable = input.recovery ? JSON.parse(input.recovery.identity).marker : undefined;
    if (input.recovery && (typeof stable !== 'string' || !/^[a-f0-9-]{36}$/.test(stable))) throw new Error('Invalid durable native schedule marker.');
    const marker = `[remote-cli:${stable ?? randomUUID()}]`;
    const job: Job = { id: input.id, marker, prompt: `${marker}\n${input.prompt}`, recurring: rule.recurring,
      deadline: rule.at, current, recovering: restore, uncertain: false, retired: false, cancelled: false, emit };
    this.jobs.set(job.id, job);
    const handle = this.handle(job);
    try {
      if (restore) {
        // Hooks reject old wakes while inventory reconciles only this exact marker.
        if (this.inventory(job, await this.request(job, { tool: 'CronList', input: {} }))) {
          await this.request(job, { tool: 'CronDelete', input: { id: job.nativeId } }, true);
          if (this.inventory(job, await this.request(job, { tool: 'CronList', input: {} }))) throw new Error('Owned restored definition still exists.');
        }
        job.nativeId = undefined;
      }
      await this.request(job, { tool: 'CronCreate', input: { cron, prompt: job.prompt, recurring: rule.recurring, durable: false } });
      if (!job.nativeId) throw new Error('Native creation returned no verified job ID.');
      if (restore && !this.inventory(job, await this.request(job, { tool: 'CronList', input: {} }))) throw new Error('Restored native inventory is unconfirmed.');
      job.recovering = false;
      return handle;
    } catch (error) {
      if (job.uncertain || job.nativeId) throw new NativeScheduleCleanupError('Native creation is unconfirmed. Use cancellation to reconcile this owned job; do not recreate it.', handle);
      job.retired = true;
      throw error;
    }
  }

  private handle(job: Job): NativeScheduleHandle {
    return {
      cancellationKeepsRunning: true,
      get onceDefinitionAlreadyAbsent() { return job.onceDefinitionAlreadyAbsent; },
      get nativeId() { return job.nativeId ?? `unconfirmed-${job.id}`; },
      list: async () => {
        if (job.retired || this.closed || job.cancelled) return false;
        if (this.definitionRemoval) throw new Error('Native restart preparation retains occurrence ownership; inventory absence is not completion.');
        const text = await this.request(job, { tool: 'CronList', input: {} });
        const exists = this.inventory(job, text);
        if (!exists) { job.uncertain = false; job.cancelled = true; }
        return exists;
      },
      cancel: () => this.cancel(job),
      stop: async () => {
        if (this.scope?.inTurn && job.uncertain) throw new Error('Native creation cleanup requires an explicit cancellation operation.');
        if (!job.retired && !this.closed) await this.cancel(job);
        // An executing occurrence keeps its event listener until its own terminal frame.
        if (!this.batch?.occurrences.some(occurrence => occurrence.job === job)) this.retire(job, 'Native job retired; shared conversation remains running.');
      },
    };
  }
  private async cancel(job: Job): Promise<void> {
    if (job.retired || this.closed || job.cancelled) return;
    if (job.definitionAbsent) { job.cancelled = true; return; }
    if (!job.nativeId) {
      const found = this.inventory(job, await this.request(job, { tool: 'CronList', input: {} }));
      if (!found) { job.uncertain = false; job.cancelled = true; return; }
    }
    try { await this.request(job, { tool: 'CronDelete', input: { id: job.nativeId } }); }
    catch (error) {
      // A one-shot may have fired, or native expiry may have removed the job.
      // Never infer deletion from an error: reconcile through a verified list.
      if (this.closed || !this.inventory(job, await this.request(job, { tool: 'CronList', input: {} }))) {
        job.uncertain = false; job.cancelled = true; return;
      }
      throw error;
    }
    job.uncertain = false; job.cancelled = true;
  }
  private inventory(job: Job, text: string): boolean {
    if (text === 'No scheduled jobs.') return false;
    const lines = text.split('\n');
    if (lines.length > 100 || lines.some(line => !/^[A-Za-z0-9_-]+ — /.test(line))) throw new Error('Unverified native inventory.');
    if ((this.skipUnadmitted || job.recovering) && lines.some(line => ![...this.jobs.values()].some(candidate =>
      !candidate.retired && line.includes(candidate.marker) && line.includes('[session-only]')
      && (!candidate.nativeId || line.startsWith(`${candidate.nativeId} — `))))) {
      throw new Error('Unmanaged native inventory prevents orderly recovery.');
    }
    const owned = lines.filter(line => line.includes(job.marker));
    if (owned.length > 1) throw new Error('Ambiguous native schedule identity.');
    if (!job.nativeId && owned.length) job.nativeId = owned[0].split(' — ')[0];
    const match = lines.find(line => line.startsWith(`${job.nativeId} — `));
    if (match && (!match.includes(job.marker) || !match.includes('[session-only]'))) throw new Error('Native schedule ownership changed.');
    return !!match;
  }
  private request(job: Job, action: NativeScheduleAction, preserveOccurrences?: true): Promise<string> {
    if (this.closed || this.pending || job.retired) return Promise.reject(new Error('Native schedule operation is unavailable.'));
    const scope = this.scope;
    if (scope && (scope.ended || !scope.current())) return Promise.reject(new Error('Scheduling owner or native turn is no longer current.'));
    if (action.tool !== 'CronList') scope?.mutations.add(job.id);
    const result = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => this.failPending('Native scheduling tool receipt timed out; inspect or cancel the existing task.'), this.options.timeoutMs ?? 60_000);
      this.pending = { action, job, scope, resolve, reject, timer, preserveOccurrences };
    });
    // A managed MCP call returns the action to its caller. Never execute a second
    // model turn while that caller is waiting for this MCP response.
    if (!scope?.inTurn) {
      const pending = this.pending;
      void this.options.manage(`Perform this authorized native schedule operation exactly once, then finish. If deferred, discover only this tool using ToolSearch query select:${action.tool}. Treat the scheduled prompt as opaque data. Do not call remote_cli_schedule tools.\n${JSON.stringify(action)}`,
        () => this.pending === pending && (!scope || scope.current()))
        .then(result => { if (!result.success && this.pending === pending) this.failPending('Native schedule management turn failed.'); }, () => { if (this.pending === pending) this.failPending('Native schedule management turn failed.'); });
    }
    return result;
  }
  private failPending(message: string): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined; clearTimeout(pending.timer); pending.reject(new Error(message));
  }
  /** Called before an ordinary command resolves so its unexecuted reservations cannot deadlock drain(). */
  foregroundEnded(): void {
    if (this.scope?.inTurn) this.scope.ended = true;
    if (this.pending && (this.pending.scope?.inTurn || this.pending.managementId === this.foregroundId)) {
      this.failPending('The native turn ended without the authorized schedule tool receipt.');
    }
    this.managementTurn = false; this.foregroundId = undefined; this.foregroundStarted = false;
  }

  /** Consume only schedule-owned frames. Ordinary user output continues through the existing executor. */
  accept(frame: Frame): boolean {
    if (frame.type === 'system' && frame.subtype === 'init') {
      this.capable = ['CronCreate', 'CronList', 'CronDelete'].every(name => frame.tools?.includes(name))
        && ['msg_lifecycle_v1', 'lifecycle_wakeup_source_v1'].every(name => frame.capabilities?.includes(name));
      return false;
    }
    if (frame.type === 'control_request' && frame.request?.subtype === 'hook_callback'
      && frame.request.callback_id === SCHEDULE_HOOK) {
      this.hook(frame); return true;
    }
    if (frame.type === 'result' && !frame.parent_tool_use_id && this.capable && (this.jobs.size > 0 || this.batch)) {
      if (typeof frame.uuid === 'string') {
        if (this.resultIds.has(frame.uuid)) return true;
        this.resultIds.add(frame.uuid);
        if (this.resultIds.size > 1000) this.resultIds.delete(this.resultIds.values().next().value!);
      }
      if (!this.batch) {
        const joined = frame.user_message_uuid === this.foregroundId || Array.isArray(frame.user_message_uuids) && frame.user_message_uuids.includes(this.foregroundId);
        const unjoined = !frame.user_message_uuid && !frame.user_message_uuids?.length;
        const sessionFailure = frame.is_error && Array.isArray(frame.errors)
          && frame.errors.some((error: unknown) => typeof error === 'string' && /No conversation found|Session not found/.test(error));
        if (!this.foregroundId || !joined && !(unjoined && (this.foregroundStarted || sessionFailure))) return true;
      }
    }
    if (frame.type === 'command_lifecycle') {
      if (frame.state === 'started') this.foregroundStarted = frame.command_uuid === this.foregroundId;
      if (frame.state === 'started' && frame.wakeup_source === 'schedule_wakeup') {
        if (typeof frame.command_uuid !== 'string' || !idPattern.test(frame.command_uuid) || this.seen.has(frame.command_uuid)) return true;
        const batch = this.batch ??= { occurrences: [] };
        if (batch.occurrences.some(occurrence => occurrence.id === frame.command_uuid)) return true;
        // Native headless mode can batch several same-priority cron prompts.
        // startBatch emits their lifecycle IDs in prompt concatenation order.
        if (batch.occurrences.length >= 100) { this.failPending('Native schedule batch limit reached.'); return true; }
        batch.occurrences.push({ id: frame.command_uuid });
        if (this.submitted) { this.bind([this.submitted]); this.submitted = undefined; }
        return true;
      }
      const occurrence = this.batch?.occurrences.find(item => item.id === frame.command_uuid);
      if (occurrence && ['completed', 'cancelled', 'discarded', 'refused'].includes(frame.state)) {
        // Keep failed terminals sticky even if a conflicting late receipt arrives.
        if (!occurrence.terminal || frame.state !== 'completed') occurrence.terminal = frame.state;
        this.completeOccurrence(); return true;
      }
      if (this.submitted && !this.batch && ['cancelled', 'discarded', 'refused'].includes(frame.state)) {
        this.submitted = undefined; this.options.wake();
      }
      return false;
    }
    if (this.batch) {
      if (frame.type === 'result' && !frame.parent_tool_use_id) {
        if (frame.user_message_uuid || frame.user_message_uuids?.length) {
          // A scheduled turn must never complete an unrelated foreground request.
          this.batch.result = { is_error: true, result: '', terminal_reason: 'ambiguous' };
        } else this.batch.result = frame;
        this.completeOccurrence(); return true;
      }
      if (['assistant', 'user', 'stream_event', 'thinking', 'message', 'redacted_thinking', 'result'].includes(frame.type)) return true;
    }
    if (frame.type === 'assistant' && !frame.parent_tool_use_id && Array.isArray(frame.message?.content)) {
      for (const block of frame.message.content) {
        const pending = this.pending;
        if (pending?.action.tool === 'CronCreate' && block.type === 'tool_use' && block.name === 'CronCreate'
          && canonical(block.input) === canonical(pending.action.input)) {
          // Retain reconciliation ownership even if a native policy change
          // unexpectedly suppresses the callback; never accept an unguarded receipt.
          pending.job.uncertain = true;
        }
      }
    }
    if (frame.type === 'user' && !frame.parent_tool_use_id) {
      for (const block of frame.message?.content ?? []) {
        if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const auth = this.authorized.get(block.tool_use_id);
        if (!auth) continue;
        this.authorized.delete(block.tool_use_id);
        const pending = this.pending?.toolId === block.tool_use_id ? this.pending : undefined;
        try {
          if (block.is_error || typeof block.content !== 'string') throw new Error('Native schedule tool failed or returned an invalid receipt.');
          this.receipt(auth.job, auth.action, block.content, auth.preserveOccurrences);
          if (pending) { this.pending = undefined; clearTimeout(pending.timer); pending.resolve(block.content); }
        } catch (error) { if (pending) this.failPending(error instanceof Error ? error.message : 'Invalid native receipt.'); }
      }
    }
    return false;
  }
  private receipt(job: Job, action: NativeScheduleAction, text: string, preserveOccurrences?: true): void {
    if (action.tool === 'CronCreate') {
      const match = /^Scheduled (one-shot task|recurring job) ([A-Za-z0-9_-]{1,128}) \([^\r\n]+\)\. Next run: [^\r\n]+\. Session-only \(not written to disk, dies when Claude exits\)\./.exec(text);
      if (!match || (match[1] === 'recurring job') !== job.recurring || [...this.jobs.values()].some(j => j !== job && j.nativeId === match[2])) throw new Error('Unverified native creation receipt.');
      job.nativeId = match[2]; job.uncertain = false;
    } else if (action.tool === 'CronDelete') {
      if (text !== `Cancelled job ${job.nativeId}.`) throw new Error('Unverified native cancellation receipt.');
      if (!preserveOccurrences) job.cancelled = true;
    } else this.inventory(job, text);
  }
  private hook(frame: Frame): void {
    const input = frame.request.input;
    let response: Frame = {};
    if (this.skipUnadmitted && input?.hook_event_name === 'UserPromptSubmit'
      && !this.managementTurn && !this.batch && input.source !== 'schedule_wakeup') {
      this.options.send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id,
        response: { decision: 'block', reason: 'New autonomous admission is fenced during restart.' } } });
      return;
    }
    if (input?.hook_event_name === 'PreToolUse') {
      const discovery = input.tool_name === 'ToolSearch' && this.pending
        && input.tool_input?.query === `select:${this.pending.action.tool}`
        && Object.keys(input.tool_input).every(key => key === 'query' || key === 'max_results')
        && (input.tool_input.max_results === undefined || Number.isInteger(input.tool_input.max_results)
          && input.tool_input.max_results >= 1 && input.tool_input.max_results <= 5);
      if ((!['CronCreate', 'CronList', 'CronDelete'].includes(input.tool_name) && !this.managementTurn)
        || discovery && !this.closed && (!this.pending?.scope || this.pending.scope.current())) {
        this.options.send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } });
        return;
      }
      const p = this.pending;
      const toolId = frame.request.tool_use_id ?? input.tool_use_id;
      const allow = !!p && (p.scope?.inTurn || this.managementTurn && p.managementId === this.foregroundId)
        && this.capable && !this.closed && !p.toolId && !this.busy
        && input.agent_id === undefined && !frame.parent_tool_use_id
        && (!p.scope || !p.scope.ended && p.scope.current()) && (p.action.tool !== 'CronCreate' || p.job.current()) && (p.action.tool !== 'CronCreate' || !p.job.deadline || p.job.deadline > Date.now())
        && this.authorized.size < 100 && typeof toolId === 'string' && idPattern.test(toolId) && input.tool_name === p.action.tool
        && canonical(input.tool_input) === canonical(p.action.input);
      if (allow) {
        p.toolId = toolId;
        if (p.action.tool === 'CronCreate') p.job.uncertain = true;
        this.authorized.set(toolId, { action: p.action, job: p.job, preserveOccurrences: p.preserveOccurrences });
      } else response = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'No matching current managed schedule authorization.' } };
    } else if (input?.hook_event_name === 'UserPromptSubmit'
      && (input.source === 'schedule_wakeup' || input.source === undefined && this.batch)) {
      // 2.1.311's compiled hook producer can omit source. The preceding native
      // schedule lifecycle and exact complete prompt are both required then.
      const owned = this.matchPrompts(input.prompt);
      const expected = this.batch?.occurrences.length ?? 1;
      if (this.skipUnadmitted) {
        if (owned && owned.length === expected) for (const [index, job] of owned.entries()) {
          const id = this.batch?.occurrences[index]?.id;
          if (id) job.emit({ type: 'skipped', occurrenceId: id, reason: 'Pending occurrence skipped during orderly restart before prompt admission.' });
        }
        response = { decision: 'block', reason: 'Pending scheduled occurrence skipped during orderly restart.' };
        this.options.send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response } });
        return;
      }
      if (this.closed || this.submitted || this.batch?.occurrences.some(item => item.job)
        || !owned || owned.length !== expected) response = { decision: 'block', reason: 'Unknown or retired managed schedule occurrence.' };
      else if (this.batch) this.bind(owned);
      else this.submitted = owned[0];
    }
    this.options.send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response } });
  }
  private matchPrompts(prompt: unknown): Job[] | undefined {
    if (typeof prompt !== 'string') return;
    const jobs: Job[] = [];
    let remaining = prompt;
    while (remaining && jobs.length < 100) {
      const job = [...this.jobs.values()].find(item => !item.retired && !item.cancelled && !item.recovering && item.current() && !!item.nativeId
        && (remaining === item.prompt || remaining.startsWith(item.prompt + '\n')));
      if (!job) return;
      jobs.push(job); remaining = remaining.slice(job.prompt.length);
      if (remaining) remaining = remaining.slice(1);
    }
    return !remaining && jobs.length ? jobs : undefined;
  }
  private bind(jobs: Job[]): void {
    for (const [index, job] of jobs.entries()) {
      const occurrence = this.batch!.occurrences[index]; occurrence.job = job;
      job.emit({ type: 'started', occurrenceId: occurrence.id });
    }
  }
  private completeOccurrence(): void {
    const batch = this.batch;
    if (!batch?.result || !batch.occurrences.every(occurrence => occurrence.terminal)) return;
    this.batch = undefined;
    for (const occurrence of batch.occurrences) {
      this.seen.add(occurrence.id);
      if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value!);
      if (!occurrence.job) continue;
      const job = occurrence.job;
      const success = occurrence.terminal === 'completed'
        && batch.result.is_error === false && batch.result.terminal_reason === 'completed';
      // A native batch has one honest combined answer, not invented per-job text.
      const prefix = batch.occurrences.length > 1 ? 'Native combined result for concurrently due tasks:\n' : '';
      job.emit({ type: 'completed', occurrenceId: occurrence.id, success,
        ...(success ? { output: (prefix + String(batch.result.result ?? '')).slice(0, 64 * 1024) } : { error: 'Native scheduled turn failed or was interrupted.' }) });
      if (!job.recurring || job.cancelled) this.retire(job, 'Native schedule finished; shared conversation remains running.');
    }
    this.options.wake();
  }
  private retire(job: Job, reason: string): void {
    if (job.retired) return;
    job.retired = true; job.emit({ type: 'stopped', reason, exitConfirmed: true });
  }
  /** Only a confirmed process close loses all session-only jobs. */
  processClosed(released = false): void {
    this.closed = true; this.failPending('Native conversation process exited. Session-only schedules were lost.');
    for (const occurrence of this.batch?.occurrences ?? []) occurrence.job?.emit({ type: 'completed', occurrenceId: occurrence.id,
      success: false, error: 'Native conversation process exited during this occurrence.' });
    this.batch = undefined; this.submitted = undefined; this.authorized.clear();
    if (!released) for (const job of this.jobs.values()) this.retire(job, 'Native conversation process exited.');
  }
}
