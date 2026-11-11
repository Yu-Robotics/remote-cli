import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { DshScheduleBridge, type DshContext } from '../../src/scheduling/dsh/HostBridge';
import { COMMAND, EVENT, JsonLines, type ObjectValue } from '../../src/scheduling/dsh/protocol';

export class DshFixture extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly nativeReceived: ObjectValue[] = [];
  readonly frames: ObjectValue[] = [];
  readonly guards: Array<(exec: ObjectValue) => string | undefined> = [];
  readonly hooks = new EventEmitter();
  readonly rows: ObjectValue[] = [];
  readonly signals: string[] = [];
  readonly scope = 'test-scope';
  readonly sessionId = 'test-session';
  readonly session: ObjectValue;
  readonly agent: ObjectValue;
  readonly context: DshContext;
  readonly bridge: DshScheduleBridge;
  alive = true;
  graceful = true;
  killOn?: string = 'SIGTERM';
  nativeActive = false;
  turn = 0;
  duringCreate?: () => void;
  failCreate = false;
  failDelete = false;
  drop?: string;
  changeRecord?: (record: ObjectValue) => void;
  mutateFrame?: (frame: ObjectValue) => void;
  constructor(cwd: string) {
    super();
    this.session = { id: this.sessionId, header: { cwd } };
    this.agent = { session: this.session, cancel: () => {
      if (this.nativeActive) this.complete('', 'aborted');
    } };
    this.context = {
      on: (name, cb) => { this.hooks.on(name, cb); return () => { this.hooks.off(name, cb); }; },
      effect: () => {}, inject: () => {}, provide: () => {},
      tools: { guard: cb => { this.guards.push(cb); return () => { this.guards.splice(this.guards.indexOf(cb), 1); }; } },
      agents: { get: id => id === this.sessionId ? this.agent : undefined },
      sessions: { flush: async () => true }, sessionPersistence: { root: '' }, storage: { backend: { get: () => ({ root: '' }) } },
      schedule: {
        create: async (sessionId, request) => {
          if (this.failCreate) throw new Error('synthetic-private-error');
          const record = { id: 'schedule-native', prompt: request.prompt, title: request.title,
            ...(request.at ? { kind: 'at', scheduledAt: request.at } : { kind: 'cron', scheduledAt: new Date(Date.now() + 60000).toISOString(),
              expression: request.cron.expression, timeZone: request.cron.time_zone }) };
          this.changeRecord?.(record);
          this.rows.push({ ...record, sessionId, status: 'active' });
          this.hooks.emit('schedule/changed');
          this.duringCreate?.();
          return record;
        },
        list: async ({ sessionId }) => this.rows.filter(row => row.sessionId === sessionId && row.status === 'active'),
        catalog: async () => this.rows.map(row => ({ ...row })),
        delete: async ({ id, sessionId }) => {
          if (this.failDelete) throw new Error('synthetic-private-error');
          const index = this.rows.findIndex(row => row.id === id && row.sessionId === sessionId);
          if (index < 0) return { id, deleted: false };
          this.rows.splice(index, 1); this.hooks.emit('schedule/changed');
          return { id, deleted: true };
        },
      },
    };
    // Native and extension parsers receive exactly the same bytes, as in the real stdio probe.
    const reader = new JsonLines(frame => {
      this.nativeReceived.push(frame);
      if (this.drop && (frame.method === this.drop || frame.params?.operation === this.drop)) return;
      if (frame.method === COMMAND) return;
      if (frame.method === 'initialize') this.frame({ id: frame.id, result: { protocolVersion: 1 } });
      else if (frame.method === 'session/new') {
        this.hooks.emit('session/created', this.session);
        this.frame({ id: frame.id, result: { sessionId: this.sessionId, configOptions: [] } });
      } else if (frame.method === 'session/set_config_option') {
        this.frame({ id: frame.id, result: { configOptions: [{ id: frame.params.configId, currentValue: frame.params.value }] } });
      }
    });
    this.stdin.on('data', data => reader.read(data));
    const output = new PassThrough();
    output.on('data', data => {
      const frame = JSON.parse(String(data));
      if (!this.drop || (frame.params?.operation !== this.drop && frame.params?.kind !== this.drop)) this.frame(frame);
    });
    this.bridge = new DshScheduleBridge(this.context, this.scope, this.stdin, output);
    this.stdin.on('finish', () => {
      if (this.graceful) void this.bridge.dispose().catch(() => {}).finally(() => this.exit());
    });
    queueMicrotask(() => { void this.bridge.start(); });
  }
  frame(value: ObjectValue) {
    const frame = { jsonrpc: '2.0', ...value };
    this.mutateFrame?.(frame);
    this.frames.push(frame);
    if (!this.stdout.destroyed) this.stdout.write(JSON.stringify(frame) + '\n');
  }
  start(occurrenceAt?: string) {
    const row = this.rows[0];
    this.turn++; this.nativeActive = true;
    const at = occurrenceAt ?? row.scheduledAt;
    const text = row.kind === 'at'
      ? `[SCHEDULE REMINDER]\nThis is a scheduled message from the user\nschedule_id_json: ${JSON.stringify(row.id)}\noccurrence_at: ${at}\nreminder_prompt_json: ${JSON.stringify(row.prompt)}`
      : `[SCHEDULE REMINDER BATCH]\nThis is a scheduled message from the user\nreminders_json: ${JSON.stringify([{ schedule_id: row.id, occurrence_at: at, reminder_prompt: row.prompt }])}`;
    if (row.kind === 'at') row.status = 'inactive';
    this.hooks.emit('agent/inbox/claimed', { agent: this.agent, turn: this.turn,
      message: { id: `message-${this.turn}`, source: { kind: 'schedule' }, content: [{ type: 'text', text }] } });
  }
  complete(text = 'Synthetic output', reason = 'completed') {
    if (text) this.hooks.emit('session/event', this.session, { type: 'assistant/message',
      data: { turn: this.turn, message: { content: [{ type: 'text', text }] } } });
    this.nativeActive = false;
    this.hooks.emit('session/event', this.session, { type: 'turn/end', data: { turn: this.turn, reason: { kind: reason } } });
  }
  kill(signal = 'SIGTERM') { this.signals.push(signal); if (signal === this.killOn) this.exit(); return true; }
  exit() { if (this.alive) { this.alive = false; this.emit('exit', 0, null); this.emit('close', 0, null); } }
  extensions() { return this.frames.filter(frame => frame.method === EVENT).map(frame => frame.params); }
}
export async function flush() { for (let i = 0; i < 60; i++) await Promise.resolve(); }
