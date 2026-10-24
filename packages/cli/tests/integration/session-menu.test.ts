import { ThreadContextReset } from '../../src/thread/ThreadContextReset';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'os';
import path from 'path';

vi.mock('../../src/client/WebSocketClient');
vi.mock('../../src/session/adapters', () => ({
  SESSION_CATALOG_READERS: { claude: () => undefined, codex: () => undefined, pi: () => undefined },
  readSessionCatalog: vi.fn(),
}));

import { MessageHandler } from '../../src/client/MessageHandler';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { readSessionCatalog } from '../../src/session/adapters';

const originalHomedir = os.homedir.bind(os);
vi.spyOn(os, 'homedir').mockImplementation(() => process.env.HOME || originalHomedir());

describe('Integration: paged read-only session menus', () => {
  let handler: MessageHandler;
  let wsClient: any;
  let executor: any;
  let threadPool: any;
  let config: any;
  let guard: DirectoryGuard;
  let workingDirectory: string;

  const catalog = {
    candidates: Array.from({ length: 20 }, (_, i) => ({
      id: `session-${String(i).padStart(2, '0')}`, name: i === 13 ? 'Fix login flow' : undefined,
      source: 'native-local' as const, modifiedAt: 1_700_000_000_000 - i, messageCount: 0, countComplete: false,
    })),
    complete: true, notes: [],
  };

  const send = async (messageId: string, content: string, overrides: Record<string, unknown> = {}) => {
    await handler.handleMessage({ type: 'command', messageId, content, isSlashCommand: true, openId: 'owner-example',
      timestamp: Date.now(), ...overrides } as any);
    return wsClient.send.mock.calls.map((call: any[]) => call[0]).find((m: any) => m.messageId === messageId);
  };
  const tokenOf = (output: string) => /menu `([A-Za-z0-9_-]{12})`/.exec(output)![1];

  beforeEach(() => {
    vi.clearAllMocks();
    workingDirectory = path.join(os.homedir(), 'projects');
    wsClient = { send: vi.fn(), on: vi.fn(), isConnected: vi.fn(() => true) };
    executor = { execute: vi.fn(), getCurrentWorkingDirectory: vi.fn(() => '~/projects') };
    guard = new DirectoryGuard(['~/projects']);
    vi.spyOn(guard, 'isSafePath').mockReturnValue(true);
    const thread = { id: 'thread-a', name: 'default', workingDirectory: '~/projects', sessionId: null, createdAt: 0, lastActiveAt: 0 };
    const threads: Record<string, any> = { 'thread-a': thread, 'thread-b': { ...thread, id: 'thread-b', name: 'other' } };
    const threadManager: any = {
      contextResets: new ThreadContextReset(),
      getDefaultThread: vi.fn(() => thread),
      getThread: vi.fn((id: string) => threads[id]),
      getThreadByName: vi.fn(),
      listThreads: vi.fn(() => Object.values(threads)),
    };
    threadPool = {
      getExecutor: vi.fn(() => executor),
      isThreadBusy: vi.fn(() => false),
      getSummaries: vi.fn(() => []),
      getBackendKey: vi.fn(() => 'pi'),
    };
    config = { get: vi.fn((key: string) => key === 'sessionSharing' ? { enabled: true } : undefined),
      set: vi.fn(), has: vi.fn(() => true), getAll: vi.fn(() => ({})), getConfigDir: vi.fn(() => '/tmp/test-config') };
    (readSessionCatalog as any).mockReturnValue(catalog);
    handler = new MessageHandler(wsClient, threadPool, threadManager, guard, config);
  });

  it('lists the first page with a token, then pages and searches without any executor', async () => {
    const first = await send('list', '/resume');
    expect(first.success).toBe(true);
    expect(first.output).toContain('Page 1/3');
    expect(first.output).toContain('8. Session session-');
    expect(readSessionCatalog).toHaveBeenCalledWith('pi', workingDirectory);
    const token = tokenOf(first.output);

    const second = await send('page-2', `/resume page ${token} 2`);
    expect(second.output).toContain('Page 2/3');
    expect(second.output).toContain('9. Session session-');

    const found = await send('search', `/resume search ${token} login`);
    expect(found.output).toContain('1. Fix login flow');
    expect(found.output).toContain('Page 1/1 \u00b7 search "login"');
    expect(tokenOf(found.output)).not.toBe(token);
    // Paging never reloads native metadata: the snapshot fixes the rows.
    expect(readSessionCatalog).toHaveBeenCalledTimes(1);
    expect(threadPool.getExecutor).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('rejects another user, another thread, unknown pages and malformed tokens', async () => {
    const token = tokenOf((await send('list', '/resume')).output);
    expect((await send('other-user', `/resume page ${token} 2`, { openId: 'someone-else' })).error).toContain('expired or belongs');
    expect((await send('other-thread', `/resume page ${token} 2`, { threadId: 'thread-b' })).error).toContain('expired or belongs');
    expect((await send('too-far', `/resume page ${token} 4`)).error).toContain('has 3 pages');
    expect((await send('malformed', '/resume page nope 2')).error).toContain('menu token');
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('invalidates open menus when local sharing is disabled afterwards', async () => {
    const token = tokenOf((await send('list', '/resume')).output);
    config.get.mockImplementation((key: string) => key === 'sessionSharing' ? { enabled: true, backends: { pi: { enabled: false } } } : undefined);
    const denied = await send('after-disable', `/resume page ${token} 2`);
    expect(denied.success).toBe(false);
    expect(denied.error).toContain('disabled for Pi');
  });

  async function prepareConnection(): Promise<string> {
    Object.assign((handler as any).sessionControl.deps, {
      resolvePi: (_cwd: string, id: string) => ({ id, file: `/native/${id}.jsonl`, revision: 'synthetic-revision' }),
      piHolder: () => undefined,
      piBinding: () => undefined,
    });
    executor.adoptNativeSession = vi.fn(async () => ({ success: true }));
    threadPool.setThreadBusy = vi.fn();
    const selected = await send('select', '/resume id session-00');
    expect(selected.success).toBe(true);
    return /\/resume confirm ([A-Za-z0-9_-]{12})/.exec(selected.output)![1];
  }

  it.each(['thread-a', '*'])('rejects Pi confirmation while a %s settings writer is active without consuming its token', async target => {
    const pending = await prepareConnection();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const writer = (handler as any).settingsAdmission.mutation(target, () => gate);
    try {
      const refused = await send('blocked-confirm', `/resume confirm ${pending}`);
      expect(refused.success).toBe(false);
      expect(refused.error).toContain('settings operation');
      expect(executor.adoptNativeSession).not.toHaveBeenCalled();
    } finally { release(); await writer; }
    expect((await send('retry-confirm', `/resume confirm ${pending}`)).success).toBe(true);
    expect(executor.adoptNativeSession).toHaveBeenCalledTimes(1);
  });

  it('holds settings admission throughout Pi startup and rejects an overlapping model change', async () => {
    const pending = await prepareConnection();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    executor.adoptNativeSession.mockImplementation(async () => { await gate; return { success: true }; });
    executor.setModel = vi.fn();
    const connecting = send('connecting', `/resume confirm ${pending}`);
    try {
      expect((handler as any).settingsAdmission.isBlocked('thread-a')).toBe(true);
      expect((await send('model-overlap', '/model example/model-a')).success).toBe(false);
      expect(executor.setModel).not.toHaveBeenCalled();
    } finally { release(); await connecting; }
    expect((handler as any).settingsAdmission.isBlocked('thread-a')).toBe(false);
  });

  it.each(['update', 'workers'])('refuses Pi context changes during %s', async reason => {
    const pending = await prepareConnection();
    if (reason === 'update') (handler as any).automaticUpdateInProgress = true;
    else vi.spyOn((handler as any).delegation, 'hasActiveTasks').mockReturnValue(true);
    expect((await send('busy-confirm', `/resume confirm ${pending}`)).success).toBe(false);
    expect(executor.adoptNativeSession).not.toHaveBeenCalled();
  });

  it.each(['claude', 'codex'])('keeps %s catalogs read-only even during an unrelated settings writer', async backend => {
    threadPool.getBackendKey.mockReturnValue(backend);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const writer = (handler as any).settingsAdmission.mutation('*', () => gate);
    try {
      expect((await send('read-only-list', '/resume')).success).toBe(true);
      expect((await send('no-connect', '/resume id session-00')).success).toBe(false);
      expect(threadPool.getExecutor).not.toHaveBeenCalled();
      expect(executor.execute).not.toHaveBeenCalled();
    } finally { release(); await writer; }
  });
});
