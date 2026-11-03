import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { randomUUID, createHash } from 'crypto';
import { captureCheckpoint, checkpointRevision, gitText, runGit } from '../../src/delegation/GitCheckpoint';
import { SharedLinkCapture, delegationSharedSymlinks, parseSharedSymlinkGrants, validateSharedLocations } from '../../src/delegation/SharedSymlinks';
import { DelegatedWorkspaceManager } from '../../src/delegation/DelegatedWorkspaceManager';
import { DelegatedWorkerSessionStore } from '../../src/delegation/DelegatedWorkerSessionStore';
import { ConfigManager } from '../../src/config/ConfigManager';
import { configCommand } from '../../src/commands/config';
import { exportWorkspaceFiles } from '../../src/delegation/WorkspaceDisposal';
import { gitFixture, nestedGitFixture } from './gitFixture';
import { supportsFileSymlinks } from './symlinkFixture';

// All targets, keys, stores and repositories in this suite are synthetic and owned.
describe('explicit project shared links', { timeout: 60_000 }, () => {
  let fixture: Awaited<ReturnType<typeof gitFixture>>;
  let target: string;
  const grant = () => ({ root: fixture.root, path: 'shared-link', target });
  const storage = () => path.join(fixture.directory, 'workspaces');
  beforeEach(async () => {
    fixture = await gitFixture();
    target = path.join(fixture.directory, 'shared.txt');
    await fs.writeFile(target, 'synthetic shared bytes\n');
    await runGit(fixture.root, ['config', 'core.symlinks', 'true']);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(fixture.directory, { recursive: true, force: true }); });
  async function link(absolute = false, replacing = false) {
    const name = replacing ? 'nested' : 'shared-link';
    if (replacing) await fs.rm(path.join(fixture.root, name), { recursive: true });
    const text = absolute ? target : path.relative(fixture.root, target);
    await fs.symlink(text, path.join(fixture.root, name), 'file');
    return { name, text };
  }
  async function setup(disposable = true) {
    await link();
    let configured: unknown = [grant()];
    const manager = new DelegatedWorkspaceManager(storage(), disposable, () => configured);
    const source = (await manager.discover(fixture.root))!;
    const lanes = new DelegatedWorkerSessionStore(path.join(fixture.directory, 'lanes'));
    const { lane } = await lanes.acquire({ threadId: 'synthetic-owner', backend: 'agy', workingDirectory: fixture.root, workspaceGeneration: 0 });
    const input = await manager.baseline(source);
    const workspace = await manager.prepare(lane, source, input, randomUUID());
    const owner = { threadId: lane.threadId, cwd: fixture.root, workspaceGeneration: 0 };
    return { manager, source, lane, input, workspace, owner, configure: (value: unknown) => { configured = value; } };
  }

  it.each([null, {}, '[]', [null], [{ root: 'relative', path: 'x', target: 'relative' }], Array(65).fill({}),
    [{ root: '/', path: '../x', target: '/' }], [{ root: '/', path: '.git/config', target: '/' }],
    [{ root: '/', path: '*', target: '/' }], [{ root: '/', path: 'x', target: '/', unexpected: true }]])('rejects invalid grant data %j', value => {
    expect(() => parseSharedSymlinkGrants(value)).toThrow();
  });
  it('keeps absent grants denied and rejects duplicate, prefix and unknown policy fields', () => {
    expect(delegationSharedSymlinks(undefined)).toEqual([]);
    expect(() => parseSharedSymlinkGrants([grant(), grant()])).toThrow();
    expect(() => delegationSharedSymlinks({ sharedSymlinks: [], enabled: true })).toThrow();
    expect(() => delegationSharedSymlinks('invalid')).toThrow();
  });
  it('bounds aggregate grant bytes even when individual fields and entry counts are valid', () => {
    const grants = Array.from({ length: 16 }, (_, index) => ({ ...grant(), path: `link-${index}`,
      target: path.join(fixture.directory, '\u4e00'.repeat(350)) }));
    expect(JSON.stringify(grants).length).toBeLessThan(16 * 1024);
    expect(Buffer.byteLength(JSON.stringify(grants))).toBeGreaterThan(16 * 1024);
    expect(() => parseSharedSymlinkGrants(grants.slice(0, 4))).not.toThrow();
    expect(() => parseSharedSymlinkGrants(grants)).toThrow('metadata byte limit');
  });
  it('rejects oversized recorded bindings before task closeout can lose readable recovery records', () => {
    const grants = [grant(), { ...grant(), path: 'second-link' }];
    const bindings = grants.map(item => ({ path: item.path, target, kind: 'file' as const, linkText: '\u4e00'.repeat(6000) }));
    expect(bindings.every(item => item.linkText.length < 16 * 1024)).toBe(true);
    expect(() => new SharedLinkCapture(fixture.root, { policy: { root: fixture.root, grants }, bindings })).toThrow('metadata byte limit');
  });
  it.skipIf(!supportsFileSymlinks)('bounds newly discovered binding bytes before a worker checkout is created', async () => {
    await link();
    await fs.symlink(target, path.join(fixture.root, 'second-link'), 'file');
    const grants = [grant(), { ...grant(), path: 'second-link' }];
    const readlink = fs.readlink.bind(fs);
    vi.spyOn(fs, 'readlink').mockImplementation(((file: any, options: any) => {
      if ([path.join(fixture.root, 'shared-link'), path.join(fixture.root, 'second-link')].includes(String(file))) {
        return Promise.resolve(Buffer.from('\u4e00'.repeat(6000)));
      }
      return (readlink as any)(file, options);
    }) as any);
    const context = new SharedLinkCapture(fixture.root, { sharedSymlinks: grants });
    await expect(context.initialize()).rejects.toThrow('metadata byte limit');
  });
  it('supports only the typed config command and validates before saving', async () => {
    const set = vi.fn();
    vi.spyOn(ConfigManager, 'initialize').mockResolvedValue({ get: () => undefined, set } as any);
    expect((await configCommand({ action: 'set', key: 'delegation.sharedSymlinks', value: JSON.stringify([grant()]) })).success).toBe(true);
    expect(set).toHaveBeenCalledWith('delegation', { sharedSymlinks: [grant()] });
    set.mockClear();
    for (const [key, value] of [['delegation', '{}'], ['delegation.sharedSymlinks.x', 'true'], ['delegation.sharedSymlinks', 'null']]) {
      expect((await configCommand({ action: 'set', key, value })).success).toBe(false);
    }
    expect(set).not.toHaveBeenCalled();
    const config = Object.create(ConfigManager.prototype);
    config.config = { delegation: { sharedSymlinks: 'invalid' } };
    expect(config.getConfig().delegation.sharedSymlinks).toBe('invalid');
    expect(() => config.getSharedSymlinks()).toThrow();
  });
  it('allows a valid typed replacement to repair malformed saved grants', async () => {
    const set = vi.fn();
    vi.spyOn(ConfigManager, 'initialize').mockResolvedValue({ get: () => ({ sharedSymlinks: 'invalid' }), set } as any);
    expect((await configCommand({ action: 'set', key: 'delegation.sharedSymlinks', value: '[]' })).success).toBe(true);
    expect(set).toHaveBeenCalledWith('delegation', { sharedSymlinks: [] });
  });
  it('rejects malformed pinned policies and bindings rather than broadening them', () => {
    const good = { policy: { root: fixture.root, grants: [grant()] }, bindings: [{ path: 'shared-link', linkText: '../shared.txt', target, kind: 'file' as const }] };
    for (const options of [
      { ...good, policy: { root: 'relative', grants: [grant()] } },
      { ...good, policy: { root: fixture.root, grants: [{ ...grant(), root: fixture.directory }] } },
      { ...good, bindings: [] },
      { ...good, bindings: [good.bindings[0], good.bindings[0]] },
      { ...good, bindings: [{ ...good.bindings[0], path: '../unsafe' }] },
      { ...good, bindings: [{ ...good.bindings[0], kind: 'special' }] },
      { ...good, bindings: [{ ...good.bindings[0], target: fixture.root }] },
      { ...good, bindings: [{ ...good.bindings[0], linkText: '' }] },
      { ...good, bindings: [{ ...good.bindings[0], unexpected: true }] },
    ]) expect(() => new SharedLinkCapture(fixture.root, options as any)).toThrow();
  });
  it.skipIf(!supportsFileSymlinks)('requires canonical grant locations and rejects aliases and special targets', async () => {
    const alias = path.join(fixture.directory, 'alias.txt'); await fs.symlink(target, alias, 'file');
    await expect(validateSharedLocations([{ ...grant(), target: alias }])).rejects.toThrow();
    await expect(validateSharedLocations([{ ...grant(), root: path.join(fixture.root, 'missing') }])).rejects.toThrow();
    const lstat = fs.lstat.bind(fs);
    vi.spyOn(fs, 'lstat').mockImplementation((async (file: any, options: any) => {
      if (file === target) return { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => false };
      return (lstat as any)(file, options);
    }) as any);
    await expect(validateSharedLocations([grant()])).rejects.toThrow();
  });
  it.skipIf(!supportsFileSymlinks)('requires an exact project and rejects stale policy or target alias retargeting', async () => {
    const alias = path.join(fixture.root, 'ignored-alias');
    await fs.appendFile(path.join(fixture.root, '.gitignore'), 'ignored-alias\n');
    await fs.symlink(target, alias, 'file');
    await fs.symlink('ignored-alias', path.join(fixture.root, 'shared-link'), 'file');
    const saved = await captureCheckpoint(fixture.root, { sharedSymlinks: [grant()] });
    await expect(captureCheckpoint(fixture.root, { sharedSymlinks: [{ ...grant(), root: fixture.directory }] })).rejects.toThrow();
    const other = path.join(fixture.directory, 'other.txt'); await fs.writeFile(other, 'synthetic other bytes\n');
    await fs.unlink(alias); await fs.symlink(other, alias, 'file');
    await expect(captureCheckpoint(fixture.root, { policy: saved.sharedSymlinkPolicy, bindings: saved.sharedLinks })).rejects.toThrow();
    expect(await fs.readlink(path.join(fixture.root, 'shared-link'))).toBe('ignored-alias');
    expect(await fs.readFile(other, 'utf8')).toBe('synthetic other bytes\n');
  });
  it('rejects files inside a bare Git administrative tree', async () => {
    const bare = path.join(fixture.directory, 'bare'); await fs.mkdir(bare);
    await runGit(bare, ['init', '--bare']);
    await expect(validateSharedLocations([{ ...grant(), target: path.join(bare, 'HEAD') }])).rejects.toThrow();
  });
  it.skipIf(!supportsFileSymlinks).each([false, true])('captures only the original link node with an exact grant (absolute=%s)', async absolute => {
    const { text } = await link(absolute);
    const index = await fs.readFile(path.join(fixture.root, '.git', 'index'));
    await expect(captureCheckpoint(fixture.root)).rejects.toThrow(/symbolic[- ]link/);
    const checkpoint = await captureCheckpoint(fixture.root, { sharedSymlinks: [grant()] });
    expect(checkpoint.sharedLinks).toEqual([{ path: 'shared-link', linkText: text, target, kind: 'file' }]);
    expect(await gitText(fixture.root, ['show', `${checkpoint.tree}:shared-link`])).toBe(text);
    expect(await gitText(fixture.root, ['ls-tree', checkpoint.tree, '--', 'shared-link'])).toMatch(/^120000 blob /);
    expect(await gitText(fixture.root, ['ls-tree', '-r', '--name-only', checkpoint.tree])).not.toContain('shared.txt');
    expect(await fs.readFile(path.join(fixture.root, '.git', 'index'))).toEqual(index);
    expect(await fs.readlink(path.join(fixture.root, 'shared-link'))).toBe(text);
    expect(await gitText(fixture.root, ['rev-parse', 'HEAD'])).toBe(fixture.head);
    expect(checkpoint.revision).not.toBe(checkpointRevision(checkpoint.head, checkpoint.tree, index));
  });
  it.skipIf(!supportsFileSymlinks)('allows an external replacement of cached children only with the matching grant', async () => {
    const { text } = await link(false, true);
    const index = await fs.readFile(path.join(fixture.root, '.git', 'index'));
    await expect(captureCheckpoint(fixture.root)).rejects.toThrow(/symbolic[- ]link/);
    await fs.appendFile(path.join(fixture.root, '.gitignore'), 'nested\n');
    const result = await captureCheckpoint(fixture.root, { sharedSymlinks: [{ ...grant(), path: 'nested' }] });
    expect(await gitText(fixture.root, ['show', `${result.tree}:nested`])).toBe(text);
    expect(await fs.readFile(path.join(fixture.root, '.git', 'index'))).toEqual(index);
  });
  it.skipIf(!supportsFileSymlinks).each([false, true])('shares directory bytes without enumerating or capturing them (absolute=%s)', async (absolute, context) => {
    await fs.unlink(target); target = path.join(fixture.directory, 'shared-directory'); await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'marker.txt'), 'synthetic shared marker\n');
    const text = absolute ? target : path.relative(fixture.root, target);
    try { await fs.symlink(text, path.join(fixture.root, 'shared-link'), 'dir'); }
    catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { context.skip(); return; }
      throw error;
    }
    const readdir = fs.readdir.bind(fs);
    vi.spyOn(fs, 'readdir').mockImplementation(((file: any, ...args: any[]) => {
      if (file === target || String(file).startsWith(`${path.join(fixture.root, 'shared-link')}${path.sep}`)) throw new Error('Shared directory was enumerated');
      return (readdir as any)(file, ...args);
    }) as any);
    const manager = new DelegatedWorkspaceManager(storage(), true, () => [grant()]);
    const source = (await manager.discover(fixture.root))!;
    const input = await manager.baseline(source);
    expect(input.sharedLinks?.[0].kind).toBe('dir');
    const lanes = new DelegatedWorkerSessionStore(path.join(fixture.directory, 'lanes'));
    const { lane } = await lanes.acquire({ threadId: 'directory-owner', backend: 'agy', workingDirectory: fixture.root, workspaceGeneration: 0 });
    const workspace = await manager.prepare(lane, source, input, randomUUID());
    await fs.writeFile(path.join(workspace.directory, 'shared-link', 'marker.txt'), 'direct directory edit\n');
    const result = await manager.collect(workspace, true, { exitConfirmed: true });
    expect(result.changedFiles).toEqual([]);
    const owner = { threadId: lane.threadId, cwd: fixture.root, workspaceGeneration: 0 };
    const view = await manager.integrate(owner, workspace.taskId, 'inspect', undefined) as any;
    await manager.integrate(owner, workspace.taskId, 'retain', view.revision);
    expect(await fs.readFile(path.join(target, 'marker.txt'), 'utf8')).toBe('direct directory edit\n');
    expect(await fs.readlink(path.join(fixture.root, 'shared-link'))).toBe(text);
  });
  it.skipIf(!supportsFileSymlinks)('applies ordinary output beside an ignored shared replacement without mutating stale source index children', async () => {
    const { text } = await link(false, true);
    await fs.appendFile(path.join(fixture.root, '.gitignore'), 'nested\n');
    const selected = [{ ...grant(), path: 'nested' }];
    const manager = new DelegatedWorkspaceManager(storage(), true, () => selected);
    const source = (await manager.discover(fixture.root))!;
    const lanes = new DelegatedWorkerSessionStore(path.join(fixture.directory, 'lanes'));
    const { lane } = await lanes.acquire({ threadId: 'replacement-owner', backend: 'agy', workingDirectory: fixture.root, workspaceGeneration: 0 });
    const before = await fs.readFile(path.join(fixture.root, '.git', 'index'));
    const workspace = await manager.prepare(lane, source, await manager.baseline(source), randomUUID());
    await fs.writeFile(path.join(workspace.directory, 'ordinary.txt'), 'ordinary beside link\n');
    await manager.collect(workspace, true, { exitConfirmed: true });
    const owner = { threadId: lane.threadId, cwd: fixture.root, workspaceGeneration: 0 };
    const inspected = await manager.integrate(owner, workspace.taskId, 'inspect', undefined) as any;
    await manager.integrate(owner, workspace.taskId, 'apply', inspected.revision);
    expect(await fs.readlink(path.join(fixture.root, 'nested'))).toBe(text);
    expect(await fs.readFile(path.join(fixture.root, 'ordinary.txt'), 'utf8')).toBe('ordinary beside link\n');
    expect(await fs.readFile(path.join(fixture.root, '.git', 'index'))).toEqual(before);
    expect(await fs.readFile(target, 'utf8')).toBe('synthetic shared bytes\n');
  });
  it.skipIf(!supportsFileSymlinks)('persists a blocked lane on partial mapping failure and never rewrites original links', async () => {
    const { text } = await link();
    await fs.symlink(text, path.join(fixture.root, 'zz-link'), 'file');
    const grants = [grant(), { ...grant(), path: 'zz-link' }];
    const manager = new DelegatedWorkspaceManager(storage(), true, () => grants);
    const source = (await manager.discover(fixture.root))!;
    const lanes = new DelegatedWorkerSessionStore(path.join(fixture.directory, 'lanes'));
    const { lane } = await lanes.acquire({ threadId: 'partial-owner', backend: 'agy', workingDirectory: fixture.root, workspaceGeneration: 0 });
    const input = await manager.baseline(source);
    const symlink = fs.symlink.bind(fs);
    vi.spyOn(fs, 'symlink').mockImplementation(async (pointer, destination, type) => {
      if (pointer === target && String(destination).endsWith(`${path.sep}zz-link`)) throw new Error('Synthetic mapping failure');
      return symlink(pointer, destination, type);
    });
    await expect(manager.prepare(lane, source, input, randomUUID())).rejects.toThrow('Synthetic mapping failure');
    const record = JSON.parse(await fs.readFile(path.join(storage(), 'lanes', `${lane.id}.json`), 'utf8'));
    expect(record.blocked).toBe(true);
    expect((await fs.lstat(record.directory)).isDirectory()).toBe(true);
    expect(await fs.readlink(path.join(fixture.root, 'shared-link'))).toBe(text);
    expect(await fs.readlink(path.join(fixture.root, 'zz-link'))).toBe(text);
    expect(await fs.readFile(target, 'utf8')).toBe('synthetic shared bytes\n');
    await expect(manager.prepare(lane, source, input, randomUUID())).rejects.toThrow('unresolved');
  });
  it.skipIf(!supportsFileSymlinks)('normalizes worker pointers in the temporary index and allows shared content replacement', async () => {
    const { manager, workspace, input } = await setup();
    const physical = path.join(workspace.directory, 'shared-link');
    expect(await fs.readlink(physical)).toBe(target);
    const replacement = path.join(fixture.directory, 'replacement.txt');
    await fs.writeFile(replacement, 'atomic shared edit\n'); await fs.rename(replacement, target);
    await fs.writeFile(physical, 'direct shared edit\n');
    expect(await fs.readFile(target, 'utf8')).toBe('direct shared edit\n');
    const view = await manager.collect(workspace, true, { exitConfirmed: true });
    expect(view.changedFiles).toEqual([]);
    expect(view.sharedLinkPaths).toEqual(['shared-link']);
    expect(view.sharingWarning).toContain('not captured');
    expect(await gitText(fixture.root, ['show', `${view.outputCommit}:shared-link`])).toBe(input.sharedLinks![0].linkText);
    expect(await fs.readlink(physical)).toBe(target);
    expect(await fs.readlink(path.join(fixture.root, 'shared-link'))).toBe(input.sharedLinks![0].linkText);
  });
  it.skipIf(!supportsFileSymlinks)('collects and applies ordinary changes after restart using recorded grants, then disposes and reuses without touching shared bytes', async () => {
    const { manager, workspace, owner, source, lane, input, configure } = await setup();
    const index = await fs.readFile(path.join(fixture.root, '.git', 'index'));
    await fs.writeFile(path.join(workspace.directory, 'ordinary.txt'), 'synthetic ordinary output\n');
    await manager.collect(workspace, true, { exitConfirmed: true });
    configure([]);
    await expect(manager.baseline(source)).rejects.toThrow(/symbolic[- ]link/);
    const restarted = new DelegatedWorkspaceManager(storage(), true, () => { throw new Error('Current policy must not broaden existing artifacts'); });
    const view = await restarted.integrate(owner, workspace.taskId, 'inspect', undefined) as any;
    expect(view.changedFiles).toEqual(['ordinary.txt']);
    await restarted.integrate(owner, workspace.taskId, 'apply', view.revision);
    expect(await fs.readFile(path.join(fixture.root, 'ordinary.txt'), 'utf8')).toBe('synthetic ordinary output\n');
    expect(await fs.readlink(path.join(fixture.root, 'shared-link'))).toBe(input.sharedLinks![0].linkText);
    expect(await fs.readFile(path.join(fixture.root, '.git', 'index'))).toEqual(index);
    expect(await fs.readFile(target, 'utf8')).toBe('synthetic shared bytes\n');
    await expect(fs.lstat(workspace.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    const next = new DelegatedWorkspaceManager(storage(), true, () => [grant()]);
    const reused = await next.prepare(lane, source, await next.baseline(source), randomUUID());
    expect(await fs.readlink(path.join(reused.directory, 'shared-link'))).toBe(target);
    expect(await fs.readFile(target, 'utf8')).toBe('synthetic shared bytes\n');
  });
  it.skipIf(!supportsFileSymlinks)('retains output and reuses a non-disposed mapped checkout without writing a source link', async () => {
    const { manager, workspace, owner, source, lane, input } = await setup(false);
    await fs.writeFile(path.join(workspace.directory, 'ordinary.txt'), 'retained output\n');
    await manager.collect(workspace, true);
    const view = await manager.integrate(owner, workspace.taskId, 'inspect', undefined) as any;
    await manager.integrate(owner, workspace.taskId, 'retain', view.revision);
    const next = await manager.prepare(lane, source, await manager.baseline(source), randomUUID());
    expect(await fs.readlink(path.join(next.directory, 'shared-link'))).toBe(target);
    expect(await fs.readlink(path.join(fixture.root, 'shared-link'))).toBe(input.sharedLinks![0].linkText);
    expect(await fs.readFile(target, 'utf8')).toBe('synthetic shared bytes\n');
  });
  it.skipIf(!supportsFileSymlinks).each(['deleted', 'retargeted', 'same-pointer', 'file', 'staged'])('holds evidence when a worker shared link is %s', async kind => {
    const { manager, workspace } = await setup();
    const file = path.join(workspace.directory, 'shared-link');
    if (kind === 'staged') await runGit(workspace.directory, ['add', '--', 'shared-link']);
    else {
      await fs.unlink(file);
      if (kind === 'same-pointer') await fs.symlink(target, file, 'file');
      if (kind === 'retargeted') await fs.symlink(path.join(fixture.root, 'source.txt'), file, 'file');
      if (kind === 'file') await fs.writeFile(file, 'replacement node\n');
    }
    if (kind === 'staged') {
      // Staging the expected physical delta is also unauthorized index state.
      await expect(manager.collect(workspace, true, { exitConfirmed: true })).rejects.toThrow('staged');
    } else await expect(manager.collect(workspace, true, { exitConfirmed: true })).rejects.toThrow();
    expect((await fs.lstat(workspace.directory)).isDirectory()).toBe(true);
    expect(await fs.readFile(target, 'utf8')).toBe('synthetic shared bytes\n');
  });
  it.skipIf(!supportsFileSymlinks)('retains the checkout when its shared link node is replaced after collection', async () => {
    const { manager, workspace, owner, lane } = await setup();
    await fs.writeFile(path.join(workspace.directory, 'ordinary.txt'), 'pending synthetic output\n');
    await manager.collect(workspace, true, { exitConfirmed: true });
    const file = path.join(workspace.directory, 'shared-link');
    await fs.unlink(file);
    await fs.symlink(target, file, 'file');
    const view = await manager.integrate(owner, workspace.taskId, 'inspect', undefined) as any;
    await manager.integrate(owner, workspace.taskId, 'retain', view.revision);
    const record = JSON.parse(await fs.readFile(path.join(storage(), 'lanes', `${lane.id}.json`), 'utf8'));
    expect(record.cleanup).toBeDefined();
    expect((await fs.lstat(workspace.directory)).isDirectory()).toBe(true);
    expect(await fs.readFile(path.join(workspace.directory, 'ordinary.txt'), 'utf8')).toBe('pending synthetic output\n');
    expect(await fs.readFile(target, 'utf8')).toBe('synthetic shared bytes\n');
  });
  it.skipIf(!supportsFileSymlinks)('rejects disappeared, cyclic, and changed-kind targets', async () => {
    const { manager, workspace } = await setup();
    await fs.unlink(target); await fs.mkdir(target);
    await expect(manager.collect(workspace, true)).rejects.toThrow();
    await fs.rmdir(target); await fs.symlink(target, target, 'file');
    await expect(manager.collect(workspace, true)).rejects.toThrow();
    await fs.unlink(target);
    await expect(manager.collect(workspace, true)).rejects.toThrow();
  });
  it.skipIf(!supportsFileSymlinks)('rejects Git metadata, managed storage, and repository-root targets without traversing them', async () => {
    for (const prohibited of [path.join(fixture.root, '.git'), fixture.root]) {
      await fs.mkdir(prohibited, { recursive: true });
      await expect(validateSharedLocations([{ ...grant(), target: prohibited }])).rejects.toThrow();
    }
    await fs.mkdir(storage());
    const forbidden = new SharedLinkCapture(fixture.root, { sharedSymlinks: [{ ...grant(), target: storage() }], forbiddenTargets: [storage()] });
    await expect(forbidden.initialize()).rejects.toThrow();
    const externalRepo = path.join(fixture.directory, 'external-repo'); await fs.mkdir(externalRepo);
    await runGit(externalRepo, ['init']);
    await expect(validateSharedLocations([{ ...grant(), target: externalRepo }])).rejects.toThrow();
  });
  it.skipIf(!supportsFileSymlinks)('does not use a regular-file fallback when Git has core.symlinks=false', async () => {
    await link(); await runGit(fixture.root, ['config', 'core.symlinks', 'false']);
    const manager = new DelegatedWorkspaceManager(storage(), true, () => [grant()]);
    const lanes = new DelegatedWorkerSessionStore(path.join(fixture.directory, 'lanes'));
    const source = (await manager.discover(fixture.root))!;
    const { lane } = await lanes.acquire({ threadId: 'owner', backend: 'agy', workingDirectory: fixture.root, workspaceGeneration: 0 });
    await expect(manager.prepare(lane, source, await manager.baseline(source), randomUUID())).rejects.toThrow('native symbolic links');
    const saved = JSON.parse(await fs.readFile(path.join(storage(), 'lanes', `${lane.id}.json`), 'utf8'));
    expect(saved.blocked).toBe(true);
    expect(await fs.readFile(target, 'utf8')).toBe('synthetic shared bytes\n');
  });
  it.skipIf(!supportsFileSymlinks)('keeps exports and LFS verification from following a shared link', async () => {
    const { manager, workspace } = await setup();
    const exports = path.join(fixture.directory, 'exports'); await fs.mkdir(exports);
    await expect(exportWorkspaceFiles(workspace.directory, exports, ['shared-link'])).rejects.toThrow();
    await fs.writeFile(path.join(workspace.directory, '.gitattributes'), 'shared-link filter=lfs\n');
    await expect(manager.collect(workspace, true, { exitConfirmed: true })).rejects.toThrow();
    expect(await fs.readFile(target, 'utf8')).toBe('synthetic shared bytes\n');
  });
  it.skipIf(!supportsFileSymlinks).each([false, true])('rejects shared grants in nested repositories, including ignored links (ignored=%s)', async ignored => {
    const nested = await nestedGitFixture(fixture, 'module');
    await fs.symlink(path.relative(nested, target), path.join(nested, 'shared-link'), 'file');
    if (ignored) await fs.appendFile(path.join(nested, '.gitignore'), 'shared-link\n');
    await expect(captureCheckpoint(fixture.root, { sharedSymlinks: [{ ...grant(), path: 'module/shared-link' }] })).rejects.toThrow('inside nested repositories');
  });
  it('preserves the exact legacy revision encoding without shared metadata', async () => {
    const old = createHash('sha256').update('head').update('\0').update('tree').update('\0').update(Buffer.from('index')).digest('hex');
    expect(checkpointRevision('head', 'tree', Buffer.from('index'))).toBe(old);
  });
});
