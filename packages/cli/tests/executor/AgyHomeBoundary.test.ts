import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

describe('AGY HOME boundary', () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('does not treat directory symlinks or a changed HOME as read isolation', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-boundary-test-'));
    const sharedCli = path.join(root, 'shared', '.gemini', 'antigravity-cli');
    const threadHome = path.join(root, 'thread');
    const threadCli = path.join(threadHome, '.gemini', 'antigravity-cli');
    fs.mkdirSync(path.join(sharedCli, 'cache'), { recursive: true });
    fs.mkdirSync(path.join(sharedCli, 'conversations'), { recursive: true });
    fs.mkdirSync(threadCli, { recursive: true });
    fs.writeFileSync(path.join(sharedCli, 'conversations', 'other-thread.db'), 'fixture');
    fs.symlinkSync(path.join(sharedCli, 'cache'), path.join(threadCli, 'cache'), 'dir');

    const probe = spawnSync(process.execPath, ['-e', [
      "const fs = require('fs');",
      "const root = process.env.HOME + '/.gemini/antigravity-cli';",
      "process.stdout.write(JSON.stringify({ home: process.env.HOME, reachable: fs.existsSync(root + '/cache/../conversations/other-thread.db') }));",
    ].join(' ')], { env: { ...process.env, HOME: threadHome }, encoding: 'utf8' });

    expect(probe.status).toBe(0);
    expect(JSON.parse(probe.stdout)).toEqual({ home: threadHome, reachable: true });
  });
});
