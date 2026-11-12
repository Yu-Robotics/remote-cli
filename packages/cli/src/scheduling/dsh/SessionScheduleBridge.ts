import type { Readable, Writable } from 'stream';
import { nativePackage } from './SessionScheduleStorage';
import { SESSION_COMMAND, SESSION_EVENT, SESSION_VERSION } from './sessionProtocol';
import { JsonLines, identifier, instant, exact, validPrompt, normalizeRule, matchesRecord, boundedText, MAX_OUTPUT, MAX_FRAME, type ObjectValue } from './protocol';

export const name = 'remote-cli-session-schedule-bridge';
export const inject = ['agents', 'sessions', 'tools', 'sessionController', 'sessionPersistence', 'storageDomain', 'storage.backend.remoteCliSessionSchedule'];
export async function apply(ctx: any, config: { scope: string }): Promise<void> {
  const bridge = new SessionScheduleBridge(ctx, config.scope, process.stdin, process.stdout, async () => {
    const { ScheduleService } = await nativePackage('dsh-schedule');
    ctx.plugin(ScheduleService, {});
    return await new Promise<any>(resolve => ctx.inject(['schedule'], (ready: any) => resolve(ready)));
  });
  await bridge.start();
  ctx.effect(() => () => bridge.dispose());
  ctx.provide('remoteCliSessionScheduleReady', {});
}

/** All timing/CRUD belongs to DSH. Observe durable turns, including mixed foreground/reminder turns. */
export class SessionScheduleBridge {
  private jobs = new Map<string, { sessionId: string; row: ObjectValue; rule: any; cancelled: boolean }>();
  private turns = new Map<string, { output: string; jobs: Map<string, string>; reminders: Set<string>; user: boolean; scheduled: boolean }>();
  private disposers: Array<() => void> = [];
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private initialized?: Promise<void>;
  private enabled = false;
  private creating = false;
  private early: Array<() => void> = [];
  private requests = new Set<string>();
  private reader = new JsonLines(frame => {
    if (frame.method !== SESSION_COMMAND) return;
    const p = frame.params;
    if (frame.jsonrpc !== '2.0' || 'id' in frame || p?.version !== SESSION_VERSION || p.scope !== this.scope
      || !identifier(p.requestId) || !identifier(p.sessionId)) return;
    if (this.requests.has(p.requestId) || this.requests.size >= 10000) return;
    this.requests.add(p.requestId);
    this.chain = this.chain.then(async () => {
      try { this.send({ kind: 'receipt', requestId: p.requestId, result: await this.manage(p) }); }
      catch { this.send({ kind: 'receipt', requestId: p.requestId, error: 'Native session schedule operation failed.' }); }
    });
  });
  private read = (chunk: Buffer) => { try { this.reader.read(chunk); } catch { this.send({ kind: 'fatal' }); } };
  constructor(private ctx: any, private scope: string, private input: Readable, private output: Writable,
    private initialize: () => Promise<any> = async () => {}) {}
  async start(): Promise<void> {
    this.disposers.push(this.ctx.tools.guard((execution: ObjectValue) => {
      if (/^schedule_/.test(execution.name)) return 'Use the managed scheduling tools for this session.';
      if (!this.enabled) return undefined;
      if (/^plugin_manager$|cordis/.test(execution.name)) return 'Schedule ownership prevents host reconfiguration.';
      const sessionId = execution.agent?.session?.id;
      if (/remote_cli_schedule_/.test(execution.name)
        && [...this.turns].some(([key, turn]) => key.startsWith(`${sessionId}:`) && turn.scheduled)) {
        return 'Scheduled turns cannot manage schedules, including mixed foreground/reminder turns.';
      }
      return undefined;
    }));
    this.disposers.push(this.ctx.on('agent/inbox/claimed', (data: ObjectValue) => this.claim(data)));
    this.disposers.push(this.ctx.on('session/event', (session: ObjectValue, event: ObjectValue) => this.event(session, event)));
    this.input.on('data', this.read);
  }
  private async manage(p: ObjectValue): Promise<ObjectValue> {
    if (this.stopped) throw new Error();
    this.enabled = true;
    await (this.initialized ??= this.initialize().then(async ready => {
      if (ready) this.ctx = ready;
      if ((await this.ctx.schedule.catalog()).length) throw new Error('Schedule storage must be fresh.');
    }));
    const agent = this.ctx.agents.get(p.sessionId);
    if (!agent || agent.session.header.origin === 'subagent' || agent.session.header.parentSession) throw new Error();
    if (p.operation === 'inspect') return { sessionId: agent.session.id, ready: true };
    if (p.operation === 'create') {
      if (!identifier(p.id) || this.jobs.has(p.id) || !validPrompt(p.prompt) || this.jobs.size >= 5) throw new Error();
      const rule = normalizeRule(p.rule);
      // Publish ownership before awaiting native persistence; inbox claims may precede its receipt.
      const owned = { sessionId: p.sessionId, row: undefined as any, rule, cancelled: false };
      this.jobs.set(p.id, owned);
      this.creating = true;
      try {
        const row = await this.ctx.schedule.create(p.sessionId, { title: p.id, prompt: p.prompt,
          ...(rule.kind === 'once' ? { at: rule.at } : { cron: { expression: rule.expression, time_zone: rule.timezone } }) });
        owned.row = row;
        if (!matchesRecord(row, rule, p.prompt, p.id)) {
          await this.ctx.schedule.delete({ sessionId: p.sessionId, id: row.id }); throw new Error();
        }
        return { nativeId: row.id, sessionId: p.sessionId };
      } catch (error) { throw error; }
      finally {
        this.creating = false;
        for (const work of this.early.splice(0)) work();
      }
    }
    const job = this.jobs.get(p.id);
    if (!job && p.operation === 'cancel') return { deleted: true };
    if (!job || job.sessionId !== p.sessionId) throw new Error();
    if (job.cancelled) {
      if (p.operation === 'cancel') return { deleted: true };
      if (p.operation === 'list') return { present: false };
      throw new Error();
    }
    if (!job.row) {
      const candidates = (await this.ctx.schedule.catalog()).filter((row: any) => row.sessionId === p.sessionId && row.title === p.id);
      if (candidates.length > 1) throw new Error();
      job.row = candidates[0];
      if (!job.row && p.operation === 'cancel') { this.jobs.delete(p.id); return { deleted: true }; }
      if (!job.row) throw new Error();
    }
    if (p.operation === 'list') {
      const rows = await this.ctx.schedule.catalog();
      return { present: rows.some((row: any) => row.id === job.row.id && row.sessionId === p.sessionId) };
    }
    if (p.operation !== 'cancel') throw new Error();
    const receipt = await this.ctx.schedule.delete({ sessionId: p.sessionId, id: job.row.id });
    if (receipt.id !== job.row.id) throw new Error();
    if ((await this.ctx.schedule.catalog()).some((row: any) => row.id === job.row.id)) throw new Error();
    // Deletion stops future timing, not an inbox reminder or an executing turn.
    // Retain already claimed occurrences until their native terminal events arrive.
    job.cancelled = true;
    this.retire(p.id);
    return { deleted: true };
  }
  private retire(id: string): void {
    if (this.jobs.get(id)?.cancelled && ![...this.turns.values()].some(turn => turn.jobs.has(id))) this.jobs.delete(id);
  }
  private claim({ agent, message, turn }: ObjectValue): void {
    if (this.creating && message.source?.kind === 'schedule') {
      if (this.early.length >= 100) { this.send({ kind: 'fatal' }); return; }
      this.early.push(() => this.claim({ agent, message, turn })); return;
    }
    if (!identifier(agent?.session?.id) || !Number.isSafeInteger(turn) || turn < 1 || !identifier(message?.id)) return;
    const sessionId = agent.session.id;
    const key = `${sessionId}:${turn}`;
    if (!this.turns.has(key) && this.turns.size >= 100) { this.send({ kind: 'fatal' }); return; }
    const state = this.turns.get(key) ?? { output: '', jobs: new Map<string, string>(), reminders: new Set<string>(), user: false, scheduled: false };
    this.turns.set(key, state);
    if (message.source?.kind === 'user') state.user = true;
    if (message.source?.kind !== 'schedule') return;
    state.scheduled = true;
    const text = message.content?.[0]?.text;
    if (typeof text !== 'string') return;
    const lines = text.split('\n');
    let entries: any[];
    try {
      if (lines[1] !== 'This is a scheduled message from the user') return;
      if (lines[0] === '[SCHEDULE REMINDER BATCH]' && lines.length === 3 && lines[2].startsWith('reminders_json: ')) entries = JSON.parse(lines[2].slice(16));
      else if (lines[0] === '[SCHEDULE REMINDER]' && lines.length === 5 && lines[2].startsWith('schedule_id_json: ')
        && lines[3].startsWith('occurrence_at: ') && lines[4].startsWith('reminder_prompt_json: ')) entries = [{
          schedule_id: JSON.parse(lines[2].slice(18)), occurrence_at: lines[3].slice(15), reminder_prompt: JSON.parse(lines[4].slice(22)) }];
      else return;
      if (!Array.isArray(entries) || entries.length > 5) return;
    } catch { return; }
    for (const entry of entries) {
      if (!exact(entry, ['schedule_id', 'occurrence_at', 'reminder_prompt']) || !identifier(entry.schedule_id)
        || !instant(entry.occurrence_at) || typeof entry.reminder_prompt !== 'string') continue;
      // Include queued reminders for deleted jobs in the shared-output label too.
      if (state.reminders.size < 6) state.reminders.add(entry.schedule_id);
      const job = [...this.jobs].find(([, job]) => job.sessionId === sessionId && job.row?.id === entry.schedule_id);
      if (!job || job[1].cancelled || state.jobs.has(job[0]) || entry.reminder_prompt !== job[1].row.prompt) continue;
      const occurrenceId = `${message.id}-${job[1].row.id}`;
      state.jobs.set(job[0], occurrenceId);
      this.send({ kind: 'event', id: job[0], sessionId, event: { type: 'started', occurrenceId } });
    }
  }
  private event(session: ObjectValue, event: ObjectValue): void {
    if (this.creating) {
      if (this.early.length >= 100) { this.send({ kind: 'fatal' }); return; }
      this.early.push(() => this.event(session, event)); return;
    }
    const key = `${session.id}:${event.data?.turn}`;
    const state = this.turns.get(key);
    if (!state) return;
    if (event.type === 'assistant/message') {
      const text = (event.data.message.content ?? []).filter((block: any) => block.type === 'text' && typeof block.text === 'string').map((block: any) => block.text).join('');
      this.send({ kind: 'projection', sessionId: session.id, messageId: event.data.message.id, foreground: state.user });
      if (state.jobs.size) state.output = boundedText(state.output + text, MAX_OUTPUT);
    }
    if (['tool/call', 'tool/result'].includes(event.type)) {
      this.send({ kind: 'projection', sessionId: session.id,
        toolCallId: event.type === 'tool/call' ? event.data.callId : event.data.message.toolCallId, foreground: state.user });
    }
    if (event.type !== 'turn/end') return;
    const success = event.data.reason?.kind === 'completed';
    if (state.user) this.send({ kind: 'foregroundEnd', sessionId: session.id,
      stopReason: success ? 'end_turn' : event.data.reason?.kind === 'aborted' ? 'cancelled' : 'error' });
    const prefix = state.user ? 'Native combined result for scheduled reminders and foreground input:\n'
      : state.reminders.size > 1 ? 'Native combined result for concurrently due tasks:\n' : '';
    const output = boundedText(prefix + state.output, MAX_OUTPUT);
    this.turns.delete(key);
    for (const [id, occurrenceId] of state.jobs) {
      if (!this.jobs.has(id)) continue;
      this.send({ kind: 'event', id, sessionId: session.id, event: { type: 'completed', occurrenceId,
        success, output, ...(!success && { error: 'Native scheduled turn did not complete.' }) } });
      this.retire(id);
    }
  }
  private send(params: ObjectValue): void {
    if (this.output.destroyed || this.output.writableLength > MAX_FRAME * 2) return;
    const line = JSON.stringify({ jsonrpc: '2.0', method: SESSION_EVENT,
      params: { version: SESSION_VERSION, scope: this.scope, ...params } }) + '\n';
    if (Buffer.byteLength(line) <= MAX_FRAME) this.output.write(line);
  }
  async dispose(): Promise<void> {
    this.stopped = true; this.input.off('data', this.read);
    await this.chain;
    for (const job of this.jobs.values()) if (job.row) await this.ctx.schedule.delete({ sessionId: job.sessionId, id: job.row.id });
    this.jobs.clear(); this.turns.clear();
    for (const dispose of this.disposers.splice(0)) dispose();
  }
}
