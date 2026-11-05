import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ spawn: vi.fn(), track: vi.fn(), wait: vi.fn(async () => {}) }));
// These tests supply EventEmitter processes, not OS workers. Native admission and
// containment are exercised by ManagedSpawn.native.test.ts on each native runner.
vi.mock('../../src/executor/ManagedSpawn', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/executor/ManagedSpawn')>();
  const { ownedSpawn } = await import('../../src/delegation/OwnershipRuntime');
  return { ...actual, spawnManaged: (_enabled: boolean, ...args: Parameters<typeof ownedSpawn>) => ownedSpawn(...args) };
});

vi.mock('../../src/delegation/OwnershipRuntime', () => ({ ownedSpawn: fixture.spawn }));
vi.mock('../../src/executor/ManagedProcessGroups', () => ({ ManagedProcessGroups: class {
  track = fixture.track;
  waitForExit = fixture.wait;
} }));
import { OpenCodeDeletionClient } from '../../src/delegation/OpenCodeSessionDeletion';

describe('bounded OpenCode deletion maintenance transport', () => {
  let child: EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    vi.clearAllMocks();
    child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
    let pipes = 0;
    for (const pipe of [child.stdout, child.stderr]) pipe.once('close', () => { if (++pipes === 2) child.emit('close', null); });
    fixture.spawn.mockReturnValue(child);
  });
  afterEach(() => { child.stdout.destroy(); child.stderr.destroy(); vi.useRealTimers(); vi.unstubAllEnvs(); });

  it('settles timed-out pipes before verifying that the managed process group exited', async () => {
    vi.useFakeTimers();
    const client = new OpenCodeDeletionClient('synthetic-opencode', process.cwd());
    const result = client.run(['db', 'path']);
    const rejected = expect(result).rejects.toThrow('maintenance command failed');
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(child.stdout.destroyed && child.stderr.destroyed).toBe(true);
    await client.waitForExit();
    expect(fixture.wait).toHaveBeenCalledOnce();
  });

  it('bounds excessive output and retains the captured maintenance environment', async () => {
    const environment = { PATH: process.env.PATH, OPENCODE_DB: 'synthetic-owned-database' };
    const client = new OpenCodeDeletionClient('synthetic-opencode', process.cwd(), environment);
    environment.OPENCODE_DB = 'changed';
    const result = client.run(['db', 'path']);
    const rejected = expect(result).rejects.toThrow('maintenance command failed');
    child.stdout.write(Buffer.alloc(65_537));
    await rejected;
    expect(fixture.spawn.mock.calls[0][2].env.OPENCODE_DB).toBe('synthetic-owned-database');
    await client.waitForExit();
    expect(fixture.wait).toHaveBeenCalledOnce();
  });
});
