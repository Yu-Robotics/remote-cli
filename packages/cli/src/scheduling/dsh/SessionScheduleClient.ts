import { randomUUID } from 'crypto';
import type { NativeScheduleEvent, NativeScheduleHandle, NativeScheduleInput } from '../types';
import { SESSION_COMMAND, SESSION_VERSION } from './sessionProtocol';
import { identifier, MAX_OUTPUT } from './protocol';

/** One connection to the foreground native process; no timer drives jobs here. */
export class SessionScheduleClient {
  private pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private jobs = new Map<string, { sessionId: string; emit(event: NativeScheduleEvent): void; completed: Set<string>; running: Set<string>; cancelled: boolean }>();
  private closed = false;
  constructor(private scope: string, private send: (method: string, params: unknown) => void) {}
  receive(p: any): boolean {
    if (p?.version !== SESSION_VERSION || p.scope !== this.scope) return false;
    if (p.kind === 'receipt') {
      const pending = this.pending.get(p.requestId);
      if (!pending) return true;
      this.pending.delete(p.requestId); clearTimeout(pending.timer);
      if (p.error) pending.reject(new Error('Native session schedule operation failed.'));
      else pending.resolve(p.result);
    } else if (p.kind === 'event') {
      const job = this.jobs.get(p.id), event = p.event;
      if (!job || p.sessionId !== job.sessionId || !identifier(event?.occurrenceId)) return true;
      if (job.completed.has(event.occurrenceId)) return true;
      if (event.type === 'started') {
        if (job.cancelled || job.running.has(event.occurrenceId)) return true;
        job.running.add(event.occurrenceId); job.emit(event);
      } else if (event.type === 'completed' && job.running.has(event.occurrenceId)
        && typeof event.success === 'boolean' && typeof event.output === 'string' && Buffer.byteLength(event.output) <= MAX_OUTPUT
        && (event.error === undefined || (typeof event.error === 'string' && Buffer.byteLength(event.error) <= MAX_OUTPUT))) {
        // Validate the complete frame before consuming ownership of its terminal event.
        job.running.delete(event.occurrenceId);
        job.completed.add(event.occurrenceId);
        if (job.cancelled && !job.running.size) { this.jobs.delete(p.id); job.completed.clear(); }
        job.emit(event);
      }
    } else if (p.kind === 'fatal') {
      for (const job of this.jobs.values()) job.emit({ type: 'stopped', exitConfirmed: false,
        reason: 'Native schedule bridge failed; explicit job cleanup is required.' });
    }
    return true;
  }
  private request(sessionId: string, operation: string, data: object, accept?: (value: any) => void): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Native scheduling session exited.'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('Native scheduling receipt timed out; do not recreate the task.'));
      }, 30_000);
      this.pending.set(requestId, { resolve: value => {
        // Apply receipt state before another frame in the same stdout chunk arrives.
        try { accept?.(value); resolve(value); } catch (error) { reject(error); }
      }, reject, timer });
      try { this.send(SESSION_COMMAND, { version: SESSION_VERSION, scope: this.scope, requestId, sessionId, operation, ...data }); }
      catch { clearTimeout(timer); this.pending.delete(requestId); reject(new Error('Native schedule transport write failed.')); }
    });
  }
  async create(sessionId: string, input: NativeScheduleInput, emit: (event: NativeScheduleEvent) => void): Promise<NativeScheduleHandle> {
    if (this.closed || this.jobs.has(input.id)) throw new Error('Native scheduling session exited or job already exists.');
    const inspected = await this.request(sessionId, 'inspect', {});
    if (inspected?.ready !== true || inspected.sessionId !== sessionId) throw new Error('Native foreground session was not confirmed.');
    const job = { sessionId, emit, completed: new Set<string>(), running: new Set<string>(), cancelled: false };
    this.jobs.set(input.id, job);
    const cancel = async () => {
      if (job.cancelled || this.closed) return;
      await this.request(sessionId, 'cancel', { id: input.id }, receipt => {
        if (receipt?.deleted !== true) throw new Error('Native deletion unconfirmed.');
        job.cancelled = true;
        if (!job.running.size) { this.jobs.delete(input.id); job.completed.clear(); }
      });
    };
    const handle: NativeScheduleHandle = { nativeId: input.id, cancellationKeepsRunning: true, cancel, stop: cancel,
      list: async () => !job.cancelled && !this.closed && (await this.request(sessionId, 'list', { id: input.id })).present === true };
    try {
      const receipt = await this.request(sessionId, 'create', { id: input.id, rule: input.rule, prompt: input.prompt });
      if (!identifier(receipt?.nativeId) || receipt.sessionId !== sessionId) throw new Error('Native creation receipt is invalid.');
      Object.assign(handle, { nativeId: receipt.nativeId }); return handle;
    } catch (error) {
      try { await cancel(); } catch {
        const { NativeScheduleCleanupError } = await import('../types');
        throw new NativeScheduleCleanupError('Native creation outcome is unconfirmed. Cancel this schedule to retry cleanup.', handle);
      }
      throw error;
    }
  }
  close(): void {
    if (this.closed) return; this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Native scheduling session exited.')); }
    this.pending.clear();
    for (const job of this.jobs.values()) job.emit({ type: 'stopped', exitConfirmed: true, reason: 'Foreground native session exited; schedule is not restored.' });
    this.jobs.clear();
  }
}
