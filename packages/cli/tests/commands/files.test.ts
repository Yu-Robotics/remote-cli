import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { verify } from 'crypto';
import axios from 'axios';
import { ConfigManager } from '../../src/config/ConfigManager';
import { enableFiles } from '../../src/commands/files';
vi.mock('axios');

describe('explicit file enrollment command', () => {
  let root: string; let serverUrl: string; let deviceId: string;
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'files-command-')));
    serverUrl = 'wss://router.example.test/ws'; deviceId = 'device';
    vi.spyOn(ConfigManager, 'initialize').mockResolvedValue({ getConfigDir: () => root,
      get: (key: string) => key === 'deviceId' ? deviceId : serverUrl } as any);
    vi.mocked(axios.post).mockResolvedValue({ data: { success: true, deviceAuth: true, bindingCode: '123456' } });
  });
  afterEach(async () => { vi.restoreAllMocks(); vi.clearAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
  it('sends a signed enrollment proof, never the private key, with redirect and timeout bounds', async () => {
    expect(await enableFiles()).toEqual({ bindingCode: '123456' });
    const [url, body, options] = vi.mocked(axios.post).mock.calls[0] as any;
    expect(url).toBe('https://router.example.test/api/bind/request');
    expect(options).toMatchObject({ maxRedirects: 0, timeout: 10000 });
    expect(JSON.stringify(body)).not.toContain('PRIVATE');
    expect(verify(null, Buffer.from(`remote-cli-device-v1\ndevice\n${body.nonce}`), body.devicePublicKey, Buffer.from(body.signature, 'base64'))).toBe(true);
    await enableFiles(); expect((vi.mocked(axios.post).mock.calls[1][1] as any).devicePublicKey).toBe(body.devicePublicKey);
    await enableFiles(true); expect((vi.mocked(axios.post).mock.calls[2][1] as any).devicePublicKey).not.toBe(body.devicePublicKey);
  });
  it('rejects missing initialization, insecure transport and old Routers explicitly', async () => {
    deviceId = ''; await expect(enableFiles()).rejects.toThrow('Initialize');
    deviceId = 'device'; serverUrl = 'ws://router.example.test'; await expect(enableFiles()).rejects.toThrow('HTTPS');
    serverUrl = 'wss://router.example.test'; vi.mocked(axios.post).mockResolvedValue({ data: { success: true, bindingCode: '123456' } });
    await expect(enableFiles()).rejects.toThrow('Upgrade');
  });
});
