import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';
import { DirectoryBrowser, DIRECTORY_LIMITS } from '../../src/settings/DirectoryBrowser';
import { SettingsAdmission } from '../../src/settings/SettingsAdmission';
import type { SettingsActionMessage, SettingsMenu } from '../../src/types/Settings';

describe('directory browser snapshots and Apply admission', () => {
  let root: string;
  let other: string;
  let state: { cwd: string; revision: string; backend: 'codex'; threadName: string };
  let busy: boolean;
  let now: number;
  let guard: DirectoryGuard;
  let browser: DirectoryBrowser;
  let apply: ReturnType<typeof vi.fn>;
  let admission: SettingsAdmission;
  let serial: number;
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'directory-browser-')));
    other = path.join(root, 'root-two');
    await fs.mkdir(other);
    vi.spyOn(os, 'homedir').mockReturnValue(root);
    guard = new DirectoryGuard([root]);
    state = { cwd: root, revision: 'revision-a', backend: 'codex', threadName: 'project' };
    busy = false; now = 1_000; serial = 0;
    admission = new SettingsAdmission();
    apply = vi.fn(async (_id: string, target: string) => { state.cwd = target; state.revision = 'revision-b'; return { success: true, output: 'Changed directory.' }; });
    browser = new DirectoryBrowser({ guard, state: id => id === 'thread-a' ? state : undefined,
      busy: () => busy, exclusive: (id, body) => admission.mutation(id, body), apply, now: () => now });
  });
  afterEach(async () => { browser.destroy(); vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
  const open = () => browser.open('thread-a', 'owner');
  const request = (menu: SettingsMenu, operation: 'view' | 'apply', value?: string, fields: Partial<SettingsActionMessage> = {}): SettingsActionMessage => ({
    type: 'settings_action', messageId: `request-${++serial}`, openId: 'owner', threadId: 'thread-a', snapshotId: menu.snapshotId,
    operation, value, timestamp: now, ...fields,
  });

  it('lists only directories including hidden directories, with no model calls or context changes', async () => {
    await fs.mkdir(path.join(root, 'project-a'));
    await fs.mkdir(path.join(root, '.hidden'));
    await fs.writeFile(path.join(root, 'file.txt'), 'fixture');
    const menu = await open();
    expect(menu.kind).toBe('directory');
    expect(menu.choices.map(choice => choice.label)).toEqual(['.hidden', 'project-a', 'root-two']);
    expect(menu.directory?.parent).toBeUndefined();
    expect(menu.choices.every(choice => !choice.value.includes(root))).toBe(true);
    expect(apply).not.toHaveBeenCalled();
  });

  it('navigates down, up and to roots without applying; only explicit Apply changes directory', async () => {
    const first = await open();
    const child = await browser.action(request(first, 'view', first.choices[0].value));
    expect(child.success).toBe(true);
    expect(child.menu?.directory?.browsingPath).toBe(other);
    expect(state.cwd).toBe(root);
    const parent = await browser.action(request(child.menu!, 'view', child.menu!.directory!.parent));
    expect(parent.menu?.directory?.browsingPath).toBe(root);
    const roots = await browser.action(request(parent.menu!, 'view', parent.menu!.directory!.roots));
    expect(roots.menu?.directory?.apply).toBeUndefined();
    const selected = await browser.action(request(roots.menu!, 'view', roots.menu!.choices[0].value));
    const applied = await browser.action(request(selected.menu!, 'apply', selected.menu!.directory!.apply));
    expect(applied.success).toBe(true);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('does not list symlinks to inside or outside directories', async () => {
    await fs.symlink(other, path.join(root, 'inside-link'), 'dir');
    await fs.symlink(os.tmpdir(), path.join(root, 'outside-link'), 'dir');
    const menu = await open();
    expect(menu.choices.map(choice => choice.label)).toEqual(['root-two']);
    expect(menu.directory?.notice).toContain('Symbolic-link directories are not listed');
  });

  it('opens only allowed roots when the current directory is missing or unauthorized', async () => {
    state.cwd = path.join(root, 'missing');
    const menu = await open();
    expect(menu.directory?.browsingPath).toBe('Allowed directories');
    expect(menu.directory?.apply).toBeUndefined();
    expect(menu.choices.map(choice => choice.label)).toEqual([root]);
  });

  it('stops Parent at the nearest nested allowed root', async () => {
    guard.addAllowedDirectory(other);
    state.cwd = other;
    expect((await open()).directory?.parent).toBeUndefined();
  });

  it.each(['busy', 'changed-state', 'expired', 'policy', 'removed', 'replaced', 'symlink'])('rejects unsafe Apply after %s', async mode => {
    state.cwd = other;
    const menu = await open();
    if (mode === 'busy') busy = true;
    if (mode === 'changed-state') state.revision = 'new-revision';
    if (mode === 'expired') now += DIRECTORY_LIMITS.ttl + 1;
    if (mode === 'policy') guard.addAllowedDirectory(path.join(root, 'extra'));
    if (['removed', 'replaced', 'symlink'].includes(mode)) {
      await fs.rename(other, `${other}-old`);
      if (mode === 'replaced') await fs.mkdir(other);
      if (mode === 'symlink') await fs.symlink(`${other}-old`, other, 'dir');
    }
    expect((await browser.action(request(menu, 'apply', menu.directory?.apply))).success).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it('rejects an ancestor replacement even when the final directory inode is unchanged', async () => {
    const parent = path.join(root, 'parent');
    const child = path.join(parent, 'child');
    await fs.mkdir(child, { recursive: true });
    state.cwd = child;
    const menu = await open();
    await fs.rename(parent, `${parent}-old`);
    await fs.mkdir(parent);
    await fs.rename(path.join(`${parent}-old`, 'child'), child);
    expect((await browser.action(request(menu, 'apply', menu.directory?.apply))).success).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it('deduplicates exact retries after Apply and rejects reused IDs with changed values', async () => {
    const menu = await open();
    const command = request(menu, 'apply', menu.directory?.apply);
    const [a, b] = await Promise.all([browser.action(command), browser.action(command)]);
    expect(a).toEqual(b);
    expect(a.success).toBe(true);
    expect((await browser.action(command)).success).toBe(true);
    expect((await browser.action({ ...command, value: 'altered' })).success).toBe(false);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('rejects forged owners, threads, tokens, scope and native settings operations', async () => {
    const menu = await open();
    for (const fields of [{ openId: 'other' }, { threadId: 'other' }, { value: root }, { scope: 'all' as const },
      { targetBackend: 'claude' as const }, { operation: 'reset' as const }, { messageId: '' }]) {
      expect((await browser.action(request(menu, 'apply', menu.directory?.apply, fields))).success).toBe(false);
    }
    expect((await browser.action(request(menu, 'view', menu.directory?.apply))).success).toBe(false);
    expect((await browser.action(request(menu, 'apply', menu.directory?.roots))).success).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it('allows busy navigation and serializes Apply against command admission', async () => {
    busy = true;
    const menu = await open();
    const refreshed = await browser.action(request(menu, 'view', menu.directory?.refresh));
    expect(refreshed.menu?.busy).toBe(true);
    busy = false;
    await admission.command('thread-a', 'running', async () => {
      expect((await browser.action(request(refreshed.menu!, 'apply', refreshed.menu!.directory?.apply))).success).toBe(false);
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it('invalidates stale snapshots on disconnect and destroy', async () => {
    const menu = await open();
    browser.invalidate();
    expect((await browser.action(request(menu, 'apply', menu.directory?.apply))).success).toBe(false);
    browser.destroy();
    await expect(open()).rejects.toThrow();
  });

  it('bounds directory choices and explicitly describes partial results', async () => {
    await Promise.all(Array.from({ length: DIRECTORY_LIMITS.choices + 1 }, (_, index) => fs.mkdir(path.join(root, `dir-${index}`))));
    const menu = await open();
    expect(menu.choices).toHaveLength(DIRECTORY_LIMITS.choices);
    expect(menu.directory?.notice).toContain('Partial listing');
  });

  it('reclaims superseded owner snapshots and allows Refresh at the global snapshot limit', async () => {
    for (let index = 0; index < DIRECTORY_LIMITS.snapshots + 1; index++) await open();
    browser.invalidate();
    const menus = [];
    for (let index = 0; index < DIRECTORY_LIMITS.snapshots; index++) menus.push(await browser.open('thread-a', `owner-${index}`));
    const menu = menus[0];
    const result = await browser.action(request(menu, 'view', menu.directory?.refresh, { openId: 'owner-0' }));
    expect(result.success).toBe(true);
    expect(result.menu?.snapshotId).not.toBe(menu.snapshotId);
    await expect(browser.open('thread-a', 'overflow')).rejects.toThrow('Too many');
  });

  it('rejects missing and symbolic allowed roots instead of reading outside them', async () => {
    browser.destroy();
    const link = path.join(root, 'root-link');
    await fs.symlink(other, link, 'dir');
    browser = new DirectoryBrowser({ guard: new DirectoryGuard([link, path.join(root, 'absent')]), state: () => state,
      busy: () => false, exclusive: (id, body) => admission.mutation(id, body), apply });
    await expect(open()).rejects.toThrow('No readable');
  });

  it('contains Apply failures without claiming success or deleting the cached failure receipt', async () => {
    apply.mockRejectedValueOnce(new Error('synthetic persistence failure'));
    const menu = await open();
    const command = request(menu, 'apply', menu.directory?.apply);
    const result = await browser.action(command);
    expect(result.success).toBe(false);
    expect(result.error).toContain('partially cleared');
    expect(await browser.action(command)).toEqual(result);
    expect(apply).toHaveBeenCalledTimes(1);
  });
});
