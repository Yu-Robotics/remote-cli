import fs from 'fs/promises';
import path from 'path';
import type { Readable, Writable } from 'stream';
import type { ScheduleRule } from '../types';
import { COMMAND, EVENT, VERSION, MAX_FRAME, MAX_OUTPUT, JsonLines, boundedText, exact, identifier, instant,
  matchesRecord, normalizeRule, object, validPrompt, type ObjectValue } from './protocol';

/** Structural public DSH plugin surface; no dependency on an uninstalled DSH package at CLI build time. */
export interface DshContext {
  on(name: string, callback: (...args: any[]) => unknown): () => void;
  effect(callback: () => () => unknown, label?: string): unknown;
  inject(services: string[], callback: (ctx: DshContext) => unknown): unknown;
  provide(name: string, value: unknown): void;
  tools: { guard(callback: (execution: ObjectValue) => string | undefined): () => void };
  agents: { get(id: string): ObjectValue | undefined };
  sessions: { flush(session: ObjectValue): Promise<boolean> };
  sessionPersistence: { root: string };
  storage: { backend: { get(name: string): { root?: string } } };
  schedule: {
    create(sessionId: string, request: ObjectValue): Promise<ObjectValue>;
    list(request: { sessionId: string }): Promise<ObjectValue[]>;
    catalog(): Promise<ObjectValue[]>;
    delete(request: { sessionId: string; id: string }): Promise<{ id: string; deleted: boolean }>;
  };
}
export const name = 'remote-cli-native-schedule';
export const inject = ['agents', 'sessions', 'tools', 'schedule', 'remoteCliScheduleScope'];

/** Explicit plugin dependencies keep native startup's activation audit ordered. */
export async function apply(ctx: DshContext, config: { directory: string; scope: string }): Promise<void> {
  const bridge = new DshScheduleBridge(ctx, config.scope, process.stdin, process.stdout);
  await bridge.start();
  ctx.effect(() => () => bridge.dispose(), 'remote-cli native schedule bridge');
  ctx.provide('remoteCliScheduleReady', {});
}

export async function verifyScope(ctx: DshContext, config: { directory: string; scope: string }): Promise<void> {
  if (!exact(config, ['directory', 'scope']) || !identifier(config.scope) || !path.isAbsolute(config.directory)) throw new Error('Invalid DSH schedule scope.');
  const stat = await fs.lstat(config.directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(config.directory) !== config.directory
    || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new Error('DSH schedule scope is not private.');
  for (const [name, actual] of [['sessions', ctx.sessionPersistence.root], ['storage', ctx.storage.backend.get('json').root]] as const) {
    const expected = path.join(config.directory, name);
    const child = await fs.lstat(expected);
    if (actual !== expected) throw new Error(`DSH ${name} storage routing differs from the owned scope.`);
    if (!child.isDirectory() || child.isSymbolicLink() || await fs.realpath(expected) !== expected) throw new Error('DSH schedule storage is not canonical.');
    if (name === 'sessions' && (await fs.readdir(expected)).length !== 0) throw new Error('DSH session storage is not empty.');
    if (name === 'storage') {
      // Other fresh native domains initialize concurrently. Only schedule.json can restore timers.
      try { await fs.lstat(path.join(expected, 'schedule.json')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      throw new Error('DSH schedule storage is not empty.');
    }
  }
}

/** A protocol/event adapter only: every clock, occurrence, and CRUD mutation belongs to ctx.schedule. */
export class DshScheduleBridge {
  private sequence = 0;
  private requestId = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private failed = false;
  private attempted = false;
  private creating = false;
  private early: Array<() => void> = [];
  private observed?: ObjectValue;
  private agent?: ObjectValue;
  private job?: ObjectValue;
  private rule?: ScheduleRule;
  private active?: { turn: number; messageId: string; occurrenceAt: string; output: string; truncated: boolean };
  private lastTurn = 0;
  private lastOccurrence = '';
  private cancelled = false;
  private disposal?: Promise<void>;
  private readonly disposers: Array<() => void> = [];
  private readonly reader = new JsonLines(frame => this.frame(frame));
  private readonly read = (chunk: Buffer | string) => {
    try { this.reader.read(chunk); } catch { this.fatal(); }
  };
  private readonly end = () => { void this.dispose().catch(() => {}); };
  constructor(private readonly ctx: DshContext, private readonly scope: string,
    private readonly input: Readable, private readonly output: Writable) {}

  async start(): Promise<void> {
    if ((await this.ctx.schedule.catalog()).length) throw new Error('DSH schedule store is not empty.');
    this.disposers.push(this.ctx.tools.guard(execution => {
      // Monotonic native guard: later tool policies cannot re-authorize scheduling or host reconfiguration.
      if (/^schedule_|^plugin_manager$|cordis|^run_code$|subagent|^spawn_agent$|^fork_agent$/.test(execution.name)) {
        return 'Native schedule management and delegation are reserved for the schedule owner.';
      }
      return undefined;
    }));
    this.disposers.push(this.ctx.on('session/created', session => {
      if (this.observed && this.observed !== session) { this.fatal(); return; }
      this.observed = session;
    }));
    this.disposers.push(this.ctx.on('agent/inbox/claimed', data => this.native(() => this.claim(data))));
    this.disposers.push(this.ctx.on('session/event', (session, event) => this.native(() => this.event(session, event))));
    this.disposers.push(this.ctx.on('schedule/changed', () => {
      // Event-driven validation, never timer polling. Defer beyond the native mutation's commit.
      queueMicrotask(() => { this.chain = this.chain.then(() => this.audit()).catch(() => this.fatal()); });
    }));
    this.input.on('data', this.read);
    this.input.on('end', this.end);
    this.input.on('error', this.end);
    this.send({ kind: 'ready' });
  }

  private native(work: () => void): void {
    if (this.stopped || this.failed) return;
    if (this.creating) {
      if (this.early.length >= 128) { this.fatal(); return; }
      this.early.push(work);
    } else { try { work(); } catch { this.fatal(); } }
  }

  private frame(frame: ObjectValue): void {
    // Observe the same bytes as stock ACP. Never consume its RPCs or manufacture their replies.
    if (frame.method !== COMMAND) return;
    const p = frame.params;
    if (frame.jsonrpc !== '2.0' || 'id' in frame || !object(p) || p.version !== VERSION || p.scope !== this.scope
      || !Number.isSafeInteger(p.requestId) || p.requestId <= this.requestId) { this.fatal(); return; }
    this.requestId = p.requestId;
    this.chain = this.chain.then(async () => {
      if (this.stopped || this.failed) throw new Error();
      const result = await this.manage(p);
      this.send({ kind: 'receipt', requestId: p.requestId, operation: p.operation, ...result });
      // A very short native timer may claim its message before create's await resumes.
      const early = this.early.splice(0);
      this.creating = false;
      for (const work of early) this.native(work);
    }).catch(() => this.fatal());
  }

  private async manage(p: ObjectValue): Promise<ObjectValue> {
    const base = ['version', 'scope', 'requestId', 'operation', 'sessionId'];
    if (p.operation === 'bind') {
      if (!exact(p, [...base, 'cwd']) || this.agent || !identifier(p.sessionId)) throw new Error();
      const agent = this.ctx.agents.get(p.sessionId);
      if (!agent || agent.session !== this.observed || agent.session.id !== p.sessionId
        || agent.session.header.cwd !== p.cwd || agent.session.header.origin === 'subagent'
        || agent.session.header.parentSession !== undefined) throw new Error();
      this.agent = agent;
      await this.audit();
      return { sessionId: p.sessionId };
    }
    if (!this.agent || p.sessionId !== this.agent.session.id || this.ctx.agents.get(p.sessionId) !== this.agent) throw new Error();
    if (p.operation === 'create') {
      if (!exact(p, [...base, 'rule', 'prompt', 'title']) || this.attempted || !validPrompt(p.prompt) || !identifier(p.title)) throw new Error();
      this.attempted = true;
      this.rule = normalizeRule(p.rule);
      await this.audit();
      this.creating = true;
      const selector = this.rule.kind === 'once' ? { at: this.rule.at }
        : { cron: { expression: this.rule.expression, time_zone: this.rule.timezone } };
      const record = await this.ctx.schedule.create(p.sessionId, { ...selector, prompt: p.prompt, title: p.title });
      this.job = record;
      if (!matchesRecord(record, this.rule, p.prompt, p.title)) throw new Error();
      await this.audit();
      return { sessionId: p.sessionId, nativeId: record.id, record };
    }
    if (!exact(p, base) || !['list', 'cancel'].includes(p.operation)) throw new Error();
    if (p.operation === 'cancel') {
      this.cancelled = true;
      // Catalog includes already-fired one-shots. Delete every row in this exclusively owned scope.
      await this.removeJobs();
      this.agent.cancel({ kind: 'user' });
      return { sessionId: p.sessionId, nativeId: this.job?.id ?? '', deleted: true, remaining: 0 };
    }
    await this.audit();
    const rows = await this.ctx.schedule.list({ sessionId: p.sessionId });
    if (rows.length > 1 || rows.some(row => !this.job || !matchesRecord(row, this.rule!, this.job.prompt, this.job.title, this.job.id))) throw new Error();
    // Native catalog retains a fired one-shot until its queued turn finishes.
    const catalog = await this.ctx.schedule.catalog();
    if (catalog.length > 1 || catalog.some(row => row.sessionId !== p.sessionId || !this.job
      || !matchesRecord(row, this.rule!, this.job.prompt, this.job.title, this.job.id))) throw new Error();
    return { sessionId: p.sessionId, nativeId: this.job?.id ?? '', records: catalog };
  }

  private async audit(): Promise<void> {
    if (this.stopped || this.failed) return;
    const rows = await this.ctx.schedule.catalog();
    if (this.cancelled) { if (rows.length) throw new Error(); return; }
    if (!this.job) { if (rows.length) throw new Error(); return; }
    if (rows.length !== 1 || rows[0].sessionId !== this.agent?.session.id
      || !matchesRecord(rows[0], this.rule!, this.job.prompt, this.job.title, this.job.id)) throw new Error();
  }

  private claim({ agent, message, turn }: ObjectValue): void {
    if (agent !== this.agent || !this.job || !this.rule || !Number.isSafeInteger(turn) || turn < 1 || !identifier(message.id)) throw new Error();
    // Native step context is claimed alongside the schedule's input, sometimes first.
    // It never creates an occurrence or replaces the schedule message/turn join.
    if (['tool-jobs', 'tool-registry'].includes(message.source?.kind)) {
      if (this.active ? turn !== this.active.turn : turn <= this.lastTurn) throw new Error();
      return;
    }
    if (this.active || turn <= this.lastTurn || message.source?.kind !== 'schedule') throw new Error();
    const text = message.content?.length === 1 && message.content[0].type === 'text' ? message.content[0].text : undefined;
    if (typeof text !== 'string') throw new Error();
    const lines = text.split('\n');
    let occurrenceAt: unknown;
    if (this.rule.kind === 'once') {
      if (lines.length !== 5 || lines[0] !== '[SCHEDULE REMINDER]' || lines[1] !== 'This is a scheduled message from the user'
        || !lines[2].startsWith('schedule_id_json: ') || JSON.parse(lines[2].slice(18)) !== this.job.id
        || !lines[3].startsWith('occurrence_at: ') || !lines[4].startsWith('reminder_prompt_json: ')
        || JSON.parse(lines[4].slice(22)) !== this.job.prompt) throw new Error();
      occurrenceAt = lines[3].slice(15);
      if (occurrenceAt !== this.rule.at) throw new Error();
    } else {
      if (lines.length !== 3 || lines[0] !== '[SCHEDULE REMINDER BATCH]' || lines[1] !== 'This is a scheduled message from the user'
        || !lines[2].startsWith('reminders_json: ')) throw new Error();
      const reminders = JSON.parse(lines[2].slice(16));
      if (!Array.isArray(reminders) || reminders.length !== 1 || !exact(reminders[0], ['schedule_id', 'occurrence_at', 'reminder_prompt'])
        || reminders[0].schedule_id !== this.job.id || reminders[0].reminder_prompt !== this.job.prompt) throw new Error();
      occurrenceAt = reminders[0].occurrence_at;
    }
    this.startOccurrence(turn, message.id, occurrenceAt);
  }

  private startOccurrence(turn: number, messageId: string, occurrenceAt: unknown): void {
    if (!instant(occurrenceAt) || occurrenceAt <= this.lastOccurrence || Date.parse(occurrenceAt) > Date.now() + 1000) throw new Error();
    this.lastTurn = turn;
    this.lastOccurrence = occurrenceAt;
    this.active = { turn, messageId, occurrenceAt, output: '', truncated: false };
    this.send({ kind: 'started', ...this.identity() });
  }
  private identity(): ObjectValue {
    return { sessionId: this.agent!.session.id, nativeId: this.job!.id, turn: this.active!.turn,
      messageId: this.active!.messageId, occurrenceAt: this.active!.occurrenceAt };
  }
  private event(session: ObjectValue, event: ObjectValue): void {
    if (session !== this.observed || !['assistant/message', 'turn/end'].includes(event.type)) return;
    if (!this.active || event.data.turn !== this.active.turn) throw new Error();
    if (event.type === 'assistant/message') {
      for (const block of event.data.message.content) {
        if (block.type !== 'text') continue;
        if (typeof block.text !== 'string') throw new Error();
        const remaining = MAX_OUTPUT - 64 - Buffer.byteLength(this.active.output);
        this.active.output += boundedText(block.text, remaining);
        if (Buffer.byteLength(block.text) > remaining) this.active.truncated = true;
      }
    } else {
      const reason = event.data.reason?.kind;
      if (!['completed', 'blocked', 'max-tokens', 'aborted', 'error'].includes(reason)) throw new Error();
      const output = this.active.output + (this.active.truncated ? '\n[Output truncated.]' : '');
      this.send({ kind: 'completed', ...this.identity(), success: reason === 'completed', output,
        ...(reason === 'completed' ? {} : { error: `Native DSH scheduled turn ended: ${reason}.` }) });
      this.active = undefined;
    }
  }

  private send(params: ObjectValue): void {
    if (this.output.destroyed || this.output.writableLength > MAX_FRAME * 2) throw new Error('DSH bridge output unavailable.');
    const line = JSON.stringify({ jsonrpc: '2.0', method: EVENT, params: { version: VERSION, scope: this.scope, sequence: ++this.sequence, ...params } }) + '\n';
    if (Buffer.byteLength(line) > MAX_FRAME) throw new Error('DSH bridge output limit exceeded.');
    this.output.write(line);
  }
  private fatal(): void {
    if (this.failed) return;
    this.failed = true;
    try { this.send({ kind: 'fatal', error: 'Native DSH schedule ownership or protocol validation failed.' }); } catch { /* Parent observes transport failure or timeout. */ }
    this.early = [];
    void this.dispose().catch(() => {});
    try { this.agent?.cancel({ kind: 'user' }); } catch { /* Parent retains process ownership. */ }
  }
  private async removeJobs(): Promise<void> {
    const rows = await this.ctx.schedule.catalog();
    for (const row of rows) {
      const receipt = await this.ctx.schedule.delete({ sessionId: row.sessionId, id: row.id });
      if (receipt.id !== row.id || receipt.deleted !== true) throw new Error('Native DSH deletion was not confirmed.');
    }
    if ((await this.ctx.schedule.catalog()).length !== 0) throw new Error('Native DSH jobs remain.');
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.stopped = true;
    this.input.off('data', this.read);
    this.input.off('end', this.end);
    this.input.off('error', this.end);
    this.disposal = (async () => {
      await this.chain;
      try { await this.removeJobs(); } finally {
        this.agent?.cancel({ kind: 'user' });
        for (const dispose of this.disposers.splice(0)) dispose();
      }
    })();
    return this.disposal;
  }
}
