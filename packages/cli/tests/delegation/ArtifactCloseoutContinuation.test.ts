import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactCloseoutContinuation, waitForArtifactCloseout } from '../../src/delegation/ArtifactCloseoutContinuation';
import type { DelegationCloseoutIssue } from '../../src/delegation/DelegationManager';
import { getEventListeners } from 'node:events';

const issue = (taskId: string): DelegationCloseoutIssue => ({ taskId, backend: 'codex', status: 'pending' });

describe('artifact closeout continuation pacing', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('continues indefinitely with a capped delay rather than a round budget', () => {
    const continuation = new ArtifactCloseoutContinuation();
    expect(Array.from({ length: 9 }, () => continuation.nextDelay([issue('one')]))).toEqual(
      [0, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    for (let i = 0; i < 100; i++) expect(continuation.nextDelay([issue('one')])).toBe(30000);
  });

  it('does not treat reordering, changed status, or additional workers as resolved obligations', () => {
    const continuation = new ArtifactCloseoutContinuation();
    expect(continuation.nextDelay([issue('one')])).toBe(0);
    expect(continuation.nextDelay([issue('one'), issue('two')])).toBe(1000);
    expect(continuation.nextDelay([issue('two'), { ...issue('one'), status: 'unavailable' }])).toBe(2000);
    expect(continuation.nextDelay([issue('two')])).toBe(0);
    expect(continuation.nextDelay([issue('two')])).toBe(1000);
    expect(continuation.nextDelay([])).toBe(0);
    expect(continuation.nextDelay([issue('three')])).toBe(0);
  });

  it('releases its timer and listener on normal completion', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const waiting = waitForArtifactCloseout(1000, controller.signal);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    await waiting;
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it.each(['before', 'during'])('settles cancellation %s the wait without leaving a timer', async timing => {
    vi.useFakeTimers();
    const controller = new AbortController();
    if (timing === 'before') controller.abort();
    const waiting = waitForArtifactCloseout(30000, controller.signal);
    const cancelled = expect(waiting).rejects.toThrow('cancelled');
    controller.abort();
    await cancelled;
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('supports callers without a cancellation signal', async () => {
    vi.useFakeTimers();
    const waiting = waitForArtifactCloseout(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await waiting;
    expect(vi.getTimerCount()).toBe(0);
  });
});
