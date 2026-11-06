import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { verify } from 'crypto';
import axios from 'axios';
import ora from 'ora';
import { initCommand } from '../../src/commands/init';
import { ConfigManager } from '../../src/config/ConfigManager';
import { loadIdentity } from '../../src/files/DeviceIdentity';
import * as durability from '../../src/output/Durable';

vi.mock('axios');
vi.mock('node-machine-id', () => ({ machineId: vi.fn(async () => 'synthetic-machine') }));
vi.mock('ora', () => ({ default: vi.fn(() => ({ start() { return this; }, succeed: vi.fn(), fail: vi.fn(), text: '' })) }));

describe('initial binding with device key enrollment', () => {
  let root: string;
  let values: Map<string, unknown>;
  let set: ReturnType<typeof vi.fn>;
  const serverUrl = 'https://router.example.com';
  const options = { serverUrl };
  const accepted = { success: true, deviceAuth: true, bindingCode: 'ABC-123-XYZ' };
  const request = () => vi.mocked(axios.post).mock.calls.at(-1)![1] as any;

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'init-files-')));
    vi.spyOn(os, 'homedir').mockReturnValue(root);
    vi.stubEnv('HOME', root);
    vi.stubEnv('USERPROFILE', root);
    vi.spyOn(os, 'hostname').mockReturnValue('synthetic-device');
    values = new Map();
    set = vi.fn(async (key, value) => { values.set(key, value); });
    vi.spyOn(ConfigManager, 'initialize').mockResolvedValue({ getConfigDir: () => root,
      has: (key: string) => values.has(key), get: (key: string) => values.get(key), set } as any);
    vi.mocked(axios.post).mockResolvedValue({ data: accepted });
  });
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });

  it('defaults the API to persisting a key before requesting signed binding and reports pending approval', async () => {
    vi.mocked(axios.post).mockImplementationOnce(async (_url, body: any) => {
      const saved = await loadIdentity(root, serverUrl, body.deviceId);
      expect(saved?.publicKey).toBe(body.devicePublicKey);
      expect(JSON.stringify(body)).not.toContain(saved!.privateKey);
      return { data: accepted };
    });
    const result = await initCommand(options);
    expect(result).toMatchObject({ success: true, bindingCode: accepted.bindingCode, keyEnrollmentRequested: true });
    const [url, body, settings] = vi.mocked(axios.post).mock.calls[0] as any;
    expect(url).toBe(`${serverUrl}/api/bind/request`);
    expect(settings).toMatchObject({ timeout: 10000, maxRedirects: 0, maxContentLength: 16384 });
    expect(verify(null, Buffer.from(`remote-cli-device-v1\n${body.deviceId}\n${body.nonce}`),
      body.devicePublicKey, Buffer.from(body.signature, 'base64'))).toBe(true);
    expect(Object.keys(body).sort()).toEqual(['deviceId', 'deviceName', 'devicePublicKey', 'nonce', 'signature']);
    expect(axios.post).toHaveBeenCalledOnce();
    expect(values.get('serverUrl')).toBe(serverUrl);
    expect(vi.mocked(ora).mock.results[0].value.succeed).toHaveBeenCalledWith(expect.stringContaining('approval is still required'));
    expect(JSON.stringify(result)).not.toContain('PRIVATE KEY');
  });

  it('keeps legacy initialization free of key creation and secure request fields', async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: { success: true, bindingCode: accepted.bindingCode } });
    expect(await initCommand({ serverUrl: 'http://router.example.com', withFiles: false })).toMatchObject({ success: true });
    expect(request()).toEqual({ deviceId: expect.any(String), deviceName: 'synthetic-device', platform: os.platform() });
    expect(await fs.readdir(root)).toEqual([]);
    expect(axios.post).toHaveBeenCalledOnce();
  });

  it('continues accepting explicit secure API enrollment', async () => {
    expect(await initCommand({ ...options, withFiles: true })).toMatchObject({ success: true, keyEnrollmentRequested: true });
    expect(request().devicePublicKey).toEqual(expect.any(String));
    expect(axios.post).toHaveBeenCalledOnce();
  });

  it('reuses the saved key across --force and never requests again without --force', async () => {
    await initCommand(options);
    const first = request();
    expect((await initCommand(options)).success).toBe(false);
    expect(axios.post).toHaveBeenCalledOnce();
    expect((await initCommand({ ...options, force: true })).success).toBe(true);
    expect(request().devicePublicKey).toBe(first.devicePublicKey);
    expect(request().nonce).not.toBe(first.nonce);
  });

  it.each(['network', 'disabled service', 'redirect'] as const)('retains the key and never falls back after %s failure', async failure => {
    vi.mocked(axios.post).mockRejectedValueOnce(Object.assign(new Error('synthetic-private-error'), {
      response: failure === 'network' ? undefined : { status: failure === 'redirect' ? 302 : 400, data: { error: 'synthetic-private-error' } },
    }));
    const result = await initCommand(options);
    expect(result.success).toBe(false);
    expect(result.error).not.toContain('synthetic-private-error');
    expect(result.error).toContain('--without-files');
    expect(set).not.toHaveBeenCalled();
    expect(axios.post).toHaveBeenCalledOnce();
    const first = request();
    expect((await initCommand(options)).success).toBe(true);
    expect(request().devicePublicKey).toBe(first.devicePublicKey);
  });

  it.each([null, {}, { ...accepted, success: 'true' }, { ...accepted, success: false },
    { ...accepted, deviceAuth: undefined }, { ...accepted, deviceAuth: 'true' },
    ...['', 'a'.repeat(65), 'A'.repeat(65), 'ABC\n', 'ABC DEF', '/bind ABC', 'ABC--DEF', 'ABC-', 'abc', 123].map(bindingCode => ({ ...accepted, bindingCode })),
  ])('rejects malformed or unsupported enrollment response %j', async data => {
    vi.mocked(axios.post).mockResolvedValueOnce({ data });
    const result = await initCommand(options);
    expect(result.success).toBe(false);
    expect(result.error).toContain('--without-files');
    expect(set).not.toHaveBeenCalled();
    expect(axios.post).toHaveBeenCalledOnce();
  });

  it.each(['http://router.example.com', 'https://user:password@router.example.com',
    'https://router.example.com/?key=synthetic', 'https://router.example.com/#fragment'])('rejects unsafe enrollment URL %s before creating a key', async serverUrl => {
    const result = await initCommand({ ...options, serverUrl });
    expect(result.success).toBe(false);
    expect(result.error).toContain('--without-files');
    expect(axios.post).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('permits loopback HTTP for secure enrollment fixtures', async () => {
    expect((await initCommand({ ...options, serverUrl: 'http://127.0.0.1:3000' })).success).toBe(true);
    expect(axios.post).toHaveBeenCalledWith('http://127.0.0.1:3000/api/bind/request', expect.objectContaining({ devicePublicKey: expect.any(String) }), expect.anything());
  });

  it('retains the key after partial config failure and reuses it on forced retry', async () => {
    set.mockImplementationOnce(async (key, value) => { values.set(key, value); });
    set.mockRejectedValueOnce(new Error('synthetic-private-config-error'));
    const failed = await initCommand(options);
    expect(failed.success).toBe(false);
    expect(failed.error).toContain('--force');
    expect(failed.error).not.toContain('synthetic-private');
    expect(failed.bindingCode).toBeUndefined();
    const first = request();
    expect((await initCommand({ ...options, force: true })).success).toBe(true);
    expect(request().devicePublicKey).toBe(first.devicePublicKey);
  });

  it('does not request approval when identity durability fails', async () => {
    vi.spyOn(durability, 'syncDirectory').mockRejectedValueOnce(new Error('synthetic-private-sync-error'));
    const failed = await initCommand(options);
    expect(failed.success).toBe(false);
    expect(failed.error).toContain('identity');
    expect(failed.error).not.toContain('synthetic-private');
    expect(axios.post).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect((await initCommand(options)).success).toBe(true);
  });

  it('rejects corrupt saved identities without disclosing their contents or replacing them', async () => {
    await initCommand(options);
    const directory = path.join(root, 'device-identities');
    const [name] = await fs.readdir(directory);
    const filename = path.join(directory, name);
    await fs.writeFile(filename, 'synthetic-private-key-sentinel');
    vi.mocked(axios.post).mockClear();
    const result = await initCommand({ ...options, force: true });
    expect(result.success).toBe(false);
    expect(result.error).not.toContain('synthetic-private-key-sentinel');
    expect(axios.post).not.toHaveBeenCalled();
    expect(await fs.readFile(filename, 'utf8')).toBe('synthetic-private-key-sentinel');
  });
});
