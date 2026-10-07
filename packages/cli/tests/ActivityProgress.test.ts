import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTIVITY_PROGRESS_INTERVAL_MS, ActivityProgress } from '../src/utils/ActivityProgress';

afterEach(() => vi.useRealTimers());

describe('bounded display activity cadence', () => {
  it('coalesces the latest snapshot and deduplicates successful delivery', async () => {
    vi.useFakeTimers();
    const send = vi.fn(() => true);
    const progress = new ActivityProgress(send);
    for (let index = 0; index < 100; index++) progress.offer({ source: 'public_text', text: `Inspecting item ${index}` });
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(ACTIVITY_PROGRESS_INTERVAL_MS);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({ source: 'public_text', text: 'Inspecting item 99' });
    progress.offer({ source: 'public_text', text: 'Inspecting item 99' });
    await vi.advanceTimersByTimeAsync(ACTIVITY_PROGRESS_INTERVAL_MS);
    expect(send).toHaveBeenCalledOnce();
    progress.offer({ source: 'plan', text: 'Inspecting item 99' });
    await vi.advanceTimersByTimeAsync(ACTIVITY_PROGRESS_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(2);
    progress.dispose();
  });

  it('bounds Unicode, removes controls and rejects private or malformed sources', async () => {
    vi.useFakeTimers();
    const send = vi.fn(() => true);
    const progress = new ActivityProgress(send);
    for (const value of [null, [], { source: 'thinking', text: 'PRIVATE' }, { source: 'plan', text: {} }]) progress.offer(value);
    await vi.advanceTimersByTimeAsync(ACTIVITY_PROGRESS_INTERVAL_MS);
    expect(send).not.toHaveBeenCalled();
    progress.offer({ source: 'plan', text: `Read\n\t${'\u{1f3af}'.repeat(1000)}` });
    await vi.advanceTimersByTimeAsync(ACTIVITY_PROGRESS_INTERVAL_MS);
    const text = send.mock.calls[0][0].text;
    expect(Array.from(text).length).toBeLessThanOrEqual(240);
    expect(text).not.toMatch(/[\r\n\t\x00]/);
    expect(text).not.toMatch(/[\uD800-\uDBFF]$/);
    progress.dispose();
  });

  it('retries only on a later offer and never turns display into a heartbeat', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockReturnValueOnce(false).mockImplementationOnce(() => { throw new Error('Disconnected'); }).mockReturnValue(true);
    const progress = new ActivityProgress(send);
    for (let index = 0; index < 3; index++) {
      progress.offer({ source: 'tool', text: 'Using Read' });
      await vi.advanceTimersByTimeAsync(ACTIVITY_PROGRESS_INTERVAL_MS);
      expect(send).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(ACTIVITY_PROGRESS_INTERVAL_MS * 10);
      expect(send).toHaveBeenCalledTimes(index + 1);
    }
    progress.dispose();
  });

  it('cancels pending snapshots on turn boundaries, terminal disposal and immediate state changes', async () => {
    vi.useFakeTimers();
    const send = vi.fn(() => true);
    const progress = new ActivityProgress(send);
    progress.offer({ source: 'public_text', text: 'Stale first turn' });
    progress.clear();
    await vi.advanceTimersByTimeAsync(ACTIVITY_PROGRESS_INTERVAL_MS);
    expect(send).not.toHaveBeenCalled();
    progress.offer({ source: 'public_text', text: 'Stale second turn' });
    progress.offer({ source: 'state', text: 'Waiting for your input' }, true);
    await vi.advanceTimersByTimeAsync(ACTIVITY_PROGRESS_INTERVAL_MS);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({ source: 'state', text: 'Waiting for your input' });
    progress.offer({ source: 'plan', text: 'Late plan' });
    progress.dispose();
    progress.offer({ source: 'plan', text: 'After completion' }, true);
    progress.flush();
    await vi.advanceTimersByTimeAsync(ACTIVITY_PROGRESS_INTERVAL_MS);
    expect(send).toHaveBeenCalledOnce();
  });
});
