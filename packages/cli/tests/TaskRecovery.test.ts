import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskRecovery } from '../src/client/TaskRecovery';

describe('TaskRecovery', () => {
  const task = { messageId: 'm1', openId: 'u1', threadId: 't1', threadName: 'default',
    backend: 'claude', cwd: '/workspace', preview: 'Review this change' };
  let send: ReturnType<typeof vi.fn>;
  let recovery: TaskRecovery;
  const stream = (chunk: string, messageId = 'm1') => ({ type: 'stream', messageId, streamType: 'text', chunk });
  const result = (messageId = 'm1') => ({ type: 'response', messageId, success: true, output: 'entire transcript' });
  const resumes = () => send.mock.calls.map(([message]) => message).filter(message => message.type === 'task_resume');
  const acknowledge = (message = resumes().at(-1), success = true) => recovery.acknowledge({
    type: 'task_resume_ack', messageId: message.messageId, recoveryId: message.taskResume.recoveryId,
    state: message.taskResume.state, success,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    send = vi.fn();
    recovery = new TaskRecovery(send);
    recovery.registered(true);
    recovery.track(task);
  });
  afterEach(() => { recovery.destroy(); vi.useRealTimers(); });

  it('drops disconnected output and waits for a recovery card before resuming new output', () => {
    recovery.send(stream('before'));
    recovery.disconnected();
    for (let index = 0; index < 1000; index++) recovery.send(stream('lost output'));
    recovery.registered(true);
    recovery.send(stream('card not ready'));
    expect(send.mock.calls.map(([message]) => message.chunk).filter(Boolean)).toEqual(['before']);
    expect(resumes()).toHaveLength(1);
    expect(resumes()[0]).toMatchObject({ messageId: 'm1', taskResume: { state: 'running', cwd: '/workspace' } });
    acknowledge();
    recovery.send(stream('after'));
    recovery.send({ type: 'stream', messageId: 'm1', streamType: 'plan_mode', planContent: 'old plan' });
    recovery.send({ type: 'structured', messageId: 'm1', content: 'old body' });
    recovery.send(result());
    expect(send.mock.calls.map(([message]) => message.chunk).filter(Boolean)).toEqual(['before', 'after']);
    expect(send.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'response', success: true, output: undefined });
    expect(JSON.stringify(send.mock.calls)).not.toMatch(/lost output|card not ready|old plan|old body|entire transcript/);
    recovery.acknowledge({ type: 'task_result_ack', messageId: 'm1' });
    expect(recovery.hasPendingResults()).toBe(false);
  });

  it.each([true, false])('reports an offline terminal state without its transcript (success=%s)', success => {
    recovery.disconnected();
    recovery.send({ ...result(), success, error: success ? undefined : 'Backend failed' });
    expect(recovery.hasPendingResults()).toBe(true);
    recovery.registered(true);
    expect(resumes()[0].taskResume).toMatchObject({ state: success ? 'completed' : 'failed',
      error: success ? undefined : 'Backend failed' });
    expect(JSON.stringify(resumes())).not.toContain('entire transcript');
    acknowledge();
    expect(recovery.hasPendingResults()).toBe(false);
  });

  it('serializes recovery for tasks that started offline, including completion during card creation', () => {
    recovery.disconnected();
    recovery.track({ ...task, messageId: 'm2', threadId: 't2' });
    recovery.send({ type: 'queue_started', messageId: 'm2', queueStarted: { preview: 'queued task' } });
    recovery.registered(true);
    recovery.send(result());
    expect(resumes()).toHaveLength(1);
    acknowledge();
    expect(send.mock.calls.map(([message]) => message.type)).toEqual(['task_resume', 'response', 'task_resume']);
    expect(resumes()[1].messageId).toBe('m2');
    acknowledge();
    recovery.acknowledge({ type: 'task_result_ack', messageId: 'm1' });
    recovery.send(stream('next task output', 'm2'));
    expect(send.mock.calls.at(-1)?.[0].chunk).toBe('next task output');
  });

  it('retries failed or unacknowledged recovery without changing its identity', () => {
    recovery.disconnected();
    recovery.registered(true);
    acknowledge(undefined, false);
    vi.advanceTimersByTime(30000); // first backoff: 2 × RETRY_DELAY
    vi.advanceTimersByTime(60000); // second backoff: 4 × RETRY_DELAY
    expect(resumes()).toHaveLength(3);
    expect(new Set(resumes().map(message => message.taskResume.recoveryId)).size).toBe(1);
    acknowledge();
    vi.advanceTimersByTime(15000);
    expect(resumes()).toHaveLength(3);
  });

  it('backs off repeated recovery failures instead of retrying at a fixed interval', () => {
    recovery.disconnected();
    recovery.registered(true);
    acknowledge(undefined, false);
    vi.advanceTimersByTime(15000);
    expect(resumes()).toHaveLength(1); // backed off: no retry yet at the old fixed delay
    vi.advanceTimersByTime(15000); // 30s total — first backoff retry fires
    expect(resumes()).toHaveLength(2);
    vi.advanceTimersByTime(59000); // next delay is 60s
    expect(resumes()).toHaveLength(2);
    vi.advanceTimersByTime(1000);
    expect(resumes()).toHaveLength(3);
    acknowledge(); // a successful ack resets the backoff
    recovery.disconnected();
    recovery.registered(true);
    acknowledge(undefined, false);
    vi.advanceTimersByTime(15000);
    expect(resumes()).toHaveLength(4);
  });

  it('gives up after the recovery attempt cap instead of retrying forever', () => {
    recovery.disconnected();
    recovery.registered(true);
    for (let index = 0; index < 25; index++) {
      acknowledge(undefined, false);
      vi.advanceTimersByTime(300000); // jump past any backoff delay
    }
    expect(resumes()).toHaveLength(20);
    expect(recovery.hasPendingResults()).toBe(false);
    vi.advanceTimersByTime(600000);
    expect(resumes()).toHaveLength(20); // no further attempts after giving up
  });

  it('ignores an acknowledgement from an earlier connection', () => {
    recovery.disconnected(); recovery.registered(true);
    const stale = resumes()[0];
    recovery.disconnected(); recovery.registered(true);
    acknowledge(stale);
    recovery.send(stream('too early'));
    expect(send.mock.calls.at(-1)?.[0].type).toBe('task_resume');
    acknowledge();
    recovery.send(stream('current'));
    expect(send.mock.calls.at(-1)?.[0].chunk).toBe('current');
  });

  it('keeps retrying terminal status when its result receipt is lost', () => {
    recovery.send(result());
    vi.advanceTimersByTime(15000);
    expect(resumes()[0].taskResume.state).toBe('completed');
    recovery.acknowledge({ type: 'task_result_ack', messageId: 'm1' });
    expect(recovery.hasPendingResults()).toBe(false);
    vi.advanceTimersByTime(15000);
    expect(resumes()).toHaveLength(1);
  });

  it('does not confuse a delayed running acknowledgement with a retried completion', () => {
    recovery.disconnected(); recovery.registered(true);
    const running = resumes()[0];
    recovery.send(result());
    vi.advanceTimersByTime(15000);
    expect(resumes().at(-1).taskResume.state).toBe('completed');
    acknowledge(running);
    expect(recovery.hasPendingResults()).toBe(true);
    acknowledge();
    expect(recovery.hasPendingResults()).toBe(false);
  });

  it('bounds retained terminal metadata and expires it after a long outage', () => {
    recovery.disconnected();
    for (let index = 0; index < 105; index++) {
      const messageId = `finished-${index}`;
      recovery.track({ ...task, messageId, preview: 'x'.repeat(10000) });
      recovery.send({ ...result(messageId), success: false, error: 'e'.repeat(10000) });
    }
    recovery.registered(true);
    acknowledge(); // The original running task.
    for (let index = 0; index < 100; index++) acknowledge();
    expect(resumes()).toHaveLength(101);
    expect(resumes()[1].messageId).toBe('finished-5');
    expect(resumes()[1].taskResume.preview.length).toBe(240);
    expect(resumes()[1].taskResume.error.length).toBe(500);
    recovery.disconnected();
    recovery.send(result());
    vi.advanceTimersByTime(25 * 60 * 60 * 1000);
    expect(recovery.hasPendingResults()).toBe(false);
  });

  it('maintains legacy delivery when the Router does not advertise recovery', () => {
    recovery.registered(false);
    recovery.send(result());
    expect(send).toHaveBeenCalledWith(result());
    expect(recovery.hasPendingResults()).toBe(false);
    recovery.track({ ...task, messageId: 'm2' });
    recovery.disconnected();
    recovery.track(task);
    recovery.send(result());
    recovery.registered(false);
    recovery.send(stream('legacy', 'm2'));
    expect(resumes()).toHaveLength(0);
    expect(send.mock.calls.at(-1)?.[0].chunk).toBe('legacy');
    expect(recovery.hasPendingResults()).toBe(false);
  });

  it('retains status if the socket fails while sending', () => {
    send.mockImplementationOnce(() => { throw new Error('socket closed'); });
    expect(() => recovery.send(result())).not.toThrow();
    recovery.registered(true);
    expect(resumes()[0].taskResume.state).toBe('completed');
  });
});
