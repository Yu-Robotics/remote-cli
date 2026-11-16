import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import { startRetainedHost } from '../src/sessionHost/entry';
import { ConfigManager } from '../src/config/ConfigManager';
import { ThreadExecutorPool } from '../src/thread/ThreadExecutorPool';
import { RetainedRuntime } from '../src/sessionHost/RetainedRuntime';
import { HostServer } from '../src/sessionHost/HostServer';
import { WebSocketClient } from '../src/client/WebSocketClient';
import { kernelGate } from '../src/delegation/OwnershipRuntime';

vi.mock('../src/config/ConfigManager');
vi.mock('../src/thread/ThreadManager', () => ({ ThreadManager: { initialize: vi.fn(async () => ({ fixture: true })) } }));
vi.mock('../src/thread/ThreadExecutorPool', () => ({ ThreadExecutorPool: vi.fn() }));
vi.mock('../src/security/DirectoryGuard', () => ({ DirectoryGuard: vi.fn() }));
vi.mock('../src/client/WebSocketClient', () => ({ WebSocketClient: vi.fn() }));
vi.mock('../src/files/DeviceIdentity', () => ({ loadIdentity: vi.fn(async () => undefined) }));
vi.mock('../src/utils/BackendEnvironment', () => ({ initializeBackendEnvironment: vi.fn() }));
vi.mock('../src/delegation/OwnershipRuntime', () => ({ kernelGate: vi.fn(), syncDirectory: vi.fn() }));
vi.mock('../src/sessionHost/RetainedRuntime', () => ({ RetainedRuntime: vi.fn() }));
vi.mock('../src/sessionHost/HostServer', () => ({ HostServer: vi.fn() }));
let root: string;
let manifestFile: string;
let manifest: any;
let config: any;
let runtime: any;
let server: any;
let gate: any;
beforeEach(() => {
  vi.clearAllMocks();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'retained-entry-')));
  manifest = { directory: path.join(root, 'host'), installationId: 'fixture-installation', secret: randomBytes(32).toString('hex'),
    launcherSecret: randomBytes(32).toString('hex'), descriptorFile: path.join(root, 'descriptor.json') };
  manifestFile = path.join(root, 'manifest.json'); fs.writeFileSync(manifestFile, JSON.stringify(manifest), { mode: 0o600 });
  config = { deviceId: 'synthetic-device', serverUrl: 'https://example.com', security: { allowedDirectories: [root] }, service: { running: false } };
  vi.mocked(ConfigManager.initialize).mockResolvedValue({ getAll: () => config, getConfigDir: () => root } as any);
  gate = { close: vi.fn() }; vi.mocked(kernelGate).mockReturnValue(gate);
  runtime = { authorityId: 'fixture-runtime', start: vi.fn(async () => {}), execute: vi.fn(async () => null), inspect: vi.fn(async () => null),
    stop: vi.fn(async () => {}), assertCanStop: vi.fn() };
  vi.mocked(RetainedRuntime).mockImplementation(() => runtime);
  vi.mocked(HostServer).mockImplementation(options => server = { listen: vi.fn(async () => ({ port: 12345, hostId: 'fixture-host', installationId: manifest.installationId })),
    stop: vi.fn(options.runtime.stop) } as any);
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

it('composes only native authority and one Router in the independently launched entry, with private descriptor', async () => {
  const result = await startRetainedHost(manifestFile);
  expect(result).toEqual({ host: server, runtime });
  expect(ThreadExecutorPool).toHaveBeenCalledOnce(); expect(WebSocketClient).toHaveBeenCalledOnce();
  expect(vi.mocked(WebSocketClient).mock.calls[0][2]).toMatchObject({ capabilityProfile: 'retained-runtime' });
  await vi.mocked(WebSocketClient).mock.calls[0][2]!.identityLoader!();
  expect(JSON.parse(fs.readFileSync(manifest.descriptorFile, 'utf8'))).toEqual({ address: await server.listen(),
    directory: path.join(manifest.directory, 'control'), secret: manifest.secret, launcherSecret: manifest.launcherSecret });
  if (process.platform !== 'win32') expect(fs.statSync(manifest.descriptorFile).mode & 0o077).toBe(0);
  expect(fs.existsSync(path.join(root, 'retained-host-mode.json'))).toBe(true);
  const owner = vi.mocked(HostServer).mock.calls[0][0].runtime;
  owner.assertCanStop!(); await owner.inspect!('state', null); await owner.execute({ requestId: 'test', method: 'read', args: null });
  expect(runtime.assertCanStop).toHaveBeenCalledOnce(); expect(runtime.execute).toHaveBeenCalledOnce();
  await result.host.stop(); expect(runtime.stop).toHaveBeenCalledOnce(); expect(gate.close).toHaveBeenCalledOnce();
});
it('refuses first adoption of running legacy state and conflicting Router ownership before allocating executors', async () => {
  config.service.running = true;
  await expect(startRetainedHost(manifestFile)).rejects.toThrow('First adoption is unsupported');
  expect(kernelGate).not.toHaveBeenCalled(); expect(ThreadExecutorPool).not.toHaveBeenCalled();
  config.service.running = false; vi.mocked(kernelGate).mockReturnValueOnce(undefined);
  await expect(startRetainedHost(manifestFile)).rejects.toThrow('Another client');
  expect(ThreadExecutorPool).not.toHaveBeenCalled();
});
it('preserves state and releases startup ownership on runtime and listener failures', async () => {
  runtime.start.mockRejectedValueOnce(new Error('Fixture start failure'));
  await expect(startRetainedHost(manifestFile)).rejects.toThrow('Fixture start failure');
  expect(runtime.stop).toHaveBeenCalledOnce(); expect(gate.close).toHaveBeenCalled();
  expect(fs.existsSync(manifest.descriptorFile)).toBe(false);
  vi.mocked(RetainedRuntime).mockImplementationOnce(() => { throw new Error('Fixture constructor failure'); });
  await expect(startRetainedHost(manifestFile)).rejects.toThrow('Fixture constructor failure');
});
it('rejects unsafe manifests and incomplete configuration before connecting', async () => {
  manifest.directory = 'relative'; fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  await expect(startRetainedHost(manifestFile)).rejects.toThrow('Invalid retained host manifest');
  manifest.directory = root; fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  config.deviceId = undefined;
  await expect(startRetainedHost(manifestFile)).rejects.toThrow('Complete device configuration');
  expect(WebSocketClient).not.toHaveBeenCalled();
});
