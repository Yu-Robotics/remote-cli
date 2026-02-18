import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock dependencies before importing the command
vi.mock('os', () => ({
  default: { homedir: () => '/mock/home' },
  homedir: () => '/mock/home'
}));
vi.mock('fs/promises');

import { showConfigCommand, resetConfigCommand } from '../../src/commands/config';
import fs from 'fs/promises';

describe('config commands', () => {
  let consoleLogSpy: any;
  let consoleErrorSpy: any;
  let processExitSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock fs for ConfigManager
    (fs.mkdir as any) = vi.fn().mockResolvedValue(undefined);
    (fs.writeFile as any) = vi.fn().mockResolvedValue(undefined);

    // Mock console
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Mock process.exit
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  describe('showConfigCommand', () => {
    it('should display server configuration', async () => {
      (fs.readFile as any) = vi.fn().mockResolvedValue(JSON.stringify({
        server: { port: 3000, host: '0.0.0.0', nodeEnv: 'production' },
        feishu: { appId: 'test_app_id', appSecret: 'test_secret' },
        websocket: { heartbeatInterval: 15000, reconnectDelay: 5000 },
        security: { bindingCodeExpiry: 300000, maxBindingAttempts: 5 }
      }));

      await showConfigCommand();

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Port: 3000'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Host: 0.0.0.0'));
    });

    it('should display Feishu configuration with masked secret', async () => {
      (fs.readFile as any) = vi.fn().mockResolvedValue(JSON.stringify({
        server: { port: 3000, host: '0.0.0.0', nodeEnv: 'production' },
        feishu: { appId: 'cli_app123456', appSecret: 'secret12345678' },
        websocket: { heartbeatInterval: 15000, reconnectDelay: 5000 },
        security: { bindingCodeExpiry: 300000, maxBindingAttempts: 5 }
      }));

      await showConfigCommand();

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('App ID: cli_app123456'));
      // Secret should be masked
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('***'));
    });

    it('should show not set for empty configuration values', async () => {
      (fs.readFile as any) = vi.fn().mockResolvedValue(JSON.stringify({
        server: { port: 3000, host: '0.0.0.0', nodeEnv: 'production' },
        feishu: { appId: '', appSecret: '' },
        websocket: { heartbeatInterval: 15000, reconnectDelay: 5000 },
        security: { bindingCodeExpiry: 300000, maxBindingAttempts: 5 }
      }));

      await showConfigCommand();

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('(not set)'));
    });

    it('should display WebSocket configuration', async () => {
      (fs.readFile as any) = vi.fn().mockResolvedValue(JSON.stringify({
        server: { port: 3000, host: '0.0.0.0', nodeEnv: 'production' },
        feishu: { appId: '', appSecret: '' },
        websocket: { heartbeatInterval: 15000, reconnectDelay: 5000 },
        security: { bindingCodeExpiry: 300000, maxBindingAttempts: 5 }
      }));

      await showConfigCommand();

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Heartbeat Interval: 15000ms'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Reconnect Delay: 5000ms'));
    });

    it('should display security configuration', async () => {
      (fs.readFile as any) = vi.fn().mockResolvedValue(JSON.stringify({
        server: { port: 3000, host: '0.0.0.0', nodeEnv: 'production' },
        feishu: { appId: '', appSecret: '' },
        websocket: { heartbeatInterval: 15000, reconnectDelay: 5000 },
        security: { bindingCodeExpiry: 300000, maxBindingAttempts: 5 }
      }));

      await showConfigCommand();

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Binding Code Expiry: 300000ms'));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Max Binding Attempts: 5'));
    });

    it('should display config file path', async () => {
      (fs.readFile as any) = vi.fn().mockResolvedValue(JSON.stringify({
        server: { port: 3000, host: '0.0.0.0', nodeEnv: 'production' },
        feishu: { appId: '', appSecret: '' },
        websocket: { heartbeatInterval: 15000, reconnectDelay: 5000 },
        security: { bindingCodeExpiry: 300000, maxBindingAttempts: 5 }
      }));

      await showConfigCommand();

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Config file:'));
    });
  });

  describe('resetConfigCommand', () => {
    let mockRl: any;

    beforeEach(() => {
      // Mock readline/promises
      mockRl = {
        question: vi.fn(),
        close: vi.fn(),
      };

      vi.mock('readline/promises', () => ({
        createInterface: () => mockRl
      }));
    });

    it('should not reset if user does not confirm', async () => {
      (fs.readFile as any) = vi.fn().mockResolvedValue(JSON.stringify({
        server: { port: 8080, host: 'localhost', nodeEnv: 'development' },
        feishu: { appId: 'test_app_id', appSecret: 'test_secret' },
        websocket: { heartbeatInterval: 30000, reconnectDelay: 10000 },
        security: { bindingCodeExpiry: 600000, maxBindingAttempts: 3 }
      }));

      // User enters 'n'
      const readline = await import('readline/promises');
      vi.spyOn(readline, 'createInterface').mockReturnValue({
        question: vi.fn().mockResolvedValue('n'),
        close: vi.fn(),
      } as any);

      await resetConfigCommand();

      expect(consoleLogSpy).toHaveBeenCalledWith('Cancelled.');
    });
  });
});
