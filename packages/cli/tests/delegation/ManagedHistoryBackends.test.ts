import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { isMainThread } from 'worker_threads';
import { randomUUID } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DelegationManager } from '../../src/delegation/DelegationManager';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { captureHistoryTarget, claudeProjectName, historyIdentity, stableHistoryHash, type OwnedHistoryTarget } from '../../src/delegation/NativeHistoryFiles';
import { DelegatedWorkerSessionStore, type DelegatedWorkerLane } from '../../src/delegation/DelegatedWorkerSessionStore';
import { deletionPreparation } from '../../src/delegation/NativeSessionDeletion';

// Manager ownership needs the real host's locking and boot identity. Only the
// native deletion adapters require Linux; do not spoof the manager's platform.
const nativeLinux = process.platform === 'linux';
const linuxIt = nativeLinux ? it : it.skip;

describe('durable managed Kimi/Pi/Claude deletion integration', () => {
  it('runs native ownership lifecycle in an isolated process', () => {
    expect(isMainThread).toBe(true);
  });
  let home: string;
  let manager: DelegationManager;
  let kimiDelete: ReturnType<typeof vi.fn>;
  let kimiExit: ReturnType<typeof vi.fn>;
  function createManager() {
    return new DelegationManager(new DirectoryGuard([home]), undefined, undefined, undefined, undefined, 100,
      undefined, undefined, undefined, () => ({
        initialize: async () => ({ protocolVersion: 1, agentInfo: { version: '2.3.3' }, agentCapabilities: { sessionCapabilities: { delete: {} } } }),
        permanentDelete: kimiDelete, destroy: () => {}, waitForExit: async () => {}, waitForManagedProcessGroupExit: kimiExit,
      }));
  }
  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'managed-history-')));
    vi.spyOn(os, 'homedir').mockReturnValue(home); vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    kimiDelete = vi.fn(async () => ({})); kimiExit = vi.fn(async () => {}); manager = createManager();
  });
  afterEach(async () => { await manager.destroy(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(home, { recursive: true, force: true }); });
  async function target(lane: DelegatedWorkerLane, legacy = false): Promise<OwnedHistoryTarget> {
    const backend = lane.backend as OwnedHistoryTarget['backend']; const id = randomUUID();
    const nativeHome = path.join(home, 'native', backend === 'pi' ? lane.id : backend);
    const scope = backend === 'claude' ? path.join(nativeHome, 'projects', claudeProjectName(home)) : nativeHome;
    await fs.mkdir(scope, { recursive: true });
    const pointer = path.join(home, 'pointers', backend, `${lane.executorThreadId}.json`);
    await fs.mkdir(path.dirname(pointer), { recursive: true });
    const transcript = backend === 'kimi' ? undefined : path.join(scope,
      backend === 'pi' ? `2026-01-01T00-00-00-000Z_${id}.jsonl` : `${id}.jsonl`);
    await fs.writeFile(pointer, JSON.stringify({ id, ...(backend === 'pi' ? { sessionFile: transcript } : {}) }));
    const captured = await captureHistoryTarget({ backend, sessionId: id, executorThreadId: lane.executorThreadId,
      home, nativeHome, scope, pointer, cwd: home, command: `synthetic-${backend}`, ...(transcript ? { transcript } : {}) });
    if (legacy) captured.nativeVersion = ({ kimi: '2.3.3', pi: '1.5.0', claude: '2.1.308' } as const)[backend];
    await manager.laneStore.captureNativeSession(lane.id, lane.contextGeneration ?? 0, captured);
    if (backend === 'claude') {
      captured.confirmed = true;
      await manager.laneStore.captureNativeSession(lane.id, lane.contextGeneration ?? 0, captured);
    }
    if (transcript) await fs.writeFile(transcript, JSON.stringify(backend === 'pi'
      ? { type: 'session', id, version: 3, cwd: home, timestamp: '2026-01-01T00:00:00.000Z' }
      : { type: 'user', sessionId: id, version: '9.0.0', cwd: home, message: { content: 'synthetic' } }) + '\n');
    return captured;
  }
  async function lane(backend: OwnedHistoryTarget['backend'], generation = 0, excluded = new Set<string>()) {
    const { lane } = await manager.laneStore.acquire({ threadId: 'parent', backend, workingDirectory: home, workspaceGeneration: generation }, { excluded });
    await manager.laneStore.markRunning(lane.id); return lane;
  }
  async function ready(lane: DelegatedWorkerLane, proven = true) {
    await manager.laneStore.markShutdownConfirmed(lane.id, lane.contextGeneration ?? 0, proven);
    await manager.laneStore.markReady(lane.id);
  }
  async function current(id: string) { return (await manager.laneStore.lanesForThread('parent')).find(lane => lane.id === id)!; }

  it.each(['kimi', 'pi', 'claude'] as const)('keeps %s reusable until reset and limits deletion to supported cutoff generations', async backend => {
    const old = await lane(backend); const first = await target(old); await ready(old);
    const reused = await manager.laneStore.acquire({ threadId: 'parent', backend, workingDirectory: home, workspaceGeneration: 0 });
    expect(reused.lane.id).toBe(old.id); await ready(reused.lane);
    const future = await lane(backend, 1); const next = await target(future); await ready(future);
    const artifact = path.join(home, 'result.txt'); await fs.writeFile(artifact, 'keep result and recovery');
    await manager.reconcileNativeSessionDeletions(); expect((await current(old.id)).nativeDeletion).toBeUndefined();
    await manager.requestNativeSessionDeletion('parent', 0); await manager.reconcileNativeSessionDeletions();
    expect((await current(old.id)).nativeDeletion?.state).toBe(nativeLinux ? 'deleted' : 'unsupported');
    expect((await current(future.id)).nativeDeleteRequested).not.toBe(true);
    if (!nativeLinux) expect(kimiDelete).not.toHaveBeenCalled();
    if (first.transcript) {
      if (nativeLinux) await expect(fs.stat(first.transcript)).rejects.toMatchObject({ code: 'ENOENT' });
      else expect((await fs.stat(first.transcript)).isFile()).toBe(true);
    }
    if (next.transcript) expect((await fs.stat(next.transcript)).isFile()).toBe(true);
    expect(await fs.readFile(artifact, 'utf8')).toBe('keep result and recovery');
  });
  linuxIt.each(['pi', 'claude'] as const)('retains every %s fallback identity and handles independent children', async backend => {
    const firstLane = await lane(backend); const first = await target(firstLane); const fallback = await target(firstLane); await ready(firstLane);
    const secondLane = await lane(backend, 0, new Set([firstLane.id])); const other = await target(secondLane); await ready(secondLane);
    expect((await current(firstLane.id)).nativeSessionHistory).toHaveLength(1);
    await manager.requestNativeSessionDeletion('parent', 0); await manager.reconcileNativeSessionDeletions();
    for (const value of [first, fallback, other]) await expect(fs.stat(value.transcript!)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await current(firstLane.id)).nativeDeletion?.state).toBe('deleted'); expect((await current(secondLane.id)).nativeDeletion?.state).toBe('deleted');
  });
  linuxIt.each([false, true])('reconciles persisted Claude preparations after shutdown and restart (legacy=%s)', async legacy => {
    const worker = await lane('claude'); const captured = await target(worker, legacy); await ready(worker);
    const sibling = path.join(captured.scope.path, captured.sessionId); await fs.mkdir(sibling);
    await manager.requestNativeSessionDeletion('parent', 0);
    const original = fs.rmdir; vi.spyOn(fs, 'rmdir').mockRejectedValueOnce(new Error('synthetic interrupted unlink'));
    await manager.reconcileNativeSessionDeletions(); expect((await current(worker.id)).nativeDeletion?.state).toBe('uncertain');
    const saved = JSON.stringify((await current(worker.id)).nativeDeletionPreparations);
    vi.mocked(fs.rmdir).mockImplementation(original);
    await manager.destroy(); manager = createManager(); await manager.reconcileNativeSessionDeletions();
    expect((await current(worker.id)).nativeDeletion?.state).toBe('deleted');
    expect(JSON.stringify((await current(worker.id)).nativeDeletionPreparations)).toBe(saved);
  });
  it.each(['kimi', 'pi', 'claude'] as const)('reloads immutable legacy and contract %s receipts on every host', async backend => {
    for (const legacy of [false, true]) {
      const worker = await lane(backend); const captured = await target(worker, legacy); await ready(worker);
      // Persistence-only coverage must not race the manager's scheduled maintenance.
      await manager.laneStore.requestNativeDeletion('parent', 0);
      const prepared = { ...deletionPreparation(captured),
        ...(captured.transcript ? { files: [await historyIdentity(captured.transcript, 'file')] } : {}) };
      expect(prepared.targetHash).toBe(stableHistoryHash(captured));
      await manager.laneStore.prepareNativeDeletion(worker.id, 0, captured, prepared);
      const saved = JSON.stringify({ captured, prepared });
      const reloaded = new DelegatedWorkerSessionStore(manager.laneStore.storageDirectory);
      expect(await reloaded.getInventoryStatus()).toEqual({ complete: true, quarantinedRecords: 0 });
      const restored = (await reloaded.lanesForThread('parent')).find(value => value.id === worker.id)!;
      expect(JSON.stringify({ captured: restored.nativeSession, prepared: restored.nativeDeletionPreparations?.[captured.sessionId] })).toBe(saved);
      await expect(reloaded.prepareNativeDeletion(worker.id, 0, captured, { ...prepared, targetHash: '0'.repeat(64) })).rejects.toThrow();
      const marker = legacy ? ({ kimi: 'kimi-acp-delete-v1', pi: 'pi-jsonl-v3', claude: 'claude-history-v1' } as const)[backend]
        : ({ kimi: '2.3.3', pi: '1.5.0', claude: '2.1.308' } as const)[backend];
      await expect(reloaded.prepareNativeDeletion(worker.id, 0, captured, { ...prepared, nativeVersion: marker })).rejects.toThrow();
      expect((await reloaded.lanesForThread('parent')).find(value => value.id === worker.id)?.nativeDeletionPreparations?.[captured.sessionId]).toEqual(prepared);
    }
  });
  linuxIt.each([false, true])('recovers Pi unlink acknowledgement loss after restart (legacy=%s)', async legacy => {
    const worker = await lane('pi'); const captured = await target(worker, legacy); await ready(worker);
    await manager.requestNativeSessionDeletion('parent', 0);
    const original = fs.unlink;
    const unlink = vi.spyOn(fs, 'unlink').mockImplementationOnce(async file => {
      expect(path.basename(String(file))).toBe(path.basename(captured.transcript!));
      await original(file);
      throw new Error('Synthetic lost unlink acknowledgement');
    });
    await manager.reconcileNativeSessionDeletions(); unlink.mockRestore();
    expect((await current(worker.id)).nativeDeletion?.state).toBe('uncertain');
    await expect(fs.stat(captured.transcript!)).rejects.toMatchObject({ code: 'ENOENT' });
    const saved = JSON.stringify((await current(worker.id)).nativeDeletionPreparations);
    await manager.destroy(); manager = createManager(); await manager.reconcileNativeSessionDeletions();
    expect((await current(worker.id)).nativeDeletion?.state).toBe('deleted');
    expect(JSON.stringify((await current(worker.id)).nativeDeletionPreparations)).toBe(saved);
  });
  linuxIt.each([false, true])('recovers Kimi lost ACK after manager restart (legacy=%s)', async legacy => {
    const worker = await lane('kimi'); const captured = await target(worker, legacy); await ready(worker);
    await manager.requestNativeSessionDeletion('parent', 0);
    kimiDelete.mockRejectedValueOnce(new Error('Synthetic lost acknowledgement'));
    await manager.reconcileNativeSessionDeletions();
    expect((await current(worker.id)).nativeDeletion?.state).toBe('uncertain');
    const saved = JSON.stringify((await current(worker.id)).nativeDeletionPreparations);
    await manager.destroy(); manager = createManager();
    kimiDelete.mockRejectedValue({ code: -32602, rpcMessage: `Unknown sessionId: ${captured.sessionId}`, data: { sessionId: captured.sessionId } });
    await manager.reconcileNativeSessionDeletions();
    expect((await current(worker.id)).nativeDeletion?.state).toBe('deleted');
    expect(JSON.stringify((await current(worker.id)).nativeDeletionPreparations)).toBe(saved);
  });
  linuxIt('keeps an interrupted Kimi maintenance writer fenced across restart', async () => {
    const worker = await lane('kimi'); await target(worker); await ready(worker);
    kimiExit.mockRejectedValue(new Error('synthetic surviving writer'));
    await manager.requestNativeSessionDeletion('parent', 0); await manager.reconcileNativeSessionDeletions();
    expect((await current(worker.id)).nativeMaintenanceExitUnconfirmed).toBe(true);
    await manager.destroy(); manager = createManager(); await manager.reconcileNativeSessionDeletions();
    expect((await current(worker.id)).nativeDeletion?.state).toBe('waiting-exit'); expect(kimiDelete).toHaveBeenCalledOnce();
  });
  it('retains a persisted Kimi maintenance fence across restart on every host', async () => {
    const worker = await lane('kimi'); await target(worker); await ready(worker);
    await manager.requestNativeSessionDeletion('parent', 0);
    await manager.laneStore.recordNativeMaintenance(worker.id, 0, true);
    await manager.destroy(); manager = createManager(); await manager.reconcileNativeSessionDeletions();
    expect((await current(worker.id)).nativeMaintenanceExitUnconfirmed).toBe(true);
    expect((await current(worker.id)).nativeDeletion?.state).toBe('waiting-exit');
    expect(kimiDelete).not.toHaveBeenCalled();
  });
  it.each(['kimi', 'pi', 'claude'] as const)('holds %s old identities and missing writer proof', async backend => {
    const worker = await lane(backend); await target(worker); await ready(worker, false);
    await manager.requestNativeSessionDeletion('parent', 0); await manager.reconcileNativeSessionDeletions();
    expect((await current(worker.id)).nativeDeletion?.state).toBe('waiting-exit'); expect(kimiDelete).not.toHaveBeenCalled();
  });
  it('persists capture failure and never treats the earlier known identities as complete coverage', async () => {
    const worker = await lane('pi'); const captured = await target(worker);
    await manager.laneStore.recordNativeCaptureFailure(worker.id, 0); await ready(worker);
    await manager.requestNativeSessionDeletion('parent', 0); await manager.reconcileNativeSessionDeletions();
    expect((await current(worker.id)).nativeDeletion?.state).toBe('held'); expect((await fs.stat(captured.transcript!)).isFile()).toBe(true);
  });
  it('preserves preparations and historical targets across worker-only context reset', async () => {
    const worker = await lane('kimi'); const captured = await target(worker); await ready(worker);
    await manager.laneStore.clearContext(worker.id, 0, worker, async () => {});
    const reset = await current(worker.id);
    expect(reset.nativeSessionHistory?.[0]).toEqual(captured); expect(reset.nativeSession).toBeUndefined();
    await expect(manager.laneStore.captureNativeSession(worker.id, 0, captured)).rejects.toThrow('identity changed');
    await manager.laneStore.markShutdownConfirmed(worker.id, reset.contextGeneration!, true);
    await manager.requestNativeSessionDeletion('parent', 0);
    await manager.laneStore.prepareNativeDeletion(worker.id, reset.contextGeneration!, captured, deletionPreparation(captured));
    const reloaded = new DelegatedWorkerSessionStore(manager.laneStore.storageDirectory);
    const persisted = (await reloaded.lanesForThread('parent'))[0];
    expect(persisted.nativeDeletionPreparations?.[captured.sessionId]).toEqual(deletionPreparation(captured));
  });
  linuxIt('never replaces an already durable file manifest with another valid manifest', async () => {
    const worker = await lane('pi'); const captured = await target(worker); await ready(worker);
    await manager.requestNativeSessionDeletion('parent', 0); await manager.reconcileNativeSessionDeletions();
    const prepared = (await current(worker.id)).nativeDeletionPreparations![captured.sessionId];
    await expect(manager.laneStore.prepareNativeDeletion(worker.id, 0, captured, {
      ...prepared, files: prepared.files!.map(entry => ({ ...entry, mtime: '1' })),
    })).rejects.toThrow('cannot be replaced');
    expect((await current(worker.id)).nativeDeletionPreparations![captured.sessionId]).toEqual(prepared);
  });
});
