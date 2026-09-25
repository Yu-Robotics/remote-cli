import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import os from 'os';
import path from 'path';
import { ClaudeSandbox } from '../../src/executor/claude/ClaudeSandbox';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';

describe('ClaudeSandbox', () => {
  let home: string;
  const threadId = 'sandbox-test';
  let storePath: string;
  let guard: DirectoryGuard;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sandbox-test-')));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    storePath = path.join(home, '.remote-cli', 'claude-sandbox', `${threadId}.json`);
    guard = new DirectoryGuard([process.cwd(), os.tmpdir()]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('returns no spawn settings when unconfigured or in full-access mode', () => {
    expect(new ClaudeSandbox(guard, undefined, threadId).spawnSettings(process.cwd())).toBeUndefined();
    const full = new ClaudeSandbox(guard, { mode: 'danger-full-access' }, threadId);
    expect(full.isRestricted()).toBe(false);
    expect(full.spawnSettings(process.cwd())).toBeUndefined();
  });

  it('maps workspace-write mode to auto-allow sandbox settings with extra writable roots', () => {
    const extra = path.join(os.tmpdir(), `claude-sandbox-extra-${Date.now()}`);
    fs.mkdirSync(extra, { recursive: true });
    const sandbox = new ClaudeSandbox(guard, { mode: 'workspace-write', writableRoots: [extra] }, threadId);
    const settings = sandbox.spawnSettings(process.cwd()) as any;
    expect(settings.sandbox.enabled).toBe(true);
    expect(settings.sandbox.autoAllowBashIfSandboxed).toBe(true);
    expect(settings.sandbox.filesystem.allowWrite).toEqual([fs.realpathSync(extra)]);
    expect(settings.sandbox.network).toEqual({});
    fs.rmdirSync(extra);
  });

  it('maps read-only mode to a working-directory write denial', () => {
    const sandbox = new ClaudeSandbox(guard, { mode: 'read-only' }, threadId);
    const settings = sandbox.spawnSettings(process.cwd()) as any;
    expect(settings.sandbox.filesystem.denyWrite).toEqual([fs.realpathSync(process.cwd())]);
    expect(settings.sandbox.filesystem.allowWrite).toBeUndefined();
  });

  it.each(['workspace-write', 'read-only'] as const)('requires native sandbox enforcement and explicit write approvals in %s mode', mode => {
    const settings = new ClaudeSandbox(guard, { mode }, threadId).spawnSettings(process.cwd()) as any;
    expect(settings.sandbox.failIfUnavailable).toBe(true);
    // These ask rules must override previously saved native allow rules.
    expect(settings.permissions.ask).toEqual(expect.arrayContaining(['Write', 'Edit', 'NotebookEdit', 'Bash']));
  });

  it('checks executable dependencies on PATH rather than a fixed installation directory', () => {
    vi.spyOn(os, 'platform').mockReturnValue('linux');
    vi.stubEnv('PATH', home);
    const sandbox = new ClaudeSandbox(guard, { mode: 'read-only' }, threadId);
    expect(() => sandbox.assertAvailable(home)).toThrow('bwrap, socat');
    fs.writeFileSync(path.join(home, 'bwrap'), '', { mode: 0o700 });
    expect(() => sandbox.assertAvailable(home)).toThrow('socat');
    fs.writeFileSync(path.join(home, 'socat'), '', { mode: 0o700 });
    expect(() => sandbox.assertAvailable(home)).not.toThrow();
    fs.chmodSync(path.join(home, 'socat'), 0o600);
    expect(() => sandbox.assertAvailable(home)).toThrow('socat');
  });

  it('allows native macOS enforcement but rejects unsupported platforms in restricted mode', () => {
    const sandbox = new ClaudeSandbox(guard, { mode: 'workspace-write' }, threadId);
    const platform = vi.spyOn(os, 'platform').mockReturnValue('darwin');
    expect(() => sandbox.assertAvailable(home)).not.toThrow();
    platform.mockReturnValue('win32');
    expect(() => sandbox.assertAvailable(home)).toThrow('Native Windows is not supported');
    expect(() => new ClaudeSandbox(guard, undefined).assertAvailable(home)).not.toThrow();
    expect(() => new ClaudeSandbox(guard, { mode: 'danger-full-access' }).assertAvailable(home)).not.toThrow();
  });

  it('hard-denies network egress when networkAccess is false', () => {
    const sandbox = new ClaudeSandbox(guard, { mode: 'workspace-write', networkAccess: false }, threadId);
    const settings = sandbox.spawnSettings(process.cwd()) as any;
    expect(settings.sandbox.network).toEqual({ allowedDomains: [], strictAllowlist: true });
  });

  it('persists per-thread overrides and reloads them', () => {
    const sandbox = new ClaudeSandbox(guard, undefined, threadId);
    sandbox.configure({ mode: 'read-only' });
    expect(fs.existsSync(storePath)).toBe(true);
    expect(fs.statSync(storePath).mode & 0o777).toBe(0o600);
    const reloaded = new ClaudeSandbox(guard, undefined, threadId);
    expect(reloaded.getConfig()?.mode).toBe('read-only');
    reloaded.deleteData();
    expect(fs.existsSync(storePath)).toBe(false);
  });

  it('fails closed on tampered or invalid stored configuration', () => {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify({ mode: 'nonsense' }));
    expect(() => new ClaudeSandbox(guard, undefined, threadId)).toThrow('Invalid Claude sandbox configuration');
  });

  it('rejects invalid thread ids and control characters in directories', () => {
    expect(() => new ClaudeSandbox(guard, undefined, '../escape')).toThrow('Invalid thread ID');
    const sandbox = new ClaudeSandbox(guard, { mode: 'workspace-write' }, threadId);
    expect(() => sandbox.normalize('bad\0path')).toThrow('control characters');
    // An existing ancestor that is a file cannot contain a sandbox directory.
    const fileParent = path.join(os.tmpdir(), `claude-sandbox-file-${Date.now()}`);
    fs.writeFileSync(fileParent, 'x');
    expect(() => sandbox.normalize(path.join(fileParent, 'sub'))).toThrow('not a directory');
    fs.unlinkSync(fileParent);
  });
});
