import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { ChildProcess } from 'child_process';
import { DshNativeScheduleProvider, type DshNativeScheduleProviderOptions } from '../../src/scheduling/DshNativeScheduleProvider';
import { NativeScheduleCleanupError, type NativeScheduleEvent, type NativeScheduleInput } from '../../src/scheduling/types';
import { COMMAND, EVENT, MAX_FRAME, MAX_OUTPUT } from '../../src/scheduling/dsh/protocol';
import { DshFixture, flush } from './dshFixture';

let directory: string;
let fixtures: DshFixture[];
beforeEach(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-schedule-test-')));
  vi.spyOn(os, 'homedir').mockReturnValue(directory);
  fixtures = [];
});
afterEach(async () => {
  for (const fixture of fixtures) { fixture.exit(); await fixture.bridge.dispose().catch(() => {}); }
  await flush(); vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true });
});
function setup(options: DshNativeScheduleProviderOptions = {}) {
  const events: NativeScheduleEvent[] = [];
  const dispose = vi.fn(async () => {});
  const confirm = vi.fn(async () => {});
  let fixture!: DshFixture;
  let configure: ((fixture: DshFixture) => void) | undefined;
  const spawn = vi.fn(() => { fixture = new DshFixture(directory); fixtures.push(fixture); configure?.(fixture); return fixture as unknown as ChildProcess; });
  const provider = new DshNativeScheduleProvider({
    spawn, confirmProcessExit: confirm, managementTimeoutMs: 100, shutdownTimeoutMs: 5,
    launch: async () => ({ directory, scope: 'test-scope', args: ['--profile', 'acp'], env: {}, dispose }), ...options,
  });
  const input: NativeScheduleInput = { id: 'synthetic', cwd: directory, prompt: 'Synthetic task',
    rule: { kind: 'cron', expression: '*/5 * * * *', timezone: 'UTC' } };
  return { provider, input, events, dispose, confirm, spawn, get fixture() { return fixture; }, set configure(value: (fixture: DshFixture) => void) { configure = value; },
    create: (extra: Partial<NativeScheduleInput> = {}) => provider.create({ ...input, ...extra }, event => events.push(event)) };
}

describe('DSH provider and host bridge over shared ACP streams', () => {
  it('creates, lists, and deletes through native CRUD without a single prompt; preserves ACP configuration', async () => {
    const s = setup(); const handle = await s.create({ model: 'synthetic-model', effort: 'auto' });
    expect(handle.nativeId).toBe('schedule-native');
    expect(await handle.list()).toBe(true);
    const native = s.fixture.nativeReceived;
    expect(native.filter(frame => frame.method === 'session/prompt')).toEqual([]);
    expect(native.map(frame => frame.method)).toContain('session/new');
    expect(native.filter(frame => frame.method === 'session/set_config_option').map(frame => frame.params.value)).toEqual(['synthetic-model', '']);
    expect(s.fixture.guards[0]({ name: 'schedule_create' })).toMatch(/reserved/);
    expect(s.fixture.guards[0]({ name: 'schedule_update' })).toMatch(/reserved/);
    expect(s.fixture.guards[0]({ name: 'read_file' })).toBeUndefined();
    await handle.cancel();
    expect(s.fixture.rows).toEqual([]); expect(s.confirm).toHaveBeenCalledTimes(1); expect(s.dispose).toHaveBeenCalledTimes(1);
    expect(s.events.at(-1)).toMatchObject({ type: 'stopped', exitConfirmed: true });
    expect(await handle.list()).toBe(false); await handle.cancel(); await handle.stop();
    expect(s.dispose).toHaveBeenCalledTimes(1);
  });

  it('correlates distinct recurring turns and uses native output instead of late ACP chunks', async () => {
    const s = setup(); const handle = await s.create();
    const first = new Date(Date.now() - 2000).toISOString();
    s.fixture.start(first); s.fixture.complete('First native result');
    s.fixture.frame({ method: 'session/update', params: { sessionId: s.fixture.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { text: 'late duplicate' } } } });
    s.fixture.start(new Date(Date.now() - 1000).toISOString()); s.fixture.complete('Second native result', 'error');
    expect(s.events.filter(event => event.type === 'completed')).toMatchObject([
      { success: true, output: 'First native result', occurrenceId: `schedule-native:${first}` },
      { success: false, output: 'Second native result' },
    ]);
    expect(await handle.list()).toBe(true); await handle.stop();
  });

  it('keeps a fired one-shot listed while executing, then deletes storage after terminal completion', async () => {
    const at = new Date(Date.now() + 200).toISOString();
    const s = setup(); const handle = await s.create({ rule: { kind: 'once', at } });
    s.fixture.start(); expect(await handle.list()).toBe(true);
    s.fixture.complete(); await handle.stop();
    expect(s.events).toMatchObject([{ type: 'started' }, { type: 'completed', success: true }, { type: 'stopped', exitConfirmed: true }]);
    expect(s.fixture.rows).toEqual([]);
  });

  it.each(['tool-jobs', 'tool-registry'])('preserves occurrence identity through native %s context before and during a turn', async kind => {
    const s = setup(); const handle = await s.create();
    const context = (id: string) => s.fixture.hooks.emit('agent/inbox/claimed', {
      agent: s.fixture.agent, turn: 1, message: { id, source: { kind }, content: [{ type: 'text', text: 'Native context' }] },
    });
    context('context-before');
    const occurrenceAt = new Date(Date.now() - 1000).toISOString();
    s.fixture.start(occurrenceAt); context('context-during'); s.fixture.complete('Correlated result');
    expect(s.events.filter(event => event.type === 'started')).toHaveLength(1);
    expect(s.events.filter(event => event.type === 'completed')).toMatchObject([
      { occurrenceId: `schedule-native:${occurrenceAt}`, success: true, output: 'Correlated result' },
    ]);
    expect(s.fixture.extensions().some(event => event.kind === 'fatal')).toBe(false);
    expect(await handle.list()).toBe(true); await handle.stop();
  });

  it.each(['foreign-agent', 'wrong-turn', 'no-schedule'])('rejects native contextual input without a valid occurrence: %s', async fault => {
    const s = setup(); const handle = await s.create();
    if (fault !== 'no-schedule') s.fixture.start(new Date(Date.now() - 1000).toISOString());
    s.fixture.hooks.emit('agent/inbox/claimed', { agent: fault === 'foreign-agent' ? {} : s.fixture.agent,
      turn: fault === 'wrong-turn' ? 2 : 1, message: { id: 'context', source: { kind: 'tool-jobs' } } });
    if (fault === 'no-schedule') { s.fixture.turn = 1; s.fixture.complete('Unowned result'); }
    await handle.stop();
    expect(s.events.some(event => event.type === 'completed' && event.success)).toBe(false);
    expect(s.fixture.extensions().some(event => event.kind === 'fatal')).toBe(true);
  });

  it('cancels a running one-shot without mistaking aborted completion for success', async () => {
    const s = setup(); const handle = await s.create({ rule: { kind: 'once', at: new Date(Date.now() + 200).toISOString() } });
    s.fixture.start(); await handle.cancel();
    expect(s.events.find(event => event.type === 'completed')).toMatchObject({ success: false });
    expect(s.events.at(-1)).toMatchObject({ exitConfirmed: true });
  });

  it.each(['blocked', 'max-tokens', 'aborted', 'error'])('preserves non-success terminal outcome %s without raw native errors', async reason => {
    const s = setup(); const handle = await s.create();
    s.fixture.start(new Date(Date.now() - 1000).toISOString()); s.fixture.complete('Synthetic result', reason);
    expect(s.events.find(event => event.type === 'completed')).toMatchObject({ success: false }); await handle.stop();
  });

  it('bounds UTF-8 native output and reports truncation', async () => {
    const s = setup(); const handle = await s.create();
    s.fixture.start(new Date(Date.now() - 1000).toISOString()); s.fixture.complete('\u20ac'.repeat(MAX_OUTPUT));
    const event = s.events.find(event => event.type === 'completed');
    expect(event?.type === 'completed' && Buffer.byteLength(event.output!)).toBeLessThanOrEqual(MAX_OUTPUT);
    expect(event?.type === 'completed' && event.output).toMatch(/\[Output truncated\.\]$/);
    expect(event?.type === 'completed' && event.output).not.toContain('\ufffd'); await handle.stop();
  });

  it.each(['scope', 'sequence', 'version', 'sessionId', 'nativeId', 'turn', 'messageId', 'occurrenceAt'])('fails closed on forged occurrence %s', async key => {
    const s = setup(); const handle = await s.create();
    s.fixture.mutateFrame = frame => { if (frame.method === EVENT && frame.params.kind === 'started') frame.params[key] = key === 'turn' ? 0 : key === 'messageId' ? '../invalid' : 'wrong'; };
    s.fixture.start(new Date(Date.now() - 1000).toISOString()); await handle.stop();
    expect(s.events.some(event => event.type === 'started')).toBe(false);
    expect(s.events.at(-1)).toMatchObject({ exitConfirmed: true });
  });

  it.each(['duplicate', 'unclaimed', 'wrong-turn', 'oversized-output'])('rejects ambiguous terminal events: %s', async fault => {
    const s = setup(); const handle = await s.create();
    s.fixture.start(new Date(Date.now() - 1000).toISOString());
    if (fault === 'wrong-turn') s.fixture.mutateFrame = frame => { if (frame.params?.kind === 'completed') frame.params.turn++; };
    if (fault === 'oversized-output') s.fixture.mutateFrame = frame => { if (frame.params?.kind === 'completed') frame.params.output = 'x'.repeat(MAX_OUTPUT + 1); };
    s.fixture.complete();
    if (fault === 'duplicate' || fault === 'unclaimed') {
      const terminal = s.fixture.extensions().find(p => p.kind === 'completed');
      s.fixture.frame({ method: EVENT, params: { ...terminal, sequence: terminal.sequence + 1, messageId: fault === 'unclaimed' ? 'foreign' : terminal.messageId } });
    }
    await handle.stop(); expect(s.events.filter(e => e.type === 'completed' && e.success).length).toBeLessThanOrEqual(1);
  });

  it.each(['create', 'bind', 'list', 'cancel'])('times out missing %s receipts and stops the owned process', async operation => {
    const s = setup({ managementTimeoutMs: 15 });
    if (operation === 'create' || operation === 'bind') {
      s.configure = fixture => { fixture.drop = operation; }; const creating = s.create();
      await expect(creating).rejects.toThrow(/failed|timed out/);
    } else {
      const handle = await s.create(); s.fixture.drop = operation;
      await expect(operation === 'list' ? handle.list() : handle.cancel()).rejects.toThrow(); await handle.stop();
    }
    expect(s.dispose).toHaveBeenCalled();
  });

  it('retains the cleanup handle and storage until OS exit proof succeeds', async () => {
    let permit = false;
    const s = setup({ confirmProcessExit: async () => { if (!permit) throw new Error('Unconfirmed'); } });
    s.configure = fixture => { fixture.failCreate = true; }; const creating = s.create();
    let failure: unknown; try { await creating; } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(NativeScheduleCleanupError); expect(s.dispose).not.toHaveBeenCalled();
    expect(s.events.at(-1)).toMatchObject({ exitConfirmed: false });
    permit = true; await (failure as NativeScheduleCleanupError).handle.stop(); expect(s.dispose).toHaveBeenCalledTimes(1);
  });

  it('retains an explicit stop failure for retry when signals cannot prove child exit', async () => {
    const s = setup(); const handle = await s.create(); s.fixture.graceful = false; s.fixture.killOn = undefined;
    await expect(handle.stop()).rejects.toThrow(/unconfirmed/);
    expect(s.fixture.signals).toEqual(['SIGTERM', 'SIGKILL']); expect(s.dispose).not.toHaveBeenCalled();
    s.fixture.exit(); await handle.stop(); expect(s.dispose).toHaveBeenCalled();
  });

  it('escalates to kill and never equates a successful signal call with exit', async () => {
    const s = setup(); const handle = await s.create(); s.fixture.graceful = false; s.fixture.killOn = 'SIGKILL';
    await handle.stop(); expect(s.fixture.signals).toEqual(['SIGTERM', 'SIGKILL']); expect(s.confirm).toHaveBeenCalled();
  });

  it('reports process death during a turn as a failed occurrence', async () => {
    const s = setup(); const handle = await s.create();
    s.fixture.start(new Date(Date.now() - 1000).toISOString()); s.fixture.exit(); await handle.stop();
    expect(s.events.find(event => event.type === 'completed')).toMatchObject({ success: false, error: expect.stringMatching(/before completion/) });
  });

  it('rejects incorrect native rule receipts and removes the native row', async () => {
    const s = setup(); s.configure = fixture => { fixture.changeRecord = row => { row.timeZone = 'Asia/Tokyo'; }; }; const creating = s.create();
    await expect(creating).rejects.toThrow(); expect(s.fixture.rows).toEqual([]);
  });

  it('refuses a second native session and unexpected jobs', async () => {
    const s = setup(); const handle = await s.create();
    s.fixture.hooks.emit('session/created', { id: 'foreign-session', header: { cwd: directory } });
    await handle.stop(); expect(s.events.at(-1)).toMatchObject({ exitConfirmed: true });
  });

  it('denies approval requests and never echoes provider errors', async () => {
    const s = setup(); const handle = await s.create();
    s.fixture.frame({ id: 'permission', method: 'session/request_permission', params: { sessionId: s.fixture.sessionId } });
    expect(s.fixture.nativeReceived.at(-1)).toMatchObject({ id: 'permission', result: { outcome: { outcome: 'cancelled' } } });
    s.fixture.frame({ id: 'unknown', method: 'terminal/create', params: {} });
    expect(s.fixture.nativeReceived.at(-1)).toMatchObject({ error: { code: -32601 } });
    s.fixture.frame({ id: 99, error: { message: 'synthetic-private-error' } }); await handle.stop();
    expect(JSON.stringify(s.events)).not.toContain('synthetic-private-error');
  });

  it.each(['null\n', 'invalid\n', 'x'.repeat(MAX_FRAME + 1)])('rejects malformed or oversized native frames', async data => {
    const s = setup(); const handle = await s.create(); s.fixture.stdout.write(data); await handle.stop();
    expect(s.events.at(-1)).toMatchObject({ exitConfirmed: true });
  });

  it('handles callback exceptions without losing process ownership', async () => {
    const s = setup();
    const handle = await s.provider.create(s.input, () => { throw new Error('Callback failed'); });
    s.fixture.start(new Date(Date.now() - 1000).toISOString()); await handle.stop(); expect(s.dispose).toHaveBeenCalled();
  });

  it.each(['malformed', 'fatal'])('rejects completion after %s output invalidates the transport', async fault => {
    const s = setup(); const handle = await s.create();
    s.fixture.start(new Date(Date.now() - 1000).toISOString());
    const started = s.fixture.extensions().find(p => p.kind === 'started');
    const terminal = JSON.stringify({ jsonrpc: '2.0', method: EVENT, params: {
      ...started, sequence: started.sequence + (fault === 'fatal' ? 2 : 1), kind: 'completed', success: true, output: 'Untrusted late result',
    } }) + '\n';
    if (fault === 'fatal') {
      // The next frame can be in the same native stdout chunk.
      s.fixture.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: EVENT, params: {
        ...started, sequence: started.sequence + 1, kind: 'fatal',
      } }) + '\n' + terminal);
    } else { s.fixture.stdout.write('invalid\n'); s.fixture.stdout.write(terminal); }
    await handle.stop();
    expect(s.events.filter(event => event.type === 'completed')).toMatchObject([{ success: false }]);
    expect(JSON.stringify(s.events)).not.toContain('Untrusted late result');
    expect(s.events.at(-1)).toMatchObject({ exitConfirmed: true });
  });

  it('handles asynchronous spawn errors and cleans launch data', async () => {
    const s = setup(); s.configure = fixture => { queueMicrotask(() => fixture.emit('error', new Error('synthetic-private-error'))); }; const creating = s.create();
    await expect(creating).rejects.toThrow(); expect(s.dispose).toHaveBeenCalled();
  });

  it('sanitizes synchronous spawn failures and disposes unused storage', async () => {
    const s = setup({ spawn: () => { throw new Error('synthetic-private-error'); } });
    await expect(s.create()).rejects.toThrow('Native DSH schedule process could not start.'); expect(s.dispose).toHaveBeenCalled();
  });

  it('buffers a native occurrence that races the create receipt without losing ownership', async () => {
    const s = setup();
    s.configure = fixture => { fixture.duringCreate = () => { fixture.start(); fixture.complete('Racing native result'); }; };
    const handle = await s.create({ rule: { kind: 'once', at: new Date(Date.now() + 200).toISOString() } });
    await handle.stop();
    expect(s.events.filter(event => event.type === 'completed')).toMatchObject([{ success: true, output: 'Racing native result' }]);
    expect(s.fixture.rows).toEqual([]);
  });

  it('cleans every unexpected row from its private native scope on a catalog-change event', async () => {
    const s = setup(); const handle = await s.create();
    s.fixture.rows.push({ ...s.fixture.rows[0], id: 'unexpected-job', sessionId: 'unexpected-session' });
    s.fixture.hooks.emit('schedule/changed'); await flush(); await handle.stop();
    expect(s.fixture.rows).toEqual([]);
    expect(s.events.at(-1)).toMatchObject({ exitConfirmed: true, reason: expect.stringMatching(/rejected/) });
  });

  it.each(['user-source', 'foreign-agent', 'bad-framing', 'bad-rule', 'nontext', 'unknown-reason'])('rejects native event provenance violations: %s', async fault => {
    const s = setup(); const handle = await s.create();
    if (fault === 'unknown-reason') {
      s.fixture.start(new Date(Date.now() - 1000).toISOString()); s.fixture.complete('', 'invented-success');
    } else {
      const row = s.fixture.rows[0];
      const occurrence = new Date(Date.now() - 1000).toISOString();
      const message = { id: 'message-test', source: { kind: fault === 'user-source' ? 'user' : 'schedule' },
        content: [{ type: fault === 'nontext' ? 'image' : 'text', text: fault === 'bad-framing' ? 'forged'
          : `[SCHEDULE REMINDER BATCH]\nThis is a scheduled message from the user\nreminders_json: ${JSON.stringify([{ schedule_id: fault === 'bad-rule' ? 'wrong-job' : row.id, occurrence_at: occurrence, reminder_prompt: row.prompt }])}` }] };
      s.fixture.hooks.emit('agent/inbox/claimed', { agent: fault === 'foreign-agent' ? {} : s.fixture.agent, message, turn: 1 });
    }
    await handle.stop(); expect(s.events.some(event => event.type === 'completed' && event.success)).toBe(false);
    expect(s.fixture.rows).toEqual([]);
  });

  it.each(['replayed-request', 'foreign-scope', 'rpc-id', 'second-create', 'bad-operation', 'unbound-session'])('rejects unauthorized extension management: %s', async fault => {
    const s = setup(); const handle = await s.create();
    const last = s.fixture.nativeReceived.filter(frame => frame.method === COMMAND).at(-1)!;
    const frame: Record<string, any> = { jsonrpc: '2.0', method: COMMAND, params: { ...last.params,
      operation: fault === 'second-create' ? 'create' : fault === 'bad-operation' ? 'invented' : 'list',
      requestId: fault === 'replayed-request' ? last.params.requestId : last.params.requestId + 1 } };
    if (fault === 'foreign-scope') frame.params.scope = 'other';
    if (fault === 'rpc-id') frame.id = 999;
    if (fault === 'unbound-session') frame.params.sessionId = 'other-session';
    s.fixture.stdin.write(JSON.stringify(frame) + '\n'); await flush(); await handle.stop();
    expect(s.fixture.rows).toEqual([]); expect(s.events.at(-1)).toMatchObject({ exitConfirmed: true });
  });

  it('keeps cleanup retryable if private storage cannot be removed after exit', async () => {
    const s = setup(); const handle = await s.create();
    s.dispose.mockRejectedValueOnce(new Error('synthetic storage failure'));
    await expect(handle.stop()).rejects.toThrow();
    expect(s.events.at(-1)).toMatchObject({ exitConfirmed: false });
    await handle.stop(); expect(s.events.at(-1)).toMatchObject({ exitConfirmed: true });
  });

  it('stops after native deletion failure without exposing the private diagnostic', async () => {
    const s = setup(); const handle = await s.create(); s.fixture.failDelete = true;
    await expect(handle.cancel()).rejects.toThrow();
    expect(s.dispose).toHaveBeenCalled(); expect(JSON.stringify(s.events)).not.toContain('synthetic-private-error');
    s.fixture.failDelete = false;
  });

  it.each([
    { prompt: '' }, { id: '../escape' }, { cwd: 'missing-directory' }, { command: 'bad\ncommand' },
    { rule: { kind: 'once', at: '2000-01-01T00:00:00Z' } },
    { rule: { kind: 'cron', expression: '* * * * * *', timezone: 'UTC' } },
    { rule: { kind: 'cron', expression: '* * * * *', timezone: 'invalid-zone' } },
  ])('rejects invalid input before spawning: %j', async extra => {
    const s = setup(); await expect(s.create(extra as Partial<NativeScheduleInput>)).rejects.toThrow(); expect(s.spawn).not.toHaveBeenCalled();
  });
});
