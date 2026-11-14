/** Regression coverage for process-stop abort and owned cleanup.
 * No native process, network listener, model, or real native schedule is started.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { spawn } from 'child_process';

vi.mock('child_process', () => {
  const denied = () => { throw new Error('Probe forbids child processes'); };
  return { spawn: vi.fn(denied), exec: denied, execFile: denied, execSync: denied,
    execFileSync: denied, spawnSync: denied, fork: denied, default: { spawn: denied, exec: denied, execFile: denied } };
});

import { ClaudePersistentExecutor } from '../src/executor/ClaudePersistentExecutor';
import { DirectoryGuard } from '../src/security/DirectoryGuard';
import { MessageHandler } from '../src/client/MessageHandler';
import { ThreadContextReset } from '../src/thread/ThreadContextReset';
import { ManagedToolBridge } from '../src/managed/ManagedToolBridge';
import { ClaudeSessionSchedules, SCHEDULE_HOOK } from '../src/scheduling/claude/ClaudeSessionSchedules';
import { ScheduleService } from '../src/scheduling/ScheduleService';
import { claudeCodeHooks } from '../src/hooks/ClaudeCodeHooks';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
let root: string;
const filesystemPlatform = process.platform;
const nativeFsync = syncFs.fsyncSync;
let persistencePlatforms: NodeJS.Platform[];
let executors: ClaudePersistentExecutor[];
let handlers: MessageHandler[];
beforeEach(async () => {
  persistencePlatforms = [];
  // Observe actual fsync calls without weakening the filesystem durability checks.
  vi.spyOn(syncFs, 'fsyncSync').mockImplementation(fd => {
    persistencePlatforms.push(process.platform);
    return nativeFsync(fd);
  });
  vi.mocked(spawn).mockReset().mockImplementation(() => { throw new Error('Probe forbids child processes'); });
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'abort-framework-probe-')));
  vi.spyOn(os, 'homedir').mockReturnValue(root);
  for (const name of ['HOME', 'USERPROFILE']) vi.stubEnv(name, root);
  vi.stubGlobal('fetch', () => { throw new Error('Probe forbids network fetch'); });
  vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(() => { throw new Error('Probe forbids network connections'); });
  vi.spyOn(net.Server.prototype, 'listen').mockImplementation(() => { throw new Error('Probe forbids network listeners'); });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  executors = []; handlers = [];
});
afterEach(async () => {
  const teardownPlatform = process.platform;
  for (const handler of handlers) await handler.destroy();
  for (const executor of executors) {
    const raw = executor as any;
    raw.sessionSchedules?.processClosed(); raw.claudeProcess = null;
    // Settle fixture waiters even if an assertion interrupted normal teardown.
    raw.cancelInputWaiters();
    await executor.destroy();
  }
  vi.clearAllTimers(); vi.useRealTimers();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  await fs.rm(root, { recursive: true, force: true });
  expect(teardownPlatform).toBe(filesystemPlatform);
  expect(persistencePlatforms.filter(platform => platform !== filesystemPlatform)).toEqual([]);
});
function executor() {
  const value = new ClaudePersistentExecutor(new DirectoryGuard([root]), root, 'synthetic-thread',
    undefined, undefined, 'forbidden-native-executable', false);
  executors.push(value);
  return value;
}
function fakePipe(raw: any) {
  const frames: any[] = [];
  const child: any = new EventEmitter();
  child.stdin = { writable: true, write: vi.fn((line: string) => { frames.push(JSON.parse(line)); return true; }),
    end: vi.fn(() => queueMicrotask(() => child.emit('close', 0))) };
  child.kill = vi.fn();
  raw.claudeProcess = child;
  return { frames, child };
}
function nativePipe() {
  const pipe = fakePipe({});
  pipe.child.stdout = new EventEmitter(); pipe.child.stderr = new EventEmitter();
  vi.mocked(spawn).mockReturnValueOnce(pipe.child);
  return pipe;
}
function makeHandler(main: any) {
  let busy = false;
  const thread = { id: 'thread', name: 'Synthetic thread', workingDirectory: root, delegation: false };
  const pool: any = { getExecutor: () => main, getExistingExecutor: () => main,
    isThreadBusy: () => busy, setThreadBusy: (_id: string, value: boolean) => { busy = value; },
    setThreadError: vi.fn(), getSummaries: () => [], getBackendKey: () => 'claude', destroyAll: vi.fn(async () => {}) };
  const threads: any = { getThread: () => thread, getDefaultThread: () => thread, listThreads: () => [thread],
    updateThread: vi.fn(async () => {}), contextResets: new ThreadContextReset(path.join(root, 'resets')) };
  const ws: any = { isConnected: () => true, send: vi.fn(() => true), trackTask: vi.fn(), hasPendingTaskResults: () => false };
  const config: any = { get: () => undefined, getConfigDir: () => path.join(root, 'config'), getSharedSymlinks: () => [] };
  const handler = new MessageHandler(ws, pool, threads, new DirectoryGuard([root]), config);
  handlers.push(handler);
  const raw = handler as any;
  vi.spyOn(raw.delegation, 'assertExecutionSafe').mockResolvedValue(undefined);
  vi.spyOn(raw.delegation, 'cancelThread').mockResolvedValue(undefined);
  return { handler, raw, ws, pool };
}

describe('Claude abort cleanup ownership', () => {
  it.each(['delayed-close', 'unconfirmed-close'] as const)(
    'reset retains captured-child admission until %s settles, then permits a fresh context', async mode => {
      vi.useFakeTimers();
      const native = executor();
      const first = nativePipe();
      const warmup = native.execute('Synthetic pre-reset turn');
      await vi.advanceTimersByTimeAsync(1000);
      first.child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'synthetic-old-session' }) + '\n'));
      first.child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', is_error: false, result: 'Synthetic result' }) + '\n'));
      expect((await warmup).success).toBe(true);
      first.child.stdin.end.mockImplementation(() => {});
      native.resetContext();
      expect(native.getSessionId()).toBeNull();
      expect(native.hasUncertainShutdown()).toBe(true);
      const blocked = await native.execute('Must not dispatch while reset is stopping');
      expect(blocked).toEqual({ success: false, error: 'Native cleanup is still pending. Retry after cleanup.' });
      expect(spawn).toHaveBeenCalledOnce();
      expect(first.frames.filter(frame => frame.type === 'user')).toHaveLength(1);

      if (mode === 'unconfirmed-close') {
        await vi.advanceTimersByTimeAsync(9001);
        expect(native.hasUncertainShutdown()).toBe(true);
        expect((await native.execute('Must not replace an unconfirmed child')).success).toBe(false);
        expect(spawn).toHaveBeenCalledOnce();
        expect(first.child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
        // Retry joins the same owned host; a signal or elapsed deadline did not release it.
        first.child.stdin.end.mockImplementation(() => queueMicrotask(() => first.child.emit('close', 0)));
        const retry = native.abort();
        await vi.advanceTimersByTimeAsync(0);
        expect(await retry).toBe(true);
      } else {
        await vi.advanceTimersByTimeAsync(4000);
        expect(spawn).toHaveBeenCalledOnce();
        expect(first.child.kill).not.toHaveBeenCalled();
        first.child.emit('close', 0);
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(native.hasUncertainShutdown()).toBe(false);
      const second = nativePipe();
      const fresh = native.execute('Synthetic fresh context');
      await vi.advanceTimersByTimeAsync(1000);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(vi.mocked(spawn).mock.calls[1][1]).not.toContain('--resume');
      expect(second.frames.filter(frame => frame.type === 'user').map(frame => frame.message.content)).toEqual(['Synthetic fresh context']);
      // A duplicate old close cannot retire the replacement host or finish its turn.
      first.child.emit('close', 0);
      expect(native.isBusy()).toBe(true);
      second.child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', is_error: false, result: 'Synthetic fresh result' }) + '\n'));
      expect((await fresh).success).toBe(true);
      expect(native.isBusy()).toBe(false);
    });

  it('review: rejects sandbox mutation during public catalog startup before changing settings or stopping', async () => {
    const native = executor(), raw = native as any;
    const entered = deferred(), release = deferred();
    vi.spyOn(raw.sandbox, 'isRestricted').mockReturnValue(true);
    vi.spyOn(raw.sandbox, 'assertAvailable').mockImplementation(() => {});
    vi.spyOn(raw.sandbox, 'spawnSettings').mockReturnValue({});
    vi.spyOn(raw, 'ensureApprovalServer').mockImplementation(async () => {
      entered.resolve(); await release.promise; return path.join(root, 'synthetic-endpoint');
    });
    const configure = vi.spyOn(raw.sandbox, 'configure');
    const stop = vi.spyOn(raw, 'stopProcess');
    const catalog = native.listModels().catch(error => error);
    await entered.promise;
    const result = await native.configureSandbox('off');
    const mutations = configure.mock.calls.length, stops = stop.mock.calls.length;
    const destroyed = native.destroy(); release.resolve(); await destroyed; await catalog;
    expect(result.success).toBe(false); expect(mutations).toBe(0); expect(stops).toBe(0);
  });

  it('review: sandbox rejects uncertain abort without mutation or another stop, then accepts a confirmed retry', async () => {
    vi.useFakeTimers();
    const native = executor(), raw = native as any;
    const { child } = nativePipe();
    const running = native.execute('Synthetic foreground').catch(error => error);
    await vi.advanceTimersByTimeAsync(1000);
    child.stdin.end.mockImplementation(() => {});
    const failure = expect(native.abort()).rejects.toThrow('exit could not be confirmed');
    await vi.advanceTimersByTimeAsync(9001); await failure; await running;
    const configure = vi.spyOn(raw.sandbox, 'configure');
    const stops = child.stdin.end.mock.calls.length;
    const changing = native.configureSandbox('off');
    const mutations = configure.mock.calls.length, extraStops = child.stdin.end.mock.calls.length - stops;
    await vi.advanceTimersByTimeAsync(9001);
    const rejected = await changing;
    child.stdin.end.mockImplementation(() => queueMicrotask(() => child.emit('close', 0)));
    expect(await native.abort()).toBe(true);
    expect((await native.configureSandbox('off')).success).toBe(true);
    expect(rejected.success).toBe(false); expect(mutations).toBe(0); expect(extraStops).toBe(0);
  });

  it('review: overlapping reset and destruction join one captured-child stop', async () => {
    vi.useFakeTimers();
    const native = executor(), raw = native as any;
    const { child } = nativePipe();
    const start = raw.startProcess(); await vi.advanceTimersByTimeAsync(1000); await start;
    child.stdin.end.mockImplementation(() => {});
    native.resetContext(); const destruction = native.destroy();
    await vi.advanceTimersByTimeAsync(0);
    const ends = child.stdin.end.mock.calls.length;
    child.emit('close', 0); await destruction;
    expect(ends).toBe(1); expect(raw.claudeProcess).toBeNull();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('review: a close callback cannot admit a replacement before its reset stop settles', async () => {
    vi.useFakeTimers();
    const native = executor(), raw = native as any;
    const first = nativePipe(); const start = raw.startProcess();
    await vi.advanceTimersByTimeAsync(1000); await start;
    const second = nativePipe();
    let successor!: Promise<any>;
    native.once('processExit', () => { successor = native.execute('Successor during close'); });
    native.resetContext(); await vi.advanceTimersByTimeAsync(1001);
    raw.handleOutputLine(JSON.stringify({ type: 'result', is_error: false, result: 'Synthetic result' }));
    const result = await successor;
    expect(result.success).toBe(false); expect(spawn).toHaveBeenCalledOnce();
    expect(second.frames).toHaveLength(0); expect(first.child.stdin.end).toHaveBeenCalledOnce();
    const accepted = native.execute('Successor after stop');
    await vi.advanceTimersByTimeAsync(1000);
    first.child.emit('close', 0);
    expect(raw.claudeProcess).toBe(second.child); expect(raw.isProcessing).toBe(true);
    raw.handleOutputLine(JSON.stringify({ type: 'result', is_error: false, result: 'Synthetic successor result' }));
    expect((await accepted).success).toBe(true);
  });

  it('review: destroy joins already-spawned startup and leaves no late startup listeners or timers', async () => {
    vi.useFakeTimers();
    const native = executor(), raw = native as any;
    const { child } = nativePipe();
    const start = raw.startProcess().catch((error: Error) => error);
    let finished = false;
    const destroying = native.destroy().then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(0);
    const earlyFinish = finished;
    await vi.advanceTimersByTimeAsync(1001); await start; await destroying;
    expect(earlyFinish).toBe(false); expect(raw.startup).toBeUndefined();
    expect(child.listenerCount('error')).toBe(0); expect(vi.getTimerCount()).toBe(0);
    expect(raw.claudeProcess).toBeNull();
  });

  it.each(['reset', 'destroy-timeout'] as const)('review: %s fences unpublished startup without forgetting its ownership', async mode => {
    vi.useFakeTimers();
    const native = executor(), raw = native as any;
    const entered = deferred(), release = deferred();
    vi.spyOn(raw.sandbox, 'isRestricted').mockReturnValue(true);
    vi.spyOn(raw.sandbox, 'assertAvailable').mockImplementation(() => {});
    vi.spyOn(raw.sandbox, 'spawnSettings').mockReturnValue({});
    vi.spyOn(raw, 'ensureApprovalServer').mockImplementation(async () => {
      entered.resolve(); await release.promise; return path.join(root, 'synthetic-endpoint');
    });
    const starting = native.listModels().catch(error => error);
    await entered.promise;
    if (mode === 'reset') {
      native.resetContext(); await vi.advanceTimersByTimeAsync(0);
    } else {
      const destruction = native.destroy();
      expect(native.destroy()).toBe(destruction);
      const failure = expect(destruction).rejects.toThrow('startup destruction could not be confirmed');
      await vi.advanceTimersByTimeAsync(10001); await failure;
      expect(native.hasUncertainShutdown()).toBe(true);
      expect(raw.startup).toBeDefined();
      expect((await native.execute('Must remain blocked')).success).toBe(false);
    }
    release.resolve();
    expect((await starting).message).toContain('cancelled before process creation');
    await native.destroy();
    expect(raw.startup).toBeUndefined(); expect(spawn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a delayed old finalizer cannot retire a newer bridge activation', async () => {
    const enteredA = deferred(), enteredB = deferred(), returnedA = deferred(), finishB = deferred();
    const drainA = deferred(), drainingA = deferred();
    const main: any = { getCurrentWorkingDirectory: () => root,
      configureManagedTools: vi.fn(async () => {}),
      execute: vi.fn().mockImplementationOnce(async () => { enteredA.resolve(); await returnedA.promise; return { success: false }; })
        .mockImplementationOnce(async () => { enteredB.resolve(); await finishB.promise; return { success: true }; }),
      abort: vi.fn(async () => { returnedA.resolve(); return true; }) };
    const f = makeHandler(main);
    const bridge = new ManagedToolBridge();
    // Avoid sockets entirely; production activate/handler ownership is unchanged.
    vi.spyOn(bridge, 'start').mockResolvedValue({ url: 'http://127.0.0.1:1/', token: 'synthetic', groups: ['scheduling'] });
    f.raw.delegationBridges.set('thread', bridge);
    f.raw.messageOpenIds.set('a', 'synthetic-owner'); f.raw.messageOpenIds.set('b', 'synthetic-owner');
    const scopeA = { hasSideEffects: true, drain: async () => { drainingA.resolve(); await drainA.promise; },
      close: vi.fn(async () => {}), invoke: vi.fn(), unreportedFailures: () => [] };
    const scopeB = { hasSideEffects: false, drain: vi.fn(async () => {}), close: vi.fn(async () => {}),
      invoke: vi.fn(async () => ({ status: 'synthetic-b' })), unreportedFailures: () => [] };
    vi.spyOn(f.raw.scheduleToolOperations, 'scope').mockReturnValueOnce(scopeA).mockReturnValueOnce(scopeB);
    // Retain this fixture endpoint to exercise delayed finalizers against a newer lease.
    // Production abort still closes its endpoint, covered separately below.
    vi.spyOn(f.raw, 'detachDelegationBridge').mockImplementation(() => {});
    f.raw.beginThreadOperation('thread', 'a', true);
    const a = f.raw.executeCommand('a', 'thread', 'Synthetic A', main);
    await enteredA.promise;
    await f.raw.handleAbortCommand('abort', 'thread', main);
    await drainingA.promise;
    expect(f.raw.abortOperations.size).toBe(0);
    expect(f.pool.isThreadBusy('thread')).toBe(false);
    f.raw.beginThreadOperation('thread', 'b', true);
    const b = f.raw.executeCommand('b', 'thread', 'Synthetic B', main);
    await enteredB.promise;
    const activeB = (bridge as any).handler;
    expect(typeof activeB).toBe('function');
    expect(await activeB('remote_cli_schedule_list', {}, 'synthetic-call')).toEqual({ status: 'synthetic-b' });
    drainA.resolve(); await a;
    expect((bridge as any).handler).toBe(activeB);
    expect(await activeB('remote_cli_schedule_list', {}, 'second-call')).toEqual({ status: 'synthetic-b' });
    expect(f.pool.isThreadBusy('thread')).toBe(true);
    expect(scopeB.close).not.toHaveBeenCalled();
    expect(main.configureManagedTools).toHaveBeenCalledTimes(2);
    finishB.resolve(); await b;
    f.raw.finishThreadOperation('thread', f.raw.activeThreadOperations.get('thread').token);
  });

  it('explicit bridge replacement still stops Claude while equal registration does not', async () => {
    const native = executor(), raw = native as any;
    const stop = vi.spyOn(raw, 'stopProcess').mockResolvedValue(undefined);
    const first = { url: 'http://127.0.0.1:1/', token: 'synthetic-a', groups: ['scheduling'] as const };
    await native.configureManagedTools(first); stop.mockClear();
    await native.configureManagedTools({ ...first }); expect(stop).not.toHaveBeenCalled();
    const f = makeHandler(native), bridge = new ManagedToolBridge();
    const close = vi.spyOn(bridge, 'close');
    f.raw.delegationBridges.set('thread', bridge);
    f.raw.detachDelegationBridge('thread');
    expect(f.raw.delegationBridges.has('thread')).toBe(false); expect(close).toHaveBeenCalledOnce();
    await native.configureManagedTools({ ...first, token: 'synthetic-b' });
    expect(stop).toHaveBeenCalledOnce();
  });

  it('abort settles old input waiters without changing the next waiting turn', async () => {
    vi.useFakeTimers();
    const native = executor(), raw = native as any;
    raw.isProcessing = true;
    const oldWait = raw.requestInteractiveInput('Synthetic input A');
    expect(vi.getTimerCount()).toBe(1);
    // No child exists: production abort/reset executes, stopProcess returns without signals.
    expect(await native.abort()).toBe(true);
    expect(raw.inputWaiters.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(await oldWait).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    raw.isProcessing = true;
    const newWait = raw.requestInteractiveInput('Synthetic input B');
    expect(native.isWaitingInput()).toBe(true);
    await vi.advanceTimersByTimeAsync(299000);
    expect(await oldWait).toBeNull();
    expect(vi.getTimerCount()).toBe(1);
    expect(native.isWaitingInput()).toBe(true);
    fakePipe(raw);
    expect(native.sendInput('Synthetic B reply')).toBe(true);
    expect(await newWait).toBe('Synthetic B reply');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('abort fences unpublished startup and clears only the captured queue before admitting fresh work', async () => {
    const native = executor(), raw = native as any;
    const entered = deferred(), release = deferred(), dispatched = deferred();
    let pipe: ReturnType<typeof fakePipe>;
    vi.spyOn(raw, 'startProcessImpl').mockImplementation(async () => {
      raw.isStarting = true; entered.resolve(); await release.promise;
      pipe = fakePipe(raw); raw.isStarting = false;
      await raw.processQueue(); dispatched.resolve();
    });
    const task = native.execute('Synthetic queued A').catch(error => error);
    await entered.promise;
    expect(native.isBusy()).toBe(true); expect(raw.commandQueue).toHaveLength(1);
    const abort = native.abort();
    expect(native.abort()).toBe(abort);
    await Promise.resolve();
    expect(raw.commandQueue).toHaveLength(0);
    expect((await task).message).toContain('aborted');
    expect((await native.execute('During abort')).success).toBe(false);
    release.resolve(); await dispatched.promise;
    expect(await abort).toBe(true);
    expect(pipe!.frames).toHaveLength(0);
    expect(pipe!.child.stdin.end).toHaveBeenCalledOnce();
    fakePipe(raw);
    const fresh = native.execute('Synthetic new B');
    raw.handleOutputLine(JSON.stringify({ type: 'result', is_error: false, result: 'Synthetic terminal' }));
    expect((await fresh).success).toBe(true);
  });

  it('cancels real startup before spawn after delayed approval-channel setup', async () => {
    const native = executor(), raw = native as any;
    const entered = deferred(), release = deferred();
    vi.spyOn(raw.sandbox, 'isRestricted').mockReturnValue(true);
    vi.spyOn(raw.sandbox, 'assertAvailable').mockImplementation(() => {});
    vi.spyOn(raw.sandbox, 'spawnSettings').mockReturnValue({});
    vi.spyOn(raw, 'ensureApprovalServer').mockImplementation(async () => {
      entered.resolve(); await release.promise;
      return path.join(root, 'synthetic-approval-endpoint');
    });
    const task = native.execute('Cancelled before spawn').catch(error => error);
    await entered.promise;
    const startup = raw.startup;
    const abort = native.abort();
    await Promise.resolve(); release.resolve();
    expect(await abort).toBe(true);
    await expect(startup).rejects.toThrow('cancelled before process creation');
    expect((await task).message).toContain('aborted');
    expect(raw.claudeProcess).toBeNull();
    expect(raw.commandQueue).toHaveLength(0);
    expect(native.isBusy()).toBe(false);
  });

  it('retains a startup timeout fence until late startup settles and explicit stop confirms exit', async () => {
    vi.useFakeTimers();
    const native = executor(), raw = native as any;
    const entered = deferred(), release = deferred(), settled = deferred();
    let pipe: ReturnType<typeof fakePipe>;
    vi.spyOn(raw, 'startProcessImpl').mockImplementation(async () => {
      raw.isStarting = true; entered.resolve(); await release.promise;
      pipe = fakePipe(raw); raw.isStarting = false;
      await raw.processQueue(); settled.resolve();
    });
    const task = native.execute('Old queued prompt').catch(error => error);
    await entered.promise;
    const failed = expect(native.abort()).rejects.toThrow('startup cancellation could not be confirmed');
    await vi.advanceTimersByTimeAsync(10001); await failed;
    expect((await task).message).toContain('aborted');
    expect(native.hasUncertainShutdown()).toBe(true);
    expect((await native.execute('Blocked before startup settles')).success).toBe(false);
    release.resolve(); await settled.promise;
    expect(pipe!.frames).toHaveLength(0);
    expect(native.isBusy()).toBe(true);
    expect(await native.abort()).toBe(true);
    expect(pipe!.child.stdin.end).toHaveBeenCalledOnce();
    expect(native.isBusy()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['reset', 'destroy'] as const)('%s settles input waits and prevents late continuations changing another turn', async action => {
    vi.useFakeTimers();
    const native = executor(), raw = native as any;
    raw.isProcessing = true;
    const old = raw.handleInputRequest('Synthetic confirmation');
    raw.inputDetectionTimer = setTimeout(() => { throw new Error('Retired input detector fired'); }, 1000);
    if (action === 'reset') native.resetContext(); else await native.destroy();
    raw.isWaitingForInput = true;
    await old;
    expect(raw.isWaitingForInput).toBe(true);
    expect(raw.inputWaiters.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains an uncertain child, rejects new work and settings, and retries explicit abort with close evidence', async () => {
    vi.useFakeTimers();
    const native = executor(), raw = native as any;
    const { child, frames } = fakePipe(raw);
    child.stdin.end.mockImplementation(() => {});
    raw.isProcessing = true;
    const abort = native.abort();
    const failed = expect(abort).rejects.toThrow('exit could not be confirmed');
    await vi.advanceTimersByTimeAsync(9001); await failed;
    expect(native.hasUncertainShutdown()).toBe(true);
    expect(native.isBusy()).toBe(true);
    expect(raw.claudeProcess).toBe(child);
    expect((await native.execute('Must not dispatch')).success).toBe(false);
    expect((await native.setModel('synthetic-model')).success).toBe(false);
    expect(frames).toHaveLength(0);
    child.stdin.end.mockImplementation(() => queueMicrotask(() => child.emit('close', 0)));
    expect(await native.abort()).toBe(true);
    expect(native.hasUncertainShutdown()).toBe(false);
    expect(raw.claudeProcess).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps autonomous-only abort idle and never starts a host for expired native management', async () => {
    const native = executor(), raw = native as any;
    const stop = vi.spyOn(raw, 'stopProcess');
    raw.sessionSchedules = { busy: true, processClosed: vi.fn() };
    expect(await native.abort()).toBe(false); expect(stop).not.toHaveBeenCalled();
    raw.sessionSchedules = undefined;
    const start = vi.spyOn(raw, 'startProcess');
    expect((await native.execute('Expired cleanup', { nativeScheduleManagement: true, nativeScheduleCurrent: () => false })).success).toBe(false);
    expect(start).not.toHaveBeenCalled();
    const cleanup = vi.fn(async () => 'already closed');
    expect(await native.reconcileNativeSchedule('retired', () => true, cleanup)).toBe('already closed');
    expect(start).not.toHaveBeenCalled();
  });

  it('refuses cleanup during shutdown, successor work or changed generation without invoking its callback', async () => {
    const native = executor(), raw = native as any;
    fakePipe(raw);
    const run = vi.fn(async () => {});
    raw.isStopping = true;
    await expect(native.reconcileNativeSchedule('job', () => true, run)).rejects.toThrow('cleanup is pending');
    raw.isStopping = false; raw.isProcessing = true;
    await expect(native.reconcileNativeSchedule('job', () => true, run)).rejects.toThrow('cleanup is pending');
    raw.isProcessing = false;
    await expect(native.reconcileNativeSchedule('job', () => false, run)).rejects.toThrow('cleanup is pending');
    expect(run).not.toHaveBeenCalled();
  });

  it('late accepted CREATE retains retryable ownership while busy and recovers under a fresh cleanup scope', async () => {
    const adapter = new ClaudeSessionSchedules({ send: vi.fn(), manage: vi.fn(async () => {
      adapter.foregroundDispatched('cleanup-message', true); return { success: true }; }),
      wake: vi.fn(), timezone: 'UTC', timeoutMs: 1000 });
    adapter.accept({ type: 'system', subtype: 'init', tools: ['CronCreate', 'CronList', 'CronDelete'],
      capabilities: ['msg_lifecycle_v1', 'lifecycle_wakeup_source_v1'] });
    let current = true;
    const reserved = deferred();
    const events = vi.fn();
    let handle: any;
    const main = executor(), raw = main as any;
    fakePipe(raw); raw.sessionSchedules = adapter; raw.scheduleHooksReady = true;
    const f = makeHandler(main);
    const service = new ScheduleService({ directory: path.join(root, 'catalog'), isOwnerCurrent: () => true,
      deliver: async () => {}, provider: { create: async (input, emit) => {
        const promise = adapter.create(input, event => { events(event); emit(event); }, () => true, 'UTC');
        reserved.resolve(); handle = await promise; return handle;
      } } });
    await service.initialize(); f.raw.schedules = service;
    vi.spyOn(f.raw, 'initializeSchedules').mockResolvedValue(service);
    f.raw.scheduleResultsSupported = true;
    const owner = { threadId: 'thread', openId: 'synthetic-owner', generation: f.raw.scheduleGeneration('thread') };
    const context = { current: () => current, backend: 'claude', config: { type: 'auto' }, cwd: root };
    const creating = f.raw.runScheduleOperation(owner, { kind: 'create', prompt: 'Synthetic reminder',
      rule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' } }, 'managed-probe', context);
    const outcome = creating.then(() => 'unexpected success', (error: Error) => error.message);
    await reserved.promise;
    const action = adapter.action('managed-probe')!;
    expect(action.tool).toBe('CronCreate');
    adapter.accept({ type: 'control_request', request_id: 'synthetic-hook', request: {
      subtype: 'hook_callback', callback_id: SCHEDULE_HOOK, tool_use_id: 'synthetic-create',
      input: { hook_event_name: 'PreToolUse', tool_name: action.tool, tool_input: action.input } } });
    expect((adapter as any).authorized.size).toBe(1);
    current = false; raw.isProcessing = true;
    adapter.accept({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'synthetic-create',
      content: 'Scheduled recurring job native-probe (every minute). Next run: later. Session-only (not written to disk, dies when Claude exits).', is_error: false }] } });
    expect(await outcome).toContain('cleanup is pending');
    const records = await service.list(owner);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: 'managed-probe', nativeId: 'native-probe', state: 'active' });
    expect(records[0].error).toContain('cleanup is pending');
    expect(adapter.hasJobs).toBe(true);
    expect((adapter as any).pending).toBeUndefined();
    expect(f.ws.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'schedule_tool_card' }));
    // Prove a fresh owner-bound scope can recover the same handle without recreating the job.
    raw.isProcessing = false;
    const recovered = main.reconcileNativeSchedule('cleanup-probe', () => true, () => service.cancel(owner, 'managed-probe'));
    // Cancellation intent must reach durable storage before native deletion.
    await vi.waitFor(() => expect((adapter as any).pending).toBeDefined());
    const deletion = (adapter as any).pending.action;
    expect(deletion).toEqual({ tool: 'CronDelete', input: { id: 'native-probe' } });
    adapter.accept({ type: 'control_request', request_id: 'synthetic-delete-hook', request: {
      subtype: 'hook_callback', callback_id: SCHEDULE_HOOK, tool_use_id: 'synthetic-delete',
      input: { hook_event_name: 'PreToolUse', tool_name: deletion.tool, tool_input: deletion.input } } });
    adapter.accept({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'synthetic-delete',
      content: 'Cancelled job native-probe.', is_error: false }] } });
    expect((await recovered).state).toBe('cancelled');
    expect(adapter.hasJobs).toBe(false);
    expect(handle.nativeId).toBe('native-probe');
    await service.destroy(); adapter.processClosed(); raw.sessionSchedules = undefined;
  });

  it.each(['closed', 'successor'] as const)('review: late CREATE persistence after %s preserves confirmed close without a cleanup prompt', async state => {
    vi.useFakeTimers();
    const main = executor(), raw = main as any;
    const first = nativePipe(); const startup = raw.startProcess();
    await vi.advanceTimersByTimeAsync(1000); await startup;
    const adapter: ClaudeSessionSchedules = raw.schedules(); raw.scheduleHooksReady = true;
    const frame = (value: object) => raw.handleOutputLine(JSON.stringify(value));
    frame({ type: 'system', subtype: 'init', session_id: 'synthetic-session',
      tools: ['CronCreate', 'CronList', 'CronDelete'], capabilities: ['msg_lifecycle_v1', 'lifecycle_wakeup_source_v1'] });
    const foreground = main.execute('Create synthetic reminder').catch(error => error);
    const f = makeHandler(main), reserved = deferred(), persisting = deferred(), release = deferred();
    let current = true, handle: any, held = false;
    const service = new ScheduleService({ directory: path.join(root, 'late-catalog'), isOwnerCurrent: () => true,
      deliver: async () => {}, provider: { create: async (input, emit) => {
        const pending = adapter.create(input, emit, () => true, 'UTC'); reserved.resolve();
        handle = await pending; return handle;
      } } });
    await service.initialize(); f.raw.schedules = service;
    const originalPersist = (service as any).persist.bind(service);
    vi.spyOn(service as any, 'persist').mockImplementation(async () => {
      if (handle && !held) { held = true; persisting.resolve(); await release.promise; }
      await originalPersist();
    });
    vi.spyOn(f.raw, 'initializeSchedules').mockResolvedValue(service); f.raw.scheduleResultsSupported = true;
    const owner = { threadId: 'thread', openId: 'synthetic-owner', generation: f.raw.scheduleGeneration('thread') };
    const creating = f.raw.runScheduleOperation(owner, { kind: 'create', prompt: 'Synthetic reminder',
      rule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' } }, 'late-create',
      { current: () => current, backend: 'claude', config: { type: 'auto' }, cwd: root });
    const outcome = creating.catch((error: Error) => error);
    await reserved.promise;
    const action = adapter.action('late-create')!;
    frame({ type: 'control_request', request_id: 'create-hook', request: { subtype: 'hook_callback', callback_id: SCHEDULE_HOOK,
      tool_use_id: 'create-tool', input: { hook_event_name: 'PreToolUse', tool_name: action.tool, tool_input: action.input } } });
    frame({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'create-tool', is_error: false,
      content: 'Scheduled recurring job native-late (every minute). Next run: later. Session-only (not written to disk, dies when Claude exits).' }] } });
    await persisting.promise; current = false;
    expect(await main.abort()).toBe(true); await foreground;
    expect(adapter.hasJobs).toBe(false);
    let second: ReturnType<typeof nativePipe> | undefined, successor: Promise<any> | undefined;
    if (state === 'successor') {
      second = nativePipe(); successor = main.execute('Successor foreground');
      await vi.advanceTimersByTimeAsync(1000);
    }
    release.resolve(); expect(await outcome).toBeInstanceOf(Error);
    const records = await service.list(owner);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ nativeId: 'native-late', state: 'interrupted', error: 'Native conversation process exited.' });
    const runtime = (service as any).runtimes.get('late-create');
    expect(runtime.handle).toBe(handle); expect(runtime.stopped).toBe(true);
    expect(first.frames.filter(row => row.type === 'user')).toHaveLength(1);
    expect(second?.frames.filter(row => row.type === 'user').map(row => row.message.content) ?? []).toEqual(
      state === 'successor' ? ['Successor foreground'] : []);
    if (successor) { frame({ type: 'result', is_error: false, result: 'Synthetic successor result' }); await successor; }
    expect((await service.cancel(owner, 'late-create')).state).toBe('interrupted');
    expect(spawn).toHaveBeenCalledTimes(state === 'successor' ? 2 : 1);
    await service.destroy();
  });
});

/** Real executor, handler, service and adapter; only the native transport is scripted. */
async function retainedFixture() {
  const main = executor(), raw = main as any;
  const { child, frames } = fakePipe(raw); child.pid = 23;
  const frame = (value: object) => raw.handleOutputLine(JSON.stringify(value));
  const inventory = new Map<string, string>();
  let holdInterrupt = false, holdManagement = false;
  const terminal = (id: string, error = false) => {
    frame({ type: 'result', user_message_uuid: id, session_id: 'synthetic-native-session', is_error: error, result: 'Synthetic completion' });
    frame({ type: 'command_lifecycle', command_uuid: id, state: error ? 'cancelled' : 'completed', session_id: 'synthetic-native-session' });
  };
  const hook = (action: any, id: string) => frame({ type: 'control_request', request_id: `hook-${id}`, request: {
    subtype: 'hook_callback', callback_id: SCHEDULE_HOOK, tool_use_id: id,
    input: { hook_event_name: 'PreToolUse', tool_name: action.tool, tool_input: action.input } } });
  child.stdin.write.mockImplementation((line: string, callback?: () => void) => {
    const row = JSON.parse(line); frames.push(row); callback?.();
    if (row.type === 'control_request') queueMicrotask(() => {
      const response = (value: object) => frame({ type: 'control_response', response: { subtype: 'success', request_id: row.request_id, response: value } });
      if (row.request.subtype === 'initialize') response({ models: [], claude_code_version: '2.1.311', pid: child.pid });
      if (row.request.subtype === 'get_settings') response({ effective: { env: { TZ: 'UTC' } } });
      if (row.request.subtype === 'interrupt' && !holdInterrupt) { response({ turn: 'stopped', still_queued: [] }); for (const id of row.request.for_user_message_uuids) terminal(id, true); }
      if (row.request.subtype === 'stop_task') { response({}); frame({ type: 'system', subtype: 'background_tasks_changed', tasks: [] }); }
    });
    if (row.type === 'user') queueMicrotask(() => {
      frame({ type: 'command_lifecycle', command_uuid: row.uuid, state: 'started', session_id: 'synthetic-native-session' });
      if (!row.message.content.startsWith('Perform this authorized native schedule operation') || holdManagement) return;
      const action = JSON.parse(row.message.content.split('\n').at(-1));
      hook(action, row.uuid);
      let content = 'No scheduled jobs.';
      if (action.tool === 'CronList') content = [...inventory].map(([id, prompt]) => `${id} — Every minute (recurring) [session-only], next run later: ${prompt.replace(/\s+/g, ' ')}`).join('\n') || content;
      if (action.tool === 'CronDelete') { inventory.delete(action.input.id); content = `Cancelled job ${action.input.id}.`; }
      frame({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: row.uuid, content }] } });
      terminal(row.uuid);
    });
    return true;
  });
  await main.listModels();
  frame({ type: 'system', subtype: 'init', session_id: 'synthetic-native-session', tools: ['CronCreate', 'CronList', 'CronDelete'],
    capabilities: ['interrupt_receipt_v1', 'msg_lifecycle_v1', 'lifecycle_wakeup_source_v1'] });
  return { main, raw, child, frames, frame, terminal, hook, inventory,
    holdInterrupt: (value: boolean) => { holdInterrupt = value; }, holdManagement: (value: boolean) => { holdManagement = value; } };
}

describe('Claude retained cancellation integration', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const architecture = Object.getOwnPropertyDescriptor(process, 'arch')!;
  it.each([['linux', 'arm64'], ['darwin', 'arm64'], ['win32', 'x64']] as const)(
    'accepts %s/%s capabilities and retains the actual filesystem host', async (hostPlatform, arch) => {
      const f = await retainedFixture();
      f.raw.turnLedger.version = '2.1.318';
      // Restore the host before asynchronous protocol handling or persistence.
      try {
        Object.defineProperty(process, 'platform', { ...platform, value: hostPlatform });
        Object.defineProperty(process, 'arch', { ...architecture, value: arch });
        expect(f.main.preservesProcessOnAbort()).toBe(true);
      } finally {
        Object.defineProperty(process, 'arch', architecture);
        Object.defineProperty(process, 'platform', platform);
      }
      const foreground = f.main.execute('Foreground to cancel').catch(error => error);
      await Promise.resolve();
      expect(await f.main.abort()).toBe(true); await foreground;
      expect(f.frames.some(row => row.request?.subtype === 'interrupt')).toBe(true);
      expect(f.child.stdin.end).not.toHaveBeenCalled(); expect(f.child.kill).not.toHaveBeenCalled();
      expect(f.main.isProcessRunning()).toBe(true);
    },
  );
  it('retains the host and bridge registration, expires its lease, and ignores stale results in a successor', async () => {
    const f = await retainedFixture(), h = makeHandler(f.main);
    const bridge = new ManagedToolBridge();
    const stale = bridge.activate(vi.fn());
    const close = vi.spyOn(bridge, 'close');
    h.raw.delegationBridges.set('thread', bridge);
    const before = f.main.execute('Old foreground').catch(error => error);
    await Promise.resolve();
    const old = f.frames.filter(row => row.type === 'user').at(-1).uuid;
    await h.raw.handleAbortCommand('abort-message', 'thread', f.main); await before;
    expect(f.child.stdin.end).not.toHaveBeenCalled(); expect(f.child.kill).not.toHaveBeenCalled();
    expect(h.raw.delegationBridges.get('thread')).toBe(bridge); expect(close).not.toHaveBeenCalled();
    expect((bridge as any).handler).toBeUndefined();
    const active = vi.fn(); bridge.activate(active); stale(); expect((bridge as any).handler).toBe(active);
    const sent = h.ws.send.mock.calls.map((call: any[]) => call[0]);
    expect(sent.filter((row: any) => row.messageId === 'abort-message')).toHaveLength(1);
    expect(JSON.stringify(sent)).toContain('future native schedules were retained');
    let done = false;
    const display = vi.fn(); const next = f.main.execute('Successor', { onStream: display }).then(value => { done = true; return value; });
    await Promise.resolve();
    f.frame({ type: 'assistant', user_message_uuid: old, message: { content: [{ type: 'text', text: 'Stale text' }] } });
    f.terminal(old); f.frame({ type: 'result', is_error: false, result: 'Unjoined autonomous result' });
    await Promise.resolve(); expect(done).toBe(false); expect(display).not.toHaveBeenCalled();
    f.terminal(f.frames.filter(row => row.type === 'user').at(-1).uuid); expect((await next).success).toBe(true);
  });

  it('requires ACK plus joined result and terminal, keeps timeout fenced, and retries on the same late receipt', async () => {
    vi.useFakeTimers(); const f = await retainedFixture(); f.holdInterrupt(true);
    const foreground = f.main.execute('Held foreground').catch(error => error); await Promise.resolve();
    const stopping = f.main.abort(); expect(f.main.abort()).toBe(stopping);
    const rejected = expect(stopping).rejects.toThrow('unconfirmed');
    await vi.advanceTimersByTimeAsync(15001); await rejected; await foreground;
    expect(f.main.hasPendingCancellation()).toBe(true); expect(f.main.isBusy()).toBe(true);
    const h = makeHandler(f.main);
    const service = new ScheduleService({ directory: path.join(root, 'readonly-catalog'), isOwnerCurrent: () => true,
      provider: { create: async () => { throw new Error('No native creation allowed'); } }, deliver: async () => {} });
    await service.initialize(); h.raw.schedules = service;
    vi.spyOn(h.raw, 'initializeSchedules').mockResolvedValue(service); h.raw.scheduleManagement.add('thread');
    const nativeManagement = vi.spyOn(f.main, 'withNativeScheduleOperation');
    await h.raw.handleScheduleCommand({ content: '/schedule list', messageId: 'catalog-message', openId: 'synthetic-owner' }, 'thread');
    expect(nativeManagement).not.toHaveBeenCalled();
    expect(JSON.stringify(h.ws.send.mock.calls)).toContain('stored catalog');
    h.raw.scheduleManagement.delete('thread'); await service.destroy();

    expect((await f.main.execute('Must not dispatch')).success).toBe(false);
    const packet = f.frames.find(row => row.request?.subtype === 'interrupt');
    f.frame({ type: 'control_response', response: { subtype: 'success', request_id: packet.request_id, response: { turn: 'stopped' } } });
    const retry = f.main.abort(); let finished = false; void retry.then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(0); expect(finished).toBe(false);
    f.terminal(packet.request.for_user_message_uuids[0], true);
    expect(await retry).toBe(true); expect(f.main.hasPendingCancellation()).toBe(false);
    expect(f.frames.filter(row => row.request?.subtype === 'interrupt')).toHaveLength(1);
    expect(f.child.stdin.end).not.toHaveBeenCalled();
  });

  it('reconciles an error-after-commit CREATE through retained service ownership without new host or replay', async () => {
    const f = await retainedFixture(), h = makeHandler(f.main);
    let current = true;
    const service = new ScheduleService({ directory: path.join(root, 'retained-catalog'), isOwnerCurrent: () => true,
      deliver: async () => {}, provider: { create: (input, emit) => f.main.createNativeSchedule(input, emit, () => current) } });
    await service.initialize(); h.raw.schedules = service;
    vi.spyOn(h.raw, 'initializeSchedules').mockResolvedValue(service); h.raw.scheduleResultsSupported = true;
    const owner = { threadId: 'thread', openId: 'synthetic-owner', generation: h.raw.scheduleGeneration('thread') };
    const foreground = f.main.execute('Create reminder').catch(error => error); await Promise.resolve();
    const creating = h.raw.runScheduleOperation(owner, { kind: 'create', prompt: 'Synthetic reminder',
      rule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' } }, 'mutation-job',
      { current: () => current, backend: 'claude', config: { type: 'auto' }, cwd: root }).catch((error: Error) => error);
    await vi.waitFor(() => expect(f.main.nativeScheduleAction('mutation-job')).toBeDefined());
    const action = f.main.nativeScheduleAction('mutation-job')!; f.hook(action, 'creation-tool');
    f.inventory.set('native-owned', String(action.input.prompt));
    current = false;
    const abort = f.main.abort(); await Promise.resolve();
    f.frame({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'creation-tool', is_error: true, content: 'Synthetic rejected receipt after commit' }] } });
    expect(await abort).toBe(true); await foreground; await creating;
    expect(f.inventory.size).toBe(0); expect(f.child.stdin.end).not.toHaveBeenCalled();
    const actions = f.frames.filter(row => row.type === 'user' && row.message.content.startsWith('Perform this authorized'))
      .map(row => JSON.parse(row.message.content.split('\n').at(-1)));
    expect(actions.map(row => row.tool)).toEqual(['CronList', 'CronDelete', 'CronList']);
    expect(actions[1].input).toEqual({ id: 'native-owned' });
    const runtime = (service as any).runtimes.get('mutation-job');
    expect(runtime.handle).toBeDefined(); expect(runtime.stopped).toBe(true);
    expect(await service.list(owner)).toHaveLength(1);
    expect(spawn).not.toHaveBeenCalled(); await service.destroy();
  });

  it('stops only background tasks linked to the captured foreground tool and checks retirement separately', async () => {
    const f = await retainedFixture(); const foreground = f.main.execute('Spawn owned work').catch(error => error);
    await Promise.resolve();
    f.frame({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'owned-tool', name: 'Bash' }] } });
    f.frame({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'owned-task' }, { task_id: 'foreign-task' }] });
    f.frame({ type: 'system', subtype: 'task_started', task_id: 'owned-task', tool_use_id: 'owned-tool' });
    f.frame({ type: 'system', subtype: 'task_started', task_id: 'foreign-task', tool_use_id: 'unknown-tool' });
    expect(await f.main.abort()).toBe(true); await foreground;
    expect(f.frames.filter(row => row.request?.subtype === 'stop_task').map(row => row.request.task_id)).toEqual(['owned-task']);
  });
  it('keeps failed cleanup owned and fences settings/new work, then retries inventory without recreating', async () => {
    vi.useFakeTimers(); const f = await retainedFixture();
    const foreground = f.main.execute('Create synthetic job').catch(error => error); await Promise.resolve();
    const creation = f.main.withNativeScheduleOperation('uncertain-job', () => true, () => f.main.createNativeSchedule({
      id: 'uncertain-job', cwd: root, prompt: 'Synthetic uncertain reminder',
      rule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' },
    }, vi.fn()), true).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    const action = f.main.nativeScheduleAction('uncertain-job')!; f.hook(action, 'uncertain-tool');
    f.inventory.set('native-uncertain', String(action.input.prompt)); f.holdManagement(true);
    const stopped = f.main.abort(); const failure = expect(stopped).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(60001); await failure; await foreground; await creation;
    expect(f.main.hasPendingCancellation()).toBe(true);
    expect((await f.main.execute('Must not start')).success).toBe(false);
    expect((await f.main.configureSandbox('off')).success).toBe(false);
    await expect(f.main.configureManagedTools({ url: 'http://127.0.0.1:1', token: 'synthetic', groups: ['scheduling'] })).rejects.toThrow('busy');
    const run = vi.fn(); await expect(f.main.reconcileNativeSchedule('uncertain-job', () => true, run)).rejects.toThrow('pending');
    expect(run).not.toHaveBeenCalled(); expect(f.child.stdin.end).not.toHaveBeenCalled();
    // Complete the previous management turn; retry must not overlap that still-running native turn.
    f.terminal(f.frames.filter(row => row.type === 'user').at(-1).uuid, true); f.holdManagement(false);
    expect(await f.main.abort()).toBe(true); expect(f.inventory.size).toBe(0);
    expect(f.main.hasPendingCancellation()).toBe(false); expect(spawn).not.toHaveBeenCalled();
  });

  it('does not interrupt a naturally completed turn or an autonomous-only turn', async () => {
    const f = await retainedFixture(); const active = f.main.execute('Natural completion'); await Promise.resolve();
    const id = f.frames.filter(row => row.type === 'user').at(-1).uuid;
    // Abort is published before its microtask runs; the native terminal wins the race.
    const stopping = f.main.abort(); f.terminal(id); await active; expect(await stopping).toBe(false);
    f.frame({ type: 'command_lifecycle', state: 'started', wakeup_source: 'schedule_wakeup', command_uuid: 'autonomous' });
    expect(await f.main.abort()).toBe(false);
    expect(f.frames.filter(row => row.request?.subtype === 'interrupt')).toHaveLength(0);
    expect(f.child.stdin.end).not.toHaveBeenCalled();
  });

  it('permits explicit destructive context recovery after unconfirmed retained cancellation', async () => {
    vi.useFakeTimers(); const f = await retainedFixture(); f.holdInterrupt(true);
    const active = f.main.execute('Held foreground').catch(error => error); await Promise.resolve();
    const failure = expect(f.main.abort()).rejects.toThrow('unconfirmed');
    await vi.advanceTimersByTimeAsync(15001); await failure; await active;
    await f.main.stopForContextReset(); expect(f.child.stdin.end).toHaveBeenCalledOnce();
    expect(f.raw.claudeProcess).toBeNull(); expect(f.main.hasPendingCancellation()).toBe(false);
  });

  it('captures interactive continuation identities and refuses retired input while cancellation is pending', async () => {
    const f = await retainedFixture(); const foreground = f.main.execute('Interactive request').catch(error => error); await Promise.resolve();
    const original = f.frames.filter(row => row.type === 'user').at(-1).uuid;
    const waiter = f.raw.requestInteractiveInput('Synthetic question');
    expect(f.main.sendInput('Synthetic response')).toBe(true); expect(await waiter).toBe('Synthetic response');
    await Promise.resolve(); const continuation = f.frames.filter(row => row.type === 'user').at(-1).uuid;
    const stopping = f.main.abort(); expect(f.main.sendInput('Retired response')).toBe(false);
    expect(await stopping).toBe(true); await foreground;
    expect(f.frames.find(row => row.request?.subtype === 'interrupt').request.for_user_message_uuids).toEqual([original, continuation]);
  });

  it('bounds native interrupt targeting while requiring settlement of every interactive input', async () => {
    vi.useFakeTimers(); const f = await retainedFixture(); f.holdInterrupt(true);
    const foreground = f.main.execute('Long interactive request').catch(error => error);
    await Promise.resolve();
    for (let n = 0; n < 9; n++) {
      const waiter = f.raw.requestInteractiveInput('Synthetic question');
      expect(f.main.sendInput('Synthetic answer')).toBe(true); await waiter; await Promise.resolve();
    }
    const ids = f.frames.filter(row => row.type === 'user').map(row => row.uuid);
    let settled = false;
    const stopping = f.main.abort().then(value => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(0);
    const packet = f.frames.find(row => row.request?.subtype === 'interrupt');
    expect(ids).toHaveLength(10);
    expect(packet.request.for_user_message_uuids).toEqual(ids.slice(-8));
    f.frame({ type: 'control_response', response: { subtype: 'success', request_id: packet.request_id, response: { turn: 'stopped' } } });
    for (const id of ids.slice(-8)) f.terminal(id, true);
    await vi.advanceTimersByTimeAsync(0); expect(settled).toBe(false);
    for (const id of ids.slice(0, -8)) f.terminal(id, true);
    expect(await stopping).toBe(true); await foreground;
    expect(f.child.stdin.end).not.toHaveBeenCalled();
  });

  it('requires task retirement evidence newer than the stop request', async () => {
    vi.useFakeTimers(); const f = await retainedFixture();
    const foreground = f.main.execute('Owned background work').catch(error => error); await Promise.resolve();
    f.frame({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'owned-tool', name: 'Bash' }] } });
    f.frame({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    f.frame({ type: 'system', subtype: 'task_started', task_id: 'owned-task', tool_use_id: 'owned-tool' });
    const write = f.child.stdin.write.getMockImplementation()!;
    f.child.stdin.write.mockImplementation((line: string, callback?: () => void) => {
      const packet = JSON.parse(line);
      if (packet.request?.subtype !== 'stop_task') return write(line, callback);
      f.frames.push(packet); callback?.();
      queueMicrotask(() => f.frame({ type: 'control_response', response: { subtype: 'success', request_id: packet.request_id, response: {} } }));
      return true;
    });
    let settled = false;
    const stopping = f.main.abort().then(value => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.frames.some(row => row.request?.subtype === 'stop_task')).toBe(true);
    expect(settled).toBe(false);
    f.frame({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    expect(await stopping).toBe(true); await foreground;
  });

  it('reports duplicate handler abort as unresolved while native acknowledgement is missing', async () => {
    vi.useFakeTimers(); const f = await retainedFixture(), h = makeHandler(f.main); f.holdInterrupt(true);
    const foreground = f.main.execute('Unconfirmed foreground').catch(error => error); await Promise.resolve();
    const first = h.raw.handleAbortCommand('abort-first', 'thread', f.main);
    const second = h.raw.handleAbortCommand('abort-second', 'thread', f.main);
    const bridge = new ManagedToolBridge(); h.raw.delegationBridges.set('thread', bridge);
    const close = vi.spyOn(bridge, 'close');
    await expect(h.raw.clearThreadConversation('clear-during-abort', 'thread')).rejects.toThrow('still pending');
    expect(close).not.toHaveBeenCalled(); expect(h.raw.delegationBridges.get('thread')).toBe(bridge);

    await vi.advanceTimersByTimeAsync(15001); await first; await second; await foreground;
    const messages = h.ws.send.mock.calls.map((call: any[]) => call[0]).filter((row: any) => row.messageId?.startsWith('abort-'));
    expect(messages).toHaveLength(2);
    expect(messages.every((row: any) => row.success === false)).toBe(true);
    expect(f.child.stdin.end).not.toHaveBeenCalled();
  });

  it.each(['interrupt', 'clear'] as const)('preserves one foreground aborted lifecycle notification for %s', async mode => {
    const f = await retainedFixture(); f.raw.lifecycleHooks = true;
    const notified = vi.spyOn(claudeCodeHooks, 'notifyTaskAborted').mockResolvedValue(undefined);
    const active = f.main.execute('Synthetic lifecycle turn').catch(error => error); await Promise.resolve();
    if (mode === 'interrupt') { const first = f.main.abort(); expect(f.main.abort()).toBe(first); await first; }
    else await f.main.stopForContextReset();
    await active; expect(notified).toHaveBeenCalledOnce(); expect(f.raw.currentTaskId).toBeNull();
  });

  it('destroy retires pending cancellation evidence waiters without leaving deadline timers', async () => {
    vi.useFakeTimers(); const f = await retainedFixture(); f.holdInterrupt(true);
    const active = f.main.execute('Held foreground').catch(error => error); await Promise.resolve();
    const stopped = f.main.abort().catch(error => error); await vi.advanceTimersByTimeAsync(0);
    await f.main.destroy(); expect(await stopped).toBeInstanceOf(Error); await active;
    expect(vi.getTimerCount()).toBe(0); expect(f.child.stdin.end).toHaveBeenCalledOnce();
  });

});
