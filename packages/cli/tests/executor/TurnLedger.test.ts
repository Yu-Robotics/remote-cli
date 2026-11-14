import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnLedger } from '../../src/executor/claude/TurnLedger';
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const architecture = Object.getOwnPropertyDescriptor(process, 'arch')!;
beforeEach(() => Object.defineProperty(process, 'arch', { ...architecture, value: 'x64' }));
afterEach(() => Object.defineProperty(process, 'arch', architecture));
beforeEach(() => { Object.defineProperty(process, 'platform', { ...platform, value: 'linux' }); });
afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.useRealTimers(); });
function ledger() {
  const value = new TurnLedger(); value.version = '2.1.311'; value.pid = 17;
  value.observe({ type: 'system', subtype: 'init', session_id: 'fixture-session', capabilities: [
    'interrupt_receipt_v1', 'msg_lifecycle_v1', 'lifecycle_wakeup_source_v1'] });
  return value;
}
describe('native turn identity and evidence ledger', () => {
  it('requires tested platform, version, pid, session and all capabilities', () => {
    const value = ledger(); expect(value.supported(17)).toBe(true);
    expect(value.supported(18)).toBe(false); expect(value.supported(undefined)).toBe(false);
    for (const name of ['darwin', 'win32']) { Object.defineProperty(process, 'platform', { ...platform, value: name }); expect(value.supported(17)).toBe(false); }
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    Object.defineProperty(process, 'arch', { ...architecture, value: 'arm64' }); expect(value.supported(17)).toBe(false);
    Object.defineProperty(process, 'arch', { ...architecture, value: 'x64' });
    value.version = '2.1.312'; expect(value.supported(17)).toBe(false); value.version = '2.1.311';
    value.observe({ type: 'system', subtype: 'init', capabilities: ['msg_lifecycle_v1', 1] }); expect(value.supported(17)).toBe(false);
  });
  it('joins result and lifecycle independently, ignores foreign and child results, and invalidates session changes', () => {
    const value = ledger(); value.dispatched('a'); value.dispatched('b', true);
    value.observe({ type: 'command_lifecycle', command_uuid: 'a', state: 'started' });
    value.observe({ type: 'command_lifecycle', command_uuid: 'b', state: 'completed' });
    value.observe({ type: 'result', user_message_uuid: 'foreign' });
    value.observe({ type: 'result', user_message_uuid: 'b', parent_tool_use_id: 'child' });
    expect(value.settled('b')).toBe(false);
    value.observe({ type: 'result', user_message_uuids: ['a', 'b'] }); expect(value.settled('b')).toBe(true);
    expect(value.settled('a')).toBe(false);
    value.observe({ type: 'command_lifecycle', command_uuid: 'a', state: 'cancelled' }); expect(value.active).toBeUndefined();
    expect(value.settled('a')).toBe(true); expect(value.settled('unknown')).toBe(false);
    expect(value.joined({ user_message_uuid: 'a' }, 'a')).toBe(true); expect(value.joined({ user_message_uuids: ['a'] }, 'a')).toBe(true);
    expect(value.joined({}, 'a')).toBe(false); expect(value.joined({}, undefined)).toBe(false);
    value.observe({ session_id: 'foreign-session' }); expect(value.invalid).toBe(true); expect(value.supported(17)).toBe(false);
  });
  it('joins nested tool/task ownership and keeps malformed inventory unknown', () => {
    const value = ledger(); value.dispatched('a'); value.observe({ type: 'command_lifecycle', state: 'started', command_uuid: 'a' });
    value.observe({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'parent' }] } });
    value.observe({ type: 'assistant', parent_tool_use_id: 'parent', message: { content: [{ type: 'tool_use', id: 'child' }] } });
    value.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'task-a' }] });
    value.observe({ type: 'system', subtype: 'task_started', task_id: 'task-a', tool_use_id: 'child' });
    value.observe({ type: 'system', subtype: 'task_started', task_id: 'task-b', parent_task_id: 'task-a' });
    expect(value.tasks.get('task-b')?.owner).toBe('a'); expect(value.inventory?.has('task-a')).toBe(true);
    value.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ id: 'wrong-schema' }] }); expect(value.inventory).toBeUndefined();
    value.observe({ type: 'system', subtype: 'task_notification', task_id: 'task-a', status: 'stopped' }); expect(value.tasks.get('task-a')?.terminal).toBe(true);
    value.observe({ type: 'system', subtype: 'task_notification', task_id: 'unknown', status: 'stopped' });
    value.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [] }); expect(value.inventory?.size).toBe(0);
    value.observe({ type: 'system', subtype: 'background_tasks_changed' }); expect(value.inventory).toBeUndefined();
  });
  it('bounds history and fails closed on evidence capacity exhaustion', () => {
    const value = ledger(); for (let n = 0; n < 300; n++) value.dispatched(String(n));
    expect(value.turns.size).toBe(256); expect(value.inputs.size).toBe(1);
    for (let n = 0; n < 129; n++) value.dispatched(`input-${n}`, true); expect(value.invalid).toBe(true);
    const fresh = ledger(); fresh.dispatched('owner'); fresh.observe({ type: 'command_lifecycle', command_uuid: 'owner', state: 'started' });
    for (let n = 0; n < 4097; n++) {
      fresh.observe({ type: 'assistant', message: { content: [{ type: 'tool_use', id: String(n) }] } });
      fresh.observe({ type: 'system', subtype: 'task_started', task_id: String(n), tool_use_id: String(n) });
    }
    expect(fresh.tools.size).toBe(4096); expect(fresh.tasks.size).toBe(4096); expect(fresh.invalid).toBe(true);
  });
  it('waits for evidence and removes listeners/timers on both resolution and timeout', async () => {
    vi.useFakeTimers(); const value = ledger(); let done = false;
    await value.wait(() => true, 10, 'already done');
    const pending = value.wait(() => done, 10, 'settlement'); value.changed(); done = true; value.changed(); await pending;
    expect(vi.getTimerCount()).toBe(0);
    const failure = expect(value.wait(() => false, 10, 'settlement')).rejects.toThrow('unconfirmed');
    await vi.advanceTimersByTimeAsync(11); await failure; expect(vi.getTimerCount()).toBe(0);
    expect((value as any).listeners.size).toBe(0);
    const retired = expect(value.wait(() => false, 10, 'host')).rejects.toThrow('host closed'); value.retire(); await retired;
    expect(vi.getTimerCount()).toBe(0); expect((value as any).rejectors.size).toBe(0);
  });
});
