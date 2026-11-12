import { createHash } from 'crypto';
import { parseScheduleCommand, type ScheduleCommand, validateScheduleId } from './ScheduleCommand';
import { NATIVE_SCHEDULE_CAPABILITIES } from './ScheduleCapabilities';
import type { ScheduleOwner, ScheduleRecord } from './types';

export type ScheduleOperation = Extract<ScheduleCommand, { kind: 'create' | 'cancel' }> | { kind: 'list' };
type PublicRecord = Pick<ScheduleRecord, 'id' | 'state' | 'backend' | 'rule' | 'prompt' | 'error'>;
interface Result { status: 'pending' | 'succeeded' | 'failed'; requestId: string; scheduleId?: string; records?: PublicRecord[]; error?: string; card?: string }
interface Receipt { scope: string; settled: boolean; pendingObserved?: boolean; terminalObserved?: boolean; digest: string; sideEffect: boolean; result: Result; done: Promise<void> }
interface Options {
  owner: ScheduleOwner;
  messageId: string;
  backend: keyof typeof NATIVE_SCHEDULE_CAPABILITIES;
  current(): boolean;
  run(command: ScheduleOperation, scheduleId: string): Promise<ScheduleRecord[]>;
  present(records: ScheduleRecord[], operationId: string): Promise<string>;
  nativeAction?(id: string): unknown;
  waitMs?: number;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function keys(args: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(args).some(key => !allowed.includes(key))) throw new Error('Unknown scheduling field. Ownership and execution settings cannot be supplied by tools.');
}
function command(name: string, args: Record<string, unknown>): ScheduleOperation {
  if (name === 'remote_cli_schedule_list') { keys(args, ['requestId']); return { kind: 'list' }; }
  if (name === 'remote_cli_schedule_cancel') {
    keys(args, ['requestId', 'scheduleId']); validateScheduleId(args.scheduleId);
    return { kind: 'cancel', id: args.scheduleId };
  }
  if (name !== 'remote_cli_schedule_create') throw new Error('Unknown scheduling tool.');
  keys(args, ['requestId', 'when', 'prompt']);
  const when = args.when;
  if (!object(when) || typeof args.prompt !== 'string') throw new Error('A self-contained prompt and explicit timing are required.');
  let text: string;
  if (when.kind === 'after') {
    keys(when, ['kind', 'amount', 'unit']);
    if (!Number.isSafeInteger(when.amount) || Number(when.amount) <= 0 || !['m', 'h', 'd'].includes(String(when.unit))) throw new Error('Invalid relative time.');
    text = `after ${when.amount}${when.unit}`;
  } else if (when.kind === 'at') {
    keys(when, ['kind', 'at']);
    if (typeof when.at !== 'string' || /\s/.test(when.at)) throw new Error('Use an ISO timestamp with explicit offset.');
    text = `at ${when.at}`;
  } else if (when.kind === 'cron') {
    keys(when, ['kind', 'expression', 'timezone']);
    if (typeof when.expression !== 'string' || /["\r\n]/.test(when.expression)
      || typeof when.timezone !== 'string' || /\s/.test(when.timezone)) throw new Error('Invalid cron or timezone.');
    text = `cron "${when.expression}" --tz ${when.timezone}`;
  } else throw new Error('Unknown schedule timing kind.');
  const parsed = parseScheduleCommand(`/schedule ${text} -- ${args.prompt}`);
  if (parsed?.kind !== 'create') throw new Error(parsed?.kind === 'invalid' ? parsed.message : 'Invalid schedule.');
  return parsed;
}

/** Receipts survive foreground retries; persistent deterministic job IDs fence process-restart replays. */
export class ScheduleToolOperations {
  private receipts = new Map<string, Receipt>();
  scope(options: Options): ScheduleToolScope { return new ScheduleToolScope(options, this.receipts); }
}

export class ScheduleToolScope {
  private active = true;
  private tasks = new Set<Promise<void>>();
  hasSideEffects = false;
  constructor(private readonly options: Options, private readonly receipts: Map<string, Receipt>) {}
  async invoke(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.active || !this.options.current()) throw new Error('Scheduling turn is no longer active. Use /schedule list.');
    if (!object(args)) throw new Error('Invalid scheduling arguments.');
    if (name === 'remote_cli_schedule_capabilities') {
      keys(args, []);
      return { backend: this.options.backend, capability: NATIVE_SCHEDULE_CAPABILITIES[this.options.backend],
        now: new Date().toISOString(), hostTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    }
    if (typeof args.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(args.requestId)) throw new Error('A stable requestId is required.');
    const scope = JSON.stringify([this.options.owner, this.options.messageId]);
    const key = createHash('sha256').update(JSON.stringify([this.options.owner, this.options.messageId, args.requestId])).digest('hex');
    let receipt = this.receipts.get(key);
    if (name === 'remote_cli_schedule_operation') {
      keys(args, ['requestId']);
      if (!receipt) throw new Error('Unknown operation in this user request. Use /schedule list for previous requests.');
    } else {
      // Compare the original input before relative timing is normalized again on retries.
      const digest = createHash('sha256').update(JSON.stringify([name, canonical(args)])).digest('hex');
      if (receipt && receipt.digest !== digest) throw new Error('requestId was already used with different scheduling arguments.');
      if (!receipt) {
        const parsed = command(name, args);
        // Retain the current request's receipts and every pending operation.
        // Older completed requests can recover by their durable catalog IDs.
        if (this.receipts.size >= 200) {
          const stale = [...this.receipts].find(([, entry]) => entry.settled && entry.scope !== scope);
          if (stale) this.receipts.delete(stale[0]);
        }
        if (this.receipts.size >= 200 || this.tasks.size >= 5) throw new Error('Scheduling operation limit reached. Use /schedule list.');
        if (parsed.kind !== 'list') this.hasSideEffects = true;
        const scheduleId = `managed-${key.slice(0, 48)}`;
        receipt = { scope, settled: false, digest, sideEffect: parsed.kind !== 'list', result: { status: 'pending', requestId: args.requestId,
          ...(parsed.kind === 'create' ? { scheduleId } : {}) }, done: Promise.resolve() };
        this.receipts.set(key, receipt);
        const admitted = receipt;
        admitted.done = Promise.resolve().then(async () => {
          try {
            if (!this.options.current()) throw new Error('Scheduling context changed before admission.');
            const records = await this.options.run(parsed, scheduleId);
            admitted.result = { ...admitted.result, status: 'succeeded', records: records.map(record => ({
              id: record.id, state: record.state, backend: record.backend, rule: record.rule,
              prompt: record.prompt.slice(0, 240), error: record.error?.slice(0, 240),
            })) };
            try { admitted.result.card = await this.options.present(records, key); }
            catch { admitted.result.card = 'Management card unavailable. Use /schedule list; do not recreate the task.'; }
          } catch (error) {
            admitted.result = { ...admitted.result, status: 'failed', error: error instanceof Error ? error.message.slice(0, 4096) : 'Schedule operation failed. Use /schedule list.' };
          } finally { admitted.settled = true; }
        });
        this.tasks.add(admitted.done);
        void admitted.done.finally(() => this.tasks.delete(admitted.done));
      }
    }
    // Inspecting a receipt from an earlier execution also fences automatic model replay.
    if (receipt.sideEffect) this.hasSideEffects = true;
    await waitBounded(receipt.done, this.options.waitMs ?? (name === 'remote_cli_schedule_operation' ? 10_000 : 1000));
    // Never return context-bound information into a replacement conversation/socket.
    if (!this.options.current()) throw new Error('Scheduling context changed. Inspect /schedule list after reconnecting.');
    if (receipt.result.status === 'pending') receipt.pendingObserved = true;
    else receipt.terminalObserved = true;
    const nativeAction = receipt.result.status === 'pending' ? this.options.nativeAction?.(`managed-${key.slice(0, 48)}`) : undefined;
    return { ...structuredClone(receipt.result), ...(nativeAction ? { nativeAction,
      instruction: 'Call this exact authorized native tool now in this conversation, once. Do not report success until remote_cli_schedule_operation confirms its native receipt. Do not change any arguments.' } : {}) };
  }
  unreportedFailures(): Result[] {
    if (!this.options.current()) return [];
    const scope = JSON.stringify([this.options.owner, this.options.messageId]);
    return [...this.receipts.values()].filter(receipt => receipt.scope === scope
      && receipt.pendingObserved && !receipt.terminalObserved && receipt.result.status === 'failed')
      .map(receipt => structuredClone(receipt.result));
  }
  async drain(): Promise<void> { await Promise.allSettled([...this.tasks]); }
  async close(): Promise<void> { this.active = false; await this.drain(); }
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
async function waitBounded(done: Promise<void>, timeout: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([done, new Promise<void>(resolve => { timer = setTimeout(resolve, timeout); })]); }
  finally { clearTimeout(timer); }
}
