'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function stableVersion(value, label) {
  // The trim check also rejects the terminal newline accepted by RegExp's $.
  if (typeof value !== 'string' || value.trim() !== value || !STABLE.test(value)) {
    throw new Error(`${label} must be a stable X.Y.Z version.`);
  }
  return value;
}

function manifestVersion(text, label) {
  let manifest;
  try { manifest = JSON.parse(text); } catch { throw new Error(`Cannot parse ${label} package.json.`); }
  return stableVersion(manifest?.version, `${label} package.json version`);
}

async function readBefore(root, sha) {
  try {
    const { stdout } = await execFileAsync('git', ['--no-replace-objects', 'show', `${sha}:package.json`],
      { cwd: root, timeout: 30_000, maxBuffer: 1024 * 1024 });
    return stdout;
  } catch {
    throw new Error('Cannot read package.json at the push event before SHA. Restore the predecessor history or use explicit manual recovery.');
  }
}

/** Compare the entire push, not just HEAD's parent. No Git or registry mutations. */
async function selectRelease({ eventName, before, requestedVersion, deleted = '', root = path.resolve(__dirname, '..') }, dependencies = {}) {
  if (!['push', 'workflow_dispatch'].includes(eventName)) throw new Error('Unsupported release event.');
  if (eventName === 'push') {
    if (!['', 'true', 'false'].includes(deleted)) throw new Error('Invalid branch deletion flag.');
    if (deleted === 'true') return { publish: false };
    if (typeof before !== 'string' || before.length !== 40 || !/^[0-9a-f]{40}$/i.test(before)) {
      throw new Error('The push event must provide a valid before commit SHA.');
    }
    if (/^0{40}$/.test(before)) throw new Error('A new branch has no predecessor version. Use explicit manual recovery.');
  }
  let currentText;
  try { currentText = await (dependencies.readFile || fs.readFile)(path.join(root, 'package.json'), 'utf8'); }
  catch { throw new Error('Cannot read current package.json.'); }
  const version = manifestVersion(currentText, 'Current');
  if (eventName === 'workflow_dispatch') {
    if (stableVersion(requestedVersion, 'Requested version') !== version) {
      throw new Error('Requested version does not match current package.json.');
    }
    return { publish: true, version };
  }
  const previous = manifestVersion(await (dependencies.readBefore || readBefore)(root, before), 'Predecessor');
  const currentParts = version.split('.').map(BigInt);
  const previousParts = previous.split('.').map(BigInt);
  const difference = currentParts.findIndex((part, index) => part !== previousParts[index]);
  if (difference < 0) return { publish: false, version };
  if (currentParts[difference] < previousParts[difference]) throw new Error('Version downgrade detected; automatic publication is refused.');
  return { publish: true, version };
}

async function runFromEnvironment(environment = process.env, dependencies = {}) {
  if (!environment.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required.');
  const result = await selectRelease({ eventName: environment.GITHUB_EVENT_NAME,
    before: environment.RELEASE_BEFORE, deleted: environment.RELEASE_DELETED || '',
    requestedVersion: environment.RELEASE_VERSION, root: dependencies.root }, dependencies);
  // Only a fixed boolean and a validated version can enter the output file.
  const output = `publish=${result.publish}\n${result.version ? `version=${result.version}\n` : ''}`;
  await (dependencies.appendFile || fs.appendFile)(environment.GITHUB_OUTPUT, output);
  (dependencies.log || console.log)(result.publish ? `Selected npm release ${result.version}.` : 'No version increase; npm publication skipped.');
  return result;
}

module.exports = { selectRelease, runFromEnvironment };
if (require.main === module) {
  runFromEnvironment().catch(error => { console.error(error.message); process.exitCode = 1; });
}
