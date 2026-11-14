import { vi } from 'vitest';
import { PassThrough } from 'stream';
import { SessionScheduleBridge } from '../../src/scheduling/dsh/SessionScheduleBridge';
import { SessionScheduleClient } from '../../src/scheduling/dsh/SessionScheduleClient';
import type { NativeScheduleInput } from '../../src/scheduling/types';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
/** Synthetic ACP host; the executor, schedule bridge/client, catalog and updater are production classes. */
export class Host {
  input = new PassThrough(); output = new PassThrough();
  listeners = new Map<string, Function[]>(); rows: any[] = [];
  exit = deferred<void>(); exitGate?: Promise<void>;
  history: string[]; bridge: SessionScheduleBridge; client: SessionScheduleClient;
  deleteRace?: () => void;
  createError?: Error;
  createCommitted?: () => void;
  idle = vi.fn(async () => {}); flush = vi.fn(async () => true);
  agent: any;
  constructor(history: string[]) {
    this.history = history; this.agent = { session: { id: 'original-session', header: {} }, whenIdle: this.idle };
    const ctx = { agents: { get: () => this.agent }, sessions: { flush: this.flush }, tools: { guard: () => () => {} },
      on: (name: string, callback: Function) => { this.listeners.set(name, [...this.listeners.get(name) ?? [], callback]); return () => {}; },
      schedule: { catalog: async () => this.rows,
        create: async (sessionId: string, value: any) => {
          const row = { id: `native-${value.title}`, sessionId, title: value.title, prompt: value.prompt,
            kind: value.at ? 'at' : 'cron', ...(value.at ? { scheduledAt: value.at } : {
              expression: value.cron.expression, timeZone: value.cron.time_zone, scheduledAt: new Date(Date.now() + 60000).toISOString() }) };
          this.rows.push(row); this.createCommitted?.();
          if (this.createError) throw this.createError;
          return row;
        }, delete: async ({ id }: any) => { this.deleteRace?.(); this.deleteRace = undefined;
          this.rows = this.rows.filter(row => row.id !== id); return { id, deleted: true }; } } };
    this.bridge = new SessionScheduleBridge(ctx, 'fixture-scope', this.input, this.output);
    this.client = new SessionScheduleClient('fixture-scope', (method, params) => this.input.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'));
    this.output.on('data', data => { for (const line of String(data).trim().split('\n')) this.client.receive(JSON.parse(line).params); });
  }
  initialize = async () => { await this.bridge.start(); return {}; };
  newSession = vi.fn(async () => ({ sessionId: 'original-session' }));
  loadSession = vi.fn(async (id: string) => { if (id !== 'original-session') throw new Error('Unknown session'); return { sessionId: id }; });
  setConfigOption = async () => ({});
  deleteSession = async () => {};
  sendCancel = vi.fn();
  prompt = vi.fn(async (_id: string, blocks: any[]) => { this.history.push(blocks[0].text); return { stopReason: 'end_turn' }; });
  createNativeSchedule = (sessionId: string, input: NativeScheduleInput, emit: any) => this.client.create(sessionId, input, emit);
  destroy = vi.fn(() => { void (async () => {
    await this.exitGate;
    await this.bridge.dispose(); this.client.close(); this.input.destroy(); this.output.destroy(); this.exit.resolve();
  })(); });
  waitForExit = () => this.exit.promise;
  emit(name: string, ...args: any[]) { this.listeners.get(name)?.forEach(callback => callback(...args)); }
  start(row: any, turn = 1) {
    this.emit('agent/inbox/claimed', { agent: this.agent, turn, message: { id: `message-${turn}`, source: { kind: 'schedule' },
      content: [{ text: '[SCHEDULE REMINDER BATCH]\nThis is a scheduled message from the user\nreminders_json: ' + JSON.stringify([
        { schedule_id: row.id, occurrence_at: new Date().toISOString(), reminder_prompt: row.prompt }]) }] } });
  }
  finish(text: string, turn = 1) {
    this.history.push(text);
    this.emit('session/event', this.agent.session, { type: 'assistant/message', data: { turn, message: { id: `output-${turn}`, content: [{ type: 'text', text }] } } });
    this.emit('session/event', this.agent.session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
  }
}
