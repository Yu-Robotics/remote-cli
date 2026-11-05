import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { isMainThread } from 'worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DelegationManager } from '../../src/delegation/DelegationManager';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { captureAgyDeletionTarget } from '../../src/delegation/AgySessionDeletion';
import { captureDshDeletionTarget, createDshHistoryScope, type DshHistoryScope } from '../../src/delegation/DshSessionDeletion';
import type { DelegatedWorkerLane } from '../../src/delegation/DelegatedWorkerSessionStore';

vi.mock('../../src/delegation/OwnershipRuntime', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/delegation/OwnershipRuntime')>();
  const { syntheticOwnershipRuntime } = await import('./syntheticOwnershipRuntime');
  return syntheticOwnershipRuntime(actual);
});

describe('managed AGY and DSH reset cleanup delivery', () => {
  let home: string;
  let manager: DelegationManager;
  const scopes = new Map<string, DshHistoryScope>();
  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'managed-remaining-history-')));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    manager = new DelegationManager(new DirectoryGuard([home]));
    scopes.clear();
  });
  afterEach(async () => { await manager.destroy(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(home, { recursive: true, force: true }); });
  async function lane(backend: 'agy' | 'dsh', generation = 0) {
    const { lane } = await manager.laneStore.acquire({ threadId: 'parent', backend, workingDirectory: home, workspaceGeneration: generation });
    await manager.laneStore.markRunning(lane.id);
    return lane;
  }
  async function create(lane: DelegatedWorkerLane) {
    const id = randomUUID();
    const pointer = path.join(home, '.remote-cli', `${lane.backend}-sessions`, lane.executorThreadId + '.json');
    await fs.mkdir(path.dirname(pointer), { recursive: true });
    await fs.writeFile(pointer, JSON.stringify({ id, cwd: home }));
    let target;
    let history: string;
    let output: string;
    if (lane.backend === 'dsh') {
      let scope = scopes.get(lane.id);
      if (!scope) { scope = await createDshHistoryScope(home, lane.executorThreadId, home); scopes.set(lane.id, scope); }
      history = path.join(scope.history.path, 'sessions', 'project', id, 'session.v4.jsonl');
      await fs.mkdir(path.dirname(history), { recursive: true });
      await fs.writeFile(history, JSON.stringify({ type: 'session', version: 4, id, cwd: home, createdAt: 0, isSeeded: false, delegationDepth: 0 }) + '\n');
      target = await captureDshDeletionTarget(scope, id);
      output = path.join(scope.scope.path, 'retained', id + '.txt');
    } else {
      const scope = path.join(home, '.remote-cli', 'agy-homes', lane.executorThreadId, '.gemini', 'antigravity-cli');
      for (const directory of ['conversations', 'cache', path.join('brain', id, '.system_generated', 'logs')]) await fs.mkdir(path.join(scope, directory), { recursive: true });
      history = path.join(scope, 'conversations', id + '.db');
      await fs.writeFile(history, 'SQLite format 3\0synthetic conversation');
      await fs.writeFile(path.join(scope, 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl'), 'synthetic transcript');
      target = await captureAgyDeletionTarget({ sessionId: id, executorThreadId: lane.executorThreadId, home, cwd: home, command: 'synthetic-agy' });
      output = path.join(scope, 'brain', id, 'result.txt');
    }
    await fs.writeFile(output, 'required result');
    await manager.laneStore.captureNativeSession(lane.id, lane.contextGeneration ?? 0, target);
    return { target, history, output, pointer };
  }
  async function ready(lane: DelegatedWorkerLane) {
    await manager.laneStore.markShutdownConfirmed(lane.id, lane.contextGeneration ?? 0, true);
    await manager.laneStore.markReady(lane.id);
  }
  it('runs ownership in a separate process', () => { expect(isMainThread).toBe(true); });

  it.each(['agy', 'dsh'] as const)('retires every recorded %s root while retaining newer generations and outputs', async backend => {
    const old = await lane(backend);
    const first = await create(old); const second = await create(old); await ready(old);
    const future = await lane(backend, 1); const newer = await create(future); await ready(future);
    await fs.writeFile(path.join(path.dirname(first.pointer), 'foreground.json'), JSON.stringify({ id: 'unrelated:opaque/native-id' }));
    await manager.reconcileNativeSessionDeletions();
    expect(await fs.readFile(first.output, 'utf8')).toBe('required result');
    await manager.requestNativeSessionDeletion('parent', 0);
    await manager.reconcileNativeSessionDeletions();
    const saved = (await manager.laneStore.lanesForThread('parent')).find(value => value.id === old.id)!;
    expect(saved.nativeDeletion?.state).toBe('deleted');
    for (const item of [first, second]) {
      expect(await fs.readFile(item.output, 'utf8')).toBe('required result');
      if (process.platform === 'linux') await expect(fs.stat(item.history)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect((await fs.stat(newer.history)).isFile()).toBe(true);
    await manager.destroy(); manager = new DelegationManager(new DirectoryGuard([home]));
    await manager.reconcileNativeSessionDeletions();
    expect((await manager.laneStore.lanesForThread('parent')).find(value => value.id === old.id)?.nativeDeletion?.state).toBe(saved.nativeDeletion?.state);
  });

  it.each(['agy', 'dsh'] as const)('holds %s duplicate references and completes after the conflict is removed', async backend => {
    const old = await lane(backend); const item = await create(old); await ready(old);
    const alias = path.join(path.dirname(item.pointer), 'foreground.json');
    await fs.writeFile(alias, JSON.stringify({ id: item.target.sessionId, adopted: true }));
    await manager.requestNativeSessionDeletion('parent', 0); await manager.reconcileNativeSessionDeletions();
    expect((await manager.laneStore.lanesForThread('parent'))[0].nativeDeletion?.state).toBe('held');
    expect((await fs.stat(item.history)).isFile()).toBe(true);
    await fs.unlink(alias); await manager.reconcileNativeSessionDeletions();
    expect((await manager.laneStore.lanesForThread('parent'))[0].nativeDeletion?.state).toBe('deleted');
  });
});
