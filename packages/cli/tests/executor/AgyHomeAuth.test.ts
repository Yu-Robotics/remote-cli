import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { AgyExecutor } from '../../src/executor/AgyExecutor';
import { kernelGate } from '../../src/delegation/OwnershipRuntime';
import type { DirectoryGuard } from '../../src/security/DirectoryGuard';

const fixture = vi.hoisted(() => ({ home: '' }));
vi.mock('child_process', async importOriginal => ({
  ...await importOriginal<typeof import('child_process')>(), execFile: vi.fn(),
}));
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

  for (const state of ['missing', 'local']) {
    it(`queries the original thread with its ${state} token entry`, async context => {
      if (!requireFileSymlinks(() => context.skip())) return;
      const home = path.join(fixture.home, '.remote-cli', 'agy-homes', 'original-thread');
      const cli = path.join(home, '.gemini', 'antigravity-cli');
      fs.mkdirSync(cli, { recursive: true });
      const token = path.join(cli, 'antigravity-oauth-token');
      fs.writeFileSync(masterToken, 'synthetic shared credential');
      if (state === 'local') fs.writeFileSync(token, 'synthetic local credential');
      const journal = path.join(home, '.remote-cli-agy-hooks.owner.json');
      fs.writeFileSync(journal, 'synthetic journal');
      fs.mkdirSync(path.join(fixture.home, '.gemini', 'config'));
      fs.writeFileSync(path.join(masterCli, 'settings.json'), '{}');

      executor = new AgyExecutor({} as DirectoryGuard, { threadId: 'preview', delegationWorker: true, forceFileTokenStorage: true });
      vi.mocked(execFile).mockImplementation(((_command: string, args: string[], options: any, callback: any) => {
        expect(args).toEqual(['models']);
        expect(options.env.HOME).toBe(home);
        expect(options.env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE).toBe('true');
        expect(fs.realpathSync(token)).toBe(state === 'local' ? token : masterToken);
        callback(null, 'synthetic-model\tSynthetic Model\n');
      }) as any);
      expect((await executor.listModels({ threadId: 'original-thread' }))[0].id).toBe('synthetic-model');
      expect(fs.readFileSync(journal, 'utf8')).toBe('synthetic journal');
      expect(fs.existsSync(path.join(home, '.gemini', 'config'))).toBe(false);
      expect(fs.existsSync(path.join(cli, 'settings.json'))).toBe(false);
      expect(fs.existsSync(path.join(path.dirname(home), 'preview'))).toBe(false);
    });
  }

  it('refuses to create a token link in a redirected catalog directory', async context => {
    if (!requireFileSymlinks(() => context.skip())) return;
    fs.writeFileSync(masterToken, 'synthetic shared credential');
    const gemini = path.join(fixture.home, '.remote-cli', 'agy-homes', 'synthetic-thread', '.gemini');
    fs.mkdirSync(gemini, { recursive: true });
    const redirect = path.join(root, 'other-directory');
    fs.mkdirSync(redirect);
    fs.symlinkSync(redirect, path.join(gemini, 'antigravity-cli'), 'junction');
    await expect(executor.listModels()).rejects.toThrow('redirected thread HOME');
    expect(fs.readdirSync(redirect)).toEqual([]);
  });

  it('repairs the relocated native login link during a catalog query after a competing repair releases it', async context => {
    if (!requireFileSymlinks(() => context.skip())) return;
    const dir = threadCli();
    const link = path.join(dir, 'antigravity-oauth-token');
    const oldToken = path.join(root, 'previous-home', '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
    fs.symlinkSync(oldToken, link, 'file');
    const originalTarget = fs.readlinkSync(link);
    fs.writeFileSync(masterToken, 'synthetic shared credential');
    const home = path.dirname(path.dirname(dir));
    const gate = kernelGate(path.join(home, '.remote-cli-agy-file-login.gate'))!;
    try {
      await expect(executor.listModels()).rejects.toThrow('being restored');
      expect(fs.readlinkSync(link)).toBe(originalTarget);
    } finally { gate.close(); }
    vi.mocked(execFile).mockImplementation(((_command: string, _args: string[], _options: any, callback: any) => {
      expect(fs.realpathSync(link)).toBe(masterToken);
      callback(null, 'synthetic-model\tSynthetic Model\n');
    }) as any);
    expect((await executor.listModels())[0].id).toBe('synthetic-model');
    expect(threadCli()).toBe(dir);
    expect(fs.readdirSync(dir).filter(name => name.startsWith('.remote-cli-login-'))).toEqual([]);
  });

  it('preserves an unrecognized dangling link in the thread profile', async context => {
    if (!requireFileSymlinks(() => context.skip())) return;
    const link = path.join(threadCli(), 'antigravity-oauth-token');
    const unrelated = path.join(root, 'custom-login');
    fs.symlinkSync(unrelated, link, 'file');
    const originalTarget = fs.readlinkSync(link);
    fs.writeFileSync(masterToken, 'synthetic shared credential');
    await expect(executor.listModels()).rejects.toThrow('original file store');
    expect(fs.readlinkSync(link)).toBe(originalTarget);
  });

  it('leaves the relocated link alone when the shared credential points outside the account store', async context => {
    if (!requireFileSymlinks(() => context.skip())) return;
    const link = path.join(threadCli(), 'antigravity-oauth-token');
    const previous = path.join(root, 'old', '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
    fs.symlinkSync(previous, link, 'file');
    const originalTarget = fs.readlinkSync(link);
    const otherFile = path.join(root, 'other-file');
    fs.writeFileSync(otherFile, 'synthetic content');
    fs.symlinkSync(otherFile, masterToken, 'file');
    await expect(executor.listModels()).rejects.toThrow('original file store');
    expect(fs.readlinkSync(link)).toBe(originalTarget);
  });

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
