import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { ThreadManager } from '../../src/thread/ThreadManager';
import { DEFAULT_THREAD_NAME, MAX_THREADS } from '../../src/thread/types';
import { isDelegationEnabled } from '../../src/thread/DelegationSettings';
import { bootIdentity } from '../../src/delegation/OwnershipRuntime';
import { exclusiveLocalVolume } from '../../src/thread/AgyDeletionVolume';
import { replaceAtomicFile } from '../../src/delegation/AtomicFile';

vi.mock('../../src/delegation/OwnershipRuntime', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/delegation/OwnershipRuntime')>()),
  bootIdentity: vi.fn(),
}));
vi.mock('../../src/thread/AgyDeletionVolume', () => ({ exclusiveLocalVolume: vi.fn() }));
vi.mock('../../src/delegation/AtomicFile', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/delegation/AtomicFile')>();
  return { replaceAtomicFile: vi.fn(actual.replaceAtomicFile) };
});

// Mock os.homedir() so tests don't write to real home directory
const originalHomedir = os.homedir();
vi.spyOn(os, 'homedir').mockImplementation(() => process.env.HOME || originalHomedir);

describe('ThreadManager', () => {
  let tmpDir: string;
  let manager: ThreadManager;
  let previousHome: string | undefined;
  let previousProfile: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'thread-manager-test-')));
    previousHome = process.env.HOME; previousProfile = process.env.USERPROFILE;
    process.env.HOME = tmpDir; process.env.USERPROFILE = tmpDir;
    vi.mocked(bootIdentity).mockReturnValue({ host: 'fixture-host', boot: 'fixture-boot-a', namespace: 'host' });
    vi.mocked(exclusiveLocalVolume).mockResolvedValue(true);
    manager = await ThreadManager.initialize(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
  });

  describe('initialization', () => {
    it('preserves a default thread with broken reset metadata while listing unaffected siblings', async () => {
      const original = manager.getDefaultThread();
      const sibling = await manager.createThread('healthy', tmpDir);
      await manager.contextResets.begin(original.id);
      await manager.contextResets.advanceGeneration(original.id);
      await manager.contextResets.complete(original.id);
      const filename = (manager.contextResets as any).file(original.id) + '.generation';
      await fs.writeFile(filename, '{');
      const metadata = await fs.readFile(path.join(tmpDir, '.remote-cli', 'threads.json'));
      const loaded = await ThreadManager.initialize(tmpDir);
      expect(loaded.listThreads()).toHaveLength(2);
      expect(loaded.listThreads().find(thread => thread.id === original.id)).toMatchObject({ contextError: expect.stringContaining('generation') });
      expect(loaded.getThread(sibling.id)).toEqual(sibling);
      expect(() => loaded.getThread(original.id)).toThrow('generation');
      expect(await fs.readFile(path.join(tmpDir, '.remote-cli', 'threads.json'))).toEqual(metadata);
      await fs.writeFile(filename, '2');
      expect(loaded.listThreads().find(thread => thread.id === original.id)).toMatchObject({ delegationWorkspaceGeneration: 2 });
      expect(loaded.listThreads().find(thread => thread.id === original.id)).not.toHaveProperty('contextError');
    });

    it('persists native speed overrides and explicit Follow markers independently of model and effort', async () => {
      const thread = manager.getDefaultThread();
      await manager.updateThread(thread.id, { models: { codex: 'native-model' }, efforts: { codex: 'high' }, speeds: { codex: 'priority' } });
      let reloaded = await ThreadManager.initialize(tmpDir);
      expect(reloaded.getThread(thread.id)).toMatchObject({ models: { codex: 'native-model' }, efforts: { codex: 'high' }, speeds: { codex: 'priority' } });
      await reloaded.updateThread(thread.id, { speeds: { codex: null } });
      reloaded = await ThreadManager.initialize(tmpDir);
      expect(reloaded.getThread(thread.id)?.speeds).toEqual({ codex: null });
    });
    it('cleans DSH pointers and compact summaries without removing another thread', async () => {
      const thread = await manager.createThread('dsh-delete', tmpDir, 'dsh');
      const directory = path.join(tmpDir, '.remote-cli', 'dsh-sessions');
      await fs.mkdir(directory);
      for (const name of [`${thread.id}.json`, `${thread.id}.handoff.json`, 'other.json']) {
        await fs.writeFile(path.join(directory, name), '{}');
      }
      await manager.deleteThread(thread.id);
      expect(await fs.readdir(directory)).toEqual(['other.json']);
    });

    it('creates a default thread on first init', async () => {
      const threads = manager.listThreads();
      expect(threads).toHaveLength(1);
      expect(threads[0].name).toBe(DEFAULT_THREAD_NAME);
      expect(threads[0].delegationWorkspaceGeneration).toBe(0);
    });

    it('enables delegation on new threads without materializing a preference', async () => {
      const created = await manager.createThread('default-on', tmpDir);
      const saved = await ThreadManager.initialize(tmpDir);
      for (const thread of [saved.getDefaultThread(), saved.getThread(created.id)!]) {
        expect(isDelegationEnabled(thread)).toBe(true);
        expect(thread).not.toHaveProperty('delegation');
      }
    });

    it('reads legacy preferences without rewriting metadata or conversation bindings', async () => {
      const disabled = await manager.createThread('disabled', tmpDir, 'dsh');
      const enabled = await manager.createThread('enabled', tmpDir, 'claude');
      const legacy = { ...manager.getDefaultThread(), sessionId: 'saved-parent-session',
        models: { dsh: 'provider/model' }, efforts: { dsh: 'high' } };
      delete legacy.delegationWorkspaceGeneration;
      const store = { threads: {
        [legacy.id]: legacy,
        [disabled.id]: { ...disabled, delegation: false, sessionId: 'saved-disabled-session' },
        [enabled.id]: { ...enabled, delegation: true },
      } };
      const storePath = path.join(tmpDir, '.remote-cli', 'threads.json');
      const before = JSON.stringify(store, null, 2);
      await fs.writeFile(storePath, before);

      const loaded = await ThreadManager.initialize(tmpDir);
      expect(isDelegationEnabled(loaded.getDefaultThread())).toBe(true);
      expect(isDelegationEnabled(loaded.getThread(disabled.id))).toBe(false);
      expect(isDelegationEnabled(loaded.getThread(enabled.id))).toBe(true);
      expect(Object.fromEntries(loaded.listThreads().map(thread => [thread.id, thread]))).toEqual(store.threads);
      expect(await fs.readFile(storePath, 'utf8')).toBe(before);
    });

    it('retains an explicit opt-out through metadata updates and reloads', async () => {
      const thread = manager.getDefaultThread();
      await manager.updateThread(thread.id, { delegation: false, backend: 'dsh' });
      await manager.updateThread(thread.id, { sessionId: null, models: { dsh: 'provider/model' }, lastActiveAt: 42 });
      await manager.clearBackendOverrides();
      const saved = await ThreadManager.initialize(tmpDir);
      expect(saved.getDefaultThread().delegation).toBe(false);
      expect(isDelegationEnabled(saved.getDefaultThread())).toBe(false);
    });

    it('persists threads to disk and loads on re-initialize', async () => {
      await manager.createThread('feature-x', tmpDir);
      const manager2 = await ThreadManager.initialize(tmpDir);
      const threads = manager2.listThreads();
      expect(threads).toHaveLength(2);
      expect(threads.some(t => t.name === 'feature-x')).toBe(true);
    });

    it('returns same threads on repeat initialize', async () => {
      const manager2 = await ThreadManager.initialize(tmpDir);
      const threads2 = manager2.listThreads();
      expect(threads2).toHaveLength(1);
      expect(threads2[0].name).toBe(DEFAULT_THREAD_NAME);
    });
  });

  describe('createThread', () => {
    it('creates a thread with given name and workingDirectory', async () => {
      const thread = await manager.createThread('my-feature', tmpDir);
      expect(thread.name).toBe('my-feature');
      expect(thread.workingDirectory).toBe(tmpDir);
      expect(thread.id).toBeTruthy();
      expect(thread.sessionId).toBeNull();
      expect(thread.delegationWorkspaceGeneration).toBe(0);
    });

    it('creates thread with unique UUIDs', async () => {
      const t1 = await manager.createThread('t1', tmpDir);
      const t2 = await manager.createThread('t2', tmpDir);
      expect(t1.id).not.toBe(t2.id);
    });

    it('throws when name already exists', async () => {
      await manager.createThread('dup', tmpDir);
      await expect(manager.createThread('dup', tmpDir)).rejects.toThrow(/already exists/);
    });

    it('throws when MAX_THREADS reached', async () => {
      for (let i = 1; i < MAX_THREADS; i++) {
        await manager.createThread(`thread-${i}`, tmpDir);
      }
      await expect(manager.createThread('overflow', tmpDir)).rejects.toThrow(/Maximum.*threads/);
    });

    it('validates name format — rejects invalid names', async () => {
      await expect(manager.createThread('', tmpDir)).rejects.toThrow();
      await expect(manager.createThread('has space', tmpDir)).rejects.toThrow();
      await expect(manager.createThread('-starts-dash', tmpDir)).rejects.toThrow();
      await expect(manager.createThread('ends-dash-', tmpDir)).rejects.toThrow();
    });

    it('accepts valid name formats', async () => {
      await expect(manager.createThread('a', tmpDir)).resolves.toBeDefined();
      await expect(manager.createThread('my-feature-1', tmpDir)).resolves.toBeDefined();
      await expect(manager.createThread('ABC123', tmpDir)).resolves.toBeDefined();
    });
  });

  describe('getThread', () => {
    it('returns thread by id', async () => {
      const created = await manager.createThread('find-me', tmpDir);
      const found = manager.getThread(created.id);
      expect(found).toBeDefined();
      expect(found!.name).toBe('find-me');
    });

    it('returns undefined for unknown id', () => {
      expect(manager.getThread('nonexistent-id')).toBeUndefined();
    });
  });

  describe('getThreadByName', () => {
    it('returns thread by name', async () => {
      const created = await manager.createThread('named', tmpDir);
      const found = manager.getThreadByName('named');
      expect(found?.id).toBe(created.id);
    });

    it('returns undefined for unknown name', () => {
      expect(manager.getThreadByName('ghost')).toBeUndefined();
    });
  });

  describe('deleteThread', () => {
    async function detachedFixture() {
      const thread = await manager.createThread('old-agy', tmpDir);
      const root = path.join(tmpDir, '.remote-cli');
      const pointer = path.join(root, 'agy-sessions', thread.id + '.json');
      const home = path.join(root, 'agy-homes', thread.id);
      const conversations = path.join(home, '.gemini', 'antigravity-cli', 'conversations');
      await fs.mkdir(conversations, { recursive: true });
      await fs.mkdir(path.dirname(pointer), { recursive: true });
      for (const id of ['first', 'second']) {
        await fs.writeFile(pointer, JSON.stringify({ id, transport: 'acp', retired: false }));
        await fs.writeFile(path.join(conversations, id + '.db'), id);
        await manager.clearBackendSessionPointers(thread.id);
      }
      return { thread, home, pointer, archive: pointer + '.detached-acp', conversations, root };
    }
    function reboot(host = 'fixture-host') {
      vi.mocked(bootIdentity).mockReturnValue({ host, boot: 'fixture-boot-b', namespace: 'host' });
    }
    const start = () => ThreadManager.initialize(tmpDir, { retryDeferredDeletion: true });

    it('releases name and quota durably and retries only after a later boot of the original host', async () => {
      const { thread, home, root, archive } = await detachedFixture();
      for (let i = 2; i < MAX_THREADS; i++) await manager.createThread('filler-' + i, tmpDir);
      await expect(manager.createThread('overflow', tmpDir)).rejects.toThrow('Maximum');
      await manager.assertThreadDeletionAllowed(thread.id);
      await manager.deleteThread(thread.id);
      manager = await start();
      expect(manager.getThread(thread.id)).toBeUndefined();
      const replacement = await manager.createThread(thread.name, tmpDir);
      expect(replacement.id).not.toBe(thread.id);
      const sibling = path.join(root, 'agy-homes', replacement.id);
      await fs.mkdir(sibling);
      await fs.writeFile(path.join(sibling, 'keep'), 'sibling');
      expect(await fs.readdir(archive)).toHaveLength(2);
      reboot('foreign');
      await start();
      expect(await fs.stat(home)).toBeDefined();
      reboot();
      await ThreadManager.initialize(tmpDir);
      expect(await fs.stat(home)).toBeDefined();
      manager = await start();
      expect(manager.getThreadByName(thread.name)?.id).toBe(replacement.id);
      expect(await fs.readFile(path.join(sibling, 'keep'), 'utf8')).toBe('sibling');
      if (process.platform !== 'linux') {
        expect(await fs.readdir(archive)).toHaveLength(2);
        expect(await fs.stat(home)).toBeDefined();
        return;
      }
      await expect(fs.stat(home)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(archive)).rejects.toMatchObject({ code: 'ENOENT' });
      const catalog = JSON.parse(await fs.readFile(path.join(root, 'threads.json'), 'utf8'));
      expect(catalog.deferredAgyDeletions[thread.id]).toEqual({ version: 1, threadId: thread.id, completed: true });
    });

    it('retains the deleted thread\'s own project inside its old native HOME', async () => {
      const { thread, home, archive } = await detachedFixture();
      const project = path.join(home, 'project');
      await fs.mkdir(project);
      await fs.writeFile(path.join(project, 'source'), 'keep');
      await manager.updateThread(thread.id, { workingDirectory: project });
      await manager.deleteThread(thread.id);
      reboot();
      manager = await start();
      expect(manager.getThread(thread.id)).toBeUndefined();
      expect(await fs.readFile(path.join(project, 'source'), 'utf8')).toBe('keep');
      expect(await fs.readdir(archive)).toHaveLength(2);
    });

    it('limits the live-owner exception to the current ACP pointer', async () => {
      const { thread, pointer, archive } = await detachedFixture();
      await fs.writeFile(pointer, JSON.stringify({ id: 'active', transport: 'acp' }));
      const preflight = () => manager.assertThreadDeletionAllowed(thread.id, { allowCurrentAgySession: true });
      await preflight();
      await expect(manager.deleteThread(thread.id)).rejects.toThrow('retirement is unconfirmed');
      for (const suffix of ['.allocation-unconfirmed', '.checkpoint.lock', '.native-schedules', '.checkpoint', '.worker-policy']) {
        await fs.writeFile(pointer + suffix, '{}');
        await expect(preflight()).rejects.toThrow();
        await fs.unlink(pointer + suffix);
      }
      await fs.writeFile(pointer, JSON.stringify({ id: 'legacy' }));
      await expect(preflight()).rejects.toThrow();
      await fs.unlink(pointer);
      const names = await fs.readdir(archive);
      await fs.writeFile(path.join(archive, names[0]), JSON.stringify({ retirement: 'unconfirmed', session: { id: 'wrong', transport: 'acp' } }));
      await expect(preflight()).rejects.toThrow();
      expect(manager.getThread(thread.id)).toBeDefined();
    });

    it('preserves both catalog views on atomic replacement failure and supports retry', async () => {
      const { thread, root, archive } = await detachedFixture();
      const file = path.join(root, 'threads.json');
      const grants = path.join(root, 'codex-sandbox');
      await fs.mkdir(grants);
      const grant = path.join(grants, thread.id + '.json');
      await fs.writeFile(grant, '{}');
      const previous = await fs.readFile(file);
      vi.mocked(replaceAtomicFile).mockRejectedValueOnce(new Error('injected storage failure'));
      await expect(manager.deleteThread(thread.id)).rejects.toThrow('injected');
      expect(await fs.readFile(file)).toEqual(previous);
      expect(await fs.readFile(grant, 'utf8')).toBe('{}');
      expect(manager.getThreadByName(thread.name)?.id).toBe(thread.id);
      expect(await fs.readdir(archive)).toHaveLength(2);
      await manager.deleteThread(thread.id);
      expect(manager.getThread(thread.id)).toBeUndefined();
      await expect(fs.stat(grant)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it.each(['foreign-workspace', 'replaced-file', 'new-pointer', 'shared-volume', 'hard-link', 'sibling-pointer'])(
      'retains history after reboot when ownership changes (%s)', async reason => {
        const { thread, pointer, home, conversations } = await detachedFixture();
        await manager.deleteThread(thread.id);
        const file = path.join(conversations, 'first.db');
        if (reason === 'foreign-workspace') await manager.createThread('linked', home);
        if (reason === 'replaced-file') await fs.writeFile(file, 'replacement');
        if (reason === 'new-pointer') await fs.writeFile(pointer, JSON.stringify({ id: 'fresh', transport: 'acp' }));
        if (reason === 'shared-volume') vi.mocked(exclusiveLocalVolume).mockResolvedValue(false);
        if (reason === 'hard-link') await fs.link(file, path.join(tmpDir, 'alias'));
        if (reason === 'sibling-pointer') await fs.writeFile(path.join(path.dirname(pointer), 'sibling.json'), JSON.stringify({ id: 'FIRST' }));
        reboot();
        manager = await start();
        expect(manager.getThread(thread.id)).toBeUndefined();
        expect(await fs.readFile(path.join(conversations, 'second.db'), 'utf8')).toBe('second');
      });

    it.runIf(process.platform === 'linux')('resumes after interrupted erasure without requiring already removed entries', async () => {
      const { thread, home, archive } = await detachedFixture();
      await manager.deleteThread(thread.id);
      reboot();
      const names = await fs.readdir(archive);
      await fs.unlink(path.join(archive, names[0]));
      manager = await start();
      await expect(fs.stat(home)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(archive)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('retains history referenced by a redirected shared native directory', async () => {
      const { thread, home, conversations } = await detachedFixture();
      await manager.deleteThread(thread.id);
      await fs.symlink(path.join(home, '.gemini'), path.join(tmpDir, '.gemini'), process.platform === 'win32' ? 'junction' : 'dir');
      reboot();
      await start();
      expect(await fs.readFile(path.join(conversations, 'first.db'), 'utf8')).toBe('first');
    });

    it('refuses an archive redirected to a sibling', async () => {
      const { thread, archive } = await detachedFixture();
      const sibling = path.join(tmpDir, 'sibling-archive');
      await fs.rename(archive, sibling);
      await fs.symlink(sibling, archive, process.platform === 'win32' ? 'junction' : 'dir');
      await expect(manager.deleteThread(thread.id)).rejects.toThrow('ambiguous');
      expect(await fs.readdir(sibling)).toHaveLength(2);
      expect(manager.getThread(thread.id)).toBeDefined();
    });

    it('rejects ambiguous Linux mount inventories before enabling reboot cleanup', async () => {
      const { exclusiveLinuxMount } = await vi.importActual<typeof import('../../src/thread/AgyDeletionVolume')>('../../src/thread/AgyDeletionVolume');
      const disk = '1 0 8:1 / / rw - ext4 /dev/example rw';
      const root = '/fixture/.remote-cli';
      expect(exclusiveLinuxMount(disk, root)).toBe(true);
      for (const line of [
        '2 1 8:1 /fixture /second rw - ext4 /dev/example rw',
        '2 1 8:1 / /fixture rw - ext4 /dev/example rw',
        '2 1 8:2 / /fixture/.remote-cli/agy-homes rw - ext4 /dev/example2 rw',
        '2 1 0:2 / / rw - nfs example.com:/fixture rw',
        '2 1 0:2 / /fixture rw - nfs example.com:/fixture rw',
      ]) expect(exclusiveLinuxMount(disk + '\n' + line, root)).toBe(false);
      expect(() => exclusiveLinuxMount('incomplete', root)).toThrow();
    });

    it.each([true, false])('archives inactive ACP selection on explicit clear and releases the thread (retired=%s)', async retired => {
      const thread = await manager.createThread('inactive-agy', tmpDir, 'claude');
      const directory = path.join(tmpDir, '.remote-cli', 'agy-sessions'); await fs.mkdir(directory, { recursive: true });
      const pointer = path.join(directory, `${thread.id}.json`), session = { id: 'synthetic-session', transport: 'acp', retired };
      await fs.writeFile(pointer, JSON.stringify(session));
      const history = path.join(tmpDir, '.remote-cli', 'agy-homes', thread.id, 'history');
      await fs.mkdir(path.dirname(history), { recursive: true }); await fs.writeFile(history, 'native history');
      await expect(manager.deleteThread(thread.id)).rejects.toThrow('retirement is unconfirmed');
      await manager.clearBackendSessionPointers(thread.id);
      await expect(fs.stat(pointer)).rejects.toMatchObject({ code: 'ENOENT' });
      const archive = pointer + '.detached-acp';
      const [name] = await fs.readdir(archive); expect(JSON.parse(await fs.readFile(path.join(archive, name), 'utf8')).session).toEqual(session);
      manager = await ThreadManager.initialize(tmpDir);
      await manager.deleteThread(thread.id);
      expect(await fs.readFile(history, 'utf8')).toBe('native history');
      expect(manager.getThread(thread.id)).toBeUndefined();
    });

    it('does not discard inactive schedule ownership during pointer reset', async () => {
      const thread = await manager.createThread('inactive-owned', tmpDir, 'claude');
      const directory = path.join(tmpDir, '.remote-cli', 'agy-sessions'); await fs.mkdir(directory, { recursive: true });
      const pointer = path.join(directory, `${thread.id}.json`);
      await fs.writeFile(pointer, JSON.stringify({ id: 'synthetic-session', transport: 'acp' }));
      await fs.writeFile(pointer + '.native-schedules', JSON.stringify({ sessionId: 'synthetic-session', hostId: 'synthetic-host', retired: true }));
      await expect(manager.clearBackendSessionPointers(thread.id)).rejects.toThrow('schedule ownership');
      expect(await fs.stat(pointer)).toBeDefined();
    });

    it('retains inactive AGY data until exact host retirement, then permits explicit deletion', async () => {
      const thread = await manager.createThread('agy-retained', tmpDir, 'claude');
      const directory = path.join(tmpDir, '.remote-cli', 'agy-sessions');
      await fs.mkdir(directory, { recursive: true });
      const journal = path.join(directory, `${thread.id}.json.native-schedules`);
      const pointer = path.join(directory, `${thread.id}.json`);
      await fs.writeFile(pointer, JSON.stringify({ id: 'synthetic-native-session' }));
      const owner = { sessionId: 'synthetic-native-session', hostId: 'synthetic-host', retired: false };
      await fs.writeFile(journal, JSON.stringify(owner));
      await expect(manager.deleteThread(thread.id)).rejects.toThrow('retirement is unconfirmed');
      expect(manager.getThread(thread.id)).toBeDefined(); expect(await fs.stat(pointer)).toBeDefined();
      await fs.writeFile(journal, JSON.stringify({ ...owner, retired: true }));
      await fs.writeFile(pointer + '.checkpoint', 'synthetic-checkpoint');
      await fs.mkdir(pointer + '.checkpoint.lock');
      await expect(manager.deleteThread(thread.id)).rejects.toThrow('checkpoint transition');
      // Fixture-owned stale lock removal simulates an explicitly resolved transition.
      await fs.rmdir(pointer + '.checkpoint.lock');
      await manager.deleteThread(thread.id);
      await expect(fs.stat(pointer + '.checkpoint')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(journal)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('removes dormant AGY data even when the active backend is different', async () => {
      const thread = await manager.createThread('dormant-agy', tmpDir, 'claude');
      const dataDir = path.join(tmpDir, '.remote-cli');
      const home = path.join(dataDir, 'agy-homes', thread.id);
      const session = path.join(dataDir, 'agy-sessions', `${thread.id}.json`);
      await fs.mkdir(home, { recursive: true });
      await fs.mkdir(path.dirname(session), { recursive: true });
      await fs.writeFile(path.join(home, 'sentinel'), 'conversation data');
      await fs.writeFile(session, JSON.stringify({ id: 'old-conversation' }));

      await manager.deleteThread(thread.id);

      await expect(fs.stat(home)).rejects.toThrow();
      await expect(fs.stat(session)).rejects.toThrow();
    });
    it('revokes saved Codex sandbox grants even after switching to another backend', async () => {
      const thread = await manager.createThread('sandbox-grants', tmpDir, 'claude');
      const directory = path.join(tmpDir, '.remote-cli', 'codex-sandbox');
      await fs.mkdir(directory, { recursive: true });
      const grant = path.join(directory, `${thread.id}.json`);
      await fs.writeFile(grant, JSON.stringify({ mode: 'workspace-write', writableRoots: [tmpDir] }));
      await manager.deleteThread(thread.id);
      await expect(fs.stat(grant)).rejects.toThrow();
      expect(manager.getThread(thread.id)).toBeUndefined();
    });
    it('deletes a non-default thread', async () => {
      const t = await manager.createThread('deletable', tmpDir);
      await manager.deleteThread(t.id);
      expect(manager.getThread(t.id)).toBeUndefined();
    });

    it('throws when deleting the default thread', async () => {
      const defaultThread = manager.getThreadByName(DEFAULT_THREAD_NAME)!;
      await expect(manager.deleteThread(defaultThread.id)).rejects.toThrow(/default/i);
    });

    it('throws when deleting unknown thread', async () => {
      await expect(manager.deleteThread('no-such-id')).rejects.toThrow(/not found/i);
    });

    it('persists deletion to disk', async () => {
      const t = await manager.createThread('will-delete', tmpDir);
      await manager.deleteThread(t.id);
      const manager2 = await ThreadManager.initialize(tmpDir);
      expect(manager2.getThread(t.id)).toBeUndefined();
    });
  });

  describe('updateThread', () => {
    it('updates sessionId', async () => {
      const t = await manager.createThread('session-update', tmpDir);
      await manager.updateThread(t.id, { sessionId: 'abc123' });
      const updated = manager.getThread(t.id)!;
      expect(updated.sessionId).toBe('abc123');
    });

    it('updates workingDirectory', async () => {
      const t = await manager.createThread('wd-update', tmpDir);
      const newDir = path.join(tmpDir, 'subdir');
      await fs.mkdir(newDir);
      await manager.updateThread(t.id, { workingDirectory: newDir });
      const updated = manager.getThread(t.id)!;
      expect(updated.workingDirectory).toBe(newDir);
    });

    it('updates model', async () => {
      const t = await manager.createThread('model-update', tmpDir);
      expect(t.model).toBeUndefined();
      await manager.updateThread(t.id, { model: 'opus' });
      const updated = manager.getThread(t.id)!;
      expect(updated.model).toBe('opus');
    });

    it('persists and clears a per-thread backend override', async () => {
      const thread = await manager.createThread('backend-update', tmpDir, 'codex');
      expect(manager.getThread(thread.id)?.backend).toBe('codex');

      await manager.clearBackendOverrides();

      expect(manager.getThread(thread.id)?.backend).toBeUndefined();
      const reloaded = await ThreadManager.initialize(tmpDir);
      expect(reloaded.getThread(thread.id)?.backend).toBeUndefined();
    });

    it('updates lastActiveAt', async () => {
      const t = await manager.createThread('ts-update', tmpDir);
      const before = t.lastActiveAt;
      await new Promise(r => setTimeout(r, 10));
      await manager.updateThread(t.id, { lastActiveAt: Date.now() });
      const updated = manager.getThread(t.id)!;
      expect(updated.lastActiveAt).toBeGreaterThan(before);
    });

    it('throws for unknown thread id', async () => {
      await expect(manager.updateThread('ghost', { sessionId: 'x' })).rejects.toThrow(/not found/i);
    });
  });

  describe('concurrent persist safety', () => {
    it('persists all threads when multiple createThread calls fire simultaneously', async () => {
      // Fire 4 createThread calls concurrently — without a write queue the last
      // writeFile wins and earlier writes are silently dropped.
      await Promise.all([
        manager.createThread('t1', tmpDir),
        manager.createThread('t2', tmpDir),
        manager.createThread('t3', tmpDir),
        manager.createThread('t4', tmpDir),
      ]);

      const manager2 = await ThreadManager.initialize(tmpDir);
      const names = manager2.listThreads().map(t => t.name);
      expect(names).toContain('t1');
      expect(names).toContain('t2');
      expect(names).toContain('t3');
      expect(names).toContain('t4');
    });

    it('persists all updates when multiple updateThread calls fire simultaneously', async () => {
      const t = await manager.createThread('concurrent-update', tmpDir);

      // Fire 4 rapid updates — the last writeFile to finish would overwrite the others
      // without a write queue, potentially reverting earlier updates.
      await Promise.all([
        manager.updateThread(t.id, { sessionId: 'session-1' }),
        manager.updateThread(t.id, { workingDirectory: '/dir/1' }),
        manager.updateThread(t.id, { lastActiveAt: 1000 }),
        manager.updateThread(t.id, { sessionId: 'session-final' }),
      ]);

      // Re-read from disk — all operations should have completed sequentially
      const manager2 = await ThreadManager.initialize(tmpDir);
      const saved = manager2.getThread(t.id);
      expect(saved).toBeDefined();
      // The in-memory state should reflect the last applied update
      const inMem = manager.getThread(t.id)!;
      const onDisk = manager2.getThread(t.id)!;
      // Disk must match in-memory (no lost-write scenario)
      expect(onDisk.sessionId).toBe(inMem.sessionId);
      expect(onDisk.workingDirectory).toBe(inMem.workingDirectory);
    });

    it('persists final state correctly when create and delete race', async () => {
      const [t1, t2] = await Promise.all([
        manager.createThread('race-a', tmpDir),
        manager.createThread('race-b', tmpDir),
      ]);
      await Promise.all([
        manager.deleteThread(t1.id),
        manager.updateThread(t2.id, { sessionId: 'kept' }),
      ]);

      const manager2 = await ThreadManager.initialize(tmpDir);
      expect(manager2.getThread(t1.id)).toBeUndefined();
      expect(manager2.getThread(t2.id)).toBeDefined();
    });
  });

  describe('listThreads', () => {
    it('returns all threads sorted by createdAt', async () => {
      await manager.createThread('b', tmpDir);
      await manager.createThread('c', tmpDir);
      const threads = manager.listThreads();
      // default was created first
      expect(threads[0].name).toBe(DEFAULT_THREAD_NAME);
      expect(threads.length).toBe(3);
    });
  });

  describe('getDefaultThread', () => {
    it('always returns the default thread', () => {
      const def = manager.getDefaultThread();
      expect(def.name).toBe(DEFAULT_THREAD_NAME);
    });
  });

  describe('session file management', () => {
    it('returns Claude session file path (.json) for a thread', async () => {
      const t = await manager.createThread('sess', tmpDir);
      const filePath = manager.getSessionFilePath(t.id);
      expect(filePath).toContain(t.id);
      expect(filePath).toMatch(/\.json$/);
    });

    it('does not delete session file on deleteThread (executor is responsible)', async () => {
      const t = await manager.createThread('sess-del', tmpDir);
      const sessionPath = manager.getSessionFilePath(t.id);
      await fs.writeFile(sessionPath, 'some session data');
      await manager.deleteThread(t.id);
      // ThreadManager no longer deletes session files — that is ThreadExecutorPool's job
      const exists = await fs.access(sessionPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });
  });

  describe('migration from single session', () => {
    it('migrates existing .claude-session to default thread if no threads file exists', async () => {
      // Simulate pre-thread setup: session file exists but no threads.json
      const legacySessionFile = path.join(tmpDir, '.remote-cli', 'claude-session');
      await fs.mkdir(path.join(tmpDir, '.remote-cli'), { recursive: true });
      await fs.writeFile(legacySessionFile, 'legacy-session-id-123');

      // Remove threads.json so initialize sees a clean state
      const threadsFile = path.join(tmpDir, '.remote-cli', 'threads.json');
      await fs.rm(threadsFile, { force: true });

      const freshManager = await ThreadManager.initialize(tmpDir);
      const defaultThread = freshManager.getDefaultThread();
      expect(defaultThread.sessionId).toBe('legacy-session-id-123');
    });

    it('uses null sessionId when legacy claude-session file is empty (whitespace only)', async () => {
      const legacySessionFile = path.join(tmpDir, '.remote-cli', 'claude-session');
      await fs.mkdir(path.join(tmpDir, '.remote-cli'), { recursive: true });
      await fs.writeFile(legacySessionFile, '   \n  ');

      const threadsFile = path.join(tmpDir, '.remote-cli', 'threads.json');
      await fs.rm(threadsFile, { force: true });

      const freshManager = await ThreadManager.initialize(tmpDir);
      expect(freshManager.getDefaultThread().sessionId).toBeNull();
    });
  });

  describe('initialization edge cases', () => {
    it('preserves corrupt catalog bytes and fails closed on unknown UUID reservations', async () => {
      const threadsFile = path.join(tmpDir, '.remote-cli', 'threads.json');
      await fs.mkdir(path.join(tmpDir, '.remote-cli'), { recursive: true });
      await fs.writeFile(threadsFile, '{ invalid json !!!');

      await expect(ThreadManager.initialize(tmpDir)).rejects.toThrow(/threads\.json.*restore/i);
      expect(await fs.readFile(threadsFile, 'utf8')).toBe('{ invalid json !!!');
    });

    it('supports deleting an idle non-AGY thread in a linked config directory', async () => {
      const root = path.join(tmpDir, '.remote-cli');
      const actual = path.join(tmpDir, 'config');
      await fs.rename(root, actual);
      await fs.symlink(actual, root, process.platform === 'win32' ? 'junction' : 'dir');
      manager = await ThreadManager.initialize(tmpDir);
      const thread = await manager.createThread('ordinary', tmpDir, 'codex');
      await manager.assertThreadDeletionAllowed(thread.id);
      await manager.deleteThread(thread.id);
      expect((await ThreadManager.initialize(tmpDir)).getThread(thread.id)).toBeUndefined();
    });
  });

  describe('createThread name validation boundaries', () => {
    it('accepts a single-character name', async () => {
      await expect(manager.createThread('a', tmpDir)).resolves.toBeDefined();
    });

    it('accepts a 30-character name (max length)', async () => {
      const name = 'a' + 'b'.repeat(28) + 'c'; // 30 chars
      await expect(manager.createThread(name, tmpDir)).resolves.toBeDefined();
    });

    it('rejects names with only hyphens or leading/trailing hyphens', async () => {
      await expect(manager.createThread('-bad', tmpDir)).rejects.toThrow();
      await expect(manager.createThread('bad-', tmpDir)).rejects.toThrow();
    });

    it('accepts two-character alphanumeric name', async () => {
      await expect(manager.createThread('ab', tmpDir)).resolves.toBeDefined();
    });

    it('rejects two-character name with trailing hyphen', async () => {
      await expect(manager.createThread('a-', tmpDir)).rejects.toThrow();
    });
  });

  describe('deleteThread edge cases', () => {
    it('succeeds silently when session file does not exist', async () => {
      const t = await manager.createThread('no-session', tmpDir);
      // Do not create session file — delete should still work
      await expect(manager.deleteThread(t.id)).resolves.toBeUndefined();
      expect(manager.getThread(t.id)).toBeUndefined();
    });
  });

  describe('updateThread', () => {
    it('updates multiple fields simultaneously', async () => {
      const t = await manager.createThread('multi-update', tmpDir);
      const newTime = Date.now() + 9999;
      await manager.updateThread(t.id, { sessionId: 'xyz', workingDirectory: '/other', lastActiveAt: newTime });
      const updated = manager.getThread(t.id)!;
      expect(updated.sessionId).toBe('xyz');
      expect(updated.workingDirectory).toBe('/other');
      expect(updated.lastActiveAt).toBe(newTime);
    });

    it('returns a new object reference (immutability)', async () => {
      const t = await manager.createThread('immutable', tmpDir);
      const before = manager.getThread(t.id)!;
      await manager.updateThread(t.id, { sessionId: 'new-session' });
      const after = manager.getThread(t.id)!;
      expect(after).not.toBe(before);
      expect(before.sessionId).toBeNull(); // original not mutated
    });
  });
});
