import { describe, expect, it, vi } from 'vitest';
import { CodexTaskNotifications } from '../../src/executor/CodexTaskNotifications';

describe('CodexTaskNotifications', () => {
  const command = { type: 'commandExecution', id: 'exec-1', command: 'npm test', status: 'inProgress', processId: '42' };

  it.each([
    ['completed', 0, 'completed'],
    ['failed', 1, 'failed'],
    ['completed', 2, 'failed'],
    ['interrupted', null, 'stopped'],
  ])('reports a background command ending with %s/%s as %s once', (status, exitCode, expected) => {
    const notify = vi.fn();
    const tracker = new CodexTaskNotifications(vi.fn());
    tracker.handle('item/started', { turnId: 'turn-1', item: command }, notify);
    tracker.handle('turn/completed', { turn: { id: 'turn-1' } });
    const completion = { turnId: 'turn-1', item: { ...command, status, exitCode, aggregatedOutput: 'Tests finished\n' } };
    expect(tracker.handle('item/completed', completion)).toBe(true);
    tracker.handle('item/completed', completion);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      taskId: 'exec-1', status: expected, summary: expect.stringContaining('Tests finished'), outputFile: '',
    });
  });

  it('keeps foreground commands in the original response and notifies commands that yield to the model', () => {
    const notify = vi.fn();
    const tracker = new CodexTaskNotifications(vi.fn());
    tracker.handle('item/started', { turnId: 'turn-1', item: command }, notify);
    expect(tracker.handle('item/completed', { turnId: 'turn-1', item: { ...command, status: 'completed', exitCode: 0 } })).toBe(false);
    expect(notify).not.toHaveBeenCalled();

    const background = { ...command, id: 'exec-2' };
    tracker.handle('item/started', { turnId: 'turn-1', item: background }, notify);
    tracker.handle('item/started', { turnId: 'turn-1', item: { type: 'agentMessage', id: 'reply' } });
    tracker.handle('item/completed', { turnId: 'turn-1', item: { ...background, status: 'completed', exitCode: 0 } });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['completed', 'completed'], ['errored', 'failed'], ['interrupted', 'stopped'], ['shutdown', 'stopped'],
  ])('uses agent state %s, rather than the collaboration tool status, for the card', (state, status) => {
    const notify = vi.fn();
    const tracker = new CodexTaskNotifications(vi.fn());
    const spawn = {
      type: 'collabAgentToolCall', id: 'spawn-1', tool: 'spawnAgent', status: 'completed',
      receiverThreadIds: ['agent-1'], prompt: 'Review the patch', agentsStates: { 'agent-1': { status: 'running' } },
    };
    tracker.handle('item/completed', { turnId: 'turn-1', item: spawn }, notify);
    expect(notify).not.toHaveBeenCalled();
    const wait = { ...spawn, id: 'wait-1', tool: 'wait', agentsStates: { 'agent-1': { status: state, message: 'Review result' } } };
    tracker.handle('item/completed', { turnId: 'turn-1', item: wait });
    tracker.handle('item/completed', { turnId: 'turn-1', item: spawn }, notify);
    tracker.handle('item/completed', { turnId: 'turn-1', item: { ...wait, id: 'wait-2' } });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      taskId: 'agent-1', status, summary: expect.stringContaining('Review result'), outputFile: '',
    });

    tracker.handle('item/completed', { turnId: 'turn-2', item: { ...spawn, id: 'followup', tool: 'followupTask' } }, notify);
    tracker.handle('item/completed', { turnId: 'turn-2', item: { ...wait, id: 'wait-3' } });
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it.each([['completed', 'completed'], ['failed', 'failed'], ['interrupted', 'stopped']])('reads a %s sub-agent turn without generating a new turn', async (state, status) => {
    const notify = vi.fn();
    const request = vi.fn().mockResolvedValue({ data: [{ status: state, items: [{ type: 'agentMessage', text: 'Review result.' }] }] });
    const tracker = new CodexTaskNotifications(request);
    const started = { type: 'subAgentActivity', id: 'start', kind: 'started', agentThreadId: 'agent-1', agentPath: '/root/review' };
    tracker.handle('item/completed', { turnId: 'turn-1', item: started }, notify);
    const ended = { ...started, id: 'end', kind: 'completed' };
    tracker.handle('item/completed', { turnId: 'turn-1', item: ended });
    tracker.handle('item/completed', { turnId: 'turn-1', item: ended });
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('thread/turns/list', {
      threadId: 'agent-1', limit: 1, sortDirection: 'desc', itemsView: 'full',
    });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ status, summary: expect.stringContaining('Review result.') }));
  });

  it('waits for a native terminal state when a server cannot read sub-agent turns', async () => {
    const notify = vi.fn();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tracker = new CodexTaskNotifications(vi.fn().mockRejectedValue(new Error('Method not found')));
    try {
      const activity = { type: 'subAgentActivity', id: 'start', kind: 'started', agentThreadId: 'agent-1' };
      tracker.handle('item/completed', { turnId: 'turn-1', item: activity }, notify);
      tracker.handle('item/completed', { turnId: 'turn-1', item: { ...activity, id: 'end', kind: 'completed' } });
      await vi.waitFor(() => expect(warning).toHaveBeenCalled());
      expect(notify).not.toHaveBeenCalled();
      tracker.handle('item/completed', { turnId: 'turn-1', item: {
        type: 'collabAgentToolCall', id: 'wait', tool: 'wait', status: 'completed', receiverThreadIds: ['agent-1'],
        agentsStates: { 'agent-1': { status: 'errored', message: 'Provider unavailable' } },
      } });
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', summary: expect.stringContaining('Provider unavailable') }));
    } finally {
      warning.mockRestore();
    }
  });

  it('drops in-flight result lookups and command completions after the session is cleared', async () => {
    const notify = vi.fn();
    let resolve!: (result: unknown) => void;
    const tracker = new CodexTaskNotifications(() => new Promise((done) => { resolve = done; }));
    tracker.handle('item/started', { turnId: 'turn-1', item: command }, notify);
    tracker.handle('turn/completed', { turn: { id: 'turn-1' } });
    const activity = { type: 'subAgentActivity', id: 'start', kind: 'started', agentThreadId: 'agent-1' };
    tracker.handle('item/completed', { turnId: 'turn-1', item: activity }, notify);
    tracker.handle('item/completed', { turnId: 'turn-1', item: { ...activity, id: 'end', kind: 'completed' } });
    tracker.clear();
    resolve({ data: [{ status: 'completed', items: [] }] });
    await Promise.resolve();
    tracker.handle('item/completed', { turnId: 'turn-1', item: { ...command, status: 'completed', exitCode: 0 } });
    expect(notify).not.toHaveBeenCalled();
  });
});
