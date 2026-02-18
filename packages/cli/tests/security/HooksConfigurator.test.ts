import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';

// Mock fs before imports
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

// Mock os
vi.mock('os', () => ({
  default: { homedir: () => '/mock/home' },
  homedir: () => '/mock/home'
}));

import * as fs from 'fs';
import { HooksConfigurator } from '../../src/security/HooksConfigurator';

describe('HooksConfigurator', () => {
  let configurator: HooksConfigurator;
  const mockExistsSync = vi.mocked(fs.existsSync);
  const mockReadFileSync = vi.mocked(fs.readFileSync);
  const mockWriteFileSync = vi.mocked(fs.writeFileSync);
  const mockMkdirSync = vi.mocked(fs.mkdirSync);

  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock implementations
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{}');
    mockWriteFileSync.mockImplementation(() => {});
    mockMkdirSync.mockImplementation(() => undefined as any);

    configurator = new HooksConfigurator();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('configure', () => {
    it('should create hooks configuration in Claude settings', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('{}');

      await configurator.configure();

      expect(mockWriteFileSync).toHaveBeenCalled();
      const writeCall = mockWriteFileSync.mock.calls[0];
      const settingsPath = writeCall[0] as string;
      const content = JSON.parse(writeCall[1] as string);

      expect(settingsPath).toContain('.claude');
      expect(settingsPath).toContain('settings.json');
      expect(content.hooks).toBeDefined();
      expect(content.hooks.PreToolUse).toBeDefined();
      expect(Array.isArray(content.hooks.PreToolUse)).toBe(true);
    });

    it('should add security guard hook to PreToolUse', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('{}');

      await configurator.configure();

      const writeCall = mockWriteFileSync.mock.calls[0];
      const content = JSON.parse(writeCall[1] as string);
      const hooks = content.hooks.PreToolUse;

      expect(hooks.length).toBeGreaterThan(0);
      const securityHook = hooks.find((h: any) =>
        (typeof h === 'string' ? h : h.command).includes('security-guard')
      );
      expect(securityHook).toBeDefined();
    });

    it('should preserve existing hooks in settings', async () => {
      const existingSettings = {
        hooks: {
          PreToolUse: [
            { command: 'echo "existing hook"', tools: ['Bash'] }
          ],
          PostToolUse: [
            { command: 'echo "post hook"' }
          ]
        },
        someOtherSetting: 'value'
      };
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(existingSettings));

      await configurator.configure();

      const writeCall = mockWriteFileSync.mock.calls[0];
      const content = JSON.parse(writeCall[1] as string);

      // Should preserve existing PreToolUse hook
      expect(content.hooks.PreToolUse.length).toBeGreaterThanOrEqual(2);
      expect(content.hooks.PreToolUse).toContainEqual(
        expect.objectContaining({ command: 'echo "existing hook"' })
      );
      // Should preserve PostToolUse
      expect(content.hooks.PostToolUse).toBeDefined();
      // Should preserve other settings
      expect(content.someOtherSetting).toBe('value');
    });

    it('should not add duplicate hook if already configured', async () => {
      const existingSettings = {
        hooks: {
          PreToolUse: [
            { command: 'node "/path/to/security-guard.js"', tools: ['Read'] }
          ]
        }
      };
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(existingSettings));

      await configurator.configure();

      const writeCall = mockWriteFileSync.mock.calls[0];
      const content = JSON.parse(writeCall[1] as string);
      const securityHooks = content.hooks.PreToolUse.filter((h: any) =>
        (typeof h === 'string' ? h : h.command).includes('security-guard')
      );

      expect(securityHooks.length).toBe(1);
    });

    it('should create .claude directory if it does not exist', async () => {
      mockExistsSync.mockImplementation((p: any) => {
        const pathStr = String(p);
        if (pathStr.includes('security-guard')) return true;
        return false; // settings.json doesn't exist
      });
      mockReadFileSync.mockImplementation((p: any) => {
        const pathStr = String(p);
        if (pathStr.includes('settings.json')) {
          throw new Error('ENOENT');
        }
        return '{}';
      });

      await configurator.configure();

      expect(mockMkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('.claude'),
        expect.objectContaining({ recursive: true })
      );
    });

    it('should throw error if security guard script does not exist', async () => {
      mockExistsSync.mockImplementation((p: any) => {
        const pathStr = String(p);
        if (pathStr.includes('security-guard')) return false;
        return true;
      });

      await expect(configurator.configure()).rejects.toThrow('Security guard script not found');
    });

    it('should specify file operation tools in hook configuration', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('{}');

      await configurator.configure();

      const writeCall = mockWriteFileSync.mock.calls[0];
      const content = JSON.parse(writeCall[1] as string);
      const securityHook = content.hooks.PreToolUse.find((h: any) =>
        (typeof h === 'string' ? h : h.command).includes('security-guard')
      );

      expect(securityHook.tools).toBeDefined();
      expect(securityHook.tools).toContain('Read');
      expect(securityHook.tools).toContain('Write');
      expect(securityHook.tools).toContain('Edit');
    });
  });

  describe('unconfigure', () => {
    it('should remove security guard hook from settings', async () => {
      const existingSettings = {
        hooks: {
          PreToolUse: [
            { command: 'node "/path/to/security-guard.js"', tools: ['Read'] },
            { command: 'echo "other hook"', tools: ['Bash'] }
          ]
        }
      };
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(existingSettings));

      await configurator.unconfigure();

      const writeCall = mockWriteFileSync.mock.calls[0];
      const content = JSON.parse(writeCall[1] as string);

      expect(content.hooks.PreToolUse.length).toBe(1);
      expect(content.hooks.PreToolUse[0].command).toBe('echo "other hook"');
    });

    it('should do nothing if settings file does not exist', async () => {
      mockExistsSync.mockReturnValue(false);

      await configurator.unconfigure();

      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it('should preserve other hooks when unconfiguring', async () => {
      const existingSettings = {
        hooks: {
          PreToolUse: [
            { command: 'security-guard.js' },
            { command: 'my-custom-hook.js' }
          ],
          PostToolUse: [
            { command: 'post-hook.js' }
          ]
        }
      };
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(existingSettings));

      await configurator.unconfigure();

      const writeCall = mockWriteFileSync.mock.calls[0];
      const content = JSON.parse(writeCall[1] as string);

      expect(content.hooks.PreToolUse).toHaveLength(1);
      expect(content.hooks.PreToolUse[0].command).toBe('my-custom-hook.js');
      expect(content.hooks.PostToolUse).toHaveLength(1);
    });
  });

  describe('isConfigured', () => {
    it('should return true if security guard hook is present', async () => {
      const existingSettings = {
        hooks: {
          PreToolUse: [
            { command: 'node "/path/to/security-guard.js"' }
          ]
        }
      };
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(existingSettings));

      const result = await configurator.isConfigured();

      expect(result).toBe(true);
    });

    it('should return false if security guard hook is not present', async () => {
      const existingSettings = {
        hooks: {
          PreToolUse: [
            { command: 'other-hook.js' }
          ]
        }
      };
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(existingSettings));

      const result = await configurator.isConfigured();

      expect(result).toBe(false);
    });

    it('should return false if settings file does not exist', async () => {
      mockExistsSync.mockReturnValue(false);

      const result = await configurator.isConfigured();

      expect(result).toBe(false);
    });

    it('should return false if hooks section is empty', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('{}');

      const result = await configurator.isConfigured();

      expect(result).toBe(false);
    });
  });

  describe('getSecurityGuardPath', () => {
    it('should return the path to security-guard script', () => {
      const guardPath = configurator.getSecurityGuardPath();

      expect(guardPath).toContain('security-guard');
      expect(path.isAbsolute(guardPath)).toBe(true);
    });
  });
});
