import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/types/config';

const prompt = vi.hoisted(() => ({ question: vi.fn(), close: vi.fn() }));
vi.mock('readline/promises', () => ({ createInterface: () => prompt }));

describe('Router configuration commands', () => {
  let home: string;
  let configPath: string;
  const stored = {
    server: { port: 4321, host: 'localhost', nodeEnv: 'development' },
    feishu: { appId: 'example-app', appSecret: 'synthetic-secret-7890' },
    websocket: { heartbeatInterval: 12000, reconnectDelay: 4000 },
    security: { bindingCodeExpiry: 240000, maxBindingAttempts: 3 },
  };

  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'router-config-')));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.resetModules();
    configPath = path.join(home, '.remote-cli-router', 'config.json');
    await fs.mkdir(path.dirname(configPath));
    await fs.writeFile(configPath, JSON.stringify(stored));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(home, { recursive: true, force: true });
  });

  it('shows the stored configuration and path while masking the app secret', async () => {
    const { showConfigCommand } = await import('../../src/commands/config');
    await showConfigCommand();
    const output = vi.mocked(console.log).mock.calls.flat().join('\n');
    for (const field of ['Port: 4321', 'Host: localhost', 'App ID: example-app',
      'App Secret: ***7890', 'Heartbeat Interval: 12000ms', 'Reconnect Delay: 4000ms',
      'Binding Code Expiry: 240000ms', 'Max Binding Attempts: 3', configPath]) {
      expect(output).toContain(field);
    }
    expect(output).not.toContain(stored.feishu.appSecret);
  });

  it('preserves stored values when the reset prompt is declined', async () => {
    const { resetConfigCommand } = await import('../../src/commands/config');
    prompt.question.mockResolvedValueOnce('n');
    await resetConfigCommand();
    expect(console.log).toHaveBeenCalledWith('Cancelled.');
    expect(JSON.parse(await fs.readFile(configPath, 'utf8'))).toEqual(stored);
  });

  it('persists defaults on confirmation and shows unset credentials on the next read', async () => {
    const { resetConfigCommand, showConfigCommand } = await import('../../src/commands/config');
    prompt.question.mockResolvedValueOnce('Y');
    await resetConfigCommand();
    expect(JSON.parse(await fs.readFile(configPath, 'utf8'))).toEqual(DEFAULT_CONFIG);
    await showConfigCommand();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('App ID: (not set)'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('App Secret: (not set)'));
  });
});
