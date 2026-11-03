#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: sleep } = require('node:timers/promises');

const REGISTRY = 'https://registry.npmjs.org';
const CONFIRMATION_ATTEMPTS = 121;
const CONFIRMATION_INTERVAL_MS = 5_000;
const REPOSITORY = 'git+https://github.com/Yu-Robotics/remote-cli.git';
const PACKAGES = [
  { directory: 'packages/cli', name: '@yu_robotics/remote-cli' },
  { directory: 'packages/router', name: '@yu_robotics/remote-cli-router' },
];
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const execFileAsync = promisify(execFile);
const NPM_ERROR_CODES = new Set([
  'E401', 'E403', 'E404', 'E429', 'ENEEDAUTH', 'EOTP', 'EUSAGE', 'EPRIVATE',
  'EPUBLISHCONFLICT', 'EINTEGRITY', 'EINVALIDPROVENANCE', 'ETIMEDOUT',
  'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN',
]);

// Preserve only known codes and a numeric exit status, never raw npm output.
function npmFailure(error, command) {
  const reportedCode = typeof error?.stderr === 'string'
    ? error.stderr.match(/^npm (?:error|ERR!) code ([A-Z0-9_]+)\s*$/m)?.[1] : undefined;
  const npmCode = [error?.npmCode, reportedCode].find(code => NPM_ERROR_CODES.has(code));
  const exitCode = [error?.exitCode, error?.code].find(code => Number.isInteger(code) && code >= 0 && code <= 255);
  const details = [npmCode, exitCode === undefined ? undefined : `exit ${exitCode}`].filter(Boolean);
  const hint = ['E401', 'E403', 'E404', 'ENEEDAUTH', 'EOTP'].includes(npmCode)
    ? ' Check npm Trusted Publisher repository, workflow filename, environment, and direct-publishing permission.' : '';
  return Object.assign(new Error(`npm ${command} failed${details.length ? ` (${details.join('; ')})` : ''}.${hint}`),
    { npmCode, exitCode });
}

function parseArguments(args) {
  let version;
  let check = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--version' && version === undefined) version = args[++index];
    else if (args[index] === '--check' && !check) check = true;
    else throw new Error('Usage: node scripts/publish-npm.cjs --version X.Y.Z [--check]');
  }
  if (!version || !STABLE_VERSION.test(version)) throw new Error('A stable --version X.Y.Z is required.');
  return { version, check };
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { throw new Error(`Cannot read valid JSON from ${path.basename(file)}.`); }
}

async function preflight(root, version) {
  if (typeof version !== 'string' || !STABLE_VERSION.test(version)) throw new Error('A stable version X.Y.Z is required.');
  const manifest = await readJson(path.join(root, 'package.json'));
  const lock = await readJson(path.join(root, 'package-lock.json'));
  if (manifest.private !== true) throw new Error('The repository root must remain private.');
  for (const [label, value] of [
    ['root manifest', manifest.version], ['lockfile', lock.version], ['lockfile root', lock.packages?.['']?.version],
  ]) {
    if (value !== version) throw new Error(`Version mismatch in ${label}; expected ${version}.`);
  }
  for (const entry of PACKAGES) {
    const pkg = await readJson(path.join(root, entry.directory, 'package.json'));
    if (pkg.version !== version || lock.packages?.[entry.directory]?.version !== version) {
      throw new Error(`Version mismatch for ${entry.name}; expected ${version}.`);
    }
    if (pkg.name !== entry.name || pkg.private === true || pkg.publishConfig?.access !== 'public') {
      throw new Error(`Invalid public package identity or access for ${entry.directory}.`);
    }
    if (pkg.repository?.type !== 'git' || pkg.repository?.url !== REPOSITORY
      || pkg.repository?.directory !== entry.directory) {
      throw new Error(`Repository attribution mismatch for ${entry.name}; expected ${REPOSITORY}.`);
    }
    if (pkg.publishConfig?.registry !== undefined && pkg.publishConfig.registry !== REGISTRY) {
      throw new Error(`Unexpected publish registry for ${entry.name}.`);
    }
  }
}

// Invoke npm's JavaScript entry point directly, including on Windows. No shell
// interpolation is used for repository paths, temporary paths, or arguments.
async function findNpmCli() {
  const candidates = [path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')];
  if (process.env.npm_execpath && path.basename(process.env.npm_execpath) === 'npm-cli.js') {
    candidates.unshift(process.env.npm_execpath);
  }
  for (const directory of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(directory, 'node_modules/npm/bin/npm-cli.js'));
    try { candidates.push(await fs.realpath(path.join(directory, 'npm'))); } catch { /* Try other PATH entries. */ }
  }
  for (const candidate of candidates) {
    if (path.basename(candidate) !== 'npm-cli.js') continue;
    try { if ((await fs.stat(candidate)).isFile()) return candidate; } catch { /* Try the next installation. */ }
  }
  throw new Error('Cannot locate npm-cli.js; install Node with npm available on PATH.');
}

async function runNpm(args, options) {
  const cli = await findNpmCli();
  try {
    const result = await execFileAsync(process.execPath, [cli, ...args], {
      ...options, timeout: 5 * 60_000, maxBuffer: 4 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    throw npmFailure(error, args[0]);
  }
}

function isolatedEnvironment(directory, inherited) {
  const environment = Object.fromEntries(Object.entries(inherited).filter(([key]) =>
    !/^npm_config_/i.test(key) && !/^(HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|NODE_AUTH_TOKEN|NPM_TOKEN)$/i.test(key)));
  return { ...environment, HOME: directory, USERPROFILE: directory,
    npm_config_userconfig: path.join(directory, 'user.npmrc'),
    npm_config_globalconfig: path.join(directory, 'global.npmrc'),
    npm_config_cache: path.join(directory, 'cache'), npm_config_update_notifier: 'false',
    npm_config_registry: REGISTRY, npm_config_fetch_retries: '0' };
}

async function integrityOf(file) {
  return `sha512-${createHash('sha512').update(await fs.readFile(file)).digest('base64')}`;
}

async function pack(root, entry, version, temporary, invoke, environment) {
  const output = await invoke(['pack', path.join(root, entry.directory), '--ignore-scripts', '--json',
    '--pack-destination', temporary, `--registry=${REGISTRY}`], { cwd: temporary, env: environment });
  let packed;
  try { packed = JSON.parse(output); } catch { throw new Error(`Invalid npm pack response for ${entry.name}.`); }
  const item = Array.isArray(packed) && packed.length === 1 ? packed[0] : undefined;
  if (!item || item.name !== entry.name || item.version !== version || typeof item.filename !== 'string'
    || path.basename(item.filename) !== item.filename || !item.filename.endsWith('.tgz')) {
    throw new Error(`Invalid npm pack metadata for ${entry.name}.`);
  }
  const file = path.join(temporary, item.filename);
  if (!(await fs.lstat(file)).isFile()) throw new Error(`Packed artifact is not a regular file for ${entry.name}.`);
  const integrity = await integrityOf(file);
  if (item.integrity !== integrity) throw new Error(`Packed integrity mismatch for ${entry.name}.`);
  return { name: entry.name, version, file, integrity };
}

/** Anonymous, exact-version lookup. Only an actual HTTP 404 means absent. */
async function registryVersion(name, version, fetchImpl = globalThis.fetch) {
  let response;
  try {
    response = await fetchImpl(`${REGISTRY}/${encodeURIComponent(name)}/${encodeURIComponent(version)}?release_check=${randomUUID()}`, {
      headers: { accept: 'application/json', 'cache-control': 'no-cache' }, redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
  } catch { throw new Error(`Registry lookup failed for ${name}@${version}; publication status is unknown.`); }
  if (response.status === 404) return null;
  if (response.status !== 200) throw new Error(`Registry lookup returned HTTP ${response.status} for ${name}@${version}.`);
  let data;
  try { data = await response.json(); } catch { throw new Error(`Malformed registry response for ${name}@${version}.`); }
  if (data?.name !== name || data.version !== version || typeof data.dist?.integrity !== 'string'
    || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(data.dist.integrity)) {
    throw new Error(`Invalid registry metadata for ${name}@${version}.`);
  }
  return data.dist.integrity;
}

/** The caller must build and test first. Dependencies are injectable for offline tests. */
async function publishRelease({ version, check = false, root = path.resolve(__dirname, '..') }, dependencies = {}) {
  await preflight(root, version);
  const invoke = dependencies.runNpm || runNpm;
  const lookup = (name) => registryVersion(name, version, dependencies.fetch || globalThis.fetch);
  const wait = dependencies.sleep || sleep;
  const log = dependencies.log || console.log;
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'remote-cli-npm-release-')));
  try {
    // Stop npm's project-root search here, including when the OS temporary
    // directory is under a user's home on Windows.
    await fs.writeFile(path.join(temporary, 'package.json'), JSON.stringify({ private: true }));
    await fs.writeFile(path.join(temporary, 'user.npmrc'), '');
    await fs.writeFile(path.join(temporary, 'global.npmrc'), '');
    const environment = isolatedEnvironment(temporary, dependencies.environment || process.env);
    if (!check) {
      const npmVersion = (await invoke(['--version'], { cwd: temporary, env: environment })).trim();
      const parts = STABLE_VERSION.test(npmVersion) ? npmVersion.split('.').map(Number) : [];
      if (!(parts[0] > 11 || parts[0] === 11 && (parts[1] > 5 || parts[1] === 5 && parts[2] >= 1))) {
        throw new Error('OIDC publishing requires npm 11.5.1 or later.');
      }
    }
    const artifacts = [];
    for (const entry of PACKAGES) artifacts.push(await pack(root, entry, version, temporary, invoke, environment));
    if (check) {
      log('Local release checks passed; both packages packed. Registry availability was not checked.');
      return artifacts.map(({ name, integrity }) => ({ name, version, integrity, status: 'packed' }));
    }
    // Complete both lookups and detect conflicts before the first registry write.
    const existing = await Promise.all(artifacts.map(artifact => lookup(artifact.name)));
    for (const [index, artifact] of artifacts.entries()) {
      if (existing[index] !== null && existing[index] !== artifact.integrity) {
        throw new Error(`Integrity conflict for ${artifact.name}@${version}; no packages were published. Use the original source or a new version.`);
      }
    }
    const results = [];
    for (const [index, artifact] of artifacts.entries()) {
      let status = 'existing';
      if (existing[index] === null) {
        if (await integrityOf(artifact.file) !== artifact.integrity) throw new Error(`Packed artifact changed for ${artifact.name}.`);
        let failure;
        try {
          await invoke(['publish', artifact.file, '--ignore-scripts', '--access', 'public', `--registry=${REGISTRY}`],
            { cwd: temporary, env: environment });
        } catch (error) { failure = npmFailure(error, 'publish').message; }
        const diagnostic = failure ? ` ${failure}` : '';
        // Allow ten minutes between the first and final confirmation lookups.
        // Poll only absent metadata: publication may precede registry visibility.
        // Never retry the publish command, even after a timeout or lost response.
        let confirmed;
        try {
          for (let attempt = 0; attempt < CONFIRMATION_ATTEMPTS; attempt++) {
            confirmed = await lookup(artifact.name);
            if (confirmed !== null) break;
            if (attempt + 1 < CONFIRMATION_ATTEMPTS) await wait(CONFIRMATION_INTERVAL_MS);
          }
        }
        catch {
          throw new Error(`Cannot verify ${artifact.name}@${version} after its publish attempt.${diagnostic} No publish retry was made; earlier packages may be published. Reconcile from the same source before retrying.`);
        }
        if (confirmed !== artifact.integrity) {
          throw new Error(`Publish attempt for ${artifact.name}@${version} was not confirmed with matching integrity.${diagnostic} No publish retry was made; earlier packages may be published. Reconcile from the same source before retrying.`);
        }
        status = failure ? 'reconciled' : 'published';
      }
      log(`${artifact.name}@${version}: ${status}; integrity verified.`);
      results.push({ name: artifact.name, version, integrity: artifact.integrity, status });
    }
    return results;
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

module.exports = { parseArguments, preflight, registryVersion, publishRelease, isolatedEnvironment, npmFailure,
  REGISTRY, REPOSITORY, CONFIRMATION_ATTEMPTS, CONFIRMATION_INTERVAL_MS };

if (require.main === module) {
  Promise.resolve().then(() => publishRelease(parseArguments(process.argv.slice(2)))).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
