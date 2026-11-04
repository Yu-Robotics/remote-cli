import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureZCodeSharedHistory, observeZCodeSharedPrompt, inspectZCodeOwnedTree, deleteOwnedZCodeHistory,
  validZCodeOwnedTarget, preserveZCodeArtifacts, type ZCodeOwnedTarget } from '../../src/delegation/ZCodeOwnedHistory';
import { DelegatedWorkerSessionStore } from '../../src/delegation/DelegatedWorkerSessionStore';
import { selectZCodeStorage } from '../../src/executor/zcode/ZCodeStorageSelection';
import { stableHistoryHash } from '../../src/delegation/NativeHistoryFiles';
import type { ZCodeDeletionPreparation } from '../../src/delegation/ZCodeSessionDeletion';
import { ZCodeExecutor } from '../../src/executor/ZCodeExecutor';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { ZCodeClient } from '../../src/executor/zcode/ZCodeClient';
import * as command from '../../src/executor/zcode/ZCodeCommand';

let DatabaseSync: any;
try { DatabaseSync = require('node:sqlite').DatabaseSync; } catch { /* Optional host capability. */ }
const linux = process.platform === 'linux';
const native = linux && !!process.env.REMOTE_CLI_ZCODE_NATIVE_ENTRY && !!process.env.REMOTE_CLI_ZCODE_NATIVE_NODE;
const schema = `
CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,directory TEXT,task_type TEXT,time_deleted INTEGER);
CREATE TABLE session_task_link(parent_session_id TEXT,child_session_id TEXT);
CREATE TABLE part(id TEXT,session_id TEXT,data TEXT);
CREATE TABLE input_history(id TEXT,session_id TEXT,attachments TEXT);
CREATE TABLE dwf_run(id TEXT,parent_session_id TEXT,script_text TEXT,result_json TEXT,failure_json TEXT);
CREATE TABLE dwf_node(id TEXT,run_id TEXT,result_json TEXT,error_json TEXT);
CREATE TABLE dwf_event(run_id TEXT,sequence INTEGER,type TEXT,payload_json TEXT);
CREATE TABLE workflow_run(id TEXT,parent_session_id TEXT,script_path TEXT);
CREATE TABLE workflow_activity(id TEXT,run_id TEXT,result_json TEXT,error_json TEXT);
CREATE TABLE workflow_event(run_id TEXT,sequence INTEGER,type TEXT,payload_json TEXT);`;

describe.skipIf(!linux || !DatabaseSync)('ZCode shared native storage', () => {
  let home: string, cwd: string, lane: string, pointer: string, storage: string, database: string, id: string;
  const executors: ZCodeExecutor[] = [];
  const clients: ZCodeClient[] = [];
  const db = <T>(fn: (value: any) => T): T => { const value = new DatabaseSync(database); try { return fn(value); } finally { value.close(); } };
  const write = (file: string, value: string | Buffer) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
  const launch = (): command.ZCodeLaunchSpec => ({ command: 'synthetic-zcode', args: ['app-server', '--stdio'], env: {
    HOME: home, USERPROFILE: home, ZCODE_STORAGE_DIR: storage, ZCODE_SESSION_DB_PATH: database,
  } });
  const capture = () => {
    const result = captureZCodeSharedHistory(home, lane, pointer, { storage, database }, id, cwd, 'synthetic-zcode', launch());
    write(pointer, JSON.stringify({ id, cwd })); return result;
  };
  const row = (sid = id, parent: string | null = null, type = 'interactive') => db(value => value.prepare('INSERT INTO session VALUES (?,?,?,?,NULL)').run(sid, parent, cwd, type));
  beforeEach(async () => {
    home = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zcode-shared-test-')));
    cwd = path.join(home, 'work'); fs.mkdirSync(cwd);
    lane = 'delegate-lane-' + randomUUID(); id = 'sess_' + randomUUID();
    pointer = path.join(home, '.remote-cli', 'zcode-sessions', lane + '.json'); fs.mkdirSync(path.dirname(pointer), { recursive: true });
    storage = path.join(home, 'synthetic-store'); database = path.join(storage, 'db.sqlite'); fs.mkdirSync(storage);
    db(value => value.exec(schema));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'ZCODE_HOME', 'ZCODE_DATA_BASE_DIR']) vi.stubEnv(key, home);
  });
  afterEach(async () => {
    for (const executor of executors.splice(0)) { await executor.destroy(); await executor.waitForExit(); }
    for (const client of clients.splice(0)) { client.destroy(); await client.waitForExit(); await client.waitForManagedProcessGroupExit(); }
    vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.promises.rm(home, { recursive: true, force: true });
  });

  it('keeps immutable reservations and holds a prompted missing row across restart', async () => {
    const target = capture(); const serialized = JSON.stringify(target);
    expect(validZCodeOwnedTarget(JSON.parse(serialized))).toBe(true);
    expect(await inspectZCodeOwnedTree(target)).toEqual([id]);
    observeZCodeSharedPrompt(home, lane, id, { storage, database }, false);
    await expect(inspectZCodeOwnedTree(JSON.parse(serialized))).rejects.toThrow('no confirmed root');
    expect(() => observeZCodeSharedPrompt(home, lane, id, { storage, database }, true)).toThrow('not confirmed');
    row(); observeZCodeSharedPrompt(home, lane, id, { storage, database }, true);
    expect(await inspectZCodeOwnedTree(JSON.parse(serialized))).toEqual([id]);
    expect(JSON.stringify(target)).toBe(serialized);
  });

  it('only enumerates owned edges in a large shared database and retains independent forks', async () => {
    const target = capture(); row();
    const child = 'sess_' + randomUUID(), linked = 'sess_' + randomUUID(), fork = 'sess_' + randomUUID();
    row(child, id, 'subagent_child'); row(linked); row(fork, id, 'fork');
    db(value => {
      value.prepare('INSERT INTO session_task_link VALUES (?,?)').run(id, linked);
      value.exec('BEGIN');
      for (let i = 0; i < 4200; i++) value.prepare('INSERT INTO session VALUES (?,NULL,?,NULL,NULL)').run('foreign_' + i, cwd);
      value.exec('COMMIT');
      // Invalid foreign transcript JSON must never be read by our preflight.
      value.prepare('INSERT INTO part VALUES (?,?,?)').run('foreign-part', fork, 'not JSON');
    });
    expect(await inspectZCodeOwnedTree(target)).toEqual([id, child, linked].sort());
    db(value => value.prepare('INSERT INTO session_task_link VALUES (?,?)').run(fork, child));
    await expect(inspectZCodeOwnedTree(target)).rejects.toThrow('foreign');
  });

  it('rejects duplicate/adopted pointers while tolerating unrelated IDs', async () => {
    const target = capture(); row();
    const other = path.join(path.dirname(pointer), 'ordinary.json');
    write(other, JSON.stringify({ id: 'sess_unrelated', adopted: true }));
    expect(await inspectZCodeOwnedTree(target)).toEqual([id]);
    write(other, JSON.stringify({ id, adopted: true }));
    await expect(inspectZCodeOwnedTree(target)).rejects.toThrow('another pointer');
    fs.unlinkSync(other); write(pointer, JSON.stringify({ id, cwd, adopted: true }));
    await expect(inspectZCodeOwnedTree(target)).rejects.toThrow('another pointer');
  });

  it('tracks multiple databases in one lane and rejects changed roots on resume', async () => {
    const first = capture(); row(); const original = { storage, database };
    storage = path.join(home, 'second-store'); database = path.join(storage, 'second.sqlite'); fs.mkdirSync(storage); db(value => value.exec(schema));
    id = 'sess_' + randomUUID(); const second = capture(); row();
    expect(await inspectZCodeOwnedTree(first, undefined, true)).toEqual([first.sessionId]);
    expect(await inspectZCodeOwnedTree(second)).toEqual([second.sessionId]);
    expect(() => observeZCodeSharedPrompt(home, lane, first.sessionId, { storage, database }, false)).toThrow('not owned');
    write(pointer, JSON.stringify({ id: first.sessionId, cwd }));
    observeZCodeSharedPrompt(home, lane, first.sessionId, original, true);
    fs.renameSync(database, database + '.old'); db(value => value.exec(schema));
    await expect(inspectZCodeOwnedTree(second)).rejects.toThrow('identity changed');
  });

  it('never classifies a pre-existing persisted ID as a native creation', () => {
    row(); expect(capture).toThrow('pre-existing');
  });

  it('retains independent cross-lane receipts even after pointers are detached', async () => {
    const first = capture(); row();
    const otherLane = 'delegate-lane-' + randomUUID(), other = 'sess_' + randomUUID();
    const otherPointer = path.join(path.dirname(pointer), otherLane + '.json');
    const second = captureZCodeSharedHistory(home, otherLane, otherPointer, { storage, database }, other, cwd, 'synthetic-zcode', launch());
    row(other); write(otherPointer, JSON.stringify({ id: other, cwd }));
    expect(await inspectZCodeOwnedTree(first)).toEqual([id]);
    expect(await inspectZCodeOwnedTree(second)).toEqual([other]);
    fs.unlinkSync(otherPointer);
    db(value => value.prepare('INSERT INTO session_task_link VALUES (?,?)').run(id, other));
    await expect(inspectZCodeOwnedTree(first)).rejects.toThrow('independent root');
  });

  it('holds orphan activity and modified reservation receipts', async () => {
    const target = capture();
    db(value => value.prepare('INSERT INTO input_history VALUES (?,?,?)').run('unexpected', id, '[]'));
    await expect(inspectZCodeOwnedTree(target)).rejects.toThrow('orphan activity');
    db(value => value.exec('DELETE FROM input_history'));
    const markerFile = path.join(target.ownership.namespace.path, 'ownership.json');
    const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8')); marker.roots[id].target.cwd = home;
    fs.writeFileSync(markerFile, JSON.stringify(marker));
    await expect(inspectZCodeOwnedTree(target)).rejects.toThrow('not owned');
  });

  it('persists shared receipts and immutable preparations across restart with the parent generation cutoff', async () => {
    const directory = path.join(home, '.remote-cli', 'delegation-workers');
    const store = new DelegatedWorkerSessionStore(directory);
    const first = (await store.acquire({ threadId: 'synthetic-parent', backend: 'zcode', workingDirectory: cwd, workspaceGeneration: 0 })).lane;
    lane = first.executorThreadId; pointer = path.join(path.dirname(pointer), lane + '.json');
    const old = capture(); row();
    await store.markRunning(first.id); await store.captureNativeSession(first.id, 0, old);
    await store.markShutdownConfirmed(first.id, 0, true); await store.markReady(first.id);
    const next = (await store.acquire({ threadId: 'synthetic-parent', backend: 'zcode', workingDirectory: cwd, workspaceGeneration: 1 })).lane;
    lane = next.executorThreadId; pointer = path.join(path.dirname(pointer), lane + '.json'); id = 'sess_' + randomUUID();
    const current = capture(); row(); await store.captureNativeSession(next.id, 0, current);
    await store.requestNativeDeletion('synthetic-parent', 0);
    const artifacts = await preserveZCodeArtifacts(old, [old.sessionId]);
    const prepared: ZCodeDeletionPreparation = { version: 1, nativeVersion: old.nativeVersion,
      targetHash: stableHistoryHash(old), sessionIds: [old.sessionId], artifacts };
    await store.prepareNativeDeletion(first.id, 0, old, prepared);
    const restarted = new DelegatedWorkerSessionStore(directory);
    const candidates = await restarted.nativeDeletionCandidates(); expect(candidates.map(value => value.id)).toEqual([first.id]);
    expect(candidates[0].nativeSession).toEqual(old);
    expect(candidates[0].nativeDeletionPreparations?.[old.sessionId]).toEqual(prepared);
    await restarted.captureNativeSession(first.id, 0, JSON.parse(JSON.stringify(old)));
    expect((await restarted.nativeDeletionCandidates())[0].nativeSessionConflict).not.toBe(true);
    await expect(restarted.prepareNativeDeletion(first.id, 0, old, { ...prepared, artifacts: { ...artifacts, manifestHash: 'a'.repeat(64) } })).rejects.toThrow('cannot be replaced');
    await expect(restarted.markRunning(first.id)).rejects.toThrow('retired for deletion');
    await restarted.markShutdownConfirmed(next.id, 0, true); await restarted.markRunning(next.id);
    expect((await restarted.lanesForThread('synthetic-parent')).find(value => value.id === next.id)?.nativeGroupExitGeneration).toBeUndefined();
  });

  it.skipIf(!native).each(['default', 'user-config', 'environment'] as const)(
    'uses native %s shared storage, preserves unrelated state and retries partial deletion/lost ACK', async mode => {
      const configFile = path.join(home, '.zcode', 'cli', 'config.json');
      const nativeLaunch: command.ZCodeLaunchSpec = { command: process.env.REMOTE_CLI_ZCODE_NATIVE_NODE!,
        args: [process.env.REMOTE_CLI_ZCODE_NATIVE_ENTRY!, 'app-server', '--stdio'], env: {
          PATH: process.env.PATH, HOME: home, USERPROFILE: home, LANG: 'C.UTF-8',
          ZCODE_HOME: path.join(home, 'settings'), ZCODE_DATA_BASE_DIR: path.join(home, 'data'),
          XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'), XDG_CACHE_HOME: path.join(home, 'cache'),
        } };
      if (mode === 'user-config') write(configFile, JSON.stringify({ storage: { dir: '../relative-storage', sessionDbPath: '../relative-storage/native.sqlite' } }));
      if (mode === 'environment') Object.assign(nativeLaunch.env, { ZCODE_STORAGE_DIR: path.join(home, 'custom', 'cli'), ZCODE_SESSION_DB: path.join(home, 'custom', 'native.sqlite') });
      const selected = selectZCodeStorage(nativeLaunch, cwd, home); storage = selected.storage; database = selected.database;
      const originalLaunch = structuredClone(nativeLaunch);
      const captured: ZCodeOwnedTarget[] = [], additional: ZCodeOwnedTarget[] = []; const failure = vi.fn(async () => {});
      const executor = new ZCodeExecutor(new DirectoryGuard([home]), { delegationWorker: true, threadId: lane,
        initialWorkingDirectory: cwd, sessionBaseDir: path.dirname(pointer), launch: nativeLaunch });
      executors.push(executor); executor.observeNativeSessionCreation(async value => { captured.push(value as ZCodeOwnedTarget); }, failure);
      const insert = (value: any, sid: string, parent: string | null = null, type = 'interactive') => value.prepare(
        'INSERT INTO session(id,project_id,slug,directory,path,title,version,time_created,time_updated,parent_id,task_type) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(sid, 'synthetic-project', 'synthetic-session', cwd, cwd, 'Synthetic fixture', 'format-fixture', 1, 1, parent, type);
      const prompt = vi.spyOn(ZCodeClient.prototype, 'prompt').mockImplementation(async sid => {
        expect([...captured, ...additional].some(target => target.sessionId === sid)).toBe(true);
        // Simulate native first-activity persistence; no prompt/provider call.
        db(value => { if (!value.prepare('SELECT id FROM session WHERE id = ?').get(sid)) insert(value, sid); });
        return { stopReason: 'end_turn' };
      });
      expect((await executor.execute('Intercepted no-model prompt.')).success).toBe(true);
      expect((await executor.execute('Intercepted reuse.')).success).toBe(true);
      expect(captured).toHaveLength(1); expect(failure).not.toHaveBeenCalled(); expect(prompt).toHaveBeenCalledTimes(2);
      expect(nativeLaunch).toEqual(originalLaunch);
      if (mode === 'default') {
        const sibling = new ZCodeExecutor(new DirectoryGuard([home]), { delegationWorker: true, threadId: 'delegate-lane-' + randomUUID(),
          initialWorkingDirectory: cwd, sessionBaseDir: path.dirname(pointer), launch: nativeLaunch });
        executors.push(sibling); sibling.observeNativeSessionCreation(async value => { additional.push(value as ZCodeOwnedTarget); }, failure);
        const results = await Promise.all([executor.execute('Intercepted concurrent reuse.'), sibling.execute('Intercepted sibling creation.')]);
        expect(results.every(result => result.success)).toBe(true); expect(additional).toHaveLength(1);
        expect(additional[0].sessionId).not.toBe(captured[0].sessionId);
        // The unrelated worker stays alive while only the retired root is purged.
      }
      await executor.destroy(); await executor.waitForExit(); await executor.waitForManagedProcessGroupExit();
      const resumed = new ZCodeExecutor(new DirectoryGuard([home]), { delegationWorker: true, threadId: lane,
        initialWorkingDirectory: cwd, sessionBaseDir: path.dirname(pointer), launch: nativeLaunch });
      executors.push(resumed); const recaptured = vi.fn(async () => {});
      resumed.observeNativeSessionCreation(recaptured, failure);
      expect((await resumed.execute('Intercepted restart/resume.')).success).toBe(true);
      expect(recaptured).not.toHaveBeenCalled(); expect(failure).not.toHaveBeenCalled();
      expect(resumed.getSessionId()).toBe(captured[0].sessionId);
      await resumed.destroy(); await resumed.waitForExit(); await resumed.waitForManagedProcessGroupExit();
      const target = JSON.parse(JSON.stringify(captured[0])) as ZCodeOwnedTarget; id = target.sessionId;
      expect(target.ownership.contract).toBe('zcode-shared-storage-v1');
      const child = 'sess_' + randomUUID(), linked = 'sess_' + randomUUID(), foreign = 'sess_' + randomUUID(), fork = 'sess_' + randomUUID();
      db(value => {
        insert(value, child, id, 'subagent_child'); insert(value, linked); insert(value, foreign); insert(value, fork, id, 'fork');
        value.prepare('INSERT INTO session_task_link(id,parent_session_id,child_session_id,role,path,status,time_created,time_updated) VALUES (?,?,?,?,?,?,?,?)')
          .run('synthetic-link', id, linked, 'workflow_child', 'fixture', 'completed', 1, 1);
        value.prepare('INSERT INTO local_setting VALUES (?,?,?,?,?,?,?,?)').run('project', 'unrelated-project', 'permission', 'mode', '{"mode":"guarded"}', 1, 1, 1);
        value.prepare('INSERT INTO dwf_run(id,parent_session_id,status,caps_max_concurrency,time_created,time_updated,result_json) VALUES (?,?,?,?,?,?,?)')
          .run('synthetic-deliverable', id, 'completed', 1, 1, 1, '{"output":"retained-database-output"}');
      });
      const cli = path.basename(storage) === 'cli' ? storage : path.join(storage, 'cli');
      const cascade = [id, child, linked].sort();
      for (const member of cascade) write(path.join(cli, 'artifacts', member, 'output.bin'), Buffer.from([0, 255, 3]));
      const sentinel = path.join(cli, 'artifacts', foreign, 'keep.bin'); write(sentinel, Buffer.from([8, 9]));
      const preferences = () => db(value => JSON.stringify(value.prepare('SELECT * FROM local_setting ORDER BY scope,scope_id,namespace,key').all()));
      const unrelatedIds = [foreign, fork, ...additional.map(target => target.sessionId)];
      const unrelated = () => db(value => JSON.stringify(value.prepare(`SELECT * FROM session WHERE id IN (${unrelatedIds.map(() => '?').join(',')}) ORDER BY id`).all(...unrelatedIds)));
      const before = { preferences: preferences(), unrelated: unrelated() };
      expect(await inspectZCodeOwnedTree(target)).toEqual(cascade);
      // Original project cwd/config can disappear/change before maintenance.
      // Freeze both native roots, not the current user's selection.
      fs.rmSync(cwd, { recursive: true });
      write(configFile, JSON.stringify({ storage: { dir: path.join(home, 'different'), sessionDbPath: path.join(home, 'different.sqlite') } }));
      vi.spyOn(command, 'resolveZCodeLaunch').mockReturnValue(nativeLaunch);
      let preparation: ZCodeDeletionPreparation | undefined; let loseAck = true, partial = true;
      const request = ZCodeClient.prototype.requestSessionData;
      vi.spyOn(ZCodeClient.prototype, 'requestSessionData').mockImplementation(async function (action, sid) {
        if (action === 'purge' && partial) {
          partial = false;
          fs.unlinkSync(path.join(cli, 'artifacts', child, 'output.bin'));
          throw new Error('Synthetic partial file deletion');
        }
        const result = await request.call(this, action, sid);
        if (action === 'purge' && loseAck) { loseAck = false; throw new Error('Synthetic lost acknowledgement'); }
        return result;
      });
      const recovery = { persistPrepared: async (value: ZCodeDeletionPreparation) => { preparation = value; }, persistMaintenanceState: async () => {} };
      expect((await deleteOwnedZCodeHistory(target, recovery)).state).toBe('uncertain');
      expect(preparation!.targetHash).toBe(stableHistoryHash(target));
      const immutable = JSON.stringify(preparation);
      expect((await deleteOwnedZCodeHistory(target, { ...recovery, prepared: JSON.parse(immutable) })).state).toBe('uncertain');
      expect((await deleteOwnedZCodeHistory(target, { ...recovery, prepared: JSON.parse(JSON.stringify(preparation)) })).state).toBe('deleted');
      expect(JSON.stringify(preparation)).toBe(immutable);
      expect(preferences()).toBe(before.preferences); expect(unrelated()).toBe(before.unrelated);
      expect(fs.readFileSync(sentinel)).toEqual(Buffer.from([8, 9]));
      for (const member of cascade) {
        expect(fs.existsSync(path.join(cli, 'artifacts', member))).toBe(false);
        expect(fs.readFileSync(path.join(preparation!.artifacts.root.path, 'artifacts', member, 'output.bin'))).toEqual(Buffer.from([0, 255, 3]));
      }
      expect(fs.readFileSync(path.join(preparation!.artifacts.root.path, 'database-outputs.json'), 'utf8')).toContain('retained-database-output');
      expect(fs.existsSync(path.join(home, 'different.sqlite'))).toBe(false);
    }, 45_000);
});
