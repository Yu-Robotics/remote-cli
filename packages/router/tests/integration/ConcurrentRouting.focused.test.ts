/**
 * Focused concurrent routing tests
 * Tests critical concurrency issues that could cause message routing errors
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConnectionHub } from '../../src/websocket/ConnectionHub';
import { BindingManager } from '../../src/binding/BindingManager';
import { JsonStore } from '../../src/storage/JsonStore';
import { MessageType } from '../../src/types';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock WebSocket
vi.mock('ws');

/**
 * Helper: Create a mock WebSocket
 */
function createMockWebSocket(): any {
  return {
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
    readyState: 1,
    OPEN: 1,
    CLOSED: 3,
  };
}

describe('Focused Concurrent Routing Tests', () => {
  let tempDir: string;
  let store: JsonStore;
  let connectionHub: ConnectionHub;
  let bindingManager: BindingManager;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-test-'));
    const storeFilePath = path.join(tempDir, 'bindings.json');
    store = new JsonStore(storeFilePath);
    await store.initialize();
    connectionHub = new ConnectionHub();
    bindingManager = new BindingManager(store);
  });

  afterEach(async () => {
    connectionHub.closeAllConnections();
    await store.flush();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('Critical Issue 1: Device ID Collision', () => {
    it('should prevent same device ID from being bound to multiple users (BUG FIXED)', async () => {
      const sharedDeviceId = 'dev_shared';

      // First user binds the device successfully
      await bindingManager.bindUser('user_001', sharedDeviceId, 'Device-1');

      // Verify first user has the device
      const binding1 = await bindingManager.getUserBinding('user_001');
      expect(binding1!.devices.some(d => d.deviceId === sharedDeviceId)).toBe(true);

      // Second user tries to bind the same device - should be REJECTED
      await expect(
        bindingManager.bindUser('user_002', sharedDeviceId, 'Device-2')
      ).rejects.toThrow(/already bound to another user/);

      // Verify second user does NOT have the device
      const binding2 = await bindingManager.getUserBinding('user_002');
      expect(binding2).toBeNull(); // User 2 has no devices

      // CRITICAL BUG IS FIXED: The system now prevents device collision
      // This eliminates the risk of cross-user data leakage and routing confusion
    });
  });

  describe('Critical Issue 2: Concurrent Device Switching', () => {
    it('should handle concurrent device switch operations without data corruption', async () => {
      // Setup user with 3 devices
      await bindingManager.bindUser('user_001', 'dev_001', 'Device-1');
      await bindingManager.bindUser('user_001', 'dev_002', 'Device-2');
      await bindingManager.bindUser('user_001', 'dev_003', 'Device-3');

      // Concurrent switches to different devices
      const switches = await Promise.allSettled([
        bindingManager.switchActiveDevice('user_001', 'dev_001'),
        bindingManager.switchActiveDevice('user_001', 'dev_002'),
        bindingManager.switchActiveDevice('user_001', 'dev_003'),
        bindingManager.switchActiveDevice('user_001', 'dev_001'),
      ]);

      // All should succeed
      expect(switches.every(s => s.status === 'fulfilled')).toBe(true);

      // Final state should be consistent
      const binding = await bindingManager.getUserBinding('user_001');
      expect(binding).not.toBeNull();
      expect(binding!.activeDeviceId).toBeTruthy();

      // Verify only ONE device is marked as active
      const activeCount = binding!.devices.filter(d => d.isActive).length;
      expect(activeCount).toBe(1);

      // Verify activeDeviceId matches the actually marked device
      const activeDevice = binding!.devices.find(d => d.isActive);
      expect(activeDevice!.deviceId).toBe(binding!.activeDeviceId);
    });
  });

  describe('Critical Issue 3: Concurrent Message Routing', () => {
    it('should route messages to correct devices when 5 users send concurrently', async () => {
      // Setup 5 users with 1 device each
      const users = [];
      for (let i = 0; i < 5; i++) {
        const userId = `user_${i}`;
        const deviceId = `dev_${i}`;
        await bindingManager.bindUser(userId, deviceId, `Device-${i}`);
        users.push({ userId, deviceId });
      }

      // Register all device connections
      const connections = new Map();
      for (const { deviceId } of users) {
        const ws = createMockWebSocket();
        connectionHub.registerConnection(deviceId, ws);
        connections.set(deviceId, ws);
      }

      // Send messages concurrently
      await Promise.all(
        users.map(({ deviceId }, i) => {
          const message = {
            type: MessageType.COMMAND,
            messageId: `msg_${i}`,
            content: `command_${i}`,
            timestamp: Date.now(),
          };
          return connectionHub.sendToDevice(deviceId, message);
        })
      );

      // Verify each device received exactly 1 message
      for (const [deviceId, ws] of connections) {
        expect(ws.send).toHaveBeenCalledTimes(1);
      }

      // Verify no cross-contamination - each device got its own message
      users.forEach(({ deviceId }, i) => {
        const ws = connections.get(deviceId);
        const calls = ws.send.mock.calls;
        const receivedMessage = JSON.parse(calls[0][0]);
        expect(receivedMessage.messageId).toBe(`msg_${i}`);
        expect(receivedMessage.content).toBe(`command_${i}`);
      });
    });
  });

  describe('Critical Issue 4: Device Reconnection Race', () => {
    it('should handle device reconnection without losing messages', async () => {
      const deviceId = 'dev_001';
      const oldWs = createMockWebSocket();
      const newWs = createMockWebSocket();

      // Register initial connection
      connectionHub.registerConnection(deviceId, oldWs);

      // Simulate rapid reconnection
      connectionHub.registerConnection(deviceId, newWs);

      // Old connection should be closed
      expect(oldWs.close).toHaveBeenCalled();

      // New connection should be active
      const message = {
        type: MessageType.COMMAND,
        messageId: 'msg_001',
        content: 'test',
        timestamp: Date.now(),
      };

      await connectionHub.sendToDevice(deviceId, message);

      // Message should go to new connection
      expect(newWs.send).toHaveBeenCalledWith(JSON.stringify(message));
      expect(oldWs.send).not.toHaveBeenCalled();
    });
  });

  describe('Critical Issue 5: Concurrent Bind and Unbind', () => {
    it('should handle concurrent bind/unbind without corruption', async () => {
      const userId = 'user_001';
      const devices = ['dev_001', 'dev_002', 'dev_003'];

      // Bind all devices
      await Promise.all(
        devices.map(deviceId => bindingManager.bindUser(userId, deviceId, deviceId))
      );

      // Concurrent operations: bind new device, unbind existing device, switch active
      await Promise.allSettled([
        bindingManager.bindUser(userId, 'dev_004', 'Device-4'),
        bindingManager.unbindDevice(userId, 'dev_001'),
        bindingManager.switchActiveDevice(userId, 'dev_002'),
      ]);

      // Verify final state is consistent
      const binding = await bindingManager.getUserBinding(userId);
      expect(binding).not.toBeNull();

      // Should have 3 devices (added 1, removed 1, started with 3)
      expect(binding!.devices.length).toBe(3);

      // Active device should be set
      expect(binding!.activeDeviceId).toBeTruthy();

      // Exactly one device should be marked active
      const activeCount = binding!.devices.filter(d => d.isActive).length;
      expect(activeCount).toBe(1);
    });
  });
});
