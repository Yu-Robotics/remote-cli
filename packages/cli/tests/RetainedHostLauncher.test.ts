import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareRetainedHostInstallation, supervisedLauncher, type RetainedInstallationInput } from '../src/sessionHost/RetainedHostLauncher';
import { hostConfigArgument } from '../src/sessionHost/entry';
import { HostServer } from '../src/sessionHost/HostServer';
import { HostClient } from '../src/sessionHost/HostClient';
import { SessionHostSupervisor } from '../src/service/SessionHostSupervisor';
import type { VerifiedHostFile } from '../src/update/PinnedHostBundle';

const digest = (data: string) => createHash('sha256').update(data).digest('hex');
let root: string;
let input: RetainedInstallationInput;
let server: HostServer | undefined;
let client: HostClient | undefined;
function file(base: string, name: string, content: string, mode = 0o644): VerifiedHostFile {
  const filename = path.join(base, name); fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, content); fs.chmodSync(filename, mode);
  return { path: name, sha256: digest(content), mode: fs.statSync(filename).mode & 0o777 };
}
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'retained-launch-')));
  const pkg = path.join(root, 'distribution');
  const files = [file(pkg, 'package.json', '{"name":"synthetic-runtime"}'),
    file(pkg, 'dist/sessionHost/entry.js', 'module.exports = {};')];
  const node = file(root, 'node', 'synthetic interpreter', 0o755);
  input = { homeDir: root, installationId: 'synthetic-installation', bundle: {
    storeRoot: path.join(root, 'bundles'), package: { root: pkg, files }, dependencies: [], entry: 'dist/sessionHost/entry.js',
    node: { path: path.join(root, 'node'), sha256: node.sha256, mode: node.mode },
  } };
});
afterEach(async () => {
  client?.close(); client = undefined;
  await server?.stop(); server = undefined;
  vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true });
});
function installation(launch: string) {
  const record = JSON.parse(fs.readFileSync(launch, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(record.context.descriptorPath, 'utf8'));
  const connection = { address: { installationId: input.installationId, hostId: 'synthetic-host', port: 12345 },
    secret: manifest.secret, launcherSecret: manifest.launcherSecret, directory: path.join(manifest.directory, 'control') };
  const publish = () => fs.writeFileSync(manifest.descriptorFile, JSON.stringify(connection), { mode: 0o600 });
  const ensureStarted = vi.fn(async () => ({ state: 'running' as const, serviceName: 'synthetic', servicePath: path.join(root, 'service') }));
  return { record, manifest, connection, publish, ensureStarted };
}

it('prepares immutable private metadata without starting a service and reuses the same credentials', async () => {
  const start = vi.spyOn(SessionHostSupervisor.prototype, 'ensureStarted');
  const launch = await prepareRetainedHostInstallation(input);
  const first = installation(launch);
  expect(await prepareRetainedHostInstallation(input)).toBe(launch);
  expect(installation(launch).manifest).toEqual(first.manifest);
  expect(first.record.context.descriptorSha256).toBe(digest(fs.readFileSync(first.record.context.descriptorPath, 'utf8')));
  expect(start).not.toHaveBeenCalled();
  expect(fs.readFileSync(launch, 'utf8')).not.toContain(first.manifest.secret);
  if (process.platform !== 'win32') expect(fs.statSync(launch).mode & 0o077).toBe(0);
  expect(hostConfigArgument(['--config', first.record.context.descriptorPath])).toBe(first.record.context.descriptorPath);
});

it('refuses to replace an existing host installation with changed runtime input', async () => {
  const launch = await prepareRetainedHostInstallation(input);
  const original = fs.readFileSync(launch, 'utf8');
  input.bundle.package.files[1] = file(input.bundle.package.root, 'dist/sessionHost/entry.js', 'module.exports = { changed: true };');
  await expect(prepareRetainedHostInstallation(input)).rejects.toThrow('cannot be replaced');
  expect(fs.readFileSync(launch, 'utf8')).toBe(original);
});

it('refuses an unrelated entry and malformed or changed identity metadata', async () => {
  input.bundle.entry = 'package.json';
  await expect(prepareRetainedHostInstallation(input)).rejects.toThrow('retained-host entry');
  input.bundle.entry = 'dist/sessionHost/entry.js';
  const launch = await prepareRetainedHostInstallation(input);
  const fixture = installation(launch);
  fs.writeFileSync(fixture.record.context.descriptorPath, JSON.stringify({ ...fixture.manifest, installationId: 'changed' }));
  await expect(prepareRetainedHostInstallation(input)).rejects.toThrow('identity changed');
  await expect(supervisedLauncher(launch, { supervisor: () => fixture }).connect()).rejects.toThrow('integrity changed');
  expect(fixture.ensureStarted).not.toHaveBeenCalled();
});

it('attaches to the independently started host and verifies its signed protocol without native dispatch', async () => {
  const launch = await prepareRetainedHostInstallation(input);
  const fixture = installation(launch);
  const execute = vi.fn(async () => null);
  const supervisor = vi.fn(() => ({ ensureStarted: async () => {
    server = new HostServer({ directory: fixture.connection.directory, installationId: input.installationId,
      secret: fixture.manifest.secret, launcherSecret: fixture.manifest.launcherSecret,
      runtime: { authorityId: 'synthetic-owner', execute, stop: async () => {} } });
    fixture.connection.address = await server.listen(); fixture.publish();
    return fixture.ensureStarted();
  } }));
  const connection = await supervisedLauncher(launch, { supervisor }).connect();
  client = new HostClient(connection.address, connection.launcherSecret);
  expect((await client.hello()).authorityId).toBe('synthetic-owner');
  expect(supervisor).toHaveBeenCalledWith(fixture.record.context);
  expect(execute).not.toHaveBeenCalled();
});

it('waits for a descriptor after one launch and never restarts a host on readiness timeout', async () => {
  const launch = await prepareRetainedHostInstallation(input);
  const fixture = installation(launch);
  await expect(supervisedLauncher(launch, { supervisor: () => fixture, startupTimeoutMs: 5 }).connect()).rejects.toThrow('readiness is unresolved');
  expect(fixture.ensureStarted).toHaveBeenCalledTimes(1);
  fixture.publish();
  expect(await supervisedLauncher(launch, { supervisor: () => fixture }).connect()).toEqual(fixture.connection);
});

it('rejects mismatched connection metadata and manager uncertainty', async () => {
  const launch = await prepareRetainedHostInstallation(input);
  const fixture = installation(launch);
  fixture.connection.address.installationId = 'another-installation'; fixture.publish();
  await expect(supervisedLauncher(launch, { supervisor: () => fixture }).connect()).rejects.toThrow('does not belong');
  const unknown = { ensureStarted: async () => ({ state: 'unknown' as const, serviceName: 'synthetic', servicePath: 'synthetic' }) };
  await expect(supervisedLauncher(launch, { supervisor: () => unknown }).connect()).rejects.toThrow('launch is unresolved');
});

describe.skipIf(process.platform === 'win32')('supported production supervisor selection', () => {
  it('uses the actual supervisor API when no fixture launcher is injected', async () => {
    const launch = await prepareRetainedHostInstallation(input);
    const fixture = installation(launch); fixture.publish();
    const start = vi.spyOn(SessionHostSupervisor.prototype, 'ensureStarted').mockImplementation(fixture.ensureStarted);
    expect(await supervisedLauncher(launch).connect()).toEqual(fixture.connection);
    expect(start).toHaveBeenCalledOnce();
  });
});

it('rejects malformed options and CLI arguments before any startup', async () => {
  expect(() => supervisedLauncher('unused', { startupTimeoutMs: 0 })).toThrow('timeout');
  expect(() => hostConfigArgument(['--manifest', root])).toThrow('--config');
  expect(() => hostConfigArgument(['--config', 'relative'])).toThrow('--config');
  expect(() => hostConfigArgument(['--config', root, 'extra'])).toThrow('--config');
  await expect(prepareRetainedHostInstallation({ ...input, homeDir: 'relative' })).rejects.toThrow('canonical');
  const launch = await prepareRetainedHostInstallation(input);
  fs.writeFileSync(launch, JSON.stringify({ version: 2, context: {} }));
  await expect(supervisedLauncher(launch).connect()).rejects.toThrow('format');
});
