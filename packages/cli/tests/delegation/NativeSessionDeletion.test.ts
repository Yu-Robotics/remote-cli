import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureCodexDeletionTarget, deleteOwnedCodexSession, NativeSessionDeletionQueue,
  type NativeSessionDeletionTarget, type NativeDeletionPreparation } from '../../src/delegation/NativeSessionDeletion';

// Synthetic values with the required Thread fields and source variants from the
// installed Codex 0.166.0 generate-json-schema v2/ThreadListResponse.json.
function metadata(id = randomUUID(), extra: Record<string, unknown> = {}) {
  return { id, sessionId: id, parentThreadId: null, source: 'appServer', cwd: '',
    cliVersion: '0.166.0', createdAt: 1, updatedAt: 1, ephemeral: false,
    modelProvider: 'synthetic', preview: '', projectId: null, status: { type: 'notLoaded' }, turns: [], ...extra };
}
const sourceKinds = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview',
  'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];

describe('permanent native session deletion', () => {
  let home: string;
  let pointer: string;
  let target: NativeSessionDeletionTarget;
  let root: ReturnType<typeof metadata>;
  let unrelated: ReturnType<typeof metadata>;
  let respond: ReturnType<typeof vi.fn>;
  let client: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; getServerVersion: ReturnType<typeof vi.fn>; request: ReturnType<typeof vi.fn> };
  let factory: ReturnType<typeof vi.fn>;
  const list = (data: unknown[], nextCursor: string | null = null) => ({ data, nextCursor, backwardsCursor: null });
  const wasDeleted = () => client.request.mock.calls.some(([method]) => method === 'thread/delete');
  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-deletion-')));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('CODEX_HOME', path.join(home, '.codex'));
    const executorThreadId = `delegate-lane-${randomUUID()}`;
    const sessionId = randomUUID();
    pointer = path.join(home, '.remote-cli', 'codex-sessions', `${executorThreadId}.json`);
    await fs.mkdir(path.dirname(pointer), { recursive: true });
    await fs.mkdir(path.join(home, '.codex'));
    await fs.writeFile(pointer, JSON.stringify({ id: sessionId }), { mode: 0o600 });
    target = await captureCodexDeletionTarget({ sessionId, executorThreadId, home,
      nativeHome: path.join(home, '.codex'), cwd: home, command: 'synthetic-codex' });
    root = metadata(sessionId, { cwd: home });
    unrelated = metadata(randomUUID(), { cwd: home, source: 'cli', status: { type: 'active', activeFlags: [] } });
    respond = vi.fn(async (method: string, params: any) => method === 'thread/read' ? { thread: root }
      : method === 'thread/list' ? list(params.archived ? [] : [unrelated, root]) : {});
    client = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}), getServerVersion: vi.fn(() => '0.166.0'),
      request: vi.fn(async (method: string, params: any) => {
        // Exact allowed request keys: 0.166.0 has NO ancestorThreadId filter.
        if (method === 'thread/list') {
          expect(Object.keys(params).sort()).toEqual(['archived', 'cursor', 'limit', 'modelProviders', 'sortDirection', 'sortKey', 'sourceKinds']);
          expect(params).toMatchObject({ sourceKinds, modelProviders: [], limit: 100, sortKey: 'created_at', sortDirection: 'asc' });
        } else if (method === 'thread/read') expect(params).toEqual({ threadId: target.sessionId, includeTurns: false });
        else {
          expect(method).toBe('thread/delete');
          expect(params).toEqual({ threadId: target.sessionId });
        }
        return respond(method, params);
      }) };
    factory = vi.fn(() => client);
  });
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(home, { recursive: true, force: true }); });

  it('allows root and unrelated entries, deletes only the owned identity and preserves pointers/artifacts', async () => {
    const artifact = path.join(home, 'immutable-artifact');
    await fs.writeFile(artifact, 'preserve');
    expect(await deleteOwnedCodexSession(target, factory)).toMatchObject({ state: 'deleted' });
    expect(client.request.mock.calls.map(([method]) => method)).toEqual(['thread/list', 'thread/list', 'thread/read', 'thread/delete']);
    expect(client.request).toHaveBeenLastCalledWith('thread/delete', { threadId: target.sessionId });
    expect(client.stop).toHaveBeenCalledOnce();
    expect(await fs.readFile(artifact, 'utf8')).toBe('preserve');
    expect(JSON.parse(await fs.readFile(pointer, 'utf8')).id).toBe(target.sessionId);
  });

  it('completes active and archived pagination using actual source variants and session trees', async () => {
    const sources = ['cli', 'vscode', 'exec', 'appServer', 'unknown', { custom: 'synthetic' },
      { subAgent: 'review' }, { subAgent: 'compact' }, { subAgent: 'memory_consolidation' },
      { subAgent: { other: 'synthetic' } }, { subAgent: { thread_spawn: { parent_thread_id: unrelated.id, depth: 1 } } }];
    const foreign = sources.map(source => metadata(randomUUID(), { cwd: home, source, sessionId: unrelated.id }));
    respond.mockImplementation(async (method, params) => method === 'thread/read' ? { thread: root }
      : method !== 'thread/list' ? {} : params.archived
        ? params.cursor === null ? list([foreign[0]], 'archive-next') : list(foreign.slice(1))
        : params.cursor === null ? list([unrelated], 'active-next') : list([root]));
    expect(await deleteOwnedCodexSession(target, factory)).toMatchObject({ state: 'deleted' });
    expect(client.request.mock.calls.filter(([method]) => method === 'thread/list').map(([, params]) => [params.archived, params.cursor]))
      .toEqual([[false, null], [false, 'active-next'], [true, null], [true, 'archive-next']]);
  });

  it.each(['parent', 'source-parent', 'session-tree', 'archived-descendant'])(
    'holds %s descendants, even after a page of unrelated threads', async relationship => {
      const child = metadata(randomUUID(), { cwd: home,
        ...(relationship === 'session-tree' ? { sessionId: target.sessionId } : relationship === 'source-parent'
          ? { source: { subAgent: { thread_spawn: { parent_thread_id: target.sessionId, depth: 1 } } } }
          : { parentThreadId: target.sessionId }) });
      respond.mockImplementation(async (method, params) => {
        if (method !== 'thread/list') return { thread: root };
        if (params.archived) return list(relationship === 'archived-descendant' ? [child] : []);
        return params.cursor === null ? list([unrelated, root], 'next')
          : list(relationship === 'archived-descendant' ? [] : [child]);
      });
      expect(await deleteOwnedCodexSession(target, factory)).toMatchObject({ state: 'held' });
      expect(wasDeleted()).toBe(false);
    });

  it.each(['active', 'wrong-id', 'wrong-cwd', 'wrong-tree', 'ephemeral', 'root-parent', 'changed-read'])(
    'holds deletion on %s root evidence', async fault => {
      if (fault === 'active') root.status = { type: 'active' };
      if (fault === 'wrong-id') root.id = randomUUID();
      if (fault === 'wrong-cwd') root.cwd = path.dirname(home);
      if (fault === 'wrong-tree') root.sessionId = randomUUID();
      if (fault === 'ephemeral') root.ephemeral = true;
      if (fault === 'root-parent') root.parentThreadId = randomUUID() as any;
      if (fault === 'changed-read') {
        const normal = respond.getMockImplementation()!;
        respond.mockImplementation(async (method, params) => method === 'thread/read'
          ? { thread: { ...root, cwd: path.dirname(home) } } : normal(method, params));
      }
      expect(await deleteOwnedCodexSession(target, factory)).toMatchObject({ state: 'held' });
      expect(wasDeleted()).toBe(false);
    });

  it.each(['missing-page', 'missing-identity', 'missing-source', 'malformed-source', 'conflicting-parent',
    'malformed-cursor', 'looped-cursor', 'empty-nonterminal', 'duplicate', 'cycle', 'oversized-page', 'page-error'])(
    'holds malformed or incomplete inventory: %s', async fault => {
      let calls = 0;
      respond.mockImplementation(async () => {
        calls++;
        const child = metadata(randomUUID(), { cwd: home });
        if (fault === 'missing-page') return {};
        if (fault === 'missing-identity') return list([{ id: target.sessionId }]);
        if (fault === 'missing-source') return list([{ ...root, source: undefined }]);
        if (fault === 'malformed-source') return list([{ ...root, source: { subAgent: { thread_spawn: {} } } }]);
        if (fault === 'conflicting-parent') return list([{ ...child, parentThreadId: unrelated.id,
          source: { subAgent: { thread_spawn: { parent_thread_id: target.sessionId, depth: 1 } } } }]);
        if (fault === 'malformed-cursor') return { data: [root], nextCursor: 42 };
        if (fault === 'looped-cursor') return list([child], 'same');
        if (fault === 'empty-nonterminal') return list([], 'next');
        if (fault === 'duplicate') return list([root]);
        if (fault === 'cycle') return calls === 1 ? list([{ ...child, parentThreadId: child.id }]) : list([]);
        if (fault === 'oversized-page') return list(Array(101).fill(root));
        if (calls > 1) throw new Error('Synthetic page failure');
        return list([root], 'next');
      });
      expect(await deleteOwnedCodexSession(target, factory)).toMatchObject({ state: 'held' });
      expect(wasDeleted()).toBe(false);
    });

  it('bounds unique cursors without accepting a truncated inventory', async () => {
    let pages = 0;
    respond.mockImplementation(async () => list([metadata(randomUUID(), { cwd: home })], `page-${++pages}`));
    expect(await deleteOwnedCodexSession(target, factory)).toMatchObject({ state: 'held' });
    expect(pages).toBe(100);
    expect(wasDeleted()).toBe(false);
  });

  it('accepts an omitted terminal cursor as allowed by the installed schema', async () => {
    const normal = respond.getMockImplementation()!;
    respond.mockImplementation(async (method, params) => method === 'thread/list'
      ? { data: params.archived ? [] : [root] } : normal(method, params));
    expect(await deleteOwnedCodexSession(target, factory)).toMatchObject({ state: 'deleted' });
  });

  it.each(['pointer-swap', 'home', 'root-replacement', 'malformed-id', 'foreground-id', 'hardlink'])(
    'rejects %s before starting maintenance', async fault => {
      if (fault === 'pointer-swap') await fs.writeFile(pointer, JSON.stringify({ id: randomUUID() }));
      if (fault === 'home') { const other = path.join(home, 'other'); await fs.mkdir(other); vi.stubEnv('HOME', other); }
      if (fault === 'root-replacement') { await fs.rename(path.join(home, '.codex'), path.join(home, 'old')); await fs.mkdir(path.join(home, '.codex')); }
      if (fault === 'malformed-id') target.sessionId = '../foreign';
      if (fault === 'foreground-id') target.executorThreadId = randomUUID();
      if (fault === 'hardlink') await fs.link(pointer, path.join(home, 'alias'));
      expect(await deleteOwnedCodexSession(target, factory)).toMatchObject({ state: 'held' });
      expect(factory).not.toHaveBeenCalled();
    });

  it.each(['foreground', 'foreign-worker', 'late-foreground', 'uppercase-extension'])(
    'protects a genuine %s binding to the owned native ID', async kind => {
      const foreign = path.join(path.dirname(pointer), `${kind === 'foreign-worker' ? 'delegate-lane-' : ''}${randomUUID()}${kind === 'uppercase-extension' ? '.JSON' : '.json'}`);
      const content = JSON.stringify({ id: target.sessionId.toUpperCase(), savedAt: 'synthetic' });
      if (kind === 'late-foreground') {
        const normal = respond.getMockImplementation()!;
        respond.mockImplementation(async (method, params) => { await fs.writeFile(foreign, content); return normal(method, params); });
      } else await fs.writeFile(foreign, content);
      expect(await deleteOwnedCodexSession(target, factory)).toMatchObject({ state: 'held' });
      if (kind !== 'late-foreground') expect(factory).not.toHaveBeenCalled();
      expect(wasDeleted()).toBe(false);
      expect(await fs.readFile(foreign, 'utf8')).toBe(content);
    });

  it('allows an unrelated foreground pointer without changing it', async () => {
    const foreign = path.join(path.dirname(pointer), `${randomUUID()}.json`);
    const content = JSON.stringify({ id: unrelated.id });
    await fs.writeFile(foreign, content);
    expect(await deleteOwnedCodexSession(target, factory)).toMatchObject({ state: 'deleted' });
    expect(await fs.readFile(foreign, 'utf8')).toBe(content);
  });

  it.each(['bad-json', 'missing-id', 'oversized', 'directory', 'symlink'])(
    'holds ambiguous pointer inventory: %s', async fault => {
      const foreign = path.join(path.dirname(pointer), `${randomUUID()}.json`);
      if (fault === 'directory') await fs.mkdir(foreign);
      else if (fault === 'symlink') await fs.symlink(home, foreign, process.platform === 'win32' ? 'junction' : 'dir');
      else await fs.writeFile(foreign, fault === 'bad-json' ? '{' : fault === 'oversized' ? 'x'.repeat(65537) : '{}');
      expect(await deleteOwnedCodexSession(target, factory)).toMatchObject({ state: 'held' });
      expect(factory).not.toHaveBeenCalled();
    });

  it('bounds reads even when a foreground pointer grows after its initial stat', async () => {
    const foreign = path.join(path.dirname(pointer), `${randomUUID()}.json`);
    await fs.writeFile(foreign, JSON.stringify({ id: unrelated.id }));
    const open = fs.open.bind(fs);
    let requestedBytes = 0;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]) === foreign) {
        const read = handle.read.bind(handle);
        vi.spyOn(handle, 'read').mockImplementation(async (...readArgs: any[]) => {
          await fs.appendFile(foreign, 'x'.repeat(131072));
          requestedBytes += readArgs[2];
          return (read as any)(...readArgs);
        });
      }
      return handle;
    });
    expect(await deleteOwnedCodexSession(target, factory)).toMatchObject({ state: 'held' });
    expect(requestedBytes).toBe(65537);
    expect(factory).not.toHaveBeenCalled();
  });

  it('bounds local pointer inventory before any native process starts', async () => {
    vi.spyOn(fs, 'opendir').mockImplementation(async () => (async function* () {
      for (let index = 0; index < 4097; index++) yield { name: `${index}.tmp` };
    })() as any);
    expect(await deleteOwnedCodexSession(target, factory)).toMatchObject({ state: 'held' });
    expect(factory).not.toHaveBeenCalled();
  });

  it('rejects a redirected pointer ancestor without following it', async () => {
    const original = path.dirname(pointer);
    const moved = path.join(home, 'moved');
    await fs.rename(original, moved);
    await fs.symlink(moved, original, process.platform === 'win32' ? 'junction' : 'dir');
    expect(await deleteOwnedCodexSession(target, factory)).toMatchObject({ state: 'held' });
    expect(factory).not.toHaveBeenCalled();
  });

  it('rechecks a pointer changed during native inspection', async () => {
    const normal = respond.getMockImplementation()!;
    respond.mockImplementation(async (method, params) => {
      await fs.writeFile(pointer, JSON.stringify({ id: randomUUID() }));
      return normal(method, params);
    });
    expect(await deleteOwnedCodexSession(target, factory)).toMatchObject({ state: 'held' });
    expect(wasDeleted()).toBe(false);
  });

  it.each(['version', 'method'])('reports unsupported %s explicitly without archive fallback', async fault => {
    if (fault === 'version') client.getServerVersion.mockReturnValue('0.165.0');
    else respond.mockRejectedValue(Object.assign(new Error('Synthetic unsupported method'), { code: -32601 }));
    expect(await deleteOwnedCodexSession(target, factory)).toMatchObject({ state: 'unsupported' });
    expect(client.stop).toHaveBeenCalledOnce();
  });

  it.each(['lost-ack', 'lost-local-result'])(
    'recovers %s after the fake server really removes the root, using a durable exact preparation', async fault => {
      const receiptFile = path.join(home, 'prepared.json');
      const persistPrepared = vi.fn(async (receipt: NativeDeletionPreparation) => {
        await fs.writeFile(receiptFile, JSON.stringify(receipt));
      });
      let removed = false;
      let deletes = 0;
      respond.mockImplementation(async (method, params) => {
        if (method === 'thread/list') return list(params.archived || removed ? [] : [unrelated, root]);
        if (method === 'thread/read') {
          if (removed) throw new Error('Synthetic missing root');
          return { thread: root };
        }
        expect(await fs.readFile(receiptFile, 'utf8')).toBeTruthy();
        removed = true;
        if (++deletes === 1 && fault === 'lost-ack') throw new Error('Synthetic lost acknowledgement');
        if (deletes > 1) throw Object.assign(new Error(`no rollout found for thread id ${target.sessionId}`), { code: -32600 });
        return {};
      });
      expect(await deleteOwnedCodexSession(target, factory, { persistPrepared }))
        .toMatchObject({ state: fault === 'lost-ack' ? 'uncertain' : 'deleted' });
      const prepared = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
      expect(await deleteOwnedCodexSession(target, factory, { prepared })).toMatchObject({ state: 'deleted' });
      expect(deletes).toBe(2);
      expect(client.request.mock.calls.filter(([method]) => method === 'thread/read')).toHaveLength(1);
      expect(persistPrepared).toHaveBeenCalledOnce();
      expect(JSON.parse(await fs.readFile(pointer, 'utf8')).id).toBe(target.sessionId);
    });

  it.each(['missing', 'replaced'])('deletes a retired identity only with explicit detached-pointer evidence: %s', async state => {
    if (state === 'missing') await fs.unlink(pointer);
    else await fs.writeFile(pointer, JSON.stringify({ id: unrelated.id }));
    expect(await deleteOwnedCodexSession(target, factory)).toMatchObject({ state: 'held' });
    expect(wasDeleted()).toBe(false);
    expect(await deleteOwnedCodexSession(target, factory, { detachedPointer: true })).toMatchObject({ state: 'deleted' });
  });

  it('still protects a foreground binding when the worker pointer was detached', async () => {
    await fs.unlink(pointer);
    await fs.writeFile(path.join(path.dirname(pointer), `${randomUUID()}.json`), JSON.stringify({ id: target.sessionId }));
    expect(await deleteOwnedCodexSession(target, factory, { detachedPointer: true })).toMatchObject({ state: 'held' });
    expect(wasDeleted()).toBe(false);
  });

  it.each(['missing', 'wrong-hash', 'wrong-version', 'changed-target', 'descendant', 'missing-ack'])(
    'does not claim an absent target deleted with %s recovery evidence', async fault => {
      let prepared: NativeDeletionPreparation | undefined;
      await deleteOwnedCodexSession(target, factory, { persistPrepared: async value => { prepared = value; } });
      client.request.mockClear();
      if (fault === 'missing') prepared = undefined;
      if (fault === 'wrong-hash') prepared!.targetHash = '0'.repeat(64);
      if (fault === 'wrong-version') (prepared as any).nativeVersion = '0.165.0';
      respond.mockImplementation(async method => {
        if (method === 'thread/list') return list(fault === 'descendant'
          ? [metadata(randomUUID(), { cwd: home, parentThreadId: target.sessionId })] : []);
        throw new Error('Synthetic missing deletion acknowledgement');
      });
      expect(await deleteOwnedCodexSession(fault === 'changed-target' ? { ...target, cwd: path.dirname(home) } : target, factory, { prepared }))
        .toMatchObject({ state: fault === 'missing-ack' ? 'uncertain' : 'held' });
      if (fault !== 'missing-ack') expect(wasDeleted()).toBe(false);
    });

  it.each(['ENOENT', -32600, -32603])('does not classify a read error %s as an already deleted target', async code => {
    const normal = respond.getMockImplementation()!;
    respond.mockImplementation(async (method, params) => {
      if (method === 'thread/read') throw Object.assign(new Error('Thread not found; already deleted'), { code });
      return normal(method, params);
    });
    expect(await deleteOwnedCodexSession(target, factory)).toMatchObject({ state: 'held' });
    expect(wasDeleted()).toBe(false);
  });

  it('prevents deletion if durable preparation fails or a binding changes during preparation', async () => {
    expect(await deleteOwnedCodexSession(target, factory, { persistPrepared: async () => { throw new Error('Synthetic disk failure'); } }))
      .toMatchObject({ state: 'held' });
    expect(wasDeleted()).toBe(false);
    expect(await deleteOwnedCodexSession(target, factory, { persistPrepared: async () => {
      await fs.writeFile(path.join(path.dirname(pointer), `${randomUUID()}.json`), JSON.stringify({ id: target.sessionId }));
    } })).toMatchObject({ state: 'held' });
    expect(wasDeleted()).toBe(false);
  });

  it('waits for the preparation persistence acknowledgement before sending delete', async () => {
    let release!: () => void;
    const persisted = new Promise<void>(resolve => { release = resolve; });
    const persistPrepared = vi.fn(async () => persisted);
    const operation = deleteOwnedCodexSession(target, factory, { persistPrepared });
    try {
      await vi.waitFor(() => expect(persistPrepared).toHaveBeenCalledOnce());
      expect(wasDeleted()).toBe(false);
    } finally { release(); await operation; }
    expect(await operation).toMatchObject({ state: 'deleted' });
  });

  it('does not report deletion success when maintenance exit is uncertain', async () => {
    client.stop.mockRejectedValue(new Error('Synthetic stop failure'));
    expect(await deleteOwnedCodexSession(target, factory)).toMatchObject({ state: 'uncertain' });
  });

  it('durably preserves idempotent parent/generation fences across queue recreation', async () => {
    const directory = path.join(home, '.remote-cli', 'native-session-deletions');
    const queue = new NativeSessionDeletionQueue(directory);
    await queue.enqueue('parent', 3);
    await queue.enqueue('parent', 3);
    await queue.enqueue('sibling', 4);
    expect((await new NativeSessionDeletionQueue(directory).requests()).map(value => [value.threadId, value.throughGeneration]).sort())
      .toEqual([['parent', 3], ['sibling', 4]]);
    await fs.writeFile(path.join(directory, 'bad.json'), '{}');
    await expect(queue.requests()).rejects.toThrow('Malformed');
  });
});
