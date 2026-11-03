import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const { parseArguments, publishRelease, registryVersion, npmFailure, REGISTRY, REPOSITORY,
  CONFIRMATION_ATTEMPTS, CONFIRMATION_INTERVAL_MS } =
  createRequire(import.meta.url)('../../../scripts/publish-npm.cjs');
const version = '2.3.4';
const names = ['@yu_robotics/remote-cli', '@yu_robotics/remote-cli-router'];
const directories = ['packages/cli', 'packages/router'];
const bytes = (name: string) => Buffer.from(`Synthetic archive for ${name}@${version}`);
const integrity = (data: Buffer) => `sha512-${createHash('sha512').update(data).digest('base64')}`;
const metadata = (name: string, digest = integrity(bytes(name))) => ({ name, version, dist: { integrity: digest } });
const response = (status: number, data?: unknown) => ({ status, json: async () => data });

describe('npm release orchestration (synthetic processes and registry only)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'npm-release-test-')));
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'synthetic-monorepo', version, private: true }));
    const packages: Record<string, { version: string }> = { '': { version } };
    for (const [index, directory] of directories.entries()) {
      await fs.mkdir(path.join(root, directory), { recursive: true });
      await fs.writeFile(path.join(root, directory, 'package.json'), JSON.stringify({
        name: names[index], version, publishConfig: { access: 'public' },
        repository: { type: 'git', url: REPOSITORY, directory },
      }));
      packages[directory] = { version };
    }
    await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ version, lockfileVersion: 3, packages }));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function change(file: string, update: (data: any) => void) {
    const target = path.join(root, file);
    const data = JSON.parse(await fs.readFile(target, 'utf8'));
    update(data);
    await fs.writeFile(target, JSON.stringify(data));
  }

  function harness() {
    const registry = new Map<string, any>();
    const events: string[] = [];
    const archives = new Map<string, string>();
    let temporary: string | undefined;
    let onPublish: ((name: string) => void) | undefined;
    const runNpm = vi.fn(async (args: string[], options: { cwd: string; env: Record<string, string> }) => {
      temporary = options.cwd;
      if (args[0] === '--version') return '11.5.1\n';
      if (args[0] === 'pack') {
        const index = directories.findIndex(directory => path.join(root, directory) === args[1]);
        expect(index).toBeGreaterThanOrEqual(0);
        const name = names[index];
        events.push(`pack:${name}`);
        const filename = `package-${index}.tgz`;
        const archive = path.join(options.cwd, filename);
        archives.set(archive, name);
        await fs.writeFile(archive, bytes(name));
        return JSON.stringify([{ name, version, filename, integrity: integrity(bytes(name)) }]);
      }
      expect(args[0]).toBe('publish');
      const name = archives.get(args[1])!;
      expect(name).toBeDefined();
      expect(await fs.readFile(args[1])).toEqual(bytes(name));
      events.push(`publish:${name}`);
      if (onPublish) onPublish(name);
      else registry.set(name, metadata(name));
      return '{}';
    });
    const fetch = vi.fn(async (url: string, options: any) => {
      const parsed = new URL(url);
      expect(parsed.origin).toBe(REGISTRY);
      expect(parsed.pathname.endsWith(`/${version}`)).toBe(true);
      expect(options.headers).toEqual({ accept: 'application/json', 'cache-control': 'no-cache' });
      expect([...parsed.searchParams.keys()]).toEqual(['release_check']);
      expect(parsed.searchParams.get('release_check')).toMatch(/^[0-9a-f-]{36}$/);
      expect(options.redirect).toBe('error');
      const name = decodeURIComponent(parsed.pathname.slice(1, -version.length - 1));
      events.push(`get:${name}`);
      return registry.has(name) ? response(200, registry.get(name)) : response(404);
    });
    const dependencies = { runNpm, fetch, sleep: vi.fn(async (_milliseconds: number) => {}), log: vi.fn(), environment: {} };
    return { registry, events, archives, dependencies, runNpm, fetch,
      temporary: () => temporary,
      onPublish: (callback: (name: string) => void) => { onPublish = callback; },
      run: (check = false) => publishRelease({ root, version, check }, dependencies),
    };
  }

  it('parses the required stable version and optional local check without running anything on import', () => {
    expect(parseArguments(['--check', '--version', version])).toEqual({ version, check: true });
    expect(parseArguments(['--version', version])).toEqual({ version, check: false });
    for (const args of [[], ['--version'], ['--version', '1.2.3-rc.1'], ['--version', '01.2.3'],
      ['--version', version, '--unknown'], ['--version', version, '--check', '--check']]) {
      expect(() => parseArguments(args)).toThrow();
    }
  });

  it.each([
    ['package.json', 'version'], ['packages/cli/package.json', 'version'], ['packages/router/package.json', 'version'],
    ['package-lock.json', 'version'], ['package-lock.json', 'root'],
    ['package-lock.json', 'packages/cli'], ['package-lock.json', 'packages/router'],
  ])('rejects version mismatch at %s:%s before packing or registry access', async (file, key) => {
    await change(file, data => {
      if (key === 'version') data.version = '2.3.3';
      else data.packages[key === 'root' ? '' : key].version = '2.3.3';
    });
    const h = harness();
    await expect(h.run()).rejects.toThrow('Version mismatch');
    expect(h.runNpm).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it.each(directories)('rejects incorrect repository attribution for %s', async directory => {
    await change(`${directory}/package.json`, data => { data.repository.url = 'git+https://github.com/example/other.git'; });
    const h = harness();
    await expect(h.run()).rejects.toThrow('Repository attribution mismatch');
    expect(h.runNpm).not.toHaveBeenCalled();
  });

  it.each(['root-private', 'name', 'access', 'registry'])('rejects invalid publication configuration: %s', async kind => {
    await change(kind === 'root-private' ? 'package.json' : 'packages/cli/package.json', data => {
      if (kind === 'root-private') data.private = false;
      if (kind === 'name') data.name = '@example/unrelated';
      if (kind === 'access') data.publishConfig.access = 'restricted';
      if (kind === 'registry') data.publishConfig.registry = 'https://registry.example.com';
    });
    const h = harness();
    await expect(h.run()).rejects.toThrow();
    expect(h.runNpm).not.toHaveBeenCalled();
  });

  it('checks and packs locally with isolated npm configuration, without registry access or publication', async () => {
    const h = harness();
    Object.assign(h.dependencies.environment, { HOME: root, USERPROFILE: root, NPM_TOKEN: 'synthetic-token',
      NODE_AUTH_TOKEN: 'synthetic-token', NPM_CONFIG_USERCONFIG: 'synthetic-config',
      npm_config_registry: 'https://registry.example.com', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.com/oidc' });
    const result = await h.run(true);
    expect(result.map((item: any) => item.status)).toEqual(['packed', 'packed']);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.runNpm.mock.calls.map(([args]) => args[0])).toEqual(['pack', 'pack']);
    const environment = h.runNpm.mock.calls[0][1].env;
    expect(environment.HOME).toBe(h.temporary());
    expect(environment.USERPROFILE).toBe(h.temporary());
    expect(environment.NPM_TOKEN).toBeUndefined();
    expect(environment.NODE_AUTH_TOKEN).toBeUndefined();
    expect(environment.NPM_CONFIG_USERCONFIG).toBeUndefined();
    expect(environment.npm_config_userconfig).toBe(path.join(h.temporary()!, 'user.npmrc'));
    expect(environment.npm_config_globalconfig).toBe(path.join(h.temporary()!, 'global.npmrc'));
    expect(environment.npm_config_fetch_retries).toBe('0');
    expect(environment.ACTIONS_ID_TOKEN_REQUEST_URL).toBe('https://example.com/oidc');
    await expect(fs.stat(h.temporary()!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preflights both registry versions, publishes the exact packed archives, and verifies each result', async () => {
    const h = harness();
    const results = await h.run();
    expect(results.map((item: any) => item.status)).toEqual(['published', 'published']);
    expect(h.events).toEqual([`pack:${names[0]}`, `pack:${names[1]}`, `get:${names[0]}`, `get:${names[1]}`,
      `publish:${names[0]}`, `get:${names[0]}`, `publish:${names[1]}`, `get:${names[1]}`]);
    for (const [args] of h.runNpm.mock.calls) {
      if (args[0] !== '--version') expect(args).toContain('--ignore-scripts');
      if (args[0] === 'publish') {
        expect(args).toEqual(['publish', args[1], '--ignore-scripts', '--access', 'public', `--registry=${REGISTRY}`]);
      }
    }
  });

  it('runs real local npm packing on synthetic packages without lifecycle scripts or registry access', async () => {
    for (const directory of directories) {
      await change(`${directory}/package.json`, data => {
        data.scripts = { prepack: 'node -e "process.exit(99)"', prepare: 'node -e "process.exit(99)"' };
      });
    }
    const fetch = vi.fn(() => { throw new Error('A local check must not access the registry'); });
    const results = await publishRelease({ root, version, check: true }, {
      fetch, log: vi.fn(), environment: { PATH: process.env.PATH || '' },
    });
    expect(results.map((item: any) => item.status)).toEqual(['packed', 'packed']);
    for (const item of results) expect(item.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
    expect(fetch).not.toHaveBeenCalled();
  }, 30_000);

  it.each([0, 1])('aborts before publishing either package when package %i already has different bytes', async index => {
    const h = harness();
    h.registry.set(names[index], metadata(names[index], integrity(Buffer.from('different synthetic archive'))));
    await expect(h.run()).rejects.toThrow('Integrity conflict');
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.events.some(event => event.startsWith('publish:'))).toBe(false);
    await expect(fs.stat(h.temporary()!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('supports partial completion and idempotent reruns only for matching archives', async () => {
    const h = harness();
    h.registry.set(names[0], metadata(names[0]));
    expect((await h.run()).map((item: any) => item.status)).toEqual(['existing', 'published']);
    expect(h.events.filter(event => event.startsWith('publish:'))).toEqual([`publish:${names[1]}`]);
    h.events.length = 0;
    expect((await h.run()).map((item: any) => item.status)).toEqual(['existing', 'existing']);
    expect(h.events.some(event => event.startsWith('publish:'))).toBe(false);
  });

  it('reconciles a lost publish response with one registry read and never repeats the publish', async () => {
    const h = harness();
    h.onPublish(name => { h.registry.set(name, metadata(name)); throw new Error('Synthetic lost response'); });
    expect((await h.run()).map((item: any) => item.status)).toEqual(['reconciled', 'reconciled']);
    expect(h.events.filter(event => event.startsWith('publish:'))).toHaveLength(2);
    expect(h.fetch).toHaveBeenCalledTimes(4);
    expect(h.dependencies.sleep).not.toHaveBeenCalled();
  });

  it.each([
    ['success', 2], ['uncertain', 2], ['success', 12], ['uncertain', 12],
  ] as const)('confirms a %s publish after %i stale 404s without repeating publication', async (outcome, misses) => {
    const h = harness();
    h.registry.set(names[1], metadata(names[1]));
    h.onPublish(name => {
      h.registry.set(name, metadata(name));
      for (let index = 0; index < misses; index++) h.fetch.mockResolvedValueOnce(response(404));
      if (outcome === 'uncertain') throw new Error('Synthetic lost publish response');
    });
    const result = await h.run();
    expect(result.map((item: any) => item.status)).toEqual([outcome === 'success' ? 'published' : 'reconciled', 'existing']);
    expect(h.events.filter(event => event.startsWith('publish:'))).toEqual([`publish:${names[0]}`]);
    expect(h.fetch).toHaveBeenCalledTimes(2 + misses + 1);
    expect(h.dependencies.sleep.mock.calls).toEqual(Array.from({ length: misses }, () => [5000]));
    const urls = h.fetch.mock.calls.map(([url]) => url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it.each(['conflict', 'auth', 'server', 'network', 'json', 'schema'])(
    'stops polling immediately on %s after a transient 404', async outcome => {
      const h = harness();
      h.onPublish(() => {
        h.fetch.mockResolvedValueOnce(response(404));
        if (outcome === 'conflict') h.fetch.mockResolvedValueOnce(response(200, metadata(names[0], integrity(Buffer.from('different synthetic bytes')))));
        if (outcome === 'auth') h.fetch.mockResolvedValueOnce(response(403));
        if (outcome === 'server') h.fetch.mockResolvedValueOnce(response(503));
        if (outcome === 'network') h.fetch.mockRejectedValueOnce(new Error('Synthetic network failure'));
        if (outcome === 'json') h.fetch.mockResolvedValueOnce({ status: 200, json: async () => { throw new Error('Synthetic invalid JSON'); } });
        if (outcome === 'schema') h.fetch.mockResolvedValueOnce(response(200, { error: 'Synthetic invalid metadata' }));
      });
      await expect(h.run()).rejects.toThrow('No publish retry was made');
      expect(h.events.filter(event => event.startsWith('publish:'))).toEqual([`publish:${names[0]}`]);
      expect(h.fetch).toHaveBeenCalledTimes(4);
      expect(h.dependencies.sleep.mock.calls).toEqual([[5000]]);
    });

  it('confirms both packages after minutes of stale 404s, including the final allowed lookup, with one upload each', async () => {
    const h = harness();
    const misses = [60, CONFIRMATION_ATTEMPTS - 1];
    h.onPublish(name => {
      h.registry.set(name, metadata(name));
      for (let index = 0; index < misses[names.indexOf(name)]; index++) h.fetch.mockResolvedValueOnce(response(404));
    });
    const results = await h.run();
    expect(results).toEqual(names.map(name => ({ name, version, integrity: integrity(bytes(name)), status: 'published' })));
    expect(h.events.filter(event => event.startsWith('publish:'))).toEqual(names.map(name => `publish:${name}`));
    expect(h.fetch).toHaveBeenCalledTimes(2 + misses.reduce((sum, count) => sum + count + 1, 0));
    expect(h.dependencies.sleep.mock.calls).toEqual(Array.from({ length: misses[0] + misses[1] }, () => [CONFIRMATION_INTERVAL_MS]));
    // A fresh invocation sees matching versions and must not upload again.
    h.events.length = 0;
    expect((await h.run()).map((item: any) => item.status)).toEqual(['existing', 'existing']);
    expect(h.events.some(event => event.startsWith('publish:'))).toBe(false);
  });

  it.each(['missing', 'conflict', 'lookup-failed'])('stops after an uncertain publish with %s reconciliation', async outcome => {
    const h = harness();
    h.onPublish(name => {
      if (outcome === 'conflict') h.registry.set(name, metadata(name, integrity(Buffer.from('unrelated bytes'))));
      if (outcome === 'lookup-failed') h.fetch.mockRejectedValueOnce(new Error('Synthetic network failure'));
      throw new Error('Synthetic publish failure');
    });
    await expect(h.run()).rejects.toThrow('No publish retry was made');
    expect(h.events.filter(event => event.startsWith('publish:'))).toEqual([`publish:${names[0]}`]);
    expect(h.fetch).toHaveBeenCalledTimes(outcome === 'missing' ? 2 + CONFIRMATION_ATTEMPTS : 3);
    expect(h.dependencies.sleep).toHaveBeenCalledTimes(outcome === 'missing' ? CONFIRMATION_ATTEMPTS - 1 : 0);
  });

  it('does not accept a successful process exit without matching registry confirmation', async () => {
    const h = harness();
    h.onPublish(() => {});
    expect(CONFIRMATION_ATTEMPTS).toBe(121);
    expect(CONFIRMATION_INTERVAL_MS).toBe(5000);
    expect((CONFIRMATION_ATTEMPTS - 1) * CONFIRMATION_INTERVAL_MS).toBe(10 * 60_000);
    await expect(h.run()).rejects.toThrow('not confirmed with matching integrity');
    expect(h.events.filter(event => event.startsWith('publish:'))).toHaveLength(1);
    expect(h.fetch).toHaveBeenCalledTimes(2 + CONFIRMATION_ATTEMPTS);
    expect(h.dependencies.sleep.mock.calls).toEqual(Array.from({ length: CONFIRMATION_ATTEMPTS - 1 }, () => [CONFIRMATION_INTERVAL_MS]));
  });

  it.each(['error', 'ERR!'])('reports safe npm %s diagnostics without raw authentication output', prefix => {
    const error = npmFailure({
      code: 1, message: 'synthetic-sensitive-message',
      stderr: `npm ${prefix} code E403\nnpm ${prefix} synthetic-sensitive-output`,
    }, 'publish');
    expect(error.message).toContain('E403; exit 1');
    expect(error.message).toContain('Check npm Trusted Publisher');
    expect(error.message).not.toContain('synthetic-sensitive');
    expect(npmFailure(error, 'publish').message).toBe(error.message);
    const unknown = npmFailure({ code: 'synthetic-sensitive-code',
      stderr: `npm ${prefix} code SYNTHETIC_PRIVATE_VALUE`, message: 'synthetic-sensitive-message' }, 'publish');
    expect(unknown.message).toBe('npm publish failed.');
  });

  it('retains a safe authorization hint when a failed publication is not visible in the registry', async () => {
    const h = harness();
    h.onPublish(() => { throw npmFailure({ code: 1, stderr: 'npm error code ENEEDAUTH' }, 'publish'); });
    await expect(h.run()).rejects.toThrow('ENEEDAUTH; exit 1');
    expect(h.events.filter(event => event.startsWith('publish:'))).toHaveLength(1);
    expect(h.fetch).toHaveBeenCalledTimes(2 + CONFIRMATION_ATTEMPTS);
  });

  it('leaves an acknowledged first package resumable when the second publish fails', async () => {
    const h = harness();
    h.onPublish(name => {
      if (name === names[1]) throw new Error('Synthetic second package failure');
      h.registry.set(name, metadata(name));
    });
    await expect(h.run()).rejects.toThrow('earlier packages may be published');
    h.onPublish(name => { h.registry.set(name, metadata(name)); });
    h.events.length = 0;
    expect((await h.run()).map((item: any) => item.status)).toEqual(['existing', 'published']);
    expect(h.events.filter(event => event.startsWith('publish:'))).toEqual([`publish:${names[1]}`]);
  });

  it.each([401, 403, 429, 500, 503])('does not treat HTTP %i as a missing package', async status => {
    const h = harness();
    h.fetch.mockResolvedValueOnce(response(status));
    await expect(h.run()).rejects.toThrow(`HTTP ${status}`);
    expect(h.events.some(event => event.startsWith('publish:'))).toBe(false);
  });

  it.each(['network', 'json', 'shape', 'identity'])('fails preflight on %s registry errors', async kind => {
    const h = harness();
    if (kind === 'network') h.fetch.mockRejectedValueOnce(new Error('Synthetic network failure'));
    if (kind === 'json') h.fetch.mockResolvedValueOnce({ status: 200, json: async () => { throw new Error('Synthetic invalid JSON'); } });
    if (kind === 'shape') h.registry.set(names[0], { error: 'Synthetic registry error' });
    if (kind === 'identity') h.registry.set(names[0], { ...metadata(names[0]), version: '2.3.3' });
    await expect(h.run()).rejects.toThrow();
    expect(h.events.some(event => event.startsWith('publish:'))).toBe(false);
  });

  it('accepts a definitive 404 without interpreting an error body as metadata', async () => {
    const fetch = vi.fn(async () => ({ status: 404, json: async () => { throw new Error('Not JSON'); } }));
    expect(await registryVersion(names[0], version, fetch)).toBeNull();
  });

  it('uses fresh anonymous cache-bypassing URLs for every exact-version lookup', async () => {
    const fetch = vi.fn(async (_url: string, _options: any) => response(404));
    await registryVersion(names[0], version, fetch);
    await registryVersion(names[0], version, fetch);
    const urls = fetch.mock.calls.map(([url]) => new URL(url));
    expect(urls[0].href).not.toBe(urls[1].href);
    for (const [url, options] of fetch.mock.calls) {
      const parsed = new URL(url);
      expect(parsed.origin).toBe(REGISTRY);
      expect(parsed.username).toBe('');
      expect(parsed.password).toBe('');
      expect(parsed.pathname).toBe(`/${encodeURIComponent(names[0])}/${version}`);
      expect([...parsed.searchParams.keys()]).toEqual(['release_check']);
      expect(options.headers).toEqual({ accept: 'application/json', 'cache-control': 'no-cache' });
      expect(options.redirect).toBe('error');
    }
  });

  it('requires an OIDC-capable npm before a publish attempt', async () => {
    const h = harness();
    h.runNpm.mockResolvedValueOnce('11.5.0');
    await expect(h.run()).rejects.toThrow('npm 11.5.1 or later');
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('stops if an archive changes after registry preflight and before publication', async () => {
    const h = harness();
    const lookup = h.fetch.getMockImplementation()!;
    h.fetch.mockImplementation(async (url, options) => {
      const result = await lookup(url, options);
      for (const [archive, name] of h.archives) {
        if (name === names[0]) await fs.writeFile(archive, 'changed after packing');
      }
      return result;
    });
    await expect(h.run()).rejects.toThrow('Packed artifact changed');
    expect(h.events.some(event => event.startsWith('publish:'))).toBe(false);
  });

  it('rejects malformed pack output and mismatched packed bytes before registry access', async () => {
    for (const output of ['not JSON', JSON.stringify([{ name: names[0], version, filename: '../escape.tgz' }]),
      JSON.stringify([{ name: names[0], version, filename: 'missing.tgz', integrity: 'sha512-invalid' }])]) {
      const h = harness();
      h.runNpm.mockResolvedValueOnce(output);
      await expect(h.run(true)).rejects.toThrow();
      expect(h.fetch).not.toHaveBeenCalled();
    }
    const h = harness();
    const run = h.runNpm.getMockImplementation()!;
    h.runNpm.mockImplementation(async (args, options) => {
      const output = await run(args, options);
      if (args[0] === 'pack') {
        const [item] = JSON.parse(output);
        await fs.writeFile(path.join(options.cwd, item.filename), 'changed synthetic bytes');
      }
      return output;
    });
    await expect(h.run()).rejects.toThrow('Packed integrity mismatch');
    expect(h.fetch).not.toHaveBeenCalled();
  });
});
