import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'stream';
import { SessionScheduleBridge } from '../../src/scheduling/dsh/SessionScheduleBridge';
import { SessionScheduleClient } from '../../src/scheduling/dsh/SessionScheduleClient';
import { SESSION_COMMAND, SESSION_EVENT } from '../../src/scheduling/dsh/sessionProtocol';

async function fixture() {
  const listeners = new Map<string, Function[]>();
  const input = new PassThrough(), output = new PassThrough();
  const rows: any[] = [], frames: any[] = [];
  const agents = new Map(['one', 'two'].map(id => [id, { session: { id, header: {} }, cancel: vi.fn(), history: [] as string[] }]));
  const emit = (name: string, ...args: any[]) => { for (const callback of listeners.get(name) ?? []) callback(...args); };
  let count = 0;
  const ctx = { agents: { get: (id: string) => agents.get(id) }, tools: { guard: vi.fn(() => () => {}) },
    on: (name: string, callback: Function) => { listeners.set(name, [...listeners.get(name) ?? [], callback]); return () => {}; },
    schedule: { catalog: vi.fn(async () => rows),
      create: vi.fn(async (sessionId: string, request: any) => {
        const row = { id: `native-${++count}`, sessionId, title: request.title, prompt: request.prompt,
          kind: 'cron', expression: request.cron.expression, timeZone: request.cron.time_zone, scheduledAt: new Date(Date.now() + 60000).toISOString() };
        rows.push(row); return row;
      }),
      delete: vi.fn(async ({ id, sessionId }: any) => {
        const index = rows.findIndex(row => row.id === id && row.sessionId === sessionId);
        if (index >= 0) rows.splice(index, 1);
        return { id, deleted: index >= 0 };
      }) } };
  const initialize = vi.fn(async () => {});
  const bridge = new SessionScheduleBridge(ctx, 'scope', input, output, initialize);
  const client = new SessionScheduleClient('scope', (method, params) => input.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'));
  output.on('data', data => {
    for (const line of String(data).trim().split('\n')) {
      const frame = JSON.parse(line); frames.push(frame.params);
      if (frame.method === SESSION_EVENT) client.receive(frame.params);
    }
  });
  await bridge.start();
  const create = (id: string, session = 'one', events: any[] = []) => client.create(session,
    { id, backend: 'dsh', cwd: process.cwd(), prompt: 'Use the current conversation',
      rule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' } }, event => events.push(event));
  const claim = (session: string, turn: number, ids: string[] = [], user = false) => {
    const agent = agents.get(session)!;
    if (user) emit('agent/inbox/claimed', { agent, turn, message: { id: `user-${turn}`, source: { kind: 'user' } } });
    if (ids.length) emit('agent/inbox/claimed', { agent, turn, message: { id: `message-${turn}`, source: { kind: 'schedule' },
      content: [{ text: '[SCHEDULE REMINDER BATCH]\nThis is a scheduled message from the user\nreminders_json: ' + JSON.stringify(ids.map(id => ({ schedule_id: id, occurrence_at: new Date().toISOString(), reminder_prompt: 'Use the current conversation' }))) }] } });
  };
  const finish = (session: string, turn: number, text: string) => {
    const agent = agents.get(session)!; agent.history.push(text);
    emit('session/event', agent.session, { type: 'assistant/message', data: { turn, message: { id: `assistant-${turn}`, content: [{ type: 'text', text }] } } });
    emit('session/event', agent.session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
  };
  return { ctx, agents, client, bridge, create, claim, finish, frames, initialize, input, emit,
    close: async () => { await bridge.dispose(); client.close(); input.destroy(); output.destroy(); } };
}

describe('foreground native schedule bridge', () => {
  it('does not initialize native timing or change ordinary output until explicit use', async () => {
    const f = await fixture();
    try {
      f.claim('one', 1, [], true); f.finish('one', 1, 'ordinary');
      expect(f.initialize).not.toHaveBeenCalled();
      expect(f.frames).toEqual([expect.objectContaining({ kind: 'projection', foreground: true }),
        expect.objectContaining({ kind: 'foregroundEnd', stopReason: 'end_turn' })]);
    } finally { await f.close(); }
  });
  it('creates during an active foreground turn without another model turn and retains the exact agent across occurrences', async () => {
    const f = await fixture(); const events: any[] = [];
    try {
      f.claim('one', 1, [], true);
      const agent = f.agents.get('one');
      const job = await f.create('job', 'one', events);
      expect(f.ctx.schedule.create).toHaveBeenCalledWith('one', expect.anything());
      f.finish('one', 1, 'first foreground response');
      f.claim('one', 2, [job.nativeId]); f.finish('one', 2, 'first occurrence');
      f.claim('one', 3, [], true); f.finish('one', 3, 'future foreground context');
      f.claim('one', 4, [job.nativeId]); f.finish('one', 4, 'second occurrence');
      expect(f.agents.get('one')).toBe(agent);
      expect(agent!.history).toEqual(['first foreground response', 'first occurrence', 'future foreground context', 'second occurrence']);
      expect(events.filter(event => event.type === 'completed').map(event => event.output)).toEqual(['first occurrence', 'second occurrence']);
      expect(f.frames.filter(frame => frame.kind === 'projection').map(frame => frame.foreground)).toEqual([true, false, true, false]);
    } finally { await f.close(); }
  });
  it('correlates batched jobs and simultaneous user input without cross-thread delivery or cancelling the agent', async () => {
    const f = await fixture(); const a: any[] = [], b: any[] = [], other: any[] = [];
    try {
      const first = await f.create('first', 'one', a), second = await f.create('second', 'one', b);
      await f.create('other', 'two', other);
      f.claim('one', 2, [first.nativeId, second.nativeId], true); f.finish('one', 2, 'shared turn');
      expect(a.at(-1).output).toBe('Native combined result for scheduled reminders and foreground input:\nshared turn');
      expect(b.at(-1).output).toBe(a.at(-1).output); expect(other).toEqual([]);
      await first.cancel(); await first.stop();
      expect(await second.list()).toBe(true);
      expect(f.agents.get('one')!.cancel).not.toHaveBeenCalled();
      f.claim('one', 3, [first.nativeId, second.nativeId]); f.finish('one', 3, 'remaining');
      expect(a.filter(event => event.type === 'completed')).toHaveLength(1);
      expect(b.at(-1).output).toBe('Native combined result for concurrently due tasks:\nremaining');
    } finally { await f.close(); }
  });
  it('retains all started occurrences after cancel acknowledgement without stopping sibling or foreground work', async () => {
    const f = await fixture(); const a: any[] = [], b: any[] = [];
    try {
      const first = await f.create('first', 'one', a), second = await f.create('second', 'one', b);
      f.claim('one', 1, [first.nativeId, second.nativeId], true);
      f.claim('one', 2, [first.nativeId]);
      await first.cancel();
      expect((f.bridge as any).jobs.size).toBe(2);
      // A queued reminder claimed after acknowledgement must not add a retained occurrence.
      f.claim('one', 3, [first.nativeId, second.nativeId], true);
      expect(a).toHaveLength(2);
      expect(await (f.client as any).request('one', 'list', { id: 'first' })).toEqual({ present: false });
      expect(await (f.client as any).request('one', 'cancel', { id: 'first' })).toEqual({ deleted: true });
      f.finish('one', 1, 'combined answer');
      expect(a.at(-1)).toMatchObject({ type: 'completed', success: true });
      expect(a.at(-1).output).toBe('Native combined result for scheduled reminders and foreground input:\ncombined answer');
      expect(b.at(-1).output).toBe(a.at(-1).output);
      expect((f.bridge as any).jobs.size).toBe(2);
      f.finish('one', 2, 'retained second occurrence');
      f.finish('one', 2, 'duplicate terminal');
      expect(a.map(event => event.type)).toEqual(['started', 'started', 'completed', 'completed']);
      expect((f.bridge as any).jobs.size).toBe(1);
      expect((f.client as any).jobs.size).toBe(1);
      // DSH can still execute an inbox reminder queued before deletion; it is not a new managed start.
      f.finish('one', 3, 'later shared turn');
      expect(a).toHaveLength(4);
      expect(b.filter(event => event.type === 'completed')).toHaveLength(2);
      expect(f.frames.filter(frame => frame.kind === 'foregroundEnd')).toHaveLength(2);
      expect(await second.list()).toBe(true);
      expect(f.agents.get('one')!.cancel).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  it('delivers completion while native deletion is suspended and retires ownership on acknowledgement', async () => {
    const f = await fixture(); const events: any[] = [];
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const deleting = new Promise<void>(resolve => { entered = resolve; });
    const nativeDelete = f.ctx.schedule.delete.getMockImplementation()!;
    f.ctx.schedule.delete.mockImplementationOnce(async args => {
      entered(); await gate; return nativeDelete(args);
    });
    try {
      const job = await f.create('job', 'one', events);
      f.claim('one', 1, [job.nativeId]);
      const cancel = job.cancel(); await deleting;
      // Native claims before confirmed deletion also retain their eventual terminal result.
      f.claim('one', 2, [job.nativeId]);
      f.finish('one', 1, 'completed during deletion');
      expect(events.at(-1).output).toBe('completed during deletion');
      release(); await cancel;
      f.finish('one', 2, 'completed after deletion');
      expect(events.map(event => event.type)).toEqual(['started', 'started', 'completed', 'completed']);
      expect((f.bridge as any).jobs.size).toBe(0);
      expect((f.client as any).jobs.size).toBe(0);
      expect((f.bridge as any).turns.size).toBe(0);
    } finally { release(); await f.close(); }
  });
  it('retains an aborted terminal after future-only cancellation without reporting successful execution', async () => {
    const f = await fixture(); const events: any[] = [];
    try {
      const job = await f.create('job', 'one', events);
      f.claim('one', 1, [job.nativeId], true);
      await job.cancel();
      f.emit('session/event', f.agents.get('one')!.session,
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } });
      expect(events.at(-1)).toMatchObject({ type: 'completed', success: false, error: 'Native scheduled turn did not complete.' });
      expect(f.frames).toContainEqual(expect.objectContaining({ kind: 'foregroundEnd', stopReason: 'cancelled' }));
      expect((f.bridge as any).jobs.size).toBe(0);
      expect((f.client as any).jobs.size).toBe(0);
    } finally { await f.close(); }
  });
  it('labels a pure batch once within the output byte limit for each participating job', async () => {
    const f = await fixture(); const a: any[] = [], b: any[] = [];
    try {
      const first = await f.create('first', 'one', a), second = await f.create('second', 'one', b);
      f.claim('one', 1, [first.nativeId, second.nativeId]);
      f.finish('one', 1, '\u{1f600}'.repeat(100000));
      expect(a.at(-1).output).toMatch(/^Native combined result for concurrently due tasks:\n/);
      expect(b.at(-1).output).toBe(a.at(-1).output);
      expect(Buffer.byteLength(a.at(-1).output)).toBeLessThanOrEqual(256 * 1024);
      expect(a.at(-1).output).not.toContain('\ufffd');
    } finally { await f.close(); }
  });
  it('rejects foreign control frames and interrupts owned jobs on process exit without restoration', async () => {
    const f = await fixture(); const events: any[] = [];
    try {
      f.input.write(JSON.stringify({ jsonrpc: '2.0', method: SESSION_COMMAND, params: { version: 2, scope: 'foreign', requestId: 'request', sessionId: 'one', operation: 'create' } }) + '\n');
      expect(f.initialize).not.toHaveBeenCalled();
      const job = await f.create('job', 'one', events); f.client.close();
      expect(events.at(-1)).toMatchObject({ type: 'stopped', exitConfirmed: true });
      expect(await job.list()).toBe(false);
      await expect(f.create('replacement')).rejects.toThrow('exited');
    } finally { await f.close(); }
  });
  it('retains cleanup ownership after failed cancellation and never stops sibling work', async () => {
    const f = await fixture();
    try {
      const job = await f.create('job');
      f.ctx.schedule.delete.mockRejectedValueOnce(new Error('Synthetic storage error'));
      await expect(job.cancel()).rejects.toThrow('operation failed');
      expect(await job.list()).toBe(true);
      await job.cancel(); expect(await job.list()).toBe(false);
      expect(f.agents.get('one')!.cancel).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  it('buffers an occurrence emitted before native create returns its receipt', async () => {
    const f = await fixture(); const events: any[] = [];
    const create = f.ctx.schedule.create.getMockImplementation()!;
    f.ctx.schedule.create.mockImplementation(async (...args) => {
      const row = await create(...args);
      f.claim('one', 1, [row.id]); f.finish('one', 1, 'early native completion');
      return row;
    });
    try {
      await f.create('early', 'one', events);
      expect(events.map(event => event.type)).toEqual(['started', 'completed']);
      expect(events[1].output).toBe('early native completion');
    } finally { await f.close(); }
  });
  it('blocks nested managed/native scheduling during a scheduled turn and bounds collected output', async () => {
    const f = await fixture(); const events: any[] = [];
    try {
      const job = await f.create('job', 'one', events);
      const guard = f.ctx.tools.guard.mock.calls[0][0] as any;
      expect(guard({ name: 'remote_cli_schedule_create', agent: f.agents.get('one') })).toBeUndefined();
      f.claim('one', 1, [job.nativeId], true);
      expect(guard({ name: 'mcp_remote_cli_schedule_create', agent: f.agents.get('one') })).toContain('Scheduled turns');
      expect(guard({ name: 'schedule_create', agent: f.agents.get('one') })).toContain('managed');
      expect(guard({ name: 'read_file', agent: f.agents.get('one') })).toBeUndefined();
      f.finish('one', 1, 'x'.repeat(400000));
      expect(Buffer.byteLength(events.at(-1).output)).toBeLessThanOrEqual(256 * 1024);
    } finally { await f.close(); }
  });
});
