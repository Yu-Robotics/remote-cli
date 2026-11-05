import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnManaged } from '../../src/executor/ManagedSpawn';
const fake = vi.hoisted(() => ({ spawn: vi.fn(), native: { createJob: vi.fn(), jobMember: vi.fn(), jobCount: vi.fn(), terminateJob: vi.fn(), close: vi.fn(), processInfo: vi.fn() } }));
vi.mock('../../src/delegation/OwnershipRuntime', () => ({ ownedSpawn: fake.spawn }));
vi.mock('../../src/native/NativeBindings', () => ({ nativeRoot: 'synthetic-native', nativeBindings: () => fake.native }));
describe('managed launcher protocol', () => {
  let child: EventEmitter & { pid: number; connected: boolean; kill: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    vi.useFakeTimers(); vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    child = Object.assign(new EventEmitter(), { pid: 12345, connected: true, kill: vi.fn(() => true), send: vi.fn((_message, callback) => callback?.(null)) });
    fake.spawn.mockReturnValue(child); fake.native.processInfo.mockReturnValue({ group: 12345, session: 12345 });
  });
  afterEach(() => { child.emit('close', 0); vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });
  it('clears the startup deadline after admission and leaves a long-running backend alive', () => {
    const rawKill = child.kill;
    spawnManaged(true, 'synthetic-backend', ['arg'], { env: { NODE_OPTIONS: '--require=untrusted', SAFE: 'value' }, windowsVerbatimArguments: true, argv0: 'backend-only' });
    const options = fake.spawn.mock.calls[0][2];
    expect(options.env.NODE_OPTIONS).toBeUndefined();
    expect(options.argv0).toBeUndefined(); expect(options.windowsVerbatimArguments).toBeUndefined();
    child.emit('message', { type: 'managed-job-ready' });
    expect(child.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'start', env: expect.objectContaining({ SAFE: 'value' }) }), expect.any(Function));
    vi.advanceTimersByTime(120000);
    expect(rawKill).not.toHaveBeenCalled();
  });
  it('stops an unadmitted launcher without starting backend code', () => {
    const rawKill = child.kill;
    spawnManaged(true, 'synthetic-backend', [], {});
    vi.advanceTimersByTime(30000);
    expect(rawKill).toHaveBeenCalledWith('SIGKILL'); expect(child.send).not.toHaveBeenCalled();
  });
  it('asks the live macOS launcher to stop its own group and preserves backend status', () => {
    const rawKill = child.kill, exit = vi.fn();
    spawnManaged(true, 'synthetic-backend', [], {}); child.emit('message', { type: 'managed-job-ready' });
    child.kill('SIGKILL'); expect(rawKill).not.toHaveBeenCalled();
    expect(child.send).toHaveBeenCalledWith({ type: 'stop' }, expect.any(Function));
    child.on('close', exit); child.emit('message', { type: 'backend-exit', code: 7, signal: null }); child.emit('close', null, 'SIGKILL');
    expect(exit).toHaveBeenCalledWith(7, null);
  });
  it('relays backend startup errors separately from successful launcher spawn', () => {
    const error = vi.fn(); child.on('error', error); spawnManaged(true, 'missing-backend', [], {});
    child.emit('message', { type: 'backend-error', code: 'ENOENT' });
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ code: 'ENOENT' }));
  });
  it('checks Windows job membership and releases an empty job explicitly', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const handle = {}; fake.native.createJob.mockReturnValue(handle); fake.native.jobMember.mockReturnValue(true); fake.native.jobCount.mockReturnValue(1);
    spawnManaged(true, 'synthetic-backend', [], {}); child.emit('message', { type: 'managed-job-ready' });
    expect(fake.native.jobMember).toHaveBeenCalledWith(handle, child.pid);
    child.kill(); expect(fake.native.terminateJob).toHaveBeenCalledWith(handle);
    fake.native.jobCount.mockReturnValue(0); child.emit('close', 0);
    expect(fake.native.close).toHaveBeenCalledWith(handle);
  });
});
