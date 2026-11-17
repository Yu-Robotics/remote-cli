import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AgyExecutor } from '../../src/executor/AgyExecutor';
import type { DirectoryGuard } from '../../src/security/DirectoryGuard';

const fixture = vi.hoisted(() => ({ home: '' }));
vi.mock('os', async importOriginal => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => fixture.home, default: { ...actual, homedir: () => fixture.home } };
});

describe('AGY per-thread native authentication', () => {
  let root: string;
  let masterCli: string;
  let masterToken: string;
  let executor: AgyExecutor;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-home-auth-')));
    fixture.home = path.join(root, 'user');
    masterCli = path.join(fixture.home, '.gemini', 'antigravity-cli');
    masterToken = path.join(masterCli, 'antigravity-oauth-token');
    fs.mkdirSync(masterCli, { recursive: true });
    executor = new AgyExecutor({} as DirectoryGuard, { threadId: 'synthetic-thread' });
  });

  afterEach(async () => {
    await executor.destroy();
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function requireFileSymlinks(skip: () => void): boolean {
    const source = path.join(root, 'symlink-source');
    const target = path.join(root, 'symlink-probe');
    fs.writeFileSync(source, 'synthetic fixture');
    try {
      fs.symlinkSync(source, target, 'file');
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES')) {
        skip(); // Windows file symlinks require Developer Mode or suitable privileges.
        return false;
      }
      throw error;
    }
  }

  function threadCli(): string {
    const env = (executor as unknown as { buildEnv(): NodeJS.ProcessEnv }).buildEnv();
    expect(env.HOME).toBe(path.join(fixture.home, '.remote-cli', 'agy-homes', 'synthetic-thread'));
    return path.join(env.HOME!, '.gemini', 'antigravity-cli');
  }

  it('exposes the native login file without sharing conversation data', context => {
    if (!requireFileSymlinks(() => context.skip())) return;
    fs.writeFileSync(masterToken, 'synthetic shared credential');
    for (const name of ['brain', 'conversations']) {
      fs.mkdirSync(path.join(masterCli, name));
      fs.writeFileSync(path.join(masterCli, name, 'other-session'), 'synthetic private data');
    }
    expect(fs.existsSync(path.join(fixture.home, '.gemini', 'oauth_creds.json'))).toBe(false);
    expect(fs.existsSync(path.join(fixture.home, '.gemini', 'google_accounts.json'))).toBe(false);

    const cli = threadCli();
    const token = path.join(cli, 'antigravity-oauth-token');
    expect(fs.lstatSync(token).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(token)).toBe(masterToken);
    expect(fs.readFileSync(token, 'utf8')).toBe('synthetic shared credential');
    for (const name of ['brain', 'conversations']) {
      expect(fs.existsSync(path.join(cli, name))).toBe(false);
      expect(fs.readFileSync(path.join(masterCli, name, 'other-session'), 'utf8')).toBe('synthetic private data');
    }

    fs.writeFileSync(masterToken, 'synthetic refreshed credential');
    expect(fs.readFileSync(token, 'utf8')).toBe('synthetic refreshed credential');
  });

  it('links a login created after the thread HOME was initialized', context => {
    if (!requireFileSymlinks(() => context.skip())) return;
    const token = path.join(threadCli(), 'antigravity-oauth-token');
    expect(fs.existsSync(token)).toBe(false);
    fs.writeFileSync(masterToken, 'synthetic later login');

    threadCli();

    expect(fs.realpathSync(token)).toBe(masterToken);
    expect(fs.readFileSync(token, 'utf8')).toBe('synthetic later login');
  });

  it('preserves a native credential replaced locally without overwriting either copy', context => {
    if (!requireFileSymlinks(() => context.skip())) return;
    fs.writeFileSync(masterToken, 'synthetic shared credential');
    const token = path.join(threadCli(), 'antigravity-oauth-token');
    fs.unlinkSync(token);
    fs.writeFileSync(token, 'synthetic local credential');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    threadCli();

    expect(fs.lstatSync(token).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(token, 'utf8')).toBe('synthetic local credential');
    expect(fs.readFileSync(masterToken, 'utf8')).toBe('synthetic shared credential');
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('antigravity-oauth-token replaced its shared link'));
  });
});
