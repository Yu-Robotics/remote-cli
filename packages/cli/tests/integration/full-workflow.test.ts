import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import axios from 'axios';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Mock os.homedir() BEFORE importing commands
const originalHomedir = os.homedir();
vi.spyOn(os, 'homedir').mockImplementation(() => process.env.HOME || originalHomedir);

import { initCommand } from '../../src/commands/init';
import { startCommand } from '../../src/commands/start';
import { stopCommand } from '../../src/commands/stop';
import { statusCommand } from '../../src/commands/status';
import { ConfigManager } from '../../src/config/ConfigManager';
import { WebSocketClient } from '../../src/client/WebSocketClient';

// Mock dependencies
vi.mock('axios');
vi.mock('../../src/client/WebSocketClient');
vi.mock('../../src/executor/ClaudeExecutor');
vi.mock('node-machine-id', () => ({
  machineId: vi.fn().mockResolvedValue('test-machine-id-1234567890'),
}));
vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    text: '',
  })),
}));

describe('Integration: Full Workflow', () => {
  let mockAxios: any;
  let mockWsClient: any;
  let tempConfigDir: string;
  let originalConfigDir: string;
  let testCounter = 0;

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup mock axios
    mockAxios = axios as any;
    mockAxios.post = vi.fn();

    // Setup mock WebSocket client
    mockWsClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      send: vi.fn(),
      on: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    (WebSocketClient as any).mockImplementation(() => mockWsClient);

    // Use temporary config directory for isolation
    testCounter++;
    tempConfigDir = path.join(os.tmpdir(), `remote-cli-test-${Date.now()}-${testCounter}-${Math.random().toString(36).substring(7)}`);
    fs.mkdirSync(tempConfigDir, { recursive: true });

    // Set config path for ConfigManager
    originalConfigDir = process.env.HOME || '';
    const testHome = path.join(tempConfigDir, 'home');
    fs.mkdirSync(testHome, { recursive: true });
    process.env.HOME = testHome;
  });

  afterEach(() => {
    // Cleanup temp config directory
    if (fs.existsSync(tempConfigDir)) {
      fs.rmSync(tempConfigDir, { recursive: true, force: true });
    }
    process.env.HOME = originalConfigDir;
    vi.clearAllMocks();
  });

  describe('Complete user journey', () => {
    it('should successfully complete init → start → status → stop workflow', async () => {
      // Step 1: Initialize device
      mockAxios.post.mockResolvedValueOnce({
        data: {
          success: true,
          bindingCode: 'ABC-123-XYZ',
          expiresAt: Date.now() + 300000,
        },
      });

      const initResult = await initCommand({
        serverUrl: 'https://test-server.com',
        allowedDirs: ['~/test-project'],
      });

      expect(initResult.success).toBe(true);
      expect(initResult.bindingCode).toBe('ABC-123-XYZ');
      expect(initResult.deviceId).toMatch(/^dev_[a-z]+_[a-z0-9\-]+$/);

      // Verify config was created
      const config = await ConfigManager.initialize();
      expect(config.has('deviceId')).toBe(true);
      expect(config.get('serverUrl')).toBe('https://test-server.com');
      expect(config.get('security.allowedDirectories')).toEqual(['~/test-project']);

      // Step 2: Start service
      const startResult = await startCommand({ daemon: false });

      expect(startResult.success).toBe(true);
      expect(mockWsClient.connect).toHaveBeenCalled();

      // Reload config to get updated service state
      const configAfterStart = await ConfigManager.initialize();
      expect(configAfterStart.get('service.running')).toBe(true);
      expect(configAfterStart.get('service.startedAt')).toBeDefined();

      // Step 3: Check status
      const statusResult = await statusCommand();

      expect(statusResult.success).toBe(true);
      expect(statusResult.status?.initialized).toBe(true);
      expect(statusResult.status?.running).toBe(true);
      expect(statusResult.status?.connected).toBe(true);
      expect(statusResult.status?.deviceId).toBe(initResult.deviceId);
      expect(statusResult.status?.serverUrl).toBe('https://test-server.com');
      expect(statusResult.status?.allowedDirectories).toEqual(['~/test-project']);
      expect(statusResult.status?.uptime).toBeGreaterThan(0);

      // Step 4: Stop service
      const stopResult = await stopCommand();

      expect(stopResult.success).toBe(true);

      // Reload config to get updated service state after stop
      const configAfterStop = await ConfigManager.initialize();
      expect(configAfterStop.get('service.running')).toBe(false);
      expect(configAfterStop.get('service.stoppedAt')).toBeDefined();

      // Step 5: Verify status after stop
      const statusAfterStop = await statusCommand();

      expect(statusAfterStop.success).toBe(true);
      expect(statusAfterStop.status?.running).toBe(false);
    });

    it('should handle binding flow simulation', async () => {
      // Initialize device
      mockAxios.post.mockResolvedValueOnce({
        data: {
          success: true,
          bindingCode: 'XYZ-789-ABC',
          expiresAt: Date.now() + 300000,
        },
      });

      const initResult = await initCommand({
        serverUrl: 'https://router.example.com',
        allowedDirs: ['~/work', '~/projects'],
      });

      expect(initResult.success).toBe(true);

      // Simulate user binding in Feishu (manually updating config)
      const config = await ConfigManager.initialize();
      await config.set('openId', 'ou_test_user_12345');

      // Check status after binding
      const statusResult = await statusCommand();

      expect(statusResult.status?.bound).toBe(true);
      expect(statusResult.status?.openId).toBe('ou_test_user_12345');
    });

    it('should prevent starting service without initialization', async () => {
      const startResult = await startCommand({ daemon: false });

      expect(startResult.success).toBe(false);
      expect(startResult.error).toContain('not initialized');
    });

    it('should handle force re-initialization', async () => {
      // First initialization
      mockAxios.post.mockResolvedValueOnce({
        data: {
          success: true,
          bindingCode: 'ABC-111-AAA',
          expiresAt: Date.now() + 300000,
        },
      });

      const firstInit = await initCommand({
        serverUrl: 'https://test-server.com',
      });

      expect(firstInit.success).toBe(true);
      const firstDeviceId = firstInit.deviceId;

      // Try re-initialization without force (should fail)
      const secondInit = await initCommand({
        serverUrl: 'https://test-server.com',
      });

      expect(secondInit.success).toBe(false);
      expect(secondInit.error).toContain('already initialized');

      // Force re-initialization
      mockAxios.post.mockResolvedValueOnce({
        data: {
          success: true,
          bindingCode: 'ABC-222-BBB',
          expiresAt: Date.now() + 300000,
        },
      });

      const forceInit = await initCommand({
        serverUrl: 'https://new-server.com',
        force: true,
      });

      expect(forceInit.success).toBe(true);
      expect(forceInit.bindingCode).toBe('ABC-222-BBB');

      // Verify config was updated
      const config = await ConfigManager.initialize();
      expect(config.get('serverUrl')).toBe('https://new-server.com');
    });

    it('should maintain state across service restarts', async () => {
      // Initialize
      mockAxios.post.mockResolvedValueOnce({
        data: {
          success: true,
          bindingCode: 'TEST-CODE-123',
          expiresAt: Date.now() + 300000,
        },
      });

      await initCommand({
        serverUrl: 'https://test-server.com',
        allowedDirs: ['~/projects'],
      });

      // Start service
      await startCommand({ daemon: false });

      // Stop service
      await stopCommand();

      // Start service again
      const restartResult = await startCommand({ daemon: false });

      expect(restartResult.success).toBe(true);

      // Verify configuration persisted
      const config = await ConfigManager.initialize();
      expect(config.get('serverUrl')).toBe('https://test-server.com');
      expect(config.get('security.allowedDirectories')).toEqual(['~/projects']);
    });
  });

  describe('Error scenarios', () => {
    it('should handle network errors during initialization', async () => {
      mockAxios.post.mockRejectedValueOnce(new Error('Network timeout'));

      const result = await initCommand({
        serverUrl: 'https://unreachable-server.com',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Network timeout');
    });

    it('should handle server errors during initialization', async () => {
      mockAxios.post.mockResolvedValueOnce({
        data: {
          success: false,
          error: 'Server internal error',
        },
      });

      const result = await initCommand({
        serverUrl: 'https://test-server.com',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Server');
    });

    it('should handle WebSocket connection failure', async () => {
      // Initialize first
      mockAxios.post.mockResolvedValueOnce({
        data: {
          success: true,
          bindingCode: 'ABC-123-XYZ',
          expiresAt: Date.now() + 300000,
        },
      });

      await initCommand({
        serverUrl: 'https://test-server.com',
      });

      // Mock WebSocket connection failure
      mockWsClient.connect.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await startCommand({ daemon: false });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Connection refused');
    });

    it('should prevent stopping non-running service', async () => {
      // Initialize but don't start
      mockAxios.post.mockResolvedValueOnce({
        data: {
          success: true,
          bindingCode: 'ABC-123-XYZ',
          expiresAt: Date.now() + 300000,
        },
      });

      await initCommand({
        serverUrl: 'https://test-server.com',
      });

      const result = await stopCommand();

      expect(result.success).toBe(false);
      expect(result.error).toContain('not running');
    });
  });

  describe('Configuration persistence', () => {
    it('should persist configuration across ConfigManager instances', async () => {
      // Initialize
      mockAxios.post.mockResolvedValueOnce({
        data: {
          success: true,
          bindingCode: 'PERSIST-TEST',
          expiresAt: Date.now() + 300000,
        },
      });

      const initResult = await initCommand({
        serverUrl: 'https://test-server.com',
        allowedDirs: ['~/dir1', '~/dir2'],
      });

      expect(initResult.success).toBe(true);

      // Create new ConfigManager instance and verify data persists
      const newConfig = await ConfigManager.initialize();
      expect(newConfig.get('deviceId')).toBe(initResult.deviceId);
      expect(newConfig.get('serverUrl')).toBe('https://test-server.com');
      expect(newConfig.get('security.allowedDirectories')).toEqual(['~/dir1', '~/dir2']);
    });

    it('should handle missing configuration gracefully', async () => {
      const statusResult = await statusCommand();

      expect(statusResult.success).toBe(true);
      expect(statusResult.status?.initialized).toBe(false);
    });
  });
});
