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
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'router-concurrent-test-')));
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
      send: vi.fn(),
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
    deviceIds: string[]
  ): Promise<{ openId: string; deviceIds: string[]; activeDeviceId: string }> {
    // Bind all devices
    for (let i = 0; i < deviceIds.length; i++) {
      const deviceId = deviceIds[i];
      await bindingManager.bindUser(openId, deviceId, `Device-${i + 1}`);
    }

    return {
      openId,
      deviceIds,
      activeDeviceId: deviceIds[0],
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


  describe('Multi-Device User - Concurrent Operations', () => {
    it('should handle concurrent device switching for the same user', async () => {
      // Setup user with 3 devices
      const user = await setupUserWithDevices('user_001', ['dev_001', 'dev_002', 'dev_003']);

      const results = await Promise.all(['dev_002', 'dev_003', 'dev_001', 'dev_002'].map(deviceId =>
        bindingManager.switchActiveDevice(user.openId, deviceId)
      ));
      expect(results).toEqual([true, true, true, true]);
      const binding = await bindingManager.getUserBinding(user.openId);
      const active = await bindingManager.getActiveDevice(user.openId);
      expect(user.deviceIds).toContain(active?.deviceId);
      expect(binding?.devices.filter(device => device.isActive)).toEqual([active]);
    });

    it('routes the next command to the selected device after switching', async () => {
      const user = await setupUserWithDevices('user_001', ['dev_001', 'dev_002']);
      const connections = registerDeviceConnections(user.deviceIds);
      expect(await bindingManager.switchActiveDevice(user.openId, 'dev_002')).toBe(true);
      const active = await bindingManager.getActiveDevice(user.openId);
      const message = { type: MessageType.COMMAND, messageId: 'msg_001', content: 'test', timestamp: Date.now() };
      expect(await connectionHub.sendToDevice(active!.deviceId, message)).toBe(true);
      expect(connections.get('dev_002').send.mock.calls).toEqual([[JSON.stringify(message)]]);
      expect(connections.get('dev_001').send).not.toHaveBeenCalled();
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
    it('directs sends on either side of reconnection to their original sockets', async () => {
      const oldWs = createMockWebSocket();
      const replacement = createMockWebSocket();
      connectionHub.registerConnection('device', oldWs);
      const first = { type: MessageType.COMMAND, messageId: 'before', timestamp: Date.now() };
      const second = { ...first, messageId: 'after' };
      const pending = connectionHub.sendToDevice('device', first);
      connectionHub.registerConnection('device', replacement);
      expect(await pending).toBe(true);
      expect(await connectionHub.sendToDevice('device', second)).toBe(true);
      expect(oldWs.close).toHaveBeenCalled();
      expect(oldWs.send.mock.calls).toEqual([[JSON.stringify(first)]]);
      expect(replacement.send.mock.calls).toEqual([[JSON.stringify(second)]]);
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
    it('keeps forward and reverse bindings consistent across a concurrent bind, unbind and switch', async () => {
      const user = 'user_001';
      await Promise.all(['dev_001', 'dev_002', 'dev_003'].map(id => bindingManager.bindUser(user, id, id)));
      const [, removed, switched] = await Promise.all([
        bindingManager.bindUser(user, 'dev_004', 'Device-4'),
        bindingManager.unbindDevice(user, 'dev_001'),
        bindingManager.switchActiveDevice(user, 'dev_002'),
      ]);
      expect(removed).toBe(true);
      expect(switched).toBe(true);
      const binding = await bindingManager.getUserBinding(user);
      expect(binding?.devices.map(device => device.deviceId).sort()).toEqual(['dev_002', 'dev_003', 'dev_004']);
      expect(binding?.activeDeviceId).toBe('dev_002');
      expect(binding?.devices.filter(device => device.isActive).map(device => device.deviceId)).toEqual(['dev_002']);
      expect(await bindingManager.getDeviceBinding('dev_001')).toBeNull();
      expect(await bindingManager.getDeviceBinding('dev_004')).toMatchObject({ openId: user });
    });

    it('should prevent same device from being bound to multiple users simultaneously', async () => {
      const deviceId = 'dev_shared';

      // Bind to the first user (must succeed)
      await bindingManager.bindUser('user_001', deviceId, 'Device-1');

      // Subsequent bindings to different users must be rejected because the
      // device-to-user reverse map is already populated after the first call.
      const results = await Promise.allSettled([
        bindingManager.bindUser('user_002', deviceId, 'Device-2'),
        bindingManager.bindUser('user_003', deviceId, 'Device-3'),
      ]);

      const fulfilled = results.filter(r => r.status === 'fulfilled');
      const rejected = results.filter(r => r.status === 'rejected');

      // Neither should succeed because user_001 already owns the device
      expect(fulfilled.length).toBe(0);
      expect(rejected.length).toBe(2);
      for (const r of rejected) {
        expect((r as PromiseRejectedResult).reason.message).toContain('already bound to another user');
      }

      // Verify only the first user has the device
      const binding1 = await bindingManager.getUserBinding('user_001');
      const binding2 = await bindingManager.getUserBinding('user_002');
      const binding3 = await bindingManager.getUserBinding('user_003');

      expect(binding1!.devices.some(d => d.deviceId === deviceId)).toBe(true);
      expect(binding2).toBeNull();
      expect(binding3).toBeNull();
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
      const batches = users.map((user, userIndex) => ({
        deviceId: user.activeDeviceId,
        messages: Array.from({ length: messagesPerUser }, (_, index) => ({
          type: MessageType.COMMAND,
          messageId: `msg_${userIndex}_${index}`,
          content: `command_${userIndex}_${index}`,
          timestamp: Date.now(),
        })),
      }));
      const delivered = await Promise.all(batches.flatMap(({ deviceId, messages }) =>
        messages.map(message => connectionHub.sendToDevice(deviceId, message))
      ));
      expect(delivered.every(Boolean)).toBe(true);
      for (const { deviceId, messages } of batches) {
        const received = connections.get(deviceId).send.mock.calls.map(([body]: [string]) => JSON.parse(body));
        expect(received).toHaveLength(messages.length);
        expect(received).toEqual(expect.arrayContaining(messages));
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
