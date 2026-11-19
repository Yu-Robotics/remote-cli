import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { AgyExecutor } from '../../src/executor/AgyExecutor';
import { DirectoryGuard } from '../../src/security/DirectoryGuard';

const fixture = vi.hoisted(() => ({ home: '' }));
vi.mock('os', async load => {
  const actual = await load<typeof import('os')>();
  const homedir = () => fixture.home;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

describe('AGY HOME boundary', () => {
  let root: string | undefined;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('does not treat the foreground shared cache or a changed HOME as read isolation', async context => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-boundary-test-')));
    const sharedCli = path.join(root, 'shared', '.gemini', 'antigravity-cli');
    const masterHome = path.join(root, 'shared');
    fixture.home = masterHome;
    vi.stubEnv('HOME', masterHome);
    vi.stubEnv('USERPROFILE', masterHome);
    fs.mkdirSync(path.join(sharedCli, 'cache'), { recursive: true });
    fs.mkdirSync(path.join(sharedCli, 'conversations'), { recursive: true });
    fs.writeFileSync(path.join(sharedCli, 'conversations', 'other-thread.db'), 'fixture');
    const executor = new AgyExecutor(new DirectoryGuard([masterHome]), { threadId: 'synthetic-thread' });
    let env: NodeJS.ProcessEnv;
    try {
      env = (executor as unknown as { buildEnv(): NodeJS.ProcessEnv }).buildEnv();
    } catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM'
        && (error as NodeJS.ErrnoException).syscall === 'symlink') return context.skip();
      throw error;
    } finally { await executor.destroy(); }
    expect(env.HOME).toBe(path.join(masterHome, '.remote-cli', 'agy-homes', 'synthetic-thread'));

    const probe = spawnSync(process.execPath, ['-e', [
      "const fs = require('fs'), path = require('path');",
      "const root = path.join(process.env.HOME, '.gemini', 'antigravity-cli');",
      "const cache = fs.realpathSync(path.join(root, 'cache'));",
      "process.stdout.write(JSON.stringify({ home: process.env.HOME, reachable: fs.existsSync(path.join(cache, '..', 'conversations', 'other-thread.db')) }));",
    ].join(' ')], { env, encoding: 'utf8' });

    expect(probe.status, probe.stderr).toBe(0);
    expect(JSON.parse(probe.stdout)).toEqual({ home: env.HOME, reachable: true });
  });
});
