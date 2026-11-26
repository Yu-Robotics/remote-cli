import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JsonStore } from '../src/storage/JsonStore';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

describe('JsonStore', () => {
  let store: JsonStore;
  let testDir: string;
  let storePath: string;

  beforeEach(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    testDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'jsonstore-test-')));
    vi.spyOn(os, 'homedir').mockReturnValue(testDir);
    storePath = path.join(testDir, 'bindings.json');
    store = new JsonStore(storePath, 0);
  });

  afterEach(async () => {
    try {
      await store.flush();
    } finally {
      vi.restoreAllMocks();
      await fs.rm(testDir, { recursive: true, force: true });
    }
  });

  describe('initialization', () => {
    it('should create store file on initialization', async () => {
      await store.initialize();

      const exists = await fs.stat(storePath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    it('writes to the home-directory bindings file through the default constructor', async () => {
      const defaultStore = new JsonStore();
      await defaultStore.initialize();
      const pending = defaultStore.setDeviceToUserMap('device', 'owner');
      await Promise.all([pending, defaultStore.flush()]);
      const saved = new JsonStore(path.join(testDir, '.remote-cli-router', 'bindings.json'));
      await saved.initialize();
      expect(saved.getUserByDeviceId('device')).toBe('owner');
    });

    it('should initialize with empty data', async () => {
      await store.initialize();

      const stats = store.getStats();
      expect(stats.bindingCodes).toBe(0);
      expect(stats.userBindings).toBe(0);
      expect(stats.devices).toBe(0);
    });

    it('should load existing data from disk', async () => {
      // Write initial data
      const initialData = {
        version: 1,
        bindingCodes: {},
        userBindings: {
          'ou_user_1': {
            openId: 'ou_user_1',
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
          }
        },
        deviceToUserMap: {
          'dev_1': 'ou_user_1'
        }
      };
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify(initialData, null, 2));

      // Initialize store
      await store.initialize();

      const stats = store.getStats();
      expect(stats.userBindings).toBe(1);
      expect(stats.devices).toBe(1);
    });

    it('should preserve corrupted JSON instead of destructively resetting it', async () => {
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, 'not valid json');

      const invalidStore = new JsonStore(storePath, 0);
      await expect(invalidStore.initialize()).rejects.toThrow();
      expect(await fs.readFile(storePath, 'utf8')).toBe('not valid json');
    });
  });

  it('claims each Feishu confirmation once across concurrent delivery, restart, and binding reset', async () => {
    await store.initialize();
    const createdAt = Date.now();
    const claim = () => store.consumeAgyConfirmation('original-message', createdAt);
    const attempts = await Promise.allSettled([claim(), claim()]);
    expect(attempts.map(item => item.status).sort()).toEqual(['fulfilled', 'rejected']);
    await store.clear();
    store = new JsonStore(storePath, 0);
    await store.initialize();
    expect(store.mayForwardUnclaimedHumanMessage('original-message', createdAt)).toBe(false);
    expect(store.mayForwardUnclaimedHumanMessage('another-message', createdAt)).toBe(true);
    await expect(claim()).rejects.toThrow();
    await expect(store.consumeAgyConfirmation('stale-message', Date.now() - 300001)).rejects.toThrow();
    expect(await fs.readFile(storePath, 'utf8')).not.toContain('original-message');
  });

  it('refuses capacity pressure without evicting fresh confirmations and expires them by original creation time', async () => {
    await store.initialize();
    const clock = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(clock);
    const data = JSON.parse(await fs.readFile(storePath, 'utf8'));
    data.agyConfirmations = { updatedAt: clock,
      receipts: Object.fromEntries(Array.from({ length: 4096 }, (_, i) => [i.toString(16).padStart(64, '0'), clock])) };
    await fs.writeFile(storePath, JSON.stringify(data));
    store = new JsonStore(storePath, 0);
    await store.initialize();
    await expect(store.consumeAgyConfirmation('next', clock)).rejects.toThrow();
    now.mockReturnValue(clock + 300000);
    await expect(store.consumeAgyConfirmation('delayed', clock)).rejects.toThrow();
    await store.consumeAgyConfirmation('fresh', Date.now());
    expect(Object.keys(JSON.parse(await fs.readFile(storePath, 'utf8')).agyConfirmations.receipts)).toHaveLength(1);
    now.mockReturnValue(clock);
    await expect(store.consumeAgyConfirmation('delayed', clock)).rejects.toThrow();
  });

  describe('binding code operations', () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it('should set and get binding code', async () => {
      const code = 'ABC-123-XYZ';
      const bindingCode = {
        code,
        deviceId: 'dev_test_123',
        createdAt: Date.now(),
        expiresAt: Date.now() + 5 * 60 * 1000
      };

      await store.setBindingCode(code, bindingCode);
      const retrieved = store.getBindingCode(code);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.deviceId).toBe('dev_test_123');
    });

    it('should return null for non-existent binding code', () => {
      const result = store.getBindingCode('NONEXISTENT');
      expect(result).toBeNull();
    });

    it('should return null and delete expired binding code', async () => {
      const code = 'ABC-123-XYZ';
      const expiredBindingCode = {
        code,
        deviceId: 'dev_test_123',
        createdAt: Date.now() - 10 * 60 * 1000,
        expiresAt: Date.now() - 5 * 60 * 1000 // Already expired
      };

      await store.setBindingCode(code, expiredBindingCode);
      const result = store.getBindingCode(code);

      expect(result).toBeNull();
    });

    it('should delete binding code', async () => {
      const code = 'ABC-123-XYZ';
      const bindingCode = {
        code,
        deviceId: 'dev_test_123',
        createdAt: Date.now(),
        expiresAt: Date.now() + 5 * 60 * 1000
      };

      await store.setBindingCode(code, bindingCode);
      await store.deleteBindingCode(code);

      const result = store.getBindingCode(code);
      expect(result).toBeNull();
    });
  });

  describe('user binding operations', () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it('should set and get user binding', async () => {
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

      await store.setUserBinding(openId, binding);
      const retrieved = store.getUserBinding(openId);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.openId).toBe(openId);
      expect(retrieved?.devices.length).toBe(1);
    });

    it('should return null for non-existent user', () => {
      const result = store.getUserBinding('ou_nonexistent');
      expect(result).toBeNull();
    });

    it('should update device to user map when setting user binding', async () => {
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

      await store.setUserBinding(openId, binding);

      expect(store.getUserByDeviceId('dev_1')).toBe(openId);
      expect(store.getUserByDeviceId('dev_2')).toBe(openId);
    });

    it('should delete user binding and device mappings', async () => {
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

      await store.setUserBinding(openId, binding);
      await store.deleteUserBinding(openId);

      expect(store.getUserBinding(openId)).toBeNull();
      expect(store.getUserByDeviceId('dev_1')).toBeNull();
    });

    it('should handle delete of non-existent user', async () => {
      // Should not throw
      await expect(store.deleteUserBinding('ou_nonexistent')).resolves.not.toThrow();
    });
  });

  describe('device to user mapping', () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it('should get user by device ID', async () => {
      await store.setDeviceToUserMap('dev_1', 'ou_user_1');
      expect(store.getUserByDeviceId('dev_1')).toBe('ou_user_1');
    });

    it('should return null for unknown device', () => {
      expect(store.getUserByDeviceId('unknown_device')).toBeNull();
    });

    it('should remove device to user mapping', async () => {
      await store.setDeviceToUserMap('dev_1', 'ou_user_1');
      await store.removeDeviceToUserMap('dev_1');
      expect(store.getUserByDeviceId('dev_1')).toBeNull();
    });
  });

  describe('updateLastActive', () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it('should update last active time for active device', async () => {
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

      await store.setUserBinding(openId, binding);
      await store.updateLastActive(openId);

      const updated = store.getUserBinding(openId);
      expect(updated?.devices[0].lastActiveAt).toBeGreaterThan(now - 10000);
      expect(updated?.updatedAt).toBeGreaterThan(now - 10000);
    });

    it('should handle user without active device', async () => {
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

      await store.setUserBinding(openId, binding);
      // Should not throw
      await expect(store.updateLastActive(openId)).resolves.not.toThrow();
    });

    it('should handle non-existent user', async () => {
      // Should not throw
      await expect(store.updateLastActive('ou_nonexistent')).resolves.not.toThrow();
    });
  });

  describe('persistence', () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it('should persist data to disk on flush', async () => {
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

      await store.setUserBinding(openId, binding);
      await store.flush();

      // Read the file directly
      const content = await fs.readFile(storePath, 'utf-8');
      const data = JSON.parse(content);

      expect(data.userBindings[openId]).toBeDefined();
      expect(data.version).toBe(1);
    });

    it('should reload data after flush and reinitialize', async () => {
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

      await store.setUserBinding(openId, binding);
      await store.flush();

      // Create a new store instance
      const newStore = new JsonStore(storePath, 0);
      await newStore.initialize();

      const retrieved = newStore.getUserBinding(openId);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.openId).toBe(openId);
    });
  });

  describe('clear', () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it('should clear all data', async () => {
      // Add some data
      await store.setBindingCode('ABC-123', {
        code: 'ABC-123',
        deviceId: 'dev_1',
        createdAt: Date.now(),
        expiresAt: Date.now() + 60000
      });
      await store.setUserBinding('ou_user_1', {
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

      await store.clear();

      const stats = store.getStats();
      expect(stats.bindingCodes).toBe(0);
      expect(stats.userBindings).toBe(0);
      expect(stats.devices).toBe(0);
    });
  });

  describe('getStats', () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it('should return accurate statistics', async () => {
      // Add binding codes
      await store.setBindingCode('ABC-123', {
        code: 'ABC-123',
        deviceId: 'dev_1',
        createdAt: Date.now(),
        expiresAt: Date.now() + 60000
      });

      // Add user bindings
      await store.setUserBinding('ou_user_1', {
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
  });

  describe('legacy migration', () => {
    it('should migrate legacy schema to multi-device schema', async () => {
      // Create legacy data file
      const legacyData = {
        bindingCodes: {},
        userBindings: {
          'ou_user_1': {
            openId: 'ou_user_1',
            deviceId: 'dev_1',
            deviceName: 'Legacy-Device',
            boundAt: Date.now() - 1000,
            lastActiveAt: Date.now()
          }
        },
        deviceBindings: {
          'dev_1': {
            openId: 'ou_user_1',
            deviceId: 'dev_1',
            deviceName: 'Legacy-Device',
            boundAt: Date.now() - 1000,
            lastActiveAt: Date.now()
          }
        }
      };

      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify(legacyData, null, 2));

      // Initialize store (should trigger migration)
      await store.initialize();

      // Verify migration
      const binding = store.getUserBinding('ou_user_1');
      expect(binding).not.toBeNull();
      expect(binding?.devices.length).toBe(1);
      expect(binding?.devices[0].deviceId).toBe('dev_1');
      expect(binding?.devices[0].deviceName).toBe('Legacy-Device');
      expect(binding?.devices[0].isActive).toBe(true);
      expect(binding?.activeDeviceId).toBe('dev_1');
    });

    it('should handle empty legacy data', async () => {
      // Create empty legacy data file
      const legacyData = {
        bindingCodes: {},
        userBindings: {}
      };

      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify(legacyData, null, 2));

      await store.initialize();

      const stats = store.getStats();
      expect(stats.userBindings).toBe(0);
    });
  });

  describe('expired binding code cleanup', () => {
    it('should clean up expired binding codes on initialization', async () => {
      // Create data with expired binding codes
      const data = {
        version: 1,
        bindingCodes: {
          'EXPIRED-1': {
            code: 'EXPIRED-1',
            deviceId: 'dev_1',
            createdAt: Date.now() - 10 * 60 * 1000,
            expiresAt: Date.now() - 5 * 60 * 1000 // Expired
          },
          'VALID-1': {
            code: 'VALID-1',
            deviceId: 'dev_2',
            createdAt: Date.now(),
            expiresAt: Date.now() + 5 * 60 * 1000 // Not expired
          }
        },
        userBindings: {},
        deviceToUserMap: {}
      };

      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify(data, null, 2));

      await store.initialize();

      // Expired code should be removed
      expect(store.getBindingCode('EXPIRED-1')).toBeNull();
      // Valid code should remain
      expect(store.getBindingCode('VALID-1')).not.toBeNull();
    });
  });

  describe('concurrent flush safety', () => {
    beforeEach(async () => {
      await store.initialize();
    });

    it('should handle concurrent flush calls without corrupting file data', async () => {
      // Add some data first
      await store.setUserBinding('ou_user_1', {
        openId: 'ou_user_1',
        devices: [{
          deviceId: 'dev_1',
          deviceName: 'Device-1',
          boundAt: Date.now(),
          lastActiveAt: Date.now(),
          isActive: true
        }],
        activeDeviceId: 'dev_1',
        createdAt: Date.now(),
        updatedAt: Date.now()
      });

      await store.setBindingCode('ABC-123', {
        code: 'ABC-123',
        deviceId: 'dev_2',
        createdAt: Date.now(),
        expiresAt: Date.now() + 60000
      });

      // Call flush() twice concurrently
      await Promise.all([store.flush(), store.flush()]);

      // Verify the file contains valid JSON with the expected data
      const content = await fs.readFile(storePath, 'utf-8');
      const data = JSON.parse(content);

      expect(data.version).toBe(1);
      expect(data.userBindings['ou_user_1']).toBeDefined();
      expect(data.userBindings['ou_user_1'].devices.length).toBe(1);
      expect(data.bindingCodes['ABC-123']).toBeDefined();
    });
  });

  it('flushes all pending binding codes and settles each writer before the save delay', async () => {
    store = new JsonStore(storePath, 60_000);
    await store.initialize();
    const now = Date.now();
    const codes = ['first', 'second', 'third'].map(code => ({
      code, deviceId: `device-${code}`, createdAt: now, expiresAt: now + 60_000,
    }));
    const writes = codes.map(code => store.setBindingCode(code.code, code));
    await Promise.all([...writes, store.flush()]);
    const saved = JSON.parse(await fs.readFile(storePath, 'utf8'));
    expect(saved.bindingCodes).toEqual(Object.fromEntries(codes.map(code => [code.code, code])));
  });
});
