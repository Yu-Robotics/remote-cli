import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocketClient } from '../../src/client/WebSocketClient';
import { ScheduleDeliveryClient } from '../../src/scheduling/ScheduleDeliveryClient';
import type { ScheduleDelivery } from '../../src/scheduling/types';

describe('ScheduleDeliveryClient', () => {
  let client: ScheduleDeliveryClient;
  let ack: (id: string) => void;
  let close: () => void;
  let ws: { send: ReturnType<typeof vi.fn>; isConnected: ReturnType<typeof vi.fn>;
    onTaskResultAck: ReturnType<typeof vi.fn>; onClose: ReturnType<typeof vi.fn>; trackTask: ReturnType<typeof vi.fn> };
  let unsubscribeAck: ReturnType<typeof vi.fn>;
  let unsubscribeClose: ReturnType<typeof vi.fn>;
  let delivery: ScheduleDelivery;

  beforeEach(() => {
    vi.useFakeTimers();
    unsubscribeAck = vi.fn(); unsubscribeClose = vi.fn();
    ws = {
      send: vi.fn(() => true), isConnected: vi.fn(() => true), trackTask: vi.fn(),
      onTaskResultAck: vi.fn(handler => { ack = handler; return unsubscribeAck; }),
      onClose: vi.fn(handler => { close = handler; return unsubscribeClose; }),
    };
    delivery = { id: 'delivery-1', occurrenceId: 'occurrence-1', success: true, output: 'Scheduled output',
      schedule: { id: 'schedule-1', backend: 'claude', openId: 'owner-1', threadId: 'original-thread',
        generation: 'generation-1', cwd: path.resolve('project'), prompt: 'Review\n  the project',
        rule: { kind: 'once', at: '2026-12-01T00:00:00Z' }, createdAt: 1, state: 'completed' } };
    client = new ScheduleDeliveryClient(ws as unknown as WebSocketClient);
  });

  afterEach(() => { client.destroy(); vi.useRealTimers(); });

  it('sends the original routing and full output, waits for its receipt, and coalesces duplicates', async () => {
    const pending = client.deliver(delivery, 'Original thread');
    expect(client.deliver(delivery, 'Renamed thread')).toBe(pending);
    expect(ws.send).toHaveBeenCalledTimes(2);
    const [start, result] = ws.send.mock.calls.map(call => call[0]);
    expect(start).toMatchObject({ type: 'queue_started', messageId: delivery.id, openId: 'owner-1', threadId: 'original-thread',
      cwd: delivery.schedule.cwd, queueStarted: { source: 'schedule', scheduleId: 'schedule-1', threadName: 'Original thread',
        backend: 'claude', cwd: delivery.schedule.cwd, preview: 'Review the project', remainingCount: 0 } });
    expect(result).toMatchObject({ ...start, type: 'response', success: true, output: 'Scheduled output' });
    expect(ws.trackTask).not.toHaveBeenCalled();
    const settled = vi.fn(); void pending.then(settled);
    ack('wrong-id'); await Promise.resolve(); expect(settled).not.toHaveBeenCalled();
    ack(delivery.id); await pending;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts a synchronous response receipt without losing it', async () => {
    ws.send.mockImplementation(frame => { if (frame.type === 'response') ack(frame.messageId); return true; });
    await client.deliver(delivery, 'Thread');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('labels DSH results with their captured backend and rejects unsupported metadata', async () => {
    delivery.schedule.backend = 'dsh';
    const pending = client.deliver(delivery, 'Original thread');
    expect(ws.send.mock.calls.map(([frame]) => frame.queueStarted.backend)).toEqual(['dsh', 'dsh']);
    ack(delivery.id); await pending;
    ws.send.mockClear();
    (delivery.schedule as { backend: string }).backend = 'codex';
    await expect(client.deliver(delivery, 'Original thread')).rejects.toThrow('routing metadata');
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('ignores a premature receipt during the start frame', async () => {
    ws.send.mockImplementation(frame => { if (frame.type === 'queue_started') ack(frame.messageId); return true; });
    const pending = client.deliver(delivery, 'Thread');
    const rejected = expect(pending).rejects.toThrow('receipt timed out');
    await vi.advanceTimersByTimeAsync(15_000); await rejected;
  });

  it('rejects a missing receipt and permits an outbox retry with the same stable ID', async () => {
    const rejected = expect(client.deliver(delivery, 'Thread')).rejects.toThrow('receipt timed out');
    await vi.advanceTimersByTimeAsync(15_000); await rejected;
    const retried = client.deliver(delivery, 'Thread'); ack(delivery.id); await retried;
    expect(ws.send.mock.calls.map(call => call[0].messageId)).toEqual(Array(4).fill(delivery.id));
  });

  it('rejects disconnected sends and all in-flight results on disconnect', async () => {
    ws.isConnected.mockReturnValue(false);
    await expect(client.deliver(delivery, 'Thread')).rejects.toThrow('disconnected');
    expect(ws.send).not.toHaveBeenCalled();
    ws.isConnected.mockReturnValue(true);
    const one = expect(client.deliver(delivery, 'Thread')).rejects.toThrow('disconnected');
    const two = expect(client.deliver({ ...delivery, id: 'delivery-2' }, 'Thread')).rejects.toThrow('disconnected');
    close(); await Promise.all([one, two]); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['queue_started', 'response'])('rejects transport refusal during %s', async type => {
    ws.send.mockImplementation(frame => frame.type !== type);
    await expect(client.deliver(delivery, 'Thread')).rejects.toThrow('transport send failed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not resolve a synchronous receipt if the send then throws', async () => {
    ws.send.mockImplementation(frame => {
      if (frame.type === 'response') { ack(frame.messageId); throw new Error('Synthetic send failure'); }
      return true;
    });
    await expect(client.deliver(delivery, 'Thread')).rejects.toThrow('transport send failed');
  });

  it('does not send a response after shutdown during queue_started', async () => {
    ws.send.mockImplementation(() => { client.destroy(); return true; });
    await expect(client.deliver(delivery, 'Thread')).rejects.toThrow('shut down');
    expect(ws.send).toHaveBeenCalledOnce();
  });

  it('unsubscribes on destroy, rejects pending delivery, and refuses future delivery', async () => {
    const pending = expect(client.deliver(delivery, 'Thread')).rejects.toThrow('shut down');
    client.destroy(); client.destroy(); ack(delivery.id); await pending;
    expect(unsubscribeAck).toHaveBeenCalledOnce(); expect(unsubscribeClose).toHaveBeenCalledOnce();
    await expect(client.deliver(delivery, 'Thread')).rejects.toThrow('shut down');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds result, error and preview separately with an explicit truncation notice', async () => {
    delivery.output = 'o'.repeat(100_000); delivery.error = 'e'.repeat(100_000); delivery.success = false;
    delivery.schedule.prompt = 'p'.repeat(1000);
    const pending = client.deliver(delivery, 't'.repeat(200));
    const frame = ws.send.mock.calls[1][0];
    expect(frame.success).toBe(false);
    expect(frame.output.length).toBe(64 * 1024); expect(frame.error.length).toBe(64 * 1024);
    expect(frame.output).toContain('[Scheduled result truncated for delivery.]');
    expect(frame.error).toContain('[Scheduled result truncated for delivery.]');
    expect(frame.queueStarted.preview).toHaveLength(240); expect(frame.queueStarted.threadName).toHaveLength(100);
    ack(delivery.id); await pending;
  });

  it('refuses invalid routing metadata without truncating an identity', async () => {
    delivery.schedule.threadId = 't'.repeat(257);
    await expect(client.deliver(delivery, 'Thread')).rejects.toThrow('routing metadata');
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('bounds concurrent pending results without dropping existing receipts', async () => {
    const pending = Array.from({ length: 100 }, (_, index) => {
      const result = client.deliver({ ...delivery, id: `delivery-${index}` }, 'Thread');
      return expect(result).rejects.toThrow('shut down');
    });
    await expect(client.deliver({ ...delivery, id: 'overflow' }, 'Thread')).rejects.toThrow('Too many');
    client.destroy(); await Promise.all(pending);
  });
});
