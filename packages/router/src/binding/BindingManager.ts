import { DeviceBinding, UserBinding } from '../types';
import { JsonStore } from '../storage/JsonStore';

/**
 * Binding Manager
 * Responsible for managing user and device binding relationships
 * Supports multiple devices per user with one active device
 */
export class BindingManager {
  private store: JsonStore;

  constructor(store: JsonStore) {
    this.store = store;
  }

  /**
   * Generate binding code
   * @param deviceId Device unique identifier
   * @param deviceName Device name
   * @returns Binding code object
   */
  async generateBindingCode(deviceId: string, deviceName: string): Promise<import('../types').BindingCode> {
    // Generate binding code in format XXX-XXX-XXX
    const code = this.generateRandomCode();
    const now = Date.now();
    const bindingCode = {
      code,
      deviceId,
      createdAt: now,
      expiresAt: now + 5 * 60 * 1000 // Expires after 5 minutes
    };

    // Store binding code
    await this.store.setBindingCode(code, bindingCode);

    return bindingCode;
  }

  /**
   * Verify binding code
   * @param code Binding code
   * @returns Binding code object, returns null if invalid or expired
   */
  async verifyBindingCode(code: string): Promise<import('../types').BindingCode | null> {
    return this.store.getBindingCode(code);
  }

  /**
   * Bind user and device (supports multi-device)
   * First device becomes active; subsequent devices are added as inactive.
   */
  async bindUser(openId: string, deviceId: string, deviceName: string): Promise<void> {
    const now = Date.now();

    // Security check: Prevent device from being bound to multiple users
    // This prevents cross-user data leakage and routing confusion
    const existingOwner = this.store.getUserByDeviceId(deviceId);
    if (existingOwner && existingOwner !== openId) {
      throw new Error(
        `Device ${deviceId} is already bound to another user. ` +
        `Please unbind it first or use a different device ID.`
      );
    }

    const existingBinding = await this.getUserBinding(openId);

    if (existingBinding) {
      // Check if device already exists (rebinding scenario)
      const deviceIndex = existingBinding.devices.findIndex(d => d.deviceId === deviceId);

      if (deviceIndex >= 0) {
        // Update existing device entry (same user rebinding their own device)
        existingBinding.devices[deviceIndex].deviceName = deviceName;
        existingBinding.devices[deviceIndex].lastActiveAt = now;
      } else {
        // Add new device as inactive
        existingBinding.devices.push({
          deviceId,
          deviceName,
          boundAt: now,
          lastActiveAt: now,
          isActive: false,
        });
      }

      existingBinding.updatedAt = now;
      await this.store.setUserBinding(openId, existingBinding);
    } else {
      // First device for this user - set as active
      const binding: UserBinding = {
        openId,
        devices: [{
          deviceId,
          deviceName,
          boundAt: now,
          lastActiveAt: now,
          isActive: true,
        }],
        activeDeviceId: deviceId,
        createdAt: now,
        updatedAt: now,
      };

      await this.store.setUserBinding(openId, binding);
    }

    // Update device-to-user reverse mapping to ensure consistency
    await this.store.setDeviceToUserMap(deviceId, openId);
  }

  /**
   * Get user binding information
   */
  async getUserBinding(openId: string): Promise<UserBinding | null> {
    return this.store.getUserBinding(openId);
  }

  /**
   * Get all devices for a user
   */
  async getUserDevices(openId: string): Promise<DeviceBinding[]> {
    const binding = this.store.getUserBinding(openId);
    return binding?.devices || [];
  }

  /**
   * Get the active device for a user
   */
  async getActiveDevice(openId: string): Promise<DeviceBinding | null> {
    const binding = this.store.getUserBinding(openId);
    if (!binding || !binding.activeDeviceId) {
      return null;
    }
    return binding.devices.find(d => d.deviceId === binding.activeDeviceId) || null;
  }

  /**
   * Switch the active device for a user
   * @returns true if switch was successful
   */
  async switchActiveDevice(openId: string, deviceId: string): Promise<boolean> {
    const binding = this.store.getUserBinding(openId);
    if (!binding) {
      return false;
    }

    const targetDevice = binding.devices.find(d => d.deviceId === deviceId);
    if (!targetDevice) {
      return false;
    }

    // Update isActive flags
    for (const device of binding.devices) {
      device.isActive = device.deviceId === deviceId;
    }
    binding.activeDeviceId = deviceId;
    binding.updatedAt = Date.now();

    await this.store.setUserBinding(openId, binding);
    return true;
  }

  /**
   * Unbind a specific device from a user
   * If the active device is removed, promotes the first remaining device.
   * If no devices remain, removes the entire user binding.
   * @returns true if device was found and removed
   */
  async unbindDevice(openId: string, deviceId: string): Promise<boolean> {
    const binding = this.store.getUserBinding(openId);
    if (!binding) {
      return false;
    }

    const deviceIndex = binding.devices.findIndex(d => d.deviceId === deviceId);
    if (deviceIndex < 0) {
      return false;
    }

    // Remove device
    binding.devices.splice(deviceIndex, 1);
    await this.store.removeDeviceToUserMap(deviceId);

    if (binding.devices.length === 0) {
      // No devices left, delete the entire binding
      await this.store.deleteUserBinding(openId);
      return true;
    }

    // If the removed device was the active one, promote first remaining device
    if (binding.activeDeviceId === deviceId) {
      binding.devices[0].isActive = true;
      binding.activeDeviceId = binding.devices[0].deviceId;
    }

    binding.updatedAt = Date.now();
    await this.store.setUserBinding(openId, binding);
    return true;
  }

  /**
   * Get device binding information via reverse lookup
   */
  async getDeviceBinding(deviceId: string): Promise<UserBinding | null> {
    const openId = this.store.getUserByDeviceId(deviceId);
    if (!openId) {
      return null;
    }
    return this.store.getUserBinding(openId);
  }

  /**
   * Unbind all devices for a user
   */
  async unbindUser(openId: string): Promise<void> {
    await this.store.deleteUserBinding(openId);
  }

  /**
   * Update user last active time
   */
  async updateLastActive(openId: string): Promise<void> {
    await this.store.updateLastActive(openId);
  }

  /**
   * Generate random binding code (format: XXX-XXX-XXX)
   */
  private generateRandomCode(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const segments = [];

    for (let i = 0; i < 3; i++) {
      let segment = '';
      for (let j = 0; j < 3; j++) {
        segment += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      segments.push(segment);
    }

    return segments.join('-');
  }

  /**
   * Close and flush data
   */
  async close(): Promise<void> {
    await this.store.flush();
  }
}
