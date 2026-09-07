import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('os', () => ({
  default: { homedir: () => '/mock/home' },
  homedir: () => '/mock/home',
}));

import * as fs from 'fs';
import { HooksConfigurator } from '../../src/security/HooksConfigurator';

describe('HooksConfigurator', () => {
  const existsSync = vi.mocked(fs.existsSync);
  const readFileSync = vi.mocked(fs.readFileSync);
  const writeFileSync = vi.mocked(fs.writeFileSync);
  let configurator: HooksConfigurator;

  beforeEach(() => {
    vi.clearAllMocks();
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue('{}');
    writeFileSync.mockImplementation(() => undefined);
    configurator = new HooksConfigurator();
  });

  it('removes legacy remote-cli security hooks and preserves user hooks', async () => {
    readFileSync.mockReturnValue(JSON.stringify({
      model: 'sonnet',
      hooks: {
        PreToolUse: [
          {
            matcher: 'Read|Write|Edit|Glob|Grep|NotebookEdit|Bash',
            hooks: [{ type: 'command', command: 'node "/package/dist/security/security-guard.js"' }],
          },
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'my-custom-hook.js' }],
          },
        ],
        PostToolUse: [
          {
            matcher: 'Write',
            hooks: [{ type: 'command', command: 'post-hook.js' }],
          },
        ],
      },
    }));

    await configurator.unconfigure();

    const settings = JSON.parse(writeFileSync.mock.calls[0][1] as string);
    expect(settings.model).toBe('sonnet');
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe('my-custom-hook.js');
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toBe('post-hook.js');
  });

  it('removes the empty hooks object when the legacy hook was the only hook', async () => {
    readFileSync.mockReturnValue(JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'node "/old/security-guard.ts"' }],
          },
        ],
      },
    }));

    await configurator.unconfigure();

    const settings = JSON.parse(writeFileSync.mock.calls[0][1] as string);
    expect(settings.hooks).toBeUndefined();
  });

  it('does not rewrite settings when no legacy hook is present', async () => {
    readFileSync.mockReturnValue(JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'my-custom-hook.js' }],
          },
        ],
      },
    }));

    await configurator.unconfigure();

    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('does nothing when Claude settings do not exist', async () => {
    existsSync.mockReturnValue(false);

    await configurator.unconfigure();

    expect(readFileSync).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('does nothing when Claude settings are invalid JSON', async () => {
    readFileSync.mockReturnValue('{invalid');

    await configurator.unconfigure();

    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('reports whether a legacy remote-cli hook is configured', async () => {
    readFileSync.mockReturnValue(JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'node "/package/security-guard.js"' }],
          },
        ],
      },
    }));

    await expect(configurator.isConfigured()).resolves.toBe(true);

    readFileSync.mockReturnValue(JSON.stringify({ hooks: { PreToolUse: [] } }));
    await expect(configurator.isConfigured()).resolves.toBe(false);
  });
});
