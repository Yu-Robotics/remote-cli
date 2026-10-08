import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { MessageHandler } from '../src/client/MessageHandler';
import { DirectoryGuard } from '../src/security/DirectoryGuard';
import type { Thread } from '../src/thread/types';
import type { SettingsActionMessage, SettingsBackend, SettingsMenu } from '../src/types/Settings';

const BACKENDS: SettingsBackend[] = ['claude', 'codex', 'opencode', 'kimi', 'zcode', 'pi', 'agy', 'dsh'];

async function fixture() {
  const cwd = await mkdtemp(path.join(tmpdir(), 'settings-handler-'));
  const threads: Thread[] = ['thread-a', 'thread-b'].map(id => ({ id, name: id, workingDirectory: cwd, sessionId: null,
    createdAt: 0, lastActiveAt: 0, models: { codex: 'saved-codex', claude: 'saved-claude' }, efforts: { agy: 'low' } }));
  let config: any = { type: 'codex', claude: { model: 'global-claude' } };
  let closed: (() => void) | undefined;
  const busy = new Set<string>();
  const executor = {
    execute: vi.fn(async () => ({ success: true, output: 'Done' })),
    getCurrentWorkingDirectory: vi.fn(() => cwd), setWorkingDirectory: vi.fn(async () => {}),
    setModel: vi.fn(async () => ({ success: true })), clearModel: vi.fn(async () => {}),
    setEffort: vi.fn(async () => ({ success: true })), resetContext: vi.fn(async () => {}),
    abort: vi.fn(async () => true), destroy: vi.fn(async () => {}),
    listModels: vi.fn(async () => [{ id: 'model-a', displayName: 'Model A', isDefault: true }]),
  };
  const preview = { ...executor, setModel: vi.fn(async () => ({ success: true })), setEffort: vi.fn(async () => ({ success: true })), clearModel: vi.fn(async () => {}) };
  const manager = {
    getDefaultThread: vi.fn(() => threads[0]), getThread: vi.fn((id: string) => threads.find(thread => thread.id === id)),
    listThreads: vi.fn(() => threads),
    updateThread: vi.fn(async (id: string, fields: Partial<Thread>) => { const thread = threads.find(entry => entry.id === id)!; Object.assign(thread, fields); return thread; }),
    clearBackendOverrides: vi.fn(async () => { threads.forEach(thread => { delete thread.backend; }); }),
  };
  const pool = {
    getExecutor: vi.fn(() => executor), getBackendKey: vi.fn((id: string) => threads.find(thread => thread.id === id)?.backend ?? (config.type === 'auto' ? 'claude' : config.type)),
    getSummaries: vi.fn(() => threads.map(thread => ({ id: thread.id, name: thread.name, status: busy.has(thread.id) ? 'running' : 'idle' }))),
    isThreadBusy: vi.fn((id: string) => busy.has(id)), setThreadBusy: vi.fn((id: string, value: boolean) => { value ? busy.add(id) : busy.delete(id); }),
    setThreadError: vi.fn(), destroyAll: vi.fn(async () => {}), destroyThread: vi.fn(async () => {}),
    switchThreadBackend: vi.fn(async (id: string, backend: SettingsBackend) => { await manager.updateThread(id, { backend }); }),
    switchBackend: vi.fn(async () => {}),
  };
  const ws = { send: vi.fn(), trackTask: vi.fn(), hasPendingTaskResults: vi.fn(() => false), isConnected: vi.fn(() => true),
    onClose: vi.fn((callback: () => void) => { closed = callback; }) };
  const configManager = { get: vi.fn((key: string) => key === 'executor' ? config : undefined),
    set: vi.fn(async (key: string, value: unknown) => { if (key === 'executor') config = value; }),
    getConfigDir: vi.fn(() => path.join(cwd, 'config')), getAll: vi.fn(() => ({ executor: config })), save: vi.fn(async () => {}) };
  const handler = new MessageHandler(ws as any, pool as any, manager as any, new DirectoryGuard([cwd]), configManager as any);
  vi.spyOn(handler as any, 'detectBackends').mockResolvedValue(BACKENDS.map(value => ({ id: value === 'claude' ? 'auto' : value,
    label: value, installed: value !== 'pi' && value !== 'zcode', reason: value === 'pi' || value === 'zcode' ? 'Not installed' : undefined })));
  const reader = (handler as any).settingsCatalogReader;
  vi.spyOn(reader, 'read').mockImplementation(async (...args: any[]) => {
    const kind = args[4];
    return { choices: kind === 'model' ? [{ value: 'model-a', label: 'Model A' }, { value: 'model-b', label: 'Model B' }]
      : [{ value: 'high', label: 'High' }, { value: 'medium', label: 'Medium' }],
    effectiveSource: 'unknown', supportsReset: true };
  });
  vi.spyOn(reader, 'withExecutor').mockImplementation(async (...args: any[]) => args[4](preview));
  let sequence = 0;
  const send = (content: string, threadId = 'thread-a') => handler.handleMessage({ type: 'command',
    messageId: `command-${++sequence}`, openId: 'owner-a', threadId, content, timestamp: Date.now() } as any);
  const responses = () => ws.send.mock.calls.map(([value]) => value as any).filter(value => value.type === 'response');
  const results = () => ws.send.mock.calls.map(([value]) => value as any).filter(value => value.type === 'settings_result');
  const open = async (kind: 'backend' | 'model' | 'effort'): Promise<SettingsMenu> => { await send(`/${kind}`); return responses().at(-1)!.settingsMenu; };
  const action = async (menu: SettingsMenu, fields: Partial<SettingsActionMessage> = {}) => {
    const request = { type: 'settings_action', messageId: `action-${++sequence}`, openId: 'owner-a', threadId: menu.threadId,
      snapshotId: menu.snapshotId, operation: 'apply', value: 'model-a', timestamp: Date.now(), ...fields };
    await handler.handleMessage(request as any);
    return results().at(-1);
  };
  return { handler, cwd, threads, busy, executor, preview, manager, pool, ws, reader, configManager, send, open, action, responses, results,
    setConfig: (value: any) => { config = value; }, close: () => closed!() };
}

describe('settings cards command integration', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    f = await fixture();
    await f.handler.handleMessage({ type: 'binding_confirm', data: { success: true, capabilities: { settingsCards: true } } } as any);
  });
  afterEach(async () => { await f.handler.destroy(); await rm(f.cwd, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it.each(['backend', 'model', 'effort'] as const)('opens a dedicated %s snapshot without executing an agent prompt', async kind => {
    const menu = await f.open(kind);
    expect(menu).toMatchObject({ kind, threadId: 'thread-a', coordinatorBackend: 'codex', targetBackend: 'codex', busy: false });
    expect(menu.backends.map(row => row.value)).toEqual(BACKENDS);
    expect(menu.backends.filter(row => !row.installed).map(row => row.value)).toEqual(['zcode', 'pi']);
    expect(f.executor.execute).not.toHaveBeenCalled();
    expect(f.preview.execute).not.toHaveBeenCalled();
    expect(f.pool.switchThreadBackend).not.toHaveBeenCalled();
  });

  it('keeps text-only behavior and ignores unnegotiated card actions for older Routers', async () => {
    await f.handler.handleMessage({ type: 'binding_confirm', data: { success: true, capabilities: {} } } as any);
    await f.send('/model');
    expect(f.responses().at(-1).settingsMenu).toBeUndefined();
    expect(f.executor.listModels).toHaveBeenCalledTimes(1);
    await f.handler.handleMessage({ type: 'settings_action', messageId: 'unnegotiated', snapshotId: 'unused',
      threadId: 'thread-a', openId: 'owner-a', operation: 'apply', value: 'model-a', timestamp: Date.now() } as any);
    expect(f.results()).toEqual([]);
    expect(f.executor.setModel).not.toHaveBeenCalled();
  });

  it('configures an inactive backend without switching or replacing the coordinator', async () => {
    const menu = await f.open('model');
    const viewed = await f.action(menu, { operation: 'view', value: undefined, targetBackend: 'agy' });
    expect(viewed.success).toBe(true);
    expect(f.pool.getBackendKey('thread-a')).toBe('codex');
    const result = await f.action(viewed.menu);
    expect(result.success).toBe(true);
    expect(f.preview.setModel).toHaveBeenCalledWith('model-a', undefined);
    expect(f.executor.setModel).not.toHaveBeenCalled();
    expect(f.threads[0].models).toMatchObject({ agy: 'model-a', codex: 'saved-codex' });
    expect(f.pool.destroyThread).not.toHaveBeenCalled();
    expect(f.pool.switchThreadBackend).not.toHaveBeenCalled();
    expect(f.pool.getBackendKey('thread-a')).toBe('codex');
    expect(f.reader.withExecutor.mock.calls[0][2]).toBe('codex');
    expect(f.reader.withExecutor.mock.calls[0][3]).toBe('agy');
  });

  it.each([false, true])('mirrors legacy Claude model writes and clearing when active=%s', async active => {
    if (active) f.threads[0].backend = 'claude';
    let menu = await f.open('model');
    if (!active) menu = (await f.action(menu, { operation: 'view', value: undefined, targetBackend: 'claude' })).menu;
    expect((await f.action(menu)).success).toBe(true);
    expect(f.threads[0]).toMatchObject({ model: 'model-a', models: { claude: 'model-a', codex: 'saved-codex' } });
    const resetMenu = f.results().at(-1).menu;
    expect((await f.action(resetMenu, { operation: 'reset', value: undefined })).success).toBe(true);
    expect(f.threads[0].model).toBeUndefined();
    expect(f.threads[0].models?.claude).toBeUndefined();
    expect(f.threads[0].models?.codex).toBe('saved-codex');
    expect(active ? f.executor.setModel : f.preview.setModel).toHaveBeenLastCalledWith('global-claude', undefined);
    expect(f.pool.getBackendKey('thread-a')).toBe(active ? 'claude' : 'codex');
  });

  it('saves inactive effort and clears only that backend override with auto', async () => {
    const menu = await f.open('effort');
    const viewed = await f.action(menu, { operation: 'view', value: undefined, targetBackend: 'agy' });
    const set = await f.action(viewed.menu, { value: 'high' });
    expect(set.success).toBe(true);
    expect(f.preview.setEffort).toHaveBeenCalledWith('high');
    expect(f.threads[0].efforts?.agy).toBe('high');
    expect((await f.action(set.menu, { operation: 'reset', value: undefined })).success).toBe(true);
    expect(f.preview.setEffort).toHaveBeenLastCalledWith('auto');
    expect(f.threads[0].efforts).toBeUndefined();
  });

  it('keeps backend drafts harmless and applies only explicit thread/all actions', async () => {
    f.threads[1].backend = 'claude';
    const menu = await f.open('backend');
    expect(f.pool.switchBackend).not.toHaveBeenCalled();
    const local = await f.action(menu, { value: 'agy', scope: 'thread' });
    expect(local.success).toBe(true);
    expect(f.threads[0].backend).toBe('agy');
    expect(f.threads[1].backend).toBe('claude');
    expect(f.configManager.set).not.toHaveBeenCalled();
    const all = await f.action(local.menu, { value: 'codex', scope: 'all' });
    expect(all.success).toBe(true);
    expect(f.pool.switchBackend).toHaveBeenCalledWith(expect.objectContaining({ type: 'codex' }));
    expect(f.threads.every(thread => thread.backend === undefined)).toBe(true);
  });

  it('follows the global backend without deleting native conversation data', async () => {
    f.threads[0].backend = 'agy';
    const menu = await f.open('backend');
    expect((await f.action(menu, { operation: 'follow_global', value: undefined })).success).toBe(true);
    expect(f.pool.destroyThread).toHaveBeenCalledWith('thread-a', { deleteData: false });
    expect(f.threads[0].backend).toBeUndefined();
  });

  it('shows busy state honestly and rechecks work that begins after a menu query', async () => {
    f.busy.add('thread-a');
    const busy = await f.open('model');
    expect(busy.busy).toBe(true);
    expect(f.reader.read).not.toHaveBeenCalled();
    f.busy.delete('thread-a');
    expect((await f.action(busy)).success).toBe(false);
    const fresh = await f.open('model');
    f.busy.add('thread-a');
    expect((await f.action(fresh)).success).toBe(false);
    expect(f.executor.setModel).not.toHaveBeenCalled();
  });

  it('does not retarget original cards when commands or user actions use a different thread', async () => {
    const menu = await f.open('model');
    await f.send('/status', 'thread-b');
    expect((await f.action(menu, { threadId: 'thread-b' })).success).toBe(false);
    expect((await f.action(menu)).success).toBe(true);
    expect(f.manager.updateThread).toHaveBeenLastCalledWith('thread-a', expect.anything());
    expect(f.threads[1].models?.codex).toBe('saved-codex');
  });

  it('does not acknowledge native success until the preference has been persisted', async () => {
    const menu = await f.open('model');
    let release!: () => void;
    f.manager.updateThread.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return f.threads[0]; });
    const changing = f.action(menu);
    await vi.waitFor(() => expect(f.manager.updateThread).toHaveBeenCalled());
    expect(f.results()).toEqual([]);
    release();
    expect((await changing).success).toBe(true);
  });

  it('does not persist a rejected native change or claim success after persistence failure', async () => {
    const menu = await f.open('model');
    f.executor.setModel.mockResolvedValueOnce({ success: false });
    expect((await f.action(menu)).success).toBe(false);
    expect(f.manager.updateThread).not.toHaveBeenCalled();
    const fresh = await f.open('model');
    f.manager.updateThread.mockRejectedValueOnce(new Error('Private persistence details'));
    const result = await f.action(fresh);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain('Private persistence details');
  });

  it('holds commands behind a settings mutation and deduplicates concurrent retries', async () => {
    const menu = await f.open('model');
    let release!: () => void;
    f.executor.setModel.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return { success: true }; });
    const fields = { messageId: 'same-action-request' };
    const first = f.action(menu, fields);
    const retry = f.action(menu, fields);
    await vi.waitFor(() => expect(f.executor.setModel).toHaveBeenCalledTimes(1));
    const command = f.send('Read the updated settings');
    await Promise.resolve();
    expect(f.executor.execute).not.toHaveBeenCalled();
    release();
    await Promise.all([first, retry, command]);
    expect(f.executor.setModel).toHaveBeenCalledTimes(1);
    expect(f.executor.execute).toHaveBeenCalledTimes(1);
  });

  it('retains parameterized text semantics and invalidates previous card revisions', async () => {
    const menu = await f.open('backend');
    await f.send('/backend 6 @');
    expect(f.pool.switchThreadBackend).toHaveBeenCalledWith('thread-a', 'dsh');
    expect((await f.action(menu, { value: 'agy' })).success).toBe(false);
    await f.send('/backend 2');
    expect(f.pool.switchBackend).toHaveBeenCalledWith(expect.objectContaining({ type: 'codex' }));
    expect(f.threads[0].backend).toBeUndefined();
  });

  it('invalidates menus on disconnect and preserves original ACK receipts on an identical retry', async () => {
    const menu = await f.open('model');
    const changed = await f.action(menu, { messageId: 'stable-request' });
    expect(changed.success).toBe(true);
    f.close();
    expect((await f.action(changed.menu)).success).toBe(false);
    expect((await f.action(menu, { messageId: 'stable-request' })).success).toBe(true);
    expect(f.executor.setModel).toHaveBeenCalledTimes(1);
  });
});
