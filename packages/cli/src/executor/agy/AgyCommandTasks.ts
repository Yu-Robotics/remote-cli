import { createHash, randomUUID } from 'crypto';
import path from 'path';
import { isDeepStrictEqual } from 'util';
import { pathToFileURL } from 'url';
import { creationReceipt, deletionReceipt, nativeWake, NOTIFICATION_PREFIX, receiptText, type TranscriptRecord } from '../../scheduling/agy/transcript';
import type { HookDecision, HookPayload } from '../../scheduling/agy/AgySessionSchedules';

export interface AgyCommandCheckpoint { lastStep: number; digest: string; idleDenialHistory?: string }

const creationPrefix = 'Tool is running as a background task with task id: ';
const idleDenialMessage = 'AGY command notifications cannot start another tool';
const identity = (records: TranscriptRecord | TranscriptRecord[]) => createHash('sha256').update(JSON.stringify(records)).digest('hex');

/** Only a foreground tool hook can introduce an owned command. Its RUNNING
 * creation row can remain in every transcript even after a separate completion. */
export class AgyCommandTasks {
  private readonly calls = new Map<number, { id: string; args: Record<string, unknown>; cwd: string; postSeen: boolean; scheduled: boolean }>();
  private readonly receipts = new Map<number, string>();
  private readonly outstanding = new Set<number>();
  private readonly posted = new Set<number>();
  // Historical checkpoints restore receipt integrity only. This map is populated
  // exclusively by creation hooks/receipts observed by this runtime instance.
  private readonly owned = new Map<number, { cwd: string; lastStatus?: 'RUNNING' | 'DONE'; exitCode?: number }>();
  private status?: { step: number; target: number; callId: string; posted: boolean; completedAtAdmission: boolean };
  private statusHistory?: { through: number; digest: string };
  private kill?: { step: number; target: number; taskId: string; callId: string; cwd: string; posted: boolean; exitObserved: boolean };
  private provisional?: Set<number>;
  private idleInvocation = false;
  private readonly notificationWakes = new Map<number, number>(); // command step -> wake step
  private restored = false;
  private foregroundStart?: number;
  private lastStep = -1;
  private candidate?: { start: number; wakeStep: number; cwd: string; history: string };
  private denial?: { reason: string; terminated: boolean };
  // Historical denials continue to exclude settings changes and controlled reconnect.
  liveDenial = false;
  idleDecision?: HookDecision;

  constructor(private readonly session: string, private readonly home: string,
    private readonly checkpoint?: AgyCommandCheckpoint) {}

  get pending(): boolean { return !!this.denial || !!this.kill || !!this.status || this.outstanding.size > 0 || this.idleInvocation || this.notificationWakes.size > 0; }
  get outstandingCount(): number { return this.outstanding.size; }
  get observedBackgroundCommand(): boolean { return this.owned.size > 0; }
  /** Evidence from this live worker only. Never reconstruct management authority on load. */
  witnessedReceipt(row: TranscriptRecord): boolean { return this.receipts.get(row.step_index) === identity(row); }
  witnessedForegroundCommand(step: number, args: unknown): boolean {
    const call = this.calls.get(step);
    return !!call && !call.scheduled && !call.postSeen && isDeepStrictEqual(call.args, args);
  }
  retiredCommandExit(row: TranscriptRecord, candidates = this.outstanding): number | undefined {
    const wake = nativeWake(row);
    if (wake) return this.commandCompletion(row, wake, candidates)?.step;
    const target = Number(/ sender=[^\s]+\/task-(\d+) priority=MESSAGE_PRIORITY_LOW /.exec(row.content ?? '')?.[1]);
    if (candidates.has(target) && row.step_index > target && this.cancellationNotice(row, target, this.session + '/task-' + target)) return target;
  }
  get pendingStatusStep(): number | undefined { return this.status?.step; }

  get ordinaryCommandsPending(): boolean {
    return !this.idleInvocation && !this.notificationWakes.size && this.outstanding.size > 0
      && [...this.outstanding].every(step => this.calls.get(step)?.scheduled === false);
  }

  private ordinaryCommandTarget(step: number, action: 'status' | 'kill', args: unknown): number | undefined {
    if (this.kill || this.status || this.foregroundStart === undefined || step <= this.lastStep || step <= this.foregroundStart) return;
    const id = (args as { TaskId?: unknown } | undefined)?.TaskId;
    if (typeof id !== 'string') return;
    const target = Number(/\/task-(\d+)$/.exec(id)?.[1]);
    if (this.owned.has(target) && isDeepStrictEqual(args, { Action: action, TaskId: this.session + '/task-' + target })) return target;
  }

  admitStatus(step: number, callId: string, args: unknown, rows: TranscriptRecord[]): boolean {
    const target = this.ordinaryCommandTarget(step, 'status', args);
    if (target === undefined) return false;
    if (rows.at(-1)?.step_index !== step - 1) return false;
    const owned = this.owned.get(target)!;
    this.status = { step, target, callId, posted: false, completedAtAdmission: owned.lastStatus === 'DONE' || owned.exitCode !== undefined };
    this.statusHistory = { through: step - 1, digest: identity(rows) };
    return true;
  }

  private observeStatus(event: string, payload: HookPayload, rows: TranscriptRecord[], foreground: boolean, commandPost: boolean): void {
    const history = this.statusHistory;
    if (history && history.digest !== identity(rows.filter(row => row.step_index <= history.through))) {
      throw new Error('AGY status history changed.');
    }
    const status = this.status;
    if (!status) return;
    // The shell may finish while its status lookup is in flight. Its own
    // authenticated post cannot acknowledge the independent manage_task call.
    if (commandPost && foreground && payload.stepIdx !== status.step) return;
    const id = this.session + '/task-' + status.target;
    const call = payload.toolCall as { id?: string; name?: string; args?: unknown } | undefined;
    if (!foreground || event === 'PostToolUse' && (status.posted || payload.stepIdx !== status.step
      || payload.cwd !== this.owned.get(status.target)?.cwd || payload.error || call?.id !== status.callId
      || call.name !== 'manage_task' || !isDeepStrictEqual(call.args, { Action: 'status', TaskId: id }))) {
      throw new Error('Unverified AGY status callback.');
    }
    if (event === 'PostToolUse') { status.posted = true; return; }
    if (event !== 'PostInvocation' || !status.posted) throw new Error('AGY status callback is missing.');
    const row = rows.find(r => r.step_index === status.step);
    const text = receiptText(row);
    const header = 'Task: ' + id + '\nStatus: ';
    const state = text?.startsWith(header + 'DONE\n') ? 'DONE' : 'RUNNING';
    const prefix = header + state + '\nLog: ' + this.log(status.target);
    const suffix = text?.slice(prefix.length);
    if (row?.status !== 'DONE' || row.tool_calls?.length || !text?.startsWith(prefix)
      || !(suffix === '' || suffix === '\n' || suffix?.startsWith('\nLog output:\n'))
      || status.completedAtAdmission && state !== 'DONE'
      || rows.some(r => r.step_index > status.step && !nativeWake(r))) throw new Error('Unverified AGY status receipt.');
    // A successful read is not an exit wake or a notification terminal.
    this.owned.get(status.target)!.lastStatus = state;
    this.statusHistory = { through: status.step, digest: identity(rows.filter(r => r.step_index <= status.step)) };
    this.status = undefined;
  }

  admitKill(step: number, callId: string, args: unknown, planner: TranscriptRecord): boolean {
    const target = this.ordinaryCommandTarget(step, 'kill', args);
    if (target === undefined || !this.ordinaryCommandsPending || !this.outstanding.has(target)) return false;
    this.kill = { step, target, taskId: this.session + '/task-' + target, callId, cwd: this.calls.get(target)!.cwd, posted: false, exitObserved: false };
    this.receipts.set(planner.step_index, identity(planner));
    return true;
  }

  observeTool(step: number, name: string, id: string, args: Record<string, unknown>, cwd: string, scheduled = false): void {
    const prior = this.calls.get(step);
    if (prior && (name !== 'run_command' || prior.id !== id || prior.cwd !== cwd || !isDeepStrictEqual(prior.args, args))) {
      throw new Error('AGY command hook identity changed.');
    }
    if (name === 'run_command' && this.foregroundStart !== undefined && step >= this.foregroundStart
      && !prior && !this.receipts.has(step)) {
      if (!id || id.length > 256 || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid AGY command identity.');
      this.calls.set(step, { id, args: structuredClone(args), cwd, postSeen: false, scheduled });
    }
  }

  endForeground(): void {
    for (const [step, call] of this.calls) {
      if (!this.outstanding.has(step) && (call.postSeen || !this.owned.has(step))) this.calls.delete(step);
    }
    this.foregroundStart = undefined;
  }

  private log(step: number): string {
    return pathToFileURL(path.join(this.home, '.gemini', 'antigravity-cli', 'brain', this.session,
      '.system_generated', 'tasks', `task-${step}.log`)).href;
  }

  private commandCompletion(row: TranscriptRecord, wake: NonNullable<ReturnType<typeof nativeWake>>, candidates = this.outstanding) {
    const taskStep = Number(/\/task-(\d+)$/.exec(wake.sender)?.[1]);
    const id = `${this.session}/task-${taskStep}`;
    const heading = `Task id "${id}" finished with result:\nCommand exited with code `;
    if (!candidates.has(taskStep) || row.step_index <= taskStep || wake.sender !== id || row.tool_calls?.length || !wake.prompt.startsWith(heading)
      || !/^\d+\.\n\n(?:Command output:\n[\s\S]*|No output from the command\.)\nLog: [^\r\n]+$/.test(wake.prompt.slice(heading.length))
      || !wake.prompt.endsWith('\nLog: ' + this.log(taskStep))) return;
    return { step: taskStep, exitCode: Number.parseInt(wake.prompt.slice(heading.length), 10) };
  }

  private cancellationNotice(row: TranscriptRecord, target: number, id: string): boolean {
    if (row.source !== 'SYSTEM' || row.type !== 'SYSTEM_MESSAGE' || row.status !== 'DONE' || row.tool_calls?.length
      || !row.content?.startsWith(NOTIFICATION_PREFIX)) return false;
    const message = row.content.slice(NOTIFICATION_PREFIX.length);
    const stamp = /^\[Message\] timestamp=(\S+) /.exec(message);
    return !!stamp && Number.isFinite(Date.parse(stamp[1]))
      && message.slice(stamp[0].length) === 'sender=' + id + ' priority=MESSAGE_PRIORITY_LOW content=Task id "' + id
        + '" was canceled with result:\nTool execution was canceled\nLog: ' + this.log(target) + '\n</SYSTEM_MESSAGE>';
  }

  private digest(): string {
    return createHash('sha256').update(JSON.stringify([...this.receipts].sort(([a], [b]) => a - b))).digest('hex');
  }
  snapshot(records: TranscriptRecord[]): AgyCommandCheckpoint | undefined {
    if (!this.pending && this.receipts.size) return { lastStep: Math.max(...this.receipts.keys()), digest: this.digest(),
      ...(this.liveDenial && { idleDenialHistory: identity(records) }) };
    return undefined;
  }

  /** Reconstruct immutable row hashes only. No historical task is added to owned. */
  restoreHistory(rows: TranscriptRecord[]): TranscriptRecord[] {
    const checkpoint = this.checkpoint!;
    if (checkpoint.idleDenialHistory && identity(rows) !== checkpoint.idleDenialHistory) throw new Error('AGY idle denial history changed.');
    let foundDenial = false;
    for (const [index, row] of rows.entries()) {
      if (row.step_index > checkpoint.lastStep) continue;
      if (receiptText(row)?.startsWith(creationPrefix) || nativeWake(row)) this.receipts.set(row.step_index, identity(row));
      else if (checkpoint.idleDenialHistory && row.status === 'ERROR'
        && receiptText(row)?.startsWith('Encountered error in step execution: tool call denied by pre-tool hook: ' + idleDenialMessage + ' (')) {
        const planner = rows[index - 1];
        if (planner?.step_index !== row.step_index - 1) throw new Error('AGY idle denial planner is missing.');
        this.receipts.set(planner.step_index, identity(planner));
        this.receipts.set(row.step_index, identity(row));
        foundDenial = true;
      }
    }
    if (this.digest() !== checkpoint.digest || !!checkpoint.idleDenialHistory !== foundDenial) throw new Error('AGY command history changed during load.');
    this.liveDenial = foundDenial;
    this.restored = true;
    return rows.filter(row => !this.receipts.has(row.step_index));
  }

  observe(event: string, payload: HookPayload, rows: TranscriptRecord[], foreground: boolean, allowIdleDenial = false, ordinaryForeground = false): TranscriptRecord[] {
    this.idleDecision = undefined;
    if (payload.conversationId !== this.session || payload.hookEventName !== event) throw new Error('AGY command hook identity changed.');
    if (foreground && event === 'PreInvocation' && Number.isSafeInteger(payload.initialNumSteps)) {
      this.foregroundStart = payload.initialNumSteps as number;
    }
    if (this.checkpoint && !this.restored) this.restoreHistory(rows);
    // Native can deliver PostToolUse after the foreground Stop and before the
    // command's completion row. Authenticate against the original admitted call.
    const hookStep = payload.stepIdx as number;
    const prior = this.calls.get(hookStep);
    const tool = payload.toolCall as { id?: unknown; name?: unknown; args?: unknown } | undefined;
    const commandPost = event === 'PostToolUse' && !!prior && !prior.postSeen && payload.hookEventName === event
      && payload.conversationId === this.session && payload.cwd === prior.cwd && tool?.name === 'run_command'
      && tool.id === prior.id && isDeepStrictEqual(tool.args, prior.args);
    const delayedPost = !foreground && commandPost && this.owned.has(hookStep);
    this.observeStatus(event, payload, rows, foreground, commandPost);
    const kill = this.kill;
    if (kill && event === 'PostToolUse' && hookStep === kill.step) {
      if (!foreground || kill.posted || payload.error || payload.hookEventName !== event || payload.conversationId !== this.session
        || payload.cwd !== kill.cwd || tool?.id !== kill.callId || tool.name !== 'manage_task'
        || !isDeepStrictEqual(tool.args, { Action: 'kill', TaskId: kill.taskId })) throw new Error('Unverified AGY kill callback.');
      kill.posted = true;
    }
    const other: TranscriptRecord[] = [];
    let seen = 0;
    for (const row of rows) {
      const step = row.step_index;
      if (this.receipts.has(step)) {
        if (this.receipts.get(step) !== identity(row)) throw new Error('AGY command evidence changed.');
      } else if (kill && step === kill.step) {
        if (row.source === 'MODEL' && row.type === 'GENERIC' && row.status === 'RUNNING') {
          other.push(row);
          continue;
        }
        if (!deletionReceipt(row, kill.taskId) || row.tool_calls?.length) throw new Error('Unverified AGY cancellation receipt.');
        this.receipts.set(step, identity(row));
      } else if (kill && foreground && !kill.exitObserved && step > kill.step && this.receipts.has(kill.step)
        && this.cancellationNotice(row, kill.target, kill.taskId)) {
        kill.exitObserved = true;
        this.receipts.set(step, identity(row));
      } else if (receiptText(row)?.startsWith(creationPrefix)) {
        const text = receiptText(row)!;
        const id = `${this.session}/task-${step}`;
        const logLine = '\nTask logs are available at: ' + this.log(step);
        const marker = text.lastIndexOf('\nTask logs are available at: ');
        // An authenticated foreground transcript can include another tool's native
        // background receipt. It supplies no command ownership or timer authority.
        if (ordinaryForeground && foreground && !this.calls.has(step) && creationReceipt(row, this.session, step)) {
          other.push(row);
          continue;
        }
        if (!foreground || !this.calls.has(step) || row.status !== 'RUNNING' || row.tool_calls?.length
          || !text.startsWith(creationPrefix + id + '\nTask Description: ') || marker < 0
          || !text.startsWith(logLine, marker)
          || !['', '\n'].includes(text.charAt(marker + logLine.length))) throw new Error('Unowned AGY command receipt.');
        this.outstanding.add(step);
        this.owned.set(step, { cwd: this.calls.get(step)!.cwd });
        if (this.calls.get(step)?.postSeen) this.posted.add(step);
        this.receipts.set(step, identity(row));
      } else if (nativeWake(row)) {
        const wake = nativeWake(row)!;
        const completion = this.commandCompletion(row, wake);
        if (!completion) throw new Error('Unverified AGY command completion.');
        const { step: taskStep, exitCode } = completion;
        this.outstanding.delete(taskStep);
        this.owned.get(taskStep)!.exitCode = exitCode;
        if (!foreground) this.notificationWakes.set(taskStep, step);
        if (this.calls.get(taskStep)?.postSeen) this.calls.delete(taskStep);
        this.posted.delete(taskStep);
        if (this.provisional?.has(taskStep)) this.provisional = undefined;
        this.receipts.set(step, identity(row));
      } else { other.push(row); continue; }
      seen++;
    }
    if (seen !== this.receipts.size) throw new Error('AGY command evidence is missing.');
    if (kill && kill.posted && kill.exitObserved) {
      this.outstanding.delete(kill.target);
      this.owned.delete(kill.target);
      this.calls.delete(kill.target);
      this.posted.delete(kill.target);
      this.kill = undefined;
    }
    if (this.kill && event === 'Stop') throw new Error('AGY command cancellation was not confirmed.');
    if (commandPost) {
      prior.postSeen = true;
      if (this.outstanding.has(hookStep)) this.posted.add(hookStep);
      else if (this.owned.has(hookStep)) this.calls.delete(hookStep);
    }
    if (delayedPost && this.idleInvocation && rows.at(-1)?.step_index === this.lastStep) {
      // A delayed command post does not advance the current notification.
      if (this.candidate && identity(rows.filter(r => r.step_index < this.candidate!.wakeStep)) !== this.candidate.history) {
        throw new Error('AGY command notification history changed.');
      }
      return other;
    }
    if (this.candidate && !foreground && allowIdleDenial && (event === 'PreToolUse' || this.denial)) {
      this.idleDecision = this.observeIdleDenial(event, payload, rows, other);
      this.lastStep = rows.at(-1)!.step_index;
      return other;
    }
    if (this.denial) throw new Error('AGY idle denial sequence was interrupted.');
    // An intervening callback ends eligibility for this specific deny/Stop
    // sequence. The ordinary completion path still verifies no-tool turns.
    if (!delayedPost) this.candidate = undefined;
    if (!foreground && (event !== 'SessionStart' || this.notificationWakes.size)) {
      if (other.some(row => row.step_index > this.lastStep && (row.source !== 'MODEL' || row.type !== 'PLANNER_RESPONSE'
        || row.tool_calls?.length || row.status !== 'DONE'))) throw new Error('Unexpected work during AGY command completion.');
    }
    if (!foreground && event !== 'SessionStart' && !delayedPost) {
      if (event === 'PreInvocation' && !this.idleInvocation && (this.notificationWakes.size || this.posted.size > 0)) {
        // The wake may first be flushed during PostInvocation. Keep admission
        // pending until this invocation has the terminal of a posted command.
        if (!this.notificationWakes.size) this.provisional = new Set(this.posted);
        const early = [...this.notificationWakes.values()];
        const start = payload.initialNumSteps as number;
        const wakeStep = early[0] ?? this.lastStep + 1;
        if (allowIdleDenial && early.length <= 1 && payload.invocationNum === 0 && typeof payload.cwd === 'string'
          && (start === wakeStep || early.length === 1 && start === wakeStep + 1)
          && rows.at(-1)?.step_index === (early.length ? wakeStep : wakeStep - 1)) {
          this.candidate = { start, wakeStep, cwd: payload.cwd, history: identity(rows.filter(r => r.step_index < wakeStep)) };
        }
        this.idleInvocation = true;
      } else if (!this.idleInvocation || !['PostInvocation', 'Stop'].includes(event)) throw new Error('Unattributed idle AGY hook.');
      if (event === 'Stop') {
        if (this.provisional) throw new Error('AGY notification Stop lacks the posted command completion.');
        this.idleInvocation = false;
        this.notificationWakes.clear();
      }
    }
    if (rows.length) this.lastStep = rows[rows.length - 1].step_index;
    return other;
  }

  private observeIdleDenial(event: string, payload: HookPayload, rows: TranscriptRecord[], other: TranscriptRecord[]): HookDecision {
    const { start, wakeStep, cwd, history } = this.candidate!;
    const step = wakeStep + 2;
    const tail = rows.at(-1);
    const wake = this.notificationWakes.entries().next().value;
    if (payload.cwd !== cwd || payload.conversationId !== this.session || payload.hookEventName !== event
      || this.notificationWakes.size !== 1 || !wake || wake[1] !== wakeStep
      || this.owned.get(wake[0])?.cwd !== cwd || !this.idleInvocation || this.provisional || !tail
      || identity(rows.filter(row => row.step_index < wakeStep)) !== history) throw new Error('Unowned AGY idle shell.');
    // Native 1.5.13 flushes the owned completion and one planner call before
    // PreToolUse. Only that call and its nonce-bearing ERROR may follow the wake.
    if (event === 'PreToolUse' && !this.denial) {
      const call = payload.toolCall as { name?: string; args?: Record<string, unknown>; id?: string } | undefined;
      if (tail.step_index !== step - 1 || tail.source !== 'MODEL'
        || tail.type !== 'PLANNER_RESPONSE' || tail.status !== 'DONE' || payload.stepIdx !== step
        || typeof call?.id !== 'string' || !call.id || call.id.length > 256 || call.name !== 'run_command'
        || typeof call.args?.CommandLine !== 'string' || !isDeepStrictEqual(tail.tool_calls, [{ name: call.name, args: call.args }])) {
        throw new Error('Unverified AGY idle shell request.');
      }
      const reason = idleDenialMessage + ' (' + randomUUID() + ').';
      this.receipts.set(tail.step_index, identity(tail));
      other.pop();
      this.denial = { reason, terminated: false };
      this.liveDenial = true;
      return { decision: 'deny', reason };
    }
    const denied = this.denial;
    if (event === 'PostInvocation' && denied && !denied.terminated && payload.initialNumSteps === start && payload.invocationNum === 0
      && tail.step_index === step && tail.status === 'ERROR' && !tail.tool_calls?.length
      && receiptText(tail) === 'Encountered error in step execution: tool call denied by pre-tool hook: ' + denied.reason) {
      this.receipts.set(step, identity(tail));
      other.pop();
      denied.terminated = true;
      return { terminationBehavior: 'terminate' };
    }
    if (event === 'Stop' && denied?.terminated && tail.step_index === step && payload.terminationReason === 'TERMINAL_CUSTOM_HOOK'
      && payload.error === '' && payload.continuationActive === false
      && (payload.fullyIdle === true || payload.fullyIdle === false && this.outstanding.size > 0)) {
      this.denial = undefined;
      this.candidate = undefined;
      this.idleInvocation = false;
      this.notificationWakes.delete(wake[0]);
      return {};
    }
    throw new Error('AGY idle shell denial was not confirmed.');
  }
}
