import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { DEFAULT_CONFIG } from '../src/types/config';

describe('Router configuration', () => {
  let home: string;
  let filename: string;
  let ConfigManager: typeof import('../src/config/ConfigManager').ConfigManager;

  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'router-config-')));
    filename = path.join(home, '.remote-cli-router', 'config.json');
    // The manager captures the home directory at module initialization.
    vi.resetModules();
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    ({ ConfigManager } = await import('../src/config/ConfigManager'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    await fs.rm(home, { recursive: true, force: true });
  });

  it('creates defaults in the router home and returns a top-level copy', async () => {
    const config = await ConfigManager.initialize();
    expect(config.getConfigPath()).toBe(filename);
    expect(JSON.parse(await fs.readFile(filename, 'utf8'))).toEqual(DEFAULT_CONFIG);
    const view = config.getAll();
    expect(view).toEqual(DEFAULT_CONFIG);
    expect(view.files).toEqual({ enabled: true });
    view.server = { ...view.server, port: 8081 };
    expect(config.get('server')).toEqual(DEFAULT_CONFIG.server);
    expect(config.get('websocket', 'heartbeatInterval')).toBe(DEFAULT_CONFIG.websocket.heartbeatInterval);
    expect(config.get('missing' as never, 'port' as never)).toBeUndefined();
  });

  it('loads saved changes and resets both memory and disk', async () => {
    const config = await ConfigManager.initialize();
    const server = { ...config.get('server'), host: '127.0.0.1', port: 8081 };
    config.set('server', server);
    config.set('server', 'port', 8082);
    config.set('feishu', 'appId', 'fixture-app');
    await config.save();
    const reloaded = await ConfigManager.initialize();
    expect(reloaded.get('server')).toEqual({ ...server, port: 8082 });
    expect(reloaded.get('feishu', 'appId')).toBe('fixture-app');
    await reloaded.reset();
    expect(reloaded.getAll()).toEqual(DEFAULT_CONFIG);
    expect((await ConfigManager.initialize()).getAll()).toEqual(DEFAULT_CONFIG);
  });

  it('reports malformed existing config and preserves its bytes', async () => {
    await fs.mkdir(path.dirname(filename));
    await fs.writeFile(filename, '{broken');
    await expect(ConfigManager.initialize()).rejects.toThrow(SyntaxError);
    expect(await fs.readFile(filename, 'utf8')).toBe('{broken');
  });

  it.each([
    ['', '', false], ['fixture-app', '', false], ['', 'fixture-secret', false],
    ['fixture-app', 'fixture-secret', true],
  ] as const)('checks the Feishu credential pair (%s, %s)', async (appId, secret, configured) => {
    const config = await ConfigManager.initialize();
    config.set('feishu', 'appId', appId);
    config.set('feishu', 'appSecret', secret);
    expect(config.isFeishuConfigured()).toBe(configured);
  });
});
