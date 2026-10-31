import { createHash, randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { DelegatedWorkspaceManager, type DelegatedWorkspace } from '../../src/delegation/DelegatedWorkspaceManager';
import { DelegatedWorkerSessionStore } from '../../src/delegation/DelegatedWorkerSessionStore';
import { gitText, runGit } from '../../src/delegation/GitCheckpoint';
import { LfsCheckoutVerifier } from '../../src/delegation/LfsCheckout';
import { BackendRegistry } from '../../src/delegation/BackendRegistry';
import { DelegationManager } from '../../src/delegation/DelegationManager';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import type { IExecutor } from '../../src/executor/IExecutor';
import { gitFixture } from './gitFixture';

let nativeLfs = false;
try { execFileSync('git', ['lfs', 'version'], { stdio: 'ignore' }); nativeLfs = true; } catch { /* Native LFS tests require git-lfs. */ }

describe.skipIf(!nativeLfs)('local LFS checkout recovery proof', { timeout: 30_000 }, () => {
  let home: string;
  let fixture: Awaited<ReturnType<typeof gitFixture>>;
  let manager: DelegatedWorkspaceManager;
  let workspace: DelegatedWorkspace;
  const payload = Buffer.from('Synthetic LFS asset\n'.repeat(80));
  const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
  const pointer = (data: Buffer) => Buffer.from(`version https://git-lfs.github.com/spec/v1\noid sha256:${hash(data)}\nsize ${data.length}\n`);
  const media = () => path.join(fixture.root, '.git', 'lfs', 'objects');
  const object = (data = payload, root = media()) => path.join(root, hash(data).slice(0, 2), hash(data).slice(2, 4), hash(data));
  const file = () => path.join(workspace.directory, 'asset.bin');
  const storage = () => path.join(fixture.directory, 'workspaces');
  const collect = () => manager.collect(workspace, true, { exitConfirmed: true });
  const verifier = () => new LfsCheckoutVerifier(workspace.directory, fixture.root, storage());
  const blob = () => gitText(fixture.root, ['rev-parse', `${workspace.input.tree}:asset.bin`]);
  const assertHeld = async (reason = 'lfs-payload-unverified') => {
    expect(await manager.reclaim(workspace.taskId)).toBe(false);
    expect((await fs.lstat(workspace.directory)).isDirectory()).toBe(true);
    expect(await manager.getLaneCloseout(workspace.laneId)).toMatchObject({ holdReason: reason });
  };

  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'delegated-lfs-home-')));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('XDG_CONFIG_HOME', path.join(home, 'config'));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fixture = await gitFixture();
    // Only repository-local filters; no installation, authentication, remote, or download.
    await runGit(fixture.root, ['config', 'filter.lfs.clean', 'git-lfs clean -- %f']);
    await runGit(fixture.root, ['config', 'filter.lfs.process', 'git-lfs filter-process --skip']);
    await runGit(fixture.root, ['config', 'filter.lfs.smudge', 'git-lfs smudge --skip -- %f']);
    await runGit(fixture.root, ['config', 'filter.lfs.required', 'true']);
    await fs.writeFile(path.join(fixture.root, '.gitattributes'), 'asset.bin filter=lfs diff=lfs merge=lfs -text\n');
    await fs.writeFile(path.join(fixture.root, 'asset.bin'), payload);
    await runGit(fixture.root, ['add', '.']);
    await runGit(fixture.root, ['commit', '-m', 'Synthetic local LFS baseline']);
    manager = new DelegatedWorkspaceManager(storage(), true);
    const sessions = new DelegatedWorkerSessionStore(path.join(fixture.directory, 'native-lanes'));
    const { lane } = await sessions.acquire({ threadId: 'lfs-fixture', backend: 'agy', workingDirectory: fixture.root, workspaceGeneration: 0 });
    const source = (await manager.discover(fixture.root))!;
    workspace = await manager.prepare(lane, source, await manager.baseline(source), randomUUID());
    expect(await fs.readFile(file())).toEqual(pointer(payload));
    // Materialize locally without invoking a network-capable smudge operation.
    await fs.writeFile(file(), payload);
    await runGit(workspace.directory, ['add', 'asset.bin']);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (fixture) await fs.rm(fixture.directory, { recursive: true, force: true });
    if (home) await fs.rm(home, { recursive: true, force: true });
  });

  it('finalizes an unchanged materialized asset and preserves its payload, refs and native receipt on reclamation', async () => {
    const native = path.join(fixture.directory, 'native-lanes', `${workspace.laneId}.json`);
    const receipt = await fs.readFile(native);
    const artifact = await collect();
    expect(artifact).toMatchObject({ successful: true, disposition: 'applied' });
    expect(await manager.getLaneCloseout(workspace.laneId)).toMatchObject({ recoverable: true });
    const refs = await gitText(fixture.root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remote-cli']);
    expect(await manager.reclaim(workspace.taskId)).toBe(true);
    await expect(fs.lstat(workspace.directory)).rejects.toHaveProperty('code', 'ENOENT');
    expect(await fs.readFile(object())).toEqual(payload);
    expect(await fs.readFile(native)).toEqual(receipt);
    expect(await gitText(fixture.root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remote-cli'])).toBe(refs);
  });

  it('captures a changed payload and reclaims only after explicit retention', async () => {
    const changed = Buffer.from('Changed synthetic asset\n'.repeat(90));
    await fs.writeFile(file(), changed);
    expect(await collect()).toMatchObject({ successful: true, disposition: 'pending' });
    expect(await fs.readFile(object(changed))).toEqual(changed);
    expect(await manager.reclaim(workspace.taskId)).toBe(false);
    const owner = { threadId: 'lfs-fixture', cwd: fixture.root, workspaceGeneration: 0 };
    const inspected = await manager.integrate(owner, workspace.taskId, 'inspect', undefined) as { revision: string };
    await manager.integrate(owner, workspace.taskId, 'retain', inspected.revision);
    await expect(fs.lstat(workspace.directory)).rejects.toHaveProperty('code', 'ENOENT');
    expect(await fs.readFile(object(changed))).toEqual(changed);
  });

  it('finalizes empty LFS files without requiring a pointer or payload object', async () => {
    await fs.writeFile(file(), Buffer.alloc(0));
    const artifact = await collect();
    expect(artifact).toMatchObject({ successful: true, disposition: 'pending' });
    expect(await gitText(workspace.directory, ['cat-file', '-s', 'HEAD:asset.bin'])).toBe('0');
    const owner = { threadId: 'lfs-fixture', cwd: fixture.root, workspaceGeneration: 0 };
    const inspected = await manager.integrate(owner, workspace.taskId, 'inspect', undefined) as { revision: string };
    await manager.integrate(owner, workspace.taskId, 'retain', inspected.revision);
    await expect(fs.lstat(workspace.directory)).rejects.toHaveProperty('code', 'ENOENT');
  });

  it('verifies materialized LFS bytes under the conservative checkout policy', async () => {
    const conservative = new DelegatedWorkspaceManager(path.join(fixture.directory, 'conservative-workspaces'), false);
    const sessions = new DelegatedWorkerSessionStore(path.join(fixture.directory, 'conservative-lanes'));
    const { lane } = await sessions.acquire({ threadId: 'conservative-lfs', backend: 'agy',
      workingDirectory: fixture.root, workspaceGeneration: 0 });
    const source = (await conservative.discover(fixture.root))!;
    const checkout = await conservative.prepare(lane, source, await conservative.baseline(source), randomUUID());
    expect(checkout.disposalPolicy).toBeUndefined();
    await fs.writeFile(path.join(checkout.directory, 'asset.bin'), payload);
    await runGit(checkout.directory, ['add', 'asset.bin']);
    expect(await conservative.collect(checkout, true, { exitConfirmed: true }))
      .toMatchObject({ successful: true, disposition: 'applied' });
    expect(await conservative.reclaim(checkout.taskId)).toBe(true);
    await expect(fs.lstat(checkout.directory)).rejects.toHaveProperty('code', 'ENOENT');
    expect(await fs.readFile(object())).toEqual(payload);
  });

  it('delivers a succeeded no-change worker result through manager finalization and closeout', async () => {
    vi.mocked(os.homedir).mockReturnValue(fixture.directory);
    vi.stubEnv('HOME', fixture.directory);
    vi.stubEnv('USERPROFILE', fixture.directory);
    let workerDirectory = '';
    const groupExit = vi.fn(async () => undefined);
    const coordinator = new DelegationManager(new DirectoryGuard([fixture.directory]), (_guard, _config, cwd) => {
      workerDirectory = cwd!;
      return { execute: async () => ({ success: true, output: 'Synthetic inspection complete' }),
        destroy: async () => undefined, waitForExit: async () => undefined, waitForManagedProcessGroupExit: groupExit,
        abort: async () => true, resetContext: () => undefined, setWorkingDirectory: () => undefined,
        getCurrentWorkingDirectory: () => cwd!,
      } as unknown as IExecutor;
    }, new BackendRegistry(async () => 'fixture 1.0'), undefined, undefined, undefined, undefined,
    new DelegatedWorkspaceManager(path.join(fixture.directory, 'coordinator-workspaces'), true));
    try {
      const scope = coordinator.begin({ thread: { id: 'lfs-coordinator', name: 'default', workingDirectory: fixture.root,
        sessionId: null, createdAt: 0, lastActiveAt: 0 }, cwd: fixture.root, messageId: 'synthetic-message',
        backend: 'codex', config: { type: 'auto' }, onToolUse: vi.fn(), onToolResult: vi.fn(), onNotice: vi.fn(),
        onApproval: vi.fn(), onApprovalResolved: vi.fn() });
      await scope.invoke('remote_cli_delegate', { backend: 'codex', objective: 'Inspect the synthetic asset' }, 'launch');
      expect(await scope.collectPendingResults()).toMatchObject([{ state: 'succeeded', artifact: { disposition: 'applied' } }]);
      expect(groupExit).toHaveBeenCalledOnce();
      expect(await scope.checkArtifactCloseout()).toEqual([]);
      await expect(fs.lstat(workerDirectory)).rejects.toHaveProperty('code', 'ENOENT');
      expect(await fs.readFile(object())).toEqual(payload);
    } finally { await coordinator.destroy(); }
  });

  it('accepts an exact pointer-only checkout only with the matching durable local payload', async () => {
    await fs.writeFile(file(), pointer(payload));
    await runGit(workspace.directory, ['add', 'asset.bin']);
    expect(await collect()).toMatchObject({ successful: true, disposition: 'applied' });
    expect(await manager.reclaim(workspace.taskId)).toBe(true);
    expect(await fs.readFile(object())).toEqual(payload);
  });

  it.each(['missing', 'corrupt', 'wrong-size'])('holds a pointer-only checkout with a %s payload', async condition => {
    await fs.writeFile(file(), pointer(payload));
    await runGit(workspace.directory, ['add', 'asset.bin']);
    if (condition === 'missing') await fs.unlink(object());
    else await fs.writeFile(object(), condition === 'corrupt' ? Buffer.alloc(payload.length, 120) : Buffer.from('short'));
    await expect(collect()).rejects.toThrow('lfs-payload-unverified');
    expect(await manager.getLaneCloseout(workspace.laneId)).toMatchObject({ recoverable: false, holdReason: 'lfs-payload-unverified' });
    await assertHeld('recovery-unverified');
  });

  it('rechecks the durable object before deleting a materialized checkout', async () => {
    await collect();
    await fs.writeFile(object(), Buffer.alloc(payload.length, 120));
    await assertHeld();
    expect(await fs.readFile(file())).toEqual(payload);
  });

  it('does not itself recreate a missing object from materialized checkout bytes', async () => {
    await fs.unlink(object());
    await expect(verifier().verify(file(), await blob(), '100644')).rejects.toThrow('lfs-payload-unverified');
    await expect(fs.lstat(object())).rejects.toHaveProperty('code', 'ENOENT');
    expect(await fs.readFile(file())).toEqual(payload);
  });

  it('supports canonical custom external storage agreed on by source and worker', async () => {
    const custom = path.join(fixture.directory, 'shared lfs store');
    await fs.cp(path.dirname(media()), custom, { recursive: true });
    await runGit(fixture.root, ['config', 'lfs.storage', custom]);
    await collect();
    expect(await manager.reclaim(workspace.taskId)).toBe(true);
    expect(await fs.readFile(object(payload, path.join(custom, 'objects')))).toEqual(payload);
  });

  it('supports relative custom storage resolved by native Git LFS', async () => {
    const custom = path.join(fixture.root, '.git', 'local-lfs');
    await fs.cp(path.dirname(media()), custom, { recursive: true });
    await runGit(fixture.root, ['config', 'lfs.storage', 'local-lfs']);
    await collect();
    expect(await manager.reclaim(workspace.taskId)).toBe(true);
    expect(await fs.readFile(object(payload, path.join(custom, 'objects')))).toEqual(payload);
  });

  it.each(['checkout', 'managed-root', 'worktree-admin'])('rejects custom storage in disposable %s paths', async location => {
    const parent = location === 'checkout' ? workspace.directory : location === 'managed-root' ? storage()
      : path.join(fixture.root, '.git', 'worktrees');
    const custom = path.join(parent, 'unsafe-lfs');
    await fs.cp(path.dirname(media()), custom, { recursive: true });
    await runGit(fixture.root, ['config', 'lfs.storage', custom]);
    await expect(verifier().verify(file(), await blob(), '100644')).rejects.toThrow('lfs-payload-unverified');
    expect(await fs.readFile(object(payload, path.join(custom, 'objects')))).toEqual(payload);
  });

  it('rejects differing source and worktree LFS storage', async () => {
    const custom = path.join(fixture.directory, 'worker-lfs');
    await fs.cp(path.dirname(media()), custom, { recursive: true });
    await runGit(fixture.root, ['config', 'extensions.worktreeConfig', 'true']);
    await runGit(workspace.directory, ['config', '--worktree', 'lfs.storage', custom]);
    await expect(verifier().verify(file(), await blob(), '100644')).rejects.toThrow('lfs-payload-unverified');
  });

  for (const location of ['object', 'parent', 'store', 'checkout-file']) {
    it(`rejects ${location} symlinks without modifying their target`, async context => {
      const target = path.join(fixture.directory, 'link-target');
      const link = location === 'object' ? object() : location === 'parent' ? path.dirname(object())
        : location === 'store' ? media() : file();
      await fs.rename(link, target);
      try { await fs.symlink(target, link, location === 'object' || location === 'checkout-file' ? 'file' : 'dir'); }
      catch (error) {
        if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          context.skip(); return;
        }
        throw error;
      }
      await expect(verifier().verify(file(), await blob(), '100644')).rejects.toThrow('lfs-payload-unverified');
      expect(await fs.lstat(target)).toBeDefined();
    });
  }

  it.each(['invalid-version', 'traversal-oid', 'size-overflow', 'extension', 'oversized', 'noncanonical', 'high-bit'])('rejects %s saved pointers', async kind => {
    let saved = pointer(payload);
    if (kind === 'invalid-version') saved = Buffer.from(saved.toString().replace('/v1', '/v2'));
    if (kind === 'traversal-oid') saved = Buffer.from(saved.toString().replace(hash(payload), '../'.repeat(21) + 'x'));
    if (kind === 'size-overflow') saved = Buffer.from(saved.toString().replace(`size ${payload.length}`, 'size 9007199254740992'));
    if (kind === 'extension') saved = Buffer.concat([saved, Buffer.from('ext-0-custom sha256:abc\n')]);
    if (kind === 'oversized') saved = Buffer.alloc(1025, 120);
    if (kind === 'noncanonical') saved = Buffer.from(saved.toString().replace(`size ${payload.length}`, `size 0${payload.length}`));
    if (kind === 'high-bit') saved[0] |= 0x80;
    const oid = await gitText(fixture.root, ['hash-object', '-w', '--stdin'], saved);
    await expect(verifier().verify(file(), oid, '100644')).rejects.toThrow('lfs-payload-unverified');
  });

  it('rejects modified bytes even if Git filters consider the checkout clean', async () => {
    const saved = await blob();
    await fs.writeFile(file(), Buffer.alloc(payload.length, 120));
    await expect(verifier().verify(file(), saved, '100644')).rejects.toThrow('lfs-payload-unverified');
  });

  it.skipIf(process.platform === 'win32')('rejects changed executable mode on an LFS file', async () => {
    await fs.chmod(file(), 0o755);
    await expect(verifier().verify(file(), await blob(), '100644')).rejects.toThrow('lfs-payload-unverified');
  });

  it('rejects nonregular payload objects', async () => {
    await fs.unlink(object());
    await fs.mkdir(object());
    await expect(verifier().verify(file(), await blob(), '100644')).rejects.toThrow('lfs-payload-unverified');
  });

  it('rejects file replacement between lstat and open and closes the opened handle', async () => {
    const open = fs.open.bind(fs);
    let close: MockInstance<[], Promise<void>> | undefined;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (args[0] === file()) {
        await fs.rename(file(), `${file()}.previous`);
        await fs.writeFile(file(), payload);
      }
      const handle = await open(...args);
      if (args[0] === file()) close = vi.spyOn(handle, 'close');
      return handle;
    });
    await expect(verifier().verify(file(), await blob(), '100644')).rejects.toThrow('lfs-payload-unverified');
    expect(close).toHaveBeenCalledOnce();
  });

  it('preserves hidden-index protection for LFS paths', async () => {
    await collect();
    await runGit(workspace.directory, ['update-index', '--assume-unchanged', 'asset.bin']);
    expect(await manager.reclaim(workspace.taskId)).toBe(false);
    expect(await manager.getLaneCloseout(workspace.laneId)).toMatchObject({ holdReason: 'hidden-index-state' });
  });
});
