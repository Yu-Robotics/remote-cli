import { createHash } from 'crypto';
import path from 'path';
import { isDeepStrictEqual } from 'util';
import { pathToFileURL } from 'url';
import { nativeWake, receiptText, type TranscriptRecord } from '../../scheduling/agy/transcript';
import type { HookPayload } from '../../scheduling/agy/AgySessionSchedules';

export interface AgyCommandCheckpoint { lastStep: number; digest: string }

const creationPrefix = 'Tool is running as a background task with task id: ';
const identity = (row: TranscriptRecord) => createHash('sha256').update(JSON.stringify(row)).digest('hex');

/** Only a foreground tool hook can introduce an owned command. Its RUNNING
 * creation row can remain in every transcript even after a separate completion. */
export class AgyCommandTasks {
  private readonly calls = new Map<number, { id: string; args: Record<string, unknown>; cwd: string; postSeen: boolean }>();
  private readonly receipts = new Map<number, string>();
  private readonly outstanding = new Set<number>();
  private readonly posted = new Set<number>();
  private provisional?: Set<number>;
  private idleInvocation = false;
  private idleNotification = false;
  private restored = false;
  private foregroundStart?: number;
  private lastStep = -1;

  constructor(private readonly session: string, private readonly home: string,
    private readonly checkpoint?: AgyCommandCheckpoint) {}

  get pending(): boolean { return this.outstanding.size > 0 || this.idleInvocation || this.idleNotification; }

  observeTool(step: number, name: string, id: string, args: Record<string, unknown>, cwd: string): void {
    const prior = this.calls.get(step);
    if (prior && (name !== 'run_command' || prior.id !== id || prior.cwd !== cwd || !isDeepStrictEqual(prior.args, args))) {
      throw new Error('AGY command hook identity changed.');
    }
    if (name === 'run_command' && this.foregroundStart !== undefined && step >= this.foregroundStart
      && !prior && !this.receipts.has(step)) this.calls.set(step, { id, args: structuredClone(args), cwd, postSeen: false });
  }

  endForeground(): void {
    for (const step of this.calls.keys()) if (!this.outstanding.has(step)) this.calls.delete(step);
    this.foregroundStart = undefined;
  }

  private log(step: number): string {
    return pathToFileURL(path.join(this.home, '.gemini', 'antigravity-cli', 'brain', this.session,
      '.system_generated', 'tasks', `task-${step}.log`)).href;
  }

  private digest(): string {
    return createHash('sha256').update(JSON.stringify([...this.receipts].sort(([a], [b]) => a - b))).digest('hex');
  }
  snapshot(): AgyCommandCheckpoint | undefined {
    if (!this.pending && this.receipts.size) return { lastStep: Math.max(...this.receipts.keys()), digest: this.digest() };
    return undefined;
  }

  observe(event: string, payload: HookPayload, rows: TranscriptRecord[], foreground: boolean): TranscriptRecord[] {
    if (foreground && event === 'PreInvocation' && Number.isSafeInteger(payload.initialNumSteps)) {
      this.foregroundStart = payload.initialNumSteps as number;
    }
    if (this.checkpoint && !this.restored) {
      for (const row of rows) {
        if (row.step_index > this.checkpoint.lastStep) continue;
        if (receiptText(row)?.startsWith(creationPrefix) || nativeWake(row)) this.receipts.set(row.step_index, identity(row));
      }
      if (this.digest() !== this.checkpoint.digest) throw new Error('AGY command history changed during load.');
      this.restored = true;
    }
    // Native can deliver PostToolUse after the foreground Stop and before the
    // command's completion row. Authenticate against the original admitted call.
    const hookStep = payload.stepIdx as number;
    const prior = this.calls.get(hookStep);
    const tool = payload.toolCall as { id?: unknown; name?: unknown; args?: unknown } | undefined;
    const commandPost = event === 'PostToolUse' && !!prior && !prior.postSeen && payload.hookEventName === event
      && payload.conversationId === this.session && payload.cwd === prior.cwd && tool?.name === 'run_command'
      && tool.id === prior.id && isDeepStrictEqual(tool.args, prior.args);
    const delayedPost = !foreground && commandPost && this.outstanding.has(hookStep);
    const other: TranscriptRecord[] = [];
    let seen = 0, newCompletion = false;
    for (const row of rows) {
      const step = row.step_index;
      if (this.receipts.has(step)) {
        if (this.receipts.get(step) !== identity(row)) throw new Error('AGY command evidence changed.');
      } else if (receiptText(row)?.startsWith(creationPrefix)) {
        const text = receiptText(row)!;
        const id = `${this.session}/task-${step}`;
        const logLine = '\nTask logs are available at: ' + this.log(step);
        const marker = text.lastIndexOf('\nTask logs are available at: ');
        if (!foreground || !this.calls.has(step) || row.status !== 'RUNNING'
          || !text.startsWith(creationPrefix + id + '\nTask Description: ') || marker < 0
          || !text.startsWith(logLine, marker)
          || !['', '\n'].includes(text.charAt(marker + logLine.length))) throw new Error('Unowned AGY command receipt.');
        this.outstanding.add(step);
        if (this.calls.get(step)?.postSeen) this.posted.add(step);
        this.receipts.set(step, identity(row));
      } else if (nativeWake(row)) {
        const wake = nativeWake(row)!;
        const taskStep = Number(/\/task-(\d+)$/.exec(wake.sender)?.[1]);
        const id = `${this.session}/task-${taskStep}`;
        const heading = `Task id "${id}" finished with result:\nCommand exited with code `;
        if (!this.outstanding.has(taskStep) || step <= taskStep || wake.sender !== id || !wake.prompt.startsWith(heading)
          || !/^\d+\.\n\n(?:Command output:\n[\s\S]*\n|No output from the command\.)\nLog: [^\r\n]+$/.test(wake.prompt.slice(heading.length))
          || !wake.prompt.endsWith('\nLog: ' + this.log(taskStep))) throw new Error('Unverified AGY command completion.');
        this.outstanding.delete(taskStep);
        this.calls.delete(taskStep);
        this.posted.delete(taskStep);
        if (this.provisional?.has(taskStep)) this.provisional = undefined;
        this.receipts.set(step, identity(row));
        newCompletion = true;
      } else { other.push(row); continue; }
      seen++;
    }
    if (seen !== this.receipts.size) throw new Error('AGY command evidence is missing.');
    if (!foreground && newCompletion && !this.idleInvocation) this.idleNotification = true;
    if (!foreground && (event !== 'SessionStart' || newCompletion)) {
      if (other.some(row => row.step_index > this.lastStep && (row.source !== 'MODEL' || row.type !== 'PLANNER_RESPONSE'
        || row.tool_calls?.length || row.status !== 'DONE'))) throw new Error('Unexpected work during AGY command completion.');
    }
    if (commandPost) {
      prior.postSeen = true;
      if (this.outstanding.has(hookStep)) this.posted.add(hookStep);
    }
    if (!foreground && event !== 'SessionStart' && !delayedPost) {
      if (event === 'PreInvocation' && !this.idleInvocation && (this.idleNotification || this.posted.size > 0)) {
        // The wake may first be flushed during PostInvocation. Keep admission
        // pending until this invocation has the terminal of a posted command.
        if (!this.idleNotification) this.provisional = new Set(this.posted);
        this.idleInvocation = true;
        this.idleNotification = false;
      } else if (!this.idleInvocation || !['PostInvocation', 'Stop'].includes(event)) throw new Error('Unattributed idle AGY hook.');
      if (event === 'Stop') {
        if (this.provisional) throw new Error('AGY notification Stop lacks the posted command completion.');
        this.idleInvocation = false;
      }
    }
    if (rows.length) this.lastStep = rows[rows.length - 1].step_index;
    return other;
  }
}
