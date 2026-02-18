import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { MemoryStore } from '../src/storage/MemoryStore';

describe('MemoryStore', () => {
  let store: MemoryStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new MemoryStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('binding code operations', () => {
    it('should set and get binding code', () => {
      const code = 'ABC-123-XYZ';
      const bindingCode = {
        code,
        deviceId: 'dev_test_123',
        createdAt: Date.now(),
        expiresAt: Date.now() + 5 * 60 * 1000
      };

      store.setBindingCode(code, bindingCode, 300);
      const retrieved = store.getBindingCode(code);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.deviceId).toBe('dev_test_123');
    });

    it('should return null for non-existent binding code', () => {
      const result = store.getBindingCode('NONEXISTENT');
      expect(result).toBeNull();
    });

    it('should auto-expire binding code after TTL', () => {
      const code = 'ABC-123-XYZ';
      const bindingCode = {
        code,
        deviceId: 'dev_test_123',
        createdAt: Date.now(),
        expiresAt: Date.now() + 5 * 60 * 1000
      };

      store.setBindingCode(code, bindingCode, 300); // 300 seconds TTL

      // Before TTL expires
      expect(store.getBindingCode(code)).not.toBeNull();

      // After TTL expires
      vi.advanceTimersByTime(301 * 1000);
      expect(store.getBindingCode(code)).toBeNull();
    });

    it('should return null and delete expired binding code based on expiresAt', () => {
      const code = 'ABC-123-XYZ';
      const now = Date.now();
      const expiredBindingCode = {
        code,
        deviceId: 'dev_test_123',
        createdAt: now - 10 * 60 * 1000,
        expiresAt: now - 5 * 60 * 1000 // Already expired
      };

      store.setBindingCode(code, expiredBindingCode, 300);
      const result = store.getBindingCode(code);

      expect(result).toBeNull();
    });

    it('should delete binding code', () => {
      const code = 'ABC-123-XYZ';
      const bindingCode = {
        code,
        deviceId: 'dev_test_123',
        createdAt: Date.now(),
        expiresAt: Date.now() + 5 * 60 * 1000
      };

      store.setBindingCode(code, bindingCode, 300);
      store.deleteBindingCode(code);

      const result = store.getBindingCode(code);
      expect(result).toBeNull();
    });

    it('should handle deleting non-existent binding code', () => {
      // Should not throw
      expect(() => store.deleteBindingCode('NONEXISTENT')).not.toThrow();
    });
  });

  describe('user binding operations', () => {
    it('should set and get user binding', () => {
      const openId = 'ou_user_123';
      const binding = {
        openId,
        devices: [{
          deviceId: 'dev_1',
          deviceName: 'Test-Device',
          boundAt: Date.now(),
          lastActiveAt: Date.now(),
          isActive: true
        }],
        activeDeviceId: 'dev_1',
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      store.setUserBinding(openId, binding);
      const retrieved = store.getUserBinding(openId);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.openId).toBe(openId);
      expect(retrieved?.devices.length).toBe(1);
    });

    it('should return null for non-existent user', () => {
      const result = store.getUserBinding('ou_nonexistent');
      expect(result).toBeNull();
    });

    it('should update device to user map when setting user binding', () => {
      const openId = 'ou_user_123';
      const binding = {
        openId,
        devices: [
          {
            deviceId: 'dev_1',
            deviceName: 'Device-1',
            boundAt: Date.now(),
            lastActiveAt: Date.now(),
            isActive: true
          },
          {
            deviceId: 'dev_2',
            deviceName: 'Device-2',
            boundAt: Date.now(),
            lastActiveAt: Date.now(),
            isActive: false
          }
        ],
        activeDeviceId: 'dev_1',
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      store.setUserBinding(openId, binding);

      expect(store.getUserByDeviceId('dev_1')).toBe(openId);
      expect(store.getUserByDeviceId('dev_2')).toBe(openId);
    });

    it('should delete user binding and device mappings', () => {
      const openId = 'ou_user_123';
      const binding = {
        openId,
        devices: [{
          deviceId: 'dev_1',
          deviceName: 'Test-Device',
          boundAt: Date.now(),
          lastActiveAt: Date.now(),
          isActive: true
        }],
        activeDeviceId: 'dev_1',
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      store.setUserBinding(openId, binding);
      store.deleteUserBinding(openId);

      expect(store.getUserBinding(openId)).toBeNull();
      expect(store.getUserByDeviceId('dev_1')).toBeNull();
    });

    it('should handle delete of non-existent user', () => {
      // Should not throw
      expect(() => store.deleteUserBinding('ou_nonexistent')).not.toThrow();
    });
  });

  describe('device to user mapping', () => {
    it('should get user by device ID', () => {
      const openId = 'ou_user_123';
      const binding = {
        openId,
        devices: [{
          deviceId: 'dev_1',
          deviceName: 'Test-Device',
          boundAt: Date.now(),
          lastActiveAt: Date.now(),
          isActive: true
        }],
        activeDeviceId: 'dev_1',
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      store.setUserBinding(openId, binding);
      expect(store.getUserByDeviceId('dev_1')).toBe(openId);
    });

    it('should return null for unknown device', () => {
      expect(store.getUserByDeviceId('unknown_device')).toBeNull();
    });
  });

  describe('updateLastActive', () => {
    it('should update last active time for active device', () => {
      const openId = 'ou_user_123';
      const now = Date.now();
      const binding = {
        openId,
        devices: [{
          deviceId: 'dev_1',
          deviceName: 'Test-Device',
          boundAt: now - 10000,
          lastActiveAt: now - 10000,
          isActive: true
        }],
        activeDeviceId: 'dev_1',
        createdAt: now - 10000,
        updatedAt: now - 10000
      };

      store.setUserBinding(openId, binding);

      // Advance time
      vi.advanceTimersByTime(1000);

      store.updateLastActive(openId);

      const updated = store.getUserBinding(openId);
      expect(updated?.devices[0].lastActiveAt).toBeGreaterThan(now - 10000);
      expect(updated?.updatedAt).toBeGreaterThan(now - 10000);
    });

    it('should handle user without active device', () => {
      const openId = 'ou_user_123';
      const binding = {
        openId,
        devices: [{
          deviceId: 'dev_1',
          deviceName: 'Test-Device',
          boundAt: Date.now(),
          lastActiveAt: Date.now(),
          isActive: false
        }],
        activeDeviceId: null,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      store.setUserBinding(openId, binding);
      // Should not throw
      expect(() => store.updateLastActive(openId)).not.toThrow();
    });

    it('should handle non-existent user', () => {
      // Should not throw
      expect(() => store.updateLastActive('ou_nonexistent')).not.toThrow();
    });
  });

  describe('clear', () => {
    it('should clear all data', () => {
      // Add some data
      store.setBindingCode('ABC-123', {
        code: 'ABC-123',
        deviceId: 'dev_1',
        createdAt: Date.now(),
        expiresAt: Date.now() + 60000
      }, 300);

      store.setUserBinding('ou_user_1', {
        openId: 'ou_user_1',
        devices: [{
          deviceId: 'dev_1',
          deviceName: 'Device',
          boundAt: Date.now(),
          lastActiveAt: Date.now(),
          isActive: true
        }],
        activeDeviceId: 'dev_1',
        createdAt: Date.now(),
        updatedAt: Date.now()
      });

      store.clear();

      const stats = store.getStats();
      expect(stats.bindingCodes).toBe(0);
      expect(stats.userBindings).toBe(0);
      expect(stats.devices).toBe(0);
    });
  });

  describe('getStats', () => {
    it('should return accurate statistics', () => {
      // Add binding codes
      store.setBindingCode('ABC-123', {
        code: 'ABC-123',
        deviceId: 'dev_1',
        createdAt: Date.now(),
        expiresAt: Date.now() + 60000
      }, 300);

      // Add user bindings
      store.setUserBinding('ou_user_1', {
        openId: 'ou_user_1',
        devices: [
          {
            deviceId: 'dev_1',
            deviceName: 'Device-1',
            boundAt: Date.now(),
            lastActiveAt: Date.now(),
            isActive: true
          },
          {
            deviceId: 'dev_2',
            deviceName: 'Device-2',
            boundAt: Date.now(),
            lastActiveAt: Date.now(),
            isActive: false
          }
        ],
        activeDeviceId: 'dev_1',
        createdAt: Date.now(),
        updatedAt: Date.now()
      });

      const stats = store.getStats();
      expect(stats.bindingCodes).toBe(1);
      expect(stats.userBindings).toBe(1);
      expect(stats.devices).toBe(2);
    });

    it('should return zero stats for empty store', () => {
      const stats = store.getStats();
      expect(stats.bindingCodes).toBe(0);
      expect(stats.userBindings).toBe(0);
      expect(stats.devices).toBe(0);
    });
  });

  describe('multiple users and devices', () => {
    it('should handle multiple users with multiple devices', () => {
      // User 1 with 2 devices
      store.setUserBinding('ou_user_1', {
        openId: 'ou_user_1',
        devices: [
          {
            deviceId: 'dev_1',
            deviceName: 'User1-Device1',
            boundAt: Date.now(),
            lastActiveAt: Date.now(),
            isActive: true
          },
          {
            deviceId: 'dev_2',
            deviceName: 'User1-Device2',
            boundAt: Date.now(),
            lastActiveAt: Date.now(),
            isActive: false
          }
        ],
        activeDeviceId: 'dev_1',
        createdAt: Date.now(),
        updatedAt: Date.now()
      });

      // User 2 with 1 device
      store.setUserBinding('ou_user_2', {
        openId: 'ou_user_2',
        devices: [{
          deviceId: 'dev_3',
          deviceName: 'User2-Device1',
          boundAt: Date.now(),
          lastActiveAt: Date.now(),
          isActive: true
        }],
        activeDeviceId: 'dev_3',
        createdAt: Date.now(),
        updatedAt: Date.now()
      });

      // Verify lookups
      expect(store.getUserByDeviceId('dev_1')).toBe('ou_user_1');
      expect(store.getUserByDeviceId('dev_2')).toBe('ou_user_1');
      expect(store.getUserByDeviceId('dev_3')).toBe('ou_user_2');

      const stats = store.getStats();
      expect(stats.userBindings).toBe(2);
      expect(stats.devices).toBe(3);
    });

    it('should update correct user binding', () => {
      // Setup two users
      store.setUserBinding('ou_user_1', {
        openId: 'ou_user_1',
        devices: [{
          deviceId: 'dev_1',
          deviceName: 'Device1',
          boundAt: Date.now() - 10000,
          lastActiveAt: Date.now() - 10000,
          isActive: true
        }],
        activeDeviceId: 'dev_1',
        createdAt: Date.now() - 10000,
        updatedAt: Date.now() - 10000
      });

      store.setUserBinding('ou_user_2', {
        openId: 'ou_user_2',
        devices: [{
          deviceId: 'dev_2',
          deviceName: 'Device2',
          boundAt: Date.now() - 10000,
          lastActiveAt: Date.now() - 10000,
          isActive: true
        }],
        activeDeviceId: 'dev_2',
        createdAt: Date.now() - 10000,
        updatedAt: Date.now() - 10000
      });

      // Advance time and update user 1
      vi.advanceTimersByTime(5000);
      store.updateLastActive('ou_user_1');

      // Verify only user 1 was updated
      const user1 = store.getUserBinding('ou_user_1');
      const user2 = store.getUserBinding('ou_user_2');

      expect(user1?.updatedAt).toBeGreaterThan(Date.now() - 6000);
      expect(user2?.updatedAt).toBeLessThan(Date.now() - 4000);
    });
  });
});
