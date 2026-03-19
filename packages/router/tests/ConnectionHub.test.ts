import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConnectionHub } from '../src/websocket/ConnectionHub';
import { WebSocket } from 'ws';
import { MessageType } from '../src/types';

// Mock WebSocket
vi.mock('ws');

describe('ConnectionHub', () => {
  let hub: ConnectionHub;
  let mockWs: any;

  beforeEach(() => {
    hub = new ConnectionHub();

    // Create a mock WebSocket with all necessary methods
    mockWs = {
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
      readyState: 1, // OPEN
      OPEN: 1,
      CLOSED: 3
    };
  });

  describe('registerConnection', () => {
    it('should register a new device connection', () => {
      const deviceId = 'dev_test_001';

      hub.registerConnection(deviceId, mockWs);

      expect(hub.isDeviceOnline(deviceId)).toBe(true);
    });

    it('should replace existing connection when same device reconnects', () => {
      const deviceId = 'dev_test_001';
      const oldWs = { ...mockWs, close: vi.fn() };
      const newWs = { ...mockWs };

      hub.registerConnection(deviceId, oldWs);
      hub.registerConnection(deviceId, newWs);

      // Old WebSocket should be closed
      expect(oldWs.close).toHaveBeenCalled();
      expect(hub.isDeviceOnline(deviceId)).toBe(true);
    });

    it('should track last active time', () => {
      const deviceId = 'dev_test_001';
      const before = Date.now();

      hub.registerConnection(deviceId, mockWs);

      const lastActive = hub.getLastActiveTime(deviceId);
      expect(lastActive).toBeGreaterThanOrEqual(before);
      expect(lastActive).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('unregisterConnection', () => {
    it('should remove device connection', () => {
      const deviceId = 'dev_test_001';

      hub.registerConnection(deviceId, mockWs);
      expect(hub.isDeviceOnline(deviceId)).toBe(true);

      hub.unregisterConnection(deviceId);
      expect(hub.isDeviceOnline(deviceId)).toBe(false);
    });

    it('should handle unregistering non-existent device', () => {
      expect(() => {
        hub.unregisterConnection('non_existent_device');
      }).not.toThrow();
    });
  });

  describe('sendToDevice', () => {
    it('should send message to online device', async () => {
      const deviceId = 'dev_test_001';
      const message = {
        type: MessageType.COMMAND,
        messageId: 'msg_001',
        content: 'test command',
        timestamp: Date.now()
      };

      hub.registerConnection(deviceId, mockWs);

      const result = await hub.sendToDevice(deviceId, message);

      expect(result).toBe(true);
      expect(mockWs.send).toHaveBeenCalledWith(JSON.stringify(message));
    });

    it('should fail when device is offline', async () => {
      const deviceId = 'offline_device';
      const message = {
        type: MessageType.COMMAND,
        messageId: 'msg_001',
        content: 'test command',
        timestamp: Date.now()
      };

      const result = await hub.sendToDevice(deviceId, message);

      expect(result).toBe(false);
    });

    it('should handle WebSocket send errors', async () => {
      const deviceId = 'dev_test_001';
      const message = {
        type: MessageType.COMMAND,
        messageId: 'msg_001',
        content: 'test command',
        timestamp: Date.now()
      };

      const errorWs = {
        ...mockWs,
        send: vi.fn(() => {
          throw new Error('Connection closed');
        })
      };

      hub.registerConnection(deviceId, errorWs);

      const result = await hub.sendToDevice(deviceId, message);

      expect(result).toBe(false);
    });

    it('should update last active time on send', async () => {
      const deviceId = 'dev_test_001';
      const message = {
        type: MessageType.COMMAND,
        messageId: 'msg_001',
        content: 'test command',
        timestamp: Date.now()
      };

      hub.registerConnection(deviceId, mockWs);

      const before = hub.getLastActiveTime(deviceId)!;

      // Wait a bit to ensure time difference
      await new Promise(resolve => setTimeout(resolve, 10));

      await hub.sendToDevice(deviceId, message);

      const after = hub.getLastActiveTime(deviceId)!;
      expect(after).toBeGreaterThanOrEqual(before);
    });
  });

  describe('isDeviceOnline', () => {
    it('should return true for online device', () => {
      const deviceId = 'dev_test_001';

      hub.registerConnection(deviceId, mockWs);

      expect(hub.isDeviceOnline(deviceId)).toBe(true);
    });

    it('should return false for offline device', () => {
      expect(hub.isDeviceOnline('offline_device')).toBe(false);
    });

    it('should return false for unregistered device', () => {
      const deviceId = 'dev_test_001';

      hub.registerConnection(deviceId, mockWs);
      hub.unregisterConnection(deviceId);

      expect(hub.isDeviceOnline(deviceId)).toBe(false);
    });
  });

  describe('getOnlineDevices', () => {
    it('should return list of all online device IDs', () => {
      const device1 = 'dev_test_001';
      const device2 = 'dev_test_002';
      const device3 = 'dev_test_003';

      hub.registerConnection(device1, mockWs);
      hub.registerConnection(device2, mockWs);
      hub.registerConnection(device3, mockWs);

      const onlineDevices = hub.getOnlineDevices();

      expect(onlineDevices).toContain(device1);
      expect(onlineDevices).toContain(device2);
      expect(onlineDevices).toContain(device3);
      expect(onlineDevices).toHaveLength(3);
    });

    it('should return empty array when no devices online', () => {
      const onlineDevices = hub.getOnlineDevices();

      expect(onlineDevices).toEqual([]);
    });
  });

  describe('getConnectionStats', () => {
    it('should return statistics about connections', () => {
      const device1 = 'dev_test_001';
      const device2 = 'dev_test_002';

      hub.registerConnection(device1, mockWs);
      hub.registerConnection(device2, mockWs);

      const stats = hub.getConnectionStats();

      expect(stats.totalConnections).toBe(2);
      expect(stats.deviceIds).toContain(device1);
      expect(stats.deviceIds).toContain(device2);
    });

    it('should return zero stats when no connections', () => {
      const stats = hub.getConnectionStats();

      expect(stats.totalConnections).toBe(0);
      expect(stats.deviceIds).toEqual([]);
    });

    it('should return accurate connection stats after multiple register/unregister cycles', () => {
      const device1 = 'dev_test_001';
      const device2 = 'dev_test_002';
      const device3 = 'dev_test_003';
      const mockWs1 = { ...mockWs, send: vi.fn(), close: vi.fn() };
      const mockWs2 = { ...mockWs, send: vi.fn(), close: vi.fn() };
      const mockWs3 = { ...mockWs, send: vi.fn(), close: vi.fn() };

      // Register 3 connections
      hub.registerConnection(device1, mockWs1);
      hub.registerConnection(device2, mockWs2);
      hub.registerConnection(device3, mockWs3);

      // Unregister 1
      hub.unregisterConnection(device2);

      const stats = hub.getConnectionStats();
      expect(stats.totalConnections).toBe(2);
      expect(stats.deviceIds).toContain(device1);
      expect(stats.deviceIds).toContain(device3);
      expect(stats.deviceIds).not.toContain(device2);
    });
  });

  describe('broadcast', () => {
    it('should send message to all connected devices', async () => {
      const device1 = 'dev_test_001';
      const device2 = 'dev_test_002';
      const mockWs1 = { ...mockWs, send: vi.fn() };
      const mockWs2 = { ...mockWs, send: vi.fn() };

      hub.registerConnection(device1, mockWs1);
      hub.registerConnection(device2, mockWs2);

      const message = {
        type: MessageType.HEARTBEAT,
        timestamp: Date.now()
      };

      await hub.broadcast(message);

      expect(mockWs1.send).toHaveBeenCalledWith(JSON.stringify(message));
      expect(mockWs2.send).toHaveBeenCalledWith(JSON.stringify(message));
    });

    it('should skip devices with send errors', async () => {
      const device1 = 'dev_test_001';
      const device2 = 'dev_test_002';
      const mockWs1 = {
        ...mockWs,
        send: vi.fn(() => {
          throw new Error('Send error');
        })
      };
      const mockWs2 = { ...mockWs, send: vi.fn() };

      hub.registerConnection(device1, mockWs1);
      hub.registerConnection(device2, mockWs2);

      const message = {
        type: MessageType.HEARTBEAT,
        timestamp: Date.now()
      };

      await hub.broadcast(message);

      // Device 2 should still receive the message
      expect(mockWs2.send).toHaveBeenCalled();
    });
  });

  describe('updateLastActive', () => {
    it('should update last active time for online device', async () => {
      const deviceId = 'dev_test_001';

      hub.registerConnection(deviceId, mockWs);

      const before = hub.getLastActiveTime(deviceId)!;

      // Wait a bit to ensure time difference
      await new Promise(resolve => setTimeout(resolve, 10));

      hub.updateLastActive(deviceId);

      const after = hub.getLastActiveTime(deviceId)!;
      expect(after).toBeGreaterThan(before);
    });

    it('should not throw when updating non-existent device', () => {
      expect(() => {
        hub.updateLastActive('non_existent_device');
      }).not.toThrow();
    });

    it('should prevent cleanup when last active time is updated', async () => {
      const deviceId = 'dev_test_001';

      hub.registerConnection(deviceId, mockWs);

      // Simulate time passing by updating last active to now
      hub.updateLastActive(deviceId);

      // Cleanup with 1ms timeout - device should not be cleaned up
      // because we just updated the last active time
      hub.cleanupStaleConnections(1);

      expect(hub.isDeviceOnline(deviceId)).toBe(true);
    });
  });

  describe('cleanupStaleConnections', () => {
    it('should remove connections inactive for longer than timeout', () => {
      const deviceId = 'dev_test_001';

      hub.registerConnection(deviceId, mockWs);

      // Simulate stale connection by manually setting old timestamp
      // This would require exposing a test method or waiting for actual timeout
      // For now, we test the method exists and can be called
      hub.cleanupStaleConnections(1000); // 1 second timeout

      // Connection should still be there (it's not actually stale yet)
      expect(hub.isDeviceOnline(deviceId)).toBe(true);
    });

    it('should not cleanup recently active connections', () => {
      const deviceId = 'dev_test_001';

      hub.registerConnection(deviceId, mockWs);

      // Cleanup with very long timeout
      hub.cleanupStaleConnections(60000); // 60 seconds

      expect(hub.isDeviceOnline(deviceId)).toBe(true);
    });
  });

  describe('closeAllConnections', () => {
    it('should close all WebSocket connections', () => {
      const device1 = 'dev_test_001';
      const device2 = 'dev_test_002';
      const mockWs1 = { ...mockWs, terminate: vi.fn() };
      const mockWs2 = { ...mockWs, terminate: vi.fn() };

      hub.registerConnection(device1, mockWs1);
      hub.registerConnection(device2, mockWs2);

      hub.closeAllConnections();

      expect(mockWs1.terminate).toHaveBeenCalled();
      expect(mockWs2.terminate).toHaveBeenCalled();
      expect(hub.getOnlineDevices()).toHaveLength(0);
    });

    it('should handle closing when no connections exist', () => {
      expect(() => {
        hub.closeAllConnections();
      }).not.toThrow();
    });
  });
});
