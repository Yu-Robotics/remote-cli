import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { buildBackendPath, getBackendPath, type BackendPathOptions } from '../src/utils/BackendEnvironment';

const options: BackendPathOptions = {
  platform: 'linux', homeDir: '/home/example', nodePath: '/opt/node/bin/node', pathValue: '/opt/original/bin:/usr/bin',
};
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'backend-path fixture-'));
  directories.push(directory);
  return directory;
}

describe('backend PATH composition', () => {
  it('preserves precedence and inherited segments while adding only absolute fallbacks', () => {
    const input = '/opt/pinned/bin:relative::/usr/bin:/opt/pinned/bin';
    const result = buildBackendPath({ ...options, pathValue: input });
    const entries = result.split(':');
    expect(entries.slice(0, 4)).toEqual(['/opt/pinned/bin', 'relative', '', '/usr/bin']);
    expect(entries.slice(4).every(entry => path.posix.isAbsolute(entry))).toBe(true);
    expect(entries.filter(entry => entry === '/opt/pinned/bin')).toHaveLength(1);
    expect(entries.indexOf('/opt/node/bin')).toBeGreaterThan(entries.indexOf('/usr/bin'));
    expect(buildBackendPath({ ...options, pathValue: result })).toBe(result);
  });

  it('handles absent and empty PATH without inventing relative locations or manager shims', () => {
    const result = buildBackendPath({ ...options, pathValue: undefined });
    expect(result.split(':').every(entry => path.posix.isAbsolute(entry))).toBe(true);
    expect(buildBackendPath({ ...options, pathValue: '' })).toBe(`:${result}`);
    for (const manager of ['.volta', '.asdf', 'mise/shims', '.nvm', 'fnm']) expect(result).not.toContain(manager);
  });

  it.each(['bin/remote-cli.js', 'dist/index.js'])('derives a global npm bin from a resolved package layout: %s', suffix => {
    const result = buildBackendPath({ ...options, cliEntryPath: `/opt/npm prefix/lib/node_modules/@yu_robotics/remote-cli/${suffix}` });
    expect(result.split(':')).toContain('/opt/npm prefix/bin');
  });

  it.each(['/opt/custom/bin/remote-cli', '/opt/checkout/packages/cli/bin/remote-cli.js', 'relative/lib/node_modules/@yu_robotics/remote-cli/bin/remote-cli.js'])('does not guess a prefix from an ambiguous entry: %s', cliEntryPath => {
    expect(buildBackendPath({ ...options, cliEntryPath })).toBe(buildBackendPath(options));
  });

  it('accepts only safe absolute prefix/home inputs and keeps platform behavior bounded', () => {
    expect(buildBackendPath({ ...options, npmPrefix: '/opt/custom prefix' }).split(':')).toContain('/opt/custom prefix/bin');
    for (const npmPrefix of ['relative', '/opt/bad:prefix', '/opt/bad\nvalue']) {
      expect(buildBackendPath({ ...options, npmPrefix })).toBe(buildBackendPath(options));
    }
    const invalid = buildBackendPath({ ...options, homeDir: 'relative', nodePath: 'node' });
    expect(invalid).not.toContain('/home/example');
    expect(invalid).not.toContain('relative');
    expect(buildBackendPath({ ...options, platform: 'darwin' })).toContain('/opt/homebrew/bin');
    expect(buildBackendPath({ ...options, platform: 'win32', pathValue: 'C:\\Windows;C:\\Tools' })).toBe('C:\\Windows;C:\\Tools');
    expect(buildBackendPath({ ...options, platform: 'win32', pathValue: undefined })).toBe('');
  });

  it.skipIf(process.platform === 'win32')('resolves a real npm bin symlink but ignores missing installation facts', () => {
    const prefix = fixture();
    const entry = path.join(prefix, 'lib/node_modules/@yu_robotics/remote-cli/bin/remote-cli.js');
    const link = path.join(prefix, 'bin/remote-cli');
    mkdirSync(path.dirname(entry), { recursive: true });
    mkdirSync(path.dirname(link), { recursive: true });
    writeFileSync(entry, '// Synthetic package entry.\n');
    symlinkSync(entry, link);
    const resolvedBin = realpathSync(path.dirname(link));
    const input = { ...options, cliEntryPath: link, npmPrefix: 'relative' };
    expect(getBackendPath(input).split(':')).toContain(resolvedBin);
    expect(getBackendPath({ ...input, cliEntryPath: path.join(prefix, 'missing') }).split(':')).not.toContain(resolvedBin);
  });

  it.skipIf(process.platform === 'win32')('finds a later-installed executable under an unchanged old-service PATH', () => {
    const homeDir = fixture();
    const composed = buildBackendPath({ ...options, homeDir, nodePath: process.execPath, pathValue: '/nonexistent/legacy-bin' });
    const bin = path.join(homeDir, '.kimi-code/bin/remote-cli-backend-fixture');
    const run = () => spawnSync('remote-cli-backend-fixture', ['--version'], { cwd: homeDir, env: { ...process.env, PATH: composed }, encoding: 'utf8' });
    expect(run().error?.code).toBe('ENOENT');
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(bin, '#!/usr/bin/env node\nconsole.log("Backend fixture 1.0");\n', { mode: 0o755 });
    const child = run();
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stdout.trim()).toBe('Backend fixture 1.0');
  });

  it.skipIf(process.platform === 'win32')('does not replace an inherited Node interpreter with the CLI interpreter', () => {
    const homeDir = fixture();
    const pinnedBin = path.join(homeDir, 'pinned bin');
    mkdirSync(pinnedBin);
    writeFileSync(path.join(pinnedBin, 'node'), '#!/bin/sh\nprintf "pinned-node\\n"\n', { mode: 0o755 });
    const composed = buildBackendPath({ ...options, homeDir, nodePath: process.execPath, pathValue: pinnedBin });
    const child = spawnSync('node', ['--version'], { env: { ...process.env, PATH: composed }, encoding: 'utf8' });
    expect(child.status).toBe(0);
    expect(child.stdout.trim()).toBe('pinned-node');
  });
});
