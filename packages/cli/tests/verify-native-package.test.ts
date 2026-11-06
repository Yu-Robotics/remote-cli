import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const cliRoot = fileURLToPath(new URL('..', import.meta.url));
const targets = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64'];
const source = Buffer.from('/* Synthetic native helper source. */\n');
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const invoke = promisify(execFile);

// Use npm's JavaScript entry point to avoid shell and .cmd quoting differences.
async function npmCli() {
  const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')];
  for (const directory of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(directory, 'node_modules/npm/bin/npm-cli.js'));
    try { candidates.push(await fs.realpath(path.join(directory, 'npm'))); } catch { /* Try the next installation. */ }
  }
  for (const candidate of candidates) {
    if (!candidate || path.basename(candidate) !== 'npm-cli.js') continue;
    try { if ((await fs.stat(candidate)).isFile()) return candidate; } catch { /* Try the next installation. */ }
  }
  throw new Error('Cannot locate npm-cli.js for the local packaging test.');
}

describe('native package artifact coverage', () => {
  let root: string;
  let environment: NodeJS.ProcessEnv;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-package-test-')));
    await fs.mkdir(path.join(root, 'scripts'));
    await fs.mkdir(path.join(root, 'native'));
    await fs.copyFile(path.join(cliRoot, 'scripts/verify-native-package.cjs'), path.join(root, 'scripts/verify-native-package.cjs'));
    await fs.writeFile(path.join(root, 'native/managed_native.c'), source);
    // A package root and explicit empty npm configs prevent searching the user's home.
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'synthetic-native-package', version: '1.0.0' }));
    await fs.writeFile(path.join(root, 'user.npmrc'), '');
    await fs.writeFile(path.join(root, 'global.npmrc'), '');
    environment = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|ComSpec|PATHEXT|TEMP|TMP|TMPDIR)$/i.test(key))),
      HOME: root, USERPROFILE: root,
      npm_config_userconfig: path.join(root, 'user.npmrc'),
      npm_config_globalconfig: path.join(root, 'global.npmrc'),
      npm_config_cache: path.join(root, 'cache'),
      npm_config_update_notifier: 'false', npm_config_offline: 'true',
    };
    for (const target of targets) {
      const [platform, arch] = target.split('-');
      const directory = path.join(root, 'native/prebuilds', target);
      const binary = Buffer.from(`Synthetic native helper for ${target}`);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, 'managed_native.node'), binary);
      await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
        protocol: 1, platform, arch, napi: 8, sha256: digest(binary), sourceSha256: digest(source),
      }));
    }
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function verify() {
    return invoke(process.execPath, [path.join(root, 'scripts/verify-native-package.cjs')], {
      cwd: root, env: environment, timeout: 10_000,
    });
  }

  it('accepts a complete six-target artifact set', async () => {
    expect((await verify()).stdout).toContain('All six tested native helper artifacts match this source.');
  });

  it.each(targets)('rejects a missing %s binary', async target => {
    await fs.unlink(path.join(root, 'native/prebuilds', target, 'managed_native.node'));
    await expect(verify()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(target) });
  });

  it.each(targets)('rejects a missing %s manifest', async target => {
    await fs.unlink(path.join(root, 'native/prebuilds', target, 'manifest.json'));
    await expect(verify()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(target) });
  });

  it.each([
    ['sha256', '0'.repeat(64)], ['sourceSha256', '0'.repeat(64)],
    ['platform', 'darwin'], ['arch', 'x64'], ['protocol', 2], ['napi', 9],
  ])('rejects mismatched linux-arm64 manifest field %s', async (field, value) => {
    const file = path.join(root, 'native/prebuilds/linux-arm64/manifest.json');
    const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
    manifest[field] = value;
    await fs.writeFile(file, JSON.stringify(manifest));
    await expect(verify()).rejects.toMatchObject({
      code: 1, stderr: expect.stringContaining('Invalid or mismatched native helper: linux-arm64'),
    });
  });

  it('includes all six binaries and manifests in a real npm archive using the CLI files allowlist', async () => {
    const { files } = JSON.parse(await fs.readFile(path.join(cliRoot, 'package.json'), 'utf8'));
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: 'synthetic-native-package', version: '1.0.0', files,
      scripts: { prepack: 'node -e "process.exit(99)"', prepare: 'node -e "process.exit(99)"' },
    }));
    const { stdout } = await invoke(process.execPath, [await npmCli(), 'pack', '--ignore-scripts', '--offline', '--json'], {
      cwd: root, env: environment, timeout: 25_000,
    });
    const [packed] = JSON.parse(stdout);
    expect((await fs.stat(path.join(root, packed.filename))).size).toBeGreaterThan(0);
    const entries = packed.files.map((entry: { path: string }) => entry.path);
    expect(entries.filter((entry: string) => entry.startsWith('native/prebuilds/')).sort()).toEqual(
      targets.flatMap(target => ['managed_native.node', 'manifest.json'].map(file => `native/prebuilds/${target}/${file}`)).sort(),
    );
    expect(entries).not.toContain('native/managed_native.c');
    expect(entries).not.toContain('scripts/verify-native-package.cjs');
  }, 30_000);
});
