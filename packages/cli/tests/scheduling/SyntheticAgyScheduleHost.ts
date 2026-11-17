import { expect, vi } from 'vitest';
import { AgySessionSchedules } from '../../src/scheduling/agy/AgySessionSchedules';
import type { NativeScheduleToolAction } from '../../src/scheduling/types';
import type { TranscriptRecord } from '../../src/scheduling/agy/transcript';

const session = 'synthetic-session';
export function agyScheduleHarness(cwd: string) {
  let cursor = 0;
  let invocationStart = 0;
  const records: TranscriptRecord[] = [];
  const tasks = new Map<string, string>();
  const current = vi.fn(() => true);
  const bridge = new AgySessionSchedules({ sessionId: session, threadId: 'thread-a', hostId: 'synthetic-host', cwd, timezone: 'UTC',
    isCurrent: current, manage: async action => manage(action) });
  const hook = (event: string, extra: Record<string, unknown> = {}) => bridge.accept(event,
    { conversationId: session, cwd, hookEventName: event,
      ...(event === 'PostInvocation' ? { initialNumSteps: invocationStart, invocationNum: 0 } : {}), ...extra }, records);
  const record = (type: string, content: string, source = 'MODEL', status = 'DONE', step = cursor++) => {
    const row = { step_index: step, type, source, status, content };
    const index = records.findIndex(r => r.step_index === step);
    if (index === -1) records.push(row); else records[index] = row;
    return row;
  };
  const begin = () => { invocationStart = cursor; return hook('PreInvocation', { initialNumSteps: cursor, invocationNum: 0 }); };
  const stop = (output = 'Native result') => {
    record('PLANNER_RESPONSE', output);
    hook('PostInvocation'); hook('Stop', { terminationReason: 'NO_TOOL_CALL', error: '', fullyIdle: true });
  };
  const tool = (action: NativeScheduleToolAction, step = cursor++) => {
    const decision = hook('PreToolUse', { stepIdx: step, toolCall: { id: `call-${step}`, name: action.tool, args: action.input } });
    return { decision, step };
  };
  const respond = (action: NativeScheduleToolAction) => {
    const { decision, step } = tool(action);
    expect(decision).toEqual({ decision: 'allow' });
    receipt(action, step);
    hook('PostToolUse');
  };
  const receipt = (action: NativeScheduleToolAction, step: number) => {
    let text = '';
    if (action.tool === 'schedule') {
      const id = `${session}/task-${step}`;
      tasks.set(id, action.input.Prompt as string);
      text = `Tool is running as a background task with task id: ${id}\nTask Description: Timer: synthetic, Prompt: ${action.input.Prompt}\nTask logs are available at: file://synthetic/log`;
      record('GENERIC', text, 'MODEL', 'RUNNING', step);
    } else {
      if (action.input.Action === 'kill') {
        tasks.delete(action.input.TaskId as string); text = `Task "${action.input.TaskId}" cancelled.`;
      } else text = tasks.size ? `You have ${tasks.size} background task(s) currently running:\n` + JSON.stringify([...tasks].map(([taskId, prompt]) => ({ taskId, toolName: 'schedule', description: `Timer: synthetic, Prompt: ${prompt}`, isDaemon: true })))
        : 'No background tasks are currently running.';
      record('GENERIC', `Created At: synthetic\nCompleted At: synthetic\n${text}`, 'MODEL', 'DONE', step);
    }
  };
  const manage = async (action: NativeScheduleToolAction) => {
    hook('SessionStart'); begin();
    const { decision, step } = tool(action);
    expect(decision).toEqual({ decision: 'allow' });
    receipt(action, step);
    stop('Management done'); return { stopReason: 'end_turn' };
  };
  return { bridge, tasks, current, begin, stop, tool, respond };
}
