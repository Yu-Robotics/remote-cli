import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { once } from 'events';
import fs from 'fs/promises';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { WebSocketServer, type WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startCommand } from '../../src/commands/start';
import { ThreadManager } from '../../src/thread/ThreadManager';
import { ConfigManager } from '../../src/config/ConfigManager';
import * as managedSpawn from '../../src/executor/ManagedSpawn';

vi.mock('axios', () => ({ default: { get: vi.fn(async () => ({ data: {} })) } }));
vi.mock('../../src/security/HooksConfigurator', () => ({
  HooksConfigurator: class { async unconfigure() {} },
}));

const deviceId = 'fixture-bound-device';
const openId = 'fixture-owner';
const mobileThread = 'mobile-recovery';

// Recovery may quarantine the original bytes elsewhere inside this fixture.
async function containsOriginal(directory: string, original: Buffer): Promise<boolean> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory() && await containsOriginal(file, original)) return true;
    if (entry.isFile() && (await fs.readFile(file)).equals(original)) return true;
  }
  return false;
}

// Each scenario has an existing device, thread and native pointer before startup.
function useDevice() {
  let home: string, directory: string, config: string, catalog: string, pointer: string;
  let server: WebSocketServer, socket: WebSocket | undefined;
  let registered: string | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  const responses = new Map<string, { success: boolean; threadId: string; openId: string; output: string }>();
  const streams = new Map<string, string>();
  const originalPointer = Buffer.from('{"id":"fixture-existing-session"}\n');

  async function initialize() {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'startup-catalog-')));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('PATH', process.env.PATH);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    directory = path.join(home, '.remote-cli');
    config = path.join(directory, 'config.json');
    catalog = path.join(directory, 'threads.json');
    const manager = await ThreadManager.initialize(home);
    await manager.updateThread(manager.getDefaultThread().id, { workingDirectory: home });
    const existing = await manager.createThread('existing', home, 'claude');
    pointer = path.join(directory, 'claude-sessions', existing.id + '.json');
    await fs.writeFile(pointer, originalPointer);
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    server.on('connection', peer => {
      socket = peer;
      peer.on('message', data => {
        const frame = JSON.parse(data.toString());
        if (frame.type === 'binding_request') {
          registered = frame.data.deviceId;
          peer.send(JSON.stringify({ type: 'binding_confirm', data: { success: true } }));
        }
        if (frame.type === 'response') responses.set(frame.messageId, frame);
        if (frame.type === 'stream' && frame.streamType === 'text') {
          streams.set(frame.messageId, (streams.get(frame.messageId) ?? '') + frame.chunk);
        }
      });
    });
    await fs.writeFile(config, JSON.stringify({
      deviceId, serverUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      security: { allowedDirectories: [home] }, executor: { type: 'claude-persistent', claude: { command: process.execPath } },
      maintenance: { updateNotice: false, subscriptionInspection: false },
    }));
  }

  async function stop() {
    await shutdown?.();
    shutdown = undefined;
    registered = undefined;
    socket = undefined;
  }

  afterAll(async () => {
    try {
      await stop();
    } finally {
      for (const peer of server?.clients ?? []) peer.terminate();
      if (server) await new Promise<void>(resolve => server.close(() => resolve()));
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      if (home) await fs.rm(home, { recursive: true, force: true });
    }
  });

  async function command(content: string, threadId?: string) {
    const messageId = randomUUID();
    socket!.send(JSON.stringify({ type: 'command', messageId, openId, content, threadId, isSlashCommand: content.startsWith('/'), timestamp: Date.now() }));
    await vi.waitFor(() => expect(responses.has(messageId)).toBe(true), { timeout: 5000 });
    const response = responses.get(messageId)!;
    expect(response).toMatchObject({ openId, success: true, threadId: expect.any(String) });
    return { ...response, streamedText: streams.get(messageId) };
  }

  async function createFromMobile() {
    await vi.waitFor(() => expect(registered).toBe(deviceId));
    const created = await command('/thread new ' + mobileThread);
    const listed = await command('/thread list');
    expect(listed.output).toContain(mobileThread);
    return created.threadId;
  }

  return {
    start: () => startCommand({ nonInteractive: true, onShutdownReady: close => { shutdown = close; } }),
    initialize, stop, createFromMobile, command,
    get catalog() { return catalog; }, get config() { return config; }, get home() { return home; },
    get connected() { return !!socket; },
    retains: (original: Buffer) => containsOriginal(directory, original),
    verifyPointer: async () => expect(await fs.readFile(pointer)).toEqual(originalPointer),
  };
}

describe('startup with a damaged thread catalog', () => {
  const device = useDevice();
  const damaged = Buffer.from('{"threads":{"unfinished":\n');
  let mobileId: string | undefined;
  beforeAll(async () => {
    await device.initialize();
    await fs.writeFile(device.catalog, damaged);
    const result = await device.start();
    expect(result).toMatchObject({ success: true });
    mobileId = await device.createFromMobile();
    expect((await device.command('/thread list')).output).toContain('existing');
  });

  it('preserves the damaged catalog bytes and the existing native session pointer', async () => {
    expect(await device.retains(damaged)).toBe(true);
    await device.verifyPointer();
  });
  it('lets the bound Feishu user create and list a fresh thread', () => {
    expect(mobileId).toEqual(expect.any(String));
  });
});

describe('Feishu recovery without a verified thread catalog backup', () => {
  const device = useDevice();
  it('keeps fresh chat across restart and leaves the unknown identities and legacy session untouched', async () => {
    await device.initialize();
    const original = await fs.readFile(device.catalog);
    const damaged = Buffer.from([0xff, 0x00, 0x7b]);
    await fs.writeFile(device.catalog, damaged);
    await fs.writeFile(device.catalog + '.bak', 'damaged backup');
    await fs.writeFile(path.join(path.dirname(device.catalog), 'claude-session'), 'synthetic-legacy-session');
    const script = `
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const frame = JSON.parse(line);
        if (frame.type === 'control_request') {
          console.log(JSON.stringify({ type: 'control_response', response: { request_id: frame.request_id,
            subtype: 'success', response: { models: [], pid: process.pid, effective: {} } } }));
        } else if (frame.type === 'user') {
          console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Synthetic chat response' }] } }));
          console.log(JSON.stringify({ type: 'result', user_message_uuid: frame.uuid,
            is_error: false, result: 'Synthetic chat response' }));
        }
      });`;
    const native = vi.spyOn(managedSpawn, 'spawnManaged').mockImplementation((_worker, command, args, options) => {
      expect(command).toBe(process.execPath);
      expect(args).not.toContain('--resume');
      expect(options.cwd).toBe(device.home);
      return spawn(process.execPath, ['-e', script], { cwd: options.cwd, stdio: 'pipe', env: { HOME: device.home, USERPROFILE: device.home } });
    });
    expect(await device.start()).toMatchObject({ success: true });
    const id = await device.createFromMobile();
    expect(id[14]).toBe('8');
    expect((await device.command('/thread list')).output).not.toContain('existing');
    const chat = await device.command('Synthetic chat prompt', id);
    expect(chat).toMatchObject({ threadId: id, streamedText: expect.stringContaining('Synthetic chat response') });
    expect(native).toHaveBeenCalledOnce();
    await device.stop();
    expect(await device.start()).toMatchObject({ success: true });
    expect((await device.command('/thread list', id)).output).toContain(mobileThread);
    expect(await fs.readFile(device.catalog)).toEqual(damaged);
    await device.verifyPointer();
    await device.stop();
    await fs.writeFile(device.catalog, original);
    expect(await device.start()).toMatchObject({ success: true });
    const restored = (await device.command('/thread list')).output;
    expect(restored).toContain('existing');
    expect(restored).not.toContain(mobileThread);
  });
});

describe('startup after a transient thread catalog read failure', () => {
  const device = useDevice();
  it('serves existing and new threads on the next start without a local edit', async () => {
    await device.initialize();
    const before = await fs.readFile(device.catalog);
    const read = fs.readFile.bind(fs);
    let rejected = false;
    const fault = vi.spyOn(fs, 'readFile').mockImplementation(async (file, options) => {
      if (!rejected && file === device.catalog) {
        rejected = true;
        throw Object.assign(new Error('Temporary fixture catalog read failure'), { code: 'EIO' });
      }
      return read(file, options);
    });
    try {
      const result = await device.start();
      expect(rejected).toBe(true);
      if (!result.success) {
        expect(result.error).toContain('Temporary fixture catalog read failure');
        expect(device.connected).toBe(false);
      }
    } finally { fault.mockRestore(); }
    await device.stop();
    expect(await fs.readFile(device.catalog)).toEqual(before);
    expect(await device.start()).toMatchObject({ success: true });
    await device.createFromMobile();
    expect((await device.command('/thread list')).output).toContain('existing');
    await device.verifyPointer();
  });
});

describe('startup with damaged device configuration', () => {
  const device = useDevice();
  const damaged = Buffer.from('{"deviceId":"fixture-bound-device",\n');
  let preserved: boolean;
  beforeAll(async () => {
    await device.initialize();
    const catalog = await fs.readFile(device.catalog);
    await fs.writeFile(device.config, damaged);
    const result = await device.start();
    expect(result.success).toBe(false);
    expect(device.connected).toBe(false);
    expect(await fs.readFile(device.catalog)).toEqual(catalog);
    preserved = await device.retains(damaged);
  });

  it('leaves the existing native session untouched without a verified device configuration', () => device.verifyPointer());
  it('preserves damaged config bytes for recovery', () => {
    expect(preserved).toBe(true);
  });
});

describe('startup with a verified device configuration backup', () => {
  const device = useDevice();
  it('restores the same device, router and allowed directories and preserves non-UTF8 damaged bytes', async () => {
    await device.initialize();
    const config = await ConfigManager.initialize();
    await config.set('maintenance.updateNotice', false);
    const damaged = Buffer.from([0xff, 0x00, 0x7b]);
    await fs.writeFile(device.config, damaged);
    expect(await device.start()).toMatchObject({ success: true });
    await device.createFromMobile();
    const saved = JSON.parse(await fs.readFile(device.config, 'utf8'));
    expect(saved).toMatchObject({ deviceId, serverUrl: config.get('serverUrl'), security: { allowedDirectories: [device.home] } });
    expect(await device.retains(damaged)).toBe(true);
    await device.verifyPointer();
  });
});
