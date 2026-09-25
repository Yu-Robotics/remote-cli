import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexSandbox } from '../../src/executor/CodexSandbox';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';

describe('Codex sandbox policy', () => {
  let home: string;
  let project: string;
  let guard: DirectoryGuard;

  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codex-sandbox-test-')));
    project = path.join(home, 'project');
    await fs.mkdir(project);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.spyOn(os, 'tmpdir').mockReturnValue(path.join(home, 'tmp'));
    guard = new DirectoryGuard([home]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(home, { recursive: true, force: true });
  });

  it('leaves unconfigured sessions unchanged and limits development writes without granting the whole whitelist', () => {
    const legacy = new CodexSandbox(guard, undefined, 'legacy');
    expect(legacy.turnOptions(project)).toEqual({});
    expect(legacy.threadOptions(project)).toEqual({});
    const sandbox = new CodexSandbox(guard, { mode: 'workspace-write' }, 'a');
    const turn: any = sandbox.turnOptions(project);
    expect(turn.approvalPolicy).toBe('on-request');
    expect(turn.sandboxPolicy).toMatchObject({ type: 'workspaceWrite', networkAccess: true, excludeSlashTmp: true, excludeTmpdirEnvVar: true });
    const roots = turn.sandboxPolicy.writableRoots;
    expect(roots).toContain(project);
    expect(roots).toContain(path.join(home, 'workspace', '_incoming'));
    expect(roots).toContain(path.join(home, '.npm'));
    expect(roots).toContain(sandbox.temporaryDirectory);
    expect(roots).not.toContain(home);
    expect(roots).not.toContain(path.join(home, 'tmp'));
    expect(sandbox.threadOptions(project)).toMatchObject({ sandbox: 'workspace-write', config: {
      'sandbox_workspace_write.writable_roots': roots,
      'shell_environment_policy.set.TMPDIR': sandbox.temporaryDirectory,
    } });
  });

  it('persists directory grants for one thread and revokes overrides back to global defaults', async () => {
    const defaults = { mode: 'workspace-write' as const, networkAccess: true };
    const sandbox = new CodexSandbox(guard, defaults, 'a');
    const extra = path.join(home, 'other-project');
    sandbox.configure({ ...defaults, writableRoots: [extra], developmentDirectories: false });
    const restored = new CodexSandbox(guard, defaults, 'a');
    expect(restored.writableRoots(project)).toEqual([project, sandbox.temporaryDirectory, extra]);
    expect(new CodexSandbox(guard, defaults, 'b').writableRoots(project)).not.toContain(extra);
    expect(restored.describe(project)).toContain(extra);
    restored.deleteData();
    expect(new CodexSandbox(guard, defaults, 'a').getConfig()).toEqual(defaults);
    await expect(fs.stat(path.join(home, '.remote-cli', 'codex-sandbox', 'a.json'))).rejects.toThrow();
  });

  it('does not silently weaken read-only, disabled-network, or disabled-development policies', () => {
    const sandbox = new CodexSandbox(guard, { mode: 'read-only', networkAccess: false }, 'a');
    expect(sandbox.turnOptions(project)).toEqual({ approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy: { type: 'readOnly', networkAccess: false } });
    expect(sandbox.writableRoots(project)).toEqual([]);
    sandbox.configure({ mode: 'workspace-write', networkAccess: false, developmentDirectories: false });
    expect(sandbox.writableRoots(project)).toEqual([project, sandbox.temporaryDirectory]);
    expect(sandbox.describe(project)).toContain('Network: restricted');
    sandbox.configure({ mode: 'danger-full-access' });
    expect(sandbox.turnOptions(project)).toEqual({ sandboxPolicy: { type: 'dangerFullAccess' } });
    expect(sandbox.threadOptions(project)).toEqual({ sandbox: 'danger-full-access' });
    expect(sandbox.isRestricted()).toBe(false);
  });

  it('canonicalizes explicit paths and refuses to follow changed or broken authorization symlinks', async () => {
    const sandbox = new CodexSandbox(guard, undefined, 'a');
    const target = path.join(home, 'target');
    const alias = path.join(home, 'alias');
    await fs.mkdir(target);
    await fs.symlink(target, alias);
    const extra = sandbox.normalize(path.join(alias, 'new-project'));
    expect(extra).toBe(path.join(target, 'new-project'));
    sandbox.configure({ mode: 'workspace-write', writableRoots: [extra] });
    await fs.symlink(project, extra);
    expect(() => sandbox.turnOptions(project)).toThrow('symbolic-link target');
    expect(() => new CodexSandbox(guard, undefined, 'a')).toThrow('symbolic-link target');
    await fs.symlink(path.join(home, 'missing'), path.join(home, 'broken'));
    expect(() => sandbox.normalize(path.join(home, 'broken'))).toThrow('broken symbolic link');
    await fs.writeFile(path.join(home, 'file'), 'not a directory');
    expect(() => sandbox.normalize(path.join(home, 'file', 'child'))).toThrow('not a directory');
    expect(() => sandbox.normalize('bad\npath')).toThrow('control characters');
    expect(() => new CodexSandbox(guard, undefined, '..')).toThrow('Invalid thread ID');
  });

  it('fails closed on invalid settings and preserves the last grant if saving fails', async () => {
    const sandbox = new CodexSandbox(guard, undefined, 'a');
    sandbox.configure({ mode: 'read-only' });
    expect(() => sandbox.configure({ mode: 'workspace-write', networkAccess: 'false' } as any)).toThrow('Invalid Codex');
    expect(sandbox.getConfig()?.mode).toBe('read-only');
    const store = path.join(home, '.remote-cli', 'codex-sandbox', 'a.json');
    await fs.writeFile(store, '{broken');
    expect(() => new CodexSandbox(guard, undefined, 'a')).toThrow();
    await fs.rm(store);
    await fs.mkdir(store);
    expect(() => sandbox.configure({ mode: 'danger-full-access' })).toThrow();
    expect(sandbox.getConfig()?.mode).toBe('read-only');
  });
});
