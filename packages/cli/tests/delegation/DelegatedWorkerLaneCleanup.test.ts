import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { cleanupDelegatedWorkerLane } from '../../src/delegation/DelegatedWorkerLaneCleanup';
import { workerLaneExecutorId, type DelegatedWorkerLane } from '../../src/delegation/DelegatedWorkerSessionStore';

function lane(backend: DelegatedWorkerLane['backend']): DelegatedWorkerLane {
  const id = randomUUID();
  return {
    id,
    executorThreadId: workerLaneExecutorId(id),
    threadId: 'parent-thread',
    backend,
    workingDirectory: '/tmp/workspace',
    workspaceGeneration: 0,
    state: 'dirty',
    createdAt: 1,
    updatedAt: 1,
    cleanupPending: true,
  };
}

describe('cleanupDelegatedWorkerLane', () => {
  let home: string;

  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'delegated-worker-cleanup-')));
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it('removes only the synthetic Codex pointer and sandbox state', async () => {
    const worker = lane('codex');
    const root = path.join(home, '.remote-cli');
    const workerPointer = path.join(root, 'codex-sessions', `${worker.executorThreadId}.json`);
    const directPointer = path.join(root, 'codex-sessions', 'direct-thread.json');
    const sandbox = path.join(root, 'codex-sandbox', `${worker.executorThreadId}.json`);
    await fs.mkdir(path.dirname(workerPointer), { recursive: true });
    await fs.mkdir(path.dirname(sandbox), { recursive: true });
    await Promise.all([
      fs.writeFile(workerPointer, '{"id":"worker"}'),
      fs.writeFile(directPointer, '{"id":"direct"}'),
      fs.writeFile(sandbox, '{}'),
    ]);

    await cleanupDelegatedWorkerLane(worker, home);

    await expect(fs.access(workerPointer)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(sandbox)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(directPointer, 'utf8')).resolves.toContain('direct');
  });

  it('removes only a DSH worker pointer and pending compact summary', async () => {
    const worker = lane('dsh');
    const directory = path.join(home, '.remote-cli', 'dsh-sessions');
    await fs.mkdir(directory, { recursive: true });
    const pointer = path.join(directory, `${worker.executorThreadId}.json`);
    const summary = path.join(directory, `${worker.executorThreadId}.handoff.json`);
    const direct = path.join(directory, 'direct-thread.json');
    await Promise.all([pointer, summary, direct].map(file => fs.writeFile(file, '{}')));
    await cleanupDelegatedWorkerLane(worker, home);
    await expect(fs.stat(pointer)).rejects.toThrow();
    await expect(fs.stat(summary)).rejects.toThrow();
    expect(await fs.readFile(direct, 'utf8')).toBe('{}');
  });

  it('removes a Pi lane session file only when it is inside the lane-owned store', async () => {
    const worker = lane('pi');
    const root = path.join(home, '.remote-cli');
    const pointer = path.join(root, 'pi-sessions', `${worker.executorThreadId}.json`);
    const owned = path.join(root, 'pi-sessions', 'store', `${worker.executorThreadId}.jsonl`);
    const external = path.join(home, 'outside.jsonl');
    await fs.mkdir(path.dirname(owned), { recursive: true });
    await Promise.all([
      fs.writeFile(pointer, JSON.stringify({ sessionFile: owned })),
      fs.writeFile(owned, 'worker history'),
      fs.writeFile(external, 'external history'),
    ]);

    await cleanupDelegatedWorkerLane(worker, home);

    await expect(fs.access(pointer)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(owned)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(external, 'utf8')).resolves.toBe('external history');
  });
});
