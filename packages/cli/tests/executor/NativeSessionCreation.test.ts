import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
vi.mock('child_process', async original => ({ ...await original<typeof import('child_process')>(), spawn: vi.fn() }));
import { spawn } from 'child_process';
import { PiExecutor } from '../../src/executor/PiExecutor';
import { KimiExecutor } from '../../src/executor/KimiExecutor';
import { ClaudePersistentExecutor } from '../../src/executor/ClaudePersistentExecutor';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { buildPiRpcArgs, type PiLaunchOptions, type PiRpcResponse } from '../../src/executor/pi/PiTypes';
import { withKimiModes } from './kimiAcpFixture';
import type { NativeSessionDeletionTarget } from '../../src/delegation/NativeSessionDeletion';
import { verifyHistoryTarget } from '../../src/delegation/NativeHistoryFiles';

describe('managed executor native creation receipts', () => {
  let home: string;
  let targets: NativeSessionDeletionTarget[];
  let failure: ReturnType<typeof vi.fn>;
  const executors: Array<{ destroy(): Promise<void> }> = [];
  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-creation-')));
    vi.spyOn(os, 'homedir').mockReturnValue(home); vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('KIMI_CODE_HOME', path.join(home, 'kimi')); await fs.mkdir(path.join(home, 'kimi'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(home, 'claude-config')); vi.stubEnv('CLAUDE_CODE_PROJECT_DIR_NAME', 'fixture_project');
    targets = []; failure = vi.fn(async () => {});
    vi.mocked(spawn).mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    for (const executor of executors.splice(0)) await executor.destroy();
    vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(home, { recursive: true, force: true });
  });
  const observer = async (target: NativeSessionDeletionTarget) => { targets.push(structuredClone(target)); };
  function kimi(threadId = `delegate-lane-${randomUUID()}`) {
    const transport = {
      initialize: vi.fn(async () => ({ protocolVersion: 1, agentInfo: { version: '2.3.3' },
        agentCapabilities: { sessionCapabilities: { delete: {} } } })),
      newSession: vi.fn(async () => ({ sessionId: randomUUID(), configOptions: [] })),
      loadSession: vi.fn(async () => ({ configOptions: [] })), setConfigOption: vi.fn(async () => ({ configOptions: [] })),
      prompt: vi.fn(async (id: string) => { expect(targets.some(target => target.sessionId === id)).toBe(true); return { stopReason: 'end_turn' }; }),
      deleteSession: vi.fn(async () => {}), sendCancel: vi.fn(), destroy: vi.fn(),
      waitForExit: vi.fn(async () => {}), waitForManagedProcessGroupExit: vi.fn(async () => {}),
    };
    const executor = new KimiExecutor(new DirectoryGuard([home]), { threadId, delegationWorker: true, initialWorkingDirectory: home,
      sessionBaseDir: path.join(home, 'kimi-pointers'), clientFactory: () => withKimiModes(transport) });
    executor.observeNativeSessionCreation(observer, failure); executors.push(executor); return { executor, transport, threadId };
  }
  it('records Kimi creation before prompting, reuses it, and retains reset/fallback identities', async () => {
    const { executor, transport } = kimi();
    expect((await executor.execute('first')).success).toBe(true);
    expect((await executor.execute('second')).success).toBe(true);
    expect(targets).toHaveLength(1); expect(transport.newSession).toHaveBeenCalledOnce();
    executor.resetContext(); expect((await executor.execute('third')).success).toBe(true);
    expect(targets).toHaveLength(2); expect(targets[0].sessionId).not.toBe(targets[1].sessionId);
    await executor.deleteThreadData('unused'); expect(transport.deleteSession).not.toHaveBeenCalled();
  });
  it('does not label a Kimi loaded pointer as newly created', async () => {
    const lane = `delegate-lane-${randomUUID()}`; const pointerDir = path.join(home, 'kimi-pointers');
    await fs.mkdir(pointerDir); await fs.writeFile(path.join(pointerDir, `${lane}.json`), JSON.stringify({ id: randomUUID(), cwd: home }));
    const { executor, transport } = kimi(lane); transport.prompt.mockImplementation(async () => ({ stopReason: 'end_turn' }));
    await executor.execute('resume'); expect(transport.loadSession).toHaveBeenCalledOnce(); expect(targets).toHaveLength(0);
  });
  it('persists capture failure before allowing a Kimi prompt with an unaudited version', async () => {
    const { executor, transport } = kimi();
    transport.initialize.mockResolvedValue({ protocolVersion: 1, agentInfo: { version: '9.0.0' }, agentCapabilities: { sessionCapabilities: { delete: {} } } });
    transport.prompt.mockImplementation(async () => { expect(failure).toHaveBeenCalledOnce(); return { stopReason: 'end_turn' }; });
    expect((await executor.execute('safe continuation')).success).toBe(true); expect(targets).toHaveLength(0);
  });
  it('keeps simultaneous Kimi child identities independent', async () => {
    const first = kimi(); const second = kimi();
    await Promise.all([first.executor.execute('one'), second.executor.execute('two')]);
    expect(new Set(targets.map(target => target.executorThreadId)).size).toBe(2);
    expect(new Set(targets.map(target => target.sessionId)).size).toBe(2);
  });
  it('fences a Kimi creation whose reply arrives after reset and never dispatches its prompt', async () => {
    const { executor, transport } = kimi();
    let reply!: (value: { sessionId: string; configOptions: never[] }) => void;
    transport.newSession.mockImplementation(() => new Promise(resolve => { reply = resolve; }));
    const turn = executor.execute('cancelled');
    await vi.waitFor(() => expect(transport.newSession).toHaveBeenCalledOnce());
    await expect(executor.waitForManagedProcessGroupExit()).rejects.toThrow('coverage');
    executor.resetContext(); reply({ sessionId: randomUUID(), configOptions: [] }); await turn;
    expect(failure).toHaveBeenCalled(); expect(transport.prompt).not.toHaveBeenCalled();
  });
  it('does not prompt Kimi before its creation receipt can be persisted', async () => {
    const { executor, transport } = kimi();
    executor.observeNativeSessionCreation(async () => { throw new Error('synthetic receipt failure'); }, failure);
    expect((await executor.execute('blocked')).success).toBe(false); expect(transport.prompt).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledOnce();
  });
  it('withholds writer proof when neither creation nor coverage failure could be persisted', async () => {
    const { executor, transport } = kimi();
    executor.observeNativeSessionCreation(async () => { throw new Error('synthetic receipt failure'); },
      async () => { throw new Error('synthetic storage failure'); });
    expect((await executor.execute('blocked')).success).toBe(false);
    expect(transport.prompt).not.toHaveBeenCalled();
    await expect(executor.waitForManagedProcessGroupExit()).rejects.toThrow('coverage');
  });
  it('refuses a Kimi creation receipt when its root changed during session/new', async () => {
    const { executor, transport } = kimi();
    transport.newSession.mockImplementation(async () => {
      const root = path.join(home, 'kimi'); await fs.rename(root, root + '-old'); await fs.mkdir(root);
      return { sessionId: randomUUID(), configOptions: [] };
    });
    transport.prompt.mockResolvedValue({ stopReason: 'end_turn' });
    await executor.execute('first');
    expect(targets).toHaveLength(0); expect(failure).toHaveBeenCalled();
  });

  function pi() {
    let launch: PiLaunchOptions; let running = false;
    const events = new Set<(value: any) => void>();
    const state = () => ({ sessionId: launch.sessionId!, sessionFile: launch.sessionFile
      ?? path.join(launch.sessionDir!, `2026-01-01T00-00-00-000Z_${launch.sessionId}.jsonl`) });
    const request = vi.fn(async (command: Record<string, unknown>): Promise<PiRpcResponse> => {
      if (command.type === 'get_state') return { type: 'response', command: 'get_state', success: true, data: state() };
      if (command.type === 'prompt') {
        expect(targets.some(target => target.sessionId === state().sessionId)).toBe(true);
        await fs.writeFile(state().sessionFile, JSON.stringify({ type: 'session', version: 3, id: state().sessionId,
          cwd: home, timestamp: '2026-01-01T00:00:00.000Z' }) + '\n');
        for (const event of [{ type: 'agent_start' }, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'done' } },
          { type: 'agent_settled' }]) for (const handler of events) handler(event);
      }
      return { type: 'response', command: String(command.type), success: true };
    });
    const executor = new PiExecutor(new DirectoryGuard([home]), { threadId: `delegate-lane-${randomUUID()}`, delegationWorker: true,
      initialWorkingDirectory: home, sessionBaseDir: path.join(home, 'custom-pi'), clientFactory: options => {
        launch = options;
        return { start: async () => { running = true; }, stop: async () => { running = false; }, isRunning: () => running,
          request, send: () => {}, updateLaunch: partial => { launch = { ...launch, ...partial }; },
          onEvent: handler => { events.add(handler); return () => { events.delete(handler); }; },
          waitForExit: async () => {}, waitForManagedProcessGroupExit: async () => {} };
      } });
    executor.observeNativeSessionCreation(observer, failure); executors.push(executor);
    return { executor, request, launch: () => launch, state };
  }
  it('records lazy Pi history before its first prompt and retains history on managed reset', async () => {
    const { executor, state, launch } = pi();
    expect((await executor.execute('first')).success).toBe(true); const file = state().sessionFile;
    expect(targets).toHaveLength(1); expect(targets[0].backend).toBe('pi');
    expect((await executor.execute('second')).success).toBe(true); expect(targets).toHaveLength(1);
    if (targets[0].backend === 'pi') await verifyHistoryTarget(targets[0]);
    expect(launch().sessionDir).toContain('delegate-lane-');
    executor.resetContext(); expect((await executor.execute('third')).success).toBe(true);
    expect(targets).toHaveLength(2); expect((await fs.stat(file)).isFile()).toBe(true);
    await executor.deleteThreadData(targets[0].executorThreadId); expect((await fs.stat(file)).isFile()).toBe(true);
  });
  it('allocates independent Pi stores and preserves explicit --session-dir on resume', async () => {
    const first = pi(); const second = pi(); await Promise.all([first.executor.execute('one'), second.executor.execute('two')]);
    expect(first.launch().sessionDir).not.toBe(second.launch().sessionDir);
    const args = buildPiRpcArgs({ sessionDir: first.launch().sessionDir, sessionFile: first.state().sessionFile }).args;
    expect(args).toContain('--session'); expect(args).toContain('--session-dir'); expect(args).toContain(first.launch().sessionDir);
  });
  it('records independent Pi fork files created in its exclusive root even after the pointer moved', async () => {
    const { executor, launch } = pi(); await executor.execute('first');
    const id = randomUUID(); const file = path.join(launch().sessionDir!, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
    await fs.writeFile(file, JSON.stringify({ type: 'session', id, version: 3, cwd: home,
      timestamp: '2026-01-01T00:00:00.000Z', parentSession: targets[0].backend === 'pi' ? targets[0].transcript : undefined }) + '\n');
    await executor.execute('second'); expect(targets.map(value => value.sessionId)).toContain(id);
    expect(targets).toHaveLength(2); expect(failure).not.toHaveBeenCalled();
  });
  it('refuses a Pi creation receipt when its root changed before get_state returned', async () => {
    const { executor, request, launch, state } = pi();
    request.mockImplementationOnce(async () => {
      const root = launch().sessionDir!; await fs.rename(root, root + '-old'); await fs.mkdir(root);
      return { type: 'response', command: 'get_state', success: true, data: state() };
    });
    await (executor as any).ensureClient();
    expect(targets).toHaveLength(0); expect(failure).toHaveBeenCalled();
  });

  function claude(threadId = `delegate-lane-${randomUUID()}`) {
    const child = new EventEmitter() as any;
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.killed = false; child.exitCode = null; child.signalCode = null;
    child.kill = vi.fn(() => { child.killed = true; child.exitCode = 0; child.emit('exit', 0, null); child.emit('close', 0, null); return true; });
    child.stdin.on('finish', () => child.kill());
    vi.mocked(spawn).mockImplementation(() => { expect(targets).toHaveLength(1); return child; });
    const executor = new ClaudePersistentExecutor(new DirectoryGuard([home]), home, threadId,
      undefined, undefined, 'synthetic-claude', false, true);
    executor.observeNativeSessionCreation(observer, failure); executors.push(executor);
    return { executor, child };
  }
  it('durably reserves Claude identity before spawn and confirms the native init', async () => {
    const { executor } = claude(); await (executor as any).startProcess();
    const target = targets[0]; expect(target.backend).toBe('claude');
    if (target.backend !== 'claude') throw new Error('Unexpected fixture backend');
    expect(target.projectOverride).toBe('fixture_project'); expect(target.confirmed).toBeUndefined();
    expect(vi.mocked(spawn).mock.calls[0][1]).toContain(target.sessionId);
    const before = await fs.readFile(target.pointer, 'utf8');
    (executor as any).handleOutputLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: target.sessionId,
      cwd: home, claude_code_version: '2.1.308' }));
    await (executor as any).nativeObservation;
    expect(targets[1]).toEqual({ ...target, confirmed: true }); expect(await fs.readFile(target.pointer, 'utf8')).toBe(before);
    if (targets[1].backend === 'claude') await verifyHistoryTarget(targets[1]);
    await executor.deleteThreadData(target.executorThreadId); expect((await fs.stat(target.pointer)).isFile()).toBe(true);
  });
  it('holds a mismatched Claude native init and drains its durable observation before exit proof', async () => {
    const { executor } = claude(); await (executor as any).startProcess();
    (executor as any).handleOutputLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: targets[0].sessionId,
      cwd: home, claude_code_version: '9.0.0' }));
    const proof = vi.spyOn((executor as any).workerGroups, 'waitForExit').mockImplementation(async () => { expect(failure).toHaveBeenCalledOnce(); });
    await executor.waitForManagedProcessGroupExit(); expect(proof).toHaveBeenCalledOnce(); expect(targets).toHaveLength(1);
  });
  it('never records a pre-existing Claude pointer as a native creation', async () => {
    const threadId = `delegate-lane-${randomUUID()}`; const pointers = path.join(home, '.remote-cli', 'claude-sessions');
    await fs.mkdir(pointers, { recursive: true }); const id = randomUUID();
    await fs.writeFile(path.join(pointers, `${threadId}.json`), JSON.stringify({ id }));
    const { executor, child } = claude(threadId); vi.mocked(spawn).mockImplementation(() => child);
    await (executor as any).startProcess(); expect(targets).toHaveLength(0);
    expect(vi.mocked(spawn).mock.calls.at(-1)?.[1]).toContain('--resume');
  });
  it('ignores Claude project override without an explicit config root, matching native layout', async () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    const { executor } = claude(); await (executor as any).startProcess();
    const target = targets[0]; if (target.backend !== 'claude') throw new Error('Unexpected fixture backend');
    expect(target.projectOverride).toBeUndefined(); expect(target.nativeHome.path).toBe(path.join(home, '.claude'));
    expect(target.scope.path).not.toContain('fixture_project');
  });
  it('resolves an explicitly empty Claude config root against the native working directory', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    const { executor } = claude(); await (executor as any).startProcess();
    const target = targets[0]; if (target.backend !== 'claude') throw new Error('Unexpected fixture backend');
    expect(target.projectOverride).toBeUndefined(); expect(target.nativeHome.path).toBe(home);
  });
  it('does not spawn Claude after reset raced a pending durable creation receipt', async () => {
    const { executor } = claude(); let release!: () => void;
    const observed = vi.fn(async (target: NativeSessionDeletionTarget) => {
      await new Promise<void>(resolve => { release = resolve; }); await observer(target);
    });
    executor.observeNativeSessionCreation(observed, failure);
    const start = (executor as any).startProcess(); const rejected = expect(start).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(observed).toHaveBeenCalledOnce()); executor.resetContext(); release();
    await rejected; expect(spawn).not.toHaveBeenCalled();
  });
});
