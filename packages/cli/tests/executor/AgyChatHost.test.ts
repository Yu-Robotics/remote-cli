import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgyChatHost } from '../../src/executor/agy/AgyChatHost';
import type { AcpTransport } from '../../src/executor/acp/AcpClient';
import type { TranscriptRecord } from '../../src/scheduling/agy/transcript';
function fixture() {
  let finish!: (value: { stopReason: string }) => void;
  const client = { prompt: vi.fn(() => new Promise<{ stopReason: string }>(resolve => { finish = resolve; })), sendCancel: vi.fn() };
  const host = new AgyChatHost(client as unknown as AcpTransport, 'synthetic-session', 'synthetic-cwd', 'synthetic-thread');
  const rows: TranscriptRecord[] = [];
  const hook = (event: string, extra: Record<string, unknown> = {}) => host.accept(event, {
    conversationId: 'synthetic-session', cwd: 'synthetic-cwd', hookEventName: event,
    invocationNum: 0, initialNumSteps: 0, ...extra,
  }, rows);
  const terminal = (reason = 'NO_TOOL_CALL') => {
    rows.push({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Synthetic result' });
    hook('PostInvocation'); hook('Stop', { terminationReason: reason, error: reason === 'ERROR' ? 'synthetic failure' : '' });
    finish({ stopReason: 'end_turn' });
  };
  return { client, host, rows, hook, terminal, finish: (reason: string) => finish({ stopReason: reason }) };
}
afterEach(() => vi.useRealTimers());
describe('AGY ordinary ACP terminal and reuse policy', () => {
  it.each(['NO_TOOL_CALL', 'ERROR'])('keeps native %s authoritative over ACP end_turn', async reason => {
    const f = fixture(); const pending = f.host.prompt([{ type: 'text', text: 'Synthetic task' }]);
    f.hook('PreInvocation'); f.terminal(reason);
    expect(await pending).toMatchObject({ success: reason === 'NO_TOOL_CALL', output: 'Synthetic result' });
  });
  it.each(['schedule', 'manage_task'])('denies native %s without a management operation', name => {
    const f = fixture();
    expect(f.hook('PreToolUse', { stepIdx: 0, toolCall: { id: 'synthetic-call', name, args: {} } }).decision).toBe('deny');
  });
  it.each(['schedule', 'manage_task'])('permanently fences requested %s denial even after successful native terminal', async name => {
    const f = fixture(); const pending = f.host.prompt([]); f.hook('PreInvocation');
    expect(f.hook('PreToolUse', { stepIdx: 0, toolCall: { id: 'synthetic-call', name, args: {} } }).decision).toBe('deny');
    f.rows.push({ step_index: 0, source: 'MODEL', type: 'GENERIC', status: 'DONE',
      content: 'Tool is running as a background task with task id: synthetic-session/task-0\nTask Description: synthetic work\nTask logs are available at: file://synthetic/log' });
    f.terminal(); await expect(pending).rejects.toThrow(); expect(f.host.reusable).toBe(false);
    await expect(f.host.prompt([])).rejects.toThrow(); expect(f.client.prompt).toHaveBeenCalledOnce();
  });
  it('fences a DONE creation receipt even with an observed ordinary tool', async () => {
    const f = fixture(); const pending = f.host.prompt([]); f.hook('PreInvocation');
    f.hook('PreToolUse', { stepIdx: 0, toolCall: { id: 'synthetic-call', name: 'run_command', args: {} } });
    f.rows.push({ step_index: 0, source: 'MODEL', type: 'GENERIC', status: 'DONE',
      content: 'Tool is running as a background task with task id: synthetic-session/task-0\nTask Description: synthetic work\nTask logs are available at: file://synthetic/log' });
    f.terminal(); await expect(pending).rejects.toThrow(); expect(f.host.reusable).toBe(false);
  });
  it('keeps ordinary observed settled tools reusable', async () => {
    const f = fixture(); const pending = f.host.prompt([]); f.hook('PreInvocation');
    f.hook('PreToolUse', { stepIdx: 0, toolCall: { id: 'synthetic-call', name: 'run_command', args: {} } });
    f.rows.push({ step_index: 0, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'Synthetic settled result' });
    f.terminal(); expect((await pending).success).toBe(true); expect(f.host.reusable).toBe(true);
  });
  it('fences a completed tool whose hook was never observed', async () => {
    const f = fixture(); const pending = f.host.prompt([]); f.hook('PreInvocation');
    f.rows.push({ step_index: 0, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'Unobserved effect' });
    f.terminal(); await expect(pending).rejects.toThrow('hook coverage'); expect(f.host.reusable).toBe(false);
    await expect(f.host.prompt([])).rejects.toThrow(); expect(f.client.prompt).toHaveBeenCalledOnce();
  });
  it('requires a correlated hook terminal and preserves the fence', async () => {
    const f = fixture(); const pending = f.host.prompt([]); f.finish('end_turn');
    await expect(pending).rejects.toThrow('terminal is missing'); expect(f.host.reusable).toBe(false);
  });
  it('accepts confirmed cancellation without treating side effects as reverted', async () => {
    const f = fixture(); const pending = f.host.prompt([]); expect(f.host.cancelForeground()).toBe(true);
    expect(f.host.cancelForeground()).toBe(false); f.finish('cancelled');
    expect(await pending).toMatchObject({ success: false, stopReason: 'cancelled' });
    const next = f.host.prompt([]); f.hook('PreInvocation'); f.terminal(); expect((await next).success).toBe(true);
  });
  it('does not remove hook uncertainty on cancellation', async () => {
    const f = fixture(); const pending = f.host.prompt([]); f.host.fence('Synthetic uncertain effect');
    f.host.cancelForeground(); f.finish('cancelled'); await expect(pending).rejects.toThrow('uncertain effect');
    expect(f.host.reusable).toBe(false);
  });
  it('bounds a missing cancellation terminal and refuses a successor', async () => {
    vi.useFakeTimers(); const f = fixture(); const pending = f.host.prompt([]);
    const rejected = expect(pending).rejects.toThrow('unconfirmed'); f.host.cancelForeground();
    await vi.advanceTimersByTimeAsync(5000); await rejected; expect(f.host.reusable).toBe(false);
    expect(f.client.sendCancel).toHaveBeenCalledWith('synthetic-session');
  });
  it('does not qualify a running native tool for cross-task reuse', async () => {
    const f = fixture(); const pending = f.host.prompt([]); f.hook('PreInvocation');
    f.hook('PreToolUse', { stepIdx: 0, toolCall: { id: 'tool', name: 'run_command', args: {} } });
    f.rows.push({ step_index: 0, source: 'MODEL', type: 'GENERIC', status: 'RUNNING' });
    f.terminal(); await pending; expect(f.host.reusable).toBe(false);
    await expect(f.host.prompt([])).rejects.toThrow('unsettled native work');
  });
});

it('fences denial even when no creation receipt or unfinished row is ever reported', async () => {
  const f = fixture(); const pending = f.host.prompt([]); f.hook('PreInvocation');
  expect(f.hook('PreToolUse', { stepIdx: 0, toolCall: { id: 'synthetic-call', name: 'manage_task', args: {} } }).decision).toBe('deny');
  f.terminal(); await expect(pending).rejects.toThrow('denial enforcement'); expect(f.host.reusable).toBe(false);
});
