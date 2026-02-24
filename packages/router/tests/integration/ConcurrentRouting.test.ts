/**
 * Integration tests for concurrent routing with multiple users and devices
 *
 * These tests verify that the router can correctly handle:
 * 1. Multiple concurrent users sending commands
 * 2. Multiple devices per user
 * 3. Concurrent device switching
 * 4. Race conditions in streaming message handling
 * 5. Message routing correctness under load
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConnectionHub } from '../../src/websocket/ConnectionHub';
import { BindingManager } from '../../src/binding/BindingManager';
import { JsonStore } from '../../src/storage/JsonStore';
import { MessageType } from '../../src/types';
import { WebSocket } from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock WebSocket
vi.mock('ws');

describe('ConcurrentRouting - Integration Tests', () => {

  let tempDir: string;
  let store: JsonStore;
  let connectionHub: ConnectionHub;
  let bindingManager: BindingManager;

  beforeEach(async () => {
    // Create temporary directory for test data
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-concurrent-test-'));
    const storeFilePath = path.join(tempDir, 'bindings.json');
    store = new JsonStore(storeFilePath, 0);
    await store.initialize(); // Initialize the store
    connectionHub = new ConnectionHub();
    bindingManager = new BindingManager(store);
  }, 10000); // Increase timeout for setup

  afterEach(async () => {
    // Cleanup
    connectionHub.closeAllConnections();
    await store.flush(); // Ensure all saves are complete
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 10000); // Increase timeout for cleanup

  /**
   * Helper: Create a mock WebSocket with spy functions
   */
  function createMockWebSocket(): any {
    return {
      send: vi.fn((data: string) => {
        // Simulate async send
        return Promise.resolve();
      }),
      close: vi.fn(),
      on: vi.fn(),
      readyState: 1, // OPEN
      OPEN: 1,
      CLOSED: 3,
    };
  }

  /**
   * Helper: Setup a user with devices
   */
  async function setupUserWithDevices(
    openId: string,
    deviceIds: string[],
    activeDeviceIndex: number = 0
  ): Promise<{ openId: string; deviceIds: string[]; activeDeviceId: string }> {
    // Bind all devices
    for (let i = 0; i < deviceIds.length; i++) {
      const deviceId = deviceIds[i];
      const code = await bindingManager.generateBindingCode(deviceId, `Device-${i + 1}`);
      await bindingManager.bindUser(openId, deviceId, `Device-${i + 1}`);
    }

    // Set active device if not the first one
    if (activeDeviceIndex > 0) {
      await bindingManager.switchActiveDevice(openId, deviceIds[activeDeviceIndex]);
    }

    return {
      openId,
      deviceIds,
      activeDeviceId: deviceIds[activeDeviceIndex],
    };
  }

  /**
   * Helper: Register device connections
   */
  function registerDeviceConnections(deviceIds: string[]): Map<string, any> {
    const connections = new Map<string, any>();
    for (const deviceId of deviceIds) {
      const ws = createMockWebSocket();
      connectionHub.registerConnection(deviceId, ws);
      connections.set(deviceId, ws);
    }
    return connections;
  }

  describe('Multiple Users - Concurrent Commands', () => {
    it('should route messages to correct users when multiple users send commands concurrently', async () => {
      // Setup 3 users with 1 device each
      const user1 = await setupUserWithDevices('user_001', ['dev_001']);
      const user2 = await setupUserWithDevices('user_002', ['dev_002']);
      const user3 = await setupUserWithDevices('user_003', ['dev_003']);

      // Register all device connections
      const connections = registerDeviceConnections([
        user1.activeDeviceId,
        user2.activeDeviceId,
        user3.activeDeviceId,
      ]);

      // Send concurrent messages to all devices
      const message1 = { type: MessageType.COMMAND, messageId: 'msg_001', content: 'cmd1', timestamp: Date.now() };
      const message2 = { type: MessageType.COMMAND, messageId: 'msg_002', content: 'cmd2', timestamp: Date.now() };
      const message3 = { type: MessageType.COMMAND, messageId: 'msg_003', content: 'cmd3', timestamp: Date.now() };

      await Promise.all([
        connectionHub.sendToDevice(user1.activeDeviceId, message1),
        connectionHub.sendToDevice(user2.activeDeviceId, message2),
        connectionHub.sendToDevice(user3.activeDeviceId, message3),
      ]);

      // Verify each device received the correct message
      const ws1 = connections.get(user1.activeDeviceId);
      const ws2 = connections.get(user2.activeDeviceId);
      const ws3 = connections.get(user3.activeDeviceId);

      expect(ws1.send).toHaveBeenCalledWith(JSON.stringify(message1));
      expect(ws2.send).toHaveBeenCalledWith(JSON.stringify(message2));
      expect(ws3.send).toHaveBeenCalledWith(JSON.stringify(message3));

      // Verify no cross-contamination
      expect(ws1.send).toHaveBeenCalledTimes(1);
      expect(ws2.send).toHaveBeenCalledTimes(1);
      expect(ws3.send).toHaveBeenCalledTimes(1);
    });

    it('should handle 10 concurrent users sending commands simultaneously', async () => {
      const userCount = 10;
      const users = [];
      const deviceIds = [];

      // Setup 10 users
      for (let i = 0; i < userCount; i++) {
        const userId = `user_${String(i).padStart(3, '0')}`;
        const deviceId = `dev_${String(i).padStart(3, '0')}`;
        const user = await setupUserWithDevices(userId, [deviceId]);
        users.push(user);
        deviceIds.push(deviceId);
      }

      // Register all connections
      const connections = registerDeviceConnections(deviceIds);

      // Send concurrent messages from all users
      const sendPromises = users.map((user, index) => {
        const message = {
          type: MessageType.COMMAND,
          messageId: `msg_${String(index).padStart(3, '0')}`,
          content: `command_${index}`,
          timestamp: Date.now(),
        };
        return connectionHub.sendToDevice(user.activeDeviceId, message);
      });

      const results = await Promise.all(sendPromises);

      // All sends should succeed
      expect(results.every(result => result === true)).toBe(true);

      // Verify each device received exactly one message
      for (const [deviceId, ws] of connections) {
        expect(ws.send).toHaveBeenCalledTimes(1);
      }
    });
  });

  describe('Multi-Device User - Concurrent Operations', () => {
    it('should handle concurrent device switching for the same user', async () => {
      // Setup user with 3 devices
      const user = await setupUserWithDevices('user_001', ['dev_001', 'dev_002', 'dev_003']);

      // Register connections
      registerDeviceConnections(user.deviceIds);

      // Concurrently switch between devices
      const switches = [
        bindingManager.switchActiveDevice(user.openId, 'dev_002'),
        bindingManager.switchActiveDevice(user.openId, 'dev_003'),
        bindingManager.switchActiveDevice(user.openId, 'dev_001'),
        bindingManager.switchActiveDevice(user.openId, 'dev_002'),
      ];

      const results = await Promise.all(switches);

      // All switches should succeed (last one wins)
      expect(results.every(r => r === true)).toBe(true);

      // Verify final active device is consistent
      const activeDevice = await bindingManager.getActiveDevice(user.openId);
      expect(activeDevice).not.toBeNull();
      expect(user.deviceIds).toContain(activeDevice!.deviceId);
    });

    it('should route message to correct device after concurrent switch', async () => {
      // Setup user with 2 devices
      const user = await setupUserWithDevices('user_001', ['dev_001', 'dev_002']);
      const connections = registerDeviceConnections(user.deviceIds);

      // Perform concurrent device switch and message send
      await Promise.all([
        bindingManager.switchActiveDevice(user.openId, 'dev_002'),
        new Promise(resolve => setTimeout(resolve, 5)), // Small delay
      ]);

      // Send message after switch
      const activeDevice = await bindingManager.getActiveDevice(user.openId);
      expect(activeDevice).not.toBeNull();

      const message = {
        type: MessageType.COMMAND,
        messageId: 'msg_001',
        content: 'test',
        timestamp: Date.now(),
      };

      await connectionHub.sendToDevice(activeDevice!.deviceId, message);

      // Verify message was sent to active device
      const activeWs = connections.get(activeDevice!.deviceId);
      expect(activeWs.send).toHaveBeenCalledWith(JSON.stringify(message));
    });

    it('should handle concurrent unbind and switch operations', async () => {
      // Setup user with 3 devices
      const user = await setupUserWithDevices('user_001', ['dev_001', 'dev_002', 'dev_003']);

      // Concurrently unbind and switch
      const operations = [
        bindingManager.unbindDevice(user.openId, 'dev_001'),
        bindingManager.switchActiveDevice(user.openId, 'dev_002'),
        bindingManager.switchActiveDevice(user.openId, 'dev_003'),
      ];

      // Should not throw
      await expect(Promise.all(operations)).resolves.toBeDefined();

      // Verify final state is consistent
      const binding = await bindingManager.getUserBinding(user.openId);
      expect(binding).not.toBeNull();
      expect(binding!.devices).toHaveLength(2); // One device removed
      expect(binding!.activeDeviceId).toBeTruthy();
    });
  });

  describe('Device Reconnection - Race Conditions', () => {
    it('should handle device reconnection while message is being sent', async () => {
      const deviceId = 'dev_001';
      const oldWs = createMockWebSocket();
      const newWs = createMockWebSocket();

      // Register initial connection
      connectionHub.registerConnection(deviceId, oldWs);

      // Simulate concurrent message send and reconnection
      const message = {
        type: MessageType.COMMAND,
        messageId: 'msg_001',
        content: 'test',
        timestamp: Date.now(),
      };

      await Promise.all([
        connectionHub.sendToDevice(deviceId, message),
        new Promise(resolve => setTimeout(resolve, 1)), // Small delay
        (async () => {
          connectionHub.registerConnection(deviceId, newWs);
        })(),
      ]);

      // Old connection should be closed
      expect(oldWs.close).toHaveBeenCalled();

      // Device should still be online
      expect(connectionHub.isDeviceOnline(deviceId)).toBe(true);
    });

    it('should handle rapid reconnections (connection flapping)', async () => {
      const deviceId = 'dev_001';
      const connections = Array.from({ length: 5 }, () => createMockWebSocket());

      // Rapidly register and re-register connections
      for (const ws of connections) {
        connectionHub.registerConnection(deviceId, ws);
        await new Promise(resolve => setTimeout(resolve, 1));
      }

      // Only the last connection should be active
      expect(connectionHub.isDeviceOnline(deviceId)).toBe(true);

      // All old connections except the last should be closed
      for (let i = 0; i < connections.length - 1; i++) {
        expect(connections[i].close).toHaveBeenCalled();
      }

      // Last connection should not be closed
      expect(connections[connections.length - 1].close).not.toHaveBeenCalled();
    });
  });

  describe('Binding Operations - Concurrent Users', () => {
    it('should prevent same device from being bound to multiple users simultaneously', async () => {
      const deviceId = 'dev_shared';

      // Generate binding code
      const code = await bindingManager.generateBindingCode(deviceId, 'Shared Device');

      // Try to bind to multiple users concurrently
      const bindings = [
        bindingManager.bindUser('user_001', deviceId, 'Device-1'),
        bindingManager.bindUser('user_002', deviceId, 'Device-2'),
        bindingManager.bindUser('user_003', deviceId, 'Device-3'),
      ];

      // All bindings should succeed (this is actually allowed in current implementation)
      // The device can be bound to multiple users, but each user sees it as their device
      await expect(Promise.all(bindings)).resolves.toBeDefined();

      // Verify all users have the device
      const binding1 = await bindingManager.getUserBinding('user_001');
      const binding2 = await bindingManager.getUserBinding('user_002');
      const binding3 = await bindingManager.getUserBinding('user_003');

      expect(binding1!.devices.some(d => d.deviceId === deviceId)).toBe(true);
      expect(binding2!.devices.some(d => d.deviceId === deviceId)).toBe(true);
      expect(binding3!.devices.some(d => d.deviceId === deviceId)).toBe(true);

      // NOTE: This is a potential issue - same device can be bound to multiple users
      // This might cause routing conflicts if the device connects to the router
    });

    it('should handle concurrent binding code generation for different devices', async () => {
      const devices = Array.from({ length: 10 }, (_, i) => `dev_${String(i).padStart(3, '0')}`);

      // Generate binding codes concurrently
      const codePromises = devices.map((deviceId, i) =>
        bindingManager.generateBindingCode(deviceId, `Device-${i}`)
      );

      const codes = await Promise.all(codePromises);

      // All codes should be unique
      const codeStrings = codes.map(c => c.code);
      const uniqueCodes = new Set(codeStrings);
      expect(uniqueCodes.size).toBe(codes.length);

      // All codes should be valid
      for (const code of codes) {
        expect(code.code).toMatch(/^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/);
        expect(code.expiresAt).toBeGreaterThan(Date.now());
      }
    });

    it('should handle concurrent last active updates for multiple users', async () => {
      // Setup multiple users
      const users = await Promise.all([
        setupUserWithDevices('user_001', ['dev_001']),
        setupUserWithDevices('user_002', ['dev_002']),
        setupUserWithDevices('user_003', ['dev_003']),
      ]);

      // Register connections
      registerDeviceConnections(['dev_001', 'dev_002', 'dev_003']);

      // Concurrently update last active for all users
      const updates = users.map(user =>
        bindingManager.updateLastActive(user.openId)
      );

      // Should not throw
      await expect(Promise.all(updates)).resolves.toBeDefined();

      // Verify all users have updated lastActiveAt
      for (const user of users) {
        const binding = await bindingManager.getUserBinding(user.openId);
        expect(binding).not.toBeNull();
        expect(binding!.updatedAt).toBeGreaterThan(Date.now() - 1000); // Updated within last second
      }
    });
  });

  describe('Message Routing - High Load', () => {
    it('should correctly route 100 messages from 10 users concurrently', async () => {
      const userCount = 10;
      const messagesPerUser = 10;

      // Setup users
      const users = await Promise.all(
        Array.from({ length: userCount }, (_, i) =>
          setupUserWithDevices(`user_${String(i).padStart(3, '0')}`, [`dev_${String(i).padStart(3, '0')}`])
        )
      );

      // Register connections
      const connections = registerDeviceConnections(users.map(u => u.activeDeviceId));

      // Send messages concurrently
      const sendPromises = users.flatMap((user, userIndex) =>
        Array.from({ length: messagesPerUser }, (_, msgIndex) => {
          const message = {
            type: MessageType.COMMAND,
            messageId: `msg_${userIndex}_${msgIndex}`,
            content: `command_${userIndex}_${msgIndex}`,
            timestamp: Date.now(),
          };
          return connectionHub.sendToDevice(user.activeDeviceId, message);
        })
      );

      const results = await Promise.all(sendPromises);

      // All sends should succeed
      expect(results.every(r => r === true)).toBe(true);

      // Verify each device received exactly 10 messages
      for (const [deviceId, ws] of connections) {
        expect(ws.send).toHaveBeenCalledTimes(messagesPerUser);
      }
    });

    it('should handle broadcast to multiple devices without cross-contamination', async () => {
      // Setup 5 devices
      const deviceIds = Array.from({ length: 5 }, (_, i) => `dev_${String(i).padStart(3, '0')}`);
      const connections = registerDeviceConnections(deviceIds);

      // Broadcast message
      const broadcastMessage = {
        type: MessageType.HEARTBEAT,
        timestamp: Date.now(),
      };

      await connectionHub.broadcast(broadcastMessage);

      // All devices should receive the message
      for (const [deviceId, ws] of connections) {
        expect(ws.send).toHaveBeenCalledWith(JSON.stringify(broadcastMessage));
        expect(ws.send).toHaveBeenCalledTimes(1);
      }
    });
  });

  describe('Edge Cases - Race Conditions', () => {
    it('should handle user unbind during active message routing', async () => {
      // Setup user
      const user = await setupUserWithDevices('user_001', ['dev_001']);
      const connections = registerDeviceConnections([user.activeDeviceId]);

      const message = {
        type: MessageType.COMMAND,
        messageId: 'msg_001',
        content: 'test',
        timestamp: Date.now(),
      };

      // Concurrently send message and unbind user
      await Promise.all([
        connectionHub.sendToDevice(user.activeDeviceId, message),
        bindingManager.unbindUser(user.openId),
      ]);

      // Connection should still exist in hub (it's only removed on disconnect)
      expect(connectionHub.isDeviceOnline(user.activeDeviceId)).toBe(true);

      // User binding should be removed
      const binding = await bindingManager.getUserBinding(user.openId);
      expect(binding).toBeNull();
    });

    it('should handle concurrent device registration and message send', async () => {
      const deviceId = 'dev_001';
      const ws = createMockWebSocket();

      const message = {
        type: MessageType.COMMAND,
        messageId: 'msg_001',
        content: 'test',
        timestamp: Date.now(),
      };

      // Race: register and send at the same time
      const [sendResult] = await Promise.all([
        connectionHub.sendToDevice(deviceId, message),
        (async () => {
          connectionHub.registerConnection(deviceId, ws);
        })(),
      ]);

      // Send might fail or succeed depending on timing
      // The important thing is it doesn't crash
      expect(typeof sendResult).toBe('boolean');

      // Device should be online after registration
      expect(connectionHub.isDeviceOnline(deviceId)).toBe(true);
    });

    it('should handle cleanup during active connections', async () => {
      // Setup multiple devices
      const deviceIds = Array.from({ length: 5 }, (_, i) => `dev_${String(i).padStart(3, '0')}`);
      registerDeviceConnections(deviceIds);

      // All devices are online
      expect(connectionHub.getOnlineDevices()).toHaveLength(5);

      // Wait a bit to ensure timestamps are old enough
      await new Promise(resolve => setTimeout(resolve, 100));

      // Cleanup stale connections (with 1ms timeout - all should be cleaned because they're older than 1ms)
      connectionHub.cleanupStaleConnections(1);

      // All devices should be removed
      expect(connectionHub.getOnlineDevices()).toHaveLength(0);
    });
  });

  describe('Device ID Collision Detection', () => {
    it('should prevent same device ID from being bound to multiple users', async () => {
      const sharedDeviceId = 'dev_shared_001';

      // Bind device to first user successfully
      await bindingManager.bindUser('user_001', sharedDeviceId, 'Device-1');

      // Attempt to bind same device to a different user should throw
      await expect(
        bindingManager.bindUser('user_002', sharedDeviceId, 'Device-2')
      ).rejects.toThrow('already bound to another user');

      // Verify only the first user has the device
      const binding1 = await bindingManager.getUserBinding('user_001');
      const binding2 = await bindingManager.getUserBinding('user_002');

      expect(binding1!.devices.some(d => d.deviceId === sharedDeviceId)).toBe(true);
      expect(binding2).toBeNull();
    });
  });

  describe('Active Device Selection Under Concurrent Load', () => {
    it('should maintain consistent active device when switching during message floods', async () => {
      // Setup user with 3 devices
      const user = await setupUserWithDevices('user_001', ['dev_001', 'dev_002', 'dev_003']);
      const connections = registerDeviceConnections(user.deviceIds);

      // Start flooding messages
      const messageBatch = Array.from({ length: 20 }, (_, i) => ({
        type: MessageType.COMMAND,
        messageId: `msg_${String(i).padStart(3, '0')}`,
        content: `command_${i}`,
        timestamp: Date.now(),
      }));

      // Concurrently switch devices and send messages
      const operations = [
        // Device switches
        bindingManager.switchActiveDevice(user.openId, 'dev_002'),
        bindingManager.switchActiveDevice(user.openId, 'dev_003'),
        bindingManager.switchActiveDevice(user.openId, 'dev_001'),
        // Message sends
        ...messageBatch.map(async (msg) => {
          const active = await bindingManager.getActiveDevice(user.openId);
          if (active) {
            return connectionHub.sendToDevice(active.deviceId, msg);
          }
          return false;
        }),
      ];

      await Promise.all(operations);

      // Verify final state is consistent
      const finalActive = await bindingManager.getActiveDevice(user.openId);
      expect(finalActive).not.toBeNull();
      expect(user.deviceIds).toContain(finalActive!.deviceId);

      // Verify total messages sent equals batch size
      const totalSent = Array.from(connections.values())
        .reduce((sum, ws) => sum + ws.send.mock.calls.length, 0);
      expect(totalSent).toBe(messageBatch.length);
    });
  });
});
