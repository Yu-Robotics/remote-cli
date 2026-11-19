import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AcpTransport } from '../../src/executor/acp/AcpClient';
import { AgyScheduleHost } from '../../src/scheduling/agy/AgyScheduleHost';

function harness() {
  const admission = {};
  const client = { sessionAdmission: vi.fn((): object | undefined => admission), prompt: vi.fn(async () => ({ stopReason: 'end_turn' })), sendCancel: vi.fn(),
    destroy: vi.fn(), waitForExit: vi.fn(async () => {}) };
  const host = new AgyScheduleHost(client as unknown as AcpTransport, 'synthetic-session', {
    threadId: 'synthetic-thread', cwd: process.cwd(), timezone: 'UTC', isCurrent: () => true,
  });
  return { host, client };
}
describe('AGY shared original ACP host lifecycle', () => {
  afterEach(() => vi.useRealTimers());
  it('refuses restored sessions before any management inference and fences later configuration changes', async () => {
    const { host, client } = harness(); client.sessionAdmission.mockReturnValue(undefined);
    expect(() => new AgyScheduleHost(client as unknown as AcpTransport, 'synthetic-session', {
      threadId: 'synthetic-thread', cwd: process.cwd(), timezone: 'UTC', isCurrent: () => true,
    })).toThrow('unrestored');
    await expect(host.qualify()).rejects.toThrow('ownership'); expect(client.prompt).not.toHaveBeenCalled();
  });
  it('uses original session and hook-projected output, never buffered autonomous ACP text', async () => {
    const { host, client } = harness();
    vi.spyOn(host.schedules, 'endForeground').mockReturnValue({ success: true, output: 'Current hook result' });
    expect(await host.prompt([{ type: 'text', text: 'Current foreground' }])).toEqual({ success: true, output: 'Current hook result', stopReason: 'end_turn' });
    expect(client.prompt).toHaveBeenCalledWith('synthetic-session', [{ type: 'text', text: 'Current foreground' }]);
  });
  it('cancels only an active foreground once and fences future management before the ACP terminal', async () => {
    const { host, client } = harness(); let resolve!: (value: { stopReason: string }) => void;
    client.prompt.mockImplementation(() => new Promise(done => { resolve = done; }));
    expect(host.cancelForeground()).toBe(false);
    const prompt = host.prompt([{ type: 'text', text: 'Synthetic long turn' }]);
    expect(host.cancelForeground()).toBe(true); expect(host.cancelForeground()).toBe(false);
    expect(client.sendCancel).toHaveBeenCalledOnce(); expect(client.sendCancel).toHaveBeenCalledWith('synthetic-session');
    expect(client.destroy).not.toHaveBeenCalled();
    await expect(host.qualify()).rejects.toThrow('queued');
    resolve({ stopReason: 'cancelled' });
    expect(await prompt).toMatchObject({ success: false, stopReason: 'cancelled' });
    await expect(host.prompt([{ type: 'text', text: 'No automatic nudge' }])).rejects.toThrow('queued');
    expect(client.prompt).toHaveBeenCalledOnce();
  });
  it('fences the host when a native foreground prompt rejects', async () => {
    const { host, client } = harness();
    client.prompt.mockRejectedValue(new Error('Synthetic cancellation failure'));
    await expect(host.prompt([{ type: 'text', text: 'Work' }])).rejects.toThrow('failure');
    expect(host.schedules.status.blocked).toContain('uncertain');
    expect(client.destroy).not.toHaveBeenCalled();
  });
  it('bounds a missing cancel terminal while retaining the host and refusing automatic prompts', async () => {
    vi.useFakeTimers(); const { host, client } = harness();
    client.prompt.mockImplementation(() => new Promise(() => {}));
    const prompt = host.prompt([{ type: 'text', text: 'Synthetic held foreground' }]);
    host.cancelForeground();
    const rejected = expect(prompt).rejects.toThrow('terminal remains unconfirmed');
    await vi.advanceTimersByTimeAsync(5000); await rejected;
    expect(client.destroy).not.toHaveBeenCalled();
    await expect(host.prompt([{ type: 'text', text: 'No retry' }])).rejects.toThrow('queued');
    expect(client.prompt).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it('requires observed foreground Stop output even after an ACP end_turn result', async () => {
    const { host } = harness();
    await expect(host.prompt([{ type: 'text', text: 'Work' }])).rejects.toThrow('unconfirmed');
    expect(host.schedules.status.blocked).toBeTruthy();
  });
  it('bounds retirement and does not turn timeout or process closure into a restart capability', async () => {
    const { host, client } = harness(); client.waitForExit.mockImplementation(() => new Promise(() => {}));
    await expect(host.close(5)).rejects.toThrow('unconfirmed');
    await expect(host.qualify()).rejects.toThrow();
    await expect(host.prompt([{ type: 'text', text: 'After unconfirmed exit' }])).rejects.toThrow('closing');
    expect(client.prompt).not.toHaveBeenCalled();
    expect(client.destroy).toHaveBeenCalledOnce();
  });
});
