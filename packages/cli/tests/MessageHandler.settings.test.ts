import { ThreadContextReset } from '../src/thread/ThreadContextReset';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, mkdir, realpath, symlink } from 'fs/promises';
import os from 'os';
import { tmpdir } from 'os';
import path from 'path';
import { MessageHandler } from '../src/client/MessageHandler';
import { DirectoryGuard } from '../src/security/DirectoryGuard';
import type { Thread } from '../src/thread/types';
import type { SettingsActionMessage, SettingsBackend, SettingsMenu } from '../src/types/Settings';

const BACKENDS: SettingsBackend[] = ['claude', 'codex', 'opencode', 'kimi', 'zcode', 'pi', 'agy', 'dsh'];

async function fixture(temporaryRoot = tmpdir()) {
  // Temporary roots may contain platform aliases; the browser requires canonical roots.
  const cwd = await realpath(await mkdtemp(path.join(temporaryRoot, 'settings-handler-')));
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
    contextResets: new ThreadContextReset(path.join(cwd, 'reset-markers')),
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
    setWorkingDirectory: vi.fn(async (id: string, target: string) => {
      const thread = threads.find(entry => entry.id === id)!;
      const changed = thread.workingDirectory !== target;
      await manager.updateThread(id, { workingDirectory: target, delegationWorkspaceGeneration: (thread.delegationWorkspaceGeneration ?? 0) + (changed ? 1 : 0) });
      return { cwd: target, changed };
    }),
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
  const open = async (kind: 'backend' | 'model' | 'effort' | 'delegation'): Promise<SettingsMenu> => { await send(`/${kind}`); return responses().at(-1)!.settingsMenu; };
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
    vi.spyOn((f.handler as any).delegation.registry, 'list').mockResolvedValue(BACKENDS.map(backend => ({
      backend, installed: backend !== 'pi' && backend !== 'zcode', worker: backend !== 'pi' && backend !== 'zcode', readOnly: false,
      version: '1.0.0', reason: backend === 'pi' || backend === 'zcode' ? 'Executable is missing' : undefined,
    })));
    await f.handler.handleMessage({ type: 'binding_confirm', data: { success: true, capabilities: { settingsCards: true, delegationCards: true } } } as any);
  });
  afterEach(async () => { await f.handler.destroy(); await rm(f.cwd, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('persists speed separately per backend and rejects speed on old connections', async () => {
    const setSpeed = vi.fn(async () => ({ success: true }));
    Object.assign(f.executor, { setSpeed });
    f.reader.read.mockResolvedValue({ choices: [{ value: 'model-a', label: 'Model A' }], supportsReset: true, effectiveSource: 'unknown',
      speed: { choices: [{ value: 'priority', label: 'Native Fast' }, { value: 'default', label: 'Standard' }] } });
    await f.handler.handleMessage({ type: 'binding_confirm', data: { success: true, capabilities: { settingsCards: true, modelSpeedSettings: true } } } as any);
    const menu = await f.open('model');
    expect(menu.speed?.choices).toHaveLength(2);
    const applied = await f.action(menu, { setting: 'speed', value: 'priority' });
    expect(applied.success).toBe(true);
    expect(f.threads[0].speeds).toEqual({ codex: 'priority' });
    expect(f.threads[1].speeds).toBeUndefined();
    expect(f.threads[0].models?.codex).toBe('saved-codex');
    expect(setSpeed).toHaveBeenCalledWith('priority');
    expect(f.executor.setModel).not.toHaveBeenCalled();
    expect((await f.action(applied.menu, { setting: 'speed', operation: 'reset', value: undefined })).success).toBe(true);
    expect(f.threads[0].speeds).toEqual({ codex: null });
    await f.handler.handleMessage({ type: 'binding_confirm', data: { success: true, capabilities: { settingsCards: true } } } as any);
    const old = await f.open('model');
    expect(old.speed).toBeUndefined();
    expect((await f.action(old, { setting: 'speed', value: 'priority' })).success).toBe(false);
    expect(setSpeed).toHaveBeenCalledTimes(2);
  });

  async function directoryMenu(context = f) {
    vi.spyOn(os, 'homedir').mockReturnValue(context.cwd);
    // The guard captures homedir in its constructor; replace the read-only browser's guard for this fixture.
    (context.handler as any).directoryBrowser.deps.guard = new DirectoryGuard([context.cwd]);
    await context.handler.handleMessage({ type: 'binding_confirm', data: { success: true, capabilities: { settingsCards: true, directoryCards: true } } } as any);
    await context.send('/cd');
    const response = context.responses().at(-1);
    expect(response).toMatchObject({ success: true, settingsMenu: { kind: 'directory' } });
    return response.settingsMenu as SettingsMenu;
  }

  it('opens a directory card when the temporary root is reached through an alias', async () => {
    const target = path.join(f.cwd, 'temporary-root');
    const alias = path.join(f.cwd, 'temporary-alias');
    await mkdir(target);
    await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const linked = await fixture(alias);
    try {
      expect(linked.cwd).toBe(await realpath(linked.cwd));
      expect(path.dirname(linked.cwd)).toBe(target);
      expect(await directoryMenu(linked)).toMatchObject({ kind: 'directory', busy: false });
      expect(linked.pool.getExecutor).not.toHaveBeenCalled();
      expect(linked.pool.setWorkingDirectory).not.toHaveBeenCalled();
    } finally {
      await linked.handler.destroy();
      await rm(linked.cwd, { recursive: true, force: true });
    }
  });

  it('opens /cd without constructing an executor, applies through the shared generation cleanup and deduplicates retries', async () => {
    await mkdir(path.join(f.cwd, 'child'));
    const count = f.pool.getExecutor.mock.calls.length;
    const menu = await directoryMenu();
    expect(menu).toMatchObject({ kind: 'directory', busy: false });
    expect(f.pool.getExecutor.mock.calls.length).toBe(count);
    expect(f.pool.setWorkingDirectory).not.toHaveBeenCalled();
    const child = await f.action(menu, { operation: 'view', value: menu.choices[0].value });
    expect(child.success).toBe(true);
    expect(f.threads[0].workingDirectory).toBe(f.cwd);
    const cleanup = vi.spyOn((f.handler as any).delegation, 'invalidateWorkspaceGeneration').mockResolvedValue({ removed: 0, failed: 1 });
    const fields = { messageId: 'directory-apply-request', value: child.menu.directory.apply };
    const applied = await f.action(child.menu, fields);
    expect(applied.success).toBe(true);
    expect(applied.notice).toContain('1 delegated worker lane(s)');
    expect(cleanup).toHaveBeenCalledWith('thread-a', 1);
    expect(f.pool.setWorkingDirectory).toHaveBeenCalledTimes(1);
    expect((await f.action(child.menu, fields)).success).toBe(true);
    expect(f.pool.setWorkingDirectory).toHaveBeenCalledTimes(1);
    expect(f.threads[1].workingDirectory).toBe(f.cwd);
    expect(f.executor.execute).not.toHaveBeenCalled();
  });

  it('retains text /cd with old peers and uses the same cleanup path', async () => {
    await f.send('/cd');
    expect(f.responses().at(-1)).toMatchObject({ success: false, error: 'Usage: /cd <directory>' });
    const cleanup = vi.spyOn((f.handler as any).delegation, 'invalidateWorkspaceGeneration').mockResolvedValue({ removed: 0, failed: 0 });
    await f.send(`/cd ${f.cwd}/child`);
    expect(f.pool.setWorkingDirectory).toHaveBeenCalledWith('thread-a', `${f.cwd}/child`);
    expect(cleanup).toHaveBeenCalledWith('thread-a', 1);
  });

  it('permits browsing while the main thread is busy, rejects Apply, and ignores unnegotiated directory actions', async () => {
    const menu = await directoryMenu();
    f.busy.add('thread-a');
    const refreshed = await f.action(menu, { operation: 'view', value: menu.directory!.refresh });
    expect(refreshed.success).toBe(true);
    expect((await f.action(refreshed.menu, { value: refreshed.menu.directory.apply })).success).toBe(false);
    expect(f.pool.setWorkingDirectory).not.toHaveBeenCalled();
    await f.handler.handleMessage({ type: 'binding_confirm', data: { success: true, capabilities: { settingsCards: true } } } as any);
    const count = f.results().length;
    await f.action(refreshed.menu, { value: refreshed.menu.directory.apply });
    expect(f.results()).toHaveLength(count);
  });

  it.each(['card', 'text'])('blocks automatic updates and another directory change while %s Apply holds admission', async mode => {
    const menu = await directoryMenu();
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.pool.setWorkingDirectory.mockImplementationOnce(async (_id, target) => {
      entered(); await gate; return { cwd: target, changed: false };
    });
    const applying = mode === 'card' ? f.action(menu, { value: menu.directory!.apply }) : f.send(`/cd ${f.cwd}`);
    await waiting;
    try {
      expect(f.handler.tryBeginAutomaticUpdate()).toBe(false);
      await f.send(`/cd ${f.cwd}/elsewhere`);
      expect(f.responses().at(-1)).toMatchObject({ success: false, error: expect.stringContaining('Retry when it is idle') });
      expect(f.pool.setWorkingDirectory).toHaveBeenCalledTimes(1);
    } finally { release(); }
    const applied = await applying;
    if (mode === 'card') expect(applied.success).toBe(true);
    else expect(f.responses().at(-1).success).toBe(true);
  });

  it('opens and toggles delegation for the original thread without running an agent', async () => {
    Object.assign(f.executor, { configureDelegation: vi.fn(async () => {}) });
    const menu = await f.open('delegation');
    expect(menu).toMatchObject({ kind: 'delegation', configuredValue: 'on', busy: false });
    expect(menu.backends.find(row => row.value === 'codex')).toMatchObject({ worker: true, installed: true });
    const off = await f.action(menu, { value: 'off' });
    expect(off).toMatchObject({ success: true, menu: { configuredValue: 'off' } });
    expect(f.threads[0].delegation).toBe(false);
    expect(f.threads[1].delegation).toBeUndefined();
    expect((await f.action(off.menu, { value: 'on' })).success).toBe(true);
    expect(f.threads[0].delegation).toBe(true);
    expect(f.executor.execute).not.toHaveBeenCalled();
    expect(f.reader.read).not.toHaveBeenCalled();
  });

  it('preserves native cleanup ownership and waits for Off cleanup before acknowledging', async () => {
    f.threads[0].delegation = true;
    let release!: () => void;
    const configure = vi.fn(async () => new Promise<void>(resolve => { release = resolve; }));
    Object.assign(f.executor, { configureDelegation: configure });
    const close = vi.fn(async () => {});
    (f.handler as any).delegationBridges.set('thread-a', { close });
    const menu = await f.open('delegation');
    const applying = f.action(menu, { value: 'off' });
    await vi.waitFor(() => expect(configure).toHaveBeenCalledWith(undefined));
    expect(f.results()).toHaveLength(0);
    expect(f.threads[0].delegation).toBe(true);
    release();
    expect((await applying).success).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(f.threads[0]).toMatchObject({ delegation: false, delegationBackends: ['codex'] });
  });

  it('shows sandbox policy independently from the enabled flag and blocks busy workers', async () => {
    Object.assign(f.executor, { configureDelegation: vi.fn(async () => {}) });
    f.setConfig({ type: 'codex', codex: { sandbox: { mode: 'workspace-write' } } });
    const menu = await f.open('delegation');
    expect(menu.configuredValue).toBe('on');
    expect(menu.backends.filter(row => row.installed).every(row => row.worker === false && row.reason?.includes('sandbox'))).toBe(true);
    vi.spyOn((f.handler as any).delegation, 'hasActiveTasks').mockReturnValue(true);
    const busy = await f.open('delegation');
    expect(busy.busy).toBe(true);
    expect((await f.action(busy, { value: 'off' })).success).toBe(false);
    expect(f.threads[0].delegation).toBeUndefined();
  });

  it('keeps text delegation for old Routers and rejects stale cards after text toggles', async () => {
    Object.assign(f.executor, { configureDelegation: vi.fn(async () => {}) });
    const menu = await f.open('delegation');
    await f.send('/delegation off');
    expect((await f.action(menu, { value: 'on' })).success).toBe(false);
    await f.handler.handleMessage({ type: 'binding_confirm', data: { success: true, capabilities: { settingsCards: true } } } as any);
    await f.send('/delegation');
    expect(f.responses().at(-1)).toMatchObject({ success: true });
    expect(f.responses().at(-1).settingsMenu).toBeUndefined();
    expect(f.responses().at(-1).output).toContain('Agent delegation');
    await f.send('/delegation on');
    expect(f.threads[0].delegation).toBe(true);
  });

  it.each(['main', 'queue'] as const)('rechecks %s work started after opening a delegation card', async work => {
    Object.assign(f.executor, { configureDelegation: vi.fn(async () => {}) });
    const menu = await f.open('delegation');
    if (work === 'main') f.busy.add('thread-a');
    else {
      (f.handler as any).threadQueues.set('thread-a', [{ messageId: 'queued-work', content: 'Synthetic work' }]);
      (f.handler as any).pausedQueues.add('thread-a');
    }
    expect((await f.action(menu, { value: 'off' })).success).toBe(false);
    const busy = await f.open('delegation');
    expect(busy.busy).toBe(true);
    expect(f.threads[0].delegation).toBeUndefined();
  });

  it.each(['cleanup', 'persistence'] as const)('does not acknowledge Off after a %s failure', async failure => {
    f.threads[0].delegation = true;
    f.threads[0].delegationBackends = ['codex', 'agy'];
    const configure = vi.fn(async () => {});
    Object.assign(f.executor, { configureDelegation: configure });
    const menu = await f.open('delegation');
    if (failure === 'cleanup') configure.mockRejectedValueOnce(new Error('Synthetic cleanup failure'));
    else f.manager.updateThread.mockRejectedValueOnce(new Error('Synthetic persistence failure'));
    const result = await f.action(menu, { value: 'off' });
    expect(result.success).toBe(false);
    expect(f.threads[0]).toMatchObject({ delegation: true, delegationBackends: ['codex', 'agy'] });
    expect(f.threads[0].models).toMatchObject({ codex: 'saved-codex', claude: 'saved-claude' });
    expect(f.threads[0].efforts).toEqual({ agy: 'low' });
    expect(JSON.stringify(result)).not.toContain(`Synthetic ${failure} failure`);
  });

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
