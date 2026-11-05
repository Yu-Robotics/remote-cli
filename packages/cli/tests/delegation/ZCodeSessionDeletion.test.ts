import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { historyDirectory } from '../../src/delegation/NativeHistoryFiles';
import { deleteOwnedZCodeSession, validZCodeDeletionPreparation, type ZCodeDeletionTarget,
  type ZCodeDeletionPreparation, type ZCodeDeletionRecovery } from '../../src/delegation/ZCodeSessionDeletion';

describe('native ZCode permanent deletion', () => {
  let home: string, artifact: string, exported: string, target: ZCodeDeletionTarget, preparation: ZCodeDeletionPreparation | undefined;
  let recovery: ZCodeDeletionRecovery;
  let client: { requestSessionData: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>;
    waitForExit: ReturnType<typeof vi.fn>; waitForManagedProcessGroupExit: ReturnType<typeof vi.fn> };
  let factory: ReturnType<typeof vi.fn>, nativePurges: string[], order: string[];
  const digest = (s: string) => createHash('sha256').update(s).digest('hex');
  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-delete-')));
    for (const key of ['HOME', 'USERPROFILE', 'ZCODE_HOME', 'ZCODE_STORAGE_DIR', 'CODEX_HOME']) vi.stubEnv(key, home);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    for (const name of ['native', 'work', 'exports']) await fs.mkdir(path.join(home, name));
    target = { version: 1, backend: 'zcode', nativeVersion: 'zcode-session-data-v4', provenance: 'created', sessionId: 'owned-root',
      executorThreadId: `delegate-lane-${randomUUID()}`, cwd: path.join(home, 'work'), command: 'synthetic-zcode',
      home: await historyDirectory(home), nativeHome: await historyDirectory(path.join(home, 'native')), pointerHash: 'a'.repeat(64) };
    artifact = path.join(home, 'native', 'deliverable.txt');
    exported = path.join(home, 'exports', 'deliverable.txt');
    await fs.writeFile(artifact, 'Synthetic required deliverable');
    preparation = undefined; nativePurges = []; order = [];
    recovery = {
      inspectOwnedTree: vi.fn(async () => { order.push('ownership'); return ['owned-root', 'owned-child']; }),
      preserveArtifacts: vi.fn(async () => {
        order.push('export'); await fs.copyFile(artifact, exported);
        return { root: await historyDirectory(path.dirname(exported)), manifestHash: digest(await fs.readFile(exported, 'utf8')) };
      }),
      verifyArtifacts: vi.fn(async receipt => {
        order.push('verify-export'); expect(digest(await fs.readFile(exported, 'utf8'))).toBe(receipt.manifestHash);
      }),
      persistPrepared: vi.fn(async value => { order.push('prepared'); preparation = JSON.parse(JSON.stringify(value)); }),
      persistMaintenanceState: vi.fn(async active => { order.push(active ? 'fence' : 'unfence'); }),
    };
    client = {
      requestSessionData: vi.fn(async (action: string, id: string) => {
        expect(id).toBe(target.sessionId);
        order.push(action);
        if (action === 'measure') return { sessions: [{ sessionId: id, bytes: 29 }], memory: [] };
        nativePurges.push(id);
        await fs.rm(artifact, { force: true });
        return { deleted: [{ sessionId: id, bytes: 29 }], kept: [], failed: [], memory: [] };
      }),
      destroy: vi.fn(() => { order.push('destroy'); }), waitForExit: vi.fn(async () => { order.push('exit'); }),
      waitForManagedProcessGroupExit: vi.fn(async () => { order.push('group-exit'); }),
    };
    factory = vi.fn(() => client);
  });
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(home, { recursive: true, force: true }); });

  it('exports required artifacts before permanent native purge and preserves the immutable retry receipt', async () => {
    const unrelated = path.join(home, 'native', 'unrelated.txt');
    await fs.writeFile(unrelated, 'Unrelated history');
    expect(await deleteOwnedZCodeSession(target, recovery, factory)).toMatchObject({ state: 'deleted' });
    expect(await fs.readFile(exported, 'utf8')).toBe('Synthetic required deliverable');
    expect(await fs.readFile(unrelated, 'utf8')).toBe('Unrelated history');
    expect(nativePurges).toEqual(['owned-root']);
    expect(order.indexOf('prepared')).toBeLessThan(order.indexOf('purge'));
    expect(order.indexOf('verify-export')).toBeLessThan(order.indexOf('prepared'));
    expect(order.slice(-4)).toEqual(['destroy', 'exit', 'group-exit', 'unfence']);
    const saved = JSON.stringify(preparation);
    expect(validZCodeDeletionPreparation(target, preparation)).toBe(true);
    const preserve = vi.fn(), persist = vi.fn();
    expect(await deleteOwnedZCodeSession(target, { ...recovery, prepared: preparation, preserveArtifacts: preserve, persistPrepared: persist }, factory))
      .toMatchObject({ state: 'deleted' });
    expect(preserve).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled();
    expect(JSON.stringify(preparation)).toBe(saved);
  });
  it.each(['running', 'referenced'])('keeps a native %s tree explicitly held', async reason => {
    client.requestSessionData.mockResolvedValueOnce({ sessions: [{ sessionId: target.sessionId, bytes: 29 }], memory: [] })
      .mockResolvedValueOnce({ deleted: [], kept: [{ sessionId: target.sessionId, reason }], failed: [], memory: [] });
    expect(await deleteOwnedZCodeSession(target, recovery, factory)).toMatchObject({ state: 'held' });
    expect(preparation).toBeDefined();
  });
  it.each(['native-partial', 'lost-reply', 'wrong-id', 'memory', 'empty', 'extra-key', 'contradiction'])(
    'retains uncertain outcomes for %s', async fault => {
      client.requestSessionData.mockResolvedValueOnce({ sessions: [{ sessionId: target.sessionId, bytes: 29 }], memory: [] });
      const success = { deleted: [{ sessionId: target.sessionId, bytes: 29 }], kept: [], failed: [], memory: [] };
      if (fault === 'lost-reply') client.requestSessionData.mockRejectedValueOnce(new Error(`Private endpoint ${home}`));
      else client.requestSessionData.mockResolvedValueOnce(fault === 'native-partial'
        ? { deleted: [], kept: [], failed: [{ sessionId: target.sessionId, code: `Private detail ${home}` }], memory: [] }
        : fault === 'wrong-id' ? { ...success, deleted: [{ sessionId: 'foreign', bytes: 0 }] }
        : fault === 'memory' ? { ...success, memory: [{ workspacePath: home, bytes: 1 }] }
        : fault === 'empty' ? {} : fault === 'extra-key' ? { ...success, unknown: true }
        : { ...success, kept: [{ sessionId: target.sessionId, reason: 'running' }] });
      const result = await deleteOwnedZCodeSession(target, recovery, factory);
      expect(result.state).toBe('uncertain'); expect(result.reason).not.toContain(home);
      expect(preparation).toBeDefined();
      expect(await fs.readFile(exported, 'utf8')).toBe('Synthetic required deliverable');
    });
  it.each(['method-missing', 'wrong-scope', 'bad-measure'])(
    'does not purge when capability validation fails: %s', async fault => {
      if (fault === 'method-missing') client.requestSessionData.mockRejectedValueOnce(Object.assign(new Error('Private message'), { code: -32601 }));
      else client.requestSessionData.mockResolvedValueOnce(fault === 'wrong-scope'
        ? { sessions: [{ sessionId: 'unrelated', bytes: 0 }], memory: [] } : { sessions: [], memory: [] });
      expect(await deleteOwnedZCodeSession(target, recovery, factory)).toMatchObject({ state: fault === 'method-missing' ? 'unsupported' : 'held' });
      expect(nativePurges).toEqual([]); expect(recovery.preserveArtifacts).not.toHaveBeenCalled();
      expect(order.slice(-1)).toEqual(['unfence']);
    });
  it.each(['adopted', 'missing-fence', 'missing-inspector', 'ownership', 'invalid-tree'])(
    'does not construct a transport without %s safety evidence', async fault => {
      if (fault === 'adopted') (target as any).provenance = 'adopted';
      if (fault === 'missing-fence') recovery.persistMaintenanceState = undefined;
      if (fault === 'missing-inspector') (recovery as any).inspectOwnedTree = undefined;
      if (fault === 'ownership') recovery.inspectOwnedTree = async () => { throw new Error('Synthetic alias reference'); };
      if (fault === 'invalid-tree') recovery.inspectOwnedTree = async () => ['foreign'];
      expect(await deleteOwnedZCodeSession(target, recovery, factory)).toMatchObject({ state: 'held' });
      expect(factory).not.toHaveBeenCalled();
    });
  it.each(['export-failure', 'export-inside-native', 'export-inside-worktree', 'persist-failure', 'changed-cascade', 'bad-export-proof'])(
    'prevents purge on %s', async fault => {
      if (fault === 'export-failure') recovery.preserveArtifacts = async () => { throw new Error('Synthetic preservation failure'); };
      if (fault === 'export-inside-native' || fault === 'export-inside-worktree') recovery.preserveArtifacts = async () => ({
        root: await historyDirectory(fault === 'export-inside-native' ? target.nativeHome.path : target.cwd), manifestHash: 'b'.repeat(64) });
      if (fault === 'persist-failure') recovery.persistPrepared = async () => { throw new Error('Synthetic durability failure'); };
      if (fault === 'changed-cascade') recovery.inspectOwnedTree = vi.fn().mockResolvedValueOnce(['owned-root']).mockResolvedValueOnce(['owned-root', 'new-child']);
      if (fault === 'bad-export-proof') recovery.verifyArtifacts = async () => { throw new Error('Synthetic export mismatch'); };
      expect(await deleteOwnedZCodeSession(target, recovery, factory)).toMatchObject({ state: 'held' });
      expect(nativePurges).toEqual([]);
    });
  it('holds a prepared retry whose export or target has changed', async () => {
    await deleteOwnedZCodeSession(target, recovery, factory);
    await fs.writeFile(exported, 'Changed export');
    nativePurges = [];
    expect(await deleteOwnedZCodeSession(target, { ...recovery, prepared: preparation }, factory)).toMatchObject({ state: 'held' });
    expect(nativePurges).toEqual([]);
    expect(validZCodeDeletionPreparation({ ...target, sessionId: 'other' }, preparation)).toBe(false);
  });
  it('retains the maintenance fence when process-group exit is unconfirmed', async () => {
    client.waitForManagedProcessGroupExit.mockRejectedValue(new Error('Synthetic live descendant'));
    expect(await deleteOwnedZCodeSession(target, recovery, factory)).toMatchObject({ state: 'uncertain' });
    expect(order).not.toContain('unfence');
  });
});
