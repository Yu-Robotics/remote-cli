import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const { selectRelease, runFromEnvironment } = createRequire(import.meta.url)('../../../scripts/select-npm-release.cjs');
const before = 'a'.repeat(40);
const manifest = (version: unknown) => JSON.stringify({ version });
const push = { eventName: 'push', before };

function readers(current = '1.6.200', previous = '1.6.199') {
  return { readFile: vi.fn(async () => manifest(current)), readBefore: vi.fn(async () => manifest(previous)) };
}

describe('automatic npm release selection', () => {
  it('reads the real push predecessor rather than the last commit and reports missing history', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'release-history-test-')));
    const invoke = promisify(execFile);
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
    const git = async (...args: string[]) => (await invoke('git', [
      '-c', 'user.name=Synthetic Release', '-c', 'user.email=release@example.com',
      '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${path.join(root, 'hooks')}`, ...args,
    ], { cwd: root, env: { ...environment, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig') } })).stdout.trim();
    try {
      await fs.writeFile(path.join(root, 'gitconfig'), '');
      await fs.mkdir(path.join(root, 'hooks'));
      await git('init');
      await fs.writeFile(path.join(root, 'package.json'), manifest('1.6.199'));
      await git('add', 'package.json');
      await git('commit', '-m', 'Initial synthetic release');
      const previous = await git('rev-parse', 'HEAD');
      await fs.writeFile(path.join(root, 'package.json'), manifest('1.6.200'));
      await git('add', 'package.json');
      await git('commit', '-m', 'Increase synthetic version');
      await git('commit', '--allow-empty', '-m', 'Follow-up without a version change');
      expect(await selectRelease({ eventName: 'push', before: previous, root }))
        .toEqual({ publish: true, version: '1.6.200' });
      expect(await selectRelease({ eventName: 'push', before: await git('rev-parse', 'HEAD^'), root }))
        .toEqual({ publish: false, version: '1.6.200' });
      await expect(selectRelease({ eventName: 'push', before: 'd'.repeat(40), root })).rejects.toThrow('Cannot read package.json');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('skips unchanged versions without requiring npm or registry access', async () => {
    expect(await selectRelease(push, readers('1.6.199', '1.6.199'))).toEqual({ publish: false, version: '1.6.199' });
  });

  it.each([
    ['1.6.199', '1.6.200'], ['1.9.9', '1.10.0'], ['1.99.99', '2.0.0'], ['0.0.0', '0.0.1'],
  ])('selects numeric version increase %s to %s', async (previous, current) => {
    expect(await selectRelease(push, readers(current, previous))).toEqual({ publish: true, version: current });
  });

  it.each([['1.6.200', '1.6.199'], ['2.0.0', '1.99.99'], ['1.10.0', '1.9.99']])(
    'rejects downgrade %s to %s', async (previous, current) => {
      await expect(selectRelease(push, readers(current, previous))).rejects.toThrow('downgrade');
    });

  it('compares the push-event predecessor across a multi-commit push, even when HEAD and HEAD^ have equal versions', async () => {
    const intermediate = 'b'.repeat(40);
    const head = 'c'.repeat(40);
    const history = new Map([
      [before, manifest('1.6.199')],
      [intermediate, manifest('1.6.200')], // Version increase happened before the last commit.
      [head, manifest('1.6.200')],
    ]);
    const readBefore = vi.fn(async (_root: string, sha: string) => {
      if (!history.has(sha)) throw new Error('Unknown synthetic revision');
      return history.get(sha);
    });
    expect(await selectRelease(push, { readFile: async () => history.get(head), readBefore }))
      .toEqual({ publish: true, version: '1.6.200' });
    expect(readBefore).toHaveBeenCalledTimes(1);
    expect(readBefore).toHaveBeenCalledWith(expect.any(String), before);
  });

  it('allows manual recovery only for the exact current version and does not require predecessor history', async () => {
    const dependencies = readers();
    expect(await selectRelease({ eventName: 'workflow_dispatch', requestedVersion: '1.6.200' }, dependencies))
      .toEqual({ publish: true, version: '1.6.200' });
    expect(dependencies.readBefore).not.toHaveBeenCalled();
    await expect(selectRelease({ eventName: 'workflow_dispatch', requestedVersion: '1.6.199' }, dependencies))
      .rejects.toThrow('does not match');
  });

  it.each(['', undefined, 'HEAD^', 'a'.repeat(39), `${before}\n`, 'x'.repeat(40)])('rejects malformed before SHA %j', async value => {
    const dependencies = readers();
    await expect(selectRelease({ ...push, before: value }, dependencies)).rejects.toThrow('before commit SHA');
    expect(dependencies.readBefore).not.toHaveBeenCalled();
    expect(dependencies.readFile).not.toHaveBeenCalled();
  });

  it('refuses an unknown initial version for a newly created branch', async () => {
    await expect(selectRelease({ ...push, before: '0'.repeat(40) }, readers())).rejects.toThrow('no predecessor');
  });

  it('skips a deleted branch before reading the checkout or predecessor', async () => {
    const dependencies = readers();
    expect(await selectRelease({ eventName: 'push', deleted: 'true' }, dependencies)).toEqual({ publish: false });
    expect(dependencies.readFile).not.toHaveBeenCalled();
    expect(dependencies.readBefore).not.toHaveBeenCalled();
  });

  it.each(['1.6.200-rc.1', 'v1.6.200', '01.6.200', '1.6.200\n', '1.6.200\nversion=9.9.9', null])(
    'rejects malformed manifest version %j', async version => {
      const dependencies = readers();
      dependencies.readFile.mockResolvedValue(manifest(version));
      await expect(selectRelease(push, dependencies)).rejects.toThrow('stable X.Y.Z');
      dependencies.readFile.mockResolvedValue(manifest('1.6.200'));
      dependencies.readBefore.mockResolvedValue(manifest(version));
      await expect(selectRelease(push, dependencies)).rejects.toThrow('stable X.Y.Z');
    });

  it.each(['', undefined, '1.6.200\n', '1.6.200; echo synthetic', '1.6.200-rc.1'])(
    'rejects unsafe manual version %j', async requestedVersion => {
      await expect(selectRelease({ eventName: 'workflow_dispatch', requestedVersion }, readers())).rejects.toThrow('stable X.Y.Z');
    });

  it('fails closed when current or predecessor data is unreadable or malformed', async () => {
    const dependencies = readers();
    dependencies.readFile.mockRejectedValueOnce(new Error('Synthetic unavailable current manifest'));
    await expect(selectRelease(push, dependencies)).rejects.toThrow('Cannot read current');
    dependencies.readFile.mockResolvedValueOnce('{');
    await expect(selectRelease(push, dependencies)).rejects.toThrow('Cannot parse Current');
    dependencies.readBefore.mockRejectedValueOnce(new Error('Synthetic missing predecessor'));
    await expect(selectRelease(push, dependencies)).rejects.toThrow('missing predecessor');
    dependencies.readBefore.mockResolvedValueOnce('{');
    await expect(selectRelease(push, dependencies)).rejects.toThrow('Cannot parse Predecessor');
  });

  it('rejects unsupported events and invalid deletion flags', async () => {
    await expect(selectRelease({ eventName: 'pull_request' }, readers())).rejects.toThrow('Unsupported');
    await expect(selectRelease({ ...push, deleted: 'unknown' }, readers())).rejects.toThrow('deletion flag');
  });

  it('writes only fixed output keys and a validated version, and emits no output after errors', async () => {
    const dependencies = { ...readers(), appendFile: vi.fn(), log: vi.fn() };
    const environment = { GITHUB_EVENT_NAME: 'push', RELEASE_BEFORE: before, GITHUB_OUTPUT: 'synthetic-output' };
    await runFromEnvironment(environment, dependencies);
    expect(dependencies.appendFile).toHaveBeenLastCalledWith('synthetic-output', 'publish=true\nversion=1.6.200\n');
    dependencies.readBefore.mockResolvedValue(manifest('1.6.200'));
    await runFromEnvironment(environment, dependencies);
    expect(dependencies.appendFile).toHaveBeenLastCalledWith('synthetic-output', 'publish=false\nversion=1.6.200\n');
    dependencies.appendFile.mockClear();
    await expect(runFromEnvironment({ ...environment, GITHUB_EVENT_NAME: 'workflow_dispatch', RELEASE_VERSION: '1.6.200\n' }, dependencies))
      .rejects.toThrow('stable X.Y.Z');
    expect(dependencies.appendFile).not.toHaveBeenCalled();
    await expect(runFromEnvironment({}, dependencies)).rejects.toThrow('GITHUB_OUTPUT');
  });
});
