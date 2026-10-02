import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { createExecutor } from '../../src/executor';
import type { IExecutor } from '../../src/executor/IExecutor';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { ThreadManager } from '../../src/thread/ThreadManager';
import { ThreadExecutorPool } from '../../src/thread/ThreadExecutorPool';
import type { BackendKey, ExecutorConfig } from '../../src/types/config';

// Cover both default and namespace imports, including macOS home lookup.
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  const homedir = () => process.env.HOME || actual.homedir();
  return { ...actual, homedir, default: { ...actual, homedir } };
});

const backends: BackendKey[] = ['claude', 'codex', 'agy', 'opencode', 'kimi', 'zcode', 'pi', 'dsh'];
const configFor = (backend: BackendKey): ExecutorConfig => ({
  type: backend === 'claude' ? 'claude-persistent' : backend,
});

describe('Directory changes and backend session isolation', () => {
  let home: string;
  let project: string;
  let other: string;
  let manager: ThreadManager;
  let guard: DirectoryGuard;
  let pool: ThreadExecutorPool;
  let threadId: string;
  const executors: IExecutor[] = [];

  const pointerPath = (backend: BackendKey, id = threadId) =>
    path.join(home, '.remote-cli', `${backend}-sessions`, `${id}.json`);

  async function seedPointers(id = threadId): Promise<void> {
    for (const backend of backends) {
      await fs.mkdir(path.dirname(pointerPath(backend, id)), { recursive: true });
      await fs.writeFile(pointerPath(backend, id), JSON.stringify({ id: `old-${backend}`, cwd: project }));
    }
  }

  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'directory-session-test-')));
    vi.stubEnv('HOME', home);
    project = path.join(home, 'project');
    other = path.join(home, 'other');
    await fs.mkdir(project);
    await fs.mkdir(other);
    manager = await ThreadManager.initialize(home);
    threadId = manager.getDefaultThread().id;
    await manager.updateThread(threadId, { workingDirectory: project });
    guard = new DirectoryGuard([home]);
    pool = new ThreadExecutorPool(manager, guard, configFor('claude'));
    await seedPointers();
  });

  afterEach(async () => {
    await pool.destroyAll({ deleteData: false });
    for (const executor of executors.splice(0)) await executor.destroy();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true });
  });

  it.each(backends)('clears every backend binding when %s changes directory, including after restart and return', async (backend) => {
    pool = new ThreadExecutorPool(manager, guard, configFor(backend));
    const executor = pool.getExecutor(threadId);
    expect(executor.getSessionId?.()).toBe(`old-${backend}`);

    expect(await pool.setWorkingDirectory(threadId, './')).toEqual({ cwd: project, changed: false });
    expect(executor.getSessionId?.()).toBe(`old-${backend}`);
    for (const key of backends) await expect(fs.access(pointerPath(key))).resolves.toBeUndefined();

    expect(await pool.setWorkingDirectory(threadId, '../other')).toEqual({ cwd: other, changed: true });
    expect(executor.getSessionId?.()).toBeNull();
    expect(manager.getThread(threadId)).toMatchObject({
      workingDirectory: other,
      sessionId: null,
      delegationWorkspaceGeneration: 1,
    });
    for (const key of backends) await expect(fs.access(pointerPath(key))).rejects.toMatchObject({ code: 'ENOENT' });

    await pool.destroyAll({ deleteData: false });
    manager = await ThreadManager.initialize(home);
    pool = new ThreadExecutorPool(manager, guard, configFor(backend));
    expect(pool.getExecutor(threadId).getSessionId?.()).toBeNull();
    await pool.setWorkingDirectory(threadId, project);
    for (const key of backends) {
      await pool.switchBackend(configFor(key));
      expect(pool.getExecutor(threadId).getSessionId?.()).toBeNull();
      expect(pool.getExecutor(threadId).getCurrentWorkingDirectory()).toBe(project);
    }
  });

  it('preserves each backend conversation when switching backends without changing directory', async () => {
    for (const backend of [...backends, ...backends].reverse()) {
      await pool.switchBackend(configFor(backend));
      expect(pool.getExecutor(threadId).getSessionId?.()).toBe(`old-${backend}`);
    }
  });

  it('keeps other threads, transcripts, sandbox grants, and thread preferences intact', async () => {
    const sibling = await manager.createThread('sibling', project);
    await seedPointers(sibling.id);
    await manager.updateThread(threadId, {
      models: { claude: 'opus', codex: 'gpt-5' }, efforts: { codex: 'high' }, delegation: true, backend: 'claude',
    });
    const preferences = { ...manager.getThread(threadId)! };
    const preserved = [
      path.join(home, '.remote-cli', 'pi-sessions', 'store', 'history.jsonl'),
      path.join(home, '.remote-cli', 'agy-homes', threadId, '.gemini', 'antigravity-cli', 'conversations', 'history.pb'),
      path.join(home, '.remote-cli', 'codex-sandbox', `${threadId}.json`),
      path.join(home, '.remote-cli', 'claude-sandbox', `${threadId}.json`),
    ];
    const savedData = JSON.stringify({ mode: 'workspace-write', writableRoots: [other] });
    for (const file of preserved) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, savedData);
    }
    await pool.setWorkingDirectory(threadId, other);
    expect(manager.getThread(threadId)).toEqual({
      ...preferences,
      workingDirectory: other,
      sessionId: null,
      delegationWorkspaceGeneration: (preferences.delegationWorkspaceGeneration ?? 0) + 1,
    });
    expect(manager.getThread(sibling.id)?.workingDirectory).toBe(project);
    for (const backend of backends) {
      expect(JSON.parse(await fs.readFile(pointerPath(backend, sibling.id), 'utf8')).id).toBe(`old-${backend}`);
    }
    for (const file of preserved) expect(await fs.readFile(file, 'utf8')).toBe(savedData);
  });

  it('rejects invalid destinations before changing the directory or deleting session bindings', async () => {
    const file = path.join(home, 'regular-file');
    await fs.writeFile(file, 'file');
    const executor = pool.getExecutor(threadId);
    for (const target of [path.join(home, 'missing'), file, path.join(home, '..', 'outside')]) {
      await expect(pool.setWorkingDirectory(threadId, target)).rejects.toThrow();
      expect(executor.getCurrentWorkingDirectory()).toBe(project);
      expect(executor.getSessionId?.()).toBe('old-claude');
      expect(manager.getThread(threadId)?.workingDirectory).toBe(project);
      for (const backend of backends) await expect(fs.access(pointerPath(backend))).resolves.toBeUndefined();
    }
  });

  it('fails a directory change when an inactive backend binding cannot be removed', async () => {
    await fs.rm(pointerPath('pi'));
    await fs.mkdir(pointerPath('pi'));
    await expect(pool.setWorkingDirectory(threadId, other)).rejects.toThrow();
    expect(pool.getExecutor(threadId).getCurrentWorkingDirectory()).toBe(project);
    expect(manager.getThread(threadId)?.workingDirectory).toBe(project);
    for (const backend of backends.filter(key => key !== 'pi')) {
      expect(JSON.parse(await fs.readFile(pointerPath(backend), 'utf8')).id).toBe(`old-${backend}`);
    }
  });

  it('clears a Claude binding before the first command in the new directory even without a pool', async () => {
    const create = (cwd: string) => {
      const executor = createExecutor(guard, configFor('claude'), cwd, threadId);
      executors.push(executor);
      return executor;
    };
    const executor = create(project);
    await executor.setWorkingDirectory('./');
    expect(executor.getSessionId?.()).toBe('old-claude');
    await executor.setWorkingDirectory(other);
    await executor.destroy();
    expect(create(other).getSessionId?.()).toBeNull();
    expect(create(project).getSessionId?.()).toBeNull();
  });

  it('does not reopen a Pi session whose header belongs to another directory', async () => {
    const stale = createExecutor(guard, configFor('pi'), other, threadId);
    executors.push(stale);
    expect(stale.getSessionId?.()).toBeNull();
    const restored = createExecutor(guard, configFor('pi'), project, threadId);
    executors.push(restored);
    expect(restored.getSessionId?.()).toBeNull();
  });
});
