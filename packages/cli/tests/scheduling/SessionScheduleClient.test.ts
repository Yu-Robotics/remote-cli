import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionScheduleClient } from '../../src/scheduling/dsh/SessionScheduleClient';
import { MAX_OUTPUT } from '../../src/scheduling/dsh/protocol';
import { NativeScheduleCleanupError } from '../../src/scheduling/types';

const input = { id: 'job', backend: 'dsh' as const, cwd: process.cwd(), prompt: 'Synthetic prompt',
  rule: { kind: 'cron' as const, expression: '* * * * *', timezone: 'UTC' } };
function fixture() {
  const sent: any[] = [];
  const client = new SessionScheduleClient('scope', (_method, params) => { sent.push(params); });
  const reply = (result: any, error?: string) => client.receive({ version: 2, scope: 'scope', kind: 'receipt',
    requestId: sent.at(-1).requestId, result, error });
  const event = (event: any, sessionId = 'session') => client.receive({ version: 2, scope: 'scope', kind: 'event', id: 'job', sessionId, event });
  const created = async (emit = vi.fn()) => {
    const pending = client.create('session', input, emit);
    reply({ ready: true, sessionId: 'session' }); await Promise.resolve();
    reply({ nativeId: 'native', sessionId: 'session' }); return pending;
  };
  return { client, sent, reply, event, created };
}
afterEach(() => { vi.useRealTimers(); });
describe('session schedule receipts', () => {
  it('validates scope/session, deduplicates occurrences, and rejects malformed output', async () => {
    const f = fixture(), emit = vi.fn();
    await f.created(emit);
    expect(f.client.receive({ version: 2, scope: 'foreign' })).toBe(false);
    f.event({ type: 'started', occurrenceId: 'one' }, 'other');
    expect(emit).not.toHaveBeenCalled();
    f.event({ type: 'started', occurrenceId: 'one' }); f.event({ type: 'started', occurrenceId: 'one' });
    f.event({ type: 'completed', occurrenceId: 'one', success: true, output: 'done' });
    f.event({ type: 'completed', occurrenceId: 'one', success: true, output: 'done' });
    expect(emit).toHaveBeenCalledTimes(2);
    f.event({ type: 'completed', occurrenceId: 'unclaimed', success: true, output: 'unexpected' });
    expect(emit).toHaveBeenCalledTimes(2); f.client.close();
  });
  it('retains started work across cancel acknowledgement and rejects later starts synchronously', async () => {
    const f = fixture(), emit = vi.fn(), handle = await f.created(emit);
    expect(handle.cancellationKeepsRunning).toBe(true);
    f.event({ type: 'started', occurrenceId: 'first' });
    f.event({ type: 'started', occurrenceId: 'second' });
    const cancel = handle.cancel();
    f.reply({ deleted: true });
    // Same transport chunk: no promise continuation has run yet.
    f.event({ type: 'started', occurrenceId: 'too-late' });
    f.event({ type: 'completed', occurrenceId: 'first', success: true, output: 'first result' });
    f.event({ type: 'completed', occurrenceId: 'first', success: true, output: 'duplicate' });
    expect((f.client as any).jobs.size).toBe(1);
    f.event({ type: 'completed', occurrenceId: 'second', success: true, output: 'second result' });
    await cancel;
    expect(emit.mock.calls.map(([event]) => event.type)).toEqual(['started', 'started', 'completed', 'completed']);
    expect((f.client as any).jobs.size).toBe(0);
    expect(await handle.list()).toBe(false);
    await handle.stop(); f.client.close();
    expect(emit).toHaveBeenCalledTimes(4);
  });
  it('delivers a terminal while cancellation is pending and retires after its receipt', async () => {
    const f = fixture(), emit = vi.fn(), handle = await f.created(emit);
    f.event({ type: 'started', occurrenceId: 'one' });
    const cancel = handle.cancel();
    f.event({ type: 'completed', occurrenceId: 'one', success: false, output: 'partial', error: 'Synthetic failure' });
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'completed', success: false }));
    expect((f.client as any).jobs.size).toBe(1);
    f.reply({ deleted: true }); await cancel;
    expect((f.client as any).jobs.size).toBe(0); f.client.close();
  });
  it.each([
    { success: 'true', output: 'invalid' },
    { success: true, output: null },
    { success: true, output: 'x'.repeat(MAX_OUTPUT + 1) },
    { success: true, output: 'invalid', error: {} },
    { success: true, output: 'invalid', error: 'x'.repeat(MAX_OUTPUT + 1) },
  ])('does not consume a running occurrence for malformed terminal payload %#', async payload => {
    const f = fixture(), emit = vi.fn(), handle = await f.created(emit);
    f.event({ type: 'started', occurrenceId: 'one' });
    const cancel = handle.cancel(); f.reply({ deleted: true }); await cancel;
    f.event({ type: 'completed', occurrenceId: 'one', ...payload });
    expect(emit).toHaveBeenCalledTimes(1);
    expect((f.client as any).jobs.size).toBe(1);
    f.event({ type: 'completed', occurrenceId: 'one', success: true, output: 'valid' });
    expect(emit).toHaveBeenLastCalledWith({ type: 'completed', occurrenceId: 'one', success: true, output: 'valid' });
    expect((f.client as any).jobs.size).toBe(0); f.client.close();
  });
  it('keeps running ownership when cancellation is unconfirmed, permitting cleanup retry', async () => {
    const f = fixture(), emit = vi.fn(), handle = await f.created(emit);
    const cancel = handle.cancel();
    const rejected = expect(cancel).rejects.toThrow('unconfirmed');
    f.reply({ deleted: false }); await rejected;
    f.event({ type: 'started', occurrenceId: 'one' });
    expect(emit).toHaveBeenCalledTimes(1);
    const retry = handle.cancel(); f.reply({ deleted: true }); await retry;
    f.event({ type: 'completed', occurrenceId: 'one', success: true, output: 'retained' });
    expect(emit).toHaveBeenCalledTimes(2); f.client.close();
  });
  it('retains the job cleanup handle after a lost create receipt and failed deletion', async () => {
    vi.useFakeTimers(); const f = fixture();
    const creating = f.client.create('session', input, () => {}).catch(error => error);
    f.reply({ ready: true, sessionId: 'session' }); await Promise.resolve();
    await vi.advanceTimersByTimeAsync(30001);
    expect(f.sent.at(-1).operation).toBe('cancel');
    f.reply(undefined, 'synthetic deletion failure');
    const error = await creating;
    expect(error).toBeInstanceOf(NativeScheduleCleanupError);
    const retry = error.handle.stop(); f.reply({ deleted: true }); await retry;
    f.client.close();
  });
  it('does not mistake bridge failure for process exit and permits explicit cleanup', async () => {
    const f = fixture(), emit = vi.fn(); const handle = await f.created(emit);
    f.client.receive({ version: 2, scope: 'scope', kind: 'fatal' });
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'stopped', exitConfirmed: false }));
    const cancelled = handle.cancel(); f.reply({ deleted: true }); await cancelled;
    expect(await handle.list()).toBe(false); f.client.close();
  });
  it('rejects transport write failure before native creation and clears deadlines', async () => {
    vi.useFakeTimers();
    const client = new SessionScheduleClient('scope', () => { throw new Error('Synthetic transport failure'); });
    await expect(client.create('session', input, () => {})).rejects.toThrow('transport write');
    expect(vi.getTimerCount()).toBe(0); client.close();
  });
});
