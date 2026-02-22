import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BindingManager } from '../src/binding/BindingManager';
import { JsonStore } from '../src/storage/JsonStore';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

describe('BindingManager', () => {
  let bindingManager: BindingManager;
  let store: JsonStore;
  let testDir: string;

  beforeEach(async () => {
    // Create a temporary directory for test data
    testDir = path.join(os.tmpdir(), `binding-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    const storePath = path.join(testDir, 'bindings.json');
    store = new JsonStore(storePath);
    await store.initialize();
    bindingManager = new BindingManager(store);
  });

  afterEach(async () => {
    // Flush pending saves before cleanup
    await store.flush();

    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('generateBindingCode', () => {
    it('should generate binding code in correct format', async () => {
      const deviceId = 'dev_test_123';
      const deviceName = 'Test-Device';

      const bindingCode = await bindingManager.generateBindingCode(deviceId, deviceName);

      // Verify binding code format: XXX-XXX-XXX
      expect(bindingCode.code).toMatch(/^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/);
      expect(bindingCode.deviceId).toBe(deviceId);
      expect(bindingCode.createdAt).toBeLessThanOrEqual(Date.now());
      expect(bindingCode.expiresAt).toBe(bindingCode.createdAt + 5 * 60 * 1000); // Expires in 5 minutes
    });

    it('should store binding code in store', async () => {
      const deviceId = 'dev_test_123';
      const deviceName = 'Test-Device';

      const bindingCode = await bindingManager.generateBindingCode(deviceId, deviceName);

      // Verify the code can be retrieved
      const retrieved = await bindingManager.verifyBindingCode(bindingCode.code);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.deviceId).toBe(deviceId);
    });
  });

  describe('verifyBindingCode', () => {
    it('should verify valid binding code', async () => {
      const deviceId = 'dev_test_123';

      // Generate a code first
      const bindingCode = await bindingManager.generateBindingCode(deviceId, 'Test-Device');

      const result = await bindingManager.verifyBindingCode(bindingCode.code);

      expect(result).not.toBeNull();
      expect(result?.deviceId).toBe(deviceId);
    });

    it('should reject expired binding code', async () => {
      const code = 'ABC-123-XYZ';
      const expiredBindingCode = {
        code,
        deviceId: 'dev_test_123',
        createdAt: Date.now() - 10 * 60 * 1000,
        expiresAt: Date.now() - 5 * 60 * 1000 // Already expired
      };

      // Store expired code directly
      await store.setBindingCode(code, expiredBindingCode);

      const result = await bindingManager.verifyBindingCode(code);

      expect(result).toBeNull();
    });

    it('should reject non-existent binding code', async () => {
      const code = 'INVALID-CODE';

      const result = await bindingManager.verifyBindingCode(code);

      expect(result).toBeNull();
    });
  });

  describe('bindUser (multi-device)', () => {
    it('should successfully bind first device and set it as active', async () => {
      const openId = 'ou_test_user';
      const deviceId = 'dev_test_123';
      const deviceName = 'Test-Device';

      await bindingManager.bindUser(openId, deviceId, deviceName);

      // Verify binding was created
      const binding = await bindingManager.getUserBinding(openId);
      expect(binding).not.toBeNull();
      expect(binding?.openId).toBe(openId);
      expect(binding?.devices.length).toBe(1);
      expect(binding?.devices[0].deviceId).toBe(deviceId);
      expect(binding?.devices[0].deviceName).toBe(deviceName);
      expect(binding?.devices[0].isActive).toBe(true);
      expect(binding?.activeDeviceId).toBe(deviceId);
    });

    it('should bind multiple devices to the same user', async () => {
      const openId = 'ou_test_user';
      const device1Id = 'dev_test_123';
      const device2Id = 'dev_test_456';

      // Bind first device
      await bindingManager.bindUser(openId, device1Id, 'Device-1');

      // Bind second device
      await bindingManager.bindUser(openId, device2Id, 'Device-2');

      // Verify both devices are bound
      const binding = await bindingManager.getUserBinding(openId);
      expect(binding?.devices.length).toBe(2);
      expect(binding?.devices[0].deviceId).toBe(device1Id);
      expect(binding?.devices[0].isActive).toBe(true); // First device is active
      expect(binding?.devices[1].deviceId).toBe(device2Id);
      expect(binding?.devices[1].isActive).toBe(false); // Second device is inactive
      expect(binding?.activeDeviceId).toBe(device1Id);
    });

    it('should not add duplicate device', async () => {
      const openId = 'ou_test_user';
      const deviceId = 'dev_test_123';

      await bindingManager.bindUser(openId, deviceId, 'Device-1');
      await bindingManager.bindUser(openId, deviceId, 'Device-1-Updated');

      const binding = await bindingManager.getUserBinding(openId);
      expect(binding?.devices.length).toBe(1); // Still only 1 device
      expect(binding?.devices[0].deviceName).toBe('Device-1-Updated'); // Name updated
    });

    it('should reject binding device that is already bound to another user', async () => {
      const user1OpenId = 'ou_user_001';
      const user2OpenId = 'ou_user_002';
      const sharedDeviceId = 'dev_shared_123';

      // User 1 binds the device first
      await bindingManager.bindUser(user1OpenId, sharedDeviceId, 'Device-1');

      // User 2 tries to bind the same device - should be rejected
      await expect(
        bindingManager.bindUser(user2OpenId, sharedDeviceId, 'Device-2')
      ).rejects.toThrow(/already bound to another user/);

      // Verify only user 1 has the device
      const user1Binding = await bindingManager.getUserBinding(user1OpenId);
      const user2Binding = await bindingManager.getUserBinding(user2OpenId);

      expect(user1Binding?.devices.some(d => d.deviceId === sharedDeviceId)).toBe(true);
      expect(user2Binding).toBeNull(); // User 2 has no devices
    });

    it('should allow same user to rebind their own device', async () => {
      const openId = 'ou_test_user';
      const deviceId = 'dev_test_123';

      // Bind device first time
      await bindingManager.bindUser(openId, deviceId, 'Device-Old-Name');

      // Same user rebinds the same device with new name - should succeed
      await expect(
        bindingManager.bindUser(openId, deviceId, 'Device-New-Name')
      ).resolves.not.toThrow();

      // Verify device name was updated
      const binding = await bindingManager.getUserBinding(openId);
      expect(binding?.devices[0].deviceName).toBe('Device-New-Name');
    });
  });

  describe('getUserBinding', () => {
    it('should get user binding information with multiple devices', async () => {
      const openId = 'ou_test_user';
      const device1Id = 'dev_test_123';
      const device2Id = 'dev_test_456';

      await bindingManager.bindUser(openId, device1Id, 'Device-1');
      await bindingManager.bindUser(openId, device2Id, 'Device-2');

      const binding = await bindingManager.getUserBinding(openId);

      expect(binding).not.toBeNull();
      expect(binding?.openId).toBe(openId);
      expect(binding?.devices.length).toBe(2);
      expect(binding?.activeDeviceId).toBe(device1Id);
    });

    it('should return null when user is not bound', async () => {
      const openId = 'ou_unbound_user';

      const binding = await bindingManager.getUserBinding(openId);

      expect(binding).toBeNull();
    });
  });

  describe('getUserDevices', () => {
    it('should get all user devices', async () => {
      const openId = 'ou_test_user';
      await bindingManager.bindUser(openId, 'dev_1', 'Device-1');
      await bindingManager.bindUser(openId, 'dev_2', 'Device-2');

      const devices = await bindingManager.getUserDevices(openId);

      expect(devices.length).toBe(2);
      expect(devices[0].deviceId).toBe('dev_1');
      expect(devices[1].deviceId).toBe('dev_2');
    });

    it('should return empty array for unbound user', async () => {
      const devices = await bindingManager.getUserDevices('ou_unbound');
      expect(devices).toEqual([]);
    });
  });

  describe('getActiveDevice', () => {
    it('should get the active device', async () => {
      const openId = 'ou_test_user';
      await bindingManager.bindUser(openId, 'dev_1', 'Device-1');
      await bindingManager.bindUser(openId, 'dev_2', 'Device-2');

      const activeDevice = await bindingManager.getActiveDevice(openId);

      expect(activeDevice).not.toBeNull();
      expect(activeDevice?.deviceId).toBe('dev_1');
      expect(activeDevice?.isActive).toBe(true);
    });

    it('should return null for unbound user', async () => {
      const activeDevice = await bindingManager.getActiveDevice('ou_unbound');
      expect(activeDevice).toBeNull();
    });
  });

  describe('switchActiveDevice', () => {
    it('should switch active device', async () => {
      const openId = 'ou_test_user';
      await bindingManager.bindUser(openId, 'dev_1', 'Device-1');
      await bindingManager.bindUser(openId, 'dev_2', 'Device-2');

      // Switch to second device
      const result = await bindingManager.switchActiveDevice(openId, 'dev_2');
      expect(result).toBe(true);

      // Verify switch
      const binding = await bindingManager.getUserBinding(openId);
      expect(binding?.activeDeviceId).toBe('dev_2');
      expect(binding?.devices[0].isActive).toBe(false);
      expect(binding?.devices[1].isActive).toBe(true);
    });

    it('should return false for non-existent device', async () => {
      const openId = 'ou_test_user';
      await bindingManager.bindUser(openId, 'dev_1', 'Device-1');

      const result = await bindingManager.switchActiveDevice(openId, 'dev_nonexistent');
      expect(result).toBe(false);
    });

    it('should return false for unbound user', async () => {
      const result = await bindingManager.switchActiveDevice('ou_unbound', 'dev_1');
      expect(result).toBe(false);
    });
  });

  describe('unbindDevice', () => {
    it('should unbind a specific device', async () => {
      const openId = 'ou_test_user';
      await bindingManager.bindUser(openId, 'dev_1', 'Device-1');
      await bindingManager.bindUser(openId, 'dev_2', 'Device-2');

      // Unbind second device
      const result = await bindingManager.unbindDevice(openId, 'dev_2');
      expect(result).toBe(true);

      // Verify device removed
      const binding = await bindingManager.getUserBinding(openId);
      expect(binding?.devices.length).toBe(1);
      expect(binding?.devices[0].deviceId).toBe('dev_1');
    });

    it('should promote first device when active device is unbound', async () => {
      const openId = 'ou_test_user';
      await bindingManager.bindUser(openId, 'dev_1', 'Device-1');
      await bindingManager.bindUser(openId, 'dev_2', 'Device-2');

      // Unbind active device (dev_1)
      await bindingManager.unbindDevice(openId, 'dev_1');

      // Verify dev_2 is now active
      const binding = await bindingManager.getUserBinding(openId);
      expect(binding?.devices.length).toBe(1);
      expect(binding?.activeDeviceId).toBe('dev_2');
      expect(binding?.devices[0].isActive).toBe(true);
    });

    it('should remove user binding when last device is unbound', async () => {
      const openId = 'ou_test_user';
      await bindingManager.bindUser(openId, 'dev_1', 'Device-1');

      // Unbind the only device
      await bindingManager.unbindDevice(openId, 'dev_1');

      // Verify user binding is removed
      const binding = await bindingManager.getUserBinding(openId);
      expect(binding).toBeNull();
    });

    it('should return false for non-existent device', async () => {
      const openId = 'ou_test_user';
      await bindingManager.bindUser(openId, 'dev_1', 'Device-1');

      const result = await bindingManager.unbindDevice(openId, 'dev_nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('getDeviceBinding', () => {
    it('should get device binding information via reverse lookup', async () => {
      const openId = 'ou_test_user';
      const deviceId = 'dev_test_123';

      await bindingManager.bindUser(openId, deviceId, 'Test-Device');

      const binding = await bindingManager.getDeviceBinding(deviceId);

      expect(binding).not.toBeNull();
      expect(binding?.openId).toBe(openId);
      expect(binding?.devices.length).toBe(1);
      expect(binding?.devices[0].deviceId).toBe(deviceId);
    });

    it('should return null when device is not bound', async () => {
      const deviceId = 'dev_unbound_123';

      const binding = await bindingManager.getDeviceBinding(deviceId);

      expect(binding).toBeNull();
    });

    it('should work with multiple devices', async () => {
      const openId = 'ou_test_user';
      await bindingManager.bindUser(openId, 'dev_1', 'Device-1');
      await bindingManager.bindUser(openId, 'dev_2', 'Device-2');

      const binding1 = await bindingManager.getDeviceBinding('dev_1');
      const binding2 = await bindingManager.getDeviceBinding('dev_2');

      expect(binding1?.openId).toBe(openId);
      expect(binding2?.openId).toBe(openId);
      expect(binding1?.devices.some(d => d.deviceId === 'dev_1')).toBe(true);
      expect(binding2?.devices.some(d => d.deviceId === 'dev_2')).toBe(true);
    });
  });

  describe('unbindUser', () => {
    it('should successfully unbind all user devices', async () => {
      const openId = 'ou_test_user';
      await bindingManager.bindUser(openId, 'dev_1', 'Device-1');
      await bindingManager.bindUser(openId, 'dev_2', 'Device-2');

      await bindingManager.unbindUser(openId);

      // Verify user binding is removed
      const userBinding = await bindingManager.getUserBinding(openId);
      expect(userBinding).toBeNull();

      // Verify device bindings are also removed
      const deviceBinding1 = await bindingManager.getDeviceBinding('dev_1');
      const deviceBinding2 = await bindingManager.getDeviceBinding('dev_2');
      expect(deviceBinding1).toBeNull();
      expect(deviceBinding2).toBeNull();
    });

    it('should ignore unbound user', async () => {
      const openId = 'ou_unbound_user';

      // Should not throw error
      await expect(bindingManager.unbindUser(openId)).resolves.not.toThrow();
    });
  });

  describe('updateLastActive', () => {
    it('should update active device last active time', async () => {
      const openId = 'ou_test_user';
      await bindingManager.bindUser(openId, 'dev_1', 'Device-1');

      const beforeUpdate = Date.now();
      await new Promise(resolve => setTimeout(resolve, 10)); // Small delay

      await bindingManager.updateLastActive(openId);

      const activeDevice = await bindingManager.getActiveDevice(openId);
      expect(activeDevice?.lastActiveAt).toBeGreaterThanOrEqual(beforeUpdate);
    });

    it('should not throw for unbound user', async () => {
      const openId = 'ou_unbound_user';

      await expect(bindingManager.updateLastActive(openId)).resolves.not.toThrow();
    });
  });

  describe('close', () => {
    it('should flush data to disk', async () => {
      const openId = 'ou_test_user';
      await bindingManager.bindUser(openId, 'dev_1', 'Device-1');
      await bindingManager.bindUser(openId, 'dev_2', 'Device-2');
      await bindingManager.close();

      // Verify file exists
      const storePath = path.join(testDir, 'bindings.json');
      const content = await fs.readFile(storePath, 'utf-8');
      const data = JSON.parse(content);

      expect(data.userBindings[openId]).toBeDefined();
      expect(data.userBindings[openId].devices.length).toBe(2);
      expect(data.userBindings[openId].activeDeviceId).toBe('dev_1');
    });
  });

  describe('Legacy schema migration', () => {
    it('should migrate legacy single-device schema to multi-device', async () => {
      // Create a legacy schema file manually
      const storePath = path.join(testDir, 'legacy-bindings.json');
      const legacyData = {
        bindingCodes: {},
        userBindings: {
          'ou_user1': {
            openId: 'ou_user1',
            deviceId: 'dev_1',
            deviceName: 'Old-Device',
            boundAt: Date.now() - 1000,
            lastActiveAt: Date.now()
          }
        },
        deviceBindings: {
          'dev_1': {
            openId: 'ou_user1',
            deviceId: 'dev_1',
            deviceName: 'Old-Device',
            boundAt: Date.now() - 1000,
            lastActiveAt: Date.now()
          }
        }
      };

      await fs.writeFile(storePath, JSON.stringify(legacyData, null, 2), 'utf-8');

      // Load with new JsonStore (should trigger migration)
      const legacyStore = new JsonStore(storePath);
      await legacyStore.initialize();
      const manager = new BindingManager(legacyStore);

      // Verify migration
      const binding = await manager.getUserBinding('ou_user1');
      expect(binding).not.toBeNull();
      expect(binding?.devices.length).toBe(1);
      expect(binding?.devices[0].deviceId).toBe('dev_1');
      expect(binding?.devices[0].deviceName).toBe('Old-Device');
      expect(binding?.devices[0].isActive).toBe(true);
      expect(binding?.activeDeviceId).toBe('dev_1');

      await manager.close();
    });
  });
});
