import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { pathToFileURL } from 'url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { provisionZCodeOwnedHistory, configuredZCodeOwnedHistory, ownedZCodeLaunch, captureZCodeOwnedHistory, inspectZCodeOwnedTree,
  preserveZCodeArtifacts, verifyZCodeArtifacts, deleteOwnedZCodeHistory, type ZCodeOwnedNamespace,
  type ZCodeOwnedTarget, validZCodeOwnedTarget } from '../../src/delegation/ZCodeOwnedHistory';
import { stableHistoryHash } from '../../src/delegation/NativeHistoryFiles';
import type { ZCodeDeletionPreparation } from '../../src/delegation/ZCodeSessionDeletion';
import { ZCodeExecutor } from '../../src/executor/ZCodeExecutor';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { ZCodeClient } from '../../src/executor/zcode/ZCodeClient';
import * as zcodeTransport from '../../src/executor/zcode/ZCodeClient';
import type { AcpTransport } from '../../src/executor/acp/AcpClient';
import { selectZCodeStorage } from '../../src/executor/zcode/ZCodeStorageSelection';

let DatabaseSync: any;
try { DatabaseSync = require('node:sqlite').DatabaseSync; } catch { /* Optional runtime capability. */ }
const linux = process.platform === 'linux';
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

describe.skipIf(!DatabaseSync)('ZCode exclusive history ownership', () => {
  let home: string, cwd: string, pointerRoot: string, lane: string, ns: ZCodeOwnedNamespace;
  let id: string, target: ZCodeOwnedTarget;
  const executors: ZCodeExecutor[] = [];
  function db<T>(fn: (value: any) => T): T {
    const value = new DatabaseSync(ns.database);
    try { return fn(value); } finally { value.close(); }
  }
  function session(sid: string, parent: string | null = null, type = 'interactive') {
    db(value => value.prepare('INSERT INTO session VALUES (?, ?, ?, ?, NULL)').run(sid, parent, cwd, type));
  }
  function pointer(sid = id, adopted = false) {
    fs.writeFileSync(ns.pointer, JSON.stringify({ id: sid, cwd, ...(adopted ? { adopted: true } : {}) }));
  }
  function file(kind: string, name: string, bytes = Buffer.from('synthetic deliverable'), sid = id) {
    const destination = path.join(ns.storage.path, 'cli', kind, sid, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, bytes);
    return destination;
  }
  function nativeLaunch(owned?: ZCodeOwnedNamespace) {
    return { command: process.env.REMOTE_CLI_ZCODE_NATIVE_NODE!,
      args: [process.env.REMOTE_CLI_ZCODE_NATIVE_ENTRY!, 'app-server', '--stdio'], env: {
        PATH: process.env.PATH, HOME: home, USERPROFILE: home, LANG: 'C.UTF-8',
        ZCODE_HOME: path.join(home, 'config'), ZCODE_DATA_BASE_DIR: path.join(home, 'data'),
        XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'), XDG_CACHE_HOME: path.join(home, 'cache'),
        ...(owned ? { ZCODE_STORAGE_DIR: owned.storage.path, ZCODE_SESSION_DB_PATH: owned.database, ZCODE_SESSION_DB: owned.database } : {}),
      } };
  }
  beforeEach(async () => {
    home = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'zcode-owned-test-')));
    cwd = path.join(home, 'work'); fs.mkdirSync(cwd);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    for (const key of ['HOME', 'USERPROFILE', 'ZCODE_HOME', 'ZCODE_DATA_BASE_DIR', 'ZCODE_STORAGE_DIR', 'ZCODE_SESSION_DB_PATH', 'ZCODE_SESSION_DB']) vi.stubEnv(key, home);
    pointerRoot = path.join(home, '.remote-cli', 'zcode-sessions'); fs.mkdirSync(pointerRoot, { recursive: true });
    lane = 'delegate-lane-' + randomUUID();
    ns = provisionZCodeOwnedHistory(home, lane, path.join(pointerRoot, lane + '.json'))!;
    db(value => value.exec(schema));
    id = 'sess_' + randomUUID(); session(id); pointer();
    target = captureZCodeOwnedHistory(ns, id, cwd, 'synthetic-zcode');
  });
  afterEach(async () => {
    for (const executor of executors.splice(0)) { await executor.destroy(); await executor.waitForExit(); }
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    await fs.promises.rm(home, { recursive: true, force: true });
  });

  it('preserves an explicitly configured namespace without modifying configuration or aliases', () => {
    expect(validZCodeOwnedTarget(target)).toBe(true);
    expect(validZCodeOwnedTarget({ ...target, ownership: {} })).toBe(false);
    const original = { command: 'synthetic', args: ['app-server'], env: { HOME: home, USERPROFILE: home,
      ZCODE_HOME: path.join(home, 'settings'), ZCODE_STORAGE_DIR: ns.storage.path, ZCODE_SESSION_DB: ns.database } };
    const launch = ownedZCodeLaunch(original, ns);
    expect(launch.env).toMatchObject({ HOME: home, USERPROFILE: home, ZCODE_HOME: original.env.ZCODE_HOME,
      ZCODE_STORAGE_DIR: ns.storage.path, ZCODE_SESSION_DB: ns.database });
    expect(launch).toEqual(original);
    expect(launch.env).not.toHaveProperty('ZCODE_SESSION_DB_PATH');
    expect(configuredZCodeOwnedHistory(launch, home, lane, ns.pointer)).toEqual(ns);
    const other = 'delegate-lane-' + randomUUID();
    const second = provisionZCodeOwnedHistory(home, other, path.join(pointerRoot, other + '.json'))!;
    expect(second.database).not.toBe(ns.database);
    expect(provisionZCodeOwnedHistory(home, lane, ns.pointer)?.database).toBe(ns.database);
  });

  it.each(['default', 'custom', 'conflicting-alias'])('does not silently override %s native configuration', kind => {
    const fresh = 'delegate-lane-' + randomUUID();
    const pointer = path.join(pointerRoot, fresh + '.json');
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home };
    if (kind === 'custom') Object.assign(env, { ZCODE_STORAGE_DIR: path.join(home, 'custom'), ZCODE_SESSION_DB_PATH: path.join(home, 'preferences.sqlite') });
    if (kind === 'conflicting-alias') Object.assign(env, { ZCODE_STORAGE_DIR: ns.storage.path, ZCODE_SESSION_DB_PATH: ns.database, ZCODE_SESSION_DB: path.join(home, 'different.sqlite') });
    const launch = { command: 'synthetic', args: ['app-server'], env };
    const before = structuredClone(launch);
    expect(configuredZCodeOwnedHistory(launch, home, fresh, pointer)).toBeUndefined();
    expect(() => ownedZCodeLaunch(launch, ns)).toThrow('would change native configuration');
    expect(launch).toEqual(before);
    expect(fs.existsSync(path.join(home, '.remote-cli', 'zcode-owned', fresh))).toBe(false);
  });

  it('holds a legacy private pointer instead of silently resuming it in another database', () => {
    const marker = fs.readFileSync(path.join(ns.namespace.path, 'ownership.json'));
    const saved = fs.readFileSync(ns.pointer);
    expect(() => configuredZCodeOwnedHistory({ command: 'synthetic', args: [], env: { HOME: home } }, home, lane, ns.pointer))
      .toThrow('previously isolated storage');
    expect(fs.readFileSync(ns.pointer)).toEqual(saved);
    expect(fs.readFileSync(path.join(ns.namespace.path, 'ownership.json'))).toEqual(marker);
  });

  it('does not migrate adopted or ordinary existing pointers into an owned namespace', () => {
    const other = 'delegate-lane-' + randomUUID(); const location = path.join(pointerRoot, other + '.json');
    fs.writeFileSync(location, JSON.stringify({ id: 'sess_existing', cwd, adopted: true }));
    expect(provisionZCodeOwnedHistory(home, other, location)).toBeUndefined();
    expect(fs.existsSync(path.join(home, '.remote-cli', 'zcode-owned', other))).toBe(false);
    pointer(id, true); expect(provisionZCodeOwnedHistory(home, lane, ns.pointer)).toBeUndefined();
  });

  it('enumerates both native owned edges and tolerates unrelated non-UUID pointers', async () => {
    session('sess_child', id, 'subagent_child'); session('sess_link');
    db(value => value.prepare('INSERT INTO session_task_link VALUES (?, ?)').run(id, 'sess_link'));
    fs.writeFileSync(path.join(pointerRoot, 'ordinary.json'), JSON.stringify({ id: 'sess_unrelated', adopted: true }));
    expect(await inspectZCodeOwnedTree(target)).toEqual([id, 'sess_child', 'sess_link'].sort());
  });

  it.each([false, true])('rejects duplicate exact target references, adopted=%s', async adopted => {
    fs.writeFileSync(path.join(pointerRoot, 'other.json'), JSON.stringify({ id, cwd, adopted }));
    await expect(inspectZCodeOwnedTree(target)).rejects.toThrow('another pointer');
  });

  it('requires detached authorization for old identities and retains every creation receipt', async () => {
    const newer = 'sess_' + randomUUID(); session(newer); pointer(newer);
    const newTarget = captureZCodeOwnedHistory(ns, newer, cwd, 'synthetic-zcode');
    await expect(inspectZCodeOwnedTree(target)).rejects.toThrow('detached');
    expect(await inspectZCodeOwnedTree(target, undefined, true)).toEqual([id]);
    expect(await inspectZCodeOwnedTree(newTarget)).toEqual([newer]);
    expect(captureZCodeOwnedHistory(ns, newer, cwd, 'synthetic-zcode')).toEqual(newTarget);
    await expect(inspectZCodeOwnedTree({ ...target, cwd: path.dirname(cwd) }, undefined, true)).rejects.toThrow('not owned');
  });

  it('records a native reservation before its first row exists and retains the receipt when the row appears', async () => {
    const reserved = 'sess_' + randomUUID(); pointer(reserved);
    const reservation = captureZCodeOwnedHistory(ns, reserved, cwd, 'synthetic-zcode');
    expect(reservation.ownership.initialRow).toBe('reserved');
    expect(await inspectZCodeOwnedTree(reservation)).toEqual([reserved]);
    const hash = stableHistoryHash(reservation); session(reserved);
    expect(await inspectZCodeOwnedTree(reservation)).toEqual([reserved]);
    expect(stableHistoryHash(reservation)).toBe(hash);
  });

  it('does not treat orphan database deliverables as an empty native reservation', async () => {
    const reserved = 'sess_' + randomUUID(); pointer(reserved);
    const reservation = captureZCodeOwnedHistory(ns, reserved, cwd, 'synthetic-zcode');
    db(value => value.prepare('INSERT INTO dwf_run VALUES (?, ?, NULL, ?, NULL)').run('orphan', reserved, '{"output":"retain"}'));
    await expect(inspectZCodeOwnedTree(reservation)).rejects.toThrow('orphan workflow');
  });

  it('rejects invalid native launch metadata and unknown existing namespaces', () => {
    expect(validZCodeOwnedTarget({ ...target, ownership: { ...target.ownership, launch: { command: 'synthetic', args: [null] } } })).toBe(false);
    const other = 'delegate-lane-' + randomUUID();
    fs.mkdirSync(path.join(home, '.remote-cli', 'zcode-owned', other));
    expect(() => provisionZCodeOwnedHistory(home, other, path.join(pointerRoot, other + '.json'))).toThrow();
  });

  it.each([false, true])('allows an unrelated replacement pointer under explicit detachment, adopted=%s', async adopted => {
    pointer('sess_unrelated', adopted);
    expect(await inspectZCodeOwnedTree(target, undefined, true)).toEqual([id]);
    pointer(id, true); await expect(inspectZCodeOwnedTree(target, undefined, true)).rejects.toThrow('another pointer');
  });

  it('rejects foreign roots, forks, shared task links and foreign artifact references', async () => {
    session('sess_foreign', id, 'interactive');
    await expect(inspectZCodeOwnedTree(target)).rejects.toThrow('foreign');
    db(value => value.exec("DELETE FROM session WHERE id = 'sess_foreign'"));
    const other = 'sess_other'; session(other); pointer(other); captureZCodeOwnedHistory(ns, other, cwd, 'synthetic-zcode'); pointer();
    db(value => value.prepare('INSERT INTO session_task_link VALUES (?, ?)').run(id, other));
    await expect(inspectZCodeOwnedTree(target)).rejects.toThrow('shared');
    db(value => { value.exec('DELETE FROM session_task_link'); value.prepare('INSERT INTO part VALUES (?, ?, ?)').run('foreign-output', other, JSON.stringify({ url: `zcode-artifact://${id}/output` })); });
    await expect(inspectZCodeOwnedTree(target)).rejects.toThrow('foreign reference');
  });

  it('fails closed for malformed schema and replaced database identities', async () => {
    db(value => value.exec('DROP TABLE session_task_link'));
    await expect(inspectZCodeOwnedTree(target)).rejects.toThrow();
    fs.renameSync(ns.database, ns.database + '.previous'); db(value => value.exec(schema));
    await expect(inspectZCodeOwnedTree(target)).rejects.toThrow('identity changed');
  });

  it.skipIf(!linux)('exports native files and database deliverables without copying transcripts', async () => {
    for (const kind of ['artifacts', 'exec', 'agents', 'sessions']) file(kind, 'nested/output.bin', Buffer.from([0, 17, 255]));
    db(value => {
      value.prepare('INSERT INTO dwf_run VALUES (?, ?, ?, ?, NULL)').run('run', id, 'return 42', '{"answer":42}');
      value.prepare('INSERT INTO dwf_node VALUES (?, ?, ?, NULL)').run('node', 'run', '{"asset":"complete"}');
      value.prepare('INSERT INTO dwf_event VALUES (?, ?, ?, ?)').run('run', 0, 'artifact-published', '{"artifact":{"id":"asset","data":"result"}}');
      value.prepare('INSERT INTO part VALUES (?, ?, ?)').run('input', id, '{"type":"text","text":"DO-NOT-EXPORT-TRANSCRIPT"}');
      value.prepare('INSERT INTO part VALUES (?, ?, ?)').run('output', id, '{"type":"tool","state":{"input":"DO-NOT-EXPORT-INPUT","output":"retained-output"}}');
      value.prepare('INSERT INTO input_history VALUES (?, ?, ?)').run('attachment', id, '[{"name":"attachment","data":"encoded-fixture"}]');
    });
    const receipt = await preserveZCodeArtifacts(target, [id]);
    const content = fs.readFileSync(path.join(receipt.root.path, 'database-outputs.json'), 'utf8');
    expect(content).toContain('retained-output'); expect(content).toContain('encoded-fixture'); expect(content).toContain('artifact-published');
    expect(content).not.toContain('DO-NOT-EXPORT');
    await verifyZCodeArtifacts(receipt, target, [id]);
    expect(await preserveZCodeArtifacts(target, [id])).toEqual(receipt);
    for (const kind of ['artifacts', 'exec', 'agents', 'sessions']) expect(fs.readFileSync(path.join(receipt.root.path, kind, id, 'nested/output.bin'))).toEqual(Buffer.from([0, 17, 255]));
    file('artifacts', 'late.txt'); await expect(verifyZCodeArtifacts(receipt, target, [id])).rejects.toThrow('changed after export');
  });

  it.skipIf(!linux)('rejects redirected or multiply linked artifacts and modified exports', async () => {
    const original = file('artifacts', 'a'); const link = path.join(path.dirname(original), 'link');
    fs.linkSync(original, link); await expect(preserveZCodeArtifacts(target, [id])).rejects.toThrow('Unsupported'); fs.unlinkSync(link);
    fs.symlinkSync(original, link); await expect(preserveZCodeArtifacts(target, [id])).rejects.toThrow('Unsupported'); fs.unlinkSync(link);
    const receipt = await preserveZCodeArtifacts(target, [id]);
    fs.writeFileSync(path.join(receipt.root.path, 'artifacts', id, 'a'), 'changed');
    await expect(verifyZCodeArtifacts(receipt, target, [id])).rejects.toThrow('bytes changed');
  });

  it.skipIf(!linux)('recovers partial file deletion and lost ACK with exact immutable preparation after restart', async () => {
    const artifact = file('artifacts', 'result.txt'); const unrelated = path.join(cwd, 'code.txt'); fs.writeFileSync(unrelated, 'code');
    let prepared: ZCodeDeletionPreparation | undefined; let calls = 0; const fences: boolean[] = [];
    const factory = () => ({
      requestSessionData: async (action: string) => {
        if (action === 'measure') return { sessions: [{ sessionId: id, bytes: 1 }], memory: [] };
        calls++;
        if (calls === 1) { fs.unlinkSync(artifact); throw new Error('Synthetic partial native purge'); }
        db(value => value.exec('DELETE FROM session'));
        if (calls === 2) throw new Error('Synthetic lost acknowledgement');
        return { deleted: [{ sessionId: id, bytes: 0 }], kept: [], failed: [], memory: [] };
      }, destroy: vi.fn(), waitForExit: async () => {}, waitForManagedProcessGroupExit: async () => {},
    });
    const recovery = () => ({ prepared: prepared && JSON.parse(JSON.stringify(prepared)),
      persistPrepared: async (value: ZCodeDeletionPreparation) => { prepared = JSON.parse(JSON.stringify(value)); },
      persistMaintenanceState: async (value: boolean) => { fences.push(value); } });
    expect((await deleteOwnedZCodeHistory(target, recovery(), factory)).state).toBe('uncertain');
    const immutable = JSON.stringify(prepared);
    expect((await deleteOwnedZCodeHistory(target, recovery(), factory)).state).toBe('uncertain');
    expect((await deleteOwnedZCodeHistory(target, recovery(), factory)).state).toBe('deleted');
    expect(JSON.stringify(prepared)).toBe(immutable); expect(fences).toEqual([true, false, true, false, true, false]);
    expect(fs.readFileSync(path.join(prepared!.artifacts.root.path, 'artifacts', id, 'result.txt'), 'utf8')).toBe('synthetic deliverable');
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('code');
    await expect(inspectZCodeOwnedTree(target)).rejects.toThrow('missing root');
    await expect(inspectZCodeOwnedTree(target, { ...prepared!, targetHash: '0'.repeat(64) })).rejects.toThrow('preparation changed');
  });

  it.skipIf(!linux)('pins maintenance storage and launch while allowing a removed disposable cwd', async () => {
    const launch = { command: 'synthetic-node', args: ['synthetic-entry', 'app-server', '--stdio'] };
    const second = 'sess_' + randomUUID(); session(second); pointer(second);
    const secondTarget = captureZCodeOwnedHistory(ns, second, cwd, 'synthetic-zcode', false, launch);
    await fs.promises.rmdir(cwd);
    const client = { requestSessionData: vi.fn(async (action: string) => {
      if (action === 'measure') return { sessions: [{ sessionId: second, bytes: 0 }], memory: [] };
      db(value => value.prepare('DELETE FROM session WHERE id = ?').run(second));
      return { deleted: [{ sessionId: second, bytes: 0 }], kept: [], failed: [], memory: [] };
    }),
      destroy: vi.fn(), waitForExit: async () => {}, waitForManagedProcessGroupExit: async () => {} };
    const constructor = vi.spyOn(zcodeTransport, 'ZCodeClient').mockImplementation(() => client as unknown as ZCodeClient);
    expect((await deleteOwnedZCodeHistory(secondTarget, { persistPrepared: async () => {}, persistMaintenanceState: async () => {} })).state).toBe('deleted');
    expect(constructor).toHaveBeenCalledWith(expect.objectContaining({ cwd: ns.storage.path, maintenance: true, delegationWorker: true,
      launch: expect.objectContaining({ ...launch, env: expect.objectContaining({ HOME: home, ZCODE_STORAGE_DIR: ns.storage.path,
        ZCODE_SESSION_DB_PATH: ns.database, ZCODE_SESSION_DB: ns.database }) }) }), {});
  });

  it.skipIf(!linux)('does not accept a successful native reply while owned session rows remain', async () => {
    let prepared: ZCodeDeletionPreparation | undefined;
    const factory = () => ({ requestSessionData: async (action: string) => action === 'measure'
      ? { sessions: [{ sessionId: id, bytes: 0 }], memory: [] }
      : { deleted: [{ sessionId: id, bytes: 0 }], kept: [], failed: [], memory: [] },
      destroy: vi.fn(), waitForExit: async () => {}, waitForManagedProcessGroupExit: async () => {} });
    expect((await deleteOwnedZCodeHistory(target, { persistPrepared: async value => { prepared = value; }, persistMaintenanceState: async () => {} }, factory)).state).toBe('uncertain');
    expect(prepared).toBeDefined(); expect(await inspectZCodeOwnedTree(target, prepared)).toEqual([id]);
  });

  function executorWith(transport: AcpTransport) {
    const executor = new ZCodeExecutor(new DirectoryGuard([home]), { delegationWorker: true, threadId: lane,
      initialWorkingDirectory: cwd, sessionBaseDir: pointerRoot, zcodeCommand: 'synthetic-zcode',
      launch: { command: 'synthetic-zcode', args: [], env: { HOME: home, USERPROFILE: home,
        ZCODE_STORAGE_DIR: ns.storage.path, ZCODE_SESSION_DB_PATH: ns.database } },
      clientFactory: (_callbacks, _cwd, owned) => { expect(owned?.database).toBe(ns.database); return transport; } });
    executors.push(executor); return executor;
  }
  function fake(): AcpTransport {
    return { initialize: vi.fn(async () => ({})), newSession: vi.fn(async () => ({ sessionId: id })),
      loadSession: vi.fn(async () => ({ sessionId: id })), prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
      setConfigOption: vi.fn(async () => ({})), deleteSession: vi.fn(async () => {}), sendCancel: vi.fn(), destroy: vi.fn(),
      waitForExit: async () => {}, waitForManagedProcessGroupExit: async () => {} };
  }
  it('keeps managed global configuration and reuse while durably holding unowned cleanup before prompt', async () => {
    const sharedLane = 'delegate-lane-' + randomUUID();
    const launch = { command: 'synthetic-zcode', args: ['app-server', '--stdio'], env: {
      HOME: home, USERPROFILE: home, ZCODE_HOME: path.join(home, 'settings'),
      ZCODE_STORAGE_DIR: path.join(home, 'global-storage'), ZCODE_SESSION_DB_PATH: path.join(home, 'global.sqlite'),
      ZCODE_SESSION_DB: path.join(home, 'global.sqlite'),
    } };
    const original = structuredClone(launch);
    const transport = fake(); const newSession = transport.newSession; const prompt = transport.prompt;
    const constructor = vi.spyOn(zcodeTransport, 'ZCodeClient').mockImplementation(() => transport as ZCodeClient);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const create = () => {
      const executor = new ZCodeExecutor(new DirectoryGuard([home]), { delegationWorker: true, threadId: sharedLane,
        initialWorkingDirectory: cwd, sessionBaseDir: pointerRoot, launch });
      executors.push(executor); return executor;
    };
    const executor = create(); const observer = vi.fn(async () => {});
    let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
    const failure = vi.fn(async () => { await barrier; });
    executor.observeNativeSessionCreation(observer, failure);
    const execution = executor.execute('synthetic prompt');
    try { await vi.waitFor(() => expect(failure).toHaveBeenCalledOnce()); expect(prompt).not.toHaveBeenCalled(); }
    finally { release(); await execution; }
    expect((await executor.execute('reuse configured session')).success).toBe(true);
    expect(newSession).toHaveBeenCalledOnce(); expect(observer).not.toHaveBeenCalled();
    await executor.destroy(); await executor.waitForManagedProcessGroupExit();
    const resumedTransport = fake(); const loadSession = resumedTransport.loadSession;
    constructor.mockImplementation(() => resumedTransport as ZCodeClient);
    const resumed = create(); resumed.observeNativeSessionCreation(observer, failure);
    expect((await resumed.execute('resume configured session')).success).toBe(true);
    expect(loadSession).toHaveBeenCalledOnce(); expect(newSession).toHaveBeenCalledOnce();
    expect(failure).toHaveBeenCalled();
    for (const call of constructor.mock.calls) expect(call[0].launch).toEqual(original);
    expect(launch).toEqual(original);
    expect(fs.existsSync(path.join(home, '.remote-cli', 'zcode-owned', sharedLane))).toBe(false);
  });

  it('refuses to launch a previously isolated context against unrelated configuration', async () => {
    const transport = fake(); const factory = vi.fn(() => transport);
    const executor = new ZCodeExecutor(new DirectoryGuard([home]), { delegationWorker: true, threadId: lane,
      initialWorkingDirectory: cwd, sessionBaseDir: pointerRoot, clientFactory: factory,
      launch: { command: 'synthetic-zcode', args: [], env: { HOME: home, USERPROFILE: home } } });
    executors.push(executor); const before = fs.readFileSync(ns.pointer);
    expect((await executor.execute('synthetic prompt')).success).toBe(false);
    expect(factory).not.toHaveBeenCalled(); expect(fs.readFileSync(ns.pointer)).toEqual(before);
    expect(await inspectZCodeOwnedTree(target)).toEqual([id]);
  });

  it('awaits creation persistence before prompt and does not recapture owned resumes', async () => {
    fs.unlinkSync(ns.pointer);
    const transport = fake(); const executor = executorWith(transport); const order: string[] = [];
    let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
    const observer = vi.fn(async () => { order.push('receipt'); await barrier; order.push('durable'); });
    executor.observeNativeSessionCreation(observer, async () => { throw new Error('Unexpected capture failure'); });
    transport.prompt = vi.fn(async () => { order.push('prompt'); return { stopReason: 'end_turn' }; });
    const execution = executor.execute('synthetic prompt');
    try { await vi.waitFor(() => expect(observer).toHaveBeenCalledOnce()); expect(transport.prompt).not.toHaveBeenCalled(); }
    finally { release(); await execution; }
    expect(order).toEqual(['receipt', 'durable', 'prompt']);
    await executor.execute('reuse'); expect(observer).toHaveBeenCalledOnce();
    await executor.destroy(); await executor.waitForManagedProcessGroupExit();
    const resumed = executorWith(fake()); const resumeObserver = vi.fn(async () => {}); resumed.observeNativeSessionCreation(resumeObserver);
    await resumed.execute('resume'); expect(resumeObserver).not.toHaveBeenCalled();
    await resumed.deleteThreadData(lane); expect(fs.existsSync(ns.pointer)).toBe(true);
  });

  it('keeps deletion fenced when a creation receipt cannot be durably marked unavailable', async () => {
    fs.unlinkSync(ns.pointer); const transport = fake();
    const executor = executorWith(transport); executor.observeNativeSessionCreation(async () => { throw new Error('Synthetic store failure'); });
    expect((await executor.execute('synthetic prompt')).success).toBe(false);
    expect(transport.prompt).not.toHaveBeenCalled(); await executor.destroy();
    await expect(executor.waitForManagedProcessGroupExit()).rejects.toThrow('unconfirmed');
  });

  it('preserves ordinary resume fallback while refusing arbitrary managed resume failures', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const managed = fake(); managed.loadSession = vi.fn(async () => { throw new Error('Synthetic transport failure'); });
    const managedCreate = managed.newSession;
    const worker = executorWith(managed); worker.observeNativeSessionCreation(async () => {}, async () => {});
    expect((await worker.execute('synthetic prompt')).success).toBe(false);
    expect(managedCreate).not.toHaveBeenCalled();
    const ordinary = fake(); ordinary.loadSession = managed.loadSession;
    fs.writeFileSync(path.join(pointerRoot, 'ordinary.json'), JSON.stringify({ id: 'sess_ordinary', cwd }));
    const executor = new ZCodeExecutor(new DirectoryGuard([home]), { threadId: 'ordinary', initialWorkingDirectory: cwd,
      sessionBaseDir: pointerRoot, clientFactory: () => ordinary });
    executors.push(executor); executor.observeNativeSessionCreation(async () => { throw new Error('Ordinary session must not be observed'); });
    expect((await executor.execute('synthetic prompt')).success).toBe(true);
    expect(ordinary.newSession).toHaveBeenCalledOnce();
    await executor.deleteThreadData('ordinary'); expect(fs.existsSync(path.join(pointerRoot, 'ordinary.json'))).toBe(false);
  });

  it('retains capture fencing across shutdown while a native create reply is pending', async () => {
    fs.unlinkSync(ns.pointer); const transport = fake();
    let release!: () => void;
    transport.newSession = vi.fn(async () => { await new Promise<void>(resolve => { release = resolve; }); return { sessionId: id }; });
    const executor = executorWith(transport); const observed = vi.fn(async () => {});
    executor.observeNativeSessionCreation(observed, async () => {});
    const task = executor.execute('synthetic prompt');
    try {
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      await executor.destroy(); await expect(executor.waitForManagedProcessGroupExit()).rejects.toThrow('unconfirmed');
    } finally { release(); await task; }
    expect(observed).toHaveBeenCalledOnce(); expect(transport.prompt).not.toHaveBeenCalled();
    await executor.waitForManagedProcessGroupExit();
  });

  it('reports unavailable capture durably while preserving ordinary execution', async () => {
    fs.unlinkSync(ns.pointer); db(value => value.exec('DROP TABLE session'));
    const transport = fake(); const executor = executorWith(transport); const failure = vi.fn(async () => {});
    const observer = vi.fn(async () => {}); executor.observeNativeSessionCreation(observer, failure);
    expect((await executor.execute('synthetic prompt')).success).toBe(true);
    expect(failure).toHaveBeenCalledOnce(); expect(observer).not.toHaveBeenCalled();
    await executor.destroy(); await executor.waitForManagedProcessGroupExit();
  });

  it.skipIf(!linux || !process.env.REMOTE_CLI_ZCODE_NATIVE_ENTRY || !process.env.REMOTE_CLI_ZCODE_NATIVE_NODE)(
    'preserves official user/project settings, agents, plugins, memory and database preferences', async () => {
      // Optional source-build oracle: only the supplied official modules and
      // synthetic home are used. No app-server, provider or model is invoked.
      const configured = nativeLaunch();
      const storage = path.join(home, 'global-storage');
      const database = path.join(home, 'global.sqlite');
      const write = (file: string, value: string) => {
        fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value);
      };
      write(path.join(home, '.zcode', 'cli', 'config.json'), JSON.stringify({ storage: { dir: storage, sessionDbPath: database },
        features: { memory: true }, modelStream: { idleTimeoutMs: 12345 }, plugins: { enabledPlugins: { 'fixture-plugin@local': true } } }));
      write(path.join(cwd, '.zcode', 'config.json'), JSON.stringify({ plugins: { enabledPlugins: { 'fixture-plugin@local': false } } }));
      write(path.join(storage, 'agents', 'global-reviewer.md'), '---\nname: global-reviewer\ndescription: Global synthetic reviewer\n---\nReview synthetic files.');
      write(path.join(cwd, '.zcode', 'agents', 'project-reviewer.md'), '---\nname: project-reviewer\ndescription: Project synthetic reviewer\n---\nReview this synthetic project.');
      const plugins = path.join(storage, 'cli', 'plugins');
      const installed = path.join(plugins, 'cache', 'fixture-plugin');
      write(path.join(installed, 'marker.txt'), 'synthetic installed plugin');
      write(path.join(plugins, 'installed_plugins.json'), JSON.stringify({ version: 1, plugins: [{
        id: 'fixture-plugin@local', name: 'fixture-plugin', marketplace: 'local', version: '1.0.0',
        installPath: installed, installedAt: '2026-01-01T00:00:00.000Z', scope: 'user',
      }] }));
      const sharedLane = 'delegate-lane-' + randomUUID();
      let effective: typeof configured | undefined;
      vi.spyOn(zcodeTransport, 'ZCodeClient').mockImplementation(options => { effective = options.launch as typeof configured; return fake() as ZCodeClient; });
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const executor = new ZCodeExecutor(new DirectoryGuard([home]), { delegationWorker: true, threadId: sharedLane,
        initialWorkingDirectory: cwd, sessionBaseDir: pointerRoot, launch: configured });
      executors.push(executor); const failure = vi.fn(async () => {});
      executor.observeNativeSessionCreation(async () => { throw new Error('Unexpected shared-storage ownership'); }, failure);
      expect((await executor.execute('synthetic prompt')).success).toBe(true);
      expect(failure).toHaveBeenCalled(); expect(effective).toEqual(configured);
      // Configuration APIs are imported from the optional source build. They
      // execute under the exact environment forwarded to the transport above.
      const overrides = [{}, { ZCODE_STORAGE_DIR: '../override' }, { ZCODE_SESSION_DB_PATH: '../one.sqlite' },
        { ZCODE_SESSION_DB_PATH: '../one.sqlite', ZCODE_SESSION_DB: '../two.sqlite' },
        { ZCODE_SESSION_DB: '../two.sqlite', ZCODE_SESSION_DB_PATH: '../one.sqlite' },
        { ZCODE_STORAGE_DIR: '', ZCODE_SESSION_DB: '' }];
      const script = `
        import fs from 'node:fs';
        import path from 'node:path';
        import { pathToFileURL } from 'node:url';
        import { DatabaseSync } from 'node:sqlite';
        const packages = path.resolve(path.dirname(process.argv[1]), '../..');
        const load = name => import(pathToFileURL(path.join(packages, name)).href);
        const { createConfig } = await load('adapters/dist/config/config-factory.js');
        const { resolvePath } = await load('adapters/dist/config/file-config.adapter.js');
        const { loadZCodeAgentProfiles } = await load('bootstrap/dist/subagents.js');
        const { getCliStorageRoot, getPluginStorageRoot, getProjectMemoryRoot } = await load('bootstrap/dist/app/paths.js');
        const { listInstalledPluginRecords, resolveInstalledPluginRoot } = await load('adapters/dist/plugins/marketplace.js');
        const { getProjectPermissionMode, saveProjectPermissionMode } = await load('adapters/dist/storage/session-store/repositories/local-settings.js');
        const config = createConfig({ env: process.env, workingDirectory: process.cwd() }).config;
        const agents = await loadZCodeAgentProfiles({ storageRoot: config.storage.dir, workingDirectory: process.cwd() });
        const cliRoot = getCliStorageRoot(config.storage.dir);
        const pluginRoot = getPluginStorageRoot(cliRoot);
        const records = listInstalledPluginRecords(pluginRoot);
        const memoryRoot = getProjectMemoryRoot(cliRoot, process.cwd());
        fs.mkdirSync(memoryRoot, { recursive: true });
        fs.writeFileSync(path.join(memoryRoot, 'MEMORY.md'), 'synthetic memory');
        const db = new DatabaseSync(config.storage.sessionDbPath);
        db.exec('CREATE TABLE local_setting(scope TEXT,scope_id TEXT,namespace TEXT,key TEXT,value TEXT,schema_version INTEGER,time_created INTEGER,time_updated INTEGER,PRIMARY KEY(scope,scope_id,namespace,key))');
        saveProjectPermissionMode(db, { mode: 'guarded', projectID: 'synthetic-project' });
        const preference = getProjectPermissionMode(db, 'synthetic-project');
        db.close();
        const selections = ${JSON.stringify(overrides)}.map(override => {
          const storage = createConfig({ env: { ...process.env, ...override }, workingDirectory: process.cwd() }).config.storage;
          return { storage: resolvePath(storage.dir), database: resolvePath(storage.sessionDbPath) };
        });
        console.log(JSON.stringify({ selections, storage: config.storage, timeout: config.modelStream.idleTimeoutMs, enabledPlugins: config.plugins.enabledPlugins,
          agents: agents.profiles.map(value => value.name).sort(),
          plugins: records.map(record => ({ id: record.id, marker: fs.readFileSync(path.join(resolveInstalledPluginRoot(pluginRoot, record), 'marker.txt'), 'utf8') })),
          memoryRoot, memory: fs.readFileSync(path.join(memoryRoot, 'MEMORY.md'), 'utf8'), preference }));
      `;
      const result = await promisify(execFile)(configured.command, ['--import', pathToFileURL(require.resolve('tsx')).href,
        '--input-type=module', '-e', script, configured.args[0]],
        { cwd, env: effective!.env, timeout: 20_000, maxBuffer: 1024 * 1024 });
      const observed = JSON.parse(result.stdout.trim());
      expect(observed.storage).toEqual({ dir: storage, sessionDbPath: database });
      expect(selectZCodeStorage(configured, cwd, home)).toEqual({ storage, database });
      expect(overrides.map(override => selectZCodeStorage({ ...configured, env: { ...configured.env, ...override } }, cwd, home))).toEqual(observed.selections);
      expect(observed.timeout).toBe(12345);
      expect(observed.enabledPlugins['fixture-plugin@local']).toBe(false);
      expect(observed.agents).toEqual(['global-reviewer', 'project-reviewer']);
      expect(observed.plugins).toEqual([{ id: 'fixture-plugin@local', marker: 'synthetic installed plugin' }]);
      expect(path.relative(path.join(storage, 'cli', 'memories'), observed.memoryRoot)).not.toMatch(/^\.\./);
      expect(observed.memory).toBe('synthetic memory'); expect(observed.preference).toBe('guarded');
      expect(fs.existsSync(path.join(home, '.remote-cli', 'zcode-owned', sharedLane))).toBe(false);
    }, 30_000);

  it.skipIf(!linux || !process.env.REMOTE_CLI_ZCODE_NATIVE_ENTRY || !process.env.REMOTE_CLI_ZCODE_NATIVE_NODE)(
    'creates and reuses a native no-model session using the original global storage configuration', async () => {
      const sharedLane = 'delegate-lane-' + randomUUID();
      const storage = path.join(home, 'global-storage'); const database = path.join(storage, 'global.sqlite');
      const config = path.join(home, '.zcode', 'cli', 'config.json');
      fs.mkdirSync(path.dirname(config), { recursive: true });
      fs.writeFileSync(config, JSON.stringify({ storage: { dir: storage, sessionDbPath: database } }));
      const executor = new ZCodeExecutor(new DirectoryGuard([home]), { delegationWorker: true, threadId: sharedLane,
        initialWorkingDirectory: cwd, sessionBaseDir: pointerRoot, launch: nativeLaunch() });
      executors.push(executor); const failure = vi.fn(async () => {}); const observer = vi.fn(async () => {});
      executor.observeNativeSessionCreation(observer, failure);
      const prompt = vi.spyOn(ZCodeClient.prototype, 'prompt').mockImplementation(async () => {
        expect(observer).toHaveBeenCalledOnce(); return { stopReason: 'end_turn' };
      });
      expect((await executor.execute('Mocked prompt; never sent to the native transport.')).success).toBe(true);
      const created = executor.getSessionId(); expect(created).toMatch(/^sess_/);
      expect((await executor.execute('Mocked reuse.')).success).toBe(true);
      expect(executor.getSessionId()).toBe(created); expect(prompt).toHaveBeenCalledTimes(2);
      expect(observer).toHaveBeenCalledOnce(); expect(failure).not.toHaveBeenCalled();
      await executor.destroy(); await executor.waitForExit(); await executor.waitForManagedProcessGroupExit();
      expect(fs.existsSync(database)).toBe(true);
      expect(fs.existsSync(path.join(home, '.remote-cli', 'zcode-owned', sharedLane))).toBe(false);
    }, 30_000);

  it.skipIf(!linux || !process.env.REMOTE_CLI_ZCODE_NATIVE_ENTRY || !process.env.REMOTE_CLI_ZCODE_NATIVE_NODE)(
    'captures actual executor creation and reset identities before a mocked no-model prompt', async () => {
      const nativeLane = 'delegate-lane-' + randomUUID();
      const configured = provisionZCodeOwnedHistory(home, nativeLane, path.join(pointerRoot, nativeLane + '.json'))!;
      const executor = new ZCodeExecutor(new DirectoryGuard([home]), { delegationWorker: true,
        threadId: nativeLane, initialWorkingDirectory: cwd, sessionBaseDir: pointerRoot, launch: nativeLaunch(configured) });
      executors.push(executor);
      const captured: ZCodeOwnedTarget[] = [];
      executor.observeNativeSessionCreation(async value => { captured.push(value as unknown as ZCodeOwnedTarget); }, async () => { throw new Error('Native receipt capture failed'); });
      const prompt = vi.spyOn(ZCodeClient.prototype, 'prompt').mockImplementation(async sessionId => {
        expect(captured.some(value => value.sessionId === sessionId)).toBe(true);
        return { stopReason: 'end_turn' };
      });
      expect((await executor.execute('This prompt is intercepted and never sent to the native transport.')).success).toBe(true);
      expect(captured).toHaveLength(1); expect(captured[0].ownership.initialRow).toBe('reserved');
      expect(validZCodeOwnedTarget(captured[0])).toBe(true);
      expect((await executor.execute('Mocked reuse.')).success).toBe(true); expect(captured).toHaveLength(1);
      executor.resetContext(); await executor.waitForExit();
      expect((await executor.execute('Mocked reset.')).success).toBe(true); expect(captured).toHaveLength(2);
      expect(captured[0].sessionId).not.toBe(captured[1].sessionId);
      expect(captured[0].nativeHome).toEqual(captured[1].nativeHome);
      expect(await inspectZCodeOwnedTree(captured[0], undefined, true)).toEqual([captured[0].sessionId]);
      expect(await inspectZCodeOwnedTree(captured[1])).toEqual([captured[1].sessionId]);
      expect(prompt).toHaveBeenCalledTimes(3);
      await executor.destroy(); await executor.waitForExit(); await executor.waitForManagedProcessGroupExit();
    }, 45_000);

  it.skipIf(!linux || !process.env.REMOTE_CLI_ZCODE_NATIVE_ENTRY || !process.env.REMOTE_CLI_ZCODE_NATIVE_NODE)(
    'accepts native no-model create, complete exports, purge and absent-root retry', async () => {
      // The optional entry/runtime point to an official build, never a user data root.
      const isolatedLane = 'delegate-lane-' + randomUUID();
      const isolated = provisionZCodeOwnedHistory(home, isolatedLane, path.join(pointerRoot, isolatedLane + '.json'))!;
      const launch = ownedZCodeLaunch(nativeLaunch(isolated), isolated);
      const client = new ZCodeClient({ cwd, launch, delegationWorker: true, autoApprove: false }, {});
      let created: string, unrelated: string;
      try { await client.initialize(); created = (await client.newSession(cwd, [])).sessionId!; unrelated = (await client.newSession(cwd, [])).sessionId!; }
      finally { client.destroy(); await client.waitForExit(); await client.waitForManagedProcessGroupExit(); }
      expect(created!).toMatch(/^sess_/);
      fs.writeFileSync(isolated.pointer, JSON.stringify({ id: created!, cwd }));
      const nativeTarget = captureZCodeOwnedHistory(isolated, created!, cwd, 'synthetic-native-entry', false, launch);
      captureZCodeOwnedHistory(isolated, unrelated!, cwd, 'synthetic-native-entry', true, launch);
      expect(nativeTarget.ownership.initialRow).toBe('reserved');
      expect(await inspectZCodeOwnedTree(nativeTarget)).toEqual([created!]);
      ns = isolated; id = created!;
      const child = 'sess_' + randomUUID(), linked = 'sess_' + randomUUID();
      const cascade = [id, child, linked].sort();
      for (const member of cascade) for (const kind of ['artifacts', 'exec', 'agents', 'sessions']) file(kind, 'native-output.bin', Buffer.from([0, 255, 1]), member);
      const sentinel = file('artifacts', 'unrelated.bin', Buffer.from('unrelated'), unrelated!);
      db(value => {
        // Simulate first-activity persistence without a model call. Native create
        // reserves the ID but intentionally does not materialize the row yet.
        const insert = value.prepare('INSERT INTO session(id,project_id,slug,directory,path,title,version,time_created,time_updated,parent_id,task_type) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
        for (const member of [...cascade, unrelated!]) insert.run(member, 'synthetic-project', 'synthetic-session', cwd, cwd, 'Synthetic fixture', 'format-fixture', 1, 1,
          member === child ? id : null, member === child ? 'subagent_child' : 'interactive');
        value.prepare('INSERT INTO session_task_link(id,parent_session_id,child_session_id,role,path,status,time_created,time_updated) VALUES (?,?,?,?,?,?,?,?)')
          .run('fixture-link', id, linked, 'workflow_child', 'fixture', 'completed', 1, 1);
        value.prepare('INSERT INTO dwf_run(id,parent_session_id,status,caps_max_concurrency,time_created,time_updated,result_json) VALUES (?,?,?,?,?,?,?)')
          .run('fixture-run', id, 'completed', 1, 1, 1, '{"output":"database-deliverable"}');
        value.prepare('INSERT INTO dwf_event(run_id,sequence,type,payload_json,time_created) VALUES (?,?,?,?,?)')
          .run('fixture-run', 1, 'artifact-published', '{"artifact":{"id":"fixture","value":"retained"}}', 1);
      });
      expect(await inspectZCodeOwnedTree(nativeTarget)).toEqual(cascade);
      let preparation: ZCodeDeletionPreparation | undefined;
      const factory = () => new ZCodeClient({ cwd, launch, maintenance: true, delegationWorker: true }, {});
      const first = await deleteOwnedZCodeHistory(nativeTarget, { persistPrepared: async value => { preparation = value; }, persistMaintenanceState: async () => {} }, factory);
      expect(first).toMatchObject({ state: 'deleted' });
      expect(preparation!.targetHash).toBe(stableHistoryHash(nativeTarget));
      expect(fs.readFileSync(path.join(preparation!.artifacts.root.path, 'database-outputs.json'), 'utf8')).toContain('database-deliverable');
      expect(db(value => value.prepare('SELECT id FROM session ORDER BY id').all())).toEqual([{ id: unrelated! }]);
      for (const member of cascade) for (const kind of ['artifacts', 'exec', 'agents', 'sessions']) {
        expect(fs.existsSync(path.join(ns.storage.path, 'cli', kind, member))).toBe(false);
        expect(fs.readFileSync(path.join(preparation!.artifacts.root.path, kind, member, 'native-output.bin'))).toEqual(Buffer.from([0, 255, 1]));
      }
      expect(fs.readFileSync(sentinel, 'utf8')).toBe('unrelated');
      expect((await deleteOwnedZCodeHistory(nativeTarget, { prepared: preparation, persistMaintenanceState: async () => {} }, factory)).state).toBe('deleted');
    }, 45_000);
});
