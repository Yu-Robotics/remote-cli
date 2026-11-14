import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

vi.mock('child_process', () => {
  const denied = () => { throw new Error('Native execution is forbidden in this fixture'); };
  return { spawn: vi.fn(denied), exec: denied, execFile: denied, execSync: denied,
    execFileSync: denied, spawnSync: denied, fork: denied };
});
import { ClaudePersistentExecutor } from '../src/executor/ClaudePersistentExecutor';
import { DirectoryGuard } from '../src/security/DirectoryGuard';
import { MessageHandler } from '../src/client/MessageHandler';
import { ThreadExecutorPool } from '../src/thread/ThreadExecutorPool';
import { ThreadContextReset } from '../src/thread/ThreadContextReset';
import { ManagedToolBridge } from '../src/managed/ManagedToolBridge';
import { SCHEDULE_HOOK } from '../src/scheduling/claude/ClaudeSessionSchedules';

let root: string;
let executor: ClaudePersistentExecutor;
let raw: any;
let child: any;
let wire: any[];
let version: string | undefined;
let handlers: MessageHandler[];
let bridges: ManagedToolBridge[];
let sessionModel: string;
const hostPlatform = process.platform;
const models = [
  { value: 'sonnet', resolvedModel: 'synthetic-sonnet', supportsEffort: true, supportedEffortLevels: ['high'] },
  { value: 'opus', resolvedModel: 'synthetic-opus', supportsEffort: true, supportedEffortLevels: ['high'] },
  { value: 'haiku', supportsEffort: false },
  { value: 'default', supportsEffort: false },
];
const frame = (message: object, host = child) => host.stdout.emit('data', Buffer.from(JSON.stringify(message) + '\n'));
const control = () => wire.filter(row => row.request?.subtype === 'set_model').at(-1);
const respond = (response: object, packet = control(), host = child) => frame({ type: 'control_response',
  response: { request_id: packet.request_id, ...response } }, host);
const ack = (selected = 'synthetic-opus', packet = control(), host = child) => {
  sessionModel = selected;
  respond({ subtype: 'success', response: { model: selected } }, packet, host);
};
const tick = () => vi.advanceTimersByTimeAsync(0);

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'model-control-')));
  vi.spyOn(os, 'homedir').mockReturnValue(root);
  vi.stubEnv('HOME', root); vi.stubEnv('USERPROFILE', root);
  vi.stubGlobal('fetch', () => { throw new Error('External requests are forbidden'); });
  // This exercises the native control protocol portably, not native platform execution.
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
  vi.spyOn(process, 'arch', 'get').mockReturnValue('x64');
  for (const name of ['log', 'warn', 'error'] as const) vi.spyOn(console, name).mockImplementation(() => {});
  vi.useFakeTimers();
  version = '2.1.311'; wire = []; handlers = []; bridges = []; sessionModel = 'synthetic-sonnet';
  child = Object.assign(new EventEmitter(), { pid: 4242, killed: false, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
  child.stdin = { writable: true, end: vi.fn(() => child.emit('close', 0)), write: vi.fn((line: string, done?: (error?: Error) => void) => {
    const packet = JSON.parse(line); wire.push(packet);
    if (packet.request?.subtype === 'initialize') queueMicrotask(() => respond({ subtype: 'success', response: {
      claude_code_version: version, pid: child.pid, models,
    } }, packet));
    if (packet.request?.subtype === 'get_settings') queueMicrotask(() => respond({ subtype: 'success', response: { effective: { env: {} }, sources: [] } }, packet));
    done?.(); return true;
  }) };
  vi.mocked(spawn).mockReset().mockReturnValue(child);
  executor = new ClaudePersistentExecutor(new DirectoryGuard([root]), root, 'synthetic-thread', 'sonnet', undefined, 'forbidden-native');
  raw = executor as any;
});
afterEach(async () => {
  for (const handler of handlers) await handler.destroy();
  for (const bridge of bridges) await bridge.close();
  await executor.destroy();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  await fs.rm(root, { recursive: true, force: true });
});
async function warm() {
  const init = executor.listModels();
  await vi.advanceTimersByTimeAsync(1000); await init;
  frame({ type: 'system', subtype: 'init', model: 'synthetic-sonnet', session_id: 'synthetic-session', tools: ['CronCreate', 'CronList', 'CronDelete'],
    capabilities: ['interrupt_receipt_v1', 'msg_lifecycle_v1', 'lifecycle_wakeup_source_v1'] });
}
async function change(model = 'opus') { const promise = executor.setModel(model); await tick(); return { promise }; }
function completed(id: string) {
  frame({ type: 'result', uuid: `result-${id}`, user_message_uuid: id, user_message_uuids: [id], result: 'Synthetic response', is_error: false });
  frame({ type: 'command_lifecycle', command_uuid: id, state: 'completed' });
}
async function reserve() {
  const events = vi.fn();
  const pending = executor.withNativeScheduleOperation('synthetic-job', () => true, () => executor.createNativeSchedule({
    id: 'synthetic-job', cwd: root, prompt: 'Synthetic recurring work',
    rule: { kind: 'cron', expression: '* * * * *', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
  }, events), true);
  await tick();
  const action = executor.nativeScheduleAction('synthetic-job')!;
  frame({ type: 'control_request', request_id: 'create-hook', request: { subtype: 'hook_callback', callback_id: SCHEDULE_HOOK,
    tool_use_id: 'create-tool', input: { hook_event_name: 'PreToolUse', tool_name: action.tool, tool_input: action.input } } });
  frame({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'create-tool',
    content: 'Scheduled recurring job native-job (every minute). Next run: later. Session-only (not written to disk, dies when Claude exits).', is_error: false }] } });
  return { handle: await pending, action, events };
}
function scheduled(job: Awaited<ReturnType<typeof reserve>>, end = true) {
  frame({ type: 'command_lifecycle', command_uuid: 'schedule-occurrence', state: 'started', wakeup_source: 'schedule_wakeup' });
  frame({ type: 'control_request', request_id: 'wake-hook', request: { subtype: 'hook_callback', callback_id: SCHEDULE_HOOK,
    input: { hook_event_name: 'UserPromptSubmit', source: 'schedule_wakeup', prompt: job.action.input.prompt } } });
  if (end) endScheduled();
}
function endScheduled() {
  frame({ type: 'assistant', message: { role: 'assistant', model: sessionModel, content: [{ type: 'text', text: `Synthetic scheduled response using ${sessionModel}` }] } });
  frame({ type: 'result', uuid: 'schedule-result', is_error: false, terminal_reason: 'completed', result: `Synthetic scheduled response using ${sessionModel}` });
  frame({ type: 'command_lifecycle', command_uuid: 'schedule-occurrence', state: 'completed' });
}

function handlerFixture() {
  const thread: any = { id: 'synthetic-thread', name: 'Synthetic', workingDirectory: root, models: { claude: 'sonnet' } };
  const manager: any = { contextResets: new ThreadContextReset(path.join(root, 'resets')),
    getThread: () => thread, getDefaultThread: () => thread, listThreads: () => [thread],
    updateThread: vi.fn(async (_id, fields) => Object.assign(thread, fields)), clearBackendSessionPointers: vi.fn(async () => {}) };
  const pool = new ThreadExecutorPool(manager, new DirectoryGuard([root]), { type: 'claude-persistent' }, () => executor);
  pool.getExecutor(thread.id);
  const ws: any = { send: vi.fn(), isConnected: () => true, hasPendingTaskResults: () => false, trackTask: vi.fn() };
  let globalModel: string | undefined;
  const config: any = { get: (key: string) => key === 'executor' ? { type: 'claude-persistent', claude: { model: globalModel } } : undefined,
    getConfigDir: () => path.join(root, 'config'), getSharedSymlinks: () => [] };
  const handler = new MessageHandler(ws, pool, manager, new DirectoryGuard([root]), config); handlers.push(handler);
  const inner = handler as any;
  vi.spyOn(inner, 'detectBackends').mockResolvedValue([{ id: 'auto', label: 'Claude', installed: true }]);
  vi.spyOn(inner.delegation.registry, 'list').mockResolvedValue([]);
  vi.spyOn(inner.settingsCatalogReader, 'withExecutor').mockImplementation(async (...args: any[]) => args[4](executor));
  let sequence = 0;
  const send = (content: string) => handler.handleMessage({ type: 'command', threadId: thread.id, messageId: `command-${++sequence}`,
    openId: 'synthetic-owner', content, timestamp: Date.now() } as any);
  const messages = () => ws.send.mock.calls.map(([message]: any[]) => message);
  return { thread, manager, pool, handler, inner, send, messages, setGlobal: (model?: string) => { globalModel = model; } };
}

describe('Claude in-process model ownership', () => {
  it('selects and clears cold preferences without spawning, including effort validation', async () => {
    expect((await executor.setModel('opus')).success).toBe(true);
    expect(executor.getExecutionMetadata()).toMatchObject({ model: 'opus', modelSource: 'configured' });
    await executor.clearModel(); expect(raw.model).toBeUndefined();
    raw.effort = 'high';
    expect((await executor.setModel('haiku')).error).toContain('Reset /effort auto');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('keeps host, session, bridge and authorized jobs; synthetic future native turns use the acknowledged selection', async () => {
    const bridge = new ManagedToolBridge(); bridges.push(bridge);
    const connection = await bridge.start(['scheduling']);
    await executor.configureDelegation(connection);
    await warm(); const job = await reserve();
    const close = vi.spyOn(bridge, 'close');
    const { promise } = await change();
    expect(control().request).toEqual({ subtype: 'set_model', model: 'opus' });
    ack(); expect((await promise).success).toBe(true);
    expect(raw.claudeProcess).toBe(child); expect(executor.getSessionId()).toBe('synthetic-session');
    expect(raw.delegation).toEqual(connection); expect(await bridge.start(['scheduling'])).toEqual(connection);
    expect(close).not.toHaveBeenCalled(); expect(raw.sessionSchedules.hasJobs).toBe(true); expect(job.handle.nativeId).toBe('native-job');
    expect((await executor.listModels()).find(model => model.id === 'opus')?.isCurrent).toBe(true);
    scheduled(job);
    expect(job.events).toHaveBeenCalledWith(expect.objectContaining({ type: 'completed', success: true, output: 'Synthetic scheduled response using synthetic-opus' }));
    expect(child.stdin.end).not.toHaveBeenCalled(); expect(child.kill).not.toHaveBeenCalled(); expect(spawn).toHaveBeenCalledOnce();
    expect(wire.filter(row => row.type === 'user')).toHaveLength(0);
    const listed = executor.withNativeScheduleOperation('inventory', () => true, () => job.handle.list!(), false);
    await tick(); const management = wire.filter(row => row.type === 'user').at(-1);
    const action = JSON.parse(management.message.content.split('\n').at(-1));
    expect(action.tool).toBe('CronList');
    frame({ type: 'control_request', request_id: 'list-hook', request: { subtype: 'hook_callback', callback_id: SCHEDULE_HOOK,
      tool_use_id: 'list-tool', input: { hook_event_name: 'PreToolUse', tool_name: action.tool, tool_input: action.input } } });
    frame({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'list-tool',
      content: `native-job — ${job.action.input.prompt.split('\n')[0]} [session-only]`, is_error: false }] } });
    completed(management.uuid); expect(await listed).toBe(true);
    expect(spawn).toHaveBeenCalledOnce(); expect(child.stdin.end).not.toHaveBeenCalled();
  });

  it('resets to native default with the SDK omission shape and reports the acknowledged model', async () => {
    await warm(); const pending = executor.clearModel(); await tick();
    expect(control().request).toEqual({ subtype: 'set_model' }); ack('synthetic-default'); await pending;
    expect(raw.model).toBeUndefined();
    frame({ type: 'assistant', message: { role: 'assistant', model: 'synthetic-old-turn' } });
    expect(executor.getExecutionMetadata()).toMatchObject({ model: 'synthetic-default', modelSource: 'reported' });
    expect(child.stdin.end).not.toHaveBeenCalled();
  });

  it('lets a subsequent foreground report its actual served model without accepting an old idle response', async () => {
    await warm(); const { promise } = await change(); ack(); await promise;
    frame({ type: 'assistant', message: { role: 'assistant', model: 'synthetic-old-model' } });
    expect(executor.getExecutionMetadata().model).toBe('synthetic-opus');
    const next = executor.execute('Synthetic next turn'); const id = wire.at(-1).uuid;
    frame({ type: 'assistant', user_message_uuid: id, message: { role: 'assistant', model: 'synthetic-provider-fallback' } });
    expect(executor.getExecutionMetadata().model).toBe('synthetic-provider-fallback');
    completed(id); await next;
  });

  it.each([
    ['linux', 'arm64', '2.1.318'], ['darwin', 'arm64', 'future-build'],
    ['win32', 'x64', '2.1.310'], ['linux', 'x64', undefined],
  ] as const)('uses acknowledged model control on %s/%s build %s', async (platform, arch, build) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    vi.spyOn(process, 'arch', 'get').mockReturnValue(arch);
    version = build;
    await warm(); await reserve();
    const { promise } = await change(); ack();
    expect((await promise).success).toBe(true);
    expect(raw.model).toBe('opus'); expect(child.stdin.end).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledOnce();
  });

  it.each(['pid', 'invalid', 'unwritable'])('rejects %s host evidence without stopping jobs', async mismatch => {
    await warm(); await reserve();
    if (mismatch === 'pid') raw.turnLedger.pid = 4243;
    if (mismatch === 'invalid') raw.turnLedger.invalid = true;
    if (mismatch === 'unwritable') child.stdin.writable = false;
    expect((await executor.setModel('opus')).success).toBe(false);
    expect(control()).toBeUndefined(); expect(raw.model).toBe('sonnet'); expect(child.stdin.end).not.toHaveBeenCalled();
  });

  it.each(['haiku', 'default'])('refuses incompatible effort for %s, including reset', async model => {
    await warm(); await reserve(); raw.effort = 'high';
    if (model === 'default') await expect(executor.clearModel()).rejects.toThrow('incompatible');
    else expect((await executor.setModel(model)).error).toContain('incompatible');
    expect(control()).toBeUndefined(); expect(raw.effort).toBe('high');
    expect((await executor.setEffort('auto')).error).toContain('native schedules');
    expect(child.stdin.end).not.toHaveBeenCalled();
  });

  it('refuses unvalidated effort on an unknown explicit model', async () => {
    await warm(); raw.effort = 'high';
    expect((await executor.setModel('provider/unknown')).error).toContain('Cannot validate');
    expect(control()).toBeUndefined();
  });

  it('uses native validation for explicit names and retains reported selection on a refusal', async () => {
    await warm(); const { promise } = await change('provider/unknown');
    respond({ subtype: 'error', error: 'Synthetic rejection', error_code: 'catalog_unknown', model: 'synthetic-sonnet' });
    expect((await promise).error).toContain('refused'); expect(raw.model).toBe('sonnet'); expect(executor.isBusy()).toBe(false);
  });

  it('fences new input, duplicate preferences, compact, bridge changes and abort while preserving scheduled wakeups', async () => {
    await warm(); const job = await reserve(); const { promise } = await change();
    expect((await executor.execute('Must not dispatch')).success).toBe(false);
    expect((await executor.setModel('haiku')).success).toBe(false);
    await expect(executor.clearModel()).rejects.toThrow('pending');
    expect((await executor.compact()).success).toBe(false);
    expect((await executor.setEffort('auto')).success).toBe(false);
    const mutation = vi.fn();
    await expect(executor.withNativeScheduleOperation('blocked', () => true, mutation, true)).rejects.toThrow('unavailable');
    expect(mutation).not.toHaveBeenCalled();
    await expect(executor.configureDelegation({ url: 'http://127.0.0.1:1/', token: 'synthetic' })).rejects.toThrow('busy');
    await expect(executor.abort()).rejects.toThrow('settings request');
    scheduled(job, false); ack(); expect((await promise).success).toBe(true);
    // The wake started before ACK: model control does not cancel that occurrence.
    expect(executor.isBusy()).toBe(true); endScheduled(); expect(executor.isBusy()).toBe(false);
    expect(child.stdin.end).not.toHaveBeenCalled(); expect(child.kill).not.toHaveBeenCalled();
    const next = executor.execute('Next foreground'); const id = wire.at(-1).uuid; completed(id);
    expect((await next).success).toBe(true);
  });

  it('bounds timeout, keeps admission and consumes late ACK without committing the timed-out preference', async () => {
    await warm(); const { promise } = await change(); const packet = control();
    await vi.advanceTimersByTimeAsync(10000);
    expect((await promise).error).toContain('timed out'); expect(raw.model).toBe('sonnet');
    expect(executor.getExecutionMetadata()).toMatchObject({ model: undefined, modelSource: 'unknown' });
    expect((await executor.setModel('haiku')).success).toBe(false);
    respond({ subtype: 'success', response: { model: 'synthetic-foreign' } }, { request_id: 'foreign' });
    expect(executor.isBusy()).toBe(true);
    ack('synthetic-opus', packet); expect(executor.isBusy()).toBe(false); expect(raw.model).toBe('sonnet');
    expect(executor.getExecutionMetadata().model).toBe('synthetic-opus');
    const retry = await change(); ack(); expect((await retry.promise).success).toBe(true); expect(raw.model).toBe('opus');
  });

  it.each(['internal_error', 'malformed'])('keeps %s uncertain until a fresh confirmed setting, never a restart', async mode => {
    await warm(); const { promise } = await change();
    if (mode === 'malformed') respond({ subtype: 'success', response: {} });
    else respond({ subtype: 'error', error: 'Synthetic post-change failure', error_code: mode, model: 'synthetic-opus' });
    expect((await promise).success).toBe(false); expect(raw.model).toBe('sonnet'); expect(executor.isBusy()).toBe(true);
    const retry = await change('sonnet'); ack('synthetic-sonnet'); expect((await retry.promise).success).toBe(true);
    expect(child.stdin.end).not.toHaveBeenCalled();
  });

  it.each(['verdict_pending', 'unclassified'])('does not turn %s into a refusal or allow overlapping native changes', async code => {
    await warm(); const { promise } = await change();
    respond({ subtype: 'error', error: 'Synthetic unknown outcome', error_code: code, model: 'synthetic-sonnet' });
    expect((await promise).success).toBe(false); expect(executor.isBusy()).toBe(true);
    expect((await executor.setModel('sonnet')).success).toBe(false); expect(child.stdin.end).not.toHaveBeenCalled();
  });

  it.each(['reset', 'destroy', 'close'])('rejects stale acknowledgement after %s and never changes a replacement preference', async action => {
    await warm(); const { promise } = await change(); const packet = control();
    if (action === 'reset') executor.resetContext();
    else if (action === 'destroy') await executor.destroy();
    else child.emit('close', 0);
    await tick(); expect((await promise).success).toBe(false);
    ack('synthetic-opus', packet); expect(raw.model).toBe('sonnet'); expect(raw.acknowledgedModel).toBeUndefined();
    if (action !== 'destroy') { expect((await executor.setModel('haiku')).success).toBe(true); expect(raw.model).toBe('haiku'); }
  });

  it('refuses a preflight whose captured session changed', async () => {
    await warm(); raw.cachedModelCatalog = null;
    const pending = executor.setModel('opus');
    frame({ type: 'system', subtype: 'init', session_id: 'synthetic-replacement' });
    await tick(); expect((await pending).success).toBe(false); expect(control()).toBeUndefined();
  });

  it('rejects a correlated ACK from a changed session identity', async () => {
    await warm(); const { promise } = await change();
    frame({ type: 'control_response', session_id: 'synthetic-other-session', response: {
      subtype: 'success', request_id: control().request_id, response: { model: 'synthetic-opus' },
    } });
    expect((await promise).success).toBe(false); expect(raw.model).toBe('sonnet'); expect(executor.isBusy()).toBe(true);
  });

  it('does not persist a late refusal and releases its admission without stopping jobs', async () => {
    await warm(); const { promise } = await change(); await vi.advanceTimersByTimeAsync(10000);
    expect((await promise).success).toBe(false);
    respond({ subtype: 'error', error_code: 'blocked_by_hook', model: 'synthetic-sonnet' });
    expect(raw.model).toBe('sonnet'); expect(executor.isBusy()).toBe(false); expect(child.stdin.end).not.toHaveBeenCalled();
  });

  it.each(['callback', 'throw'])('retains uncertainty after a %s write failure', async mode => {
    await warm(); child.stdin.write.mockImplementation(() => { throw new Error('Synthetic write failure'); });
    if (mode === 'callback') child.stdin.write.mockImplementation((_line: string, callback: (error: Error) => void) => callback(new Error('Synthetic write failure')));
    expect((await executor.setModel('opus')).error).toContain('write failed'); expect(executor.isBusy()).toBe(true);
    expect(raw.model).toBe('sonnet'); expect(child.stdin.end).not.toHaveBeenCalled();
  });

  it('does not stop a host if a schedule arrives while an effort catalog check yields', async () => {
    await warm();
    let resume!: () => void;
    const wait = new Promise<void>(resolve => { resume = resolve; });
    const list = executor.listEfforts.bind(executor);
    vi.spyOn(executor, 'listEfforts').mockImplementation(async () => { const info = await list(); await wait; return info; });
    const effort = executor.setEffort('high'); const job = await reserve(); resume();
    expect((await effort).success).toBe(false); expect(job.handle.nativeId).toBe('native-job');
    expect(child.stdin.end).not.toHaveBeenCalled();
  });

  it('rejects invalid identifiers and destroyed cold changes', async () => {
    for (const value of ['', ' ', 'bad\nmodel', 'a'.repeat(513)]) expect((await executor.setModel(value)).success).toBe(false);
    await executor.destroy(); expect((await executor.setModel('opus')).success).toBe(false);
    await expect(executor.clearModel()).rejects.toThrow('destroyed'); expect(spawn).not.toHaveBeenCalled();
  });
});

describe('production handler model/card persistence', () => {
  it('persists text selection only after native ACK and retains the registered bridge', async () => {
    await warm(); const f = handlerFixture();
    const bridge = new ManagedToolBridge(); bridges.push(bridge); await bridge.start(['scheduling']);
    f.inner.delegationBridges.set(f.thread.id, bridge); const close = vi.spyOn(bridge, 'close');
    const pending = f.send('/model opus'); await tick(); expect(control()).toBeDefined();
    expect(f.thread.models.claude).toBe('sonnet');
    await f.send('/abort'); expect(f.messages().at(-1)).toMatchObject({ success: false }); expect(close).not.toHaveBeenCalled();
    ack(); await pending; expect(f.thread.models.claude).toBe('opus');
    expect(f.messages().at(-1)?.error).toBeUndefined(); expect(f.messages().at(-1)).toMatchObject({ success: true }); expect(child.stdin.end).not.toHaveBeenCalled();
  });

  it.each(['refusal', 'timeout', 'close'])('does not persist a text preference on %s, including late ACK', async mode => {
    await warm(); const f = handlerFixture(); const pending = f.send('/model opus'); await tick();
    const packet = control(); expect(packet).toBeDefined();
    if (mode === 'timeout') await vi.advanceTimersByTimeAsync(10000);
    else if (mode === 'close') child.emit('close', 0);
    else respond({ subtype: 'error', error_code: 'not_found', model: 'synthetic-sonnet' });
    await pending; expect(f.thread.models.claude).toBe('sonnet'); expect(f.messages().at(-1)).toMatchObject({ success: false });
    ack('synthetic-opus', packet); expect(f.thread.models.claude).toBe('sonnet');
  });

  it('permits a terminal-error text retry through the real pool while ordinary work remains fenced', async () => {
    await warm(); const f = handlerFixture();
    const first = f.send('/model opus'); await tick();
    respond({ subtype: 'error', error_code: 'internal_error', model: 'synthetic-opus' });
    await first;
    expect(f.pool.isThreadBusy(f.thread.id)).toBe(true);
    expect(f.thread.models.claude).toBe('sonnet');
    const retry = f.send('/model sonnet'); await tick();
    expect(control().request.model).toBe('sonnet'); ack('synthetic-sonnet'); await retry;
    expect(f.messages().at(-1)).toMatchObject({ success: true });
    expect(f.pool.isThreadBusy(f.thread.id)).toBe(false);
    expect(child.stdin.end).not.toHaveBeenCalled();
  });

  it.each(['host', 'windows-directory-handles'] as const)('offers explicit destructive clear after timeout and ignores the retired control reply (%s)', async filesystem => {
    await warm(); const job = await reserve(); const f = handlerFixture();
    vi.spyOn(f.inner.delegation, 'requestNativeSessionDeletion').mockResolvedValue(undefined);
    vi.spyOn(f.inner.delegation, 'cancelThread').mockResolvedValue(undefined);
    const pending = f.send('/model opus'); await tick(); const packet = control();
    await vi.advanceTimersByTimeAsync(10000); await pending;
    if (filesystem === 'windows-directory-handles') {
      const openSync = fsSync.openSync;
      // Windows cannot open directory handles through Node's file API. Reproduce
      // that boundary on every runner while retaining real file persistence.
      vi.spyOn(fsSync, 'openSync').mockImplementation((...args: Parameters<typeof fsSync.openSync>) => {
        if (fsSync.statSync(args[0], { throwIfNoEntry: false })?.isDirectory()) {
          throw Object.assign(new Error('Synthetic Windows directory handle refusal'), { code: 'EPERM' });
        }
        return openSync(...args);
      });
    }
    // The Linux override above simulates the native model-control host.
    // Destructive clear uses real filesystem durability APIs, whose platform
    // must match the host (or the directory-handle boundary simulated here).
    vi.spyOn(process, 'platform', 'get').mockReturnValue(filesystem === 'host' ? hostPlatform : 'win32');
    await f.send('/clear');
    expect(f.messages().at(-1)?.error, f.messages().at(-1)?.error).toBeUndefined();
    expect(f.messages().at(-1)).toMatchObject({ success: true, output: expect.stringContaining('schedules were lost') });
    expect(f.manager.contextResets.isPending(f.thread.id)).toBe(false);
    expect(f.manager.contextResets.generation(f.thread.id)).toBe(1);
    expect(f.manager.clearBackendSessionPointers).toHaveBeenCalledWith(f.thread.id);
    expect(child.stdin.end).toHaveBeenCalledOnce(); expect(executor.isProcessRunning()).toBe(false);
    expect(await job.handle.list!()).toBe(false); ack('synthetic-opus', packet); expect(raw.model).toBe('sonnet');
  });

  it('supports explicit text default using native validation without killing the host', async () => {
    await warm(); const f = handlerFixture(); const pending = f.send('/model default'); await tick();
    expect(control().request).toEqual({ subtype: 'set_model', model: 'default' });
    ack('synthetic-default'); await pending;
    expect(f.thread.models.claude).toBe('default'); expect(raw.model).toBe('default');
    expect(child.stdin.end).not.toHaveBeenCalled();
  });

  it('leaves a card preference unchanged on native refusal', async () => {
    await warm(); const f = handlerFixture();
    await f.handler.handleMessage({ type: 'binding_confirm', data: { success: true, capabilities: { settingsCards: true } } } as any);
    await f.send('/model'); const menu = f.messages().findLast((m: any) => m.settingsMenu).settingsMenu;
    const pending = f.handler.handleMessage({ type: 'settings_action', operation: 'apply', value: 'opus', openId: 'synthetic-owner', threadId: f.thread.id,
      messageId: 'refused-card', snapshotId: menu.snapshotId, timestamp: Date.now() } as any);
    await tick(); respond({ subtype: 'error', error_code: 'not_found', model: 'synthetic-sonnet' }); await pending;
    expect(f.thread.models.claude).toBe('sonnet');
    expect(f.messages().findLast((m: any) => m.type === 'settings_result')).toMatchObject({ success: false });
    expect(child.stdin.end).not.toHaveBeenCalled();
  });

  it.each([undefined, 'opus'])('card reset follows global %s through native control, then clears thread override', async fallback => {
    await warm(); const f = handlerFixture(); f.setGlobal(fallback);
    await f.handler.handleMessage({ type: 'binding_confirm', data: { success: true, capabilities: { settingsCards: true } } } as any);
    await f.send('/model');
    const menu = f.messages().findLast((m: any) => m.settingsMenu)?.settingsMenu;
    expect(menu).toBeDefined();
    const pending = f.handler.handleMessage({ type: 'settings_action', operation: 'reset', openId: 'synthetic-owner', threadId: f.thread.id,
      messageId: 'reset-card', snapshotId: menu.snapshotId, timestamp: Date.now() } as any);
    await tick(); expect(control().request).toEqual({ subtype: 'set_model', ...(fallback ? { model: fallback } : {}) });
    expect(f.thread.models.claude).toBe('sonnet'); ack(fallback ? 'synthetic-opus' : 'synthetic-default'); await pending;
    expect(f.thread.models?.claude).toBeUndefined(); expect(f.messages().findLast((m: any) => m.type === 'settings_result')).toMatchObject({ success: true });
    expect(child.stdin.end).not.toHaveBeenCalled();
  });
});
