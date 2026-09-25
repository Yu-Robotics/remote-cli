import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import os from 'os';
import path from 'path';
import { ClaudeSandbox } from '../../src/executor/claude/ClaudeSandbox';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';

describe('ClaudeSandbox', () => {
  const home = os.homedir();
  const threadId = `test-${Date.now()}`;
  const storePath = path.join(home, '.remote-cli', 'claude-sandbox', `${encodeURIComponent(threadId)}.json`);
  let guard: DirectoryGuard;

  beforeEach(() => {
    guard = new DirectoryGuard([process.cwd(), os.tmpdir()]);
    if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
  });

  afterEach(() => {
    if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
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
